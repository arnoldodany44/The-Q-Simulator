import {
  defaultQubitLabel as documentLabel,
  projectCircuit,
} from '@qsim/collab'
import { validateCircuit } from '@qsim/schema'
import { afterEach, describe, expect, it } from 'vitest'
import * as Y from 'yjs'

import {
  createCircuitStore,
  defaultQubitLabel,
  type CircuitStore,
} from '../circuit-editor/useCircuitStore'
import {
  bridgeCircuitDocument,
  type CircuitDocumentBridge,
} from './circuitDocument'

interface Peer {
  readonly store: CircuitStore
  readonly bridge: CircuitDocumentBridge
}

const attached: CircuitDocumentBridge[] = []

function peer(doc: Y.Doc, seed?: 'document' | 'store'): Peer {
  const store = createCircuitStore()
  const bridge = bridgeCircuitDocument({
    store,
    doc,
    ...(seed === undefined ? {} : { seed }),
  })
  attached.push(bridge)
  return { store, bridge }
}

/**
 * Two peers on one session, with a relay between them.
 *
 * The relay is what a socket will be: it forwards every update it sees to the
 * other side and lets Yjs's idempotence stop the echo — an update that changes
 * nothing produces no update of its own, so the second hop is the last.
 */
function session(): { ana: Peer; beto: Peer } {
  const ana = peer(new Y.Doc())
  const beto = peer(forkOf(ana.bridge.doc))
  relay(ana.bridge, beto.bridge)
  relay(beto.bridge, ana.bridge)
  return { ana, beto }
}

function forkOf(doc: Y.Doc): Y.Doc {
  const copy = new Y.Doc()
  Y.applyUpdate(copy, Y.encodeStateAsUpdate(doc))
  return copy
}

function relay(from: CircuitDocumentBridge, to: CircuitDocumentBridge): void {
  from.doc.on('update', (update: Uint8Array) => {
    to.receive(update)
  })
}

afterEach(() => {
  while (attached.length > 0) attached.pop()?.detach()
})

describe('bridgeCircuitDocument', () => {
  it('seeds an empty document from the editor', () => {
    const { store, bridge } = peer(new Y.Doc())
    store.getState().placeGate('h', [0], 0)

    expect(projectCircuit(bridge.doc).circuit).toEqual(store.getState().circuit)
  })

  it('adopts a document that already holds a circuit', () => {
    const first = peer(new Y.Doc())
    first.store.getState().placeGate('h', [0], 0)

    const joiner = peer(forkOf(first.bridge.doc))

    expect(joiner.store.getState().circuit).toEqual(
      first.store.getState().circuit
    )
  })

  it('writes one update per edit and does not answer its own', () => {
    // The loop this bridge exists to avoid would show up here as an unbounded
    // number of updates, or as a second one carrying nothing.
    const { store, bridge } = peer(new Y.Doc())
    const updates: unknown[] = []
    bridge.doc.on('update', (_update: Uint8Array, origin: unknown) => {
      updates.push(origin)
    })

    store.getState().placeGate('h', [0], 0)

    expect(updates).toEqual([bridge.origin])
  })

  it('does not write when only the selection changed', () => {
    const { store, bridge } = peer(new Y.Doc())
    store.getState().placeGate('h', [0], 0)
    let updates = 0
    bridge.doc.on('update', () => {
      updates += 1
    })

    store.getState().setSelection([])
    store
      .getState()
      .setSelection(store.getState().circuit.operations.map((o) => o.id))

    expect(updates).toBe(0)
  })

  it('does not write when an edit was refused', () => {
    // The store's second rule — a refused edit changes nothing — has to survive
    // the bridge, or a rejected drag would travel to everybody else.
    const { store, bridge } = peer(new Y.Doc())
    store.getState().placeGate('h', [0], 0)
    let updates = 0
    bridge.doc.on('update', () => {
      updates += 1
    })

    // Same cell: the contract refuses it, so nothing happens at all.
    const result = store.getState().placeGate('x', [0], 0)

    expect(result.ok).toBe(false)
    expect(updates).toBe(0)
  })

  it('carries an edit from one peer to the other', () => {
    const { ana, beto } = session()

    ana.store.getState().placeGate('h', [0], 0)

    expect(beto.store.getState().circuit).toEqual(ana.store.getState().circuit)
    expect(validateCircuit(beto.store.getState().circuit)).toEqual([])
  })

  it('keeps both peers on the same circuit through a stream of edits', () => {
    const { ana, beto } = session()

    ana.store.getState().placeGate('h', [0], 0)
    beto.store.getState().placeGate('x', [1], 0)
    ana.store.getState().placeGate('cx', [1], 1, { controls: [0] })
    beto.store.getState().addQubit()
    ana.store.getState().setQubitLabel(0, 'alice')

    expect(beto.store.getState().circuit).toEqual(ana.store.getState().circuit)
    expect(ana.store.getState().circuit.qubits).toBe(4)
    expect(ana.store.getState().circuit.qubitLabels?.[0]).toBe('alice')
  })

  describe('undo', () => {
    it('takes back this client’s edit and leaves the other’s alone', () => {
      // The whole point of a per-user history, in one assertion: Ana pressing
      // undo must not delete what Beto just did.
      const { ana, beto } = session()
      ana.store.getState().placeGate('h', [0], 0)
      beto.store.getState().placeGate('x', [1], 0)
      expect(ana.store.getState().circuit.operations).toHaveLength(2)

      expect(ana.store.getState().undo().ok).toBe(true)

      for (const holder of [ana, beto]) {
        expect(
          holder.store
            .getState()
            .circuit.operations.map((operation) => operation.gate)
        ).toEqual(['x'])
      }
    })

    it('reports nothing to undo when only the other peer has edited', () => {
      // Narrower than it used to be, and deliberately: the stack is not empty,
      // it holds nothing of *this* user's. Reporting a refusal is what lets the
      // editor say so to somebody who cannot see the canvas.
      const { ana, beto } = session()
      beto.store.getState().placeGate('x', [1], 0)

      expect(ana.store.getState().undo()).toMatchObject({
        ok: false,
        reason: 'nothing-to-undo',
      })
      expect(beto.store.getState().circuit.operations).toHaveLength(1)
    })

    it('redoes what it undid, and only that', () => {
      const { ana, beto } = session()
      ana.store.getState().placeGate('h', [0], 0)
      beto.store.getState().placeGate('x', [1], 0)
      ana.store.getState().undo()

      expect(ana.store.getState().redo().ok).toBe(true)

      expect(
        beto.store
          .getState()
          .circuit.operations.map((o) => o.gate)
          .sort()
      ).toEqual(['h', 'x'])
    })

    it('does not revert a field the other peer has written since', () => {
      /*
       * `ignoreRemoteMapChanges` left at its default. Ana's undo cannot put the
       * angle back to 0 without overwriting the 2 Beto typed after her, so Yjs
       * refuses that item — and one press spends exactly that one step. It does
       * *not* fall through to the next of Ana's steps that can still be undone:
       * that used to delete the gate, and Beto's 2 with it, while reporting
       * success. "Undo mine" has to mean "and only mine" even when mine has
       * already been overwritten, and a press that could do nothing has to say
       * so. See `one()` in `sharedUndo.ts`.
       */
      const { ana, beto } = session()
      ana.store.getState().placeGate('rz', [0], 0)
      const id = ana.store.getState().circuit.operations[0]!.id
      ana.store.getState().setParam(id, 0, 1)
      beto.store.getState().setParam(id, 0, 2)

      expect(ana.store.getState().undo().ok).toBe(false)
      expect(beto.store.getState().circuit).toEqual(
        ana.store.getState().circuit
      )
      expect(ana.store.getState().circuit.operations[0]?.params).toEqual([2])

      // The next press reaches the placement, which is hers to take back.
      expect(ana.store.getState().undo().ok).toBe(true)
      expect(ana.store.getState().circuit.operations).toEqual([])
      expect(beto.store.getState().circuit).toEqual(
        ana.store.getState().circuit
      )
    })

    it('restores the selection that was in place before the edit', () => {
      const { ana } = session()
      ana.store.getState().placeGate('h', [0], 0)
      const first = ana.store.getState().selection
      ana.store.getState().placeGate('x', [1], 1)
      expect(ana.store.getState().selection).not.toEqual(first)

      ana.store.getState().undo()

      expect(ana.store.getState().selection).toEqual(first)
    })

    it('undoes every kind of change the store makes', () => {
      // The store's actions do more than add operations: they resize registers,
      // rename wires, declare parameters and install definitions. Each one has
      // to be one undo step in a shared session too, or "undo" would mean
      // different things depending on which button was pressed.
      const { store } = peer(new Y.Doc())
      const state = () => store.getState()
      const circuits = [state().circuit]

      state().placeGate('rz', [0], 0)
      circuits.push(state().circuit)
      state().setParam(state().circuit.operations[0]!.id, 0, 1.25)
      circuits.push(state().circuit)
      state().addQubit()
      circuits.push(state().circuit)
      state().setQubitLabel(1, 'middle')
      circuits.push(state().circuit)
      state().addClbit()
      circuits.push(state().circuit)
      state().installCustomGate('block', {
        qubits: 1,
        operations: [{ id: 'b1', gate: 'h', targets: [0], column: 0 }],
      })
      circuits.push(state().circuit)
      state().placeCustomGate('block', 0)
      circuits.push(state().circuit)

      for (let step = circuits.length - 2; step >= 0; step -= 1) {
        expect(state().undo().ok).toBe(true)
        expect(state().circuit).toEqual(circuits[step])
      }
      expect(state().undo().ok).toBe(false)
    })

    it('collapses a gesture into one step', () => {
      const { store } = peer(new Y.Doc())
      const state = () => store.getState()
      state().placeGate('rz', [0], 0)
      const id = state().circuit.operations[0]!.id
      const before = state().circuit

      state().beginTransaction()
      for (const angle of [0.25, 0.5, 0.75]) state().setParam(id, 0, angle)
      state().endTransaction()
      expect(state().circuit.operations[0]?.params).toEqual([0.75])

      expect(state().undo().ok).toBe(true)
      expect(state().circuit).toEqual(before)
    })

    it('charges nothing for a gesture that ended where it began', () => {
      const { store } = peer(new Y.Doc())
      const state = () => store.getState()
      state().placeGate('rz', [0], 0)
      const id = state().circuit.operations[0]!.id

      state().beginTransaction()
      state().setParam(id, 0, 0.5)
      state().setParam(id, 0, 0)
      state().endTransaction()

      // The one step left is the placement, not the drag.
      expect(state().undo().ok).toBe(true)
      expect(state().circuit.operations).toEqual([])
      expect(state().undo().ok).toBe(false)
    })

    it('gives the local history back when the bridge detaches', () => {
      const store = createCircuitStore()
      const bridge = bridgeCircuitDocument({ store, doc: new Y.Doc() })
      store.getState().placeGate('h', [0], 0)
      bridge.detach()

      store.getState().placeGate('x', [1], 1)
      expect(store.getState().undo().ok).toBe(true)
      expect(store.getState().circuit.operations).toHaveLength(1)
      // And no further: leaving a session leaves you where the document is,
      // because a stack of snapshots taken before other people edited is a
      // stack of documents that were only ever this client's.
      expect(store.getState().undo().ok).toBe(false)
    })
  })

  describe('a merge that broke §6', () => {
    it('shows both peers the same circuit and the same held-back gate', () => {
      const ana = peer(new Y.Doc())
      ana.store.getState().placeGate('h', [0], 0)
      const beto = peer(forkOf(ana.bridge.doc))

      // Both drop a gate on (q1, c1) while apart.
      ana.store.getState().placeGate('x', [1], 1)
      beto.store.getState().placeGate('z', [1], 1)

      const fromAna = ana.bridge.state()
      const fromBeto = beto.bridge.state()
      expect(ana.bridge.receive(fromBeto).ok).toBe(true)
      expect(beto.bridge.receive(fromAna).ok).toBe(true)

      expect(beto.store.getState().circuit).toEqual(
        ana.store.getState().circuit
      )
      expect(validateCircuit(ana.store.getState().circuit)).toEqual([])
      expect(ana.bridge.projection().deferred).toEqual(
        beto.bridge.projection().deferred
      )
      expect(ana.bridge.projection().deferred).toHaveLength(1)
      // Whoever lost the cell sees their gate missing from the canvas, which is
      // why the projection reports it rather than swallowing it.
      expect(
        ana.store.getState().circuit.operations.map((o) => o.gate)
      ).toHaveLength(2)
    })

    it('places the held-back gate when the blocker moves out of the way', () => {
      const ana = peer(new Y.Doc())
      ana.store.getState().placeGate('h', [0], 0)
      const beto = peer(forkOf(ana.bridge.doc))
      ana.store.getState().placeGate('x', [1], 1)
      beto.store.getState().placeGate('z', [1], 1)
      ana.bridge.receive(beto.bridge.state())
      beto.bridge.receive(ana.bridge.state())
      const held = ana.bridge.projection().deferred[0]?.operation
      const blocker = ana.bridge.projection().deferred[0]?.blockedBy[0]

      // An ordinary edit resolves it, and the gate that had been waiting in the
      // document appears without anybody re-sending anything.
      ana.store.getState().moveOperation(blocker!, [1], 4)

      expect(ana.bridge.projection().deferred).toEqual([])
      expect(
        ana.store.getState().circuit.operations.map((o) => o.gate)
      ).toContain(held!.gate)
      expect(ana.store.getState().circuit.operations).toHaveLength(3)
    })
  })

  it('agrees with the document about what an unnamed wire is called', () => {
    // Two definitions of the same convention, in the one place that may import
    // both. A disagreement here would be two peers drawing different row
    // headers for the same document.
    for (const index of [0, 1, 7, 27]) {
      expect(documentLabel(index)).toBe(defaultQubitLabel(index))
    }
  })
})
