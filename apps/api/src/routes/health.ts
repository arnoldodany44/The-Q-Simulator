/**
 * Health, in the two flavours a platform actually needs.
 *
 * `/health/live` answers whether the process is alive and does not touch
 * anything else. `/health` answers whether it can do its job, which means
 * asking the database. Conflating them is a well-known way to make an outage
 * worse: if the readiness check is what the platform restarts on, a database
 * blip restarts every replica, and a cold API cannot reconnect any faster
 * than a warm one could have.
 *
 * `/health` reports 503 when the database is unreachable — a status a load
 * balancer understands — while `/health/live` keeps answering 200, so the
 * instance stays up and recovers on its own.
 *
 * Both are outside `/api/v1` and outside rate limiting. A platform probes
 * every few seconds from a small set of addresses, and counting those against
 * the per-IP budget is how a healthy service starts failing its own checks.
 */

import type { FastifyPluginCallback } from 'fastify'

/**
 * Uptime measured from module load rather than from `process.uptime()`,
 * because everything outside `env.ts` is kept away from `process` (see the
 * lint rule). The two differ by the few milliseconds Node spends starting.
 */
const startedAt = Date.now()

export const healthRoutes: FastifyPluginCallback = (app, _options, done) => {
  app.get(
    '/health',
    /*
     * Deliberately no response schema. Every other route declares one so the
     * Zod serialiser can strip anything the route did not promise, but this
     * one has to answer while things are broken — and a serialisation
     * mismatch would turn an honest 503 into an opaque 500.
     */
    { config: { auth: 'public', rateLimit: false } },
    async (_request, reply) => {
      const database = await app.checkDatabase()
      reply.status(database.reachable ? 200 : 503)
      return {
        status: database.reachable ? 'ok' : 'degraded',
        uptimeSeconds: Math.round((Date.now() - startedAt) / 1000),
        database,
      }
    }
  )

  app.get(
    '/health/live',
    { config: { auth: 'public', rateLimit: false } },
    () => ({ status: 'ok' as const })
  )

  done()
}
