/**
 * Adversarial verification — one writer per classical bit, per instant.
 *
 * A column is one instant (§6). `runner.ts` groups a column's operations and
 * runs them in array order, which is safe only because the contract makes the
 * qubits of a column disjoint; the classical register is the exception, and
 * two operations writing one bit in one column give a tally that depends on
 * nothing but which of them the array lists last. The editor must never build
 * that shape.
 *
 * The sequences below are the ones that reached it, and they are ordinary: a
 * measurement plus a register edit plus a second measurement. The register
 * commands renumber the wires and deliberately leave the classical register
 * alone, so the clbit-equals-qubit diagonal the editor places on is *not* a
 * property of the document, and a placement that assumed it handed the
 * vacated wire index a bit that column already wrote.
 *
 * Every gesture here goes through the functions the canvas calls — `draftOf`
 * for a placement, `moveTo` for a drag — because hand-written arguments would
 * be testing the test. The store is driven directly for the register commands
 * for the same reason `useKeyboardGrid` calls them directly: they take an
 * index and nothing else.
 */

import { emptyCircuit, validateCircuit, type Circuit } from '@qsim/schema'
import { describe, expect, it } from 'vitest'

import { draftOf, moveTo } from '../../features/circuit-editor/placement'
import {
  createCircuitStore,
  type CircuitStore,
  type EditResult,
} from '../../features/circuit-editor/useCircuitStore'

/** Places a measurement the way the editor does: the draft `draftOf` builds. */
function measure(
  store: CircuitStore,
  qubit: number,
  column: number
): EditResult {
  const step = draftOf(store.getState().circuit, 'measure', [qubit], column)
  if (step.kind !== 'ready') {
    return { ok: false, reason: 'clbit-in-use', issues: [] }
  }
  const { targets, clbitTargets } = step.draft
  return store.getState().placeGate('measure', targets, column, {
    ...(clbitTargets !== undefined ? { clbitTargets } : {}),
  })
}

/** Drags an operation to a cell the way a drop does. */
function dragTo(
  store: CircuitStore,
  id: string,
  grabbed: number,
  qubit: number,
  column: number
): EditResult {
  const circuit = store.getState().circuit
  const operation = circuit.operations.find((candidate) => candidate.id === id)
  expect(operation, `no operation ${id}`).toBeDefined()
  const step = moveTo(circuit, operation!, grabbed, { qubit, column })
  if (step.kind === 'refused') {
    return { ok: false, reason: 'clbit-in-use', issues: [] }
  }
  const { targets, controls, clbitTargets } = step.draft
  return store.getState().moveOperation(id, targets, step.draft.column, {
    ...(controls !== undefined ? { controls } : {}),
    ...(clbitTargets !== undefined ? { clbitTargets } : {}),
  })
}

/** The invariant itself, stated once. */
function expectOneWriterPerBit(circuit: Circuit, where: string): void {
  const written = new Map<number, Set<number>>()
  for (const operation of circuit.operations) {
    const bits = written.get(operation.column) ?? new Set<number>()
    for (const clbit of operation.clbitTargets ?? []) {
      expect(
        bits.has(clbit),
        `${where}: column ${operation.column} has two writers of c${clbit}`
      ).toBe(false)
      bits.add(clbit)
    }
    written.set(operation.column, bits)
  }
  expect(validateCircuit(circuit), where).toEqual([])
}

const writesIn = (circuit: Circuit, column: number): number[] =>
  circuit.operations
    .filter((operation) => operation.column === column)
    .flatMap((operation) => operation.clbitTargets ?? [])
    .sort((first, second) => first - second)

describe('a register edit cannot make two measurements share a bit', () => {
  it('survives a wire being deleted under a measurement', () => {
    // Variant A: measure q1 -> c1, delete q0 (the measurement rides down to
    // q0 and keeps writing c1), measure the wire that took index 1.
    const store = createCircuitStore(emptyCircuit(3, 3))
    expect(measure(store, 1, 0).ok).toBe(true)
    expect(store.getState().removeQubit(0).ok).toBe(true)
    expect(store.getState().circuit.operations[0]).toMatchObject({
      targets: [0],
      clbitTargets: [1],
    })

    expect(measure(store, 1, 0).ok).toBe(true)
    expectOneWriterPerBit(store.getState().circuit, 'after the deletion')
    expect(writesIn(store.getState().circuit, 0)).toEqual([0, 1])
  })

  it('survives a wire being inserted under a measurement', () => {
    // Variant B: the measurement rides *up* instead, and the new wire takes
    // the index whose bit it is still writing.
    const store = createCircuitStore(emptyCircuit(3, 3))
    expect(measure(store, 1, 0).ok).toBe(true)
    expect(store.getState().addQubit(1).ok).toBe(true)
    expect(store.getState().circuit.operations[0]).toMatchObject({
      targets: [2],
      clbitTargets: [1],
    })

    expect(measure(store, 1, 0).ok).toBe(true)
    expectOneWriterPerBit(store.getState().circuit, 'after the insertion')
  })

  it('survives the wires being reordered under a measurement', () => {
    // Variant D: `reorderQubits` is what the drag-to-reorder of §3.1 calls.
    const store = createCircuitStore(emptyCircuit(3, 3))
    expect(measure(store, 0, 0).ok).toBe(true)
    expect(store.getState().reorderQubits([1, 0, 2]).ok).toBe(true)
    expect(store.getState().circuit.operations[0]).toMatchObject({
      targets: [1],
      clbitTargets: [0],
    })

    expect(measure(store, 0, 0).ok).toBe(true)
    expectOneWriterPerBit(store.getState().circuit, 'after the reorder')
  })

  it('refuses a paste that would land on a bit that column writes', () => {
    // Variant C: a fragment cut from a broken diagonal translates faithfully
    // — that is what a paste is — and lands on a bit already in use. There
    // is no free bit to fall back on, because a fragment's internal wiring
    // only survives if every reference moves the same distance.
    const store = createCircuitStore(emptyCircuit(4, 4))
    expect(measure(store, 3, 0).ok).toBe(true)
    expect(store.getState().removeQubit(0).ok).toBe(true)
    const rider = store.getState().circuit.operations[0]!
    expect(rider).toMatchObject({ targets: [2], clbitTargets: [3] })

    expect(measure(store, 1, 0).ok).toBe(true)
    store.getState().setSelection([rider.id])
    expect(store.getState().copy().ok).toBe(true)

    const before = store.getState().circuit
    const pasted = store.getState().paste(0, 0)
    expect(pasted).toEqual({
      ok: false,
      reason: 'clbit-in-use',
      issues: [],
    })
    // A refused edit changes nothing at all — same object, same history.
    expect(store.getState().circuit).toBe(before)
    expectOneWriterPerBit(store.getState().circuit, 'after the refused paste')
  })

  it('refuses a drag whose classical write would collide', () => {
    const store = createCircuitStore(emptyCircuit(4, 4))
    expect(measure(store, 3, 0).ok).toBe(true)
    expect(store.getState().removeQubit(0).ok).toBe(true)
    const rider = store.getState().circuit.operations[0]!
    expect(measure(store, 1, 1).ok).toBe(true)

    // The rider sits on q2 and writes c3. Dragged two wires down into column
    // 1, its write travels the same two wires — to c1, which the measurement
    // already standing in that column writes. Refused, rather than committed
    // and left for the engine to guess.
    expect(dragTo(store, rider.id, 2, 0, 1).ok).toBe(false)
    expectOneWriterPerBit(store.getState().circuit, 'after the refused drag')
  })
})
