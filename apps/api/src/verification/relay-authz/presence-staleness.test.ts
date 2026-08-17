/**
 * The seam between the authorisation cache and the presence path.
 *
 * `deliverPresence` may not await, so instead of re-checking authorisation per
 * delivery it applies a *staleness* test to the cached decision: inside
 * `AUTHORISATION_TTL_MS` the frame goes out, past it the frame is dropped and a
 * refresh is scheduled (§3.4, M5.3 decision 3).
 *
 * That is a sound way to bound a revocation window. What it must not do is drop
 * the frames the feature is *made* of, and two numbers decided that it did: the
 * TTL is 2 s and `PRESENCE_HEARTBEAT_MS` is 10 s. A peer that is simply sitting
 * there renews its presence every 10 s, so every renewal arrived with the
 * recipient's decision 10 s old — stale, by construction, every time — and was
 * dropped. Two consequences, both of them the feature failing rather than the
 * bound working:
 *
 *   - a peer who stopped moving disappeared from everybody else's roster at
 *     `PRESENCE_TIMEOUT_MS` and did not come back, because the heartbeats that
 *     exist to prevent exactly that were the frames being dropped;
 *   - the `state: null` that says a peer has *left* went the same way, so a
 *     cursor belonging to somebody the relay had ejected for losing read access
 *     stayed on the remaining screens for up to 30 s.
 *
 * `deliverPresence` now schedules the refresh and *delivers* the frame. The
 * revocation window is still bounded by the refresh — it ends the attachment, and
 * an ended attachment relays nothing — which is what these two tests hold in
 * place.
 */

import { describe, expect, it } from 'vitest'
import { PRESENCE_HEARTBEAT_MS } from '@qsim/contract'
import { connect, startRelay } from './harness.js'
import { OWNER, STRANGER, seed } from './fixtures.js'

const POSITION = {
  cursor: { qubit: 0, column: 0 },
  selection: [],
  edits: 0,
}

/** Longer than AUTHORISATION_TTL_MS, and far shorter than a heartbeat. */
const QUIET = 2_300

describe('presence delivery and the two-second decision cache', () => {
  it('delivers a heartbeat that arrives while the recipient’s decision is stale', async () => {
    const relay = await startRelay()
    try {
      const circuits = await seed(relay)
      const handle = circuits.public.id
      const mover = await connect(relay, {
        bearer: await relay.token({ subject: OWNER }),
      })
      const watcher = await connect(relay, {
        bearer: await relay.token({ subject: STRANGER }),
      })
      for (const peer of [mover, watcher]) {
        peer.send({ type: 'collab:join', circuitId: handle })
        await peer.waitFor((frame) => frame.type === 'collab:joined')
      }

      // The first position, delivered: the decision is fresh from the join.
      mover.send({
        type: 'collab:presence',
        circuitId: handle,
        state: POSITION,
      })
      await watcher.waitFor((frame) => frame.type === 'collab:presence')

      // Now nothing happens for longer than the TTL — which is what "two people
      // are looking at a circuit" is, most of the time.
      await watcher.quiet(QUIET)
      watcher.frames.length = 0
      mover.send({
        type: 'collab:presence',
        circuitId: handle,
        state: { ...POSITION, cursor: { qubit: 1, column: 4 } },
      })
      // The heartbeat arrives, on a decision the relay is refreshing behind it.
      const renewal = await watcher.waitFor(
        (frame) => frame.type === 'collab:presence',
        10_000
      )
      expect(renewal.state).toMatchObject({ cursor: { qubit: 1, column: 4 } })

      // And so does the next one, and the one after a second quiet period: a
      // session that goes quiet must not go deaf.
      await watcher.quiet(QUIET)
      watcher.frames.length = 0
      mover.send({
        type: 'collab:presence',
        circuitId: handle,
        state: { ...POSITION, cursor: { qubit: 1, column: 5 } },
      })
      const late = await watcher.waitFor(
        (frame) => frame.type === 'collab:presence',
        10_000
      )
      expect(late.state).toMatchObject({ cursor: { qubit: 1, column: 5 } })

      // The heartbeat interval is five times the TTL, which is why dropping a
      // stale-decision frame was dropping the steady state of an idle session
      // rather than losing a rare race.
      expect(PRESENCE_HEARTBEAT_MS).toBeGreaterThan(2_000 * 4)
    } finally {
      await relay.close()
    }
    // Two quiet periods of 2.3 s each, plus a database read behind each renewal.
  }, 30_000)

  it('tells the remaining peers about a peer the relay ejected', async () => {
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
      watcher.send({
        type: 'collab:presence',
        circuitId: handle,
        state: POSITION,
      })
      const arrived = await owner.waitFor(
        (frame) => frame.type === 'collab:presence'
      )

      // The owner un-publishes; the watcher loses read access and is ejected.
      await relay.repository.update({
        id: handle,
        ownerId: OWNER,
        visibility: 'PRIVATE',
      })
      await watcher.quiet(QUIET)
      owner.frames.length = 0
      watcher.send({
        type: 'collab:presence',
        circuitId: handle,
        state: { ...POSITION, cursor: { qubit: 1, column: 1 } },
      })
      expect(
        await watcher.waitFor((frame) => frame.type === 'collab:left')
      ).toMatchObject({ reason: 'unauthorised' })

      /*
       * The relay knows they are gone, and it says so. The `state: null` that
       * removes the caret was dropped by the same staleness test, so somebody the
       * relay had removed for losing read access stayed drawn on every remaining
       * screen — with their name and their access — until the client's own 30 s
       * expiry swept them.
       */
      const departure = await owner.waitFor(
        (frame) => frame.type === 'collab:presence' && frame.state === null,
        10_000
      )
      expect(departure.peerId).toBe(arrived.peerId)
    } finally {
      await relay.close()
    }
  })
})
