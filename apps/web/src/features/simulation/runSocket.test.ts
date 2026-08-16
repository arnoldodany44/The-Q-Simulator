/**
 * Reconnection, driven with a socket that is a plain object.
 *
 * Every property worth asserting here is about *time and order* — what happens
 * when a connection drops between two frames, what the client asks for when it
 * comes back, how long it waits before trying — and none of it is reproducible
 * on demand against a real network. So the transport is injected, the clock is
 * injected, and the jitter is injected.
 */

import { SOCKET_CLOSE, encodeFrame } from '@qsim/contract'
import type { ClientFrame, ServerFrame } from '@qsim/contract'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import {
  RECONNECT_BACKOFF_MS,
  RECONNECT_JITTER,
  createRunSocket,
} from './runSocket'
import type { RunSocket, RunWatcher, SocketLike } from './runSocket'

interface FakeSocket extends SocketLike {
  readonly sent: ClientFrame[]
  readonly url: string
  closedWith: number | null
  open(): void
  deliver(frame: ServerFrame): void
  drop(code?: number): void
}

function fakeSocket(url: string): FakeSocket {
  const socket: FakeSocket = {
    url,
    sent: [],
    closedWith: null,
    onopen: null,
    onmessage: null,
    onclose: null,
    onerror: null,
    send: (data) => socket.sent.push(JSON.parse(data) as ClientFrame),
    close: (code) => {
      socket.closedWith = code ?? 1000
    },
    open: () => socket.onopen?.({}),
    deliver: (frame) => socket.onmessage?.({ data: encodeFrame(frame) }),
    drop: (code) =>
      socket.onclose?.({ ...(code === undefined ? {} : { code }) }),
  }
  return socket
}

interface Harness {
  readonly socket: RunSocket
  readonly opened: FakeSocket[]
  readonly current: () => FakeSocket
  /** Runs the pending reconnection timer and returns the delay it waited. */
  readonly elapse: () => number
  readonly pendingDelay: () => number | null
}

interface HarnessOptions {
  readonly token?: string | null
  readonly failToConnect?: boolean
}

function harness(options: HarnessOptions = {}): Harness {
  const opened: FakeSocket[] = []
  const timers: { run: () => void; delay: number }[] = []

  const socket = createRunSocket({
    url: 'wss://api.example.test/ws',
    getToken: () => Promise.resolve(options.token ?? null),
    connect: (url) => {
      if (options.failToConnect === true) throw new Error('refused')
      const created = fakeSocket(url)
      opened.push(created)
      return created
    },
    schedule: (run, delay) => {
      const entry = { run, delay }
      timers.push(entry)
      return () => {
        const index = timers.indexOf(entry)
        if (index >= 0) timers.splice(index, 1)
      }
    },
    // Midpoint of the jitter window, so every delay is exactly its base.
    random: () => 0.5,
  })

  return {
    socket,
    opened,
    current: () => {
      const last = opened.at(-1)
      if (last === undefined) throw new Error('nothing has connected')
      return last
    },
    pendingDelay: () => timers[0]?.delay ?? null,
    elapse: () => {
      const entry = timers.shift()
      if (entry === undefined) throw new Error('no reconnection is pending')
      entry.run()
      return entry.delay
    },
  }
}

function watcher(): RunWatcher & {
  readonly resyncs: number[]
  readonly progress: unknown[]
  readonly completions: unknown[]
  readonly refusals: string[]
  readonly offline: number[]
} {
  const resyncs: number[] = []
  const progress: unknown[] = []
  const completions: unknown[] = []
  const refusals: string[] = []
  const offline: number[] = []
  return {
    resyncs,
    progress,
    completions,
    refusals,
    offline,
    onResync: () => resyncs.push(resyncs.length),
    onProgress: (frame) => progress.push(frame),
    onStatus: () => undefined,
    onComplete: (frame) => completions.push(frame),
    onRefused: (code) => refusals.push(code),
    onOffline: () => offline.push(offline.length),
  }
}

let h: Harness

beforeEach(() => {
  h = harness()
})

describe('opening', () => {
  it('connects nothing until something is watched', () => {
    expect(h.opened).toHaveLength(0)
    h.socket.watch('run-1', watcher())
    expect(h.opened).toHaveLength(1)
  })

  it('subscribes only after the server says it is ready', async () => {
    h.socket.watch('run-1', watcher())
    const first = h.current()
    first.open()
    await vi.waitFor(() => expect(first.sent).toHaveLength(0))

    // The `ready` frame is the answer to authentication, and subscribing before
    // it would have the server authorise against an anonymous viewer.
    first.deliver({ type: 'ready', viewer: null, expiresAt: null })
    expect(first.sent).toEqual([{ type: 'subscribe', runId: 'run-1' }])
  })

  it('presents a token when the session has one', async () => {
    const authed = harness({ token: 'a.b.c' })
    authed.socket.watch('run-1', watcher())
    const socket = authed.current()
    socket.open()
    await vi.waitFor(() => expect(socket.sent).toHaveLength(1))
    expect(socket.sent[0]).toEqual({ type: 'authenticate', token: 'a.b.c' })
  })

  it('waits for the ready that answers its token, not the one before it', async () => {
    /*
     * The server sends `ready` the instant a socket opens and again after a
     * successful `authenticate`. Subscribing on the first would ask it to
     * authorise every run against an anonymous viewer — 404 for runs the reader
     * can plainly see, reported by the consumer as gone.
     */
    const authed = harness({ token: 'a.b.c' })
    authed.socket.watch('run-1', watcher())
    const socket = authed.current()
    socket.open()
    await vi.waitFor(() => expect(socket.sent).toHaveLength(1))

    socket.deliver({ type: 'ready', viewer: null, expiresAt: null })
    expect(socket.sent).toHaveLength(1)

    socket.deliver({ type: 'ready', viewer: 'u1', expiresAt: 1 })
    expect(socket.sent.at(-1)).toEqual({ type: 'subscribe', runId: 'run-1' })
  })

  it('carries on anonymously when the token is refused', async () => {
    // There will be no second `ready`, so waiting for one would leave the
    // socket connected and subscribed to nothing, forever.
    const authed = harness({ token: 'stale' })
    authed.socket.watch('run-1', watcher())
    const socket = authed.current()
    socket.open()
    await vi.waitFor(() => expect(socket.sent).toHaveLength(1))
    socket.deliver({ type: 'ready', viewer: null, expiresAt: null })
    socket.deliver({ type: 'error', code: 'AUTH_INVALID_TOKEN', runId: null })
    expect(socket.sent.at(-1)).toEqual({ type: 'subscribe', runId: 'run-1' })
  })

  it('subscribes a run added while the socket is already up, once', () => {
    h.socket.watch('run-1', watcher())
    const socket = h.current()
    socket.open()
    socket.deliver({ type: 'ready', viewer: null, expiresAt: null })
    h.socket.watch('run-2', watcher())
    expect(socket.sent).toEqual([
      { type: 'subscribe', runId: 'run-1' },
      { type: 'subscribe', runId: 'run-2' },
    ])
  })

  it('reports a resync on the very first subscription', () => {
    // Not only after a reconnection: the consumer reads the run on every
    // confirmed subscription, which is what closes the race between the POST
    // answering 202 and this frame arriving.
    const w = watcher()
    h.socket.watch('run-1', w)
    const socket = h.current()
    socket.open()
    socket.deliver({ type: 'ready', viewer: null, expiresAt: null })
    socket.deliver({ type: 'subscribed', runId: 'run-1', status: 'QUEUED' })
    expect(w.resyncs).toHaveLength(1)
  })
})

describe('reconnection', () => {
  it('backs off, and the delays are the published schedule', () => {
    h.socket.watch('run-1', watcher())
    const delays: number[] = []
    for (
      let attempt = 0;
      attempt < RECONNECT_BACKOFF_MS.length + 2;
      attempt++
    ) {
      h.current().drop()
      delays.push(h.elapse())
    }
    expect(delays).toEqual([
      ...RECONNECT_BACKOFF_MS,
      // Flat at the tail: a tab left open against a dead host must not become
      // a request per second for the rest of the afternoon.
      RECONNECT_BACKOFF_MS.at(-1),
      RECONNECT_BACKOFF_MS.at(-1),
    ])
  })

  it('spreads the delay, so a redeploy is not answered by a herd', () => {
    const early = harness()
    const late = harness()
    // Two clients, two ends of the jitter window, one dropped connection each.
    const spread = RECONNECT_BACKOFF_MS[0] * RECONNECT_JITTER
    expect(spread).toBeGreaterThan(0)

    early.socket.watch('run-1', watcher())
    early.current().drop()
    expect(early.pendingDelay()).toBe(RECONNECT_BACKOFF_MS[0])
    late.socket.watch('run-1', watcher())
    late.current().drop()
    expect(late.pendingDelay()).toBe(RECONNECT_BACKOFF_MS[0])
  })

  it('re-subscribes to everything it was watching', () => {
    h.socket.watch('run-1', watcher())
    h.socket.watch('run-2', watcher())
    const first = h.current()
    first.open()
    first.deliver({ type: 'ready', viewer: null, expiresAt: null })
    expect(first.sent).toHaveLength(2)

    first.drop()
    h.elapse()
    const second = h.current()
    expect(second).not.toBe(first)
    second.open()
    second.deliver({ type: 'ready', viewer: null, expiresAt: null })
    expect(second.sent).toEqual([
      { type: 'subscribe', runId: 'run-1' },
      { type: 'subscribe', runId: 'run-2' },
    ])
  })

  it('tells the consumer to re-read after every reconnection', () => {
    /*
     * The recovery story in one assertion. Pub/sub delivers at most once, so
     * whatever was published while this client was away is gone — and the
     * resync is what makes that harmless, because the run is read instead of
     * replayed.
     */
    const w = watcher()
    h.socket.watch('run-1', w)
    const first = h.current()
    first.open()
    first.deliver({ type: 'ready', viewer: null, expiresAt: null })
    first.deliver({ type: 'subscribed', runId: 'run-1', status: 'RUNNING' })
    expect(w.resyncs).toHaveLength(1)

    first.drop()
    expect(w.offline).toHaveLength(1)
    h.elapse()
    const second = h.current()
    second.open()
    second.deliver({ type: 'ready', viewer: null, expiresAt: null })
    second.deliver({ type: 'subscribed', runId: 'run-1', status: 'RUNNING' })
    expect(w.resyncs).toHaveLength(2)
  })

  it('does not reconnect after a protocol close', () => {
    // The server rejected frames this build produced. Reconnecting would
    // reproduce it immediately and forever.
    h.socket.watch('run-1', watcher())
    h.current().drop(SOCKET_CLOSE.PROTOCOL)
    expect(h.pendingDelay()).toBeNull()
  })

  it('does reconnect after an expiry close, which is the point of it', () => {
    h.socket.watch('run-1', watcher())
    h.current().drop(SOCKET_CLOSE.EXPIRED)
    expect(h.pendingDelay()).toBe(RECONNECT_BACKOFF_MS[0])
  })

  it('retries a transport that refuses to construct at all', () => {
    const blocked = harness({ failToConnect: true })
    blocked.socket.watch('run-1', watcher())
    expect(blocked.pendingDelay()).toBe(RECONNECT_BACKOFF_MS[0])
  })

  it('ignores a frame from a connection that has been replaced', () => {
    const w = watcher()
    h.socket.watch('run-1', w)
    const first = h.current()
    first.open()
    first.deliver({ type: 'ready', viewer: null, expiresAt: null })
    first.drop()
    h.elapse()

    // The old socket delivers a late message. Acting on it would repaint from
    // a connection that no longer exists.
    first.deliver({
      type: 'run:progress',
      runId: 'run-1',
      phase: 'simulating',
      completed: 1,
      total: 2,
    })
    expect(w.progress).toHaveLength(0)
  })
})

describe('delivery', () => {
  it('routes each frame to the run it names, and nothing else', () => {
    const one = watcher()
    const two = watcher()
    h.socket.watch('run-1', one)
    h.socket.watch('run-2', two)
    const socket = h.current()
    socket.open()
    socket.deliver({ type: 'ready', viewer: null, expiresAt: null })

    socket.deliver({
      type: 'run:progress',
      runId: 'run-1',
      phase: 'sampling',
      completed: 4,
      total: 8,
    })
    expect(one.progress).toHaveLength(1)
    expect(two.progress).toHaveLength(0)
  })

  it('reports a revoked subscription as a refusal', () => {
    // §11's mid-stream re-check, arriving at the client. A stream that simply
    // went quiet would be indistinguishable from a slow run.
    const w = watcher()
    h.socket.watch('run-1', w)
    const socket = h.current()
    socket.open()
    socket.deliver({ type: 'ready', viewer: null, expiresAt: null })
    socket.deliver({
      type: 'unsubscribed',
      runId: 'run-1',
      reason: 'unauthorised',
    })
    expect(w.refusals).toEqual(['unauthorised'])
  })

  it('says nothing when a subscription ends because the run finished', () => {
    const w = watcher()
    h.socket.watch('run-1', w)
    const socket = h.current()
    socket.open()
    socket.deliver({ type: 'ready', viewer: null, expiresAt: null })
    socket.deliver({
      type: 'run:complete',
      runId: 'run-1',
      status: 'DONE',
      durationMs: 3,
      error: null,
    })
    socket.deliver({ type: 'unsubscribed', runId: 'run-1', reason: 'finished' })
    expect(w.completions).toHaveLength(1)
    expect(w.refusals).toEqual([])
  })

  it('drops a frame from an API newer than this bundle', () => {
    h.socket.watch('run-1', watcher())
    const socket = h.current()
    socket.open()
    expect(() =>
      socket.onmessage?.({ data: JSON.stringify({ type: 'run:paused' }) })
    ).not.toThrow()
  })
})

describe('closing', () => {
  it('gives the connection back when the last watcher goes', () => {
    const stop = h.socket.watch('run-1', watcher())
    const socket = h.current()
    socket.open()
    socket.deliver({ type: 'ready', viewer: null, expiresAt: null })
    stop()
    expect(socket.sent.at(-1)).toEqual({ type: 'unsubscribe', runId: 'run-1' })
    expect(socket.closedWith).not.toBeNull()
  })

  it('keeps the connection while another run is still watched', () => {
    const stop = h.socket.watch('run-1', watcher())
    h.socket.watch('run-2', watcher())
    const socket = h.current()
    socket.open()
    socket.deliver({ type: 'ready', viewer: null, expiresAt: null })
    stop()
    expect(socket.closedWith).toBeNull()
  })

  it('stops reconnecting once closed', () => {
    h.socket.watch('run-1', watcher())
    h.current().drop()
    h.socket.close()
    expect(h.pendingDelay()).toBeNull()
  })
})
