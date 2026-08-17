/**
 * The 2×2 complex arithmetic the decomposition needs, and nothing else.
 *
 * The layout is `@qsim/core`'s `Matrix2`: eight doubles, row-major, real and
 * imaginary interleaved, entry (r, c) at `(2r + c) · 2`. That is deliberate
 * rather than convenient — every matrix that enters this file comes out of
 * `matrixFor()`, the same function the simulator's kernel loads, so a
 * decomposition proved correct here is proved against the matrices the engine
 * actually applies rather than against a second copy of the catalog.
 *
 * ── WHY A ZYZ EXTRACTION AND NOT A TABLE OF ANGLES ───────────────────────
 *
 * `euler.ts` does keep an exact table for the catalog's one-qubit gates,
 * because `rz(pi/2)` is worth far more to a reader than
 * `rz(1.5707963267948966)` and because an exact table can be *derived* and
 * checked entry by entry. But two jobs cannot be done from a table:
 *
 *   1. Fusing a run of consecutive one-qubit gates into one. The product of
 *      two catalog gates is generally not a catalog gate, and the fused
 *      operation has to be re-expressed in the native basis somehow.
 *   2. Taking a square root. A doubly-controlled U is built from √U, and √U
 *      of an arbitrary gate is not in the catalog either.
 *
 * Both need "given this 2×2, what are its Euler angles", so it lives here.
 *
 * ── GLOBAL PHASE IS CARRIED, NOT DISCARDED ───────────────────────────────
 *
 * `zyzOf` returns a fourth number, `phase`, with the property
 *
 *     M = e^{i·phase} · U(theta, phi, lambda)
 *
 * and every caller that controls a gate must use it. This is the trap
 * `@qsim/core`'s `gates.ts` header names: `rz(θ)` and `p(θ)` differ by a global
 * phase, which is unobservable — until the gate is controlled, at which point
 * the phase lands on the |1⟩ branch of the control and `crz` and `cp` become
 * genuinely different operations. A controlled-U built from angles alone would
 * silently emit `cp` where the document said `crz`, and every test that
 * compares final states of an uncontrolled circuit would pass.
 */

/** A 2×2 complex matrix in `@qsim/core`'s layout: 8 doubles. */
export type Matrix2 = Float64Array

/** How close two doubles must be to count as the same angle here. */
const EPSILON = 1e-12

/** Real part of entry (row, column). */
export function re(m: Matrix2, row: number, column: number): number {
  return m[(2 * row + column) * 2] as number
}

/** Imaginary part of entry (row, column). */
export function im(m: Matrix2, row: number, column: number): number {
  return m[(2 * row + column) * 2 + 1] as number
}

/** The 2×2 identity. */
export function identity2(): Matrix2 {
  return new Float64Array([1, 0, 0, 0, 0, 0, 1, 0])
}

/**
 * `a · b` — the matrix of "apply b, then apply a".
 *
 * Note the order: a circuit is read left to right in time and a matrix product
 * right to left, so fusing a run of gates means folding with the new gate on
 * the *left*. Every call site here says which it means.
 */
export function multiply(a: Matrix2, b: Matrix2): Matrix2 {
  const out = new Float64Array(8)
  for (let row = 0; row < 2; row++) {
    for (let column = 0; column < 2; column++) {
      let sumRe = 0
      let sumIm = 0
      for (let k = 0; k < 2; k++) {
        const ar = re(a, row, k)
        const ai = im(a, row, k)
        const br = re(b, k, column)
        const bi = im(b, k, column)
        sumRe += ar * br - ai * bi
        sumIm += ar * bi + ai * br
      }
      out[(2 * row + column) * 2] = sumRe
      out[(2 * row + column) * 2 + 1] = sumIm
    }
  }
  return out
}

/** Scale every entry by the complex number `(sr, si)`. */
export function scale(m: Matrix2, sr: number, si: number): Matrix2 {
  const out = new Float64Array(8)
  for (let i = 0; i < 8; i += 2) {
    const r = m[i] as number
    const v = m[i + 1] as number
    out[i] = r * sr - v * si
    out[i + 1] = r * si + v * sr
  }
  return out
}

/**
 * Euler angles in Qiskit's U convention, plus the global phase that was left
 * over — see the header for why the phase is part of the answer.
 */
export interface EulerAngles {
  /** Polar angle, always in [0, π]. */
  readonly theta: number
  readonly phi: number
  readonly lambda: number
  /** `M = e^{i·phase} · U(theta, phi, lambda)`. */
  readonly phase: number
}

/**
 * The matrix `e^{i·phase} · U(theta, phi, lambda)`.
 *
 * `U(θ,φ,λ)` is spelled out here rather than taken from `@qsim/core`'s
 * `uMatrix` for one reason: this is the inverse of `zyzOf`, and a pair of
 * functions that claim to invert each other should not be able to agree
 * because they share a bug. `euler.test.ts` checks this one against `uMatrix`
 * directly.
 */
export function matrixOf(angles: EulerAngles): Matrix2 {
  const { theta, phi, lambda, phase } = angles
  const c = Math.cos(theta / 2)
  const s = Math.sin(theta / 2)
  return scale(
    new Float64Array([
      c,
      0,
      -Math.cos(lambda) * s,
      -Math.sin(lambda) * s,
      Math.cos(phi) * s,
      Math.sin(phi) * s,
      Math.cos(phi + lambda) * c,
      Math.sin(phi + lambda) * c,
    ]),
    Math.cos(phase),
    Math.sin(phase)
  )
}

/**
 * A 2×2 unitary read as `e^{i·phase} · U(theta, phi, lambda)`.
 *
 * θ comes from the *moduli* of the first column, which are `cos(θ/2)` and
 * `sin(θ/2)` and are therefore both non-negative — so `atan2` of the two puts
 * θ in [0, π] with no branch to choose. The three phases then come from the
 * arguments of three entries, which is where the two degenerate cases are:
 * when θ is 0 the second column carries no information about φ separately from
 * λ, and when θ is π the first column carries none. In both, one of the two is
 * free and is set to zero — any choice describes the same matrix, and zero is
 * the one that drops out of the emitted circuit.
 */
export function zyzOf(m: Matrix2): EulerAngles {
  const c = Math.hypot(re(m, 0, 0), im(m, 0, 0))
  const s = Math.hypot(re(m, 1, 0), im(m, 1, 0))
  const theta = 2 * Math.atan2(s, c)

  if (s <= EPSILON) {
    // Diagonal: M = e^{iγ}·diag(1, e^{i(φ+λ)}). Only the sum is determined.
    const phase = Math.atan2(im(m, 0, 0), re(m, 0, 0))
    const total = Math.atan2(im(m, 1, 1), re(m, 1, 1)) - phase
    return { theta: 0, phi: 0, lambda: total, phase }
  }
  if (c <= EPSILON) {
    // Antidiagonal: M = e^{iγ}·[[0, -e^{iλ}], [e^{iφ}, 0]]. λ is set to 0, so
    // e^{iγ} is read off the top-right entry with its minus sign undone.
    const phase = Math.atan2(-im(m, 0, 1), -re(m, 0, 1))
    const phi = Math.atan2(im(m, 1, 0), re(m, 1, 0)) - phase
    return { theta: Math.PI, phi, lambda: 0, phase }
  }

  const phase = Math.atan2(im(m, 0, 0), re(m, 0, 0))
  const phi = Math.atan2(im(m, 1, 0), re(m, 1, 0)) - phase
  const lambda = Math.atan2(-im(m, 0, 1), -re(m, 0, 1)) - phase
  return { theta, phi, lambda, phase }
}

/**
 * A square root of a 2×2 unitary: `sqrtOf(M)² = M`.
 *
 * Needed by exactly one construction — a doubly-controlled gate, which is
 * `CV · CX · CV† · CX · CV` with `V² = U` — and correct for any unitary input.
 *
 * ── HOW ──────────────────────────────────────────────────────────────────
 *
 * Split off the determinant's phase so that what is left is in SU(2):
 * `det M = e^{2iξ}` gives `W = e^{-iξ}M` with `det W = 1`. Every SU(2) element
 * is a rotation, `W = cos(β/2)·I − i·sin(β/2)·(n̂·σ)`, and halving a rotation
 * halves its angle — so `√W = cos(β/4)·I − i·sin(β/4)·(n̂·σ)`.
 *
 * The axis is not extracted as an axis, but the *traceless part* is, and that
 * is the whole of the numerical care here:
 *
 *     D = W − cos(β/2)·I = −i·sin(β/2)·(n̂·σ)
 *     √W = cos(β/4)·I + [sin(β/4)/sin(β/2)]·D
 *
 * ── WHY IT IS WRITTEN THIS WAY AND NOT THE OTHER TWO OBVIOUS WAYS ────────
 *
 * The compact form `√W = a·I + b·W` with `a = cos(β/4) − b·cos(β/2)` is the
 * same identity with `D` multiplied out, and it is wrong at both ends of the
 * domain — which is exactly where a doubly-controlled *rotation* lives, since
 * `cu`/`crz`/`crx` with a small angle is the commonest degenerate case a user
 * can draw:
 *
 *   near β = 0    `b·W` and `a·I` are each ≈ 1 and cancel to something ≈ β/4.
 *   near β = 2π   `b = sin(β/4)/sin(β/2)` grows without bound while `I + W`
 *                 goes to zero, so the product is 0 × ∞ evaluated in floats.
 *                 `sqrtOf(rz(2π − 1e-7))` squared back to something 2.4e-2
 *                 from its input.
 *
 * Keeping `D` intact fixes both: its entries are *already* O(sin(β/2)), the
 * large coefficient multiplies small numbers to give O(1), and nothing large
 * is ever subtracted from anything large.
 *
 * The second trap was reading `sin(β/2)` as `√(1 − cos²(β/2))`. For
 * |β| < ~3e-8 the cosine rounds to exactly 1 in Float64, so that answered 0,
 * the "W = ±I" branch fired, and the root came back as the identity — a
 * doubly-controlled rotation *silently vanishing from the emitted program*.
 * Here `sin(β/2)` is `‖D‖_F/√2`, which is built from the entries that carry
 * the sine itself and never from a difference of two near-equal numbers.
 *
 * `sin(β/2) = 0` exactly is still two cases and they are genuinely different:
 * `W = I`, whose root is `I`, and `W = −I`, a full turn whose root is a half
 * turn about *any* axis. The z axis is chosen there, so
 * `√(−I) = diag(−i, i) = rz(π)` — a rotation the native basis spells for free.
 */
export function sqrtOf(m: Matrix2): Matrix2 {
  // det M = m₀₀·m₁₁ − m₀₁·m₁₀
  const detRe =
    re(m, 0, 0) * re(m, 1, 1) -
    im(m, 0, 0) * im(m, 1, 1) -
    (re(m, 0, 1) * re(m, 1, 0) - im(m, 0, 1) * im(m, 1, 0))
  const detIm =
    re(m, 0, 0) * im(m, 1, 1) +
    im(m, 0, 0) * re(m, 1, 1) -
    (re(m, 0, 1) * im(m, 1, 0) + im(m, 0, 1) * re(m, 1, 0))
  const xi = Math.atan2(detIm, detRe) / 2

  const w = scale(m, Math.cos(-xi), Math.sin(-xi))
  // Tr(W)/2 is real for W in SU(2); the imaginary part is float dust.
  const half = clampUnit((re(w, 0, 0) + re(w, 1, 1)) / 2)

  // D = W − cos(β/2)·I, and ‖D‖_F = √2·|sin(β/2)| because (n̂·σ)² = I.
  const d = new Float64Array(w)
  d[0] = (d[0] as number) - half
  d[6] = (d[6] as number) - half
  let square = 0
  for (let i = 0; i < 8; i++) square += (d[i] as number) * (d[i] as number)
  const sinHalf = Math.sqrt(square / 2)

  const rootW =
    sinHalf === 0
      ? half >= 0
        ? identity2()
        : new Float64Array([0, -1, 0, 0, 0, 0, 0, 1])
      : rootFromTracelessPart(d, half, sinHalf)

  return scale(rootW, Math.cos(xi / 2), Math.sin(xi / 2))
}

/**
 * `cos(β/4)·I + sin(β/4)·(D/‖D‖)`, with `D/‖D‖` formed first.
 *
 * Dividing before multiplying is deliberate: near a full turn `sin(β/4)/
 * sin(β/2)` overflows towards infinity while `D` goes to zero, and a product
 * of those two in that order is NaN. `unit` is O(1) at every angle, so the
 * result is bounded by construction.
 *
 * `atan2(sin, cos)` rather than `acos(cos)` for the half-angle: `acos` loses
 * half its significant digits as its argument approaches ±1, which is the only
 * region this function is ever numerically interesting in.
 */
function rootFromTracelessPart(
  d: Float64Array,
  half: number,
  sinHalf: number
): Matrix2 {
  const quarter = Math.atan2(sinHalf, half) / 2
  const cosQuarter = Math.cos(quarter)
  const sinQuarter = Math.sin(quarter)

  const out = new Float64Array(8)
  for (let i = 0; i < 8; i++) {
    out[i] = (sinQuarter * (d[i] as number)) / sinHalf
  }
  out[0] = (out[0] as number) + cosQuarter
  out[6] = (out[6] as number) + cosQuarter
  return out
}

function clampUnit(value: number): number {
  return value > 1 ? 1 : value < -1 ? -1 : value
}

/**
 * How far this matrix is from unitary, as `max |M†M − I|`. Used by the tests
 * and by nothing else; it is here rather than in a test file because the
 * property it measures is a property of this module.
 */
export function unitarityDefect(m: Matrix2): number {
  let worst = 0
  for (let row = 0; row < 2; row++) {
    for (let column = 0; column < 2; column++) {
      let sumRe = 0
      let sumIm = 0
      for (let k = 0; k < 2; k++) {
        // (M†M)[row][column] = Σ conj(M[k][row]) · M[k][column]
        const ar = re(m, k, row)
        const ai = -im(m, k, row)
        const br = re(m, k, column)
        const bi = im(m, k, column)
        sumRe += ar * br - ai * bi
        sumIm += ar * bi + ai * br
      }
      const expected = row === column ? 1 : 0
      worst = Math.max(worst, Math.abs(sumRe - expected), Math.abs(sumIm))
    }
  }
  return worst
}
