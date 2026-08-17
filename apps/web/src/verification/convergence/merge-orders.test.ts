/**
 * Two documents, edited while disconnected, merged in every order.
 *
 * Derived from §6 and §3.4 rather than from the implementation: what *should*
 * be true is that the same set of concurrent edits produces one circuit
 * whichever order they arrive in, that every peer holds it, and that the
 * contract accepts it. `converge()` in `peers.ts` asserts all three; each test
 * here adds what it expects that one circuit to be.
 */

import { circuitRoots, slotKeys } from '@qsim/collab'
import { CIRCUIT_SCHEMA_VERSION, emptyCircuit } from '@qsim/schema'
import type { Circuit } from '@qsim/schema'
import { describe, expect, it } from 'vitest'

import {
  cellsOf,
  clientIds,
  converge,
  deliver,
  join,
  placedIds,
  reading,
  seedDocument,
  type Peer,
} from './peers'

function circuit(
  qubits: number,
  operations: Circuit['operations'],
  extra: Partial<Circuit> = {}
): Circuit {
  return {
    schemaVersion: CIRCUIT_SCHEMA_VERSION,
    qubits,
    clbits: qubits,
    operations,
    ...extra,
  }
}

/** Two peers over one seeded document, each with a random client id. */
function pair(base: Circuit): [Peer, Peer] {
  const state = seedDocument(base)
  const [first, second] = clientIds(2) as [number, number]
  return [join(state, 'ana', first), join(state, 'beto', second)]
}

function documentSlots(peer: Peer): number {
  return slotKeys(circuitRoots(peer.doc)).length
}

describe('two gates in one cell — the case the milestone exists for', () => {
  it('keeps one, defers the other, and both peers agree which', () => {
    const [ana, beto] = pair(emptyCircuit(3, 3))

    // Both mint `op_1`: each counts up inside the document it opened.
    expect(ana.store.getState().placeGate('h', [0], 3).ok).toBe(true)
    expect(beto.store.getState().placeGate('x', [0], 3).ok).toBe(true)
    expect(ana.store.getState().circuit.operations[0]?.id).toBe('op_1')
    expect(beto.store.getState().circuit.operations[0]?.id).toBe('op_1')

    const view = converge([ana, beto])

    expect(view.circuit.operations).toHaveLength(1)
    expect(view.deferred).toHaveLength(1)
    expect(view.deferred[0]?.reason).toBe('column-conflict')
    expect(view.deferred[0]?.blockedBy).toEqual([placedIds(view)[0]])
    // Nothing was lost: both gates are still slots in the document.
    expect(documentSlots(ana)).toBe(2)
    expect(documentSlots(beto)).toBe(2)
    // The two ids do not fuse into one operation with Ana's gate and Beto's
    // targets — the outcome `document.ts` calls the worst available.
    expect(['h', 'x']).toContain(view.circuit.operations[0]?.gate)
  })

  it('agrees over many independent client-id draws', () => {
    const winners = new Set<string>()
    for (let attempt = 0; attempt < 24; attempt += 1) {
      const [ana, beto] = pair(emptyCircuit(3, 3))
      ana.store.getState().placeGate('h', [0], 3)
      beto.store.getState().placeGate('x', [0], 3)
      const view = converge([ana, beto])
      winners.add(view.circuit.operations[0]?.gate ?? '?')
    }
    // Which one wins is arbitrary by design; that both peers pick the same one
    // is not. If this ever sees a single gate it means the draw stopped mattering
    // and the tie-break is no longer the slot key.
    expect([...winners].sort()).toEqual(['h', 'x'])
  })
})

describe('an operation already in the document keeps its cell', () => {
  it('defers the younger claim, whatever the client ids are', () => {
    for (let attempt = 0; attempt < 8; attempt += 1) {
      const [ana, beto] = pair(
        circuit(3, [{ id: 'seed_1', gate: 'h', targets: [0], column: 3 }])
      )

      // Ana drags the seeded gate to (q0, c5). A move does not restamp `seq`,
      // so the gate keeps the older claim it entered the document with.
      expect(ana.store.getState().moveOperation('seed_1', [0], 5).ok).toBe(true)
      // Beto, who never saw the move, drops a gate on the cell it moved to.
      expect(beto.store.getState().placeGate('x', [0], 5).ok).toBe(true)

      const view = converge([ana, beto])
      expect(cellsOf(view)).toEqual(['h@0:5'])
      expect(view.deferred).toHaveLength(1)
      expect(view.deferred[0]?.reason).toBe('column-conflict')
      expect(view.deferred[0]?.blockedBy).toEqual(['seed_1'])
    }
  })
})

describe('a two-qubit gate is contested on the wire it controls', () => {
  it('never tears the gate in half', () => {
    const [ana, beto] = pair(emptyCircuit(3, 3))
    expect(
      ana.store.getState().placeGate('cx', [2], 1, { controls: [0] }).ok
    ).toBe(true)
    expect(beto.store.getState().placeGate('h', [0], 1).ok).toBe(true)

    const view = converge([ana, beto])
    expect(view.circuit.operations).toHaveLength(1)
    expect(view.deferred).toHaveLength(1)
    const survivor = view.circuit.operations[0]
    if (survivor?.gate === 'cx') {
      // Both of its cells survived, which is the property a cell-keyed
      // representation could not have offered.
      expect(survivor.targets).toEqual([2])
      expect(survivor.controls).toEqual([0])
    } else {
      expect(survivor?.gate).toBe('h')
    }
  })
})

describe('both peers insert a qubit', () => {
  it('converges, and to one new wire rather than two', () => {
    const [ana, beto] = pair(
      circuit(3, [
        { id: 'seed_1', gate: 'h', targets: [0], column: 0 },
        { id: 'seed_2', gate: 'cx', targets: [1], controls: [0], column: 1 },
      ])
    )

    expect(ana.store.getState().addQubit(0).ok).toBe(true)
    expect(beto.store.getState().addQubit(0).ok).toBe(true)

    const view = converge([ana, beto])
    // Both wrote `qubits: 4` over `3`, so the merge holds one insertion. Two
    // people each adding a wire and getting one wire between them is a real
    // consequence of a last-write-wins scalar, and it is at least the same
    // consequence on both screens.
    expect(view.circuit.qubits).toBe(4)
    expect(cellsOf(view)).toEqual(['h@1:0', 'cx@1,2:1'])
  })

  it('converges when the two insertions are at different indices', () => {
    const [ana, beto] = pair(
      circuit(3, [
        { id: 'seed_1', gate: 'h', targets: [0], column: 0 },
        { id: 'seed_2', gate: 'cx', targets: [1], controls: [0], column: 1 },
      ])
    )
    expect(ana.store.getState().addQubit(0).ok).toBe(true)
    expect(beto.store.getState().addQubit(3).ok).toBe(true)
    converge([ana, beto])
  })
})

describe('one peer reorders the wires while the other places a gate', () => {
  it('converges', () => {
    const [ana, beto] = pair(
      circuit(3, [
        { id: 'seed_1', gate: 'h', targets: [0], column: 0 },
        { id: 'seed_2', gate: 'x', targets: [2], column: 0 },
      ])
    )
    expect(ana.store.getState().reorderQubits([2, 1, 0]).ok).toBe(true)
    expect(beto.store.getState().placeGate('y', [0], 4).ok).toBe(true)
    converge([ana, beto])
  })

  it('converges when the placement lands where a reordered gate arrives', () => {
    const [ana, beto] = pair(
      circuit(3, [{ id: 'seed_1', gate: 'h', targets: [0], column: 0 }])
    )
    // Ana swaps q0 and q2, so the seeded `h` moves to (q2, c0).
    expect(ana.store.getState().reorderQubits([2, 1, 0]).ok).toBe(true)
    // Beto, still seeing q2 as free at column 0, drops a gate there.
    expect(beto.store.getState().placeGate('x', [2], 0).ok).toBe(true)
    const view = converge([ana, beto])
    expect(view.circuit.operations.length + view.deferred.length).toBe(2)
  })
})

describe('one peer deletes an operation the other is editing', () => {
  it('resolves to the deletion on both peers', () => {
    const [ana, beto] = pair(
      circuit(3, [{ id: 'seed_1', gate: 'h', targets: [0], column: 1 }])
    )
    expect(ana.store.getState().removeOperation('seed_1').ok).toBe(true)
    expect(beto.store.getState().moveOperation('seed_1', [2], 4).ok).toBe(true)

    const view = converge([ana, beto])
    expect(view.circuit.operations).toEqual([])
    expect(view.deferred).toEqual([])
    expect(documentSlots(ana)).toBe(0)
  })

  it('resolves the same way when the roles are swapped', () => {
    const [ana, beto] = pair(
      circuit(3, [{ id: 'seed_1', gate: 'h', targets: [0], column: 1 }])
    )
    expect(ana.store.getState().moveOperation('seed_1', [2], 4).ok).toBe(true)
    expect(beto.store.getState().removeOperation('seed_1').ok).toBe(true)
    const view = converge([ana, beto])
    expect(view.circuit.operations).toEqual([])
  })

  it('does not let a recycled id fuse two unrelated gates', () => {
    const [ana, beto] = pair(
      circuit(3, [{ id: 'op_1', gate: 'h', targets: [0], column: 1 }])
    )
    /*
     * Ana deletes `op_1` and places a new gate. The allocator counts on from
     * `firstFreeId`, so the new gate is `op_2` rather than the dead id — that is
     * M5.4's rule about anchors, and it is asserted here so that this scenario
     * cannot quietly stop being the one it means to test. What the merge below
     * exercises is the *document*: slot keys, not ids, are what keep Ana's new
     * gate and the gate Beto is editing from being fused, and that holds whether
     * or not the two ids are equal.
     */
    expect(ana.store.getState().removeOperation('op_1').ok).toBe(true)
    expect(ana.store.getState().placeGate('h', [2], 7).ok).toBe(true)
    expect(ana.store.getState().circuit.operations[0]?.id).toBe('op_2')
    // Beto, meanwhile, edits the gate Ana deleted.
    expect(beto.store.getState().moveOperation('op_1', [0], 2).ok).toBe(true)

    const view = converge([ana, beto])
    // One gate, and it is Ana's new one — not the old gate wearing new targets.
    expect(cellsOf(view)).toEqual(['h@2:7'])
  })
})

describe('three peers', () => {
  it('agree over all six merge orders', () => {
    const state = seedDocument(emptyCircuit(3, 3))
    const [first, second, third] = clientIds(3) as [number, number, number]
    const peers = [
      join(state, 'ana', first),
      join(state, 'beto', second),
      join(state, 'cleo', third),
    ]
    peers[0]?.store.getState().placeGate('h', [0], 3)
    peers[1]?.store.getState().placeGate('x', [0], 3)
    peers[2]?.store.getState().placeGate('y', [0], 3)

    const view = converge(peers)
    expect(view.circuit.operations).toHaveLength(1)
    expect(view.deferred).toHaveLength(2)
    for (const entry of view.deferred) {
      expect(entry.reason).toBe('column-conflict')
      expect(entry.blockedBy).toEqual([placedIds(view)[0]])
    }
  })

  it('agree when each edits a different part of the register', () => {
    const state = seedDocument(
      circuit(4, [
        { id: 'seed_1', gate: 'h', targets: [0], column: 0 },
        { id: 'seed_2', gate: 'cx', targets: [1], controls: [0], column: 1 },
      ])
    )
    const [first, second, third] = clientIds(3) as [number, number, number]
    const peers = [
      join(state, 'ana', first),
      join(state, 'beto', second),
      join(state, 'cleo', third),
    ]
    peers[0]?.store.getState().reorderQubits([1, 0, 2, 3])
    peers[1]?.store.getState().placeGate('measure', [3], 2, {
      clbitTargets: [3],
    })
    peers[2]?.store.getState().removeOperation('seed_2')
    converge(peers)
  })
})

describe('a peer that was offline for many edits', () => {
  it('converges with the peer that kept working', () => {
    const [ana, beto] = pair(
      circuit(4, [
        { id: 'seed_1', gate: 'h', targets: [0], column: 0 },
        { id: 'seed_2', gate: 'cx', targets: [1], controls: [0], column: 1 },
        { id: 'seed_3', gate: 'x', targets: [3], column: 2 },
      ])
    )

    // Sixty-odd edits on one side.
    const placed: string[] = []
    for (let column = 3; column < 13; column += 1) {
      for (let qubit = 0; qubit < 4; qubit += 1) {
        const result = ana.store.getState().placeGate('h', [qubit], column)
        expect(result.ok).toBe(true)
        if (result.ok && result.ids?.[0] !== undefined) {
          placed.push(result.ids[0])
        }
      }
    }
    for (const id of placed.slice(0, 8)) {
      expect(ana.store.getState().removeOperation(id).ok).toBe(true)
    }
    for (const [index, id] of placed.slice(20, 24).entries()) {
      expect(ana.store.getState().moveOperation(id, [index], 20).ok).toBe(true)
    }
    expect(ana.store.getState().setQubitLabel(0, 'alice').ok).toBe(true)
    expect(ana.store.getState().addQubit().ok).toBe(true)

    // Four on the other, one of them into a cell Ana filled.
    expect(beto.store.getState().placeGate('z', [0], 3).ok).toBe(true)
    expect(beto.store.getState().placeGate('t', [1], 20).ok).toBe(true)
    expect(beto.store.getState().removeOperation('seed_3').ok).toBe(true)
    expect(beto.store.getState().setQubitLabel(2, 'bob').ok).toBe(true)

    const view = converge([ana, beto])
    // Beto's gate at (q0, c3) contends with one of Ana's forty.
    expect(view.deferred.map((entry) => entry.reason)).toEqual([
      'column-conflict',
    ])
    /*
     * Only one of the two renames survives, and this is not the conflict
     * machinery deciding: naming a wire for the first time materialises the
     * whole label list (§6 wants one label per qubit or none), so Ana's write of
     * `q2` and Beto's write of `bob` are two writes to one key. Recorded here as
     * behaviour rather than asserted as correct — both peers agree about it,
     * which is what this file is verifying.
     */
    expect(view.circuit.qubitLabels?.[0]).toBeDefined()
  })
})

describe('one peer narrows the register while the other uses the wire', () => {
  it('defers what no longer fits, on both peers', () => {
    const [ana, beto] = pair(
      circuit(3, [{ id: 'seed_1', gate: 'h', targets: [0], column: 0 }])
    )
    expect(ana.store.getState().removeQubit(2).ok).toBe(true)
    expect(beto.store.getState().placeGate('x', [2], 6).ok).toBe(true)

    const view = converge([ana, beto])
    expect(view.circuit.qubits).toBe(2)
    expect(view.deferred).toHaveLength(1)
    expect(view.deferred[0]?.reason).toBe('out-of-register')
  })
})

describe('a deferred gate is held, not lost', () => {
  it('comes back on every peer when the blocker is removed', () => {
    const [ana, beto] = pair(emptyCircuit(3, 3))
    ana.store.getState().placeGate('h', [0], 3)
    beto.store.getState().placeGate('x', [0], 3)
    const view = converge([ana, beto])

    const winner = placedIds(view)[0] as string
    const heldBack = view.deferred[0]?.slot as string

    // Whoever's gate won, both stores hold it now, so either peer can move it
    // out of the way. This is an ordinary edit and not a recovery.
    expect(ana.store.getState().removeOperation(winner).ok).toBe(true)
    deliver(ana, beto)

    for (const peer of [ana, beto]) {
      const after = reading(peer.doc)
      expect(after.deferred, `${peer.name} still defers something`).toEqual([])
      expect(after.circuit.operations).toHaveLength(1)
      expect(after.slots.map(([, slot]) => slot)).toEqual([heldBack])
      expect(peer.store.getState().circuit).toEqual(after.circuit)
    }
  })

  it('survives the next edit of the peer whose gate it is', () => {
    const [ana, beto] = pair(emptyCircuit(3, 3))
    ana.store.getState().placeGate('h', [0], 3)
    beto.store.getState().placeGate('x', [0], 3)
    const view = converge([ana, beto])

    const heldBack = view.deferred[0]?.slot as string
    const loser = [ana, beto].find((peer) =>
      heldBack.startsWith(`${peer.doc.clientID.toString(36)}-`)
    ) as Peer
    const other = loser === ana ? beto : ana

    // The loser's own gate is not in its store any more — it adopted the
    // projection. An unrelated edit must not delete the slot it is still in.
    expect(loser.store.getState().placeGate('z', [1], 9).ok).toBe(true)
    deliver(loser, other)

    for (const peer of [loser, other]) {
      const after = reading(peer.doc)
      expect(
        after.deferred.map((entry) => entry.slot),
        `${peer.name} dropped the deferred slot`
      ).toEqual([heldBack])
      expect(after.circuit.operations).toHaveLength(2)
    }
  })
})

describe('concurrent wire renames', () => {
  it('resolve to one name on both peers', () => {
    const [ana, beto] = pair(
      circuit(3, [], { qubitLabels: ['q0', 'q1', 'q2'] })
    )
    expect(ana.store.getState().setQubitLabel(0, 'alice').ok).toBe(true)
    expect(beto.store.getState().setQubitLabel(0, 'roberto').ok).toBe(true)
    const view = converge([ana, beto])
    expect(['alice', 'roberto']).toContain(view.circuit.qubitLabels?.[0])
  })

  it('keep both when two wires are named for the first time at once', () => {
    const [ana, beto] = pair(circuit(3, []))
    expect(ana.store.getState().setQubitLabel(0, 'alice').ok).toBe(true)
    expect(beto.store.getState().setQubitLabel(2, 'roberto').ok).toBe(true)
    const view = converge([ana, beto])
    /*
     * Both names survive. Naming a wire for the first time materialises the
     * whole label list in the store (§6 wants one label per qubit or none), and
     * writing every entry of it made Ana's rename of q0 a write to q1's and q2's
     * keys too — so these two edits were two writes to one key and last-write-
     * wins discarded one of them, with nothing in `deferred` to report it.
     * `writeLabels` now leaves a placeholder unwritten when the document has
     * never named that wire, so a rename touches exactly the wire it renames.
     */
    expect(view.circuit.qubitLabels).toEqual(['alice', 'q1', 'roberto'])
    expect(view.deferred).toEqual([])
  })

  it('keep both when they name different wires of a labelled circuit', () => {
    const [ana, beto] = pair(
      circuit(3, [], { qubitLabels: ['q0', 'q1', 'q2'] })
    )
    ana.store.getState().setQubitLabel(0, 'alice')
    beto.store.getState().setQubitLabel(2, 'roberto')
    const view = converge([ana, beto])
    expect(view.circuit.qubitLabels).toEqual(['alice', 'q1', 'roberto'])
  })
})

describe('concurrent structural rewrites', () => {
  it('converge when one peer compacts the columns and the other writes', () => {
    const [ana, beto] = pair(
      circuit(3, [
        { id: 'seed_1', gate: 'h', targets: [0], column: 0 },
        { id: 'seed_2', gate: 'x', targets: [1], column: 5 },
        { id: 'seed_3', gate: 'y', targets: [2], column: 9 },
      ])
    )
    expect(ana.store.getState().compactColumns().ok).toBe(true)
    expect(beto.store.getState().placeGate('z', [0], 5).ok).toBe(true)
    converge([ana, beto])
  })

  it('converge on one body when both peers define the same gate', () => {
    const [ana, beto] = pair(circuit(2, []))
    expect(
      ana.store.getState().installCustomGate('shared', {
        qubits: 2,
        operations: [{ id: 'a1', gate: 'h', targets: [0], column: 0 }],
      }).ok
    ).toBe(true)
    expect(
      beto.store.getState().installCustomGate('shared', {
        qubits: 2,
        operations: [{ id: 'b1', gate: 'x', targets: [1], column: 0 }],
      }).ok
    ).toBe(true)

    const view = converge([ana, beto])
    // One definition, whole: a body is one value, so a merge picks a rewrite
    // rather than interleaving two of them.
    expect(Object.keys(view.circuit.customGates ?? {})).toEqual(['shared'])
    expect(['h', 'x']).toContain(
      view.circuit.customGates?.shared?.operations[0]?.gate
    )
  })

  it('keep both definitions when the names differ', () => {
    const [ana, beto] = pair(circuit(2, []))
    ana.store.getState().installCustomGate('anas', {
      qubits: 2,
      operations: [{ id: 'a1', gate: 'h', targets: [0], column: 0 }],
    })
    beto.store.getState().installCustomGate('betos', {
      qubits: 2,
      operations: [{ id: 'b1', gate: 'x', targets: [1], column: 0 }],
    })
    const view = converge([ana, beto])
    expect(Object.keys(view.circuit.customGates ?? {}).sort()).toEqual([
      'anas',
      'betos',
    ])
  })
})

describe('undo in a shared document', () => {
  it('takes back only its own change, and both peers agree afterwards', () => {
    const [ana, beto] = pair(circuit(3, []))
    expect(ana.store.getState().placeGate('h', [0], 0).ok).toBe(true)
    expect(beto.store.getState().placeGate('x', [1], 1).ok).toBe(true)
    const view = converge([ana, beto])
    expect(view.circuit.operations).toHaveLength(2)

    expect(ana.store.getState().undo().ok).toBe(true)
    deliver(ana, beto)

    for (const peer of [ana, beto]) {
      const after = reading(peer.doc)
      expect(
        cellsOf(after),
        `${peer.name} does not agree after Ana's undo`
      ).toEqual(['x@1:1'])
      expect(peer.store.getState().circuit).toEqual(after.circuit)
    }
    // And Beto's undo has nothing of Ana's to reach for either way.
    expect(beto.store.getState().undo().ok).toBe(true)
    deliver(beto, ana)
    for (const peer of [ana, beto]) {
      expect(reading(peer.doc).circuit.operations).toEqual([])
    }
  })

  it('does not resurrect what a peer deleted in the meantime', () => {
    const [ana, beto] = pair(circuit(3, []))
    expect(ana.store.getState().placeGate('h', [0], 0).ok).toBe(true)
    converge([ana, beto])
    const id = ana.store.getState().circuit.operations[0]?.id as string

    // Beto deletes Ana's gate; Ana then presses undo over her own placement.
    expect(beto.store.getState().removeOperation(id).ok).toBe(true)
    deliver(beto, ana)
    ana.store.getState().undo()
    deliver(ana, beto)

    for (const peer of [ana, beto]) {
      expect(reading(peer.doc).circuit.operations).toEqual([])
      expect(peer.store.getState().circuit.operations).toEqual([])
    }
  })
})
