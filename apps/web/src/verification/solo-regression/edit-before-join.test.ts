/**
 * FINDING 1 — an edit made before the join lands is deleted, silently, and undo
 * cannot bring it back.
 *
 * The window is not hypothetical and it is not short. `useCollabSession` opens
 * the socket in an effect, after `useCircuitDocument` has answered and the canvas
 * is painted and interactive; the client then waits for `ready`, sends
 * `collab:join`, and the relay answers only after an authorisation read and a
 * document build. Measured against this repository's own API on localhost, an
 * anonymous `collab:join` for a handle that does not exist — the authorisation
 * read alone, with no session row, no head version and no Y.Doc — came back in
 * 273 ms, 275 ms, 499 ms and 547 ms over four runs. A real join does strictly
 * more work, and production puts the database on another host.
 *
 * Everything typed into that window is in the store and in no document. The join
 * then applies the relay's state, `bridgeCircuitDocument` finds a non-empty
 * document (so it does not publish the store's circuit), and `adopt()` replaces
 * the canvas with what the relay sent. The edit is not overwritten locally — it
 * never reached the document at all, so nothing anywhere holds it.
 *
 * Reproduced in a browser too: place a gate at `/c/:slug` before the relay
 * answers and the canvas goes from "Operations: 3" back to "Operations: 2", the
 * `?c=` draft disappears from the address bar, the status line still reads "H
 * placed on q0, column 7", and four undo presses report "There is nothing left to
 * undo".
 *
 * ── The variant that needs no race at all ─────────────────────────────────
 *
 * The unsaved-work mechanism this project chose is the address bar:
 * `useUnsavedWork` argues at length that «the draft is the URL» and that it is
 * «not a second copy to keep in sync», and `routes/editor.tsx` states the
 * precedence — a `?c=` payload «always wins, including over the version stored
 * under the slug: it is the newer of the two documents, and showing the older one
 * instead is the one outcome that loses work». Reloading `/c/:slug?c=…` paints the
 * draft, the join arrives a second later with the *saved* version, `adopt()`
 * replaces the draft with it, and `suppressed` then strips `?c=` from the address
 * bar — deleting the only copy. No timing is required for that one: the draft is
 * on screen before the socket is even open.
 *
 * ── What answers it ──────────────────────────────────────────────────────
 *
 * `bridgeCircuitDocument` now *carries* the store's unpublished work into the
 * joined document instead of adopting over it: additive, so nothing a peer wrote
 * is deleted, and filtered through the saved version, so nothing a peer deleted
 * comes back. The carry is written after the undo manager exists, which is what
 * makes the second test below pass too — the gate is on the canvas *and* on the
 * stack. Both tests were `it.fails` when this file was written; they are the
 * regression test for the repair now.
 */

import { describe, expect, it } from 'vitest'

import {
  cellsOf,
  connect,
  joinedFrame,
  relayDocument,
  savedCircuit,
  soloEditor,
} from './session'

describe('an edit made while the join is in flight', () => {
  it('survives the join', async () => {
    const solo = soloEditor()
    await connect(solo)

    // The reader places a gate. The canvas is painted and interactive; the
    // relay has not answered yet.
    expect(solo.store.getState().placeGate('x', [0], 4).ok).toBe(true)
    expect(cellsOf(solo)).toEqual(['cx@1:1', 'h@0:0', 'x@0:4'])

    // The relay answers with the document it built from the head version —
    // which knows nothing about the gate that was just placed.
    solo.socket().deliver(joinedFrame(relayDocument(savedCircuit())))

    expect(cellsOf(solo)).toEqual(['cx@1:1', 'h@0:0', 'x@0:4'])
  })

  it('or is at least still on the undo stack', async () => {
    const solo = soloEditor()
    await connect(solo)
    solo.store.getState().placeGate('x', [0], 4)
    solo.socket().deliver(joinedFrame(relayDocument(savedCircuit())))

    // It is gone from the canvas. The least a lost edit is owed is a way back.
    expect(solo.store.getState().undo().ok).toBe(true)
  })
})
