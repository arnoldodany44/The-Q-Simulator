/**
 * The process. Railway runs `node dist/worker.js` (§12.4).
 *
 * Everything interesting is in `pool.ts`, `processor.ts` and `queue.ts`; this
 * file owns what a process owns — reading the environment, refusing to start
 * when it cannot do its job, and dying well.
 *
 * ── Dying well means something different here than in the API ─────────────
 *
 * The API's graceful shutdown is about in-flight *requests*, which are
 * milliseconds. A shutdown here can be holding a job that is forty seconds into
 * a sixty-second bound, and there are two bad answers: abandon it, and it is
 * re-executed from scratch by the next worker; wait forever, and the deploy
 * hangs until the platform sends SIGKILL — which skips every hook and leaves
 * children orphaned and Postgres connections held.
 *
 * So the shutdown is: stop taking new jobs, let the current ones finish, and
 * bound the whole thing with a timer that is deliberately longer than the API's
 * (thirty seconds against ten) because the work is. Past the bound, the pool is
 * closed — which SIGKILLs every child — and the process exits. The jobs those
 * children were running are not lost: their locks expire, BullMQ declares them
 * stalled and another worker takes them (see `queue.ts` in `@qsim/jobs`).
 *
 * ── Children are killed, always, on every path ────────────────────────────
 *
 * A forked child is not a dependent of its parent at the OS level: kill the
 * worker and the children go on running, holding their memory and finishing
 * simulations nobody will read. Every exit path below goes through
 * `pool.close()` for that reason, including the failure paths.
 */

import process from 'node:process'
import { fileURLToPath } from 'node:url'
import {
  disconnectPrismaClient,
  getPrismaClient,
  prismaSimulationRunRepository,
} from '@qsim/db'
import { pino } from 'pino'
import { EnvValidationError, loadProcessEnv } from './env.js'
import { createPool } from './pool.js'
import { startReaper } from './reaper.js'
import { assertReachable, createConnection, startQueue } from './queue.js'

const env = (() => {
  try {
    return loadProcessEnv()
  } catch (error) {
    if (error instanceof EnvValidationError) {
      // Straight to stderr, before a logger exists: whoever reads this is
      // looking at a crashed deploy's console and needs to read it, not parse
      // it.
      console.error(`\n${error.message}\n`)
      process.exit(1)
    }
    throw error
  }
})()

const log = pino({
  level: env.logLevel,
  /*
   * The same redaction discipline as the API's logger. A job payload carries a
   * whole circuit and the id of whoever submitted it; neither belongs in a log
   * aggregator, and the fields below are the ones a careless `err` serialisation
   * would carry them out through.
   */
  redact: {
    paths: ['*.circuit', '*.payload', 'err.cause.circuit'],
    censor: '[redacted]',
  },
})

/**
 * Where the forked child lives.
 *
 * `import.meta.url` and not a hand-written path, because this file is bundled:
 * at runtime it is `dist/worker.js` and its sibling is `dist/simulate.child.js`,
 * which is exactly what `build.js` emits. Resolving relative to the module
 * means the pair moves together and neither `cwd` nor the start command can
 * separate them.
 */
const childPath = fileURLToPath(new URL('./simulate.child.js', import.meta.url))

const pool = createPool({
  size: env.concurrency,
  childPath,
  timeoutMs: env.timeoutMs,
  ceilings: { maxQubits: env.maxQubits, timeoutMs: env.timeoutMs },
})

const connection = createConnection(env.redisUrl)
connection.on('error', (error: unknown) => {
  // Logged rather than fatal: a consumer's job is to survive a blip. An
  // unreachable Redis *at startup* is the fatal case, and `assertReachable`
  // below is what makes it one.
  log.warn({ err: error }, 'redis connection error')
})

try {
  await assertReachable(connection)
} catch (error) {
  log.fatal(
    { err: error },
    'redis is unreachable; refusing to start as an idle worker'
  )
  await pool.close()
  process.exit(1)
}

/*
 * `getPrismaClient` reads `DATABASE_URL` itself and holds the singleton, which
 * is what keeps a redeploy from opening a second pool against a pooler budget
 * of one. `env.databaseUrl` is validated above and is the same value; parsing
 * it here is what turns a missing variable into a named boot failure instead of
 * a throw from inside the client on the first job.
 */
const prisma = getPrismaClient()
const runs = prismaSimulationRunRepository(prisma)

const runtime = startQueue({
  env,
  connection,
  ports: {
    runs,
    pool,
    timeoutMs: env.timeoutMs,
    log: (level, fields, message) => {
      log[level](fields, message)
    },
  },
})

/*
 * The sweep that guarantees no run stays non-terminal for ever — see
 * `reaper.ts` for the three ways one can, none of which the queue can recover
 * from on its own. It lives in this process because this process already owns
 * writing to those rows and because there is one of it.
 */
const reaper = startReaper({
  runs,
  log: (level, fields, message) => {
    log[level](fields, message)
  },
})

log.info(
  {
    concurrency: env.concurrency,
    maxQubits: env.maxQubits,
    timeoutMs: env.timeoutMs,
    queuePrefix: env.queuePrefix,
  },
  'worker ready'
)

let shuttingDown = false

async function shutdown(signal: string): Promise<void> {
  // Platforms send SIGTERM twice, and an impatient operator adds a SIGINT.
  if (shuttingDown) return
  shuttingDown = true

  log.info({ signal }, 'shutting down')

  const forceExit = setTimeout(() => {
    log.error(
      { signal, timeoutMs: env.shutdownTimeoutMs },
      'graceful shutdown timed out; killing children and exiting'
    )
    void pool.close().finally(() => {
      process.exit(1)
    })
  }, env.shutdownTimeoutMs)
  forceExit.unref()

  reaper.stop()

  try {
    await runtime.close()
    await pool.close()
    await disconnectPrismaClient()
    clearTimeout(forceExit)
  } catch (error) {
    log.error({ err: error }, 'shutdown failed')
    await pool.close()
    process.exit(1)
  }
}

for (const signal of ['SIGTERM', 'SIGINT'] as const) {
  process.on(signal, () => void shutdown(signal))
}

/*
 * A rejection nobody handled has left some state undefined by definition, and
 * this process holds child processes and a database pool. Stopping is safer
 * than continuing to accept jobs from an unknown state.
 */
process.on('unhandledRejection', (reason) => {
  log.fatal({ err: reason }, 'unhandled rejection')
  void shutdown('unhandledRejection')
})

process.on('uncaughtException', (error) => {
  log.fatal({ err: error }, 'uncaught exception')
  void shutdown('uncaughtException')
})
