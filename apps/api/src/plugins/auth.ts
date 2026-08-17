/**
 * Who the caller is, and whether this route cares.
 *
 * ── The two-phase shape, and why it is not one hook ───────────────────────
 *
 * Authentication happens in two separate hooks with the rate limiter
 * deliberately sandwiched between them:
 *
 *     onRequest, global: resolveIdentity   ← verifies, never rejects
 *     onRequest, route:  (rate limit)      ← keyed on the identity above
 *     onRequest, route:  enforceAuthPolicy ← rejects
 *
 * If verification rejected on the spot, a failed request would never reach
 * the limiter, and an attacker replaying garbage tokens would be limited by
 * nothing at all — the one caller who most needs limiting would be the one
 * exempt from it. Resolving first also gives the limiter a real per-user key
 * instead of a shared proxy IP, which is what §11's "per IP *and* per user"
 * actually requires.
 *
 * Getting that order took a look at the plugin's source. `@fastify/rate-limit`
 * does not install a global hook: its `onRoute` handler *appends* to each
 * route's own `onRequest` array. Fastify runs every global `onRequest` hook
 * before any route-level one, so a global enforcement hook — the obvious
 * implementation — always runs *before* the limiter, no matter what order
 * the plugins were registered in. That is why enforcement is attached the
 * same way, by an `onRoute` hook registered after the limiter's, and why
 * `authEnforcementPlugin` is separate from this one. The rate-limit test
 * that replays a bad token is what would catch a regression.
 *
 * ── Policy is declared, not remembered ────────────────────────────────────
 *
 * Every route states `config: { auth: 'required' | 'optional' | 'public' }`,
 * and an `onRoute` hook refuses to boot if one does not. A guard that must
 * be *remembered* — a `preHandler` added per route — fails silently when it
 * is forgotten: the route works, the tests pass, and private data is served
 * to anonymous callers. This one fails at startup, before a request exists.
 *
 * The distinction between `optional` and `public` is real:
 *   - `required`  a verified user, or 401. Anything that writes.
 *   - `optional`  the gallery. Anonymous readers are welcome, and the viewer
 *                 id — `null` or a verified `sub` — selects what they see
 *                 through the §11 filters in `@qsim/db`.
 *   - `public`    the identity is irrelevant, and so is a broken one. The
 *                 `Authorization` header is not consulted at all, which is
 *                 exactly what distinguishes this from `optional`: a liveness
 *                 probe that answered 401 because some caller attached a
 *                 stale token would be a healthy instance reporting itself
 *                 dead.
 *
 * `public` was written for health checks and said "nothing that serves data".
 * `GET /embed/:handle` (§3.4) is the one route that serves data under it, and
 * it is here for the same reason rather than in spite of it: an embed is
 * rendered inside a third party's page, so a response that varied with the
 * reader's token would publish an author's PRIVATE circuit to a whole blog
 * post the moment the author previewed their own embed. The route needs the
 * header to be *unreadable*, not merely unread, and `optional` cannot promise
 * that. See `routes/embed.ts`.
 *
 * ── The second credential, and the second declaration (§3.5) ──────────────
 *
 * A caller may also present an API key, which travels in the same
 * `Authorization: Bearer` header and is resolved by `plugins/api-keys.ts` into
 * `request.apiKey`. A key **acts as its user and can do no more** — every
 * query it reaches is scoped by the very `viewerIdOf` that scopes a session's
 * — but it may do *less*, and how much less is the second thing a route
 * declares:
 *
 *     config: { auth: 'required', scope: 'write' }
 *
 * A route that declares no `scope` is unreachable with a key, and that default
 * is the security property rather than an oversight. Every route in this API
 * predates the public one, so a permissive default would have published the
 * entire surface — key management and hardware included — on the commit that
 * introduced keys. Fail-closed also means the *next* route is session-only
 * until somebody decides otherwise, which is the only direction in which
 * forgetting is safe.
 *
 * The scope is singular, and that is deliberate: a list would immediately
 * raise "any of these, or all of them?", and a question a reader has to answer
 * from the implementation is a question two readers will answer differently.
 * One route, one capability.
 */

import fp from 'fastify-plugin'
import { API_KEY_SCOPES, isApiKeyScope } from '@qsim/contract'
import type { ApiKeyScope } from '@qsim/contract'
import type {
  FastifyInstance,
  FastifyRequest,
  RouteOptions,
  onRequestHookHandler,
} from 'fastify'
import { ApiError, toApiError } from '../errors.js'
import type { ApiEnv } from '../env.js'
import type { VerifiedApiKey } from '../api-keys/verify.js'
import { isApiKeyCredential } from '../api-keys/secret.js'
import { JwksCache } from '../auth/jwks.js'
import { bearerToken, verifyAccessToken } from '../auth/verify.js'
import type { VerifiedIdentity } from '../auth/verify.js'

export type AuthPolicy = 'required' | 'optional' | 'public'

declare module 'fastify' {
  interface FastifyRequest {
    /**
     * The verified *session*, or `null`.
     *
     * Strictly a Supabase JWT and never an API key, which is why the two have
     * separate slots rather than one synthesised identity. An API key has no
     * email, no display name and no expiry, so a synthesised `VerifiedIdentity`
     * would have to invent three claims — and code reading `auth.expiresAt`
     * would be reading a number nobody minted. Route code should reach for
     * `viewerIdOf`/`requireViewerId`, which answer "who is the caller" across
     * both.
     */
    auth: VerifiedIdentity | null
    /**
     * The verified API key, or `null`. Set by `plugins/api-keys.ts`.
     *
     * Never non-null at the same time as `auth`: the two resolvers each test
     * for their own token shape and a string cannot have both.
     */
    apiKey: VerifiedApiKey | null
    /**
     * Set when a credential was presented and did not verify — a bad JWT or an
     * unknown key alike. Held rather than thrown so the rate limiter still
     * sees the request; `enforceAuthPolicy` throws it a hook later.
     */
    authFailure: ApiError | null
  }

  interface FastifyContextConfig {
    auth?: AuthPolicy
    /**
     * The capability an API key must carry to use this route (§3.5).
     *
     * Absent means no key may use it, whatever its scopes. See the header.
     */
    scope?: ApiKeyScope
  }

  interface FastifyInstance {
    /** Rejects requests that a route's declared policy does not allow. */
    enforceAuthPolicy: onRequestHookHandler
    /** Exposed for the health route and for tests; never for route code. */
    jwks: JwksCache
    /**
     * Every route an API key may reach, recorded as the router received it.
     *
     * The authoritative answer to "what is the public API", derived from the
     * declarations rather than kept beside them — so it cannot disagree with
     * what is enforced, which a hand-maintained list eventually would. The
     * generated reference is checked against it, and so is the assertion that
     * the surface has not grown by accident.
     */
    readonly apiKeySurface: readonly ApiKeySurfaceEntry[]
  }
}

/** One method-and-path an API key may use, and the scope it must carry. */
export interface ApiKeySurfaceEntry {
  readonly method: string
  /** The template, including the `/api/v1` prefix the router registered. */
  readonly url: string
  readonly scope: ApiKeyScope
}

export interface AuthPluginOptions {
  readonly env: ApiEnv
  /** Tests inject a cache backed by a locally generated key pair. */
  readonly jwks?: JwksCache
}

/**
 * The viewer id in the form `@qsim/db`'s visibility filters expect.
 *
 * Route code calls this instead of reaching for `request.auth?.userId`, so
 * that "the viewer" always means "an identity this process verified" and never
 * an id that arrived in a body or a path.
 *
 * Both credentials answer here, and that single line is what makes §3.5's
 * strongest guarantee structural rather than intended: **an API key sees
 * exactly what its user sees**. Every visibility filter in the system takes
 * this value, so a key cannot reach another account's PRIVATE circuit for the
 * same reason its owner's browser cannot — there is no second code path where
 * a key is handled, and therefore no second path where the filter could be
 * forgotten.
 */
export function viewerIdOf(request: FastifyRequest): string | null {
  return request.auth?.userId ?? request.apiKey?.userId ?? null
}

/**
 * The viewer id on a route that declared `auth: 'required'`, narrowed to a
 * string. Throwing here rather than returning `string | null` keeps handlers
 * from growing a null check that can only be reached by a policy bug.
 */
export function requireViewerId(request: FastifyRequest): string {
  const viewerId = viewerIdOf(request)
  if (viewerId === null) throw new ApiError('AUTH_REQUIRED')
  return viewerId
}

/**
 * The `public.User` id of a caller whose row is guaranteed to exist already.
 *
 * `null` for a session, which has to go through `ensureOwner`: a Supabase
 * identity can make its very first authenticated request to a route that
 * writes, and the `public.User` row is created there rather than by a trigger
 * (see `users.ts` in @qsim/db).
 *
 * An API key is the opposite case and the guarantee is a foreign key:
 * `ApiKey.userId` references `User.id`, so a key can only exist if the row
 * does. Calling `ensureOwner` for it would be an upsert whose answer is
 * already known — and it would need an `email` claim that a key does not carry
 * and never will, which would turn every write by a key into a 403 about a
 * missing email address.
 */
export function establishedOwnerId(request: FastifyRequest): string | null {
  return request.apiKey?.userId ?? null
}

function authPlugin(
  app: FastifyInstance,
  options: AuthPluginOptions,
  done: (error?: Error) => void
): void {
  const { env } = options
  const jwks = options.jwks ?? new JwksCache({ url: env.jwksUrl })

  app.decorate('jwks', jwks)
  const apiKeySurface: ApiKeySurfaceEntry[] = []
  app.decorate('apiKeySurface', apiKeySurface)
  /*
   * `decorateRequest` with `null` rather than with an object: Fastify shares
   * one prototype across every request, so a decorator holding an object
   * would be the *same* object on every request — one caller's identity
   * visible to the next. `null` is a primitive and each request overwrites
   * its own slot.
   */
  app.decorateRequest('auth', null)
  app.decorateRequest('apiKey', null)
  app.decorateRequest('authFailure', null)

  app.addHook('onRoute', (route) => {
    /*
     * Fastify synthesises HEAD routes from GET ones and copies their config,
     * so this sees the policy the author wrote. A route with none is a
     * programming error and the process must not come up with it.
     */
    if (route.config?.auth === undefined) {
      throw new Error(
        `Route ${route.method.toString()} ${route.url} does not declare an ` +
          "auth policy. Add config: { auth: 'required' | 'optional' | " +
          "'public' } — see src/plugins/auth.ts for what each one means."
      )
    }

    const scope: unknown = route.config.scope
    /*
     * A misspelled scope would be a route no key could ever satisfy, because
     * the comparison is a string equality against what a stored row holds.
     * Silent unreachability is exactly the failure that gets shipped, so the
     * process refuses to come up with it.
     */
    if (scope !== undefined && !isApiKeyScope(scope)) {
      throw new Error(
        `Route ${route.method.toString()} ${route.url} declares an unknown ` +
          `API key scope. Use one of: ${API_KEY_SCOPES.join(', ')}.`
      )
    }
    /*
     * A `public` route never consults the header at all, so a scope on one
     * would describe a check that cannot run — and would read, to the next
     * person, as evidence that keys are honoured there. They are not.
     */
    if (scope !== undefined && route.config.auth === 'public') {
      throw new Error(
        `Route ${route.method.toString()} ${route.url} is auth: 'public' and ` +
          'declares an API key scope. A public route never reads the ' +
          'Authorization header, so the scope could never be checked.'
      )
    }

    if (scope !== undefined && isApiKeyScope(scope)) {
      const methods = Array.isArray(route.method)
        ? route.method
        : [route.method]
      for (const method of methods) {
        /*
         * HEAD is skipped because Fastify synthesises one from every GET and
         * copies its config, so recording it would list the public surface
         * with a phantom entry per read — a difference between what the
         * reference says and what the router holds, caused by a route nobody
         * wrote.
         */
        if (method === 'HEAD') continue
        apiKeySurface.push({ method, url: route.url, scope })
      }
    }
  })

  app.addHook('onRequest', async (request) => {
    const header = request.headers.authorization
    if (header === undefined) return

    const token = bearerToken(header)
    if (token === null) {
      request.authFailure = new ApiError('AUTH_INVALID_TOKEN')
      return
    }
    /*
     * Somebody else's credential. `plugins/api-keys.ts` resolves keys, and a
     * key handed to `jwtVerify` would be recorded here as an invalid *token* —
     * which is the same 401 by luck rather than by design, and would mean two
     * hooks both writing `authFailure` for one request with the loser's answer
     * silently overwriting the winner's.
     */
    if (isApiKeyCredential(token)) return

    try {
      request.auth = await verifyAccessToken(token, {
        keys: jwks,
        issuer: env.jwtIssuer,
        audience: env.jwtAudience,
      })
    } catch (error) {
      request.authFailure = toApiError(error)
    }
  })

  const enforceAuthPolicy: onRequestHookHandler = (request, _reply, done) => {
    /*
     * No route matched. Enforcement would turn every 404 into a 401, which
     * hides typos behind an authentication error; the not-found handler
     * answers instead.
     */
    if (request.routeOptions.url === undefined) {
      done()
      return
    }

    // Defaulting to the strictest policy: if the boot-time check above were
    // ever bypassed, the failure is a locked door rather than an open one.
    const policy = request.routeOptions.config.auth ?? 'required'

    /*
     * `public` means the identity is irrelevant, and that has to include a
     * *broken* identity or the word means nothing. The health endpoints are
     * the whole reason the policy exists, and they used to answer 401 to any
     * caller whose Authorization header held a stale token — a healthy
     * instance reporting itself dead, on the signal a platform restarts on.
     * A client-side token problem must not become a restart loop.
     */
    if (policy === 'public') {
      done()
      return
    }

    /*
     * On `required` and `optional` alike, a token that was presented and did
     * not verify is an error. Treating it as "anonymous" would mean a client
     * with a stale session silently sees the public view and never learns to
     * refresh — and it would make a bug in verification look exactly like a
     * successful anonymous request.
     */
    if (request.authFailure !== null) {
      done(request.authFailure)
      return
    }

    /*
     * The scope check (§3.5), and it runs before the `required` check below
     * rather than after. That order is what makes the answer specific: a key
     * without the scope for a route it may otherwise reach should be told
     * exactly that, not "authentication required", which would send its holder
     * to check a credential that verified perfectly.
     */
    const key = request.apiKey
    if (key !== null) {
      const required = request.routeOptions.config.scope
      if (required === undefined) {
        /*
         * Fail-closed: a route that never declared a scope is not part of the
         * public API. Key management and hardware live here permanently and by
         * decision — see `@qsim/contract`'s `api-keys.ts` — and everything
         * else lives here until somebody has thought about it.
         */
        done(new ApiError('API_KEY_NOT_ACCEPTED'))
        return
      }
      if (!key.scopes.includes(required)) {
        done(
          new ApiError('API_KEY_SCOPE_REQUIRED', {
            /*
             * The missing scope travels in `details`, because it is the one
             * thing the caller needs and cannot guess: it names the checkbox
             * to tick when minting the replacement. It discloses nothing — the
             * requirement is a property of the route, identical for everyone,
             * and published in the generated reference.
             */
            details: [{ path: 'scope', code: required }],
          })
        )
        return
      }
    }

    if (policy === 'required' && viewerIdOf(request) === null) {
      done(new ApiError('AUTH_REQUIRED'))
      return
    }
    done()
  }

  app.decorate('enforceAuthPolicy', enforceAuthPolicy)
  done()
}

/**
 * Appends a hook to a route's own `onRequest` list, the same way
 * `@fastify/rate-limit` does. Mutating `routeOptions` inside an `onRoute`
 * hook is the documented way to add a per-route hook from a plugin.
 */
function appendOnRequest(
  route: RouteOptions,
  hook: onRequestHookHandler
): void {
  const existing = route.onRequest
  if (existing === undefined) {
    route.onRequest = [hook]
  } else if (Array.isArray(existing)) {
    existing.push(hook)
  } else {
    route.onRequest = [existing, hook]
  }
}

/**
 * Registered *after* the rate limiter, so that enforcement lands after the
 * limiter's own route-level hook and a rejected token is still counted. See
 * the ordering argument at the top of this file.
 */
function authEnforcementPlugin(
  app: FastifyInstance,
  _options: unknown,
  done: (error?: Error) => void
): void {
  app.addHook('onRoute', (route) => {
    appendOnRequest(route, app.enforceAuthPolicy)
  })
  done()
}

export const authEnforcement = fp(authEnforcementPlugin, {
  name: 'qsim-auth-enforcement',
  dependencies: ['qsim-auth'],
})

export default fp(authPlugin, { name: 'qsim-auth' })
