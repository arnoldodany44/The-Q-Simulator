import {
  CIRCUIT_SCHEMA_VERSION,
  parseCircuit,
  type Circuit,
} from '@qsim/schema'
import { describe, expect, it } from 'vitest'

import { toCircuitJson } from './json.js'

/**
 * The native export has one job — lose nothing — and one property that only
 * matters because people put these files in repositories: the same circuit
 * must produce the same bytes however the object was built.
 */

const FULL: Circuit = {
  schemaVersion: CIRCUIT_SCHEMA_VERSION,
  qubits: 3,
  clbits: 2,
  qubitLabels: ['alice', 'shared', 'bob'],
  parameters: [{ name: 'theta', value: 0.7853981634 }],
  operations: [
    { id: 'op_1', gate: 'h', targets: [0], column: 0 },
    { id: 'op_2', gate: 'cx', targets: [2], controls: [1], column: 1 },
    {
      id: 'op_3',
      gate: 'rz',
      targets: [0],
      params: ['theta'],
      column: 2,
    },
    {
      id: 'op_4',
      gate: 'x',
      targets: [1],
      controls: [{ qubit: 0, state: 0 }],
      column: 3,
    },
    {
      id: 'op_5',
      gate: 'measure',
      targets: [0],
      clbitTargets: [0],
      column: 4,
    },
    {
      id: 'op_6',
      gate: 'x',
      targets: [2],
      column: 5,
      condition: { clbit: 0, equals: 1 },
    },
  ],
  customGates: {
    bellPair: {
      qubits: 2,
      symbol: 'B',
      operations: [{ id: 'g_1', gate: 'h', targets: [0], column: 0 }],
    },
  },
}

describe('toCircuitJson', () => {
  it('round-trips through the contract parser unchanged', () => {
    expect(parseCircuit(JSON.parse(toCircuitJson(FULL)))).toEqual(FULL)
  })

  it('is stable however the object was assembled', () => {
    // The same circuit with every key inserted in the opposite order. A plain
    // `JSON.stringify` would produce different bytes for this, and a file
    // people commit would then show a diff nobody made.
    const shuffled = {
      operations: FULL.operations.map((operation) =>
        Object.fromEntries(Object.entries(operation).reverse())
      ),
      customGates: FULL.customGates,
      parameters: FULL.parameters,
      qubitLabels: FULL.qubitLabels,
      clbits: FULL.clbits,
      qubits: FULL.qubits,
      schemaVersion: FULL.schemaVersion,
    } as unknown as Circuit

    expect(toCircuitJson(shuffled)).toBe(toCircuitJson(FULL))
  })

  it('writes the schema version first and the operations in document order', () => {
    const text = toCircuitJson(FULL)
    expect(text.split('\n')[1]).toBe('  "schemaVersion": 1,')
    expect(text.indexOf('"qubits"')).toBeLessThan(text.indexOf('"clbits"'))
    expect(text.indexOf('"op_1"')).toBeLessThan(text.indexOf('"op_2"'))
  })

  it('omits an absent optional field rather than writing null', () => {
    const bare: Circuit = {
      schemaVersion: CIRCUIT_SCHEMA_VERSION,
      qubits: 1,
      clbits: 0,
      operations: [{ id: 'op_1', gate: 'x', targets: [0], column: 0 }],
    }
    const text = toCircuitJson(bare)
    expect(text).not.toContain('null')
    expect(text).not.toContain('qubitLabels')
    // `null` would not parse back: the schema's optionals are absent or valid,
    // never empty.
    expect(() => parseCircuit(JSON.parse(text))).not.toThrow()
  })

  it('is a file: two-space indent, one trailing newline', () => {
    const text = toCircuitJson(FULL)
    expect(text.endsWith('}\n')).toBe(true)
    expect(text).toContain('\n  "qubits": 3,')
  })
})
