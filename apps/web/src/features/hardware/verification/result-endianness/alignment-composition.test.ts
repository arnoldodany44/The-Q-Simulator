/**
 * The last leg of a measurement's journey home, verified against arithmetic
 * rather than against the module's own reasoning.
 *
 * A device answers with the **classical register** of the submitted program,
 * keyed highest classical bit first. The chart draws **basis states of the
 * qubit register**, indexed so that bit `q` is qubit `q` (D1). Those two are
 * the same picture only when the document's own measurements make them so, and
 * a document is free to write `c[2] = measure q[0]`.
 *
 * The oracle here is a hand-computed table: for each circuit, the outcome is
 * deterministic, so there is exactly one right statevector index and exactly
 * one right register key, and both are written out by hand from the definition
 * of the two orders. The ideal statevector is then simulated independently and
 * asserted to agree, which is what makes the hand table load-bearing rather
 * than decorative.
 *
 * Every fixture is asymmetric under a bit reversal. A Bell pair is a fixed
 * point of exactly the mistake being hunted, so it can prove nothing here.
 */

import { analyticMode, formatKet, run } from '@qsim/core'
import { CIRCUIT_SCHEMA_VERSION, type Circuit } from '@qsim/schema'
import { describe, expect, it } from 'vitest'

import {
  alignMeasurements,
  basisIndexOf,
  distributionFromCounts,
} from '../../alignment'
import { idealCircuitOf } from '../../ideal'

/**
 * `x` on qubit 0, nothing on qubits 1 and 2, with the classical register wired
 * three different ways. The state is the same in all three; the key a device
 * returns is not.
 */
function xOnQubitZero(
  clbitOfQubit: readonly [number, number, number]
): Circuit {
  return {
    schemaVersion: CIRCUIT_SCHEMA_VERSION,
    qubits: 3,
    clbits: 3,
    operations: [
      { id: 'x0', gate: 'x', targets: [0], column: 0 },
      ...clbitOfQubit.map((clbit, qubit) => ({
        id: `m${String(qubit)}`,
        gate: 'measure',
        targets: [qubit],
        clbitTargets: [clbit],
        column: 1,
      })),
    ],
  }
}

/** The one basis state a deterministic circuit ends in. */
function certainIndex(circuit: Circuit): number {
  const ideal = idealCircuitOf(circuit)
  if (!ideal.ok) throw new Error(`no ideal state: ${ideal.code}`)
  const result = run(ideal.circuit, analyticMode())
  if (result.mode !== 'analytic') throw new Error('expected an analytic run')
  const { state } = result
  let chosen = -1
  for (let index = 0; index < state.size; index++) {
    const p = (state.re[index] ?? 0) ** 2 + (state.im[index] ?? 0) ** 2
    if (p > 1 - 1e-10) chosen = index
    else if (p > 1e-10) throw new Error('the circuit is not deterministic')
  }
  if (chosen < 0) throw new Error('no basis state carries the probability')
  return chosen
}

describe('the device key and the chart index are the same outcome', () => {
  it('agrees with the hand table for three wirings of one state', () => {
    /*
     * `x` on qubit 0 leaves the register |q2 q1 q0> = |0 0 1>, statevector
     * index 1, `formatKet` label "001". Written by hand, three times, one per
     * wiring — the key is the register read highest classical bit first.
     */
    const cases = [
      // c[0]=q0, c[1]=q1, c[2]=q2 — the natural wiring. c[0] is the set bit.
      { clbitOfQubit: [0, 1, 2] as const, key: '001' },
      // c[2]=q0, c[1]=q1, c[0]=q2 — fully crossed. c[2] is the set bit.
      { clbitOfQubit: [2, 1, 0] as const, key: '100' },
      // c[1]=q0, c[0]=q1, c[2]=q2 — a rotation, so no wiring is its own
      // inverse and a "swap the ends" bug survives the previous case.
      { clbitOfQubit: [1, 0, 2] as const, key: '010' },
    ]

    for (const { clbitOfQubit, key } of cases) {
      const circuit = xOnQubitZero(clbitOfQubit)
      expect(certainIndex(circuit)).toBe(1)
      expect(formatKet(1, 3)).toBe('001')

      const aligned = alignMeasurements(circuit, 3)
      expect(aligned.ok).toBe(true)
      if (!aligned.ok) continue

      // Every wiring must send its own key to the one state the circuit made.
      expect(basisIndexOf(key, aligned.qubitOfClbit)).toBe(1)

      // And must send the *other* keys somewhere else, which is what makes the
      // agreement above evidence rather than coincidence.
      for (const other of ['001', '010', '100']) {
        if (other === key) continue
        expect(basisIndexOf(other, aligned.qubitOfClbit)).not.toBe(1)
      }

      const distribution = distributionFromCounts(
        { [key]: 500 },
        3,
        aligned.qubitOfClbit
      )
      expect([...distribution]).toEqual([0, 1, 0, 0, 0, 0, 0, 0])
    }
  })

  it('sends every key of a crossed register to the state it names', () => {
    // c[0]=q2, c[1]=q1, c[2]=q0. Key "abc" is c[2]c[1]c[0] = q0 q1 q2, so the
    // statevector index is q0·1 + q1·2 + q2·4 read straight off the key.
    const circuit = xOnQubitZero([2, 1, 0])
    const aligned = alignMeasurements(circuit, 3)
    expect(aligned.ok).toBe(true)
    if (!aligned.ok) return

    const expected: Readonly<Record<string, number>> = {
      '000': 0,
      '001': 4, // c[0]=1 → q2=1
      '010': 2, // c[1]=1 → q1=1
      '011': 6,
      '100': 1, // c[2]=1 → q0=1
      '101': 5,
      '110': 3,
      '111': 7,
    }
    for (const [key, index] of Object.entries(expected)) {
      expect(basisIndexOf(key, aligned.qubitOfClbit)).toBe(index)
    }
  })

  it('keeps a distribution normalised while it permutes it', () => {
    const circuit = xOnQubitZero([2, 1, 0])
    const aligned = alignMeasurements(circuit, 3)
    if (!aligned.ok) throw new Error('expected an alignment')

    const counts = { '100': 700, '000': 200, '011': 100 }
    const distribution = distributionFromCounts(counts, 3, aligned.qubitOfClbit)
    const total = [...distribution].reduce((sum, value) => sum + value, 0)
    expect(total).toBeCloseTo(1, 12)
    expect(distribution[1]).toBeCloseTo(0.7, 12) // "100" → q0
    expect(distribution[0]).toBeCloseTo(0.2, 12)
    expect(distribution[6]).toBeCloseTo(0.1, 12) // "011" → q1,q2
  })

  it('refuses a key whose width is not the register it is drawn against', () => {
    const circuit = xOnQubitZero([0, 1, 2])
    const aligned = alignMeasurements(circuit, 3)
    if (!aligned.ok) throw new Error('expected an alignment')
    // A leading zero that went missing is exactly this shape, and it must be a
    // refusal rather than a bar in the wrong place.
    expect(() => basisIndexOf('01', aligned.qubitOfClbit)).toThrow()
    expect(() => basisIndexOf('0001', aligned.qubitOfClbit)).toThrow()
  })
})

describe('a register that is not a relabelling is refused rather than drawn', () => {
  it('refuses a circuit that leaves a qubit unmeasured', () => {
    const circuit: Circuit = {
      schemaVersion: CIRCUIT_SCHEMA_VERSION,
      qubits: 3,
      clbits: 2,
      operations: [
        { id: 'x0', gate: 'x', targets: [0], column: 0 },
        {
          id: 'm0',
          gate: 'measure',
          targets: [0],
          clbitTargets: [0],
          column: 1,
        },
        {
          id: 'm1',
          gate: 'measure',
          targets: [1],
          clbitTargets: [1],
          column: 1,
        },
      ],
    }
    expect(alignMeasurements(circuit, 2)).toEqual({
      ok: false,
      code: 'unmeasured-qubit',
    })
  })

  it('refuses a classical bit no measurement writes', () => {
    const circuit = xOnQubitZero([0, 1, 2])
    // The device declared four bits; the document only fills three.
    expect(alignMeasurements(circuit, 4)).toEqual({
      ok: false,
      code: 'unwritten-clbit',
    })
  })
})
