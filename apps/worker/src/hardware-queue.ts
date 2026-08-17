/**
 * The hardware consumer, and the sweep that makes "resume a job this worker did
 * not submit" true.
 *
 * ══════════════════════════════════════════════════════════════════════════
 * TWO MECHANISMS, AND THEY COVER DIFFERENT FAILURES
 *
 * **The schedule** is the normal path: every tick books the next one as a
 * delayed BullMQ job. Delayed jobs live in Redis, so a worker that is killed,
 * redeployed or evicted loses nothing — the tick is already booked and whichever
 * replica is running when it comes due takes it.
 *
 * **The sweep** is for everything the schedule cannot recover from, and each of
 * these is real:
 *
 *   - the API created a row and the tick it scheduled was lost — Redis was
 *     flushed, the key expired, the delayed job was removed by an operator;
 *   - a tick failed *between* writing the row and booking its successor, so the
 *     row moved and nothing is waiting for it;
 *   - a queue prefix changed under a deployment, orphaning every booked tick;
 *   - a job was submitted by a build that is no longer running.
 *
 * It reads "non-terminal, not polled since `RESUME_IDLE_MS`, least recently
 * first, NULLs first" and books a tick for each. Five minutes is comfortably
 * longer than the longest scheduled gap, so a job that is being polled normally
 * is never resumed and the two mechanisms never double each other.
 *
 * ══════════════════════════════════════════════════════════════════════════
 * WHY THE SWEEP RUNNING ON EVERY REPLICA IS SAFE
 *
 * Because a tick's queue job id is deterministic in `(jobId, tick)`. Two
 * replicas that both decide job `abc` needs its fourth poll produce the same
 * id, and BullMQ keeps one. Without that, the sweep would be a fan-out: every
 * replica booking its own copy of every job's next poll, multiplying the
 * provider's request rate by the number of containers.
 *
 * ══════════════════════════════════════════════════════════════════════════
 * WHY THIS QUEUE RETRIES NOTHING
 *
 * `attempts: 1`. A tick that failed is not retried by BullMQ, because the
 * *next* tick already is the retry — booked by the tick that failed, or by the
 * sweep if that one never ran. Two retry mechanisms on one job would double
 * every poll, and on the one call in this system that spends somebody's
 * ten-minute allowance, a duplicate is not a wasted request: it is a second job
 * on a real machine.
 *
 * The exception is a storage failure, which is rethrown so that BullMQ files it
 * as failed and an operator can see it. The row is unchanged in that case, so
 * the sweep is what actually recovers it.
 */

import { Worker } from 'bullmq'
import type { Job } from 'bullmq'
import {
  HARDWARE_JOB_NAME,
  HARDWARE_QUEUE,
  RESUME_BATCH,
  RESUME_IDLE_MS,
  RESUME_INTERVAL_MS,
  encodeRunEvent,
  hardwareEventChannel,
  parseHardwarePayload,
  pollDelayMs,
} from '@qsim/jobs'
import type { HardwareJobPayload } from '@qsim/jobs'
import type { HardwareRepository } from '@qsim/db'
import type { Redis } from 'ioredis'
import { pollHardwareJob } from './hardware.js'
import type {
  HardwarePollPorts,
  HardwarePublication,
  PollOutcome,
} from './hardware.js'

export type Logger = (
  level: 'info' | 'warn' | 'error',
  fields: Record<string, unknown>,
  message: string
) => void

/**
 * How a tick is booked, from anywhere in this process.
 *
 * A function rather than a `Queue` handle at every call site, so that the
 * consumer, the sweep and the poll all book ticks the same way and cannot
 * disagree about the id.
 */
export type ScheduleTick = (
  payload: HardwareJobPayload,
  delayMs: number
) => Promise<void>

export interface HardwareRuntimeOptions {
  readonly connection: Redis
  readonly queuePrefix: string
  readonly concurrency: number
  readonly jobs: HardwareRepository
  readonly clientFor: HardwarePollPorts['clientFor']
  readonly schedule: ScheduleTick
  readonly log: Logger
}

export interface HardwareRuntime {
  readonly worker: Worker<HardwareJobPayload>
  /** Runs one sweep now. Answers how many ticks it booked. */
  resumeOnce(): Promise<number>
  close(): Promise<void>
}

/**
 * Publishes a poll's findings to whoever is watching over §8's socket.
 *
 * Fire-and-forget and swallowed, exactly like the simulation publisher: a job
 * that failed because a notification could not be delivered would be an absurd
 * trade, and the client falls back to `GET /hardware/jobs/:id` — which is what
 * it does across a reconnect anyway.
 */
export function createHardwarePublisher(options: {
  connection: Pick<Redis, 'publish'>
  prefix: string
  log: Logger
}): (event: HardwarePublication) => void {
  return (event) => {
    const channel = hardwareEventChannel(options.prefix, event.jobId)
    const payload =
      event.kind === 'status'
        ? encodeRunEvent({
            type: 'hardware:status',
            // The subscription key. See `@qsim/jobs`' `events.ts` for why the
            // field is shared with the simulation events.
            runId: event.jobId,
            at: Date.now(),
            status: event.status,
            queuePosition: event.queuePosition,
          })
        : encodeRunEvent({
            type: 'hardware:complete',
            runId: event.jobId,
            at: Date.now(),
            status: event.status,
            error: event.error,
          })
    void options.connection
      .publish(channel, payload)
      .then(() => undefined)
      .catch((error: unknown) => {
        options.log(
          'warn',
          { jobId: event.jobId, err: error },
          'could not publish a hardware event; the client will poll instead'
        )
      })
  }
}

export function startHardwareQueue(
  options: HardwareRuntimeOptions
): HardwareRuntime {
  const publish = createHardwarePublisher({
    connection: options.connection,
    prefix: options.queuePrefix,
    log: options.log,
  })

  const ports: HardwarePollPorts = {
    jobs: options.jobs,
    clientFor: options.clientFor,
    schedule: options.schedule,
    publish,
    log: options.log,
  }

  const worker = new Worker<HardwareJobPayload, PollOutcome>(
    HARDWARE_QUEUE,
    async (job: Job<HardwareJobPayload>) =>
      /*
       * Parsed rather than cast. A job in Redis is a job anything holding the
       * connection string can add, and this one names a row whose credential
       * will be decrypted — so what comes off the queue is untrusted input, in
       * exactly the sense `payload.ts` argues for the simulation queue.
       */
      pollHardwareJob(parseHardwarePayload(job.data), ports),
    {
      connection: options.connection,
      prefix: options.queuePrefix,
      /*
       * Higher than the simulation worker's, and for the opposite reason. Each
       * unit of *that* concurrency is a child process holding up to 256 MB of
       * typed array; a poll tick holds a socket for a few hundred milliseconds
       * and nothing else. What bounds this number is the provider's patience
       * rather than this container's memory.
       */
      concurrency: options.concurrency,
      /*
       * A tick is short, so its lock can be. Thirty seconds is what the
       * simulation queue needs because a simulation can block an event loop;
       * nothing here can, and a shorter lock means a tick lost to a killed
       * worker is re-delivered sooner.
       */
      lockDuration: 15_000,
      removeOnComplete: { count: 0 },
      removeOnFail: { age: 3600, count: 20 },
    }
  )

  worker.on('error', (error) => {
    options.log('warn', { err: error }, 'hardware queue connection error')
  })

  worker.on('failed', (job, error) => {
    /*
     * Only a storage failure reaches here — every failure of the *work* is a
     * terminal row and a tick that succeeded. The row is unchanged, so nothing
     * is scheduled and the sweep is what recovers it; the line is what makes
     * that visible rather than silent.
     */
    options.log(
      'error',
      { jobId: job?.data.jobId, err: error },
      'a hardware poll failed; the resume sweep will pick the job up'
    )
  })

  async function resumeOnce(): Promise<number> {
    const idleSince = new Date(Date.now() - RESUME_IDLE_MS)
    const stranded = await options.jobs.findResumable({
      idleSince,
      limit: RESUME_BATCH,
    })
    let booked = 0
    for (const job of stranded) {
      /*
       * `pollCount + 1` is the tick number, so a resumed job continues its own
       * schedule rather than restarting it — and, more to the point, produces
       * the same deterministic queue id every replica's sweep would produce.
       *
       * No delay: a job the sweep found has already been idle for at least
       * `RESUME_IDLE_MS`, so the thing it needs is a poll now.
       */
      const payload: HardwareJobPayload = {
        jobId: job.id,
        userId: job.userId,
        tick: Math.min(job.pollCount + 1, Number.MAX_SAFE_INTEGER),
      }
      try {
        await options.schedule(payload, 0)
        booked += 1
      } catch (error) {
        options.log(
          'warn',
          { jobId: job.id, err: error },
          'could not resume a stranded hardware job'
        )
      }
    }
    if (booked > 0) {
      options.log(
        'info',
        { booked },
        'resumed hardware jobs that nothing was polling'
      )
    }
    return booked
  }

  /*
   * Runs on a timer *and* once at boot, and the boot run is the important one:
   * a redeploy is by far the commonest way a tick is lost, and waiting a minute
   * to notice would make every deploy a visible stall on every job in flight.
   */
  const timer = setInterval(() => {
    void resumeOnce().catch((error: unknown) => {
      options.log('warn', { err: error }, 'a hardware resume sweep failed')
    })
  }, RESUME_INTERVAL_MS)
  timer.unref()

  void resumeOnce().catch((error: unknown) => {
    options.log('warn', { err: error }, 'the first hardware sweep failed')
  })

  return {
    worker,
    resumeOnce,
    async close() {
      clearInterval(timer)
      // Without `force`: a tick is milliseconds, so letting it finish costs
      // nothing and avoids a redelivery.
      await worker.close()
    },
  }
}

/** Books a tick on a queue, with the id every scheduler agrees on. */
export function scheduleOn(
  queue: {
    add: (
      name: string,
      data: HardwareJobPayload,
      options: { jobId: string; delay: number }
    ) => Promise<unknown>
  },
  tickId: (jobId: string, tick: number) => string
): ScheduleTick {
  return async (payload, delayMs) => {
    await queue.add(HARDWARE_JOB_NAME, payload, {
      jobId: tickId(payload.jobId, payload.tick),
      delay: delayMs === 0 ? 0 : delayMs || pollDelayMs(payload.tick),
    })
  }
}
