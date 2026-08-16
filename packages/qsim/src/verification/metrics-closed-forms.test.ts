/**
 * INDEPENDENT ADVERSARIAL VERIFICATION — METRICS CLOSED FORMS LENS.
 *
 * Every expected number in this file was derived by hand from a definition,
 * not read off the implementation and not copied from `metrics.test.ts` or
 * `verification/entanglement-metrics.test.ts`. Where a closed form was not
 * available, the oracle is a deliberately slow dense routine written here:
 * explicit complex matrices, O(m³) products, brute-force enumeration of basis
 * states. Nothing here shares a loop, a stride or an accumulator with the
 * module under test.
 *
 * ────────────────────────────────────────────────────────────────────────
 * THE CLOSED FORMS, AND WHERE EACH ONE COMES FROM
 *
 * ENTROPY. S(ρ) = −Tr(ρ log₂ ρ), so it is a function of the spectrum alone.
 *
 *   product state        every reduced ρ is pure    → S = 0
 *   Bell, either half    ρ = I/2, spectrum {½, ½}   → S = 1 exactly
 *   GHZ_n, one qubit     ρ = diag(½, ½)             → S = 1 for n = 3, 4, 5
 *   W_n, one qubit       ρ = diag(1 − 1/n, 1/n)     → S = H₂(1/n) ≠ 1
 *   W_n, two qubits      spectrum {(n−2)/n, 2/n, 0, 0}
 *   cosθ|00⟩ + sinθ|11⟩  spectrum {cos²θ, sin²θ}    → S = H₂(cos²θ)
 *
 * THE W STATE IS THE ONE THAT SEPARATES A METRIC FROM A DETECTOR. Every other
 * entangled case above reads exactly 1, which is also what an implementation
 * that merely notices "this qubit is entangled" and reports the maximum would
 * print. W₃ reads 0.9182958340544896 = log₂3 − 2/3, W₄ reads 0.8112781244591328
 * and W₅ reads 0.7219280948873623, and none of those is reachable by accident.
 * The two-qubit reductions carry the same discrimination in the other
 * direction: the two-qubit subsystem of W₄ has spectrum {½, ½} and therefore
 * entropy exactly 1, while its single qubits do not.
 *
 * CONCURRENCE. Three independent closed forms, none of which needs Wootters'
 * construction to evaluate:
 *
 *   pure two-qubit ψ     C = 2·|ψ₀₀ψ₁₁ − ψ₀₁ψ₁₀|      (amplitudes only)
 *   X-state ρ            C = 2·max(0, |ρ₁₂| − √(ρ₀₀ρ₃₃), |ρ₀₃| − √(ρ₁₁ρ₂₂))
 *   Werner ρ(p)          C = max(0, (3p − 1)/2)
 *
 * The Werner form is derived rather than quoted: ρ = p|Ψ⁻⟩⟨Ψ⁻| + (1−p)I/4 is
 * Bell-diagonal with eigenvalues (1+3p)/4 once and (1−p)/4 three times, every
 * Bell state is its own spin flip up to a phase so ρ̃ = ρ, hence σᵢ = λᵢ and
 * C = max(0, (1+3p)/4 − 3(1−p)/4) = max(0, (3p−1)/2). It crosses zero at
 * p = 1/3, which is the point a coefficient error would move.
 *
 * FIDELITY, in this package's squared convention F = (Tr√(√ρ σ √ρ))²:
 *
 *   two qubits, Bloch    F = ½(1 + r·s + √((1 − |r|²)(1 − |s|²)))
 *   ρ pure               F = ⟨ψ|σ|ψ⟩
 *   ρ pure, σ = I/d      F = 1/d
 *   commuting diagonals  F = (Σ √(pᵢqᵢ))²
 *
 * ────────────────────────────────────────────────────────────────────────
 * THE EIGENSOLVER, CHECKED WITHOUT A SECOND EIGENSOLVER
 *
 * Writing a reference Jacobi iteration to check a Jacobi iteration would share
 * the blind spot it is meant to find. Instead:
 *
 *   1. **Constructed spectra.** A = VΛV† for a V built as an explicit product
 *      of complex Givens rotations and a diagonal of phases — unitary by
 *      construction, and asserted unitary numerically before use. Λ is chosen,
 *      so the answer is known exactly: degenerate, already-diagonal, and
 *      spectra carrying a −3e-17 that has to survive as a small negative
 *      rather than as a clamp or a throw.
 *   2. **Power traces.** For a random Hermitian A, Σλᵏ must equal Tr(Aᵏ) for
 *      k = 1…m, with Tr(Aᵏ) computed by dense multiplication. By Newton's
 *      identities those m sums determine the characteristic polynomial, hence
 *      the whole multiset of eigenvalues — so this pins the spectrum without
 *      ever computing one a second way.
 *   3. **Exact analytic spectra.** The tridiagonal Toeplitz matrix with 2 on
 *      the diagonal and −1 beside it has eigenvalues 2 − 2cos(kπ/(m+1)), and
 *      a 2×2 Hermitian has the quadratic formula. Both are exact for any m.
 *   4. **Pairing.** A·V[:,j] = λⱼ·V[:,j] entry by entry, and V†V = I. A sort
 *      that carries the wrong vector with a correct eigenvalue leaves every
 *      eigenvalue right and every reconstruction wrong, so the two have to be
 *      checked separately.
 */

import { describe, expect, it } from 'vitest'

import type { DensityMatrix } from '../density.js'
import {
  EigenTooLargeError,
  MAX_EIGEN_DIM,
  NotHermitianError,
  eigenHermitian,
  eigenvaluesHermitian,
} from '../eigen.js'
import type { HermitianMatrix } from '../eigen.js'
import {
  binaryEntropy,
  concurrence,
  concurrenceOf,
  densityFidelity,
  densityStateFidelity,
  distributionFidelity,
  partialTrace,
  partialTraceOfDensity,
  qubitEntropy,
  stateFidelity,
  subsystemEntropy,
  vonNeumannEntropy,
} from '../metrics.js'
import type { Statevector } from '../statevector.js'

/** D6's 1e-10, as the digit count `toBeCloseTo` counts in. */
const DIGITS = 10

/* ═════════════════ hand-computed constants, written out ══════════════════ */

/**
 * H₂(1/3) = log₂3 − 2/3. Spelled as a literal rather than as a call to
 * `binaryEntropy`, so that an error inside `binaryEntropy` cannot make the
 * W-state assertions agree with themselves.
 */
const H2_THIRD = 0.9182958340544896
/** H₂(1/4) = 2 − (3/4)·log₂3. */
const H2_QUARTER = 0.8112781244591328
/** H₂(1/5) = log₂5 − (4/5)·log₂4·… evaluated by hand to sixteen digits. */
const H2_FIFTH = 0.7219280948873623
/** H₂(2/5). */
const H2_TWO_FIFTHS = 0.9709505944546686
/** H₂(0.3) = −0.3·log₂0.3 − 0.7·log₂0.7. */
const H2_THREE_TENTHS = 0.8812908992306927

/* ════════════════════════ dense complex matrices ═════════════════════════ */

/**
 * A square complex matrix, row-major, in the same two-array layout the engine
 * uses — so one of these can be handed to `eigenvaluesHermitian` unadapted.
 * Everything below it is the slow, obvious implementation of the operation it
 * names, written for readability rather than for speed.
 */
interface Dense {
  readonly dim: number
  readonly re: Float64Array
  readonly im: Float64Array
}

function dense(dim: number): Dense {
  return {
    dim,
    re: new Float64Array(dim * dim),
    im: new Float64Array(dim * dim),
  }
}

function identity(dim: number): Dense {
  const m = dense(dim)
  for (let i = 0; i < dim; i++) m.re[i * dim + i] = 1
  return m
}

/** C = A·B, the definition, three loops. */
function matMul(a: Dense, b: Dense): Dense {
  const { dim } = a
  const out = dense(dim)
  for (let i = 0; i < dim; i++) {
    for (let j = 0; j < dim; j++) {
      let sr = 0
      let si = 0
      for (let k = 0; k < dim; k++) {
        const ar = a.re[i * dim + k]
        const ai = a.im[i * dim + k]
        const br = b.re[k * dim + j]
        const bi = b.im[k * dim + j]
        sr += ar * br - ai * bi
        si += ar * bi + ai * br
      }
      out.re[i * dim + j] = sr
      out.im[i * dim + j] = si
    }
  }
  return out
}

/** A† — transpose and conjugate. */
function adjoint(a: Dense): Dense {
  const { dim } = a
  const out = dense(dim)
  for (let i = 0; i < dim; i++) {
    for (let j = 0; j < dim; j++) {
      out.re[i * dim + j] = a.re[j * dim + i]
      out.im[i * dim + j] = -a.im[j * dim + i]
    }
  }
  return out
}

/** Re Tr(A). Every matrix this is asked for here is Hermitian. */
function traceRe(a: Dense): number {
  let sum = 0
  for (let i = 0; i < a.dim; i++) sum += a.re[i * a.dim + i]
  return sum
}

/** max |A_ij − B_ij| over the whole matrix. */
function maxAbsDiff(a: Dense, b: Dense): number {
  let worst = 0
  for (let i = 0; i < a.re.length; i++) {
    const d = Math.hypot(a.re[i] - b.re[i], a.im[i] - b.im[i])
    if (d > worst) worst = d
  }
  return worst
}

/**
 * A complex Givens rotation on the pair (p, q): the identity except for
 *
 *     G_pp = cos θ           G_pq = −sin θ·e^{−iφ}
 *     G_qp =  sin θ·e^{iφ}   G_qq =  cos θ
 *
 * Unitary for every θ and φ — the two columns have unit norm and their inner
 * product is −cs·e^{−iφ} + cs·e^{−iφ} = 0. Asserted numerically anyway.
 */
function givens(
  dim: number,
  p: number,
  q: number,
  theta: number,
  phi: number
): Dense {
  const g = identity(dim)
  const c = Math.cos(theta)
  const s = Math.sin(theta)
  g.re[p * dim + p] = c
  g.re[q * dim + q] = c
  g.re[p * dim + q] = -s * Math.cos(phi)
  g.im[p * dim + q] = s * Math.sin(phi)
  g.re[q * dim + p] = s * Math.cos(phi)
  g.im[q * dim + p] = s * Math.sin(phi)
  return g
}

/**
 * A deterministic generator. Every "random" matrix in this file is the same
 * matrix on every run: a verification suite that goes red one time in fifty is
 * a suite that gets ignored.
 */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

/** A unitary as an explicit product of Givens rotations and a phase diagonal. */
function randomUnitary(dim: number, rand: () => number): Dense {
  let v = identity(dim)
  if (dim > 1) {
    for (let step = 0; step < 4 * dim; step++) {
      const p = Math.floor(rand() * dim)
      let q = Math.floor(rand() * (dim - 1))
      if (q >= p) q++
      v = matMul(
        v,
        givens(
          dim,
          Math.min(p, q),
          Math.max(p, q),
          rand() * Math.PI,
          rand() * 2 * Math.PI
        )
      )
    }
  }
  const phases = identity(dim)
  for (let i = 0; i < dim; i++) {
    const angle = rand() * 2 * Math.PI
    phases.re[i * dim + i] = Math.cos(angle)
    phases.im[i * dim + i] = Math.sin(angle)
  }
  return matMul(v, phases)
}

/** V·diag(λ)·V† — a Hermitian matrix whose spectrum is known by construction. */
function conjugateBy(v: Dense, lambdas: readonly number[]): Dense {
  const { dim } = v
  const lambda = dense(dim)
  for (let i = 0; i < dim; i++) lambda.re[i * dim + i] = lambdas[i]
  return matMul(matMul(v, lambda), adjoint(v))
}

/** How far V is from unitary, so a construction cannot be trusted untested. */
function unitarityDefect(v: Dense): number {
  return maxAbsDiff(matMul(adjoint(v), v), identity(v.dim))
}

/* ══════════════════════════ states, built by hand ════════════════════════ */

/**
 * A normalised statevector from a sparse list of `[index, re, im]`.
 *
 * The engine's `alloc` is not used: this file builds the object literal, so a
 * defect in the allocator cannot reach the numbers being checked.
 */
function makeState(
  qubits: number,
  entries: readonly (readonly [number, number, number])[]
): Statevector {
  const size = 1 << qubits
  const re = new Float64Array(size)
  const im = new Float64Array(size)
  for (const [index, r, i] of entries) {
    re[index] += r
    im[index] += i
  }
  let norm = 0
  for (let k = 0; k < size; k++) norm += re[k] * re[k] + im[k] * im[k]
  const scale = 1 / Math.sqrt(norm)
  for (let k = 0; k < size; k++) {
    re[k] *= scale
    im[k] *= scale
  }
  return { qubits, size, re, im }
}

/** (|0…0⟩ + |1…1⟩)/√2. */
function ghz(qubits: number): Statevector {
  return makeState(qubits, [
    [0, 1, 0],
    [(1 << qubits) - 1, 1, 0],
  ])
}

/** (|10…0⟩ + … + |0…01⟩)/√n — exactly one excitation, delocalised. */
function wState(qubits: number): Statevector {
  const entries: (readonly [number, number, number])[] = []
  for (let q = 0; q < qubits; q++) entries.push([1 << q, 1, 0] as const)
  return makeState(qubits, entries)
}

/** The four Bell states, by their amplitudes in the little-endian basis. */
const BELL_STATES: Record<string, Statevector> = {
  'Φ+': makeState(2, [
    [0, 1, 0],
    [3, 1, 0],
  ]),
  'Φ−': makeState(2, [
    [0, 1, 0],
    [3, -1, 0],
  ]),
  'Ψ+': makeState(2, [
    [1, 1, 0],
    [2, 1, 0],
  ]),
  'Ψ−': makeState(2, [
    [1, 1, 0],
    [2, -1, 0],
  ]),
}

/** ρ = |ψ⟩⟨ψ| by the outer product, written here rather than imported. */
function densityOfState(state: Statevector): DensityMatrix {
  const dim = state.size
  const re = new Float64Array(dim * dim)
  const im = new Float64Array(dim * dim)
  for (let r = 0; r < dim; r++) {
    for (let c = 0; c < dim; c++) {
      // ψ_r · conj(ψ_c)
      re[r * dim + c] = state.re[r] * state.re[c] + state.im[r] * state.im[c]
      im[r * dim + c] = state.im[r] * state.re[c] - state.re[r] * state.im[c]
    }
  }
  return { qubits: state.qubits, dim, size: dim * dim, re, im }
}

/** A DensityMatrix wrapper around a Dense of the right size. */
function asDensity(matrix: Dense, qubits: number): DensityMatrix {
  return {
    qubits,
    dim: matrix.dim,
    size: matrix.dim * matrix.dim,
    re: matrix.re,
    im: matrix.im,
  }
}

function asDense(rho: DensityMatrix | HermitianMatrix): Dense {
  return { dim: rho.dim, re: rho.re, im: rho.im }
}

/** ρ = Σ wᵢ ρᵢ, entry by entry. */
function mixture(
  qubits: number,
  parts: readonly (readonly [number, DensityMatrix | Dense])[]
): DensityMatrix {
  const dim = parts[0][1].dim
  const re = new Float64Array(dim * dim)
  const im = new Float64Array(dim * dim)
  for (const [weight, part] of parts) {
    for (let i = 0; i < re.length; i++) {
      re[i] += weight * part.re[i]
      im[i] += weight * part.im[i]
    }
  }
  return { qubits, dim, size: dim * dim, re, im }
}

/** I/2ⁿ, the maximally mixed state. */
function maximallyMixed(qubits: number): DensityMatrix {
  const dim = 1 << qubits
  const re = new Float64Array(dim * dim)
  const im = new Float64Array(dim * dim)
  for (let i = 0; i < dim; i++) re[i * dim + i] = 1 / dim
  return { qubits, dim, size: dim * dim, re, im }
}

/** ρ_W(p) = p·|B⟩⟨B| + (1 − p)·I/4, for any two-qubit |B⟩. */
function werner(p: number, bell: Statevector): DensityMatrix {
  return mixture(2, [
    [p, densityOfState(bell)],
    [1 - p, maximallyMixed(2)],
  ])
}

/* ═══════════════ closed forms, each derived in the header ════════════════ */

/** C = 2·|ψ₀₀ψ₁₁ − ψ₀₁ψ₁₀| — the amplitudes alone, no partial trace. */
function pureConcurrence(state: Statevector): number {
  const ad = {
    re: state.re[0] * state.re[3] - state.im[0] * state.im[3],
    im: state.re[0] * state.im[3] + state.im[0] * state.re[3],
  }
  const bc = {
    re: state.re[1] * state.re[2] - state.im[1] * state.im[2],
    im: state.re[1] * state.im[2] + state.im[1] * state.re[2],
  }
  return 2 * Math.hypot(ad.re - bc.re, ad.im - bc.im)
}

/**
 * The X-state closed form, with the basis ordered 00, 01, 10, 11:
 *
 *     C = 2·max(0, |ρ₁₂| − √(ρ₀₀ρ₃₃), |ρ₀₃| − √(ρ₁₁ρ₂₂))
 *
 * Valid whenever every entry outside the diagonal and the two antidiagonal
 * pairs vanishes, which is true of every reduced pair of a W or GHZ state and
 * of every Werner state.
 */
function xStateConcurrence(rho: DensityMatrix): number {
  const at = (r: number, c: number): number =>
    Math.hypot(rho.re[r * 4 + c], rho.im[r * 4 + c])
  const first = at(1, 2) - Math.sqrt(rho.re[0] * rho.re[15])
  const second = at(0, 3) - Math.sqrt(rho.re[5] * rho.re[10])
  return 2 * Math.max(0, first, second)
}

/** F = ½(1 + r·s + √((1 − |r|²)(1 − |s|²))) for two single-qubit ρ. */
function qubitFidelityFromBloch(
  r: readonly [number, number, number],
  s: readonly [number, number, number]
): number {
  const dot = r[0] * s[0] + r[1] * s[1] + r[2] * s[2]
  const rr = r[0] * r[0] + r[1] * r[1] + r[2] * r[2]
  const ss = s[0] * s[0] + s[1] * s[1] + s[2] * s[2]
  return 0.5 * (1 + dot + Math.sqrt(Math.max(0, (1 - rr) * (1 - ss))))
}

/** ρ = ½(I + r·σ) as a one-qubit density matrix. */
function qubitDensity(r: readonly [number, number, number]): DensityMatrix {
  const re = new Float64Array([
    0.5 * (1 + r[2]),
    0.5 * r[0],
    0.5 * r[0],
    0.5 * (1 - r[2]),
  ])
  const im = new Float64Array([0, -0.5 * r[1], 0.5 * r[1], 0])
  return { qubits: 1, dim: 2, size: 4, re, im }
}

/** −Σ pᵢ log₂ pᵢ over a list of probabilities, zeros skipped. */
function shannon(values: readonly number[]): number {
  let bits = 0
  for (const p of values) {
    if (p <= 0) continue
    bits -= p * Math.log2(p)
  }
  return bits
}

/**
 * ρ for one qubit, by brute force: enumerate every basis index, split it into
 * "this qubit's bit" and "everything else", and sum ψ_a·conj(ψ_b) over every
 * pair whose remainders agree. O(4ⁿ) and obviously correct.
 */
function bruteForceQubitDensity(
  state: Statevector,
  qubit: number
): [number, number, number, number] {
  let r00 = 0
  let r11 = 0
  let re01 = 0
  let im01 = 0
  for (let a = 0; a < state.size; a++) {
    for (let b = 0; b < state.size; b++) {
      const restA = a & ~(1 << qubit)
      const restB = b & ~(1 << qubit)
      if (restA !== restB) continue
      const bitA = (a >> qubit) & 1
      const bitB = (b >> qubit) & 1
      const pr = state.re[a] * state.re[b] + state.im[a] * state.im[b]
      const pi = state.im[a] * state.re[b] - state.re[a] * state.im[b]
      if (bitA === 0 && bitB === 0) r00 += pr
      else if (bitA === 1 && bitB === 1) r11 += pr
      else if (bitA === 0 && bitB === 1) {
        re01 += pr
        im01 += pi
      }
    }
  }
  return [r00, r11, re01, im01]
}

/** A single-qubit unitary U(θ, φ, λ), written from the standard form. */
function u3(theta: number, phi: number, lambda: number): Dense {
  const c = Math.cos(theta / 2)
  const s = Math.sin(theta / 2)
  const m = dense(2)
  m.re[0] = c
  m.re[1] = -Math.cos(lambda) * s
  m.im[1] = -Math.sin(lambda) * s
  m.re[2] = Math.cos(phi) * s
  m.im[2] = Math.sin(phi) * s
  m.re[3] = Math.cos(phi + lambda) * c
  m.im[3] = Math.sin(phi + lambda) * c
  return m
}

/**
 * |ψ'⟩ = U_qubit |ψ⟩, applied by explicit enumeration of the two indices that
 * differ in bit `qubit`. Written here so that the local-unitary invariance
 * checks do not depend on `apply.ts`.
 */
function applyLocal(state: Statevector, u: Dense, qubit: number): Statevector {
  const re = new Float64Array(state.size)
  const im = new Float64Array(state.size)
  for (let index = 0; index < state.size; index++) {
    if (((index >> qubit) & 1) !== 0) continue
    const one = index | (1 << qubit)
    const a0r = state.re[index]
    const a0i = state.im[index]
    const a1r = state.re[one]
    const a1i = state.im[one]
    re[index] = u.re[0] * a0r - u.im[0] * a0i + (u.re[1] * a1r - u.im[1] * a1i)
    im[index] = u.re[0] * a0i + u.im[0] * a0r + (u.re[1] * a1i + u.im[1] * a1r)
    re[one] = u.re[2] * a0r - u.im[2] * a0i + (u.re[3] * a1r - u.im[3] * a1i)
    im[one] = u.re[2] * a0i + u.im[2] * a0r + (u.re[3] * a1i + u.im[3] * a1r)
  }
  return { qubits: state.qubits, size: state.size, re, im }
}

/**
 * The Kronecker product for the little-endian convention (D1): the operator
 * acting as `low` on qubit 0 and `high` on qubit 1 has entries
 * `M[2a+b][2c+d] = high[a][c]·low[b][d]`, because bit 0 is the least
 * significant half of the index.
 */
function kron2(high: Dense, low: Dense): Dense {
  const out = dense(4)
  for (let a = 0; a < 2; a++) {
    for (let b = 0; b < 2; b++) {
      for (let c = 0; c < 2; c++) {
        for (let d = 0; d < 2; d++) {
          const hr = high.re[a * 2 + c]
          const hi = high.im[a * 2 + c]
          const lr = low.re[b * 2 + d]
          const li = low.im[b * 2 + d]
          out.re[(a * 2 + b) * 4 + (c * 2 + d)] = hr * lr - hi * li
          out.im[(a * 2 + b) * 4 + (c * 2 + d)] = hr * li + hi * lr
        }
      }
    }
  }
  return out
}

/* ═══════════════════════════════ entropy ════════════════════════════════ */

describe('von Neumann entropy against hand-computed spectra', () => {
  it('is exactly 0 for every qubit of a product state', () => {
    // |0⟩ ⊗ |+⟩ ⊗ (|0⟩ + i|1⟩)/√2 ⊗ |1⟩, written as amplitudes so that no
    // gate application stands between the definition and the check.
    const rand = mulberry32(0x51ce)
    let state = makeState(4, [[0, 1, 0]])
    for (let q = 0; q < 4; q++) {
      state = applyLocal(
        state,
        u3(rand() * Math.PI, rand() * 2 * Math.PI, rand() * 2 * Math.PI),
        q
      )
    }
    for (let q = 0; q < 4; q++) {
      expect(qubitEntropy(state, q)).toBeCloseTo(0, DIGITS)
      expect(subsystemEntropy(state, [q])).toBeCloseTo(0, DIGITS)
    }
    // And any grouping of a product state is still a product state.
    expect(subsystemEntropy(state, [0, 2])).toBeCloseTo(0, DIGITS)
    expect(subsystemEntropy(state, [1, 2, 3])).toBeCloseTo(0, DIGITS)
  })

  it('is exactly 1 for each half of all four Bell states', () => {
    for (const [name, state] of Object.entries(BELL_STATES)) {
      for (const qubit of [0, 1]) {
        expect(qubitEntropy(state, qubit), `${name} q${qubit}`).toBeCloseTo(
          1,
          DIGITS
        )
        expect(
          subsystemEntropy(state, [qubit]),
          `${name} q${qubit} general path`
        ).toBeCloseTo(1, DIGITS)
      }
      // The pair itself is pure, so the whole register reads 0.
      expect(subsystemEntropy(state, [0, 1]), name).toBeCloseTo(0, DIGITS)
    }
  })

  it('is exactly 1 per qubit for GHZ on 3, 4 and 5 qubits', () => {
    for (const n of [3, 4, 5]) {
      const state = ghz(n)
      for (let q = 0; q < n; q++) {
        expect(qubitEntropy(state, q), `GHZ${n} q${q}`).toBeCloseTo(1, DIGITS)
      }
      // Every proper subsystem of GHZ has spectrum {½, ½}, whatever its size.
      expect(subsystemEntropy(state, [0, 1]), `GHZ${n} pair`).toBeCloseTo(
        1,
        DIGITS
      )
      if (n >= 4) {
        expect(
          subsystemEntropy(state, [0, 2, 3]),
          `GHZ${n} triple`
        ).toBeCloseTo(1, DIGITS)
      }
    }
  })

  it('reads H₂(1/n) — NOT 1 — for a qubit of the W state', () => {
    const expected: Record<number, number> = {
      3: H2_THIRD,
      4: H2_QUARTER,
      5: H2_FIFTH,
    }
    for (const n of [3, 4, 5]) {
      const state = wState(n)
      for (let q = 0; q < n; q++) {
        expect(qubitEntropy(state, q), `W${n} q${q}`).toBeCloseTo(
          expected[n],
          DIGITS
        )
        expect(
          subsystemEntropy(state, [q]),
          `W${n} q${q} general path`
        ).toBeCloseTo(expected[n], DIGITS)
      }
      // The point of the case: an implementation that detects entanglement
      // and reports the maximum would pass every test above this one.
      expect(Math.abs(qubitEntropy(state, 0) - 1)).toBeGreaterThan(0.05)
    }
  })

  it('reads the two-qubit W spectrum {(n−2)/n, 2/n, 0, 0}', () => {
    for (const n of [3, 4, 5]) {
      const state = wState(n)
      const expected = shannon([(n - 2) / n, 2 / n])
      expect(subsystemEntropy(state, [0, 1]), `W${n}`).toBeCloseTo(
        expected,
        DIGITS
      )
    }
    // Spelled out for the two cases whose values are worth naming: the
    // two-qubit subsystem of W₄ is maximally mixed on a two-dimensional
    // support and reads exactly 1, while its single qubits read 0.811.
    expect(subsystemEntropy(wState(3), [0, 1])).toBeCloseTo(H2_THIRD, DIGITS)
    expect(subsystemEntropy(wState(4), [0, 1])).toBeCloseTo(1, DIGITS)
    expect(subsystemEntropy(wState(5), [0, 1])).toBeCloseTo(
      H2_TWO_FIFTHS,
      DIGITS
    )
  })

  it('follows H₂(cos²θ) along the whole Schmidt family', () => {
    for (const theta of [0, 0.1, 0.3, Math.PI / 8, Math.PI / 4, 1.2, 1.5]) {
      const state = makeState(2, [
        [0, Math.cos(theta), 0],
        [3, Math.sin(theta), 0],
      ])
      const expected = shannon([Math.cos(theta) ** 2, Math.sin(theta) ** 2])
      expect(qubitEntropy(state, 0), `θ=${theta}`).toBeCloseTo(expected, DIGITS)
      expect(qubitEntropy(state, 1), `θ=${theta}`).toBeCloseTo(expected, DIGITS)
    }
  })

  it('agrees with a brute-force 2×2 reduction, spectrum and all', () => {
    const rand = mulberry32(0xbeef)
    const entries: (readonly [number, number, number])[] = []
    for (let i = 0; i < 32; i++) {
      entries.push([i, rand() * 2 - 1, rand() * 2 - 1] as const)
    }
    const state = makeState(5, entries)
    for (let q = 0; q < 5; q++) {
      const [r00, r11, re01, im01] = bruteForceQubitDensity(state, q)
      // Eigenvalues of a 2×2 Hermitian, by the quadratic formula.
      const mean = (r00 + r11) / 2
      const gap = Math.sqrt(((r00 - r11) / 2) ** 2 + re01 * re01 + im01 * im01)
      expect(qubitEntropy(state, q), `q${q}`).toBeCloseTo(
        shannon([mean + gap, mean - gap]),
        DIGITS
      )
    }
  })

  it('gives a subsystem and its complement the same entropy', () => {
    // Schmidt: a pure global state has equal entropy on either side of any
    // cut. It holds for every cut, so it is a strong statement about the
    // partial trace as well as about the spectrum.
    const rand = mulberry32(0x5c41)
    const entries: (readonly [number, number, number])[] = []
    for (let i = 0; i < 64; i++) {
      entries.push([i, rand() * 2 - 1, rand() * 2 - 1] as const)
    }
    const state = makeState(6, entries)
    const cuts: [number[], number[]][] = [
      [[0], [1, 2, 3, 4, 5]],
      [
        [0, 3],
        [1, 2, 4, 5],
      ],
      [
        [1, 4, 5],
        [0, 2, 3],
      ],
      [
        [2, 3, 4, 5],
        [0, 1],
      ],
    ]
    for (const [left, right] of cuts) {
      expect(
        subsystemEntropy(state, left),
        `${left.join('')} vs ${right.join('')}`
      ).toBeCloseTo(subsystemEntropy(state, right), DIGITS)
    }
  })

  it('is unchanged by a local unitary on any qubit', () => {
    const rand = mulberry32(0x10ca1)
    const entries: (readonly [number, number, number])[] = []
    for (let i = 0; i < 16; i++) {
      entries.push([i, rand() * 2 - 1, rand() * 2 - 1] as const)
    }
    const state = makeState(4, entries)
    const before = [0, 1, 2, 3].map((q) => qubitEntropy(state, q))
    const beforePair = subsystemEntropy(state, [0, 2])

    let rotated = state
    for (let q = 0; q < 4; q++) {
      rotated = applyLocal(
        rotated,
        u3(rand() * Math.PI, rand() * 2 * Math.PI, rand() * 2 * Math.PI),
        q
      )
    }
    for (let q = 0; q < 4; q++) {
      expect(qubitEntropy(rotated, q), `q${q}`).toBeCloseTo(before[q], DIGITS)
    }
    expect(subsystemEntropy(rotated, [0, 2])).toBeCloseTo(beforePair, DIGITS)
  })

  it('reads n bits for the maximally mixed n-qubit ρ', () => {
    for (const n of [1, 2, 3, 4, 5]) {
      expect(vonNeumannEntropy(maximallyMixed(n)), `n=${n}`).toBeCloseTo(
        n,
        DIGITS
      )
    }
  })

  it('is additive across a tensor product of mixed states', () => {
    // S(ρ ⊗ σ) = S(ρ) + S(σ). Built by an explicit Kronecker product, so a
    // subsystem-ordering error in the implementation cannot hide in it.
    const a = qubitDensity([0.6, 0, 0])
    const b = qubitDensity([0, 0.2, 0.3])
    const joint = kron2(asDense(b), asDense(a))
    expect(
      vonNeumannEntropy({ dim: 4, re: joint.re, im: joint.im })
    ).toBeCloseTo(vonNeumannEntropy(a) + vonNeumannEntropy(b), DIGITS)
  })

  it('matches binaryEntropy at the points that have a name', () => {
    expect(binaryEntropy(0)).toBe(0)
    expect(binaryEntropy(1)).toBe(0)
    expect(binaryEntropy(0.5)).toBeCloseTo(1, DIGITS)
    expect(binaryEntropy(1 / 3)).toBeCloseTo(H2_THIRD, DIGITS)
    expect(binaryEntropy(2 / 3)).toBeCloseTo(H2_THIRD, DIGITS)
    expect(binaryEntropy(0.25)).toBeCloseTo(H2_QUARTER, DIGITS)
    expect(binaryEntropy(0.2)).toBeCloseTo(H2_FIFTH, DIGITS)
    expect(binaryEntropy(0.4)).toBeCloseTo(H2_TWO_FIFTHS, DIGITS)
    expect(binaryEntropy(0.3)).toBeCloseTo(H2_THREE_TENTHS, DIGITS)
  })

  it('traces a mixed ρ down to a subsystem and reads its entropy', () => {
    // Werner at p: each qubit is maximally mixed whatever p is, because both
    // |Ψ⁻⟩⟨Ψ⁻| and I/4 reduce to I/2. So the single-qubit entropy is 1 for
    // every p — a case where "how entangled" and "how mixed" pull apart.
    for (const p of [0, 0.25, 0.5, 0.9, 1]) {
      const rho = werner(p, BELL_STATES['Ψ−'])
      const reduced = partialTraceOfDensity(rho, [0])
      expect(vonNeumannEntropy(reduced), `p=${p}`).toBeCloseTo(1, DIGITS)
    }
    // And the whole two-qubit Werner ρ has spectrum
    // {(1+3p)/4, (1−p)/4, (1−p)/4, (1−p)/4}.
    for (const p of [0, 0.25, 0.5, 0.9, 1]) {
      const rho = werner(p, BELL_STATES['Ψ−'])
      const expected = shannon([
        (1 + 3 * p) / 4,
        (1 - p) / 4,
        (1 - p) / 4,
        (1 - p) / 4,
      ])
      expect(vonNeumannEntropy(rho), `p=${p}`).toBeCloseTo(expected, DIGITS)
    }
  })
})

/* ═════════════════════════════ concurrence ══════════════════════════════ */

describe('concurrence against hand-computed closed forms', () => {
  it('is 1 for all four Bell states and 0 for a product state', () => {
    for (const [name, state] of Object.entries(BELL_STATES)) {
      expect(concurrenceOf(state, 0, 1), name).toBeCloseTo(1, DIGITS)
      expect(concurrence(densityOfState(state)), name).toBeCloseTo(1, DIGITS)
    }
    const rand = mulberry32(0x9a17)
    for (let trial = 0; trial < 8; trial++) {
      let product = makeState(2, [[0, 1, 0]])
      for (const q of [0, 1]) {
        product = applyLocal(
          product,
          u3(rand() * Math.PI, rand() * 2 * Math.PI, rand() * 2 * Math.PI),
          q
        )
      }
      expect(concurrenceOf(product, 0, 1), `trial ${trial}`).toBeCloseTo(
        0,
        DIGITS
      )
    }
  })

  it('follows C = 2|ad − bc| for every pure two-qubit state', () => {
    const rand = mulberry32(0x2f1d)
    for (let trial = 0; trial < 40; trial++) {
      const entries: (readonly [number, number, number])[] = []
      for (let i = 0; i < 4; i++) {
        entries.push([i, rand() * 2 - 1, rand() * 2 - 1] as const)
      }
      const state = makeState(2, entries)
      expect(concurrenceOf(state, 0, 1), `trial ${trial}`).toBeCloseTo(
        pureConcurrence(state),
        DIGITS
      )
    }
  })

  it('follows |sin 2θ| along cos θ|00⟩ + sin θ|11⟩', () => {
    for (const theta of [0, 0.2, Math.PI / 8, Math.PI / 4, 1.1, Math.PI / 2]) {
      const state = makeState(2, [
        [0, Math.cos(theta), 0],
        [3, Math.sin(theta), 0],
      ])
      expect(concurrenceOf(state, 0, 1), `θ=${theta}`).toBeCloseTo(
        Math.abs(Math.sin(2 * theta)),
        DIGITS
      )
    }
  })

  it('follows the Werner closed form max(0, (3p − 1)/2)', () => {
    for (const bell of ['Ψ−', 'Φ+', 'Φ−', 'Ψ+']) {
      for (const p of [0, 0.1, 1 / 3, 0.4, 0.5, 0.75, 0.9, 1]) {
        const rho = werner(p, BELL_STATES[bell])
        expect(concurrence(rho), `${bell} p=${p}`).toBeCloseTo(
          Math.max(0, (3 * p - 1) / 2),
          DIGITS
        )
      }
    }
  })

  it('stays exactly zero on the separable side of the Werner threshold', () => {
    // The interesting half of the closed form: below p = 1/3 the bracket is
    // genuinely negative and the clamp is part of the definition, not a
    // numerical guard. A coefficient error would move the crossing.
    for (const p of [0, 0.05, 0.15, 0.25, 0.3, 0.33, 1 / 3]) {
      expect(concurrence(werner(p, BELL_STATES['Ψ−'])), `p=${p}`).toBe(0)
    }
    expect(concurrence(werner(0.34, BELL_STATES['Ψ−']))).toBeGreaterThan(0)
  })

  it('reads 2/n for every pair of W_n and 0 for every pair of GHZ_n', () => {
    for (const n of [3, 4, 5]) {
      const w = wState(n)
      for (let a = 0; a < n; a++) {
        for (let b = a + 1; b < n; b++) {
          expect(concurrenceOf(w, a, b), `W${n} ${a}${b}`).toBeCloseTo(
            2 / n,
            DIGITS
          )
        }
      }
      const g = ghz(n)
      for (let a = 0; a < n; a++) {
        for (let b = a + 1; b < n; b++) {
          expect(concurrenceOf(g, a, b), `GHZ${n} ${a}${b}`).toBeCloseTo(
            0,
            DIGITS
          )
        }
      }
    }
  })

  it('agrees with the X-state closed form on reduced pairs', () => {
    for (const n of [3, 4, 5]) {
      for (const state of [wState(n), ghz(n)]) {
        const rho = partialTrace(state, [0, 1])
        expect(concurrence(rho)).toBeCloseTo(xStateConcurrence(rho), DIGITS)
      }
    }
    for (const p of [0, 0.2, 1 / 3, 0.6, 1]) {
      const rho = werner(p, BELL_STATES['Ψ−'])
      expect(concurrence(rho), `p=${p}`).toBeCloseTo(
        xStateConcurrence(rho),
        DIGITS
      )
    }
  })

  it('separates a Bell pair from the qubit it is not entangled with', () => {
    // |Φ⁺⟩ on (0,1) tensored with |0⟩ on qubit 2: one pair at 1, two at 0,
    // while all three qubits of GHZ₃ read entropy 1 and every pair reads 0.
    const state = makeState(3, [
      [0, 1, 0],
      [3, 1, 0],
    ])
    expect(concurrenceOf(state, 0, 1)).toBeCloseTo(1, DIGITS)
    expect(concurrenceOf(state, 0, 2)).toBeCloseTo(0, DIGITS)
    expect(concurrenceOf(state, 1, 2)).toBeCloseTo(0, DIGITS)
  })

  it('is unchanged by local unitaries, pure and mixed', () => {
    const rand = mulberry32(0x7e11)

    // Pure: a random two-qubit state, rotated on each wire.
    for (let trial = 0; trial < 8; trial++) {
      const entries: (readonly [number, number, number])[] = []
      for (let i = 0; i < 4; i++) {
        entries.push([i, rand() * 2 - 1, rand() * 2 - 1] as const)
      }
      let state = makeState(2, entries)
      const before = concurrenceOf(state, 0, 1)
      for (const q of [0, 1]) {
        state = applyLocal(
          state,
          u3(rand() * Math.PI, rand() * 2 * Math.PI, rand() * 2 * Math.PI),
          q
        )
      }
      expect(concurrenceOf(state, 0, 1), `pure ${trial}`).toBeCloseTo(
        before,
        DIGITS
      )
    }

    // Mixed: ρ → (V⊗U) ρ (V⊗U)†, by dense multiplication.
    for (const p of [0.2, 0.5, 0.8, 1]) {
      const rho = werner(p, BELL_STATES['Ψ−'])
      const before = concurrence(rho)
      const low = u3(
        rand() * Math.PI,
        rand() * 2 * Math.PI,
        rand() * 2 * Math.PI
      )
      const high = u3(
        rand() * Math.PI,
        rand() * 2 * Math.PI,
        rand() * 2 * Math.PI
      )
      const local = kron2(high, low)
      expect(unitarityDefect(local)).toBeLessThan(1e-12)
      const rotated = matMul(matMul(local, asDense(rho)), adjoint(local))
      expect(concurrence(asDensity(rotated, 2)), `p=${p}`).toBeCloseTo(
        before,
        DIGITS
      )
    }
  })

  it('is unchanged by swapping which qubit of the pair is which', () => {
    // The spin flip is symmetric under relabelling; the module says so in a
    // comment, and a comment is a claim.
    const rand = mulberry32(0x3355)
    for (const n of [3, 4]) {
      const entries: (readonly [number, number, number])[] = []
      for (let i = 0; i < 1 << n; i++) {
        entries.push([i, rand() * 2 - 1, rand() * 2 - 1] as const)
      }
      const state = makeState(n, entries)
      for (let a = 0; a < n; a++) {
        for (let b = a + 1; b < n; b++) {
          expect(
            concurrence(partialTrace(state, [a, b])),
            `${a}${b}`
          ).toBeCloseTo(concurrence(partialTrace(state, [b, a])), DIGITS)
        }
      }
    }
  })

  it('never exceeds 1 and never dips below 0', () => {
    const rand = mulberry32(0xa11e)
    for (let trial = 0; trial < 30; trial++) {
      // A random mixture of four random pure states — a generic ρ.
      const parts: [number, DensityMatrix][] = []
      let total = 0
      const weights = [rand(), rand(), rand(), rand()]
      for (const w of weights) total += w
      for (let k = 0; k < 4; k++) {
        const entries: (readonly [number, number, number])[] = []
        for (let i = 0; i < 4; i++) {
          entries.push([i, rand() * 2 - 1, rand() * 2 - 1] as const)
        }
        parts.push([weights[k] / total, densityOfState(makeState(2, entries))])
      }
      const value = concurrence(mixture(2, parts))
      expect(value, `trial ${trial}`).toBeGreaterThanOrEqual(0)
      expect(value, `trial ${trial}`).toBeLessThanOrEqual(1 + 1e-12)
    }
  })
})

/* ══════════════════════════════ fidelity ════════════════════════════════ */

describe('fidelity against hand-computed closed forms', () => {
  it('is |⟨ψ|φ⟩|² for two pure states', () => {
    for (const theta of [0, 0.3, Math.PI / 4, Math.PI / 2, 2.1, Math.PI]) {
      const zero = makeState(1, [[0, 1, 0]])
      const tilted = makeState(1, [
        [0, Math.cos(theta / 2), 0],
        [1, Math.sin(theta / 2), 0],
      ])
      const expected = Math.cos(theta / 2) ** 2
      expect(stateFidelity(zero, tilted), `θ=${theta}`).toBeCloseTo(
        expected,
        DIGITS
      )
      expect(
        densityStateFidelity(densityOfState(zero), tilted),
        `θ=${theta}`
      ).toBeCloseTo(expected, DIGITS)
      expect(
        densityFidelity(densityOfState(zero), densityOfState(tilted)),
        `θ=${theta}`
      ).toBeCloseTo(expected, DIGITS)
    }
  })

  it('follows the single-qubit Bloch closed form', () => {
    const rand = mulberry32(0xf1de)
    for (let trial = 0; trial < 24; trial++) {
      // Two Bloch vectors of random direction and random length ≤ 1.
      const draw = (): [number, number, number] => {
        const z = rand() * 2 - 1
        const phi = rand() * 2 * Math.PI
        const radial = Math.cbrt(rand())
        const planar = Math.sqrt(1 - z * z)
        return [
          radial * planar * Math.cos(phi),
          radial * planar * Math.sin(phi),
          radial * z,
        ]
      }
      const r = draw()
      const s = draw()
      const value = densityFidelity(qubitDensity(r), qubitDensity(s))
      expect(value, `trial ${trial}`).toBeCloseTo(
        qubitFidelityFromBloch(r, s),
        DIGITS
      )
      // Symmetric, though the two evaluations take different paths.
      expect(
        densityFidelity(qubitDensity(s), qubitDensity(r)),
        `trial ${trial} reversed`
      ).toBeCloseTo(value, DIGITS)
    }
  })

  it('is 1/d between a pure state and the maximally mixed one', () => {
    for (const n of [1, 2, 3]) {
      const rand = mulberry32(0x2b1d + n)
      const entries: (readonly [number, number, number])[] = []
      for (let i = 0; i < 1 << n; i++) {
        entries.push([i, rand() * 2 - 1, rand() * 2 - 1] as const)
      }
      const pure = densityOfState(makeState(n, entries))
      expect(densityFidelity(pure, maximallyMixed(n)), `n=${n}`).toBeCloseTo(
        1 / (1 << n),
        DIGITS
      )
      expect(densityFidelity(maximallyMixed(n), pure), `n=${n}`).toBeCloseTo(
        1 / (1 << n),
        DIGITS
      )
    }
  })

  it('collapses to ⟨ψ|σ|ψ⟩ when one argument is pure', () => {
    for (const p of [0, 0.2, 0.5, 0.9, 1]) {
      const rho = werner(p, BELL_STATES['Ψ−'])
      // ⟨Ψ⁻|ρ_W|Ψ⁻⟩ = p + (1−p)/4 = (1+3p)/4, and ⟨Φ⁺|ρ_W|Φ⁺⟩ = (1−p)/4.
      const psiMinus = densityOfState(BELL_STATES['Ψ−'])
      const phiPlus = densityOfState(BELL_STATES['Φ+'])
      expect(densityFidelity(psiMinus, rho), `Ψ− p=${p}`).toBeCloseTo(
        (1 + 3 * p) / 4,
        DIGITS
      )
      expect(densityFidelity(rho, psiMinus), `Ψ− p=${p} reversed`).toBeCloseTo(
        (1 + 3 * p) / 4,
        DIGITS
      )
      expect(densityFidelity(phiPlus, rho), `Φ+ p=${p}`).toBeCloseTo(
        (1 - p) / 4,
        DIGITS
      )
      expect(
        densityStateFidelity(rho, BELL_STATES['Ψ−']),
        `Ψ− p=${p} state path`
      ).toBeCloseTo((1 + 3 * p) / 4, DIGITS)
    }
  })

  it('reduces to the squared Bhattacharyya coefficient on diagonals', () => {
    const p = [0.1, 0.2, 0.3, 0.4]
    const q = [0.25, 0.25, 0.25, 0.25]
    let sum = 0
    for (let i = 0; i < 4; i++) sum += Math.sqrt(p[i] * q[i])
    const expected = sum * sum
    expect(distributionFidelity(p, q)).toBeCloseTo(expected, DIGITS)

    const diagonal = (values: readonly number[]): DensityMatrix => {
      const re = new Float64Array(16)
      for (let i = 0; i < 4; i++) re[i * 4 + i] = values[i]
      return { qubits: 2, dim: 4, size: 16, re, im: new Float64Array(16) }
    }
    expect(densityFidelity(diagonal(p), diagonal(q))).toBeCloseTo(
      expected,
      DIGITS
    )
  })

  it('is 1 on identical distributions and 0 on disjoint supports', () => {
    expect(distributionFidelity([0.3, 0.7], [0.3, 0.7])).toBeCloseTo(1, DIGITS)
    expect(distributionFidelity([1, 0], [0, 1])).toBeCloseTo(0, DIGITS)
    expect(distributionFidelity([1, 0], [0.5, 0.5])).toBeCloseTo(0.5, DIGITS)
  })
})

/* ═════════════════════════════ the eigensolver ══════════════════════════ */

describe('the Hermitian eigensolver, on its own', () => {
  it('returns an already-diagonal matrix untouched, sorted ascending', () => {
    const values = [3, -1, 2, 0, 7, -5]
    const dim = values.length
    const a = dense(dim)
    for (let i = 0; i < dim; i++) a.re[i * dim + i] = values[i]

    const { values: found, re, im } = eigenHermitian(a)
    const sorted = [...values].sort((x, y) => x - y)
    for (let i = 0; i < dim; i++) {
      expect(found[i], `λ${i}`).toBeCloseTo(sorted[i], DIGITS)
    }
    // The eigenvectors must be the standard basis, permuted: exactly one
    // entry of modulus 1 per column. A sort that carries the wrong vector
    // leaves the values right and this wrong.
    for (let j = 0; j < dim; j++) {
      const column: number[] = []
      for (let row = 0; row < dim; row++) {
        column.push(Math.hypot(re[row * dim + j], im[row * dim + j]))
      }
      const ones = column.filter((v) => Math.abs(v - 1) < 1e-12).length
      const zeros = column.filter((v) => v < 1e-12).length
      expect(ones, `column ${j}`).toBe(1)
      expect(zeros, `column ${j}`).toBe(dim - 1)
      const at = column.findIndex((v) => Math.abs(v - 1) < 1e-12)
      expect(values[at], `column ${j} pairing`).toBeCloseTo(found[j], DIGITS)
    }
  })

  it('handles a fully degenerate spectrum', () => {
    for (const dim of [2, 4, 8]) {
      const a = identity(dim)
      const found = eigenvaluesHermitian(a)
      for (let i = 0; i < dim; i++) {
        expect(found[i], `dim ${dim} λ${i}`).toBeCloseTo(1, DIGITS)
      }
      const system = eigenHermitian(a)
      expect(
        unitarityDefect({ dim, re: system.re, im: system.im }),
        `dim ${dim} V`
      ).toBeLessThan(1e-12)
    }
  })

  it('handles partly degenerate spectra in a rotated basis', () => {
    const cases: number[][] = [
      [2, 2, 5, 5],
      [-1, -1, -1, 3],
      [0, 0, 0, 0, 1, 1, 1, 1],
      [0.25, 0.25, 0.25, 0.25],
      [1e-8, 1e-8, 0.5, 0.5],
    ]
    const rand = mulberry32(0xd39e)
    for (const lambdas of cases) {
      const dim = lambdas.length
      const v = randomUnitary(dim, rand)
      expect(unitarityDefect(v), `V for ${lambdas.join(',')}`).toBeLessThan(
        1e-12
      )
      const a = conjugateBy(v, lambdas)
      const found = eigenvaluesHermitian(a)
      const sorted = [...lambdas].sort((x, y) => x - y)
      for (let i = 0; i < dim; i++) {
        expect(found[i], `${lambdas.join(',')} λ${i}`).toBeCloseTo(
          sorted[i],
          DIGITS
        )
      }
    }
  })

  it('keeps a tiny negative eigenvalue as a tiny negative number', () => {
    // A rank-deficient ρ comes back with eigenvalues a few ulps either side
    // of zero. The solver must report them rather than clamp or throw — the
    // clamping is the caller's job, and burying it here would hide a genuine
    // sign error later.
    const lambdas = [-3e-17, 1.5e-17, 0.3, 0.7 + 3e-17 - 1.5e-17]
    const rand = mulberry32(0x0e11)
    const v = randomUnitary(4, rand)
    expect(unitarityDefect(v)).toBeLessThan(1e-12)
    const a = conjugateBy(v, lambdas)

    const found = eigenvaluesHermitian(a)
    expect(found[0]).toBeLessThan(1e-14)
    expect(Math.abs(found[0])).toBeLessThan(1e-14)
    expect(found[2]).toBeCloseTo(0.3, DIGITS)
    expect(found[3]).toBeCloseTo(0.7, DIGITS)

    // And the entropy built on top of it is the two-outcome one, exactly.
    expect(vonNeumannEntropy({ dim: 4, re: a.re, im: a.im })).toBeCloseTo(
      H2_THREE_TENTHS,
      DIGITS
    )
  })

  it('matches the exact 2×2 quadratic formula, complex off-diagonal', () => {
    const cases: [number, number, number, number][] = [
      [0.3, -1.2, 0.5, -0.7],
      [1, 1, 0, 0],
      [0, 0, 0, 1],
      [-2.5, 4.25, 1.75, 3.5],
      [1e-9, -1e-9, 1e-9, 0],
    ]
    for (const [aa, dd, br, bi] of cases) {
      const m: HermitianMatrix = {
        dim: 2,
        re: new Float64Array([aa, br, br, dd]),
        im: new Float64Array([0, bi, -bi, 0]),
      }
      const mean = (aa + dd) / 2
      const gap = Math.sqrt(((aa - dd) / 2) ** 2 + br * br + bi * bi)
      const found = eigenvaluesHermitian(m)
      expect(found[0], `${aa},${dd},${br},${bi}`).toBeCloseTo(
        mean - gap,
        DIGITS
      )
      expect(found[1], `${aa},${dd},${br},${bi}`).toBeCloseTo(
        mean + gap,
        DIGITS
      )
    }
  })

  it('matches the exact tridiagonal Toeplitz spectrum', () => {
    // 2 on the diagonal, −1 beside it: λ_k = 2 − 2cos(kπ/(m+1)), k = 1…m.
    for (const dim of [3, 8, 16, 32]) {
      const a = dense(dim)
      for (let i = 0; i < dim; i++) {
        a.re[i * dim + i] = 2
        if (i + 1 < dim) {
          a.re[i * dim + i + 1] = -1
          a.re[(i + 1) * dim + i] = -1
        }
      }
      const found = eigenvaluesHermitian(a)
      for (let k = 1; k <= dim; k++) {
        const expected = 2 - 2 * Math.cos((k * Math.PI) / (dim + 1))
        expect(found[k - 1], `dim ${dim} k=${k}`).toBeCloseTo(expected, DIGITS)
      }
    }
  })

  it('reproduces the Pauli spectra and their eigenvectors', () => {
    const paulis: Record<string, HermitianMatrix> = {
      X: {
        dim: 2,
        re: new Float64Array([0, 1, 1, 0]),
        im: new Float64Array(4),
      },
      Y: {
        dim: 2,
        re: new Float64Array(4),
        im: new Float64Array([0, -1, 1, 0]),
      },
      Z: {
        dim: 2,
        re: new Float64Array([1, 0, 0, -1]),
        im: new Float64Array(4),
      },
    }
    for (const [name, matrix] of Object.entries(paulis)) {
      const { values, re, im } = eigenHermitian(matrix)
      expect(values[0], name).toBeCloseTo(-1, DIGITS)
      expect(values[1], name).toBeCloseTo(1, DIGITS)
      // A·v = λ·v, checked entry by entry against a dense product.
      const v: Dense = { dim: 2, re, im }
      const product = matMul({ dim: 2, re: matrix.re, im: matrix.im }, v)
      for (let j = 0; j < 2; j++) {
        for (let row = 0; row < 2; row++) {
          expect(
            product.re[row * 2 + j],
            `${name} col ${j} row ${row} re`
          ).toBeCloseTo(values[j] * re[row * 2 + j], DIGITS)
          expect(
            product.im[row * 2 + j],
            `${name} col ${j} row ${row} im`
          ).toBeCloseTo(values[j] * im[row * 2 + j], DIGITS)
        }
      }
    }
  })

  it('pins a random spectrum by its power traces', () => {
    // Newton's identities: Σλᵏ for k = 1…m determines the characteristic
    // polynomial and therefore the eigenvalues. Tr(Aᵏ) is computed by dense
    // multiplication, so this pins the spectrum without a second solver.
    const rand = mulberry32(0xc0ffee)
    for (const dim of [2, 3, 4, 5, 6, 8]) {
      const a = dense(dim)
      for (let i = 0; i < dim; i++) {
        a.re[i * dim + i] = rand() * 2 - 1
        for (let j = i + 1; j < dim; j++) {
          const r = rand() * 2 - 1
          const im = rand() * 2 - 1
          a.re[i * dim + j] = r
          a.im[i * dim + j] = im
          a.re[j * dim + i] = r
          a.im[j * dim + i] = -im
        }
      }
      const found = eigenvaluesHermitian(a)

      let power = identity(dim)
      for (let k = 1; k <= dim; k++) {
        power = matMul(power, a)
        let sum = 0
        let magnitude = 0
        for (let i = 0; i < dim; i++) {
          sum += found[i] ** k
          magnitude += Math.abs(found[i]) ** k
        }
        expect(
          Math.abs(traceRe(power) - sum),
          `dim ${dim} k=${k}`
        ).toBeLessThan(1e-9 * Math.max(1, magnitude))
      }
    }
  })

  it('reconstructs a random Hermitian matrix from its eigenpairs', () => {
    const rand = mulberry32(0x515ed)
    for (const dim of [2, 3, 5, 8, 16]) {
      const a = dense(dim)
      for (let i = 0; i < dim; i++) {
        a.re[i * dim + i] = rand() * 2 - 1
        for (let j = i + 1; j < dim; j++) {
          const r = rand() * 2 - 1
          const im = rand() * 2 - 1
          a.re[i * dim + j] = r
          a.im[i * dim + j] = im
          a.re[j * dim + i] = r
          a.im[j * dim + i] = -im
        }
      }
      const { values, re, im } = eigenHermitian(a)
      const v: Dense = { dim, re, im }
      expect(unitarityDefect(v), `dim ${dim} V†V`).toBeLessThan(1e-12)

      const rebuilt = conjugateBy(v, Array.from(values))
      expect(maxAbsDiff(rebuilt, a), `dim ${dim} VΛV†`).toBeLessThan(1e-12)

      // Ascending, as documented, and paired with the right vector.
      for (let j = 1; j < dim; j++) {
        expect(values[j], `dim ${dim} order`).toBeGreaterThanOrEqual(
          values[j - 1]
        )
      }
      const product = matMul(a, v)
      for (let j = 0; j < dim; j++) {
        for (let row = 0; row < dim; row++) {
          expect(
            product.re[row * dim + j],
            `dim ${dim} col ${j} row ${row}`
          ).toBeCloseTo(values[j] * re[row * dim + j], DIGITS)
          expect(
            product.im[row * dim + j],
            `dim ${dim} col ${j} row ${row}`
          ).toBeCloseTo(values[j] * im[row * dim + j], DIGITS)
        }
      }
    }
  })

  it('handles the degenerate corners: 1×1, and the zero matrix', () => {
    expect(
      Array.from(
        eigenvaluesHermitian({
          dim: 1,
          re: new Float64Array([2.5]),
          im: new Float64Array([0]),
        })
      )
    ).toEqual([2.5])
    const zero = dense(6)
    const found = eigenvaluesHermitian(zero)
    for (let i = 0; i < 6; i++) expect(found[i]).toBe(0)
  })

  it('refuses a matrix past the ceiling before allocating', () => {
    const dim = MAX_EIGEN_DIM + 1
    // Only the shape is needed for the refusal, so the arrays stay empty of
    // meaning; the check must happen before anything reads them.
    const oversized: HermitianMatrix = {
      dim,
      re: new Float64Array(0),
      im: new Float64Array(0),
    }
    expect(() => eigenvaluesHermitian(oversized)).toThrow(EigenTooLargeError)
    try {
      eigenvaluesHermitian(oversized)
    } catch (error) {
      expect((error as EigenTooLargeError).dim).toBe(dim)
      expect((error as EigenTooLargeError).maxDim).toBe(MAX_EIGEN_DIM)
    }
  })

  it('refuses a matrix that is not Hermitian', () => {
    const notHermitian: HermitianMatrix = {
      dim: 2,
      re: new Float64Array([0, 1, 2, 0]),
      im: new Float64Array(4),
    }
    expect(() => eigenvaluesHermitian(notHermitian)).toThrow(NotHermitianError)

    // A complex diagonal is the same defect, and the one most likely to be
    // produced by a conjugate on the wrong factor.
    const complexDiagonal: HermitianMatrix = {
      dim: 2,
      re: new Float64Array([1, 0, 0, 1]),
      im: new Float64Array([0.5, 0, 0, 0]),
    }
    expect(() => eigenvaluesHermitian(complexDiagonal)).toThrow(
      NotHermitianError
    )
  })
})

/* ═══════════════ the regimes where a metric usually goes wrong ═══════════ */

describe('the small-number regimes', () => {
  it('resolves an entropy of 4e-11 without losing it in the rounding', () => {
    // A state that is almost, but not quite, a product state. Its entropy is
    // the quantity §3.2 draws next to a Bloch arrow that looks like it reaches
    // the surface, and it is where an implementation that computed
    // 1 − purity, or that clamped early, would report a flat zero.
    for (const eps of [1e-4, 1e-6, 1e-8, 1e-10, 1e-12]) {
      let state = makeState(2, [
        [0, Math.sqrt(1 - eps), 0],
        [3, Math.sqrt(eps), 0],
      ])
      // Rotated on both wires, so the reduced ρ is not diagonal and the
      // eigensolver has to find the small eigenvalue rather than read it.
      state = applyLocal(state, u3(1.03, 0.7, 1.1), 0)
      state = applyLocal(state, u3(2.1, 1.9, 0.3), 1)

      const closed = -eps * Math.log2(eps) - (1 - eps) * Math.log2(1 - eps)
      expect(qubitEntropy(state, 0), `bloch ε=${eps}`).toBeCloseTo(closed, 13)
      expect(subsystemEntropy(state, [0]), `eigen ε=${eps}`).toBeCloseTo(
        closed,
        13
      )
      expect(qubitEntropy(state, 0), `nonzero ε=${eps}`).toBeGreaterThan(0)
    }
  })

  it('resolves a concurrence of 1e-13 to full relative precision', () => {
    // The module's header claims the Jordan–Wielandt embedding buys absolute
    // machine precision on every σ, where taking √ of an eigenvalue would
    // halve the digits. That claim is testable exactly here: the naive route
    // puts ≈1e-8 of noise into C, so any C below that would be swamped.
    for (const target of [1e-3, 1e-5, 1e-7, 1e-9, 1e-11, 1e-13]) {
      const t = 0.5 * Math.asin(target)
      const state = makeState(2, [
        [0, Math.cos(t), 0],
        [3, Math.sin(t), 0],
      ])
      const got = concurrenceOf(state, 0, 1)
      expect(Math.abs(got / target - 1), `C=${target}`).toBeLessThan(1e-9)
    }
  })

  it('puts a product state at a concurrence far below 1e-8', () => {
    // Same claim from the other side: a separable state must read 0, and the
    // route through √(eigenvalue) reports 7.6e-10 here. A regression to it
    // would leave every closed form above still passing.
    let worst = 0
    for (let k = 0; k < 200; k++) {
      let state = makeState(2, [[0, 1, 0]])
      state = applyLocal(
        state,
        u3((k * 0.37) % 3.14, (k * 1.1) % 6.28, (k * 0.7) % 6.28),
        0
      )
      state = applyLocal(
        state,
        u3((k * 0.53) % 3.14, (k * 2.3) % 6.28, (k * 1.9) % 6.28),
        1
      )
      worst = Math.max(worst, concurrenceOf(state, 0, 1))
    }
    expect(worst).toBeLessThan(1e-12)
  })

  it('follows C = q along q|Φ⁺⟩⟨Φ⁺| + (1 − q)|00⟩⟨00|', () => {
    // A rank-2 X-state whose closed form is the mixing parameter itself:
    // |ρ₀₃| = q/2 and ρ₁₁ρ₂₂ = 0, so C = 2·(q/2) = q with no cancellation
    // anywhere in the derivation.
    const phiPlus = densityOfState(BELL_STATES['Φ+'])
    const ground = densityOfState(makeState(2, [[0, 1, 0]]))
    for (const q of [0, 0.1, 0.25, 0.5, 0.75, 0.9, 1]) {
      const rho = mixture(2, [
        [q, phiPlus],
        [1 - q, ground],
      ])
      expect(concurrence(rho), `q=${q}`).toBeCloseTo(q, DIGITS)
    }
  })

  it('reads 0 for the entropy of a pure ρ of full size', () => {
    // 0·log 0 = 0, over a rank-1 8×8 whose other seven eigenvalues come back
    // at ±1e-17. A NaN or a clamp that threw would surface here.
    const rand = mulberry32(0x0bad)
    const entries: (readonly [number, number, number])[] = []
    for (let i = 0; i < 8; i++) {
      entries.push([i, rand() * 2 - 1, rand() * 2 - 1] as const)
    }
    const rho = densityOfState(makeState(3, entries))
    expect(vonNeumannEntropy(rho)).toBeCloseTo(0, 12)
    expect(densityFidelity(rho, rho)).toBeCloseTo(1, DIGITS)
  })
})

/* ══════════ the two metrics checked against each other, and the guards ═══ */

describe('cross-checks and refusals', () => {
  it('ties entropy to concurrence on every pure two-qubit state', () => {
    // For a pure pair the two metrics are one quantity twice: the Schmidt
    // weights are (1 ± √(1 − C²))/2, so S = H₂((1 + √(1 − C²))/2). The two
    // sides of that identity share no code — one is the Bloch closed form,
    // the other is an 8×8 Jordan–Wielandt decomposition — so agreement is a
    // statement about both.
    const rand = mulberry32(0x71ed)
    for (let trial = 0; trial < 40; trial++) {
      const entries: (readonly [number, number, number])[] = []
      for (let i = 0; i < 4; i++) {
        entries.push([i, rand() * 2 - 1, rand() * 2 - 1] as const)
      }
      const state = makeState(2, entries)
      const c = concurrenceOf(state, 0, 1)
      const expected = binaryEntropy(
        (1 + Math.sqrt(Math.max(0, 1 - c * c))) / 2
      )
      expect(qubitEntropy(state, 0), `trial ${trial}`).toBeCloseTo(
        expected,
        DIGITS
      )
      expect(qubitEntropy(state, 1), `trial ${trial}`).toBeCloseTo(
        expected,
        DIGITS
      )
    }
  })

  it('keeps qubit 0 the least significant bit throughout (D1)', () => {
    // |+⟩ on qubit 0, tensored with a Bell pair on qubits 1 and 2. Little
    // endian puts the Bell amplitudes at indices 0 and 6 — and every metric
    // has to agree on which wire is which, or the panel labels the rows of an
    // otherwise correct table with the wrong names.
    const state = makeState(3, [
      [0, 1, 0],
      [1, 1, 0],
      [6, 1, 0],
      [7, 1, 0],
    ])
    expect(qubitEntropy(state, 0)).toBeCloseTo(0, DIGITS)
    expect(qubitEntropy(state, 1)).toBeCloseTo(1, DIGITS)
    expect(qubitEntropy(state, 2)).toBeCloseTo(1, DIGITS)
    expect(concurrenceOf(state, 1, 2)).toBeCloseTo(1, DIGITS)
    expect(concurrenceOf(state, 0, 1)).toBeCloseTo(0, DIGITS)
    expect(concurrenceOf(state, 0, 2)).toBeCloseTo(0, DIGITS)
    expect(subsystemEntropy(state, [1, 2])).toBeCloseTo(0, DIGITS)
    expect(subsystemEntropy(state, [0, 1])).toBeCloseTo(1, DIGITS)
  })

  it('does not care in which order a subsystem is named', () => {
    const rand = mulberry32(0x0d3e)
    const entries: (readonly [number, number, number])[] = []
    for (let i = 0; i < 32; i++) {
      entries.push([i, rand() * 2 - 1, rand() * 2 - 1] as const)
    }
    const state = makeState(5, entries)
    for (const keep of [
      [0, 2],
      [1, 3, 4],
      [0, 1, 2, 3],
    ]) {
      const reversed = [...keep].reverse()
      expect(subsystemEntropy(state, keep), `${keep.join('')}`).toBeCloseTo(
        subsystemEntropy(state, reversed),
        DIGITS
      )
    }
  })

  it('agrees across the widest subsystem the solver accepts', () => {
    // A 7-qubit subsystem is a 128×128 decomposition — the documented ceiling
    // — and its entropy must equal that of the single qubit left outside it.
    const rand = mulberry32(0x1287)
    const entries: (readonly [number, number, number])[] = []
    for (let i = 0; i < 256; i++) {
      entries.push([i, rand() * 2 - 1, rand() * 2 - 1] as const)
    }
    const state = makeState(8, entries)
    expect(subsystemEntropy(state, [0, 1, 2, 3, 4, 5, 6])).toBeCloseTo(
      qubitEntropy(state, 7),
      DIGITS
    )
    // And one qubit past it is a typed refusal, not a slow answer.
    expect(() => subsystemEntropy(state, [0, 1, 2, 3, 4, 5, 6, 7])).toThrow(
      EigenTooLargeError
    )
  })

  it('refuses a Hermitian, unit-trace matrix that is not positive', () => {
    // Trace 1 and Hermitian survive most mistakes; positivity does not. A
    // spectrum of {1.2, −0.2} looks like a state to every cheap check.
    const notAState = {
      qubits: 1,
      dim: 2,
      size: 4,
      re: new Float64Array([0.5, 0.7, 0.7, 0.5]),
      im: new Float64Array(4),
    }
    expect(() => vonNeumannEntropy(notAState)).toThrow(RangeError)

    const pairNotAState: DensityMatrix = {
      qubits: 2,
      dim: 4,
      size: 16,
      re: new Float64Array([
        0.5, 0, 0, 0.9, 0, 0, 0, 0, 0, 0, 0, 0, 0.9, 0, 0, 0.5,
      ]),
      im: new Float64Array(16),
    }
    expect(() => concurrence(pairNotAState)).toThrow(RangeError)
  })

  it('refuses metrics on the wrong shape of input', () => {
    const state = ghz(3)
    expect(() => concurrence(partialTrace(state, [0, 1, 2]))).toThrow(
      RangeError
    )
    // A matrix whose trace is not 1 is not a state, whatever else it is.
    const untraced: DensityMatrix = {
      qubits: 2,
      dim: 4,
      size: 16,
      re: new Float64Array(16),
      im: new Float64Array(16),
    }
    untraced.re[0] = 0.5
    expect(() => concurrence(untraced)).toThrow(RangeError)
    expect(() => vonNeumannEntropy(untraced)).toThrow(RangeError)
    expect(() => distributionFidelity([0.5, 0.25], [0.5, 0.5])).toThrow(
      RangeError
    )
  })

  it('keeps fidelity invariant under a common unitary', () => {
    const rand = mulberry32(0xf00d)
    const rho = werner(0.6, BELL_STATES['Ψ−'])
    const sigma = werner(0.2, BELL_STATES['Φ+'])
    const before = densityFidelity(rho, sigma)
    for (let trial = 0; trial < 4; trial++) {
      const u = randomUnitary(4, rand)
      expect(unitarityDefect(u)).toBeLessThan(1e-12)
      const rotate = (m: DensityMatrix): DensityMatrix =>
        asDensity(matMul(matMul(u, asDense(m)), adjoint(u)), 2)
      expect(
        densityFidelity(rotate(rho), rotate(sigma)),
        `trial ${trial}`
      ).toBeCloseTo(before, DIGITS)
    }
  })

  it('reads a hand-built channel exactly where §3.3 would', () => {
    // The three numbers §3.3's panel prints, on density matrices this file
    // produces itself: explicit 2×2 Kraus operators, checked trace-preserving,
    // applied by dense multiplication. Nothing from `noise.ts` is involved —
    // the claim under test is that the metrics read a mixed state correctly,
    // not that any particular channel was built correctly.
    const identity2 = identity(2)
    const pauliX = dense(2)
    pauliX.re[1] = 1
    pauliX.re[2] = 1
    const pauliY = dense(2)
    pauliY.im[1] = -1
    pauliY.im[2] = 1
    const pauliZ = dense(2)
    pauliZ.re[0] = 1
    pauliZ.re[3] = -1

    const scaled = (m: Dense, factor: number): Dense => {
      const out = dense(m.dim)
      for (let i = 0; i < m.re.length; i++) {
        out.re[i] = m.re[i] * factor
        out.im[i] = m.im[i] * factor
      }
      return out
    }
    /** Σ Kₖ† Kₖ, which must be the identity for a channel to preserve trace. */
    const closureDefect = (kraus: readonly Dense[]): number => {
      const dim = kraus[0].dim
      const sum = dense(dim)
      for (const k of kraus) {
        const term = matMul(adjoint(k), k)
        for (let i = 0; i < sum.re.length; i++) {
          sum.re[i] += term.re[i]
          sum.im[i] += term.im[i]
        }
      }
      return maxAbsDiff(sum, identity(dim))
    }
    const evolve = (rho: Dense, kraus: readonly Dense[]): Dense => {
      const out = dense(rho.dim)
      for (const k of kraus) {
        const term = matMul(matMul(k, rho), adjoint(k))
        for (let i = 0; i < out.re.length; i++) {
          out.re[i] += term.re[i]
          out.im[i] += term.im[i]
        }
      }
      return out
    }

    // ── depolarising on one qubit: ρ → (1 − p)ρ + p·I/2 ──────────────────
    const plus = makeState(1, [
      [0, 1, 0],
      [1, 1, 0],
    ])
    for (const p of [0, 0.1, 0.5, 0.9, 1]) {
      const kraus = [
        scaled(identity2, Math.sqrt(1 - (3 * p) / 4)),
        scaled(pauliX, Math.sqrt(p / 4)),
        scaled(pauliY, Math.sqrt(p / 4)),
        scaled(pauliZ, Math.sqrt(p / 4)),
      ]
      expect(closureDefect(kraus), `depolarising p=${p}`).toBeLessThan(1e-12)
      const rho = asDensity(evolve(asDense(densityOfState(plus)), kraus), 1)
      // The Bloch vector shrinks by (1 − p), so the spectrum is
      // {(1 + (1−p))/2, (1 − (1−p))/2} and S = H₂(p/2).
      expect(vonNeumannEntropy(rho), `S p=${p}`).toBeCloseTo(
        binaryEntropy(p / 2),
        DIGITS
      )
      expect(densityStateFidelity(rho, plus), `⟨+|ρ|+⟩ p=${p}`).toBeCloseTo(
        1 - p / 2,
        DIGITS
      )
      expect(
        densityFidelity(rho, densityOfState(plus)),
        `F p=${p}`
      ).toBeCloseTo(1 - p / 2, DIGITS)
    }

    // ── amplitude damping with γ = 1 sends any state to |0⟩ ──────────────
    for (const gamma of [0, 0.25, 0.6, 1]) {
      const k0 = dense(2)
      k0.re[0] = 1
      k0.re[3] = Math.sqrt(1 - gamma)
      const k1 = dense(2)
      k1.re[1] = Math.sqrt(gamma)
      expect(closureDefect([k0, k1]), `damping γ=${gamma}`).toBeLessThan(1e-12)

      const one = makeState(1, [[1, 1, 0]])
      const zero = makeState(1, [[0, 1, 0]])
      const rho = asDensity(evolve(asDense(densityOfState(one)), [k0, k1]), 1)
      expect(vonNeumannEntropy(rho), `S γ=${gamma}`).toBeCloseTo(
        binaryEntropy(gamma),
        DIGITS
      )
      expect(densityStateFidelity(rho, zero), `γ=${gamma}`).toBeCloseTo(
        gamma,
        DIGITS
      )
      expect(densityStateFidelity(rho, one), `γ=${gamma}`).toBeCloseTo(
        1 - gamma,
        DIGITS
      )
    }

    // ── phase damping leaves the populations and kills the coherence ─────
    for (const lambda of [0, 0.3, 0.75, 1]) {
      const k0 = dense(2)
      k0.re[0] = 1
      k0.re[3] = Math.sqrt(1 - lambda)
      const k1 = dense(2)
      k1.re[3] = Math.sqrt(lambda)
      expect(closureDefect([k0, k1]), `phase λ=${lambda}`).toBeLessThan(1e-12)

      const rho = asDensity(evolve(asDense(densityOfState(plus)), [k0, k1]), 1)
      // Populations untouched: both diagonal entries stay at ½, so the
      // distribution is unchanged and only a state-level metric can see the
      // damage. The coherence is √(1 − λ)/2.
      expect(rho.re[0], `ρ₀₀ λ=${lambda}`).toBeCloseTo(0.5, DIGITS)
      expect(rho.re[3], `ρ₁₁ λ=${lambda}`).toBeCloseTo(0.5, DIGITS)
      const coherence = Math.sqrt(1 - lambda)
      expect(densityStateFidelity(rho, plus), `λ=${lambda}`).toBeCloseTo(
        (1 + coherence) / 2,
        DIGITS
      )
      expect(vonNeumannEntropy(rho), `S λ=${lambda}`).toBeCloseTo(
        binaryEntropy((1 - coherence) / 2),
        DIGITS
      )
    }

    // ── depolarising one HALF of a Bell pair makes a Werner state ────────
    // (D_p ⊗ I)(|Φ⁺⟩⟨Φ⁺|) = (1−p)|Φ⁺⟩⟨Φ⁺| + p·I/4, because the untouched
    // half is already maximally mixed. So the concurrence must follow the
    // Werner closed form at parameter 1 − p: C = max(0, (2 − 3p)/2), which
    // crosses zero at p = 2/3 — entanglement dying before the state does.
    for (const p of [0, 0.2, 0.5, 2 / 3, 0.8, 1]) {
      const kraus = [
        scaled(identity2, Math.sqrt(1 - (3 * p) / 4)),
        scaled(pauliX, Math.sqrt(p / 4)),
        scaled(pauliY, Math.sqrt(p / 4)),
        scaled(pauliZ, Math.sqrt(p / 4)),
      ].map((k) => kron2(identity2, k))
      expect(closureDefect(kraus), `pair p=${p}`).toBeLessThan(1e-12)

      const bell = densityOfState(BELL_STATES['Φ+'])
      const rho = asDensity(evolve(asDense(bell), kraus), 2)
      expect(concurrence(rho), `C p=${p}`).toBeCloseTo(
        Math.max(0, (2 - 3 * p) / 2),
        DIGITS
      )
      expect(densityFidelity(rho, bell), `F p=${p}`).toBeCloseTo(
        1 - (3 * p) / 4,
        DIGITS
      )
      // Each half stays maximally mixed whatever the channel did.
      expect(
        vonNeumannEntropy(partialTraceOfDensity(rho, [1])),
        `S_B p=${p}`
      ).toBeCloseTo(1, DIGITS)
    }
  })

  it('is multiplicative across a tensor product', () => {
    // F(ρ₁⊗ρ₂, σ₁⊗σ₂) = F(ρ₁,σ₁)·F(ρ₂,σ₂). Two single-qubit pairs whose
    // fidelities are known from the Bloch closed form, combined by an
    // explicit Kronecker product.
    const r1: [number, number, number] = [0.3, -0.4, 0.5]
    const s1: [number, number, number] = [-0.1, 0.2, 0.8]
    const r2: [number, number, number] = [0.7, 0.1, -0.2]
    const s2: [number, number, number] = [0, 0, 0]
    const f1 = qubitFidelityFromBloch(r1, s1)
    const f2 = qubitFidelityFromBloch(r2, s2)
    const rho = asDensity(
      kron2(asDense(qubitDensity(r2)), asDense(qubitDensity(r1))),
      2
    )
    const sigma = asDensity(
      kron2(asDense(qubitDensity(s2)), asDense(qubitDensity(s1))),
      2
    )
    expect(densityFidelity(rho, sigma)).toBeCloseTo(f1 * f2, DIGITS)
  })
})
