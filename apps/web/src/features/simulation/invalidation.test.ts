// @vitest-environment node
import { parseCircuit, type Circuit, type CircuitInput } from '@qsim/schema'
import { describe, expect, it } from 'vitest'

import { earliestChangedColumn } from './invalidation'

/**
 * The column an edit invalidated.
 *
 * These assertions are the contract the resumed run depends on: name a column
 * that is too late and the runner resumes from a checkpoint the edit already
 * contradicted, which produces a normalised statevector belonging to no
 * circuit and no error anywhere. Every case here therefore pins the *earliest*
 * column, not merely a plausible one.
 */

function circuitOf(input: Omit<CircuitInput, 'schemaVersion'>): Circuit {
  return parseCircuit({ schemaVersion: 1, ...input })
}

const BASE = circuitOf({
  qubits: 2,
  clbits: 1,
  operations: [
    { id: 'a', gate: 'h', targets: [0], column: 0 },
    { id: 'b', gate: 'x', targets: [1], column: 3 },
    { id: 'c', gate: 'cx', targets: [1], controls: [0], column: 9 },
  ],
})

describe('nothing to do', () => {
  it('reports the same object as unchanged', () => {
    expect(earliestChangedColumn(BASE, BASE)).toBeNull()
  })

  it('reports an identical rebuild as unchanged', () => {
    const copy = circuitOf({
      qubits: 2,
      clbits: 1,
      operations: [
        { id: 'a', gate: 'h', targets: [0], column: 0 },
        { id: 'b', gate: 'x', targets: [1], column: 3 },
        { id: 'c', gate: 'cx', targets: [1], controls: [0], column: 9 },
      ],
    })

    expect(earliestChangedColumn(BASE, copy)).toBeNull()
  })

  it('ignores a wire being renamed', () => {
    const renamed: Circuit = { ...BASE, qubitLabels: ['control', 'target'] }

    expect(earliestChangedColumn(BASE, renamed)).toBeNull()
  })

  it('reads the two spellings of a positive control as the same control', () => {
    const spelled: Circuit = {
      ...BASE,
      operations: BASE.operations.map((operation) =>
        operation.id === 'c'
          ? { ...operation, controls: [{ qubit: 0, state: 1 }] }
          : operation
      ),
    }

    expect(earliestChangedColumn(BASE, spelled)).toBeNull()
  })
})

describe('a first circuit', () => {
  it('is a full run', () => {
    expect(earliestChangedColumn(undefined, BASE)).toBe(0)
  })
})

describe('operations', () => {
  it('invalidates from the column a gate was added to', () => {
    const added: Circuit = {
      ...BASE,
      operations: [
        ...BASE.operations,
        { id: 'd', gate: 'y', targets: [0], column: 4 },
      ],
    }

    expect(earliestChangedColumn(BASE, added)).toBe(4)
  })

  it('invalidates from the column a gate was deleted from', () => {
    const deleted: Circuit = {
      ...BASE,
      operations: BASE.operations.filter((operation) => operation.id !== 'b'),
    }

    expect(earliestChangedColumn(BASE, deleted)).toBe(3)
  })

  it('invalidates from the earlier end of a move', () => {
    // Column 9 → column 1: the circuit changed from column 1 onwards, and
    // invalidating from 9 would resume from a checkpoint that still has the
    // gate at its old place.
    const moved: Circuit = {
      ...BASE,
      operations: BASE.operations.map((operation) =>
        operation.id === 'c' ? { ...operation, column: 1 } : operation
      ),
    }

    expect(earliestChangedColumn(BASE, moved)).toBe(1)
  })

  it('invalidates from the earlier end of a move in either direction', () => {
    const moved: Circuit = {
      ...BASE,
      operations: BASE.operations.map((operation) =>
        operation.id === 'a' ? { ...operation, column: 6 } : operation
      ),
    }

    expect(earliestChangedColumn(BASE, moved)).toBe(0)
  })

  it('notices a control appearing on a gate', () => {
    const controlled: Circuit = {
      ...BASE,
      operations: BASE.operations.map((operation) =>
        operation.id === 'b'
          ? { ...operation, gate: 'cx', controls: [0] }
          : operation
      ),
    }

    expect(earliestChangedColumn(BASE, controlled)).toBe(3)
  })

  it('notices a negative control replacing a positive one', () => {
    const negative: Circuit = {
      ...BASE,
      operations: BASE.operations.map((operation) =>
        operation.id === 'c'
          ? { ...operation, controls: [{ qubit: 0, state: 0 as const }] }
          : operation
      ),
    }

    expect(earliestChangedColumn(BASE, negative)).toBe(9)
  })

  it('reports the earliest of several edits at once', () => {
    const many: Circuit = {
      ...BASE,
      operations: [
        ...BASE.operations.filter((operation) => operation.id !== 'c'),
        { id: 'd', gate: 'z', targets: [0], column: 2 },
        { id: 'e', gate: 'z', targets: [1], column: 7 },
      ],
    }

    expect(earliestChangedColumn(BASE, many)).toBe(2)
  })
})

describe('parameters', () => {
  const swept = circuitOf({
    qubits: 2,
    parameters: [{ name: 'theta', value: 0.3 }],
    operations: [
      { id: 'a', gate: 'h', targets: [0], column: 0 },
      { id: 'b', gate: 'rz', targets: [0], params: ['theta'], column: 2 },
      { id: 'c', gate: 'rz', targets: [1], params: ['theta'], column: 6 },
    ],
  })

  it('invalidates from the first column that reads a changed value', () => {
    // The operations are untouched — they still say `['theta']` — so the
    // operation walk alone would call a slider drag a no-op.
    const dragged: Circuit = {
      ...swept,
      parameters: [{ name: 'theta', value: 0.4 }],
    }

    expect(earliestChangedColumn(swept, dragged)).toBe(2)
  })

  it('ignores a value that did not move', () => {
    const same: Circuit = {
      ...swept,
      parameters: [{ name: 'theta', value: 0.3 }],
    }

    expect(earliestChangedColumn(swept, same)).toBeNull()
  })

  it('invalidates from the columns that used to read a removed parameter', () => {
    const dropped: Circuit = {
      ...swept,
      parameters: [],
      operations: swept.operations.map((operation) =>
        operation.params === undefined
          ? operation
          : { ...operation, params: [0.3] }
      ),
    }

    expect(earliestChangedColumn(swept, dropped)).toBe(2)
  })

  it('invalidates from the literal angle that changed', () => {
    const literal = circuitOf({
      qubits: 1,
      operations: [
        { id: 'a', gate: 'rz', targets: [0], params: [0], column: 4 },
      ],
    })
    const turned: Circuit = {
      ...literal,
      operations: [
        { id: 'a', gate: 'rz', targets: [0], params: [1.2], column: 4 },
      ],
    }

    expect(earliestChangedColumn(literal, turned)).toBe(4)
  })
})

describe('the register', () => {
  it('invalidates everything when a qubit is added', () => {
    const wider = circuitOf({
      qubits: 3,
      clbits: 1,
      operations: [...BASE.operations],
    })

    expect(earliestChangedColumn(BASE, wider)).toBe(0)
  })

  it('invalidates everything when the classical register changes', () => {
    const clbits: Circuit = { ...BASE, clbits: 2 }

    expect(earliestChangedColumn(BASE, clbits)).toBe(0)
  })

  it('invalidates everything when a custom gate is redefined', () => {
    const withBlock: Circuit = {
      ...BASE,
      customGates: {
        block: { qubits: 1, operations: [] },
      },
    }

    expect(earliestChangedColumn(BASE, withBlock)).toBe(0)
  })
})
