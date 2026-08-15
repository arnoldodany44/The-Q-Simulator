import {
  MAX_QUBITS,
  emptyCircuit,
  gateCount,
  qubitsOf,
  validateCircuit,
  type Circuit,
  type CircuitInput,
  type ValidationCode,
} from '@qsim/schema'
import { describe, expect, it } from 'vitest'

import enEditor from '../../i18n/locales/en/editor.json'
import esEditor from '../../i18n/locales/es/editor.json'
import frEditor from '../../i18n/locales/fr/editor.json'
import { draftOf, moveTo } from './placement'
import {
  REJECTION_REASONS,
  createCircuitStore,
  defaultQubitLabel,
  operationAt,
  selectedOperations,
  type CircuitStore,
  type EditResult,
  type RejectionReason,
} from './useCircuitStore'

function storeOf(qubits = 4, clbits = 2): CircuitStore {
  return createCircuitStore(emptyCircuit(qubits, clbits))
}

/** The invariant every test leans on: the store never holds a bad circuit. */
function expectValid(store: CircuitStore): void {
  expect(validateCircuit(store.getState().circuit)).toEqual([])
}

function historyDepth(store: CircuitStore): number {
  return store.temporal.getState().pastStates.length
}

function futureDepth(store: CircuitStore): number {
  return store.temporal.getState().futureStates.length
}

/**
 * Undo travels with the selection it was recorded with, so a restored
 * selection must never name an operation the restored circuit does not have.
 */
function expectSelectionIsLive(store: CircuitStore): void {
  const { circuit, selection } = store.getState()
  const ids = new Set(circuit.operations.map((operation) => operation.id))
  expect(selection.filter((id) => !ids.has(id))).toEqual([])
}

function reasonOf(result: EditResult): RejectionReason | 'ok' {
  return result.ok ? 'ok' : result.reason
}

/**
 * The invariant the contract does not check: at most one operation per
 * column writes any given classical bit.
 *
 * A column is one instant (§6) and the runner takes a column's operations in
 * whatever order the array happens to hold them, so two writers on one bit
 * have no defined answer — the same circuit would report a different result
 * depending on which of the two the array listed last.
 */
function expectOneWriterPerClassicalBit(store: CircuitStore): void {
  const perColumn = new Map<number, Set<number>>()
  for (const operation of store.getState().circuit.operations) {
    const written = perColumn.get(operation.column) ?? new Set<number>()
    for (const clbit of operation.clbitTargets ?? []) {
      expect(
        written.has(clbit),
        `column ${operation.column} has two writers of c${clbit}`
      ).toBe(false)
      written.add(clbit)
    }
    perColumn.set(operation.column, written)
  }
}

describe('placing gates', () => {
  it('places a gate, selects it and reports its id', () => {
    const store = storeOf()
    const result = store.getState().placeGate('h', [0], 0)

    expect(result).toEqual({ ok: true, ids: ['op_1'] })
    expect(store.getState().circuit.operations).toEqual([
      { id: 'op_1', gate: 'h', targets: [0], column: 0 },
    ])
    expect(store.getState().selection).toEqual(['op_1'])
    expectValid(store)
  })

  it('builds a Bell circuit out of two placements', () => {
    const store = storeOf(2, 0)
    store.getState().placeGate('h', [0], 0)
    store.getState().placeGate('cx', [1], 1, { controls: [0] })

    expect(store.getState().circuit).toEqual({
      schemaVersion: 1,
      qubits: 2,
      clbits: 0,
      operations: [
        { id: 'op_1', gate: 'h', targets: [0], column: 0 },
        { id: 'op_2', gate: 'cx', targets: [1], column: 1, controls: [0] },
      ],
    })
    expectValid(store)
  })

  it('gives a parametrised gate zero angles when none are supplied', () => {
    const store = storeOf()
    store.getState().placeGate('u', [0], 0)

    expect(store.getState().circuit.operations[0]?.params).toEqual([0, 0, 0])
    expectValid(store)
  })

  it('refuses a gate that needs a control it was not given', () => {
    const store = storeOf()
    const result = store.getState().placeGate('cx', [0], 0)

    expect(reasonOf(result)).toBe('control-count-mismatch')
    expect(store.getState().circuit.operations).toEqual([])
  })

  it('refuses a gate whose arity does not match its targets', () => {
    const store = storeOf()
    expect(reasonOf(store.getState().placeGate('h', [0, 1], 0))).toBe(
      'arity-mismatch'
    )
  })

  it('refuses a gate the catalog does not know', () => {
    const store = storeOf()
    expect(reasonOf(store.getState().placeGate('flip', [0], 0))).toBe(
      'unknown-gate'
    )
  })

  it('refuses a qubit outside the register', () => {
    const store = storeOf(2, 0)
    expect(reasonOf(store.getState().placeGate('h', [7], 0))).toBe(
      'qubit-out-of-range'
    )
  })
})

describe('a refused placement', () => {
  it('leaves the circuit and the history untouched', () => {
    const store = storeOf()
    store.getState().placeGate('h', [0], 0)

    const before = store.getState().circuit
    const historyBefore = historyDepth(store)

    // The control wire of a CNOT crosses q0, which the H already holds.
    const refused = store.getState().placeGate('cx', [1], 0, { controls: [0] })

    expect(reasonOf(refused)).toBe('column-conflict')
    // Identity, not equality: nothing was rebuilt, so nothing re-renders.
    expect(store.getState().circuit).toBe(before)
    expect(historyDepth(store)).toBe(historyBefore)

    // And the undo step the user has left is their last real edit.
    store.getState().undo()
    expect(store.getState().circuit.operations).toEqual([])
  })

  it('does not consume the redo stack either', () => {
    const store = storeOf()
    store.getState().placeGate('h', [0], 0)
    store.getState().undo()

    store.getState().placeGate('h', [9], 0)
    store.getState().redo()

    expect(store.getState().circuit.operations).toHaveLength(1)
  })
})

describe('moving and removing', () => {
  it('moves an operation to a free cell', () => {
    const store = storeOf()
    store.getState().placeGate('h', [0], 0)
    const result = store.getState().moveOperation('op_1', [2], 3)

    expect(result).toEqual({ ok: true, ids: ['op_1'] })
    expect(store.getState().circuit.operations[0]).toEqual({
      id: 'op_1',
      gate: 'h',
      targets: [2],
      column: 3,
    })
    expectValid(store)
  })

  it('refuses a move onto an occupied cell', () => {
    const store = storeOf()
    store.getState().placeGate('h', [0], 0)
    store.getState().placeGate('x', [1], 0)

    const before = store.getState().circuit
    expect(reasonOf(store.getState().moveOperation('op_2', [0], 0))).toBe(
      'column-conflict'
    )
    expect(store.getState().circuit).toBe(before)
  })

  it('carries the controls the caller hands it', () => {
    const store = storeOf()
    store.getState().placeGate('cx', [1], 0, { controls: [0] })
    store.getState().moveOperation('op_1', [2], 0, { controls: [1] })

    expect(store.getState().circuit.operations[0]).toMatchObject({
      targets: [2],
      controls: [1],
    })
    expectValid(store)
  })

  it('treats a move that lands where it started as no edit at all', () => {
    const store = storeOf()
    store.getState().placeGate('h', [0], 0)
    const depth = historyDepth(store)

    expect(store.getState().moveOperation('op_1', [0], 0).ok).toBe(true)
    expect(historyDepth(store)).toBe(depth)
  })

  it('removes an operation and drops it from the selection', () => {
    const store = storeOf()
    store.getState().placeGate('h', [0], 0)
    store.getState().placeGate('x', [1], 0)
    store.getState().setSelection(['op_1', 'op_2'])

    store.getState().removeOperation('op_1')

    expect(store.getState().circuit.operations).toHaveLength(1)
    expect(store.getState().selection).toEqual(['op_2'])
    expectValid(store)
  })

  it('refuses to remove an operation that is not there', () => {
    const store = storeOf()
    expect(reasonOf(store.getState().removeOperation('op_9'))).toBe(
      'operation-not-found'
    )
  })

  it('leaves the gap a deletion opens until asked to compact', () => {
    const store = storeOf()
    store.getState().placeGate('h', [0], 0)
    store.getState().placeGate('x', [0], 1)
    store.getState().placeGate('z', [0], 2)
    store.getState().removeOperation('op_2')

    expect(store.getState().circuit.operations.map((op) => op.column)).toEqual([
      0, 2,
    ])

    store.getState().compactColumns()
    expect(store.getState().circuit.operations.map((op) => op.column)).toEqual([
      0, 1,
    ])
    expectValid(store)
  })
})

describe('controls', () => {
  it('adds a positive control as a bare qubit index', () => {
    const store = storeOf()
    store.getState().placeGate('h', [0], 0)
    store.getState().addControl('op_1', 2)

    expect(store.getState().circuit.operations[0]?.controls).toEqual([2])
    expectValid(store)
  })

  it('adds a negative control in its explicit form', () => {
    const store = storeOf()
    store.getState().placeGate('h', [0], 0)
    store.getState().addControl('op_1', 2, 0)

    expect(store.getState().circuit.operations[0]?.controls).toEqual([
      { qubit: 2, state: 0 },
    ])
    expectValid(store)
  })

  it('refuses a control on a gate the catalog does not let you control', () => {
    const store = storeOf()
    store.getState().placeGate('swap', [0, 1], 0)

    expect(reasonOf(store.getState().addControl('op_1', 2))).toBe(
      'control-count-mismatch'
    )
    expect(store.getState().circuit.operations[0]?.controls).toBeUndefined()
  })

  it('refuses a control on a qubit the gate already acts on', () => {
    const store = storeOf()
    store.getState().placeGate('h', [0], 0)

    expect(reasonOf(store.getState().addControl('op_1', 0))).toBe(
      'target-control-overlap'
    )
  })

  it('refuses a control on a qubit another gate holds in that column', () => {
    const store = storeOf()
    store.getState().placeGate('h', [0], 0)
    store.getState().placeGate('x', [1], 0)

    expect(reasonOf(store.getState().addControl('op_1', 1))).toBe(
      'column-conflict'
    )
  })

  it('removes a control, whichever spelling it was stored in', () => {
    const store = storeOf()
    store.getState().placeGate('h', [0], 0)
    store.getState().addControl('op_1', 1)
    store.getState().addControl('op_1', 2, 0)

    store.getState().removeControl('op_1', 2)
    expect(store.getState().circuit.operations[0]?.controls).toEqual([1])

    store.getState().removeControl('op_1', 1)
    expect(store.getState().circuit.operations[0]?.controls).toBeUndefined()
    expectValid(store)
  })

  it('refuses to remove a control that is not there', () => {
    const store = storeOf()
    store.getState().placeGate('h', [0], 0)
    expect(reasonOf(store.getState().removeControl('op_1', 3))).toBe(
      'control-not-found'
    )
  })

  it('refuses to strip the control a CNOT is defined by', () => {
    const store = storeOf()
    store.getState().placeGate('cx', [1], 0, { controls: [0] })

    expect(reasonOf(store.getState().removeControl('op_1', 0))).toBe(
      'control-count-mismatch'
    )
    expectValid(store)
  })
})

describe('parameters', () => {
  it('sets an angle by position', () => {
    const store = storeOf()
    store.getState().placeGate('u', [0], 0)
    store.getState().setParam('op_1', 1, Math.PI / 2)

    expect(store.getState().circuit.operations[0]?.params).toEqual([
      0,
      Math.PI / 2,
      0,
    ])
    expectValid(store)
  })

  it('accepts a symbolic parameter the circuit declares', () => {
    const store = storeOf()
    store.getState().loadCircuit({
      schemaVersion: 1,
      qubits: 2,
      parameters: [{ name: 'theta', value: 0.5 }],
      operations: [
        { id: 'op_1', gate: 'rz', targets: [0], params: [0], column: 0 },
      ],
    } satisfies CircuitInput)

    expect(store.getState().setParam('op_1', 0, 'theta').ok).toBe(true)
    expect(reasonOf(store.getState().setParam('op_1', 0, 'phi'))).toBe(
      'unknown-parameter'
    )
    expectValid(store)
  })

  it('refuses an index the gate does not have', () => {
    const store = storeOf()
    store.getState().placeGate('rz', [0], 0)

    expect(reasonOf(store.getState().setParam('op_1', 2, 1))).toBe(
      'param-count-mismatch'
    )
    expect(reasonOf(store.getState().setParam('op_9', 0, 1))).toBe(
      'operation-not-found'
    )
  })

  it('does not spend an undo step on a slider that came back home', () => {
    const store = storeOf()
    store.getState().placeGate('rz', [0], 0)
    store.getState().setParam('op_1', 0, 1)
    const depth = historyDepth(store)

    expect(store.getState().setParam('op_1', 0, 1).ok).toBe(true)
    expect(historyDepth(store)).toBe(depth)
  })
})

/*
 * A gesture is one history step.
 *
 * A slider drag commits every value it passes through — the analysis panel
 * has to follow the drag, that is what the control is for — but a user who
 * turns an angle once and presses undo once expects the angle back, not the
 * forty-ninth intermediate value. Untreated, one drag also evicted most of
 * a hundred-step history, taking every real edit with it.
 */
describe('a continuous gesture', () => {
  /** The angles a drag from 0 to about π/2 passes through. */
  const DRAG = Array.from({ length: 12 }, (_, step) => (step + 1) / 8)

  function drag(store: CircuitStore, values: readonly number[]): void {
    store.getState().beginTransaction()
    for (const value of values) store.getState().setParam('op_1', 0, value)
    store.getState().endTransaction()
  }

  function rotationStore(): CircuitStore {
    const store = storeOf(2, 0)
    store.getState().placeGate('rz', [0], 0)
    store.getState().clearHistory()
    return store
  }

  it('records one step for a drag of twelve values', () => {
    const store = rotationStore()

    drag(store, DRAG)

    expect(historyDepth(store)).toBe(1)
    expect(store.getState().circuit.operations[0]?.params).toEqual([1.5])
  })

  it('applies every value as it arrives, without waiting for the end', () => {
    const store = rotationStore()
    const seen: unknown[] = []

    store.getState().beginTransaction()
    for (const value of DRAG) {
      store.getState().setParam('op_1', 0, value)
      seen.push(store.getState().circuit.operations[0]?.params?.[0])
    }
    store.getState().endTransaction()

    expect(seen).toEqual(DRAG)
  })

  it('comes back to the angle from before the drag in one undo', () => {
    const store = rotationStore()
    store.getState().setParam('op_1', 0, 0.25)
    const before = store.getState().circuit

    drag(store, DRAG)
    store.getState().undo()

    expect(store.getState().circuit).toEqual(before)
    // And the whole drag is one redo away, not twelve.
    store.getState().redo()
    expect(store.getState().circuit.operations[0]?.params).toEqual([1.5])
  })

  it('costs nothing at all when the drag ends where it started', () => {
    const store = rotationStore()
    store.getState().setParam('op_1', 0, 0.25)
    const before = store.getState().circuit
    const depth = historyDepth(store)

    drag(store, [...DRAG, 0.25])

    expect(historyDepth(store)).toBe(depth)
    // Down to the object identity, so nothing downstream recomputes either.
    expect(store.getState().circuit).toBe(before)
  })

  it('leaves the redo branch alone when the drag ends where it started', () => {
    const store = rotationStore()
    store.getState().setParam('op_1', 0, 0.25)
    store.getState().undo()
    expect(futureDepth(store)).toBe(1)

    drag(store, [0.5, 0])

    expect(futureDepth(store)).toBe(1)
    store.getState().redo()
    expect(store.getState().circuit.operations[0]?.params).toEqual([0.25])
  })

  it('gives each of five separate gestures its own step', () => {
    const store = rotationStore()

    for (let gesture = 1; gesture <= 5; gesture++) {
      drag(store, [gesture / 10, gesture / 5])
    }

    expect(historyDepth(store)).toBe(5)
    for (let gesture = 5; gesture >= 1; gesture--) {
      expect(store.getState().circuit.operations[0]?.params).toEqual([
        gesture / 5,
      ])
      store.getState().undo()
    }
  })

  it('spends no history on a hundred drags, where it once spent all of it', () => {
    const store = storeOf(2, 0)
    store.getState().placeGate('rz', [0], 0)
    store.getState().placeGate('h', [1], 0)
    const anchor = store.getState().circuit

    for (let gesture = 0; gesture < 20; gesture++) {
      drag(
        store,
        DRAG.map((value) => value + gesture)
      )
    }
    for (let gesture = 0; gesture < 20; gesture++) store.getState().undo()

    // The two placements are still reachable: 20 gestures cost 20 steps, not
    // 240, so they never came near the 100-step ceiling.
    expect(store.getState().circuit).toEqual(anchor)
    expectValid(store)
  })

  it('ignores a second begin, so one end really ends the gesture', () => {
    const store = rotationStore()

    store.getState().beginTransaction()
    store.getState().setParam('op_1', 0, 0.5)
    store.getState().beginTransaction()
    store.getState().setParam('op_1', 0, 1)
    store.getState().endTransaction()

    expect(historyDepth(store)).toBe(1)
    // History is running again: the next edit is its own step.
    store.getState().setParam('op_1', 0, 2)
    expect(historyDepth(store)).toBe(2)
  })

  it('ignores an end with no gesture open', () => {
    const store = rotationStore()
    store.getState().endTransaction()
    store.getState().setParam('op_1', 0, 1)

    expect(historyDepth(store)).toBe(1)
  })

  it('records nothing for a gesture that never changed anything', () => {
    const store = rotationStore()
    store.getState().beginTransaction()
    store.getState().endTransaction()

    store.getState().setParam('op_1', 0, 1)
    expect(historyDepth(store)).toBe(1)
  })

  it('keeps recording when the first commit of a gesture is a no-op', () => {
    const store = rotationStore()
    store.getState().setParam('op_1', 0, 0.5)
    const depth = historyDepth(store)

    store.getState().beginTransaction()
    // A refused edit and a no-op edit both leave the circuit alone; neither
    // may be mistaken for the gesture's one recorded change.
    store.getState().setParam('op_1', 0, 0.5)
    store.getState().setParam('op_9', 0, 1)
    store.getState().setParam('op_1', 0, 1)
    store.getState().endTransaction()

    expect(historyDepth(store)).toBe(depth + 1)
    store.getState().undo()
    expect(store.getState().circuit.operations[0]?.params).toEqual([0.5])
  })

  it('does not leave history paused when a document arrives mid-gesture', () => {
    const store = rotationStore()
    store.getState().beginTransaction()
    store.getState().setParam('op_1', 0, 1)

    store.getState().loadCircuit(emptyCircuit(2, 0))
    store.getState().placeGate('x', [0], 0)

    expect(historyDepth(store)).toBe(1)
  })

  /*
   * Any gesture, not just a slider: the qubit-reorder drag M0.7 adds has the
   * same shape, and the pair has to be the store's own idea rather than the
   * parameter editor's private arrangement.
   */
  it('groups a register gesture the same way', () => {
    const store = storeOf(4, 0)
    store.getState().placeGate('h', [0], 0)
    const before = store.getState().circuit

    store.getState().beginTransaction()
    store.getState().reorderQubits([1, 0, 2, 3])
    store.getState().reorderQubits([0, 2, 1, 3])
    store.getState().reorderQubits([3, 1, 2, 0])
    store.getState().endTransaction()

    store.getState().undo()
    expect(store.getState().circuit).toEqual(before)
  })
})

describe('the quantum register', () => {
  it('appends a qubit', () => {
    const store = storeOf(2, 0)
    store.getState().addQubit()
    expect(store.getState().circuit.qubits).toBe(3)
    expectValid(store)
  })

  it('inserting a qubit shifts the wires above it', () => {
    const store = storeOf(3, 0)
    store.getState().placeGate('cx', [2], 0, { controls: [0] })
    store.getState().addQubit(1)

    expect(store.getState().circuit.qubits).toBe(4)
    expect(store.getState().circuit.operations[0]).toMatchObject({
      targets: [3],
      controls: [0],
    })
    expectValid(store)
  })

  it('removing a qubit takes what stood on it and renumbers the rest', () => {
    const store = storeOf()
    store.getState().loadCircuit({
      schemaVersion: 1,
      qubits: 4,
      clbits: 1,
      qubitLabels: ['alice', 'bob', 'carol', 'dave'],
      operations: [
        { id: 'op_1', gate: 'h', targets: [0], column: 0 },
        { id: 'op_2', gate: 'h', targets: [1], column: 0 },
        { id: 'op_3', gate: 'cx', targets: [2], controls: [0], column: 1 },
        { id: 'op_4', gate: 'swap', targets: [2, 3], column: 2 },
        {
          id: 'op_5',
          gate: 'measure',
          targets: [3],
          clbitTargets: [0],
          column: 3,
        },
        { id: 'op_6', gate: 'barrier', targets: [0, 1, 2], column: 4 },
      ],
    } satisfies CircuitInput)
    store.getState().setSelection(['op_1', 'op_2'])

    expect(store.getState().removeQubit(1).ok).toBe(true)

    // op_2 sat on the deleted wire and op_6 crossed it, so both are gone;
    // everything above q1 moved down one.
    expect(store.getState().circuit).toEqual({
      schemaVersion: 1,
      qubits: 3,
      clbits: 1,
      qubitLabels: ['alice', 'carol', 'dave'],
      operations: [
        { id: 'op_1', gate: 'h', targets: [0], column: 0 },
        { id: 'op_3', gate: 'cx', targets: [1], controls: [0], column: 1 },
        { id: 'op_4', gate: 'swap', targets: [1, 2], column: 2 },
        {
          id: 'op_5',
          gate: 'measure',
          targets: [2],
          clbitTargets: [0],
          column: 3,
        },
      ],
    } satisfies Circuit)
    expect(store.getState().selection).toEqual(['op_1'])
    expectValid(store)
  })

  it('refuses to remove the last qubit or one that does not exist', () => {
    const store = storeOf(1, 0)
    expect(reasonOf(store.getState().removeQubit(0))).toBe('register-limit')

    const wider = storeOf(2, 0)
    expect(reasonOf(wider.getState().removeQubit(5))).toBe('qubit-out-of-range')
  })

  it('refuses to grow past what the format can hold', () => {
    const store = createCircuitStore(emptyCircuit(MAX_QUBITS))
    expect(reasonOf(store.getState().addQubit())).toBe('register-limit')
  })

  it('reorders wires, dragging their gates and names with them', () => {
    const store = storeOf(3, 0)
    store.getState().setQubitLabel(0, 'alice')
    store.getState().placeGate('cx', [2], 0, { controls: [0] })

    // dnd-kit hands over the old indices in their new order.
    expect(store.getState().reorderQubits([2, 0, 1]).ok).toBe(true)

    expect(store.getState().circuit.operations[0]).toMatchObject({
      targets: [0],
      controls: [1],
    })
    expect(store.getState().circuit.qubitLabels).toEqual([
      defaultQubitLabel(2),
      'alice',
      defaultQubitLabel(1),
    ])
    expectValid(store)
  })

  it('refuses an order that is not a permutation, and skips the identity', () => {
    const store = storeOf(3, 0)
    expect(reasonOf(store.getState().reorderQubits([0, 1]))).toBe(
      'qubit-out-of-range'
    )
    expect(reasonOf(store.getState().reorderQubits([0, 1, 1]))).toBe(
      'repeated-qubit'
    )

    const depth = historyDepth(store)
    expect(store.getState().reorderQubits([0, 1, 2]).ok).toBe(true)
    expect(historyDepth(store)).toBe(depth)
  })

  it('naming one wire names them all, because the contract asks for that', () => {
    const store = storeOf(3, 0)
    store.getState().setQubitLabel(1, 'ancilla')

    expect(store.getState().circuit.qubitLabels).toEqual([
      defaultQubitLabel(0),
      'ancilla',
      defaultQubitLabel(2),
    ])
    expect(reasonOf(store.getState().setQubitLabel(1, ''))).toBe('shape')
    expect(reasonOf(store.getState().setQubitLabel(7, 'x'))).toBe(
      'qubit-out-of-range'
    )
    expectValid(store)
  })

  /*
   * The new wire is named after the register size so it cannot collide with
   * the wire it pushed aside — but a user who has already renamed some wire
   * to that name defeats that alone, and two wires called `q3` is ambiguous
   * everywhere a wire is named by its label. The contract does not notice:
   * it counts labels and never compares them.
   */
  it('never gives the new wire a name another wire already answers to', () => {
    const store = storeOf(3, 0)
    store.getState().setQubitLabel(0, defaultQubitLabel(3))

    store.getState().addQubit(0)

    const labels = store.getState().circuit.qubitLabels ?? []
    expect(new Set(labels).size).toBe(labels.length)
    expect(labels).toEqual([
      defaultQubitLabel(4),
      defaultQubitLabel(3),
      defaultQubitLabel(1),
      defaultQubitLabel(2),
    ])
    expectValid(store)
  })

  it('still takes the obvious name when nothing is in the way', () => {
    const store = storeOf(3, 0)
    store.getState().setQubitLabel(1, 'ancilla')

    store.getState().addQubit(0)

    expect(store.getState().circuit.qubitLabels?.[0]).toBe(defaultQubitLabel(3))
    expectValid(store)
  })
})

describe('the classical register', () => {
  it('adds a classical bit', () => {
    const store = storeOf(2, 0)
    store.getState().addClbit()
    expect(store.getState().circuit.clbits).toBe(1)
    expectValid(store)
  })

  it('removing a classical bit cascades like removing a qubit', () => {
    const store = storeOf(2, 2)
    store.getState().placeGate('measure', [0], 0, { clbitTargets: [0] })
    store.getState().placeGate('measure', [1], 0, { clbitTargets: [1] })
    store.getState().placeGate('x', [0], 1, {
      condition: { clbit: 1, equals: 1 },
    })

    expect(store.getState().removeClbit(0).ok).toBe(true)

    expect(store.getState().circuit.clbits).toBe(1)
    expect(store.getState().circuit.operations).toEqual([
      {
        id: 'op_2',
        gate: 'measure',
        targets: [1],
        clbitTargets: [0],
        column: 0,
      },
      {
        id: 'op_3',
        gate: 'x',
        targets: [0],
        column: 1,
        condition: { clbit: 0, equals: 1 },
      },
    ])
    expectValid(store)
  })

  it('refuses to remove a classical bit that is not there', () => {
    const store = storeOf(2, 0)
    expect(reasonOf(store.getState().removeClbit(0))).toBe('register-limit')
    const withBits = storeOf(2, 1)
    expect(reasonOf(withBits.getState().removeClbit(4))).toBe(
      'clbit-out-of-range'
    )
  })

  /*
   * A wire whose classical bit does not exist can never be measured: the
   * measure chip is in the palette, the cell is empty, and the contract
   * refuses it forever. So a new wire brings its bit along while the two
   * registers are the same width.
   */
  it('grows with the quantum register while the two are in step', () => {
    const store = storeOf(3, 3)
    expect(store.getState().addQubit().ok).toBe(true)

    expect(store.getState().circuit.qubits).toBe(4)
    expect(store.getState().circuit.clbits).toBe(4)
    expect(
      store.getState().placeGate('measure', [3], 0, { clbitTargets: [3] }).ok
    ).toBe(true)
    expectValid(store)
  })

  it('leaves a register that is deliberately out of step alone', () => {
    // Wider on purpose: a loaded document keeps the register it declared.
    const wide = storeOf(2, 8)
    wide.getState().addQubit()
    expect(wide.getState().circuit.clbits).toBe(8)

    // Narrower on purpose: the user shrank it with the gutter control, and
    // adding a wire is not the place to overrule that.
    const narrow = storeOf(3, 3)
    narrow.getState().removeClbit(2)
    narrow.getState().addQubit()
    expect(narrow.getState().circuit).toMatchObject({ qubits: 4, clbits: 2 })
  })

  it('does not shrink when a wire is removed, then grows back in step', () => {
    const store = storeOf(3, 3)
    store.getState().removeQubit(2)
    // Shrinking here would cascade a second time and delete measurements
    // belonging to the wires that stayed.
    expect(store.getState().circuit).toMatchObject({ qubits: 2, clbits: 3 })

    store.getState().addQubit()
    expect(store.getState().circuit).toMatchObject({ qubits: 3, clbits: 3 })
  })

  it('grows in the same history step as the wire, so one undo restores both', () => {
    const store = storeOf(3, 3)
    const depth = historyDepth(store)
    store.getState().addQubit()
    expect(historyDepth(store)).toBe(depth + 1)

    store.getState().undo()
    expect(store.getState().circuit).toMatchObject({ qubits: 3, clbits: 3 })
  })
})

describe('copy and paste', () => {
  function withFragment(): CircuitStore {
    const store = storeOf(4, 0)
    store.getState().placeGate('h', [0], 0)
    store.getState().placeGate('cx', [1], 1, { controls: [0] })
    store.getState().setSelection(['op_1', 'op_2'])
    store.getState().copy()
    return store
  }

  it('stores the fragment relative to its own corner', () => {
    const store = withFragment()
    expect(store.getState().clipboard).toEqual({
      qubits: 2,
      columns: 2,
      // Kept so `paste` can tell how far the fragment travelled, which is
      // how far its classical writes have to travel with it.
      originQubit: 0,
      operations: [
        { id: 'op_1', gate: 'h', targets: [0], column: 0 },
        { id: 'op_2', gate: 'cx', targets: [1], controls: [0], column: 1 },
      ],
    })
  })

  it('copying is not an edit, so it costs no undo step', () => {
    const store = storeOf(4, 0)
    store.getState().placeGate('h', [0], 0)
    store.getState().setSelection(['op_1'])
    const depth = historyDepth(store)

    expect(store.getState().copy().ok).toBe(true)
    expect(historyDepth(store)).toBe(depth)
  })

  it('pastes with fresh ids, never duplicates', () => {
    const store = withFragment()
    const before = store.getState().circuit.operations.map((op) => op.id)

    const first = store.getState().paste(2, 2)
    expect(first).toEqual({ ok: true, ids: ['op_3', 'op_4'] })

    const second = store.getState().paste(2, 4)
    expect(second).toEqual({ ok: true, ids: ['op_5', 'op_6'] })

    const ids = store.getState().circuit.operations.map((op) => op.id)
    expect(new Set(ids).size).toBe(ids.length)
    expect(ids.filter((id) => before.includes(id))).toEqual(before)

    // Translated by the anchor, and selected so it can be dragged on.
    expect(store.getState().circuit.operations.slice(2, 4)).toEqual([
      { id: 'op_3', gate: 'h', targets: [2], column: 2 },
      { id: 'op_4', gate: 'cx', targets: [3], controls: [2], column: 3 },
    ])
    expect(store.getState().selection).toEqual(['op_5', 'op_6'])
    expectValid(store)
  })

  it('refuses a paste that would collide or fall off the register', () => {
    const store = withFragment()
    const before = store.getState().circuit

    expect(reasonOf(store.getState().paste(0, 0))).toBe('column-conflict')
    expect(reasonOf(store.getState().paste(3, 6))).toBe('qubit-out-of-range')
    expect(store.getState().circuit).toBe(before)
  })

  it('refuses to copy nothing and to paste nothing', () => {
    const store = storeOf()
    expect(reasonOf(store.getState().copy())).toBe('empty-selection')
    expect(reasonOf(store.getState().paste(0, 0))).toBe('empty-clipboard')
  })

  it('carries a fragment across documents', () => {
    const store = withFragment()
    store.getState().loadCircuit(emptyCircuit(4))

    expect(store.getState().paste(0, 0).ok).toBe(true)
    expect(store.getState().circuit.operations).toHaveLength(2)
    expectValid(store)
  })

  /*
   * A classical write travels with the wire it reads. A measurement pasted
   * one wire down that kept its original bit would put two writers on that
   * bit in one column, and a column is one instant (§6): the engine takes
   * its operations in no defined order, so the circuit would have no defined
   * answer at all. The contract accepts that shape, which is exactly why the
   * editor has to refuse to build it.
   */
  function measuring(): CircuitStore {
    const store = storeOf(4, 4)
    store.getState().placeGate('measure', [0], 0, { clbitTargets: [0] })
    store.getState().setSelection(['op_1'])
    store.getState().copy()
    return store
  }

  it('translates a pasted measurement’s classical bit with its wire', () => {
    const store = measuring()
    expect(store.getState().paste(1, 0).ok).toBe(true)

    expect(store.getState().circuit.operations[1]).toMatchObject({
      targets: [1],
      clbitTargets: [1],
    })
    expectOneWriterPerClassicalBit(store)
    expectValid(store)
  })

  it('pastes an exact copy when the fragment does not change wires', () => {
    const store = measuring()
    expect(store.getState().paste(0, 2).ok).toBe(true)

    expect(store.getState().circuit.operations[1]).toMatchObject({
      targets: [0],
      column: 2,
      clbitTargets: [0],
    })
  })

  it('refuses a paste whose classical bit would leave the register', () => {
    const store = storeOf(4, 2)
    store.getState().placeGate('measure', [0], 0, { clbitTargets: [0] })
    store.getState().setSelection(['op_1'])
    store.getState().copy()
    const before = store.getState().circuit

    // q3 exists; c3 does not. The contract answers, and `commit` runs before
    // `set`, so the refusal is a true no-op.
    expect(reasonOf(store.getState().paste(3, 1))).toBe('clbit-out-of-range')
    expect(store.getState().circuit).toBe(before)
  })

  it('keeps a measurement and the gate it conditions wired together', () => {
    const store = storeOf(4, 4)
    store.getState().placeGate('measure', [0], 0, { clbitTargets: [0] })
    store.getState().placeGate('x', [0], 1, {
      condition: { clbit: 0, equals: 1 },
    })
    store.getState().setSelection(['op_1', 'op_2'])
    store.getState().copy()

    expect(store.getState().paste(1, 2).ok).toBe(true)
    expect(store.getState().circuit.operations.slice(2)).toEqual([
      {
        id: 'op_3',
        gate: 'measure',
        targets: [1],
        clbitTargets: [1],
        column: 2,
      },
      {
        id: 'op_4',
        gate: 'x',
        targets: [1],
        column: 3,
        condition: { clbit: 1, equals: 1 },
      },
    ])
    expectValid(store)
  })
})

describe('moving a measurement', () => {
  it('takes its classical write to the wire it landed on', () => {
    const store = storeOf(4, 4)
    store.getState().placeGate('measure', [0], 0, { clbitTargets: [0] })

    expect(
      store.getState().moveOperation('op_1', [1], 0, { clbitTargets: [1] }).ok
    ).toBe(true)
    expect(store.getState().circuit.operations[0]).toMatchObject({
      targets: [1],
      clbitTargets: [1],
    })
    expectValid(store)
  })

  it('leaves the condition of a gate dragged across wires pointing where it did', () => {
    const store = storeOf(4, 4)
    store.getState().placeGate('measure', [0], 0, { clbitTargets: [0] })
    store.getState().placeGate('x', [1], 1, {
      condition: { clbit: 0, equals: 1 },
    })

    expect(store.getState().moveOperation('op_2', [2], 1).ok).toBe(true)
    // A move relocates one operation inside a circuit whose measurements
    // stay put, so repointing a classical *read* would be an edit the user
    // never asked for.
    expect(store.getState().circuit.operations[1]).toMatchObject({
      targets: [2],
      condition: { clbit: 0, equals: 1 },
    })
  })

  it('refuses a move whose classical bit would leave the register', () => {
    const store = storeOf(4, 2)
    store.getState().placeGate('measure', [0], 0, { clbitTargets: [0] })
    const before = store.getState().circuit

    expect(
      reasonOf(
        store.getState().moveOperation('op_1', [3], 0, { clbitTargets: [3] })
      )
    ).toBe('clbit-out-of-range')
    expect(store.getState().circuit).toBe(before)
  })

  it('is still not an edit when the drag lands where it started', () => {
    const store = storeOf(4, 4)
    store.getState().placeGate('measure', [0], 0, { clbitTargets: [0] })
    const before = store.getState().circuit
    const depth = historyDepth(store)

    expect(
      store.getState().moveOperation('op_1', [0], 0, { clbitTargets: [0] }).ok
    ).toBe(true)
    expect(store.getState().circuit).toBe(before)
    expect(historyDepth(store)).toBe(depth)
  })
})

describe('selection', () => {
  it('keeps ids in circuit order, deduplicated, and drops unknown ones', () => {
    const store = storeOf()
    store.getState().placeGate('h', [0], 0)
    store.getState().placeGate('x', [1], 0)
    store.getState().setSelection(['op_2', 'op_1', 'op_2', 'ghost'])

    expect(store.getState().selection).toEqual(['op_1', 'op_2'])
  })

  it('toggles one id at a time', () => {
    const store = storeOf()
    store.getState().placeGate('h', [0], 0)
    store.getState().toggleSelection('op_1')
    expect(store.getState().selection).toEqual([])

    store.getState().toggleSelection('op_1')
    expect(store.getState().selection).toEqual(['op_1'])

    store.getState().clearSelection()
    expect(store.getState().selection).toEqual([])
  })

  it('never enters the history', () => {
    const store = storeOf()
    store.getState().placeGate('h', [0], 0)
    const depth = historyDepth(store)

    store.getState().setSelection(['op_1'])
    store.getState().toggleSelection('op_1')
    store.getState().clearSelection()

    expect(historyDepth(store)).toBe(depth)
  })
})

describe('undo and redo', () => {
  it('round-trips 50 edits to identical circuits', () => {
    const store = storeOf(5, 1)
    const snapshots: Circuit[] = [store.getState().circuit]

    for (let step = 0; step < 50; step++) {
      const result = store
        .getState()
        .placeGate('h', [step % 5], Math.floor(step / 5))
      expect(result.ok).toBe(true)
      snapshots.push(store.getState().circuit)
    }

    for (let step = 50; step > 0; step--) {
      store.getState().undo()
      expect(store.getState().circuit).toEqual(snapshots[step - 1])
      expectValid(store)
    }

    for (let step = 1; step <= 50; step++) {
      store.getState().redo()
      expect(store.getState().circuit).toEqual(snapshots[step])
      expectValid(store)
    }
  })

  it('round-trips 50 mixed edits', () => {
    // Appending gates is the easy case. This one walks through moves,
    // parameter changes, controls, pastes, and wires appearing and
    // disappearing under the gates that stood on them.
    const random = mulberry32(7)
    const store = storeOf(4, 2)
    const snapshots: Circuit[] = [store.getState().circuit]

    for (let guard = 0; guard < 5000 && snapshots.length <= 50; guard++) {
      const before = store.getState().circuit
      randomEdit(store, random, { history: false })
      const after = store.getState().circuit
      if (after !== before) snapshots.push(after)
    }
    expect(snapshots).toHaveLength(51)

    for (let step = 50; step > 0; step--) {
      store.getState().undo()
      expect(store.getState().circuit, `undo to step ${step - 1}`).toEqual(
        snapshots[step - 1]
      )
      expectSelectionIsLive(store)
      expectValid(store)
    }

    for (let step = 1; step <= 50; step++) {
      store.getState().redo()
      expect(store.getState().circuit, `redo to step ${step}`).toEqual(
        snapshots[step]
      )
      expectSelectionIsLive(store)
      expectValid(store)
    }
  })

  it('restores the selection the edit was made with', () => {
    const store = storeOf()
    store.getState().placeGate('h', [0], 0)
    store.getState().placeGate('x', [1], 0)
    expect(store.getState().selection).toEqual(['op_2'])

    store.getState().undo()
    expect(store.getState().selection).toEqual(['op_1'])

    store.getState().redo()
    expect(store.getState().selection).toEqual(['op_2'])
  })

  it('undoes a cascading qubit removal in one step', () => {
    const store = storeOf(3, 0)
    store.getState().placeGate('h', [1], 0)
    store.getState().placeGate('cx', [2], 1, { controls: [1] })
    const before = store.getState().circuit

    store.getState().removeQubit(1)
    expect(store.getState().circuit.operations).toEqual([])

    store.getState().undo()
    expect(store.getState().circuit).toEqual(before)
  })

  it('does not rewind the id counter, so an id is never reused', () => {
    const store = storeOf()
    store.getState().placeGate('h', [0], 0)
    store.getState().undo()
    store.getState().placeGate('x', [0], 0)

    expect(store.getState().circuit.operations[0]?.id).toBe('op_2')
  })

  /*
   * Step counts below 1. zundo splices `(-steps, steps)` off its stack,
   * which is an empty slice for every one of these, and the `undefined`
   * that follows replaces the whole store — circuit, clipboard and actions
   * alike. Each call must instead be a true no-op, down to the history
   * stacks: zundo pushes onto `futureStates` before it notices the slice is
   * empty, so a guard placed after the delegation would still leave a
   * phantom redo step behind.
   */
  const UNUSABLE_STEPS: readonly (readonly [string, number])[] = [
    ['0', 0],
    ['-0', -0],
    ['0.5', 0.5],
    ['0.999', 0.999],
    ['-1', -1],
    ['-2', -2],
    ['NaN', NaN],
    ['-Infinity', -Infinity],
  ]

  for (const [label, steps] of UNUSABLE_STEPS) {
    it(`ignores undo(${label}) and redo(${label}) completely`, () => {
      const store = storeOf()
      store.getState().placeGate('h', [0], 0)
      store.getState().placeGate('x', [1], 1)
      store.getState().copy()
      // One step in each stack, so a call that consumed or manufactured a
      // step would show up on either side.
      store.getState().undo()

      const before = store.getState()
      const past = historyDepth(store)
      const future = futureDepth(store)

      before.undo(steps)
      before.redo(steps)

      const after = store.getState()
      expect(after).toBeDefined()
      expect(after.circuit).toBe(before.circuit)
      expect(after.selection).toBe(before.selection)
      expect(after.clipboard).toBe(before.clipboard)
      expect(after.nextId).toBe(before.nextId)
      expect(historyDepth(store)).toBe(past)
      expect(futureDepth(store)).toBe(future)

      // The actions themselves are part of the state zundo would have
      // wiped, so an editor holding this store must still be able to edit.
      expect(after.placeGate('z', [2], 2).ok).toBe(true)
    })
  }

  /*
   * Undo is the one command whose success and its failure leave exactly the
   * same canvas behind, so nothing downstream can work out which happened by
   * looking. The editor's live region speaks these two codes verbatim, and
   * they are the only thing that tells a user who cannot see the canvas that
   * their press did something.
   */
  it('reports whether a history move consumed a step', () => {
    const store = storeOf()
    expect(reasonOf(store.getState().undo())).toBe('nothing-to-undo')
    expect(reasonOf(store.getState().redo())).toBe('nothing-to-redo')

    store.getState().placeGate('h', [0], 0)
    expect(store.getState().undo().ok).toBe(true)
    expect(reasonOf(store.getState().undo())).toBe('nothing-to-undo')

    expect(store.getState().redo().ok).toBe(true)
    expect(reasonOf(store.getState().redo())).toBe('nothing-to-redo')
  })

  it('refuses a step count that consumes nothing rather than claiming success', () => {
    const store = storeOf()
    store.getState().placeGate('h', [0], 0)

    // A count below 1 moves the document no more than an empty stack does,
    // so it answers the same way: reporting success would have the editor
    // announce an undo that never happened.
    expect(reasonOf(store.getState().undo(0))).toBe('nothing-to-undo')
    expect(historyDepth(store)).toBe(1)
    expect(futureDepth(store)).toBe(0)
  })

  it('rewinds and replays exactly the number of steps it is given', () => {
    const store = storeOf()
    store.getState().placeGate('h', [0], 0)
    const afterFirst = store.getState().circuit
    store.getState().placeGate('x', [1], 0)
    store.getState().placeGate('z', [2], 0)

    store.getState().undo(2)
    expect(store.getState().circuit).toBe(afterFirst)

    store.getState().redo(2)
    expect(gateCount(store.getState().circuit)).toBe(3)
  })

  it('truncates a fractional count, so undo(1.5) undoes one step', () => {
    const store = storeOf()
    store.getState().placeGate('h', [0], 0)
    const afterFirst = store.getState().circuit
    store.getState().placeGate('x', [1], 0)

    store.getState().undo(1.5)
    expect(store.getState().circuit).toBe(afterFirst)
  })

  it('rewinds to the first snapshot when asked for more steps than exist', () => {
    for (const steps of [7, Infinity]) {
      const store = storeOf()
      const empty = store.getState().circuit
      store.getState().placeGate('h', [0], 0)
      store.getState().placeGate('x', [1], 0)

      store.getState().undo(steps)
      expect(store.getState().circuit, `undo(${String(steps)})`).toBe(empty)
      expectValid(store)

      store.getState().redo(steps)
      expect(gateCount(store.getState().circuit)).toBe(2)
      expectValid(store)
    }
  })

  it('still resets and loads after a nonsense step count', () => {
    const store = storeOf()
    store.getState().placeGate('h', [0], 0)
    store.getState().undo(0)
    store.getState().redo(NaN)

    store.getState().reset()
    expect(store.getState().circuit).toEqual(emptyCircuit(4, 2))
    expect(store.getState().loadCircuit(emptyCircuit(2)).ok).toBe(true)
    expect(store.getState().circuit.qubits).toBe(2)
  })
})

/*
 * The undo/redo hole was one instance of a class: an argument that reaches
 * `set()` without the contract getting to judge it. Every other action
 * builds a candidate circuit and hands it to `commit()`, so a hostile
 * number can only be refused — this pins that, action by action, so a
 * future action that writes to the store directly cannot quietly join the
 * class.
 */
describe('out-of-range arguments', () => {
  const HOSTILE = [-1, -0.5, 0.5, 1e9, NaN, Infinity, -Infinity]

  it('leave the store usable and its circuit valid, whatever they are', () => {
    for (const value of HOSTILE) {
      const store = storeOf()
      store.getState().placeGate('rz', [0], 0, { params: [0] })
      store.getState().placeGate('measure', [1], 1, { clbitTargets: [1] })
      store.getState().setSelection(['op_1'])
      store.getState().copy()

      const attempts: readonly (readonly [string, () => unknown])[] = [
        ['placeGate target', () => store.getState().placeGate('h', [value], 2)],
        ['placeGate column', () => store.getState().placeGate('h', [2], value)],
        [
          'placeGate control',
          () => store.getState().placeGate('cx', [2], 2, { controls: [value] }),
        ],
        [
          'placeGate param',
          () => store.getState().placeGate('rz', [2], 2, { params: [value] }),
        ],
        [
          'placeGate clbitTarget',
          () =>
            store
              .getState()
              .placeGate('measure', [2], 2, { clbitTargets: [value] }),
        ],
        [
          'placeGate condition',
          () =>
            store.getState().placeGate('x', [2], 2, {
              condition: { clbit: value, equals: 1 },
            }),
        ],
        [
          'moveOperation target',
          () => store.getState().moveOperation('op_1', [value], 0),
        ],
        [
          'moveOperation column',
          () => store.getState().moveOperation('op_1', [0], value),
        ],
        ['addControl', () => store.getState().addControl('op_1', value)],
        ['removeControl', () => store.getState().removeControl('op_1', value)],
        ['setParam index', () => store.getState().setParam('op_1', value, 0)],
        ['setParam value', () => store.getState().setParam('op_1', 0, value)],
        ['addQubit', () => store.getState().addQubit(value)],
        ['removeQubit', () => store.getState().removeQubit(value)],
        [
          'reorderQubits',
          () => store.getState().reorderQubits([value, 1, 2, 3]),
        ],
        ['setQubitLabel', () => store.getState().setQubitLabel(value, 'wire')],
        ['removeClbit', () => store.getState().removeClbit(value)],
        ['paste qubit', () => store.getState().paste(value, 2)],
        ['paste column', () => store.getState().paste(0, value)],
        ['undo', () => store.getState().undo(value)],
        ['redo', () => store.getState().redo(value)],
      ]

      for (const [action, attempt] of attempts) {
        attempt()
        const state = store.getState()
        expect(state, `${action}(${String(value)})`).toBeDefined()
        expect(
          validateCircuit(state.circuit),
          `${action}(${String(value)})`
        ).toEqual([])
      }
    }
  })
})

describe('documents', () => {
  it('loads a valid circuit and forgets the previous history', () => {
    const store = storeOf()
    store.getState().placeGate('h', [0], 0)

    expect(store.getState().loadCircuit(emptyCircuit(2)).ok).toBe(true)
    expect(store.getState().circuit.qubits).toBe(2)
    expect(store.getState().selection).toEqual([])
    expect(historyDepth(store)).toBe(0)
  })

  it('refuses invalid input and says what is wrong with it', () => {
    const store = storeOf()
    const before = store.getState().circuit
    const result = store.getState().loadCircuit({ qubits: 2 })

    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.reason).toBe('shape')
      expect(result.issues.length).toBeGreaterThan(0)
    }
    expect(store.getState().circuit).toBe(before)
  })

  it('refuses a circuit that is shaped right but cannot run', () => {
    const store = storeOf()
    const result = store.getState().loadCircuit({
      schemaVersion: 1,
      qubits: 2,
      operations: [
        { id: 'op_1', gate: 'h', targets: [0], column: 0 },
        { id: 'op_2', gate: 'x', targets: [0], column: 0 },
      ],
    } satisfies CircuitInput)

    expect(reasonOf(result)).toBe('column-conflict')
  })

  it('resets to the document it was created with', () => {
    const store = storeOf(2, 0)
    store.getState().placeGate('h', [0], 0)
    store.getState().reset()

    expect(store.getState().circuit).toEqual(emptyCircuit(2, 0))
    expect(historyDepth(store)).toBe(0)
    expect(store.getState().selection).toEqual([])
  })
})

describe('selectors', () => {
  it('finds the operation holding a cell, target or control alike', () => {
    const store = storeOf()
    store.getState().placeGate('cx', [2], 1, { controls: [0] })
    const circuit = store.getState().circuit

    expect(operationAt(circuit, 2, 1)?.id).toBe('op_1')
    expect(operationAt(circuit, 0, 1)?.id).toBe('op_1')
    expect(operationAt(circuit, 1, 1)).toBeUndefined()
    expect(operationAt(circuit, 2, 0)).toBeUndefined()
  })

  it('lists the selected operations in circuit order', () => {
    const store = storeOf()
    store.getState().placeGate('h', [0], 0)
    store.getState().placeGate('x', [1], 0)
    store.getState().setSelection(['op_2', 'op_1'])

    const { circuit, selection } = store.getState()
    expect(selectedOperations(circuit, selection).map((op) => op.id)).toEqual([
      'op_1',
      'op_2',
    ])
  })
})

describe('rejection reasons', () => {
  it('cover every code the contract can raise', () => {
    // A compile-time claim, asserted at runtime so it cannot be pruned: if
    // the schema grows a validation code the store does not name, this line
    // stops typechecking.
    const covered: ValidationCode extends RejectionReason ? true : false = true
    expect(covered).toBe(true)
  })

  it('have a message in all three languages', () => {
    // Typed as a total record, so a missing key is a compile error too.
    const english: Record<RejectionReason, string> = enEditor.rejection
    const spanish: Record<RejectionReason, string> = esEditor.rejection
    const french: Record<RejectionReason, string> = frEditor.rejection

    for (const reason of REJECTION_REASONS) {
      for (const catalog of [english, spanish, french]) {
        expect(catalog[reason].trim().length).toBeGreaterThan(0)
      }
    }
  })
})

/* ------------------------------------------------------------------ *
 * Randomised sequences.
 *
 * The point is not to check any particular edit but to check that no
 * reachable order of edits can leave a circuit the contract would reject,
 * and that every refusal is a true no-op. Seeds are fixed so a failure is
 * reproducible.
 * ------------------------------------------------------------------ */

function mulberry32(seed: number): () => number {
  let state = seed >>> 0
  return () => {
    state = (state + 0x6d2b79f5) >>> 0
    let t = Math.imul(state ^ (state >>> 15), 1 | state)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

function choose<T>(random: () => number, values: readonly T[]): T {
  return values[Math.floor(random() * values.length)]!
}

/** `[0 … qubits-1]` in a random order, the shape `reorderQubits` takes. */
function shuffled(random: () => number, qubits: number): number[] {
  return distinctQubits(random, qubits, qubits)
}

/** `count` distinct qubit indices, or fewer if the register is smaller. */
function distinctQubits(
  random: () => number,
  count: number,
  qubits: number
): number[] {
  const pool = Array.from({ length: qubits }, (_, index) => index)
  for (let i = 0; i < Math.min(count, pool.length); i++) {
    const j = i + Math.floor(random() * (pool.length - i))
    const swap = pool[i]!
    pool[i] = pool[j]!
    pool[j] = swap
  }
  return pool.slice(0, count)
}

/** Runs one random edit and hands back whatever the store answered. */
function randomEdit(
  store: CircuitStore,
  random: () => number,
  options: { readonly history?: boolean } = {}
): EditResult | undefined {
  const state = store.getState()
  const { circuit } = state
  const column = Math.floor(random() * 5)
  const ids = circuit.operations.map((operation) => operation.id)
  const [a, b, c] = distinctQubits(random, 3, circuit.qubits)

  const placements: (() => EditResult | undefined)[] = [
    () =>
      state.placeGate(choose(random, ['h', 'x', 'z', 't', 'sx']), [a!], column),
    () => state.placeGate('rz', [a!], column, { params: [random() * Math.PI] }),
    () =>
      b === undefined
        ? undefined
        : state.placeGate(choose(random, ['cx', 'cz']), [a!], column, {
            controls: [b],
          }),
    () =>
      b === undefined ? undefined : state.placeGate('swap', [a!, b], column),
    () =>
      b === undefined || c === undefined
        ? undefined
        : state.placeGate('ccx', [a!], column, { controls: [b, c] }),
    () =>
      circuit.clbits === 0
        ? undefined
        : state.placeGate('measure', [a!], column, {
            clbitTargets: [Math.floor(random() * circuit.clbits)],
          }),
    () =>
      b === undefined ? undefined : state.placeGate('barrier', [a!, b], column),
  ]

  const edits: (() => EditResult | undefined)[] = [
    () =>
      ids.length === 0
        ? undefined
        : state.moveOperation(choose(random, ids), [a!], column),
    () =>
      ids.length === 0 ? undefined : state.removeOperation(choose(random, ids)),
    () =>
      ids.length === 0
        ? undefined
        : state.addControl(choose(random, ids), a!, random() < 0.5 ? 0 : 1),
    () =>
      ids.length === 0
        ? undefined
        : state.removeControl(choose(random, ids), a!),
    () =>
      ids.length === 0
        ? undefined
        : state.setParam(
            choose(random, ids),
            Math.floor(random() * 3),
            random() * Math.PI
          ),
    () => state.addQubit(Math.floor(random() * (circuit.qubits + 1))),
    () => state.removeQubit(Math.floor(random() * circuit.qubits)),
    () =>
      state.reorderQubits(
        distinctQubits(random, circuit.qubits, circuit.qubits)
      ),
    () => state.setQubitLabel(Math.floor(random() * circuit.qubits), 'wire'),
    () => state.addClbit(),
    () => state.removeClbit(Math.floor(random() * Math.max(circuit.clbits, 1))),
    () => {
      state.setSelection(ids.filter(() => random() < 0.5))
      return undefined
    },
    () => state.copy(),
    () => state.paste(Math.floor(random() * circuit.qubits), column),
    () => state.compactColumns(),
  ]

  if (options.history !== false) {
    edits.push(
      () => {
        state.undo()
        return undefined
      },
      () => {
        state.redo()
        return undefined
      }
    )
  }

  // Placements are weighted heavily. With a flat mix the destructive edits
  // keep the circuit hovering around empty, and an invariant that only ever
  // sees three gates is not an invariant anybody tested.
  return choose(random, random() < 0.6 ? placements : edits)()
}

describe('randomised action sequences', () => {
  it('never leave a circuit the contract would reject', () => {
    let applied = 0
    let gates = 0

    for (let seed = 1; seed <= 50; seed++) {
      const random = mulberry32(seed)
      const store = storeOf(4, 2)

      for (let step = 0; step < 40; step++) {
        const before = store.getState().circuit
        randomEdit(store, random)
        const after = store.getState().circuit

        const issues = validateCircuit(after)
        expect(
          issues,
          `seed ${seed}, step ${step}: ${JSON.stringify(after)}`
        ).toEqual([])
        expectSelectionIsLive(store)

        if (after !== before) {
          applied++
          const ids = after.operations.map((operation) => operation.id)
          expect(new Set(ids).size, `seed ${seed}, step ${step}`).toBe(
            ids.length
          )
        }
      }
      gates += gateCount(store.getState().circuit)
    }

    // Guards against the sequences degenerating into 2000 refusals on an
    // empty canvas, which would make every assertion above pass without
    // testing anything. The run is deterministic: these were 973 and 287.
    expect(applied).toBeGreaterThan(500)
    expect(gates).toBeGreaterThan(150)
  })

  it('leave the circuit untouched whenever an edit is refused', () => {
    let refusals = 0

    for (let seed = 101; seed <= 150; seed++) {
      const random = mulberry32(seed)
      const store = storeOf(3, 1)

      for (let step = 0; step < 40; step++) {
        const before = store.getState().circuit
        const historyBefore = historyDepth(store)
        const result = randomEdit(store, random)
        if (result === undefined || result.ok) continue

        refusals++
        expect(store.getState().circuit, `seed ${seed}, step ${step}`).toBe(
          before
        )
        expect(historyDepth(store), `seed ${seed}, step ${step}`).toBe(
          historyBefore
        )
      }
    }

    // The assertions above are vacuous if nothing was ever refused.
    expect(refusals).toBeGreaterThan(100)
  })
})

/* ------------------------------------------------------------------ *
 * Randomised sequences, restricted to what the canvas can actually issue.
 *
 * `randomEdit` above deliberately probes the store's whole API with hostile
 * arguments, including measurements aimed at an arbitrary classical bit.
 * That is the right test for "the contract is the only judge", and the wrong
 * one for the classical-write invariant: a generator that picks bits at
 * random can produce two writers in a column by itself, so asserting the
 * invariant against it would only be asserting a property of the generator.
 *
 * This one models a user instead. Every placement is the draft `draftOf`
 * would have built, and every move is the draft `moveTo` would have built,
 * so what it proves is that no sequence of *editor* gestures can reach the
 * shape the engine has no answer for.
 * ------------------------------------------------------------------ */

/** One editor-shaped edit: the arguments the canvas would have supplied. */
function editorGesture(
  store: CircuitStore,
  random: () => number
): EditResult | undefined {
  const state = store.getState()
  const { circuit } = state
  const column = Math.floor(random() * 5)
  const ids = circuit.operations.map((operation) => operation.id)
  const [a, b] = distinctQubits(random, 2, circuit.qubits)

  const gestures: (() => EditResult | undefined)[] = [
    () => state.placeGate(choose(random, ['h', 'x', 'z', 't']), [a!], column),
    () =>
      b === undefined
        ? undefined
        : state.placeGate('cx', [a!], column, { controls: [b] }),
    /*
     * Through `draftOf`, not through a hand-written `clbitTargets: [a]`.
     * Choosing the bit is exactly the decision under test — the diagonal is
     * a default the register commands below can break — and a generator that
     * hard-codes it would be asserting the invariant against itself.
     */
    () => {
      const step = draftOf(circuit, 'measure', [a!], column)
      if (step.kind !== 'ready') return undefined
      const { targets, clbitTargets } = step.draft
      return state.placeGate('measure', targets, column, {
        ...(clbitTargets !== undefined ? { clbitTargets } : {}),
      })
    },
    () => {
      if (ids.length === 0) return undefined
      const operation = choose(random, circuit.operations)
      const grabbed = choose(random, qubitsOf(operation))
      const step = moveTo(circuit, operation, grabbed, {
        qubit: a!,
        column,
      })
      if (step.kind === 'refused') return undefined
      const { id, targets, controls, clbitTargets } = step.draft
      return state.moveOperation(id, targets, step.draft.column, {
        ...(controls !== undefined ? { controls } : {}),
        ...(clbitTargets !== undefined ? { clbitTargets } : {}),
      })
    },
    () =>
      ids.length === 0 ? undefined : state.removeOperation(choose(random, ids)),
    () => {
      state.setSelection(ids.filter(() => random() < 0.5))
      return state.copy()
    },
    () => state.paste(a!, column),
    () => state.compactColumns(),
    () => state.addClbit(),
    () => state.removeClbit(circuit.clbits - 1),
    /*
     * The three commands that renumber the wires without touching the
     * classical register. They are what breaks the clbit-equals-qubit
     * diagonal — a measurement rides to another wire index and keeps the bit
     * it always wrote — so a generator without them never reaches the state
     * the next placement has to cope with. The gutter offers the first two
     * as buttons; `reorderQubits` is the drag of §3.1.
     */
    // `addQubit` takes the index as optional — no index appends — so the
    // generator hands it whatever `distinctQubits` produced, undefined and
    // all, which is one more shape the store has to answer for.
    () => state.addQubit(a),
    () => state.removeQubit(a!),
    () => {
      const order = shuffled(random, circuit.qubits)
      return state.reorderQubits(order)
    },
    () => {
      state.undo()
      return undefined
    },
    () => {
      state.redo()
      return undefined
    },
  ]

  return choose(random, gestures)()
}

describe('randomised editor gestures', () => {
  it('never put two writers of one classical bit in one column', () => {
    let measurements = 0

    for (let seed = 201; seed <= 250; seed++) {
      const random = mulberry32(seed)
      const store = storeOf(4, 4)

      for (let step = 0; step < 40; step++) {
        editorGesture(store, random)
        expect(
          validateCircuit(store.getState().circuit),
          `seed ${seed}, step ${step}`
        ).toEqual([])
        expectOneWriterPerClassicalBit(store)
      }
      measurements += store
        .getState()
        .circuit.operations.filter(
          (operation) => operation.gate === 'measure'
        ).length
    }

    // Vacuous unless measurements were actually placed and survived.
    expect(measurements).toBeGreaterThan(20)
  })
})
