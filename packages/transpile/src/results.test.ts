import { describe, expect, it } from 'vitest'

import {
  bitsOfSample,
  countsFromSamples,
  invertLayout,
  logicalBitstring,
  sampleValue,
} from './results.js'

describe('sampleValue', () => {
  it('reads the hexadecimal a backend writes', () => {
    expect(sampleValue('0x3')).toBe(3n)
    expect(sampleValue('0X1f')).toBe(31n)
    expect(sampleValue('1f')).toBe(31n)
    expect(sampleValue(' 0x0 ')).toBe(0n)
  })

  it('is exact past 2^53, where a double stops counting', () => {
    // 60 classical bits is inside the contract's ceiling of 64, and a double
    // cannot represent consecutive integers there. `parseInt` would return a
    // value close to this one and never this one.
    const sample = '0xfffffffffffffff'
    expect(sampleValue(sample)).toBe(1152921504606846975n)
    expect(BigInt(Number.parseInt(sample, 16))).not.toBe(sampleValue(sample))
  })

  it('refuses anything that is not a sample', () => {
    for (const bad of ['', '0x', 'zz', '0b101', '3.5', '-1', '0x 3']) {
      expect(() => sampleValue(bad)).toThrowError(/hexadecimal/)
    }
  })
})

describe('bitsOfSample', () => {
  it('writes the highest classical bit first, like formatRegister', () => {
    // 0x2 on two bits is c[1] = 1, c[0] = 0, printed "10".
    expect(bitsOfSample('0x2', 2)).toBe('10')
    expect(bitsOfSample('0x1', 2)).toBe('01')
    expect(bitsOfSample('0x3', 2)).toBe('11')
    expect(bitsOfSample('0x0', 2)).toBe('00')
  })

  it('pads to the register width', () => {
    expect(bitsOfSample('0x1', 5)).toBe('00001')
    expect(bitsOfSample('0x1', 5)).toHaveLength(5)
  })

  it('refuses a sample too wide for the register it was given', () => {
    // A silent truncation here would put every shot in the wrong bucket while
    // the histogram still looked like a histogram.
    expect(() => bitsOfSample('0x4', 2)).toThrowError(/does not fit/)
    expect(() => bitsOfSample('0x3', 2)).not.toThrow()
  })

  it('refuses a register width the contract does not allow', () => {
    expect(() => bitsOfSample('0x0', 0)).toThrowError(/between 1 and 64/)
    expect(() => bitsOfSample('0x0', 65)).toThrowError(/between 1 and 64/)
  })
})

describe('countsFromSamples', () => {
  it('folds a shot list into the keys @qsim/core uses', () => {
    const counts = countsFromSamples(['0x3', '0x0', '0x3', '0x2'], 2)
    expect(counts).toEqual({ '11': 2, '00': 1, '10': 1 })
  })

  it('answers an empty object for no shots', () => {
    expect(countsFromSamples([], 3)).toEqual({})
  })
})

describe('invertLayout', () => {
  it('is sparse, because a two-qubit circuit lives on a 156-qubit chip', () => {
    const inverse = invertLayout([53, 54])
    expect(inverse.get(53)).toBe(0)
    expect(inverse.get(54)).toBe(1)
    expect(inverse.get(0)).toBeUndefined()
    expect(inverse.size).toBe(2)
  })

  it('inverts a layout that is not in order', () => {
    const inverse = invertLayout([9, 2, 7])
    expect([...inverse.entries()].sort()).toEqual([
      [2, 1],
      [7, 2],
      [9, 0],
    ])
  })
})

describe('logicalBitstring', () => {
  it('reindexes a device-wide reading onto the circuit s own qubits', () => {
    // Five physical qubits, highest first: q4 q3 q2 q1 q0 = "10010", so
    // q4 = 1, q1 = 1 and the rest 0. Logical 0 sits on physical 1 and
    // logical 1 on physical 4, so the answer is q(logical 1) q(logical 0) = 11.
    expect(logicalBitstring('10010', [1, 4])).toBe('11')
  })

  it('keeps the highest logical qubit first', () => {
    // Logical 0 on physical 0 (bit "1"), logical 1 on physical 2 (bit "0").
    expect(logicalBitstring('001', [0, 2])).toBe('01')
  })

  it('refuses a physical qubit the reading does not reach', () => {
    expect(() => logicalBitstring('01', [0, 9])).toThrowError(/outside a 2/)
  })
})
