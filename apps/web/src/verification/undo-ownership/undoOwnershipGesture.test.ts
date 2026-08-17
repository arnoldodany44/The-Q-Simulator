/**
 * Third batch: the gesture path in a shared session, and the one thing about
 * the bridge's surface a transport has to get right for undo to travel at all.
 */

import { describe, expect, it } from 'vitest'
import * as Y from 'yjs'

import { createCircuitStore } from '../../features/circuit-editor/useCircuitStore'
import { bridgeCircuitDocument } from '../../features/collab/circuitDocument'
import { cells, circuitOf, deliver, host, idOf, joiner } from './peers'

describe('undo ownership: gestures', () => {
  it('K. a slider drag is one undo step and leaves the peer alone', () => {
    const ana = host('ana')
    const beto = joiner('beto', ana)

    const placed = ana.store.getState().placeGate('rz', [0], 0)
    const id = idOf(placed)
    deliver(ana, beto)
    beto.store.getState().placeGate('x', [1], 0)
    deliver(beto, ana)

    ana.store.getState().beginTransaction()
    for (const value of [0.1, 0.2, 0.3, 0.4]) {
      ana.store.getState().setParam(id, 0, value)
    }
    ana.store.getState().endTransaction()
    deliver(ana, beto)
    expect(circuitOf(beto).operations[0]?.params).toEqual([0.4])

    expect(ana.store.getState().undo().ok).toBe(true)
    deliver(ana, beto)
    expect({
      params: circuitOf(beto).operations[0]?.params,
      cells: cells(circuitOf(beto)),
    }).toEqual({ params: [0], cells: ['rz@0:0', 'x@1:0'] })
  })

  /**
   * FINDING 6, fixed. A drag that ends where it began costs no undo press and
   * leaves the step before it undoable.
   *
   * `endGesture` popped the gesture's stack item while deliberately leaving its
   * writes in the document. Those writes were then accounted for by nothing:
   * Yjs's map-redo guard walks the successors of the item it wants to restore
   * and asks whether each is explained by this manager's undo or redo stack,
   * and the popped item was what explained these. So it refused — and
   * `popStackItem` moved on to the step underneath, which is the placement.
   * The item is now *fused* into the step below rather than dropped, so the
   * writes stay explained. See `undoOwnershipSolo.test.ts` for the same
   * keystrokes solo.
   */
  it('L. a drag that ends where it began costs no undo press', () => {
    const ana = host('ana')
    const placed = ana.store.getState().placeGate('rz', [0], 0)
    const id = idOf(placed)
    ana.store.getState().setParam(id, 0, 0.5)

    ana.store.getState().beginTransaction()
    ana.store.getState().setParam(id, 0, 1.5)
    ana.store.getState().setParam(id, 0, 0.5)
    ana.store.getState().endTransaction()

    // One press must reach past the drag that changed nothing, to the 0.5.
    expect(ana.store.getState().undo().ok).toBe(true)
    expect(circuitOf(ana).operations[0]?.params).toEqual([0])
  })

  /**
   * FINDING 7, fixed. The surface a relay is meant to use now carries an undo.
   *
   * A transport has to broadcast what this client produced — an edit, an undo, a
   * redo, and the repairs the per-user undo makes — and must not re-broadcast
   * what it applied from the relay. The bridge used to expose only `origin`, its
   * editor sentinel, and to document it as "how it knows which updates were
   * ours"; an undo does not carry it, because `Y.UndoManager` transacts under
   * itself, so the filter the surface invited dropped every undo and the two
   * peers diverged without either of them being wrong.
   *
   * `onLocalUpdate` is the surface now, and there is no filter left to write:
   * it announces everything this client produced and nothing `receive` applied.
   */
  it('M. the bridge announces every update this client produced', () => {
    const anaStore = createCircuitStore()
    const anaDoc = new Y.Doc()
    const anaBridge = bridgeCircuitDocument({
      store: anaStore,
      doc: anaDoc,
      seed: 'store',
    })

    const betoStore = createCircuitStore()
    const betoDoc = new Y.Doc()
    Y.applyUpdate(betoDoc, Y.encodeStateAsUpdate(anaDoc))
    const betoBridge = bridgeCircuitDocument({
      store: betoStore,
      doc: betoDoc,
    })

    const sent: Uint8Array[] = []
    anaBridge.onLocalUpdate((update) => sent.push(update))

    anaStore.getState().placeGate('h', [0], 0)
    for (const update of sent.splice(0, sent.length)) betoBridge.receive(update)
    expect(cells(betoStore.getState().circuit)).toEqual(['h@0:0'])

    anaStore.getState().undo()
    expect(cells(anaStore.getState().circuit)).toEqual([])
    for (const update of sent.splice(0, sent.length)) betoBridge.receive(update)
    // Both peers agree, which is the whole requirement.
    expect(cells(betoStore.getState().circuit)).toEqual([])

    // And what came *from* the relay is never announced back at it, or the two
    // of them would trade one gate forever.
    betoStore.getState().placeGate('x', [1], 1)
    const echo: Uint8Array[] = []
    const stop = anaBridge.onLocalUpdate((update) => echo.push(update))
    anaBridge.receive(Y.encodeStateAsUpdate(betoDoc))
    stop()
    expect(echo).toEqual([])
    expect(cells(anaStore.getState().circuit)).toEqual(['x@1:1'])
  })
})
