/**
 * FINDINGS 3 and 4 — two sentences the panel shows a solo editor that are not
 * true, and stay on screen for the rest of the session.
 *
 * Both are read by one person editing their own circuit with nobody else
 * attached, which §3.4 says is the ordinary case («un circuito tiene exactamente
 * una escritora»). Neither breaks the editor; both describe the reader's work to
 * them incorrectly, which is the thing this project's own comments repeatedly
 * refuse to do elsewhere.
 *
 *   3. `reconciled` never returns to true. One refused update — a big paste, a
 *      wide register edit, or the relay's own byte budget for the window — sets it
 *      and nothing clears it, so `session.diverged` («Some of your changes were
 *      too large to send, so the other people here do not have them yet») stays up
 *      after everything has in fact reached the relay, and names other people to a
 *      reader who is alone.
 *
 *   4. A rejoin that is never answered leaves the session in `reconnecting`
 *      forever. `rejoin` schedules exactly one `join` and nothing re-arms it, so
 *      if that frame goes unanswered — the relay dropped the document and is busy,
 *      the frame was lost, the socket is half-open — the panel says «Reconnecting
 *      to the shared session…» permanently while nothing is being attempted and no
 *      ending is ever reported.
 */

import { describe, expect, it } from 'vitest'

import {
  CIRCUIT_ID,
  connect,
  errorFrame,
  joinedFrame,
  relayDocument,
  savedCircuit,
  soloEditor,
} from './session'

describe('what the collaboration panel tells a solo editor', () => {
  it('stops claiming a divergence once one is over', async () => {
    const solo = soloEditor()
    await connect(solo)
    const relay = relayDocument(savedCircuit())
    solo.socket().deliver(joinedFrame(relay))

    // The relay refuses one update for its size. Its own header says the
    // attachment survives and the session goes on.
    solo.socket().deliver(errorFrame('PAYLOAD_TOO_LARGE'))
    expect(solo.snapshot().reconciled).toBe(false)

    // Everything after it is ordinary and small, and a rejoin exchanges state
    // vectors, which is exactly the mechanism that closes such a gap.
    solo.store.getState().placeGate('x', [0], 4)
    solo.advance(1_000)
    solo.socket().drop()
    solo.fire(500)
    solo.socket().open()
    await Promise.resolve()
    solo.socket().deliver({ type: 'ready', viewer: null, expiresAt: null })
    solo.socket().deliver(joinedFrame(relay))
    expect(solo.snapshot().status).toBe('open')

    expect(solo.snapshot().reconciled).toBe(true)
  })

  it('stops saying "reconnecting" when nothing is being tried', async () => {
    const solo = soloEditor()
    await connect(solo)
    solo.socket().deliver(joinedFrame(relayDocument(savedCircuit())))

    // The relay drops the document and asks this peer to rejoin.
    solo
      .socket()
      .deliver({ type: 'collab:left', circuitId: CIRCUIT_ID, reason: 'gone' })
    expect(solo.snapshot().status).toBe('reconnecting')

    // The rejoin goes out and is never answered — the relay is still busy, or
    // the frame was lost on a half-open socket.
    solo.fire(500)
    expect(
      solo.socket().sent.filter((frame) => frame.type === 'collab:join').length
    ).toBe(2)

    // Either another attempt is pending or the reader is told it ended. What
    // must not happen is a permanent "reconnecting" with nothing behind it.
    expect(() => {
      solo.fire(1_000)
    }).not.toThrow()
  })
})
