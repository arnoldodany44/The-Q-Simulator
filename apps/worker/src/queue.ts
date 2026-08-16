/**
 * The BullMQ consumer: connection, worker, and the two Redis keys this system
 * owns itself.
 *
 * ── The connection is configured to persist, not to fail fast ─────────────
 *
 * Exactly the opposite of the API's client, and for a reason worth stating.
 * The API is answering an HTTP request somebody is waiting on, so a Redis that
 * is down must produce an error in seconds and become a 503. This process has
 * nobody waiting: its whole job is to be attached to a queue, so a dropped
 * connection is something to survive rather than something to report.
 * `maxRetriesPerRequest: null` is also a hard requirement of BullMQ's blocking
 * reads — with a finite retry count, a reconnect during a `BZPOPMIN` surfaces
 * as a command error and the worker stops consuming.
 *
 * ── Redis unreachable at startup is a refusal to start ────────────────────
 *
 * `assertReachable` pings before a worker is constructed. Without it the
 * process starts, reports healthy, retries a connection forever and consumes
 * nothing — green on every dashboard while the queue fills. §12.5 makes
 * `REDIS_URL` required here precisely so this can be a boot failure, and this
 * is where that becomes true.
 */

import { Worker } from 'bullmq'
import type { Job } from 'bullmq'
import {
  COMPLETED_RETENTION,
  COMPLETION_TTL_MS,
  FAILED_RETENTION,
  LOCK_DURATION_MS,
  MAX_STALLED_COUNT,
  SIMULATION_QUEUE,
  STALLED_CHECK_INTERVAL_MS,
  completionKey,
} from '@qsim/jobs'
import type { JobProgress, SimulationJobPayload } from '@qsim/jobs'
import { Redis } from 'ioredis'
import type { WorkerEnv } from './env.js'
import { createRunEventPublisher } from './events.js'
import { processSimulationJob } from './processor.js'
import type { ProcessorOutcome, ProcessorPorts } from './processor.js'

/** How long `assertReachable` waits for a PING before giving up. */
const PING_TIMEOUT_MS = 5_000

export function createConnection(url: string): Redis {
  return new Redis(url, {
    /*
     * Required by BullMQ for a consumer. A finite count turns a reconnect in
     * the middle of a blocking read into a command failure, and the worker
     * quietly stops taking jobs.
     */
    maxRetriesPerRequest: null,
    connectTimeout: 10_000,
    /*
     * Nothing here connects at import time. The process pings deliberately (see
     * `assertReachable`) so that an unreachable Redis is a named boot failure
     * rather than a client retrying in the background.
     */
    lazyConnect: true,
    retryStrategy: (attempt) => Math.min(attempt * 500, 5_000),
  })
}

/**
 * Refuses to continue unless Redis answers.
 *
 * A bounded wait, because `lazyConnect` plus ioredis's retry strategy would
 * otherwise keep trying forever — which is exactly the silent-idle failure this
 * function exists to prevent, arrived at from the other direction.
 */
export async function assertReachable(
  /*
   * Structural rather than `Pick<Redis, 'ping'>`: ioredis overloads `ping` for
   * the message form, and pinning to the overload set would make every test
   * double reproduce it to say "this answers".
   */
  connection: { ping: () => Promise<unknown> },
  timeoutMs: number = PING_TIMEOUT_MS
): Promise<void> {
  let timer: NodeJS.Timeout | undefined
  const expiry = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      reject(
        new Error(
          `Redis did not answer a PING within ${String(timeoutMs)} ms. ` +
            'This process is only a queue consumer; without Redis it has ' +
            'nothing to do, so it refuses to start rather than idle silently.'
        )
      )
    }, timeoutMs)
  })

  try {
    await Promise.race([connection.ping(), expiry])
  } finally {
    clearTimeout(timer)
  }
}

export interface QueueRuntime {
  readonly worker: Worker<SimulationJobPayload>
  close(): Promise<void>
}

export interface StartQueueOptions {
  readonly env: WorkerEnv
  readonly connection: Redis
  /** Everything `processSimulationJob` needs except the per-job progress sink. */
  readonly ports: Omit<
    ProcessorPorts,
    'reportProgress' | 'signalCompletion' | 'publish'
  >
}

/**
 * Attaches a consumer to the queue.
 *
 * `concurrency` is the number of jobs BullMQ will hold at once, and it is the
 * same number as the pool's size on purpose: a worker that accepted more jobs
 * than there are children would hold locks on jobs nothing was running, and the
 * lock is what tells the rest of the system that a job is being worked on.
 */
export function startQueue(options: StartQueueOptions): QueueRuntime {
  const { env, connection, ports } = options

  /*
   * Publishes on the *same* connection the consumer uses, which is safe and is
   * worth saying why: ioredis forbids ordinary commands only on a client in
   * subscriber mode, and nothing in this process ever subscribes — the worker
   * publishes, and the API is the one that listens. A second connection would
   * be a second TCP session and a second reconnect story on a metered tier, for
   * a `PUBLISH` that happens about four times a second per running job.
   */
  const publish = createRunEventPublisher({
    connection,
    prefix: env.queuePrefix,
    log: ports.log,
  })

  const worker = new Worker<SimulationJobPayload, ProcessorOutcome>(
    SIMULATION_QUEUE,
    async (job: Job<SimulationJobPayload>) =>
      processSimulationJob(job.data, {
        ...ports,
        publish,
        /*
         * Whether the queue is re-delivering this job. `stalledCounter` counts
         * the times a worker stopped renewing its lock on it; `attemptsStarted`
         * counts executions, so anything past the first is a re-delivery too
         * (a retry after a storage failure). Either way the previous execution
         * cannot still be holding the lock, which is what makes a recovery
         * claim safe — see `processor.ts`.
         */
        recovery: job.stalledCounter > 0 || job.attemptsStarted > 1,
        /*
         * BullMQ stores whatever this is handed as JSON on the job's hash, and
         * the API reads it back through `parseProgress`. Failures propagate to
         * the throttle in `processor.ts`, which swallows them.
         */
        reportProgress: (progress: JobProgress) => job.updateProgress(progress),
        signalCompletion: async (runId: string) => {
          await connection.set(
            completionKey(env.queuePrefix, runId),
            '1',
            'PX',
            COMPLETION_TTL_MS
          )
        },
      }),
    {
      connection,
      prefix: env.queuePrefix,
      concurrency: env.concurrency,
      /*
       * The three numbers that decide what happens to a job whose worker dies.
       * They live in `@qsim/jobs` rather than here because the API's retention
       * settings have to agree with them, and because the argument for each is
       * long enough to be worth writing once.
       */
      lockDuration: LOCK_DURATION_MS,
      /*
       * The API sets these on the job as it adds it, and a worker that
       * disagreed would apply its own to a job that was added by an older
       * build. Declared here as well so a job added by anything else — a
       * script, a replay — gets the same policy.
       */
      stalledInterval: STALLED_CHECK_INTERVAL_MS,
      maxStalledCount: MAX_STALLED_COUNT,
      removeOnComplete: { ...COMPLETED_RETENTION },
      removeOnFail: { ...FAILED_RETENTION },
    }
  )

  /*
   * An 'error' listener is not optional: an unhandled 'error' event on an
   * EventEmitter takes the process down, and a worker emits one for every
   * transient connection blip. The per-job failures do not come through here —
   * they are already rows.
   */
  worker.on('error', (error) => {
    ports.log('warn', { err: error }, 'queue connection error')
  })

  worker.on('stalled', (jobId) => {
    /*
     * Worth a line every time. A stall means a worker stopped renewing a lock,
     * and the only two explanations are a process that died and an event loop
     * that was blocked — the second of which is the failure `pool.ts` exists to
     * make impossible, so seeing this repeatedly means a simulation has found
     * its way back onto the main thread.
     */
    ports.log('warn', { jobId }, 'job stalled and will be re-executed')
  })

  worker.on('failed', (job, error) => {
    /*
     * The only thing that reaches here is a storage failure the processor
     * rethrew — every failure of the *work* is a FAILED row and a job that
     * succeeded. Logged with the attempt count because the interesting case is
     * the last one: past `JOB_ATTEMPTS` the queue stops, and what moves the row
     * then is the reaper.
     */
    ports.log(
      'error',
      {
        jobId: job?.id,
        attempts: job?.attemptsStarted,
        err: error,
      },
      'job execution failed and will be retried if attempts remain'
    )
  })

  return {
    worker,
    async close() {
      /*
       * `close()` without `force` lets in-flight jobs finish, which is what a
       * redeploy should do: the alternative is to abandon a job that is thirty
       * seconds into a sixty-second bound and have it re-executed from scratch.
       * The overall shutdown is bounded by `worker.ts`, so a job that will not
       * finish cannot hold the deploy open forever.
       */
      await worker.close()
      await connection.quit()
    },
  }
}
