/**
 * The payload: a CRDT update is opaque binary from a client nobody controls.
 *
 * Four shapes, and each has one correct answer:
 *
 *   - **oversized** — refused by size, before anything decodes it, and the
 *     document untouched;
 *   - **malformed** — refused before integration, because `Y.applyUpdate` has
 *     no rollback: a document half-way through somebody's garbage belongs to
 *     everybody in the session, so the other peers must be provably unharmed;
 *   - **a legal update whose merge is an illegal circuit** — accepted, because a
 *     CRDT converges, and *projected* into something the contract accepts. This
 *     is the case §6 creates and the one a relay cannot refuse without
 *     diverging;
 *   - **a legal update carrying nonsense** (an unknown gate, a qubit the
 *     register does not have, a slot holding a number, a `__proto__` gate name)
 *     — accepted and projected away, never crashing the projection and never
 *     making the shared document unserveable.
 */

import { describe, expect, it } from 'vitest'
import { randomBytes } from 'node:crypto'
import {
  FIELD_COLUMN,
  FIELD_GATE,
  FIELD_ID,
  FIELD_TARGETS,
  META_CLBITS,
  META_QUBITS,
  circuitRoots,
  projectCircuit,
} from '@qsim/collab'
import { MAX_COLLAB_UPDATE_BYTES, MAX_SOCKET_FRAME_BYTES } from '@qsim/contract'
import { validateCircuit } from '@qsim/schema'
import * as Y from 'yjs'
import {
  connect,
  decodePayload,
  editUpdate,
  payload,
  peerDocument,
  startRelay,
  type Peer,
} from './harness.js'
import { OWNER, seed, withGate } from './fixtures.js'

async function joinAsOwner(
  handle: string,
  relay: Awaited<ReturnType<typeof startRelay>>
) {
  const peer = await connect(relay, {
    bearer: await relay.token({ subject: OWNER }),
  })
  peer.send({ type: 'collab:join', circuitId: handle })
  const joined = await peer.waitFor((frame) => frame.type === 'collab:joined')
  return { peer, joined, document: peerDocument(joined) }
}

async function joinAsWatcher(
  handle: string,
  relay: Awaited<ReturnType<typeof startRelay>>
): Promise<Peer> {
  const peer = await connect(relay)
  peer.send({ type: 'collab:join', circuitId: handle })
  await peer.waitFor((frame) => frame.type === 'collab:joined')
  return peer
}

describe('an update that is too big', () => {
  it('is refused by size, and a frame past the transport ceiling closes the socket', async () => {
    const relay = await startRelay()
    try {
      const circuits = await seed(relay)
      const handle = circuits.private.id
      const { peer } = await joinAsOwner(handle, relay)
      const watcher = await connect(relay, {
        bearer: await relay.token({ subject: OWNER }),
      })
      watcher.send({ type: 'collab:join', circuitId: handle })
      await watcher.waitFor((frame) => frame.type === 'collab:joined')

      // Valid base64, the longest the frame schema admits — which decodes to
      // two bytes more than the relay's own ceiling.
      const longest = 'A'.repeat(Math.ceil(MAX_COLLAB_UPDATE_BYTES / 3) * 4)
      expect(decodePayload(longest).byteLength).toBeGreaterThan(
        MAX_COLLAB_UPDATE_BYTES
      )
      peer.frames.length = 0
      peer.send({ type: 'collab:update', circuitId: handle, update: longest })
      expect(
        await peer.waitFor((frame) => frame.type === 'collab:error')
      ).toMatchObject({ code: 'PAYLOAD_TOO_LARGE' })
      expect(peer.closeCode()).toBeNull()

      // One byte past the schema is not a collaboration error at all: the frame
      // does not parse, so it is the generic refusal, and the socket lives.
      peer.frames.length = 0
      peer.send({
        type: 'collab:update',
        circuitId: handle,
        update: `${longest}AAAA`,
      })
      expect(
        await peer.waitFor((frame) => frame.type === 'error')
      ).toMatchObject({ code: 'VALIDATION_FAILED' })

      // And a frame past `maxPayload` never reaches the session: the protocol
      // layer closes the connection rather than buffering it.
      const flood = await connect(relay)
      flood.raw('x'.repeat(MAX_SOCKET_FRAME_BYTES + 1_024))
      expect(await flood.waitClosed()).toBe(1009)

      // Nothing of any of that touched the document.
      await watcher.quiet(150)
      expect(watcher.frames.map((frame) => frame.type)).not.toContain(
        'collab:update'
      )
      expect(await relay.repository.loadSession(handle)).toBeNull()
    } finally {
      await relay.close()
    }
  })
})

describe('an update that is not a Yjs update at all', () => {
  it('closes the sender and leaves every other peer’s document intact', async () => {
    const relay = await startRelay()
    try {
      const circuits = await seed(relay)
      const handle = circuits.private.id
      const hostile = await joinAsOwner(handle, relay)
      const second = await joinAsOwner(handle, relay)
      const watcher = await joinAsWatcher(circuits.public.id, relay)

      hostile.peer.send({
        type: 'collab:update',
        circuitId: handle,
        update: payload(new Uint8Array(randomBytes(512))),
      })
      expect(await hostile.peer.waitClosed()).toBe(4003)

      // The document is still there, and still takes a legal update.
      second.peer.frames.length = 0
      second.peer.send({
        type: 'collab:update',
        circuitId: handle,
        update: payload(editUpdate(second.document, withGate('op_after_junk'))),
      })
      await second.peer.quiet(200)
      expect(second.peer.frames.map((frame) => frame.type)).not.toContain(
        'collab:error'
      )
      expect(second.peer.closeCode()).toBeNull()

      await second.peer.quiet(2_400)
      const stored = await relay.repository.loadSession(handle)
      const doc = new Y.Doc()
      Y.applyUpdate(doc, stored?.state ?? new Uint8Array())
      const projection = projectCircuit(doc)
      expect(projection.circuit.operations).toHaveLength(1)
      expect(validateCircuit(projection.circuit)).toEqual([])
      // An unrelated session is unaffected.
      expect(watcher.closeCode()).toBeNull()
    } finally {
      await relay.close()
    }
  })
})

describe('two legal updates whose merge breaks §6', () => {
  it('converges, defers one of them, and stays a legal circuit everywhere', async () => {
    const relay = await startRelay()
    try {
      const circuits = await seed(relay)
      const handle = circuits.private.id
      const ana = await joinAsOwner(handle, relay)
      const beto = await joinAsOwner(handle, relay)

      // Both write to (q0, c0) without having seen each other: the collision a
      // CRDT cannot refuse.
      const anaUpdate = editUpdate(ana.document, withGate('op_ana', 0))
      const betoUpdate = editUpdate(beto.document, withGate('op_beto', 0))
      ana.peer.send({
        type: 'collab:update',
        circuitId: handle,
        update: payload(anaUpdate),
      })
      beto.peer.send({
        type: 'collab:update',
        circuitId: handle,
        update: payload(betoUpdate),
      })

      await ana.peer.waitFor((frame) => frame.type === 'collab:update')
      await beto.peer.waitFor((frame) => frame.type === 'collab:update')
      expect(ana.peer.frames.map((frame) => frame.type)).not.toContain(
        'collab:error'
      )
      expect(beto.peer.frames.map((frame) => frame.type)).not.toContain(
        'collab:left'
      )

      // What the relay now says the session holds, as a joiner is told.
      const joiner = await joinAsOwner(handle, relay)
      expect(joiner.joined.deferred).toBe(1)
      const projection = projectCircuit(joiner.document)
      expect(projection.circuit.operations).toHaveLength(1)
      expect(projection.deferred).toHaveLength(1)
      expect(validateCircuit(projection.circuit)).toEqual([])

      // Both peers, having merged the other's bytes, agree with the relay.
      for (const peer of [ana, beto]) {
        for (const frame of peer.peer.frames) {
          if (frame.type !== 'collab:update') continue
          Y.applyUpdate(peer.document, decodePayload(frame.update), 'remote')
        }
        const local = projectCircuit(peer.document)
        expect(local.circuit).toEqual(projection.circuit)
        expect(validateCircuit(local.circuit)).toEqual([])
      }
    } finally {
      await relay.close()
    }
  })
})

describe('a legal update whose contents are nonsense', () => {
  it('is projected away rather than crashing or dropping the document', async () => {
    const relay = await startRelay()
    try {
      const circuits = await seed(relay)
      const handle = circuits.private.id
      const owner = await joinAsOwner(handle, relay)
      const watcher = await joinAsOwner(handle, relay)

      const before = Y.encodeStateVector(owner.document)
      const roots = circuitRoots(owner.document)
      owner.document.transact(() => {
        const slot = new Y.Map<unknown>()
        slot.set(FIELD_ID, 'op_unknown_gate')
        slot.set(FIELD_GATE, 'nope')
        slot.set(FIELD_TARGETS, [0])
        slot.set(FIELD_COLUMN, 0)
        roots.operations.set('hostile-gate', slot)

        const outside = new Y.Map<unknown>()
        outside.set(FIELD_ID, 'op_out_of_register')
        outside.set(FIELD_GATE, 'h')
        outside.set(FIELD_TARGETS, [27])
        outside.set(FIELD_COLUMN, 1)
        roots.operations.set('hostile-register', outside)

        const negative = new Y.Map<unknown>()
        negative.set(FIELD_ID, 'op_negative_column')
        negative.set(FIELD_GATE, 'h')
        negative.set(FIELD_TARGETS, [0])
        negative.set(FIELD_COLUMN, -5)
        roots.operations.set('hostile-column', negative)

        // A slot that is not a field map at all.
        roots.operations.set('hostile-scalar', 7)
        // A register nobody could have meant.
        roots.meta.set(META_QUBITS, 'lots')
        roots.meta.set(META_CLBITS, 1_000_000_000)
        // A label with a NUL in it, and a prototype-shaped gate name.
        roots.labels.set('0', 'bad label')
        roots.gates.set('__proto__', { qubits: 1, operations: [] })
        roots.parameters.set('theta', { value: 'not a number', seq: 1 })
      }, 'hostile')
      const update = Y.encodeStateAsUpdate(owner.document, before)

      owner.peer.frames.length = 0
      owner.peer.send({
        type: 'collab:update',
        circuitId: handle,
        update: payload(update),
      })
      // Accepted: it is a well-formed update, and a CRDT converges.
      await watcher.peer.waitFor((frame) => frame.type === 'collab:update')
      await owner.peer.quiet(200)
      expect(owner.peer.frames.map((frame) => frame.type)).not.toContain(
        'collab:error'
      )
      expect(owner.peer.frames.map((frame) => frame.type)).not.toContain(
        'collab:left'
      )
      expect(owner.peer.closeCode()).toBeNull()

      // And what it projects to is a circuit the contract accepts.
      const joiner = await joinAsOwner(handle, relay)
      const projection = projectCircuit(joiner.document)
      expect(validateCircuit(projection.circuit)).toEqual([])
      // The unknown gate, the negative column and the scalar slot are all
      // deferred; the nonsense register and the `__proto__` definition are
      // simply not there.
      expect(projection.deferred.map((entry) => entry.reason).sort()).toEqual([
        'invalid',
        'malformed',
        'malformed',
      ])
      expect(Object.keys(projection.circuit.customGates ?? {})).toEqual([])
      expect(projection.circuit.parameters).toBeUndefined()
      /*
       * The one survivor is the operation on q27, and it survives *by widening
       * the register*: `meta.qubits` was destroyed, so the register is derived
       * from what the operations name (see `readRegister`). The projection is
       * still a circuit the contract accepts, which is the property under test —
       * but a writer can therefore turn a 2-qubit session into a 28-qubit one by
       * writing a string over one meta key.
       */
      expect(projection.circuit.operations.map((entry) => entry.id)).toEqual([
        'op_out_of_register',
      ])
      expect(projection.circuit.qubits).toBe(28)

      // The session is still there and still persists.
      await joiner.peer.quiet(2_400)
      const stored = await relay.repository.loadSession(handle)
      expect(stored).not.toBeNull()
      const persisted = new Y.Doc()
      Y.applyUpdate(persisted, stored?.state ?? new Uint8Array())
      expect(validateCircuit(projectCircuit(persisted).circuit)).toEqual([])
    } finally {
      await relay.close()
    }
  })
})
