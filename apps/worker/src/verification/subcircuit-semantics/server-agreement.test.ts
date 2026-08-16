/**
 * The authoritative run and the browser's run agree about a block — §4's
 * two-level principle, applied to §3.1's subcircuits.
 *
 * The whole point of the server is that its answer can be trusted where the
 * browser's cannot (challenge validation, §4). That only holds if the two
 * agree, and a custom gate is the one construct where they could quietly stop
 * agreeing: the browser expands in `apps/web`'s worker seam and the server
 * expands in `acceptCircuit` here, so a divergence would surface as "solved
 * locally, failed remotely" with nothing to debug.
 *
 * The second test is the §11 half. The cycle check proves the definition graph
 * terminates and says nothing about its size, so twenty definitions where each
 * uses the previous one twice are two kilobytes of JSON and a million
 * operations of circuit. That has to be refused by the contract — a 400 — and
 * not by whatever runs out of memory first.
 */
import { analyticMode, run } from '@qsim/core'
import { expandCircuit, parseCircuit, type Circuit } from '@qsim/schema'
import { describe, expect, it } from 'vitest'

import { runSimulationJob } from '../../simulate.js'

const CEILINGS = { maxQubits: 24, timeoutMs: 30_000 }

/** Two uses of a two-level block, at different offsets and different angles. */
const PACKAGED = {
  schemaVersion: 1,
  qubits: 3,
  parameters: [{ name: 'alpha', value: 0.9 }],
  operations: [
    { id: 'op_1', gate: 'blk', targets: [2, 0], params: ['alpha'], column: 0 },
    { id: 'op_2', gate: 'blk', targets: [1, 2], params: [0.4], column: 1 },
  ],
  customGates: {
    leaf: {
      qubits: 2,
      params: ['w'],
      operations: [
        { id: 'l1', gate: 'h', targets: [0], column: 0 },
        {
          id: 'l2',
          gate: 'crz',
          targets: [1],
          controls: [0],
          params: ['w'],
          column: 1,
        },
      ],
    },
    blk: {
      qubits: 2,
      params: ['v'],
      // `[1, 0]`: the nested use reverses the wires, so a frame that composed
      // the two maps in the wrong order would produce a plausible wrong state.
      operations: [
        { id: 'b1', gate: 'leaf', targets: [1, 0], params: ['v'], column: 0 },
        { id: 'b2', gate: 't', targets: [0], column: 1 },
      ],
    },
  },
}

function browserProbabilities(circuit: Circuit): number[] {
  const result = run(expandCircuit(circuit).circuit, analyticMode())
  if (result.mode !== 'analytic') throw new Error('expected an analytic run')
  const out: number[] = []
  for (let index = 0; index < result.state.size; index++) {
    const re = result.state.re[index] ?? 0
    const im = result.state.im[index] ?? 0
    out.push(re ** 2 + im ** 2)
  }
  return out
}

describe('a server run of a nested block', () => {
  it('reports the distribution the browser computes', () => {
    const circuit = parseCircuit(PACKAGED)
    const server = runSimulationJob(
      {
        runId: 'verification',
        circuit,
        mode: 'STATEVECTOR',
        shots: null,
        seed: 7,
        noiseProfileId: null,
        readout: false,
        submittedBy: null,
        circuitId: null,
      },
      () => undefined,
      CEILINGS
    )

    const browser = browserProbabilities(circuit)
    const byServer = new Map(
      server.outcomes.map((outcome) => [outcome.state, outcome.probability])
    )
    for (let index = 0; index < browser.length; index++) {
      // The result table labels a state highest-qubit-first, the way
      // `formatKet` and Qiskit both print it (D1).
      const label = index.toString(2).padStart(circuit.qubits, '0')
      const reported = byServer.get(label) ?? 0
      expect(Math.abs(reported - (browser[index] as number))).toBeLessThan(
        1e-10
      )
    }
    expect(server.hiddenOutcomes).toBe(0)
  })

  it('refuses a definition graph that doubles past the ceiling', () => {
    const definitions: Record<string, unknown> = {
      g0: {
        qubits: 1,
        operations: [{ id: 'a', gate: 'h', targets: [0], column: 0 }],
      },
    }
    for (let level = 1; level <= 20; level++) {
      definitions[`g${level}`] = {
        qubits: 1,
        operations: [
          { id: 'l', gate: `g${level - 1}`, targets: [0], column: 0 },
          { id: 'r', gate: `g${level - 1}`, targets: [0], column: 1 },
        ],
      }
    }
    expect(() =>
      parseCircuit({
        schemaVersion: 1,
        qubits: 1,
        operations: [{ id: 'op_1', gate: 'g20', targets: [0], column: 0 }],
        customGates: definitions,
      })
    ).toThrow(/more than 16384 operations/)
  })
})
