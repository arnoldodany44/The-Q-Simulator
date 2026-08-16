import {
  depth,
  emptyCircuit,
  expandCircuit,
  gateCount,
  validateCircuit,
  type Circuit,
} from '@qsim/schema'
import { describe, expect, it } from 'vitest'

import {
  customGateNameIssue,
  definitionAsDocument,
  firstFreeColumn,
  packageFragment,
  reshapesUses,
  signatureOf,
} from './customGates'
import { createCircuitStore, type CircuitStore } from './useCircuitStore'

function storeOf(qubits = 4, clbits = 2): CircuitStore {
  return createCircuitStore(emptyCircuit(qubits, clbits))
}

/** A Bell pair on wires 0 and 1, selected. */
function bellStore(): CircuitStore {
  const store = storeOf()
  store.getState().placeGate('h', [0], 0)
  store.getState().placeGate('cx', [1], 1, { controls: [0] })
  store.getState().setSelection(['op_1', 'op_2'])
  return store
}

function expectValid(store: CircuitStore): void {
  expect(validateCircuit(store.getState().circuit)).toEqual([])
}

describe('customGateNameIssue', () => {
  const circuit: Circuit = {
    ...emptyCircuit(2),
    customGates: { taken: { qubits: 1, operations: [] } },
  }

  it.each(['', '2fast', 'has space', 'dash-name'])(
    'refuses "%s" as a name',
    (name) => {
      expect(customGateNameIssue(circuit, name)).toBe('custom-gate-name')
    }
  )

  /*
   * A definition called `h` would exist and never run: `gateResolver` in the
   * contract answers the built-in first, so every use would resolve to the
   * catalog's H and the body would be dead JSON.
   */
  it('refuses a name the catalog already owns', () => {
    expect(customGateNameIssue(circuit, 'h')).toBe('custom-gate-name')
    expect(customGateNameIssue(circuit, 'cswap')).toBe('custom-gate-name')
  })

  it('refuses a name this circuit already defines', () => {
    expect(customGateNameIssue(circuit, 'taken')).toBe('custom-gate-exists')
  })

  it('accepts an ordinary identifier', () => {
    expect(customGateNameIssue(circuit, 'bellPair')).toBeNull()
  })
})

describe('packaging the selection', () => {
  it('replaces the fragment with one block and declares it', () => {
    const store = bellStore()
    expect(
      store.getState().packageSelection('bellPair', { symbol: 'B' }).ok
    ).toBe(true)

    const { circuit } = store.getState()
    expect(circuit.operations).toHaveLength(1)
    expect(circuit.operations[0]).toMatchObject({
      gate: 'bellPair',
      targets: [0, 1],
      column: 0,
    })
    expect(circuit.customGates?.bellPair).toMatchObject({
      qubits: 2,
      symbol: 'B',
    })
    expectValid(store)
  })

  /*
   * The property the whole design rests on: a block is a name for the gates
   * that were there, so flattening the packaged document has to give back the
   * document that was packaged — same gates, same wires, same columns.
   */
  it('does not change what the circuit does', () => {
    const store = bellStore()
    store.getState().placeGate('x', [2], 2)
    const before = expandCircuit(store.getState().circuit).circuit

    store.getState().setSelection(['op_1', 'op_2'])
    expect(store.getState().packageSelection('bellPair').ok).toBe(true)
    const after = expandCircuit(store.getState().circuit).circuit

    const shape = (circuit: Circuit) =>
      circuit.operations
        .map((operation) => ({
          gate: operation.gate,
          targets: operation.targets,
          controls: operation.controls ?? [],
          column: operation.column,
        }))
        .sort((left, right) => left.column - right.column)
    expect(shape(after)).toEqual(shape(before))
  })

  it('refuses a selection that skips a gate inside its own columns', () => {
    const store = storeOf()
    store.getState().placeGate('h', [0], 0)
    store.getState().placeGate('x', [2], 1)
    store.getState().placeGate('y', [0], 2)
    store.getState().setSelection(['op_1', 'op_3'])

    const result = store.getState().packageSelection('skipper')
    expect(result).toMatchObject({
      ok: false,
      reason: 'fragment-not-rectangular',
    })
    // A refused edit changes nothing (the store's rule 2).
    expect(store.getState().circuit.customGates).toBeUndefined()
  })

  it('refuses an empty selection and a name that is already a gate', () => {
    const store = storeOf()
    expect(store.getState().packageSelection('block')).toMatchObject({
      ok: false,
      reason: 'empty-selection',
    })
    store.getState().placeGate('h', [0], 0)
    store.getState().setSelection(['op_1'])
    expect(store.getState().packageSelection('h')).toMatchObject({
      ok: false,
      reason: 'custom-gate-name',
    })
  })

  it('turns the angles a fragment reads into the block’s parameters', () => {
    const store = storeOf()
    store.getState().loadCircuit({
      ...emptyCircuit(4, 2),
      parameters: [{ name: 'theta', value: 0.5 }],
      operations: [
        { id: 'op_1', gate: 'rz', targets: [0], params: ['theta'], column: 0 },
      ],
    })
    store.getState().setSelection(['op_1'])
    expect(store.getState().packageSelection('turn').ok).toBe(true)

    const { circuit } = store.getState()
    expect(circuit.customGates?.turn?.params).toEqual(['theta'])
    // And the placed block passes the same name straight back, so the slider
    // in this document still drives it.
    expect(circuit.operations[0]?.params).toEqual(['theta'])
    expectValid(store)
  })

  it('claims every wire the block spans, including the ones it skips', () => {
    const store = storeOf()
    store.getState().placeGate('h', [0], 0)
    store.getState().placeGate('x', [2], 0)
    store.getState().setSelection(['op_1', 'op_2'])
    expect(store.getState().packageSelection('wide').ok).toBe(true)

    expect(store.getState().circuit.operations[0]?.targets).toEqual([0, 1, 2])
    expect(store.getState().circuit.customGates?.wide?.qubits).toBe(3)
  })

  it('is one history step', () => {
    const store = bellStore()
    const before = store.temporal.getState().pastStates.length
    store.getState().packageSelection('bellPair')
    expect(store.temporal.getState().pastStates.length).toBe(before + 1)

    store.getState().undo()
    expect(store.getState().circuit.customGates).toBeUndefined()
    expect(store.getState().circuit.operations).toHaveLength(2)
  })
})

describe('placing and expanding a block', () => {
  function packaged(): CircuitStore {
    const store = bellStore()
    store.getState().packageSelection('bellPair', { symbol: 'B' })
    return store
  }

  it('places another use on the first free column', () => {
    const store = packaged()
    expect(store.getState().placeCustomGate('bellPair', 2).ok).toBe(true)

    const placed = store.getState().circuit.operations.at(-1)
    expect(placed).toMatchObject({
      gate: 'bellPair',
      targets: [2, 3],
      column: 0,
    })
    expectValid(store)
  })

  it('keeps a block on the canvas even when it would hang off the end', () => {
    const store = packaged()
    // Asked for the last wire; the block is two wires tall, so it slides up.
    expect(store.getState().placeCustomGate('bellPair', 3).ok).toBe(true)
    expect(store.getState().circuit.operations.at(-1)?.targets).toEqual([2, 3])
  })

  it('refuses to place a definition that does not exist', () => {
    expect(storeOf().getState().placeCustomGate('nope')).toMatchObject({
      ok: false,
      reason: 'custom-gate-not-found',
    })
  })

  it('expands one use back into its gates and moves the tail along', () => {
    const store = packaged()
    store.getState().placeGate('x', [2], 1)
    const id = store.getState().circuit.operations[0]?.id ?? ''

    expect(store.getState().inlineOperation(id).ok).toBe(true)
    const { circuit } = store.getState()
    expect(
      circuit.operations
        .map((operation) => [operation.gate, operation.column])
        .sort()
    ).toEqual([
      ['cx', 1],
      ['h', 0],
      ['x', 2],
    ])
    // The definition survives: peeling one use apart says nothing about the
    // others, and an unused definition is still one the user may place again.
    expect(circuit.customGates?.bellPair).toBeDefined()
    expectValid(store)
  })

  it('refuses to expand something that is not a block', () => {
    const store = storeOf()
    store.getState().placeGate('h', [0], 0)
    expect(store.getState().inlineOperation('op_1')).toMatchObject({
      ok: false,
      reason: 'not-a-custom-gate',
    })
    expect(store.getState().inlineOperation('op_99')).toMatchObject({
      ok: false,
      reason: 'operation-not-found',
    })
  })

  it('carries an argument into the gates it expands to', () => {
    const store = storeOf()
    store.getState().installCustomGate('turn', {
      qubits: 1,
      params: ['angle'],
      operations: [
        { id: 't1', gate: 'rz', targets: [0], params: ['angle'], column: 0 },
      ],
    })
    store.getState().placeGate('turn', [1], 0, { params: [1.25] })
    const id = store.getState().circuit.operations[0]?.id ?? ''

    expect(store.getState().inlineOperation(id).ok).toBe(true)
    expect(store.getState().circuit.operations[0]).toMatchObject({
      gate: 'rz',
      targets: [1],
      params: [1.25],
    })
  })
})

describe('deleting a definition', () => {
  it('refuses while something still calls it, and allows it after', () => {
    const store = bellStore()
    store.getState().packageSelection('bellPair')

    expect(store.getState().removeCustomGate('bellPair')).toMatchObject({
      ok: false,
      reason: 'custom-gate-in-use',
    })

    const id = store.getState().circuit.operations[0]?.id ?? ''
    store.getState().inlineOperation(id)
    expect(store.getState().removeCustomGate('bellPair').ok).toBe(true)
    // The key goes entirely rather than being left as an empty record.
    expect(store.getState().circuit.customGates).toBeUndefined()
  })

  it('refuses a definition another definition uses', () => {
    const store = storeOf()
    store.getState().installCustomGate('inner', {
      qubits: 1,
      operations: [{ id: 'i1', gate: 'x', targets: [0], column: 0 }],
    })
    store.getState().installCustomGate('outer', {
      qubits: 1,
      operations: [{ id: 'o1', gate: 'inner', targets: [0], column: 0 }],
    })
    expect(store.getState().removeCustomGate('inner')).toMatchObject({
      ok: false,
      reason: 'custom-gate-in-use',
    })
  })
})

describe('editing a definition', () => {
  function packaged(): CircuitStore {
    const store = bellStore()
    store.getState().packageSelection('bellPair', { symbol: 'B' })
    store.getState().placeCustomGate('bellPair', 2)
    return store
  }

  it('opens the body as the document and says how many uses will change', () => {
    const store = packaged()
    expect(store.getState().openDefinition('bellPair').ok).toBe(true)

    const state = store.getState()
    expect(state.definitionEdit).toMatchObject({
      name: 'bellPair',
      symbol: 'B',
      uses: 2,
    })
    // The canvas is now the block's own body: two wires, no classical
    // register, the two gates that make a Bell pair.
    expect(state.circuit.qubits).toBe(2)
    expect(state.circuit.clbits).toBe(0)
    expect(state.circuit.operations.map((o) => o.gate)).toEqual(['h', 'cx'])
  })

  it('changes every use at once when applied', () => {
    const store = packaged()
    store.getState().openDefinition('bellPair')
    store.getState().placeGate('z', [1], 2)
    expect(store.getState().applyDefinition().ok).toBe(true)

    const { circuit, definitionEdit } = store.getState()
    expect(definitionEdit).toBeNull()
    expect(circuit.customGates?.bellPair?.operations).toHaveLength(3)
    // Both uses are the name, so both grew the Z. Six gates for two uses.
    expect(gateCount(circuit)).toBe(6)
    expect(depth(circuit)).toBe(3)
    expectValid(store)
  })

  it('leaves the circuit alone when cancelled', () => {
    const store = packaged()
    const before = store.getState().circuit
    store.getState().openDefinition('bellPair')
    store.getState().placeGate('z', [1], 2)
    expect(store.getState().cancelDefinition().ok).toBe(true)

    expect(store.getState().circuit).toBe(before)
    expect(store.getState().definitionEdit).toBeNull()
  })

  /*
   * The refusal that makes the shared-by-reference decision safe: the register
   * and the parameter list are the calling convention, and there is no honest
   * guess about which wire a new one should be.
   */
  it('refuses a change that reshapes the uses already placed', () => {
    const store = packaged()
    store.getState().openDefinition('bellPair')
    store.getState().addQubit()
    expect(store.getState().applyDefinition()).toMatchObject({
      ok: false,
      reason: 'custom-gate-reshaped',
    })
    // Still inside the definition, so nothing is lost and the way out is
    // either to undo the extra wire or to cancel.
    expect(store.getState().definitionEdit?.name).toBe('bellPair')
  })

  it('allows a reshape when nothing uses the definition yet', () => {
    const store = storeOf()
    store.getState().installCustomGate('spare', {
      qubits: 1,
      operations: [{ id: 's1', gate: 'x', targets: [0], column: 0 }],
    })
    store.getState().openDefinition('spare')
    store.getState().addQubit()
    expect(store.getState().applyDefinition().ok).toBe(true)
    expect(store.getState().circuit.customGates?.spare?.qubits).toBe(2)
  })

  it('offers duplication as the way to branch instead of edit', () => {
    const store = packaged()
    expect(
      store.getState().duplicateCustomGate('bellPair', 'bellPair2').ok
    ).toBe(true)
    store.getState().openDefinition('bellPair2')
    store.getState().placeGate('z', [1], 2)
    store.getState().applyDefinition()

    const { circuit } = store.getState()
    expect(circuit.customGates?.bellPair?.operations).toHaveLength(2)
    expect(circuit.customGates?.bellPair2?.operations).toHaveLength(3)
  })

  it('refuses to open a second definition while one is open', () => {
    const store = packaged()
    store.getState().openDefinition('bellPair')
    expect(store.getState().openDefinition('bellPair')).toMatchObject({
      ok: false,
      reason: 'definition-open',
    })
  })

  it('ends the session when a whole document replaces the host', () => {
    const store = packaged()
    store.getState().openDefinition('bellPair')
    store.getState().loadCircuit(emptyCircuit(2))
    expect(store.getState().definitionEdit).toBeNull()
  })
})

describe('small pure helpers', () => {
  it('finds the first column with the block’s wires free', () => {
    const circuit: Circuit = {
      ...emptyCircuit(4),
      operations: [
        { id: 'a', gate: 'h', targets: [0], column: 0 },
        { id: 'b', gate: 'h', targets: [1], column: 1 },
      ],
    }
    expect(firstFreeColumn(circuit, 0, 2)).toBe(2)
    expect(firstFreeColumn(circuit, 2, 2)).toBe(0)
  })

  it('names the calling convention the way the panel prints it', () => {
    expect(signatureOf('turn', { qubits: 1, operations: [] })).toBe('turn')
    expect(
      signatureOf('turn', { qubits: 1, params: ['a', 'b'], operations: [] })
    ).toBe('turn(a, b)')
  })

  it('reports what a definition change breaks', () => {
    const base = { qubits: 2, params: ['a'], operations: [] }
    expect(reshapesUses(base, base)).toBeNull()
    expect(reshapesUses(base, { ...base, qubits: 3 })).toBe('qubits')
    expect(reshapesUses(base, { ...base, params: ['a', 'b'] })).toBe('params')
  })

  it('seeds the definition editor with the angles the host was showing', () => {
    const document = definitionAsDocument(
      { qubits: 1, params: ['theta'], operations: [] },
      new Map([['theta', 1.75]])
    )
    expect(document.parameters).toEqual([{ name: 'theta', value: 1.75 }])
    expect(document.clbits).toBe(0)
  })

  it('packages nothing but what was asked for', () => {
    const circuit: Circuit = {
      ...emptyCircuit(3),
      operations: [{ id: 'a', gate: 'h', targets: [1], column: 3 }],
    }
    const result = packageFragment(circuit, ['a'], 'one', { instanceId: 'x' })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.packaged.definition.operations[0]).toMatchObject({
      targets: [0],
      column: 0,
    })
    expect(result.packaged.instance).toMatchObject({
      targets: [1],
      column: 3,
    })
  })
})
