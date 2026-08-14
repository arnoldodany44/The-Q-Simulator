import { describe, expect, it } from 'vitest'

import { MAX_QUBITS, type Circuit, type Operation } from './circuit.js'
import {
  controlsOf,
  depth,
  emptyCircuit,
  gateCount,
  normalizeColumns,
  normalizeControl,
  qubitsOf,
  resolveParams,
} from './helpers.js'
import { safeParseCircuit } from './validate.js'

function op(
  id: string,
  gate: string,
  targets: number[],
  column: number,
  extra: Partial<Operation> = {}
): Operation {
  return { id, gate, targets, column, ...extra }
}

function circuitOf(operations: Operation[], qubits = 3): Circuit {
  return { ...emptyCircuit(qubits, 2), operations }
}

describe('emptyCircuit', () => {
  it('produces a circuit that validates', () => {
    const circuit = emptyCircuit(3)
    expect(circuit).toEqual({
      schemaVersion: 1,
      qubits: 3,
      clbits: 0,
      operations: [],
    })
    expect(safeParseCircuit(circuit).ok).toBe(true)
  })

  it('takes an optional classical register', () => {
    expect(emptyCircuit(2, 2).clbits).toBe(2)
  })

  it('refuses sizes the format cannot hold', () => {
    expect(() => emptyCircuit(0)).toThrow(RangeError)
    expect(() => emptyCircuit(MAX_QUBITS + 1)).toThrow(RangeError)
    expect(() => emptyCircuit(2.5)).toThrow(RangeError)
    expect(() => emptyCircuit(1, -1)).toThrow(RangeError)
  })
})

describe('controls', () => {
  it('reads a bare number as a positive control', () => {
    expect(normalizeControl(2)).toEqual({ qubit: 2, state: 1 })
  })

  it('leaves an explicit negative control alone', () => {
    expect(normalizeControl({ qubit: 2, state: 0 })).toEqual({
      qubit: 2,
      state: 0,
    })
  })

  it('normalizes a mixed list', () => {
    const operation = op('op_1', 'h', [0], 0, {
      controls: [1, { qubit: 2, state: 0 }],
    })
    expect(controlsOf(operation)).toEqual([
      { qubit: 1, state: 1 },
      { qubit: 2, state: 0 },
    ])
    expect(qubitsOf(operation)).toEqual([0, 1, 2])
  })

  it('reports no controls when the field is absent', () => {
    expect(controlsOf(op('op_1', 'h', [0], 0))).toEqual([])
  })
})

describe('gateCount', () => {
  it('counts gates and ignores structure', () => {
    const circuit = circuitOf([
      op('op_1', 'h', [0], 0),
      op('op_2', 'cx', [1], 1, { controls: [0] }),
      op('op_3', 'barrier', [0, 1, 2], 2),
      op('op_4', 'reset', [2], 3),
      op('op_5', 'measure', [0], 4, { clbitTargets: [0] }),
    ])
    expect(gateCount(circuit)).toBe(2)
    expect(circuit.operations).toHaveLength(5)
  })

  it('counts a custom gate as one gate, not as its body', () => {
    const circuit: Circuit = {
      ...circuitOf([op('op_1', 'bellPair', [0, 1], 0)], 2),
      customGates: {
        bellPair: {
          qubits: 2,
          operations: [
            op('cg_1', 'h', [0], 0),
            op('cg_2', 'cx', [1], 1, { controls: [0] }),
          ],
        },
      },
    }
    expect(gateCount(circuit)).toBe(1)
  })
})

describe('depth', () => {
  it('is 0 for an empty circuit', () => {
    expect(depth(emptyCircuit(3))).toBe(0)
  })

  it('counts one column per moment: Bell is 2', () => {
    // q0: H ─●─
    // q1: ───⊕─
    const bell = circuitOf(
      [op('op_1', 'h', [0], 0), op('op_2', 'cx', [1], 1, { controls: [0] })],
      2
    )
    expect(depth(bell)).toBe(2)
  })

  it('charges a multi-qubit gate once, not once per qubit', () => {
    const circuit = circuitOf([op('op_1', 'cx', [1], 0, { controls: [0] })])
    expect(depth(circuit)).toBe(1)
  })

  it('charges parallel operations once', () => {
    // Three gates, one column, one time step.
    const circuit = circuitOf([
      op('op_1', 'h', [0], 0),
      op('op_2', 'h', [1], 0),
      op('op_3', 'h', [2], 0),
    ])
    expect(depth(circuit)).toBe(1)
  })

  it('ignores gaps in the column numbering', () => {
    const circuit = circuitOf([
      op('op_1', 'h', [0], 0),
      op('op_2', 'x', [0], 7),
    ])
    expect(depth(circuit)).toBe(2)
    expect(depth(normalizeColumns(circuit))).toBe(depth(circuit))
  })

  it('does not charge for a barrier, the way Qiskit does not', () => {
    // q0: H ─┊─ M
    // q1: X ─┊───
    //     0  1  2   → columns 0 and 2 do work, column 1 is an annotation
    const circuit = circuitOf([
      op('op_1', 'h', [0], 0),
      op('op_2', 'x', [1], 0),
      op('op_3', 'barrier', [0, 1], 1),
      op('op_4', 'measure', [0], 2, { clbitTargets: [0] }),
    ])
    expect(depth(circuit)).toBe(2)
    expect(safeParseCircuit(circuit).ok).toBe(true)
  })

  it('still counts a column a barrier merely shares', () => {
    const circuit = circuitOf([
      op('op_1', 'h', [0], 0),
      op('op_2', 'barrier', [1, 2], 0),
    ])
    expect(depth(circuit)).toBe(1)
  })

  it('counts reset and measure, which are real work', () => {
    const circuit = circuitOf([
      op('op_1', 'reset', [0], 0),
      op('op_2', 'measure', [0], 1, { clbitTargets: [0] }),
    ])
    expect(depth(circuit)).toBe(2)
  })
})

describe('normalizeColumns', () => {
  it('closes the gaps left by editing', () => {
    const circuit = circuitOf([
      op('op_1', 'h', [0], 0),
      op('op_2', 'h', [0], 5),
      op('op_3', 'h', [1], 5),
      op('op_4', 'h', [0], 9),
    ])
    expect(normalizeColumns(circuit).operations.map((o) => o.column)).toEqual([
      0, 1, 1, 2,
    ])
  })

  it('leaves an already tight circuit untouched', () => {
    const circuit = circuitOf([
      op('op_1', 'h', [0], 0),
      op('op_2', 'x', [0], 1),
    ])
    expect(normalizeColumns(circuit)).toEqual(circuit)
  })

  it('preserves operation order and every other field', () => {
    const circuit = circuitOf([
      op('op_1', 'x', [0], 4, { condition: { clbit: 0, equals: 1 } }),
      op('op_2', 'h', [0], 2),
    ])
    const normalized = normalizeColumns(circuit)
    expect(normalized.operations.map((o) => o.id)).toEqual(['op_1', 'op_2'])
    expect(normalized.operations[0]?.column).toBe(1)
    expect(normalized.operations[1]?.column).toBe(0)
    expect(normalized.operations[0]?.condition).toEqual({
      clbit: 0,
      equals: 1,
    })
  })

  it('does not mutate the circuit it was given', () => {
    const circuit = circuitOf([op('op_1', 'h', [0], 6)])
    normalizeColumns(circuit)
    expect(circuit.operations[0]?.column).toBe(6)
  })
})

describe('resolveParams', () => {
  const parameters = [
    { name: 'theta', value: 0.5 },
    { name: 'phi', value: 1.25 },
  ]

  it('passes literal angles through', () => {
    const operation = op('op_1', 'u', [0], 0, { params: [0, 1, 2] })
    expect(resolveParams(operation, parameters)).toEqual([0, 1, 2])
  })

  it('resolves symbolic references, positionally', () => {
    const operation = op('op_1', 'u', [0], 0, { params: ['phi', 0, 'theta'] })
    expect(resolveParams(operation, parameters)).toEqual([1.25, 0, 0.5])
  })

  it('returns nothing for a gate without parameters', () => {
    expect(resolveParams(op('op_1', 'h', [0], 0), parameters)).toEqual([])
  })

  it('throws on a name no validated circuit could contain', () => {
    const operation = op('op_1', 'rz', [0], 0, { params: ['missing'] })
    expect(() => resolveParams(operation, parameters)).toThrow('"missing"')
  })
})
