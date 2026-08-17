/**
 * Minting, listing and revoking the public API's credentials — §3.5, §11.
 *
 * ══════════════════════════════════════════════════════════════════════════
 * THE KEY IS SHOWN ONCE, AND THAT IS ENFORCED THREE TIMES OVER
 *
 * §3.5 gives the product a public API; §11 gives it the discipline. The one
 * rule that matters here is that the secret exists in exactly one response and
 * nowhere else afterwards, and it is true for three independent reasons — the
 * same layered arrangement `hardware.ts` uses for a stored token, sharpened by
 * the fact that this secret is not merely hidden but *irrecoverable*:
 *
 *   1. `mintApiKey` is the only thing in the system that produces a key, it is
 *      called from exactly one line below, and the value goes straight into
 *      the 201 body. No field on any object holds it afterwards.
 *   2. What is stored is a SHA-256. There is no inverse, so no endpoint could
 *      return the key even if somebody wrote one — including to its owner,
 *      which is the case people actually ask for.
 *   3. `apiKeyMetaSelect` in `@qsim/db` cannot fetch `keyHash`, and
 *      `ApiKeyResponse` in `@qsim/contract` has no field that could hold a
 *      secret, and Fastify serialises *through* that schema. A handler that
 *      returned the whole row would have the extra stripped before it reached
 *      a socket.
 *
 * The consequence is a support burden and it is the right trade: a key lost
 * between the response and the clipboard is gone, and the only remedy is to
 * mint another and revoke this one. The settings screen is built around
 * exactly that (`apps/web/src/features/api-keys`), because the alternative —
 * an endpoint that shows it again — is a permanent second way to steal every
 * key in the database.
 *
 * ══════════════════════════════════════════════════════════════════════════
 * NO ROUTE HERE DECLARES A `scope`, AND THAT IS THE POINT
 *
 * A key may not manage keys. Not with `write`, not with every scope ticked.
 * The reason is that revocation would otherwise be theatre: a leaked key that
 * can mint keys renews itself, so revoking the leaked one closes nothing and
 * the only true remedy becomes deleting the account. Session only, for ever.
 *
 * The enforcement is not in this file — it is `enforceAuthPolicy`'s default in
 * `plugins/auth.ts`, which refuses a key on any route that did not declare a
 * scope. That is deliberate: a rule written *here* would be a rule the next
 * router could forget, and this one can only be broken by adding a line that
 * says so.
 *
 * ══════════════════════════════════════════════════════════════════════════
 * WHY `DELETE` DOES NOT DELETE
 *
 * It sets `revokedAt` and leaves the row. Revocation is immediate either way
 * — the lookup filters on `revokedAt IS NULL` inside the query, so the key
 * fails on its very next request — but the row is the only record that the key
 * ever existed, what it was called, when it was last used and when it was
 * turned off. Those five facts are exactly what somebody wants an hour after
 * discovering a leak, and a `DELETE FROM` would have destroyed them at the
 * moment of most need.
 *
 * So the response is the revoked row rather than a 204: the caller gets back
 * the `revokedAt` the server stamped, which is the fact that makes the answer
 * worth reading.
 */

import { API_KEY_ROUTES, isApiKeyScope } from '@qsim/contract'
import type { ApiKeyMeta } from '@qsim/db'
import type { FastifyPluginCallback } from 'fastify'
import { mintApiKey } from '../api-keys/secret.js'
import type { ApiEnv } from '../env.js'
import { ApiError } from '../errors.js'
import { requireViewerId } from '../plugins/auth.js'
import { strictRateLimit } from '../plugins/rate-limit.js'
import type { ZodTypeProvider } from '../plugins/validation.js'
import {
  ApiKeyCreatedEnvelope,
  ApiKeyEnvelope,
  ApiKeyIdParams,
  ApiKeyListEnvelope,
  CreateApiKeyBody,
} from './api-keys.schemas.js'

export interface ApiKeyRoutesOptions {
  readonly env: ApiEnv
}

/**
 * A row as the wire carries it.
 *
 * Takes `ApiKeyMeta` — the repository's own projection — rather than a
 * structural shape, so a column added to that projection is a compile error
 * here rather than a field that silently starts appearing in responses. On a
 * credentials table, that is the direction the type should push.
 *
 * The one transformation is the scope list, narrowed through the very
 * predicate the authentication path uses. `ApiKey.scopes` is `TEXT[]`, so a
 * row can hold a string this build has never heard of, and the two possible
 * behaviours are to report it or to drop it. Dropping is the only honest one:
 * `createApiKeyVerifier` drops it too, so a reported-but-unrecognised scope
 * would be a key advertising an authority it does not have — a listing that
 * disagrees with the enforcement it is describing.
 */
function toApiKeyResponse(row: ApiKeyMeta) {
  return { ...row, scopes: row.scopes.filter(isApiKeyScope) }
}

const plugin: FastifyPluginCallback<ApiKeyRoutesOptions> = (
  instance,
  options,
  done
) => {
  const app = instance.withTypeProvider<ZodTypeProvider>()
  const { env } = options

  app.get(
    API_KEY_ROUTES.collection,
    {
      config: { auth: 'required' },
      schema: { response: { 200: ApiKeyListEnvelope } },
    },
    async (request) => {
      const rows = await app.apiKeys.listApiKeys(requireViewerId(request))
      return { apiKeys: rows.map(toApiKeyResponse) }
    }
  )

  app.post(
    API_KEY_ROUTES.collection,
    {
      /*
       * The strict budget §11 reserves for authentication, and this route is
       * squarely in that class: it is the one endpoint that manufactures a
       * long-lived credential. A caller doing it in a loop is either a bug
       * filling somebody's twenty slots or an attacker with a stolen session
       * establishing persistence that outlives the session's own hour.
       */
      config: { auth: 'required', rateLimit: strictRateLimit(env) },
      schema: {
        body: CreateApiKeyBody,
        response: { 201: ApiKeyCreatedEnvelope },
      },
    },
    async (request, reply) => {
      const userId = requireViewerId(request)
      /*
       * Minted before the row is written, because the row is *derived from*
       * the key: the hash and the prefix are both functions of it. The other
       * order — allocate a row, then fill in a secret — has a window in which
       * a row exists that authenticates nothing.
       */
      const minted = mintApiKey()

      const apiKey = await app.apiKeys.createApiKey({
        userId,
        name: request.body.name,
        keyHash: minted.keyHash,
        keyPrefix: minted.keyPrefix,
        scopes: request.body.scopes,
      })

      /*
       * `minted.key` leaves the process here and is never held again. An
       * `ApiKeyLimitError` from the line above would have thrown before this
       * point, so a refused mint never produces a key that authenticates
       * nothing — and the log cannot carry one either: `scrubSecrets` redacts
       * anything matching the `qsk_` format out of every message and stack.
       */
      reply.status(201)
      return { apiKey: toApiKeyResponse(apiKey), key: minted.key }
    }
  )

  app.delete(
    API_KEY_ROUTES.item,
    {
      config: { auth: 'required' },
      schema: {
        params: ApiKeyIdParams,
        response: { 200: ApiKeyEnvelope },
      },
    },
    async (request) => {
      const apiKey = await app.apiKeys.revokeApiKey({
        id: request.params.id,
        userId: requireViewerId(request),
        at: new Date(),
      })
      /*
       * 404 and never 403, for the reason every read in this API does it: the
       * answer for somebody else's key id and for an id nobody minted must be
       * the same one, or the difference between them is an oracle over the
       * table. The owner scope is in the statement itself, so this is a second
       * guard rather than the only one.
       *
       * There is no cache to invalidate afterwards, which is the whole reason
       * `plugins/api-keys.ts` never caches a successful verification: the very
       * next request carrying this key finds no row and is refused, on this
       * instance and on any other.
       */
      if (apiKey === null) throw new ApiError('NOT_FOUND')
      return { apiKey: toApiKeyResponse(apiKey) }
    }
  )

  done()
}

export const apiKeyRoutes = plugin
