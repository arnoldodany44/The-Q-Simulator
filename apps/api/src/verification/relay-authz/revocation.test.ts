/**
 * What happens to a live session when the owner takes access away.
 *
 * The properties this file asserts are the ones §3.4 (M5.2, decision 5) claims
 * and §11 requires. Derived, not read off the code:
 *
 *   - un-publishing a circuit must stop *delivery* to a peer who could read it,
 *     within the authorisation TTL, and must say why rather than going quiet;
 *   - it must also stop presence reaching them, which is a second delivery path
 *     with a different mechanism;
 *   - a rejoin after revocation must be refused like any other stranger's;
 *   - losing only *write* access must downgrade an attachment rather than end
 *     it — a peer who may still read should keep watching — and the next update
 *     must be refused.
 */

import { describe, expect, it } from 'vitest'
import {
  connect,
  editUpdate,
  payload,
  peerDocument,
  startRelay,
} from './harness.js'
import { OWNER, STRANGER, row, seed, withGate } from './fixtures.js'

/** Longer than AUTHORISATION_TTL_MS (2 s), shorter than anything else. */
const PAST_THE_TTL = 2_300

describe('revocation while a session is running', () => {
  it('stops delivering to a reader whose circuit was unpublished', async () => {
    const relay = await startRelay()
    try {
      const circuits = await seed(relay)
      const handle = circuits.public.id
      const owner = await connect(relay, {
        bearer: await relay.token({ subject: OWNER }),
      })
      const watcher = await connect(relay, {
        bearer: await relay.token({ subject: STRANGER }),
      })
      owner.send({ type: 'collab:join', circuitId: handle })
      const joined = await owner.waitFor(
        (frame) => frame.type === 'collab:joined'
      )
      watcher.send({ type: 'collab:join', circuitId: handle })
      await watcher.waitFor((frame) => frame.type === 'collab:joined')
      const document = peerDocument(joined)

      // The first edit reaches the watcher: this is the control.
      owner.send({
        type: 'collab:update',
        circuitId: handle,
        update: payload(editUpdate(document, withGate('op_before'))),
      })
      await watcher.waitFor((frame) => frame.type === 'collab:update')

      await relay.repository.update({
        id: handle,
        ownerId: OWNER,
        visibility: 'PRIVATE',
      })
      await watcher.quiet(PAST_THE_TTL)
      watcher.frames.length = 0

      owner.send({
        type: 'collab:update',
        circuitId: handle,
        update: payload(editUpdate(document, withGate('op_after'))),
      })
      const left = await watcher.waitFor(
        (frame) => frame.type === 'collab:left'
      )
      expect(left).toMatchObject({ circuitId: handle, reason: 'unauthorised' })
      expect(watcher.frames.map((frame) => frame.type)).not.toContain(
        'collab:update'
      )

      // And the door is shut behind them.
      watcher.frames.length = 0
      watcher.send({ type: 'collab:join', circuitId: handle })
      expect(
        await watcher.waitFor((frame) => frame.type.startsWith('collab:'))
      ).toMatchObject({ type: 'collab:error', code: 'NOT_FOUND' })
    } finally {
      await relay.close()
    }
  })

  it('stops presence reaching a reader whose circuit was unpublished', async () => {
    const relay = await startRelay()
    try {
      const circuits = await seed(relay)
      const handle = circuits.public.id
      const owner = await connect(relay, {
        bearer: await relay.token({ subject: OWNER }),
      })
      const watcher = await connect(relay)
      for (const peer of [owner, watcher]) {
        peer.send({ type: 'collab:join', circuitId: handle })
        await peer.waitFor((frame) => frame.type === 'collab:joined')
      }

      const position = {
        cursor: { qubit: 0, column: 1 },
        selection: [],
        edits: 0,
      }
      owner.send({
        type: 'collab:presence',
        circuitId: handle,
        state: position,
      })
      await watcher.waitFor((frame) => frame.type === 'collab:presence')

      await relay.repository.update({
        id: handle,
        ownerId: OWNER,
        visibility: 'PRIVATE',
      })
      await watcher.quiet(PAST_THE_TTL)
      watcher.frames.length = 0

      owner.send({
        type: 'collab:presence',
        circuitId: handle,
        state: { ...position, cursor: { qubit: 1, column: 2 } },
      })
      const left = await watcher.waitFor(
        (frame) => frame.type === 'collab:left'
      )
      expect(left).toMatchObject({ reason: 'unauthorised' })
      expect(watcher.frames.map((frame) => frame.type)).not.toContain(
        'collab:presence'
      )
    } finally {
      await relay.close()
    }
  })

  it('stops a revoked reader’s own presence from reaching anybody', async () => {
    const relay = await startRelay()
    try {
      const circuits = await seed(relay)
      const handle = circuits.public.id
      const owner = await connect(relay, {
        bearer: await relay.token({ subject: OWNER }),
      })
      const watcher = await connect(relay, {
        bearer: await relay.token({ subject: STRANGER }),
      })
      for (const peer of [owner, watcher]) {
        peer.send({ type: 'collab:join', circuitId: handle })
        await peer.waitFor((frame) => frame.type === 'collab:joined')
      }
      const position = {
        cursor: { qubit: 0, column: 0 },
        selection: [],
        edits: 0,
      }
      watcher.send({
        type: 'collab:presence',
        circuitId: handle,
        state: position,
      })
      await owner.waitFor((frame) => frame.type === 'collab:presence')

      await relay.repository.update({
        id: handle,
        ownerId: OWNER,
        visibility: 'PRIVATE',
      })
      await watcher.quiet(PAST_THE_TTL)
      owner.frames.length = 0
      watcher.frames.length = 0

      watcher.send({
        type: 'collab:presence',
        circuitId: handle,
        state: { ...position, cursor: { qubit: 1, column: 1 } },
      })
      expect(
        await watcher.waitFor((frame) => frame.type === 'collab:left')
      ).toMatchObject({ reason: 'unauthorised' })
      /*
       * Their new position never reached the owner, which is the property this
       * test is for. What the owner *is* told is that they left: the relay ejects
       * the peer and fans out `state: null`, so the ejected caret comes off the
       * grid at once rather than sitting there until the client's own 30 s expiry
       * — see `presence-staleness.test.ts`.
       */
      await owner.quiet(300)
      const seen = owner.frames.filter(
        (frame) => frame.type === 'collab:presence'
      )
      expect(seen).toHaveLength(1)
      expect(seen[0]).toMatchObject({ state: null })
    } finally {
      await relay.close()
    }
  })

  it('downgrades a writer who lost only write access, and refuses the next update', async () => {
    const relay = await startRelay()
    try {
      const circuits = await seed(relay)
      const handle = circuits.public.id
      const author = await connect(relay, {
        bearer: await relay.token({ subject: OWNER }),
      })
      author.send({ type: 'collab:join', circuitId: handle })
      const joined = await author.waitFor(
        (frame) => frame.type === 'collab:joined'
      )
      expect(joined).toMatchObject({ access: 'write' })
      const document = peerDocument(joined)

      // The circuit is transferred: still readable (PUBLIC), no longer theirs.
      row(relay, handle).ownerId = STRANGER
      await author.quiet(PAST_THE_TTL)
      author.frames.length = 0

      author.send({
        type: 'collab:update',
        circuitId: handle,
        update: payload(editUpdate(document, withGate('op_transferred'))),
      })
      expect(
        await author.waitFor((frame) => frame.type === 'collab:error')
      ).toMatchObject({ code: 'FORBIDDEN' })
      // Downgraded, not disconnected: they may still watch.
      expect(author.frames.map((frame) => frame.type)).not.toContain(
        'collab:left'
      )
      expect(author.closeCode()).toBeNull()

      // And a rejoin now states read access.
      author.frames.length = 0
      author.send({ type: 'collab:join', circuitId: handle })
      expect(
        await author.waitFor((frame) => frame.type === 'collab:joined')
      ).toMatchObject({ access: 'read' })
    } finally {
      await relay.close()
    }
  })

  it('ends a deleted circuit’s session rather than serving it on', async () => {
    const relay = await startRelay()
    try {
      const circuits = await seed(relay)
      const handle = circuits.public.id
      const owner = await connect(relay, {
        bearer: await relay.token({ subject: OWNER }),
      })
      const watcher = await connect(relay)
      for (const peer of [owner, watcher]) {
        peer.send({ type: 'collab:join', circuitId: handle })
        await peer.waitFor((frame) => frame.type === 'collab:joined')
      }
      const joined =
        owner.frames.find((frame) => frame.type === 'collab:joined') ?? null
      const document = peerDocument(joined ?? { type: 'x' })

      await relay.repository.remove({ id: handle, ownerId: OWNER })
      await watcher.quiet(PAST_THE_TTL)
      watcher.frames.length = 0
      owner.frames.length = 0

      owner.send({
        type: 'collab:update',
        circuitId: handle,
        update: payload(editUpdate(document, withGate('op_orphan'))),
      })
      expect(
        await owner.waitFor((frame) => frame.type === 'collab:left')
      ).toMatchObject({ reason: 'unauthorised' })
      expect(watcher.frames.map((frame) => frame.type)).not.toContain(
        'collab:update'
      )
    } finally {
      await relay.close()
    }
  })
})
