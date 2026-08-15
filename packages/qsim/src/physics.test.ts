/**
 * The tests that decide whether the engine is right — specification §13.
 *
 * A wrong sign in the kernel throws no exception. It produces a state that is
 * still normalised, still plausible on screen, and simply not the physics.
 * The only defence is comparing against states that are known analytically,
 * and against algebraic identities that a sign error cannot survive.
 */

import fc from 'fast-check'
import { describe, expect, it } from 'vitest'

import {
  apply1q,
  applyControlled,
  applyISwap,
  applySwap,
  type ControlSpec,
} from './apply.js'
import {
  GATE_MATRICES,
  dagger,
  rxMatrix,
  ryMatrix,
  rzMatrix,
  uMatrix,
} from './gates.js'
import {
  alloc,
  clone,
  norm,
  renormalize,
  type Statevector,
} from './statevector.js'

/** Decision D6: tolerance 1e-10, expressed as digits for `toBeCloseTo`. */
const DIGITS = 10
const TOLERANCE = 1e-10
const SQRT1_2 = Math.SQRT1_2

const { h, s, sx, t, x, y, z } = GATE_MATRICES

const positive = (qubit: number): ControlSpec => ({ qubit, state: 1 })

function pseudoState(qubits: number, seed: number): Statevector {
  const state = alloc(qubits)
  let bits = seed >>> 0
  const next = (): number => {
    bits = (Math.imul(bits, 1664525) + 1013904223) >>> 0
    return bits / 0x100000000 - 0.5
  }
  for (let i = 0; i < state.size; i++) {
    state.re[i] = next()
    state.im[i] = next()
  }
  renormalize(state)
  return state
}

function expectSameState(actual: Statevector, expected: Statevector): void {
  for (let i = 0; i < expected.size; i++) {
    expect(actual.re[i], `re[${i}]`).toBeCloseTo(expected.re[i], DIGITS)
    expect(actual.im[i], `im[${i}]`).toBeCloseTo(expected.im[i], DIGITS)
  }
}

/** Every amplitude against an expected `[re, im]` list, in index order. */
function expectAmplitudes(
  state: Statevector,
  expected: readonly (readonly [number, number])[]
): void {
  expect(state.size).toBe(expected.length)
  for (let i = 0; i < expected.length; i++) {
    expect(state.re[i], `re[${i}]`).toBeCloseTo(expected[i][0], DIGITS)
    expect(state.im[i], `im[${i}]`).toBeCloseTo(expected[i][1], DIGITS)
  }
}

describe('states with a known closed form', () => {
  it('builds the Bell pair (H on q0, CNOT q0→q1)', () => {
    const state = alloc(2)
    apply1q(state, h, 0)
    applyControlled(state, x, 1, [positive(0)])

    expectAmplitudes(state, [
      [SQRT1_2, 0],
      [0, 0],
      [0, 0],
      [SQRT1_2, 0],
    ])
    expect(norm(state)).toBeCloseTo(1, DIGITS)
  })

  it('builds GHZ-3 (H on q0, CNOT q0→q1, CNOT q1→q2)', () => {
    const state = alloc(3)
    apply1q(state, h, 0)
    applyControlled(state, x, 1, [positive(0)])
    applyControlled(state, x, 2, [positive(1)])

    expectAmplitudes(state, [
      [SQRT1_2, 0],
      [0, 0],
      [0, 0],
      [0, 0],
      [0, 0],
      [0, 0],
      [0, 0],
      [SQRT1_2, 0],
    ])
    expect(norm(state)).toBeCloseTo(1, DIGITS)
  })

  it('entangles the same way when the CNOT points the other way', () => {
    // H on q1 then CNOT q1→q0 is the same Bell pair: the correlation is
    // between the qubits, not between a qubit and an index.
    const state = alloc(2)
    apply1q(state, h, 1)
    applyControlled(state, x, 0, [positive(1)])
    expectAmplitudes(state, [
      [SQRT1_2, 0],
      [0, 0],
      [0, 0],
      [SQRT1_2, 0],
    ])
  })

  it('spreads |0…0⟩ evenly under a wall of Hadamards', () => {
    const state = alloc(4)
    for (let q = 0; q < 4; q++) apply1q(state, h, q)
    for (let i = 0; i < state.size; i++) {
      expect(state.re[i], `re[${i}]`).toBeCloseTo(0.25, DIGITS)
      expect(state.im[i], `im[${i}]`).toBeCloseTo(0, DIGITS)
    }
  })
})

describe('gate identities', () => {
  it('H·H = I', () => {
    const state = pseudoState(3, 101)
    const before = clone(state)
    apply1q(state, h, 1)
    apply1q(state, h, 1)
    expectSameState(state, before)
  })

  it('X·Y·Z = iI', () => {
    // Applied right to left, so Z first. The result is the original state
    // multiplied by i: (re, im) → (-im, re).
    const state = pseudoState(2, 202)
    const before = clone(state)
    apply1q(state, z, 0)
    apply1q(state, y, 0)
    apply1q(state, x, 0)
    for (let i = 0; i < state.size; i++) {
      expect(state.re[i], `re[${i}]`).toBeCloseTo(-before.im[i], DIGITS)
      expect(state.im[i], `im[${i}]`).toBeCloseTo(before.re[i], DIGITS)
    }
  })

  it('T⁸ = I', () => {
    const state = pseudoState(2, 303)
    const before = clone(state)
    for (let k = 0; k < 8; k++) apply1q(state, t, 1)
    expectSameState(state, before)
  })

  it('S² = Z', () => {
    const twice = pseudoState(3, 404)
    const once = clone(twice)
    apply1q(twice, s, 2)
    apply1q(twice, s, 2)
    apply1q(once, z, 2)
    expectSameState(twice, once)
  })

  it('√X² = X', () => {
    const twice = pseudoState(3, 505)
    const once = clone(twice)
    apply1q(twice, sx, 0)
    apply1q(twice, sx, 0)
    apply1q(once, x, 0)
    expectSameState(twice, once)
  })

  it('SWAP·SWAP = I and iSWAP⁴ = I', () => {
    const swapped = pseudoState(3, 606)
    const before = clone(swapped)
    applySwap(swapped, 0, 2)
    applySwap(swapped, 0, 2)
    expectSameState(swapped, before)

    const iswapped = pseudoState(3, 707)
    const iBefore = clone(iswapped)
    for (let k = 0; k < 4; k++) applyISwap(iswapped, 1, 2)
    expectSameState(iswapped, iBefore)
  })
})

describe('norm preservation', () => {
  it('holds after every gate of a mixed circuit', () => {
    const state = alloc(5)
    const check = (label: string): void => {
      expect(Math.abs(norm(state) - 1), label).toBeLessThan(TOLERANCE)
    }

    apply1q(state, h, 0)
    check('h')
    apply1q(state, t, 1)
    check('t')
    apply1q(state, sx, 2)
    check('sx')
    apply1q(state, rxMatrix(0.63), 3)
    check('rx')
    apply1q(state, ryMatrix(-1.4), 4)
    check('ry')
    apply1q(state, rzMatrix(2.2), 0)
    check('rz')
    applyControlled(state, x, 1, [positive(0)])
    check('cx')
    applyControlled(state, z, 3, [positive(2)])
    check('cz')
    applyControlled(state, x, 4, [positive(0), positive(1)])
    check('ccx')
    applyControlled(state, uMatrix(0.4, -0.9, 1.3), 2, [{ qubit: 4, state: 0 }])
    check('negatively controlled u')
    applySwap(state, 0, 4)
    check('swap')
    applySwap(state, 1, 3, [positive(2)])
    check('cswap')
    applyISwap(state, 2, 3)
    check('iswap')
  })

  it('survives a thousand gates without drifting past the tolerance', () => {
    // D6 renormalises every 64 gates in the runner; this asserts the drift
    // the runner is protecting against is genuinely slow, so that interval is
    // a comfortable margin rather than a load-bearing one.
    const state = alloc(6)
    for (let k = 0; k < 1000; k++) {
      apply1q(state, uMatrix(0.31 * k, 0.11 * k, -0.07 * k), k % 6)
    }
    expect(Math.abs(norm(state) - 1)).toBeLessThan(TOLERANCE)
  })
})

describe('property: unitaries are invertible (fast-check)', () => {
  const angle = fc.double({ min: -7, max: 7, noNaN: true })
  const seed = fc.integer({ min: 0, max: 2 ** 30 })
  const qubit = fc.integer({ min: 0, max: 3 })

  it('U† undoes U on any state, on any qubit', () => {
    fc.assert(
      fc.property(
        angle,
        angle,
        angle,
        qubit,
        seed,
        (theta, phi, lambda, target, s0) => {
          const state = pseudoState(4, s0)
          const before = clone(state)
          const matrix = uMatrix(theta, phi, lambda)
          apply1q(state, matrix, target)
          apply1q(state, dagger(matrix), target)
          expectSameState(state, before)
        }
      )
    )
  })

  it('U preserves the norm, controlled or not', () => {
    fc.assert(
      fc.property(
        angle,
        angle,
        angle,
        qubit,
        seed,
        fc.boolean(),
        (theta, phi, lambda, target, s0, controlled) => {
          const state = pseudoState(4, s0)
          const matrix = uMatrix(theta, phi, lambda)
          const controls: ControlSpec[] = controlled
            ? [{ qubit: (target + 1) % 4, state: 1 }]
            : []
          applyControlled(state, matrix, target, controls)
          expect(Math.abs(norm(state) - 1)).toBeLessThan(TOLERANCE)
        }
      )
    )
  })

  it('a controlled U is undone by the same controls and U†', () => {
    fc.assert(
      fc.property(
        angle,
        angle,
        angle,
        qubit,
        seed,
        (theta, phi, lambda, target, s0) => {
          const state = pseudoState(4, s0)
          const before = clone(state)
          const matrix = uMatrix(theta, phi, lambda)
          const controls: ControlSpec[] = [
            { qubit: (target + 1) % 4, state: 1 },
            { qubit: (target + 2) % 4, state: 0 },
          ]
          applyControlled(state, matrix, target, controls)
          applyControlled(state, dagger(matrix), target, controls)
          expectSameState(state, before)
        }
      )
    )
  })
})
