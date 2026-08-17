/**
 * Who may attach to a circuit's document, and who may write to it.
 *
 * Derived from §3.4 (M5.2 decision 1) and §11, not from the implementation:
 *
 *   - watching is `findReadable` — an id reaches PUBLIC and the viewer's own,
 *     a slug additionally reaches UNLISTED, and a PRIVATE circuit's only
 *     reader is its owner;
 *   - writing is `canEditCircuit` — the owner and nobody else, whatever the
 *     visibility;
 *   - a refusal is NOT_FOUND and never FORBIDDEN, so a socket cannot be used
 *     to discover that a circuit exists;
 *   - read-only is enforced on the frame, so a `collab:update` from a reader
 *     must reach no other peer and change no document.
 */

import { describe, expect, it } from 'vitest'
import { projectCircuit } from '@qsim/collab'
import * as Y from 'yjs'
import {
  connect,
  editUpdate,
  payload,
  peerDocument,
  startRelay,
} from './harness.js'
import { OWNER, STRANGER, seed, withGate } from './fixtures.js'

describe('the collaboration channel as a read path', () => {
  it('refuses a stranger every way of naming a PRIVATE circuit', async () => {
    const relay = await startRelay()
    try {
      const circuits = await seed(relay)
      const anonymous = await connect(relay)
      const stranger = await connect(relay, {
        bearer: await relay.token({ subject: STRANGER }),
      })

      for (const handle of [circuits.private.id, circuits.private.slug]) {
        for (const peer of [anonymous, stranger]) {
          peer.frames.length = 0
          peer.send({ type: 'collab:join', circuitId: handle })
          const answer = await peer.waitFor((frame) =>
            frame.type.startsWith('collab:')
          )
          expect(answer).toMatchObject({
            type: 'collab:error',
            code: 'NOT_FOUND',
          })
        }
      }
      expect(relay.app.collab?.documentCount()).toBe(0)
    } finally {
      await relay.close()
    }
  })

  it('admits a reader to a PUBLIC circuit and an UNLISTED slug, not an UNLISTED id', async () => {
    const relay = await startRelay()
    try {
      const circuits = await seed(relay)
      const peer = await connect(relay)

      peer.send({ type: 'collab:join', circuitId: circuits.public.id })
      expect(
        await peer.waitFor((frame) => frame.type === 'collab:joined')
      ).toMatchObject({ access: 'read' })

      peer.frames.length = 0
      peer.send({
        type: 'collab:join',
        circuitId: circuits.unlisted.slug,
      })
      expect(
        await peer.waitFor((frame) => frame.type.startsWith('collab:'))
      ).toMatchObject({ type: 'collab:joined', access: 'read' })

      const second = await connect(relay)
      second.send({
        type: 'collab:join',
        circuitId: circuits.unlisted.id,
      })
      expect(
        await second.waitFor((frame) => frame.type.startsWith('collab:'))
      ).toMatchObject({ type: 'collab:error', code: 'NOT_FOUND' })
    } finally {
      await relay.close()
    }
  })

  it('answers a circuit that does not exist exactly as it answers one it will not show', async () => {
    const relay = await startRelay()
    try {
      const circuits = await seed(relay)
      const peer = await connect(relay)
      const answers: unknown[] = []
      for (const handle of ['no-such-circuit', circuits.private.id]) {
        peer.frames.length = 0
        peer.send({ type: 'collab:join', circuitId: handle })
        const answer = await peer.waitFor((frame) =>
          frame.type.startsWith('collab:')
        )
        answers.push({ type: answer.type, code: answer.code })
      }
      // Identical, so the socket is not an oracle for whether a circuit exists.
      expect(answers[0]).toEqual(answers[1])
      expect(answers[0]).toEqual({
        type: 'collab:error',
        code: 'NOT_FOUND',
      })
    } finally {
      await relay.close()
    }
  })

  it('gives the owner write access to their own PRIVATE circuit', async () => {
    const relay = await startRelay()
    try {
      const circuits = await seed(relay)
      const owner = await connect(relay, {
        bearer: await relay.token({ subject: OWNER }),
      })
      owner.send({
        type: 'collab:join',
        circuitId: circuits.private.id,
      })
      expect(
        await owner.waitFor((frame) => frame.type === 'collab:joined')
      ).toMatchObject({ access: 'write' })
    } finally {
      await relay.close()
    }
  })
})

describe('the collaboration channel as a write path', () => {
  it('refuses a legal update from a reader and lets no other peer see it', async () => {
    const relay = await startRelay()
    try {
      const circuits = await seed(relay)
      const handle = circuits.public.id

      const owner = await connect(relay, {
        bearer: await relay.token({ subject: OWNER }),
      })
      owner.send({ type: 'collab:join', circuitId: handle })
      await owner.waitFor((frame) => frame.type === 'collab:joined')

      for (const reader of [
        await connect(relay),
        await connect(relay, {
          bearer: await relay.token({ subject: STRANGER }),
        }),
      ]) {
        reader.send({ type: 'collab:join', circuitId: handle })
        const joined = await reader.waitFor(
          (frame) => frame.type === 'collab:joined'
        )
        expect(joined).toMatchObject({ access: 'read' })

        owner.frames.length = 0
        reader.frames.length = 0
        // A genuinely legal edit, written on the document the join handed over:
        // the refusal must be about who is sending it and nothing else.
        const document = peerDocument(joined)
        reader.send({
          type: 'collab:update',
          circuitId: handle,
          update: payload(editUpdate(document, withGate('op_intruder'))),
        })
        expect(
          await reader.waitFor((frame) => frame.type === 'collab:error')
        ).toMatchObject({ code: 'FORBIDDEN' })
        // The document must not have moved: no fan-out, and no row.
        await owner.quiet(150)
        expect(owner.frames.map((frame) => frame.type)).not.toContain(
          'collab:update'
        )
        expect(await relay.repository.loadSession(handle)).toBeNull()
      }
    } finally {
      await relay.close()
    }
  })

  it('accepts the owner’s update, fans it out, and persists what projected', async () => {
    const relay = await startRelay()
    try {
      const circuits = await seed(relay)
      const handle = circuits.public.id
      const owner = await connect(relay, {
        bearer: await relay.token({ subject: OWNER }),
      })
      const reader = await connect(relay)
      owner.send({ type: 'collab:join', circuitId: handle })
      const joined = await owner.waitFor(
        (frame) => frame.type === 'collab:joined'
      )
      reader.send({ type: 'collab:join', circuitId: handle })
      await reader.waitFor((frame) => frame.type === 'collab:joined')

      const document = peerDocument(joined)
      owner.send({
        type: 'collab:update',
        circuitId: handle,
        update: payload(editUpdate(document, withGate('op_1'))),
      })
      const relayed = await reader.waitFor(
        (frame) => frame.type === 'collab:update'
      )
      expect(relayed.circuitId).toBe(handle)
      // The writer is never told its own update back.
      expect(owner.frames.map((frame) => frame.type)).not.toContain(
        'collab:update'
      )

      // Debounced at PERSIST_QUIET_MS; a read after it must hold the gate.
      await owner.quiet(2_400)
      const stored = await relay.repository.loadSession(handle)
      expect(stored).not.toBeNull()
      const persisted = new Y.Doc()
      Y.applyUpdate(persisted, stored?.state ?? new Uint8Array())
      expect(projectCircuit(persisted).circuit.operations).toHaveLength(1)
    } finally {
      await relay.close()
    }
  })
})
