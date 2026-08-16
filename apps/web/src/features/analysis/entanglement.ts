/**
 * The model behind the entanglement panel — §3.2: "entropía de von Neumann de
 * cada subsistema y concurrencia para pares de qubits".
 *
 * No React and no i18next, the same split every other model here makes. And no
 * physics: `qubitEntropy` and `concurrenceOf` are the engine's, where the
 * adversarial suite lives, and this module calls them. What is left is which
 * numbers to ask for, what each one *reads* as, and where to stop asking.
 *
 * ────────────────────────────────────────────────────────────────────────
 * TWO NUMBERS THAT ANSWER DIFFERENT QUESTIONS, WHICH IS WHY §3.2 WANTS BOTH
 *
 * The per-qubit entropy asks "does this qubit have a state of its own?". It is
 * 0 when it does and 1 when it has none at all, and everything in between is a
 * qubit whose state is partly held somewhere else. It is the Bloch panel's
 * shortened arrow written as a number: S = H₂((1 − |r|)/2), so an arrow at the
 * centre of its sphere and an entropy of exactly 1 are one fact in two
 * renderings.
 *
 * The concurrence asks a question the entropy cannot: "do these two share it
 * with *each other*?". The contrast that makes the pair worth showing together
 * is GHZ₃ against W₃. Both have every qubit at entropy 0.918 or 1; but every
 * pair of GHZ₃ reads a concurrence of 0, because the entanglement is a
 * three-way property that no two of its qubits hold between them, while every
 * pair of W₃ reads 2/3. One number says the qubits are entangled; the other
 * says with whom.
 *
 * ────────────────────────────────────────────────────────────────────────
 * WHERE THE PAIRS STOP, AND WHY THE ENTROPIES DO NOT
 *
 * The engine draws exactly this line itself and for exactly this reason:
 * `qubitEntropy` has a closed form and "works at any register size", while
 * anything needing a decomposition stops at `MAX_SUBSYSTEM_QUBITS`. The costs
 * on this side follow it.
 *
 * An entropy is one pass over the amplitudes per qubit — n·2ⁿ, which is what
 * the Bloch panel next door already pays for its vectors and is documented
 * there as affordable. A concurrence is a partial trace to two qubits, so
 * roughly 4·2ⁿ per pair, and there are n(n−1)/2 pairs. Multiplied out on the
 * main thread, per result:
 *
 *     n = 8    28 pairs ×   1 024  ≈  29 000     instant
 *     n = 10   45 pairs ×   4 096  ≈ 184 000     instant
 *     n = 12   66 pairs ×  16 384  ≈ 1.1 million  a few milliseconds
 *     n = 14   91 pairs ×  65 536  ≈ 6 million    tens of milliseconds
 *     n = 16  120 pairs × 262 144  ≈ 31 million   a quarter of a second
 *
 * Twelve is the last size that stays inside a frame, so that is where the pair
 * table stops — with a visible, translated sentence saying so, the way the
 * histogram states its bar cap. It is not silently thinned and it is not
 * quietly slow: §3.2's own model of a limit is that it is stated on screen.
 *
 * That twelve coincides with §3.3's density-matrix ceiling is a coincidence of
 * two different arithmetics and not a shared constant — one is 4ⁿ bytes, the
 * other is n³·2ⁿ operations — so they are written down separately and may
 * diverge.
 */

import { concurrenceOf, qubitEntropy, type Statevector } from '@qsim/core'

import { qubitName } from './bloch'

/**
 * The widest register the pair table is computed for. See the header for the
 * measurements this comes from.
 */
export const MAX_CONCURRENCE_QUBITS = 12

/**
 * How close to 0 or 1 counts as being there: half of the last digit the table
 * prints.
 *
 * Deliberately not D6's 1e-10, and for the reason `READING_TOLERANCE` in
 * `bloch.ts` gives: the sentence sits in the same row as the number, and a row
 * reading `1,0000` beside "has a state of its own" is a contradiction on screen
 * whatever the seventh decimal says. Tying the threshold to the printed
 * precision makes the word and the digits incapable of disagreeing.
 */
export const READING_TOLERANCE = 5e-5

/**
 * What a qubit's entropy says about it.
 *
 * `own`     S = 0. The qubit has a state of its own; nothing else holds any
 *           part of it, and its Bloch arrow reaches the surface.
 * `partial` in between. Part of its state is held jointly with the rest.
 * `none`    S = 1. It has no state of its own at all — the maximum a single
 *           qubit can reach, and what either half of a Bell pair reads.
 */
export type EntropyReading = 'own' | 'partial' | 'none'

export function entropyReadingOf(entropy: number): EntropyReading {
  if (entropy <= READING_TOLERANCE) return 'own'
  if (entropy >= 1 - READING_TOLERANCE) return 'none'
  return 'partial'
}

/** What a pair's concurrence says about the two of them. */
export type PairReading = 'separable' | 'partial' | 'maximal'

export function pairReadingOf(concurrence: number): PairReading {
  if (concurrence <= READING_TOLERANCE) return 'separable'
  if (concurrence >= 1 - READING_TOLERANCE) return 'maximal'
  return 'partial'
}

export interface QubitEntropy {
  readonly qubit: number
  /** The wire's name, as the canvas names an unlabelled one: `q0`. */
  readonly name: string
  /** S(ρ_q) in bits. 0 for a qubit with a state of its own, 1 for none. */
  readonly entropy: number
  readonly reading: EntropyReading
}

export interface PairConcurrence {
  readonly first: number
  readonly second: number
  readonly name: string
  /** Wootters' concurrence: 0 for a separable pair, 1 for a Bell pair. */
  readonly concurrence: number
  readonly reading: PairReading
}

export interface EntanglementModel {
  readonly qubits: number
  readonly entropies: readonly QubitEntropy[]
  /** Every pair, or empty when the register is past `MAX_CONCURRENCE_QUBITS`. */
  readonly pairs: readonly PairConcurrence[]
  /** Whether the pairs were computed at all. False is a sentence, not a gap. */
  readonly pairsComputed: boolean
  /** Qubits with no state of their own — the headline of the caption. */
  readonly entangledQubits: number
  /** The most entangled pair, or null when none of them share anything. */
  readonly strongestPair: PairConcurrence | null
}

/**
 * Every number the panel prints, from one state.
 *
 * Memoised by the caller on the state, exactly as the Bloch vectors are: this
 * is the second-largest piece of arithmetic the analysis panel does, and doing
 * it once per answer rather than once per render is the whole of what keeps it
 * affordable.
 */
export function buildEntanglement(state: Statevector): EntanglementModel {
  const qubits = state.qubits
  const entropies: QubitEntropy[] = []
  for (let qubit = 0; qubit < qubits; qubit++) {
    const entropy = qubitEntropy(state, qubit)
    entropies.push({
      qubit,
      name: qubitName(qubit),
      entropy,
      reading: entropyReadingOf(entropy),
    })
  }

  const pairsComputed = qubits >= 2 && qubits <= MAX_CONCURRENCE_QUBITS
  const pairs: PairConcurrence[] = []
  if (pairsComputed) {
    for (let first = 0; first < qubits; first++) {
      for (let second = first + 1; second < qubits; second++) {
        const value = concurrenceOf(state, first, second)
        pairs.push({
          first,
          second,
          name: pairName(first, second),
          concurrence: value,
          reading: pairReadingOf(value),
        })
      }
    }
  }

  let strongestPair: PairConcurrence | null = null
  for (const pair of pairs) {
    if (pair.concurrence <= READING_TOLERANCE) continue
    // Ties go to the first pair in (first, second) order, so two equally
    // entangled pairs name the same one on every run — the same tie-break
    // discipline `buildHistogram` applies to its bars.
    if (
      strongestPair === null ||
      pair.concurrence > strongestPair.concurrence
    ) {
      strongestPair = pair
    }
  }

  return {
    qubits,
    entropies,
    pairs,
    pairsComputed,
    entangledQubits: entropies.filter((row) => row.reading !== 'own').length,
    strongestPair,
  }
}

/**
 * A pair's name, as notation rather than as a sentence: `q0 · q1`.
 *
 * The separator is a middle dot for the reason `formatPhaseReading` uses one —
 * a comma is already the decimal separator in two of the three languages — and
 * the whole string goes through `Notation`, because a wire's name is invariant
 * across the three catalogs exactly as `q0` is on the canvas.
 */
export function pairName(first: number, second: number): string {
  return `${qubitName(first)} · ${qubitName(second)}`
}
