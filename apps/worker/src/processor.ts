/**
 * What happens to one job: validate, claim, run, write back.
 *
 * A plain function over three ports — the run repository, the pool, and
 * whatever signals completion — so that every failure mode in the milestone
 * brief can be exercised with none of them real. The BullMQ wiring is in
 * `queue.ts`; nothing in this file knows what a queue is.
 *
 * ── The order, and the one part of it that is not obvious ─────────────────
 *
 *   1. parse the payload. A job in Redis is a job anything with the connection
 *      string can add, so what comes off the queue is untrusted input and is
 *      parsed rather than cast.
 *   2. claim the run: QUEUED → RUNNING, conditionally. A claim that fails is
 *      not an error — it means this job is a **re-execution** of one that was
 *      already finished, or one another worker holds, and the honest response
 *      is to stop without touching anything.
 *   3. run it in a child, with a bound.
 *   4. write the answer, conditionally again.
 *
 * Step 2 is the interesting one, because it is what makes a re-executed job
 * harmless. BullMQ will re-execute: a worker killed mid-job stops renewing its
 * lock, the job is declared stalled, and a replacement picks it up (see
 * `queue.ts` in `@qsim/jobs`). That is *required* — the work was never done —
 * but the same mechanism will also re-execute a job whose work was finished and
 * whose worker died on the way to the database. Both are handled by the same
 * two compare-and-set writes: the second execution either fails to claim, or
 * claims and then fails to complete. Either way the row moves once.
 *
 * ── A RE-EXECUTION MAY TAKE OVER A RUN THAT IS ALREADY RUNNING ────────────
 *
 * And it must, or the mechanism above guarantees nothing. The worker that died
 * had already written its claim, so the row says RUNNING; a plain claim accepts
 * only QUEUED, so the replacement refused itself, reported the job done, and
 * left a row nothing would ever move again — a permanent spinner for the client
 * polling it. `ports.recovery` says "the queue is re-delivering this", which is
 * true only after the lock expired, and it widens the claim to a RUNNING row.
 *
 * The safety argument is the one the design already makes: two executions of
 * one job are possible whenever a stall is possible, and what makes that
 * harmless is that the *completion* is a compare-and-set. A terminal row is
 * still refused by both claims.
 *
 * ── A FAILURE OF THE STORAGE IS NOT A FAILURE OF THE WORK ─────────────────
 *
 * Every repository call goes through `storage()`, which tags whatever it throws
 * as a `RunStorageError`. Those are the only errors this function lets escape,
 * and they escape on purpose: they mean the row was *not* written, so the job
 * has genuinely not been done and BullMQ should re-execute it (`JOB_ATTEMPTS`,
 * with a backoff). Everything else — a circuit the engine refused, a child that
 * died, a timeout — is deterministic, is written as a FAILED row, and reports
 * the job as having succeeded in doing its work.
 *
 * Getting that distinction wrong in either direction is a stuck run: an error
 * that escapes without a retry leaves the row QUEUED behind a job Redis has
 * filed as failed, and a database outage recorded as `ENGINE_FAILED` tells a
 * user their circuit broke the engine while throwing a finished result away.
 *
 * ── The completion signal is last, and after the write ────────────────────
 *
 * `POST /simulate` waits on it and then reads the row. Signalling before the
 * write would race: the API would read a run that is still RUNNING, answer 202,
 * and the caller would poll for something that was already done. So the signal
 * strictly follows the write it is a signal about — and it is best-effort,
 * because a signal that failed to send costs one caller a 202 instead of a 201,
 * while a job that failed because of it would cost the whole run.
 */

import {
  SimulationFailure,
  failureCodeOf,
  initialProgress,
  parseJobPayload,
  shouldReport,
} from '@qsim/jobs'
import type { JobProgress, SimulationJobPayload } from '@qsim/jobs'
import type { SimulationRunRepository } from '@qsim/db'
import { NO_PUBLISHER } from './events.js'
import type { PublishRunEvent } from './events.js'
import type { SimulationPool } from './pool.js'

export interface ProcessorPorts {
  readonly runs: SimulationRunRepository
  readonly pool: SimulationPool
  /** Publishes progress. Failures are swallowed: progress is a decoration. */
  readonly reportProgress: (progress: JobProgress) => Promise<void> | void
  /** Tells a waiting `POST /simulate` that the row has reached its end state. */
  readonly signalCompletion: (runId: string) => Promise<void>
  /**
   * Announces the run's lifecycle to whoever is watching it over §8's socket.
   *
   * Defaulted, because a worker that cannot publish is a worker that works: a
   * client falls back to `GET /simulate/:runId`, which is the same path it
   * takes across a reconnect. Every call here is fire-and-forget — see
   * `events.ts` for why a notification may never be able to fail a run.
   */
  readonly publish?: PublishRunEvent
  /** For the log line beside the row, never for the row. */
  readonly log: (
    level: 'info' | 'warn' | 'error',
    fields: Record<string, unknown>,
    message: string
  ) => void
  readonly timeoutMs: number
  /**
   * Whether the queue is re-delivering this job rather than delivering it.
   *
   * True for a stalled job the queue recovered, and for a retry after a storage
   * failure — both cases in which the previous execution's lock is gone. It is
   * the only thing that lets a claim take over a RUNNING row; see the header.
   */
  readonly recovery?: boolean
  /** Injected so the throttle can be exercised without waiting for a clock. */
  readonly now?: () => number
}

/**
 * A repository call that did not happen.
 *
 * Distinct from every other failure in this file because it says nothing about
 * the circuit: the row is exactly as it was, so the job has not been done and
 * re-executing it is the correct response rather than a duplicate of one.
 */
export class RunStorageError extends Error {
  readonly operation: string

  constructor(operation: string, cause: unknown) {
    super(`the run repository failed during ${operation}`, { cause })
    this.name = 'RunStorageError'
    this.operation = operation
  }
}

/** Runs a repository call, tagging anything it throws. See the header. */
async function storage<T>(
  operation: string,
  action: () => Promise<T>
): Promise<T> {
  try {
    return await action()
  } catch (error) {
    throw new RunStorageError(operation, error)
  }
}

/**
 * A run id from a payload that did not parse, when there is one to be had.
 *
 * A payload can fail validation for a reason that has nothing to do with the id
 * it names — a shot count past the schema's maximum, a circuit the contract
 * refuses — and the id is right there. Skipping in that case left the run
 * QUEUED for ever under a log line claiming there was no run to fail, which was
 * simply untrue. Only a producer other than this API can reach it, which is
 * precisely the threat model the double validation here is written for.
 */
function runIdOf(raw: unknown): string | null {
  if (typeof raw !== 'object' || raw === null) return null
  const value: unknown = (raw as Record<string, unknown>).runId
  if (typeof value !== 'string') return null
  // The same shape the contract accepts, so a "run id" out of a hostile payload
  // cannot become a wildcard in a query.
  return /^[A-Za-z0-9_-]{1,64}$/.test(value) ? value : null
}

export type ProcessorOutcome =
  | { readonly kind: 'completed'; readonly durationMs: number }
  | { readonly kind: 'failed'; readonly code: string }
  /** The run was not claimable: already terminal, or held by another worker. */
  | { readonly kind: 'skipped' }

/**
 * Runs one job to a terminal row, and throws only when the job should be run
 * again.
 *
 * THROWING EXACTLY ONCE IS DELIBERATE and it is a decision about BullMQ rather
 * than about style. A processor that throws makes BullMQ mark the job failed
 * and — with a retry policy — run it again. Almost every failure this function
 * can reach is *deterministic*: the same circuit, from the same seed, refused
 * for the same reason. Retrying spends a second minute of a killable child to
 * reach the identical answer. So the job is reported as having succeeded in
 * doing its work, which was to write a FAILED row.
 *
 * The exception is a `RunStorageError`: the repository could not be reached, so
 * *nothing was written*. Reporting that job as done would leave a row QUEUED
 * behind a job Redis considers finished, which nothing in the system ever
 * revisits. It is rethrown, and `JOB_ATTEMPTS` is greater than one to match.
 */
export async function processSimulationJob(
  raw: unknown,
  ports: ProcessorPorts
): Promise<ProcessorOutcome> {
  let payload: SimulationJobPayload
  try {
    payload = parseJobPayload(raw)
  } catch (error) {
    const stranded = runIdOf(raw)
    if (stranded === null) {
      // Nothing can be written; the log is the only record, and the job is not
      // retried into the same wall.
      ports.log(
        'error',
        { err: error },
        'a job payload did not parse; it names no run to fail'
      )
      return { kind: 'skipped' }
    }
    ports.log(
      'error',
      { err: error, runId: stranded },
      'a job payload did not parse; failing the run it names'
    )
    const stored = await storage('failRun', () =>
      ports.runs.failRun({
        id: stranded,
        code: 'INVALID_CIRCUIT',
        durationMs: null,
      })
    )
    if (stored) await signalQuietly(ports, stranded)
    return { kind: 'failed', code: 'INVALID_CIRCUIT' }
  }

  const now = ports.now ?? Date.now
  const publish = ports.publish ?? NO_PUBLISHER

  const claimed = await storage('claimRun', () =>
    ports.runs.claimRun(payload.runId, { recovery: ports.recovery === true })
  )
  if (!claimed) {
    ports.log(
      'info',
      { runId: payload.runId, recovery: ports.recovery === true },
      'run was not claimable; another execution already owns it'
    )
    return { kind: 'skipped' }
  }

  /*
   * QUEUED → RUNNING, announced. This is the transition that is invisible
   * everywhere else: a job can sit behind other work for a minute reporting
   * nothing, because there is nothing to report, and a client watching an
   * estimate needs to know when the clock that estimate describes actually
   * started. It is published *after* the claim succeeded, so it is never a
   * second worker's announcement of a run it does not own.
   */
  publish({
    type: 'job:status',
    runId: payload.runId,
    at: now(),
    status: 'RUNNING',
  })

  const started = now()
  let result
  try {
    result = await ports.pool.run(payload, {
      timeoutMs: ports.timeoutMs,
      onProgress: throttled(ports, payload.runId),
    })
  } catch (error) {
    const code = failureCodeOf(error)
    ports.log(
      code === 'ENGINE_FAILED' ? 'error' : 'warn',
      {
        runId: payload.runId,
        code,
        // The engine's own English, in the log and only in the log (D2).
        detail: error instanceof Error ? error.message : String(error),
      },
      'run failed'
    )
    const durationMs = Math.max(0, Math.round(now() - started))
    const stored = await storage('failRun', () =>
      ports.runs.failRun({ id: payload.runId, code, durationMs })
    )
    // Same guard as the success path, and it matters more here: a failure
    // announced over a run somebody else already completed would replace a
    // good answer on screen with a code.
    if (stored) {
      publish({
        type: 'run:complete',
        runId: payload.runId,
        at: now(),
        status: 'FAILED',
        durationMs,
        error: code,
      })
    }
    await signalQuietly(ports, payload.runId)
    return { kind: 'failed', code }
  }

  {
    const stored = await storage('completeRun', () =>
      ports.runs.completeRun({
        id: payload.runId,
        result,
        durationMs: result.durationMs,
      })
    )
    if (!stored) {
      /*
       * The row went terminal while this job was running, which means this is
       * the second execution of a job whose first execution finished. The
       * result is discarded rather than written: it is the same answer, and
       * writing it would resurrect a run somebody may already have read.
       */
      ports.log(
        'warn',
        { runId: payload.runId },
        'result discarded: the run was already terminal'
      )
      return { kind: 'skipped' }
    }
    /*
     * Published only because `completeRun` said this execution is the one that
     * moved the row. A re-executed job whose first execution already finished
     * takes the branch above and announces nothing — otherwise a client would
     * see a run complete twice, and the second frame would arrive after it had
     * already read the answer.
     */
    publish({
      type: 'run:complete',
      runId: payload.runId,
      at: now(),
      status: 'DONE',
      durationMs: result.durationMs,
      error: null,
    })
    await signalQuietly(ports, payload.runId)
    return { kind: 'completed', durationMs: result.durationMs }
  }
}

/**
 * A progress reporter that writes to Redis a few times a second at most.
 *
 * The child emits a report per shot chunk — 780 of them for a hundred-thousand
 * shot run — and each write is a round trip to a metered instance to say
 * something a reader could not perceive. `shouldReport` is where that policy
 * lives; this is the state it needs.
 *
 * TWO SINKS, ONE THROTTLE. A report both updates the BullMQ job's progress
 * field — which is what `GET /simulate/:runId` reads, and therefore what a
 * client polling across a reconnect sees — and publishes an event for whoever
 * is watching the socket. Throttling once, here, is what keeps the two from
 * disagreeing about how far a run has got: they are the same report, delivered
 * two ways, rather than two schedules that happen to be similar.
 */
function throttled(
  ports: ProcessorPorts,
  runId: string
): (progress: JobProgress) => void {
  const now = ports.now ?? Date.now
  const publish = ports.publish ?? NO_PUBLISHER
  let previous: JobProgress | null = null
  let lastAt = 0

  function report(progress: JobProgress, at: number): void {
    // Fire and forget, and swallowed: a failed progress write must never fail a
    // run that is otherwise going perfectly.
    void Promise.resolve(ports.reportProgress(progress)).catch(() => undefined)
    publish({ type: 'run:progress', runId, at, progress })
  }

  // The first report goes out before any work does, so a claimed job is never
  // blank to a client that polls it immediately.
  const initial = initialProgress()
  lastAt = now()
  report(initial, lastAt)
  previous = initial

  return (progress) => {
    const at = now()
    if (!shouldReport(previous, progress, at - lastAt)) return
    previous = progress
    lastAt = at
    report(progress, at)
  }
}

async function signalQuietly(
  ports: ProcessorPorts,
  runId: string
): Promise<void> {
  try {
    await ports.signalCompletion(runId)
  } catch (error) {
    ports.log(
      'warn',
      { runId, err: error },
      'could not publish the completion signal; a waiting caller will poll'
    )
  }
}

/** Re-exported so `queue.ts` can name the failure type without a second import. */
export { SimulationFailure }
