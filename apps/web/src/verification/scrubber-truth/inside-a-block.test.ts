/**
 * A packaged fragment can be stepped through, gate by gate.
 *
 * §3.1 decision 2 rejects executing a definition recursively, and the reason it
 * gives is this exact scrubber: "o el scrubber no puede detenerse dentro de él
 * —y una teleportación empaquetada se vuelve un salto ilegible, justo la
 * lección que la función existe para mostrar— o la caché necesita una segunda
 * coordenada". Expansion is what buys the way out of that dilemma, and the
 * timeline is where the purchase is either collected or thrown away: counting
 * the *source* document's columns gave a five-gate block two stops where the
 * same five gates placed by hand gave six, so four teaching moments existed in
 * the engine and were unreachable from the interface.
 *
 * The test drives the real seam — `runJob`, the function the worker calls — at
 * every stop `timeline.ts` offers, and compares the two documents state by
 * state. They are the same circuit, so they must be the same walk.
 */

import { createCheckpoints } from '@qsim/core'
import { CIRCUIT_SCHEMA_VERSION, depth, type Circuit } from '@qsim/schema'
import { describe, expect, it } from 'vitest'

import {
  positionAt,
  stopCount,
  timelineLength,
} from '../../features/circuit-editor/timeline'
import { runJob } from '../../features/simulation/job'
import { decodeState } from '../../features/simulation/protocol'
import type { SimulateRequest } from '../../features/simulation/protocol'

/** Five gates, placed by hand — the shape a teleportation lesson has. */
const BY_HAND: Circuit = {
  schemaVersion: CIRCUIT_SCHEMA_VERSION,
  qubits: 2,
  clbits: 0,
  operations: [
    { id: 'op_1', gate: 'h', targets: [0], column: 0 },
    { id: 'op_2', gate: 'cx', targets: [1], controls: [0], column: 1 },
    { id: 'op_3', gate: 't', targets: [1], column: 2 },
    { id: 'op_4', gate: 'h', targets: [1], column: 3 },
    { id: 'op_5', gate: 'z', targets: [0], column: 4 },
  ],
}

/** The same five gates, packaged. */
const PACKAGED: Circuit = {
  schemaVersion: CIRCUIT_SCHEMA_VERSION,
  qubits: 2,
  clbits: 0,
  operations: [{ id: 'op_1', gate: 'tele', targets: [0, 1], column: 0 }],
  customGates: {
    tele: {
      qubits: 2,
      operations: [
        { id: 'b1', gate: 'h', targets: [0], column: 0 },
        { id: 'b2', gate: 'cx', targets: [1], controls: [0], column: 1 },
        { id: 'b3', gate: 't', targets: [1], column: 2 },
        { id: 'b4', gate: 'h', targets: [1], column: 3 },
        { id: 'b5', gate: 'z', targets: [0], column: 4 },
      ],
    },
  },
}

function walk(circuit: Circuit): number[][] {
  const columns = timelineLength(circuit)
  const states: number[][] = []
  for (let stop = 0; stop < stopCount(columns); stop++) {
    const request: SimulateRequest = {
      kind: 'simulate',
      id: stop + 1,
      circuit,
      fromColumn: 0,
      mode: 'analytic',
      sample: null,
      noise: null,
      sharedMemory: false,
      throughColumn: positionAt(stop, columns),
    }
    const { response } = runJob(createCheckpoints(), request, false)
    if (response.kind !== 'result' || response.mode !== 'analytic') {
      throw new Error('the analytic run did not answer analytically')
    }
    const state = decodeState(response.state)
    states.push(
      [...state.re].map((re, index) => {
        const im = state.im[index] ?? 0
        return re * re + im * im
      })
    )
  }
  return states
}

describe('stepping through a packaged fragment', () => {
  it('offers one stop per instant the engine actually takes', () => {
    expect(timelineLength(PACKAGED)).toBe(timelineLength(BY_HAND))
    expect(stopCount(timelineLength(PACKAGED))).toBe(6)
    // The engine's own count of instants, from the contract's own helper.
    expect(depth(PACKAGED)).toBe(depth(BY_HAND))
  })

  it('shows the same states at the same stops as the gates placed by hand', () => {
    const packaged = walk(PACKAGED)
    const byHand = walk(BY_HAND)
    expect(packaged).toHaveLength(6)
    for (const [index, probabilities] of packaged.entries()) {
      for (const [basis, value] of probabilities.entries()) {
        expect(value).toBeCloseTo((byHand[index] as number[])[basis] ?? 0, 10)
      }
    }
  })

  it('does not jump from the ground state straight to the answer', () => {
    // The failure this file exists against: two stops, and the four states in
    // between reachable only by taking the block apart.
    const states = walk(PACKAGED)
    const first = states[0] as number[]
    const second = states[1] as number[]
    expect(first[0]).toBeCloseTo(1, 10)
    // After the H alone: |00> and |10> at a half each, which is a state the
    // packaged document could not previously be stopped at.
    expect(second[0]).toBeCloseTo(0.5, 10)
    expect(second[1]).toBeCloseTo(0.5, 10)
  })
})
