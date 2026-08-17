/**
 * One solo editor, one relay, and a socket a test can drive.
 *
 * Independent verification of M5.6's central promise: «A SOLO EDITOR MUST NOT
 * REGRESS. Most sessions have one person in them, and the editor that shipped is
 * the common case.» Every scenario here has exactly one person in the session —
 * the owner of a saved circuit, with write access and nobody else attached — and
 * asks whether the editor they get is the editor that shipped.
 *
 * The store, the bridge and the transport are the real ones. Only the socket and
 * the clock are injected, for the reason `collabSession.ts` gives: everything
 * that can go wrong is a sequence, and a sequence needs a driveable clock.
 */

import { projectCircuit, writeCircuit } from '@qsim/collab'
import { encodeBinaryPayload, encodeFrame } from '@qsim/contract'
import type {
  ClientFrame,
  CollabAccess,
  ServerFrame,
  SocketErrorCode,
} from '@qsim/contract'
import { parseCircuit, type Circuit } from '@qsim/schema'
import * as Y from 'yjs'

import {
  createCircuitStore,
  type CircuitStore,
} from '../../features/circuit-editor/useCircuitStore'
import {
  createCollabSession,
  type CollabSession,
  type CollabSessionSnapshot,
  type CollabSocketLike,
} from '../../features/collab/collabSession'

export const CIRCUIT_ID = 'V1StGXR8Z5jdHi6BmyT8a'

/** The circuit the REST call served and the editor painted: a Bell pair. */
export function savedCircuit(): Circuit {
  return parseCircuit({
    schemaVersion: 1,
    qubits: 2,
    clbits: 0,
    operations: [
      { id: 'op_1', gate: 'h', targets: [0], column: 0 },
      { id: 'op_2', gate: 'cx', targets: [1], controls: [0], column: 1 },
    ],
  })
}

/**
 * The relay's copy, seeded the way `ws/documents.ts` seeds one from the head
 * version. A different `clientID`, because it is a different writer.
 */
export function relayDocument(circuit: Circuit, clientID = 900_001): Y.Doc {
  const doc = new Y.Doc()
  doc.clientID = clientID
  writeCircuit(doc, circuit, { origin: null, baseline: projectCircuit(doc) })
  return doc
}

interface FakeSocket extends CollabSocketLike {
  readonly sent: ClientFrame[]
  open(): void
  deliver(frame: ServerFrame): void
  drop(code?: number): void
}

function fakeSocket(): FakeSocket {
  const socket: FakeSocket = {
    sent: [],
    onopen: null,
    onmessage: null,
    onclose: null,
    onerror: null,
    send: (data) => socket.sent.push(JSON.parse(data) as ClientFrame),
    close: () => undefined,
    open: () => socket.onopen?.({}),
    deliver: (frame) => socket.onmessage?.({ data: encodeFrame(frame) }),
    drop: (code) =>
      socket.onclose?.({ ...(code === undefined ? {} : { code }) }),
  }
  return socket
}

export interface SoloHarness {
  readonly session: CollabSession
  readonly store: CircuitStore
  readonly socket: () => FakeSocket
  readonly snapshot: () => CollabSessionSnapshot
  /** How many times the session told a subscriber something changed. */
  readonly notices: () => number
  readonly fire: (delay: number) => void
  readonly advance: (ms: number) => void
}

/**
 * A solo editor on a saved circuit, connected but not yet joined.
 *
 * The store already holds the saved circuit, because that is the order the
 * product has: `useCircuitDocument` seeds the canvas from the REST answer and
 * the session is opened afterwards, on the handle the server confirmed.
 */
export function soloEditor(circuit: Circuit = savedCircuit()): SoloHarness {
  const sockets: FakeSocket[] = []
  const timers: { readonly run: () => void; readonly delay: number }[] = []
  const store = createCircuitStore()
  store.getState().loadCircuit(circuit)
  let clock = 0
  let notices = 0

  const session = createCollabSession({
    circuitId: CIRCUIT_ID,
    store,
    connect: () => {
      const created = fakeSocket()
      sockets.push(created)
      return created
    },
    getToken: () => Promise.resolve(null),
    now: () => clock,
    schedule: (run, delay) => {
      const entry = { run, delay }
      timers.push(entry)
      return () => {
        const index = timers.indexOf(entry)
        if (index >= 0) timers.splice(index, 1)
      }
    },
    random: () => 0.5,
  })
  session.subscribe(() => {
    notices += 1
  })

  const socket = (): FakeSocket => {
    const last = sockets.at(-1)
    if (last === undefined) throw new Error('nothing has connected')
    return last
  }

  return {
    session,
    store,
    socket,
    snapshot: () => session.snapshot(),
    notices: () => notices,
    fire: (delay) => {
      const index = timers.findIndex((timer) => timer.delay === delay)
      if (index < 0) {
        throw new Error(
          `no timer pending at ${String(delay)}ms; pending: ${timers
            .map((timer) => String(timer.delay))
            .join(', ')}`
        )
      }
      const [entry] = timers.splice(index, 1)
      entry?.run()
    },
    advance: (ms) => {
      clock += ms
    },
  }
}

/** Opens the socket and lets the anonymous join go out. */
export async function connect(harness: SoloHarness): Promise<void> {
  harness.socket().open()
  await Promise.resolve()
  harness.socket().deliver({ type: 'ready', viewer: null, expiresAt: null })
}

/** The relay's answer to `collab:join`, with a real state vector. */
export function joinedFrame(
  relay: Y.Doc,
  access: CollabAccess = 'write'
): ServerFrame {
  return {
    type: 'collab:joined',
    circuitId: CIRCUIT_ID,
    access,
    update: encodeBinaryPayload(Y.encodeStateAsUpdate(relay)),
    vector: encodeBinaryPayload(Y.encodeStateVector(relay)),
    deferred: 0,
    overflow: 0,
  }
}

export function errorFrame(code: SocketErrorCode): ServerFrame {
  return { type: 'collab:error', circuitId: CIRCUIT_ID, code }
}

/** `gate@targets:column` for every operation, sorted. */
export function cells(circuit: Circuit): string[] {
  return circuit.operations
    .map(
      (operation) =>
        `${operation.gate}@${[...operation.targets].join('+')}:${String(
          operation.column
        )}`
    )
    .sort()
}

export function cellsOf(harness: SoloHarness): string[] {
  return cells(harness.store.getState().circuit)
}
