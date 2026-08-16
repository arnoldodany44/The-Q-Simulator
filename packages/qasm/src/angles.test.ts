import { describe, expect, it } from 'vitest'

import { asPiMultiple, formatAngle, usesPi } from './angles.js'

/**
 * An angle literal has one hard requirement — it must read back as the same
 * double — and one soft one: it should look like the angle a person meant.
 * The tests below are mostly about the first, because that is the one whose
 * failure is silent.
 */

describe('formatAngle', () => {
  it.each([
    [Math.PI, 'pi'],
    [-Math.PI, '-pi'],
    [Math.PI / 2, 'pi/2'],
    [-Math.PI / 2, '-pi/2'],
    [Math.PI / 4, 'pi/4'],
    [(3 * Math.PI) / 4, '3*pi/4'],
    [-(3 * Math.PI) / 4, '-3*pi/4'],
    [2 * Math.PI, '2*pi'],
    [Math.PI / 8, 'pi/8'],
  ])('writes %s as %s', (value, expected) => {
    expect(formatAngle(value)).toBe(expected)
  })

  it('writes zero as a float rather than as 0*pi', () => {
    expect(formatAngle(0)).toBe('0.0')
    expect(formatAngle(-0)).toBe('0.0')
  })

  it('always carries a fractional part, so no literal is an integer', () => {
    // `rx(2)` would be an implicit int→float cast in OpenQASM and an `int` in
    // Python. Neither is what the document said.
    expect(formatAngle(2)).toBe('2.0')
    expect(formatAngle(-7)).toBe('-7.0')
  })

  it('prints an angle that is not a multiple of pi as an exact decimal', () => {
    expect(formatAngle(0.30000000000000004)).toBe('0.30000000000000004')
    expect(Number(formatAngle(0.1 + 0.2))).toBe(0.1 + 0.2)
  })

  /**
   * The property that matters: whatever comes out, reading it back gives the
   * same double. `pi/2` counts as read-back because both target languages
   * evaluate it to `Math.PI / 2` in IEEE 754 double arithmetic, which is the
   * same operation this test performs.
   */
  it('round-trips every angle it is given', () => {
    const values = [
      0,
      1,
      -1,
      Math.PI,
      Math.PI / 3,
      Math.E,
      1e-7,
      1234.56789,
      -0.000123456789,
      Number.MAX_SAFE_INTEGER,
      Number.MIN_VALUE,
    ]
    for (const value of values) {
      expect(readBack(formatAngle(value))).toBe(value)
    }
  })

  it('refuses a non-finite angle rather than writing nonsense', () => {
    expect(() => formatAngle(Number.NaN)).toThrow(RangeError)
    expect(() => formatAngle(Number.POSITIVE_INFINITY)).toThrow(RangeError)
  })
})

describe('asPiMultiple', () => {
  it('only recognises the exact double the ratio produces', () => {
    expect(asPiMultiple(Math.PI / 2)).toEqual({
      numerator: 1,
      denominator: 2,
    })
    // One ulp away is a different angle, and saying `pi/2` for it would make
    // the export disagree with the circuit by that ulp. π/2 lies in [1, 2),
    // where the spacing of doubles is exactly 2⁻⁵², so this is the neighbour.
    const nearly = Math.PI / 2 + 2 ** -52
    expect(nearly).not.toBe(Math.PI / 2)
    expect(asPiMultiple(nearly)).toBeNull()
  })

  it('prefers the reduced fraction', () => {
    expect(asPiMultiple((2 * Math.PI) / 4)).toEqual({
      numerator: 1,
      denominator: 2,
    })
  })

  it('answers null for zero and for anything far from a multiple', () => {
    expect(asPiMultiple(0)).toBeNull()
    expect(asPiMultiple(1)).toBeNull()
    expect(asPiMultiple(Number.NaN)).toBeNull()
  })
})

describe('usesPi', () => {
  it('is what tells the Qiskit emitter whether to import pi', () => {
    expect(usesPi([0.5, 1.25])).toBe(false)
    expect(usesPi([0.5, Math.PI / 4])).toBe(true)
    expect(usesPi([])).toBe(false)
  })
})

/** Evaluates the restricted literal grammar both target languages share. */
function readBack(literal: string): number {
  const pi = /^(-?)(?:(\d+)\*)?pi(?:\/(\d+))?$/.exec(literal)
  if (pi === null) return Number(literal)
  const sign = pi[1] === '-' ? -1 : 1
  const numerator = pi[2] === undefined ? 1 : Number(pi[2])
  const denominator = pi[3] === undefined ? 1 : Number(pi[3])
  return (sign * numerator * Math.PI) / denominator
}
