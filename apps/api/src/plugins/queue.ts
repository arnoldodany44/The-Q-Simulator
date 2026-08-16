/**
 * The queue, decorated onto the instance as `app.simulations`.
 *
 * ── The API never runs a simulation ───────────────────────────────────────
 *
 * That is the decision this file exists to enforce, and it is worth stating
 * plainly because §8's wording invites the opposite reading. "Síncrono si es
 * chico" is a promise about the *response*, not about which process did the
 * arithmetic. A twenty-qubit statevector is sixteen megabytes and a couple of
 * hundred million kernel operations, and running that on Fastify's event loop
 * would stop this process answering anything — the gallery, a sign-in, the
 * platform's own health probe — for as long as it took. There would then be
 * two implementations of "run a circuit safely" in the system, and the one in
 * the API would be the one with no kill switch, which is precisely what §11
 * forbids.
 *
 * So every run goes to the queue, and a *small* run is one the API is willing
 * to wait for. `routeOf` in `@qsim/jobs` decides which, from the browser's own
 * ceiling; this port is what the waiting is done through.
 *
 * ── Why the waiting is a key and not a subscription ───────────────────────
 *
 * BullMQ offers `job.waitUntilFinished`, and it needs a `QueueEvents`
 * instance: a permanently blocking `XREAD` connection that streams *every*
 * event in the queue — added, active, progress, completed — into every API
 * replica, for as long as the process lives. On a shared, metered, 256 MB
 * instance that is a standing cost to serve a two-second wait that most
 * requests never take.
 *
 * The alternative here costs one `SET` per finished run and a handful of `GET`s
 * per waiter, and nothing at all when nobody is waiting: the worker stamps a
 * one-byte completion key, and `awaitCompletion` polls it on a backoff that
 * starts fast (the common case finishes in a few hundred milliseconds) and
 * widens quickly. Polling Postgres instead was the other candidate and is worse
 * for a specific reason: `DATABASE_URL` carries `connection_limit=1`, so
 * thirty-odd status reads per synchronous request would queue behind each other
 * on a pool of one.
 *
 * ── Redis being absent is a supported state ───────────────────────────────
 *
 * `app.simulations` is `null` when no `REDIS_URL` was configured, and every
 * failure to reach Redis surfaces as `QueueUnavailableError`. Both become one
 * 503 on one route. The rest of the API does not know this plugin exists.
 */

import { Queue } from 'bullmq'
import {
  COMPLETED_RETENTION,
  COMPLETION_TTL_MS,
  DEDUPLICATION_TTL_MS,
  FAILED_RETENTION,
  JOB_ATTEMPTS,
  JOB_BACKOFF,
  SIMULATION_JOB_NAME,
  SIMULATION_QUEUE,
  completionKey,
  deduplicationKey,
  parseProgress,
} from '@qsim/jobs'
import type { JobProgress, SimulationJobPayload } from '@qsim/jobs'
import fp from 'fastify-plugin'
import type { FastifyInstance } from 'fastify'
import { Redis } from 'ioredis'
import type { ApiEnv } from '../env.js'

/**
 * Anything that stopped the queue from answering.
 *
 * Carries a `code` so `toApiError` maps it by shape rather than by message,
 * like every other domain error in this service. Deliberately one code for
 * "not configured", "cannot connect", "timed out" and "replied with an error":
 * they are the same fact to a client, which is that server-side simulation is
 * unavailable and everything else still works.
 */
export class QueueUnavailableError extends Error {
  readonly code = 'SIMULATION_UNAVAILABLE'

  constructor(detail: string, options: { cause?: unknown } = {}) {
    super(detail, options)
    this.name = 'QueueUnavailableError'
  }
}

export interface ClaimWorkInput {
  /** The full Redis key, built by `deduplicationKey` from the work digest. */
  readonly key: string
  /** The run id this caller would like to own the work. */
  readonly runId: string
}

/**
 * Everything `POST /simulate` and `GET /simulate/:runId` need from Redis.
 *
 * An interface for the same two reasons `CircuitRepository` is one, and neither
 * is "for mocking". The first is that CI must be able to exercise the whole
 * HTTP surface — routing, auth, the §11 visibility rules, the two response
 * shapes, every failure mode — without a live Redis, on an instance that is
 * shared with production and metered. The second is that the interesting
 * behaviour here is a *protocol* between two processes, and a protocol is
 * easier to get right when it is written down as five methods than when it is
 * spread through a route handler as raw commands.
 */
export interface SimulationQueue {
  /**
   * Claims a piece of work, returning whichever run id now owns it.
   *
   * A return value equal to `input.runId` means this caller won and should
   * enqueue. Anything else is the run id of an identical submission already in
   * flight, and this caller should discard its own row and answer with that
   * one — see `POST /simulate`.
   */
  claimWork(input: ClaimWorkInput): Promise<string>

  /**
   * Releases a claim this caller made, if it still holds it.
   *
   * Exists for one case and it is not a tidy-up: a run that *failed* is one a
   * person tries again immediately, and the deduplication key knows nothing
   * about status, so the retry was answered with the same failed run and
   * enqueued nothing — for the whole five minutes of `DEDUPLICATION_TTL_MS`.
   * From the reader's side that is a button that has stopped working.
   *
   * Compare-and-delete rather than a plain `DEL`: between reading the failed
   * run and releasing its key, a *third* submission may have claimed the work
   * legitimately, and deleting that claim would start the duplicate run the key
   * exists to prevent. Answers whether the key was released.
   */
  releaseWork(input: ClaimWorkInput): Promise<boolean>

  /** Adds the job. The job id is the run id, so a run is addressable in both. */
  enqueue(payload: SimulationJobPayload): Promise<void>

  /**
   * How many jobs are waiting to be run.
   *
   * Asked before every enqueue, because the instance is 256 MB with
   * `noeviction` and each job carries a whole circuit document: a queue with no
   * depth limit works perfectly until the memory runs out and then nothing
   * works at all. See `MAX_QUEUE_DEPTH`.
   */
  depth(): Promise<number>

  /**
   * Waits for the worker's completion signal, or gives up.
   *
   * Resolves `true` if the run finished inside the window and `false`
   * otherwise. Never rejects on a timeout: not finishing in two seconds is an
   * ordinary outcome and the caller answers 202 with a run id.
   */
  awaitCompletion(runId: string, timeoutMs: number): Promise<boolean>

  /** How far a running job has got, or `null` if the queue cannot say. */
  progressOf(runId: string): Promise<JobProgress | null>

  close(): Promise<void>
}

declare module 'fastify' {
  interface FastifyInstance {
    /** `null` when no REDIS_URL was configured. See the header. */
    readonly simulations: SimulationQueue | null
  }
}

export interface QueuePluginOptions {
  /** Injected by tests, and by nothing else. */
  readonly queue?: SimulationQueue
  readonly env: ApiEnv
}

/**
 * The backoff `awaitCompletion` polls on, in milliseconds.
 *
 * Front-loaded because the distribution is: a run the router called
 * "immediate" is one the cost model says fits inside the window, so most land
 * in the first few hundred milliseconds and a first poll at 25 ms costs one
 * command to catch them. The tail widens fast so that a two-second wait is
 * about eight commands rather than eighty — the difference between a metered
 * tier noticing and not.
 */
const POLL_SCHEDULE_MS = [25, 50, 75, 150, 250, 400] as const

/** The interval used once the schedule above is exhausted. */
const POLL_TAIL_MS = 400

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/**
 * The ioredis client the API uses, configured to **fail fast**.
 *
 * Opposite of what a worker wants, and deliberately. A worker holds a blocking
 * read and must survive a reconnect without giving up (`maxRetriesPerRequest:
 * null`); an API is answering an HTTP request that somebody is waiting on, so a
 * Redis that is down must produce an error in seconds and become a 503 —
 * retrying forever would hold the request until the platform's own timeout cut
 * it, which reads to a client as a hang rather than as an outage.
 */
function createClient(url: string): Redis {
  return new Redis(url, {
    maxRetriesPerRequest: 2,
    connectTimeout: 5_000,
    commandTimeout: 5_000,
    // Without this a connection failure at boot is an unhandled 'error' event
    // on a client nobody has awaited yet, which crashes the process.
    lazyConnect: true,
    retryStrategy: (attempt) => Math.min(attempt * 200, 2_000),
  })
}

export function bullSimulationQueue(env: ApiEnv): SimulationQueue {
  const url = env.queue.redisUrl
  if (url === null) {
    throw new QueueUnavailableError('REDIS_URL is not configured')
  }

  const connection = createClient(url)
  /*
   * An 'error' listener is not optional on an ioredis client: without one,
   * every connection failure is an unhandled error event, and an unhandled
   * error event on an EventEmitter takes the process down. The failures
   * themselves surface where they matter — on the command that was issued,
   * which becomes a 503.
   */
  connection.on('error', () => {
    /* handled per command; see above */
  })

  const queue = new Queue<SimulationJobPayload>(SIMULATION_QUEUE, {
    connection,
    prefix: env.queue.prefix,
    defaultJobOptions: {
      attempts: JOB_ATTEMPTS,
      // Only a storage failure reaches BullMQ as a failure (see the processor),
      // and that is transient — so the retries are spaced rather than immediate.
      backoff: { ...JOB_BACKOFF },
      removeOnComplete: { ...COMPLETED_RETENTION },
      removeOnFail: { ...FAILED_RETENTION },
    },
  })

  async function guarded<T>(
    what: string,
    action: () => Promise<T>
  ): Promise<T> {
    try {
      return await action()
    } catch (error) {
      throw new QueueUnavailableError(what, { cause: error })
    }
  }

  return {
    claimWork({ key, runId }) {
      return guarded('could not claim a deduplication key', async () => {
        /*
         * `SET key runId NX PX ttl` is the whole of the deduplication, and it
         * is one round trip because it has to be atomic: a GET followed by a
         * SET would let two identical submissions arriving together both see
         * an empty key, both create a row, and both enqueue.
         */
        const claimed = await connection.set(
          key,
          runId,
          'PX',
          DEDUPLICATION_TTL_MS,
          'NX'
        )
        if (claimed === 'OK') return runId
        const winner = await connection.get(key)
        /*
         * The key can expire between the failed SET and this GET. That leaves
         * nobody holding the work, and the honest answer is that this caller
         * now does — the alternative would be to fail a perfectly good request
         * over a race whose only consequence is that identical work might run
         * twice.
         */
        return winner ?? runId
      })
    },

    releaseWork({ key, runId }) {
      return guarded('could not release a deduplication key', async () => {
        /*
         * Lua rather than GET-then-DEL, because the two are the same race the
         * `SET NX` above exists to close: another submission can claim the key
         * between the read and the delete, and deleting *its* claim would let
         * two identical jobs run.
         */
        const released = await connection.eval(
          `if redis.call('get', KEYS[1]) == ARGV[1] then
             return redis.call('del', KEYS[1])
           else
             return 0
           end`,
          1,
          key,
          runId
        )
        return released === 1
      })
    },

    depth() {
      return guarded('could not read the queue depth', async () => {
        // Waiting only: `active` is bounded by the worker's concurrency and
        // `delayed` by the retry policy, and neither is a backlog somebody is
        // adding to. One LLEN.
        return await queue.getWaitingCount()
      })
    },

    enqueue(payload) {
      return guarded('could not enqueue the job', async () => {
        await queue.add(SIMULATION_JOB_NAME, payload, {
          /*
           * The run id *is* the job id. Deduplication is already handled by the
           * key above, so this is not doing that job — it is what makes a run
           * addressable in Redis from nothing but the id the client was given,
           * which is what `progressOf` needs and what a `GET` has in hand.
           */
          jobId: payload.runId,
        })
      })
    },

    async awaitCompletion(runId, timeoutMs) {
      const key = completionKey(env.queue.prefix, runId)
      const deadline = Date.now() + timeoutMs
      let index = 0

      for (;;) {
        const signalled = await guarded(
          'could not read a completion signal',
          () => connection.exists(key)
        )
        if (signalled === 1) return true

        const remaining = deadline - Date.now()
        if (remaining <= 0) return false
        const wait = POLL_SCHEDULE_MS[index] ?? POLL_TAIL_MS
        index++
        await sleep(Math.min(wait, remaining))
      }
    },

    async progressOf(runId) {
      /*
       * Failures are swallowed here and nowhere else in this file. Progress is
       * a decoration on a run that has already been read from Postgres, so a
       * Redis outage must degrade the response to "no progress" rather than
       * fail a `GET` that is otherwise perfectly answerable.
       */
      try {
        const job = await queue.getJob(runId)
        return job === undefined ? null : parseProgress(job.progress)
      } catch {
        return null
      }
    },

    async close() {
      /*
       * BOTH, AND IN THIS ORDER. BullMQ treats a connection it was *handed* as
       * shared (`isRedisInstance(opts.connection)` → `shared: true`) and never
       * quits it, so `queue.close()` leaves a live TLS socket to a metered
       * instance — with a retry strategy that keeps reconnecting. The process
       * then cannot exit on SIGTERM, `server.ts` calls no `process.exit` on the
       * happy path, and the platform's SIGKILL arrives instead, skipping every
       * remaining hook. This is the same two-step `apps/worker`'s queue does.
       */
      await queue.close()
      try {
        await connection.quit()
      } catch {
        // Already gone, or refusing to answer. Either way the socket must not
        // survive this call, and `disconnect` cannot fail.
        connection.disconnect()
      }
    },
  }
}

/** Marks a run finished, which is what `awaitCompletion` is waiting for. */
export async function signalCompletion(
  connection: Pick<Redis, 'set'>,
  prefix: string,
  runId: string
): Promise<void> {
  await connection.set(
    completionKey(prefix, runId),
    '1',
    'PX',
    COMPLETION_TTL_MS
  )
}

/** The deduplication key for a work digest, under this instance's prefix. */
export function workKey(env: ApiEnv, digestHex: string): string {
  return deduplicationKey(env.queue.prefix, digestHex)
}

function queuePlugin(
  app: FastifyInstance,
  options: QueuePluginOptions,
  done: (error?: Error) => void
): void {
  const injected = options.queue
  let owned: SimulationQueue | null = null
  let built = false

  app.decorate('simulations', {
    getter: (): SimulationQueue | null => {
      if (injected !== undefined) return injected
      if (options.env.queue.redisUrl === null) return null
      /*
       * Built on first use rather than at boot, for the reason the database
       * plugin is lazy: a connection opened during startup is a connection
       * opened before the platform's health check has passed, and a Redis that
       * is briefly unreachable would then look like a service that cannot
       * start rather than one route that cannot answer.
       */
      if (!built) {
        built = true
        owned = bullSimulationQueue(options.env)
      }
      return owned
    },
  })

  app.addHook('onClose', async () => {
    // Only what this process opened. An injected queue belongs to its test.
    if (owned !== null) await owned.close()
  })

  done()
}

export default fp(queuePlugin, { name: 'qsim-queue' })
