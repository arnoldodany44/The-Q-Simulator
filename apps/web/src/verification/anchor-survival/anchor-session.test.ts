/**
 * INDEPENDENT VERIFICATION — anchor survival inside a live session (lens:
 * anchor-survival).
 *
 * §3.4 (M5.4 decision 2) claims delete-then-undo is free: "the operation
 * returns with the same id […] and the comment re-attaches by itself". The store
 * proves that for its own zundo history. In a shared session the history is
 * `Y.UndoManager` instead (M5.1), so the claim has to hold on that path too, and
 * it is a different mechanism: an undo there restores a document key, not a
 * JavaScript array.
 *
 * Also checked here: the id an editor mints while a session is attached, which is
 * where a duplicate becomes a rename and a rename can move an anchor.
 *
 * NOTE FOR WHOEVER FINDS THIS RED: these assertions state the claim §3.4 (M5.4)
 * makes about anchors. A failure here is a finding, not a broken test. No
 * production code was touched by this directory.
 */

import { projectCircuit } from '@qsim/collab'
import { emptyCircuit, type Circuit } from '@qsim/schema'
import { describe, expect, it } from 'vitest'
import * as Y from 'yjs'

import { bridgeCircuitDocument } from '../../features/collab/circuitDocument.js'
import { anchorCellOf } from '../../features/comments/anchors.js'
import { createCircuitStore } from '../../features/circuit-editor/useCircuitStore.js'

const base: Circuit = {
  ...emptyCircuit(3, 3),
  operations: [
    { id: 'op_1', gate: 'h', targets: [0], column: 0 },
    { id: 'op_2', gate: 'x', targets: [1], column: 1 },
  ],
}

function session() {
  const store = createCircuitStore()
  expect(store.getState().loadCircuit(base).ok).toBe(true)
  const doc = new Y.Doc()
  const bridge = bridgeCircuitDocument({ store, doc, seed: 'store' })
  return { store, doc, bridge }
}

describe('anchor survival with a shared session attached', () => {
  it('delete then undo returns the gate with its id, on the Yjs history too', () => {
    const { store, doc, bridge } = session()
    try {
      expect(anchorCellOf(store.getState().circuit, 'op_2')).toEqual({
        qubit: 1,
        column: 1,
      })

      expect(store.getState().removeOperation('op_2').ok).toBe(true)
      expect(anchorCellOf(store.getState().circuit, 'op_2')).toBeNull()

      expect(store.getState().undo().ok).toBe(true)
      // Same id, same cell, same gate — the comment re-attaches with no write.
      expect(anchorCellOf(store.getState().circuit, 'op_2')).toEqual({
        qubit: 1,
        column: 1,
      })
      expect(
        store.getState().circuit.operations.find((op) => op.id === 'op_2')?.gate
      ).toBe('x')
      // And the document agrees with the store, which is what every other peer
      // will read.
      expect(projectCircuit(doc).circuit.operations).toHaveLength(2)
    } finally {
      bridge.detach()
    }
  })

  it('a placement in a session must not reuse a deleted gate’s id', () => {
    const { store, bridge } = session()
    try {
      expect(store.getState().removeOperation('op_2').ok).toBe(true)
      const placed = store.getState().placeGate('z', [2], 4)
      expect(placed.ok).toBe(true)
      const newId = placed.ok ? placed.ids[0] : undefined

      // A comment on the deleted `x` must stay an orphan. If the new `z` is
      // handed `op_2`, every peer's panel starts saying the sentence about the
      // `x` under a `z` nobody has commented on.
      expect(newId).not.toBe('op_2')
      expect(anchorCellOf(store.getState().circuit, 'op_2')).toBeNull()
    } finally {
      bridge.detach()
    }
  })
})
