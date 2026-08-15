/**
 * Adversarial verification — copy, paste and the history they must not spend.
 *
 * The property under test is that a pasted fragment is *new operations*: it
 * never reuses an id the circuit already carries, and it never reuses one
 * that an undo or a redo could bring back. An id collision is the quietest
 * corruption in the editor — the circuit keeps validating until the duplicate
 * lands in the same operation list, and until then selection, undo and the
 * canvas simply act on the wrong gate.
 *
 * The orderings below are the ones a history implementation usually gets
 * wrong: a paste after the source has been undone away, a paste between an
 * undo and a redo, and a paste into a document that was loaded over the one
 * the fragment came from.
 */

import { emptyCircuit, validateCircuit, type Circuit } from '@qsim/schema'
import { describe, expect, it } from 'vitest'

import {
  createCircuitStore,
  type CircuitStore,
} from '../../features/circuit-editor/useCircuitStore'

const idsOf = (circuit: Circuit): string[] =>
  circuit.operations.map((operation) => operation.id)

function historyDepths(store: CircuitStore): {
  past: number
  future: number
} {
  const temporal = store.temporal.getState()
  return {
    past: temporal.pastStates.length,
    future: temporal.futureStates.length,
  }
}

/**
 * No id may name two different operations anywhere the user can travel to.
 * Undo hands a snapshot straight back to the canvas, so an id that means one
 * gate now and another one undo ago is a live confusion, not a theoretical
 * one.
 *
 * The gate is the fingerprint, because it is the one field no action changes:
 * wires and columns move under `addQubit` and `moveOperation`, and an
 * operation that survived either is still the same operation.
 */
function expectIdsMeanOneThing(store: CircuitStore, where: string): void {
  const temporal = store.temporal.getState()
  const meaning = new Map<string, string>()
  // zundo types a snapshot as `Partial<TState>`, so the circuits come back
  // optional even though `partialize` always puts one there.
  const reachable = [
    ...temporal.pastStates.map((snapshot) => snapshot.circuit),
    store.getState().circuit,
    ...temporal.futureStates.map((snapshot) => snapshot.circuit),
  ].filter((circuit): circuit is Circuit => circuit !== undefined)
  for (const circuit of reachable) {
    for (const operation of circuit.operations) {
      const known = meaning.get(operation.id)
      if (known === undefined) meaning.set(operation.id, operation.gate)
      else
        expect(
          operation.gate,
          `${where}: id "${operation.id}" names one operation`
        ).toBe(known)
    }
  }
}

function bellStore(): CircuitStore {
  const store = createCircuitStore(emptyCircuit(4, 4))
  expect(store.getState().placeGate('h', [0], 0).ok).toBe(true)
  expect(store.getState().placeGate('cx', [1], 1, { controls: [0] }).ok).toBe(
    true
  )
  return store
}

describe('copy spends no history', () => {
  it('records no undo step and keeps the redo stack', () => {
    const store = bellStore()
    store.getState().undo()
    const before = historyDepths(store)
    expect(before.future).toBe(1)

    store.getState().setSelection(idsOf(store.getState().circuit))
    expect(store.getState().copy().ok).toBe(true)

    expect(historyDepths(store)).toEqual(before)
  })

  it('refuses an empty selection without touching anything', () => {
    const store = bellStore()
    const before = historyDepths(store)
    const circuit = store.getState().circuit

    store.getState().clearSelection()

    expect(store.getState().copy()).toEqual({
      ok: false,
      reason: 'empty-selection',
      issues: [],
    })
    expect(store.getState().circuit).toBe(circuit)
    expect(historyDepths(store)).toEqual(before)
  })
})

describe('paste mints fresh ids under every ordering', () => {
  const orderings: readonly {
    name: string
    run: (store: CircuitStore) => void
  }[] = [
    {
      name: 'paste three times in a row',
      run: (store) => {
        expect(store.getState().paste(2, 3).ok).toBe(true)
        expect(store.getState().paste(0, 5).ok).toBe(true)
        expect(store.getState().paste(2, 7).ok).toBe(true)
      },
    },
    {
      name: 'undo the source away, then paste',
      run: (store) => {
        store.getState().undo()
        store.getState().undo()
        expect(store.getState().paste(0, 0).ok).toBe(true)
      },
    },
    {
      name: 'paste, undo the paste, paste again',
      run: (store) => {
        expect(store.getState().paste(2, 3).ok).toBe(true)
        store.getState().undo()
        expect(store.getState().paste(2, 3).ok).toBe(true)
      },
    },
    {
      name: 'paste, undo, redo, paste',
      run: (store) => {
        expect(store.getState().paste(2, 3).ok).toBe(true)
        store.getState().undo()
        store.getState().redo()
        expect(store.getState().paste(0, 6).ok).toBe(true)
      },
    },
    {
      name: 'delete the source, then paste it back',
      run: (store) => {
        expect(store.getState().removeOperations(['op_1', 'op_2']).ok).toBe(
          true
        )
        expect(store.getState().paste(0, 0).ok).toBe(true)
      },
    },
    {
      name: 'load another document, then paste',
      run: (store) => {
        expect(
          store.getState().loadCircuit({
            schemaVersion: 1,
            qubits: 4,
            clbits: 4,
            operations: [{ id: 'op_2', gate: 'x', targets: [3], column: 9 }],
          }).ok
        ).toBe(true)
        expect(store.getState().paste(0, 0).ok).toBe(true)
      },
    },
    {
      name: 'reset, then paste',
      run: (store) => {
        store.getState().reset()
        expect(store.getState().paste(0, 0).ok).toBe(true)
      },
    },
    {
      name: 'add a wire under the fragment, then paste twice',
      run: (store) => {
        expect(store.getState().addQubit(1).ok).toBe(true)
        expect(store.getState().paste(2, 4).ok).toBe(true)
        expect(store.getState().paste(0, 6).ok).toBe(true)
      },
    },
  ]

  for (const ordering of orderings) {
    it(ordering.name, () => {
      const store = bellStore()
      store.getState().setSelection(['op_1', 'op_2'])
      expect(store.getState().copy().ok).toBe(true)

      ordering.run(store)

      const circuit = store.getState().circuit
      expect(validateCircuit(circuit), ordering.name).toEqual([])
      expect(new Set(idsOf(circuit)).size, `${ordering.name}: unique now`).toBe(
        idsOf(circuit).length
      )
      expectIdsMeanOneThing(store, ordering.name)

      // And the ids must stay unique everywhere undo and redo can travel.
      for (let step = 0; step < 12; step++) {
        store.getState().undo()
        const undone = store.getState().circuit
        expect(validateCircuit(undone), `${ordering.name}: undone`).toEqual([])
        expect(new Set(idsOf(undone)).size).toBe(idsOf(undone).length)
      }
      for (let step = 0; step < 12; step++) {
        store.getState().redo()
        const redone = store.getState().circuit
        expect(validateCircuit(redone), `${ordering.name}: redone`).toEqual([])
        expect(new Set(idsOf(redone)).size).toBe(idsOf(redone).length)
      }
    })
  }

  it('never reuses an id that lives in the reachable history', () => {
    const store = bellStore()
    store.getState().setSelection(['op_1', 'op_2'])
    expect(store.getState().copy().ok).toBe(true)

    for (let round = 0; round < 20; round++) {
      store.getState().paste(0, round * 2 + 2)
      if (round % 3 === 0) store.getState().undo()
      if (round % 7 === 0) store.getState().redo()
      expectIdsMeanOneThing(store, `round ${round}`)
      expect(validateCircuit(store.getState().circuit)).toEqual([])
    }
  })
})

describe('a refused paste is a true no-op', () => {
  it('an empty clipboard costs nothing', () => {
    const store = bellStore()
    const before = historyDepths(store)
    const circuit = store.getState().circuit

    expect(store.getState().paste(0, 4)).toEqual({
      ok: false,
      reason: 'empty-clipboard',
      issues: [],
    })
    expect(store.getState().circuit).toBe(circuit)
    expect(historyDepths(store)).toEqual(before)
  })

  it('a paste onto an occupied cell lands nothing at all', () => {
    const store = bellStore()
    store.getState().setSelection(['op_1', 'op_2'])
    expect(store.getState().copy().ok).toBe(true)
    const circuit = store.getState().circuit
    const before = historyDepths(store)

    expect(store.getState().paste(0, 0).ok).toBe(false)

    expect(store.getState().circuit).toBe(circuit)
    expect(historyDepths(store)).toEqual(before)
  })

  it('a paste that runs off the register costs nothing', () => {
    const store = bellStore()
    store.getState().setSelection(['op_1', 'op_2'])
    expect(store.getState().copy().ok).toBe(true)
    const circuit = store.getState().circuit
    const before = historyDepths(store)

    expect(store.getState().paste(3, 5).ok).toBe(false)
    expect(store.getState().circuit).toBe(circuit)
    expect(historyDepths(store)).toEqual(before)
  })
})

describe('undo restores the selection the edit was made with', () => {
  it('a pasted fragment is selected, and undo gives back what was', () => {
    const store = bellStore()
    store.getState().setSelection(['op_1'])
    expect(store.getState().copy().ok).toBe(true)
    store.getState().setSelection(['op_2'])

    expect(store.getState().paste(2, 4).ok).toBe(true)
    expect(store.getState().selection).toEqual(['op_3'])

    store.getState().undo()
    expect(store.getState().selection).toEqual(['op_2'])
  })
})
