/**
 * Angles: what an expression evaluates to, and what it refuses to be.
 *
 * The second half is the interesting one. Inside a `gate` body an angle may
 * name a formal parameter, which the contract can carry — and may *compute*
 * with one, which it cannot. Refusing that is not a failure: the caller catches
 * it and inlines the definition at each call site, where the parameter has a
 * value. Getting that boundary wrong in either direction either drops a
 * definition that could have been a block, or produces a block whose angles are
 * wrong.
 */

import { describe, expect, it } from 'vitest'

import { evaluate, evaluateSymbolic, NotRepresentable } from './expressions.js'
import { QasmImportError } from './errors.js'
import { parseProgram } from './parser.js'
import type { QasmExpr, QasmGateCall } from './ast.js'

/** The first argument of the first statement of a one-line program. */
function angle(text: string): QasmExpr {
  const program = parseProgram(`qubit[1] q;\nrz(${text}) q[0];`)
  const call = program.statements[0] as QasmGateCall
  return call.args[0] as QasmExpr
}

function value(text: string): number {
  return evaluate(angle(text), new Map())
}

describe('arithmetic', () => {
  it.each([
    ['1', 1],
    ['1 + 2', 3],
    ['1 - 2 - 3', -4],
    ['2 * 3 + 1', 7],
    ['1 + 2 * 3', 7],
    ['(1 + 2) * 3', 9],
    ['8 / 2 / 2', 2],
    ['2 ** 3 ** 2', 512],
    ['2 ^ 3', 8],
    ['2 ** -1', 0.5],
  ])('reads %s', (text, expected) => {
    expect(value(text)).toBeCloseTo(expected, 12)
  })

  it('binds a unary sign tighter than an addition', () => {
    // `-1 + 2` is 1 and `-(1 + 2)` is −3, and a parser that recursed into the
    // whole expression from its unary rule produces the second.
    expect(value('-1 + 2')).toBe(1)
    expect(value('- -3')).toBe(3)
  })
})

describe('constants', () => {
  it.each([
    ['pi', Math.PI],
    ['π', Math.PI],
    ['tau', 2 * Math.PI],
    ['τ', 2 * Math.PI],
    ['euler', Math.E],
    ['ℇ', Math.E],
  ])('reads %s', (text, expected) => {
    expect(value(text)).toBe(expected)
  })

  it('gives the Unicode and ASCII spellings the same double', () => {
    // Not merely close: the same entry of the same table, so the two spellings
    // cannot drift into two angles.
    expect(value('π/2')).toBe(value('pi/2'))
  })
})

describe('functions', () => {
  it.each([
    ['sin(0)', 0],
    ['cos(0)', 1],
    ['sqrt(4)', 2],
    ['ln(1)', 0],
    ['exp(0)', 1],
    ['arctan(1)', Math.PI / 4],
    ['floor(1.7)', 1],
  ])('reads %s', (text, expected) => {
    expect(value(text)).toBeCloseTo(expected, 12)
  })

  it('names a function it does not have', () => {
    const error = capture(() => value('popcount(3)'))
    expect(error.code).toBe('unsupported')
    expect(error.construct).toBe('popcount')
  })

  it('refuses a result that is not a finite angle', () => {
    // `1/0` and `ln(0)` are both writable and neither is a number the gate
    // catalog has a meaning at; caught here so the reader gets a line rather
    // than a RangeError three files away.
    expect(capture(() => value('1/0')).code).toBe('semantic')
    expect(capture(() => value('ln(0)')).code).toBe('semantic')
  })

  it('names an identifier that is not a constant', () => {
    const error = capture(() => value('theta'))
    expect(error.code).toBe('semantic')
    expect(error.message).toContain('theta')
  })
})

describe('a formal parameter of the gate being defined', () => {
  const FORMALS = new Set(['theta', 'phi'])

  it('answers the name when the angle is exactly the name', () => {
    expect(evaluateSymbolic(angle('theta'), FORMALS)).toEqual({
      formal: 'theta',
    })
  })

  it('answers a number when no formal appears', () => {
    expect(evaluateSymbolic(angle('pi/2'), FORMALS)).toBe(Math.PI / 2)
  })

  it.each(['theta/2', '-theta', 'theta + phi', 'sin(theta)', '2*theta'])(
    'refuses to carry %s, so the definition is inlined instead',
    (text) => {
      expect(() => evaluateSymbolic(angle(text), FORMALS)).toThrow(
        NotRepresentable
      )
    }
  )

  it('lets a formal shadow a constant', () => {
    // The language's own scoping, and the only reading under which a definition
    // means the same thing after being copied into another document (§3.1).
    expect(evaluateSymbolic(angle('pi'), new Set(['pi']))).toEqual({
      formal: 'pi',
    })
  })
})

function capture(action: () => unknown): QasmImportError {
  try {
    action()
  } catch (cause) {
    if (cause instanceof QasmImportError) return cause
    throw cause
  }
  throw new Error('expected a QasmImportError')
}
