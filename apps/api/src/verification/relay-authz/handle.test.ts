/**
 * One circuit, two handles — and §8 says the channel is `circuit:<id>`.
 *
 * `findReadable` deliberately accepts either handle: an id reaches PUBLIC, a
 * slug additionally reaches UNLISTED, which is what makes an unlisted link
 * work. The relay then uses the string the *frame* carried as the key of the
 * live document, as the argument of `loadSession`/`saveSession`, and as the
 * Redis channel name.
 *
 * What a correct relay must do is join the two peers to the same session
 * whichever handle they typed: a document is a property of the circuit, the row
 * is keyed by `circuitId`, and §3.4 (M5.2, decision 3) says there is one row per
 * circuit. It did not: the relay authorised with `findReadable` and then keyed
 * the document, the row and the channel by the *frame's* string, so a slug join
 * opened a second, empty session — the peer was told it could write, handed
 * `emptyCircuit(1, 0)` instead of the circuit that was saved, and every edit it
 * made reached nobody and was never persisted.
 *
 * `CircuitAccess` now carries the resolved `circuitId`, and this file is what
 * holds that in place.
 */

import { describe, expect, it } from 'vitest'
import * as Y from 'yjs'
import { projectCircuit } from '@qsim/collab'
import {
  connect,
  editUpdate,
  payload,
  peerDocument,
  startRelay,
} from './harness.js'
import { OWNER, seed, withGate } from './fixtures.js'

describe('a session addressed by slug instead of by id', () => {
  it('is the same document as the one addressed by id', async () => {
    const relay = await startRelay()
    try {
      const circuits = await seed(relay)
      // A circuit with something in it, saved the ordinary way.
      await relay.repository.appendVersion({
        circuitId: circuits.public.id,
        ownerId: OWNER,
        data: withGate('op_saved')(
          (
            await relay.repository.findVersion({
              circuitId: circuits.public.id,
              versionNum: 1,
            })
          )?.data ?? { schemaVersion: 1, qubits: 2, clbits: 0, operations: [] }
        ),
        message: 'a gate worth collaborating on',
      })

      const byId = await connect(relay, {
        bearer: await relay.token({ subject: OWNER }),
      })
      byId.send({ type: 'collab:join', circuitId: circuits.public.id })
      const idJoin = await byId.waitFor(
        (frame) => frame.type === 'collab:joined'
      )
      const idDocument = peerDocument(idJoin)
      expect(projectCircuit(idDocument).circuit.operations).toHaveLength(1)

      const bySlug = await connect(relay, {
        bearer: await relay.token({ subject: OWNER }),
      })
      bySlug.send({ type: 'collab:join', circuitId: circuits.public.slug })
      const slugJoin = await bySlug.waitFor(
        (frame) => frame.type === 'collab:joined'
      )
      expect(slugJoin).toMatchObject({ access: 'write' })

      // One live document for one circuit, and the slug peer was handed the
      // circuit that was saved rather than an empty one.
      expect(relay.app.collab?.documentCount()).toBe(1)
      const slugDocument = peerDocument(slugJoin)
      const slugProjection = projectCircuit(slugDocument)
      expect(slugProjection.circuit.operations).toHaveLength(1)
      expect(slugProjection.circuit.qubits).toBe(
        projectCircuit(idDocument).circuit.qubits
      )

      // An edit on one side reaches the other.
      bySlug.send({
        type: 'collab:update',
        circuitId: circuits.public.slug,
        update: payload(editUpdate(slugDocument, withGate('op_by_slug', 4))),
      })
      const relayed = await byId.waitFor(
        (frame) => frame.type === 'collab:update'
      )
      expect(relayed).toBeDefined()

      // And the work is persisted, once, under the circuit's own id — not under
      // the slug, where the foreign key would have refused it.
      await bySlug.quiet(2_400)
      const row = await relay.repository.loadSession(circuits.public.id)
      expect(row).not.toBeNull()
      const rowDocument = new Y.Doc()
      Y.applyUpdate(rowDocument, row?.state ?? new Uint8Array(), 'row')
      const persisted = projectCircuit(rowDocument).circuit
      expect(
        persisted.operations.map((operation) => operation.id).sort()
      ).toEqual(['op_by_slug', 'op_saved'])
      expect(bySlug.closeCode()).toBeNull()
    } finally {
      await relay.close()
    }
  })
})
