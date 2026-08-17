/**
 * INDEPENDENT VERIFICATION — anchor survival (lens: anchor-survival).
 *
 * Derived from §3.4 (M5.4 decision 1) and `packages/contract/src/comments.ts`,
 * which both claim: "an anchor can fail to resolve but it can never resolve to
 * the wrong gate". Each case below derives where the comment SHOULD end up and
 * asserts on the CELL, not on mere presence.
 *
 * Nothing here is a fix. The `expect` calls state the specified behaviour, so a
 * failure is the finding.
 *
 * NOTE FOR WHOEVER FINDS THIS RED: these assertions state the claim §3.4 (M5.4)
 * makes about anchors. A failure here is a finding, not a broken test. No
 * production code was touched by this directory.
 */

import { emptyCircuit, type Circuit } from '@qsim/schema'
import { describe, expect, it } from 'vitest'

import {
  anchorCellOf,
  resolveAnchors,
} from '../../features/comments/anchors.js'
import { createCircuitStore } from '../../features/circuit-editor/useCircuitStore.js'

/**
 * Three gates on three wires, one per column, all ids explicit so a scenario
 * can name the one it comments on.
 */
function threeGates(): Circuit {
  return {
    ...emptyCircuit(3, 3),
    operations: [
      { id: 'op_1', gate: 'h', targets: [0], column: 0 },
      { id: 'op_2', gate: 'x', targets: [1], column: 1 },
      { id: 'op_3', gate: 'y', targets: [2], column: 2 },
    ],
  }
}

/** A store holding `threeGates` the way the editor gets it: through a load. */
function loadedStore() {
  const store = createCircuitStore()
  const result = store.getState().loadCircuit(threeGates())
  expect(result.ok).toBe(true)
  return store
}

describe('anchor survival: the nine document mutations', () => {
  it('a column inserted before the anchor moves the anchor with its gate', () => {
    const store = loadedStore()
    // There is no `insertColumn` action; a column insertion is a translation of
    // `column` for everything at or past the insertion point, applied
    // right-to-left so no intermediate state doubles up in a column.
    for (const operation of [...store.getState().circuit.operations]
      .filter((candidate) => candidate.column >= 1)
      .sort((left, right) => right.column - left.column)) {
      const moved = store
        .getState()
        .moveOperation(operation.id, operation.targets, operation.column + 1)
      expect(moved.ok).toBe(true)
    }

    expect(anchorCellOf(store.getState().circuit, 'op_2')).toEqual({
      qubit: 1,
      column: 2,
    })
    // And the gate under the anchor is still the gate that was commented on.
    expect(
      store.getState().circuit.operations.find((op) => op.id === 'op_2')?.gate
    ).toBe('x')
  })

  it('a qubit inserted above the anchor shifts the anchor down one wire', () => {
    const store = loadedStore()
    expect(store.getState().addQubit(0).ok).toBe(true)

    expect(anchorCellOf(store.getState().circuit, 'op_2')).toEqual({
      qubit: 2,
      column: 1,
    })
  })

  it('reordering wires carries the anchor to the gate’s new wire', () => {
    const store = loadedStore()
    // `order[newIndex] = oldIndex`: q2 first, then q0, then q1.
    expect(store.getState().reorderQubits([2, 0, 1]).ok).toBe(true)

    // op_2 lived on old q1, which is now position 2.
    expect(anchorCellOf(store.getState().circuit, 'op_2')).toEqual({
      qubit: 2,
      column: 1,
    })
  })

  it('a qubit removed below the anchor shifts the anchor up one wire', () => {
    const store = loadedStore()
    expect(store.getState().removeQubit(0).ok).toBe(true)

    expect(anchorCellOf(store.getState().circuit, 'op_2')).toEqual({
      qubit: 0,
      column: 1,
    })
  })

  it('the gate moved to another column takes the anchor with it', () => {
    const store = loadedStore()
    expect(store.getState().moveOperation('op_2', [1], 5).ok).toBe(true)

    expect(anchorCellOf(store.getState().circuit, 'op_2')).toEqual({
      qubit: 1,
      column: 5,
    })
  })

  it('the gate moved to another qubit takes the anchor with it', () => {
    const store = loadedStore()
    expect(store.getState().moveOperation('op_2', [2], 1).ok).toBe(true)

    expect(anchorCellOf(store.getState().circuit, 'op_2')).toEqual({
      qubit: 2,
      column: 1,
    })
  })

  it('the gate deleted orphans the anchor and marks no cell', () => {
    const store = loadedStore()
    expect(store.getState().removeOperation('op_2').ok).toBe(true)

    expect(anchorCellOf(store.getState().circuit, 'op_2')).toBeNull()
    expect(resolveAnchors(store.getState().circuit, ['op_2']).orphaned).toEqual(
      ['op_2']
    )
  })

  it('deleted then undone re-attaches the anchor to the same cell', () => {
    const store = loadedStore()
    expect(store.getState().removeOperation('op_2').ok).toBe(true)
    expect(store.getState().undo().ok).toBe(true)

    expect(anchorCellOf(store.getState().circuit, 'op_2')).toEqual({
      qubit: 1,
      column: 1,
    })
    expect(
      store.getState().circuit.operations.find((op) => op.id === 'op_2')?.gate
    ).toBe('x')
  })
})

describe('anchor survival: id reuse is what makes an anchor safe', () => {
  /**
   * §3.4 and `comments.ts` both rest on "an id is never recycled". The
   * observable consequence, and the one a reader depends on: after the gate an
   * anchor names is deleted, no LATER placement in the same document may be
   * handed that id — otherwise the comment silently changes subject.
   */
  it('a placement after a delete must not reuse the deleted gate’s id', () => {
    const store = loadedStore()
    expect(store.getState().removeOperation('op_2').ok).toBe(true)
    // The comment on op_2 is an orphan at this point, correctly.
    expect(anchorCellOf(store.getState().circuit, 'op_2')).toBeNull()

    // Now the author places a completely unrelated gate somewhere else.
    const placed = store.getState().placeGate('z', [2], 7)
    expect(placed.ok).toBe(true)
    const newId = placed.ok ? placed.ids[0] : undefined

    expect(newId).not.toBe('op_2')
    // Stated as the reader's question too: the anchor must still be an orphan.
    expect(anchorCellOf(store.getState().circuit, 'op_2')).toBeNull()
  })

  /**
   * Restoring an older version is `loadCircuit` of that version's JSON. A
   * comment written against the head version names an id the old version may
   * also use — for a different gate — if ids were ever recycled.
   */
  it('restoring an older version must not point a newer comment at an old gate', () => {
    // Version 1 of the circuit: one H on q0, id op_1.
    const version1: Circuit = {
      ...emptyCircuit(3, 3),
      operations: [{ id: 'op_1', gate: 'h', targets: [0], column: 0 }],
    }

    const store = createCircuitStore()
    expect(store.getState().loadCircuit(version1).ok).toBe(true)

    // The author deletes the H and places an X on q1 instead. Whatever id the
    // X receives, a comment is written about the X.
    expect(store.getState().removeOperation('op_1').ok).toBe(true)
    const placed = store.getState().placeGate('x', [1], 0)
    expect(placed.ok).toBe(true)
    const commentedId = placed.ok ? (placed.ids[0] ?? '') : ''
    const head = store.getState().circuit
    expect(anchorCellOf(head, commentedId)).toEqual({ qubit: 1, column: 0 })

    // Now the history sidebar restores version 1. The X is gone, so the comment
    // about the X must be an orphan — never a comment about the H.
    expect(store.getState().loadCircuit(version1).ok).toBe(true)
    expect(anchorCellOf(store.getState().circuit, commentedId)).toBeNull()
  })

  /**
   * The paste rule the contract states: a pasted gate is a different gate, so
   * it must not inherit the anchor of the gate it was copied from — and must
   * not be handed a *deleted* gate's id either.
   */
  it('paste mints ids that never collide with a commented gate’s id', () => {
    const store = loadedStore()
    store.getState().setSelection(['op_1'])
    expect(store.getState().copy().ok).toBe(true)
    expect(store.getState().removeOperation('op_2').ok).toBe(true)

    const pasted = store.getState().paste(1, 4)
    expect(pasted.ok).toBe(true)
    const ids = pasted.ok ? pasted.ids : []
    expect(ids).not.toContain('op_2')
    expect(anchorCellOf(store.getState().circuit, 'op_2')).toBeNull()
  })
})
