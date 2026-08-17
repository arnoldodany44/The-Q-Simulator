/**
 * The second way to authenticate — §3.5.
 *
 * ══════════════════════════════════════════════════════════════════════════
 * WHY THIS IS A SEPARATE PLUGIN FROM `auth.ts`
 *
 * Not tidiness: a dependency. Verifying a key is a database read, so this
 * plugin depends on `qsim-database`, which is registered late for a reason of
 * its own (a connection budget of one, so the client is built on first use and
 * not at boot). `auth.ts` depends on nothing but a JWKS endpoint and has to be
 * registered early, before the rate limiter, because the limiter is keyed on
 * the identity it resolves.
 *
 * Splitting them lets each keep its own registration position while both
 * install a **global** `onRequest` hook — and every global hook runs before
 * any route-level one, which is where the limiter and the policy check live.
 * So the ordering that matters is preserved whichever way round the two
 * plugins are registered:
 *
 *     onRequest, global: resolveIdentity  (auth.ts)      ← JWTs
 *     onRequest, global: resolveApiKey    (this file)    ← qsk_ keys
 *     onRequest, route:  (rate limit)                    ← keyed on both
 *     onRequest, route:  enforceAuthPolicy (auth.ts)     ← rejects
 *
 * The two resolvers cannot both fire on one request. A compact JWS begins
 * `eyJ` and a key begins `qsk_`; each resolver tests for its own shape and
 * ignores the other's, so no token is ever tried against both verifiers and
 * no request can arrive at enforcement holding two identities.
 *
 * ══════════════════════════════════════════════════════════════════════════
 * WHY A KEY IS RESOLVED AND NOT REJECTED HERE
 *
 * The same argument `auth.ts` makes at length, and it is sharper for keys.
 * If this hook threw on an unknown key, a caller replaying invented keys would
 * never reach the rate limiter — and this is the credential type whose
 * verification costs a database query, on a pooler with one connection. The
 * one caller who most needs limiting would be the one exempt from it, at the
 * highest possible price. So a bad key becomes `request.authFailure`, the
 * limiter counts the request against the caller's address, and enforcement
 * throws a hook later.
 *
 * ══════════════════════════════════════════════════════════════════════════
 * WHY THE FEATURE HAS NO "OFF" STATE
 *
 * Unlike the queue, the event bus and the hardware port — each of which
 * degrades to `null` when its environment variable is absent — this needs no
 * configuration beyond the database that every other route already requires.
 * There is nothing to switch off and therefore no half-configured deployment
 * where keys silently stop working, which is the failure mode a nullable
 * decoration would have introduced.
 */

import fp from 'fastify-plugin'
import { prismaApiKeyRepository } from '@qsim/db'
import type { ApiKeyRepository } from '@qsim/db'
import type { FastifyInstance } from 'fastify'
import { createApiKeyVerifier } from '../api-keys/verify.js'
import type { ApiKeyVerifier } from '../api-keys/verify.js'
import { isApiKeyCredential } from '../api-keys/secret.js'
import { ApiError, toApiError } from '../errors.js'
import { bearerToken } from '../auth/verify.js'

declare module 'fastify' {
  interface FastifyInstance {
    /** Built on first access, like every other repository. */
    readonly apiKeys: ApiKeyRepository
    /** The verifier the resolver hook drives. Exposed for tests. */
    readonly apiKeyVerifier: ApiKeyVerifier
  }
}

export interface ApiKeysPluginOptions {
  /** Injected by tests, and by nothing else. */
  readonly repository?: ApiKeyRepository
  /** Injected by tests that need to drive the clock or the cache bounds. */
  readonly verifier?: ApiKeyVerifier
}

function apiKeysPlugin(
  app: FastifyInstance,
  options: ApiKeysPluginOptions,
  done: (error?: Error) => void
): void {
  const injected = options.repository
  let owned: ApiKeyRepository | null = null

  app.decorate('apiKeys', {
    getter: (): ApiKeyRepository => {
      if (injected !== undefined) return injected
      owned ??= prismaApiKeyRepository(app.db)
      return owned
    },
  })

  const injectedVerifier = options.verifier
  let ownedVerifier: ApiKeyVerifier | null = null

  app.decorate('apiKeyVerifier', {
    getter: (): ApiKeyVerifier => {
      if (injectedVerifier !== undefined) return injectedVerifier
      ownedVerifier ??= createApiKeyVerifier({
        repository: app.apiKeys,
        onTouchError: (error) => {
          /*
           * Logged and swallowed. The request it describes has already been
           * authorised, and a timestamp that could not be written must never
           * present to a user as "your key stopped working".
           */
          app.log.warn({ err: error }, 'could not stamp an API key as used')
        },
      })
      return ownedVerifier
    },
  })

  app.addHook('onRequest', async (request) => {
    const header = request.headers.authorization
    if (header === undefined) return

    const token = bearerToken(header)
    /*
     * Not ours. Either `auth.ts` has already verified it as a JWT, or it has
     * already recorded the failure — this hook must add nothing in either
     * case, because a second opinion about somebody else's credential is how
     * one of the two ends up being ignored.
     */
    if (token === null || !isApiKeyCredential(token)) return

    try {
      const verified = await app.apiKeyVerifier.verify(token)
      if (verified === null) {
        /*
         * Unknown or revoked — the same answer, deliberately, and the same
         * code a rejected JWT gets. Distinguishing "this was a key once" from
         * "this was never a key" would tell whoever is holding a string that
         * it used to be a credential, which is a fact worth something only to
         * somebody who should not have it.
         */
        request.authFailure = new ApiError('AUTH_INVALID_TOKEN')
        return
      }
      request.apiKey = verified
    } catch (error) {
      /*
       * The database refused, so this request cannot be authenticated. Held
       * rather than thrown for the reason at the top of this file, and mapped
       * through `toApiError` so a Prisma connection failure answers 503 rather
       * than being reported to the caller as a bad credential — "your key is
       * wrong" is the single most misleading thing to say when the truth is
       * "we could not look".
       */
      request.authFailure = toApiError(error)
    }
  })

  done()
}

export default fp(apiKeysPlugin, {
  name: 'qsim-api-keys',
  dependencies: ['qsim-auth', 'qsim-database'],
})
