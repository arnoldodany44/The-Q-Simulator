import { parseCircuit, type CircuitInput } from '@qsim/schema'
import { describe, expect, it } from 'vitest'

import { executionModeFor, needsTrajectories } from './mode'

/**
 * The question this asks has one right answer and it is the engine's, so
 * every case below is stated as "would `run()` in analytic mode have thrown?".
 * Getting it wrong in one direction shows the reader an error instead of an
 * answer; in the other it replaces an exact distribution with a shot tally,
 * which is worse — it looks like a working panel and is a downgrade nobody
 * asked for.
 */

function circuit(input: CircuitInput) {
  return parseCircuit(input)
}

describe('needsTrajectories', () => {
  it('is false for a unitary circuit', () => {
    expect(
      needsTrajectories(
        circuit({
          schemaVersion: 1,
          qubits: 2,
          operations: [
            { id: 'a', gate: 'h', targets: [0], column: 0 },
            { id: 'b', gate: 'cx', targets: [1], controls: [0], column: 1 },
          ],
        })
      )
    ).toBe(false)
  })

  it('is true for a circuit that measures', () => {
    expect(
      needsTrajectories(
        circuit({
          schemaVersion: 1,
          qubits: 1,
          clbits: 1,
          operations: [
            { id: 'a', gate: 'h', targets: [0], column: 0 },
            {
              id: 'b',
              gate: 'measure',
              targets: [0],
              clbitTargets: [0],
              column: 1,
            },
          ],
        })
      )
    ).toBe(true)
  })

  it('is true for a gate conditioned on a classical bit', () => {
    // Without a measurement anywhere: a condition alone is enough, because the
    // runner refuses one in analytic mode whether or not anything ever wrote
    // the bit it reads.
    expect(
      needsTrajectories(
        circuit({
          schemaVersion: 1,
          qubits: 1,
          clbits: 1,
          operations: [
            {
              id: 'a',
              gate: 'x',
              targets: [0],
              column: 0,
              condition: { clbit: 0, equals: 1 },
            },
          ],
        })
      )
    ).toBe(true)
  })

  it('is false for a reset, which the engine may still run analytically', () => {
    // Documented in `mode.ts`: whether a reset needs randomness depends on the
    // state at that column, not on the document. Sending every circuit with a
    // reset to a shot tally would throw away an exact answer the engine was
    // willing to give.
    expect(
      needsTrajectories(
        circuit({
          schemaVersion: 1,
          qubits: 1,
          operations: [{ id: 'a', gate: 'reset', targets: [0], column: 0 }],
        })
      )
    ).toBe(false)
  })

  it('is false for an empty circuit', () => {
    expect(
      needsTrajectories(
        circuit({ schemaVersion: 1, qubits: 1, operations: [] })
      )
    ).toBe(false)
  })
})

describe('executionModeFor', () => {
  it('names the mode the scheduler takes', () => {
    expect(
      executionModeFor(circuit({ schemaVersion: 1, qubits: 1, operations: [] }))
    ).toBe('analytic')
    expect(
      executionModeFor(
        circuit({
          schemaVersion: 1,
          qubits: 1,
          clbits: 1,
          operations: [
            {
              id: 'a',
              gate: 'measure',
              targets: [0],
              clbitTargets: [0],
              column: 0,
            },
          ],
        })
      )
    ).toBe('trajectories')
  })
})
