/**
 * How a running job says how far it has got.
 *
 * ── Why a phase and not just a percentage ─────────────────────────────────
 *
 * Because two of the three modes have no percentage to give, and inventing one
 * would be worse than admitting it. A `STATEVECTOR` run is a single walk of
 * the circuit with no natural subdivision the engine exposes, and a
 * `DENSITY_MATRIX` run is the same walk over ρ. Only the sampled work divides:
 * a trajectories run is literally `shots` independent repetitions, so it can
 * report "40 000 of 100 000" and mean it.
 *
 * A progress bar fed a fabricated number is worse than a spinner. It stalls at
 * 90 % and stays there, and the reader learns that this application's progress
 * bars lie — which they then believe about the one that is telling the truth.
 * So `total` is nullable, `progressFraction` returns `null` where there is
 * nothing honest to return, and the phase carries the meaning in those cases.
 *
 * ── Why the shot chunk is a constant ──────────────────────────────────────
 *
 * The sampled modes are divided into fixed chunks so that progress has
 * something to count. That chunk size is part of the run's *determinism*: the
 * seeded generator is threaded through the chunks in order, so the same seed
 * and the same chunk size give the same draws, and a chunk size tuned per job —
 * by shot count, by register size, by how busy the worker looked — would make
 * a "reproducible" run reproducible only on a machine in the same mood. Hence
 * `SHOT_CHUNK`, one number, changed only with the understanding that it changes
 * every future sampled result.
 *
 * ── Progress is throttled, and the reason is a bill ───────────────────────
 *
 * Every report is a write to Redis, and Redis here is a metered, shared,
 * 256 MB instance. A hundred-thousand-shot run divided into chunks of 128 has
 * 780 reporting opportunities; at one write each that is 780 round trips to
 * say something a reader could not perceive. `shouldReport` collapses them to
 * roughly four a second, and never suppresses a phase change or the final
 * report — the two a client actually reacts to.
 */

import { z } from 'zod'

/**
 * Where a job is.
 *
 *   `validating`  `parseCircuit` and the limit checks. Sub-millisecond in the
 *                 ordinary case, and its own phase because it is where a job
 *                 that is going to be refused gets refused.
 *   `simulating`  the engine. Divisible for the sampled modes and not
 *                 otherwise.
 *   `sampling`    drawing shots from a finished statevector (§5.3's other
 *                 meaning of "shots"), which is a separate pass over the
 *                 distribution and a separate share of the time.
 *   `summarising` reducing a result to the bounded shape that fits a row.
 */
export const PROGRESS_PHASES = [
  'validating',
  'simulating',
  'sampling',
  'summarising',
] as const

export type ProgressPhase = (typeof PROGRESS_PHASES)[number]

export const JobProgressSchema = z.object({
  phase: z.enum(
    PROGRESS_PHASES as unknown as [ProgressPhase, ...ProgressPhase[]]
  ),
  /** Units finished in this phase, or `null` where the phase does not divide. */
  completed: z.number().int().min(0).nullable(),
  /** Units in this phase, or `null`. Never zero: a phase with no work is not one. */
  total: z.number().int().min(1).nullable(),
})

export type JobProgress = z.infer<typeof JobProgressSchema>

/**
 * Progress as it comes back *off* Redis, which is to say untrusted.
 *
 * BullMQ stores whatever the worker handed it as JSON on a hash field, and the
 * API reads it to answer `GET /simulate/:runId`. That is a value crossing a
 * process boundary through a data store, so it is parsed rather than cast —
 * and a value that does not parse is reported as "no progress" rather than as
 * an error, because a malformed progress field must never be able to fail a
 * read of a run that is otherwise perfectly fine.
 */
export function parseProgress(value: unknown): JobProgress | null {
  const parsed = JobProgressSchema.safeParse(value)
  return parsed.success ? parsed.data : null
}

/**
 * How far through this phase, in [0, 1], or `null` when the phase does not
 * divide.
 *
 * Deliberately *not* a fraction of the whole job. The phases have wildly
 * different costs — validating is microseconds, simulating is the run — and a
 * weighted total would be a second cost model to keep in step with the real
 * one in `limits.ts`. A client that wants one number can decide its own
 * weighting; what it cannot do is un-invent one this file made up.
 */
export function progressFraction(progress: JobProgress): number | null {
  if (progress.total === null || progress.completed === null) return null
  if (progress.total <= 0) return null
  return Math.min(1, Math.max(0, progress.completed / progress.total))
}

/**
 * Shots per chunk in a sampled run. See the header: this is part of what makes
 * a seeded run reproducible, not a tuning knob.
 *
 * 128 is small enough that a chunk of the largest sampled register this server
 * accepts is a fraction of a second — so a cancelled or timed-out job is never
 * more than that far from a clean stopping point — and large enough that the
 * per-chunk overhead (a plan walk, an allocation) is amortised to nothing.
 */
export const SHOT_CHUNK = 128

/** Fewest milliseconds between two reports of the same phase. */
export const PROGRESS_MIN_INTERVAL_MS = 250

/**
 * Smallest change worth a write, as a fraction of the phase.
 *
 * Two per cent, which is half a pixel on a hundred-pixel bar. Below that the
 * write buys the reader nothing and costs the tier a round trip.
 */
export const PROGRESS_MIN_DELTA = 0.02

/**
 * Whether this report is worth a round trip to Redis.
 *
 * A phase change always is: it is the one transition a client reacts to, and
 * there are only four of them in the life of a job. Everything else has to earn
 * it by being both new enough and different enough.
 *
 * `elapsedMs` is passed in rather than read from a clock so the throttle is
 * testable without one — the same reason `sharedMemoryAvailable` in the
 * browser's protocol takes its scope as an argument.
 */
export function shouldReport(
  previous: JobProgress | null,
  next: JobProgress,
  elapsedMs: number
): boolean {
  if (previous === null) return true
  if (previous.phase !== next.phase) return true
  if (elapsedMs < PROGRESS_MIN_INTERVAL_MS) return false

  const before = progressFraction(previous)
  const after = progressFraction(next)
  // An indivisible phase has nothing to compare, so the interval alone decides
  // — which is what keeps a long `simulating` phase visibly alive.
  if (before === null || after === null) return true
  return after - before >= PROGRESS_MIN_DELTA
}

/** The first thing every job reports, so a claimed job is never blank. */
export function initialProgress(): JobProgress {
  return { phase: 'validating', completed: null, total: null }
}
