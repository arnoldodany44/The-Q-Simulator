/**
 * `finalClassicalRegister` — which qubit each classical bit holds when the
 * emitted program ends.
 *
 * The interesting cases all turn on one word: **later**. In the contract's
 * model of time that means a larger `column`, which is what `orderedOperations`
 * sorts by and what any reader of the emitted program will execute. A document
 * is free to store its operations in any array order at all, so the two
 * readings can disagree — and when they do, the register the device sends home
 * is the program's, never the array's.
 */

import { describe, expect, it } from 'vitest'
import type { Operation } from '@qsim/schema'

import { finalClassicalRegister } from './program.js'
import { toOpenQasm3 } from './qasm3.js'

function measure(
  id: string,
  qubit: number,
  clbit: number,
  column: number
): Operation {
  return {
    id,
    gate: 'measure',
    targets: [qubit],
    clbitTargets: [clbit],
    column,
  }
}

describe('finalClassicalRegister', () => {
  it('maps each bit to the qubit its only measurement wrote', () => {
    const operations = [measure('m0', 0, 0, 1), measure('m1', 1, 1, 1)]
    expect(finalClassicalRegister(operations, 2)).toEqual([0, 1])
  })

  it('honours the crossing the document wrote', () => {
    // `c[1] = measure q[0]` is an ordinary line — the editor writes it whenever
    // a measurement is dragged to a bit that is not the wire's own number.
    const operations = [measure('m0', 0, 1, 1), measure('m1', 1, 0, 1)]
    expect(finalClassicalRegister(operations, 2)).toEqual([1, 0])
  })

  it('leaves a bit no measurement writes undefined', () => {
    expect(finalClassicalRegister([measure('m0', 0, 0, 1)], 2)).toEqual([
      0,
      undefined,
    ])
  })

  it('lets the later COLUMN win, not the later array position', () => {
    /*
     * THE REPORTED DEFECT, in its smallest form. Both measurements write `c0`;
     * the one at column 3 is the one the program runs last, so `c0` holds q0.
     * A walk over the array in the order given would answer q1.
     */
    const operations = [measure('late', 0, 0, 3), measure('early', 1, 0, 1)]
    expect(finalClassicalRegister(operations, 1)).toEqual([0])
  })

  it('agrees with the program @qsim/qasm actually emits', () => {
    /*
     * The property that matters, checked against the text rather than against
     * another copy of the rule: the last `c[k] = measure q[j];` line in the
     * emitted program is the one this function reports for bit `k`.
     */
    const circuit = {
      schemaVersion: 1 as const,
      qubits: 2,
      clbits: 2,
      operations: [
        { id: 'x', gate: 'x', targets: [0], column: 0 },
        measure('a', 0, 0, 3),
        measure('b', 1, 0, 1),
        measure('c', 1, 1, 3),
        measure('d', 0, 1, 1),
      ] as Operation[],
    }

    const qasm = toOpenQasm3(circuit)
    const written = new Map<number, number>()
    for (const line of qasm.split('\n')) {
      const match = /^c\[(\d+)]\s*=\s*measure\s+q\[(\d+)];/.exec(line.trim())
      if (match === null) continue
      written.set(Number(match[1]), Number(match[2]))
    }

    const register = finalClassicalRegister(circuit.operations, 2)
    expect([...register]).toEqual([written.get(0), written.get(1)])
    // And, concretely: the column-3 pair is what survives.
    expect([...register]).toEqual([0, 1])
  })
})
