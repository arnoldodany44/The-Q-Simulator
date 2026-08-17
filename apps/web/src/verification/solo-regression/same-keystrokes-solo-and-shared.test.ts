/**
 * The parity sweep: one person, the same commands, with and without a session.
 *
 * `undoOwnershipSolo.test.ts` asks this of three gestures. This asks it of the
 * commands that are *not* gate placements — the register edits, the labels, the
 * clipboard, the custom-gate detour, the gap closing — because those are the ones
 * whose document representation is not a slot in `operations`, and therefore the
 * ones where a `Y.UndoManager` step and a zundo snapshot are most likely to
 * disagree.
 *
 * Each case runs the identical sequence against two stores: one with nothing
 * attached (the editor that shipped) and one bridged to a joined session with
 * nobody else in it. Both are then described the same way, and the two
 * descriptions must be equal. What is compared is what a person can see: the
 * gates and where they are, the register, the wire names, the definitions, the
 * selection, and what each press of undo reported.
 */

import { parseCircuit, type Circuit } from '@qsim/schema'
import { describe, expect, it } from 'vitest'

import {
  createCircuitStore,
  type CircuitStore,
} from '../../features/circuit-editor/useCircuitStore'
import {
  cells,
  connect,
  joinedFrame,
  relayDocument,
  soloEditor,
} from './session'

/** Three wires, three gates, one of them parametrised and one two-qubit. */
function startingCircuit(): Circuit {
  return parseCircuit({
    schemaVersion: 1,
    qubits: 3,
    clbits: 0,
    operations: [
      { id: 'op_1', gate: 'h', targets: [0], column: 0 },
      { id: 'op_2', gate: 'cx', targets: [1], controls: [0], column: 1 },
      { id: 'op_3', gate: 'rz', targets: [2], column: 0, params: [0.5] },
    ],
  })
}

/** Everything about the document a person can see. */
function describeStore(store: CircuitStore): unknown {
  const state = store.getState()
  const circuit = state.circuit
  return {
    cells: cells(circuit),
    qubits: circuit.qubits,
    clbits: circuit.clbits,
    labels: circuit.qubitLabels ?? null,
    definitions: Object.keys(circuit.customGates ?? {}).sort(),
    selection: [...state.selection].sort(),
    params: circuit.operations
      .map((operation) => `${operation.id}:${String(operation.params ?? '')}`)
      .sort(),
  }
}

/** A run of one command sequence: what it did, and what undo gave back. */
function walk(
  store: CircuitStore,
  run: (store: CircuitStore) => void
): unknown {
  run(store)
  const after = describeStore(store)
  const presses: unknown[] = []
  for (let press = 0; press < 4; press += 1) {
    const result = store.getState().undo()
    presses.push({ ok: result.ok, state: describeStore(store) })
  }
  const redone: unknown[] = []
  for (let press = 0; press < 4; press += 1) {
    const result = store.getState().redo()
    redone.push({ ok: result.ok, state: describeStore(store) })
  }
  return { after, presses, redone }
}

/** The shipped editor: a store with no session anywhere near it. */
function soloRun(run: (store: CircuitStore) => void): unknown {
  const store = createCircuitStore()
  store.getState().loadCircuit(startingCircuit())
  return walk(store, run)
}

/**
 * The same commands inside a joined session with one person in it.
 *
 * The relay serves a document built from the same circuit, which is what it does
 * when the session row and the head version agree — the ordinary first join.
 */
async function sharedRun(run: (store: CircuitStore) => void): Promise<unknown> {
  const circuit = startingCircuit()
  const solo = soloEditor(circuit)
  await connect(solo)
  solo.socket().deliver(joinedFrame(relayDocument(circuit)))
  expect(solo.snapshot().status).toBe('open')
  expect(solo.snapshot().access).toBe('write')
  // The join must not have changed the document before the sequence starts.
  expect(cells(solo.store.getState().circuit)).toEqual(cells(circuit))
  return walk(solo.store, run)
}

const CASES: Readonly<Record<string, (store: CircuitStore) => void>> = {
  'insert a qubit in the middle': (store) => {
    store.getState().addQubit(1)
  },
  'remove a wire that carries a gate': (store) => {
    store.getState().removeQubit(0)
  },
  'reorder the wires': (store) => {
    store.getState().reorderQubits([2, 0, 1])
  },
  'name a wire': (store) => {
    store.getState().setQubitLabel(0, 'control')
  },
  'add and remove a classical bit': (store) => {
    store.getState().addClbit()
    store.getState().addClbit()
    store.getState().removeClbit(1)
  },
  'copy and paste a fragment': (store) => {
    store.getState().setSelection(['op_1', 'op_2'])
    store.getState().copy()
    store.getState().paste(0, 4)
  },
  'close the gaps': (store) => {
    store.getState().removeOperation('op_1')
    store.getState().compactColumns()
  },
  'package a selection into a custom gate': (store) => {
    store.getState().setSelection(['op_1', 'op_2'])
    store.getState().packageSelection('bell')
  },
  /*
   * The definition detour, which the store treats as a different document and
   * deliberately drives with zundo even while a session is attached — see
   * `resetDocumentHistory`. Both directions, because the way back is what
   * publishes anything.
   */
  'edit a definition and apply it': (store) => {
    store.getState().setSelection(['op_1', 'op_2'])
    store.getState().packageSelection('bell')
    store.getState().openDefinition('bell')
    store.getState().placeGate('z', [0], 3)
    store.getState().applyDefinition()
  },
  'edit a definition and cancel it': (store) => {
    store.getState().setSelection(['op_1', 'op_2'])
    store.getState().packageSelection('bell')
    store.getState().openDefinition('bell')
    store.getState().placeGate('z', [0], 3)
    store.getState().cancelDefinition()
  },
  'a parameter, then a gesture that ends elsewhere': (store) => {
    store.getState().setParam('op_3', 0, 1)
    store.getState().beginTransaction()
    store.getState().setParam('op_3', 0, 2)
    store.getState().setParam('op_3', 0, 3)
    store.getState().endTransaction()
  },
}

describe('the same commands, solo and in a session of one', () => {
  for (const [name, run] of Object.entries(CASES)) {
    it(name, async () => {
      expect(await sharedRun(run)).toEqual(soloRun(run))
    })
  }
})
