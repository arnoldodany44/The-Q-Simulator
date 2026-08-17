/**
 * Deciding whether a build step is done — §3.6, Phase 3.
 *
 * The argument for checking this in the browser rather than on the server is
 * in `format.ts` under decision 3, and it comes down to one fact: a lesson has
 * nothing to win. Risk 5 and §11 put challenge validation on the server
 * because a challenge has a leaderboard and a client that lies gains a
 * position; nothing here is ranked, nothing is written that another reader can
 * see, and "next" is enabled either way. What a reader could obtain by lying
 * to this function is a sentence they can also obtain by pressing a button.
 *
 * ────────────────────────────────────────────────────────────────────────
 * EVERY CHECK IS A READING OF THE STATE, NEVER OF THE GATES.
 *
 * A check written against the circuit text would accept exactly one
 * construction of |+⟩ and reject `ry(π/2)`, `x` then `h`, and `h` then `z`
 * then `z`. That is not a stricter lesson, it is a different one: it teaches
 * the reader to reproduce a picture rather than to produce a state, which is
 * the failure mode this whole feature exists to avoid.
 *
 * ────────────────────────────────────────────────────────────────────────
 * THE RUN IS SYNCHRONOUS, AND THE FORMAT IS WHAT MAKES THAT SAFE.
 *
 * No worker, no debounce, no scheduler. A lesson circuit is small by
 * construction — `MAX_LESSON_QUBITS` is enforced by `lessons.test.ts` on every
 * step of every lesson — so this is a few hundred complex multiplications on
 * the main thread, and the alternative would be a second copy of M0.6's
 * pipeline running beside the real one for a circuit the real one has already
 * simulated.
 *
 * It is also the reason this file refuses rather than guesses. A circuit that
 * measures mid-run has no single final state (§5.3), the engine says so, and
 * an objective over one is a question with no answer — so the format does not
 * offer it and the checker reports `unavailable` if a reader builds one
 * anyway, instead of throwing inside a render.
 */

import {
  MidCircuitMeasurementError,
  formatKet,
  probabilities,
  qubitEntropy,
  run,
  stateFidelity,
  type Statevector,
} from '@qsim/core'
import { expandCircuit, type Circuit } from '@qsim/schema'

import type { LessonCheck } from './format'

/**
 * Widest register a lesson step may use.
 *
 * Six because this file runs on the main thread on every edit, 2⁶ amplitudes
 * is a rounding error of work, and because a lesson that needs a seventh wire
 * to make its point has stopped being an explanation. It is asserted over the
 * catalog rather than enforced at runtime: a lesson too wide is an authoring
 * mistake to fail the build on, not a state a reader can reach.
 */
export const MAX_LESSON_QUBITS = 6

/** Default overlap a `state` check demands. See `LessonCheck` for the 0.999. */
export const DEFAULT_MIN_FIDELITY = 0.999

/** Default per-basis-state slack a `probabilities` check allows. */
export const DEFAULT_PROBABILITY_TOLERANCE = 0.01

/**
 * Default entropy, in bits, above which a qubit counts as entangled.
 *
 * Half a bit is comfortably above the numerical floor and comfortably below
 * the one bit a maximally entangled qubit carries, so it accepts a partially
 * entangled pair — which is the honest reading of "entangle these two" — and
 * rejects a product state without being sensitive to how the reader built it.
 */
export const DEFAULT_MIN_ENTROPY = 0.5

export type ObjectiveStatus = 'met' | 'unmet' | 'unavailable'

export interface ObjectiveReading {
  readonly status: ObjectiveStatus
  /**
   * The number the check looked at — a fidelity, a worst-case probability
   * error, an entropy — or `null` when there was nothing to read.
   *
   * It exists so the player can show the reader how close they are rather than
   * only whether they arrived, which is the difference between a hint and a
   * verdict.
   */
  readonly value: number | null
}

const UNAVAILABLE: ObjectiveReading = { status: 'unavailable', value: null }

/**
 * The final state of a circuit, or `null` when it has none.
 *
 * `null` covers exactly two cases and both are the reader's doing rather than
 * the lesson's: a mid-circuit measurement, and a circuit past what this file
 * will run. Everything else the contract already refused before it reached the
 * store.
 */
export function lessonState(circuit: Circuit): Statevector | null {
  if (circuit.qubits > MAX_LESSON_QUBITS) return null
  try {
    // Expanded first, exactly as `job.ts` does: a custom gate is not something
    // the kernel knows, and a reader who packaged their answer into a block
    // has still produced the state.
    const expanded = expandCircuit(circuit)
    const result = run(expanded.circuit)
    return result.mode === 'analytic' ? result.state : null
  } catch (cause) {
    // The one refusal that is a legitimate thing for a reader to build.
    if (cause instanceof MidCircuitMeasurementError) return null
    // An expansion ceiling or a malformed definition. Both are refusals rather
    // than crashes, and both mean the same thing here: no state to read.
    return null
  }
}

/**
 * Whether the reader's circuit satisfies the step, and by how much.
 *
 * `target` is the lesson's own circuit at this step, used only by the `state`
 * check — the other two name their expectation themselves, which is what lets
 * a step ask for something the lesson never draws.
 */
export function checkObjective(
  check: LessonCheck,
  built: Circuit,
  target: Circuit | null
): ObjectiveReading {
  const state = lessonState(built)
  if (state === null) return UNAVAILABLE

  switch (check.kind) {
    case 'state': {
      if (target === null) return UNAVAILABLE
      const wanted = lessonState(target)
      // Different registers have no overlap at all, and asking for one throws
      // — a reader who added a qubit is simply not there yet.
      if (wanted === null || wanted.qubits !== state.qubits) {
        return { status: 'unmet', value: 0 }
      }
      const fidelity = stateFidelity(wanted, state)
      const floor = check.minFidelity ?? DEFAULT_MIN_FIDELITY
      return { status: fidelity >= floor ? 'met' : 'unmet', value: fidelity }
    }

    case 'probabilities': {
      const worst = worstProbabilityError(state, check.expected)
      const slack = check.tolerance ?? DEFAULT_PROBABILITY_TOLERANCE
      return { status: worst <= slack ? 'met' : 'unmet', value: worst }
    }

    case 'entangled': {
      if (check.qubit >= state.qubits) return { status: 'unmet', value: 0 }
      const entropy = qubitEntropy(state, check.qubit)
      const floor = check.minEntropy ?? DEFAULT_MIN_ENTROPY
      return { status: entropy >= floor ? 'met' : 'unmet', value: entropy }
    }

    case 'outcomes': {
      const worst = worstUniformError(state, check.count)
      const slack = check.tolerance ?? DEFAULT_PROBABILITY_TOLERANCE
      return { status: worst <= slack ? 'met' : 'unmet', value: worst }
    }
  }
}

/**
 * How far the distribution is from "exactly `count` equally likely outcomes",
 * with no opinion about *which* outcomes they are.
 *
 * Sorted rather than matched against labels, which is the whole content of the
 * check: a question about the shape of a histogram must not be answerable only
 * by the reader who also got the labelling the lesson happened to draw. The
 * comparison is then the same worst-case one `worstProbabilityError` makes —
 * the largest gap between the sorted probabilities and `[1/count … 1/count, 0
 * … 0]` — so a state with a third small bar fails on that bar rather than
 * being averaged away.
 */
function worstUniformError(state: Statevector, count: number): number {
  const sorted = [...probabilities(state)].sort((a, b) => b - a)
  let worst = 0
  for (let index = 0; index < sorted.length; index += 1) {
    const wanted = index < count ? 1 / count : 0
    worst = Math.max(worst, Math.abs((sorted[index] ?? 0) - wanted))
  }
  // A register too narrow to hold `count` outcomes cannot satisfy the check,
  // and the loop above would not have noticed: it only walks what exists.
  if (sorted.length < count) worst = Math.max(worst, 1 / count)
  return worst
}

/**
 * The largest gap between the distribution asked for and the one produced.
 *
 * Worst case rather than a sum, because a distribution that is right
 * everywhere except one state is wrong, and a sum of small errors over 2ⁿ
 * states would let a wide register hide a real one. Basis states absent from
 * `expected` are expected to be *zero* — otherwise "half |00⟩, half |11⟩" would
 * be satisfied by a state that also puts weight on |01⟩, which is the exact
 * distinction between a Bell pair and a mixture the lesson is teaching.
 */
function worstProbabilityError(
  state: Statevector,
  expected: Readonly<Record<string, number>>
): number {
  const actual = probabilities(state)
  let worst = 0
  for (let index = 0; index < actual.length; index += 1) {
    // The ket as §3.2 prints it — little-endian (D1), so the catalog and the
    // amplitude table on screen name the same basis state the same way.
    const label = formatKet(index, state.qubits)
    const wanted = expected[label] ?? 0
    worst = Math.max(worst, Math.abs((actual[index] ?? 0) - wanted))
  }
  return worst
}
