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
 */

import fp from 'fastify-plugin'
import type {
  FastifyInstance,
  FastifyRequest,
  RouteOptions,
  onRequestHookHandler,
} from 'fastify'
import { ApiError, toApiError } from '../errors.js'
import type { ApiEnv } from '../env.js'
import { JwksCache } from '../auth/jwks.js'
import { bearerToken, verifyAccessToken } from '../auth/verify.js'
import type { VerifiedIdentity } from '../auth/verify.js'

export type AuthPolicy = 'required' | 'optional' | 'public'

declare module 'fastify' {
  interface FastifyRequest {
    /** The verified identity, or `null` for an anonymous caller. */
    auth: VerifiedIdentity | null
    /**
     * Set when a token was presented and did not verify. Held rather than
     * thrown so the rate limiter still sees the request; `enforceAuthPolicy`
     * throws it a hook later.
     */
    authFailure: ApiError | null
  }

  interface FastifyContextConfig {
    auth?: AuthPolicy
  }

  interface FastifyInstance {
    /** Rejects requests that a route's declared policy does not allow. */
    enforceAuthPolicy: onRequestHookHandler
    /** Exposed for the health route and for tests; never for route code. */
    jwks: JwksCache
  }
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
 * that "the viewer" always means "a `sub` claim this process verified" and
 * never an id that arrived in a body or a path.
 */
export function viewerIdOf(request: FastifyRequest): string | null {
  return request.auth?.userId ?? null
}

/**
 * The viewer id on a route that declared `auth: 'required'`, narrowed to a
 * string. Throwing here rather than returning `string | null` keeps handlers
 * from growing a null check that can only be reached by a policy bug.
 */
export function requireViewerId(request: FastifyRequest): string {
  const identity = request.auth
  if (identity === null) throw new ApiError('AUTH_REQUIRED')
  return identity.userId
}

function authPlugin(
  app: FastifyInstance,
  options: AuthPluginOptions,
  done: (error?: Error) => void
): void {
  const { env } = options
  const jwks = options.jwks ?? new JwksCache({ url: env.jwksUrl })

  app.decorate('jwks', jwks)
  /*
   * `decorateRequest` with `null` rather than with an object: Fastify shares
   * one prototype across every request, so a decorator holding an object
   * would be the *same* object on every request — one caller's identity
   * visible to the next. `null` is a primitive and each request overwrites
   * its own slot.
   */
  app.decorateRequest('auth', null)
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
  })

  app.addHook('onRequest', async (request) => {
    const header = request.headers.authorization
    if (header === undefined) return

    const token = bearerToken(header)
    if (token === null) {
      request.authFailure = new ApiError('AUTH_INVALID_TOKEN')
      return
    }

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

    if (policy === 'required' && request.auth === null) {
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
