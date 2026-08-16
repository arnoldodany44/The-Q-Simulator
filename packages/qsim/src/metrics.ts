/**
 * Single-qubit metrics read off a statevector — specification §5.5.
 *
 * This is the arithmetic behind the Bloch spheres of §3.2, and it is short
 * enough to state in full:
 *
 *     trace out every other qubit  →  ρ_q, a 2×2 density matrix
 *     rx = 2·Re(ρ₀₁),  ry = 2·Im(ρ₁₀),  rz = ρ₀₀ − ρ₁₁
 *
 * ────────────────────────────────────────────────────────────────────────
 * WHY THE LENGTH IS THE POINT, AND NOT THE DIRECTION
 *
 * A qubit that is not entangled with anything has a state of its own, and
 * its Bloch vector reaches the surface: |r| = 1. A qubit that is entangled
 * does **not** have a state of its own — no vector in ℂ² describes it — and
 * the partial trace answers with a *mixed* state, whose vector is shorter.
 * In a Bell pair each half is maximally mixed, ρ = I/2, and its vector is
 * the zero vector: it collapses to the centre of the sphere.
 *
 * That is what makes the picture a detector rather than a decoration (§3.2):
 * the reader drops a CNOT on the canvas and watches two arrows shrink to
 * nothing. So a renderer must draw |r| to scale and never normalise it —
 * normalising the arrow would delete the only quantity that carries the
 * lesson, and would draw a confident direction for a qubit that has none.
 *
 * ────────────────────────────────────────────────────────────────────────
 * THE PARTIAL TRACE IS THE SAME INDEX PAIRING AS EVERY OTHER LOOP HERE
 *
 * Tracing out "every other qubit" sounds like a reshape into a 2ⁿ⁻¹ × 2
 * matrix. It is not: pairing index `i` (bit q clear) with `i + 2^q` (bit q
 * set) enumerates exactly the terms of the sum, because two indices that
 * differ only in bit q are the same configuration of every *other* qubit —
 * which is precisely what "the rest agrees" means. So this is `apply.ts`'s
 * walk with a different body, O(2ⁿ) and no allocation, and it needs no
 * knowledge of which qubits the other bits are.
 *
 * The four accumulators are the whole of ρ_q. It is Hermitian, so ρ₁₀ is
 * ρ₀₁'s conjugate and is never stored; its diagonal is real by construction,
 * because each entry is a sum of squared magnitudes.
 *
 * PRECISION. The sums run over 2ⁿ terms in index order, so at twenty qubits
 * a million additions accumulate the usual Float64 drift — the same drift
 * D6 tolerates elsewhere and for the same reason. `trace()` is therefore
 * 1 to within 1e-10 rather than exactly 1, and nothing here renormalises it
 * on the way out: a caller that wants to see the drift can, and a caller
 * that hides it would be hiding the one signal that says the state upstream
 * stopped being normalised.
 */

import type { Statevector } from './statevector.js'

/**
 * The reduced density matrix of one qubit: ρ_q, with the rest traced out.
 *
 * Four numbers rather than a matrix type, because a 2×2 Hermitian matrix has
 * exactly four real degrees of freedom and spelling them out is what makes
 * `rho10` unspellable — the entry a reader is most likely to get the sign of
 * wrong. Whoever needs it takes the conjugate of `rho01` explicitly.
 */
export interface ReducedDensity {
  /** Which qubit this describes. Carried so an array of these is readable. */
  readonly qubit: number
  /** ρ₀₀ — the probability this qubit reads 0. Real, and non-negative. */
  readonly rho00: number
  /** ρ₁₁ — the probability it reads 1. `rho00 + rho11` is the trace, 1. */
  readonly rho11: number
  /** Re ρ₀₁. */
  readonly re01: number
  /** Im ρ₀₁. ρ₁₀ = conj(ρ₀₁), so Im ρ₁₀ is the negative of this. */
  readonly im01: number
}

/**
 * A qubit's Bloch vector, with its length already taken.
 *
 * `length` is computed here rather than left to the caller because it is the
 * quantity §3.2 is about, and because every caller would otherwise write the
 * same `Math.hypot` — one of them eventually as `x*x + y*y + z*z` without
 * the square root, which reads identically at 0 and at 1 and is wrong
 * everywhere in between.
 */
export interface BlochVector {
  readonly qubit: number
  readonly x: number
  readonly y: number
  readonly z: number
  /** |r| — 1 for a qubit in a pure state, 0 for half of a Bell pair. */
  readonly length: number
}

/**
 * Trace every other qubit out of `state` and return ρ for `qubit`.
 *
 * The walk visits each index exactly once as a member of one pair, so it is
 * one pass over the amplitudes whatever `qubit` is — a high qubit strides
 * far and a low one strides by one, and neither changes the work done.
 */
export function reducedDensity(
  state: Statevector,
  qubit: number
): ReducedDensity {
  checkQubit(state, qubit)
  const { re, im, size } = state
  const stride = 1 << qubit

  let rho00 = 0
  let rho11 = 0
  let re01 = 0
  let im01 = 0

  for (let base = 0; base < size; base += stride << 1) {
    for (let offset = 0; offset < stride; offset++) {
      const zero = base + offset
      const one = zero + stride
      const zr = re[zero]
      const zi = im[zero]
      const or = re[one]
      const oi = im[one]

      rho00 += zr * zr + zi * zi
      rho11 += or * or + oi * oi
      // ρ₀₁ = Σ ψ₀ · conj(ψ₁), summed over every configuration of the rest.
      re01 += zr * or + zi * oi
      im01 += zi * or - zr * oi
    }
  }

  return { qubit, rho00, rho11, re01, im01 }
}

/**
 * The Bloch vector of a reduced density matrix — §5.5's three lines.
 *
 * `y` is written as `−2·Im ρ₀₁` rather than as `2·Im ρ₁₀`. They are the same
 * number, since ρ₁₀ = conj(ρ₀₁), and the specification states the second
 * form; this form is the one that can be read against the field it uses,
 * which is what stops the sign from being flipped by a later edit that
 * "simplified" a conjugate away. The convention it produces is the standard
 * one, ρ = ½(I + r·σ): |0⟩ is +z, |+⟩ is +x and (|0⟩ + i|1⟩)/√2 is +y.
 */
export function blochOf(density: ReducedDensity): BlochVector {
  const x = 2 * density.re01
  const y = -2 * density.im01
  const z = density.rho00 - density.rho11
  return { qubit: density.qubit, x, y, z, length: Math.hypot(x, y, z) }
}

/** The Bloch vector of one qubit, in one pass over the state. */
export function blochVector(state: Statevector, qubit: number): BlochVector {
  return blochOf(reducedDensity(state, qubit))
}

/**
 * Every qubit's Bloch vector, in register order.
 *
 * One pass per qubit rather than one pass accumulating all of them: the
 * combined sweep is the same O(n·2ⁿ) arithmetic, but it would read the
 * partner amplitude of every qubit at every index — n strides at once, none
 * of them sequential — where this reads each pair of a single stride and
 * lets the prefetcher do its job.
 */
export function blochVectors(state: Statevector): readonly BlochVector[] {
  const out: BlochVector[] = []
  for (let qubit = 0; qubit < state.qubits; qubit++) {
    out.push(blochVector(state, qubit))
  }
  return out
}

/**
 * Tr(ρ) — 1 for any qubit of a normalised state.
 *
 * Exported because it is the cheapest check that a state upstream is still
 * physical, and because the tests that hold this module to being a density
 * matrix need it.
 */
export function trace(density: ReducedDensity): number {
  return density.rho00 + density.rho11
}

/**
 * Tr(ρ²) — the purity: 1 exactly when this qubit is unentangled, ½ when it
 * is maximally entangled, and never below ½ for one qubit.
 *
 * Computed from the matrix rather than from the vector, though
 * `(1 + |r|²) / 2` gives the same answer. Two independent routes to one
 * number is what lets a test assert they agree, which is a check on the
 * partial trace itself: a sign error in `im01` moves the vector and the
 * purity by different amounts and the identity stops holding.
 *
 * Tr(ρ²) = ρ₀₀² + ρ₁₁² + 2|ρ₀₁|², since the cross terms ρ₀₁ρ₁₀ and ρ₁₀ρ₀₁
 * are each |ρ₀₁|².
 */
export function purity(density: ReducedDensity): number {
  const { rho00, rho11, re01, im01 } = density
  return rho00 * rho00 + rho11 * rho11 + 2 * (re01 * re01 + im01 * im01)
}

function checkQubit(state: Statevector, qubit: number): void {
  if (!Number.isInteger(qubit) || qubit < 0 || qubit >= state.qubits) {
    throw new RangeError(
      `Cannot reduce onto qubit ${qubit}: outside [0, ${state.qubits}).`
    )
  }
}
