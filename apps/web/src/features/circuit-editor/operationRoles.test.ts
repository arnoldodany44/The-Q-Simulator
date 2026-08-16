import {
  emptyCircuit,
  GATE_IDS,
  lookupGate,
  type Operation,
  type ParamValue,
} from '@qsim/schema'
import { describe, expect, it } from 'vitest'

import {
  boxLabel,
  clbitLabel,
  describeClassicalCell,
  describeQubitCell,
  formatParams,
  gateSymbol,
  paramLabel,
  qubitLabel,
  registerOperationsAt,
  roleOnQubit,
  targetShape,
  touchesRegister,
} from './operationRoles'

function operation(patch: Partial<Operation>): Operation {
  return { id: 'op', gate: 'h', targets: [0], column: 0, ...patch }
}

describe('roleOnQubit', () => {
  it('separates a target from a control on the same operation', () => {
    const cx = operation({ gate: 'cx', targets: [1], controls: [0] })
    expect(roleOnQubit(cx, 1)).toBe('target')
    expect(roleOnQubit(cx, 0)).toBe('control')
    expect(roleOnQubit(cx, 2)).toBeNull()
  })

  it('distinguishes a negative control, which inverts the gate', () => {
    const negated = operation({ controls: [{ qubit: 1, state: 0 }] })
    expect(roleOnQubit(negated, 1)).toBe('negative-control')
  })

  it('reports both ends of a symmetric two-qubit gate as targets', () => {
    const swap = operation({ gate: 'swap', targets: [0, 3] })
    expect(roleOnQubit(swap, 0)).toBe('target')
    expect(roleOnQubit(swap, 3)).toBe('target')
  })
})

describe('shapes and labels', () => {
  it('falls back to a labelled box for anything unrecognised', () => {
    expect(targetShape('grover_oracle')).toBe('box')
    expect(gateSymbol('grover_oracle')).toBe('grover_oracle')
  })

  it('prefers a custom gate’s own symbol when the circuit declares one', () => {
    const circuit = {
      ...emptyCircuit(2),
      customGates: { oracle: { qubits: 2, operations: [], symbol: 'Uf' } },
    }
    expect(gateSymbol('oracle', circuit)).toBe('Uf')
  })

  /*
   * The reason this mapping exists: the control dot already says
   * "controlled", so a box labelled CZ next to one would claim a second
   * control the circuit does not have.
   */
  it('labels the box of a controlled gate with its base gate', () => {
    expect(boxLabel('cz')).toBe('Z')
    expect(boxLabel('crz')).toBe('Rz')
    expect(boxLabel('cp')).toBe('P')
    expect(boxLabel('h')).toBe('H')
  })

  it('has a shape for every gate in the catalog', () => {
    for (const gate of GATE_IDS) {
      expect(targetShape(gate)).toBeDefined()
      expect(boxLabel(gate).length).toBeGreaterThan(0)
    }
  })

  it('draws the conventional glyphs rather than a box', () => {
    expect(targetShape('cx')).toBe('plus')
    expect(targetShape('ccx')).toBe('plus')
    expect(targetShape('swap')).toBe('cross')
    expect(targetShape('cswap')).toBe('cross')
    expect(targetShape('measure')).toBe('meter')
    expect(targetShape('barrier')).toBe('barrier')
  })

  it('does not draw iSWAP as a plain SWAP', () => {
    // They are different unitaries and used to be the same picture — byte for
    // byte, in an exported file where the picture is all the reader has.
    expect(targetShape('iswap')).not.toBe(targetShape('swap'))
  })

  it('writes a gate’s angles as notation, not as a localised number', () => {
    /*
     * These sit beside `π`, `q0` and `c0 = 1` in a drawing that also travels
     * into a file with no locale in it, so they are notation (D2) — the same
     * π forms the angle field shows beside the slider. The *sentence* a screen
     * reader hears is `formatParams`, which does go through `Intl`.
     */
    const at = (params: ParamValue[]) =>
      paramLabel(operation({ gate: 'rz', targets: [0], params }))

    expect(at([Math.PI / 2])).toBe('π/2')
    expect(at([-3 * (Math.PI / 4)])).toBe('-3π/4')
    expect(at([0])).toBe('0')
    expect(at([0.123456])).toBe('0.1235')
    // A declared parameter is an identifier, not a quantity.
    expect(at(['theta'])).toBe('theta')
    // Nothing at all for a gate that carries no angle: an empty label would
    // still be an element in the exported markup.
    expect(paramLabel(operation({ gate: 'h', targets: [0] }))).toBe('')
  })

  it('bounds the angle label so it cannot sit under the next gate', () => {
    // The label is centred in a 56 px column. Truncation is marked, because a
    // number silently cut in half is worse than one visibly cut.
    const long = paramLabel(
      operation({ gate: 'u', targets: [0], params: [0.12345, 0.6789, 0.98765] })
    )
    expect(long.length).toBeLessThanOrEqual(11)
    expect(long.endsWith('…')).toBe(true)
  })
})

describe('wire names', () => {
  it('numbers unnamed wires and honours named ones', () => {
    const plain = emptyCircuit(3)
    expect(qubitLabel(plain, 2)).toBe('q2')
    expect(qubitLabel({ ...plain, qubitLabels: ['a', 'b', 'c'] }, 1)).toBe('b')
    expect(clbitLabel(4)).toBe('c4')
  })
})

describe('formatParams', () => {
  it('spells parameter names the way the literature does', () => {
    const names = lookupGate('u')?.paramNames ?? []
    expect(formatParams(names, [0, 1, 2], 'en')).toBe('θ = 0, φ = 1, λ = 2')
  })

  /* D2: French uses a decimal comma, and an angle that reads as a thousands
   * separator is worse than showing no angle at all. */
  it('formats numbers for the active locale', () => {
    expect(formatParams(['theta'], [1.5707963], 'en')).toBe('θ = 1.571')
    expect(formatParams(['theta'], [1.5707963], 'fr')).toBe('θ = 1,571')
  })

  it('passes a symbolic parameter through as the identifier it is', () => {
    expect(formatParams(['theta'], ['sweep'], 'fr')).toBe('θ = sweep')
  })
})

describe('the classical register', () => {
  const circuit = emptyCircuit(2, 1)

  const measure = operation({
    id: 'm',
    gate: 'measure',
    targets: [1],
    clbitTargets: [0],
    column: 3,
  })
  const conditional = operation({
    id: 'k',
    gate: 'x',
    targets: [0],
    condition: { clbit: 0, equals: 1 },
    column: 3,
  })
  const plain = operation({ id: 'p', column: 3 })

  it('knows which operations reach it', () => {
    expect(touchesRegister(measure)).toBe(true)
    expect(touchesRegister(conditional)).toBe(true)
    expect(touchesRegister(plain)).toBe(false)
  })

  it('collects every operation in a column that touches it', () => {
    const populated = {
      ...circuit,
      operations: [measure, conditional, plain],
    }
    expect(registerOperationsAt(populated, 3).map((o) => o.id)).toEqual([
      'm',
      'k',
    ])
    expect(registerOperationsAt(populated, 0)).toEqual([])
  })

  it('describes a write and a read differently', () => {
    expect(describeClassicalCell(circuit, measure)).toEqual([
      { kind: 'notation', value: 'c0' },
      {
        kind: 'phrase',
        key: 'canvas.cell.classicalWrite',
        // Names, not a joined string: the view joins them the way the active
        // language joins a list, which a hard-coded ", " never did.
        wires: ['q1'],
      },
    ])
    expect(describeClassicalCell(circuit, conditional)).toEqual([
      {
        kind: 'phrase',
        key: 'canvas.cell.classicalRead',
        values: { clbit: 'c0', value: '1' },
      },
    ])
    expect(describeClassicalCell(circuit, plain)).toEqual([])
  })
})

describe('describeQubitCell', () => {
  const circuit = emptyCircuit(3, 1)

  it('says nothing about a wire the operation does not touch', () => {
    expect(describeQubitCell(circuit, operation({}), 2)).toEqual([])
  })

  it('keeps a bare one-qubit gate to its symbol alone', () => {
    expect(describeQubitCell(circuit, operation({ gate: 'h' }), 0)).toEqual([
      { kind: 'notation', value: 'H' },
    ])
  })

  /* The glyph `⋮` is a drawing, not a word; reading it aloud helps nobody. */
  it('names a barrier instead of reciting its glyph', () => {
    const barrier = operation({ gate: 'barrier', targets: [0, 1, 2] })
    expect(describeQubitCell(circuit, barrier, 1)).toEqual([
      { kind: 'phrase', key: 'canvas.cell.barrier' },
    ])
  })
})
