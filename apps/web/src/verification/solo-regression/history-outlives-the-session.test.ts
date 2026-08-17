/**
 * FINDING 2 — when a session ends, the solo editor's undo history is thrown away.
 *
 * `collabSession.ts` says the ending «hands undo back to the store», and the
 * store's `attachHistory(null)` clears the history in both directions. The
 * argument given for clearing is about *other people*: «a stack of snapshots
 * taken before other people edited is a stack of documents that were only ever
 * this client's». In a solo session there are no other people, every step on the
 * stack is this reader's own work on a document nobody else touched, and the
 * clearing takes away the one thing the degradation path promised to leave alone.
 *
 * Reached by every ending the relay can produce, none of which the reader caused:
 * `collab:left unauthorised`, a `collab:error` the transport does not retry
 * (NOT_FOUND, CIRCUIT_TOO_LARGE, VALIDATION_FAILED, SIMULATION_UNAVAILABLE), a
 * close with `SOCKET_CLOSE.PROTOCOL`, a document the projection refuses, and
 * `gone`/`overloaded` once the three rejoins are spent.
 *
 * In a browser: two gates placed in a healthy session, then `collab:left` with
 * `reason: 'unauthorised'`. The panel says "This circuit stopped being yours to
 * open, so the shared session ended", both gates are still on the canvas, and
 * four undo presses report "There is nothing left to undo". The same page with no
 * session at all undoes both.
 */

import { describe, expect, it } from 'vitest'

import {
  cellsOf,
  connect,
  errorFrame,
  joinedFrame,
  relayDocument,
  savedCircuit,
  soloEditor,
  CIRCUIT_ID,
} from './session'

/** A session that has joined, with two gates placed inside it. */
async function twoGatesInASession(): Promise<ReturnType<typeof soloEditor>> {
  const solo = soloEditor()
  await connect(solo)
  solo.socket().deliver(joinedFrame(relayDocument(savedCircuit())))
  solo.store.getState().placeGate('x', [0], 4)
  solo.advance(1_000)
  solo.store.getState().placeGate('z', [1], 5)
  expect(cellsOf(solo)).toEqual(['cx@1:1', 'h@0:0', 'x@0:4', 'z@1:5'])
  // Undo works while the session is open, which is what makes its loss a loss.
  expect(solo.snapshot().status).toBe('open')
  return solo
}

describe('a session that ends must not take the undo history with it', () => {
  it('after an eject the reader can still undo their own work', async () => {
    const solo = await twoGatesInASession()

    solo.socket().deliver({
      type: 'collab:left',
      circuitId: CIRCUIT_ID,
      reason: 'unauthorised',
    })
    expect(solo.snapshot().ended).toBe('unauthorised')
    // The gates are still on the canvas, so there is something to undo.
    expect(cellsOf(solo)).toEqual(['cx@1:1', 'h@0:0', 'x@0:4', 'z@1:5'])

    expect(solo.store.getState().undo().ok).toBe(true)
  })

  it('after a refusal the reader can still undo their own work', async () => {
    const solo = await twoGatesInASession()

    solo.socket().deliver(errorFrame('NOT_FOUND'))
    expect(solo.snapshot().ended).toBe('unavailable')

    expect(solo.store.getState().undo().ok).toBe(true)
  })

  it('the editor itself keeps working, which is the half that holds', async () => {
    const solo = await twoGatesInASession()
    solo.socket().deliver(errorFrame('NOT_FOUND'))

    // New edits, and undo of those, are unaffected: only the history taken
    // during the session is gone.
    expect(solo.store.getState().placeGate('y', [0], 6).ok).toBe(true)
    expect(solo.store.getState().undo().ok).toBe(true)
    expect(cellsOf(solo)).toEqual(['cx@1:1', 'h@0:0', 'x@0:4', 'z@1:5'])
  })
})
