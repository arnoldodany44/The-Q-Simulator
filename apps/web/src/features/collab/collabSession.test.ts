/**
 * The session, driven with a socket that is a plain object.
 *
 * Everything worth asserting here is about *time and order*: what is sent
 * before a token has resolved, what a rejoin carries, what happens to a local
 * edit produced while the connection is down, which endings come back and which
 * do not. None of it is reproducible on demand against a real relay, so the
 * socket, the clock, the timers and the jitter are all injected — the same shape
 * `runSocket.test.ts` uses, for the same reason.
 *
 * The store and the bridge are the *real* ones. That is deliberate: the property
 * this file exists to protect is that a session which cannot open leaves the
 * editor exactly as it shipped, and a stubbed bridge could not tell anybody
 * whether that was true.
 */

import { projectCircuit, writeCircuit } from '@qsim/collab'
import { encodeBinaryPayload, encodeFrame, SOCKET_CLOSE } from '@qsim/contract'
import type {
  ClientFrame,
  CollabAccess,
  PresenceState,
  ServerFrame,
} from '@qsim/contract'
import { parseCircuit, type Circuit } from '@qsim/schema'
import { describe, expect, it } from 'vitest'
import * as Y from 'yjs'

import {
  createCircuitStore,
  type CircuitStore,
} from '../circuit-editor/useCircuitStore'
import {
  MAX_REJOIN_ATTEMPTS,
  RECONNECT_BACKOFF_MS,
  UPDATE_COALESCE_MS,
  createCollabSession,
  type CollabSession,
  type CollabSocketLike,
} from './collabSession'

const CIRCUIT_ID = 'circuit1'

function circuitWith(gates: readonly number[]): Circuit {
  return parseCircuit({
    schemaVersion: 1,
    qubits: 2,
    operations: gates.map((column) => ({
      id: `r${column}`,
      gate: 'h',
      targets: [0],
      column,
    })),
  })
}

/** The relay's copy of the document, seeded as `documents.ts` seeds one. */
function relayDocument(circuit: Circuit, clientID = 900_001): Y.Doc {
  const doc = new Y.Doc()
  doc.clientID = clientID
  writeCircuit(doc, circuit, { origin: null, baseline: projectCircuit(doc) })
  return doc
}

interface FakeSocket extends CollabSocketLike {
  readonly sent: ClientFrame[]
  closedWith: number | null
  open(): void
  deliver(frame: ServerFrame): void
  drop(code?: number): void
}

function fakeSocket(): FakeSocket {
  const socket: FakeSocket = {
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

interface Timer {
  readonly run: () => void
  readonly delay: number
}

interface Harness {
  readonly session: CollabSession
  readonly store: CircuitStore
  readonly opened: FakeSocket[]
  readonly current: () => FakeSocket
  /** Runs the first pending timer with this delay. */
  readonly fire: (delay: number) => void
  readonly delays: () => number[]
  readonly advance: (ms: number) => void
  /** Everything this client has sent on the current socket. */
  readonly sent: () => ClientFrame[]
  readonly updates: () => Uint8Array[]
}

interface HarnessOptions {
  readonly token?: string | null
  readonly connectThrows?: boolean
  readonly seed?: 'document' | 'store'
}

function harness(options: HarnessOptions = {}): Harness {
  const opened: FakeSocket[] = []
  const timers: Timer[] = []
  const store = createCircuitStore()
  let clock = 0

  const session = createCollabSession({
    circuitId: CIRCUIT_ID,
    store,
    connect: () => {
      if (options.connectThrows === true) throw new Error('refused')
      const created = fakeSocket()
      opened.push(created)
      return created
    },
    getToken: () => Promise.resolve(options.token ?? null),
    ...(options.seed === undefined ? {} : { seed: options.seed }),
    now: () => clock,
    schedule: (run, delay) => {
      const entry = { run, delay }
      timers.push(entry)
      return () => {
        const index = timers.indexOf(entry)
        if (index >= 0) timers.splice(index, 1)
      }
    },
    // The midpoint of the jitter window, so every delay is exactly its base.
    random: () => 0.5,
  })

  const current = (): FakeSocket => {
    const last = opened.at(-1)
    if (last === undefined) throw new Error('nothing has connected')
    return last
  }

  return {
    session,
    store,
    opened,
    current,
    delays: () => timers.map((timer) => timer.delay),
    fire: (delay) => {
      const index = timers.findIndex((timer) => timer.delay === delay)
      if (index < 0) {
        throw new Error(
          `no timer pending at ${delay}ms; pending: ${timers
            .map((timer) => timer.delay)
            .join(', ')}`
        )
      }
      const [entry] = timers.splice(index, 1)
      entry?.run()
    },
    advance: (ms) => {
      clock += ms
    },
    sent: () => current().sent,
    updates: () =>
      current()
        .sent.filter((frame) => frame.type === 'collab:update')
        .map((frame) => decode(frame.update)),
  }
}

/** Base64 back to bytes, in the test rather than through the decoder it tests. */
function decode(text: string): Uint8Array {
  const binary = atob(text)
  const bytes = new Uint8Array(binary.length)
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index)
  }
  return bytes
}

function joinedFrame(
  relay: Y.Doc,
  access: CollabAccess = 'write',
  since?: Uint8Array
): ServerFrame {
  const update =
    since === undefined
      ? Y.encodeStateAsUpdate(relay)
      : Y.encodeStateAsUpdate(relay, since)
  return {
    type: 'collab:joined',
    circuitId: CIRCUIT_ID,
    access,
    update: encodeBinaryPayload(update),
    vector: encodeBinaryPayload(Y.encodeStateVector(relay)),
    deferred: 0,
    overflow: 0,
  }
}

function presenceFrame(
  peerId: string,
  state: PresenceState | null
): ServerFrame {
  return { type: 'collab:presence', circuitId: CIRCUIT_ID, peerId, state }
}

const READY: ServerFrame = { type: 'ready', viewer: null, expiresAt: null }

/** Opens a session that has joined, and returns the relay's document. */
async function opened(
  test: Harness,
  access: CollabAccess = 'write',
  circuit: Circuit = circuitWith([0])
): Promise<Y.Doc> {
  const relay = relayDocument(circuit)
  test.current().open()
  await Promise.resolve()
  test.current().deliver(READY)
  test.current().deliver(joinedFrame(relay, access))
  return relay
}

/** What the relay would hold after applying everything this client sent. */
function relayReading(relay: Y.Doc, test: Harness): Circuit {
  for (const update of test.updates()) Y.applyUpdate(relay, update)
  return projectCircuit(relay).circuit
}

describe('the join handshake', () => {
  it('joins on the first ready when there is no token, with no vector', async () => {
    const test = harness()
    test.current().open()
    await Promise.resolve()
    test.current().deliver(READY)

    expect(test.sent()).toEqual([
      { type: 'collab:join', circuitId: CIRCUIT_ID },
    ])
  })

  it('authenticates first and waits for the ready that answers it', async () => {
    const test = harness({ token: 'token.value' })
    test.current().open()
    await Promise.resolve()

    expect(test.sent()).toEqual([
      { type: 'authenticate', token: 'token.value' },
    ])

    // The pre-authentication `ready`, which the relay sends the instant a socket
    // opens. Joining here would ask the relay to authorise the circuit against
    // an anonymous viewer — a NOT_FOUND for a circuit the owner can plainly see.
    test.current().deliver(READY)
    expect(test.sent()).toHaveLength(1)

    test.current().deliver({ type: 'ready', viewer: 'u1', expiresAt: null })
    expect(test.sent().at(-1)).toEqual({
      type: 'collab:join',
      circuitId: CIRCUIT_ID,
    })
  })

  it('joins anonymously when the token is refused', async () => {
    const test = harness({ token: 'stale.token' })
    test.current().open()
    await Promise.resolve()
    test.current().deliver({
      type: 'error',
      code: 'AUTH_INVALID_TOKEN',
      runId: null,
    })

    expect(test.sent().at(-1)).toEqual({
      type: 'collab:join',
      circuitId: CIRCUIT_ID,
    })
  })

  it('adopts the relay’s document and reports the access it was granted', async () => {
    const test = harness()
    await opened(test, 'write', circuitWith([0, 2]))

    expect(test.session.snapshot()).toMatchObject({
      status: 'open',
      access: 'write',
      ended: null,
      reconciled: true,
    })
    expect(
      test.store.getState().circuit.operations.map((entry) => entry.column)
    ).toEqual([0, 2])
  })

  it('announces where this client is looking as soon as it has joined', async () => {
    const test = harness()
    await opened(test)

    const presence = test.sent().filter((f) => f.type === 'collab:presence')
    expect(presence).toEqual([
      {
        type: 'collab:presence',
        circuitId: CIRCUIT_ID,
        state: { cursor: null, selection: [], edits: 0 },
      },
    ])
  })
})

describe('a solo editor, until a session actually opens', () => {
  it('does not touch the store before a join, and undo stays the store’s own', async () => {
    const test = harness()
    const before = test.store.getState().circuit
    test.current().open()
    await Promise.resolve()
    test.current().deliver(READY)

    expect(test.store.getState().circuit).toBe(before)
    expect(test.session.snapshot().status).toBe('connecting')

    // The editor that shipped: a placement, then zundo puts it back.
    test.store.getState().placeGate('h', [0], 0)
    expect(test.store.getState().circuit.operations).toHaveLength(1)
    expect(test.store.getState().undo().ok).toBe(true)
    expect(test.store.getState().circuit.operations).toHaveLength(0)
  })

  it('leaves the store alone when the socket cannot be opened at all', () => {
    const test = harness({ connectThrows: true })
    const before = test.store.getState().circuit

    expect(test.opened).toHaveLength(0)
    expect(test.store.getState().circuit).toBe(before)
    // Retried on the backoff: a URL the browser refuses is indistinguishable
    // from a host that is down.
    expect(test.delays()).toContain(RECONNECT_BACKOFF_MS[0])
  })
})

describe('publishing this client’s edits', () => {
  it('sends the first edit at once and merges what follows it', async () => {
    const test = harness()
    const relay = await opened(test)

    test.store.getState().placeGate('h', [1], 1)
    expect(test.updates()).toHaveLength(1)

    // Inside the coalescing window: both accumulate and travel as one frame,
    // which is what the relay's budget was sized against.
    test.advance(10)
    test.store.getState().placeGate('x', [1], 2)
    test.store.getState().placeGate('x', [1], 3)
    expect(test.updates()).toHaveLength(1)

    test.fire(UPDATE_COALESCE_MS - 10)
    expect(test.updates()).toHaveLength(2)

    const reading = relayReading(relay, test)
    expect(
      reading.operations.map((entry) => `${entry.gate}@${entry.column}`)
    ).toEqual(['h@0', 'h@1', 'x@2', 'x@3'])
  })

  it('sends nothing at all while this peer may only read', async () => {
    const test = harness()
    await opened(test, 'read')

    test.store.getState().placeGate('h', [1], 1)
    test.advance(UPDATE_COALESCE_MS)
    expect(test.updates()).toEqual([])
  })

  it('stops sending when a refusal arrives after the interface was drawn', async () => {
    const test = harness()
    await opened(test, 'write')

    // The circuit was transferred out from under this peer: the relay downgrades
    // the attachment in place and refuses the next update.
    test.current().deliver({
      type: 'collab:error',
      circuitId: CIRCUIT_ID,
      code: 'FORBIDDEN',
    })
    expect(test.session.snapshot()).toMatchObject({
      status: 'open',
      access: 'read',
      error: 'FORBIDDEN',
    })

    const before = test.updates().length
    test.store.getState().placeGate('h', [1], 1)
    test.advance(UPDATE_COALESCE_MS)
    expect(test.updates()).toHaveLength(before)
  })

  it('reports an update the relay refused for its size as unreconciled', async () => {
    const test = harness()
    await opened(test)

    test.current().deliver({
      type: 'collab:error',
      circuitId: CIRCUIT_ID,
      code: 'PAYLOAD_TOO_LARGE',
    })
    // The attachment survives, so the session does — but this client's document
    // now holds an edit nobody else has, and that is not hidden.
    expect(test.session.snapshot()).toMatchObject({
      status: 'open',
      reconciled: false,
    })
  })
})

describe('receiving other people’s work', () => {
  it('applies an inbound update to the document on screen', async () => {
    const test = harness()
    const relay = await opened(test)

    const before = Y.encodeStateVector(relay)
    writeCircuit(relay, circuitWith([0, 4]), {
      origin: null,
      baseline: projectCircuit(relay),
    })
    test.current().deliver({
      type: 'collab:update',
      circuitId: CIRCUIT_ID,
      update: encodeBinaryPayload(Y.encodeStateAsUpdate(relay, before)),
    })

    expect(
      test.store.getState().circuit.operations.map((entry) => entry.column)
    ).toEqual([0, 4])
  })

  it('records a peer’s presence, and forgets it when the peer goes', async () => {
    const test = harness()
    await opened(test)
    const state: PresenceState = {
      cursor: { qubit: 1, column: 2 },
      selection: [],
      edits: 0,
      name: 'Ana',
      access: 'write',
    }

    test.current().deliver(presenceFrame('peer-2', state))
    expect(test.session.presence.snapshot().peers).toHaveLength(1)

    test.current().deliver(presenceFrame('peer-2', null))
    expect(test.session.presence.snapshot().peers).toEqual([])
  })

  it('lets the session go when a peer’s bytes do not read as a document', async () => {
    const test = harness()
    await opened(test)
    const before = test.store.getState().circuit

    // Well-formed base64, and not a Yjs update. The bridge refuses it, which is
    // the transport's cue: a projection cannot un-apply what a peer sent.
    test.current().deliver({
      type: 'collab:update',
      circuitId: CIRCUIT_ID,
      update: encodeBinaryPayload(new Uint8Array([9, 9, 9, 9])),
    })

    expect(test.session.snapshot()).toMatchObject({
      status: 'ended',
      ended: 'invalid',
      access: null,
    })
    // The editor keeps the circuit it had, and gets its own undo back.
    expect(test.store.getState().circuit).toBe(before)
    expect(test.current().closedWith).not.toBeNull()
  })

  it('drops a payload that is not base64 without applying anything', async () => {
    const test = harness()
    await opened(test)

    test.current().deliver({
      type: 'collab:update',
      circuitId: CIRCUIT_ID,
      update: 'not base64 at all',
    })
    expect(test.session.snapshot().status).toBe('open')
  })
})

describe('a dropped socket', () => {
  it('reconnects on the backoff and rejoins with what it already holds', async () => {
    const test = harness()
    await opened(test)

    test.current().drop()
    expect(test.session.snapshot()).toMatchObject({
      status: 'reconnecting',
      /*
       * The last access the relay stated, and *not* null.
       *
       * Clearing it was found to hand a read-only peer a fully writable editor
       * for the length of every dropped socket: the page draws read-only from
       * `access === 'read'`, so undo came back, the palette came back, and the
       * gate placed then went into that peer's own document and into no other —
       * `flush` and `reconcile` both need write access, so it could never travel,
       * and the rejoin restored the notice with the divergence left in place. See
       * `CollabSessionSnapshot.access`.
       */
      access: 'write',
    })
    // Everybody's caret goes with the connection: those peers did not leave.
    expect(test.session.presence.snapshot().peers).toEqual([])

    test.fire(RECONNECT_BACKOFF_MS[0])
    expect(test.opened).toHaveLength(2)
    test.current().open()
    await Promise.resolve()
    test.current().deliver(READY)

    const join = test.sent().at(-1)
    expect(join?.type).toBe('collab:join')
    expect(join?.type === 'collab:join' ? join.since : undefined).toBeTypeOf(
      'string'
    )
  })

  /**
   * A watcher whose socket dropped is still a watcher.
   *
   * The page has one input for "may this reader edit" and it is `access`, so a
   * reconnect that cleared it invited an edit the relay would refuse and the
   * session could never carry — a permanent divergence produced by a lid closing.
   */
  it('keeps a watcher read-only while the socket is coming back', async () => {
    const test = harness()
    await opened(test, 'read')

    test.current().drop()
    expect(test.session.snapshot()).toMatchObject({
      status: 'reconnecting',
      access: 'read',
    })

    test.fire(RECONNECT_BACKOFF_MS[0])
    test.current().open()
    await Promise.resolve()
    expect(test.session.snapshot().access).toBe('read')

    // An ending is the one thing that clears it: there is no session left to
    // have access to, and the editor is the reader's own again.
    test.current().deliver({
      type: 'collab:error',
      circuitId: CIRCUIT_ID,
      code: 'SIMULATION_UNAVAILABLE',
    })
    expect(test.session.snapshot()).toMatchObject({
      status: 'ended',
      access: null,
    })
  })

  it('sends the session what it missed while this peer was away', async () => {
    const test = harness()
    const relay = await opened(test)
    test.current().drop()

    // Edited offline. The bridge keeps it — that is the CRDT working — and
    // nothing has ever asked this peer for it.
    test.store.getState().placeGate('x', [1], 5)

    test.fire(RECONNECT_BACKOFF_MS[0])
    test.current().open()
    await Promise.resolve()
    test.current().deliver(READY)
    const since = test.sent().at(-1)
    const vector =
      since?.type === 'collab:join' && since.since !== undefined
        ? decode(since.since)
        : undefined
    test.current().deliver(joinedFrame(relay, 'write', vector))

    // The relay's vector on the join frame is what makes this possible.
    const reading = relayReading(relay, test)
    expect(
      reading.operations.map((entry) => `${entry.gate}@${entry.column}`)
    ).toEqual(['h@0', 'x@5'])
  })

  it('joins without a vector when the document has too many writers to name', async () => {
    const test = harness()
    const relay = await opened(test)
    const doc = relay // any document; the vector is this client's own

    /*
     * A clock per peer that has ever written. Past `MAX_JOIN_VECTOR_BYTES` the
     * frame omits it and the relay sends the whole document — correct and merely
     * expensive, where a truncated vector would be a lie about what is held.
     */
    for (let writer = 0; writer < 700; writer += 1) {
      const stranger = new Y.Doc()
      stranger.clientID = 1_000_000 + writer
      stranger.getMap('unrelated').set(`k${writer}`, writer)
      Y.applyUpdate(doc, Y.encodeStateAsUpdate(stranger))
    }
    test.current().deliver({
      type: 'collab:update',
      circuitId: CIRCUIT_ID,
      update: encodeBinaryPayload(Y.encodeStateAsUpdate(doc)),
    })

    test.current().drop()
    test.fire(RECONNECT_BACKOFF_MS[0])
    test.current().open()
    await Promise.resolve()
    test.current().deliver(READY)

    expect(test.sent().at(-1)).toEqual({
      type: 'collab:join',
      circuitId: CIRCUIT_ID,
    })
  })

  it('does not reconnect after a protocol close', async () => {
    const test = harness()
    await opened(test)

    test.current().drop(SOCKET_CLOSE.PROTOCOL)
    expect(test.session.snapshot()).toMatchObject({
      status: 'ended',
      ended: 'unavailable',
    })
    expect(test.delays()).not.toContain(RECONNECT_BACKOFF_MS[0])
  })

  it('reconnects after being closed for being too fast', async () => {
    const test = harness()
    await opened(test)

    // OVERLOADED is not PROTOCOL: the frames were valid, this build is not
    // wrong, and the ordinary backoff is the right answer.
    test.current().drop(SOCKET_CLOSE.OVERLOADED)
    expect(test.session.snapshot().status).toBe('reconnecting')
    test.fire(RECONNECT_BACKOFF_MS[0])
    expect(test.opened).toHaveLength(2)
  })
})

describe('endings the relay decides', () => {
  it('ends for good when the circuit stops being this viewer’s', async () => {
    const test = harness()
    await opened(test)

    test.current().deliver({
      type: 'collab:left',
      circuitId: CIRCUIT_ID,
      reason: 'unauthorised',
    })

    expect(test.session.snapshot()).toMatchObject({
      status: 'ended',
      ended: 'unauthorised',
      access: null,
    })
    // No rejoin: it would be refused, and a loop of refusals says nothing.
    expect(test.delays()).toEqual([])
  })

  it('rejoins when the relay lets the document go, and gives up bounded', async () => {
    const test = harness()
    const relay = await opened(test)

    for (let attempt = 0; attempt < MAX_REJOIN_ATTEMPTS; attempt += 1) {
      test.current().deliver({
        type: 'collab:left',
        circuitId: CIRCUIT_ID,
        reason: 'gone',
      })
      expect(test.session.snapshot().status).toBe('reconnecting')
      test.fire(
        RECONNECT_BACKOFF_MS[
          Math.min(attempt, RECONNECT_BACKOFF_MS.length - 1)
        ] as number
      )
      test.current().deliver(joinedFrame(relay))
      expect(test.session.snapshot().status).toBe('open')
    }

    // The fourth ending is one this client stops answering: a document dropped
    // by every join would otherwise be rejoined forever.
    test.current().deliver({
      type: 'collab:left',
      circuitId: CIRCUIT_ID,
      reason: 'gone',
    })
    expect(test.session.snapshot()).toMatchObject({
      status: 'ended',
      ended: 'gone',
    })
  })

  it('tries the join again when the relay is full or its database is not', async () => {
    const test = harness()
    test.current().open()
    await Promise.resolve()
    test.current().deliver(READY)
    test.current().deliver({
      type: 'collab:error',
      circuitId: CIRCUIT_ID,
      code: 'RATE_LIMITED',
    })

    // Still `connecting`: this session has never been open, so reporting a
    // reconnection would describe something that never happened.
    expect(test.session.snapshot()).toMatchObject({
      status: 'connecting',
      error: 'RATE_LIMITED',
    })
    test.fire(RECONNECT_BACKOFF_MS[0])
    expect(test.sent().at(-1)?.type).toBe('collab:join')
  })

  it('stops quietly when there is no such circuit for this viewer', async () => {
    const test = harness()
    test.current().open()
    await Promise.resolve()
    test.current().deliver(READY)
    const before = test.store.getState().circuit

    test.current().deliver({
      type: 'collab:error',
      circuitId: CIRCUIT_ID,
      code: 'NOT_FOUND',
    })

    expect(test.session.snapshot()).toMatchObject({
      status: 'ended',
      ended: 'unavailable',
      error: 'NOT_FOUND',
    })
    expect(test.store.getState().circuit).toBe(before)
    expect(test.delays()).toEqual([])
  })

  it('stops quietly on a deployment with collaboration switched off', async () => {
    const test = harness()
    test.current().open()
    await Promise.resolve()
    test.current().deliver(READY)

    test.current().deliver({
      type: 'collab:error',
      circuitId: CIRCUIT_ID,
      code: 'SIMULATION_UNAVAILABLE',
    })
    expect(test.session.snapshot()).toMatchObject({
      status: 'ended',
      ended: 'unavailable',
      error: 'SIMULATION_UNAVAILABLE',
    })
  })

  it('ignores frames about a circuit this session is not in', async () => {
    const test = harness()
    await opened(test)

    test.current().deliver({
      type: 'collab:left',
      circuitId: 'somebody-else',
      reason: 'unauthorised',
    })
    expect(test.session.snapshot().status).toBe('open')
  })
})

describe('leaving', () => {
  it('flushes, says goodbye and closes', async () => {
    const test = harness()
    const relay = await opened(test)

    test.store.getState().placeGate('h', [1], 1)
    test.advance(10)
    test.store.getState().placeGate('x', [1], 2)
    const socket = test.current()

    test.session.stop()

    // The queued edit is not lost to a coalescing window that never elapsed:
    // there is no rejoin after an unmount to recover it.
    const reading = relayReading(relay, test)
    expect(
      reading.operations.map((entry) => `${entry.gate}@${entry.column}`)
    ).toEqual(['h@0', 'h@1', 'x@2'])
    expect(socket.sent.at(-1)).toEqual({
      type: 'collab:leave',
      circuitId: CIRCUIT_ID,
    })
    expect(socket.closedWith).not.toBeNull()
    expect(test.session.snapshot().status).toBe('off')
  })

  it('sends nothing more, and reconnects to nothing, once stopped', async () => {
    const test = harness()
    await opened(test)
    test.session.stop()
    const before = test.current().sent.length

    test.store.getState().placeGate('h', [1], 1)
    test.advance(UPDATE_COALESCE_MS)
    expect(test.current().sent).toHaveLength(before)
    expect(test.delays()).toEqual([])
    expect(test.opened).toHaveLength(1)
  })
})
