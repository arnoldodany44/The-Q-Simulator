/**
 * Independent verification of M5.1: undo ownership in a shared document.
 *
 * The rule being checked is one sentence: **Ana pressing undo takes back Ana's
 * last change and leaves Beto's alone.** Every expectation was derived from
 * that sentence, and from `sharedUndo.ts`'s own stated contract, before the
 * suite was run.
 *
 * ── HOW TO READ A `it.fails` HERE ─────────────────────────────────────────
 *
 * Every assertion states what a correct system does. The ones marked
 * `it.fails` are the ones the implementation does not do today: the assertion
 * is the specification, and the marker is what keeps this suite green while the
 * defect stands. Fixing the defect turns the marker red — which is the point.
 * Flip it back to `it` then; do not weaken the assertion.
 */

import { describe, expect, it } from 'vitest'

import {
  cells,
  circuitOf,
  deferredOf,
  deliver,
  host,
  idOf,
  joiner,
  merge,
} from './peers'

describe('undo ownership: two peers, one document', () => {
  it('A. Ana undo removes Ana gate and keeps Beto gate (both online)', () => {
    const ana = host('ana')
    const beto = joiner('beto', ana)

    expect(ana.store.getState().placeGate('h', [0], 0).ok).toBe(true)
    deliver(ana, beto)
    expect(cells(circuitOf(beto))).toEqual(['h@0:0'])

    expect(beto.store.getState().placeGate('x', [1], 0).ok).toBe(true)
    deliver(beto, ana)
    expect(cells(circuitOf(ana))).toEqual(['h@0:0', 'x@1:0'])

    expect(ana.store.getState().undo().ok).toBe(true)
    expect(cells(circuitOf(ana))).toEqual(['x@1:0'])

    deliver(ana, beto)
    expect(cells(circuitOf(beto))).toEqual(['x@1:0'])
  })

  it('B. Ana undo after a genuinely concurrent merge keeps Beto gate', () => {
    const ana = host('ana')
    const beto = joiner('beto', ana)

    // Disconnected: neither delivery happens until both have written.
    ana.store.getState().placeGate('h', [0], 0)
    beto.store.getState().placeGate('x', [1], 0)
    merge(ana, beto)

    expect(cells(circuitOf(ana))).toEqual(['h@0:0', 'x@1:0'])
    expect(cells(circuitOf(beto))).toEqual(['h@0:0', 'x@1:0'])

    expect(ana.store.getState().undo().ok).toBe(true)
    expect(cells(circuitOf(ana))).toEqual(['x@1:0'])
    merge(ana, beto)
    expect(cells(circuitOf(beto))).toEqual(['x@1:0'])
  })

  it('C. Ana redo after a remote edit lands restores Ana gate whole', () => {
    const ana = host('ana')
    const beto = joiner('beto', ana)

    ana.store.getState().placeGate('h', [0], 0)
    deliver(ana, beto)
    expect(ana.store.getState().undo().ok).toBe(true)
    deliver(ana, beto)
    expect(cells(circuitOf(beto))).toEqual([])

    beto.store.getState().placeGate('x', [1], 0)
    deliver(beto, ana)
    expect(cells(circuitOf(ana))).toEqual(['x@1:0'])

    expect(ana.store.getState().redo().ok).toBe(true)
    expect(cells(circuitOf(ana))).toEqual(['h@0:0', 'x@1:0'])
    expect(deferredOf(ana)).toEqual([])

    merge(ana, beto)
    expect(cells(circuitOf(beto))).toEqual(['h@0:0', 'x@1:0'])
  })

  /**
   * FINDING 1, fixed. One keystroke may spend only one of Ana's steps.
   *
   * `sharedUndo.ts` states the intent: "Ana's undo does nothing to that field
   * rather than silently reverting Beto's newer value." `Y.UndoManager`'s
   * `popStackItem` kept popping until *something* changed, so the refused angle
   * step was discarded without a trace and the step under it — Ana's placement
   * — ran in its place: the gate went and Beto's 1.25 with it. `one()` now hands
   * the manager a stack holding just the item being asked for, so the
   * fall-through has nowhere to fall.
   */
  it('D. Ana undo of a field Beto overwrote reverts nothing else', () => {
    const ana = host('ana')
    const beto = joiner('beto', ana)

    const placed = ana.store.getState().placeGate('rz', [0], 0)
    expect(placed.ok).toBe(true)
    const id = idOf(placed)
    deliver(ana, beto)

    expect(ana.store.getState().setParam(id, 0, 0.5).ok).toBe(true)
    deliver(ana, beto)
    expect(circuitOf(beto).operations[0]?.params).toEqual([0.5])

    expect(beto.store.getState().setParam(id, 0, 1.25).ok).toBe(true)
    deliver(beto, ana)
    expect(circuitOf(ana).operations[0]?.params).toEqual([1.25])

    // Press one: the angle is no longer Ana's to revert, so nothing moves and
    // the store says so. The step is spent, not silently thrown away.
    const first = ana.store.getState().undo()
    expect({
      ok: first.ok,
      cells: cells(circuitOf(ana)),
      params: circuitOf(ana).operations[0]?.params,
    }).toEqual({ ok: false, cells: ['rz@0:0'], params: [1.25] })

    // Press two reaches the placement, which is Ana's to take back.
    expect(ana.store.getState().undo().ok).toBe(true)
    expect(cells(circuitOf(ana))).toEqual([])
  })

  /**
   * FINDING 2, fixed. Ana's undo of a structural change keeps Beto's gate.
   *
   * Ana inserts a wire, which rewrites the `targets` of every operation
   * including Beto's. Beto then moves his own gate. Ana's undo reverts her
   * `qubits` write — hers to revert — and Yjs correctly refuses to revert
   * `targets`, which Beto has written since. The half that landed left Beto's
   * gate outside the register, so the projection deferred it and it disappeared
   * from both screens with only `deferred` to say why. `widenRegister` now runs
   * on the peer that pressed undo: a wire cannot be withdrawn from under
   * somebody else's gate, so the register stays as wide as the document needs.
   */
  it('E. Ana undo of a structural change keeps Beto gate placed', () => {
    const ana = host('ana')
    const beto = joiner('beto', ana)

    beto.store.getState().placeGate('x', [1], 0)
    deliver(beto, ana)
    expect(cells(circuitOf(ana))).toEqual(['x@1:0'])

    expect(ana.store.getState().addQubit(0).ok).toBe(true)
    expect(cells(circuitOf(ana))).toEqual(['x@2:0'])
    deliver(ana, beto)
    expect(cells(circuitOf(beto))).toEqual(['x@2:0'])

    // Beto moves his own gate onto the wire Ana just created.
    const betoId = circuitOf(beto).operations[0]?.id ?? ''
    expect(beto.store.getState().moveOperation(betoId, [3], 0).ok).toBe(true)
    deliver(beto, ana)
    expect(cells(circuitOf(ana))).toEqual(['x@3:0'])

    ana.store.getState().undo()
    merge(ana, beto)
    // Whatever the register ends up as, Beto's gate must still be a gate.
    expect({
      ana: cells(circuitOf(ana)),
      beto: cells(circuitOf(beto)),
      deferred: deferredOf(beto),
    }).toEqual({ ana: ['x@3:0'], beto: ['x@3:0'], deferred: [] })
  })

  /**
   * FINDING 3, fixed. Opening a definition publishes nothing at all.
   *
   * `openDefinition` swaps `state.circuit` for the definition's body through a
   * bare `set`, and the bridge's store subscription could not tell that from an
   * edit — so it wrote the body into the shared document, deleted every
   * operation of the host circuit, and (because the body declares no custom
   * gates) deleted the definition too. The bridge now reads `definitionEdit`:
   * a detour publishes nothing on the way in, and on the way out publishes the
   * definitions alone. `openDefinition` no longer clears the session's undo
   * stack either, which is why Ana can still take her own edits back.
   */
  it('F. opening a definition does not publish its body', () => {
    const ana = host('ana')
    const beto = joiner('beto', ana)

    ana.store.getState().placeGate('h', [0], 0)
    ana.store.getState().placeGate('x', [1], 1)
    ana.store
      .getState()
      .setSelection(circuitOf(ana).operations.map((operation) => operation.id))
    expect(ana.store.getState().packageSelection('mine').ok).toBe(true)
    merge(ana, beto)
    expect(cells(circuitOf(beto))).toEqual(['mine@0+1:0'])

    // A definition edit is a *different document* — the store says so, and
    // bumps `documentId` for it. None of it belongs to the peers.
    expect(ana.store.getState().openDefinition('mine').ok).toBe(true)
    deliver(ana, beto)
    expect({
      cells: cells(circuitOf(beto)),
      gates: Object.keys(circuitOf(beto).customGates ?? {}),
    }).toEqual({ cells: ['mine@0+1:0'], gates: ['mine'] })

    // And the session's own history is still Ana's to use: the detour is a
    // different document, so it clears the *local* history and leaves the
    // shared stack waiting.
    expect(ana.store.getState().cancelDefinition().ok).toBe(true)
    expect(ana.store.getState().undo().ok).toBe(true)
    merge(ana, beto)
    expect({
      ana: cells(circuitOf(ana)),
      beto: cells(circuitOf(beto)),
    }).toEqual({ ana: ['h@0:0', 'x@1:1'], beto: ['h@0:0', 'x@1:1'] })
  })

  it('G. leaving the session gives the solo history back', () => {
    const ana = host('ana')
    ana.store.getState().placeGate('h', [0], 0)
    ana.bridge.detach()

    ana.store.getState().placeGate('x', [1], 1)
    expect(cells(circuitOf(ana))).toEqual(['h@0:0', 'x@1:1'])
    expect(ana.store.getState().undo().ok).toBe(true)
    expect(cells(circuitOf(ana))).toEqual(['h@0:0'])
    // The session's steps are not offered back: undoing into a document other
    // people edited is what `attachHistory` clears the stack to prevent.
    expect(ana.store.getState().undo().ok).toBe(false)
  })
})
