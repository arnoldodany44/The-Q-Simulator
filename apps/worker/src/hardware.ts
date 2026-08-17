/**
 * One tick of one hardware job's poll loop.
 *
 * ══════════════════════════════════════════════════════════════════════════
 * WHY A TICK AND NOT A LOOP
 *
 * A hardware job can take **hours** — a device with 24 835 jobs waiting is a
 * device whose answer arrives tomorrow — and this process does not own the
 * machine, cannot be told when it is done, and is redeployed several times a
 * week. So nothing is held open: no socket to the provider, no BullMQ lock
 * spanning the wait, no promise a process is parked on. The unit of work is one
 * question and one answer, a couple of hundred milliseconds long, followed by a
 * *scheduled* next tick.
 *
 * That is what makes the milestone's hardest requirement true. "A worker
 * restart must resume polling a job it did not submit" is not a recovery path
 * bolted on afterwards — it is the ordinary path, because every tick already
 * loads everything it needs from the row. There is nothing in this function
 * that knows or cares whether the previous tick ran in this process, in a
 * process that has since been killed, or an hour ago in a container that no
 * longer exists.
 *
 * ══════════════════════════════════════════════════════════════════════════
 * THE STATE MACHINE, AS THIS FUNCTION DRIVES IT
 *
 *   SUBMITTED  →  send it to the provider, record the id       →  QUEUED
 *   QUEUED     →  ask; still waiting                           →  QUEUED
 *   QUEUED     →  ask; it started                              →  RUNNING
 *   RUNNING    →  ask; finished                                →  read results
 *   anything   →  the person cancelled                         →  stop
 *
 * Every write is a compare-and-set (`@qsim/db`'s `hardware.ts`), and the one
 * that matters most is the first: `recordSubmission` accepts only a row that is
 * still SUBMITTED. That is the whole of **"a job cancelled before it was sent
 * is never sent"** — `DELETE /hardware/jobs/:id` moves the row to CANCELLED
 * first and tells the provider second, so a tick racing it either wins (and the
 * cancel then tells the provider) or loses (and this function finds a row it
 * cannot claim and stops without spending anything).
 *
 * ══════════════════════════════════════════════════════════════════════════
 * THE ONE CALL THAT SPENDS SOMEBODY'S MONTH
 *
 * `submitJob`. Everything else here — the token exchange, the status read, the
 * results read, the cancel — is free. The Open Plan grants ten minutes of QPU
 * time per twenty-eight days, it is the *user's* allowance and not the
 * project's (§3.7, risk 4), and it does not refill on request. So the
 * submission is guarded by a compare-and-set on both sides of it, is never
 * retried by BullMQ (`attempts: 1` on this queue), and is never reached at all
 * by a job whose row has moved.
 *
 * ══════════════════════════════════════════════════════════════════════════
 * WHAT COMES BACK, AND THE THIRD PLACE ENDIANNESS COULD GO WRONG
 *
 * Samples arrive as hexadecimal integers. They are handed to
 * `countsFromSamples` in `@qsim/transpile` — the one function in this project
 * that converts them — and the **layout is deliberately not applied**: the
 * transpiler permutes qubits and not classical bits, so the register that comes
 * home is already in the source document's own order.
 *
 * This is the worst place in the system for that to be wrong, and the reason is
 * not subtlety, it is the absence of an oracle. A simulator gives you an ideal
 * distribution to compare against; a real device gives you nothing. A reversed
 * register produces a histogram that is exactly as plausible as the right one,
 * on a machine that is genuinely noisy, and there is no assertion anybody can
 * write after the fact that would catch it. Which is why the conversion lives
 * in one place, is tested against asymmetric circuits, and is not re-implemented
 * here.
 */

import type { HardwareRepository, PollableHardwareJob } from '@qsim/db'
import { parseStoredProgram } from '@qsim/db'
import { IbmError } from '@qsim/ibm'
import type { IbmClient } from '@qsim/ibm'
import {
  MAX_POLL_ATTEMPTS,
  MAX_SUBMIT_ATTEMPTS,
  SUBMIT_CLAIM_MS,
  isTerminalHardwareStatus,
  pollDelayMs,
} from '@qsim/jobs'
import type {
  HardwareFailureCode,
  HardwareJobPayload,
  HardwareResult,
  HardwareStatus,
} from '@qsim/jobs'
import { countsFromSamples } from '@qsim/transpile'

/** A failure of the storage, which means the tick has not happened. */
export class HardwareStorageError extends Error {
  readonly operation: string

  constructor(operation: string, cause: unknown) {
    super(`the hardware repository failed during ${operation}`, { cause })
    this.name = 'HardwareStorageError'
    this.operation = operation
  }
}

async function storage<T>(
  operation: string,
  action: () => Promise<T>
): Promise<T> {
  try {
    return await action()
  } catch (error) {
    throw new HardwareStorageError(operation, error)
  }
}

export interface HardwarePollPorts {
  readonly jobs: HardwareRepository
  /**
   * A client for the credential this job names, or `null` when it is gone.
   *
   * `null` rather than a throw, because a deleted credential is an ordinary
   * outcome rather than an error: `ON DELETE SET NULL` keeps the job's record
   * of what was run, and a person who deletes a key while a job is queued has
   * simply made that job unpollable. It becomes `CREDENTIAL_MISSING`.
   */
  readonly clientFor: (
    credentialId: string,
    userId: string
  ) => Promise<IbmClient | null>
  /** Schedules the next tick. Failures are storage-shaped: see the header. */
  readonly schedule: (
    payload: HardwareJobPayload,
    delayMs: number
  ) => Promise<void>
  /** Announces the job's lifecycle over §8's socket. Fire-and-forget. */
  readonly publish?: (event: HardwarePublication) => void
  readonly log: (
    level: 'info' | 'warn' | 'error',
    fields: Record<string, unknown>,
    message: string
  ) => void
  readonly now?: () => Date
}

/** What the poll tells whoever is watching. Translated by `hardware-queue.ts`. */
export type HardwarePublication =
  | {
      readonly kind: 'status'
      readonly jobId: string
      readonly status: HardwareStatus
      readonly queuePosition: number | null
    }
  | {
      readonly kind: 'complete'
      readonly jobId: string
      readonly status: 'DONE' | 'FAILED' | 'CANCELLED'
      readonly error: string | null
    }

export type PollOutcome =
  /** The job moved and another tick is scheduled. */
  | { readonly kind: 'polled'; readonly status: HardwareStatus }
  /** The job reached a terminal status. Nothing more is scheduled. */
  | { readonly kind: 'finished'; readonly status: HardwareStatus }
  /** Nothing to do: no such job, already terminal, or another tick owns it. */
  | { readonly kind: 'skipped'; readonly reason: string }

/**
 * Runs one tick.
 *
 * Throws only `HardwareStorageError`, and only that, for the same reason
 * `processSimulationJob` does: a repository that could not be reached means the
 * row was *not* written, so the tick genuinely has not happened. Everything
 * else — a provider that refused, a device that failed, a result that could not
 * be read — is written as a terminal row and reported as a tick that did its
 * job.
 */
export async function pollHardwareJob(
  payload: HardwareJobPayload,
  ports: HardwarePollPorts
): Promise<PollOutcome> {
  const now = ports.now ?? (() => new Date())
  const publish = ports.publish ?? (() => undefined)

  const job = await storage('findPollable', () =>
    ports.jobs.findPollable(payload.jobId)
  )
  if (job === null) {
    ports.log('warn', { jobId: payload.jobId }, 'no such hardware job')
    return { kind: 'skipped', reason: 'no-such-job' }
  }
  if (isTerminalHardwareStatus(job.status)) {
    /*
     * The common benign race: the person cancelled while this tick was in
     * flight, or a previous tick already finished it. Nothing is scheduled, so
     * the loop ends here — which is exactly what should happen.
     */
    return { kind: 'skipped', reason: 'already-terminal' }
  }

  /*
   * The poll ceiling. What happens past it is a FAILED row and not a row left
   * running: a job that says "still going" for ever is worse than one that says
   * it gave up, because nobody can tell the two apart from the outside. The
   * provider may well still be running it, and `providerJobId` is in the
   * response so a person can go and look.
   */
  if (payload.tick >= MAX_POLL_ATTEMPTS) {
    return finish(ports, job, 'POLL_ABANDONED', now(), publish)
  }

  if (job.credentialId === null) {
    /*
     * The credential was deleted while this job was in a queue. The job cannot
     * be polled and cannot even be cancelled at the provider, because both need
     * the key — so the honest thing is to say so and stop.
     */
    return finish(ports, job, 'CREDENTIAL_MISSING', now(), publish)
  }

  const program = parseStoredProgram(job.program)
  if (program === null) {
    /*
     * Unreachable through `POST /hardware/jobs`, which writes the program in
     * the same statement that creates the row. If it is ever reached the row
     * predates that, and submitting would spend the allowance on a job whose
     * answer could not be read — which is the one outcome worth refusing.
     */
    return finish(ports, job, 'RESULT_UNREADABLE', now(), publish)
  }

  let client: IbmClient | null
  try {
    client = await ports.clientFor(job.credentialId, job.userId)
  } catch (error) {
    return failFromProvider(payload, ports, job, error, now(), publish)
  }
  if (client === null) {
    return finish(ports, job, 'CREDENTIAL_MISSING', now(), publish)
  }

  try {
    if (job.providerJobId === null) {
      return await submit(payload, ports, job, client, program, now, publish)
    }
    return await observe(payload, ports, job, client, program, now, publish)
  } catch (error) {
    if (error instanceof HardwareStorageError) throw error
    return failFromProvider(payload, ports, job, error, now(), publish)
  }
}

/* ─────────────────────────────── submitting ─────────────────────────────── */

async function submit(
  payload: HardwareJobPayload,
  ports: HardwarePollPorts,
  job: PollableHardwareJob,
  client: IbmClient,
  program: { qasm: string },
  now: () => Date,
  publish: (event: HardwarePublication) => void
): Promise<PollOutcome> {
  /*
   * ══════════════════════════════════════════════════════════════════════
   * THE CEILING ON ATTEMPTS, AND WHY IT IS NOT A RETRY BUDGET
   *
   * `pollCount` is incremented by the claim below, so it counts submission
   * attempts for a row that has never got past submission. Past the ceiling
   * the honest answer is not "try again": an answer that never arrived says
   * nothing about what the provider did with the bytes it already had, so a
   * fourth attempt would be buying a fourth job rather than recovering the
   * first. The row is failed by name and the provider's console is where the
   * question is settled.
   */
  if (job.pollCount >= MAX_SUBMIT_ATTEMPTS) {
    ports.log(
      'error',
      { jobId: job.id, attempts: job.pollCount },
      'a hardware job was never confirmed as submitted; giving up rather ' +
        'than sending it again'
    )
    return finish(ports, job, 'SUBMIT_ABANDONED', now(), publish)
  }

  /*
   * ══════════════════════════════════════════════════════════════════════
   * THE CLAIM, AND IT IS THE WHOLE GUARD
   *
   * `recordSubmission` below is a compare-and-set *after* the device has the
   * work: it can report a duplicate and cannot prevent one. This is the one
   * that runs before, and it is a single atomic UPDATE — so two ticks that
   * read the same SUBMITTED row (the API's tick 0 and a resume sweep's tick 1,
   * which is a real overlap of a couple of seconds) produce exactly one
   * submission. The loser stops here having spent nothing.
   */
  const claimed = await storage('claimSubmission', () =>
    ports.jobs.claimSubmission({
      id: job.id,
      at: now(),
      notClaimedSince: new Date(now().getTime() - SUBMIT_CLAIM_MS),
    })
  )
  if (!claimed) {
    ports.log(
      'info',
      { jobId: job.id },
      'another tick holds the submission claim for this job'
    )
    return { kind: 'skipped', reason: 'submission-claimed-elsewhere' }
  }

  /*
   * THE ONE CALL THAT SPENDS QPU TIME. Everything above it is free; everything
   * below it is reading. See the header.
   */
  const providerJobId = await client.submitJob({
    backend: job.backendName,
    qasm: program.qasm,
    shots: job.shots,
  })

  const recorded = await storage('recordSubmission', () =>
    ports.jobs.recordSubmission({ id: job.id, providerJobId })
  )
  if (!recorded) {
    /*
     * The row moved between the read at the top of this tick and here — in
     * practice, the person cancelled. The job now exists at the provider and
     * this system has no record of its id, so it is cancelled there
     * immediately rather than left to run against an allowance nobody wants
     * spent. Best effort: a provider that refuses leaves a job running that
     * this system will not collect, which is worth a log line and nothing more.
     */
    ports.log(
      'warn',
      { jobId: job.id, providerJobId },
      'the row moved during submission; cancelling at the provider'
    )
    try {
      await client.cancelJob(providerJobId)
    } catch (error) {
      ports.log(
        'warn',
        { jobId: job.id, providerJobId, err: error },
        'could not cancel a job whose row had already moved'
      )
    }
    return { kind: 'skipped', reason: 'row-moved-during-submission' }
  }

  publish({
    kind: 'status',
    jobId: job.id,
    status: 'QUEUED',
    queuePosition: null,
  })
  await scheduleNext(payload, ports)
  return { kind: 'polled', status: 'QUEUED' }
}

/* ─────────────────────────────── observing ──────────────────────────────── */

async function observe(
  payload: HardwareJobPayload,
  ports: HardwarePollPorts,
  job: PollableHardwareJob,
  client: IbmClient,
  program: {
    register: string
    clbits: number
    layout: readonly number[]
    calibratedAt?: string | null
  },
  now: () => Date,
  publish: (event: HardwarePublication) => void
): Promise<PollOutcome> {
  const providerJobId = job.providerJobId as string
  const reading = await client.readJob(providerJobId)

  if (reading.status === null) {
    /*
     * A status word this build has never seen. Treated as "no transition"
     * rather than as a failure, because guessing FAILED for a provider that
     * added `Validating` would mark a wave of perfectly healthy jobs as failed.
     * The row keeps its status and the loop keeps asking.
     */
    ports.log(
      'info',
      { jobId: job.id, status: reading.rawStatus },
      'the provider reported a status this build does not know; asking again'
    )
    await scheduleNext(payload, ports)
    return { kind: 'polled', status: job.status }
  }

  if (reading.status === 'DONE') {
    return collect(
      ports,
      job,
      client,
      program,
      reading.quantumSeconds,
      now(),
      publish
    )
  }

  if (isTerminalHardwareStatus(reading.status)) {
    const code: HardwareFailureCode =
      reading.status === 'CANCELLED' ? 'POLL_ABANDONED' : 'PROVIDER_FAILED'
    if (reading.status === 'CANCELLED') {
      /*
       * Cancelled *at the provider* rather than here — somebody used IBM's own
       * console, or the provider reaped it. It is recorded as CANCELLED and not
       * as a failure: a cancellation is a third outcome, and telling somebody
       * their circuit failed when they stopped it themselves is a lie about
       * their work.
       */
      const moved = await storage('recordObservation', () =>
        ports.jobs.recordObservation({
          id: job.id,
          status: 'CANCELLED',
          queuePosition: null,
          at: now(),
        })
      )
      if (moved) {
        publish({
          kind: 'complete',
          jobId: job.id,
          status: 'CANCELLED',
          error: null,
        })
      }
      return { kind: 'finished', status: 'CANCELLED' }
    }
    ports.log(
      'warn',
      { jobId: job.id, status: reading.rawStatus },
      'the device reported a failure'
    )
    return finish(ports, job, code, now(), publish)
  }

  /*
   * The provider's own estimate of what this run will cost, logged the first
   * time it is quoted. It is the only number available while there is still
   * time to cancel — `quantumSeconds` appears once the job is DONE, which is
   * after the allowance has been spent — and this system has nowhere else that
   * says what a run is about to cost out of six hundred seconds per
   * twenty-eight days.
   */
  if (reading.estimatedSeconds !== null && job.status === 'QUEUED') {
    ports.log(
      'info',
      { jobId: job.id, estimatedSeconds: reading.estimatedSeconds },
      'the provider quoted the QPU time this job is expected to cost'
    )
  }

  const moved = await storage('recordObservation', () =>
    ports.jobs.recordObservation({
      id: job.id,
      status: reading.status as HardwareStatus,
      queuePosition: reading.queuePosition,
      at: now(),
    })
  )
  if (!moved) {
    // The row went terminal underneath this tick. Nothing is scheduled.
    return { kind: 'skipped', reason: 'row-moved' }
  }

  publish({
    kind: 'status',
    jobId: job.id,
    status: reading.status,
    queuePosition: reading.queuePosition,
  })
  await scheduleNext(payload, ports)
  return { kind: 'polled', status: reading.status }
}

/* ─────────────────────────────── collecting ─────────────────────────────── */

async function collect(
  ports: HardwarePollPorts,
  job: PollableHardwareJob,
  client: IbmClient,
  program: {
    register: string
    clbits: number
    layout: readonly number[]
    calibratedAt?: string | null
  },
  quantumSeconds: number | null,
  at: Date,
  publish: (event: HardwarePublication) => void
): Promise<PollOutcome> {
  const samples = await client.readResults(
    job.providerJobId as string,
    program.register
  )
  if (samples === null) {
    /*
     * The provider says the job is done and the results are not ready. Rare and
     * real: the two are separate stores. Treated as "ask again" rather than as
     * a failure, because a job whose result is a moment away must never be
     * failed — the device has already spent the allowance.
     */
    ports.log(
      'info',
      { jobId: job.id },
      'the job is complete but its results are not yet readable'
    )
    return { kind: 'polled', status: job.status }
  }

  let counts: Readonly<Record<string, number>>
  try {
    /*
     * THE CONVERSION. The layout is deliberately absent — see the header, and
     * `@qsim/transpile`'s `results.ts` for the full argument. The transpiler
     * permutes qubits, not classical bits, so applying the layout here would
     * *introduce* a permutation rather than remove one, and there is no ideal
     * distribution beside a hardware result to notice it with.
     */
    counts = countsFromSamples(samples.samples, program.clbits)
  } catch (error) {
    /*
     * The most expensive failure this system has: the device ran the circuit,
     * spent the allowance, and the answer could not be read. Its own code, so
     * that it never hides inside a generic failure — the response to it is "go
     * and read the job at the provider", not "run it again".
     */
    ports.log(
      'error',
      { jobId: job.id, err: error },
      'a finished hardware job produced samples that could not be read'
    )
    return finish(ports, job, 'RESULT_UNREADABLE', at, publish)
  }

  const result: HardwareResult = {
    backend: job.backendName,
    /*
     * THE SHOTS THE DEVICE RETURNED, NEVER THE SHOTS THAT WERE ASKED FOR.
     *
     * `provenance.ts` states the rule and the panel prints the row under the
     * heading "Shots returned": "They differ when a device returns fewer shots
     * than were asked for, and the third column is drawn from what came back —
     * so a header quoting the request would label a histogram with a number
     * that is not its denominator." Writing `job.shots` here made that
     * impossible to be true, because the result's shot count was then always
     * the request and the fallback could never select anything else. The
     * request is not lost: it is `HardwareJob.shots`, one column away, and the
     * two disagreeing is exactly the fact worth being able to see.
     */
    shots: samples.samples.length,
    counts,
    layout: [...program.layout],
    /*
     * From the frozen program, which recorded it at submission. It cannot be
     * re-derived here: today's calibration is not the one the placement was
     * chosen from, and quoting it would be a timestamp that looks like
     * provenance and is not.
     */
    calibratedAt: program.calibratedAt ?? null,
    quantumSeconds,
  }

  const stored = await storage('completeJob', () =>
    ports.jobs.completeJob({ id: job.id, result, at })
  )
  if (!stored) {
    /*
     * The row was already terminal — a second tick raced the first, or the
     * person cancelled between the read and the write. The result is discarded
     * rather than written: it is the same answer, and writing it would
     * resurrect a job somebody deliberately stopped.
     */
    ports.log(
      'warn',
      { jobId: job.id },
      'a hardware result was discarded: the job was already terminal'
    )
    return { kind: 'skipped', reason: 'already-terminal' }
  }

  publish({ kind: 'complete', jobId: job.id, status: 'DONE', error: null })
  return { kind: 'finished', status: 'DONE' }
}

/* ──────────────────────────────── failing ───────────────────────────────── */

/**
 * A provider failure, classified.
 *
 * The retryable ones — a 429, a 5xx, a socket that never opened — are *not*
 * terminal: the job is still sitting at the provider and the next tick will
 * ask again. That is the whole reason the poll schedule exists, and failing a
 * queued job because the network blinked would throw away a run somebody has
 * already paid for.
 */
async function failFromProvider(
  payload: HardwareJobPayload,
  ports: HardwarePollPorts,
  job: PollableHardwareJob,
  error: unknown,
  at: Date,
  publish: (event: HardwarePublication) => void
): Promise<PollOutcome> {
  if (error instanceof IbmError && error.retryable) {
    ports.log(
      'warn',
      { jobId: job.id, code: error.code },
      'the provider is unavailable; the next tick will ask again'
    )
    /*
     * THE NEXT TICK IS BOOKED HERE, BY THIS FUNCTION.
     *
     * It used to say "the *queue* wrapper schedules the retry" and no such
     * code existed: `startHardwareQueue`'s processor discards the outcome and
     * the queue is `attempts: 1`. So a provider blip left a row that nothing
     * was waiting on, recoverable only by the resume sweep — and the sweep's
     * NULL branch then made that recovery immediate and endless, which is how
     * a lost submission became a resubmission every sixty seconds.
     *
     * One tick, booked once, on the job's own schedule. It is bounded by
     * `MAX_POLL_ATTEMPTS` for a job that has an id, and by
     * `MAX_SUBMIT_ATTEMPTS` for one that does not.
     */
    await scheduleNext(payload, ports)
    return { kind: 'polled', status: job.status }
  }

  const code = failureCodeOf(error)
  ports.log(
    code === 'CREDENTIAL_INVALID' ? 'warn' : 'error',
    {
      jobId: job.id,
      code,
      // The provider's own English, in the log and only in the log (D2).
      detail: error instanceof Error ? error.message : String(error),
    },
    'a hardware job failed against the provider'
  )
  return finish(ports, job, code, at, publish)
}

/** The failure code for anything thrown, decided by shape and never by text. */
export function failureCodeOf(error: unknown): HardwareFailureCode {
  if (!(error instanceof IbmError)) return 'PROVIDER_REFUSED'
  switch (error.code) {
    case 'IBM_CREDENTIAL_INVALID':
    case 'IBM_FORBIDDEN':
      return 'CREDENTIAL_INVALID'
    case 'IBM_QUOTA_EXHAUSTED':
      return 'QUOTA_EXHAUSTED'
    case 'IBM_RATE_LIMITED':
    case 'IBM_UNAVAILABLE':
      return 'PROVIDER_UNAVAILABLE'
    case 'IBM_MALFORMED_RESPONSE':
      return 'RESULT_UNREADABLE'
    default:
      return 'PROVIDER_REFUSED'
  }
}

async function finish(
  ports: HardwarePollPorts,
  job: PollableHardwareJob,
  code: HardwareFailureCode,
  at: Date,
  publish: (event: HardwarePublication) => void
): Promise<PollOutcome> {
  const stored = await storage('failJob', () =>
    ports.jobs.failJob({ id: job.id, code, at })
  )
  if (stored) {
    publish({ kind: 'complete', jobId: job.id, status: 'FAILED', error: code })
  }
  return { kind: 'finished', status: 'FAILED' }
}

/**
 * Schedules the next tick.
 *
 * A failure here is a `HardwareStorageError` and therefore escapes, which is
 * deliberate: a tick that updated the row and then could not schedule its
 * successor has left a job nothing will ever look at again. BullMQ retries
 * nothing on this queue, so what recovers it is the resume sweep — but a
 * *reported* failure is what makes that visible in a log rather than silent.
 */
async function scheduleNext(
  payload: HardwareJobPayload,
  ports: HardwarePollPorts
): Promise<void> {
  const tick = payload.tick + 1
  await storage('schedule', () =>
    ports.schedule({ ...payload, tick }, pollDelayMs(tick))
  )
}
