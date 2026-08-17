/**
 * The relay end to end, through a real socket and the real repository.
 *
 * `session.test.ts` proves the state machine over fake ports and
 * `documents.test.ts` proves the document over real Yjs. Neither can reach the
 * failure this file is for: the **wiring of authorisation**. `readCircuit` is
 * assembled in `routes/ws.ts` out of `findReadable` and `canEditCircuit`, and a
 * mistake there — the wrong viewer, the two composed the wrong way round, a
 * `read` where a `write` belongs — is invisible to every test that hands the
 * session its answer.
 *
 * So every test here starts from a circuit created over HTTP by its owner, and
 * asks the question from the outside: what does a stranger get, what does a
 * reader get, and can either of them write.
 */

import {
  SOCKET_PATH,
  decodeBinaryPayload,
  encodeBinaryPayload,
  encodeFrame,
  parseServerFrame,
} from '@qsim/contract'
import type { ClientFrame, PresencePosition, ServerFrame } from '@qsim/contract'
import { projectCircuit, writeCircuit } from '@qsim/collab'
import { CIRCUIT_SCHEMA_VERSION } from '@qsim/schema'
import type { Circuit } from '@qsim/schema'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { WebSocket } from 'ws'
import * as Y from 'yjs'
import type { ApiInstance } from '../app.js'
import { createTestApp } from '../testing/app.js'
import { createMemoryCircuitRepository } from '../testing/circuit-repository.js'
import {
  createSigningKey,
  createTestJwksCache,
  signToken,
  stubJwksEndpoint,
} from '../testing/tokens.js'
import type { TestSigningKey } from '../testing/tokens.js'

const OWNER_ID = '11111111-1111-4111-8111-111111111111'
const STRANGER_ID = '22222222-2222-4222-8222-222222222222'

let app: ApiInstance
let key: TestSigningKey
let ownerToken: string
let strangerToken: string
const sockets: WebSocket[] = []

const bell: Circuit = {
  schemaVersion: CIRCUIT_SCHEMA_VERSION,
  qubits: 2,
  clbits: 0,
  operations: [
    { id: 'op-0', gate: 'h', targets: [0], column: 0 },
    { id: 'op-1', gate: 'cx', targets: [1], controls: [0], column: 1 },
  ],
}

interface Client {
  readonly frames: ServerFrame[]
  send(frame: ClientFrame): void
  next(type: ServerFrame['type']): Promise<ServerFrame>
}

function wrap(socket: WebSocket): Client {
  const frames: ServerFrame[] = []
  const waiting: { type: string; resolve: (frame: ServerFrame) => void }[] = []

  socket.on('message', (raw: Buffer) => {
    const frame = parseServerFrame(raw.toString('utf8'))
    // A frame the contract cannot parse is a violation by the server, and this
    // is the only kind of test that would ever see one.
    if (frame === null) throw new Error(`unparseable frame: ${raw.toString()}`)
    frames.push(frame)
    for (let index = waiting.length - 1; index >= 0; index -= 1) {
      const waiter = waiting[index]
      if (waiter !== undefined && waiter.type === frame.type) {
        waiting.splice(index, 1)
        waiter.resolve(frame)
      }
    }
  })

  return {
    frames,
    send: (frame) => socket.send(encodeFrame(frame)),
    next: (type) =>
      new Promise((resolve, reject) => {
        const existing = frames.find((frame) => frame.type === type)
        if (existing !== undefined) {
          resolve(existing)
          return
        }
        const timer = setTimeout(() => {
          reject(
            new Error(
              `no ${type} frame arrived; saw ${frames
                .map((frame) => frame.type)
                .join(', ')}`
            )
          )
        }, 2_000)
        waiting.push({
          type,
          resolve: (frame) => {
            clearTimeout(timer)
            resolve(frame)
          },
        })
      }),
  }
}

async function connect(token?: string): Promise<Client> {
  let client: Client | undefined
  const socket = await app.injectWS(
    SOCKET_PATH,
    {},
    { onInit: (ws) => (client = wrap(ws)) }
  )
  sockets.push(socket)
  if (client === undefined) throw new Error('injectWS never called onInit')
  await client.next('ready')
  if (token !== undefined) {
    client.send({ type: 'authenticate', token })
    // The second `ready`, which is what says the token was accepted rather than
    // ignored — the two are indistinguishable from the outside.
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
  return client
}

/** A circuit belonging to OWNER_ID, created the way a person creates one. */
async function createCircuit(
  visibility: 'PRIVATE' | 'UNLISTED' | 'PUBLIC'
): Promise<string> {
  const response = await app.inject({
    method: 'POST',
    url: '/api/v1/circuits',
    headers: { authorization: `Bearer ${ownerToken}` },
    body: { title: 'Bell pair', visibility, circuit: bell },
  })
  expect(response.statusCode).toBe(201)
  return response.json<{ circuit: { id: string } }>().circuit.id
}

/** The document a `collab:joined` frame handed over, as a browser would hold it. */
function adopt(frame: ServerFrame): Y.Doc {
  if (frame.type !== 'collab:joined') throw new Error('not a join frame')
  const doc = new Y.Doc()
  const state = decodeBinaryPayload(frame.update)
  if (state === null) throw new Error('the join frame did not decode')
  Y.applyUpdate(doc, state)
  return doc
}

/** One edit, as the bridge makes it, returning the update to send. */
function edit(doc: Y.Doc, change: (circuit: Circuit) => Circuit): Uint8Array {
  const origin = { local: true }
  const outgoing: Uint8Array[] = []
  const listener = (update: Uint8Array, from: unknown): void => {
    if (from === origin) outgoing.push(update)
  }
  doc.on('update', listener)
  const baseline = projectCircuit(doc)
  writeCircuit(doc, change(baseline.circuit), { origin, baseline })
  doc.off('update', listener)
  return Y.mergeUpdates(outgoing)
}

beforeEach(async () => {
  key = await createSigningKey('relay-key')
  app = await createTestApp({
    circuits: { repository: createMemoryCircuitRepository() },
    jwks: createTestJwksCache(stubJwksEndpoint([key])),
  })
  await app.ready()
  ownerToken = await signToken(key, {
    subject: OWNER_ID,
    email: 'ada@example.com',
  })
  strangerToken = await signToken(key, {
    subject: STRANGER_ID,
    email: 'grace@example.com',
  })
})

afterEach(async () => {
  for (const socket of sockets.splice(0)) socket.terminate()
  await app.close()
})

describe('who the relay lets in', () => {
  it('gives the owner write access to their own circuit', async () => {
    const circuitId = await createCircuit('PRIVATE')
    const owner = await connect(ownerToken)

    owner.send({ type: 'collab:join', circuitId })
    const joined = await owner.next('collab:joined')

    expect(joined).toMatchObject({ circuitId, access: 'write' })
    // And what it handed over is the saved circuit, not an empty document.
    expect(projectCircuit(adopt(joined)).circuit.operations).toEqual(
      bell.operations
    )
  })

  /**
   * The stranger, from the stranger's side. A PRIVATE circuit is not theirs to
   * read, and the answer is the 404 every read in this API gives — never a 403,
   * which would confirm that the circuit exists.
   */
  it('tells a stranger a private circuit does not exist', async () => {
    const circuitId = await createCircuit('PRIVATE')
    const stranger = await connect(strangerToken)

    stranger.send({ type: 'collab:join', circuitId })
    const refused = await stranger.next('collab:error')

    expect(refused).toEqual({
      type: 'collab:error',
      circuitId,
      code: 'NOT_FOUND',
    })
  })

  it('tells an anonymous caller the same thing about the same circuit', async () => {
    const circuitId = await createCircuit('PRIVATE')
    const anonymous = await connect()

    anonymous.send({ type: 'collab:join', circuitId })

    expect(await anonymous.next('collab:error')).toMatchObject({
      code: 'NOT_FOUND',
    })
  })

  /**
   * The read-only decision, and the consequence written down beside it: joining
   * the live session of a PUBLIC circuit shows edits its owner has not saved.
   * That is admitted deliberately — the filter doing the admitting is the same
   * one `GET /circuits/:id` uses — and the enforcement is that they may not
   * write.
   */
  it('lets a stranger watch a public circuit, and only watch it', async () => {
    const circuitId = await createCircuit('PUBLIC')
    const stranger = await connect(strangerToken)

    stranger.send({ type: 'collab:join', circuitId })
    const joined = await stranger.next('collab:joined')
    expect(joined).toMatchObject({ access: 'read' })

    // A well-formed update, built from the document the relay just handed over,
    // so nothing but the authorisation can be what refuses it.
    const doc = adopt(joined)
    const update = edit(doc, (circuit) => ({
      ...circuit,
      operations: [
        ...circuit.operations,
        { id: 'op-2', gate: 'x', targets: [0], column: 2 },
      ],
    }))
    stranger.send({
      type: 'collab:update',
      circuitId,
      update: encodeBinaryPayload(update),
    })

    expect(await stranger.next('collab:error')).toEqual({
      type: 'collab:error',
      circuitId,
      code: 'FORBIDDEN',
    })
  })

  it('does not let an anonymous caller write to a public circuit either', async () => {
    const circuitId = await createCircuit('PUBLIC')
    const anonymous = await connect()

    anonymous.send({ type: 'collab:join', circuitId })
    const joined = await anonymous.next('collab:joined')
    expect(joined).toMatchObject({ access: 'read' })

    const update = edit(adopt(joined), (circuit) => ({
      ...circuit,
      operations: [
        ...circuit.operations,
        { id: 'op-2', gate: 'x', targets: [0], column: 2 },
      ],
    }))
    anonymous.send({
      type: 'collab:update',
      circuitId,
      update: encodeBinaryPayload(update),
    })

    expect(await anonymous.next('collab:error')).toMatchObject({
      code: 'FORBIDDEN',
    })
  })
})

describe('a session between two sockets', () => {
  it('carries an owner’s edit to a watcher and refuses the reverse', async () => {
    const circuitId = await createCircuit('PUBLIC')
    const owner = await connect(ownerToken)
    const watcher = await connect(strangerToken)

    owner.send({ type: 'collab:join', circuitId })
    const ownerJoin = await owner.next('collab:joined')
    watcher.send({ type: 'collab:join', circuitId })
    await watcher.next('collab:joined')

    const doc = adopt(ownerJoin)
    const update = edit(doc, (circuit) => ({
      ...circuit,
      operations: [
        ...circuit.operations,
        { id: 'op-2', gate: 'x', targets: [0], column: 2 },
      ],
    }))
    owner.send({
      type: 'collab:update',
      circuitId,
      update: encodeBinaryPayload(update),
    })

    const relayed = await watcher.next('collab:update')
    if (relayed.type !== 'collab:update') throw new Error('wrong frame')
    const watcherDoc = adopt(await watcher.next('collab:joined'))
    const bytes = decodeBinaryPayload(relayed.update)
    Y.applyUpdate(watcherDoc, bytes as Uint8Array)

    expect(projectCircuit(watcherDoc).circuit.operations).toHaveLength(3)
    // Nothing came back to the sender: the relay skips the connection an update
    // arrived on.
    expect(
      owner.frames.filter((frame) => frame.type === 'collab:update')
    ).toEqual([])
  })

  /**
   * Revocation, from the outside. The circuit is made PRIVATE while the watcher
   * is in the session, and the attachment ends rather than the events simply
   * stopping — a stream that goes quiet is indistinguishable from a session where
   * nobody is typing.
   */
  it('ends a watcher’s attachment when the circuit is unpublished', async () => {
    const circuitId = await createCircuit('PUBLIC')
    const owner = await connect(ownerToken)
    const watcher = await connect(strangerToken)

    owner.send({ type: 'collab:join', circuitId })
    const ownerJoin = await owner.next('collab:joined')
    watcher.send({ type: 'collab:join', circuitId })
    await watcher.next('collab:joined')

    const patch = await app.inject({
      method: 'PATCH',
      url: `/api/v1/circuits/${circuitId}`,
      headers: { authorization: `Bearer ${ownerToken}` },
      body: { visibility: 'PRIVATE' },
    })
    expect(patch.statusCode).toBe(200)

    /*
     * The decision is cached for `AUTHORISATION_TTL_MS`, so the revocation takes
     * effect on the first delivery after it expires rather than instantly. That
     * is the trade `session.ts` argues: a query per update on a pool of one is
     * not available, and what the window can reach is a scratch document.
     */
    await new Promise((resolve) => setTimeout(resolve, 2_100))
    const doc = adopt(ownerJoin)
    for (const [index, gate] of ['x', 'y'].entries()) {
      const update = edit(doc, (circuit) => ({
        ...circuit,
        operations: [
          ...circuit.operations,
          { id: `op-${index + 2}`, gate, targets: [0], column: index + 2 },
        ],
      }))
      owner.send({
        type: 'collab:update',
        circuitId,
        update: encodeBinaryPayload(update),
      })
    }

    expect(await watcher.next('collab:left')).toEqual({
      type: 'collab:left',
      circuitId,
      reason: 'unauthorised',
    })
  })
})

describe('what a session leaves behind', () => {
  /**
   * The row `CircuitSession` exists for, observed from the outside: two people
   * edit, everybody leaves without saving, and the work is still there.
   */
  it('resumes a document after everybody has left', async () => {
    const circuitId = await createCircuit('PRIVATE')
    const first = await connect(ownerToken)
    first.send({ type: 'collab:join', circuitId })
    const joined = await first.next('collab:joined')

    const doc = adopt(joined)
    const update = edit(doc, (circuit) => ({
      ...circuit,
      operations: [
        ...circuit.operations,
        { id: 'op-2', gate: 'x', targets: [0], column: 2 },
      ],
    }))
    first.send({
      type: 'collab:update',
      circuitId,
      update: encodeBinaryPayload(update),
    })
    // Leave, which is what flushes the row.
    first.send({ type: 'collab:leave', circuitId })
    await new Promise((resolve) => setTimeout(resolve, 50))

    const second = await connect(ownerToken)
    second.send({ type: 'collab:join', circuitId })
    const resumed = await second.next('collab:joined')

    expect(projectCircuit(adopt(resumed)).circuit.operations).toHaveLength(3)
  })

  /**
   * And the other half of the reconciliation: a save supersedes the session, so
   * the next one starts from what was saved. This is what makes "restore version
   * 3" reach a session rather than being silently undone by a stale row.
   */
  it('starts from the head version again once a version is appended', async () => {
    const circuitId = await createCircuit('PRIVATE')
    const first = await connect(ownerToken)
    first.send({ type: 'collab:join', circuitId })
    const joined = await first.next('collab:joined')

    const update = edit(adopt(joined), (circuit) => ({
      ...circuit,
      operations: [
        ...circuit.operations,
        { id: 'op-2', gate: 'x', targets: [0], column: 2 },
      ],
    }))
    first.send({
      type: 'collab:update',
      circuitId,
      update: encodeBinaryPayload(update),
    })
    first.send({ type: 'collab:leave', circuitId })
    await new Promise((resolve) => setTimeout(resolve, 50))

    // A save — of the two-gate circuit, as a restore of version 1 would be.
    const saved = await app.inject({
      method: 'POST',
      url: `/api/v1/circuits/${circuitId}/versions`,
      headers: { authorization: `Bearer ${ownerToken}` },
      body: { circuit: bell, message: 'back to the Bell pair' },
    })
    expect(saved.statusCode).toBe(201)

    const second = await connect(ownerToken)
    second.send({ type: 'collab:join', circuitId })
    const resumed = await second.next('collab:joined')

    expect(projectCircuit(adopt(resumed)).circuit.operations).toEqual(
      bell.operations
    )
  })
})

describe('presence, from the outside (M5.3)', () => {
  const AT_COLUMN_4: PresencePosition = {
    cursor: { qubit: 0, column: 4 },
    selection: ['op-1'],
    edits: 1,
  }

  /**
   * THE WIRING THIS FILE EXISTS FOR, APPLIED TO PRESENCE.
   *
   * `readViewerName` is assembled in `routes/ws.ts` out of `findUserById`, and a
   * mistake there is invisible to `session.test.ts`, which hands the session its
   * answer. The mistake that matters is one column wide: §11 says a collaborator
   * may see a display name and never an email, and the difference between those
   * two is a property access.
   */
  it('carries the owner’s public name to a watcher, and never their email', async () => {
    const circuitId = await createCircuit('PUBLIC')
    const owner = await connect(ownerToken)
    const watcher = await connect(strangerToken)

    owner.send({ type: 'collab:join', circuitId })
    await owner.next('collab:joined')
    watcher.send({ type: 'collab:join', circuitId })
    await watcher.next('collab:joined')

    owner.send({ type: 'collab:presence', circuitId, state: AT_COLUMN_4 })
    const frame = await watcher.next('collab:presence')
    if (frame.type !== 'collab:presence') throw new Error('wrong frame')

    expect(frame.state).toMatchObject({
      access: 'write',
      cursor: { qubit: 0, column: 4 },
      selection: ['op-1'],
    })
    // A name at all — it came out of the row `POST /circuits` created — and not
    // the address the token carried.
    expect(frame.state?.name).toBeTruthy()
    expect(JSON.stringify(watcher.frames)).not.toContain('ada@example.com')
    // Nothing came back to the peer it describes: a client knows where its own
    // cursor is.
    expect(owner.frames.some((f) => f.type === 'collab:presence')).toBe(false)
  })

  it('shows a watcher as a watcher, to the person editing', async () => {
    const circuitId = await createCircuit('PUBLIC')
    const owner = await connect(ownerToken)
    const watcher = await connect(strangerToken)

    owner.send({ type: 'collab:join', circuitId })
    await owner.next('collab:joined')
    watcher.send({ type: 'collab:join', circuitId })
    await watcher.next('collab:joined')

    // A read-only peer may say where it is looking: presence writes nothing.
    watcher.send({ type: 'collab:presence', circuitId, state: AT_COLUMN_4 })
    const frame = await owner.next('collab:presence')
    if (frame.type !== 'collab:presence') throw new Error('wrong frame')

    expect(frame.state?.access).toBe('read')
  })

  it('hands a joiner the cursors that were already there', async () => {
    const circuitId = await createCircuit('PUBLIC')
    const owner = await connect(ownerToken)
    owner.send({ type: 'collab:join', circuitId })
    await owner.next('collab:joined')
    owner.send({ type: 'collab:presence', circuitId, state: AT_COLUMN_4 })
    // Let the presence reach the roster before anybody joins.
    await new Promise((resolve) => setTimeout(resolve, 30))

    const watcher = await connect(strangerToken)
    watcher.send({ type: 'collab:join', circuitId })
    await watcher.next('collab:joined')
    const frame = await watcher.next('collab:presence')
    if (frame.type !== 'collab:presence') throw new Error('wrong frame')

    expect(frame.state).toMatchObject({ cursor: { qubit: 0, column: 4 } })
  })

  it('takes a cursor away when its socket closes', async () => {
    const circuitId = await createCircuit('PUBLIC')
    const owner = await connect(ownerToken)
    const watcher = await connect(strangerToken)
    owner.send({ type: 'collab:join', circuitId })
    await owner.next('collab:joined')
    watcher.send({ type: 'collab:join', circuitId })
    await watcher.next('collab:joined')
    owner.send({ type: 'collab:presence', circuitId, state: AT_COLUMN_4 })
    await watcher.next('collab:presence')

    owner.send({ type: 'collab:leave', circuitId })

    await expect
      .poll(() =>
        watcher.frames.some(
          (frame) => frame.type === 'collab:presence' && frame.state === null
        )
      )
      .toBe(true)
  })

  /**
   * A stranger who never signed in. §3.4 admits them to a PUBLIC session on
   * purpose, and what the owner learns about them is exactly nothing: presence
   * with no name, which the client renders as a word of its own.
   */
  it('says an anonymous watcher is here without saying who they are', async () => {
    const circuitId = await createCircuit('PUBLIC')
    const owner = await connect(ownerToken)
    const anonymous = await connect()
    owner.send({ type: 'collab:join', circuitId })
    await owner.next('collab:joined')
    anonymous.send({ type: 'collab:join', circuitId })
    await anonymous.next('collab:joined')

    anonymous.send({ type: 'collab:presence', circuitId, state: AT_COLUMN_4 })
    const frame = await owner.next('collab:presence')
    if (frame.type !== 'collab:presence') throw new Error('wrong frame')

    expect(frame.state).toMatchObject({ name: null, access: 'read' })
  })

  /**
   * The stranger's side of the same coin: a PRIVATE circuit is not theirs to
   * read, so there is no session to be seen in — and the refusal comes before any
   * presence can be published.
   */
  it('lets no presence into a session a stranger could not join', async () => {
    const circuitId = await createCircuit('PRIVATE')
    const owner = await connect(ownerToken)
    const stranger = await connect(strangerToken)
    owner.send({ type: 'collab:join', circuitId })
    await owner.next('collab:joined')
    owner.send({ type: 'collab:presence', circuitId, state: AT_COLUMN_4 })

    stranger.send({ type: 'collab:join', circuitId })
    await stranger.next('collab:error')
    stranger.send({ type: 'collab:presence', circuitId, state: AT_COLUMN_4 })
    await new Promise((resolve) => setTimeout(resolve, 50))

    expect(stranger.frames.some((f) => f.type === 'collab:presence')).toBe(
      false
    )
    // And the owner never hears about the stranger either.
    expect(owner.frames.some((f) => f.type === 'collab:presence')).toBe(false)
  })
})
