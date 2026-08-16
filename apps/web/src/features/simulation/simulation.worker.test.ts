import { parseCircuit, type Circuit } from '@qsim/schema'
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
} from 'vitest'

import type { SimulationRequest, SimulationResponse } from './protocol'
import {
  createSimulationScheduler,
  type SimulationScheduler,
} from './scheduler'

/**
 * The worker's message loop, driven without a worker.
 *
 * jsdom has no `Worker`, but it does not need one: the module installs its
 * handler on `globalThis` and answers through `globalThis.postMessage`, so
 * both ends can be stood in for. What is pinned here is the one property only
 * this loop can break — **every simulate request terminates in exactly one
 * posted response** — and it matters because the alternative is invisible. An
 * exception escaping the loop as a rejected promise does not fire
 * `worker.onerror`, so nothing reaches the main thread and the editor waits
 * forever on an answer that was already thrown away.
 *
 * The assertions therefore end at a real scheduler rather than at the posted
 * message: `status === 'error'` is the user-visible property, and `'running'`
 * forever is the defect.
 */

/** A request `runJob` cannot even start on: it reads `circuit.qubits` first. */
function withoutCircuit(request: SimulationRequest): SimulationRequest {
  return { ...request, circuit: undefined } as unknown as SimulationRequest
}

function malformed(id: number): SimulationRequest {
  return withoutCircuit({
    kind: 'simulate',
    id,
    mode: 'analytic',
    circuit: bell(),
    fromColumn: 0,
    sharedMemory: false,
    throughColumn: null,
    sample: null,
    noise: null,
  })
}

function bell(): Circuit {
  return parseCircuit({
    schemaVersion: 1,
    qubits: 2,
    operations: [
      { id: 'a', gate: 'h', targets: [0], column: 0 },
      { id: 'b', gate: 'cx', targets: [1], controls: [0], column: 1 },
    ],
  })
}

/** One macrotask — exactly the gap `yieldToInbox` hands back before answering. */
function settle(): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, 0)
  })
}

let posted: SimulationResponse[]
let rejections: unknown[]
let scheduler: SimulationScheduler
let corruptNext = false
let deliver: (event: { data: SimulationRequest }) => void

const realPostMessage = globalThis.postMessage

function collect(reason: unknown): void {
  rejections.push(reason)
}

beforeAll(async () => {
  // Installed before the import so the module's first `answer()` finds the
  // stand-in. jsdom's own `postMessage` has a different signature entirely.
  globalThis.postMessage = ((response: SimulationResponse) => {
    posted.push(response)
    scheduler.receive(response)
  }) as typeof globalThis.postMessage

  // The worker decides its own half of the transport once, at import: this is
  // what makes its scope claim it can share, so the tests below can ask what
  // it does when the *main thread* says it cannot.
  Object.defineProperty(globalThis, 'crossOriginIsolated', {
    configurable: true,
    value: true,
  })

  await import('./simulation.worker')
  const handler = globalThis.onmessage
  expect(handler, 'the worker installed no message handler').not.toBeNull()
  deliver = handler as unknown as (event: { data: SimulationRequest }) => void
})

afterAll(() => {
  globalThis.postMessage = realPostMessage
})

beforeEach(() => {
  posted = []
  rejections = []
  corruptNext = false
  process.on('unhandledRejection', collect)
  scheduler = createSimulationScheduler()
  scheduler.connect((request) => {
    // The id stays the scheduler's own, so a reply to a corrupted request is
    // not dropped as stale — which is the whole point of the last test.
    deliver({ data: corruptNext ? withoutCircuit(request) : request })
    corruptNext = false
  })
})

afterEach(() => {
  process.off('unhandledRejection', collect)
  scheduler.dispose()
})

describe('a request the worker cannot run', () => {
  it('comes back as one worker-failed response, not as silence', async () => {
    deliver({ data: malformed(1) })
    await settle()

    expect(posted).toHaveLength(1)
    expect(posted[0]).toMatchObject({
      kind: 'error',
      id: 1,
      failure: { code: 'worker-failed' },
    })
    expect(rejections).toEqual([])
  })

  it('leaves the loop able to answer the next request', async () => {
    deliver({ data: malformed(1) })
    await settle()
    posted.length = 0

    scheduler.schedule(bell())
    scheduler.flush()
    await settle()

    // `draining` was released and the catch sat inside the loop, so a real
    // circuit still gets a real answer afterwards.
    expect(posted).toHaveLength(1)
    expect(scheduler.getSnapshot().status).toBe('ready')
    expect(scheduler.getSnapshot().outcome?.mode).toBe('analytic')
    expect(rejections).toEqual([])
  })
})

/*
 * `sharedMemory` on the request is what the main thread says about *itself*,
 * and it is the half the worker cannot observe. The worker used to read only
 * its own scope, so a deployment isolating the document and this chunk
 * differently posted a `SharedArrayBuffer` the receiver could not accept —
 * `DataCloneError`, answered as `worker-failed`, where §5.6 promises a
 * slower run and never a broken one.
 */
describe('who decides the transport', () => {
  function transportOf(): string | null {
    return scheduler.getSnapshot().transport
  }

  it('falls back when the main thread says it cannot take a shared buffer', async () => {
    scheduler.dispose()
    scheduler = createSimulationScheduler({ sharedMemory: false })
    scheduler.connect((request) => {
      deliver({ data: request })
    })

    scheduler.schedule(bell())
    scheduler.flush()
    await settle()

    expect(scheduler.getSnapshot().status).toBe('ready')
    expect(transportOf()).toBe('transfer')
  })

  it('shares when both sides can', async () => {
    scheduler.dispose()
    scheduler = createSimulationScheduler({ sharedMemory: true })
    scheduler.connect((request) => {
      deliver({ data: request })
    })

    scheduler.schedule(bell())
    scheduler.flush()
    await settle()

    expect(scheduler.getSnapshot().status).toBe('ready')
    expect(transportOf()).toBe('shared')
  })
})

describe('what the editor sees', () => {
  it('reports an error instead of simulating forever', async () => {
    corruptNext = true
    scheduler.schedule(bell())
    expect(scheduler.getSnapshot().status).toBe('scheduled')

    scheduler.flush()
    await settle()

    // Before the fix this stayed `running` for as long as the tab was open:
    // the throw escaped as a rejected promise, which fires no `onerror` and
    // reaches the main thread as nothing at all.
    expect(scheduler.getSnapshot().status).toBe('error')
    expect(scheduler.getSnapshot().failure?.code).toBe('worker-failed')
    expect(rejections).toEqual([])
  })
})
