/**
 * Real hardware, decorated onto the instance as `app.hardware`.
 *
 * ══════════════════════════════════════════════════════════════════════════
 * WHAT THIS PLUGIN OWNS, AND WHY IT IS ONE OBJECT RATHER THAN THREE
 *
 * Three things that only make sense together: the repository (the rows), the
 * cipher (the master key), and a factory that turns a stored credential into a
 * client for the provider. Splitting them into three decorators would let a
 * route hold a cipher without a repository — which is a route that can decrypt
 * a credential it did not authorise reading. Here the only way to reach a
 * plaintext is `clientFor(credentialId, userId)`, which does the authorised
 * read and the decryption together and hands back something that can *use* the
 * credential without exposing it.
 *
 * ══════════════════════════════════════════════════════════════════════════
 * THE PLAINTEXT'S WHOLE LIFETIME IS ONE FUNCTION CALL
 *
 * `createIbmClient` takes `apiKey` as a **callback**, not a value. So the
 * decrypted key exists inside one `await` in `@qsim/ibm`'s token exchange, is
 * form-encoded into one request body, and is never held by the client, by this
 * plugin, or by any route. What is held afterwards is the IAM bearer token,
 * which lasts an hour and lives in a `TokenCache` in this process's memory —
 * never in a row, never in a log line, never in an error (`IbmError` scrubs its
 * own detail).
 *
 * The callback also means the credential is read from Postgres *once per token
 * exchange* rather than once per request: with a live token in the cache,
 * `clientFor` performs no decryption at all.
 *
 * ══════════════════════════════════════════════════════════════════════════
 * ABSENT IS A SUPPORTED STATE
 *
 * `app.hardware` is `null` when no `ENCRYPTION_KEY` was configured, and the
 * five `/hardware` routes answer 503. That is the same arrangement
 * `plugins/queue.ts` has for Redis and it is the same argument: §3.7's hardware
 * is a feature a user brings their own account to, so a deployment where nobody
 * has is a deployment that should still serve the gallery.
 *
 * What it is not is a *weaker mode*. There is no default key, no key derived
 * from another secret, and no path anywhere that stores a credential
 * unencrypted. The route refuses before a seal is ever attempted.
 */

import { prismaHardwareRepository, createCredentialCipher } from '@qsim/db'
import type {
  CreateCredentialInput,
  CredentialCipher,
  HardwareCredentialMeta,
  HardwareRepository,
} from '@qsim/db'
import { decodeEncryptionKey } from '@qsim/db'
import {
  createIbmClient,
  createTokenCache,
  exchangeApiKey,
  fetchTransport,
  parseCrn,
} from '@qsim/ibm'
import type { IbmClient, TokenCache } from '@qsim/ibm'
import fp from 'fastify-plugin'
import type { FastifyInstance } from 'fastify'
import type { ApiEnv } from '../env.js'

/** Raised when a route needs a credential this caller does not have. */
export class CredentialNotFoundError extends Error {
  readonly code = 'HARDWARE_CREDENTIAL_NOT_FOUND'

  constructor() {
    // 404 through `DOMAIN_ERROR_CODES` would be the wrong door: this one is
    // mapped by the route, which knows whether the id came from a path or a
    // body and can point at the right field.
    super('no such credential for this user')
    this.name = 'CredentialNotFoundError'
  }
}

export interface HardwarePort {
  readonly repository: HardwareRepository
  /**
   * Seals and stores a credential.
   *
   * Here rather than on the repository so that no route ever holds a name bound
   * to a `CredentialCipher`. `HardwareRepository.createCredential` takes one as
   * a parameter — which is right for the package that owns the column, because
   * it means the key is not in that package either — and this is the one place
   * in the API that supplies it.
   */
  store(input: CreateCredentialInput): Promise<HardwareCredentialMeta>
  /**
   * A client bound to one stored credential.
   *
   * `userId` is not a courtesy parameter. It scopes the read *in the query*,
   * and it is the AES-GCM additional authenticated data — so a credential id
   * belonging to somebody else fails twice, once by matching no row and once by
   * failing to decrypt. Throws `CredentialNotFoundError` when there is no such
   * credential for this user, which the route answers 404 to.
   */
  clientFor(credentialId: string, userId: string): Promise<IbmClient>
  /**
   * Proves a credential works, before it is stored.
   *
   * One IAM token exchange, which costs no QPU time at all — the ten-minute
   * allowance is spent by `POST /jobs` and by nothing else. It is worth a
   * network call on a write because the alternative is worse than it sounds: a
   * key that was mistyped is stored happily, and the person finds out an hour
   * later when a hardware job they were waiting on fails with a code, having
   * already picked a backend and a shot count.
   *
   * Throws the `@qsim/ibm` failure, which `toApiError` maps by shape — so a
   * refused key is 502 HARDWARE_CREDENTIAL_REJECTED and an IAM that is merely
   * down is 502 HARDWARE_UNAVAILABLE, which are different instructions.
   */
  verifyCredential(input: { apiKey: string; instance: string }): Promise<void>
  /** Forgets a credential's cached bearer token. Called when one is deleted. */
  forget(credentialId: string): void
  close(): void
}

declare module 'fastify' {
  interface FastifyInstance {
    /** `null` when no ENCRYPTION_KEY was configured. See the header. */
    readonly hardware: HardwarePort | null
  }
}

export interface HardwarePluginOptions {
  /** Injected by tests, and by nothing else. */
  readonly port?: HardwarePort
  readonly env: ApiEnv
}

export interface BuildHardwarePortInput {
  readonly repository: HardwareRepository
  readonly cipher: CredentialCipher
  readonly tokens: TokenCache
  readonly transport: ReturnType<typeof fetchTransport>
  readonly timeoutMs: number
}

/**
 * The port, over ports.
 *
 * Every dependency is a parameter so that the API's own suites can drive the
 * whole hardware surface — the routes, the §11 rules, every failure mode —
 * against a recorded transport and an in-memory repository, with no live IBM
 * and no live Postgres. That is not a testing convenience here; it is the
 * budget. The Open Plan allows ten minutes per twenty-eight days.
 */
export function buildHardwarePort(input: BuildHardwarePortInput): HardwarePort {
  return {
    repository: input.repository,

    store(credential) {
      return input.repository.createCredential(credential, input.cipher)
    },

    async clientFor(credentialId, userId) {
      /*
       * Read eagerly to authorise, even though the key may not be needed: a
       * live cached token means no exchange, but the *authorisation* must
       * happen on every call. A client handed out on the strength of a cached
       * token would keep working after the credential was deleted.
       */
      const meta = await input.repository.findCredential(credentialId, userId)
      if (meta === null) throw new CredentialNotFoundError()

      /*
       * The instance CRN is inside the sealed document, so it has to be opened
       * once here to know which host to address. That is one decryption per
       * client rather than per request — a route builds one client and makes
       * several calls with it.
       */
      const document = await input.repository.openCredential(
        credentialId,
        userId,
        input.cipher
      )
      if (document === null) throw new CredentialNotFoundError()

      return createIbmClient({
        crn: document.instance,
        credentialId,
        /*
         * A callback, not the value. The plaintext key exists for the duration
         * of one IAM exchange and is never held by this closure's caller — see
         * the header. It re-reads rather than closing over `document.apiKey`
         * so that a key rotated in the database is picked up on the next
         * exchange rather than on the next deploy.
         */
        apiKey: async () => {
          const fresh = await input.repository.openCredential(
            credentialId,
            userId,
            input.cipher
          )
          if (fresh === null) throw new CredentialNotFoundError()
          return fresh.apiKey
        },
        transport: input.transport,
        tokens: input.tokens,
        timeoutMs: input.timeoutMs,
      })
    },

    async verifyCredential({ apiKey, instance }) {
      // Throws `InvalidCrnError` for a CRN that addresses no host, before a
      // single byte of the key leaves this process.
      parseCrn(instance)
      /*
       * Deliberately not through the `TokenCache`: there is no credential id to
       * key it under yet, and caching a token for a credential that may not be
       * stored would leave a live bearer token in memory belonging to nothing.
       * The token this produces is discarded; what is being tested is that IAM
       * accepts the key at all.
       */
      await exchangeApiKey(apiKey, {
        transport: input.transport,
        timeoutMs: input.timeoutMs,
      })
    },

    forget(credentialId) {
      input.tokens.invalidate(credentialId)
    },

    close() {
      // The one thing worth doing on shutdown: drop every bearer token this
      // process is holding. They live an hour and there is no reason for one
      // to survive the process that fetched it.
      input.tokens.clear()
    },
  }
}

function hardwarePlugin(
  app: FastifyInstance,
  options: HardwarePluginOptions,
  done: (error?: Error) => void
): void {
  const injected = options.port
  let owned: HardwarePort | null = null
  let built = false

  app.decorate('hardware', {
    getter: (): HardwarePort | null => {
      if (injected !== undefined) return injected
      const key = options.env.hardware.encryptionKey
      if (key === null) return null
      /*
       * Built on first use rather than at boot, for the reason the database and
       * queue plugins are lazy: `app.db` opens a connection against a pooler
       * whose budget is one, and a connection opened during startup is one
       * opened before the platform's health check has passed.
       */
      if (!built) {
        built = true
        const transport = fetchTransport()
        owned = buildHardwarePort({
          repository: prismaHardwareRepository(app.db),
          cipher: createCredentialCipher(decodeEncryptionKey(key)),
          tokens: createTokenCache({
            transport,
            timeoutMs: options.env.hardware.timeoutMs,
          }),
          transport,
          timeoutMs: options.env.hardware.timeoutMs,
        })
      }
      return owned
    },
  })

  app.addHook('onClose', () => {
    // Only what this process built. An injected port belongs to its test.
    if (owned !== null) owned.close()
  })

  done()
}

export default fp(hardwarePlugin, {
  name: 'qsim-hardware',
  dependencies: ['qsim-database'],
})
