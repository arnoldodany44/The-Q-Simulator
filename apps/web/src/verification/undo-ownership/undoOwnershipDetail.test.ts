/**
 * Second batch: the remaining ways one peer's history reaches another peer's
 * document, and the interleaving orders the milestone asks for.
 *
 * The `it.fails` convention is explained in `undoOwnership.test.ts`.
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

describe('undo ownership: mechanisms', () => {
  /**
   * FINDING 1, measured. How many of Ana's steps one press spends.
   *
   * The counterpart to case D: D says what the presses must report, this says
   * what the document must look like after each of them. One press spends one
   * step, so the refused angle step is spent and the placement is still there
   * to be taken back by the second press — and the redo that follows gives back
   * the gate carrying the value the document actually holds.
   */
  it('D2. evidence: one press spends exactly one step', () => {
    const ana = host('ana')
    const beto = joiner('beto', ana)

    const placed = ana.store.getState().placeGate('rz', [0], 0)
    const id = idOf(placed)
    deliver(ana, beto)
    ana.store.getState().setParam(id, 0, 0.5)
    deliver(ana, beto)
    beto.store.getState().setParam(id, 0, 1.25)
    deliver(beto, ana)

    const first = ana.store.getState().undo()
    const middle = cells(circuitOf(ana))
    const second = ana.store.getState().undo()
    expect({
      first: { ok: first.ok, cells: middle },
      second: { ok: second.ok, cells: cells(circuitOf(ana)) },
    }).toEqual({
      // Press one asks for the angle, which is no longer Ana's to revert. It is
      // spent and nothing moves; Beto's 1.25 is untouched.
      first: { ok: false, cells: ['rz@0:0'] },
      // Press two reaches the placement, which is hers.
      second: { ok: true, cells: [] },
    })

    // Redo gives the gate back, carrying the value the document holds — Beto's,
    // because his was the last write to that field and Ana never reverted it.
    expect(ana.store.getState().redo().ok).toBe(true)
    expect({
      cells: cells(circuitOf(ana)),
      params: circuitOf(ana).operations[0]?.params,
    }).toEqual({ cells: ['rz@0:0'], params: [1.25] })
  })

  /**
   * FINDING 4, fixed. `loadCircuit` while bridged publishes nothing.
   *
   * Same mechanism as FINDING 3: an action that swaps the whole document went
   * through a bare `set`, and the bridge's subscription read it as an edit. The
   * reachable paths are opening another circuit, restoring a version and
   * importing OpenQASM — each of which would have overwritten the live session
   * of whatever circuit the peers were in. The bridge now compares
   * `documentId`, stops, and tells the transport.
   */
  it('H. loading another circuit while bridged does not publish it', () => {
    const ana = host('ana')
    const beto = joiner('beto', ana)
    ana.store.getState().placeGate('h', [0], 0)
    merge(ana, beto)

    expect(
      ana.store.getState().loadCircuit({
        schemaVersion: 1,
        qubits: 2,
        operations: [{ id: 'other_1', gate: 'y', targets: [0], column: 0 }],
      }).ok
    ).toBe(true)
    deliver(ana, beto)
    expect(cells(circuitOf(beto))).toEqual(['h@0:0'])
    // And the transport was told, once, so it can leave the channel.
    expect(ana.replaced).toBe(1)
  })

  it('I. undo and redo interleaved with remote edits, in several orders', () => {
    const ana = host('ana')
    const beto = joiner('beto', ana)

    // Ana: three placements. Beto: one, landing between Ana's second and third.
    ana.store.getState().placeGate('h', [0], 0)
    ana.store.getState().placeGate('x', [0], 1)
    deliver(ana, beto)
    beto.store.getState().placeGate('z', [1], 0)
    deliver(beto, ana)
    ana.store.getState().placeGate('y', [0], 2)
    merge(ana, beto)
    expect(cells(circuitOf(beto))).toEqual(['h@0:0', 'x@0:1', 'y@0:2', 'z@1:0'])

    // Three presses take back exactly Ana's three; Beto's z survives.
    expect(ana.store.getState().undo(3).ok).toBe(true)
    merge(ana, beto)
    expect({
      ana: cells(circuitOf(ana)),
      beto: cells(circuitOf(beto)),
    }).toEqual({ ana: ['z@1:0'], beto: ['z@1:0'] })

    // A fourth press has nothing of Ana's left, though the document is not
    // empty — that narrower meaning is the whole point of per-user undo.
    expect(ana.store.getState().undo().ok).toBe(false)

    // Beto edits again, then Ana redoes all three.
    beto.store.getState().placeGate('s', [2], 3)
    merge(beto, ana)
    expect(ana.store.getState().redo(3).ok).toBe(true)
    merge(ana, beto)
    expect({
      ana: cells(circuitOf(ana)),
      beto: cells(circuitOf(beto)),
      deferred: deferredOf(beto),
    }).toEqual({
      ana: ['h@0:0', 's@2:3', 'x@0:1', 'y@0:2', 'z@1:0'],
      beto: ['h@0:0', 's@2:3', 'x@0:1', 'y@0:2', 'z@1:0'],
      deferred: [],
    })
  })

  /**
   * FINDING 5, fixed. Ana's redo does not displace a gate Beto placed since.
   *
   * `project.ts` decides a contested cell by the Lamport stamp and states the
   * rule it implements: "an operation that was already in the document when
   * yours was written is never displaced by yours". A redo re-inserts the
   * operation with the stamp it was born with — `item.content.copy()` carries
   * `seq` verbatim — so Ana's re-inserted gate presented an older claim than
   * Beto's, even though Ana's gate was *not* in the document when Beto wrote,
   * and Beto's gate left both canvases because Ana pressed redo.
   * `restampOperations` now gives a revived operation the newest claim, which is
   * what it is.
   */
  it('J. Ana redo does not displace a gate Beto placed since', () => {
    const ana = host('ana')
    const beto = joiner('beto', ana)

    ana.store.getState().placeGate('h', [0], 0)
    deliver(ana, beto)
    beto.store.getState().placeGate('x', [1], 0)
    deliver(beto, ana)
    // Ana takes her h back; the cell (q0, c0) is free for anybody.
    ana.store.getState().undo()
    deliver(ana, beto)
    expect(cells(circuitOf(beto))).toEqual(['x@1:0'])

    // Beto moves into the cell Ana vacated. His is the only claim on it.
    const betoId = circuitOf(beto).operations[0]?.id ?? ''
    beto.store.getState().moveOperation(betoId, [0], 0)
    deliver(beto, ana)
    expect(cells(circuitOf(ana))).toEqual(['x@0:0'])

    ana.store.getState().redo()
    merge(ana, beto)
    expect({
      beto: cells(circuitOf(beto)),
      deferred: deferredOf(beto),
    }).toEqual({ beto: ['x@0:0'], deferred: ['column-conflict:h'] })
  })
})
