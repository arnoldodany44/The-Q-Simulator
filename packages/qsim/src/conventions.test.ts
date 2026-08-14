import { describe, expect, it } from 'vitest'

import {
  bitOf,
  clearBit,
  flipBit,
  formatKet,
  setBit,
  stateSize,
} from './conventions.js'

describe('qubit ordering (D1: little-endian)', () => {
  it('treats qubit 0 as the least significant bit', () => {
    // index 5 = 0b101 → q0=1, q1=0, q2=1
    expect(bitOf(5, 0)).toBe(1)
    expect(bitOf(5, 1)).toBe(0)
    expect(bitOf(5, 2)).toBe(1)
  })

  it('prints kets highest-qubit-first, the way Qiskit does', () => {
    expect(formatKet(5, 3)).toBe('101')
    expect(formatKet(1, 3)).toBe('001')
    expect(formatKet(4, 3)).toBe('100')
  })

  it('places a flip on qubit 0 at index 1, not index 4', () => {
    // This is the assertion that would fail under big-endian ordering.
    // An X gate on qubit 0 must move |000⟩ to index 1.
    expect(flipBit(0, 0)).toBe(1)
    expect(flipBit(0, 2)).toBe(4)
  })

  it('sizes the state space as 2^n', () => {
    expect(stateSize(0)).toBe(1)
    expect(stateSize(3)).toBe(8)
    expect(stateSize(20)).toBe(1_048_576)
  })

  it('sets, clears and flips bits without touching the others', () => {
    expect(setBit(0b000, 1)).toBe(0b010)
    expect(setBit(0b010, 1)).toBe(0b010)
    expect(clearBit(0b111, 1)).toBe(0b101)
    expect(clearBit(0b101, 1)).toBe(0b101)
    expect(flipBit(0b101, 1)).toBe(0b111)
    expect(flipBit(0b111, 1)).toBe(0b101)
  })
})
