import { describe, expect, it } from 'vitest'

import {
  GATES,
  GATE_IDS,
  VARIABLE_ARITY,
  isGateId,
  lookupGate,
  type GateId,
} from './gates.js'

describe('catalog coverage (specification §3.1)', () => {
  it.each([
    ['i', 1, 0],
    ['x', 1, 0],
    ['y', 1, 0],
    ['z', 1, 0],
    ['h', 1, 0],
    ['s', 1, 0],
    ['sdg', 1, 0],
    ['t', 1, 0],
    ['tdg', 1, 0],
    ['sx', 1, 0],
  ] as const)('has 1-qubit gate %s', (id, arity, paramCount) => {
    const gate = GATES[id]
    expect(gate.category).toBe('single')
    expect(gate.arity).toBe(arity)
    expect(gate.paramCount).toBe(paramCount)
    expect(gate.acceptsControls).toBe(true)
  })

  it.each([
    ['rx', 1],
    ['ry', 1],
    ['rz', 1],
    ['p', 1],
    ['u', 3],
  ] as const)('has parametrised gate %s with %i parameter(s)', (id, params) => {
    const gate = GATES[id]
    expect(gate.category).toBe('parametrised')
    expect(gate.arity).toBe(1)
    expect(gate.paramCount).toBe(params)
    expect(gate.acceptsControls).toBe(true)
  })

  it.each([
    ['cx', 1, 1, 0],
    ['cz', 1, 1, 0],
    ['swap', 2, 0, 0],
    ['iswap', 2, 0, 0],
    ['crz', 1, 1, 1],
    ['cp', 1, 1, 1],
  ] as const)(
    'has 2-qubit gate %s as %i target(s) + %i control(s)',
    (id, arity, controls, params) => {
      const gate = GATES[id]
      expect(gate.category).toBe('two')
      expect(gate.arity).toBe(arity)
      expect(gate.controlCount).toBe(controls)
      expect(gate.paramCount).toBe(params)
    }
  )

  it.each([
    ['ccx', 1, 2],
    ['cswap', 2, 1],
  ] as const)('has 3-qubit gate %s', (id, arity, controls) => {
    const gate = GATES[id]
    expect(gate.category).toBe('three')
    expect(gate.arity).toBe(arity)
    expect(gate.controlCount).toBe(controls)
  })

  it.each(['barrier', 'reset', 'measure'] as const)(
    'has structural operation %s',
    (id) => {
      expect(GATES[id].category).toBe('structural')
    }
  )

  it('is the only place a gate can come from', () => {
    // 26 gates: 10 single, 5 parametrised, 6 two-qubit, 2 three-qubit,
    // 3 structural. A change to this number is a change to §3.1.
    expect(GATE_IDS).toHaveLength(26)
  })
})

describe('catalog invariants', () => {
  const entries = GATE_IDS.map((id): [GateId, (typeof GATES)[GateId]] => [
    id,
    GATES[id],
  ])

  it.each(entries)('%s is keyed by its own id', (id, gate) => {
    expect(gate.id).toBe(id)
  })

  it.each(entries)('%s names each of its parameters', (_id, gate) => {
    expect(gate.paramNames).toHaveLength(gate.paramCount)
  })

  it.each(entries)('%s has a display symbol', (_id, gate) => {
    expect(gate.symbol.length).toBeGreaterThan(0)
  })

  it('only lets 1-qubit gates take extra controls (§3.1)', () => {
    for (const [, gate] of entries) {
      if (!gate.acceptsControls) continue
      expect(['single', 'parametrised']).toContain(gate.category)
      expect(gate.arity).toBe(1)
    }
  })

  it('reserves variable arity for the barrier', () => {
    const variable = entries.filter(([, gate]) => gate.arity === VARIABLE_ARITY)
    expect(variable.map(([id]) => id)).toEqual(['barrier'])
  })

  it('lets only measure write to the classical register', () => {
    const writers = entries.filter(([, gate]) => gate.clbitCount > 0)
    expect(writers.map(([id]) => id)).toEqual(['measure'])
    expect(GATES.measure.clbitCount).toBe(1)
  })
})

describe('lookup', () => {
  it('recognises a built-in id', () => {
    expect(isGateId('cswap')).toBe(true)
    expect(lookupGate('cswap')?.symbol).toBe('CSWAP')
  })

  it('does not recognise a custom gate name', () => {
    expect(isGateId('bellPair')).toBe(false)
    expect(lookupGate('bellPair')).toBeUndefined()
  })

  it('is not fooled by inherited object properties', () => {
    expect(isGateId('toString')).toBe(false)
    expect(lookupGate('constructor')).toBeUndefined()
  })
})
