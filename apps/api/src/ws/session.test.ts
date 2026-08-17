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
  MAX_COLLAB_BYTES_PER_WINDOW,
  MAX_COLLAB_DOCUMENTS_PER_SOCKET,
  MAX_COLLAB_PRESENCE_PER_WINDOW,
  MAX_COLLAB_UPDATES_PER_WINDOW,
  MAX_COLLAB_UPDATE_BYTES,
  MAX_SOCKET_FRAMES_PER_WINDOW,
  MAX_SOCKET_SUBSCRIPTIONS,
  SOCKET_CLOSE,
  decodeBinaryPayload,
  encodeBinaryPayload,
  encodeFrame,
} from '@qsim/contract'
import type {
  ClientFrame,
  CollabAccess,
  PresencePosition,
  PresenceState,
  ServerFrame,
} from '@qsim/contract'
import type { HardwareStatus, RunEvent, RunStatus } from '@qsim/jobs'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  AUTHORISATION_TTL_MS,
  IDLE_TIMEOUT_MS,
  MAX_COLLAB_PENDING_DELIVERIES,
  MAX_PROTOCOL_VIOLATIONS,
  createSocketSession,
} from './session.js'
import type {
  AttachRefusalCode,
  ReadableRun,
  SocketSession,
} from './session.js'

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
  /** What `readCircuit` answers, per viewer. `null` means "not readable". */
  readonly access: Map<string, CollabAccess | null>
  /** Every question `readCircuit` was asked, as `key(circuitId, viewer)`. */
  readonly circuitReads: string[]
  /** The peers this session attached, newest last. */
  readonly peers: FakePeer[]
  /** Every viewer `readViewerName` was asked about, in order. */
  readonly nameReads: string[]
  /** Flipped mid-test to model a dependency that fails after a join. */
  readonly control: { failCircuitReads: boolean }
}

interface HarnessOptions {
  readonly runs?: Record<string, ReadableRun | null>
  readonly subscribable?: boolean
  readonly busFails?: boolean
  readonly identity?: { userId: string; expiresAt: number } | null
  readonly verifies?: string | null
  /** Circuits and what each viewer may do with them — see `access`. */
  readonly circuits?: Record<string, CollabAccess | null>
  /**
   * Handles that resolve to a *different* circuit id, as a slug does.
   *
   * The default resolves a handle to itself, which is right for the tests that
   * address circuits by id. A slug is the case where the frame's string and the
   * document's key differ, and that difference is what the attachment budget was
   * found miscounting.
   */
  readonly resolves?: Record<string, string>
  /** `false` models a deployment with the relay switched off. */
  readonly collaborative?: boolean
  /** What `attachDocument` refuses with, when a test wants a refusal. */
  readonly attachRefusal?: AttachRefusalCode
  /** What every `apply` refuses with, when a test wants a refusal. */
  readonly applyRefusal?:
    'too-large' | 'malformed' | 'invalid' | 'document-too-large'
  /** What `missing` answers; `null` models a document too big for a frame. */
  readonly documentState?: Uint8Array | null
  /** Makes `readCircuit` reject, modelling an unreachable database. */
  readonly circuitReadFails?: boolean
  /** Display names by viewer id, for the presence frames a peer composes. */
  readonly names?: Record<string, string | null>
  /** Makes `readViewerName` reject, modelling an unreachable database. */
  readonly nameReadFails?: boolean
  /** Who the relay says is already in the session when this socket joins. */
  readonly roster?: readonly {
    readonly peerId: string
    readonly state: PresenceState
  }[]
}

/** One attached peer, as the harness can drive it. */
interface FakePeer {
  readonly circuitId: string
  /** The opaque handle the session minted for this connection. */
  readonly peerId: string
  /** Pushes an update at the session, as the registry's fan-out would. */
  readonly deliver: (update: Uint8Array) => void
  /** Pushes somebody else's presence at the session, as the fan-out would. */
  readonly deliverPresence: (
    peerId: string,
    state: PresenceState | null
  ) => void
  /** Tells the session the relay gave the document up. */
  readonly drop: () => void
  /** Updates the session accepted and passed on. */
  readonly applied: Uint8Array[]
  /** Presences the session composed and published, newest last. */
  readonly published: (PresenceState | null)[]
  detached: boolean
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
  const access = new Map<string, CollabAccess | null>()
  const circuitReads: string[] = []
  const peers: FakePeer[] = []
  const nameReads: string[] = []
  const control = { failCircuitReads: options.circuitReadFails === true }
  let clock = 1_000_000
  let minted = 0

  for (const [runId, run] of Object.entries(options.runs ?? {})) {
    // Readable by everybody unless a test says otherwise, which it does by
    // writing a viewer-scoped entry over the top.
    for (const viewer of [null, OWNER, STRANGER]) {
      visibility.set(key(runId, viewer), run)
    }
  }
  for (const [circuitId, granted] of Object.entries(options.circuits ?? {})) {
    for (const viewer of [null, OWNER, STRANGER]) {
      access.set(key(circuitId, viewer), granted)
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
      const found = visibility.get(key(runId, viewerId)) ?? null
      return Promise.resolve(found?.kind === 'run' ? found : null)
    },
    /*
     * The second table. A hardware job has an owner and is never readable by
     * whoever merely holds its id, which is the one §11 rule that differs from
     * a simulation run — so an anonymous viewer reads nothing here.
     */
    readHardwareJob: (jobId, viewerId) => {
      /*
       * Deliberately not pushed onto `reads`. That list counts *the visibility
       * question* the session asks about a run, and a hardware lookup is the
       * second half of one question rather than a second question — counting it
       * would make every run assertion in this file read one higher.
       */
      if (viewerId === null) return Promise.resolve(null)
      const found = visibility.get(key(jobId, viewerId)) ?? null
      return Promise.resolve(found?.kind === 'hardware' ? found : null)
    },
    subscribe:
      options.subscribable === false
        ? null
        : (runId, _kind, listener) => {
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
    readCircuit:
      options.collaborative === false
        ? null
        : (circuitId, viewerId) => {
            circuitReads.push(key(circuitId, viewerId))
            if (control.failCircuitReads) {
              return Promise.reject(new Error('pooler is down'))
            }
            return Promise.resolve(
              (() => {
                const granted = access.get(key(circuitId, viewerId)) ?? null
                // A handle resolves to itself unless a test says otherwise: most
                // of these address circuits by id, and `resolves` is how the slug
                // case — where the frame's string is not the document's key — is
                // reached without a database.
                return granted === null
                  ? null
                  : {
                      access: granted,
                      circuitId: options.resolves?.[circuitId] ?? circuitId,
                    }
              })()
            )
          },
    attachDocument:
      options.collaborative === false
        ? null
        : (input) => {
            const refusal = options.attachRefusal
            if (refusal !== undefined) {
              return Promise.resolve({ refused: refusal })
            }
            const peer: FakePeer = {
              circuitId: input.circuitId,
              peerId: input.peerId,
              deliver: input.deliver,
              deliverPresence: input.deliverPresence,
              drop: input.dropped,
              applied: [],
              published: [],
              detached: false,
            }
            peers.push(peer)
            return Promise.resolve({
              missing: () =>
                options.documentState === undefined
                  ? new Uint8Array([1, 2, 3])
                  : options.documentState,
              vector: () => new Uint8Array([0]),
              deferred: 0,
              overflow: 0,
              roster: () => options.roster ?? [],
              publishPresence: (state) => {
                peer.published.push(state)
              },
              apply: (update) => {
                const reason = options.applyRefusal
                if (reason !== undefined) return { ok: false, reason }
                peer.applied.push(update)
                return { ok: true, work: 1 }
              },
              detach: () => {
                peer.detached = true
              },
            })
          },
    /*
     * The name a peer's presence carries. `null` models a viewer with no row,
     * and `readViewerName` is never consulted for an anonymous socket at all —
     * which is one of the things `presence` is tested for below.
     */
    readViewerName: (viewer) => {
      nameReads.push(viewer)
      if (options.nameReadFails === true) {
        return Promise.reject(new Error('pooler is down'))
      }
      return Promise.resolve(options.names?.[viewer] ?? null)
    },
    newPeerId: () => {
      minted += 1
      return `peer-${minted}`
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
    access,
    circuitReads,
    peers,
    nameReads,
    control,
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
  return { kind: 'run', status }
}

/** A hardware job in the given state, for the Phase 4 subscription tests. */
function hardware(status: HardwareStatus = 'QUEUED'): ReadableRun {
  return { kind: 'hardware', status }
}

/**
 * An upgrade that already proved an identity.
 *
 * Every hardware test uses one, because a hardware job is never readable by
 * whoever merely holds its id — unlike a simulation run, it spends a
 * *particular person's* ten-minute allowance, so it always has an owner.
 * `expiresAt` is in seconds, as `exp` is, and is far past the harness clock.
 */
const SESSION = { userId: OWNER, expiresAt: 2_000_000_000 }

/**
 * Lets the delivery chain drain.
 *
 * A published event is appended to a promise chain and every delivery makes an
 * authorisation decision, so a frame is several microtasks behind the publish.
 * Four turns is comfortably more than the longest path and still costs nothing.
 */
async function settle(): Promise<void> {
  for (let turn = 0; turn < 4; turn++) await Promise.resolve()
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

/**
 * Watching a hardware job — §3.7, Phase 4.
 *
 * The same socket, the same `subscribe` frame, the same ceiling and the same
 * ordering guard. What differs is the *lifecycle*: a hardware job has SUBMITTED
 * and CANCELLED, which a simulation run cannot be, and it may sit in somebody
 * else's queue for hours. That is exactly why it reuses this machinery rather
 * than growing its own — the thing that is hard here is the sequencing, and the
 * sequencing is identical.
 */
describe('watching a hardware job', () => {
  it('subscribes by the same frame and reports its own vocabulary', async () => {
    const h = harness({
      runs: { j1: hardware('SUBMITTED') },
      identity: SESSION,
    })
    await h.send({ type: 'subscribe', runId: 'j1' })
    expect(h.sent.at(-1)).toEqual({
      type: 'subscribed',
      runId: 'j1',
      status: 'SUBMITTED',
    })
  })

  it('delivers a status change with the device queue position', async () => {
    const h = harness({
      runs: { j1: hardware('SUBMITTED') },
      identity: SESSION,
    })
    await h.send({ type: 'subscribe', runId: 'j1' })
    h.sent.length = 0
    h.publish({
      type: 'hardware:status',
      runId: 'j1',
      at: 10,
      status: 'QUEUED',
      queuePosition: null,
    })
    await settle()
    expect(h.sent).toEqual([
      {
        type: 'hardware:status',
        runId: 'j1',
        status: 'QUEUED',
        queuePosition: null,
      },
    ])
  })

  /*
   * CANCELLED is a third terminal outcome and not a failure. Somebody who
   * stopped a job to protect their ten-minute allowance has not had a failure,
   * and reporting one would tell them their circuit was wrong.
   */
  it('reports a cancellation as its own outcome and releases the channel', async () => {
    const h = harness({ runs: { j1: hardware('RUNNING') }, identity: SESSION })
    await h.send({ type: 'subscribe', runId: 'j1' })
    h.sent.length = 0
    h.publish({
      type: 'hardware:complete',
      runId: 'j1',
      at: 20,
      status: 'CANCELLED',
      error: null,
    })
    await settle()
    expect(typesOf(h.sent)).toEqual(['hardware:complete', 'unsubscribed'])
    expect([...h.channels]).toEqual([])
  })

  it('opens no channel for a job that is already terminal', async () => {
    const h = harness({ runs: { j1: hardware('DONE') }, identity: SESSION })
    await h.send({ type: 'subscribe', runId: 'j1' })
    expect(h.sent.at(-1)).toEqual({
      type: 'subscribed',
      runId: 'j1',
      status: 'DONE',
    })
    expect([...h.channels]).toEqual([])
  })

  /*
   * A hardware job has an owner, always. Unlike a simulation run — where the id
   * is the credential for an anonymous submission — there is no such thing as
   * an anonymous hardware job, because a job spends a *particular person's*
   * allowance.
   */
  it('refuses an anonymous watcher, as a NOT_FOUND', async () => {
    const h = harness({ runs: { j1: hardware('QUEUED') } })
    await h.send({ type: 'subscribe', runId: 'j1' })
    expect(h.sent.at(-1)).toEqual({
      type: 'error',
      code: 'NOT_FOUND',
      runId: 'j1',
    })
  })

  /*
   * The frame kinds cannot cross. The channels are separately namespaced so
   * this is unreachable through Redis routing; the guard exists because the
   * *authorisation* was decided about one row, and a frame of the other kind
   * would be about something this socket was never granted.
   */
  it('drops a run event that arrives on a hardware subscription', async () => {
    const h = harness({ runs: { j1: hardware('RUNNING') }, identity: SESSION })
    await h.send({ type: 'subscribe', runId: 'j1' })
    h.sent.length = 0
    h.publish({
      type: 'run:complete',
      runId: 'j1',
      at: 30,
      status: 'DONE',
      durationMs: 1,
      error: null,
    })
    await settle()
    expect(h.sent).toEqual([])
    // And the subscription survives: a stray frame must not tear down a job
    // that is still running, or the completion it is waiting for never lands.
    expect(h.session.subscriptionCount()).toBe(1)
  })

  it('drops a hardware event that arrives on a run subscription', async () => {
    const h = harness({ runs: { r1: running() } })
    await h.send({ type: 'subscribe', runId: 'r1' })
    h.sent.length = 0
    h.publish({
      type: 'hardware:status',
      runId: 'r1',
      at: 40,
      status: 'RUNNING',
      queuePosition: 3,
    })
    await settle()
    expect(h.sent).toEqual([])
  })

  /* Rule 1 of the session header, applied to the second table. */
  it('ends the subscription when the job stops being readable', async () => {
    const h = harness({ runs: { j1: hardware('RUNNING') }, identity: SESSION })
    await h.send({ type: 'subscribe', runId: 'j1' })
    h.visibility.set(key('j1', OWNER), null)
    h.advance(AUTHORISATION_TTL_MS + 1)
    h.sent.length = 0
    h.publish({
      type: 'hardware:status',
      runId: 'j1',
      at: 50,
      status: 'RUNNING',
      queuePosition: null,
    })
    await settle()
    expect(typesOf(h.sent)).toEqual(['unsubscribed'])
  })
})

/**
 * The collaboration channel — rules 4, 5 and 6 of the session header.
 *
 * Every test here is about *authority* rather than about convergence: whether a
 * merged document is a circuit is `@qsim/collab`'s question, answered in its own
 * merge tests. What is answered here is who may attach, who may write, what
 * happens when either stops being true, and what a stranger gets.
 */
describe('joining a shared document', () => {
  const UPDATE = encodeBinaryPayload(new Uint8Array([9, 8, 7]))

  function lastJoin(frames: readonly ServerFrame[]) {
    return frames.filter((frame) => frame.type === 'collab:joined').at(-1)
  }

  it('attaches an owner with write access and hands over the document', async () => {
    const h = harness({ circuits: { c1: 'write' }, identity: SESSION })
    await h.send({ type: 'collab:join', circuitId: 'c1' })
    const frame = lastJoin(h.sent)
    expect(frame).toMatchObject({
      type: 'collab:joined',
      circuitId: 'c1',
      access: 'write',
      deferred: 0,
      overflow: 0,
    })
    expect(decodeBinaryPayload(frame?.update ?? '')).toEqual(
      new Uint8Array([1, 2, 3])
    )
    expect(h.session.attachmentCount()).toBe(1)
  })

  /**
   * Rule 4. A reader of a PUBLIC circuit may watch, and the refusal to write is
   * enforced on the server rather than by the absence of a button.
   */
  it('attaches a reader read-only and refuses its updates', async () => {
    const h = harness({ circuits: { c1: 'read' } })
    await h.send({ type: 'collab:join', circuitId: 'c1' })
    expect(lastJoin(h.sent)).toMatchObject({ access: 'read' })

    h.sent.length = 0
    await h.send({ type: 'collab:update', circuitId: 'c1', update: UPDATE })
    expect(h.sent).toEqual([
      { type: 'collab:error', circuitId: 'c1', code: 'FORBIDDEN' },
    ])
    // And the bytes never reached the document, which is the whole point.
    expect(h.peers[0]?.applied).toEqual([])
  })

  /** A stranger, from the outside: the circuit may as well not exist. */
  it('answers NOT_FOUND to a viewer who may not read the circuit', async () => {
    const h = harness({ circuits: { c1: null }, identity: SESSION })
    await h.send({ type: 'collab:join', circuitId: 'c1' })
    expect(h.sent.at(-1)).toEqual({
      type: 'collab:error',
      circuitId: 'c1',
      code: 'NOT_FOUND',
    })
    expect(h.session.attachmentCount()).toBe(0)
    expect(h.peers).toEqual([])
  })

  /**
   * A stranger's update on a circuit they never joined. Ignored rather than
   * answered — see the note in `update` — and the load-bearing half is that no
   * document was reached and no query was spent.
   */
  it('ignores an update for a circuit this socket never joined', async () => {
    const h = harness({ circuits: { c1: 'write' } })
    h.sent.length = 0
    await h.send({ type: 'collab:update', circuitId: 'c1', update: UPDATE })
    expect(h.sent).toEqual([])
    expect(h.peers).toEqual([])
    expect(h.circuitReads).toEqual([])
  })

  it('is idempotent, so a reconnecting client does not spend a slot', async () => {
    const h = harness({ circuits: { c1: 'write' }, identity: SESSION })
    await h.send({ type: 'collab:join', circuitId: 'c1' })
    await h.send({ type: 'collab:join', circuitId: 'c1' })
    expect(h.session.attachmentCount()).toBe(1)
    expect(h.peers).toHaveLength(1)
    expect(
      h.sent.filter((frame) => frame.type === 'collab:joined')
    ).toHaveLength(2)
  })

  it('adopts the access a rejoin reports, in either direction', async () => {
    const h = harness({ circuits: { c1: 'write' }, identity: SESSION })
    await h.send({ type: 'collab:join', circuitId: 'c1' })
    // The circuit was transferred: still readable, no longer writable.
    h.access.set(key('c1', OWNER), 'read')
    await h.send({ type: 'collab:join', circuitId: 'c1' })
    expect(lastJoin(h.sent)).toMatchObject({ access: 'read' })

    h.sent.length = 0
    await h.send({ type: 'collab:update', circuitId: 'c1', update: UPDATE })
    expect(h.sent).toEqual([
      { type: 'collab:error', circuitId: 'c1', code: 'FORBIDDEN' },
    ])
  })

  it('bounds how many documents one socket may hold', async () => {
    const h = harness({
      circuits: { c1: 'write', c2: 'write', c3: 'write' },
      identity: SESSION,
    })
    for (const circuitId of ['c1', 'c2', 'c3']) {
      await h.send({ type: 'collab:join', circuitId })
    }
    expect(h.session.attachmentCount()).toBe(MAX_COLLAB_DOCUMENTS_PER_SOCKET)
    expect(h.sent.at(-1)).toEqual({
      type: 'collab:error',
      circuitId: 'c3',
      code: 'RATE_LIMITED',
    })
    // The ceiling is checked before the database is asked, so a socket at its
    // limit cannot buy a query with a frame.
    expect(h.circuitReads).toEqual([key('c1', OWNER), key('c2', OWNER)])
  })

  /**
   * The bound is documents, and a slug join used to cost two of them.
   *
   * `attachments` is keyed by *both* handles of every document — that is what lets
   * a slug join and an id join for one circuit find each other — so comparing its
   * `size` to `MAX_COLLAB_DOCUMENTS_PER_SOCKET` enforced half the documented
   * ceiling for every client that joins by slug, which is every browser.
   */
  it('charges one document for a join by slug, not two', async () => {
    const h = harness({
      circuits: { s1: 'write', s2: 'write' },
      resolves: { s1: 'c1', s2: 'c2' },
      identity: SESSION,
    })

    await h.send({ type: 'collab:join', circuitId: 's1' })
    expect(h.session.attachmentCount()).toBe(1)

    await h.send({ type: 'collab:join', circuitId: 's2' })
    expect(h.session.attachmentCount()).toBe(MAX_COLLAB_DOCUMENTS_PER_SOCKET)
    expect(h.sent.filter((frame) => frame.type === 'collab:error')).toEqual([])
  })

  it('leaves the socket open when the relay is switched off', async () => {
    const h = harness({ circuits: { c1: 'write' }, collaborative: false })
    await h.send({ type: 'collab:join', circuitId: 'c1' })
    expect(h.sent.at(-1)).toEqual({
      type: 'collab:error',
      circuitId: 'c1',
      code: 'SIMULATION_UNAVAILABLE',
    })
    expect(h.closed).toEqual([])
  })

  it('reports an unreachable database rather than closing the socket', async () => {
    const h = harness({ circuits: { c1: 'write' }, circuitReadFails: true })
    await h.send({ type: 'collab:join', circuitId: 'c1' })
    expect(h.sent.at(-1)).toEqual({
      type: 'collab:error',
      circuitId: 'c1',
      code: 'DATABASE_UNAVAILABLE',
    })
    expect(h.closed).toEqual([])
  })

  it('translates every attachment refusal into a code a client knows', async () => {
    const cases: [AttachRefusalCode, string][] = [
      ['too-many-documents', 'RATE_LIMITED'],
      ['too-many-peers', 'RATE_LIMITED'],
      ['too-large', 'CIRCUIT_TOO_LARGE'],
      ['unavailable', 'DATABASE_UNAVAILABLE'],
    ]
    for (const [refusal, code] of cases) {
      const h = harness({ circuits: { c1: 'write' }, attachRefusal: refusal })
      await h.send({ type: 'collab:join', circuitId: 'c1' })
      expect(h.sent.at(-1)).toEqual({
        type: 'collab:error',
        circuitId: 'c1',
        code,
      })
      expect(h.session.attachmentCount()).toBe(0)
    }
  })

  it('refuses a state vector the decoder cannot read', async () => {
    const h = harness({ circuits: { c1: 'write' } })
    // Five characters of the legal alphabet, so the schema accepts it; a length
    // no base64 encoder can produce, so the decoder does not.
    await h.send({ type: 'collab:join', circuitId: 'c1', since: 'AAAAA' })
    expect(h.sent.at(-1)).toEqual({
      type: 'collab:error',
      circuitId: 'c1',
      code: 'VALIDATION_FAILED',
    })
    expect(h.circuitReads).toEqual([])
  })

  it('gives up an attachment whose document cannot fit in a frame', async () => {
    const h = harness({ circuits: { c1: 'write' }, documentState: null })
    await h.send({ type: 'collab:join', circuitId: 'c1' })
    expect(typesOf(h.sent.slice(-2))).toEqual(['collab:left', 'collab:error'])
    expect(h.sent.at(-1)).toEqual({
      type: 'collab:error',
      circuitId: 'c1',
      code: 'CIRCUIT_TOO_LARGE',
    })
    expect(h.session.attachmentCount()).toBe(0)
  })

  it('refuses a join on an expired credential rather than answering it', async () => {
    const h = harness({
      circuits: { c1: 'write' },
      identity: { userId: OWNER, expiresAt: 1_000 },
    })
    await h.send({ type: 'collab:join', circuitId: 'c1' })
    expect(h.closed).toEqual([SOCKET_CLOSE.EXPIRED])
    expect(h.circuitReads).toEqual([])
  })
})

describe('relaying updates', () => {
  const UPDATE = encodeBinaryPayload(new Uint8Array([4, 5, 6]))

  async function attached(options: HarnessOptions = {}): Promise<Harness> {
    const h = harness({
      circuits: { c1: 'write' },
      identity: SESSION,
      ...options,
    })
    await h.send({ type: 'collab:join', circuitId: 'c1' })
    h.sent.length = 0
    return h
  }

  it('passes a writer’s update to the document and echoes nothing', async () => {
    const h = await attached()
    await h.send({ type: 'collab:update', circuitId: 'c1', update: UPDATE })
    expect(h.peers[0]?.applied).toEqual([new Uint8Array([4, 5, 6])])
    expect(h.sent).toEqual([])
  })

  it('delivers another peer’s update, base64, in order', async () => {
    const h = await attached()
    h.peers[0]?.deliver(new Uint8Array([1]))
    h.peers[0]?.deliver(new Uint8Array([2]))
    await settle()
    expect(h.sent).toEqual([
      {
        type: 'collab:update',
        circuitId: 'c1',
        update: encodeBinaryPayload(new Uint8Array([1])),
      },
      {
        type: 'collab:update',
        circuitId: 'c1',
        update: encodeBinaryPayload(new Uint8Array([2])),
      },
    ])
  })

  /**
   * Rule 5 on the write path: the decision was true when the attachment opened
   * and is not cached past the TTL.
   */
  it('ends the attachment when the circuit stops being readable', async () => {
    const h = await attached()
    h.access.set(key('c1', OWNER), null)
    h.advance(AUTHORISATION_TTL_MS + 1)
    await h.send({ type: 'collab:update', circuitId: 'c1', update: UPDATE })
    expect(h.sent).toEqual([
      { type: 'collab:left', circuitId: 'c1', reason: 'unauthorised' },
    ])
    expect(h.peers[0]?.applied).toEqual([])
    expect(h.peers[0]?.detached).toBe(true)
  })

  /** The same withdrawal on the read path, where nothing is being sent. */
  it('ends a watcher mid-stream when its read access is withdrawn', async () => {
    const h = await attached({ circuits: { c1: 'read' } })
    h.access.set(key('c1', OWNER), null)
    h.advance(AUTHORISATION_TTL_MS + 1)
    h.peers[0]?.deliver(new Uint8Array([1]))
    await settle()
    expect(h.sent).toEqual([
      { type: 'collab:left', circuitId: 'c1', reason: 'unauthorised' },
    ])
  })

  /**
   * The other half of rule 5, and the more interesting one: write access can be
   * withdrawn without read access going with it, and such a peer keeps watching.
   */
  it('downgrades a writer whose write access was withdrawn', async () => {
    const h = await attached()
    h.access.set(key('c1', OWNER), 'read')
    h.advance(AUTHORISATION_TTL_MS + 1)
    await h.send({ type: 'collab:update', circuitId: 'c1', update: UPDATE })
    expect(h.sent).toEqual([
      { type: 'collab:error', circuitId: 'c1', code: 'FORBIDDEN' },
    ])
    expect(h.session.attachmentCount()).toBe(1)
    expect(h.peers[0]?.applied).toEqual([])
  })

  it('re-checks at most once per TTL, not once per update', async () => {
    const h = await attached()
    for (let i = 0; i < 5; i += 1) {
      await h.send({ type: 'collab:update', circuitId: 'c1', update: UPDATE })
    }
    // One read for the join and none since: five updates inside one window.
    expect(h.circuitReads).toEqual([key('c1', OWNER)])
    h.advance(AUTHORISATION_TTL_MS + 1)
    await h.send({ type: 'collab:update', circuitId: 'c1', update: UPDATE })
    expect(h.circuitReads).toHaveLength(2)
  })

  /**
   * A pooler blip must not disconnect a session two people are in the middle
   * of. The window it leaves open is two seconds wide on a scratch document, and
   * the same outage refuses the version they are about to save.
   */
  it('keeps an attachment when the re-check itself cannot be made', async () => {
    const h = await attached()
    h.control.failCircuitReads = true
    h.advance(AUTHORISATION_TTL_MS + 1)
    await h.send({ type: 'collab:update', circuitId: 'c1', update: UPDATE })
    expect(h.session.attachmentCount()).toBe(1)
    expect(h.peers[0]?.applied).toHaveLength(1)
  })

  it('ends the attachment when the relay gives the document up', async () => {
    const h = await attached()
    h.peers[0]?.drop()
    expect(h.sent).toEqual([
      { type: 'collab:left', circuitId: 'c1', reason: 'gone' },
    ])
    expect(h.session.attachmentCount()).toBe(0)
  })

  /**
   * An update may never be dropped — a peer that missed one holds a document
   * nobody else has and cannot know it — so a peer that cannot keep up is ended
   * instead, which tells it to rejoin, and a rejoin is a resync.
   */
  it('ends a peer that falls too far behind rather than dropping updates', async () => {
    const h = await attached()
    for (let i = 0; i <= MAX_COLLAB_PENDING_DELIVERIES; i += 1) {
      h.peers[0]?.deliver(new Uint8Array([i]))
    }
    expect(h.sent.at(-1)).toEqual({
      type: 'collab:left',
      circuitId: 'c1',
      reason: 'overloaded',
    })
    expect(h.session.attachmentCount()).toBe(0)
  })

  it('reports a refused update in the code that says what to do', async () => {
    const cases: ['too-large' | 'invalid' | 'document-too-large', string][] = [
      ['too-large', 'PAYLOAD_TOO_LARGE'],
      ['document-too-large', 'CIRCUIT_TOO_LARGE'],
      ['invalid', 'VALIDATION_FAILED'],
    ]
    for (const [reason, code] of cases) {
      const h = await attached({ applyRefusal: reason })
      await h.send({ type: 'collab:update', circuitId: 'c1', update: UPDATE })
      expect(h.sent.at(-1)).toEqual({
        type: 'collab:error',
        circuitId: 'c1',
        code,
      })
      expect(h.closed).toEqual([])
    }
  })

  /**
   * Bytes that are not a Yjs update at all. The relay decodes before it
   * integrates, so the document was never touched — and a peer sending
   * undecodable binary is not a peer to keep relaying for.
   */
  it('closes the socket on bytes that are not a Yjs update', async () => {
    const h = await attached({ applyRefusal: 'malformed' })
    await h.send({ type: 'collab:update', circuitId: 'c1', update: UPDATE })
    expect(h.closed).toEqual([SOCKET_CLOSE.PROTOCOL])
  })

  it('refuses a payload the decoder cannot read', async () => {
    const h = await attached()
    await h.send({ type: 'collab:update', circuitId: 'c1', update: 'AAAAA' })
    expect(h.sent).toEqual([
      { type: 'collab:error', circuitId: 'c1', code: 'VALIDATION_FAILED' },
    ])
    expect(h.peers[0]?.applied).toEqual([])
  })

  it('detaches on `collab:leave`, silently, because the client asked', async () => {
    const h = await attached()
    await h.send({ type: 'collab:leave', circuitId: 'c1' })
    expect(h.sent).toEqual([])
    expect(h.session.attachmentCount()).toBe(0)
    expect(h.peers[0]?.detached).toBe(true)
  })

  /**
   * Detaching on close is what lets the registry write the document: this may be
   * the last peer, and the last peer leaving is the moment the row exists for.
   */
  it('detaches every attachment when the socket closes', async () => {
    const h = await attached()
    await h.session.close()
    expect(h.peers[0]?.detached).toBe(true)
    expect(h.session.attachmentCount()).toBe(0)
  })
})

describe('the collaboration budget', () => {
  const UPDATE = encodeBinaryPayload(new Uint8Array([1, 2, 3]))

  async function attached(): Promise<Harness> {
    const h = harness({ circuits: { c1: 'write' }, identity: SESSION })
    await h.send({ type: 'collab:join', circuitId: 'c1' })
    return h
  }

  /**
   * Rule 6. A slider drag is dozens of commits a second; the general budget is
   * six a second because every frame it counts is a database read. Charging a
   * drag against it would close the socket of somebody using the product.
   */
  it('does not charge an update against the general frame budget', async () => {
    const h = await attached()
    const many = MAX_SOCKET_FRAMES_PER_WINDOW + 20
    for (let i = 0; i < many; i += 1) {
      await h.send({ type: 'collab:update', circuitId: 'c1', update: UPDATE })
    }
    expect(h.closed).toEqual([])
    expect(h.peers[0]?.applied).toHaveLength(many)
  })

  it('closes a socket past its update count', async () => {
    const h = await attached()
    for (let i = 0; i <= MAX_COLLAB_UPDATES_PER_WINDOW; i += 1) {
      await h.send({ type: 'collab:update', circuitId: 'c1', update: UPDATE })
    }
    expect(h.closed).toEqual([SOCKET_CLOSE.OVERLOADED])
  })

  /**
   * The count and the weight bound different things, and this is the case that
   * shows the weight is the one that binds first: a full-sized update is 85 KiB
   * of base64, so twelve of them spend a megabyte while the count is still at
   * twelve out of a hundred and twenty.
   */
  it('closes a socket past its update weight, well before its count', async () => {
    const h = await attached()
    const heavy = 'A'.repeat(Math.ceil(MAX_COLLAB_UPDATE_BYTES / 3) * 4)
    const enough = Math.ceil(MAX_COLLAB_BYTES_PER_WINDOW / heavy.length)
    expect(enough).toBeLessThan(MAX_COLLAB_UPDATES_PER_WINDOW)
    for (let i = 0; i < enough && h.closed.length === 0; i += 1) {
      await h.send({ type: 'collab:update', circuitId: 'c1', update: heavy })
    }
    expect(h.closed).toEqual([SOCKET_CLOSE.OVERLOADED])
  })

  it('opens a new window once the old one has passed', async () => {
    const h = await attached()
    for (let i = 0; i < MAX_COLLAB_UPDATES_PER_WINDOW; i += 1) {
      await h.send({ type: 'collab:update', circuitId: 'c1', update: UPDATE })
    }
    h.advance(10_001)
    await h.send({ type: 'collab:update', circuitId: 'c1', update: UPDATE })
    expect(h.closed).toEqual([])
  })
})

describe('an idle socket holding only a document', () => {
  /**
   * Watching is silence. A socket closed after two minutes of it would make the
   * feature look broken for exactly the person it was built for.
   */
  it('is not closed for idleness', async () => {
    const h = harness({ circuits: { c1: 'read' } })
    await h.send({ type: 'collab:join', circuitId: 'c1' })
    h.advance(IDLE_TIMEOUT_MS + 1)
    h.session.sweep()
    expect(h.closed).toEqual([])
  })

  it('is closed once it has left the document', async () => {
    const h = harness({ circuits: { c1: 'read' } })
    await h.send({ type: 'collab:join', circuitId: 'c1' })
    await h.send({ type: 'collab:leave', circuitId: 'c1' })
    h.advance(IDLE_TIMEOUT_MS + 1)
    h.session.sweep()
    expect(h.closed).toEqual([SOCKET_CLOSE.IDLE])
  })

  /**
   * REVOCATION IS NOT A PROPERTY OF TRAFFIC.
   *
   * `stillAttached` was reached only from `update`, `presence` and the two
   * delivery paths, so a peer that stopped speaking kept its attachment, its
   * reader slot and its hold on the live document after its read access had been
   * withdrawn — measured at 32 s of silence with the socket still open and no
   * `collab:left` sent. Nothing leaked, because the first frame after the owner
   * edits is the ejection rather than the edit; what was wrong is the lifecycle,
   * and this channel's own comment promises the decision is «re-checked while the
   * session runs».
   */
  it('ends a silent attachment whose read access was withdrawn', async () => {
    const h = harness({ circuits: { c1: 'read' } })
    await h.send({ type: 'collab:join', circuitId: 'c1' })
    expect(h.session.attachmentCount()).toBe(1)

    // The owner made the circuit PRIVATE. This peer says nothing at all.
    h.access.set(key('c1', null), null)
    h.advance(AUTHORISATION_TTL_MS + 1)
    h.session.sweep()
    await settle()

    expect(h.sent.at(-1)).toEqual({
      type: 'collab:left',
      circuitId: 'c1',
      reason: 'unauthorised',
    })
    expect(h.session.attachmentCount()).toBe(0)
  })

  it('keeps a silent attachment the owner has not revoked', async () => {
    const h = harness({ circuits: { c1: 'read' } })
    await h.send({ type: 'collab:join', circuitId: 'c1' })
    h.sent.length = 0

    h.advance(AUTHORISATION_TTL_MS + 1)
    h.session.sweep()
    await settle()

    // Watching is silence, and silence is not a reason to be thrown out.
    expect(h.sent).toEqual([])
    expect(h.session.attachmentCount()).toBe(1)
    expect(h.closed).toEqual([])
  })

  it('asks nothing of the database for an attachment inside the TTL', async () => {
    const h = harness({ circuits: { c1: 'read' } })
    await h.send({ type: 'collab:join', circuitId: 'c1' })
    const reads = h.circuitReads.length

    // A session with traffic has just re-checked; the sweep must not double it.
    h.session.sweep()
    await settle()
    expect(h.circuitReads).toHaveLength(reads)
  })
})

describe('presence — who is here and where they are looking (M5.3)', () => {
  const AT_COLUMN_4: PresencePosition = {
    cursor: { qubit: 0, column: 4 },
    selection: [],
    edits: 0,
  }

  const BETO: PresenceState = {
    ...AT_COLUMN_4,
    name: 'Beto',
    access: 'write',
  }

  async function joined(options: HarnessOptions = {}): Promise<Harness> {
    const h = harness(options)
    await h.send({ type: 'collab:join', circuitId: 'c1' })
    h.sent.length = 0
    return h
  }

  /**
   * Rule 7, and the reason presence is a typed frame rather than a relayed
   * awareness blob: the *name* is composed here, out of the identity this socket
   * proved. What the client said about itself is only ever the position.
   */
  it('stamps the name from the database and not from the frame', async () => {
    const h = await joined({
      circuits: { c1: 'write' },
      identity: SESSION,
      names: { [OWNER]: 'Ada Lovelace' },
    })

    await h.send({
      type: 'collab:presence',
      circuitId: 'c1',
      state: AT_COLUMN_4,
    })

    expect(h.peers[0]?.published).toEqual([
      { ...AT_COLUMN_4, name: 'Ada Lovelace', access: 'write' },
    ])
    expect(h.nameReads).toEqual([OWNER])
  })

  it('asks the database once per socket, not once per cursor movement', async () => {
    const h = await joined({
      circuits: { c1: 'write' },
      identity: SESSION,
      names: { [OWNER]: 'Ada' },
    })

    for (let column = 0; column < 5; column += 1) {
      await h.send({
        type: 'collab:presence',
        circuitId: 'c1',
        state: { ...AT_COLUMN_4, cursor: { qubit: 0, column } },
      })
    }

    expect(h.nameReads).toEqual([OWNER])
    expect(h.peers[0]?.published).toHaveLength(5)
  })

  it('never asks about an anonymous socket, and says nothing about who it is', async () => {
    /*
     * An anonymous watcher of a PUBLIC circuit is admitted by §3.4 on purpose.
     * `null` is the whole statement: the *word* for it belongs to the client,
     * because D2 puts every user-facing string in three catalogs and a server
     * that answered "Anonymous" would be sending English to a French reader.
     */
    const h = await joined({ circuits: { c1: 'read' } })

    await h.send({
      type: 'collab:presence',
      circuitId: 'c1',
      state: AT_COLUMN_4,
    })

    expect(h.peers[0]?.published).toEqual([
      { ...AT_COLUMN_4, name: null, access: 'read' },
    ])
    expect(h.nameReads).toEqual([])
  })

  it('shows a peer as read-only when that is what the relay decided', async () => {
    const h = await joined({
      circuits: { c1: 'read' },
      identity: SESSION,
      names: { [OWNER]: 'Grace' },
    })

    await h.send({
      type: 'collab:presence',
      circuitId: 'c1',
      state: AT_COLUMN_4,
    })

    /*
     * A watcher may be *seen*, and this is the one place on this channel where
     * "read-only" does not mean "refused": presence writes nothing that outlives
     * the connection, and a watcher nobody can see would make §3.4's shared
     * cursors a feature only the sole writer of a circuit ever benefits from.
     */
    expect(h.peers[0]?.published).toEqual([
      { ...AT_COLUMN_4, name: 'Grace', access: 'read' },
    ])
  })

  it('carries on with no name when the database cannot be read', async () => {
    const h = await joined({
      circuits: { c1: 'write' },
      identity: SESSION,
      nameReadFails: true,
    })

    await h.send({
      type: 'collab:presence',
      circuitId: 'c1',
      state: AT_COLUMN_4,
    })

    expect(h.peers[0]?.published).toEqual([
      { ...AT_COLUMN_4, name: null, access: 'write' },
    ])
  })

  it('answers a presence for a circuit nobody joined with silence', async () => {
    const h = harness({ circuits: { c1: 'write' } })
    h.sent.length = 0
    await h.send({
      type: 'collab:presence',
      circuitId: 'c1',
      state: AT_COLUMN_4,
    })
    expect(h.sent).toEqual([])
  })

  it('sends the roster after the join, one frame per peer', async () => {
    const h = harness({
      circuits: { c1: 'write' },
      identity: SESSION,
      roster: [{ peerId: 'peer-beto', state: BETO }],
    })

    await h.send({ type: 'collab:join', circuitId: 'c1' })

    expect(typesOf(h.sent)).toEqual([
      'ready',
      'collab:joined',
      'collab:presence',
    ])
    expect(h.sent.at(-1)).toEqual({
      type: 'collab:presence',
      circuitId: 'c1',
      peerId: 'peer-beto',
      state: BETO,
    })
  })

  it('delivers somebody else’s presence, and their departure', async () => {
    const h = await joined({ circuits: { c1: 'write' }, identity: SESSION })

    h.peers[0]?.deliverPresence('peer-beto', BETO)
    h.peers[0]?.deliverPresence('peer-beto', null)

    expect(h.sent).toEqual([
      {
        type: 'collab:presence',
        circuitId: 'c1',
        peerId: 'peer-beto',
        state: BETO,
      },
      {
        type: 'collab:presence',
        circuitId: 'c1',
        peerId: 'peer-beto',
        state: null,
      },
    ])
  })

  /**
   * The delivery path is deliberately unlike the update path. An update may never
   * be dropped; a presence may never be *queued*. Past the TTL the decision is
   * refreshed out of band and the frame still goes out — because dropping it meant
   * dropping every heartbeat in a quiet session: a renewal arrives every ten
   * seconds and the decision goes stale after two, so the mechanism that keeps a
   * roster alive was the one thing being thrown away. The ejection is what the
   * refresh is for, and it is not delayed by delivering the frame.
   */
  it('waits for one re-check rather than dropping a stale presence', async () => {
    const h = await joined({ circuits: { c1: 'read' }, identity: SESSION })
    h.circuitReads.length = 0

    h.advance(AUTHORISATION_TTL_MS)
    h.peers[0]?.deliverPresence('peer-beto', BETO)

    // Not yet: the decision is stale, so the frame is behind the one read that
    // refreshes it rather than being thrown away.
    expect(h.sent).toEqual([])
    for (let turn = 0; turn < 4; turn += 1) await Promise.resolve()
    expect(h.sent).toEqual([
      {
        type: 'collab:presence',
        circuitId: 'c1',
        peerId: 'peer-beto',
        state: BETO,
      },
    ])
    expect(h.circuitReads).toEqual([`c1::${OWNER}`])

    // And the refresh made the decision fresh, so the next one goes straight out.
    h.sent.length = 0
    h.peers[0]?.deliverPresence('peer-beto', BETO)
    expect(h.sent).toHaveLength(1)
  })

  it('ends an attachment whose read access was withdrawn while it watched', async () => {
    const h = await joined({ circuits: { c1: 'read' }, identity: SESSION })

    h.access.set(`c1::${OWNER}`, null)
    h.advance(AUTHORISATION_TTL_MS)
    h.peers[0]?.deliverPresence('peer-beto', BETO)
    for (let turn = 0; turn < 4; turn += 1) await Promise.resolve()

    // The frame that was already on its way went out; the attachment then ended,
    // which is what stops anything further reaching this viewer.
    expect(h.sent[h.sent.length - 1]).toEqual({
      type: 'collab:left',
      circuitId: 'c1',
      reason: 'unauthorised',
    })
    expect(h.session.attachmentCount()).toBe(0)

    // And nothing reaches it afterwards, which is the property that matters.
    h.sent.length = 0
    h.peers[0]?.deliverPresence('peer-beto', BETO)
    expect(h.sent).toEqual([])
  })

  it('schedules one re-check however many cursors are moving', async () => {
    const h = await joined({ circuits: { c1: 'read' }, identity: SESSION })
    h.circuitReads.length = 0

    h.advance(AUTHORISATION_TTL_MS)
    for (let index = 0; index < 8; index += 1) {
      h.peers[0]?.deliverPresence(`peer-${index}`, BETO)
    }
    for (let turn = 0; turn < 4; turn += 1) await Promise.resolve()

    expect(h.circuitReads).toEqual([`c1::${OWNER}`])
  })

  it('meters presence apart from the general frame budget', async () => {
    // A cursor moving is not a database query. Counting it against a budget
    // sized against Postgres would close the socket of somebody using the
    // product.
    const h = await joined({ circuits: { c1: 'write' }, identity: SESSION })

    for (let index = 0; index < MAX_SOCKET_FRAMES_PER_WINDOW + 10; index += 1) {
      await h.send({
        type: 'collab:presence',
        circuitId: 'c1',
        state: AT_COLUMN_4,
      })
    }

    expect(h.closed).toEqual([])
  })

  it('closes a socket that outruns the presence budget', async () => {
    const h = await joined({ circuits: { c1: 'write' }, identity: SESSION })

    for (
      let index = 0;
      index < MAX_COLLAB_PRESENCE_PER_WINDOW + 1;
      index += 1
    ) {
      await h.send({
        type: 'collab:presence',
        circuitId: 'c1',
        state: AT_COLUMN_4,
      })
    }

    expect(h.closed).toEqual([SOCKET_CLOSE.OVERLOADED])
  })

  it('reopens the presence window, as the other budgets do', async () => {
    const h = await joined({ circuits: { c1: 'write' }, identity: SESSION })

    for (let index = 0; index < MAX_COLLAB_PRESENCE_PER_WINDOW; index += 1) {
      await h.send({
        type: 'collab:presence',
        circuitId: 'c1',
        state: AT_COLUMN_4,
      })
    }
    h.advance(10_001)
    await h.send({
      type: 'collab:presence',
      circuitId: 'c1',
      state: AT_COLUMN_4,
    })

    expect(h.closed).toEqual([])
  })

  it('mints one peer id per socket, however many documents it holds', async () => {
    const h = await joined({
      circuits: { c1: 'write', c2: 'write' },
      identity: SESSION,
    })
    await h.send({ type: 'collab:join', circuitId: 'c2' })

    expect(h.peers.map((peer) => peer.peerId)).toEqual(['peer-1', 'peer-1'])
  })

  it('takes the cursor down by detaching, on leave and on close', async () => {
    // One path, not two: the registry removes a peer's presence when the peer
    // detaches, so nothing here has to remember to say goodbye twice.
    const h = await joined({ circuits: { c1: 'write' }, identity: SESSION })
    await h.send({ type: 'collab:leave', circuitId: 'c1' })
    expect(h.peers[0]?.detached).toBe(true)

    await h.send({ type: 'collab:join', circuitId: 'c1' })
    await h.session.close()
    expect(h.peers[1]?.detached).toBe(true)
  })
})
