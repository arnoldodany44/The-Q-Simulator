/**
 * Adversarial verification — the register edits, checked by wire identity.
 *
 * Validity alone cannot catch the failure that matters here: a wrong remap
 * after inserting, deleting or reordering a wire produces a circuit that
 * still passes `validateCircuit` and computes something the user never drew.
 * So every assertion below is phrased in terms of *which wire* an operation
 * ended up on, never in terms of index arithmetic — the arithmetic is what
 * is under test.
 *
 * Wires are identified by their label. `qubitLabels` is one-per-qubit by
 * contract, so a labelled register names every wire, and "the gate that was
 * on `alice` is still on `alice`" is a statement about meaning rather than
 * about the implementation.
 */

import { validateCircuit, type Circuit, type Operation } from '@qsim/schema'
import { describe, expect, it } from 'vitest'

import {
  createCircuitStore,
  type CircuitStore,
} from '../../features/circuit-editor/useCircuitStore'

/** A named register with one gate per wire. */
function labelledStore(names: readonly string[]): CircuitStore {
  const store = createCircuitStore({
    schemaVersion: 1,
    qubits: names.length,
    clbits: names.length,
    qubitLabels: [...names],
    operations: [],
  })
  names.forEach((_, qubit) => {
    expect(store.getState().placeGate('h', [qubit], 0).ok).toBe(true)
  })
  return store
}

const labelsOf = (circuit: Circuit): readonly string[] =>
  circuit.qubitLabels ?? []

/** Every wire an operation touches, named. */
function wiresOf(circuit: Circuit, operation: Operation): string[] {
  const labels = labelsOf(circuit)
  const named = (qubit: number): string => labels[qubit] ?? `#${qubit}`
  return [
    ...operation.targets.map(named),
    ...(operation.controls ?? []).map((control) =>
      named(typeof control === 'number' ? control : control.qubit)
    ),
  ]
}

/** `id -> the wires it sits on`, which is the thing that must be preserved. */
function wiring(circuit: Circuit): Record<string, string[]> {
  return Object.fromEntries(
    circuit.operations.map((operation) => [
      operation.id,
      wiresOf(circuit, operation),
    ])
  )
}

/** Every permutation of `0..n-1`, as `order[newIndex] = oldIndex`. */
function permutations(n: number): number[][] {
  if (n === 0) return [[]]
  const out: number[][] = []
  for (const rest of permutations(n - 1)) {
    for (let slot = 0; slot <= rest.length; slot++) {
      out.push([...rest.slice(0, slot), n - 1, ...rest.slice(slot)])
    }
  }
  return out
}

describe('reorderQubits moves gates with their wires', () => {
  const names = ['alice', 'bob', 'carol', 'dave']

  for (const order of permutations(4)) {
    it(`order [${order.join()}]`, () => {
      const store = labelledStore(names)
      // A two-wire gate as well, so a permutation that only looks right for
      // single-qubit gates has somewhere to go wrong.
      expect(
        store.getState().placeGate('cx', [1], 1, { controls: [3] }).ok
      ).toBe(true)

      const before = store.getState().circuit
      const expectedWiring = wiring(before)

      expect(store.getState().reorderQubits(order).ok).toBe(true)
      const after = store.getState().circuit

      expect(validateCircuit(after)).toEqual([])
      // `order[newIndex] = oldIndex`: the wire that was at `order[k]` is now
      // at `k`, so its name must have travelled with it.
      expect(labelsOf(after)).toEqual(order.map((old) => names[old]))
      // And every gate must still sit on the same *named* wires.
      expect(wiring(after)).toEqual(expectedWiring)
      expect(after.operations.length).toBe(before.operations.length)
    })
  }

  it('undoes itself when applied with the inverse order', () => {
    const store = labelledStore(names)
    const original = store.getState().circuit
    const order = [2, 0, 3, 1]
    const inverse = order.map((_, position) => order.indexOf(position))

    expect(store.getState().reorderQubits(order).ok).toBe(true)
    expect(store.getState().reorderQubits(inverse).ok).toBe(true)
    expect(store.getState().circuit).toEqual(original)
  })
})

describe('removeQubit takes exactly what stood on the wire', () => {
  const names = ['alice', 'bob', 'carol', 'dave']

  for (let index = 0; index < names.length; index++) {
    it(`removing ${names[index]}`, () => {
      const store = labelledStore(names)
      expect(
        store.getState().placeGate('cx', [1], 1, { controls: [3] }).ok
      ).toBe(true)
      expect(store.getState().placeGate('swap', [0, 2], 2).ok).toBe(true)

      const before = store.getState().circuit
      const doomed = names[index] as string
      const survivors = Object.fromEntries(
        Object.entries(wiring(before)).filter(
          ([, wires]) => !wires.includes(doomed)
        )
      )

      expect(store.getState().removeQubit(index).ok).toBe(true)
      const after = store.getState().circuit

      expect(validateCircuit(after)).toEqual([])
      expect(labelsOf(after)).toEqual(names.filter((_, i) => i !== index))
      // Everything that did not touch the deleted wire is untouched, on the
      // same named wires; everything that did touch it is gone.
      expect(wiring(after)).toEqual(survivors)
    })
  }

  it('undo brings the wire and everything that stood on it back', () => {
    const store = labelledStore(names)
    expect(store.getState().placeGate('cx', [1], 1, { controls: [3] }).ok).toBe(
      true
    )
    const before = store.getState().circuit

    expect(store.getState().removeQubit(1).ok).toBe(true)
    store.getState().undo()

    expect(store.getState().circuit).toBe(before)
    expect(validateCircuit(store.getState().circuit)).toEqual([])
  })
})

describe('addQubit pushes wires aside without moving their gates', () => {
  const names = ['alice', 'bob', 'carol']

  for (let at = 0; at <= names.length; at++) {
    it(`inserting at ${at}`, () => {
      const store = labelledStore(names)
      expect(
        store.getState().placeGate('cx', [0], 1, { controls: [2] }).ok
      ).toBe(true)

      const before = store.getState().circuit
      const expectedWiring = wiring(before)

      expect(store.getState().addQubit(at).ok).toBe(true)
      const after = store.getState().circuit

      expect(validateCircuit(after)).toEqual([])
      expect(after.qubits).toBe(names.length + 1)
      expect(wiring(after)).toEqual(expectedWiring)
      // The named wires keep their relative order; one new slot appears.
      expect(labelsOf(after).filter((label) => names.includes(label))).toEqual(
        names
      )
    })
  }
})

describe('custom gate bodies are not part of the register', () => {
  const withCustomGate = () =>
    createCircuitStore({
      schemaVersion: 1,
      qubits: 4,
      clbits: 2,
      operations: [
        { id: 'a', gate: 'bell', targets: [0, 1], column: 0 },
        { id: 'b', gate: 'h', targets: [3], column: 0 },
      ],
      customGates: {
        bell: {
          qubits: 2,
          operations: [
            { id: 'i1', gate: 'h', targets: [0], column: 0 },
            { id: 'i2', gate: 'cx', targets: [1], column: 1, controls: [0] },
          ],
        },
      },
    })

  it('survives every register edit untouched', () => {
    const store = withCustomGate()
    const body = JSON.stringify(store.getState().circuit.customGates)

    expect(store.getState().addQubit(0).ok).toBe(true)
    expect(store.getState().removeQubit(0).ok).toBe(true)
    expect(store.getState().reorderQubits([3, 2, 1, 0]).ok).toBe(true)

    // A custom gate has its own numbering, so remapping the outer register
    // into it would rewire a definition the user never opened.
    expect(JSON.stringify(store.getState().circuit.customGates)).toBe(body)
    expect(validateCircuit(store.getState().circuit)).toEqual([])
  })
})

describe('removeClbit takes exactly what wrote to it', () => {
  it('drops the measurements and the conditions that named the bit', () => {
    const store = createCircuitStore({
      schemaVersion: 1,
      qubits: 3,
      clbits: 3,
      operations: [],
    })
    expect(
      store.getState().placeGate('measure', [0], 0, { clbitTargets: [0] }).ok
    ).toBe(true)
    expect(
      store.getState().placeGate('measure', [1], 0, { clbitTargets: [1] }).ok
    ).toBe(true)
    expect(
      store.getState().placeGate('x', [2], 1, {
        condition: { clbit: 2, equals: 1 },
      }).ok
    ).toBe(true)

    expect(store.getState().removeClbit(1).ok).toBe(true)
    const after = store.getState().circuit

    expect(validateCircuit(after)).toEqual([])
    expect(after.clbits).toBe(2)
    expect(after.operations.map((operation) => operation.id)).toEqual([
      'op_1',
      'op_3',
    ])
    // The conditioned gate followed its bit down from 2 to 1.
    expect(after.operations[1]?.condition).toEqual({ clbit: 1, equals: 1 })
  })
})
