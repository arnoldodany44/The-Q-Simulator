import { describe, expect, it } from 'vitest'

import { CIRCUIT_SCHEMA_VERSION, type CircuitInput } from './circuit.js'
import { parseCircuit, safeParseCircuit } from './validate.js'

/**
 * The circuit printed in specification §6, verbatim except that `bellPair`'s
 * body — elided as a comment in the document — is spelled out here.
 */
const SPECIFICATION_EXAMPLE = {
  schemaVersion: 1,
  qubits: 3,
  clbits: 2,
  qubitLabels: ['alice', 'shared', 'bob'],
  parameters: [{ name: 'theta', value: 0.7853981634 }],
  operations: [
    { id: 'op_1', gate: 'h', targets: [0], column: 0 },
    { id: 'op_2', gate: 'cx', targets: [2], controls: [1], column: 1 },
    { id: 'op_3', gate: 'rz', targets: [0], params: ['theta'], column: 2 },
    {
      id: 'op_4',
      gate: 'measure',
      targets: [0],
      clbitTargets: [0],
      column: 3,
    },
    {
      id: 'op_5',
      gate: 'x',
      targets: [2],
      column: 4,
      condition: { clbit: 0, equals: 1 },
    },
  ],
  customGates: {
    bellPair: {
      qubits: 2,
      operations: [
        { id: 'cg_1', gate: 'h', targets: [0], column: 0 },
        { id: 'cg_2', gate: 'cx', targets: [1], controls: [0], column: 1 },
      ],
    },
  },
}

/**
 * Wraps one operation in the smallest circuit that can hold it: the same
 * three qubits, two classical bits and `theta` the example declares.
 */
function circuitWith(operation: unknown): unknown {
  return {
    schemaVersion: 1,
    qubits: 3,
    clbits: 2,
    parameters: SPECIFICATION_EXAMPLE.parameters,
    operations: [operation],
  }
}

describe('specification §6 example', () => {
  it('validates as a whole', () => {
    const circuit = parseCircuit(SPECIFICATION_EXAMPLE)
    expect(circuit.qubits).toBe(3)
    expect(circuit.operations).toHaveLength(5)
    expect(circuit.customGates?.bellPair?.qubits).toBe(2)
  })

  it.each(SPECIFICATION_EXAMPLE.operations)(
    'validates operation $id in isolation',
    (operation) => {
      expect(safeParseCircuit(circuitWith(operation)).ok).toBe(true)
    }
  )

  it('keeps every field it was given', () => {
    const circuit = parseCircuit(SPECIFICATION_EXAMPLE)
    expect(circuit.operations[2]).toEqual({
      id: 'op_3',
      gate: 'rz',
      targets: [0],
      params: ['theta'],
      column: 2,
    })
    expect(circuit.qubitLabels).toEqual(['alice', 'shared', 'bob'])
    expect(circuit.parameters).toEqual([{ name: 'theta', value: 0.7853981634 }])
  })
})

describe('shape', () => {
  it('defaults clbits to 0 when the circuit has no classical register', () => {
    const circuit = parseCircuit({
      schemaVersion: CIRCUIT_SCHEMA_VERSION,
      qubits: 2,
      operations: [],
    })
    expect(circuit.clbits).toBe(0)
  })

  it('rejects unknown keys instead of silently dropping them', () => {
    const result = safeParseCircuit({
      ...SPECIFICATION_EXAMPLE,
      qbits: 3, // a typo that must not pass for "no qubits given"
    })
    expect(result.ok).toBe(false)
  })

  it('rejects a misspelled operation field', () => {
    // `target` instead of `targets` would otherwise parse as an operation
    // with no targets at all.
    const result = safeParseCircuit(
      circuitWith({ id: 'op_1', gate: 'h', target: [0], column: 0 })
    )
    expect(result.ok).toBe(false)
  })

  it('names the offending operation in a shape error', () => {
    const result = safeParseCircuit(
      circuitWith({ id: 'op_bad', gate: 'h', targets: [0], column: -1 })
    )
    if (result.ok) throw new Error('expected the circuit to be rejected')
    expect(result.issues[0]?.code).toBe('shape')
    expect(result.issues[0]?.operationId).toBe('op_bad')
    expect(result.issues[0]?.message).toContain('operations[0].column')
  })

  it('pins schemaVersion to an exact version', () => {
    const result = safeParseCircuit({
      ...SPECIFICATION_EXAMPLE,
      schemaVersion: 2,
    })
    expect(result.ok).toBe(false)
  })

  it('rejects non-integer, infinite and negative counts', () => {
    for (const qubits of [
      0,
      1.5,
      -1,
      29,
      Number.NaN,
      Number.POSITIVE_INFINITY,
    ]) {
      const result = safeParseCircuit({
        schemaVersion: 1,
        qubits,
        operations: [],
      })
      expect(result.ok, `qubits: ${qubits}`).toBe(false)
    }
  })

  it('rejects a parameter value that is not a finite number', () => {
    const result = safeParseCircuit({
      schemaVersion: 1,
      qubits: 1,
      operations: [],
      parameters: [{ name: 'theta', value: Number.NaN }],
    })
    expect(result.ok).toBe(false)
  })

  it('rejects a parameter name QASM could not spell', () => {
    const result = safeParseCircuit({
      schemaVersion: 1,
      qubits: 1,
      operations: [],
      parameters: [{ name: '2 theta', value: 0 }],
    })
    expect(result.ok).toBe(false)
  })
})

describe('controls', () => {
  it('accepts the plain-number form', () => {
    const circuit = parseCircuit(
      circuitWith({
        id: 'op_1',
        gate: 'cx',
        targets: [0],
        controls: [1],
        column: 0,
      })
    )
    expect(circuit.operations[0]?.controls).toEqual([1])
  })

  it('accepts the object form, including a negative control', () => {
    const circuit = parseCircuit(
      circuitWith({
        id: 'op_1',
        gate: 'cx',
        targets: [0],
        controls: [{ qubit: 1, state: 0 }],
        column: 0,
      })
    )
    expect(circuit.operations[0]?.controls).toEqual([{ qubit: 1, state: 0 }])
  })

  it('rejects a control state that is neither 0 nor 1', () => {
    const result = safeParseCircuit(
      circuitWith({
        id: 'op_1',
        gate: 'cx',
        targets: [0],
        controls: [{ qubit: 1, state: 2 }],
        column: 0,
      })
    )
    expect(result.ok).toBe(false)
  })

  it('lets a 1-qubit gate carry extra controls (§3.1)', () => {
    const result = safeParseCircuit(
      circuitWith({
        id: 'op_1',
        gate: 'h',
        targets: [0],
        controls: [1, { qubit: 2, state: 0 }],
        column: 0,
      })
    )
    expect(result.ok).toBe(true)
  })
})

describe('CircuitInput', () => {
  it('types a document written by hand, before defaults are applied', () => {
    // Compile-time assertion: omitting `clbits` is legal input.
    const input: CircuitInput = {
      schemaVersion: CIRCUIT_SCHEMA_VERSION,
      qubits: 1,
      operations: [{ id: 'op_1', gate: 'h', targets: [0], column: 0 }],
    }
    expect(parseCircuit(input).clbits).toBe(0)
  })
})
