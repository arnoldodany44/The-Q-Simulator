/**
 * An anchor outlives what it points at — §3.4, §14 (Fase 5, M5.4).
 *
 * ══════════════════════════════════════════════════════════════════════════
 * THIS IS THE TEST THE MILESTONE IS ABOUT
 *
 * A comment on "the `H` on q0 at column 3" has to survive the document being
 * edited underneath it, and the failure that matters is not losing the comment:
 * it is the comment silently coming to point at a *different* gate, so that a
 * reader is shown a stranger's sentence about the gate in front of them,
 * attributed to somebody who never said it.
 *
 * So every case below drives the **real store** — `createCircuitStore`, the same
 * one the editor uses, with its own validation and its own undo — and then asks
 * `resolveAnchors` where the anchor landed. Nothing here stubs the store, because
 * the property under test *is* a property of the store: that it never rewrites an
 * operation's `id`, and never issues an id that is in use.
 *
 * The five mutations §14 names, plus the two that must orphan:
 *
 *   1. a column inserted before the anchor;
 *   2. qubits reordered;
 *   3. the gate moved;
 *   4. the gate deleted;
 *   5. deleted and then undone;
 *   6. a wire deleted from under it (orphan);
 *   7. the gate copied (the copy carries no comment).
 *
 * The assertions are deliberately about the *cell*, not merely about presence.
 * "The anchor still resolves" would pass for an implementation that resolved it
 * to the wrong gate, which is the whole thing being ruled out.
 */

import { CIRCUIT_SCHEMA_VERSION, type Circuit } from '@qsim/schema'
import { describe, expect, it } from 'vitest'

import { createCircuitStore } from '../circuit-editor/useCircuitStore'
import { anchorCellOf, resolveAnchors } from './anchors'

/**
 * Three gates on three wires, one per column, so that "which gate did the
 * anchor land on" has a different answer for every wrong answer.
 *
 * `h` on q0 c0 is the commented one. `x` on q1 c1 and `y` on q2 c2 are there to
 * be mistaken for it.
 */
function threeGates(): Circuit {
  return {
    schemaVersion: CIRCUIT_SCHEMA_VERSION,
    qubits: 3,
    clbits: 0,
    operations: [
      { id: 'op_1', gate: 'h', targets: [0], column: 0 },
      { id: 'op_2', gate: 'x', targets: [1], column: 1 },
      { id: 'op_3', gate: 'y', targets: [2], column: 2 },
    ],
  }
}

/** The anchored comment's subject, in every test below. */
const ANCHOR = 'op_1'

function storeWith(circuit: Circuit = threeGates()) {
  return createCircuitStore(circuit)
}

/** The gate an anchor resolves to, by name, or `null`. */
function gateAt(circuit: Circuit, anchorOpId: string): string | null {
  const operation = circuit.operations.find((row) => row.id === anchorOpId)
  return operation?.gate ?? null
}

describe('an anchor survives the document being edited', () => {
  it('does not move when a column is inserted before it', () => {
    /*
     * There is no `insertColumn` action: a column insertion is a translation of
     * `column` values, performed with the ordinary move — which is exactly what
     * makes it safe for an anchor. Rightmost first, so no intermediate state has
     * two operations in one column (the store would refuse that, and rightly).
     */
    const store = storeWith()
    for (const id of ['op_3', 'op_2', 'op_1']) {
      const operation = store
        .getState()
        .circuit.operations.find((row) => row.id === id)
      expect(operation).toBeDefined()
      const moved = store
        .getState()
        .moveOperation(
          id,
          operation?.targets ?? [],
          (operation?.column ?? 0) + 1
        )
      expect(moved.ok).toBe(true)
    }

    const circuit = store.getState().circuit
    // The anchor rode along with its gate rather than staying at column 0,
    // where there is now nothing at all.
    expect(anchorCellOf(circuit, ANCHOR)).toEqual({ qubit: 0, column: 1 })
    expect(gateAt(circuit, ANCHOR)).toBe('h')
  })

  it('follows its gate when the qubits are reordered', () => {
    /*
     * Two gates in column 0, so the reorder *swaps* them and the substitution a
     * coordinate anchor would make is exact: (q0, c0) holds the `h` before and
     * the `z` after, and the two are one cell apart in nothing but identity.
     */
    const store = storeWith({
      schemaVersion: CIRCUIT_SCHEMA_VERSION,
      qubits: 2,
      clbits: 0,
      operations: [
        { id: ANCHOR, gate: 'h', targets: [0], column: 0 },
        { id: 'op_2', gate: 'z', targets: [1], column: 0 },
      ],
    })
    // `order[newIndex] = oldIndex`: the two wires trade places.
    expect(store.getState().reorderQubits([1, 0]).ok).toBe(true)

    const circuit = store.getState().circuit
    // The anchor points at the `h`, which is on q1 now — not at (q0, c0), where
    // the `z` has just arrived.
    expect(anchorCellOf(circuit, ANCHOR)).toEqual({ qubit: 1, column: 0 })
    expect(gateAt(circuit, ANCHOR)).toBe('h')
    expect(
      circuit.operations.find((row) => row.column === 0 && row.targets[0] === 0)
        ?.gate
    ).toBe('z')
  })

  it('follows its gate when the gate itself is dragged', () => {
    const store = storeWith()
    // Across wires and along time at once, which is the drag that breaks both
    // coordinates of a coordinate anchor.
    expect(store.getState().moveOperation(ANCHOR, [2], 4).ok).toBe(true)

    const circuit = store.getState().circuit
    expect(anchorCellOf(circuit, ANCHOR)).toEqual({ qubit: 2, column: 4 })
    expect(gateAt(circuit, ANCHOR)).toBe('h')
  })

  it('is reported as an orphan when the gate is deleted', () => {
    const store = storeWith()
    expect(store.getState().removeOperation(ANCHOR).ok).toBe(true)

    const circuit = store.getState().circuit
    expect(anchorCellOf(circuit, ANCHOR)).toBeNull()

    /*
     * Orphaned, not dropped. The distinction is the product decision: the thread
     * is still listed, against the circuit, with a note that its subject is
     * gone — because "we discussed this and decided" is the value, and a
     * conversation that vanishes cannot even be looked for.
     */
    const resolution = resolveAnchors(circuit, [ANCHOR])
    expect(resolution.present.size).toBe(0)
    expect(resolution.orphaned).toEqual([ANCHOR])
  })

  it('re-attaches by itself when the deletion is undone', () => {
    const store = storeWith()
    store.getState().removeOperation(ANCHOR)
    expect(resolveAnchors(store.getState().circuit, [ANCHOR]).orphaned).toEqual(
      [ANCHOR]
    )

    expect(store.getState().undo().ok).toBe(true)

    /*
     * The hardest case, and it costs nothing. Undo restores the operations array
     * with the same ids, and no request was ever sent about the comment — so the
     * anchor resolves again with no write, no reconciliation and no compensating
     * update. A stored `orphaned` flag would have needed one, from an editor that
     * does not talk to the API on every keystroke.
     */
    const circuit = store.getState().circuit
    expect(anchorCellOf(circuit, ANCHOR)).toEqual({ qubit: 0, column: 0 })
    expect(gateAt(circuit, ANCHOR)).toBe('h')
  })

  it('orphans rather than slides when the wire under it is deleted', () => {
    const store = storeWith()
    // Deleting a wire deletes what stood on it (see `removeQubit`), and the
    // wires below it shift up — so (q0, c0) is about to be a different gate.
    expect(store.getState().removeQubit(0).ok).toBe(true)

    const circuit = store.getState().circuit
    expect(anchorCellOf(circuit, ANCHOR)).toBeNull()
    // And what is at (q0, c0) now is the `x`, which nobody has said anything
    // about. This is the exact substitution the id anchor exists to refuse.
    expect(circuit.operations.find((row) => row.targets[0] === 0)?.gate).toBe(
      'x'
    )
  })

  it('is not copied onto a pasted duplicate of the gate', () => {
    const store = storeWith()
    store.getState().setSelection([ANCHOR])
    expect(store.getState().copy().ok).toBe(true)
    const pasted = store.getState().paste(0, 5)
    expect(pasted.ok).toBe(true)

    const circuit = store.getState().circuit
    // The original still owns the anchor.
    expect(anchorCellOf(circuit, ANCHOR)).toEqual({ qubit: 0, column: 0 })
    /*
     * And the copy is a different operation with a fresh id, so it carries no
     * comment. That is right rather than a limitation: a pasted gate is a gate
     * nobody has said anything about yet — and it is *why* an anchor can never
     * resolve to the wrong gate, since an id in use is never reissued.
     */
    const copy = circuit.operations.find((row) => row.column === 5)
    expect(copy).toBeDefined()
    expect(copy?.id).not.toBe(ANCHOR)
  })
})

describe('two documents, the same anchor', () => {
  it('resolves in one and orphans in the other, with no writes anywhere', () => {
    /*
     * The property that makes "no `orphaned` column" correct rather than merely
     * cheaper. One comment, two documents on screen — a saved version and the
     * buffer somebody is editing — and the anchor's status differs between them.
     * A boolean in Postgres would have to be true or false; it would be a claim
     * about one of these presented as a fact about both.
     */
    const saved = threeGates()
    const editing = storeWith()
    editing.getState().removeOperation(ANCHOR)

    expect(resolveAnchors(saved, [ANCHOR]).present.has(ANCHOR)).toBe(true)
    expect(
      resolveAnchors(editing.getState().circuit, [ANCHOR]).orphaned
    ).toEqual([ANCHOR])
  })
})

describe('resolveAnchors', () => {
  it('marks a multi-wire gate on its topmost wire, controls included', () => {
    const store = storeWith({
      schemaVersion: CIRCUIT_SCHEMA_VERSION,
      qubits: 3,
      clbits: 0,
      operations: [
        // Target on q2, control on q0: the box is drawn from q0 down, so the
        // marker belongs at q0 rather than on the target.
        { id: 'op_1', gate: 'cx', targets: [2], controls: [0], column: 1 },
      ],
    })
    expect(anchorCellOf(store.getState().circuit, 'op_1')).toEqual({
      qubit: 0,
      column: 1,
    })
  })

  it('sorts orphans so a list does not reorder itself between renders', () => {
    const resolution = resolveAnchors(threeGates(), ['op_9', 'op_4', 'op_7'])
    expect(resolution.orphaned).toEqual(['op_4', 'op_7', 'op_9'])
  })

  it('resolves every anchor in one pass over a document', () => {
    const resolution = resolveAnchors(threeGates(), ['op_1', 'op_3', 'op_404'])
    expect([...resolution.present.entries()]).toEqual([
      ['op_1', { qubit: 0, column: 0 }],
      ['op_3', { qubit: 2, column: 2 }],
    ])
    expect(resolution.orphaned).toEqual(['op_404'])
  })

  it('does not look inside a custom gate definition', () => {
    /*
     * An operation inside a definition has an id of its own, and ids are only
     * unique within their own operation list — so a definition's `op_1` is not
     * this document's `op_1`. A resolver that searched definitions would attach a
     * comment about a call site to a gate inside an unrelated block.
     */
    const circuit: Circuit = {
      schemaVersion: CIRCUIT_SCHEMA_VERSION,
      qubits: 2,
      clbits: 0,
      operations: [{ id: 'call_1', gate: 'bell', targets: [0, 1], column: 0 }],
      customGates: {
        bell: {
          qubits: 2,
          operations: [
            { id: 'op_1', gate: 'h', targets: [0], column: 0 },
            { id: 'op_2', gate: 'cx', targets: [1], controls: [0], column: 1 },
          ],
        },
      },
    }
    const resolution = resolveAnchors(circuit, ['call_1', 'op_1'])
    expect(resolution.present.has('call_1')).toBe(true)
    expect(resolution.orphaned).toEqual(['op_1'])
  })
})
