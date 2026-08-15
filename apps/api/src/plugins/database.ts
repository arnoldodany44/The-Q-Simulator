/**
 * The database handle, and the probe the health endpoint reports on.
 *
 * Two things here are deliberate and neither is obvious.
 *
 * **The client is built lazily, behind a getter.** Constructing it at boot
 * would open a connection before the process has finished starting, and
 * `DATABASE_URL` points at a shared pooler with `connection_limit=1` — so a
 * deploy that overlaps the previous instance would have two processes
 * fighting over one connection. Deferring means the pool is created by the
 * first query that needs it. It also keeps every test in this suite free of
 * a database: nothing touches `app.db`, so nothing connects.
 *
 * **The probe is separable from the client.** `checkDatabase` runs whatever
 * `probe` it was given, defaulting to `SELECT 1`. That is what lets the
 * health route be tested for both outcomes — reachable and not — against a
 * real Fastify instance and no Postgres, which is the only way the 503 path
 * is ever exercised.
 *
 * Shutdown disconnects through `@qsim/db`'s own singleton helper, and only
 * when this plugin was the thing that created it. With a budget of one
 * connection, a process that exits without releasing it makes the next
 * deploy's first requests wait on the pooler.
 */

import fp from 'fastify-plugin'
import { disconnectPrismaClient, getPrismaClient } from '@qsim/db'
import type { PrismaClient } from '@qsim/db'
import type { FastifyInstance } from 'fastify'

declare module 'fastify' {
  interface FastifyInstance {
    /** Built on first access. See the note above about `connection_limit=1`. */
    readonly db: PrismaClient
    checkDatabase(): Promise<DatabaseHealth>
  }
}

export interface DatabaseHealth {
  readonly reachable: boolean
  /** Round-trip time of the probe, or `null` when it did not come back. */
  readonly latencyMs: number | null
}

export interface DatabasePluginOptions {
  /** Injected by a caller that owns the client's lifetime. */
  readonly client?: PrismaClient
  /**
   * Injected by tests. Defaults to `SELECT 1` on the client.
   *
   * Takes no client argument on purpose: an injected probe must be able to
   * run without one existing at all, or every test would construct a
   * PrismaClient — and therefore need a real `DATABASE_URL` and a real
   * database — just to assert what the health endpoint answers.
   */
  readonly probe?: () => Promise<void>
  readonly probeTimeoutMs?: number
}

const DEFAULT_PROBE_TIMEOUT_MS = 2_000

class ProbeTimeoutError extends Error {
  constructor(timeoutMs: number) {
    super(`Database probe did not answer within ${String(timeoutMs)}ms`)
    this.name = 'ProbeTimeoutError'
  }
}

function databasePlugin(
  app: FastifyInstance,
  options: DatabasePluginOptions,
  done: (error?: Error) => void
): void {
  const injected = options.client
  const timeoutMs = options.probeTimeoutMs ?? DEFAULT_PROBE_TIMEOUT_MS

  let owned: PrismaClient | null = null
  const clientOf = (): PrismaClient => {
    if (injected !== undefined) return injected
    owned ??= getPrismaClient()
    return owned
  }

  const probe =
    options.probe ??
    (async () => {
      await clientOf().$queryRaw`SELECT 1`
    })

  app.decorate('db', { getter: clientOf })

  app.decorate('checkDatabase', async (): Promise<DatabaseHealth> => {
    const startedAt = performance.now()
    let timer: ReturnType<typeof setTimeout> | undefined
    try {
      await Promise.race([
        probe(),
        new Promise<never>((_resolve, reject) => {
          timer = setTimeout(() => {
            /*
             * A health check that hangs is worse than one that fails: the
             * platform's probe times out with no answer, and the log says
             * nothing. Losing the race is not cancellation — the query is
             * still out there — but the endpoint answers, which is its job.
             */
            reject(new ProbeTimeoutError(timeoutMs))
          }, timeoutMs)
        }),
      ])
      return {
        reachable: true,
        latencyMs: Math.round(performance.now() - startedAt),
      }
    } catch (error) {
      /*
       * Logged, never returned. A `pg` connection failure carries the
       * connection string in its message, so this is exactly the value that
       * must not reach a client — and pino's `err` serialiser is
       * `serializeError`, which scrubs it on the way to the log. Handed the
       * raw error rather than a pre-serialised one, or that serialiser runs
       * twice and the second pass loses the error's class.
       */
      app.log.error({ err: error }, 'database probe failed')
      return { reachable: false, latencyMs: null }
    } finally {
      if (timer !== undefined) clearTimeout(timer)
    }
  })

  app.addHook('onClose', async () => {
    // A client somebody handed us belongs to them; disconnecting it here
    // would close a pool the caller is still using.
    if (injected !== undefined || owned === null) return
    await disconnectPrismaClient()
  })

  done()
}

export default fp(databasePlugin, { name: 'qsim-database' })
