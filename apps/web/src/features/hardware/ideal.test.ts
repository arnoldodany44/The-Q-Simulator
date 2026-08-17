/**
 * The circuit the ideal column simulates, and the two shapes it must refuse.
 *
 * Dropping a measurement is safe when it is the last thing on its wire and is a
 * fabrication when it is not — the deleted collapse leaves a superposition the
 * real run did not have, and the resulting "ideal" column would differ from the
 * device's answer by something that looks exactly like hardware error.
 */

import { run } from '@qsim/core'
import { CIRCUIT_SCHEMA_VERSION, parseCircuit } from '@qsim/schema'
import type { CircuitInput } from '@qsim/schema'
import { describe, expect, it } from 'vitest'

import { idealCircuitOf } from './ideal'

function circuit(input: Omit<CircuitInput, 'schemaVersion'>) {
  return parseCircuit({ schemaVersion: CIRCUIT_SCHEMA_VERSION, ...input })
}

describe('the circuit the ideal column runs', () => {
  it('drops terminal measurements and keeps everything else', () => {
    const measured = circuit({
      qubits: 2,
      clbits: 2,
      operations: [
        { id: 'op_1', gate: 'h', targets: [0], column: 0 },
        { id: 'op_2', gate: 'x', targets: [1], controls: [0], column: 1 },
        {
          id: 'op_3',
          gate: 'measure',
          targets: [0],
          clbitTargets: [0],
          column: 2,
        },
        {
          id: 'op_4',
          gate: 'measure',
          targets: [1],
          clbitTargets: [1],
          column: 2,
        },
      ],
    })

    const ideal = idealCircuitOf(measured)

    expect(ideal.ok).toBe(true)
    if (!ideal.ok) return
    expect(ideal.circuit.operations.map((operation) => operation.gate)).toEqual(
      ['h', 'x']
    )
    // The register is kept: it is what the device's counts are keyed by, and a
    // circuit that lost it would disagree with the job about its own width.
    expect(ideal.circuit.clbits).toBe(2)
  })

  /**
   * The definition has to be per wire and by column. A document whose
   * measurements are staggered — qubit 0 read in column 2 while qubit 1 is
   * still being worked on — has two terminal measurements, and a test of "is it
   * the last operation in the document" would call the first one mid-circuit.
   */
  it('calls a staggered measurement terminal when its own wire is done', () => {
    const staggered = circuit({
      qubits: 2,
      clbits: 2,
      operations: [
        { id: 'op_1', gate: 'h', targets: [0], column: 0 },
        {
          id: 'op_2',
          gate: 'measure',
          targets: [0],
          clbitTargets: [0],
          column: 1,
        },
        { id: 'op_3', gate: 'x', targets: [1], column: 2 },
        {
          id: 'op_4',
          gate: 'measure',
          targets: [1],
          clbitTargets: [1],
          column: 3,
        },
      ],
    })

    expect(idealCircuitOf(staggered).ok).toBe(true)
  })

  it('refuses a measurement with work after it on the same wire', () => {
    const midCircuit = circuit({
      qubits: 2,
      clbits: 2,
      operations: [
        { id: 'op_1', gate: 'h', targets: [0], column: 0 },
        {
          id: 'op_2',
          gate: 'measure',
          targets: [0],
          clbitTargets: [0],
          column: 1,
        },
        { id: 'op_3', gate: 'x', targets: [0], column: 2 },
        {
          id: 'op_4',
          gate: 'measure',
          targets: [1],
          clbitTargets: [1],
          column: 3,
        },
      ],
    })

    expect(idealCircuitOf(midCircuit)).toEqual({
      ok: false,
      code: 'mid-circuit-measurement',
    })
  })

  it('counts a control as work on the wire it controls from', () => {
    // Qubit 0 is measured and then used as a control. Nobody's target, and
    // still very much in use — a reader of `targets` alone would miss it.
    const controlAfter = circuit({
      qubits: 2,
      clbits: 2,
      operations: [
        {
          id: 'op_1',
          gate: 'measure',
          targets: [0],
          clbitTargets: [0],
          column: 0,
        },
        { id: 'op_2', gate: 'x', targets: [1], controls: [0], column: 1 },
        {
          id: 'op_3',
          gate: 'measure',
          targets: [1],
          clbitTargets: [1],
          column: 2,
        },
      ],
    })

    expect(idealCircuitOf(controlAfter)).toEqual({
      ok: false,
      code: 'mid-circuit-measurement',
    })
  })

  it('refuses a conditioned circuit, which has no single unitary', () => {
    const teleportish = circuit({
      qubits: 2,
      clbits: 2,
      operations: [
        { id: 'op_1', gate: 'h', targets: [0], column: 0 },
        {
          id: 'op_2',
          gate: 'measure',
          targets: [0],
          clbitTargets: [0],
          column: 1,
        },
        {
          id: 'op_3',
          gate: 'x',
          targets: [1],
          column: 2,
          condition: { clbit: 0, equals: 1 },
        },
        {
          id: 'op_4',
          gate: 'measure',
          targets: [1],
          clbitTargets: [1],
          column: 3,
        },
      ],
    })

    expect(idealCircuitOf(teleportish)).toEqual({
      ok: false,
      code: 'conditioned',
    })
  })

  it('leaves a barrier out of the reckoning', () => {
    // A barrier is an instruction to an optimiser, not work on a wire, so a
    // measurement followed by one is still terminal.
    const barriered = circuit({
      qubits: 1,
      clbits: 1,
      operations: [
        { id: 'op_1', gate: 'h', targets: [0], column: 0 },
        {
          id: 'op_2',
          gate: 'measure',
          targets: [0],
          clbitTargets: [0],
          column: 1,
        },
        { id: 'op_3', gate: 'barrier', targets: [0], column: 2 },
      ],
    })

    expect(idealCircuitOf(barriered).ok).toBe(true)
  })

  it('produces something the engine will actually run', () => {
    // The point of the whole module: analytic mode refuses a circuit that
    // measures, and this is what makes the ideal column possible at all.
    const measured = circuit({
      qubits: 2,
      clbits: 2,
      operations: [
        { id: 'op_1', gate: 'h', targets: [0], column: 0 },
        { id: 'op_2', gate: 'x', targets: [1], controls: [0], column: 1 },
        {
          id: 'op_3',
          gate: 'measure',
          targets: [0],
          clbitTargets: [0],
          column: 2,
        },
        {
          id: 'op_4',
          gate: 'measure',
          targets: [1],
          clbitTargets: [1],
          column: 2,
        },
      ],
    })

    const ideal = idealCircuitOf(measured)
    expect(ideal.ok).toBe(true)
    if (!ideal.ok) return

    const result = run(ideal.circuit)
    expect(result.mode).toBe('analytic')
  })
})
