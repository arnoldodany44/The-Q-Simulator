// @vitest-environment node
import { alloc } from '@qsim/core'
import { MAX_COLUMNS, parseCircuit, type Circuit } from '@qsim/schema'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import {
  encodeState,
  type SimulateRequest,
  type SimulationRequest,
} from './protocol'
import {
  SIMULATION_DEBOUNCE_MS,
  createSimulationScheduler,
  type SimulationScheduler,
} from './scheduler'

/**
 * The two defects M0.6 exists to prevent, pinned.
 *
 * Both are timing bugs, and both are invisible until someone edits fast: ten
 * edits that cost ten simulations, and a result for an edit the user has
 * already replaced repainting the panel. Neither needs a real worker to
 * reproduce — the scheduler is where the decisions are — so neither gets to
 * hide behind one.
 *
 * A third assertion runs through this file and is the least obvious: the
 * `fromColumn` a request carries must cover every edit the worker has not
 * answered yet, including edits whose job was cancelled before it ever ran.
 * Get that wrong and the worker resumes from a checkpoint the edit already
 * contradicted, which is not a visible bug at all — just a wrong answer.
 */

/** A circuit with one H per named column. Adding a column is one edit. */
function withGates(columns: readonly number[]): Circuit {
  return parseCircuit({
    schemaVersion: 1,
    qubits: 3,
    operations: columns.map((column) => ({
      id: `g${column}`,
      gate: 'h',
      targets: [0],
      column,
    })),
  })
}

function withQubits(qubits: number): Circuit {
  return parseCircuit({ schemaVersion: 1, qubits, operations: [] })
}

function simulates(posts: readonly SimulationRequest[]): SimulateRequest[] {
  return posts.filter(
    (request): request is SimulateRequest => request.kind === 'simulate'
  )
}

/** A believable answer for `id`, so `receive` has something to accept. */
function resultFor(id: number) {
  const { payload } = encodeState(alloc(2), false)
  return {
    kind: 'result',
    id,
    mode: 'analytic',
    state: payload,
    resumedFromColumn: 0,
    durationMs: 3,
  } as const
}

/** The same, for a sampling run: counts, and no statevector at all. */
function trajectoriesResultFor(id: number) {
  return {
    kind: 'result',
    id,
    mode: 'trajectories',
    shots: 8,
    counts: { '0': 8 },
    durationMs: 2,
  } as const
}

let posts: SimulationRequest[]
let scheduler: SimulationScheduler

beforeEach(() => {
  vi.useFakeTimers()
  posts = []
  scheduler = createSimulationScheduler()
  scheduler.connect((request) => {
    posts.push(request)
  })
})

afterEach(() => {
  scheduler.dispose()
  vi.useRealTimers()
})

/** Brings the scheduler to "the worker has answered and nothing is pending". */
function settle(circuit: Circuit): void {
  scheduler.schedule(circuit)
  vi.advanceTimersByTime(SIMULATION_DEBOUNCE_MS)
  const dispatched = simulates(posts).at(-1)
  scheduler.receive(resultFor(dispatched!.id))
  posts.length = 0
}

describe('debounce', () => {
  it('turns ten rapid edits into exactly one simulation', () => {
    settle(withGates([]))

    for (let index = 0; index < 10; index++) {
      const columns = Array.from({ length: index + 1 }, (_, n) => 10 + n)
      scheduler.schedule(withGates(columns))
      vi.advanceTimersByTime(10)
    }
    vi.advanceTimersByTime(SIMULATION_DEBOUNCE_MS)

    expect(posts).toHaveLength(1)
    // And it resumes from the earliest of the ten edits, not the last.
    expect(simulates(posts)[0]?.fromColumn).toBe(10)
  })

  it('waits for the pause, not for the first edit', () => {
    scheduler.schedule(withGates([0]))
    vi.advanceTimersByTime(SIMULATION_DEBOUNCE_MS - 1)

    expect(posts).toHaveLength(0)
    expect(scheduler.getSnapshot().status).toBe('scheduled')

    vi.advanceTimersByTime(1)
    expect(posts).toHaveLength(1)
    expect(scheduler.getSnapshot().status).toBe('running')
  })

  it('dispatches immediately when asked to', () => {
    scheduler.schedule(withGates([0]))
    scheduler.flush()

    expect(posts).toHaveLength(1)
  })

  it('says nothing about a circuit that did not change', () => {
    const circuit = withGates([0])
    settle(circuit)

    scheduler.schedule(circuit)
    vi.advanceTimersByTime(SIMULATION_DEBOUNCE_MS)

    expect(posts).toHaveLength(0)
    expect(scheduler.getSnapshot().status).toBe('ready')
  })
})

describe('staleness', () => {
  it('discards a result for a superseded request', () => {
    settle(withGates([]))

    scheduler.schedule(withGates([1]))
    vi.advanceTimersByTime(SIMULATION_DEBOUNCE_MS)
    const stale = simulates(posts)[0]!.id

    scheduler.schedule(withGates([1, 2]))
    vi.advanceTimersByTime(SIMULATION_DEBOUNCE_MS)
    const current = simulates(posts).at(-1)!.id
    expect(current).toBeGreaterThan(stale)

    // The superseded worker answers late, as it is entitled to. What the user
    // keeps looking at is the last result that was not superseded.
    const onScreen = scheduler.getSnapshot().outcome
    expect(scheduler.receive(resultFor(stale))).toBe(false)
    expect(scheduler.getSnapshot().outcome).toBe(onScreen)
    expect(scheduler.getSnapshot().status).toBe('running')

    expect(scheduler.receive(resultFor(current))).toBe(true)
    expect(scheduler.getSnapshot().outcome).not.toBe(onScreen)
    expect(scheduler.getSnapshot().outcome?.mode).toBe('analytic')
  })

  it('never accepts a result twice', () => {
    settle(withGates([]))
    scheduler.schedule(withGates([1]))
    vi.advanceTimersByTime(SIMULATION_DEBOUNCE_MS)
    const id = simulates(posts).at(-1)!.id

    expect(scheduler.receive(resultFor(id))).toBe(true)
    expect(scheduler.receive(resultFor(id))).toBe(false)
  })

  it('cancels the in-flight request when a new one goes out', () => {
    settle(withGates([]))

    scheduler.schedule(withGates([1]))
    vi.advanceTimersByTime(SIMULATION_DEBOUNCE_MS)
    const first = simulates(posts)[0]!.id

    scheduler.schedule(withGates([1, 2]))
    vi.advanceTimersByTime(SIMULATION_DEBOUNCE_MS)

    expect(posts[1]).toEqual({ kind: 'cancel', id: first })
    expect(posts[2]?.kind).toBe('simulate')
  })
})

describe('invalidation that survives a cancellation', () => {
  it('keeps the earliest column of an edit whose job never answered', () => {
    settle(withGates([0, 5, 20]))

    // Edit at column 5. Its job is dispatched…
    scheduler.schedule(withGates([0, 20]))
    vi.advanceTimersByTime(SIMULATION_DEBOUNCE_MS)
    expect(simulates(posts).at(-1)?.fromColumn).toBe(5)

    // …and superseded by an edit at column 20 before it ever answers. The
    // worker may well have dropped the first job unrun, so the second request
    // still has to invalidate from 5.
    scheduler.schedule(withGates([0]))
    vi.advanceTimersByTime(SIMULATION_DEBOUNCE_MS)

    expect(simulates(posts).at(-1)?.fromColumn).toBe(5)
  })

  it('forgets the accumulated column once a result proves the cache caught up', () => {
    settle(withGates([0, 5, 20]))

    scheduler.schedule(withGates([0, 20]))
    vi.advanceTimersByTime(SIMULATION_DEBOUNCE_MS)
    scheduler.receive(resultFor(simulates(posts).at(-1)!.id))

    scheduler.schedule(withGates([0]))
    vi.advanceTimersByTime(SIMULATION_DEBOUNCE_MS)

    expect(simulates(posts).at(-1)?.fromColumn).toBe(20)
  })

  it('keeps the column when the run came back as an error', () => {
    settle(withGates([0, 5, 20]))

    scheduler.schedule(withGates([0, 20]))
    vi.advanceTimersByTime(SIMULATION_DEBOUNCE_MS)
    scheduler.receive({
      kind: 'error',
      id: simulates(posts).at(-1)!.id,
      failure: { code: 'worker-failed', detail: 'boom' },
    })

    scheduler.schedule(withGates([0]))
    vi.advanceTimersByTime(SIMULATION_DEBOUNCE_MS)

    expect(simulates(posts).at(-1)?.fromColumn).toBe(5)
  })

  it('invalidates nothing when only the run options changed', () => {
    settle(withGates([0, 1]))

    scheduler.schedule(withGates([0, 1]), { mode: 'trajectories' })
    vi.advanceTimersByTime(SIMULATION_DEBOUNCE_MS)

    const request = simulates(posts).at(-1)
    expect(request?.mode).toBe('trajectories')
    // No column changed, so the worker keeps every checkpoint it holds.
    expect(request?.fromColumn).toBe(MAX_COLUMNS)
  })

  /*
   * A sampling run never touches the worker's checkpoint cache — it starts
   * from |0…0⟩ on every shot, deliberately — so its answer says nothing about
   * how far that cache caught up. A scheduler that credited it would tell the
   * next analytic request to invalidate nothing, and the worker would resume
   * from a checkpoint taken before the user's edit: no exception, no NaN,
   * just a normalised statevector belonging to a circuit that no longer
   * exists. That is the worst failure mode in this project, so it gets three
   * tests: the reported sequence, the ordinary variant, and the guard against
   * over-correcting into permanent full re-simulation.
   */
  it('does not let a sampling result absolve an edit it never saw', () => {
    settle(withGates([0, 5, 20]))

    // The gate at column 5 is deleted, and the user switches to sampling
    // before the analytic job for that edit is ever dispatched.
    scheduler.schedule(withGates([0, 20]))
    scheduler.schedule(withGates([0, 20]), { mode: 'trajectories' })
    vi.advanceTimersByTime(SIMULATION_DEBOUNCE_MS)
    scheduler.receive(trajectoriesResultFor(simulates(posts).at(-1)!.id))

    // The histogram is a legitimate answer and is shown…
    expect(scheduler.getSnapshot().outcome?.mode).toBe('trajectories')
    expect(scheduler.getSnapshot().durationMs).toBe(2)

    // …but the analytic cache still holds column 5 as the user first wrote it.
    scheduler.schedule(withGates([0, 20]), { mode: 'analytic' })
    vi.advanceTimersByTime(SIMULATION_DEBOUNCE_MS)

    expect(simulates(posts).at(-1)?.fromColumn).toBe(5)
  })

  it('keeps an edit made while sampling was in flight', () => {
    settle(withGates([0, 5, 20]))

    scheduler.schedule(withGates([0, 5, 20]), { mode: 'trajectories' })
    vi.advanceTimersByTime(SIMULATION_DEBOUNCE_MS)
    scheduler.receive(trajectoriesResultFor(simulates(posts).at(-1)!.id))

    // Column 5 is edited away with a second sampling run, whose result is
    // just as blind to the checkpoint cache as the first.
    scheduler.schedule(withGates([0, 20]), { mode: 'trajectories' })
    vi.advanceTimersByTime(SIMULATION_DEBOUNCE_MS)
    scheduler.receive(trajectoriesResultFor(simulates(posts).at(-1)!.id))

    scheduler.schedule(withGates([0, 20]), { mode: 'analytic' })
    vi.advanceTimersByTime(SIMULATION_DEBOUNCE_MS)

    expect(simulates(posts).at(-1)?.fromColumn).toBe(5)
  })

  it('still invalidates nothing when sampling changed no column', () => {
    settle(withGates([0, 5, 20]))

    scheduler.schedule(withGates([0, 5, 20]), { mode: 'trajectories' })
    vi.advanceTimersByTime(SIMULATION_DEBOUNCE_MS)
    scheduler.receive(trajectoriesResultFor(simulates(posts).at(-1)!.id))

    scheduler.schedule(withGates([0, 5, 20]), { mode: 'analytic' })
    vi.advanceTimersByTime(SIMULATION_DEBOUNCE_MS)

    // The guard against over-correcting: a round trip through sampling with
    // an unchanged circuit must still resume from the last checkpoint.
    expect(simulates(posts).at(-1)?.fromColumn).toBe(MAX_COLUMNS)
  })

  it('starts over after a reset, because a new worker has no cache', () => {
    settle(withGates([0, 5]))
    scheduler.reset()

    scheduler.schedule(withGates([0, 5]))
    vi.advanceTimersByTime(SIMULATION_DEBOUNCE_MS)

    expect(simulates(posts).at(-1)?.fromColumn).toBe(0)
  })
})

describe('the qubit ceiling', () => {
  it('refuses more than 20 qubits without troubling the worker', () => {
    scheduler.schedule(withQubits(21))
    vi.advanceTimersByTime(SIMULATION_DEBOUNCE_MS)

    expect(posts).toHaveLength(0)
    const snapshot = scheduler.getSnapshot()
    expect(snapshot.status).toBe('error')
    expect(snapshot.failure?.code).toBe('too-many-qubits')
    expect(snapshot.failure?.qubits).toBe(21)
    expect(snapshot.failure?.limit).toBe(20)
  })

  it('drops the answer that is already on screen', () => {
    settle(withGates([0]))
    expect(scheduler.getSnapshot().outcome).not.toBeNull()

    scheduler.schedule(withQubits(21))

    // A histogram of the circuit as it was two qubits ago is a lie, and the
    // error is what the user needs to read instead.
    expect(scheduler.getSnapshot().outcome).toBeNull()
  })

  it('simulates again once the circuit fits', () => {
    scheduler.schedule(withQubits(21))
    vi.advanceTimersByTime(SIMULATION_DEBOUNCE_MS)

    scheduler.schedule(withQubits(20))
    vi.advanceTimersByTime(SIMULATION_DEBOUNCE_MS)

    expect(simulates(posts)).toHaveLength(1)
    expect(simulates(posts)[0]?.fromColumn).toBe(0)
  })
})

describe('the snapshot', () => {
  it('notifies subscribers and keeps its identity between changes', () => {
    const seen: number[] = []
    scheduler.subscribe(() => seen.push(1))

    const first = scheduler.getSnapshot()
    scheduler.schedule(withGates([0]))
    const second = scheduler.getSnapshot()

    expect(seen).toHaveLength(1)
    expect(second).not.toBe(first)
    expect(scheduler.getSnapshot()).toBe(second)
  })

  it('reports a worker-level failure that no request will answer', () => {
    scheduler.schedule(withGates([0]))
    vi.advanceTimersByTime(SIMULATION_DEBOUNCE_MS)
    scheduler.fail({ code: 'worker-unavailable', detail: 'no Worker here' })

    const snapshot = scheduler.getSnapshot()
    expect(snapshot.status).toBe('error')
    expect(snapshot.failure?.code).toBe('worker-unavailable')
  })
})
