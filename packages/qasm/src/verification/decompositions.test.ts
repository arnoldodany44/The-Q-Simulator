import { run } from '@qsim/core'
import {
  CIRCUIT_SCHEMA_VERSION,
  type Circuit,
  type Operation,
} from '@qsim/schema'
import { describe, expect, it } from 'vitest'

import { toOpenQasm3 } from '../qasm3.js'

/**
 * A DECOMPOSITION IS AN EQUALITY, NOT A RESEMBLANCE.
 *
 * `iswap` is the one catalog gate with no name in `stdgates.inc`, so the
 * OpenQASM export writes it out as `S·S·H·CX·CX·H`. The brief for M1.7 says
 * such a gate must be decomposed and *said so*, "rather than silently
 * approximating" — and the sharp edge of that word is global phase.
 *
 * A decomposition equal to the gate up to a global phase is indistinguishable
 * from it in every measurement, so the agreement test next door would pass
 * with one. It stops being indistinguishable the moment somebody controls the
 * block, or interferes it against another path — at which point the phase is
 * relative and the circuit computes something else. So this file compares
 * amplitudes, real and imaginary part, on all four basis states: four columns
 * agreeing entry for entry is the two matrices being equal.
 *
 * The check runs against the emitted text's own sequence, asserted separately,
 * so a future edit to the emitter cannot leave this test proving a
 * decomposition the export no longer uses.
 */

const DECOMPOSITION = `s q[0];
s q[1];
h q[0];
cx q[0], q[1];
cx q[1], q[0];
h q[1];`

/** The steps above as operations, one per column, on qubits 0 and 1. */
const STEPS: readonly Operation[] = [
  { id: 'd_1', gate: 's', targets: [0], column: 10 },
  { id: 'd_2', gate: 's', targets: [1], column: 11 },
  { id: 'd_3', gate: 'h', targets: [0], column: 12 },
  { id: 'd_4', gate: 'cx', targets: [1], controls: [0], column: 13 },
  { id: 'd_5', gate: 'cx', targets: [0], controls: [1], column: 14 },
  { id: 'd_6', gate: 'h', targets: [1], column: 15 },
]

describe('the iswap decomposition', () => {
  it('is the sequence the exporter actually emits', () => {
    const program = toOpenQasm3({
      schemaVersion: CIRCUIT_SCHEMA_VERSION,
      qubits: 2,
      clbits: 0,
      operations: [{ id: 'op_1', gate: 'iswap', targets: [0, 1], column: 0 }],
    })
    expect(program).toContain(DECOMPOSITION)
  })

  it.each([
    ['|00>', []],
    ['|01>', [0]],
    ['|10>', [1]],
    ['|11>', [0, 1]],
  ])('equals iswap on %s, phase included', (_name, excited) => {
    const preparation: Operation[] = excited.map((qubit, index) => ({
      id: `prep_${qubit}`,
      gate: 'x',
      targets: [qubit],
      column: index,
    }))

    const direct = finalState({
      schemaVersion: CIRCUIT_SCHEMA_VERSION,
      qubits: 2,
      clbits: 0,
      operations: [
        ...preparation,
        { id: 'op_1', gate: 'iswap', targets: [0, 1], column: 9 },
      ],
    })
    const decomposed = finalState({
      schemaVersion: CIRCUIT_SCHEMA_VERSION,
      qubits: 2,
      clbits: 0,
      operations: [...preparation, ...STEPS],
    })

    for (let index = 0; index < 4; index++) {
      // 1e-12 is D6's tolerance for a comparison of two float paths, an order
      // of magnitude above the drift six gates can accumulate.
      expect(decomposed.re[index]!).toBeCloseTo(direct.re[index]!, 12)
      expect(decomposed.im[index]!).toBeCloseTo(direct.im[index]!, 12)
    }
  })
})

function finalState(circuit: Circuit): { re: Float64Array; im: Float64Array } {
  const result = run(circuit)
  if (result.mode !== 'analytic') throw new Error('expected an analytic run')
  return { re: result.state.re, im: result.state.im }
}
