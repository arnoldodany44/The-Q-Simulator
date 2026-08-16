/**
 * What a finished run stores, and why it cannot be the answer itself.
 *
 * ── The result is bounded by construction, not by truncation ──────────────
 *
 * The obvious shape for a simulation result is "the final state", and at the
 * sizes this server exists for that shape is unstorable: 24 qubits is 16.7
 * million amplitudes and 256 MB of doubles, and `SimulationRun.result` is a
 * Postgres `jsonb` column read back over HTTP. Nothing about that gets better
 * with compression.
 *
 * So the stored result is a *reading* rather than a state: the heaviest basis
 * states with their weights, the numbers §3.2 draws, and an honest account of
 * what was left out. `hiddenOutcomes` and `hiddenWeight` are the second half of
 * that honesty and are the reason a truncated list is acceptable at all —
 * without them, a run that showed six states out of a million would be
 * indistinguishable from a run whose distribution really has six states in it,
 * and that is a lie about physics rather than about formatting.
 *
 * ── The byte cap is a tripwire, not a policy ──────────────────────────────
 *
 * `boundOutcomes` already makes the result small: at most
 * `MAX_RESULT_OUTCOMES` entries, and the widest label this server can produce
 * is a 28-character bitstring, so the arithmetic ceiling of a well-formed
 * result is a few tens of kilobytes at most. `MAX_RESULT_JSON_BYTES` is nearly three times that. Reaching
 * it therefore does not mean "this run was unusually big" — it means the
 * bounding above did not happen, which is a bug, and the run fails loudly with
 * `RESULT_TOO_LARGE` instead of writing a row that some later reader cannot
 * load. A limit whose normal case is never approached is a limit that can be
 * trusted to mean something when it fires.
 */

import { z } from 'zod'
import { utf8ByteLength } from './payload.js'
import {
  SIMULATION_MODES,
  SimulationFailure,
  type SimulationMode,
} from './run.js'

/**
 * Most basis states a stored result may name.
 *
 * The browser's histogram stops at 32 bars because that is what a chart can
 * show; this is data rather than a drawing, so it is looser — but it is still
 * a top-k and not a dump. 256 is every state of an 8-qubit register, which is
 * the largest register that can be listed exhaustively at all; past that any
 * list is a selection, and the only question is whether the selection is
 * declared. This one is.
 */
export const MAX_RESULT_OUTCOMES = 256

/**
 * Below this a basis state is not an outcome, it is floating-point residue.
 *
 * Same floor as the browser's histogram, and for the same reason: a state
 * carrying 10⁻¹⁶ of the probability is a rounding artefact of the kernel, and
 * listing it would spend one of 256 slots on nothing while implying the run
 * found something there.
 */
export const RESULT_PROBABILITY_FLOOR = 1e-12

/** Ceiling on the stored JSON. See the header — this is a tripwire. */
export const MAX_RESULT_JSON_BYTES = 64 * 1024

export const SimulationOutcomeSchema = z.object({
  /**
   * The basis state, exactly as the engine keys it: `formatKet`'s bitstring,
   * `0101`, most significant qubit first.
   *
   * The engine's own spelling and not a prettier one, because it is also the
   * key of a `ShotCounts` — so an exact probability and an empirical count for
   * the same state meet on one row without a translation step that could
   * disagree with itself.
   */
  state: z.string().min(1).max(64),
  /** Born probability, or `null` for a purely empirical tally. */
  probability: z.number().min(0).max(1).nullable(),
  /** Shots that landed here, or `null` for an exact run that drew none. */
  count: z.number().int().min(0).nullable(),
})

export type SimulationOutcome = z.infer<typeof SimulationOutcomeSchema>

export const SimulationRunResultSchema = z.object({
  /**
   * The shape's own version, so a row written today is still readable after
   * the shape changes — the same reason `Circuit` carries `schemaVersion`.
   * A stored result outlives the code that wrote it by definition.
   */
  resultVersion: z.literal(1),
  mode: z.enum(
    SIMULATION_MODES as unknown as [SimulationMode, ...SimulationMode[]]
  ),
  qubits: z.number().int().min(1),
  shots: z.number().int().min(0).nullable(),
  /** Echoed so the run can be repeated exactly from what was stored. */
  seed: z.number().int().min(0),
  noiseProfileId: z.string().min(1).max(64).nullable(),
  outcomes: z.array(SimulationOutcomeSchema).max(MAX_RESULT_OUTCOMES),
  /** Basis states carrying weight that the cap left out. */
  hiddenOutcomes: z.number().int().min(0),
  /** The probability those states hold between them. */
  hiddenWeight: z.number().min(0).max(1),
  /** Tr(ρ²) for a density run: 1 pure, 1/2ⁿ maximally mixed. Null otherwise. */
  purity: z.number().min(0).max(1).nullable(),
  /** Wall-clock inside the engine, as the worker measured it. */
  durationMs: z.number().int().min(0),
})

export type SimulationRunResult = z.infer<typeof SimulationRunResultSchema>

/**
 * A stored result as it comes back out of the `jsonb` column.
 *
 * Parsed rather than cast for the same reason `parseStoredCircuit` is in
 * `@qsim/db`: the column holds whatever some past version of this code put
 * there, and a shape that no longer parses must surface as "this run has no
 * readable result" rather than as a type assertion that is quietly wrong two
 * layers downstream.
 */
export function parseStoredResult(value: unknown): SimulationRunResult | null {
  const parsed = SimulationRunResultSchema.safeParse(value)
  return parsed.success ? parsed.data : null
}

/** One candidate outcome before the cap is applied. */
export interface OutcomeCandidate {
  readonly state: string
  readonly probability: number | null
  readonly count: number | null
}

export interface BoundedOutcomes {
  readonly outcomes: readonly SimulationOutcome[]
  readonly hiddenOutcomes: number
  readonly hiddenWeight: number
}

/**
 * The heaviest `limit` outcomes, plus what was left behind.
 *
 * Sorted by weight descending and then by label ascending. The tie-break is not
 * cosmetic: a maximally mixed distribution has 2ⁿ states of exactly equal
 * weight, and without a total order the top-k would depend on the iteration
 * order of whatever produced the candidates — so the same run would store a
 * different result on a different day, and a reproducible seed would stop
 * meaning anything.
 *
 * `hiddenWeight` is the *probability* left out, which is the number a reader
 * can act on; for a purely empirical tally with no probabilities it is derived
 * from the counts, so it means the same thing in both modes.
 */
export function boundOutcomes(
  candidates: readonly OutcomeCandidate[],
  limit: number = MAX_RESULT_OUTCOMES
): BoundedOutcomes {
  const totalCount = candidates.reduce(
    (sum, entry) => sum + (entry.count ?? 0),
    0
  )
  const weightOf = (entry: OutcomeCandidate): number =>
    entry.probability ?? (totalCount > 0 ? (entry.count ?? 0) / totalCount : 0)

  const meaningful = candidates.filter(
    (entry) => weightOf(entry) > RESULT_PROBABILITY_FLOOR
  )
  const sorted = [...meaningful].sort((left, right) => {
    const delta = weightOf(right) - weightOf(left)
    if (delta !== 0) return delta
    return left.state < right.state ? -1 : left.state > right.state ? 1 : 0
  })

  const kept = sorted.slice(0, Math.max(0, limit))
  const dropped = sorted.slice(kept.length)
  const hiddenWeight = dropped.reduce((sum, entry) => sum + weightOf(entry), 0)

  return {
    outcomes: kept.map((entry) => ({
      state: entry.state,
      probability: entry.probability,
      count: entry.count,
    })),
    hiddenOutcomes: dropped.length,
    // Clamped because a sum of floats can land a few ulps past 1, and the
    // schema would then refuse to store a result that is perfectly correct.
    hiddenWeight: Math.min(1, Math.max(0, hiddenWeight)),
  }
}

/** Size of a result as Postgres will hold it. */
export function resultByteLength(result: SimulationRunResult): number {
  return utf8ByteLength(JSON.stringify(result))
}

/**
 * Refuses a result too large to store.
 *
 * Throws rather than truncating, and the difference matters: a truncated
 * result is a row that reads as a successful run and is not one. A run that
 * cannot report its answer did not succeed, and `RESULT_TOO_LARGE` says so in
 * the one place a client will look.
 */
export function assertResultFits(
  result: SimulationRunResult,
  limit: number = MAX_RESULT_JSON_BYTES
): void {
  const bytes = resultByteLength(result)
  if (bytes <= limit) return
  throw new SimulationFailure(
    'RESULT_TOO_LARGE',
    `A run result of ${String(bytes)} bytes exceeds the ${String(limit)}-byte ` +
      'ceiling. Results are bounded to MAX_RESULT_OUTCOMES entries by ' +
      'boundOutcomes, so this means the bounding was skipped.'
  )
}
