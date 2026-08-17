/**
 * The hardware poll queue, decorated onto the instance as `app.hardwareQueue`.
 *
 * ── Why this is not a method on `app.simulations` ────────────────────────
 *
 * Because it is a different BullMQ queue, and in BullMQ a queue is the unit at
 * which the retry policy, the retention policy and the consumer's concurrency
 * are set — and all three are *opposite* here. A simulation job is executed up
 * to three times, holds a lock for up to thirty seconds, and is retained for
 * five minutes; a hardware tick is executed once, holds a lock for a second, and
 * is retained for nothing, because there will be another one in a minute and a
 * thousand finished ticks on a 256 MB `noeviction` instance is how a queue
 * becomes an outage. `@qsim/jobs`' `hardware.ts` has the full argument.
 *
 * ── Why it opens its own connection, which is a real cost ────────────────
 *
 * One extra TCP session per API replica, on a metered tier. It is paid
 * deliberately and it is paid *lazily*: the getter builds nothing until a
 * hardware route is actually used, and §3.7's hardware is a feature a person
 * brings their own IBM account to — so on a deployment where nobody has, this
 * connection is never opened at all.
 *
 * The alternative was to reach into `plugins/queue.ts` and have it hand out two
 * queues over one connection. That is a genuinely better use of the tier and a
 * worse change to make now: it would rewrite the construction of the object
 * every `/simulate` test injects, to save a connection that most deployments
 * never open.
 *
 * ── The only thing this queue carries is "look at job X again" ───────────
 *
 * There is no payload worth losing. Everything a tick needs is in the row, so
 * a tick that vanishes costs nothing but latency — the resume sweep in
 * `apps/worker` finds the job and schedules another. That is why the enqueue
 * failure path here fails the *row* rather than retrying: a job left SUBMITTED
 * with nothing scheduled would be picked up by the sweep eventually, but the
 * row would sit there describing a submission that never happened, and saying
 * so immediately is the honest answer.
 */

import { Queue } from 'bullmq'
import {
  HARDWARE_JOB_NAME,
  HARDWARE_QUEUE,
  hardwareTickId,
  pollDelayMs,
} from '@qsim/jobs'
import type { HardwareJobPayload } from '@qsim/jobs'
import fp from 'fastify-plugin'
import type { FastifyInstance } from 'fastify'
import { Redis } from 'ioredis'
import type { ApiEnv } from '../env.js'
import { QueueUnavailableError } from './queue.js'

export interface HardwareQueue {
  /**
   * Schedules one poll of one job.
   *
   * `delayMs` defaults to this tick's place in the schedule, so the API and the
   * worker cannot disagree about when the first poll happens. The job id is
   * deterministic in `(jobId, tick)`, which is what stops the resume sweep from
   * becoming a fan-out — two schedulers that both decide job `abc` needs its
   * fourth poll produce one queue job.
   */
  enqueueTick(payload: HardwareJobPayload, delayMs?: number): Promise<void>
  close(): Promise<void>
}

declare module 'fastify' {
  interface FastifyInstance {
    /** `null` when no REDIS_URL was configured — see `plugins/queue.ts`. */
    readonly hardwareQueue: HardwareQueue | null
  }
}

export interface HardwareQueuePluginOptions {
  /** Injected by tests, and by nothing else. */
  readonly queue?: HardwareQueue
  readonly env: ApiEnv
}

/** Fail-fast, like the simulation queue's: an HTTP caller is waiting. */
function createClient(url: string): Redis {
  return new Redis(url, {
    maxRetriesPerRequest: 2,
    connectTimeout: 5_000,
    commandTimeout: 5_000,
    lazyConnect: true,
    retryStrategy: (attempt) => Math.min(attempt * 200, 2_000),
  })
}

export function bullHardwareQueue(env: ApiEnv): HardwareQueue {
  const url = env.queue.redisUrl
  if (url === null) {
    throw new QueueUnavailableError('REDIS_URL is not configured')
  }

  const connection = createClient(url)
  connection.on('error', () => {
    /* handled per command; an unhandled 'error' event exits the process */
  })

  const queue = new Queue<HardwareJobPayload>(HARDWARE_QUEUE, {
    connection,
    prefix: env.queue.prefix,
    defaultJobOptions: {
      /*
       * One attempt. A tick that failed is not retried by BullMQ, because the
       * *next* tick is already the retry — it is scheduled by the tick that
       * failed, or by the sweep if that one never ran. Retrying here would put
       * two schedules on one job and double every poll.
       */
      attempts: 1,
      /*
       * Kept for nothing. A finished tick has no diagnostic value — its whole
       * output is a row update — and a job polled for a day is 720 of them.
       * `removeOnFail` keeps a handful, which is the only case worth reading.
       */
      removeOnComplete: true,
      removeOnFail: { age: 3600, count: 20 },
    },
  })

  return {
    async enqueueTick(payload, delayMs) {
      try {
        await queue.add(HARDWARE_JOB_NAME, payload, {
          jobId: hardwareTickId(payload.jobId, payload.tick),
          delay: delayMs ?? pollDelayMs(payload.tick),
        })
      } catch (error) {
        throw new QueueUnavailableError('could not schedule a hardware poll', {
          cause: error,
        })
      }
    },

    async close() {
      // Both, in this order, for the reason `plugins/queue.ts` documents at
      // length: BullMQ never quits a connection it was handed.
      await queue.close()
      try {
        await connection.quit()
      } catch {
        connection.disconnect()
      }
    },
  }
}

function hardwareQueuePlugin(
  app: FastifyInstance,
  options: HardwareQueuePluginOptions,
  done: (error?: Error) => void
): void {
  const injected = options.queue
  let owned: HardwareQueue | null = null
  let built = false

  app.decorate('hardwareQueue', {
    getter: (): HardwareQueue | null => {
      if (injected !== undefined) return injected
      if (options.env.queue.redisUrl === null) return null
      if (!built) {
        built = true
        owned = bullHardwareQueue(options.env)
      }
      return owned
    },
  })

  app.addHook('onClose', async () => {
    if (owned !== null) await owned.close()
  })

  done()
}

export default fp(hardwareQueuePlugin, { name: 'qsim-hardware-queue' })
