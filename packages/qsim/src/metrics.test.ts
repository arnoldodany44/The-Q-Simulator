/**
 * The Bloch vector, against states whose answer is known on paper (§5.5).
 *
 * A partial trace has the same failure mode as the kernel it reads: get the
 * conjugate on the wrong factor, or the pairing on the wrong bit, and what
 * comes out is still a plausible unit vector pointing somewhere else. So
 * every expectation below is a hand-computed vector for a state with a name,
 * chosen so that each of the three components is pinned by at least one
 * state where the other two are zero — and so that the *sign* of y is pinned
 * twice, by |+i⟩ and by the direction Rz turns the vector, because y is the
 * component whose sign a stray conjugate flips silently.
 *
 * The entangled cases are the milestone: a Bell pair must give |r| = 0 on
 * both halves, and a partly entangled pair must give a length between the
 * two, because "the arrow shrinks" is the lesson this arithmetic exists to
 * draw (§3.2).
 */

import { describe, expect, it } from 'vitest'

import { applyControlled, apply1q, type ControlSpec } from './apply.js'
import { GATE_MATRICES, ryMatrix, rzMatrix } from './gates.js'
import {
  blochOf,
  blochVector,
  blochVectors,
  purity,
  reducedDensity,
  trace,
  type BlochVector,
} from './metrics.js'
import { alloc, type Statevector } from './statevector.js'

/** Decision D6: tolerance 1e-10, as digits for `toBeCloseTo`. */
const DIGITS = 10

const { h, s, sdg, x, z } = GATE_MATRICES

const control = (qubit: number): ControlSpec => ({ qubit, state: 1 })

function expectVector(
  actual: BlochVector,
  expected: readonly [number, number, number]
): void {
  expect(actual.x).toBeCloseTo(expected[0], DIGITS)
  expect(actual.y).toBeCloseTo(expected[1], DIGITS)
  expect(actual.z).toBeCloseTo(expected[2], DIGITS)
  expect(actual.length).toBeCloseTo(Math.hypot(...expected), DIGITS)
}

/** A one-qubit state built by applying `gates` to |0⟩, in order. */
function oneQubit(...gates: readonly Float64Array[]): Statevector {
  const state = alloc(1)
  for (const gate of gates) apply1q(state, gate, 0)
  return state
}

/** H on qubit 0, then CNOT 0 → 1: the Bell pair (Φ⁺). */
function bellPair(): Statevector {
  const state = alloc(2)
  apply1q(state, h, 0)
  applyControlled(state, x, 1, [control(0)])
  return state
}

describe('the six cardinal states', () => {
  it('puts |0⟩ at the north pole', () => {
    expectVector(blochVector(alloc(1), 0), [0, 0, 1])
  })

  it('puts |1⟩ at the south pole', () => {
    expectVector(blochVector(oneQubit(x), 0), [0, 0, -1])
  })

  it('puts |+⟩ on +x', () => {
    expectVector(blochVector(oneQubit(h), 0), [1, 0, 0])
  })

  it('puts |−⟩ on −x', () => {
    expectVector(blochVector(oneQubit(h, z), 0), [-1, 0, 0])
  })

  it('puts |+i⟩ = S·H|0⟩ on +y', () => {
    expectVector(blochVector(oneQubit(h, s), 0), [0, 1, 0])
  })

  it('puts |−i⟩ = S†·H|0⟩ on −y', () => {
    expectVector(blochVector(oneQubit(h, sdg), 0), [0, -1, 0])
  })

  it('gives every one of them unit length and purity 1', () => {
    for (const state of [
      alloc(1),
      oneQubit(x),
      oneQubit(h),
      oneQubit(h, z),
      oneQubit(h, s),
      oneQubit(h, sdg),
    ]) {
      const density = reducedDensity(state, 0)
      expect(blochOf(density).length).toBeCloseTo(1, DIGITS)
      expect(purity(density)).toBeCloseTo(1, DIGITS)
    }
  })
})

describe('rotation directions', () => {
  /*
   * Rz turns the vector about +z by the right-hand rule, so from +x it heads
   * towards +y. This is the second pin on the sign of y, and the one that
   * would survive a reader who mistrusts which of |+i⟩ and |−i⟩ is which:
   * it only asks that a positive angle turn the arrow the positive way.
   */
  it('Rz(φ) on |+⟩ sweeps the equator from +x towards +y', () => {
    for (const phi of [0, Math.PI / 6, Math.PI / 2, 2, Math.PI]) {
      const state = oneQubit(h, rzMatrix(phi))
      expectVector(blochVector(state, 0), [Math.cos(phi), Math.sin(phi), 0])
    }
  })

  it('Ry(θ) on |0⟩ tilts from +z towards +x', () => {
    for (const theta of [0, Math.PI / 4, Math.PI / 2, 1.3]) {
      const state = oneQubit(ryMatrix(theta))
      expectVector(blochVector(state, 0), [Math.sin(theta), 0, Math.cos(theta)])
    }
  })
})

describe('a product state gives each qubit its own vector', () => {
  it('reads H on q0 and X on q1 as +x and −z', () => {
    const state = alloc(2)
    apply1q(state, h, 0)
    apply1q(state, x, 1)

    const vectors = blochVectors(state)
    expect(vectors).toHaveLength(2)
    expectVector(vectors[0], [1, 0, 0])
    expectVector(vectors[1], [0, 0, -1])
  })

  /*
   * The same two gates on a wider register, with the interesting qubits far
   * apart and an untouched wire between them. A partial trace that paired the
   * wrong bit would still answer with unit vectors here — it would simply
   * answer with the wrong qubit's — so the assertion is about *which* wire
   * carries which vector, which is D1 read through this module.
   */
  it('keeps the vectors on the wires that earned them', () => {
    const state = alloc(4)
    apply1q(state, h, 3)
    apply1q(state, x, 0)

    const vectors = blochVectors(state)
    expectVector(vectors[0], [0, 0, -1])
    expectVector(vectors[1], [0, 0, 1])
    expectVector(vectors[2], [0, 0, 1])
    expectVector(vectors[3], [1, 0, 0])
    expect(vectors.map((vector) => vector.qubit)).toEqual([0, 1, 2, 3])
  })
})

describe('entanglement shortens the vector', () => {
  it('collapses both halves of a Bell pair to the centre', () => {
    const state = bellPair()

    for (const qubit of [0, 1]) {
      const density = reducedDensity(state, qubit)
      expectVector(blochOf(density), [0, 0, 0])
      expect(blochOf(density).length).toBeCloseTo(0, DIGITS)
      // ρ = I/2 exactly: both outcomes equally likely, no coherence left.
      expect(density.rho00).toBeCloseTo(0.5, DIGITS)
      expect(density.rho11).toBeCloseTo(0.5, DIGITS)
      expect(density.re01).toBeCloseTo(0, DIGITS)
      expect(density.im01).toBeCloseTo(0, DIGITS)
      expect(purity(density)).toBeCloseTo(0.5, DIGITS)
    }
  })

  it('collapses every qubit of GHZ-3 to the centre', () => {
    const state = alloc(3)
    apply1q(state, h, 0)
    applyControlled(state, x, 1, [control(0)])
    applyControlled(state, x, 2, [control(1)])

    for (const vector of blochVectors(state)) {
      expect(vector.length).toBeCloseTo(0, DIGITS)
    }
  })

  /*
   * Ry(θ) then CNOT gives cos(θ/2)|00⟩ + sin(θ/2)|11⟩, whose reduced matrix
   * is diag(cos²(θ/2), sin²(θ/2)) — so |r| = |cos θ|, sweeping the whole
   * range from a separable state at θ = 0 to a Bell pair at θ = π/2. This is
   * the case that says the length is a *measurement* and not a flag: a
   * renderer that drew a full arrow for anything not maximally entangled
   * would pass every other test in this file.
   */
  it('shortens by exactly cos θ as a pair becomes entangled', () => {
    for (const theta of [0, 0.3, 1, Math.PI / 2, 2.5]) {
      const state = alloc(2)
      apply1q(state, ryMatrix(theta), 0)
      applyControlled(state, x, 1, [control(0)])

      for (const qubit of [0, 1]) {
        const vector = blochVector(state, qubit)
        expect(vector.length).toBeCloseTo(Math.abs(Math.cos(theta)), DIGITS)
        expectVector(vector, [0, 0, Math.cos(theta)])
      }
    }
  })

  it('leaves a spectator qubit at full length beside an entangled pair', () => {
    // Bell pair on q0/q1, and q2 in |+⟩ on its own.
    const state = alloc(3)
    apply1q(state, h, 0)
    applyControlled(state, x, 1, [control(0)])
    apply1q(state, h, 2)

    const vectors = blochVectors(state)
    expect(vectors[0].length).toBeCloseTo(0, DIGITS)
    expect(vectors[1].length).toBeCloseTo(0, DIGITS)
    expectVector(vectors[2], [1, 0, 0])
  })
})

describe('the reduced matrix is a density matrix', () => {
  it('has trace 1 and a real, non-negative diagonal', () => {
    const state = bellPair()
    for (const qubit of [0, 1]) {
      const density = reducedDensity(state, qubit)
      expect(trace(density)).toBeCloseTo(1, DIGITS)
      expect(density.rho00).toBeGreaterThanOrEqual(0)
      expect(density.rho11).toBeGreaterThanOrEqual(0)
    }
  })

  it('relates purity to the length as (1 + |r|²) / 2', () => {
    for (const theta of [0, 0.7, Math.PI / 2]) {
      const state = alloc(2)
      apply1q(state, ryMatrix(theta), 0)
      applyControlled(state, x, 1, [control(0)])

      const density = reducedDensity(state, 0)
      const { length } = blochOf(density)
      expect(purity(density)).toBeCloseTo((1 + length * length) / 2, DIGITS)
    }
  })
})

describe('argument checking', () => {
  it('refuses a qubit outside the register', () => {
    const state = alloc(2)
    expect(() => reducedDensity(state, 2)).toThrow(RangeError)
    expect(() => reducedDensity(state, -1)).toThrow(RangeError)
    expect(() => reducedDensity(state, 1.5)).toThrow(RangeError)
  })

  it('names the qubit and the range it was outside', () => {
    expect(() => reducedDensity(alloc(2), 7)).toThrow(/qubit 7.*\[0, 2\)/)
  })
})
