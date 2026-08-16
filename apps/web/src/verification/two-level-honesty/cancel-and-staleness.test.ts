// @vitest-environment node
/**
 * The two halves of §4 that only show up when the pieces are composed: the real
 * scheduler driving the real server backend, with only the network faked.
 *
 * What is asserted here is not "does a unit work" — `scheduler.test.ts` and
 * `serverRun.test.ts` already answer that — but what the *pair* does at the
 * three moments where a two-level system can quietly lie to its reader:
 * supersession, cancellation, and a worker-level failure that arrives while the
 * answer is somewhere else entirely.
 */

import { parseCircuit, type Circuit } from '@qsim/schema'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { SimulationRun } from '@qsim/contract'

import { MAX_CLIENT_QUBITS } from '../../features/simulation/protocol'
import { createServerBackend } from '../../features/simulation/serverRun'
import {
  SIMULATION_DEBOUNCE_MS,
  createSimulationScheduler,
  type SimulationScheduler,
} from '../../features/simulation/scheduler'

function beyondCeiling(columns: readonly number[]): Circuit {
  return parseCircuit({
    schemaVersion: 1,
    qubits: MAX_CLIENT_QUBITS + 1,
    operations: columns.map((column) => ({
      id: `g${String(column)}`,
      gate: 'h',
      targets: [0],
      column,
    })),
  })
}

function runRow(id: string, status: SimulationRun['status']): SimulationRun {
  return {
    id,
    status,
    mode: 'STATEVECTOR',
    shots: null,
    circuitId: null,
    result: null,
    error: null,
    durationMs: null,
    createdAt: new Date('2026-08-16T00:00:00.000Z'),
    estimatedDurationMs: 5_000,
    progress: null,
  } satisfies SimulationRun
}

interface Harness {
  readonly scheduler: SimulationScheduler
  readonly submissions: string[]
  readonly reads: string[]
  readonly dispose: () => void
  /** Run ids the fake API considers finished. */
  readonly finish: (runId: string) => void
}

let harness: Harness
let nextRunId: number

function createHarness(): Harness {
  const submissions: string[] = []
  const reads: string[] = []
  const finished = new Set<string>()
  const scheduler = createSimulationScheduler()

  const backend = createServerBackend({
    submit: () => {
      nextRunId += 1
      const id = `run_${String(nextRunId)}`
      submissions.push(id)
      return Promise.resolve(runRow(id, 'QUEUED'))
    },
    fetchRun: (runId) => {
      reads.push(runId)
      return Promise.resolve(
        runRow(runId, finished.has(runId) ? 'DONE' : 'RUNNING')
      )
    },
    socket: null,
    deliver: (response) => {
      scheduler.receive(response)
    },
    fail: (id, failure) => {
      scheduler.receive({ kind: 'error', id, failure })
    },
    report: (update) => {
      scheduler.report(update)
    },
  })
  scheduler.connectServer(backend.dispatch)
  scheduler.connect(() => undefined)

  return {
    scheduler,
    submissions,
    reads,
    finish: (runId) => finished.add(runId),
    dispose: () => {
      backend.dispose()
      scheduler.dispose()
    },
  }
}

beforeEach(() => {
  vi.useFakeTimers()
  nextRunId = 0
  harness = createHarness()
})

afterEach(() => {
  harness.dispose()
  vi.useRealTimers()
})

/** Dispatches, and lets the submission promise settle. */
async function dispatch(circuit: Circuit): Promise<void> {
  harness.scheduler.schedule(circuit)
  await vi.advanceTimersByTimeAsync(SIMULATION_DEBOUNCE_MS)
  await vi.advanceTimersByTimeAsync(0)
}

describe('supersession', () => {
  it('never delivers the answer to a superseded server run', async () => {
    await dispatch(beyondCeiling([0]))
    expect(harness.submissions).toEqual(['run_1'])

    await dispatch(beyondCeiling([0, 1]))
    expect(harness.submissions).toEqual(['run_1', 'run_2'])

    // The first run finishes. Nothing about it may reach the panel.
    harness.finish('run_1')
    await vi.advanceTimersByTimeAsync(20_000)
    expect(harness.scheduler.getSnapshot().outcome).toBeNull()

    harness.finish('run_2')
    await vi.advanceTimersByTimeAsync(20_000)
    const outcome = harness.scheduler.getSnapshot().outcome
    expect(outcome?.mode).toBe('server')
    expect(outcome?.mode === 'server' ? outcome.run.id : null).toBe('run_2')
  })

  it('discards a server answer superseded by a run this tab took back', async () => {
    await dispatch(beyondCeiling([0]))
    expect(harness.submissions).toEqual(['run_1'])

    // Back under the ceiling: the next run belongs to the worker, and the
    // worker in this harness never answers. Nothing from the server may land.
    harness.scheduler.schedule(
      parseCircuit({
        schemaVersion: 1,
        qubits: MAX_CLIENT_QUBITS,
        operations: [],
      })
    )
    await vi.advanceTimersByTimeAsync(SIMULATION_DEBOUNCE_MS)

    harness.finish('run_1')
    await vi.advanceTimersByTimeAsync(30_000)
    expect(harness.scheduler.getSnapshot().outcome).toBeNull()
    expect(harness.scheduler.getSnapshot().serverRun).toBeNull()
  })

  it('stops reading the superseded run entirely', async () => {
    await dispatch(beyondCeiling([0]))
    await dispatch(beyondCeiling([0, 1]))
    harness.reads.length = 0
    await vi.advanceTimersByTimeAsync(30_000)
    expect(harness.reads).not.toContain('run_1')
    expect(harness.reads).toContain('run_2')
  })
})

describe('cancellation', () => {
  it('stops the page reading the run, which is all it claims to do', async () => {
    await dispatch(beyondCeiling([0]))
    harness.scheduler.cancel()
    harness.reads.length = 0
    await vi.advanceTimersByTimeAsync(60_000)
    expect(harness.reads).toEqual([])
  })

  it('keeps the run id nowhere the reader can still see it', async () => {
    await dispatch(beyondCeiling([0]))
    expect(harness.scheduler.getSnapshot().serverRun?.runId).toBe('run_1')

    harness.scheduler.cancel()

    /*
     * The panel's own note says "the run keeps going on the server and keeps
     * its identifier". The snapshot is the only place that identifier lived, so
     * this is what the reader is left with.
     */
    expect(harness.scheduler.getSnapshot().serverRun).toBeNull()
    expect(harness.scheduler.getSnapshot().outcome).toBeNull()
  })
})

describe('a worker failure that arrives while the answer is on the server', () => {
  it('releases the server run instead of leaving it polled by nobody', async () => {
    /*
     * Every path that gives up on the in-flight request has to tell the backend
     * that owns it. `fail` used to clear the slot directly, which left the
     * server backend's poll chain rescheduling every five seconds until the
     * component unmounted — against a metered route, for an answer the
     * staleness line would then discard because there was no id left to match.
     */
    await dispatch(beyondCeiling([0]))
    expect(harness.scheduler.getSnapshot().serverRun?.runId).toBe('run_1')

    // The Web Worker breaks — an `onerror` for the *previous* circuit, say.
    harness.scheduler.fail({ code: 'worker-failed', detail: 'boom' })
    expect(harness.scheduler.getSnapshot().serverRun).toBeNull()

    harness.reads.length = 0
    await vi.advanceTimersByTimeAsync(60_000)
    expect(harness.reads).toEqual([])
  })
})
