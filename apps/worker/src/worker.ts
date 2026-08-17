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
import { Queue } from 'bullmq'
import {
  createCredentialCipher,
  decodeEncryptionKey,
  disconnectPrismaClient,
  getPrismaClient,
  prismaHardwareRepository,
  prismaSimulationRunRepository,
} from '@qsim/db'
import type { HardwareRepository } from '@qsim/db'
import { createIbmClient, createTokenCache, fetchTransport } from '@qsim/ibm'
import { HARDWARE_QUEUE, hardwareTickId } from '@qsim/jobs'
import type { HardwareJobPayload } from '@qsim/jobs'
import { pino } from 'pino'
import { EnvValidationError, loadProcessEnv } from './env.js'
import { buildWorkerLoggerOptions } from './logging.js'
import { startHardwareQueue, scheduleOn } from './hardware-queue.js'
import type { HardwareRuntime } from './hardware-queue.js'
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

/*
 * The same rules as the API's logger, from the same package — see
 * `logging.ts` for the leak that made sharing them non-optional. A job payload
 * carries a whole circuit and the id of whoever submitted it, an error carries
 * whatever the driver put in its message, and this is the process that holds
 * `ENCRYPTION_KEY`.
 */
const log = pino(buildWorkerLoggerOptions(env))

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
 * The hardware half, and it is optional in the same first-class way §11's key
 * is: with no `ENCRYPTION_KEY` this process consumes only the simulation queue,
 * and every hardware row simply waits for a deployment that has one. There is
 * no mode in which a credential is read without the key it was sealed under.
 */
const hardware: {
  runtime: HardwareRuntime
  queue: Queue<HardwareJobPayload>
  /** The rows, so the reaper can bound them. See `reaper.ts`. */
  jobs: HardwareRepository
  /** Drops every derived bearer token. Called on the way out — see `shutdown`. */
  forgetTokens: () => void
} | null = (() => {
  const key = env.hardware.encryptionKey
  if (key === null) return null

  const cipher = createCredentialCipher(decodeEncryptionKey(key))
  const jobs = prismaHardwareRepository(prisma)
  const transport = fetchTransport()
  const tokens = createTokenCache({
    transport,
    timeoutMs: env.hardware.timeoutMs,
  })

  /*
   * A second `Queue` on the *same* connection as the consumer. Safe, and worth
   * saying why: ioredis forbids ordinary commands only on a client in
   * subscriber mode, and nothing in this process ever subscribes — it publishes
   * and the API listens. A separate connection would be a second TCP session on
   * a metered tier for a few `ZADD`s a minute.
   */
  const queue = new Queue<HardwareJobPayload>(HARDWARE_QUEUE, {
    connection,
    prefix: env.queuePrefix,
    defaultJobOptions: { attempts: 1, removeOnComplete: true },
  })

  const runtime = startHardwareQueue({
    connection,
    queuePrefix: env.queuePrefix,
    concurrency: env.hardware.concurrency,
    jobs,
    schedule: scheduleOn(queue, hardwareTickId),
    /*
     * The credential's whole plaintext lifetime is one IAM exchange inside
     * `@qsim/ibm`. This closure reads it to learn which host to address, and
     * hands the key itself to the client as a *callback* so that nothing here
     * ever holds it — the same arrangement the API's port has, for the same
     * reason.
     */
    clientFor: async (credentialId, userId) => {
      const document = await jobs.openCredential(credentialId, userId, cipher)
      if (document === null) {
        /*
         * The credential is gone — deleted by its owner while a job of theirs
         * was in a queue. `DELETE /hardware/credentials/:id` calls
         * `hardware.forget(id)` in the API for exactly this reason ("a key
         * somebody revoked because it leaked would go on working from this
         * process for up to an hour"), and that call cannot reach this
         * process: two containers, two caches, no shared memory.
         *
         * This is the moment this process learns the same fact, and it is the
         * earliest one available: every tick re-reads the row before it builds
         * a client, so a deletion is observed on the next poll rather than an
         * hour later when the token expires. Dropping the derived bearer token
         * here is what closes the window on this side.
         */
        tokens.invalidate(credentialId)
        return null
      }
      return createIbmClient({
        crn: document.instance,
        credentialId,
        apiKey: async () => {
          const fresh = await jobs.openCredential(credentialId, userId, cipher)
          if (fresh === null) {
            throw new Error('the credential went away mid-exchange')
          }
          return fresh.apiKey
        },
        transport,
        tokens,
        timeoutMs: env.hardware.timeoutMs,
      })
    },
    log: (level, fields, message) => {
      log[level](fields, message)
    },
  })

  return {
    runtime,
    queue,
    jobs,
    forgetTokens: () => {
      tokens.clear()
    },
  }
})()

/*
 * The sweep that guarantees no row stays non-terminal for ever — see
 * `reaper.ts` for the ways one can, none of which the queues can recover from
 * on their own. It lives in this process because this process already owns
 * writing to those rows and because there is one of it.
 *
 * It is started *after* the hardware block so it can be given the hardware
 * repository: a hardware job with no horizon is what turns a lost submission
 * into a loop that keeps buying jobs on a real device.
 */
const reaper = startReaper({
  runs,
  ...(hardware === null ? {} : { hardware: hardware.jobs }),
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
    hardware: hardware !== null,
  },
  'worker ready'
)

if (hardware === null) {
  log.warn(
    { configuration: true },
    'ENCRYPTION_KEY is not set, so this worker consumes no hardware jobs. ' +
      'Simulation is unaffected; hardware rows wait for a deployment that ' +
      'has the key the API sealed them with.'
  )
}

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
    if (hardware !== null) {
      await hardware.runtime.close()
      await hardware.queue.close()
      /*
       * The bearer tokens go with the process, and they go *before* it is
       * gone: they live an hour, they belong to users rather than to this
       * service, and there is no reason for one to survive the process that
       * fetched it. The API's port clears its own cache in `close()` for the
       * same reason; this is the other half of that rule.
       */
      hardware.forgetTokens()
    }
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
