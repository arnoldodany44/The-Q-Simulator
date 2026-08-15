import { run, type Statevector } from '@qsim/core'
import { parseCircuit, type CircuitInput } from '@qsim/schema'
import { describe, expect, it } from 'vitest'

import {
  buildAmplitudes,
  sortAmplitudes,
  type AmplitudeRow,
} from './amplitudes'

/**
 * The amplitude table's model, with no renderer near it.
 *
 * Every state is produced by running a real circuit through the engine, for
 * the reason `histogram.test.ts` gives: a hand-assembled statevector would
 * only prove the table is consistent with itself, and what has to be true is
 * that it reports what the simulator says.
 *
 * D6 fixes the tolerance at 1e-10. `1/√2` squared is not exactly 0.5 in
 * Float64, so nothing here compares for equality.
 */

const HALF_ROOT_TWO = Math.SQRT1_2

function stateOf(input: CircuitInput): Statevector {
  const result = run(parseCircuit(input))
  if (result.mode !== 'analytic') throw new Error('expected an analytic run')
  return result.state
}

/** H then CNOT: (|00⟩ + |11⟩)/√2. */
const BELL: CircuitInput = {
  schemaVersion: 1,
  qubits: 2,
  operations: [
    { id: 'a', gate: 'h', targets: [0], column: 0 },
    { id: 'b', gate: 'cx', targets: [1], controls: [0], column: 1 },
  ],
}

/** H then S: (|0⟩ + i|1⟩)/√2 — a purely imaginary second amplitude. */
const IMAGINARY: CircuitInput = {
  schemaVersion: 1,
  qubits: 1,
  operations: [
    { id: 'a', gate: 'h', targets: [0], column: 0 },
    { id: 'b', gate: 's', targets: [0], column: 1 },
  ],
}

function uniform(qubits: number): CircuitInput {
  return {
    schemaVersion: 1,
    qubits,
    operations: Array.from({ length: qubits }, (_, qubit) => ({
      id: `h${qubit}`,
      gate: 'h',
      targets: [qubit],
      column: 0,
    })),
  }
}

/**
 * Amplitudes of different sizes: Ry(2·atan(2)) puts |1⟩ at 4/5 and |0⟩ at
 * 3/5, so probability order and basis-state order disagree.
 */
const LOPSIDED: CircuitInput = {
  schemaVersion: 1,
  qubits: 1,
  operations: [
    {
      id: 'a',
      gate: 'ry',
      targets: [0],
      column: 0,
      params: [2 * Math.atan(2)],
    },
  ],
}

describe('a known state', () => {
  it('reports the amplitude, the magnitude and the probability of each row', () => {
    const model = buildAmplitudes(stateOf(BELL))

    expect(model.rows.map((row) => row.label)).toEqual(['00', '11'])
    for (const row of model.rows) {
      expect(row.re).toBeCloseTo(HALF_ROOT_TWO, 10)
      expect(row.im).toBeCloseTo(0, 10)
      // |a| and |a|² are different numbers and both are shown: 0,7071 and
      // 50 %. A table that printed one for the other would be believable and
      // wrong, which is exactly why this is asserted.
      expect(row.magnitude).toBeCloseTo(HALF_ROOT_TWO, 10)
      expect(row.probability).toBeCloseTo(0.5, 10)
      expect(row.phase).toBeCloseTo(0, 10)
    }
  })

  it('keeps the imaginary part rather than folding it into a magnitude', () => {
    const model = buildAmplitudes(stateOf(IMAGINARY))
    const [zero, one] = model.rows

    expect(zero?.re).toBeCloseTo(HALF_ROOT_TWO, 10)
    expect(zero?.im).toBeCloseTo(0, 10)
    expect(one?.re).toBeCloseTo(0, 10)
    expect(one?.im).toBeCloseTo(HALF_ROOT_TWO, 10)
    // The phase is what the imaginary part is *for*: a quarter turn.
    expect(one?.phase).toBeCloseTo(Math.PI / 2, 10)
  })

  it('lists the states in basis order, so a row keeps its address', () => {
    const model = buildAmplitudes(stateOf(uniform(3)))

    expect(model.rows.map((row) => row.index)).toEqual([0, 1, 2, 3, 4, 5, 6, 7])
  })
})

describe('the cap', () => {
  it('is the histogram’s cap, applied to the same states', () => {
    const model = buildAmplitudes(stateOf(uniform(5)), 4)

    expect(model.rows).toHaveLength(4)
    expect(model.occupied).toBe(32)
    expect(model.size).toBe(32)
    expect(model.hidden).toBe(28)
    expect(model.hiddenProbability).toBeCloseTo(28 / 32, 10)
  })

  it('leaves nothing hidden when everything fits', () => {
    const model = buildAmplitudes(stateOf(BELL))

    expect(model.hidden).toBe(0)
    expect(model.hiddenProbability).toBe(0)
  })

  it('drops the basis states no amplitude reaches', () => {
    // A Bell pair is two rows out of four, not four rows two of which are
    // zero: 1e-12 on |a|² is Float64 residue, not physics.
    expect(buildAmplitudes(stateOf(BELL)).rows).toHaveLength(2)
  })
})

describe('sorting', () => {
  const rows = buildAmplitudes(stateOf(LOPSIDED)).rows

  it('orders by probability, largest first', () => {
    const sorted = sortAmplitudes(rows, 'probability')

    expect(sorted.map((row) => row.index)).toEqual([1, 0])
    expect(sorted[0]?.probability).toBeCloseTo(0.8, 10)
  })

  it('orders by basis state', () => {
    const sorted = sortAmplitudes(sortAmplitudes(rows, 'probability'), 'state')

    expect(sorted.map((row) => row.index)).toEqual([0, 1])
  })

  it('breaks ties on the index, so equal amplitudes never shuffle', () => {
    // A uniform superposition is the common case and every probability in it
    // is the same number. Without a tie-break the order would be whatever the
    // sort did that day, and the table would reorder itself for no reason.
    const uniformRows = buildAmplitudes(stateOf(uniform(4))).rows
    const sorted = sortAmplitudes(uniformRows, 'probability')

    expect(sorted.map((row) => row.index)).toEqual(
      uniformRows.map((row) => row.index)
    )
  })

  it('returns a new array rather than reordering the model', () => {
    const before: readonly AmplitudeRow[] = [...rows]
    sortAmplitudes(rows, 'probability')

    expect(rows).toEqual(before)
  })
})
