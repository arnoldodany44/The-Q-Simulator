/**
 * Measurement, sampling and the two execution modes — specification §5.3.
 *
 * BORN RULE. The probability of reading basis state `i` is `|aᵢ|²`, and the
 * marginal probability of qubit `q` reading 1 is the sum of `|aᵢ|²` over every
 * index whose bit `q` is set (D1, `conventions.ts`). Both are one pass over
 * the state and neither of them allocates a matrix.
 *
 * ────────────────────────────────────────────────────────────────────────
 * THE TWO MODES, AND WHY THEY CANNOT BE ONE.
 *
 * A unitary circuit has a final state: run it once, read off every amplitude,
 * and the histogram is exact. A measurement in the middle of a circuit breaks
 * that. It picks an outcome at random, deletes the amplitudes that disagree
 * with it and renormalises what is left, so the "final state" is a different
 * vector depending on a coin flip — and if a later gate is conditioned on the
 * outcome, the two branches do not even evolve the same way. **There is no
 * single final statevector to return.** Statistics then require running the
 * whole circuit once per shot and tallying what each run measured.
 *
 * So the engine has two modes and refuses to blur them:
 *
 *   analytic      one run, one final state, exact probabilities.
 *                 A mid-circuit measurement is an error, not a warning.
 *   trajectories  `shots` independent runs, each with its own collapses and
 *                 classically-conditioned gates. The answer is counts; there
 *                 is no state to show.
 *
 * The types carry that distinction so a caller cannot skip it:
 *
 *  - `RunResult` is a discriminated union and only its analytic member has a
 *    `state`. Reading a final state means narrowing on `mode` first, which is
 *    the compiler asking the question this comment answers.
 *  - the `Rng` lives on `TrajectoriesOptions` only. An analytic run has no
 *    generator to pass to `measureQubit`, so mid-circuit collapse is not
 *    something it can reach by accident.
 *  - `assertMidCircuitAllowed` is the gate the runner of M0.4 calls before a
 *    `measure` or a conditioned gate. It narrows its argument, so the runner
 *    obtains the RNG *by* passing the check.
 *
 * ────────────────────────────────────────────────────────────────────────
 * SAMPLING. `sampleShots` builds the cumulative distribution once — O(2ⁿ) —
 * and binary searches it per shot, O(log 2ⁿ) = O(n). The alias method the
 * work plan mentions for shots > 10 000 buys O(1) per sample, but it needs a
 * second O(2ⁿ) build and two more arrays of 2ⁿ; at the sizes this engine runs
 * (10 000 shots × 20 qubits is 200 000 comparisons, microseconds) the build
 * dominates the sampling either way, so the simpler structure wins until a
 * measurement says otherwise.
 */

import { formatKet } from './conventions.js'
import type { Rng } from './rng.js'
import type { Statevector } from './statevector.js'

/**
 * How often each outcome came up, keyed by the ket label of the basis state —
 * highest qubit first, the way `formatKet` and Qiskit print it.
 *
 * Outcomes that never occurred are absent rather than present with a zero: a
 * 20-qubit run has a million basis states and 1024 shots, and a map of mostly
 * zeros would be the larger part of every worker message. A missing key is a
 * count of zero.
 *
 * **KEY ENUMERATION ORDER IS NOT PART OF THIS CONTRACT**, and no amount of
 * care at the insertion site can make it so. A plain object enumerates its
 * canonical array-index keys in ascending numeric order *before* every other
 * key, and a fixed-width bitstring is an array index exactly when it has no
 * leading zero — so `"10"` is hoisted in front of `"00"` however they were
 * inserted. (Decimal digits run out at 2³²−1, so the hazard bites for widths 2
 * to 10 and vanishes above them, which is to say it bites for every teaching
 * circuit and hides in the large registers.) A consumer that needs display
 * order calls `orderedCounts()`; that is the ordering contract.
 */
export type ShotCounts = Readonly<Record<string, number>>

/**
 * `counts` as label/count pairs in ascending basis-state order — the ordered
 * view the histogram of M0.7 lays its bars out from, and the only ordering
 * guarantee this module makes. See `ShotCounts` for why the object cannot
 * carry one itself.
 *
 * The labels of one run are all the same width, so sorting them
 * lexicographically *is* sorting them numerically, and it needs no register
 * size passed in.
 */
export function orderedCounts(
  counts: ShotCounts
): readonly (readonly [label: string, count: number])[] {
  return Object.keys(counts)
    .sort()
    .map((label) => [label, counts[label]] as const)
}

/** Born-rule probability of every basis state, in index order. */
export function probabilities(state: Statevector): Float64Array {
  const { re, im, size } = state
  const out = new Float64Array(size)
  for (let i = 0; i < size; i++) out[i] = re[i] * re[i] + im[i] * im[i]
  return out
}

/**
 * Probability that `qubit` reads 1, summed over every basis state where that
 * bit is set.
 *
 * The walk is the index pairing of `apply.ts`, entered on the far side: with
 * `base` starting at `stride` and stepping by `2·stride`, `base + offset`
 * enumerates exactly the indices whose target bit is 1. That is half the reads
 * of a full sweep with a bit test per index.
 *
 * Assumes a normalised state, as every function here does — D6 has the runner
 * renormalising every 64 gates precisely so that this stays true.
 */
export function marginalProbability(state: Statevector, qubit: number): number {
  checkQubit(state, qubit)
  const { re, im, size } = state
  const stride = 1 << qubit
  let sum = 0
  for (let base = stride; base < size; base += stride << 1) {
    for (let offset = 0; offset < stride; offset++) {
      const i = base + offset
      sum += re[i] * re[i] + im[i] * im[i]
    }
  }
  return sum
}

/**
 * Draw `shots` samples from the state's distribution and tally them.
 *
 * This is the analytic-mode histogram: it samples a state that already exists
 * and never touches it, so the caller keeps a state it can still inspect. A
 * trajectories run cannot use it — its randomness happens during the run, not
 * after it.
 *
 * The cumulative distribution is left unnormalised and the draw is scaled by
 * the total instead. That is one multiplication rather than 2ⁿ divisions, and
 * it absorbs the float drift D6 tolerates: whatever the amplitudes sum to,
 * samples land inside it.
 */
export function sampleShots(
  state: Statevector,
  shots: number,
  rng: Rng
): ShotCounts {
  checkShots(shots)
  const { re, im, size } = state

  const cumulative = new Float64Array(size)
  let total = 0
  for (let i = 0; i < size; i++) {
    total += re[i] * re[i] + im[i] * im[i]
    cumulative[i] = total
  }
  if (!(total > 0) || !Number.isFinite(total)) {
    throw new RangeError(
      `Cannot sample a state whose total probability is ${total}.`
    )
  }

  // Tally by index and format once per distinct outcome at the end: building
  // an n-character string per shot would make the labels cost more than the
  // sampling.
  const tally = new Map<number, number>()
  const last = size - 1
  for (let shot = 0; shot < shots; shot++) {
    const target = rng.next() * total
    // Smallest index whose cumulative mass exceeds `target`. The comparison is
    // strict, which is what keeps zero-probability outcomes unreachable: their
    // slice is empty, so no `target` can be below their bound and at or above
    // the previous one.
    let low = 0
    let high = last
    while (low < high) {
      const middle = (low + high) >>> 1
      if (target < cumulative[middle]) high = middle
      else low = middle + 1
    }
    tally.set(low, (tally.get(low) ?? 0) + 1)
  }

  // No sort on the way out: the object would discard it anyway (see
  // `ShotCounts`), and pretending otherwise is how the histogram ends up
  // rendered back to front. `orderedCounts()` is where display order lives.
  const counts: Record<string, number> = {}
  for (const [index, count] of tally) {
    counts[formatKet(index, state.qubits)] = count
  }
  return counts
}

/**
 * Collapse `qubit` onto `outcome`, in place: the amplitudes that disagree are
 * zeroed and what survives is renormalised. Returns the probability the
 * outcome had, which the walk has to compute anyway.
 *
 * It does not delegate to `renormalize()`: the scan already visits the
 * surviving half and knows its norm, the zeroed half needs no scaling, and a
 * failure here deserves the diagnostic "that outcome was impossible" rather
 * than "the norm was 0".
 *
 * Throws when the outcome has zero probability, and throws before writing
 * anything: the whole surviving half is measured first, then the state is
 * committed in one pass. Zeroing as we counted would have been the same memory
 * traffic, but it left a rejected call holding a vector of zeros — so the
 * "that outcome was impossible" diagnostic this function goes out of its way to
 * produce was delivered exactly once and replaced by "the norm was 0" on every
 * later call, and an editor that caught the error to keep its last good state
 * no longer had one.
 */
export function collapse(
  state: Statevector,
  qubit: number,
  outcome: 0 | 1
): number {
  checkQubit(state, qubit)
  checkOutcome(outcome)

  const { re, im, size } = state
  const stride = 1 << qubit
  const keepShift = outcome === 1 ? stride : 0
  const dropShift = stride - keepShift

  // Read-only walk, entered on the surviving side: `base + offset` enumerates
  // exactly the indices that agree with `outcome`, as in `marginalProbability`.
  let kept = 0
  for (let base = keepShift; base < size; base += stride << 1) {
    for (let offset = 0; offset < stride; offset++) {
      const i = base + offset
      kept += re[i] * re[i] + im[i] * im[i]
    }
  }

  if (!(kept > 0) || !Number.isFinite(kept)) {
    throw new RangeError(
      `Cannot collapse qubit ${qubit} onto ${outcome}: that outcome has ` +
        `probability ${kept}.`
    )
  }

  const scale = 1 / Math.sqrt(kept)
  for (let base = 0; base < size; base += stride << 1) {
    for (let offset = 0; offset < stride; offset++) {
      const pair = base + offset
      const keep = pair + keepShift
      const drop = pair + dropShift
      re[keep] *= scale
      im[keep] *= scale
      re[drop] = 0
      im[drop] = 0
    }
  }
  return kept
}

/**
 * Measure `qubit`: draw an outcome with its Born probability, collapse the
 * state onto it, return what was read.
 *
 * This is the trajectories-mode primitive. It mutates the state, and after it
 * the circuit that produced that state can no longer be described by one final
 * vector — see the header.
 *
 * WHY THE DRAW IS SCALED BY THE STATE'S OWN MASS rather than compared with the
 * marginal directly — the same trick `sampleShots` uses, and for a sharper
 * reason. `next() < p` silently assumes `P(0) = 1 - p`, i.e. a norm of exactly
 * 1. After a collapse the norm is *not* exactly 1: renormalising by
 * `1/√kept` leaves the surviving half summing to 1 − 2e-16 at two qubits and
 * 1 − 2e-14 at twenty, and no Float64 renormalisation can do better. The
 * missing mass is drift, but the old rule handed it to the *other* outcome —
 * whose amplitudes are exactly zero — so `next()` at the top of its range
 * re-measured a collapsed qubit as the value it cannot have and `collapse`
 * aborted the whole trajectory. Scaling instead makes both certainties exact:
 * a certain outcome carries all of `total`, and `next() * total < total` holds
 * for every `next()` in [0, 1), while the impossible outcome has mass 0 and no
 * scaled draw is below zero.
 */
export function measureQubit(
  state: Statevector,
  qubit: number,
  rng: Rng
): 0 | 1 {
  checkQubit(state, qubit)
  const { re, im, size } = state
  const stride = 1 << qubit

  // Both branch masses in one pass, rather than `marginalProbability`'s half
  // pass over the far side alone. Measurements are rare next to the gates around
  // them, so the extra half is invisible: §5.2's budget is about gates.
  let zeroMass = 0
  let oneMass = 0
  for (let base = 0; base < size; base += stride << 1) {
    for (let offset = 0; offset < stride; offset++) {
      const zero = base + offset
      const one = zero + stride
      zeroMass += re[zero] * re[zero] + im[zero] * im[zero]
      oneMass += re[one] * re[one] + im[one] * im[one]
    }
  }

  const total = zeroMass + oneMass
  if (!(total > 0) || !Number.isFinite(total)) {
    // Said here rather than left to `collapse`, which would report "that
    // outcome has probability 0" and point at the outcome instead of the state.
    throw new RangeError(
      `Cannot measure qubit ${qubit} of a state whose total probability is ` +
        `${total}.`
    )
  }

  const outcome: 0 | 1 = rng.next() * total < oneMass ? 1 : 0
  collapse(state, qubit, outcome)
  return outcome
}

/* ────────────────────────── execution modes ─────────────────────────── */

/** The two ways a circuit can be run. See the header for why they differ. */
export type ExecutionMode = 'analytic' | 'trajectories'

/** One run, one final state. Carries no RNG because nothing is random. */
export interface AnalyticOptions {
  readonly mode: 'analytic'
}

/** `shots` independent runs, each free to measure and branch mid-circuit. */
export interface TrajectoriesOptions {
  readonly mode: 'trajectories'
  readonly shots: number
  readonly rng: Rng
}

export type ExecutionOptions = AnalyticOptions | TrajectoriesOptions

/**
 * The outcome of an analytic run. `sampleShots(result.state, …)` turns it into
 * a histogram; `probabilities(result.state)` gives the exact bars, which is
 * what the analysis panel shows, because a simulator has no reason to add shot
 * noise it was not asked for.
 */
export interface AnalyticResult {
  readonly mode: 'analytic'
  readonly state: Statevector
}

/**
 * The outcome of a trajectories run: counts and nothing else. The absent
 * `state` is the point — see the header.
 */
export interface TrajectoriesResult {
  readonly mode: 'trajectories'
  readonly shots: number
  readonly counts: ShotCounts
}

export type RunResult = AnalyticResult | TrajectoriesResult

const ANALYTIC: AnalyticOptions = Object.freeze({ mode: 'analytic' })

/** Options for an analytic run. A shared constant: it has no state to carry. */
export function analyticMode(): AnalyticOptions {
  return ANALYTIC
}

/** Options for a trajectories run of `shots` independent runs. */
export function trajectoriesMode(shots: number, rng: Rng): TrajectoriesOptions {
  checkShots(shots)
  if (shots < 1) {
    // Zero is a legal argument to `sampleShots` — an empty histogram of an
    // existing state — but a trajectories run with no shots computes nothing
    // and returns nothing, so it is a caller's mistake rather than a request.
    throw new RangeError(
      `A trajectories run needs at least one shot, got ${shots}.`
    )
  }
  return { mode: 'trajectories', shots, rng }
}

/**
 * Raised when a circuit asks for something only a trajectories run can do.
 *
 * Its own class rather than a bare `Error` because the editor has to turn it
 * into an offer — "this circuit measures in the middle, run it in shots mode?"
 * — and matching on a message string is not a contract.
 */
export class MidCircuitMeasurementError extends Error {
  constructor(operation: string) {
    super(
      `Analytic mode cannot run ${operation}. Measuring collapses the state ` +
        `onto a random outcome, so a circuit that measures before it ends has ` +
        `no single final statevector. Re-run in trajectories mode, which ` +
        `repeats the whole circuit once per shot and reports counts.`
    )
    this.name = 'MidCircuitMeasurementError'
  }
}

/**
 * The runner's gate in front of any operation that collapses the state or
 * reads a classical bit. On success it narrows `options`, so the RNG the
 * operation needs is only in scope once the mode has been checked.
 */
export function assertMidCircuitAllowed(
  options: ExecutionOptions,
  operation: string
): asserts options is TrajectoriesOptions {
  if (options.mode !== 'trajectories') {
    throw new MidCircuitMeasurementError(operation)
  }
}

function checkQubit(state: Statevector, qubit: number): void {
  if (!Number.isInteger(qubit) || qubit < 0 || qubit >= state.qubits) {
    throw new RangeError(
      `Measured qubit ${qubit} is outside [0, ${state.qubits}).`
    )
  }
}

function checkOutcome(outcome: number): void {
  if (outcome !== 0 && outcome !== 1) {
    throw new RangeError(`A measurement outcome is 0 or 1, got ${outcome}.`)
  }
}

function checkShots(shots: number): void {
  if (!Number.isInteger(shots) || shots < 0) {
    throw new RangeError(
      `A shot count must be a non-negative integer, got ${shots}.`
    )
  }
}
