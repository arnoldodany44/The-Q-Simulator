import { CIRCUIT_SCHEMA_VERSION, parseCircuit } from '@qsim/schema'
import type { Circuit } from '@qsim/schema'
import { act, renderHook } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import type {
  SimulationRequest,
  SimulationResponse,
} from '../features/simulation/protocol'
import {
  EMBED_SEED,
  EMBED_SHOTS,
  useEmbedSimulation,
  type EmbedWorkerLike,
} from './useEmbedSimulation'

/**
 * The embed's one run.
 *
 * The assertion that matters most is the shared-memory one. A framed document
 * is never cross-origin isolated, so `SharedArrayBuffer` is unavailable to an
 * embed every time — and the tempting simplification is to hard-code
 * `sharedMemory: false` here, since we know. This suite pins the opposite:
 * the capability is *asked for*, so an embed opened top-level and an embed
 * inside a frame run the same code, and what the e2e suite exercises is what
 * a reader gets. The documented fallback in `encodeState` is then what runs,
 * rather than a second arrangement written for embeds.
 */

afterEach(() => {
  vi.unstubAllGlobals()
})

/*
 * Built once and reused, never rebuilt inside `renderHook`. The hook keys its
 * effect on the circuit's identity (see its doc comment), so a fresh object
 * per render would respawn the worker on every paint — and since the answer
 * sets state, forever. That is a real constraint on callers rather than a
 * quirk of the test, which is why it is written down in both places.
 */
const BELL = bell()
const MEASURED = measured()

function bell(): Circuit {
  return parseCircuit({
    schemaVersion: CIRCUIT_SCHEMA_VERSION,
    qubits: 2,
    clbits: 0,
    operations: [
      { id: 'op-0', gate: 'h', targets: [0], column: 0 },
      { id: 'op-1', gate: 'cx', targets: [1], controls: [0], column: 1 },
    ],
  })
}

/** A circuit that measures, so `executionModeFor` picks trajectories. */
function measured(): Circuit {
  return parseCircuit({
    schemaVersion: CIRCUIT_SCHEMA_VERSION,
    qubits: 1,
    clbits: 1,
    operations: [
      { id: 'op-0', gate: 'h', targets: [0], column: 0 },
      {
        id: 'op-1',
        gate: 'measure',
        targets: [0],
        clbitTargets: [0],
        column: 1,
      },
    ],
  })
}

/*
 * The factory is read through a ref rather than depended on, so an inline
 * arrow would be safe here — it is named anyway, because a `createWorker`
 * written inline is exactly the shape that used to hang this suite and the
 * name is a reminder of which side of that line the hook now sits on.
 */
function refuseToSpawn(): never {
  throw new DOMException('blocked', 'SecurityError')
}

interface Spy {
  readonly sent: SimulationRequest[]
  readonly terminated: () => number
  reply(response: SimulationResponse): void
  fail(message: string): void
}

function stubWorker(): { create: () => EmbedWorkerLike; spy: Spy } {
  const sent: SimulationRequest[] = []
  let terminations = 0
  let onmessage: ((event: MessageEvent<SimulationResponse>) => void) | null =
    null
  let onerror: ((event: ErrorEvent) => void) | null = null

  const worker: EmbedWorkerLike = {
    postMessage(message: SimulationRequest) {
      sent.push(message)
    },
    terminate() {
      terminations += 1
    },
    get onmessage() {
      return onmessage
    },
    set onmessage(handler) {
      onmessage = handler
    },
    get onerror() {
      return onerror
    },
    set onerror(handler) {
      onerror = handler
    },
  }

  return {
    create: () => worker,
    spy: {
      sent,
      terminated: () => terminations,
      reply(response) {
        act(() => {
          onmessage?.({ data: response } as MessageEvent<SimulationResponse>)
        })
      },
      fail(message) {
        act(() => {
          onerror?.({ message } as ErrorEvent)
        })
      },
    },
  }
}

describe('the request an embed posts', () => {
  it('asks whether shared memory is available rather than assuming', () => {
    // jsdom is not cross-origin isolated, which is exactly the state a framed
    // document is in.
    vi.stubGlobal('crossOriginIsolated', false)
    const { create, spy } = stubWorker()

    renderHook(() => useEmbedSimulation(BELL, { createWorker: create }))

    expect(spy.sent).toHaveLength(1)
    expect(spy.sent[0]?.kind).toBe('simulate')
    if (spy.sent[0]?.kind !== 'simulate') return
    expect(spy.sent[0].sharedMemory).toBe(false)
  })

  it('runs the whole circuit, with no shots and no noise model', () => {
    const { create, spy } = stubWorker()

    renderHook(() => useEmbedSimulation(BELL, { createWorker: create }))

    const request = spy.sent[0]
    expect(request?.kind).toBe('simulate')
    if (request?.kind !== 'simulate') return
    expect(request.mode).toBe('analytic')
    if (request.mode !== 'analytic') return
    // An embed is a figure: the ideal reading, nothing sampled that nobody
    // asked for (§5.3), and no comparison it has no control to configure.
    expect(request.throughColumn).toBeNull()
    expect(request.sample).toBeNull()
    expect(request.noise).toBeNull()
    expect(request.fromColumn).toBe(0)
  })

  it('samples a measuring circuit, always with the same seed', () => {
    const { create, spy } = stubWorker()

    renderHook(() => useEmbedSimulation(MEASURED, { createWorker: create }))

    const request = spy.sent[0]
    if (request?.kind !== 'simulate') throw new Error('nothing was sent')
    expect(request.mode).toBe('trajectories')
    if (request.mode !== 'trajectories') return
    /*
     * A figure a teacher writes a caption for must not change between page
     * loads, and a tally with no control to re-roll it has no way to explain
     * that it moved.
     */
    expect(request.seed).toBe(EMBED_SEED)
    expect(request.shots).toBe(EMBED_SHOTS)
  })
})

describe('what comes back', () => {
  it('holds the statevector of an analytic run', () => {
    const { create, spy } = stubWorker()
    const { result } = renderHook(() =>
      useEmbedSimulation(BELL, { createWorker: create })
    )

    expect(result.current.status).toBe('running')

    spy.reply({
      kind: 'result',
      id: 1,
      mode: 'analytic',
      state: {
        qubits: 1,
        size: 2,
        re: new Float64Array([1, 0]),
        im: new Float64Array([0, 0]),
        transport: 'transfer',
      },
      throughColumn: null,
      resumedFromColumn: 0,
      sampling: null,
      noise: null,
      durationMs: 1,
    })

    expect(result.current.status).toBe('analytic')
  })

  it('keeps a refusal as a code and its numbers, for the view to word', () => {
    /*
     * An embed never dispatches past the ceiling to the server: that would
     * make an anonymous frame on an arbitrary origin a way to spend this
     * project's compute at whatever rate the pages embedding it are loaded.
     * The refusal is the answer, and the diagram beside it is still true.
     */
    const { create, spy } = stubWorker()
    const { result } = renderHook(() =>
      useEmbedSimulation(BELL, { createWorker: create })
    )

    spy.reply({
      kind: 'error',
      id: 1,
      failure: {
        code: 'too-many-qubits',
        qubits: 24,
        limit: 20,
        detail: 'past the ceiling',
      },
    })

    expect(result.current).toEqual({
      status: 'failed',
      code: 'too-many-qubits',
      values: { qubits: 24, limit: 20 },
    })
  })

  it('reports a worker that cannot start instead of waiting forever', () => {
    /*
     * The real configuration behind this: `sandbox="allow-scripts"` without
     * `allow-same-origin` gives the frame an opaque origin, and a document in
     * an opaque origin cannot construct a worker from a same-origin URL. The
     * drawing is still an answer, so this is a state rather than a throw.
     */
    vi.spyOn(console, 'error').mockImplementation(() => undefined)
    const { result } = renderHook(() =>
      useEmbedSimulation(BELL, { createWorker: refuseToSpawn })
    )

    expect(result.current).toEqual({
      status: 'failed',
      code: 'worker-unavailable',
      values: {},
    })
  })

  it('reports a worker that dies mid-run', () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined)
    const { create, spy } = stubWorker()
    const { result } = renderHook(() =>
      useEmbedSimulation(BELL, { createWorker: create })
    )

    spy.fail('boom')

    expect(result.current.status).toBe('failed')
    if (result.current.status !== 'failed') return
    expect(result.current.code).toBe('worker-failed')
  })

  it('terminates the worker when the frame goes away', () => {
    const { create, spy } = stubWorker()
    const { unmount } = renderHook(() =>
      useEmbedSimulation(BELL, { createWorker: create })
    )

    unmount()

    expect(spy.terminated()).toBeGreaterThan(0)
  })

  it('starts nothing while there is no circuit', () => {
    const { create, spy } = stubWorker()
    const { result } = renderHook(() =>
      useEmbedSimulation(null, { createWorker: create })
    )

    expect(spy.sent).toHaveLength(0)
    expect(result.current.status).toBe('running')
  })
})
