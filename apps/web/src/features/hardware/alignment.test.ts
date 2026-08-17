/**
 * The endianness surface of §3.7, tested the only way it can be: with circuits
 * that are **asymmetric on purpose**.
 *
 * A Bell pair is symmetric under the exact relabelling these functions could get
 * wrong — `00` and `11` are fixed points of a bit swap — so it agrees with a
 * mirrored implementation of itself and proves nothing. Every circuit below
 * puts an `x` on one wire and nothing on the other, and several of them measure
 * into crossed classical bits, so a wrong answer is a *different* answer rather
 * than the same one.
 *
 * This is the third place in the project where the mistake would be invisible,
 * and the worst of the three: a real device gives nothing to compare against,
 * so two exchanged bars would look exactly like hardware noise that happened to
 * favour the other outcome.
 */

import { CIRCUIT_SCHEMA_VERSION, parseCircuit } from '@qsim/schema'
import type { CircuitInput } from '@qsim/schema'
import { describe, expect, it } from 'vitest'

import {
  alignMeasurements,
  basisIndexOf,
  distributionFromCounts,
} from './alignment'

function circuit(input: Omit<CircuitInput, 'schemaVersion'>) {
  return parseCircuit({ schemaVersion: CIRCUIT_SCHEMA_VERSION, ...input })
}

/** `x` on qubit 0 only, measured straight through: q[k] → c[k]. */
const straight = circuit({
  qubits: 2,
  clbits: 2,
  operations: [
    { id: 'op_1', gate: 'x', targets: [0], column: 0 },
    { id: 'op_2', gate: 'measure', targets: [0], clbitTargets: [0], column: 1 },
    { id: 'op_3', gate: 'measure', targets: [1], clbitTargets: [1], column: 1 },
  ],
})

/** The same circuit with the classical bits crossed: q[0] → c[1], q[1] → c[0]. */
const crossed = circuit({
  qubits: 2,
  clbits: 2,
  operations: [
    { id: 'op_1', gate: 'x', targets: [0], column: 0 },
    { id: 'op_2', gate: 'measure', targets: [0], clbitTargets: [1], column: 1 },
    { id: 'op_3', gate: 'measure', targets: [1], clbitTargets: [0], column: 1 },
  ],
})

function mapOf(aligned: ReturnType<typeof alignMeasurements>): number[] {
  if (!aligned.ok) throw new Error(`alignment refused: ${aligned.code}`)
  return [...aligned.qubitOfClbit]
}

describe('reading which qubit each classical bit holds', () => {
  it('reads a straight-through circuit as the identity', () => {
    expect(mapOf(alignMeasurements(straight, 2))).toEqual([0, 1])
  })

  it('reads a crossed circuit as crossed', () => {
    // c[0] holds qubit 1, c[1] holds qubit 0. This is the fact the whole
    // module exists for, and the one a Bell pair hides.
    expect(mapOf(alignMeasurements(crossed, 2))).toEqual([1, 0])
  })

  it('reads a document whose gates are packaged in a subcircuit', () => {
    // The circuit is read expanded, the same reading `gateCount` and `depth`
    // take. Nothing here depends on a block containing a measurement — a custom
    // gate has no classical register of its own — but the expansion must not
    // lose the top-level measurements on the way past it.
    const packaged = circuit({
      qubits: 2,
      clbits: 2,
      customGates: {
        entangle: {
          qubits: 2,
          operations: [
            { id: 'inner_1', gate: 'h', targets: [0], column: 0 },
            {
              id: 'inner_2',
              gate: 'x',
              targets: [1],
              controls: [0],
              column: 1,
            },
          ],
        },
      },
      operations: [
        { id: 'op_1', gate: 'entangle', targets: [0, 1], column: 0 },
        {
          id: 'op_2',
          gate: 'measure',
          targets: [0],
          clbitTargets: [1],
          column: 1,
        },
        {
          id: 'op_3',
          gate: 'measure',
          targets: [1],
          clbitTargets: [0],
          column: 1,
        },
      ],
    })

    expect(mapOf(alignMeasurements(packaged, 2))).toEqual([1, 0])
  })

  it('takes the last measurement into a bit, which is what the bit holds', () => {
    const rewritten = circuit({
      qubits: 2,
      clbits: 2,
      operations: [
        {
          id: 'op_1',
          gate: 'measure',
          targets: [1],
          clbitTargets: [0],
          column: 0,
        },
        {
          id: 'op_2',
          gate: 'measure',
          targets: [0],
          clbitTargets: [0],
          column: 1,
        },
        {
          id: 'op_3',
          gate: 'measure',
          targets: [1],
          clbitTargets: [1],
          column: 2,
        },
      ],
    })

    expect(mapOf(alignMeasurements(rewritten, 2))).toEqual([0, 1])
  })
})

describe('refusing a join that would not be one', () => {
  it('refuses a circuit whose qubits are not all measured', () => {
    const partial = circuit({
      qubits: 3,
      clbits: 3,
      operations: [
        {
          id: 'op_1',
          gate: 'measure',
          targets: [0],
          clbitTargets: [0],
          column: 0,
        },
        {
          id: 'op_2',
          gate: 'measure',
          targets: [1],
          clbitTargets: [1],
          column: 0,
        },
        {
          id: 'op_3',
          gate: 'measure',
          targets: [1],
          clbitTargets: [2],
          column: 1,
        },
      ],
    })

    // Qubit 2 never reaches the register, so the device reports a marginal of
    // the state the chart draws rather than a relabelling of it.
    expect(alignMeasurements(partial, 3)).toEqual({
      ok: false,
      code: 'repeated-qubit',
    })
  })

  it('names an unmeasured qubit when every bit is written', () => {
    const marginal = circuit({
      qubits: 3,
      clbits: 2,
      operations: [
        {
          id: 'op_1',
          gate: 'measure',
          targets: [0],
          clbitTargets: [0],
          column: 0,
        },
        {
          id: 'op_2',
          gate: 'measure',
          targets: [1],
          clbitTargets: [1],
          column: 0,
        },
      ],
    })

    expect(alignMeasurements(marginal, 2)).toEqual({
      ok: false,
      code: 'unmeasured-qubit',
    })
  })

  it('refuses a register with a bit nothing writes', () => {
    const sparse = circuit({
      qubits: 2,
      clbits: 3,
      operations: [
        {
          id: 'op_1',
          gate: 'measure',
          targets: [0],
          clbitTargets: [0],
          column: 0,
        },
        {
          id: 'op_2',
          gate: 'measure',
          targets: [1],
          clbitTargets: [1],
          column: 0,
        },
      ],
    })

    expect(alignMeasurements(sparse, 3)).toEqual({
      ok: false,
      code: 'unwritten-clbit',
    })
  })
})

describe('a device bitstring as a basis-state index', () => {
  /*
   * `basisIndexOf` composes three orderings that all look alike and are not:
   * the key is written highest classical bit first, a classical bit holds some
   * qubit, and bit `q` of a statevector index is qubit `q`. Each case below
   * would pass under at least one wrong composition and fail under the others.
   */

  it('reads the identity mapping the way formatKet writes a label', () => {
    const identity = [0, 1]

    // "10" is c[1] = 1, c[0] = 0 — qubit 1 set, qubit 0 clear — index 2.
    expect(basisIndexOf('10', identity)).toBe(2)
    expect(basisIndexOf('01', identity)).toBe(1)
    expect(basisIndexOf('00', identity)).toBe(0)
    expect(basisIndexOf('11', identity)).toBe(3)
  })

  it('undoes a crossing the document wrote', () => {
    const swapped = mapOf(alignMeasurements(crossed, 2))

    // The circuit sets qubit 0, and the crossing puts that in c[1], so the
    // device answers "10". On the chart it is qubit 0 — index 1, |01⟩.
    expect(basisIndexOf('10', swapped)).toBe(1)
    // And the mirror: a device "01" is qubit 1 set, index 2.
    expect(basisIndexOf('01', swapped)).toBe(2)
  })

  it('reads three bits without confusing the ends', () => {
    // Deliberately not a permutation of itself under reversal.
    const map = [2, 0, 1]

    // "100": c[2] = 1 → qubit 1 → index 2.
    expect(basisIndexOf('100', map)).toBe(2)
    // "010": c[1] = 1 → qubit 0 → index 1.
    expect(basisIndexOf('010', map)).toBe(1)
    // "001": c[0] = 1 → qubit 2 → index 4.
    expect(basisIndexOf('001', map)).toBe(4)
  })

  it('refuses a key of the wrong width instead of padding it', () => {
    // A short key means the counts came from a different job, and every row
    // drawn from then on would be wrong while looking perfectly plausible.
    expect(() => basisIndexOf('1', [0, 1])).toThrow(RangeError)
    expect(() => basisIndexOf('111', [0, 1])).toThrow(RangeError)
  })

  it('refuses a key that is not a bitstring', () => {
    expect(() => basisIndexOf('0x', [0, 1])).toThrow(RangeError)
  })
})

describe('device counts as a distribution', () => {
  it('divides by the counts it was given, not by a requested shot count', () => {
    const distribution = distributionFromCounts(
      { '01': 30, '10': 10 },
      2,
      [0, 1]
    )

    // 40 shots came back. A denominator of 1024 would give a distribution
    // summing to 0.04, which the fidelity refuses outright — turning a short
    // run into an empty panel.
    expect(distribution[1]).toBeCloseTo(0.75, 12)
    expect(distribution[2]).toBeCloseTo(0.25, 12)
    expect(
      [...distribution].reduce((sum, share) => sum + share, 0)
    ).toBeCloseTo(1, 12)
  })

  it('puts a crossed circuit s counts on the states the chart draws', () => {
    const swapped = mapOf(alignMeasurements(crossed, 2))
    const distribution = distributionFromCounts({ '10': 100 }, 2, swapped)

    // Everything at |01⟩ — qubit 0 set — and nothing at |10⟩. Under the
    // identity map this would be the other way round, which is a chart that
    // looks fine and describes the wrong outcome.
    expect(distribution[1]).toBe(1)
    expect(distribution[2]).toBe(0)
  })

  it('answers with zeros for a job that returned nothing', () => {
    const distribution = distributionFromCounts({}, 2, [0, 1])

    expect([...distribution]).toEqual([0, 0, 0, 0])
  })

  it('adds two keys that land on one state rather than replacing', () => {
    // Not reachable from one register width, but reachable from a hand-written
    // record — and a `=` where a `+=` belongs loses shots silently.
    const distribution = distributionFromCounts({ '00': 1, '11': 3 }, 2, [0, 1])

    expect(distribution[0]).toBeCloseTo(0.25, 12)
    expect(distribution[3]).toBeCloseTo(0.75, 12)
  })
})
