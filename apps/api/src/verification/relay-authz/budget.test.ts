/**
 * What a flood costs, and who pays for it.
 *
 * §11 asks for rate limiting, and `session.ts` answers with three budgets: a
 * general one for frames that reach the database, one for collaboration updates
 * (frames *and* bytes, because the work is linear in bytes) and one for
 * presence. The property this file checks is not that each budget exists — it
 * is that **every frame a stranger can send is charged to one of them.** A
 * frame type exempted from the general budget and refused before its own budget
 * is charged is a frame with no ceiling at all, which is the one shape of
 * rate-limiting bug that cannot be seen by testing each budget on its own.
 *
 * The A/B in `an unattached socket` is deliberately identical in every respect
 * except the join: same anonymous identity, same bytes, same pacing.
 */

import { describe, expect, it } from 'vitest'
import {
  MAX_COLLAB_BYTES_PER_WINDOW,
  MAX_COLLAB_PRESENCE_PER_WINDOW,
  MAX_COLLAB_UPDATES_PER_WINDOW,
  MAX_SOCKET_FRAMES_PER_WINDOW,
} from '@qsim/contract'
import { connect, startRelay, type Peer } from './harness.js'
import { OWNER, seed } from './fixtures.js'

/** Everything the server said beyond the opening `ready`. */
function answers(peer: Peer): string[] {
  return peer.frames
    .filter((frame) => frame.type !== 'ready')
    .map((frame) => frame.type)
}

/** A full-sized update payload: valid base64, the largest a frame admits. */
const FULL = 'A'.repeat(87_384)

/**
 * Writes `count` copies of one frame, politely.
 *
 * Paced so that the server's *pending* queue (32 frames, 256 KiB) is never the
 * thing that closes the socket: what is under test is the rate budget, and a
 * burst that trips the queue bound would answer a different question. Returns
 * how many were written before the socket went away.
 */
async function push(
  peer: Peer,
  frame: unknown,
  count: number
): Promise<number> {
  const text = JSON.stringify(frame)
  for (let sent = 1; sent <= count; sent += 1) {
    if (peer.closeCode() !== null) return sent - 1
    peer.raw(text)
    while (peer.socket.bufferedAmount > 128 * 1_024) await peer.quiet(1)
    if (sent % 8 === 0) await peer.quiet(1)
  }
  await peer.quiet(150)
  return count
}

describe('the budgets that do bind', () => {
  it('closes a socket that outruns the general frame budget', async () => {
    const relay = await startRelay()
    try {
      const peer = await connect(relay)
      await push(peer, { type: 'ping' }, MAX_SOCKET_FRAMES_PER_WINDOW + 5)
      expect(await peer.waitClosed()).toBe(4005)
    } finally {
      await relay.close()
    }
  })

  it('closes an attached socket that outruns the collaboration byte budget', async () => {
    const relay = await startRelay()
    try {
      const circuits = await seed(relay)
      const peer = await connect(relay)
      peer.send({ type: 'collab:join', circuitId: circuits.public.id })
      await peer.waitFor((frame) => frame.type === 'collab:joined')

      const affordable = Math.floor(MAX_COLLAB_BYTES_PER_WINDOW / FULL.length)
      const sent = await push(
        peer,
        {
          type: 'collab:update',
          circuitId: circuits.public.id,
          update: FULL,
        },
        MAX_COLLAB_UPDATES_PER_WINDOW
      )
      expect(await peer.waitClosed()).toBe(4005)
      // Closed around the frame that crossed the byte budget — a handful of
      // frames may already be in flight — and nowhere near the frame ceiling.
      expect(sent).toBeLessThan(affordable * 2)
    } finally {
      await relay.close()
    }
  })

  it('closes an attached socket that outruns the presence budget', async () => {
    const relay = await startRelay()
    try {
      const circuits = await seed(relay)
      const peer = await connect(relay, {
        bearer: await relay.token({ subject: OWNER }),
      })
      peer.send({ type: 'collab:join', circuitId: circuits.public.id })
      await peer.waitFor((frame) => frame.type === 'collab:joined')
      await push(
        peer,
        {
          type: 'collab:presence',
          circuitId: circuits.public.id,
          state: { cursor: { qubit: 0, column: 0 }, selection: [], edits: 0 },
        },
        MAX_COLLAB_PRESENCE_PER_WINDOW + 10
      )
      expect(await peer.waitClosed()).toBe(4005)
    } finally {
      await relay.close()
    }
  })
})

describe('an unattached socket', () => {
  it('is charged the general frame budget for a collaboration frame', async () => {
    const relay = await startRelay()
    try {
      const circuits = await seed(relay)
      const handle = circuits.public.id

      /*
       * The same anonymous peer and the same bytes as the attached case above —
       * the only difference is that this one never sent `collab:join`.
       *
       * The exemption from the general budget exists because a collaboration
       * frame is charged to a budget of its own. That is only true once the
       * socket holds the attachment the frame names: `update()` and `presence()`
       * return on a missing attachment *before* charging. So an unattached
       * socket's collaboration frame is an ordinary frame and is charged like
       * one, or it has no ceiling at all — which is what it had: 2 752 frames of
       * 87 KiB, 240 MB of `JSON.parse` and base64 scanning, accepted in three
       * seconds through one socket that had never authenticated.
       */
      const unattached = await connect(relay)
      const sent = await push(
        unattached,
        { type: 'collab:update', circuitId: handle, update: FULL },
        200
      )

      expect(await unattached.waitClosed()).toBe(4005)
      // Closed well inside the two hundred it tried to send, and around the
      // general budget rather than the collaboration one.
      expect(sent).toBeLessThan(MAX_SOCKET_FRAMES_PER_WINDOW * 2)

      // Presence is charged the same way.
      const presence = await connect(relay)
      await push(
        presence,
        {
          type: 'collab:presence',
          circuitId: handle,
          state: { cursor: { qubit: 0, column: 0 }, selection: [], edits: 0 },
        },
        MAX_SOCKET_FRAMES_PER_WINDOW + 10
      )
      expect(await presence.waitClosed()).toBe(4005)

      // And a circuit that does not exist buys nothing either.
      const invented = await connect(relay)
      await push(
        invented,
        { type: 'collab:update', circuitId: 'no-such-circuit', update: FULL },
        MAX_SOCKET_FRAMES_PER_WINDOW + 10
      )
      expect(await invented.waitClosed()).toBe(4005)
    } finally {
      await relay.close()
    }
  })

  it('is charged again after a `collab:leave`', async () => {
    const relay = await startRelay()
    try {
      const circuits = await seed(relay)
      const handle = circuits.public.id
      const peer = await connect(relay)
      peer.send({ type: 'collab:join', circuitId: handle })
      await peer.waitFor((frame) => frame.type === 'collab:joined')
      peer.send({ type: 'collab:leave', circuitId: handle })
      await peer.quiet(50)

      // Leaving gives the exemption up with the attachment: the frames below are
      // charged to the general budget, which is what closes the socket.
      await push(
        peer,
        { type: 'collab:update', circuitId: handle, update: FULL },
        MAX_SOCKET_FRAMES_PER_WINDOW + 10
      )
      expect(await peer.waitClosed()).toBe(4005)
    } finally {
      await relay.close()
    }
  })

  it('still gets no answer for a frame it is not entitled to send', async () => {
    /*
     * The refusal is a *budget*, not a reply. A collaboration frame for a circuit
     * this socket never joined is still answered with silence — it is what a
     * client sends in the moment after its attachment ended — so the metering
     * cannot be used as an oracle for whether a circuit exists.
     */
    const relay = await startRelay()
    try {
      const peer = await connect(relay)
      peer.send({
        type: 'collab:update',
        circuitId: 'no-such-circuit',
        update: 'AAAA',
      })
      await peer.quiet(80)
      expect(answers(peer)).toEqual([])
      expect(peer.closeCode()).toBeNull()
    } finally {
      await relay.close()
    }
  })
})
