/**
 * The §3.2 metrics, against states whose answer is known on paper: the Bloch
 * vector (§5.5), the von Neumann entropy of a subsystem, the concurrence of a
 * pair, and fidelity in all four of its forms.
 *
 * THE ONE THING THIS FILE IS BUILT AROUND. A number that merely *detects*
 * entanglement passes almost every obvious test. GHZ and W are both "very
 * entangled" and both give a maximally mixed single qubit under any measure
 * that only knows the difference between zero and non-zero — but their
 * single-qubit entropies are 1 and 0.9183, and their pairwise concurrences
 * are 0 and 2/3. Those two states appear in nearly every describe below,
 * because the gap between them is what separates an implementation of §3.2
 * from a plausible-looking indicator.
 *
 * ────────────────────────────────────────────────────────────────────────
 * The Bloch half of the file, from M1.6:
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
import {
  fromStatevector,
  isHermitian,
  isPositiveSemidefinite,
  entry as densityEntry,
  trace as densityTraceOf,
  type DensityMatrix,
} from './density.js'
import { EigenTooLargeError } from './eigen.js'
import { GATE_MATRICES, ryMatrix, rzMatrix, uMatrix } from './gates.js'
import { probabilities } from './measure.js'
import {
  MAX_SUBSYSTEM_QUBITS,
  binaryEntropy,
  blochOf,
  blochVector,
  blochVectors,
  concurrence,
  concurrenceOf,
  densityFidelity,
  densityStateFidelity,
  distributionFidelity,
  partialTrace,
  partialTraceOfDensity,
  purity,
  qubitEntropy,
  reducedDensity,
  stateFidelity,
  subsystemEntropy,
  trace,
  vonNeumannEntropy,
  type BlochVector,
} from './metrics.js'
import { createRng } from './rng.js'
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

/* ═══════════ states with names, and the numbers they are known by ════════ */

/** GHZ on n qubits: (|0…0⟩ + |1…1⟩)/√2. Built with gates, as a user would. */
function ghz(n: number): Statevector {
  const state = alloc(n)
  apply1q(state, h, 0)
  for (let qubit = 1; qubit < n; qubit++) {
    applyControlled(state, x, qubit, [control(qubit - 1)])
  }
  return state
}

/**
 * W on n qubits: (|10…0⟩ + |01…0⟩ + … )/√n, one excitation shared n ways.
 *
 * Written into the amplitudes directly rather than assembled from rotations.
 * The circuit that prepares a W state is fiddly and its correctness is not
 * what is under test here — a bug in it would show up as a wrong entropy and
 * be blamed on the entropy.
 */
function wState(n: number): Statevector {
  const state = alloc(n)
  state.re[0] = 0
  const amplitude = 1 / Math.sqrt(n)
  for (let qubit = 0; qubit < n; qubit++) state.re[1 << qubit] = amplitude
  return state
}

/**
 * cos(θ/2)|00⟩ + sin(θ/2)|11⟩ — a pair whose entanglement is a dial.
 *
 * Separable at θ = 0, a Bell pair at θ = π/2, and everything between. Its
 * closed forms: each qubit has entropy H₂(cos²(θ/2)) and the pair has
 * concurrence |sin θ|.
 */
function tunablePair(theta: number): Statevector {
  const state = alloc(2)
  apply1q(state, ryMatrix(theta), 0)
  applyControlled(state, x, 1, [control(0)])
  return state
}

/**
 * The Werner state ρ(p) = p·|Φ⁺⟩⟨Φ⁺| + (1−p)·I/4.
 *
 * Its concurrence is max(0, (3p − 1)/2) — a closed form that is a *function*
 * of a parameter rather than a single number, which is what makes it the
 * strongest of the concurrence checks: an implementation can hit 0 and 1 by
 * accident and cannot hit a line by accident. It is also the one family where
 * the entanglement vanishes at a threshold (p = 1/3) while the state stays
 * visibly non-classical, so it catches a clamp applied in the wrong place.
 */
function werner(p: number): DensityMatrix {
  const rho = fromStatevector(bellPair())
  for (let i = 0; i < rho.size; i++) {
    rho.re[i] *= p
    rho.im[i] *= p
  }
  for (let i = 0; i < 4; i++) rho.re[i * 4 + i] += (1 - p) / 4
  return rho
}

/** I/2ⁿ — the state that knows nothing, with entropy exactly n. */
function maximallyMixed(n: number): DensityMatrix {
  const rho = fromStatevector(alloc(n))
  rho.re[0] = 0
  const share = 1 / rho.dim
  for (let i = 0; i < rho.dim; i++) rho.re[i * rho.dim + i] = share
  return rho
}

/** A state with no entanglement anywhere: a different rotation on each wire. */
function productState(n: number, seed: number): Statevector {
  const state = alloc(n)
  const rng = createRng(seed)
  for (let qubit = 0; qubit < n; qubit++) {
    apply1q(
      state,
      uMatrix(rng.next() * Math.PI, rng.next() * 6, rng.next() * 6),
      qubit
    )
  }
  return state
}

/** Every non-empty subset of `[0, n)`, as arrays of qubit indices. */
function subsets(n: number): number[][] {
  const out: number[][] = []
  for (let mask = 1; mask < 1 << n; mask++) {
    const keep: number[] = []
    for (let qubit = 0; qubit < n; qubit++) {
      if ((mask >> qubit) & 1) keep.push(qubit)
    }
    out.push(keep)
  }
  return out
}

/* ═════════════════ the partial trace onto any subsystem ══════════════════ */

describe('the partial trace onto a subsystem', () => {
  it('agrees with the four-number single-qubit form', () => {
    const state = tunablePair(0.9)
    for (const qubit of [0, 1]) {
      const small = reducedDensity(state, qubit)
      const full = partialTrace(state, [qubit])
      expect(full.qubits).toBe(1)
      expect(densityEntry(full, 0, 0).re).toBeCloseTo(small.rho00, DIGITS)
      expect(densityEntry(full, 1, 1).re).toBeCloseTo(small.rho11, DIGITS)
      expect(densityEntry(full, 0, 1).re).toBeCloseTo(small.re01, DIGITS)
      expect(densityEntry(full, 0, 1).im).toBeCloseTo(small.im01, DIGITS)
      // ρ₁₀ = conj(ρ₀₁), the entry the four-number form deliberately omits.
      expect(densityEntry(full, 1, 0).im).toBeCloseTo(-small.im01, DIGITS)
    }
  })

  it('returns a density matrix: Hermitian, unit trace, positive', () => {
    const state = wState(4)
    for (const keep of subsets(4)) {
      const rho = partialTrace(state, keep)
      const label = `keep ${keep.join(',')}`
      expect(densityTraceOf(rho), label).toBeCloseTo(1, DIGITS)
      expect(isHermitian(rho), label).toBe(true)
      expect(isPositiveSemidefinite(rho), label).toBe(true)
    }
  })

  it('puts subsystem bit j on the wire keep[j] named', () => {
    /*
     * D1, applied to a subsystem. |q2 q1 q0⟩ = |100⟩, so keeping [2, 0] puts
     * the set qubit on subsystem bit 0 and the answer is |01⟩ → index 1;
     * keeping [0, 2] puts it on bit 1 and the answer is index 2. Any
     * implementation that sorted `keep` behind the caller's back would give
     * the same matrix twice.
     */
    const state = alloc(3)
    apply1q(state, x, 2)

    const first = partialTrace(state, [2, 0])
    expect(densityEntry(first, 1, 1).re).toBeCloseTo(1, DIGITS)
    const second = partialTrace(state, [0, 2])
    expect(densityEntry(second, 2, 2).re).toBeCloseTo(1, DIGITS)
  })

  it('reproduces |ψ⟩⟨ψ| when nothing is traced out', () => {
    const state = ghz(3)
    const kept = partialTrace(state, [0, 1, 2])
    const outer = fromStatevector(state)
    for (let i = 0; i < outer.size; i++) {
      expect(kept.re[i]).toBeCloseTo(outer.re[i], DIGITS)
      expect(kept.im[i]).toBeCloseTo(outer.im[i], DIGITS)
    }
  })

  it('gives the same answer starting from ρ as from ψ', () => {
    // The mixed-state twin has to agree with the pure one on a pure input,
    // which is the only case where both are defined.
    const state = wState(4)
    const rho = fromStatevector(state)
    for (const keep of [[0], [2], [1, 3], [0, 1, 2]]) {
      const fromPure = partialTrace(state, keep)
      const fromMixed = partialTraceOfDensity(rho, keep)
      for (let i = 0; i < fromPure.size; i++) {
        expect(fromMixed.re[i], `keep ${keep.join(',')}`).toBeCloseTo(
          fromPure.re[i],
          DIGITS
        )
        expect(fromMixed.im[i], `keep ${keep.join(',')}`).toBeCloseTo(
          fromPure.im[i],
          DIGITS
        )
      }
    }
  })

  it('traces a mixed state down to a mixed state', () => {
    // I/2³ reduced onto any pair must be I/2², not something purer: a trace
    // that dropped the off-diagonal environment terms would return a pure
    // state here and look entirely reasonable doing it.
    const rho = maximallyMixed(3)
    const pair = partialTraceOfDensity(rho, [0, 2])
    for (let r = 0; r < 4; r++) {
      for (let c = 0; c < 4; c++) {
        expect(densityEntry(pair, r, c).re).toBeCloseTo(r === c ? 0.25 : 0, 12)
        expect(densityEntry(pair, r, c).im).toBeCloseTo(0, 12)
      }
    }
  })

  it('refuses an empty, repeated or out-of-range subsystem', () => {
    const state = alloc(3)
    expect(() => partialTrace(state, [])).toThrow(RangeError)
    expect(() => partialTrace(state, [1, 1])).toThrow(/twice/)
    expect(() => partialTrace(state, [3])).toThrow(/\[0, 3\)/)
    expect(() => partialTrace(state, [-1])).toThrow(RangeError)
    expect(() => partialTrace(state, [1.5])).toThrow(RangeError)
  })
})

/* ═══════════════════ von Neumann entropy (§3.2) ══════════════════════════ */

describe('von Neumann entropy', () => {
  it('is zero for every subsystem of a product state', () => {
    for (const seed of [1, 2, 3]) {
      const state = productState(4, seed)
      for (const keep of subsets(4)) {
        expect(
          subsystemEntropy(state, keep),
          `seed ${seed} keep ${keep.join(',')}`
        ).toBeCloseTo(0, DIGITS)
      }
    }
  })

  it('is exactly 1 for each half of a Bell pair, and 0 for the pair', () => {
    const state = bellPair()
    expect(subsystemEntropy(state, [0])).toBeCloseTo(1, DIGITS)
    expect(subsystemEntropy(state, [1])).toBeCloseTo(1, DIGITS)
    // The pair together is a pure state, so it has no entropy at all — the
    // check that says the partial trace of "everything" traced out nothing.
    expect(subsystemEntropy(state, [0, 1])).toBeCloseTo(0, DIGITS)
  })

  it('is 1 for any single qubit of GHZ, at every width', () => {
    for (const n of [2, 3, 4, 5]) {
      const state = ghz(n)
      for (let qubit = 0; qubit < n; qubit++) {
        expect(
          subsystemEntropy(state, [qubit]),
          `GHZ-${n} q${qubit}`
        ).toBeCloseTo(1, DIGITS)
      }
    }
  })

  it('is 1 for EVERY proper subsystem of GHZ, not only single qubits', () => {
    // GHZ is a superposition of two basis states, so any partial trace has
    // rank two whatever it keeps: the entropy is one bit for a single qubit
    // and one bit for three of them. This is the case that catches a partial
    // trace which is right on one qubit and wrong on a group.
    const state = ghz(4)
    for (const keep of subsets(4)) {
      if (keep.length === 4) continue
      expect(
        subsystemEntropy(state, keep),
        `keep ${keep.join(',')}`
      ).toBeCloseTo(1, DIGITS)
    }
  })

  it('gives a W state a single-qubit entropy of H₂(1/n), not 1', () => {
    /*
     * THE TEST THAT DISTINGUISHES A CORRECT IMPLEMENTATION FROM ONE THAT
     * MERELY DETECTS ENTANGLEMENT. W and GHZ are both maximally entangled by
     * any yes/no reading, and both give a mixed single qubit. But W_n shares
     * one excitation n ways, so its reduced single-qubit state is
     * diag(1 − 1/n, 1/n) and its entropy is H₂(1/n): 0.9183 at n = 3, 0.8113
     * at n = 4 — near 1 but not 1, and falling as n grows while GHZ stays
     * pinned at exactly 1.
     */
    for (const n of [2, 3, 4, 5]) {
      const state = wState(n)
      const expected = binaryEntropy(1 / n)
      for (let qubit = 0; qubit < n; qubit++) {
        expect(
          subsystemEntropy(state, [qubit]),
          `W-${n} q${qubit}`
        ).toBeCloseTo(expected, DIGITS)
      }
      if (n > 2) {
        expect(expected, `W-${n} must differ from GHZ`).toBeLessThan(0.999)
      }
    }
  })

  it('agrees with itself across a bipartition of a pure state', () => {
    // S(A) = S(Ā) for a pure global state. It is the strongest structural
    // check available without a second implementation: the two sides are
    // different partial traces, of different sizes, over different
    // environments, and they must land on the same number.
    for (const state of [ghz(4), wState(4), productState(4, 9)]) {
      for (const keep of subsets(4)) {
        const rest = [0, 1, 2, 3].filter((qubit) => !keep.includes(qubit))
        if (rest.length === 0) continue
        expect(subsystemEntropy(state, keep)).toBeCloseTo(
          subsystemEntropy(state, rest),
          DIGITS
        )
      }
    }
  })

  it('follows H₂(cos²(θ/2)) as a pair is dialled into entanglement', () => {
    for (const theta of [0, 0.4, 1, Math.PI / 2, 2.2, Math.PI]) {
      const state = tunablePair(theta)
      const c = Math.cos(theta / 2)
      const expected = binaryEntropy(c * c)
      expect(subsystemEntropy(state, [0]), `θ=${theta}`).toBeCloseTo(
        expected,
        DIGITS
      )
      expect(subsystemEntropy(state, [1]), `θ=${theta}`).toBeCloseTo(
        expected,
        DIGITS
      )
    }
  })

  it('gives the maximally mixed state on n qubits an entropy of n', () => {
    for (const n of [1, 2, 3, 4]) {
      expect(vonNeumannEntropy(maximallyMixed(n)), `n=${n}`).toBeCloseTo(
        n,
        DIGITS
      )
    }
  })

  it('agrees with the closed-form single-qubit route', () => {
    // `qubitEntropy` reads H₂ off the Bloch length in one pass; the general
    // route builds a 2×2 ρ and decomposes it. Two independent arithmetics for
    // one number, so a disagreement means something.
    for (const state of [ghz(3), wState(3), tunablePair(1.1), bellPair()]) {
      for (let qubit = 0; qubit < state.qubits; qubit++) {
        expect(qubitEntropy(state, qubit)).toBeCloseTo(
          subsystemEntropy(state, [qubit]),
          DIGITS
        )
      }
    }
  })

  it('does not care in which order the kept qubits are named', () => {
    const state = wState(4)
    expect(subsystemEntropy(state, [0, 2])).toBeCloseTo(
      subsystemEntropy(state, [2, 0]),
      DIGITS
    )
    expect(subsystemEntropy(state, [3, 1, 0])).toBeCloseTo(
      subsystemEntropy(state, [0, 1, 3]),
      DIGITS
    )
  })

  it('stays between 0 and log₂ of the subsystem dimension', () => {
    for (const seed of [4, 5, 6]) {
      const state = randomEntangled(4, seed)
      for (const keep of subsets(4)) {
        const bits = subsystemEntropy(state, keep)
        expect(bits).toBeGreaterThanOrEqual(-1e-12)
        expect(bits).toBeLessThanOrEqual(keep.length + 1e-12)
      }
    }
  })

  it('computes H₂ at the ends without producing NaN', () => {
    expect(binaryEntropy(0)).toBe(0)
    expect(binaryEntropy(1)).toBe(0)
    expect(binaryEntropy(0.5)).toBeCloseTo(1, DIGITS)
    // A tiny negative from Float64 drift clamps to zero rather than to NaN,
    // which is the whole reason the clamp exists.
    expect(binaryEntropy(-1e-17)).toBe(0)
  })

  it('refuses an argument that is not a probability at all', () => {
    expect(() => binaryEntropy(1.5)).toThrow(RangeError)
    expect(() => binaryEntropy(-0.2)).toThrow(RangeError)
    expect(() => binaryEntropy(Number.NaN)).toThrow(RangeError)
  })

  it('refuses a matrix whose trace is not 1', () => {
    const rho = fromStatevector(alloc(2))
    rho.re[0] = 0.5
    expect(() => vonNeumannEntropy(rho)).toThrow(/trace/)
  })
})

/* ═══════════════════════ concurrence (§3.2) ══════════════════════════════ */

describe('concurrence', () => {
  it('is 1 for a Bell pair', () => {
    expect(concurrence(fromStatevector(bellPair()))).toBeCloseTo(1, DIGITS)
    expect(concurrenceOf(bellPair(), 0, 1)).toBeCloseTo(1, DIGITS)
  })

  it('is 0 for a product state', () => {
    for (const seed of [1, 2, 3]) {
      const state = productState(2, seed)
      expect(concurrenceOf(state, 0, 1), `seed ${seed}`).toBeCloseTo(0, DIGITS)
    }
  })

  it('matches (3p − 1)/2 for a Werner state, threshold included', () => {
    for (const p of [0, 0.1, 1 / 3 - 0.01, 1 / 3, 0.4, 0.5, 0.75, 0.9, 1]) {
      const rho = werner(p)
      // The family is only a family if every member is a state.
      expect(isPositiveSemidefinite(rho), `p=${p}`).toBe(true)
      expect(concurrence(rho), `p=${p}`).toBeCloseTo(
        Math.max(0, (3 * p - 1) / 2),
        DIGITS
      )
    }
  })

  it('follows |sin θ| as a pair is dialled into entanglement', () => {
    for (const theta of [0, 0.4, 1, Math.PI / 2, 2.2, Math.PI]) {
      expect(concurrenceOf(tunablePair(theta), 0, 1), `θ=${theta}`).toBeCloseTo(
        Math.abs(Math.sin(theta)),
        DIGITS
      )
    }
  })

  it('separates GHZ from W, which the entropy alone nearly does not', () => {
    /*
     * GHZ₃ has entropy 1 on every qubit and concurrence 0 on every pair: all
     * of its entanglement is three-way, and no two of its qubits share any.
     * W₃ has entropy 0.9183 and concurrence 2/3 = 0.667 on every pair. The
     * entropies differ by 8%; the concurrences differ by everything.
     */
    const g = ghz(3)
    const w = wState(3)
    for (const [a, b] of [
      [0, 1],
      [0, 2],
      [1, 2],
    ]) {
      expect(concurrenceOf(g, a, b), `GHZ ${a}${b}`).toBeCloseTo(0, DIGITS)
      expect(concurrenceOf(w, a, b), `W ${a}${b}`).toBeCloseTo(2 / 3, DIGITS)
    }
  })

  it('gives W_n a pairwise concurrence of 2/n', () => {
    for (const n of [2, 3, 4, 5]) {
      expect(concurrenceOf(wState(n), 0, 1), `W-${n}`).toBeCloseTo(
        2 / n,
        DIGITS
      )
    }
  })

  it('relates to the Bloch length as C² + |r|² = 1 on a two-qubit pure state', () => {
    // Two entirely different readings of the same state: one from a 4×4
    // spin-flipped decomposition, one from a 2×2 partial trace. They are
    // forced to agree, and nothing in either computes the other.
    for (const theta of [0.3, 1, 2, 2.9]) {
      const state = tunablePair(theta)
      const c = concurrenceOf(state, 0, 1)
      const r = blochVector(state, 0).length
      expect(c * c + r * r, `θ=${theta}`).toBeCloseTo(1, DIGITS)
    }
  })

  it('is symmetric in the two qubits it is asked about', () => {
    const state = wState(4)
    expect(concurrenceOf(state, 1, 3)).toBeCloseTo(
      concurrenceOf(state, 3, 1),
      DIGITS
    )
  })

  it('refuses anything that is not a pair of qubits', () => {
    expect(() => concurrence(fromStatevector(alloc(1)))).toThrow(/pair/)
    expect(() => concurrence(fromStatevector(ghz(3)))).toThrow(/3/)
  })
})

/* ════════════════════════ fidelity (§3.3) ════════════════════════════════ */

describe('fidelity', () => {
  it('is 1 for a state with itself, in all four forms', () => {
    const state = ghz(3)
    const rho = fromStatevector(state)
    expect(stateFidelity(state, state)).toBeCloseTo(1, DIGITS)
    expect(densityStateFidelity(rho, state)).toBeCloseTo(1, DIGITS)
    expect(densityFidelity(rho, rho)).toBeCloseTo(1, DIGITS)
    expect(
      distributionFidelity(probabilities(state), probabilities(state))
    ).toBeCloseTo(1, DIGITS)
  })

  it('is 0 for two orthogonal states', () => {
    const zero = alloc(2)
    const one = alloc(2)
    apply1q(one, x, 0)
    expect(stateFidelity(zero, one)).toBeCloseTo(0, DIGITS)
    expect(densityStateFidelity(fromStatevector(zero), one)).toBeCloseTo(
      0,
      DIGITS
    )
    expect(
      densityFidelity(fromStatevector(zero), fromStatevector(one))
    ).toBeCloseTo(0, DIGITS)

    // Orthogonal *within* the same subspace, too: |+⟩ against |−⟩, where the
    // distributions are identical and only the phase differs. A fidelity
    // computed from the histogram alone would call this pair 1.
    const plus = alloc(1)
    apply1q(plus, h, 0)
    const minus = alloc(1)
    apply1q(minus, h, 0)
    apply1q(minus, z, 0)
    expect(stateFidelity(plus, minus)).toBeCloseTo(0, DIGITS)
    expect(
      distributionFidelity(probabilities(plus), probabilities(minus))
    ).toBeCloseTo(1, DIGITS)
  })

  it('is |⟨ψ|φ⟩|², the squared convention, and says so numerically', () => {
    /*
     * The definition this package uses, pinned on a case where the two
     * conventions differ visibly: |0⟩ against cos(θ/2)|0⟩ + sin(θ/2)|1⟩ has
     * overlap cos(θ/2), so the squared convention gives cos²(θ/2) and the
     * unsquared one gives |cos(θ/2)|. At θ = π/2 that is 0.5 against 0.7071.
     */
    for (const theta of [0.5, Math.PI / 2, 2]) {
      const psi = alloc(1)
      const phi = alloc(1)
      apply1q(phi, ryMatrix(theta), 0)
      const c = Math.cos(theta / 2)
      expect(stateFidelity(psi, phi), `θ=${theta}`).toBeCloseTo(c * c, DIGITS)
    }
    const half = alloc(1)
    apply1q(half, ryMatrix(Math.PI / 2), 0)
    expect(stateFidelity(alloc(1), half)).toBeCloseTo(0.5, DIGITS)
  })

  it('agrees between the general form and the pure-state shortcut', () => {
    // ⟨ψ|ρ|ψ⟩ is O(4ⁿ) and (Tr√(√ρσ√ρ))² is O(8ⁿ); on a pure σ they are the
    // same number, and §3.3 gets to use the cheap one because of it.
    const noisy = werner(0.6)
    const pure = bellPair()
    expect(densityStateFidelity(noisy, pure)).toBeCloseTo(
      densityFidelity(noisy, fromStatevector(pure)),
      DIGITS
    )
    // Worked value: ⟨Φ⁺|ρ_W(p)|Φ⁺⟩ = p + (1 − p)/4.
    expect(densityStateFidelity(noisy, pure)).toBeCloseTo(0.6 + 0.4 / 4, DIGITS)
  })

  it('agrees between the classical and the quantum form on diagonal states', () => {
    // The squared convention is what makes these the same function: a
    // distribution laid on a diagonal ρ has (Σ√(pq))² for its quantum
    // fidelity too. Under the unsquared convention only one of the two would
    // have been squared and this test would fail by exactly that square.
    const rng = createRng(31)
    const p = normalised(8, rng)
    const q = normalised(8, rng)
    expect(distributionFidelity(p, q)).toBeCloseTo(
      densityFidelity(diagonalState(p), diagonalState(q)),
      DIGITS
    )
  })

  it('is symmetric in its two density matrices', () => {
    // Only one of them gets a square root, so the two evaluations take
    // genuinely different arithmetic to the same answer.
    const a = werner(0.7)
    const b = maximallyMixed(2)
    expect(densityFidelity(a, b)).toBeCloseTo(densityFidelity(b, a), DIGITS)
  })

  it('gives a pure state against the maximally mixed one 1/2ⁿ', () => {
    for (const n of [1, 2, 3]) {
      const pure = ghz(n)
      expect(
        densityStateFidelity(maximallyMixed(n), pure),
        `n=${n}`
      ).toBeCloseTo(1 / (1 << n), DIGITS)
      expect(
        densityFidelity(maximallyMixed(n), fromStatevector(pure))
      ).toBeCloseTo(1 / (1 << n), DIGITS)
    }
  })

  it('reads an ideal-versus-noisy comparison the way §3.3 will', () => {
    // A depolarised Bell pair: the histogram still looks like a Bell pair's,
    // and the state fidelity is the number that says how much was lost.
    const ideal = bellPair()
    for (const p of [0, 0.25, 0.5, 1]) {
      const noisy = werner(1 - p)
      const fidelity = densityStateFidelity(noisy, ideal)
      expect(fidelity, `p=${p}`).toBeCloseTo(1 - (3 * p) / 4, DIGITS)
      expect(fidelity).toBeGreaterThanOrEqual(0.25 - 1e-12)
    }
  })

  it('refuses shot counts handed in where frequencies were meant', () => {
    const counts = new Float64Array([300, 700])
    const ideal = new Float64Array([0.5, 0.5])
    expect(() => distributionFidelity(counts, ideal)).toThrow(/divide/)
  })

  it('refuses operands from different registers', () => {
    expect(() => stateFidelity(alloc(2), alloc(3))).toThrow(RangeError)
    expect(() =>
      densityStateFidelity(fromStatevector(alloc(2)), alloc(3))
    ).toThrow(RangeError)
    expect(() =>
      densityFidelity(fromStatevector(alloc(2)), fromStatevector(alloc(3)))
    ).toThrow(RangeError)
    expect(() =>
      distributionFidelity(new Float64Array([1]), new Float64Array([0.5, 0.5]))
    ).toThrow(RangeError)
  })
})

/* ═══════════ invariance under local unitaries — the acid test ════════════ */

describe('local unitaries change nothing', () => {
  /*
   * Entanglement is by definition what a local operation cannot create or
   * destroy, so both metrics must be invariant under U₀ ⊗ U₁ ⊗ … — an
   * arbitrary, different rotation on every wire. This is the check with the
   * broadest reach in the file: it is sensitive to a wrong basis, a
   * mispaired qubit, a conjugate on the wrong factor and a spin flip built
   * with the wrong sign, none of which commute with an arbitrary rotation.
   */
  function localise(state: Statevector, seed: number): Statevector {
    const rng = createRng(seed)
    const rotated = { ...state, re: state.re.slice(), im: state.im.slice() }
    for (let qubit = 0; qubit < state.qubits; qubit++) {
      apply1q(
        rotated,
        uMatrix(rng.next() * Math.PI, rng.next() * 6, rng.next() * 6),
        qubit
      )
    }
    return rotated
  }

  it('leaves every subsystem entropy where it was', () => {
    for (const original of [ghz(4), wState(4), tunablePair(1.3)]) {
      for (const seed of [1, 2]) {
        const rotated = localise(original, seed)
        for (const keep of subsets(original.qubits)) {
          expect(
            subsystemEntropy(rotated, keep),
            `keep ${keep.join(',')} seed ${seed}`
          ).toBeCloseTo(subsystemEntropy(original, keep), DIGITS)
        }
      }
    }
  })

  it('leaves every pairwise concurrence where it was', () => {
    for (const original of [ghz(3), wState(3), wState(4)]) {
      for (const seed of [3, 4]) {
        const rotated = localise(original, seed)
        for (let a = 0; a < original.qubits; a++) {
          for (let b = a + 1; b < original.qubits; b++) {
            expect(
              concurrenceOf(rotated, a, b),
              `pair ${a}${b} seed ${seed}`
            ).toBeCloseTo(concurrenceOf(original, a, b), DIGITS)
          }
        }
      }
    }
  })

  it('leaves a fidelity where it was when both sides are rotated together', () => {
    // F(UρU†, UσU†) = F(ρ, σ). Rotating only one side must move it, and the
    // second half of this test is what stops the first from passing
    // vacuously on a fidelity that ignores its arguments.
    const a = ghz(3)
    const b = wState(3)
    const seed = 12
    expect(stateFidelity(localise(a, seed), localise(b, seed))).toBeCloseTo(
      stateFidelity(a, b),
      DIGITS
    )
    expect(stateFidelity(localise(a, seed), b)).not.toBeCloseTo(
      stateFidelity(a, b),
      6
    )
  })
})

/* ════════════════════════ the ceiling, stated ════════════════════════════ */

describe('the subsystem ceiling', () => {
  it('computes an entropy right up to the limit', () => {
    const state = ghz(MAX_SUBSYSTEM_QUBITS + 1)
    const keep = Array.from({ length: MAX_SUBSYSTEM_QUBITS }, (_v, i) => i)
    expect(subsystemEntropy(state, keep)).toBeCloseTo(1, DIGITS)
  })

  it('refuses one qubit past it, with a typed error naming the size', () => {
    const state = ghz(MAX_SUBSYSTEM_QUBITS + 1)
    const keep = Array.from({ length: MAX_SUBSYSTEM_QUBITS + 1 }, (_v, i) => i)
    expect(() => subsystemEntropy(state, keep)).toThrow(EigenTooLargeError)
    try {
      subsystemEntropy(state, keep)
    } catch (error) {
      expect((error as EigenTooLargeError).dim).toBe(
        1 << (MAX_SUBSYSTEM_QUBITS + 1)
      )
    }
  })

  it('says the same thing about a density matrix that is too wide', () => {
    const rho = maximallyMixed(MAX_SUBSYSTEM_QUBITS + 1)
    expect(() => vonNeumannEntropy(rho)).toThrow(EigenTooLargeError)
    expect(() => densityFidelity(rho, rho)).toThrow(EigenTooLargeError)
  })
})

/* ─────────────────────────── local helpers ──────────────────────────────── */

/** A normalised random distribution of `n` outcomes. */
function normalised(n: number, rng: { next(): number }): Float64Array {
  const out = new Float64Array(n)
  let total = 0
  for (let i = 0; i < n; i++) {
    out[i] = rng.next()
    total += out[i]
  }
  for (let i = 0; i < n; i++) out[i] /= total
  return out
}

/** A density matrix carrying `p` on its diagonal and nothing anywhere else. */
function diagonalState(p: Float64Array): DensityMatrix {
  const qubits = Math.round(Math.log2(p.length))
  const rho = maximallyMixed(qubits)
  rho.re.fill(0)
  rho.im.fill(0)
  for (let i = 0; i < p.length; i++) rho.re[i * rho.dim + i] = p[i]
  return rho
}

/** A state with entanglement of no particular structure, seeded. */
function randomEntangled(n: number, seed: number): Statevector {
  const state = productState(n, seed)
  const rng = createRng(seed + 1000)
  for (let round = 0; round < 2; round++) {
    for (let qubit = 0; qubit < n; qubit++) {
      applyControlled(state, x, (qubit + 1) % n, [control(qubit)])
      apply1q(
        state,
        uMatrix(rng.next() * Math.PI, rng.next() * 6, rng.next() * 6),
        qubit
      )
    }
  }
  return state
}
