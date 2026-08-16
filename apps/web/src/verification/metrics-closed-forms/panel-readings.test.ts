/**
 * INDEPENDENT ADVERSARIAL VERIFICATION — METRICS CLOSED FORMS, PANEL SIDE.
 *
 * The engine half of this lens lives in
 * `packages/qsim/src/verification/metrics-closed-forms.test.ts`, where every
 * closed form is derived from a definition and checked against the engine.
 * This file asks the next question: does the number the engine computed
 * survive the trip to the panel's model, and does the *sentence* printed
 * beside it say the same thing the number does?
 *
 * The two failures it is looking for are both silent:
 *
 *  1. **A reading that contradicts its own number.** `entropyReadingOf` and
 *     `pairReadingOf` classify at a tolerance tied to the printed precision,
 *     so a row can read `0,9183` next to "has no state of its own" if the
 *     threshold is on the wrong side of a comparison. The closed forms are
 *     what says which side is right: H₂(1/3) is 0.918, and 0.918 is *not* 1.
 *
 *  2. **GHZ and W collapsing into each other.** The panel's whole reason for
 *     showing two tables is that these two states are indistinguishable in
 *     one of them and opposite in the other. GHZ₃ has every qubit at entropy
 *     exactly 1 and every pair at concurrence exactly 0; W₃ has every qubit
 *     at 0.9182958340544896 and every pair at exactly 2/3. If the summary
 *     line and the readings do not separate them, the panel has two tables
 *     and one lesson fewer than §3.2 asked for.
 *
 * Both states are built here from their amplitudes rather than from a
 * circuit, so no gate application stands between the definition and the
 * assertion.
 */

import type { Statevector } from '@qsim/core'
import { describe, expect, it } from 'vitest'

import {
  MAX_CONCURRENCE_QUBITS,
  buildEntanglement,
  entropyReadingOf,
  pairReadingOf,
} from '../../features/analysis/entanglement'

/** D6 again. */
const DIGITS = 10

/** H₂(1/3) = log₂3 − 2/3, by hand. The number a W₃ qubit has to read. */
const H2_THIRD = 0.9182958340544896

function makeState(
  qubits: number,
  entries: readonly (readonly [number, number, number])[]
): Statevector {
  const size = 1 << qubits
  const re = new Float64Array(size)
  const im = new Float64Array(size)
  // `?? 0` throughout, and it is exact rather than defensive: every index here
  // is inside a `Float64Array` of length `size`, so the fallback is unreachable
  // — it is only what `noUncheckedIndexedAccess` asks a typed-array read to say
  // out loud. Same convention as the rest of the tree.
  for (const [index, r, i] of entries) {
    re[index] = (re[index] ?? 0) + r
    im[index] = (im[index] ?? 0) + i
  }
  let norm = 0
  for (let k = 0; k < size; k++) {
    norm += (re[k] ?? 0) * (re[k] ?? 0) + (im[k] ?? 0) * (im[k] ?? 0)
  }
  const scale = 1 / Math.sqrt(norm)
  for (let k = 0; k < size; k++) {
    re[k] = (re[k] ?? 0) * scale
    im[k] = (im[k] ?? 0) * scale
  }
  return { qubits, size, re, im }
}

const GHZ3 = makeState(3, [
  [0, 1, 0],
  [7, 1, 0],
])

const W3 = makeState(3, [
  [1, 1, 0],
  [2, 1, 0],
  [4, 1, 0],
])

const BELL = makeState(2, [
  [0, 1, 0],
  [3, 1, 0],
])

const PRODUCT = makeState(2, [
  [0, 1, 0],
  [1, 1, 0],
])

describe('the entanglement panel model against closed forms', () => {
  it('separates GHZ₃ from W₃ exactly where §3.2 says it should', () => {
    const ghz = buildEntanglement(GHZ3)
    for (const row of ghz.entropies) {
      expect(row.entropy, `GHZ ${row.name}`).toBeCloseTo(1, DIGITS)
      expect(row.reading, `GHZ ${row.name}`).toBe('none')
    }
    expect(ghz.pairs).toHaveLength(3)
    for (const pair of ghz.pairs) {
      expect(pair.concurrence, `GHZ ${pair.name}`).toBeCloseTo(0, DIGITS)
      expect(pair.reading, `GHZ ${pair.name}`).toBe('separable')
    }
    // Every qubit entangled, no pair sharing anything — the one shape the
    // panel prints its extra sentence for.
    expect(ghz.entangledQubits).toBe(3)
    expect(ghz.strongestPair).toBeNull()

    const w = buildEntanglement(W3)
    for (const row of w.entropies) {
      expect(row.entropy, `W ${row.name}`).toBeCloseTo(H2_THIRD, DIGITS)
      // 0.918 is not 1, and the sentence beside it must not say it is.
      expect(row.reading, `W ${row.name}`).toBe('partial')
    }
    expect(w.pairs).toHaveLength(3)
    for (const pair of w.pairs) {
      expect(pair.concurrence, `W ${pair.name}`).toBeCloseTo(2 / 3, DIGITS)
      expect(pair.reading, `W ${pair.name}`).toBe('partial')
    }
    expect(w.entangledQubits).toBe(3)
    expect(w.strongestPair).not.toBeNull()
    expect(w.strongestPair?.concurrence).toBeCloseTo(2 / 3, DIGITS)
    // Ties go to the first pair in (first, second) order, so the headline is
    // the same on every run rather than whichever the loop reached last.
    expect(w.strongestPair?.first).toBe(0)
    expect(w.strongestPair?.second).toBe(1)
  })

  it('reads a Bell pair as maximal and a product state as neither', () => {
    const bell = buildEntanglement(BELL)
    expect(bell.entropies.every((row) => row.reading === 'none')).toBe(true)
    // Narrowed rather than indexed inline: a two-qubit register has exactly one
    // pair, so a missing row is itself a failure and this is where it reads as
    // one instead of as `undefined` reaching a matcher.
    const bellPair = bell.pairs[0]
    expect(bellPair, 'a two-qubit register has one pair').toBeDefined()
    expect(bellPair?.concurrence).toBeCloseTo(1, DIGITS)
    expect(bellPair?.reading).toBe('maximal')
    expect(bell.entangledQubits).toBe(2)

    const product = buildEntanglement(PRODUCT)
    expect(product.entropies.every((row) => row.reading === 'own')).toBe(true)
    const productPair = product.pairs[0]
    expect(productPair, 'a two-qubit register has one pair').toBeDefined()
    expect(productPair?.concurrence).toBeCloseTo(0, DIGITS)
    expect(productPair?.reading).toBe('separable')
    expect(product.entangledQubits).toBe(0)
    expect(product.strongestPair).toBeNull()
  })

  it('classifies at the printed precision, on both sides of each edge', () => {
    // The thresholds decide what a row *says*, so they are checked as
    // thresholds rather than only through the states that happen to land far
    // from them.
    expect(entropyReadingOf(0)).toBe('own')
    expect(entropyReadingOf(1e-9)).toBe('own')
    expect(entropyReadingOf(1e-3)).toBe('partial')
    expect(entropyReadingOf(H2_THIRD)).toBe('partial')
    expect(entropyReadingOf(0.9999)).toBe('partial')
    expect(entropyReadingOf(1)).toBe('none')
    // An entropy a shade over 1 is Float64 residue, not a new category.
    expect(entropyReadingOf(1 + 1e-12)).toBe('none')

    expect(pairReadingOf(0)).toBe('separable')
    expect(pairReadingOf(1e-9)).toBe('separable')
    expect(pairReadingOf(2 / 3)).toBe('partial')
    expect(pairReadingOf(0.9999)).toBe('partial')
    expect(pairReadingOf(1)).toBe('maximal')
    expect(pairReadingOf(1 + 1e-12)).toBe('maximal')
  })

  it('names one pair per unordered pair, in a stable order', () => {
    const model = buildEntanglement(
      makeState(4, [
        [0, 1, 0],
        [15, 1, 0],
      ])
    )
    expect(model.pairs).toHaveLength(6)
    const seen = model.pairs.map((pair) => `${pair.first}:${pair.second}`)
    expect(seen).toEqual(['0:1', '0:2', '0:3', '1:2', '1:3', '2:3'])
    expect(new Set(seen).size).toBe(6)
  })

  it('says which limit it hit rather than thinning the table', () => {
    // A single qubit has no pairs to show; a wide register has pairs it will
    // not pay for. Both leave `pairs` empty, and the panel tells them apart by
    // the register size — so the model has to make that distinguishable.
    const single = buildEntanglement(makeState(1, [[0, 1, 0]]))
    expect(single.pairsComputed).toBe(false)
    expect(single.pairs).toHaveLength(0)
    expect(single.qubits).toBeLessThan(2)

    const wide = buildEntanglement(
      makeState(MAX_CONCURRENCE_QUBITS + 1, [
        [0, 1, 0],
        [1, 1, 0],
      ])
    )
    expect(wide.pairsComputed).toBe(false)
    expect(wide.pairs).toHaveLength(0)
    expect(wide.qubits).toBeGreaterThan(MAX_CONCURRENCE_QUBITS)
    // The entropies are never withheld — they have a closed form and no
    // ceiling, which is the whole reason the two tables stop at different
    // sizes.
    expect(wide.entropies).toHaveLength(MAX_CONCURRENCE_QUBITS + 1)
    // And it is still the right closed form up there: qubit 0 is in |+⟩ and
    // every other wire is in |0⟩, so nothing is entangled with anything.
    expect(wide.entangledQubits).toBe(0)
  })
})
