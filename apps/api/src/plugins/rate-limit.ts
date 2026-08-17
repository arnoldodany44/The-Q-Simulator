/**
 * Rate limiting per IP, per user *and* per API key (§11, §3.5).
 *
 * The key is the whole design. Limiting by IP alone punishes everyone behind
 * a university NAT and does nothing about one account driving a script.
 * Limiting by user alone leaves anonymous traffic — the gallery, the landing
 * page, every unauthenticated probe — unbounded. So an authenticated request
 * is counted against its `sub` and an anonymous one against its address, and
 * the namespaces are prefixed so they can never collide.
 *
 * A request authenticated by an API key is counted against **the key** rather
 * than against the account that owns it, because a key *is* an identity: it is
 * one script, on one machine, doing one thing, and it is the unit somebody can
 * actually revoke. Folding it into the owner's budget would let a looping cron
 * job lock its author out of their own browser session, and would make a 429
 * name an account instead of the row that caused it.
 *
 * `request.auth` is populated by the auth plugin's `onRequest` hook, which
 * is why this plugin must be registered *after* it and why enforcement comes
 * after both — see the hook ordering argument in `plugins/auth.ts`.
 *
 * The store is in-memory, which is correct for exactly one instance and
 * wrong for two: each replica would then enforce its own copy of the limit.
 * Redis arrives in Phase 2 with `apps/worker`, and this becomes a
 * `redis:` option rather than a rewrite.
 *
 * ── What is deliberately not counted ──────────────────────────────────────
 *
 * A CORS preflight. `@fastify/cors` answers `OPTIONS` from a global
 * `onRequest` hook, before any route is matched and therefore before this
 * plugin's per-route hook exists, so the only place a limiter could sit is
 * *ahead* of CORS — and a 429 raised there leaves without
 * `Access-Control-Allow-Origin`, which a browser reports as a CORS error
 * rather than as a rate limit. That is precisely the afternoon-wasting
 * failure the registration order in `app.ts` was arranged to prevent, traded
 * for bounding a hook whose whole cost is a string comparison against the
 * origin allow-list. A rate limiter bounds expensive work and credential
 * stuffing; it is not a packet filter, and the platform edge is.
 *
 * Requests that match no route *are* counted — see the not-found handler in
 * `app.ts`, which takes `app.rateLimit()` as a `preHandler`.
 */

import fp from 'fastify-plugin'
import rateLimit from '@fastify/rate-limit'
import type { FastifyInstance, FastifyRequest } from 'fastify'
import { ApiError } from '../errors.js'
import type { ApiEnv } from '../env.js'

export interface RateLimitPluginOptions {
  readonly env: ApiEnv
}

/**
 * The tighter budget §11 asks for on authentication and on `/simulate`.
 *
 * Those two are singled out for different reasons: auth endpoints are where
 * credential stuffing goes, and `/simulate` is the one route where a single
 * request can cost seconds of CPU and gigabytes of memory. Spread as
 * `config: { rateLimit: strictRateLimit(env) }` on the route.
 */
export function strictRateLimit(env: ApiEnv): {
  max: number
  timeWindow: number
} {
  return { max: env.rateLimit.strictMax, timeWindow: env.rateLimit.windowMs }
}

function keyFor(request: FastifyRequest): string {
  /*
   * An API key is its own identity and gets its own budget (§3.5) — keyed on
   * the key's id and not on the account behind it. That is the whole point of
   * the field: a script holding one key must not be able to exhaust the
   * allowance of the person's browser session, and two scripts holding two
   * keys must not throttle each other. It is also what makes a runaway job
   * diagnosable: the 429s name a row somebody can revoke, rather than an
   * account with six keys and no way to tell which one is looping.
   *
   * Checked before `auth` because the two are mutually exclusive and this one
   * is the more specific fact. Prefixed like the others so the three
   * namespaces can never collide.
   */
  const key = request.apiKey
  if (key !== null) return `key:${key.keyId}`

  const identity = request.auth
  // Prefixed so that a user id can never be mistaken for an address, and so
  // a signed-in user carries their budget across networks instead of
  // inheriting whatever their current IP has already spent.
  return identity === null ? `ip:${request.ip}` : `user:${identity.userId}`
}

async function rateLimitPlugin(
  app: FastifyInstance,
  options: RateLimitPluginOptions
): Promise<void> {
  const { env } = options

  await app.register(rateLimit, {
    global: true,
    max: env.rateLimit.max,
    timeWindow: env.rateLimit.windowMs,
    hook: 'onRequest',
    keyGenerator: keyFor,
    /*
     * The plugin throws whatever this returns, so returning an `ApiError`
     * routes a 429 through the same error handler as everything else and the
     * body keeps the one shape clients parse. Returning a plain object would
     * produce a differently-shaped payload for this status alone.
     */
    errorResponseBuilder: () => new ApiError('RATE_LIMITED'),
    /*
     * `X-RateLimit-*` on every response, not only on the rejection: a client
     * that can see its remaining budget can slow down before it is cut off,
     * which is the difference between a queue and a retry storm.
     */
    addHeaders: {
      'x-ratelimit-limit': true,
      'x-ratelimit-remaining': true,
      'x-ratelimit-reset': true,
      'retry-after': true,
    },
  })
}

export default fp(rateLimitPlugin, {
  name: 'qsim-rate-limit',
  dependencies: ['qsim-auth'],
})
