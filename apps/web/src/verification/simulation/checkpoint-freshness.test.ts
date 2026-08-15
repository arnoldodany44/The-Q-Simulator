// @vitest-environment node
/**
 * Independent verification of confirmed defect 7 — an analytic run resuming
 * from a checkpoint that predates an edit.
 *
 * The scheduler's own suite asserts the *bookkeeping* (`fromColumn` on the
 * request). This file asserts the *physics*, which is the thing the defect
 * actually corrupted: it drives the real worker module — real message loop,
 * real `runJob`, one real `createCheckpoints()` cache that survives every
 * request, exactly as a live worker's does — and compares the amplitudes that
 * come back with a from-scratch `run()` of the circuit on screen.
 *
 * A wrong answer here is silent by construction: the state is perfectly
 * normalised, no exception is thrown, and nothing on screen looks unusual. So
 * the only witness available is amplitude equality against ground truth.
 */

import { run, type Statevector } from '@qsim/core'
import { parseCircuit, type Circuit } from '@qsim/schema'
import { afterAll, afterEach, beforeAll, beforeEach, expect, it } from 'vitest'

import type {
  SimulationRequest,
  SimulationResponse,
} from '../../features/simulation/protocol'
import {
  createSimulationScheduler,
  type SimulationScheduler,
} from '../../features/simulation/scheduler'

/** The column whose parameter the edits below move. Deep enough to be past a
 * checkpoint boundary (the engine checkpoints every 8 columns). */
const EDITED_COLUMN = 10
const COLUMNS = 24

/**
 * A 3-qubit circuit whose column 10 reads `theta`, with entanglement either
 * side of it so a stale resume cannot accidentally agree.
 */
function circuitAt(theta: number): Circuit {
  const operations = []
  for (let column = 0; column < COLUMNS; column += 1) {
    if (column % 4 === 3) {
      operations.push({
        id: `g${column}`,
        gate: 'cx',
        targets: [(column + 1) % 3],
        controls: [column % 3],
        column,
      })
      continue
    }
    operations.push({
      id: `g${column}`,
      gate: 'rx',
      targets: [column % 3],
      column,
      params: [column === EDITED_COLUMN ? 'theta' : 0.17 + column * 0.041],
    })
  }
  return parseCircuit({
    schemaVersion: 1,
    qubits: 3,
    // Non-zero so a trajectories run is a *result* and not a
    // `no-classical-bits` refusal — a refusal would leave `dirtyFrom` alone
    // through the error path and the defect would be untestable.
    clbits: 1,
    parameters: [{ name: 'theta', value: theta }],
    operations,
  })
}

function truth(circuit: Circuit): Statevector {
  const result = run(circuit)
  if (result.mode !== 'analytic') throw new Error('expected an analytic run')
  return result.state
}

function expectSameState(actual: Statevector, expected: Statevector): void {
  expect(actual.size).toBe(expected.size)
  for (let index = 0; index < expected.size; index += 1) {
    expect(actual.re[index]).toBeCloseTo(expected.re[index] ?? 0, 12)
    expect(actual.im[index]).toBeCloseTo(expected.im[index] ?? 0, 12)
  }
}

/** One macrotask — the gap the worker hands back before it answers. */
function settle(): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, 0)
  })
}

let scheduler: SimulationScheduler
let deliver: (event: { data: SimulationRequest }) => void

const realPostMessage = globalThis.postMessage

beforeAll(async () => {
  globalThis.postMessage = ((response: SimulationResponse) => {
    scheduler.receive(response)
  }) as typeof globalThis.postMessage
  await import('../../features/simulation/simulation.worker')
  deliver = globalThis.onmessage as unknown as (event: {
    data: SimulationRequest
  }) => void
  expect(deliver, 'the worker installed no message handler').toBeTypeOf(
    'function'
  )
})

afterAll(() => {
  globalThis.postMessage = realPostMessage
})

beforeEach(() => {
  // debounceMs 0 plus explicit `flush()` keeps the timing deterministic
  // without fake timers, which the worker's own `setTimeout(0)` needs real.
  scheduler = createSimulationScheduler({ debounceMs: 0, sharedMemory: false })
  scheduler.connect((request) => {
    deliver({ data: request })
  })
})

afterEach(() => {
  scheduler.dispose()
})

function stateOf(): Statevector {
  const outcome = scheduler.getSnapshot().outcome
  if (outcome === null || outcome.mode !== 'analytic') {
    throw new Error(
      `expected an analytic outcome, got ${JSON.stringify(outcome)} with ` +
        `status ${scheduler.getSnapshot().status}`
    )
  }
  return outcome.state
}

it('an analytic run after a sampling run answers the edited circuit', async () => {
  const before = circuitAt(0.3)
  const after = circuitAt(1.9)
  // Sanity: the edit is observable at all.
  expect(truth(before).re[0]).not.toBeCloseTo(truth(after).re[0] ?? 0, 6)

  // 1. Warm the worker's checkpoint cache on the circuit as it was.
  scheduler.schedule(before)
  scheduler.flush()
  await settle()
  expect(scheduler.getSnapshot().status).toBe('ready')
  expectSameState(stateOf(), truth(before))

  // 2. Edit column 10, then supersede it with a sampling run before the
  //    analytic job for that edit is ever dispatched.
  scheduler.schedule(after)
  scheduler.schedule(after, { mode: 'trajectories', shots: 8 })
  scheduler.flush()
  await settle()
  expect(scheduler.getSnapshot().outcome?.mode).toBe('trajectories')

  // 3. Back to analytic. Nothing about the circuit changed since step 2, so
  //    the only thing that can carry the column-10 edit forward is the
  //    scheduler refusing to treat a sampling result as evidence about the
  //    analytic checkpoint cache.
  scheduler.schedule(after, { mode: 'analytic' })
  scheduler.flush()
  await settle()

  expect(scheduler.getSnapshot().status).toBe('ready')
  expectSameState(stateOf(), truth(after))

  const outcome = scheduler.getSnapshot().outcome
  expect(
    outcome?.mode === 'analytic' && outcome.resumedFromColumn
  ).toBeLessThanOrEqual(EDITED_COLUMN)
})

it('editing while sampling still reaches the next analytic run', async () => {
  const before = circuitAt(0.3)
  const after = circuitAt(2.4)

  scheduler.schedule(before)
  scheduler.flush()
  await settle()

  // Sample the unchanged circuit, then edit while the sampling result is the
  // most recent answer, then sample again, then go analytic.
  scheduler.schedule(before, { mode: 'trajectories', shots: 8 })
  scheduler.flush()
  await settle()

  scheduler.schedule(after, { mode: 'trajectories', shots: 8 })
  scheduler.flush()
  await settle()

  scheduler.schedule(after, { mode: 'analytic' })
  scheduler.flush()
  await settle()

  expectSameState(stateOf(), truth(after))
})

it('an unchanged circuit round-tripping through sampling still resumes', async () => {
  const circuit = circuitAt(0.3)

  scheduler.schedule(circuit)
  scheduler.flush()
  await settle()

  scheduler.schedule(circuit, { mode: 'trajectories', shots: 8 })
  scheduler.flush()
  await settle()

  scheduler.schedule(circuit, { mode: 'analytic' })
  scheduler.flush()
  await settle()

  expectSameState(stateOf(), truth(circuit))
  const outcome = scheduler.getSnapshot().outcome
  // The guard against over-correcting: with nothing edited, the run must still
  // resume from a checkpoint rather than restart at column 0.
  expect(
    outcome?.mode === 'analytic' && outcome.resumedFromColumn
  ).toBeGreaterThan(0)
})

/**
 * The sweep. Random interleavings of edits, mode switches, cancellations and
 * dispatches, each run ending on an analytic answer that is compared with
 * ground truth. Any ordering in which the scheduler's idea of the worker's
 * cache drifts from the worker's actual cache shows up here as amplitudes that
 * do not match.
 */
it('survives 60 random interleavings of edits and mode switches', async () => {
  let seed = 20260814
  const random = () => {
    seed = (seed * 1103515245 + 12345) % 2147483648
    return seed / 2147483648
  }

  let theta = 0.3
  let circuit = circuitAt(theta)
  scheduler.schedule(circuit)
  scheduler.flush()
  await settle()

  for (let step = 0; step < 60; step += 1) {
    const roll = random()
    if (roll < 0.55) {
      theta += 0.37
      circuit = circuitAt(theta)
      scheduler.schedule(circuit, {
        mode: random() < 0.4 ? 'trajectories' : 'analytic',
        shots: 8,
      })
    } else if (roll < 0.75) {
      scheduler.schedule(circuit, { mode: 'trajectories', shots: 8 })
    } else if (roll < 0.9) {
      scheduler.flush()
      await settle()
    } else {
      scheduler.cancel()
    }
  }

  scheduler.schedule(circuit, { mode: 'analytic' })
  scheduler.flush()
  await settle()

  expect(scheduler.getSnapshot().status).toBe('ready')
  expectSameState(stateOf(), truth(circuit))
})
