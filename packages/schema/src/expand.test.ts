import { describe, expect, it } from 'vitest'

import {
  MAX_CUSTOM_GATE_DEPTH,
  type Circuit,
  type CustomGate,
  type Operation,
} from './circuit.js'
import {
  CircuitExpansionError,
  MAX_EXPANDED_OPERATIONS,
  expandCircuit,
  expandedFromColumn,
  expandedThroughColumn,
  inlineOperation,
  safeExpandCircuit,
  sourceColumnOf,
  sourceOperationId,
  usesCustomGates,
} from './expand.js'
import { depth, emptyCircuit, gateCount } from './helpers.js'
import { safeParseCircuit, validateCircuit } from './validate.js'

function op(
  id: string,
  gate: string,
  targets: number[],
  column: number,
  extra: Partial<Operation> = {}
): Operation {
  return { id, gate, targets, column, ...extra }
}

function circuitOf(
  operations: Operation[],
  customGates?: Record<string, CustomGate>,
  qubits = 3
): Circuit {
  return {
    ...emptyCircuit(qubits, 2),
    operations,
    ...(customGates === undefined ? {} : { customGates }),
  }
}

/** h then cx — two columns wide, two qubits tall. */
const BELL: CustomGate = {
  qubits: 2,
  symbol: 'B',
  operations: [
    op('b1', 'h', [0], 0),
    op('b2', 'cx', [1], 1, { controls: [0] }),
  ],
}

describe('usesCustomGates', () => {
  it('is false without a declaration', () => {
    expect(usesCustomGates(circuitOf([op('op_1', 'h', [0], 0)]))).toBe(false)
  })

  it('is false when a declaration exists but nothing uses it', () => {
    expect(
      usesCustomGates(circuitOf([op('op_1', 'h', [0], 0)], { bell: BELL }))
    ).toBe(false)
  })

  it('is true when an operation names one', () => {
    expect(
      usesCustomGates(
        circuitOf([op('op_1', 'bell', [0, 1], 0)], { bell: BELL })
      )
    ).toBe(true)
  })
})

describe('expandCircuit', () => {
  it('returns the same object when there is nothing to expand', () => {
    const circuit = circuitOf([op('op_1', 'h', [0], 0)])
    const expansion = expandCircuit(circuit)
    expect(expansion.changed).toBe(false)
    expect(expansion.circuit).toBe(circuit)
    expect(expansion.columns).toEqual([])
  })

  it('maps a block onto the wires it was placed on', () => {
    const circuit = circuitOf([op('op_1', 'bell', [2, 1], 0)], { bell: BELL })
    const { circuit: flat } = expandCircuit(circuit)

    expect(flat.customGates).toBeUndefined()
    expect(flat.operations).toEqual([
      expect.objectContaining({ gate: 'h', targets: [2], column: 0 }),
      expect.objectContaining({
        gate: 'cx',
        targets: [1],
        controls: [2],
        column: 1,
      }),
    ])
    // The wires are the instance's `targets` in order: body qubit 0 is the
    // first target, body qubit 1 the second — so placing a block "upside down"
    // is a real difference and not a normalisation.
    expect(safeParseCircuit(flat).ok).toBe(true)
  })

  it('pushes everything after a block along by its width', () => {
    const circuit = circuitOf(
      [op('op_1', 'bell', [0, 1], 0), op('op_2', 'x', [2], 1)],
      { bell: BELL }
    )
    const expansion = expandCircuit(circuit)

    expect(expansion.circuit.operations.map((o) => [o.gate, o.column])).toEqual(
      [
        ['h', 0],
        ['cx', 1],
        ['x', 2],
      ]
    )
    expect(expansion.columns).toEqual([
      { source: 0, start: 0, end: 1 },
      { source: 1, start: 2, end: 2 },
    ])
  })

  it('keeps two blocks in one column side by side', () => {
    const circuit = circuitOf(
      [op('op_1', 'bell', [0, 1], 0), op('op_2', 'h', [2], 0)],
      { bell: BELL },
      4
    )
    const expansion = expandCircuit(circuit)

    // The one-qubit gate shares the block's first instant; the block still
    // claims both columns, so the source column is two wide.
    expect(expansion.columns).toEqual([{ source: 0, start: 0, end: 1 }])
    expect(
      expansion.circuit.operations.map((o) => [o.gate, o.targets[0], o.column])
    ).toEqual([
      ['h', 0, 0],
      ['cx', 1, 1],
      ['h', 2, 0],
    ])
  })

  it('gives a top-level primitive its own id back and traces the rest', () => {
    const circuit = circuitOf(
      [op('op_1', 'bell', [0, 1], 0), op('op_2', 'x', [2], 1)],
      { bell: BELL }
    )
    const expansion = expandCircuit(circuit)
    const ids = expansion.circuit.operations.map((o) => o.id)

    expect(ids).toContain('op_2')
    expect(new Set(ids).size).toBe(ids.length)
    for (const id of ids) {
      const origin = sourceOperationId(expansion, id)
      expect(['op_1', 'op_2']).toContain(origin)
    }
    expect(sourceOperationId(expansion, 'op_2')).toBe('op_2')
  })

  it('never mints an id a source operation already holds', () => {
    const circuit = circuitOf(
      [op('~0', 'bell', [0, 1], 0), op('~1', 'x', [2], 1)],
      { bell: BELL }
    )
    const ids = expandCircuit(circuit).circuit.operations.map((o) => o.id)
    expect(new Set(ids).size).toBe(ids.length)
    expect(safeParseCircuit(expandCircuit(circuit).circuit).ok).toBe(true)
  })

  it('memoises on the circuit object', () => {
    const circuit = circuitOf([op('op_1', 'bell', [0, 1], 0)], { bell: BELL })
    expect(expandCircuit(circuit)).toBe(expandCircuit(circuit))
  })
})

describe('expandCircuit, parameters', () => {
  const rotate: CustomGate = {
    qubits: 1,
    params: ['angle'],
    operations: [op('r1', 'rz', [0], 0, { params: ['angle'] })],
  }

  it('binds a literal argument into the body', () => {
    const circuit = circuitOf(
      [op('op_1', 'rotate', [1], 0, { params: [0.5] })],
      {
        rotate,
      }
    )
    expect(expandCircuit(circuit).circuit.operations).toEqual([
      expect.objectContaining({ gate: 'rz', targets: [1], params: [0.5] }),
    ])
  })

  it('carries a circuit-level parameter name through the binding', () => {
    const circuit: Circuit = {
      ...circuitOf([op('op_1', 'rotate', [0], 0, { params: ['theta'] })], {
        rotate,
      }),
      parameters: [{ name: 'theta', value: 0.25 }],
    }
    // A sweep still reaches a gate inside a block: the argument was symbolic,
    // so the emitted operation is symbolic too.
    expect(expandCircuit(circuit).circuit.operations[0]?.params).toEqual([
      'theta',
    ])
    expect(validateCircuit(circuit)).toEqual([])
  })

  it('binds through a nested definition', () => {
    const twice: CustomGate = {
      qubits: 1,
      params: ['a'],
      operations: [
        op('t1', 'rotate', [0], 0, { params: ['a'] }),
        op('t2', 'rotate', [0], 1, { params: ['a'] }),
      ],
    }
    const circuit = circuitOf(
      [op('op_1', 'twice', [2], 0, { params: [1.5] })],
      { rotate, twice }
    )
    const flat = expandCircuit(circuit).circuit
    expect(flat.operations).toEqual([
      expect.objectContaining({
        gate: 'rz',
        targets: [2],
        params: [1.5],
        column: 0,
      }),
      expect.objectContaining({
        gate: 'rz',
        targets: [2],
        params: [1.5],
        column: 1,
      }),
    ])
  })

  it("does not let a body read the circuit's parameters", () => {
    const leaky: CustomGate = {
      qubits: 1,
      operations: [op('l1', 'rz', [0], 0, { params: ['theta'] })],
    }
    const circuit: Circuit = {
      ...circuitOf([op('op_1', 'leaky', [0], 0)], { leaky }),
      parameters: [{ name: 'theta', value: 0.25 }],
    }
    expect(validateCircuit(circuit).map((issue) => issue.code)).toContain(
      'unknown-parameter'
    )
    expect(() => expandCircuit(circuit)).toThrow(CircuitExpansionError)
  })
})

describe('expandCircuit, conditions', () => {
  it('applies an instance condition to every operation of the block', () => {
    const circuit = circuitOf(
      [op('op_1', 'bell', [0, 1], 0, { condition: { clbit: 0, equals: 1 } })],
      { bell: BELL }
    )
    for (const operation of expandCircuit(circuit).circuit.operations) {
      expect(operation.condition).toEqual({ clbit: 0, equals: 1 })
    }
  })
})

describe('expandCircuit, refusals', () => {
  it('refuses a DAG that doubles past the operation ceiling', () => {
    // Acyclic, tiny, and exponential: each definition uses the previous one
    // twice. This is the case the cycle check cannot see.
    const customGates: Record<string, CustomGate> = {
      g0: { qubits: 1, operations: [op('a', 'x', [0], 0)] },
    }
    for (let level = 1; level <= 24; level++) {
      customGates[`g${level}`] = {
        qubits: 1,
        operations: [
          op('a', `g${level - 1}`, [0], 0),
          op('b', `g${level - 1}`, [0], 1),
        ],
      }
    }
    const circuit = circuitOf([op('op_1', 'g24', [0], 0)], customGates)

    expect(() => expandCircuit(circuit)).toThrow(CircuitExpansionError)
    expect(safeExpandCircuit(circuit)).toBeNull()
    const codes = validateCircuit(circuit).map((issue) => issue.code)
    expect(codes).toContain('custom-gate-too-large')
    // And the counters do not throw on it either.
    expect(Number.isFinite(gateCount(circuit))).toBe(true)
  })

  it('refuses a chain nested past the depth ceiling', () => {
    const customGates: Record<string, CustomGate> = {
      g0: { qubits: 1, operations: [op('a', 'x', [0], 0)] },
    }
    const levels = MAX_CUSTOM_GATE_DEPTH + 4
    for (let level = 1; level <= levels; level++) {
      customGates[`g${level}`] = {
        qubits: 1,
        operations: [op('a', `g${level - 1}`, [0], 0)],
      }
    }
    const circuit = circuitOf([op('op_1', `g${levels}`, [0], 0)], customGates)

    expect(() => expandCircuit(circuit)).toThrow(/nested more than/)
    expect(validateCircuit(circuit).map((issue) => issue.code)).toContain(
      'custom-gate-too-deep'
    )
  })

  it('stays under the operation ceiling it advertises', () => {
    const wide: CustomGate = {
      qubits: 1,
      operations: Array.from({ length: 100 }, (_, index) =>
        op(`w${index}`, 'x', [0], index)
      ),
    }
    const circuit = circuitOf(
      Array.from({ length: 3 }, (_, index) =>
        op(`op_${index}`, 'wide', [0], index)
      ),
      { wide }
    )
    expect(
      expandCircuit(circuit).circuit.operations.length
    ).toBeLessThanOrEqual(MAX_EXPANDED_OPERATIONS)
  })

  it('refuses an unknown gate rather than dropping it', () => {
    const circuit = circuitOf([op('op_1', 'nope', [0], 0)], { bell: BELL })
    // `usesCustomGates` is false — the declaration is unused — so this one
    // never reaches the expander and stays the validator's business.
    expect(expandCircuit(circuit).changed).toBe(false)

    const used = circuitOf(
      [op('op_1', 'bell', [0, 1], 0), op('op_2', 'nope', [2], 1)],
      { bell: BELL }
    )
    expect(() => expandCircuit(used)).toThrow(/nope/)
  })
})

describe('the column map', () => {
  const circuit = circuitOf(
    [
      op('op_1', 'x', [2], 0),
      op('op_2', 'bell', [0, 1], 1),
      op('op_3', 'x', [2], 2),
    ],
    { bell: BELL }
  )
  const expansion = expandCircuit(circuit)

  it('places each source column where its operations went', () => {
    expect(expansion.columns).toEqual([
      { source: 0, start: 0, end: 0 },
      { source: 1, start: 1, end: 2 },
      { source: 2, start: 3, end: 3 },
    ])
  })

  it('answers a scrub position with the end of its block', () => {
    // "Stop after source column 1" is "stop after expanded column 2": the
    // reader asked to see the block finished, not half-run.
    expect(expandedThroughColumn(expansion, -1)).toBe(-1)
    expect(expandedThroughColumn(expansion, 0)).toBe(0)
    expect(expandedThroughColumn(expansion, 1)).toBe(2)
    expect(expandedThroughColumn(expansion, 2)).toBe(3)
    expect(expandedThroughColumn(expansion, 99)).toBe(3)
  })

  it('answers an invalidation point with the start of its block', () => {
    // Rounding the other way: an edit at source column 1 invalidates from the
    // first instant of the block, not from the last.
    expect(expandedFromColumn(expansion, 0)).toBe(0)
    expect(expandedFromColumn(expansion, 1)).toBe(1)
    expect(expandedFromColumn(expansion, 2)).toBe(3)
    expect(expandedFromColumn(expansion, 99)).toBe(4)
  })

  it('maps an engine column back to the column the editor draws', () => {
    expect(sourceColumnOf(expansion, 0)).toBe(0)
    expect(sourceColumnOf(expansion, 1)).toBe(1)
    expect(sourceColumnOf(expansion, 2)).toBe(1)
    expect(sourceColumnOf(expansion, 3)).toBe(2)
    expect(sourceColumnOf(expansion, 9)).toBe(3)
  })

  it('is the identity when nothing was expanded', () => {
    const plain = expandCircuit(circuitOf([op('op_1', 'h', [0], 0)]))
    expect(expandedThroughColumn(plain, 4)).toBe(4)
    expect(expandedFromColumn(plain, 4)).toBe(4)
    expect(sourceColumnOf(plain, 4)).toBe(4)
  })

  it('reports an empty block as taking no time at all', () => {
    const empty = circuitOf(
      [op('op_1', 'nothing', [0], 0), op('op_2', 'x', [0], 1)],
      {
        nothing: { qubits: 1, operations: [] },
      }
    )
    const result = expandCircuit(empty)
    expect(result.columns[0]).toEqual({ source: 0, start: 0, end: -1 })
    // Which is exactly right: the state after source column 0 is the state
    // before anything ran.
    expect(expandedThroughColumn(result, 0)).toBe(-1)
    expect(result.circuit.operations).toEqual([
      expect.objectContaining({ gate: 'x', column: 0 }),
    ])
  })
})

describe('the counters agree with the expansion', () => {
  const circuit = circuitOf(
    [
      op('op_1', 'bell', [0, 1], 0),
      op('op_2', 'barrier', [0, 1, 2], 1),
      op('op_3', 'bell', [1, 2], 2),
    ],
    { bell: BELL }
  )

  it('counts the gates the engine will actually run', () => {
    const flat = expandCircuit(circuit).circuit
    expect(gateCount(circuit)).toBe(gateCount(flat))
    expect(gateCount(circuit)).toBe(4)
  })

  it('counts the instants the engine will actually take', () => {
    const flat = expandCircuit(circuit).circuit
    expect(depth(circuit)).toBe(depth(flat))
    expect(depth(circuit)).toBe(4)
  })
})

describe('inlining leaves the circuit alone', () => {
  /*
   * Packaging a fragment is depth-preserving, and its inverse has to be too —
   * §3.1 decision 3 makes depth a statement about "el número de primitivas que
   * correría el hardware", and §3.6 ranks challenge tables on it. A depth that
   * moves when a block is peeled open would reward leaving gates packaged,
   * which is the exact failure that decision was written to close.
   *
   * The document below is the sharp case: a two-instant block sharing a column
   * with a three-instant one. Expansion gives the column the wider width, so
   * the block's second instant runs *inside* it; inlined, that gate needs a
   * column of its own and lands after the wider sibling. Same gates, same
   * wires, same order — one more occupied column, which is why depth is the
   * critical path and not a count of columns.
   */
  const PAIRED = circuitOf(
    [op('op_1', 'pair', [0], 0), op('op_2', 'triple', [1], 0)],
    {
      pair: {
        qubits: 1,
        operations: [op('a', 'h', [0], 0), op('b', 't', [0], 1)],
      },
      triple: {
        qubits: 1,
        operations: [
          op('c', 'h', [0], 0),
          op('d', 'h', [0], 1),
          op('e', 'h', [0], 2),
        ],
      },
    },
    2
  )

  it('reports the same depth and the same gate count after inlining', () => {
    let minted = 0
    const after = inlineOperation(
      PAIRED,
      'op_1',
      () => `hand_${String(++minted)}`
    )
    expect(after).not.toBeNull()
    if (after === null) return
    expect(gateCount(after)).toBe(gateCount(PAIRED))
    expect(depth(after)).toBe(depth(PAIRED))
  })

  it('reports the same depth however many blocks are peeled', () => {
    let minted = 0
    const mint = () => `hand_${String(++minted)}`
    const once = inlineOperation(PAIRED, 'op_1', mint)
    expect(once).not.toBeNull()
    if (once === null) return
    const twice = inlineOperation(once, 'op_2', mint)
    expect(twice).not.toBeNull()
    if (twice === null) return
    expect(depth(twice)).toBe(depth(PAIRED))
    expect(gateCount(twice)).toBe(gateCount(PAIRED))
  })

  it('refuses to expand a control the contract does not allow on a block', () => {
    /*
     * `validateCircuit` reports `control-count-mismatch` for this and every
     * production path parses first — but this module is also reached with
     * circuits nobody promised had been validated, and it used to drop the
     * control silently. A controlled block that expands to an uncontrolled body
     * is the sharpest case of looking right and counting wrong.
     */
    const controlled = circuitOf(
      [
        op('op_1', 'h', [2], 0),
        op('op_2', 'blk', [0, 1], 1, { controls: [2] }),
      ],
      {
        blk: {
          qubits: 2,
          operations: [op('a', 'x', [0], 0), op('b', 'x', [1], 1)],
        },
      }
    )
    expect(validateCircuit(controlled).map((issue) => issue.code)).toContain(
      'control-count-mismatch'
    )
    expect(() => expandCircuit(controlled)).toThrow(CircuitExpansionError)
    expect(safeExpandCircuit(controlled)).toBeNull()
  })
})
