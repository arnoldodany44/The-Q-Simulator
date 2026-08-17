/**
 * Feedback that teaches — §3.6, and the difference between a number and a
 * lesson.
 *
 * "Fidelity 0.83" tells a learner they are wrong and nothing else. "Your state
 * has the right magnitudes and the wrong relative phase" tells them where to
 * look, and it is a statement the server can make without giving the answer
 * away: it is a fact about the *shape* of the difference, not about the target.
 *
 * Every function here returns codes, never sentences. `apps/web` owns the
 * words, in three catalogs (D2, §11) — which is also what makes the diagnosis
 * translatable at all, since a server-side sentence would be English in a place
 * no catalog covers.
 *
 * ── WHAT MAY BE SAID, AND WHAT MAY NOT ────────────────────────────────────
 *
 * Everything below is derived from a *comparison* and reports a property of the
 * submission: how many outcomes it has, whether its qubits are entangled,
 * whether reversing its wires would have worked. None of it names an amplitude,
 * a phase or a basis state of the target. The strongest hint here is
 * "reversing your qubit order would solve it", which is a statement about the
 * reader's own circuit — and telling them is the whole point, because that
 * mistake is D1 in disguise and staring at a fidelity will never reveal it.
 *
 * ── GLOBAL PHASE IS ANNOUNCED, NOT PENALISED ──────────────────────────────
 *
 * |ψ⟩ and e^{iφ}|ψ⟩ are the same physical state, so a submission differing by
 * one passes — `stateFidelity` squares the modulus and never sees it. It is
 * still worth saying out loud: a reader comparing their amplitude table against
 * a textbook and finding every sign flipped should be told that this is not the
 * difference between right and wrong, or they will spend an evening chasing it.
 */

import {
  distributionFidelity,
  probabilities,
  qubitEntropy,
  stateFidelity,
  unitaryFidelity,
  type Statevector,
  type Unitary,
} from '@qsim/core'
import type { ChallengeFeedback, ChallengeFeedbackCode } from '@qsim/contract'

/**
 * How many diagnoses one submission gets.
 *
 * Three. A wall of advice is a wall nobody reads, and the codes below are
 * emitted most-specific first, so the cut keeps the ones that say the most.
 */
export const MAX_FEEDBACK = 3

/**
 * Below this a probability is Float64 residue rather than an outcome — the
 * same floor `histogram.ts` uses in `apps/web`, and for the same reason: a
 * Bell pair has two outcomes, not two outcomes and two ghosts.
 */
const PROBABILITY_FLOOR = 1e-12

/** Two distributions this close are the same distribution (D6). */
const AGREEMENT = 1e-9

/** A von Neumann entropy above this means the qubit is entangled with something. */
const ENTANGLED = 1e-6

/** Above this fraction of the threshold, a wrong answer is a near miss. */
const NEARLY = 0.9

/**
 * A probability-like quantity, kept inside [0, 1] before it goes on the wire.
 *
 * The same argument `clampFidelity` makes in `validate.ts`: a Bhattacharyya
 * overlap of two distributions is a probability and Float64 is not, so a sum
 * over 2ⁿ terms lands a few ulps outside — measured at 1.0000000000012799.
 * Every other fidelity in a verdict is clamped; this one was not, and it is
 * serialised as a plain number that a catalog is one edit away from printing
 * as "100.0000000001 %".
 */
function clampProbability(value: number): number {
  if (!Number.isFinite(value)) return 0
  return Math.min(1, Math.max(0, value))
}

export function feedback(
  code: ChallengeFeedbackCode,
  extra: { value?: number; gate?: string } = {}
): ChallengeFeedback {
  return {
    code,
    value: extra.value ?? null,
    gate: extra.gate ?? null,
  }
}

/** The index whose bits are `index`'s in the opposite order. */
export function reverseIndexBits(index: number, qubits: number): number {
  let reversed = 0
  for (let bit = 0; bit < qubits; bit++) {
    if (((index >> bit) & 1) === 1) reversed |= 1 << (qubits - 1 - bit)
  }
  return reversed
}

/** The same state with qubit q renamed to qubit n−1−q. */
export function reverseQubits(state: Statevector): Statevector {
  const out: Statevector = {
    qubits: state.qubits,
    size: state.size,
    re: new Float64Array(state.size),
    im: new Float64Array(state.size),
  }
  for (let i = 0; i < state.size; i++) {
    const j = reverseIndexBits(i, state.qubits)
    out.re[j] = state.re[i] as number
    out.im[j] = state.im[i] as number
  }
  return out
}

/** The same operation with every wire renamed q → n−1−q. */
export function reverseUnitaryQubits(matrix: Unitary): Unitary {
  const { dim, qubits } = matrix
  const out: Unitary = {
    qubits,
    dim,
    re: new Float64Array(dim * dim),
    im: new Float64Array(dim * dim),
  }
  for (let col = 0; col < dim; col++) {
    const rc = reverseIndexBits(col, qubits)
    for (let row = 0; row < dim; row++) {
      const rr = reverseIndexBits(row, qubits)
      out.re[rc * dim + rr] = matrix.re[col * dim + row] as number
      out.im[rc * dim + rr] = matrix.im[col * dim + row] as number
    }
  }
  return out
}

/** How many basis states carry real probability. */
function outcomeCount(state: Statevector): number {
  const probs = probabilities(state)
  let count = 0
  for (let i = 0; i < probs.length; i++) {
    if ((probs[i] as number) > PROBABILITY_FLOOR) count++
  }
  return count
}

/** Whether any single qubit is entangled with the rest of the register. */
function isEntangled(state: Statevector): boolean {
  for (let qubit = 0; qubit < state.qubits; qubit++) {
    if (qubitEntropy(state, qubit) > ENTANGLED) return true
  }
  return false
}

/** The phase of ⟨target|actual⟩, which fidelity throws away. */
function overlapPhase(actual: Statevector, target: Statevector): number {
  let re = 0
  let im = 0
  for (let i = 0; i < actual.size; i++) {
    re += (target.re[i] as number) * (actual.re[i] as number)
    re += (target.im[i] as number) * (actual.im[i] as number)
    im += (target.re[i] as number) * (actual.im[i] as number)
    im -= (target.im[i] as number) * (actual.re[i] as number)
  }
  return Math.atan2(im, re)
}

/**
 * What is wrong with a state, in the order a reader can act on.
 *
 * The first three checks are the ones that name a *cause*; the rest describe
 * the shape of the miss. `MAX_FEEDBACK` cuts the tail.
 */
export function diagnoseState(input: {
  actual: Statevector
  target: Statevector
  fidelity: number
  threshold: number
}): ChallengeFeedback[] {
  const { actual, target, fidelity, threshold } = input
  const found: ChallengeFeedback[] = []

  if (fidelity >= threshold) {
    found.push(feedback('solved', { value: fidelity }))
    /*
     * Said only when there is something to say. A phase of zero is the
     * ordinary case and mentioning it would be noise; a phase of π is the
     * reader whose every amplitude has the opposite sign, and who is one
     * sentence away from not worrying about it.
     */
    const phase = overlapPhase(actual, target)
    if (Math.abs(phase) > 1e-6) {
      found.push(feedback('global-phase-ignored', { value: phase }))
    }
    return found
  }

  if (fidelity < 1e-9) found.push(feedback('orthogonal', { value: fidelity }))

  /*
   * THE ONE THIS FILE EXISTS FOR. Identical probabilities, different state:
   * every magnitude is right and the phases between them are not, which is
   * invisible in a histogram and obvious in the phasors beside it (§10).
   */
  const magnitudes = clampProbability(
    distributionFidelity(probabilities(actual), probabilities(target))
  )
  if (magnitudes > 1 - AGREEMENT) {
    found.push(feedback('relative-phase', { value: magnitudes }))
  }

  // D1 in disguise: the right circuit built on the wires in the other order.
  if (stateFidelity(reverseQubits(actual), target) >= threshold) {
    found.push(feedback('qubit-order-reversed'))
  }

  const targetEntangled = isEntangled(target)
  const actualEntangled = isEntangled(actual)
  if (targetEntangled && !actualEntangled) {
    found.push(feedback('entanglement-missing'))
  } else if (actualEntangled && !targetEntangled) {
    found.push(feedback('entanglement-unwanted'))
  }

  if (magnitudes <= 1 - AGREEMENT) {
    const mine = outcomeCount(actual)
    const theirs = outcomeCount(target)
    if (mine < theirs) found.push(feedback('too-few-outcomes', { value: mine }))
    else if (mine > theirs) {
      found.push(feedback('too-many-outcomes', { value: mine }))
    }
  }

  if (fidelity >= NEARLY * threshold) {
    found.push(feedback('nearly-there', { value: fidelity }))
  }

  return found.slice(0, MAX_FEEDBACK)
}

/**
 * The same reading for an operation.
 *
 * Fewer checks, because fewer of them mean anything about a matrix: a unitary
 * has no "outcomes" and is not entangled or not. What survives is the pair that
 * do — the magnitudes-versus-phases split, and the reversed register — because
 * both are mistakes rather than misunderstandings.
 */
export function diagnoseUnitary(input: {
  actual: Unitary
  target: Unitary
  fidelity: number
  threshold: number
}): ChallengeFeedback[] {
  const { actual, target, fidelity, threshold } = input
  if (fidelity >= threshold) return [feedback('solved', { value: fidelity })]

  const found: ChallengeFeedback[] = []
  if (fidelity < 1e-9) found.push(feedback('orthogonal', { value: fidelity }))

  /*
   * Entry-by-entry magnitudes. For an operation this is the same reading as
   * the histogram comparison above: |Uᵢⱼ|² is the probability that |j⟩ comes
   * out as |i⟩, so two matrices agreeing here agree about every measurement
   * outcome of every basis input and differ only in the phases between them.
   */
  if (magnitudesAgree(actual, target)) {
    found.push(feedback('relative-phase', { value: 1 }))
  }

  if (unitaryFidelity(reverseUnitaryQubits(actual), target) >= threshold) {
    found.push(feedback('qubit-order-reversed'))
  }

  if (fidelity >= NEARLY * threshold) {
    found.push(feedback('nearly-there', { value: fidelity }))
  }

  return found.slice(0, MAX_FEEDBACK)
}

function magnitudesAgree(a: Unitary, b: Unitary): boolean {
  for (let i = 0; i < a.re.length; i++) {
    const left = (a.re[i] as number) ** 2 + (a.im[i] as number) ** 2
    const right = (b.re[i] as number) ** 2 + (b.im[i] as number) ** 2
    if (Math.abs(left - right) > 1e-9) return false
  }
  return true
}
