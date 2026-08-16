/**
 * A Hermitian eigensolver — the one piece of dense linear algebra this engine
 * has to own, and the reason it can compute an entropy at all.
 *
 * §3.2 asks for the von Neumann entropy S(ρ) = −Tr(ρ log₂ ρ) and for the
 * concurrence of a pair of qubits. Both are functions of a *spectrum*: the
 * logarithm of a matrix is defined through its eigenvalues, and the
 * concurrence is a sum of square roots of them. There is no index-pairing
 * trick for that — a spectrum is not a local rearrangement of the entries —
 * so this file is a genuine O(m³) decomposition and is priced accordingly
 * (see `MAX_EIGEN_DIM`). §12.3 forbids a dependency, so it is written here.
 *
 * ────────────────────────────────────────────────────────────────────────
 * THE METHOD: CYCLIC JACOBI, EXTENDED TO COMPLEX HERMITIAN
 *
 * The standard library answer (LAPACK's `zheevd`) is Householder reduction to
 * real tridiagonal form followed by an implicit-QL sweep. It is roughly an
 * order of magnitude faster than Jacobi at large m. Jacobi is chosen anyway,
 * for three reasons, in order of weight:
 *
 *  1. **Relative accuracy on the small eigenvalues, which is the whole job
 *     here.** Entropy weights each eigenvalue by log₂ of itself, so the
 *     eigenvalues *near zero* are the ones whose relative error survives into
 *     the answer: an eigenvalue of 1e-8 known to ±1e-16 absolute contributes
 *     2.1e-7 bits and is harmless, while the same eigenvalue known only to
 *     ±1e-8 could as easily be 2e-8 and contributes anything. Tridiagonal
 *     methods guarantee absolute accuracy, ‖λ̂ − λ‖ ≤ ε‖A‖, which for a
 *     density matrix (‖A‖ ≈ 1) says nothing at all about a λ of 1e-8. Jacobi
 *     applied to a positive definite matrix is accurate to *relative*
 *     precision on every eigenvalue, however small — the Demmel–Veselić
 *     result — and that is exactly the regime a reduced ρ lives in: near-pure
 *     subsystems have one eigenvalue near 1 and the rest near 0.
 *  2. **It is short enough to be checked by reading.** Two loops, one closed
 *     form, no deflation criterion, no shift strategy, no ambiguous
 *     convergence heuristics. A wrong shift in a QL implementation produces a
 *     plausible spectrum, and "plausible but wrong" is the failure this whole
 *     module is written against.
 *  3. **It converges unconditionally.** Every rotation strictly decreases the
 *     off-diagonal norm, so there is no input for which it stalls; the sweep
 *     cap below is a tripwire, not a strategy.
 *
 * The cost is the trade: O(m³) per sweep and typically six to nine sweeps,
 * against O(m³) once. At the sizes this engine asks for — a two-qubit reduced
 * ρ is 4×4, and `MAX_EIGEN_DIM` caps a subsystem at 128×128 — that trade is
 * paid in milliseconds and bought with accuracy on the numbers that matter.
 *
 * ONE ROTATION, IN TWO STEPS. The real Jacobi rotation zeroes a symmetric
 * pair (p, q) by choosing an angle. A Hermitian pair needs one more degree of
 * freedom, because A_pq is complex, so the unitary is applied as a product of
 * two:
 *
 *   1. a diagonal phase D = diag(…, e^{−iθ} at q, …) with θ = arg(A_pq).
 *      D† A D leaves every modulus alone and turns A_pq into the real
 *      positive number |A_pq|;
 *   2. the ordinary real rotation on the now-real 2×2 block
 *      [[A_pp, |A_pq|], [|A_pq|, A_qq]], with the textbook closed form
 *
 *          τ = (A_qq − A_pp) / 2|A_pq|
 *          t = sign(τ) / (|τ| + √(1 + τ²))          (the smaller root)
 *          c = 1/√(1 + t²),   s = t·c
 *
 *      after which A_pp − t|A_pq| and A_qq + t|A_pq| are the new diagonal
 *      entries and the pair is exactly zero.
 *
 * Taking the *smaller* root of t² + 2τt − 1 = 0 is not a preference: it keeps
 * the rotation angle under 45°, which is what stops the two diagonal entries
 * from swapping roles on every sweep and is what makes the cancellation in
 * `A_pp − t·h` benign rather than catastrophic.
 *
 * WHAT IS STORED. The full m×m matrix, not a triangle. Hermiticity is then a
 * loop invariant that can be asserted at any point rather than a promise about
 * entries nobody wrote — and the mirrored write costs one store on a line the
 * loop already has in cache.
 *
 * OUTPUT. Eigenvalues ascending, eigenvectors as the COLUMNS of V, so that
 *
 *     A = V Λ V†     and     A·V[:,j] = λ_j·V[:,j]
 *
 * Ascending rather than descending because it puts the near-zero eigenvalues
 * — the ones a caller has to clamp — at a known end of the array. A caller
 * wanting the largest reads from the back.
 */

/**
 * A dense complex Hermitian matrix, row-major: entry (r, c) is at
 * `r * dim + c` in both arrays.
 *
 * The same layout `density.ts` uses, and deliberately structurally
 * compatible with `DensityMatrix` — a ρ can be handed straight to this file
 * with no adapter, which is the point, since every caller here has one.
 */
export interface HermitianMatrix {
  readonly dim: number
  readonly re: Float64Array
  readonly im: Float64Array
}

/** A full eigendecomposition: A = V Λ V†. */
export interface Eigensystem {
  /** The eigenvalues, ascending. Length `dim`. */
  readonly values: Float64Array
  /** Re V, row-major `dim × dim`. Column j is the eigenvector of `values[j]`. */
  readonly re: Float64Array
  /** Im V, same layout. */
  readonly im: Float64Array
  /** Sweeps the iteration needed. Diagnostic; typically six to nine. */
  readonly sweeps: number
}

/**
 * The largest matrix this solver will accept: 128×128, a 7-qubit subsystem.
 *
 * WHY A CEILING AT ALL. A sweep is O(m³) and the iteration is memory bound —
 * every rotation rewrites two rows and two columns, and a column of a
 * row-major matrix is one cache line per entry. Measured here, one full
 * decomposition takes about 1 ms at m = 16, 22 ms at m = 64, 150 ms at
 * m = 128 and 2.0 s at m = 256; the growth is the 8× of m³ plus the cache
 * falling out from under it. An entropy that takes seconds is not a slow
 * metric, it is a frozen tab, and the mode this serves (§3.3) already refuses
 * an over-large register with a typed error rather than by hanging. So the
 * refusal happens here too, before any allocation, and names the limit.
 *
 * WHY 128. It is the last power of two — the last whole number of qubits —
 * whose decomposition stays inside the sixth of a second that still reads as
 * "the panel updated" rather than as "the panel stopped". Seven qubits of
 * *subsystem* is already well past where a human reads an entropy off a
 * chart: the interesting bipartitions of a ten-qubit study circuit are one,
 * two and three qubits wide.
 *
 * The per-qubit metrics of §3.2 are unaffected: a single qubit's entropy has
 * a closed form (`metrics.qubitEntropy`) and never comes here, so the Bloch
 * panel keeps working at any register size.
 */
export const MAX_EIGEN_DIM = 128

/**
 * The sweep cap. Cyclic Jacobi converges quadratically once the off-diagonal
 * is small, and six to nine sweeps is the observed range for every matrix in
 * this repo's suites; sixty is far enough out that reaching it means
 * something is wrong rather than something is hard.
 */
export const MAX_JACOBI_SWEEPS = 60

/**
 * How far from Hermitian an input may be — an absolute bound, scaled by the
 * matrix's own magnitude so that it is meaningful for a ρ (entries ≤ 1) and
 * for anything else alike.
 *
 * Looser than D6's 1e-10 on purpose. This is an *input* check on a matrix
 * some other loop built, and a partial trace over 2²⁰ amplitudes accumulates
 * drift a decision about test tolerance never contemplated. What it has to
 * catch is a conjugate on the wrong factor, which is wrong by O(1), not by
 * 1e-12.
 */
export const HERMITICITY_TOLERANCE = 1e-9

/**
 * A matrix too large for the solver.
 *
 * A typed error rather than a string, for the same reason
 * `DensityTooLargeError` is one: the UI has to say this in three languages
 * (D2), and a translated message needs the numbers as interpolation values.
 */
export class EigenTooLargeError extends RangeError {
  readonly dim: number
  readonly maxDim: number

  constructor(dim: number) {
    super(
      `A Hermitian eigendecomposition of a ${dim}×${dim} matrix is over the ` +
        `${MAX_EIGEN_DIM}×${MAX_EIGEN_DIM} limit. The method is O(m³) and ` +
        `past that size it takes minutes; ask for a smaller subsystem.`
    )
    this.name = 'EigenTooLargeError'
    this.dim = dim
    this.maxDim = MAX_EIGEN_DIM
  }
}

/**
 * An input that is not Hermitian, to tolerance.
 *
 * Loud rather than lenient, and emphatically not "symmetrise it and carry
 * on": a matrix that is not Hermitian has complex eigenvalues, so every
 * number downstream — an entropy, a concurrence, a fidelity — would be
 * computed from the spectrum of a matrix the caller never had. Carrying the
 * defect means a failing test can print how far off it was.
 */
export class NotHermitianError extends RangeError {
  readonly defect: number
  readonly tolerance: number

  constructor(defect: number, tolerance: number) {
    super(
      `This matrix is not Hermitian: the largest |A_rc − conj(A_cr)| is ` +
        `${defect.toExponential(3)}, over the tolerance of ` +
        `${tolerance.toExponential(3)}. Its eigenvalues are not real, so no ` +
        `entropy, concurrence or fidelity computed from them would mean ` +
        `anything.`
    )
    this.name = 'NotHermitianError'
    this.defect = defect
    this.tolerance = tolerance
  }
}

/** Knobs. Both have answers that are right almost always; see the constants. */
export interface EigenOptions {
  /**
   * Relative bound on the Hermiticity defect of the input.
   * Defaults to `HERMITICITY_TOLERANCE`, scaled by max(1, ‖A‖_F).
   */
  readonly hermiticityTolerance?: number
}

/**
 * The eigenvalues of a Hermitian matrix, ascending.
 *
 * Skips accumulating the eigenvectors, which is most of the work per rotation
 * — an entropy needs the spectrum and nothing else, and it is the call this
 * file gets most often.
 */
export function eigenvaluesHermitian(
  matrix: HermitianMatrix,
  options: EigenOptions = {}
): Float64Array {
  return jacobi(matrix, false, options).values
}

/**
 * The full decomposition A = V Λ V†, eigenvalues ascending and eigenvectors
 * in the columns of V.
 *
 * Needed wherever a *function* of the matrix is wanted rather than a function
 * of its spectrum — √ρ, for the fidelity and the concurrence of `metrics.ts`.
 */
export function eigenHermitian(
  matrix: HermitianMatrix,
  options: EigenOptions = {}
): Eigensystem {
  return jacobi(matrix, true, options)
}

/**
 * The largest |A_rc − conj(A_cr)| over the matrix, the diagonal included
 * (where the statement is that A_rr is real).
 *
 * A near-copy of `density.hermiticityDefect`, and deliberately not an import
 * of it: that one is a public diagnostic *about a ρ* and takes a
 * `DensityMatrix`, this one is an input guard on any Hermitian matrix. Making
 * them one function would mean a type-only import cycle between the two
 * modules for the sake of twelve lines, and `no-circular` is a rule this repo
 * enforces for better reasons than this one would be worth breaking it for.
 */
function hermiticityDefect(matrix: HermitianMatrix): number {
  const { dim, re, im } = matrix
  let worst = 0
  for (let row = 0; row < dim; row++) {
    const rowBase = row * dim
    const diagonal = Math.abs(im[rowBase + row])
    if (diagonal > worst) worst = diagonal
    for (let column = row + 1; column < dim; column++) {
      const upper = rowBase + column
      const lower = column * dim + row
      const dr = Math.abs(re[upper] - re[lower])
      const di = Math.abs(im[upper] + im[lower])
      if (dr > worst) worst = dr
      if (di > worst) worst = di
    }
  }
  return worst
}

/** ‖A‖_F, the scale every tolerance in this file is relative to. */
function frobenius(matrix: HermitianMatrix): number {
  const { re, im } = matrix
  let sum = 0
  for (let i = 0; i < re.length; i++) sum += re[i] * re[i] + im[i] * im[i]
  return Math.sqrt(sum)
}

/**
 * √(Σ_{r≠c} |A_rc|²) — how far the working matrix still is from diagonal.
 *
 * This is the quantity every Jacobi rotation strictly decreases, so it is
 * both the convergence test and the proof that the loop terminates. Computing
 * it costs O(m²) against the O(m³) of the sweep it guards, which is why it is
 * recomputed honestly each time instead of being tracked incrementally.
 */
function offNorm(re: Float64Array, im: Float64Array, dim: number): number {
  let sum = 0
  for (let row = 0; row < dim; row++) {
    const rowBase = row * dim
    for (let column = row + 1; column < dim; column++) {
      const at = rowBase + column
      sum += re[at] * re[at] + im[at] * im[at]
    }
  }
  // The upper triangle counted once; the lower is its mirror, hence the 2.
  return Math.sqrt(2 * sum)
}

function jacobi(
  matrix: HermitianMatrix,
  wantVectors: boolean,
  options: EigenOptions
): Eigensystem {
  const { dim } = matrix
  checkShape(matrix)

  const scale = frobenius(matrix)
  if (!Number.isFinite(scale)) {
    throw new RangeError(
      'This matrix has a non-finite entry, so it has no eigenvalues to find.'
    )
  }

  const hermiticity =
    (options.hermiticityTolerance ?? HERMITICITY_TOLERANCE) * Math.max(1, scale)
  const defect = hermiticityDefect(matrix)
  if (defect > hermiticity) throw new NotHermitianError(defect, hermiticity)

  const re = matrix.re.slice()
  const im = matrix.im.slice()

  /*
   * V starts as the identity and ends holding the accumulated rotations, so
   * that A_final = V† A V is diagonal and therefore A = V Λ V†.
   *
   * Held TRANSPOSED while the iteration runs: every step touches two of V's
   * *columns*, and a column of a row-major matrix strides by `dim` — one
   * cache line per entry at any interesting size. Storing Vᵀ turns those two
   * columns into two contiguous rows. The transpose back happens once, in
   * `sortAscending`, which has to walk the whole matrix anyway to apply the
   * permutation.
   */
  const size = dim * dim
  const vre = wantVectors ? new Float64Array(size) : EMPTY
  const vim = wantVectors ? new Float64Array(size) : EMPTY
  if (wantVectors) for (let i = 0; i < dim; i++) vre[i * dim + i] = 1

  /*
   * Sweep until the off-diagonal is at the floor Float64 can express for a
   * matrix of this size and scale. `Number.EPSILON * dim * scale` is a
   * touch above the ‖·‖_F ≈ ε‖A‖_F√m that a converged decomposition actually
   * reaches, which is what keeps the loop from spinning against rounding.
   * A zero matrix has scale 0 and threshold 0, and its off-norm is already 0.
   */
  const threshold = Number.EPSILON * Math.max(4, dim) * scale

  /*
   * AN OFF-DIAGONAL BELOW HALF AN EPSILON OF THE MATRIX IS LEFT ALONE, AND
   * THAT IS A CORRECTNESS RULE RATHER THAN AN OPTIMISATION.
   *
   * The phase step divides A_pq by |A_pq| to get a unit complex number. That
   * is exact to a rounding for any *normal* entry — but `Math.hypot` of two
   * SUBNORMALS is not a norm, because subnormals carry only a handful of
   * significant bits:
   *
   *     Math.hypot(1.1e-322, 1.5e-322) = 1.83e-322
   *     c = 0.5945…, s = 0.8108…, and c² + s² = 1.0110
   *
   * — one per cent off unity. Multiplying a whole row and column by a number
   * of modulus 1.0055 is not a unitary similarity, so it MOVES THE SPECTRUM,
   * and it moves it by however large the rest of that row happens to be. This
   * was measured, not imagined: a state with a couple of subnormal amplitudes
   * produced a reduced ρ whose eigenvalues were wrong by 7e-10 — no
   * exception, no NaN, no failure of Hermiticity or of the trace, just a
   * number quietly off in the tenth digit and an entropy to match.
   *
   * Skipping the pair costs nothing: an entry this small contributes at most
   * `dim · negligible = ½·dim·ε·‖A‖` to the off-diagonal norm, which is at
   * most half of `threshold`, so the iteration can still converge with every
   * such pair left in place.
   */
  const negligible = 0.5 * Number.EPSILON * scale

  let sweeps = 0
  let off = offNorm(re, im, dim)
  while (off > threshold && sweeps < MAX_JACOBI_SWEEPS) {
    sweep(re, im, vre, vim, dim, wantVectors, negligible)
    sweeps++
    off = offNorm(re, im, dim)
  }
  if (off > 1e-10 * Math.max(1, scale)) {
    throw new Error(
      `The Jacobi iteration did not converge in ${MAX_JACOBI_SWEEPS} ` +
        `sweeps: the off-diagonal norm is still ${off.toExponential(3)}. ` +
        'Every rotation strictly decreases it, so this is unreachable for a ' +
        'finite Hermitian input and means the input was neither.'
    )
  }

  return sortAscending(re, vre, vim, dim, wantVectors, sweeps)
}

const EMPTY = new Float64Array(0)

/** One cyclic sweep: every pair (p, q) with p < q, once, in order. */
function sweep(
  re: Float64Array,
  im: Float64Array,
  vre: Float64Array,
  vim: Float64Array,
  dim: number,
  wantVectors: boolean,
  negligible: number
): void {
  for (let p = 0; p < dim - 1; p++) {
    for (let q = p + 1; q < dim; q++) {
      const pq = p * dim + q
      const h = Math.hypot(re[pq], im[pq])
      // Below the matrix's own resolution there is no angle worth choosing,
      // and dividing by `h` at that size stops producing a unit vector — see
      // `negligible` where it is computed.
      if (h <= negligible) continue

      // Step 1 — the phase, turning A_pq into the real positive h.
      const cosT = re[pq] / h
      const sinT = im[pq] / h
      phase(re, im, dim, q, cosT, sinT)
      if (wantVectors) phaseColumn(vre, vim, dim, q, cosT, sinT)

      // Step 2 — the real rotation on [[A_pp, h], [h, A_qq]].
      const app = re[p * dim + p]
      const aqq = re[q * dim + q]
      const tau = (aqq - app) / (2 * h)
      const t =
        tau >= 0
          ? 1 / (tau + Math.sqrt(1 + tau * tau))
          : -1 / (-tau + Math.sqrt(1 + tau * tau))
      const c = 1 / Math.sqrt(1 + t * t)
      const s = t * c

      rotate(re, im, dim, p, q, c, s)
      if (wantVectors) rotateColumns(vre, vim, dim, p, q, c, s)

      // The 2×2 block in closed form, so the pair is exactly zero rather
      // than nearly zero — which is what lets `offNorm` reach its floor.
      re[p * dim + p] = app - t * h
      re[q * dim + q] = aqq + t * h
      im[p * dim + p] = 0
      im[q * dim + q] = 0
      re[pq] = 0
      im[pq] = 0
      re[q * dim + p] = 0
      im[q * dim + p] = 0
    }
  }
}

/**
 * A ← D† A D with D = diag(1, …, e^{−iθ} at `q`, …, 1).
 *
 * Row q is multiplied by e^{+iθ} and column q by its conjugate. Entry (q, q)
 * would take both factors and is left alone, which is also what keeps it
 * exactly real.
 *
 * WHY THE ROW LEADS. A_kq = conj(A_qk) throughout, so either half determines
 * the other and only one of them has to be *read*. Reading the row is a
 * contiguous sweep; reading the column would touch a fresh cache line per
 * entry. The mirrored store into the column is unavoidable — the full matrix
 * is kept so Hermiticity stays checkable — but a strided write costs a
 * fraction of a strided read-modify-write.
 */
function phase(
  re: Float64Array,
  im: Float64Array,
  dim: number,
  q: number,
  cosT: number,
  sinT: number
): void {
  const rowBase = q * dim
  for (let k = 0; k < dim; k++) {
    if (k === q) continue
    const qk = rowBase + k
    const xr = re[qk]
    const xi = im[qk]
    // (xr + i·xi)·(cosT + i·sinT)
    const nr = xr * cosT - xi * sinT
    const ni = xi * cosT + xr * sinT
    re[qk] = nr
    im[qk] = ni
    const kq = k * dim + q
    re[kq] = nr
    im[kq] = -ni
  }
}

/** Vᵀ ← (V·D)ᵀ — the same phase on what is a row of the transposed store. */
function phaseColumn(
  re: Float64Array,
  im: Float64Array,
  dim: number,
  q: number,
  cosT: number,
  sinT: number
): void {
  const rowBase = q * dim
  for (let k = 0; k < dim; k++) {
    const qk = rowBase + k
    const xr = re[qk]
    const xi = im[qk]
    // Vᵀ holds conj-free copies of V's columns, so this is the e^{−iθ} of
    // the derivation applied to V[:, q], written along a row.
    re[qk] = xr * cosT + xi * sinT
    im[qk] = xi * cosT - xr * sinT
  }
}

/**
 * A ← RᵀAR for the real rotation R that is the identity except
 * R_pp = R_qq = c, R_pq = s, R_qp = −s.
 *
 * Only the k ∉ {p, q} entries: the 2×2 block is written by the closed form at
 * the call site, which is both faster and exact. Because c and s are real,
 * the column update is the conjugate of the row update, so one pass over the
 * two rows writes both halves and Hermiticity is preserved by construction
 * rather than by arithmetic.
 */
function rotate(
  re: Float64Array,
  im: Float64Array,
  dim: number,
  p: number,
  q: number,
  c: number,
  s: number
): void {
  const pBase = p * dim
  const qBase = q * dim
  for (let k = 0; k < dim; k++) {
    if (k === p || k === q) continue
    const pk = pBase + k
    const qk = qBase + k
    const pr = re[pk]
    const pi = im[pk]
    const qr = re[qk]
    const qi = im[qk]
    const npr = c * pr - s * qr
    const npi = c * pi - s * qi
    const nqr = s * pr + c * qr
    const nqi = s * pi + c * qi
    re[pk] = npr
    im[pk] = npi
    re[qk] = nqr
    im[qk] = nqi
    const kp = k * dim + p
    const kq = k * dim + q
    re[kp] = npr
    im[kp] = -npi
    re[kq] = nqr
    im[kq] = -nqi
  }
}

/** Vᵀ ← (V·R)ᵀ — rows p and q of the transposed store, both contiguous. */
function rotateColumns(
  re: Float64Array,
  im: Float64Array,
  dim: number,
  p: number,
  q: number,
  c: number,
  s: number
): void {
  const pBase = p * dim
  const qBase = q * dim
  for (let k = 0; k < dim; k++) {
    const pk = pBase + k
    const qk = qBase + k
    const pr = re[pk]
    const pi = im[pk]
    const qr = re[qk]
    const qi = im[qk]
    re[pk] = c * pr - s * qr
    im[pk] = c * pi - s * qi
    re[qk] = s * pr + c * qr
    im[qk] = s * pi + c * qi
  }
}

/**
 * Read the diagonal off, sort ascending, and transpose the eigenvector store
 * back into columns, carrying each vector with its eigenvalue.
 *
 * Permutation and transpose happen in the same pass into fresh arrays. In
 * place, either one alone needs cycle-following, and getting that wrong pairs
 * a correct eigenvalue with someone else's eigenvector — a defect that leaves
 * every eigenvalue right and every reconstruction wrong.
 */
function sortAscending(
  re: Float64Array,
  vre: Float64Array,
  vim: Float64Array,
  dim: number,
  wantVectors: boolean,
  sweeps: number
): Eigensystem {
  const order = Array.from({ length: dim }, (_unused, i) => i)
  order.sort((a, b) => re[a * dim + a] - re[b * dim + b])

  const values = new Float64Array(dim)
  for (let j = 0; j < dim; j++) values[j] = re[order[j] * dim + order[j]]
  if (!wantVectors) return { values, re: EMPTY, im: EMPTY, sweeps }

  const outRe = new Float64Array(dim * dim)
  const outIm = new Float64Array(dim * dim)
  for (let j = 0; j < dim; j++) {
    // Row `from` of the transposed store is eigenvector `from`, contiguous.
    const from = order[j] * dim
    for (let row = 0; row < dim; row++) {
      outRe[row * dim + j] = vre[from + row]
      outIm[row * dim + j] = vim[from + row]
    }
  }
  return { values, re: outRe, im: outIm, sweeps }
}

function checkShape(matrix: HermitianMatrix): void {
  const { dim, re, im } = matrix
  if (!Number.isInteger(dim) || dim < 1) {
    throw new RangeError(`A matrix needs at least one row, got dim ${dim}.`)
  }
  if (dim > MAX_EIGEN_DIM) throw new EigenTooLargeError(dim)
  if (re.length !== dim * dim || im.length !== dim * dim) {
    throw new RangeError(
      `A ${dim}×${dim} matrix needs ${dim * dim} entries in each of re and ` +
        `im, got ${re.length} and ${im.length}.`
    )
  }
}
