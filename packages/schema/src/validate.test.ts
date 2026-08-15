import { describe, expect, it } from 'vitest'

import {
  CircuitValidationError,
  parseCircuit,
  safeParseCircuit,
  validateCircuit,
  type ValidationIssue,
} from './validate.js'
import { emptyCircuit } from './helpers.js'

/** A 3-qubit, 2-clbit circuit with whatever the test needs bolted on. */
function circuit(overrides: Record<string, unknown> = {}): unknown {
  return {
    schemaVersion: 1,
    qubits: 3,
    clbits: 2,
    operations: [],
    ...overrides,
  }
}

function problems(input: unknown): readonly ValidationIssue[] {
  const result = safeParseCircuit(input)
  if (result.ok) throw new Error('expected this circuit to be rejected')
  return result.issues
}

/** Asserts the circuit fails for exactly one reason, and returns it. */
function onlyProblem(input: unknown): ValidationIssue {
  const issues = problems(input)
  // Mapped to messages so a failure prints something readable.
  expect(issues.map((issue) => issue.message)).toHaveLength(1)
  return issues[0]!
}

describe('one gate per qubit per column', () => {
  it('rejects two operations sharing a target in one column', () => {
    const issue = onlyProblem(
      circuit({
        operations: [
          { id: 'op_1', gate: 'h', targets: [1], column: 0 },
          { id: 'op_2', gate: 'x', targets: [1], column: 0 },
        ],
      })
    )
    expect(issue.code).toBe('column-conflict')
    expect(issue.message).toContain('"op_1" and "op_2"')
    expect(issue.message).toContain('qubit 1 in column 0')
  })

  it('counts a control wire as occupying its qubit', () => {
    const issue = onlyProblem(
      circuit({
        operations: [
          { id: 'op_1', gate: 'h', targets: [1], column: 2 },
          { id: 'op_2', gate: 'cx', targets: [2], controls: [1], column: 2 },
        ],
      })
    )
    expect(issue.code).toBe('column-conflict')
    expect(issue.message).toContain('qubit 1 in column 2')
  })

  it('allows the same qubit in different columns', () => {
    const result = safeParseCircuit(
      circuit({
        operations: [
          { id: 'op_1', gate: 'h', targets: [1], column: 0 },
          { id: 'op_2', gate: 'x', targets: [1], column: 1 },
        ],
      })
    )
    expect(result.ok).toBe(true)
  })
})

describe('indices within the registers', () => {
  it('rejects a target beyond the qubit count', () => {
    const issue = onlyProblem(
      circuit({
        operations: [{ id: 'op_1', gate: 'h', targets: [3], column: 0 }],
      })
    )
    expect(issue.code).toBe('qubit-out-of-range')
    expect(issue.message).toContain('"op_1"')
    expect(issue.message).toContain('qubit 3 as a target')
    expect(issue.message).toContain('0 to 2')
  })

  it('rejects a control beyond the qubit count', () => {
    const issue = onlyProblem(
      circuit({
        operations: [
          { id: 'op_1', gate: 'cx', targets: [0], controls: [7], column: 0 },
        ],
      })
    )
    expect(issue.code).toBe('qubit-out-of-range')
    expect(issue.message).toContain('qubit 7 as a control')
  })

  it('rejects a clbitTarget beyond the classical register', () => {
    const issue = onlyProblem(
      circuit({
        operations: [
          {
            id: 'op_1',
            gate: 'measure',
            targets: [0],
            clbitTargets: [5],
            column: 0,
          },
        ],
      })
    )
    expect(issue.code).toBe('clbit-out-of-range')
    expect(issue.message).toContain('"op_1"')
    expect(issue.message).toContain('classical bit 5')
  })

  it('rejects a condition on a classical bit that does not exist', () => {
    const issue = onlyProblem(
      circuit({
        clbits: 1,
        operations: [
          {
            id: 'op_1',
            gate: 'x',
            targets: [0],
            column: 0,
            condition: { clbit: 4, equals: 1 },
          },
        ],
      })
    )
    expect(issue.code).toBe('clbit-out-of-range')
    expect(issue.message).toContain('conditioned on classical bit 4')
  })
})

describe('a qubit cannot play two roles', () => {
  it('rejects an operation whose target is also its control', () => {
    const issue = onlyProblem(
      circuit({
        operations: [
          { id: 'op_1', gate: 'cx', targets: [1], controls: [1], column: 0 },
        ],
      })
    )
    expect(issue.code).toBe('target-control-overlap')
    expect(issue.message).toContain('"op_1"')
    expect(issue.message).toContain('both a target and a control')
  })

  it('rejects a repeated target', () => {
    const issue = onlyProblem(
      circuit({
        operations: [{ id: 'op_1', gate: 'swap', targets: [1, 1], column: 0 }],
      })
    )
    expect(issue.code).toBe('repeated-qubit')
    expect(issue.message).toContain('qubit 1 twice')
  })
})

describe('parameters', () => {
  it('rejects a symbolic reference that was never declared', () => {
    const issue = onlyProblem(
      circuit({
        operations: [
          {
            id: 'op_1',
            gate: 'rz',
            targets: [0],
            params: ['theta'],
            column: 0,
          },
        ],
      })
    )
    expect(issue.code).toBe('unknown-parameter')
    expect(issue.message).toContain('"op_1"')
    expect(issue.message).toContain('"theta"')
  })

  it('accepts a reference that is declared', () => {
    const result = safeParseCircuit(
      circuit({
        parameters: [{ name: 'theta', value: 0.5 }],
        operations: [
          {
            id: 'op_1',
            gate: 'rz',
            targets: [0],
            params: ['theta'],
            column: 0,
          },
        ],
      })
    )
    expect(result.ok).toBe(true)
  })

  it('rejects a name declared twice', () => {
    const issue = onlyProblem(
      circuit({
        parameters: [
          { name: 'theta', value: 0.5 },
          { name: 'theta', value: 1.5 },
        ],
      })
    )
    expect(issue.code).toBe('duplicate-parameter')
    expect(issue.message).toContain('"theta"')
  })
})

describe('gates match the catalog', () => {
  it('rejects a gate that is neither built in nor custom', () => {
    const issue = onlyProblem(
      circuit({
        operations: [{ id: 'op_1', gate: 'hadamard', targets: [0], column: 0 }],
      })
    )
    expect(issue.code).toBe('unknown-gate')
    expect(issue.message).toContain('"op_1"')
    expect(issue.message).toContain('"hadamard"')
  })

  it('rejects the wrong number of targets', () => {
    const issue = onlyProblem(
      circuit({
        operations: [{ id: 'op_1', gate: 'swap', targets: [0], column: 0 }],
      })
    )
    expect(issue.code).toBe('arity-mismatch')
    expect(issue.message).toContain('"swap"')
    expect(issue.message).toContain('takes exactly 2')
  })

  it('rejects the wrong number of parameters', () => {
    const issue = onlyProblem(
      circuit({
        operations: [{ id: 'op_1', gate: 'rz', targets: [0], column: 0 }],
      })
    )
    expect(issue.code).toBe('param-count-mismatch')
    expect(issue.message).toContain('0 parameter(s)')
    expect(issue.message).toContain('takes exactly 1')
  })

  it('rejects too many parameters', () => {
    const issue = onlyProblem(
      circuit({
        operations: [
          { id: 'op_1', gate: 'u', targets: [0], params: [0, 1], column: 0 },
        ],
      })
    )
    expect(issue.code).toBe('param-count-mismatch')
    expect(issue.message).toContain('takes exactly 3')
  })

  it('rejects a controlled gate without its control', () => {
    const issue = onlyProblem(
      circuit({
        operations: [{ id: 'op_1', gate: 'cx', targets: [0], column: 0 }],
      })
    )
    expect(issue.code).toBe('control-count-mismatch')
    expect(issue.message).toContain('"cx"')
    expect(issue.message).toContain('exactly 1')
  })

  it('rejects extra controls on a gate that does not take them', () => {
    const issue = onlyProblem(
      circuit({
        operations: [
          {
            id: 'op_1',
            gate: 'swap',
            targets: [0, 1],
            controls: [2],
            column: 0,
          },
        ],
      })
    )
    expect(issue.code).toBe('control-count-mismatch')
  })

  it('rejects a measurement with nowhere to write', () => {
    const issue = onlyProblem(
      circuit({
        operations: [{ id: 'op_1', gate: 'measure', targets: [0], column: 0 }],
      })
    )
    expect(issue.code).toBe('clbit-target-mismatch')
    expect(issue.message).toContain('"op_1"')
  })

  it('rejects clbitTargets on a gate that writes no classical bits', () => {
    const issue = onlyProblem(
      circuit({
        operations: [
          {
            id: 'op_1',
            gate: 'h',
            targets: [0],
            clbitTargets: [0],
            column: 0,
          },
        ],
      })
    )
    expect(issue.code).toBe('clbit-target-mismatch')
    expect(issue.message).toContain('does not write to the classical register')
  })

  it('accepts a barrier across any number of qubits', () => {
    const result = safeParseCircuit(
      circuit({
        operations: [
          { id: 'op_1', gate: 'barrier', targets: [0, 1, 2], column: 0 },
        ],
      })
    )
    expect(result.ok).toBe(true)
  })
})

describe('operation ids', () => {
  it('rejects the same id twice', () => {
    const issue = onlyProblem(
      circuit({
        operations: [
          { id: 'op_1', gate: 'h', targets: [0], column: 0 },
          { id: 'op_1', gate: 'h', targets: [1], column: 0 },
        ],
      })
    )
    expect(issue.code).toBe('duplicate-operation-id')
    expect(issue.message).toContain('"op_1"')
  })
})

describe('qubit labels', () => {
  it('rejects a label list that does not cover every qubit', () => {
    const issue = onlyProblem(circuit({ qubitLabels: ['alice', 'bob'] }))
    expect(issue.code).toBe('qubit-label-count')
    expect(issue.message).toContain('2 entries')
    expect(issue.message).toContain('3 qubits')
  })
})

describe('custom gates', () => {
  const bellPair = {
    qubits: 2,
    operations: [
      { id: 'cg_1', gate: 'h', targets: [0], column: 0 },
      { id: 'cg_2', gate: 'cx', targets: [1], controls: [0], column: 1 },
    ],
  }

  it('accepts an operation that calls one', () => {
    const result = safeParseCircuit(
      circuit({
        customGates: { bellPair },
        operations: [
          { id: 'op_1', gate: 'bellPair', targets: [0, 1], column: 0 },
        ],
      })
    )
    expect(result.ok).toBe(true)
  })

  it('checks the call against the custom gate width', () => {
    const issue = onlyProblem(
      circuit({
        customGates: { bellPair },
        operations: [{ id: 'op_1', gate: 'bellPair', targets: [0], column: 0 }],
      })
    )
    expect(issue.code).toBe('arity-mismatch')
    expect(issue.message).toContain('takes exactly 2')
  })

  it('validates the body against the custom gate own register', () => {
    const issue = onlyProblem(
      circuit({
        customGates: {
          wide: {
            qubits: 2,
            operations: [{ id: 'cg_1', gate: 'h', targets: [5], column: 0 }],
          },
        },
      })
    )
    expect(issue.code).toBe('qubit-out-of-range')
    expect(issue.customGate).toBe('wide')
    expect(issue.message).toContain('Custom gate "wide"')
    expect(issue.message).toContain('"cg_1"')
  })

  it('rejects a gate that contains itself directly', () => {
    const issue = onlyProblem(
      circuit({
        customGates: {
          loop: {
            qubits: 2,
            operations: [
              { id: 'cg_1', gate: 'loop', targets: [0, 1], column: 0 },
            ],
          },
        },
      })
    )
    expect(issue.code).toBe('custom-gate-cycle')
    expect(issue.message).toContain('loop → loop')
  })

  it('rejects a gate that contains itself transitively', () => {
    const issues = problems(
      circuit({
        customGates: {
          a: {
            qubits: 2,
            operations: [{ id: 'a_1', gate: 'b', targets: [0, 1], column: 0 }],
          },
          b: {
            qubits: 2,
            operations: [{ id: 'b_1', gate: 'a', targets: [0, 1], column: 0 }],
          },
        },
      })
    )
    const cycle = issues.find((issue) => issue.code === 'custom-gate-cycle')
    expect(cycle?.message).toContain('a → b → a')
  })

  /*
   * The two hazards a plain object brings to a lookup keyed by untrusted text.
   * Both were reachable from a `?c=` link.
   */
  it.each([
    'toString',
    'constructor',
    'valueOf',
    'hasOwnProperty',
    'isPrototypeOf',
    '__defineGetter__',
    '__proto__',
  ])('reports "%s" as an unknown gate, not as an inherited one', (name) => {
    const issue = onlyProblem(
      circuit({
        operations: [{ id: 'op_1', gate: name, targets: [0], column: 0 }],
      })
    )
    expect(issue.code).toBe('unknown-gate')
    expect(issue.message).toContain('neither in the gate catalog')
    // The shape of the defect this pins: an inherited member resolved as a
    // gate and its arity was compared against `undefined`.
    expect(issue.message).not.toContain('undefined')
  })

  it('refuses a definition the record parser cannot carry', () => {
    // `__proto__` matches `IdentifierSchema`, and `z.record` writes onto an
    // object literal — so this entry used to disappear and the circuit was
    // accepted with `customGates: {}`, silently discarding part of an
    // untrusted document.
    const declared = Object.create(null) as Record<string, unknown>
    declared['__proto__'] = { polluted: true }
    const issue = onlyProblem(circuit({ customGates: declared }))
    expect(issue.code).toBe('shape')
    expect(issue.message).toContain('__proto__')
    // And nothing was written to the prototype on the way through.
    expect(({} as Record<string, unknown>).polluted).toBeUndefined()
  })

  it('refuses it even when the definition itself is well formed', () => {
    const declared = Object.create(null) as Record<string, unknown>
    declared['__proto__'] = bellPair
    declared['fine'] = bellPair
    const issue = onlyProblem(circuit({ customGates: declared }))
    expect(issue.code).toBe('shape')
    expect(issue.message).toContain('__proto__')
  })
})

describe('reporting', () => {
  it('returns every problem, not just the first', () => {
    const issues = problems(
      circuit({
        qubitLabels: ['only one'],
        operations: [
          { id: 'op_1', gate: 'h', targets: [9], column: 0 },
          { id: 'op_2', gate: 'nope', targets: [0], column: 1 },
        ],
      })
    )
    expect(issues.map((issue) => issue.code).sort()).toEqual([
      'qubit-label-count',
      'qubit-out-of-range',
      'unknown-gate',
    ])
  })

  it('throws a CircuitValidationError carrying the issues', () => {
    const bad = circuit({
      operations: [{ id: 'op_1', gate: 'h', targets: [9], column: 0 }],
    })
    expect(() => parseCircuit(bad)).toThrow(CircuitValidationError)
    try {
      parseCircuit(bad)
      expect.unreachable('parseCircuit should have thrown')
    } catch (error) {
      expect(error).toBeInstanceOf(CircuitValidationError)
      const issues = (error as CircuitValidationError).issues
      expect(issues[0]?.operationId).toBe('op_1')
      expect((error as Error).message).toContain('Invalid circuit (1 problem)')
    }
  })

  it('says nothing about a circuit that is fine', () => {
    expect(validateCircuit(emptyCircuit(3, 2))).toEqual([])
  })
})
