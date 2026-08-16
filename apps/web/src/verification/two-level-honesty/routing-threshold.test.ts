// @vitest-environment node
/**
 * §4, read as an executable claim: the browser runs everything it can, and only
 * what it cannot goes over the network.
 *
 * Two directions, both driven rather than read:
 *
 *   1. Ordinary editing never enqueues. Every register the browser can hold,
 *      every mode, every scrub step — zero bytes to the API.
 *   2. A register past the ceiling reaches the server rather than freezing the
 *      tab.
 *
 * The other half of the threshold — that `@qsim/jobs` believes the browser
 * stops in the same place — cannot be asserted from here, because §12.3 forbids
 * a package importing an app and this app may not import `@qsim/jobs`. It is
 * pinned by literal on both sides instead: `protocol.test.ts` says
 * `MAX_CLIENT_QUBITS` is 20, and `apps/api/src/routes/simulate.schemas.test.ts`
 * says `CLIENT_STATEVECTOR_QUBITS` is 20 and `clientCeilingsAgree(20, 12)`.
 */

import { MAX_DENSITY_QUBITS, MAX_QUBITS } from '@qsim/core'
import { parseCircuit, type Circuit } from '@qsim/schema'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import {
  MAX_CLIENT_QUBITS,
  MAX_DENSITY_CLIENT_QUBITS,
  type ServerRequest,
  type SimulationRequest,
} from '../../features/simulation/protocol'
import {
  SIMULATION_DEBOUNCE_MS,
  createSimulationScheduler,
  type SimulationScheduler,
} from '../../features/simulation/scheduler'

function withQubits(qubits: number, columns: readonly number[] = []): Circuit {
  return parseCircuit({
    schemaVersion: 1,
    qubits,
    operations: columns.map((column) => ({
      id: `g${String(column)}`,
      gate: 'h',
      targets: [0],
      column,
    })),
  })
}

let toWorker: SimulationRequest[]
let toServer: ServerRequest[]
let scheduler: SimulationScheduler

beforeEach(() => {
  vi.useFakeTimers()
  toWorker = []
  toServer = []
  scheduler = createSimulationScheduler()
  scheduler.connect((request) => toWorker.push(request))
  scheduler.connectServer((request) => toServer.push(request))
})

afterEach(() => {
  scheduler.dispose()
  vi.useRealTimers()
})

function simulateCount(posts: readonly SimulationRequest[]): number {
  return posts.filter((request) => request.kind === 'simulate').length
}

function serverSubmits(posts: readonly ServerRequest[]): ServerRequest[] {
  return posts.filter((request) => request.kind === 'server-simulate')
}

describe('the threshold is the engine constant, not a second opinion', () => {
  it('can only ever be stricter than the engine, never looser', () => {
    expect(MAX_CLIENT_QUBITS).toBeLessThanOrEqual(MAX_QUBITS)
    expect(MAX_DENSITY_CLIENT_QUBITS).toBeLessThanOrEqual(MAX_DENSITY_QUBITS)
  })
})

describe('ordinary editing never enqueues', () => {
  it('sends nothing to the server for every register up to the ceiling', () => {
    for (let qubits = 1; qubits <= MAX_CLIENT_QUBITS; qubits++) {
      scheduler.schedule(withQubits(qubits, [0]))
      vi.advanceTimersByTime(SIMULATION_DEBOUNCE_MS)
    }
    expect(serverSubmits(toServer)).toHaveLength(0)
    expect(simulateCount(toWorker)).toBe(MAX_CLIENT_QUBITS)
  })

  it('sends nothing to the server across a long editing session', () => {
    // A hundred edits at the ceiling: adding a gate, moving the scrubber,
    // switching modes, turning sampling on. None of it may cost a queued job.
    const columns: number[] = []
    for (let step = 0; step < 100; step++) {
      columns.push(step % 40)
      scheduler.schedule(withQubits(MAX_CLIENT_QUBITS, [...new Set(columns)]), {
        mode: step % 7 === 0 ? 'trajectories' : 'analytic',
        sample: step % 3 === 0,
        shots: 1024,
        throughColumn: step % 5 === 0 ? null : (step % 5) - 1,
      })
      vi.advanceTimersByTime(SIMULATION_DEBOUNCE_MS)
    }
    expect(serverSubmits(toServer)).toHaveLength(0)
  })
})

describe('past the ceiling it reaches the server rather than freezing', () => {
  it('dispatches to the server and never to the worker', () => {
    scheduler.schedule(withQubits(MAX_CLIENT_QUBITS + 1, [0]))
    vi.advanceTimersByTime(SIMULATION_DEBOUNCE_MS)
    expect(serverSubmits(toServer)).toHaveLength(1)
    expect(simulateCount(toWorker)).toBe(0)
  })

  it('reports the server run in the snapshot the same frame it leaves', () => {
    scheduler.schedule(withQubits(MAX_CLIENT_QUBITS + 1, [0]))
    vi.advanceTimersByTime(SIMULATION_DEBOUNCE_MS)
    const snapshot = scheduler.getSnapshot()
    expect(snapshot.status).toBe('running')
    expect(snapshot.serverRun?.stage).toBe('submitting')
  })

  it('still refuses honestly when there is nowhere to send it', () => {
    scheduler.connectServer(null)
    scheduler.schedule(withQubits(MAX_CLIENT_QUBITS + 1, [0]))
    vi.advanceTimersByTime(SIMULATION_DEBOUNCE_MS)
    expect(scheduler.getSnapshot().failure?.code).toBe('too-many-qubits')
    expect(simulateCount(toWorker)).toBe(0)
  })
})
