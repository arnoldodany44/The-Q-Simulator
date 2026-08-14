import { describe, expect, it } from 'vitest'

import {
  MAX_QUBITS,
  RENORMALIZE_INTERVAL,
  alloc,
  amplitude,
  clone,
  norm,
  renormalize,
  reset,
} from './statevector.js'

/**
 * Decision D6 fixes the test tolerance at 1e-10. `toBeCloseTo` takes a number
 * of digits, and 10 digits means |difference| < 0.5e-10 — the same bar,
 * stated the way the matcher wants it, with a readable failure message.
 */
const DIGITS = 10

describe('allocation', () => {
  it('starts every register in |0…0⟩', () => {
    const state = alloc(3)
    expect(state.qubits).toBe(3)
    expect(state.size).toBe(8)
    expect(state.re.length).toBe(8)
    expect(state.im.length).toBe(8)
    expect([...state.re]).toEqual([1, 0, 0, 0, 0, 0, 0, 0])
    expect([...state.im]).toEqual([0, 0, 0, 0, 0, 0, 0, 0])
    expect(norm(state)).toBe(1)
  })

  it('rejects sizes outside [1, MAX_QUBITS]', () => {
    expect(() => alloc(0)).toThrow(RangeError)
    expect(() => alloc(-1)).toThrow(RangeError)
    expect(() => alloc(1.5)).toThrow(RangeError)
    expect(() => alloc(MAX_QUBITS + 1)).toThrow(RangeError)
  })

  it('caps at the 4 GB row of the memory table in §5.1', () => {
    expect(MAX_QUBITS).toBe(28)
  })
})

describe('lifecycle', () => {
  it('reset returns a dirtied state to the ground state', () => {
    const state = alloc(2)
    state.re[0] = 0
    state.re[3] = 0.6
    state.im[3] = 0.8
    reset(state)
    expect([...state.re]).toEqual([1, 0, 0, 0])
    expect([...state.im]).toEqual([0, 0, 0, 0])
  })

  it('norm counts both components of every amplitude', () => {
    const state = alloc(2)
    state.re[0] = 3
    state.im[1] = 4
    expect(norm(state)).toBeCloseTo(5, DIGITS)
  })

  it('renormalize scales to one and reports the norm it found', () => {
    const state = alloc(2)
    state.re[0] = 3
    state.im[1] = 4
    expect(renormalize(state)).toBeCloseTo(5, DIGITS)
    expect(norm(state)).toBeCloseTo(1, DIGITS)
    expect(state.re[0]).toBeCloseTo(0.6, DIGITS)
    expect(state.im[1]).toBeCloseTo(0.8, DIGITS)
  })

  it('refuses to renormalize a state with no norm to speak of', () => {
    const state = alloc(2)
    state.re[0] = 0
    expect(() => renormalize(state)).toThrow(RangeError)
    state.re[0] = NaN
    expect(() => renormalize(state)).toThrow(RangeError)
  })

  it('renormalizes every 64 gates, per decision D6', () => {
    expect(RENORMALIZE_INTERVAL).toBe(64)
  })
})

describe('clone', () => {
  it('copies the amplitudes and shares no buffer', () => {
    const state = alloc(2)
    state.re[0] = Math.SQRT1_2
    state.im[3] = Math.SQRT1_2
    const copy = clone(state)
    expect([...copy.re]).toEqual([...state.re])
    expect([...copy.im]).toEqual([...state.im])
    expect(copy.qubits).toBe(2)
    expect(copy.size).toBe(4)

    // The checkpoint cache of M0.4 depends on this independence.
    state.re[0] = 0
    expect(copy.re[0]).toBeCloseTo(Math.SQRT1_2, DIGITS)
  })
})

describe('amplitude', () => {
  it('reads one amplitude by index', () => {
    const state = alloc(2)
    state.re[2] = 0.5
    state.im[2] = -0.5
    expect(amplitude(state, 2).re).toBeCloseTo(0.5, DIGITS)
    expect(amplitude(state, 2).im).toBeCloseTo(-0.5, DIGITS)
    expect(amplitude(state, 0)).toEqual({ re: 1, im: 0 })
  })

  it('rejects an index outside the state space', () => {
    const state = alloc(2)
    expect(() => amplitude(state, 4)).toThrow(RangeError)
    expect(() => amplitude(state, -1)).toThrow(RangeError)
    expect(() => amplitude(state, 1.5)).toThrow(RangeError)
  })
})
