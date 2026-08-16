/**
 * The second backend, driven with no network and no socket.
 *
 * The properties worth pinning are the ones that only exist because the run
 * happens somewhere else: that a run finished inside the synchronous window
 * never opens a socket at all, that a socket which never connects still
 * produces an answer, that a dropped connection recovers by *reading* rather
 * than by replaying, and that stopping means stopping waiting.
 */

import type { SimulateRequest, SimulationRun } from '@qsim/contract'
import { CIRCUIT_SCHEMA_VERSION } from '@qsim/schema'
import type { Circuit } from '@qsim/schema'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import type {
  RequestId,
  ServerSimulateRequest,
  SimulationFailure,
  SimulationResponse,
} from './protocol'
import type { RunSocket, RunWatcher } from './runSocket'
import { RUN_POLL_INTERVAL_MS, createServerBackend } from './serverRun'
import type { ServerRunUpdate, ServerTransport } from './scheduler'

const CIRCUIT: Circuit = {
  schemaVersion: CIRCUIT_SCHEMA_VERSION,
  qubits: 22,
  clbits: 0,
  operations: [{ id: 'h0', gate: 'h', targets: [0], column: 0 }],
}

function run(overrides: Partial<SimulationRun> = {}): SimulationRun {
  return {
    id: 'run_1',
    status: 'QUEUED',
    mode: 'STATEVECTOR',
    shots: null,
    circuitId: null,
    createdAt: new Date('2026-01-01T00:00:00.000Z'),
    durationMs: null,
    estimatedDurationMs: null,
    result: null,
    error: null,
    progress: null,
    ...overrides,
  }
}

function request(id: RequestId = 1): ServerSimulateRequest {
  return {
    kind: 'server-simulate',
    id,
    circuit: CIRCUIT,
    mode: 'analytic',
    shots: null,
    seed: 7,
  }
}

interface Harness {
  readonly dispatch: ServerTransport
  /** Tears the backend down the way an unmounting editor does. */
  readonly dispose: () => void
  readonly submitted: SimulateRequest[]
  readonly reads: string[]
  readonly delivered: SimulationResponse[]
  readonly failures: { id: RequestId; failure: SimulationFailure }[]
  readonly reports: ServerRunUpdate[]
  /** The watcher the backend registered, if it registered one. */
  readonly watcher: () => RunWatcher
  readonly watched: string[]
  readonly released: string[]
  /** Runs the pending poll timer. */
  readonly elapse: () => void
  readonly pending: () => boolean
  /** What the next `fetchRun` answers with. */
  next: SimulationRun
  submitResult: SimulationRun | Error
  /** Typed as an Error so a rejection is always one, like the real client. */
  fetchError: Error | null
}

function harness(options: { socket?: boolean } = {}): Harness {
  const submitted: SimulateRequest[] = []
  const reads: string[] = []
  const delivered: SimulationResponse[] = []
  const failures: { id: RequestId; failure: SimulationFailure }[] = []
  const reports: ServerRunUpdate[] = []
  const watched: string[] = []
  const released: string[] = []
  const timers: (() => void)[] = []
  let registered: RunWatcher | null = null

  const socket: RunSocket | null =
    options.socket === false
      ? null
      : {
          connected: () => true,
          close: () => undefined,
          watch: (runId, watcher) => {
            watched.push(runId)
            registered = watcher
            return () => released.push(runId)
          },
        }

  const state: Harness = {
    submitted,
    reads,
    delivered,
    failures,
    reports,
    watched,
    released,
    next: run(),
    submitResult: run(),
    fetchError: null,
    watcher: () => {
      if (registered === null) throw new Error('nothing was watched')
      return registered
    },
    pending: () => timers.length > 0,
    elapse: () => {
      const timer = timers.shift()
      if (timer === undefined) throw new Error('no poll is pending')
      timer()
    },
    ...createServerBackend({
      submit: (body) => {
        submitted.push(body)
        return state.submitResult instanceof Error
          ? Promise.reject(state.submitResult)
          : Promise.resolve(state.submitResult)
      },
      fetchRun: (runId) => {
        reads.push(runId)
        const failure = state.fetchError
        if (failure !== null) return Promise.reject(failure)
        return Promise.resolve(state.next)
      },
      socket,
      deliver: (response) => delivered.push(response),
      fail: (id, failure) => failures.push({ id, failure }),
      report: (update) => reports.push(update),
      schedule: (fn) => {
        timers.push(fn)
        return () => {
          const index = timers.indexOf(fn)
          if (index >= 0) timers.splice(index, 1)
        }
      },
    }),
  }

  return state
}

let h: Harness

beforeEach(() => {
  h = harness()
})

describe('submitting', () => {
  it('sends the circuit, the mode, the shots and the seed', async () => {
    h.dispatch(request())
    await vi.waitFor(() => expect(h.submitted).toHaveLength(1))
    expect(h.submitted[0]).toMatchObject({
      mode: 'STATEVECTOR',
      seed: 7,
      readout: true,
    })
    // The seed always travels, because a run nobody can repeat is not an
    // authoritative answer — which is one of §4's reasons for this path.
    expect(h.submitted[0]?.circuit).toBe(CIRCUIT)
  })

  it('maps the trajectories mode and carries its shots', async () => {
    h.dispatch({ ...request(), mode: 'trajectories', shots: 4096 })
    await vi.waitFor(() => expect(h.submitted).toHaveLength(1))
    expect(h.submitted[0]).toMatchObject({ mode: 'TRAJECTORIES', shots: 4096 })
  })

  it('answers immediately for a run that finished in the synchronous window', async () => {
    /*
     * The ordinary outcome for work that is here to be authoritative rather
     * than because it is big. No socket, no poll, no run id ever shown.
     */
    h.submitResult = run({ status: 'DONE', durationMs: 4 })
    h.dispatch(request())
    await vi.waitFor(() => expect(h.delivered).toHaveLength(1))
    expect(h.delivered[0]).toMatchObject({ mode: 'server', id: 1 })
    expect(h.watched).toEqual([])
    expect(h.pending()).toBe(false)
  })

  it('reports a failed run as an answer, not as a transport failure', async () => {
    // The server did the work of deciding it could not be done, and the row
    // says why in a code the panel translates.
    h.submitResult = run({ status: 'FAILED', error: 'TIMED_OUT' })
    h.dispatch(request())
    await vi.waitFor(() => expect(h.delivered).toHaveLength(1))
    expect(h.failures).toEqual([])
  })

  it('turns a refusal into a code the panel can translate', async () => {
    h.submitResult = Object.assign(new Error('nope'), {
      code: 'SIMULATION_TOO_LARGE',
    })
    h.dispatch(request())
    await vi.waitFor(() => expect(h.failures).toHaveLength(1))
    expect(h.failures[0]).toMatchObject({
      id: 1,
      failure: { code: 'server-too-large' },
    })
  })

  it('distinguishes a queue that is down from a request that was wrong', async () => {
    h.submitResult = Object.assign(new Error('down'), {
      code: 'SIMULATION_UNAVAILABLE',
    })
    h.dispatch(request())
    await vi.waitFor(() => expect(h.failures).toHaveLength(1))
    expect(h.failures[0]?.failure.code).toBe('server-unavailable')
  })
})

describe('while it runs', () => {
  beforeEach(async () => {
    h.submitResult = run({ status: 'QUEUED', estimatedDurationMs: 11_000 })
    h.dispatch(request())
    await vi.waitFor(() => expect(h.reports).toHaveLength(1))
  })

  it('reports the run id and the estimate as soon as they exist', () => {
    expect(h.reports[0]).toMatchObject({
      id: 1,
      stage: 'queued',
      runId: 'run_1',
      estimatedDurationMs: 11_000,
    })
  })

  it('subscribes and starts a safety poll', () => {
    expect(h.watched).toEqual(['run_1'])
    expect(h.pending()).toBe(true)
  })

  it('turns a claim into the running stage', () => {
    h.watcher().onStatus({
      type: 'job:status',
      runId: 'run_1',
      status: 'RUNNING',
    })
    expect(h.reports.at(-1)).toMatchObject({ stage: 'running' })
  })

  it('carries the phase and the fraction through', () => {
    h.watcher().onProgress({
      type: 'run:progress',
      runId: 'run_1',
      phase: 'sampling',
      completed: 512,
      total: 1024,
    })
    expect(h.reports.at(-1)).toMatchObject({
      stage: 'running',
      phase: 'sampling',
      completed: 512,
      total: 1024,
    })
  })

  it('reads the run when the socket says it is finished', async () => {
    // The frame says a run finished; it deliberately does not say what the
    // answer is. This is the read, and it is the only source of a result.
    h.next = run({ status: 'DONE', durationMs: 9 })
    h.watcher().onComplete({
      type: 'run:complete',
      runId: 'run_1',
      status: 'DONE',
      durationMs: 9,
      error: null,
    })
    await vi.waitFor(() => expect(h.delivered).toHaveLength(1))
    expect(h.reads).toEqual(['run_1'])
    expect(h.released).toEqual(['run_1'])
  })

  it('says the feed is offline rather than going quiet', () => {
    // "No progress for ten seconds" and "no connection for ten seconds" look
    // identical and mean different things; only one of them resolves itself.
    h.watcher().onOffline?.()
    expect(h.reports.at(-1)).toMatchObject({ live: false })
  })

  it('gives up on a run this viewer may no longer read', () => {
    // §11's mid-stream re-check, arriving at the client. Polling would answer
    // the same 404, so waiting for it would only delay the news.
    h.watcher().onRefused('unauthorised')
    expect(h.failures).toHaveLength(1)
    expect(h.released).toEqual(['run_1'])
  })
})

describe('recovery', () => {
  it('re-reads the run on every resync, which is the whole reconnection story', async () => {
    h.submitResult = run({ status: 'RUNNING' })
    h.dispatch(request())
    await vi.waitFor(() => expect(h.watched).toHaveLength(1))

    h.next = run({ status: 'DONE', durationMs: 5 })
    h.watcher().onResync({
      type: 'subscribed',
      runId: 'run_1',
      status: 'DONE',
    })
    await vi.waitFor(() => expect(h.delivered).toHaveLength(1))
    // Nothing was replayed: the answer was in the row the whole time.
    expect(h.reads).toEqual(['run_1'])
  })

  it('finishes with no socket at all, on the poll alone', async () => {
    /*
     * The property that makes the socket an optimisation rather than a
     * dependency: a proxy that strips upgrades, a CSP, an API with no Redis —
     * all of them cost latency and nothing else.
     */
    const bare = harness({ socket: false })
    bare.submitResult = run({ status: 'RUNNING' })
    bare.dispatch(request())
    await vi.waitFor(() => expect(bare.pending()).toBe(true))

    bare.next = run({ status: 'DONE', durationMs: 6 })
    bare.elapse()
    await vi.waitFor(() => expect(bare.delivered).toHaveLength(1))
    expect(bare.watched).toEqual([])
  })

  it('keeps polling on the published interval while a run is unfinished', async () => {
    const bare = harness({ socket: false })
    bare.submitResult = run({ status: 'RUNNING' })
    bare.dispatch(request())
    await vi.waitFor(() => expect(bare.pending()).toBe(true))

    bare.next = run({ status: 'RUNNING' })
    bare.elapse()
    await vi.waitFor(() => expect(bare.reads).toHaveLength(1))
    await vi.waitFor(() => expect(bare.pending()).toBe(true))
    expect(RUN_POLL_INTERVAL_MS).toBeGreaterThanOrEqual(5_000)
  })

  it('survives a read that failed, because the next one tries again', async () => {
    const bare = harness({ socket: false })
    bare.submitResult = run({ status: 'RUNNING' })
    bare.dispatch(request())
    await vi.waitFor(() => expect(bare.pending()).toBe(true))

    bare.fetchError = Object.assign(new Error('offline'), {
      code: 'NETWORK_UNREACHABLE',
    })
    bare.elapse()
    await vi.waitFor(() => expect(bare.reads).toHaveLength(1))
    expect(bare.failures).toEqual([])
    await vi.waitFor(() => expect(bare.pending()).toBe(true))

    bare.fetchError = null
    bare.next = run({ status: 'DONE', durationMs: 2 })
    bare.elapse()
    await vi.waitFor(() => expect(bare.delivered).toHaveLength(1))
  })

  it('stops when a read says the run is not there', async () => {
    // 404 covers "no such run" and "not yours" alike (§11), and neither gets
    // better by asking again.
    const bare = harness({ socket: false })
    bare.submitResult = run({ status: 'RUNNING' })
    bare.dispatch(request())
    await vi.waitFor(() => expect(bare.pending()).toBe(true))

    bare.fetchError = Object.assign(new Error('gone'), { code: 'NOT_FOUND' })
    bare.elapse()
    await vi.waitFor(() => expect(bare.failures).toHaveLength(1))
    expect(bare.pending()).toBe(false)
  })
})

describe('stopping', () => {
  it('unsubscribes and stops polling, and says nothing more', async () => {
    h.submitResult = run({ status: 'RUNNING' })
    h.dispatch(request(3))
    await vi.waitFor(() => expect(h.watched).toHaveLength(1))

    h.dispatch({ kind: 'cancel', id: 3 })
    expect(h.released).toEqual(['run_1'])
    expect(h.pending()).toBe(false)

    const before = h.reports.length
    h.watcher().onProgress({
      type: 'run:progress',
      runId: 'run_1',
      phase: 'simulating',
      completed: 1,
      total: 2,
    })
    expect(h.reports).toHaveLength(before)
  })

  it('ignores a cancel that names a run it is no longer driving', async () => {
    // A cancel that arrived after the answer did would otherwise tear down the
    // *next* run, which the scheduler has already started by then.
    h.submitResult = run({ status: 'RUNNING' })
    h.dispatch(request(5))
    await vi.waitFor(() => expect(h.watched).toHaveLength(1))
    h.dispatch({ kind: 'cancel', id: 4 })
    expect(h.released).toEqual([])
  })

  it('releases the previous run when a new one is dispatched', async () => {
    h.submitResult = run({ status: 'RUNNING' })
    h.dispatch(request(1))
    await vi.waitFor(() => expect(h.watched).toHaveLength(1))
    h.dispatch(request(2))
    expect(h.released).toEqual(['run_1'])
  })
})

describe('going away', () => {
  it('releases the subscription and the poll when the editor unmounts', async () => {
    /*
     * The leak this exists to prevent: an editor closed while a run was queued
     * used to leave a `setTimeout` chain reading `GET /simulate/:runId` every
     * five seconds for as long as the tab lived, against a run nobody would
     * ever look at. The scheduler's reset does not cover it — that clears what
     * is in flight up there, and the timer lives down here.
     */
    h.submitResult = run({ status: 'RUNNING' })
    h.dispatch(request())
    await vi.waitFor(() => expect(h.watched).toHaveLength(1))
    expect(h.pending()).toBe(true)

    h.dispose()

    expect(h.released).toEqual(['run_1'])
    expect(h.pending()).toBe(false)
  })

  it('is safe to call with nothing in flight', () => {
    expect(() => h.dispose()).not.toThrow()
  })
})
