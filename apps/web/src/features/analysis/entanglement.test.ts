/**
 * The entanglement panel's model.
 *
 * The physics is the engine's and is tested there; what is asserted here is
 * that the panel asks for the right numbers and reads them the right way. Two
 * of these are the reason §3.2 wants both metrics rather than one:
 *
 *  - Every qubit of GHZ₃ has an entropy near 1 and every *pair* of it has a
 *    concurrence of exactly 0. The state is maximally entangled and no two of
 *    its qubits hold any of it between them.
 *  - Every pair of W₃ reads 2/3 on the same register size, so the contrast is
 *    a property of the state and not of the arithmetic.
 *
 * A panel that showed only entropies would call those two states the same, and
 * a reader would have no way to tell that they are not.
 */

import { concurrenceOf, qubitEntropy, run, type Statevector } from '@qsim/core'
import { parseCircuit, type CircuitInput } from '@qsim/schema'
import { describe, expect, it } from 'vitest'

import {
  MAX_CONCURRENCE_QUBITS,
  buildEntanglement,
  entropyReadingOf,
  pairName,
  pairReadingOf,
} from './entanglement'

const DIGITS = 9

function stateOf(input: CircuitInput): Statevector {
  const result = run(parseCircuit(input))
  if (result.mode !== 'analytic') throw new Error('expected an analytic run')
  return result.state
}

function ghz(qubits: number): Statevector {
  return stateOf({
    schemaVersion: 1,
    qubits,
    operations: [
      { id: 'h', gate: 'h', targets: [0], column: 0 },
      ...Array.from({ length: qubits - 1 }, (_unused, index) => ({
        id: `cx${index}`,
        gate: 'x',
        targets: [index + 1],
        controls: [index],
        column: index + 1,
      })),
    ],
  })
}

/** A product state: one Hadamard per wire, nothing shared. */
function product(qubits: number): Statevector {
  return stateOf({
    schemaVersion: 1,
    qubits,
    operations: Array.from({ length: qubits }, (_unused, wire) => ({
      id: `h${wire}`,
      gate: 'h',
      targets: [wire],
      column: 0,
    })),
  })
}

describe('readings', () => {
  it('classifies an entropy by the precision the table prints', () => {
    // Tied to the printed precision rather than to D6, for `bloch.ts`'s reason:
    // a row saying 1,0000 beside "partly entangled" is a contradiction on
    // screen whatever the seventh decimal says.
    expect(entropyReadingOf(0)).toBe('own')
    expect(entropyReadingOf(1e-8)).toBe('own')
    expect(entropyReadingOf(0.5)).toBe('partial')
    expect(entropyReadingOf(1)).toBe('none')
    expect(entropyReadingOf(1 - 1e-8)).toBe('none')
  })

  it('classifies a concurrence the same way', () => {
    expect(pairReadingOf(0)).toBe('separable')
    expect(pairReadingOf(2 / 3)).toBe('partial')
    expect(pairReadingOf(1)).toBe('maximal')
  })

  it('names a pair as notation, with the wire names the canvas uses', () => {
    expect(pairName(0, 3)).toBe('q0 · q3')
  })
})

describe('buildEntanglement', () => {
  it('reads a product state as every qubit having a state of its own', () => {
    const model = buildEntanglement(product(3))
    expect(model.entangledQubits).toBe(0)
    for (const row of model.entropies) {
      expect(row.entropy).toBeCloseTo(0, DIGITS)
      expect(row.reading).toBe('own')
    }
    for (const pair of model.pairs) {
      expect(pair.concurrence).toBeCloseTo(0, DIGITS)
      expect(pair.reading).toBe('separable')
    }
    expect(model.strongestPair).toBeNull()
  })

  it('reads a Bell pair as one bit each and a maximal pair', () => {
    const model = buildEntanglement(ghz(2))
    expect(model.entropies.map((row) => row.reading)).toEqual(['none', 'none'])
    for (const row of model.entropies)
      expect(row.entropy).toBeCloseTo(1, DIGITS)

    expect(model.pairs).toHaveLength(1)
    expect(model.pairs[0]?.concurrence).toBeCloseTo(1, DIGITS)
    expect(model.pairs[0]?.reading).toBe('maximal')
    expect(model.strongestPair).toBe(model.pairs[0])
  })

  it('reads GHZ₃ as entangled qubits that share nothing pairwise', () => {
    // The contrast the two tables exist for. Every qubit has no state of its
    // own; no two of them hold any of it between them.
    const model = buildEntanglement(ghz(3))
    expect(model.entangledQubits).toBe(3)
    for (const row of model.entropies)
      expect(row.entropy).toBeCloseTo(1, DIGITS)

    expect(model.pairs).toHaveLength(3)
    for (const pair of model.pairs) {
      expect(pair.concurrence).toBeCloseTo(0, DIGITS)
      expect(pair.reading).toBe('separable')
    }
    // Which is what the panel's extra sentence is printed for.
    expect(model.strongestPair).toBeNull()
  })

  it('reads W₃ as every pair sharing two thirds', () => {
    // Built explicitly rather than through a gate sequence, so the state is
    // the textbook one and the expected 2/3 is a closed form rather than a
    // number this suite copied out of its own output.
    const state = wState()
    const model = buildEntanglement(state)
    expect(model.pairs).toHaveLength(3)
    for (const pair of model.pairs) {
      expect(pair.concurrence).toBeCloseTo(2 / 3, 8)
      expect(pair.reading).toBe('partial')
    }
    expect(model.strongestPair?.concurrence).toBeCloseTo(2 / 3, 8)
  })

  it('takes every number from the engine rather than deriving one', () => {
    // The panel computes nothing numeric: this asserts the model is a call
    // site and not a second implementation.
    const state = ghz(3)
    const model = buildEntanglement(state)
    model.entropies.forEach((row) => {
      expect(row.entropy).toBe(qubitEntropy(state, row.qubit))
    })
    model.pairs.forEach((pair) => {
      expect(pair.concurrence).toBe(
        concurrenceOf(state, pair.first, pair.second)
      )
    })
  })

  it('lists every pair once, in reading order', () => {
    const model = buildEntanglement(product(4))
    expect(model.pairs.map((pair) => [pair.first, pair.second])).toEqual([
      [0, 1],
      [0, 2],
      [0, 3],
      [1, 2],
      [1, 3],
      [2, 3],
    ])
  })

  it('computes no pairs for a single qubit, and says so', () => {
    const model = buildEntanglement(product(1))
    expect(model.pairsComputed).toBe(false)
    expect(model.pairs).toEqual([])
    // The entropies are still there: `qubitEntropy` has no ceiling.
    expect(model.entropies).toHaveLength(1)
  })

  it('stops the pair table past its ceiling and keeps the entropies', () => {
    // n²·2ⁿ leaves the frame budget past twelve qubits (`entanglement.ts`), so
    // the table stops — visibly, in a sentence — rather than thinning itself or
    // costing a quarter of a second on every keystroke.
    const wide = product(MAX_CONCURRENCE_QUBITS + 1)
    const model = buildEntanglement(wide)
    expect(model.pairsComputed).toBe(false)
    expect(model.pairs).toEqual([])
    expect(model.entropies).toHaveLength(MAX_CONCURRENCE_QUBITS + 1)

    const atTheLimit = buildEntanglement(product(MAX_CONCURRENCE_QUBITS))
    expect(atTheLimit.pairsComputed).toBe(true)
  })
})

/** (|100⟩ + |010⟩ + |001⟩)/√3, written out. */
function wState(): Statevector {
  const size = 8
  const re = new Float64Array(size)
  const im = new Float64Array(size)
  const amplitude = 1 / Math.sqrt(3)
  for (const index of [1, 2, 4]) re[index] = amplitude
  return { qubits: 3, size, re, im }
}
