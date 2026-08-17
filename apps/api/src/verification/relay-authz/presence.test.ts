/**
 * Presence carries identity, so the server has to be the one saying who is here.
 *
 * §11 in one sentence: a display name, never an email. §3.4 (M5.3, decision 1)
 * makes that enforceable by typing the frame — the peer sends a *position* and
 * the relay composes `name` and `access` from what the socket proved. So the
 * checks are:
 *
 *   - a peer cannot name itself, cannot rename another, and cannot claim write
 *     access it does not have;
 *   - the name that reaches other browsers is `displayName ?? username`,
 *     bounded, and no frame anywhere carries the email that is on the row;
 *   - the handle other peers learn is not the user's id, because a peer id is
 *     broadcast to every watcher of a PUBLIC circuit.
 */

import { describe, expect, it } from 'vitest'
import { MAX_PRESENCE_NAME_LENGTH } from '@qsim/contract'
import { connect, startRelay } from './harness.js'
import { OWNER, STRANGER, seed } from './fixtures.js'

const POSITION = {
  cursor: { qubit: 1, column: 3 },
  selection: ['op_1'],
  edits: 2,
}

describe('what a presence frame may say', () => {
  it('composes the name and the access, and refuses a peer that asserts them', async () => {
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

      owner.send({
        type: 'collab:presence',
        circuitId: handle,
        state: POSITION,
      })
      const relayed = await watcher.waitFor(
        (frame) => frame.type === 'collab:presence'
      )
      expect(relayed.state).toEqual({
        ...POSITION,
        name: 'Ada Lovelace',
        access: 'write',
      })
      // The row has an email on it; nothing this socket ever sent does.
      const everything = JSON.stringify(watcher.frames)
      expect(everything).not.toContain('@example.invalid')
      expect(everything).not.toContain('email')
      // Nor is the peer handle the user's id.
      expect(relayed.peerId).not.toBe(OWNER)
      expect(String(relayed.peerId)).not.toContain('1111')

      // A frame that tries to say who it is does not parse at all, and nothing
      // reaches the other peer.
      watcher.frames.length = 0
      owner.frames.length = 0
      owner.send({
        type: 'collab:presence',
        circuitId: handle,
        state: { ...POSITION, name: 'Grace Hopper', access: 'write' },
      })
      expect(
        await owner.waitFor((frame) => frame.type === 'error')
      ).toMatchObject({ code: 'VALIDATION_FAILED' })
      await watcher.quiet(150)
      expect(watcher.frames.map((frame) => frame.type)).not.toContain(
        'collab:presence'
      )
    } finally {
      await relay.close()
    }
  })

  it('says nothing about an anonymous peer, and calls a reader a reader', async () => {
    const relay = await startRelay()
    try {
      const circuits = await seed(relay)
      const handle = circuits.public.id
      const owner = await connect(relay, {
        bearer: await relay.token({ subject: OWNER }),
      })
      const anonymous = await connect(relay)
      const named = await connect(relay, {
        bearer: await relay.token({ subject: STRANGER }),
      })
      for (const peer of [owner, anonymous, named]) {
        peer.send({ type: 'collab:join', circuitId: handle })
        await peer.waitFor((frame) => frame.type === 'collab:joined')
      }

      anonymous.send({
        type: 'collab:presence',
        circuitId: handle,
        state: POSITION,
      })
      const asAnonymous = await owner.waitFor(
        (frame) => frame.type === 'collab:presence'
      )
      expect(asAnonymous.state).toMatchObject({ name: null, access: 'read' })

      // A signed-in reader with no display name is known by their username,
      // which is public by construction, and is still only a reader.
      named.send({
        type: 'collab:presence',
        circuitId: handle,
        state: POSITION,
      })
      const asReader = await owner.waitFor(
        (frame) =>
          frame.type === 'collab:presence' &&
          (frame.state as { name: unknown }).name === 'grace'
      )
      expect(asReader.state).toMatchObject({ name: 'grace', access: 'read' })
    } finally {
      await relay.close()
    }
  })

  it('bounds a display name rather than hiding the person behind it', async () => {
    const relay = await startRelay()
    try {
      const circuits = await seed(relay)
      const loud = '33333333-3333-4333-8333-333333333333'
      relay.repository.addUser({
        id: loud,
        username: 'loud',
        displayName: 'N'.repeat(400),
      })
      const handle = circuits.public.id
      const owner = await connect(relay, {
        bearer: await relay.token({ subject: OWNER }),
      })
      const peer = await connect(relay, {
        bearer: await relay.token({ subject: loud }),
      })
      for (const each of [owner, peer]) {
        each.send({ type: 'collab:join', circuitId: handle })
        await each.waitFor((frame) => frame.type === 'collab:joined')
      }
      peer.send({ type: 'collab:presence', circuitId: handle, state: POSITION })
      const relayed = await owner.waitFor(
        (frame) => frame.type === 'collab:presence'
      )
      const name = (relayed.state as { name: string }).name
      expect(name).toHaveLength(MAX_PRESENCE_NAME_LENGTH)
    } finally {
      await relay.close()
    }
  })

  it('hands a joiner the roster and never its own cursor back', async () => {
    const relay = await startRelay()
    try {
      const circuits = await seed(relay)
      const handle = circuits.public.id
      const first = await connect(relay, {
        bearer: await relay.token({ subject: OWNER }),
      })
      first.send({ type: 'collab:join', circuitId: handle })
      await first.waitFor((frame) => frame.type === 'collab:joined')
      first.send({
        type: 'collab:presence',
        circuitId: handle,
        state: POSITION,
      })
      await first.quiet(100)

      const second = await connect(relay)
      second.send({ type: 'collab:join', circuitId: handle })
      const joined = await second.waitFor(
        (frame) => frame.type === 'collab:joined'
      )
      const roster = await second.waitFor(
        (frame) => frame.type === 'collab:presence'
      )
      expect(second.frames.indexOf(joined)).toBeLessThan(
        second.frames.indexOf(roster)
      )
      expect(roster.state).toMatchObject({
        name: 'Ada Lovelace',
        access: 'write',
      })

      // Its own presence, published then rejoined, is not echoed to itself.
      second.send({
        type: 'collab:presence',
        circuitId: handle,
        state: POSITION,
      })
      await second.quiet(100)
      const mine = roster.peerId
      second.frames.length = 0
      second.send({ type: 'collab:join', circuitId: handle })
      await second.waitFor((frame) => frame.type === 'collab:joined')
      await second.quiet(100)
      const echoed = second.frames.filter(
        (frame) => frame.type === 'collab:presence'
      )
      expect(echoed.map((frame) => frame.peerId)).toEqual([mine])
    } finally {
      await relay.close()
    }
  })
})
