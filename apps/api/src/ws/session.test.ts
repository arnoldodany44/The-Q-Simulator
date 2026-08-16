/**
 * The socket's behaviour, driven with no socket.
 *
 * Every test here is a *sequence*, which is the whole reason `session.ts` has
 * no `ws` in it: the failures worth pinning are "a frame arrived before
 * another", "an authorisation was true and stopped being true", "a completion
 * raced a subscription". None of those is reproducible on demand through a real
 * connection, and a bug that cannot be reproduced never gets a regression test.
 */

import {
  MAX_SOCKET_FRAMES_PER_WINDOW,
  MAX_SOCKET_SUBSCRIPTIONS,
  SOCKET_CLOSE,
  encodeFrame,
} from '@qsim/contract'
import type { ClientFrame, ServerFrame } from '@qsim/contract'
import type { RunEvent, RunStatus } from '@qsim/jobs'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  AUTHORISATION_TTL_MS,
  IDLE_TIMEOUT_MS,
  MAX_PROTOCOL_VIOLATIONS,
  createSocketSession,
} from './session.js'
import type { ReadableRun, SocketSession } from './session.js'

const OWNER = '11111111-1111-4111-8111-111111111111'
const STRANGER = '22222222-2222-4222-8222-222222222222'

interface Harness {
  readonly session: SocketSession
  readonly sent: ServerFrame[]
  readonly closed: number[]
  /** Publishes as the worker would, to whatever is subscribed. */
  readonly publish: (event: RunEvent) => void
  /**
   * Publishes on one run's channel a payload that names another.
   *
   * Only a publisher holding the Redis connection string can do this, which is
   * why it needs a door of its own here: the worker always derives its channel
   * from the same variable as its payload.
   */
  readonly publishTo: (channel: string, event: RunEvent) => void
  readonly send: (frame: ClientFrame) => Promise<void>
  /** Advances the session's clock without waiting for one. */
  readonly advance: (ms: number) => void
  /** What `readRun` answers, per viewer. `null` means "not readable". */
  readonly visibility: Map<string, ReadableRun | null>
  readonly reads: string[]
  readonly channels: Set<string>
}

interface HarnessOptions {
  readonly runs?: Record<string, ReadableRun | null>
  readonly subscribable?: boolean
  readonly busFails?: boolean
  readonly identity?: { userId: string; expiresAt: number } | null
  readonly verifies?: string | null
}

function key(runId: string, viewerId: string | null): string {
  return `${runId}::${viewerId ?? ''}`
}

function harness(options: HarnessOptions = {}): Harness {
  const sent: ServerFrame[] = []
  const closed: number[] = []
  const reads: string[] = []
  const visibility = new Map<string, ReadableRun | null>()
  const listeners = new Map<string, (event: RunEvent) => void>()
  const channels = new Set<string>()
  let clock = 1_000_000

  for (const [runId, run] of Object.entries(options.runs ?? {})) {
    // Readable by everybody unless a test says otherwise, which it does by
    // writing a viewer-scoped entry over the top.
    for (const viewer of [null, OWNER, STRANGER]) {
      visibility.set(key(runId, viewer), run)
    }
  }

  const session = createSocketSession({
    identity: options.identity ?? null,
    send: (frame) => sent.push(frame),
    close: (code) => closed.push(code),
    verify: (token) => {
      const userId = options.verifies ?? OWNER
      if (token === 'bad') return Promise.reject(new Error('nope'))
      return Promise.resolve({
        userId: token === 'other' ? STRANGER : userId,
        // Seconds since the epoch, as `exp` is.
        expiresAt: Math.floor(clock / 1000) + 3600,
      })
    },
    readRun: (runId, viewerId) => {
      reads.push(key(runId, viewerId))
      return Promise.resolve(visibility.get(key(runId, viewerId)) ?? null)
    },
    subscribe:
      options.subscribable === false
        ? null
        : (runId, listener) => {
            if (options.busFails === true) {
              return Promise.reject(new Error('bus down'))
            }
            listeners.set(runId, listener)
            channels.add(runId)
            return Promise.resolve(() => {
              listeners.delete(runId)
              channels.delete(runId)
            })
          },
    now: () => clock,
    log: () => undefined,
  })

  return {
    session,
    sent,
    closed,
    reads,
    visibility,
    channels,
    publish: (event) => listeners.get(event.runId)?.(event),
    publishTo: (channel, event) => listeners.get(channel)?.(event),
    send: (frame) => session.receive(encodeFrame(frame)),
    advance: (ms) => {
      clock += ms
    },
  }
}

function typesOf(frames: readonly ServerFrame[]): string[] {
  return frames.map((frame) => frame.type)
}

function running(status: RunStatus = 'RUNNING'): ReadableRun {
  return { status }
}

describe('opening a socket', () => {
  it('answers `ready` immediately, anonymously', () => {
    const { sent } = harness()
    expect(sent).toEqual([{ type: 'ready', viewer: null, expiresAt: null }])
  })

  it('carries an identity the upgrade request already proved', () => {
    const { sent } = harness({
      identity: { userId: OWNER, expiresAt: 2_000 },
    })
    expect(sent[0]).toEqual({
      type: 'ready',
      viewer: OWNER,
      // `exp` is seconds; the frame is milliseconds.
      expiresAt: 2_000_000,
    })
  })
})

describe('authentication', () => {
  it('reports the viewer a token proved', async () => {
    const h = harness()
    await h.send({ type: 'authenticate', token: 'good' })
    expect(h.sent.at(-1)).toMatchObject({ type: 'ready', viewer: OWNER })
  })

  it('answers a bad token with a code and leaves the socket open', async () => {
    const h = harness()
    await h.send({ type: 'authenticate', token: 'bad' })
    expect(h.sent.at(-1)).toEqual({
      type: 'error',
      code: 'AUTH_INVALID_TOKEN',
      runId: null,
    })
    expect(h.closed).toEqual([])
  })

  it('accepts a refreshed token for the same subject', async () => {
    const h = harness()
    await h.send({ type: 'authenticate', token: 'good' })
    h.advance(1_000)
    await h.send({ type: 'authenticate', token: 'good-again' })
    expect(h.closed).toEqual([])
    expect(h.sent.at(-1)).toMatchObject({ type: 'ready', viewer: OWNER })
  })

  it('closes a socket that presents a second identity', async () => {
    // Every subscription already open was authorised against the first viewer,
    // and there is no honest way to reconcile that.
    const h = harness()
    await h.send({ type: 'authenticate', token: 'good' })
    await h.send({ type: 'authenticate', token: 'other' })
    expect(h.closed).toEqual([SOCKET_CLOSE.PROTOCOL])
  })
})

describe('subscribing', () => {
  it('confirms with the run’s status at that instant', async () => {
    const h = harness({ runs: { r1: running('QUEUED') } })
    await h.send({ type: 'subscribe', runId: 'r1' })
    expect(h.sent.at(-1)).toEqual({
      type: 'subscribed',
      runId: 'r1',
      status: 'QUEUED',
    })
  })

  it('opens no channel for a run that already finished', async () => {
    /*
     * The common case for a small run: it finished inside the synchronous
     * window while the socket was still opening. The `subscribed` frame with a
     * terminal status is what tells the client to read the run instead of
     * waiting for events that will never come.
     */
    const h = harness({ runs: { r1: running('DONE') } })
    await h.send({ type: 'subscribe', runId: 'r1' })
    expect(h.sent.at(-1)).toEqual({
      type: 'subscribed',
      runId: 'r1',
      status: 'DONE',
    })
    expect([...h.channels]).toEqual([])
    expect(h.session.subscriptionCount()).toBe(0)
  })

  it('answers 404 — not 403 — for a run this viewer may not see', async () => {
    const h = harness({ runs: { r1: running() } })
    h.visibility.set(key('r1', null), null)
    await h.send({ type: 'subscribe', runId: 'r1' })
    expect(h.sent.at(-1)).toEqual({
      type: 'error',
      code: 'NOT_FOUND',
      runId: 'r1',
    })
    expect([...h.channels]).toEqual([])
  })

  it('asks the visibility question with the viewer the socket proved', async () => {
    const h = harness({ runs: { r1: running() } })
    h.visibility.set(key('r1', null), null)

    await h.send({ type: 'subscribe', runId: 'r1' })
    expect(h.sent.at(-1)).toMatchObject({ code: 'NOT_FOUND' })

    await h.send({ type: 'authenticate', token: 'good' })
    await h.send({ type: 'subscribe', runId: 'r1' })
    expect(h.sent.at(-1)).toMatchObject({ type: 'subscribed', runId: 'r1' })
    // The same run id, two different questions, because the viewer changed.
    expect(h.reads).toEqual([key('r1', null), key('r1', OWNER)])
  })

  it('is idempotent, so a reconnecting client is not punished', async () => {
    const h = harness({ runs: { r1: running() } })
    await h.send({ type: 'subscribe', runId: 'r1' })
    await h.send({ type: 'subscribe', runId: 'r1' })
    expect(h.session.subscriptionCount()).toBe(1)
    expect(
      typesOf(h.sent).filter((type) => type === 'subscribed')
    ).toHaveLength(2)
  })

  it('refuses past the per-socket ceiling', async () => {
    const runs: Record<string, ReadableRun> = {}
    for (let index = 0; index < 12; index++)
      runs[`r${String(index)}`] = running()
    const h = harness({ runs })
    for (let index = 0; index < 12; index++) {
      await h.send({ type: 'subscribe', runId: `r${String(index)}` })
    }
    expect(h.sent.at(-1)).toEqual({
      type: 'error',
      code: 'RATE_LIMITED',
      runId: 'r11',
    })
    expect(h.session.subscriptionCount()).toBe(8)
  })

  it('says the queue is unavailable when there is no bus', async () => {
    const h = harness({ runs: { r1: running() }, subscribable: false })
    await h.send({ type: 'subscribe', runId: 'r1' })
    expect(h.sent.at(-1)).toEqual({
      type: 'error',
      code: 'SIMULATION_UNAVAILABLE',
      runId: 'r1',
    })
  })

  it('keeps the socket usable when the bus refuses', async () => {
    const h = harness({ runs: { r1: running() }, busFails: true })
    await h.send({ type: 'subscribe', runId: 'r1' })
    expect(h.sent.at(-1)).toMatchObject({ code: 'SIMULATION_UNAVAILABLE' })
    expect(h.closed).toEqual([])
    // And it left nothing behind that would count against the ceiling.
    expect(h.session.subscriptionCount()).toBe(0)
  })
})

describe('delivery', () => {
  let h: Harness

  beforeEach(async () => {
    h = harness({ runs: { r1: running() } })
    await h.send({ type: 'subscribe', runId: 'r1' })
    h.sent.length = 0
  })

  it('turns a worker event into the frame §8 names', async () => {
    h.publish({
      type: 'run:progress',
      runId: 'r1',
      at: 10,
      progress: { phase: 'simulating', completed: 3, total: 10 },
    })
    await vi.waitFor(() => expect(h.sent).toHaveLength(1))
    expect(h.sent[0]).toEqual({
      type: 'run:progress',
      runId: 'r1',
      phase: 'simulating',
      completed: 3,
      total: 10,
    })
  })

  it('releases the channel once the run completes', async () => {
    h.publish({
      type: 'run:complete',
      runId: 'r1',
      at: 20,
      status: 'DONE',
      durationMs: 7,
      error: null,
    })
    await vi.waitFor(() => expect(typesOf(h.sent)).toContain('unsubscribed'))
    expect(h.sent).toEqual([
      {
        type: 'run:complete',
        runId: 'r1',
        status: 'DONE',
        durationMs: 7,
        error: null,
      },
      { type: 'unsubscribed', runId: 'r1', reason: 'finished' },
    ])
    expect([...h.channels]).toEqual([])
  })

  it('drops an event older than one already delivered', async () => {
    // Pub/sub promises nothing about order across a reconnect, and a progress
    // bar that goes backwards is a bar the reader stops believing.
    h.publish({
      type: 'run:progress',
      runId: 'r1',
      at: 100,
      progress: { phase: 'simulating', completed: 9, total: 10 },
    })
    await vi.waitFor(() => expect(h.sent).toHaveLength(1))
    h.publish({
      type: 'run:progress',
      runId: 'r1',
      at: 50,
      progress: { phase: 'validating', completed: null, total: null },
    })
    await vi.waitFor(() => expect(h.sent).toHaveLength(1))
    expect(h.sent[0]).toMatchObject({ completed: 9 })
  })
})

describe('authorisation is kept true, not merely checked once', () => {
  it('ends a subscription whose run stopped being readable mid-stream', async () => {
    /*
     * THE TEST THIS FILE EXISTS FOR, from the stranger's side. An anonymous run
     * over a PUBLIC circuit is readable by whoever holds its id; the owner then
     * makes that circuit private, and `simulationRunFilter` stops matching. A
     * socket that authorised once would go on delivering past a revocation the
     * owner believes took effect.
     */
    const h = harness({ runs: { r1: running() } })
    await h.send({ type: 'subscribe', runId: 'r1' })
    h.sent.length = 0

    h.publish({
      type: 'run:progress',
      runId: 'r1',
      at: 1,
      progress: { phase: 'simulating', completed: null, total: null },
    })
    await vi.waitFor(() => expect(h.sent).toHaveLength(1))

    // The circuit is unpublished. Nothing about the socket changed.
    h.visibility.set(key('r1', null), null)

    // Inside the TTL the cached decision still stands, which is the cost this
    // design accepts deliberately — see the header of session.ts.
    h.publish({
      type: 'run:progress',
      runId: 'r1',
      at: 2,
      progress: { phase: 'simulating', completed: 1, total: 10 },
    })
    await vi.waitFor(() => expect(h.sent).toHaveLength(2))

    h.advance(AUTHORISATION_TTL_MS + 1)
    h.publish({
      type: 'run:complete',
      runId: 'r1',
      at: 3,
      status: 'DONE',
      durationMs: 4,
      error: null,
    })

    await vi.waitFor(() => expect(typesOf(h.sent)).toContain('unsubscribed'))
    expect(h.sent.at(-1)).toEqual({
      type: 'unsubscribed',
      runId: 'r1',
      reason: 'unauthorised',
    })
    // The completion itself never went out, and the channel is released.
    expect(typesOf(h.sent)).not.toContain('run:complete')
    expect([...h.channels]).toEqual([])
  })

  it('re-checks at most once per TTL, not once per event', async () => {
    // `DATABASE_URL` carries connection_limit=1. A query per event would queue
    // socket traffic behind the gallery on a pool of one.
    const h = harness({ runs: { r1: running() } })
    await h.send({ type: 'subscribe', runId: 'r1' })
    const before = h.reads.length

    for (let index = 0; index < 5; index++) {
      h.publish({
        type: 'run:progress',
        runId: 'r1',
        at: index + 1,
        progress: { phase: 'simulating', completed: index, total: 10 },
      })
      // Delivered one at a time, so none is dropped as superseded.
      await vi.waitFor(() => expect(h.sent.length).toBeGreaterThan(index + 1))
    }
    expect(h.reads.length).toBe(before)

    h.advance(AUTHORISATION_TTL_MS + 1)
    h.publish({
      type: 'run:progress',
      runId: 'r1',
      at: 99,
      progress: { phase: 'sampling', completed: 1, total: 2 },
    })
    await vi.waitFor(() => expect(h.reads.length).toBe(before + 1))
  })
})

describe('bounds', () => {
  it('closes after a handful of frames this protocol does not define', async () => {
    const h = harness()
    for (let index = 0; index < MAX_PROTOCOL_VIOLATIONS; index++) {
      await h.session.receive('not a frame')
    }
    expect(h.closed).toEqual([SOCKET_CLOSE.PROTOCOL])
    expect(typesOf(h.sent).filter((type) => type === 'error')).toHaveLength(
      MAX_PROTOCOL_VIOLATIONS
    )
  })

  it('tolerates one unknown frame, because a rollout produces them', async () => {
    const h = harness()
    await h.session.receive(JSON.stringify({ type: 'from-a-newer-build' }))
    expect(h.closed).toEqual([])
  })

  it('closes a socket whose token expired', async () => {
    const h = harness()
    await h.send({ type: 'authenticate', token: 'good' })
    h.advance(3_600_000 + 1)
    h.session.sweep()
    expect(h.closed).toEqual([SOCKET_CLOSE.EXPIRED])
  })

  it('closes a socket that has sat with nothing subscribed', () => {
    const h = harness()
    h.advance(IDLE_TIMEOUT_MS + 1)
    h.session.sweep()
    expect(h.closed).toEqual([SOCKET_CLOSE.IDLE])
  })

  it('leaves a watching socket alone however quiet it is', async () => {
    const h = harness({ runs: { r1: running() } })
    await h.send({ type: 'subscribe', runId: 'r1' })
    h.advance(IDLE_TIMEOUT_MS * 10)
    h.session.sweep()
    expect(h.closed).toEqual([])
  })

  it('keeps an idle socket alive when the client says to', async () => {
    const h = harness()
    h.advance(IDLE_TIMEOUT_MS - 1)
    await h.send({ type: 'ping' })
    expect(h.sent.at(-1)).toEqual({ type: 'pong' })
    h.advance(IDLE_TIMEOUT_MS - 1)
    h.session.sweep()
    expect(h.closed).toEqual([])
  })

  it('closes a socket that sends more frames than its budget allows', async () => {
    /*
     * The upgrade is rate limited once and a socket is a request that never
     * ends. Without this, one connection buys unlimited `readRun` calls on a
     * pool of one — every one of them a well-formed frame, so the
     * protocol-violation counter never sees them.
     */
    const h = harness({ runs: { r1: running() } })
    for (let index = 0; index <= MAX_SOCKET_FRAMES_PER_WINDOW; index++) {
      await h.send({ type: 'ping' })
    }
    expect(h.closed).toEqual([SOCKET_CLOSE.OVERLOADED])
  })

  it('charges the ceiling before the database, not after', async () => {
    /*
     * A socket already watching all it may is told so without a query. The
     * ordering used to be the other way round, which meant a client at its
     * ceiling still paid one round trip per frame for as long as it kept
     * asking.
     */
    const runs: Record<string, ReadableRun> = {}
    for (let index = 0; index < MAX_SOCKET_SUBSCRIPTIONS; index++) {
      runs[`r${String(index)}`] = running()
    }
    const h = harness({ runs: { ...runs, extra: running() } })
    for (let index = 0; index < MAX_SOCKET_SUBSCRIPTIONS; index++) {
      await h.send({ type: 'subscribe', runId: `r${String(index)}` })
    }
    const reads = h.reads.length

    await h.send({ type: 'subscribe', runId: 'extra' })
    expect(h.sent.at(-1)).toEqual({
      type: 'error',
      code: 'RATE_LIMITED',
      runId: 'extra',
    })
    expect(h.reads.length).toBe(reads)
  })
})

describe('an expired credential', () => {
  /*
   * `exp` is a hard boundary and not a hint the sweep timer will get to. What
   * this group pins is that authority ends at the *frame*: expiry used to be
   * enforced only on a fifteen-second timer, so a dead token still bought new
   * subscriptions to that user's private runs.
   */
  const HOUR_MS = 3_600_000

  it('buys no new subscription to a private run', async () => {
    const h = harness({ runs: { secret: running() } })
    await h.send({ type: 'authenticate', token: 'good' })
    h.advance(HOUR_MS + 1)

    await h.send({ type: 'subscribe', runId: 'secret' })

    expect(typesOf(h.sent)).not.toContain('subscribed')
    expect(h.closed).toEqual([SOCKET_CLOSE.EXPIRED])
    // Not even a read: the credential is dead before the question is asked.
    expect(h.reads).toEqual([])
  })

  it('stops the events already flowing, without waiting for a sweep', async () => {
    const h = harness({ runs: { r1: running() } })
    await h.send({ type: 'authenticate', token: 'good' })
    await h.send({ type: 'subscribe', runId: 'r1' })
    const before = h.sent.length

    h.advance(HOUR_MS + 1)
    h.publish({
      type: 'run:progress',
      runId: 'r1',
      at: 1,
      progress: { phase: 'simulating', completed: 1, total: 10 },
    })
    await vi.waitFor(() => expect(h.closed).toEqual([SOCKET_CLOSE.EXPIRED]))
    expect(h.sent.length).toBe(before)
  })
})

describe('an event that names another run', () => {
  it('is not delivered, and does not end the subscription it arrived on', async () => {
    /*
     * Only a publisher holding the connection string can produce this, which
     * makes it defence in depth rather than a live hole — but the two effects
     * are sharp: a frame naming a run this socket was refused, carrying that
     * run's terminal status, and a `finished` teardown of a subscription whose
     * own run is still going.
     */
    const h = harness({ runs: { mine: running() } })
    h.visibility.set('theirs::', null)
    await h.send({ type: 'subscribe', runId: 'mine' })
    const before = h.sent.length

    h.publishTo('mine', {
      type: 'run:complete',
      runId: 'theirs',
      at: 2,
      status: 'FAILED',
      durationMs: 1234,
      error: 'ENGINE_FAILED',
    })
    await Promise.resolve()
    await Promise.resolve()

    expect(h.sent.length).toBe(before)
    expect([...h.channels]).toEqual(['mine'])
  })
})

describe('closing', () => {
  it('releases every channel', async () => {
    const h = harness({ runs: { r1: running(), r2: running() } })
    await h.send({ type: 'subscribe', runId: 'r1' })
    await h.send({ type: 'subscribe', runId: 'r2' })
    expect([...h.channels]).toHaveLength(2)
    await h.session.close()
    expect([...h.channels]).toEqual([])
  })

  it('sends nothing after the socket is gone', async () => {
    const h = harness({ runs: { r1: running() } })
    await h.send({ type: 'subscribe', runId: 'r1' })
    const publish = h.publish
    await h.session.close()
    h.sent.length = 0
    publish({
      type: 'run:complete',
      runId: 'r1',
      at: 1,
      status: 'DONE',
      durationMs: 1,
      error: null,
    })
    await Promise.resolve()
    expect(h.sent).toEqual([])
  })

  it('drops a run when the client unsubscribes', async () => {
    const h = harness({ runs: { r1: running() } })
    await h.send({ type: 'subscribe', runId: 'r1' })
    await h.send({ type: 'unsubscribe', runId: 'r1' })
    expect([...h.channels]).toEqual([])
    expect(h.session.subscriptionCount()).toBe(0)
  })
})
