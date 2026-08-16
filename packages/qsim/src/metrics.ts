/**
 * Entanglement metrics and fidelity — specification §3.2, §3.3 and §5.5.
 *
 * Four things live here, in the order the file presents them:
 *
 *   1. the single-qubit partial trace and the Bloch vector (§5.5, M1.6);
 *   2. the general partial trace onto any subsystem, as a density matrix;
 *   3. von Neumann entropy and concurrence — "how entangled" as a number;
 *   4. fidelity, between two distributions, two states or two ρ.
 *
 * ────────────────────────────────────────────────────────────────────────
 * WHICH FIDELITY. THE SQUARED ONE. F(ρ, σ) = (Tr√(√ρ σ √ρ))².
 *
 * The literature carries two conventions that differ by exactly a square, and
 * both are called "fidelity". Nielsen & Chuang write F = Tr√(√ρ σ √ρ); Jozsa
 * and most of the hardware-benchmarking literature write its square. Reading
 * a number of 0.98 without knowing which is meant is reading nothing: the
 * other convention would have called the same pair of states 0.96.
 *
 * THIS PACKAGE USES THE SQUARED CONVENTION, EVERYWHERE, WITHOUT EXCEPTION:
 *
 *     two pure states       F = |⟨ψ|φ⟩|²
 *     ρ against a pure ψ    F = ⟨ψ|ρ|ψ⟩
 *     two distributions     F = (Σᵢ √(pᵢ qᵢ))²
 *     two density matrices  F = (Tr√(√ρ σ √ρ))²
 *
 * Chosen because in this convention F *is a probability*: for pure states it
 * is the chance that a measurement which perfectly identifies |φ⟩ accepts
 * |ψ⟩. "Fidelity 0.99" then means "behaves like the ideal one ninety-nine
 * times in a hundred", which is what a reader of §3.3's ideal-versus-noisy
 * panel is being invited to conclude, and what the `fidelityThreshold` of the
 * challenge model (§7, default 0.99) has to mean for the default to be
 * sensible. The four forms above are consistent with each other by
 * construction — each is the general one specialised — and the tests assert
 * that pairwise rather than trusting it.
 *
 * ────────────────────────────────────────────────────────────────────────
 * WHY ENTROPY NEEDS AN EIGENSOLVER, AND WHERE THE CEILING COMES FROM
 *
 * S(ρ) = −Tr(ρ log₂ ρ) is defined through the spectrum: log of a matrix means
 * log of its eigenvalues. There is no index-pairing walk for a spectrum, so
 * `eigen.ts` is a genuine O(m³) decomposition, and it refuses a matrix wider
 * than `MAX_EIGEN_DIM`. That is what fixes `MAX_SUBSYSTEM_QUBITS` below: an
 * entropy is available for subsystems up to that width and *refused with a
 * typed error* past it, never computed slowly enough to look like a hang.
 * A single qubit is exempt — `qubitEntropy` has a closed form and works at
 * any register size, which is what the §3.2 panel actually draws.
 *
 * ────────────────────────────────────────────────────────────────────────
 * 0 log 0 = 0, AND THE EIGENVALUE THAT COMES BACK AT −3e-17
 *
 * Every function here that reads a spectrum treats it as a list of
 * probabilities, and Float64 does not respect that: a rank-deficient ρ has
 * eigenvalues that land a few ulps either side of zero. So each one is
 * clamped into [0, 1] — and a value *outside* the clamp by more than
 * `PHYSICALITY_TOLERANCE` is thrown on rather than clamped, because at that
 * size it is not drift, it is a sign error, and the whole point of §3.3 is
 * that nobody has an intuition for what the answer should have been.
 * `x log x → 0` as x → 0 makes the clamped term zero, which is the standard
 * convention and also the only one that does not produce NaN.
 *
 * ────────────────────────────────────────────────────────────────────────
 * §5.5 — THE SINGLE-QUBIT CASE, WHICH IS THE ONE THE PANEL DRAWS
 *
 * It is short enough to state in full:
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

import { alloc as densityAlloc } from './density.js'
import type { DensityMatrix } from './density.js'
import {
  EigenTooLargeError,
  MAX_EIGEN_DIM,
  eigenHermitian,
  eigenvaluesHermitian,
} from './eigen.js'
import type { HermitianMatrix } from './eigen.js'
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

/* ═══════════════════ the partial trace onto any subsystem ════════════════ */

/**
 * How far a number that ought to be a probability may stray before it stops
 * being drift and starts being a bug.
 *
 * Looser than D6's 1e-10, and for the same reason `eigen.HERMITICITY_
 * TOLERANCE` is: D6 fixes what a *test* may accept between two computed
 * quantities, while this bounds the accumulated drift of a partial trace over
 * 2²⁰ amplitudes followed by an O(m³) decomposition. What it has to catch is
 * an eigenvalue of −0.3, not one of −3e-17.
 */
export const PHYSICALITY_TOLERANCE = 1e-9

/**
 * The widest subsystem an entropy is available for: 7 qubits.
 *
 * Derived from `MAX_EIGEN_DIM` rather than written down, so the two cannot
 * drift apart — the ceiling is a property of the eigensolver (see its header
 * for the measured timings), and this is the same statement counted in
 * qubits. `qubitEntropy` is exempt and works at any register size.
 */
export const MAX_SUBSYSTEM_QUBITS = Math.round(Math.log2(MAX_EIGEN_DIM))

/**
 * ρ_S = Tr_rest |ψ⟩⟨ψ| — the state of a subsystem, as a full density matrix.
 *
 * `keep` lists the qubits that survive, and its ORDER IS THE SUBSYSTEM'S
 * ORDER: bit j of a row or column index of the result is register qubit
 * `keep[j]`. So `partialTrace(state, [3, 1])` and `partialTrace(state, [1, 3])`
 * both describe the same pair and differ by a relabelling — which matters for
 * reading the matrix and not at all for the entropy or the concurrence, both
 * of which are invariant under it. The tests assert that invariance rather
 * than leaving it as a claim.
 *
 * ────────────────────────────────────────────────────────────────────────
 * THE SUM, AND WHY THE ENVIRONMENT IS NEVER MATERIALISED
 *
 *     ρ_ab = Σ_e ψ[index(a, e)] · conj(ψ[index(b, e)])
 *
 * where `e` runs over every configuration of the traced-out qubits. Both
 * `index(a, e)` halves are pure bit placement: a kept pattern contributes
 * `Σ_j ((a >> j) & 1) << keep[j]` and the environment contributes a submask
 * of the complementary bits. The kept side is small — 2^|keep| ≤ 4096 — and is
 * tabulated once. The environment side is 2^(n−|keep|), which at twenty
 * qubits tracing to one is half a million entries and at twenty-eight is a
 * hundred and thirty million, so it is *enumerated* instead, by walking the
 * submasks of the complement in increasing order:
 *
 *     next = ((e | ~mask) + 1) & mask
 *
 * — add one into the bits the mask excludes and let the carry ripple into the
 * bits it includes. Constant time per step, no allocation, and it visits each
 * configuration exactly once.
 *
 * COST: 2^(n−k) × 4^k complex multiply-adds, and 4^k × 16 bytes of output.
 * The output allocation goes through `density.alloc`, so the 4ⁿ ceiling of
 * §3.3 is checked before a byte is reserved and reported as
 * `DensityTooLargeError` rather than as a failed typed-array constructor.
 */
export function partialTrace(
  state: Statevector,
  keep: readonly number[]
): DensityMatrix {
  const kept = checkSubsystem(keep, state.qubits)
  const rho = densityAlloc(kept.length)
  // `density.alloc` seeds |0…0⟩⟨0…0|; this is an accumulation from zero.
  rho.re[0] = 0

  const { dim, re, im } = rho
  const offsets = patternOffsets(kept)
  const restMask = registerMask(state.qubits) & ~maskOf(kept)
  const psiRe = state.re
  const psiIm = state.im
  // One environment slice at a time, gathered into contiguous scratch: the
  // inner double loop then reads it 2·dim times without re-striding the
  // statevector for each pair.
  const sliceRe = new Float64Array(dim)
  const sliceIm = new Float64Array(dim)

  for (let env = 0; ; env = nextSubmask(env, restMask)) {
    for (let a = 0; a < dim; a++) {
      const at = offsets[a] + env
      sliceRe[a] = psiRe[at]
      sliceIm[a] = psiIm[at]
    }
    for (let a = 0; a < dim; a++) {
      const ar = sliceRe[a]
      const ai = sliceIm[a]
      // A zero row of the slice contributes a zero row of the outer product.
      if (ar === 0 && ai === 0) continue
      const rowBase = a * dim
      for (let b = 0; b < dim; b++) {
        const br = sliceRe[b]
        const bi = sliceIm[b]
        re[rowBase + b] += ar * br + ai * bi
        im[rowBase + b] += ai * br - ar * bi
      }
    }
    if (env === restMask) break
  }
  return rho
}

/**
 * ρ_S = Tr_rest ρ — the same trace, starting from a mixed state.
 *
 * The mixed-state twin of `partialTrace`, and the one §3.3 needs: after a
 * noise channel there is no |ψ⟩ to reduce. Both index halves take the same
 * treatment, which is the whole difference — ρ_ab = Σ_e ρ[(a,e), (b,e)],
 * with `e` woven identically into the row and into the column, because a
 * partial trace is a sum over the *diagonal* of the traced-out factor.
 */
export function partialTraceOfDensity(
  rho: DensityMatrix,
  keep: readonly number[]
): DensityMatrix {
  const kept = checkSubsystem(keep, rho.qubits)
  const out = densityAlloc(kept.length)
  out.re[0] = 0

  const { dim, re, im } = out
  const offsets = patternOffsets(kept)
  const restMask = registerMask(rho.qubits) & ~maskOf(kept)
  const full = rho.dim

  for (let env = 0; ; env = nextSubmask(env, restMask)) {
    for (let a = 0; a < dim; a++) {
      const sourceRow = (offsets[a] + env) * full + env
      const rowBase = a * dim
      for (let b = 0; b < dim; b++) {
        const at = sourceRow + offsets[b]
        re[rowBase + b] += rho.re[at]
        im[rowBase + b] += rho.im[at]
      }
    }
    if (env === restMask) break
  }
  return out
}

/* ══════════════════════ von Neumann entropy (§3.2) ═══════════════════════ */

/**
 * S(ρ) = −Tr(ρ log₂ ρ), in bits (ebits).
 *
 * Base 2 rather than e, so that the answer is counted in the unit the reader
 * is looking at: one bit is exactly one maximally entangled pair, and half of
 * a Bell state reads 1.000 rather than 0.693.
 *
 * WHAT IT MEASURES, AND THE ONE MISREADING TO AVOID. For a subsystem of a
 * *pure* global state this is entanglement entropy: 0 says the subsystem has
 * a state of its own and is unentangled with the rest, and log₂(dim) says it
 * is as entangled as it can be. For a *mixed* global state — anything out of
 * §3.3's noise mode — it is the entropy of the subsystem, which mixes
 * entanglement with the classical uncertainty the channel injected, and is
 * therefore not a measure of entanglement at all. The number is honest either
 * way; the sentence next to it in the panel is what has to be careful.
 *
 * Accepts any Hermitian matrix, so a `DensityMatrix` goes in unadapted. The
 * trace is checked first because it is O(m) against the decomposition's
 * O(m³), and because "the input was not a state" is a more useful error than
 * an entropy computed from a spectrum that does not sum to one.
 */
export function vonNeumannEntropy(matrix: HermitianMatrix): number {
  checkUnitTrace(matrix)
  const values = eigenvaluesHermitian(matrix)
  let bits = 0
  for (let i = 0; i < values.length; i++) {
    const p = clampProbability(values[i], 'eigenvalue')
    // 0·log 0 = 0 by the standard convention, and 1·log 1 = 0 exactly; both
    // are skipped so that a pure state returns 0 rather than 0 plus a ulp.
    if (p === 0 || p === 1) continue
    bits -= p * Math.log2(p)
  }
  return bits
}

/**
 * H₂(p) = −p log₂ p − (1−p) log₂(1−p), the entropy of a two-outcome spectrum.
 *
 * Exported because it is the closed form every closed-form check in the tests
 * would otherwise re-derive — a Bell half is H₂(½) = 1, a qubit of W₃ is
 * H₂(⅓) = 0.9183 — and because `qubitEntropy` is nothing but this applied to
 * the Bloch length.
 */
export function binaryEntropy(p: number): number {
  const a = clampProbability(p, 'argument')
  if (a === 0 || a === 1) return 0
  return -a * Math.log2(a) - (1 - a) * Math.log2(1 - a)
}

/**
 * The entropy of one qubit, at any register size, without an eigensolver.
 *
 * The 2×2 case has a closed form and this is it: ρ_q = ½(I + r·σ) has
 * eigenvalues (1 ± |r|)/2, so S = H₂((1 − |r|)/2). One pass over the
 * amplitudes, no allocation, no O(m³) — which is why the §3.2 panel can show
 * a per-qubit entropy beside every Bloch sphere on a twenty-qubit register
 * while `subsystemEntropy` stops at seven.
 *
 * It is also a second, independent route to the same number: the general path
 * `vonNeumannEntropy(partialTrace(state, [q]))` must agree with it to D6, and
 * a test asserts exactly that. Two routes that agree is what makes a
 * disagreement mean something.
 */
export function qubitEntropy(state: Statevector, qubit: number): number {
  return binaryEntropy((1 - blochVector(state, qubit).length) / 2)
}

/**
 * The entropy of an arbitrary subsystem of a pure state.
 *
 * Refuses a subsystem wider than `MAX_SUBSYSTEM_QUBITS` *before* the partial
 * trace allocates anything, so an over-large request costs nothing and
 * arrives as `EigenTooLargeError` — a typed refusal the UI can translate —
 * rather than as a decomposition that runs for minutes.
 */
export function subsystemEntropy(
  state: Statevector,
  keep: readonly number[]
): number {
  checkSubsystem(keep, state.qubits)
  if (keep.length > MAX_SUBSYSTEM_QUBITS) {
    throw new EigenTooLargeError(1 << keep.length)
  }
  return vonNeumannEntropy(partialTrace(state, keep))
}

/* ═════════════════════════ concurrence (§3.2) ════════════════════════════ */

/**
 * The sign pattern of Y⊗Y, which is `antidiag(−1, 1, 1, −1)`.
 *
 * Y = [[0, −i], [i, 0]], so (Y⊗Y)_{ac} = Y_{a₁c₁}·Y_{a₀c₀} is non-zero only
 * when every bit of `c` is the complement of the matching bit of `a` — that
 * is, when c = 3 − a — and the two factors of ±i multiply to ±1, negative
 * when the two bits of `a` agree. Hence [−1, 1, 1, −1].
 *
 * NOTE ON D1. This matrix is unchanged by swapping which qubit is which: the
 * relabelling exchanges basis indices 1 and 2, and the pattern is symmetric
 * under exactly that exchange. So the little-endian convention, which decides
 * so much else in this engine, does not reach the spin flip — and the tests
 * still build Y⊗Y from an explicit Kronecker product and compare, because
 * "the convention cannot matter here" is a claim, and claims get checked.
 */
const SPIN_FLIP_SIGNS = [-1, 1, 1, -1] as const

/**
 * The concurrence of a two-qubit ρ: 0 for a separable state, 1 for a Bell
 * pair, and a monotone measure of entanglement in between.
 *
 * WOOTTERS' CONSTRUCTION, which is the definition §3.2 is asking for:
 *
 *     ρ̃ = (Y⊗Y) ρ* (Y⊗Y)                   the spin-flipped state
 *     C  = max(0, σ₁ − σ₂ − σ₃ − σ₄)       σ descending, σᵢ² = eig(ρ ρ̃)
 *
 * with ρ* the entry-by-entry conjugate in the computational basis — NOT the
 * adjoint. Getting that wrong gives ρ̃ = ρ for a Hermitian ρ, so C comes out
 * as a function of ρ's own spectrum: still in [0, 1], still 0 on some
 * separable states, and wrong everywhere it matters.
 *
 * ρ ρ̃ IS NOT HERMITIAN, AND THE OBVIOUS REPAIR LOSES HALF THE DIGITS. The
 * product of two Hermitian matrices generally is not one, so `eigen.ts`
 * cannot touch ρ ρ̃ directly. The textbook fix is to decompose the similar
 * matrix √ρ ρ̃ √ρ, which is Hermitian and positive semidefinite, and take
 * square roots of its eigenvalues. It gives the right answer and it gives it
 * to only half the available precision:
 *
 *     an eigenvalue of 0 comes back at 1e-16 — that is machine precision,
 *     and there is nothing wrong with it — but √1e-16 is 1e-8.
 *
 * Since the σ are then *subtracted* from one another, three spurious 1e-8
 * terms land directly in C. Measured, that is what it costs: a product state
 * reports a concurrence of 7.6e-10 instead of 0, and every closed form in
 * the tests agrees only to eight digits rather than to D6's ten. The square
 * root is the culprit, and it is unavoidable *if the σ are obtained as roots
 * of eigenvalues*.
 *
 * SO THEY ARE NOT. The σ are the singular values of A = √ρ̃ √ρ — because
 * A†A = √ρ √ρ̃ √ρ̃ √ρ = √ρ ρ̃ √ρ, whose eigenvalues are the σ² — and singular
 * values can be had *directly*, at full absolute precision, as the
 * eigenvalues of the Jordan–Wielandt matrix
 *
 *     H = ⎡ 0   A ⎤       spectrum { ±σ₁, ±σ₂, ±σ₃, ±σ₄ }
 *         ⎣ A†  0 ⎦
 *
 * which is Hermitian, 8×8, and exactly what the solver already in this
 * package eats. No square root is ever taken of a computed quantity, and the
 * closed forms come back to 1e-13.
 *
 * √ρ̃ COSTS NOTHING EXTRA. Spin-flipping commutes with the square root:
 * ρ̃ = W Λ W† with W = (Y⊗Y)V* unitary, so √ρ̃ = W √Λ W† = the spin flip of
 * √ρ. One decomposition of ρ, one spin flip, one 4×4 product, one 8×8
 * decomposition — and no step that magnifies its own rounding.
 *
 * The max(0, ·) at the end is not a numerical guard: for a separable state
 * the four σ genuinely satisfy σ₁ ≤ σ₂ + σ₃ + σ₄ and the bracket is
 * negative, and clamping it is part of the definition.
 */
export function concurrence(rho: DensityMatrix): number {
  if (rho.qubits !== 2) {
    throw new RangeError(
      `Concurrence is defined for a pair of qubits; this ρ has ` +
        `${rho.qubits}. Take a two-qubit partial trace first.`
    )
  }
  checkUnitTrace(rho)

  const root = psdSqrt(rho)
  const values = eigenvaluesHermitian(
    jordanWielandt(multiply(spinFlip(root), root, 4), 4)
  )

  /*
   * The spectrum of H is symmetric about zero, so ascending it reads
   * −σ₁, −σ₂, −σ₃, −σ₄, σ₄, σ₃, σ₂, σ₁ and the four singular values are the
   * upper half, smallest first. C subtracts the three smaller from the
   * largest.
   */
  return Math.max(0, values[7] - values[6] - values[5] - values[4])
}

/**
 * The concurrence of the pair (q0, q1) inside a larger state.
 *
 * Traces the rest out first, so this is the entanglement *of the pair with
 * each other*, not of the pair with the world. In GHZ₃ every pair reads 0 —
 * the state is maximally entangled and no two of its qubits share any of it —
 * while in W₃ every pair reads 2/3. That contrast is exactly why §3.2 asks
 * for a per-pair number in addition to the per-qubit entropy.
 */
export function concurrenceOf(
  state: Statevector,
  q0: number,
  q1: number
): number {
  return concurrence(partialTrace(state, [q0, q1]))
}

/* ══════════════════════════ fidelity (§3.3) ══════════════════════════════ */

/**
 * F(p, q) = (Σᵢ √(pᵢ qᵢ))² — the squared Bhattacharyya coefficient.
 *
 * THIS IS THE NUMBER §3.3's SIDE-BY-SIDE PANEL SHOWS. It is O(2ⁿ) and needs
 * no decomposition, so it works at the top of the noise mode's range where
 * `densityFidelity` cannot run at all — and it is the honest metric for what
 * the panel is comparing, which is two histograms rather than two states.
 *
 * Both inputs must be normalised. That is enforced rather than assumed,
 * because the mistake it catches is a real one and silent: handing this
 * function raw shot *counts* instead of frequencies returns a number in the
 * thousands, which no amount of staring at a UI would identify as "somebody
 * forgot to divide".
 *
 * The squared convention makes this exactly `densityFidelity` of the two
 * diagonal density matrices carrying p and q — the classical case of the
 * quantum formula — and the tests assert that agreement.
 */
export function distributionFidelity(
  p: ArrayLike<number>,
  q: ArrayLike<number>
): number {
  if (p.length !== q.length) {
    throw new RangeError(
      `Two distributions of different lengths (${p.length} and ${q.length}) ` +
        'describe different registers and have no fidelity.'
    )
  }
  checkNormalised(p, 'the first distribution')
  checkNormalised(q, 'the second distribution')

  let sum = 0
  for (let i = 0; i < p.length; i++) {
    const a = clampNonNegative(p[i], 'entry')
    const b = clampNonNegative(q[i], 'entry')
    sum += Math.sqrt(a * b)
  }
  return sum * sum
}

/** F(ψ, φ) = |⟨ψ|φ⟩|². 1 for the same state, 0 for orthogonal ones. */
export function stateFidelity(a: Statevector, b: Statevector): number {
  if (a.qubits !== b.qubits) {
    throw new RangeError(
      `States on ${a.qubits} and ${b.qubits} qubits live in different spaces ` +
        'and have no overlap.'
    )
  }
  let re = 0
  let im = 0
  for (let i = 0; i < a.size; i++) {
    // ⟨a|b⟩ = Σ conj(aᵢ)·bᵢ
    re += a.re[i] * b.re[i] + a.im[i] * b.im[i]
    im += a.re[i] * b.im[i] - a.im[i] * b.re[i]
  }
  return re * re + im * im
}

/**
 * F(ρ, |ψ⟩) = ⟨ψ|ρ|ψ⟩ — a mixed state against a pure one.
 *
 * THIS IS THE STATE-LEVEL COMPARISON §3.3 CAN AFFORD. The ideal run produces
 * a statevector and the noisy run produces a ρ, and for a pure second
 * argument the general formula collapses to this expectation value: O(4ⁿ),
 * one sweep of the matrix, no decomposition. `densityFidelity` gives the same
 * answer on `densityFromStatevector(ψ)` and the tests check that, but it
 * costs O(8ⁿ) and stops at seven qubits.
 *
 * The result is real because ρ is Hermitian; only the real part is
 * accumulated, so a Hermiticity defect shows up as an error in the value
 * rather than as an imaginary part nobody looks at.
 */
export function densityStateFidelity(
  rho: DensityMatrix,
  state: Statevector
): number {
  if (rho.qubits !== state.qubits) {
    throw new RangeError(
      `A ρ on ${rho.qubits} qubits and a state on ${state.qubits} live in ` +
        'different spaces and have no fidelity.'
    )
  }
  const { dim, re, im } = rho
  let sum = 0
  for (let row = 0; row < dim; row++) {
    const ar = state.re[row]
    const ai = state.im[row]
    if (ar === 0 && ai === 0) continue
    const rowBase = row * dim
    for (let column = 0; column < dim; column++) {
      const pr = re[rowBase + column]
      const pi = im[rowBase + column]
      const br = state.re[column]
      const bi = state.im[column]
      // Re[ conj(ψ_row) · ρ_rc · ψ_column ]
      sum += ar * (pr * br - pi * bi) + ai * (pr * bi + pi * br)
    }
  }
  return sum
}

/**
 * F(ρ, σ) = (Tr√(√ρ σ √ρ))² — the general case, both states mixed.
 *
 * COST, AND WHEN NOT TO CALL THIS. Two O(m³) decompositions and two O(m³)
 * products, m = 2ⁿ — so O(8ⁿ), and `MAX_EIGEN_DIM` refuses it past seven
 * qubits. It is the right function for a subsystem, for a two-qubit reduced
 * state, or for a small register being studied closely. It is the wrong
 * function for the ten-qubit noise run of §3.3: use `distributionFidelity`
 * for the histograms the panel draws, or `densityStateFidelity` against the
 * ideal statevector for a state-level number.
 *
 * SYMMETRY. F(ρ, σ) = F(σ, ρ) mathematically, though the two evaluations take
 * different arithmetic paths — the first argument is the one that gets a
 * square root. The tests check the symmetry numerically for that reason: it
 * is a free, strong check on `psdSqrt`.
 */
export function densityFidelity(
  rho: DensityMatrix,
  sigma: DensityMatrix
): number {
  if (rho.qubits !== sigma.qubits) {
    throw new RangeError(
      `Density matrices on ${rho.qubits} and ${sigma.qubits} qubits live in ` +
        'different spaces and have no fidelity.'
    )
  }
  checkUnitTrace(rho)
  checkUnitTrace(sigma)

  const { dim } = rho
  const root = psdSqrt(rho)
  const product = multiply(multiply(root, sigma, dim), root, dim)
  const values = eigenvaluesHermitian({
    dim,
    re: product.re,
    im: product.im,
  })

  /*
   * Tr√M, with the same rank floor `psdSqrt` argues for and for the same
   * reason: √ρ σ √ρ is rank-deficient whenever either operand is — which is
   * every pure state — and √(1e-17) is 3e-9, so three eigenvalues that ought
   * to be zero would otherwise put a 1e-8 error into a number the panel
   * prints to four decimals.
   */
  const floor = 4 * dim * Number.EPSILON * Math.abs(values[dim - 1])
  let sum = 0
  for (let i = 0; i < values.length; i++) {
    const value = clampNonNegative(values[i], 'eigenvalue')
    if (value > floor) sum += Math.sqrt(value)
  }
  return sum * sum
}

/* ═══════════════════════════ private helpers ═════════════════════════════ */

/** A dense complex matrix with no shape attached — internal plumbing only. */
interface Complexes {
  readonly re: Float64Array
  readonly im: Float64Array
}

/**
 * √A for a positive semidefinite Hermitian A: V √Λ V†.
 *
 * The eigenvalues are clamped at zero on the way in. For a genuine ρ they are
 * probabilities, so a negative one is either drift (clamped, harmlessly) or a
 * sign error (thrown on by `clampNonNegative`, which is the point).
 *
 * ────────────────────────────────────────────────────────────────────────
 * AN EIGENVALUE INSIDE THE NOISE IS TREATED AS EXACTLY ZERO, AND THAT IS NOT
 * COSMETIC
 *
 * A rank-deficient ρ — every reduced state of an entangled register is one —
 * has eigenvalues that come back at ±1e-17 rather than at 0. That is machine
 * precision and there is nothing wrong with it, but √1e-17 is 3e-9, so the
 * square root turns invisible noise into a *visible* null-space component of
 * √ρ, and every σ downstream inherits it. Measured: the concurrence of a W
 * state moved by 6e-9 under a local unitary, which is supposed to move it by
 * nothing at all.
 *
 * So an eigenvalue at or below `4·dim·ε·λmax` becomes an exact zero. The
 * factor is the rank-determination threshold of any dense decomposition, with
 * a little headroom for the drift a partial trace over 2ⁿ amplitudes brings
 * in. It is the minimax choice rather than a free parameter: for a λ that is
 * truly zero, keeping it costs √ε ≈ 1e-8 and zeroing it costs nothing; for a
 * λ that is truly `t`, zeroing it costs √t and keeping it costs ε/(2√t), and
 * the two curves cross at t ≈ ε. Setting the floor anywhere near there is
 * therefore right, and setting it much higher would start rounding real
 * eigenvalues away.
 */
function psdSqrt(matrix: HermitianMatrix): Complexes {
  const { dim } = matrix
  const { values, re, im } = eigenHermitian(matrix)
  const floor = 4 * dim * Number.EPSILON * Math.abs(values[dim - 1])

  // W = V·√Λ, one scaled column per eigenvalue.
  const wRe = new Float64Array(dim * dim)
  const wIm = new Float64Array(dim * dim)
  for (let k = 0; k < dim; k++) {
    const lambda = clampNonNegative(values[k], 'eigenvalue')
    const root = lambda <= floor ? 0 : Math.sqrt(lambda)
    for (let row = 0; row < dim; row++) {
      wRe[row * dim + k] = re[row * dim + k] * root
      wIm[row * dim + k] = im[row * dim + k] * root
    }
  }

  // √A = W·V†, i.e. (√A)_ij = Σ_k W_ik · conj(V_jk).
  const outRe = new Float64Array(dim * dim)
  const outIm = new Float64Array(dim * dim)
  for (let i = 0; i < dim; i++) {
    for (let j = 0; j < dim; j++) {
      let sr = 0
      let si = 0
      for (let k = 0; k < dim; k++) {
        const ar = wRe[i * dim + k]
        const ai = wIm[i * dim + k]
        const br = re[j * dim + k]
        const bi = -im[j * dim + k]
        sr += ar * br - ai * bi
        si += ar * bi + ai * br
      }
      outRe[i * dim + j] = sr
      outIm[i * dim + j] = si
    }
  }
  return { re: outRe, im: outIm }
}

/**
 * X̃ = (Y⊗Y) X* (Y⊗Y) for a 4×4 X, written out.
 *
 * With (Y⊗Y)_{ac} = s_a·δ_{c, 3−a} the two sums collapse to a single term:
 *
 *     X̃_ab = s_a · conj(X_{3−a, 3−b}) · s_{3−b} = s_a s_b conj(X_{3−a,3−b})
 *
 * the last step because the sign pattern is a palindrome, s_{3−b} = s_b. Four
 * multiplications and an index reversal instead of two 4×4 products.
 *
 * Takes any 4×4 rather than only a ρ, because `concurrence` flips √ρ: the
 * operation is a congruence by a unitary composed with a conjugation, and
 * both commute with taking the square root of a positive semidefinite matrix.
 */
function spinFlip(matrix: Complexes): Complexes {
  const re = new Float64Array(16)
  const im = new Float64Array(16)
  for (let a = 0; a < 4; a++) {
    for (let b = 0; b < 4; b++) {
      const sign = SPIN_FLIP_SIGNS[a] * SPIN_FLIP_SIGNS[b]
      const from = (3 - a) * 4 + (3 - b)
      re[a * 4 + b] = sign * matrix.re[from]
      im[a * 4 + b] = -sign * matrix.im[from]
    }
  }
  return { re, im }
}

/**
 * The Jordan–Wielandt embedding of a square matrix A: the Hermitian
 *
 *     H = ⎡ 0   A ⎤        with eigenvalues ±σᵢ(A)
 *         ⎣ A†  0 ⎦
 *
 * A singular value decomposition in disguise, and the reason `concurrence`
 * needs no second solver: reading σ off a *Hermitian* spectrum keeps it at
 * absolute machine precision, where computing it as √(eigenvalue of A†A)
 * would halve the digits of every σ near zero — see that function's header
 * for the measured cost of getting this wrong.
 */
function jordanWielandt(a: Complexes, dim: number): HermitianMatrix {
  const size = 2 * dim
  const re = new Float64Array(size * size)
  const im = new Float64Array(size * size)
  for (let i = 0; i < dim; i++) {
    for (let j = 0; j < dim; j++) {
      const ar = a.re[i * dim + j]
      const ai = a.im[i * dim + j]
      re[i * size + dim + j] = ar
      im[i * size + dim + j] = ai
      re[(dim + j) * size + i] = ar
      im[(dim + j) * size + i] = -ai
    }
  }
  return { dim: size, re, im }
}

/** The plain O(m³) product A·B. Small matrices only; see `densityFidelity`. */
function multiply(a: Complexes, b: Complexes, dim: number): Complexes {
  const re = new Float64Array(dim * dim)
  const im = new Float64Array(dim * dim)
  for (let i = 0; i < dim; i++) {
    for (let k = 0; k < dim; k++) {
      const ar = a.re[i * dim + k]
      const ai = a.im[i * dim + k]
      if (ar === 0 && ai === 0) continue
      const rowBase = i * dim
      const kBase = k * dim
      for (let j = 0; j < dim; j++) {
        const br = b.re[kBase + j]
        const bi = b.im[kBase + j]
        re[rowBase + j] += ar * br - ai * bi
        im[rowBase + j] += ar * bi + ai * br
      }
    }
  }
  return { re, im }
}

/**
 * Validate a subsystem and hand it back. Distinct qubits, all in range, at
 * least one of them.
 *
 * Duplicates are refused rather than deduplicated: `[1, 1]` almost always
 * means a loop wrote the same variable twice, and the deduplicated reading
 * would return a one-qubit ρ where the caller is about to index a 4×4.
 */
function checkSubsystem(
  keep: readonly number[],
  qubits: number
): readonly number[] {
  if (keep.length === 0) {
    throw new RangeError('A subsystem needs at least one qubit, got none.')
  }
  const seen = new Set<number>()
  for (const qubit of keep) {
    if (!Number.isInteger(qubit) || qubit < 0 || qubit >= qubits) {
      throw new RangeError(
        `Cannot keep qubit ${qubit}: outside [0, ${qubits}).`
      )
    }
    if (seen.has(qubit)) {
      throw new RangeError(`A subsystem names qubit ${qubit} twice.`)
    }
    seen.add(qubit)
  }
  return keep
}

/**
 * The full index each pattern of the kept qubits contributes.
 *
 * `offsets[a]` scatters the bits of `a` onto the wires `keep` names, so bit j
 * of `a` lands on bit `keep[j]` of a statevector index — D1, applied to a
 * subsystem.
 */
function patternOffsets(keep: readonly number[]): Int32Array {
  const out = new Int32Array(1 << keep.length)
  for (let j = 0; j < keep.length; j++) {
    const bit = 1 << keep[j]
    const step = 1 << j
    // The patterns whose bit j is set are the odd-numbered blocks of `step`.
    for (let block = step; block < out.length; block += step << 1) {
      for (let k = 0; k < step; k++) out[block + k] |= bit
    }
  }
  return out
}

/** All 1s across an n-qubit index. */
function registerMask(qubits: number): number {
  return (1 << qubits) - 1
}

function maskOf(qubits: readonly number[]): number {
  let mask = 0
  for (const qubit of qubits) mask |= 1 << qubit
  return mask
}

/**
 * The next submask of `mask` in increasing order.
 *
 * Adds one into the bits `mask` excludes so that the carry ripples into the
 * bits it includes, then discards the excluded bits. From `mask` itself it
 * wraps to 0, which is why every caller tests `env === restMask` at the
 * bottom of the loop rather than at the top.
 */
function nextSubmask(sub: number, mask: number): number {
  return ((sub | ~mask) + 1) & mask
}

/** Tr must be 1: the input has to be a state before it can have a spectrum. */
function checkUnitTrace(matrix: HermitianMatrix): void {
  const { dim, re } = matrix
  let sum = 0
  for (let i = 0; i < dim; i++) sum += re[i * dim + i]
  if (!(Math.abs(sum - 1) <= PHYSICALITY_TOLERANCE)) {
    throw new RangeError(
      `This matrix has trace ${sum}, not 1, so it is not a density matrix ` +
        'and any entropy, concurrence or fidelity read from it would be ' +
        'arithmetic on something that is not a state.'
    )
  }
}

/** Every entry non-negative and the whole thing summing to 1. */
function checkNormalised(values: ArrayLike<number>, role: string): void {
  let sum = 0
  for (let i = 0; i < values.length; i++) sum += values[i]
  if (!(Math.abs(sum - 1) <= PHYSICALITY_TOLERANCE)) {
    throw new RangeError(
      `${role} sums to ${sum}, not 1. Fidelity compares probability ` +
        'distributions; divide shot counts by the number of shots first.'
    )
  }
}

/**
 * A number that has to be a probability, clamped into [0, 1] — or thrown on
 * if it is outside by more than drift.
 *
 * The clamp is what makes `0 log 0 = 0` reachable instead of `NaN`, and the
 * throw is what keeps the clamp from turning a sign error into a plausible
 * answer.
 */
function clampProbability(value: number, role: string): number {
  if (!(
    value >= -PHYSICALITY_TOLERANCE && value <= 1 + PHYSICALITY_TOLERANCE
  )) {
    throw new RangeError(
      `An ${role} of ${value} is not a probability. Outside ` +
        `[0, 1] by more than ${PHYSICALITY_TOLERANCE} this is a sign or a ` +
        'coefficient error, not Float64 drift, so it is refused rather than ' +
        'clamped into looking reasonable.'
    )
  }
  return value <= 0 ? 0 : value >= 1 ? 1 : value
}

/** The same guard where only the lower bound is meaningful. */
function clampNonNegative(value: number, role: string): number {
  if (!(value >= -PHYSICALITY_TOLERANCE)) {
    throw new RangeError(
      `An ${role} of ${value} is negative by more than ` +
        `${PHYSICALITY_TOLERANCE}, which is a sign error rather than drift.`
    )
  }
  return value <= 0 ? 0 : value
}
