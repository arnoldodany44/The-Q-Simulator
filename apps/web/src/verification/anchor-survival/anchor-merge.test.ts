/**
 * INDEPENDENT VERIFICATION — anchor survival across a merge (lens:
 * anchor-survival).
 *
 * Two real Y.Docs, edited while apart, then merged. The claim under test is the
 * one §3.4 (M5.4 decision 1) and `packages/contract/src/comments.ts` both make:
 *
 *   "an anchor can fail to resolve but it can never resolve to the wrong gate"
 *
 * `project.ts` renames a duplicate contract id after a merge, and the anchor IS
 * a contract id — so the question is whether a rename can move a commented
 * gate's id onto somebody else's gate.
 *
 * NOTE FOR WHOEVER FINDS THIS RED: these assertions state the claim §3.4 (M5.4)
 * makes about anchors. A failure here is a finding, not a broken test. No
 * production code was touched by this directory.
 */

import { documentOf, projectCircuit, writeCircuit } from '@qsim/collab'
import { emptyCircuit, type Circuit } from '@qsim/schema'
import { describe, expect, it } from 'vitest'
import * as Y from 'yjs'

import { anchorCellOf } from '../../features/comments/anchors.js'
import { createCircuitStore } from '../../features/circuit-editor/useCircuitStore.js'

const base: Circuit = {
  ...emptyCircuit(3, 3),
  operations: [{ id: 'op_1', gate: 'h', targets: [0], column: 0 }],
}

/**
 * A peer: a store loaded with `base` and a Y.Doc synced to the same bytes.
 *
 * `clientID` is fixed so the slot keys — and therefore `project.ts`'s
 * tie-break between two genuinely concurrent placements — are deterministic
 * instead of a coin flip on Yjs's random id.
 */
function peer(clientID: number, seed: Uint8Array) {
  const doc = new Y.Doc()
  doc.clientID = clientID
  Y.applyUpdate(doc, seed)
  const store = createCircuitStore()
  expect(store.getState().loadCircuit(projectCircuit(doc).circuit).ok).toBe(
    true
  )
  return { doc, store }
}

/** Places one gate through the real store and writes it into the peer's doc. */
function place(
  peerState: ReturnType<typeof peer>,
  gate: string,
  qubit: number,
  column: number
): string {
  const before = projectCircuit(peerState.doc)
  const result = peerState.store.getState().placeGate(gate, [qubit], column)
  expect(result.ok).toBe(true)
  const id = result.ok ? (result.ids[0] ?? '') : ''
  writeCircuit(peerState.doc, peerState.store.getState().circuit, {
    origin: 'test',
    baseline: before,
  })
  return id
}

describe('anchor survival across a CRDT merge', () => {
  it('two peers apart mint the same operation id', () => {
    const seed = Y.encodeStateAsUpdate(documentOf(base))
    const ana = peer(2, seed)
    const beto = peer(1, seed)

    // Neither has seen the other. The store's allocator counts up from op_1
    // inside the document each of them opened, so both call their gate op_2.
    expect(place(ana, 'x', 1, 1)).toBe('op_2')
    expect(place(beto, 'y', 2, 1)).toBe('op_2')
  })

  it('a merge must not hand a commented gate’s id to another peer’s gate', () => {
    const seed = Y.encodeStateAsUpdate(documentOf(base))
    // Ana's clientID sorts AFTER Beto's, which is the half of the coin flip
    // that decides the rename against her. Nothing in the product lets her
    // choose it.
    const ana = peer(2, seed)
    const beto = peer(1, seed)

    const anaGateId = place(ana, 'x', 1, 1)
    const betoGateId = place(beto, 'y', 2, 1)
    expect(anaGateId).toBe(betoGateId)

    // Ana comments on the gate she just placed, while still apart. The anchor
    // recorded in the database is the id her own document shows.
    const anchor = anaGateId
    expect(anchorCellOf(ana.store.getState().circuit, anchor)).toEqual({
      qubit: 1,
      column: 1,
    })

    // They reconnect and exchange updates.
    const fromAna = Y.encodeStateAsUpdate(ana.doc)
    const fromBeto = Y.encodeStateAsUpdate(beto.doc)
    Y.applyUpdate(ana.doc, fromBeto)
    Y.applyUpdate(beto.doc, fromAna)

    const merged = projectCircuit(ana.doc)
    // Convergence itself is fine: both gates survive.
    expect(merged.circuit.operations).toHaveLength(3)
    expect(projectCircuit(beto.doc).circuit).toEqual(merged.circuit)

    const resolved = merged.circuit.operations.find((op) => op.id === anchor)
    // The specified outcome: Ana's comment either still names her `x`, or it
    // names nothing at all. Naming Beto's `y` is the "changed its subject in
    // silence" failure the anchor design exists to prevent.
    expect(resolved?.gate ?? null).not.toBe('y')
    expect(anchorCellOf(merged.circuit, anchor)).not.toEqual({
      qubit: 2,
      column: 1,
    })
  })
})
