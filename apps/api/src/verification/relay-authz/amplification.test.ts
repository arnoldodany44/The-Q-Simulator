/**
 * What the collaboration budget actually bounds.
 *
 * `MAX_COLLAB_BYTES_PER_WINDOW` exists because "the work is linear in bytes
 * twice over — once to integrate, once to reproject" (§3.4, M5.2 decision 2;
 * `socket.ts`). Integration is linear in the *update*. Reprojection is not: it
 * reads every slot the **document** holds, parses each through the contract, and
 * `apply` then re-encodes the whole document to check its size and to hand it to
 * the persister. So the cost of a frame is set by the size of the document it
 * lands on, and the budget that is supposed to bound the cost counts the frame.
 *
 * A document may hold `MAX_DOCUMENT_OPERATIONS` (4096) operations and
 * `MAX_COLLAB_STATE_BYTES` (512 KiB) of state, and a writer can produce one in a
 * single REST call, because a saved circuit may be 256 KiB. This file drives the
 * real socket at the rate the budget permits and shows that the byte budget is
 * nowhere near binding while the work is not bounded at all.
 *
 * No wall-clock assertion lives here (that rule is absolute — such a thing goes
 * in a `*.perf.test.ts`). What is asserted is the shape: every frame accepted,
 * nothing refused, a rounding error of the byte budget spent.
 */

import { describe, expect, it } from 'vitest'
import { MAX_COLLAB_BYTES_PER_WINDOW } from '@qsim/contract'
import { emptyCircuit, type Circuit, type Operation } from '@qsim/schema'
import {
  connect,
  editUpdate,
  payload,
  peerDocument,
  startRelay,
} from './harness.js'
import { OWNER } from './fixtures.js'

/** A circuit near the ceiling of what may be saved, and therefore seeded. */
function bigCircuit(operations: number): Circuit {
  const ops: Operation[] = []
  for (let index = 0; index < operations; index += 1) {
    ops.push({
      id: `op_${String(index)}`,
      gate: 'h',
      targets: [index % 8],
      column: Math.floor(index / 8),
    })
  }
  return { ...emptyCircuit(8), operations: ops }
}

describe('a small update on a large document', () => {
  it('is accepted at the permitted rate while spending none of the byte budget', async () => {
    const relay = await startRelay()
    try {
      relay.repository.addUser({ id: OWNER, username: 'ada' })
      const created = await relay.repository.create({
        ownerId: OWNER,
        title: 'a document at the ceiling',
        description: null,
        visibility: 'PRIVATE',
        data: bigCircuit(3_000),
        message: null,
        forkedFromId: null,
      })
      const handle = created.circuit.id

      const owner = await connect(relay, {
        bearer: await relay.token({ subject: OWNER }),
      })
      owner.send({ type: 'collab:join', circuitId: handle })
      const joined = await owner.waitFor(
        (frame) => frame.type === 'collab:joined'
      )
      const document = peerDocument(joined)

      let bytes = 0
      const frames = 60
      for (let index = 0; index < frames; index += 1) {
        const update = editUpdate(document, (circuit) => ({
          ...circuit,
          operations: [
            ...circuit.operations,
            {
              id: `op_probe_${String(index)}`,
              gate: 'h',
              targets: [0],
              column: 500 + index,
            },
          ],
        }))
        const encoded = payload(update)
        bytes += encoded.length
        owner.send({
          type: 'collab:update',
          circuitId: handle,
          update: encoded,
        })
        await owner.quiet(10)
      }

      // Every frame accepted: no refusal, no close, no downgrade.
      expect(owner.closeCode()).toBeNull()
      expect(owner.frames.map((frame) => frame.type)).not.toContain(
        'collab:error'
      )
      expect(owner.frames.map((frame) => frame.type)).not.toContain(
        'collab:left'
      )
      // And the budget meant to bound the work is untouched: sixty frames of
      // real editing is ~10.8 KB — one percent of the window's mebibyte — while
      // each one reprojects and re-encodes a 370 KB document.
      expect(bytes).toBeLessThan(MAX_COLLAB_BYTES_PER_WINDOW / 50)
    } finally {
      await relay.close()
    }
    // Sixty projections of a 370 KB document, on both sides of the socket, do
    // not fit in the default five seconds — which is the finding, stated as a
    // timeout rather than as an assertion.
  }, 120_000)
})
