/**
 * The hardware queue contract — §3.7, §8's `/hardware/*`, Phase 4.
 *
 * ══════════════════════════════════════════════════════════════════════════
 * A HARDWARE JOB IS A SIMULATION JOB WITH ONE DIFFERENCE, AND IT CHANGES
 * EVERYTHING ABOUT THE SHAPE
 *
 * It can take **hours**. Not "sometimes a slow minute" — a device with 24 835
 * jobs waiting is a device whose answer arrives tomorrow, and this system does
 * not own the machine, cannot be told when it is done, and gets nothing back if
 * it walks away. Three consequences, all of which are why this file exists
 * separately from `payload.ts` rather than as a fourth `SimulationMode`:
 *
 *   1. **NOTHING IS HELD OPEN.** No socket to the provider, no BullMQ lock
 *      spanning the wait, no process parked on a promise. The unit of work is
 *      one *tick*: read the row, ask the provider one question, write what was
 *      learned, schedule the next tick with a delay. A tick is a couple of
 *      hundred milliseconds and holds a lock for exactly that long.
 *
 *   2. **THE PAYLOAD CARRIES ALMOST NOTHING**, and that is the design rather
 *      than economy. `SimulationJobPayload` carries a whole circuit because a
 *      run must compute what was asked for at submission time. A hardware tick
 *      carries an id, because everything a tick needs — the credential, the
 *      transpiled program, the layout, how many times it has been asked — is in
 *      the *row*. That is what makes "a worker restart must resume polling a job
 *      it did not submit" possible at all: a resuming worker has no payload from
 *      the original submission and never will, so any fact that lived only in
 *      the payload would be lost for good.
 *
 *   3. **THE SCHEDULE IS THE ALGORITHM.** With no push notification, how often
 *      to ask *is* the design, and it is a trade between the provider's rate
 *      limit, this system's Redis budget, and how stale a status a person is
 *      willing to look at. See `pollDelayMs`.
 *
 * ══════════════════════════════════════════════════════════════════════════
 * WHY THIS IS ITS OWN QUEUE AND NOT A SECOND JOB NAME ON `simulate`
 *
 * `queue.ts` reserves the possibility ("Hardware polling gets its own"), and
 * the reason is the retry and retention policy, which is per queue in BullMQ
 * and is *opposite* here. A simulation job is executed at most three times,
 * holds a lock for up to thirty seconds, and is retained for five minutes. A
 * hardware tick is executed once — a failed tick is not retried, it is simply
 * followed by the next scheduled one — holds a lock for a second, and is
 * retained for nothing at all, because there will be another one in a minute
 * and keeping a thousand finished ticks on a 256 MB instance is how a queue
 * becomes an outage.
 *
 * Sharing a queue would also share `concurrency`, which is the worst of it: the
 * simulation worker's concurrency is the number of *child processes* it can
 * afford (each holding a 256 MB typed array), while a poll tick holds nothing
 * and could run fifty at a time. One number cannot be both.
 */

import { z } from 'zod'
import { MAX_IDENTIFIER_LENGTH } from './payload.js'

/* ──────────────────────────── the queue ─────────────────────────────── */

/** The second queue this system defines. See the header for why it is second. */
export const HARDWARE_QUEUE = 'hardware'

/** One tick of one job's poll loop. */
export const HARDWARE_JOB_NAME = 'poll-hardware-job'

/**
 * The queue job id for a given tick of a given job.
 *
 * Deterministic in both, and that is the whole point: two workers that both
 * decide job `abc` needs its fourth poll produce the same id, and BullMQ keeps
 * one. The alternative — a random id per tick — turns the resume sweep from a
 * safety net into a fan-out, because every replica's sweep would schedule its
 * own copy of every job's next poll.
 *
 * A colon would collide with BullMQ's own key space (it builds keys by
 * concatenating with `:`), so the separator is a hyphen.
 */
export function hardwareTickId(jobId: string, tick: number): string {
  return `hw-${jobId}-${String(tick)}`
}

/**
 * How many ticks a job may have before it is abandoned.
 *
 * Eight hundred, which at the two-minute tail below is a little over
 * twenty-six hours. Long enough for a queue of twenty-four thousand on a
 * device that runs a job every few seconds; short enough that a job the
 * provider has silently forgotten does not poll for ever. What happens at the
 * ceiling is a FAILED row with `POLL_ABANDONED`, not a row left running: a job
 * that says "still going" for ever is worse than one that says it gave up,
 * because nobody can tell the two apart from the outside.
 */
export const MAX_POLL_ATTEMPTS = 800

/**
 * The gap before tick `n`, in milliseconds.
 *
 * Front-loaded and then flat, because the distribution of *interesting*
 * moments is: the submission is confirmed within seconds, the device's queue
 * position changes over minutes, and then nothing happens for a long time.
 *
 *   2 s, 5 s, 10 s, 20 s, 30 s, 60 s, then 120 s for ever.
 *
 * The first few are what make the UI feel like it is working — a person who
 * has just pressed "run on hardware" is watching. The two-minute tail is
 * chosen against the provider's rate limit rather than against impatience:
 * with fifty jobs in flight it is one request every 2.4 seconds, which is
 * nothing, and it means a job that finishes overnight is reported within two
 * minutes of finishing.
 *
 * Deliberately not exponential without a cap. A doubling schedule reaches a
 * six-hour gap on the second day, and a person who leaves a tab open would see
 * a job that finished at 3 a.m. still reading RUNNING at breakfast.
 */
const POLL_SCHEDULE_MS = [2_000, 5_000, 10_000, 20_000, 30_000, 60_000] as const

/** The interval used once the schedule above is exhausted. */
export const POLL_TAIL_MS = 120_000

export function pollDelayMs(tick: number): number {
  if (tick < 0) return POLL_SCHEDULE_MS[0]
  return POLL_SCHEDULE_MS[tick] ?? POLL_TAIL_MS
}

/**
 * How long a job may go unpolled before the resume sweep picks it up.
 *
 * Five minutes: comfortably longer than the longest scheduled gap plus a
 * generous overshoot, so a job that is being polled normally is never resumed.
 * Shorter than that and the sweep would race the schedule and double every
 * poll; much longer and a job orphaned by a redeploy would sit untouched for
 * an interval a person would notice.
 */
export const RESUME_IDLE_MS = 5 * 60_000

/** How often the sweep looks. */
export const RESUME_INTERVAL_MS = 60_000

/**
 * How many jobs one sweep may resume.
 *
 * Bounded because the sweep runs on every worker replica against a pooler
 * whose budget is one connection, and because a burst of resumes is a burst of
 * requests at a provider that rate-limits. Twenty per minute drains any
 * plausible backlog within a few minutes of a restart.
 */
export const RESUME_BATCH = 20

/**
 * How old a non-terminal job may be before the reaper fails it outright.
 *
 * Two days, against `MAX_POLL_ATTEMPTS`' twenty-six hours, so the reaper is
 * genuinely the last line of defence rather than a second poll ceiling — it
 * catches the job whose credential was deleted, or whose row nothing has
 * scheduled a tick for at all, rather than one that is merely slow.
 *
 * It is a last line of defence only if something calls it. `apps/worker`'s
 * reaper does; for a while nothing did, and a constant nobody consumes is a
 * guarantee that does not exist.
 */
export const HARDWARE_STALE_AFTER_MS = 48 * 60 * 60_000

/**
 * How long one tick's claim on an unsubmitted job lasts.
 *
 * ══════════════════════════════════════════════════════════════════════════
 * THIS IS THE NUMBER THAT STOPS ONE REQUEST BECOMING MANY JOBS
 *
 * Submission is the one call in this system that spends somebody's month, and
 * it is not idempotent: the provider has no idempotency key, so two `POST
 * /jobs` with the same body are two jobs on a real machine. The compare-and-set
 * that follows a submission can only notice the duplicate *afterwards*, once
 * the device already has the work.
 *
 * So a tick claims the row **before** it submits — a compare-and-set on
 * "SUBMITTED, no provider id, and not claimed within this window" — and a
 * second tick arriving inside the window matches nothing and stops without
 * spending anything. Sixty seconds: comfortably longer than the ten-second
 * abort in `fetchTransport` plus a token exchange, and short enough that a
 * container killed mid-submission does not strand its job for long.
 *
 * The claim also *records the attempt*, which is what makes the ceiling below
 * reachable at all.
 */
export const SUBMIT_CLAIM_MS = 60_000

/**
 * How many times this system may try to submit one job.
 *
 * An answer that never arrived says nothing about what the far end did with the
 * bytes it already received — the device may be running the circuit right now —
 * so a blind retry is not a retry, it is a second job. Three attempts is enough
 * to survive an IAM blip or a 502 and few enough that the worst case is three
 * jobs rather than one every sweep for ever, which at roughly two QPU seconds
 * each was the whole six-hundred-second allowance in about five hours.
 *
 * Past it the row is failed as `SUBMIT_ABANDONED`, which says exactly what is
 * true: this system stopped asking and does not know whether the provider has
 * the job. `providerJobId` is null by construction in that state, so the answer
 * to "did it run" is the provider's own console.
 */
export const MAX_SUBMIT_ATTEMPTS = 3

/* ──────────────────────────── the payload ───────────────────────────── */

const IdentifierSchema = z.string().min(1).max(MAX_IDENTIFIER_LENGTH)

/**
 * What travels on the hardware queue.
 *
 * Three fields, and the smallness is the design — see point 2 in the header.
 * `tick` is carried rather than read from the row because it is what names the
 * *next* queue job, and a tick that read its own number from the database
 * would produce a different id depending on whether a concurrent write had
 * landed, which is exactly the determinism `hardwareTickId` exists for.
 *
 * `userId` is carried too, and it is not authorisation: authorisation happened
 * when `POST /hardware/jobs` created the row. It is here because the
 * credential's AES-GCM tag is bound to the owner (see `@qsim/db`'s
 * `secrets.ts`), so a tick that could not name the owner could not open the
 * credential — and a tick that read the owner from the row it is about would be
 * trusting the row to say who may spend the allowance it names.
 */
export const HardwareJobPayloadSchema = z.object({
  jobId: IdentifierSchema,
  userId: IdentifierSchema,
  tick: z.number().int().min(0).max(MAX_POLL_ATTEMPTS),
})

export type HardwareJobPayload = z.infer<typeof HardwareJobPayloadSchema>

export function parseHardwarePayload(input: unknown): HardwareJobPayload {
  return HardwareJobPayloadSchema.parse(input)
}

/* ─────────────────────────── the vocabulary ─────────────────────────── */

/** Mirrors `JobStatus` in the Prisma schema (§7). */
export const HARDWARE_STATUSES = [
  'SUBMITTED',
  'QUEUED',
  'RUNNING',
  'DONE',
  'FAILED',
  'CANCELLED',
] as const

export type HardwareStatus = (typeof HARDWARE_STATUSES)[number]

export function isHardwareStatus(value: string): value is HardwareStatus {
  return (HARDWARE_STATUSES as readonly string[]).includes(value)
}

/** DONE, FAILED and CANCELLED. */
export function isTerminalHardwareStatus(status: HardwareStatus): boolean {
  return status === 'DONE' || status === 'FAILED' || status === 'CANCELLED'
}

/**
 * Why a hardware job produced no result.
 *
 * A code and never a sentence, for the reason every stored failure in this
 * system is one (D2): `HardwareJob.errorMessage` is read back by
 * `GET /hardware/jobs/:id` and rendered by a trilingual client, so English
 * prose here would be English prose on a French screen, outside every catalog
 * parity test. The provider's own message goes to the worker's log.
 *
 *   `CREDENTIAL_MISSING`     the credential this job names is gone — deleted
 *                            by its owner while the job was in a queue. The job
 *                            cannot be polled and cannot be cancelled at the
 *                            provider, because both need the key.
 *   `CREDENTIAL_INVALID`     the key was refused. Expired, revoked, or the CRN
 *                            names an instance it cannot reach.
 *   `QUOTA_EXHAUSTED`        the plan's QPU allowance is spent. The one failure
 *                            that resolves by waiting for a new period rather
 *                            than by doing anything.
 *   `PROVIDER_REFUSED`       the provider rejected the submission. The program
 *                            or the backend, not the credential.
 *   `PROVIDER_FAILED`        the device ran it and reported a failure.
 *   `PROVIDER_UNAVAILABLE`   never reached, or 5xx, past every retry. The one
 *                            code that says "this may work later".
 *   `RESULT_UNREADABLE`      the job finished and the answer could not be read:
 *                            a register that is not there, samples that are not
 *                            hexadecimal. Its own code because it means the row
 *                            is a *lost* result rather than a failed run — the
 *                            device spent the allowance and this system could
 *                            not collect it, which is the most expensive bug in
 *                            this milestone and must never hide inside a
 *                            generic failure.
 *   `POLL_ABANDONED`         `MAX_POLL_ATTEMPTS` or the reaper's horizon. The
 *                            job may still be running somewhere; this system
 *                            has stopped asking.
 *   `SUBMIT_ABANDONED`       `MAX_SUBMIT_ATTEMPTS` submissions in a row whose
 *                            answer never arrived. Distinct from
 *                            `PROVIDER_UNAVAILABLE`, which means "this may work
 *                            later", and from `POLL_ABANDONED`, which is about
 *                            a job with an id. Here there is no id: the request
 *                            may have been accepted and this system will never
 *                            know, so retrying it again would be buying a
 *                            fourth job rather than recovering the first.
 *   `QUEUE_UNAVAILABLE`      never written by the worker. The API stamps it on
 *                            a row it created and then could not enqueue a tick
 *                            for, so it does not sit SUBMITTED for ever
 *                            describing work nothing will do.
 */
export const HARDWARE_FAILURE_CODES = [
  'CREDENTIAL_MISSING',
  'CREDENTIAL_INVALID',
  'QUOTA_EXHAUSTED',
  'PROVIDER_REFUSED',
  'PROVIDER_FAILED',
  'PROVIDER_UNAVAILABLE',
  'RESULT_UNREADABLE',
  'POLL_ABANDONED',
  'SUBMIT_ABANDONED',
  'QUEUE_UNAVAILABLE',
] as const

export type HardwareFailureCode = (typeof HARDWARE_FAILURE_CODES)[number]

export function isHardwareFailureCode(
  value: string
): value is HardwareFailureCode {
  return (HARDWARE_FAILURE_CODES as readonly string[]).includes(value)
}

/* ───────────────────────────── the result ───────────────────────────── */

/**
 * How many shots a hardware job may ask for.
 *
 * Far below the simulator's ceiling, and the reason is the ten minutes. Shots
 * are the direct currency of the Open Plan's allowance: a device runs the
 * circuit once per shot, so a careless 100 000 is a meaningful slice of a
 * month's budget spent on a histogram nobody needed at that resolution. Four
 * thousand puts the sampling error near 0.8 %, which is well under the effects
 * §3.3 exists to show, and it is what most published device demonstrations use.
 */
export const MAX_HARDWARE_SHOTS = 4_096
export const MIN_HARDWARE_SHOTS = 1
export const DEFAULT_HARDWARE_SHOTS = 1_024

/**
 * What a finished hardware job stores.
 *
 * Counts keyed exactly as `@qsim/core` keys its own — highest classical bit
 * first, qubit 0 last (D1) — so the three-column comparison of §3.7 can lay a
 * hardware histogram over an ideal one with no translation step. That is the
 * whole reason the shape is pinned here rather than left to the worker: the
 * comparison is a *join on the key*, and two spellings of a bitstring would
 * make it silently empty.
 *
 * `layout` rides along for the reader rather than for the arithmetic. The
 * conversion from samples to counts deliberately takes no layout — the
 * transpiler permutes qubits and not classical bits — and storing the layout
 * beside the counts is how somebody checks that after the fact.
 */
export const HardwareResultSchema = z.object({
  backend: z.string().min(1).max(128),
  /**
   * How many shots the device actually returned — `samples.length`, not the
   * request.
   *
   * The floor is zero rather than `MIN_HARDWARE_SHOTS`, and the difference
   * matters: a device that returned fewer shots than were asked for is the case
   * this field exists to record, and a schema that refused a short run would
   * turn "the device sent back less than we asked" into "this result is
   * unreadable" — discarding an answer the allowance has already paid for.
   */
  shots: z.number().int().min(0).max(MAX_HARDWARE_SHOTS),
  /** Bitstring → count. Keys are `clbits` characters, highest bit first. */
  counts: z.record(z.string().regex(/^[01]{1,64}$/), z.number().int().min(0)),
  /** Logical qubit → physical qubit, as the job was placed. */
  layout: z.array(z.number().int().min(0)).max(64),
  /** When the calibration the placement used was measured. */
  calibratedAt: z.string().max(64).nullable(),
  /** Seconds of QPU actually spent, when the provider reports it. */
  quantumSeconds: z.number().min(0).nullable(),
})

export type HardwareResult = z.infer<typeof HardwareResultSchema>

/**
 * A stored result, or `null`.
 *
 * Never throws, like `parseStoredResult`: a row written by an older build must
 * degrade to "no result yet" on a page rather than to a 500 on a read.
 */
export function parseHardwareResult(value: unknown): HardwareResult | null {
  const parsed = HardwareResultSchema.safeParse(value)
  return parsed.success ? parsed.data : null
}
