/**
 * The density matrix — specification §5.4, and the state representation the
 * noise mode of §3.3 runs on. Read `conventions.ts` first; everything here is
 * D1 applied twice, once to each index.
 *
 * A statevector describes a state the system *is* in. A density matrix also
 * describes a state the system might be in one of, which is the only way to
 * write down what a noise channel produces: after a depolarising kick there
 * is no vector in ℂ²ⁿ that describes the qubit, in the same way there is no
 * vector describing half of a Bell pair (§5.5). ρ is what remains, and gates
 * act on it as ρ → UρU†.
 *
 * ────────────────────────────────────────────────────────────────────────
 * LAYOUT — two parallel Float64Array, row-major, exactly as in §5.1
 *
 * ρ is 2ⁿ × 2ⁿ complex, held as `re` and `im` of length 4ⁿ each. The entry in
 * row `r` and column `c` lives at
 *
 *     index = r · dim + c            with dim = 2ⁿ
 *
 * so a row is contiguous and a column strides by `dim`. Same two-array,
 * no-objects choice `statevector.ts` makes and for the same two reasons: no
 * garbage for the collector, and a buffer that can be transferred to the
 * worker without a copy. It is deliberately NOT the interleaved layout of
 * `gates.ts` — that one exists so a 2×2 fits in a cache line and can be
 * hoisted into locals, which is a statement about eight doubles, not about
 * sixteen million.
 *
 * WHICH INDEX IS WHICH QUBIT. ρ = Σ ρ_rc |r⟩⟨c|, so bit `q` of the ROW index
 * is qubit q's value in the ket and bit `q` of the COLUMN index is its value
 * in the bra — `(r >> q) & 1` and `(c >> q) & 1`, D1 both times. A statevector
 * index and a row index of ρ therefore mean the same thing, which is what
 * makes `fromStatevector` a plain outer product and lets every kernel below
 * reuse the pairing walk of `apply.ts` unchanged.
 *
 * Worked example, 2 qubits, ρ = |01⟩⟨01| (qubit 0 set, qubit 1 clear — the
 * ket prints highest-qubit-first, so |01⟩ is index 1):
 *
 *            c=0  c=1  c=2  c=3
 *      r=0 ⎡  0    0    0    0  ⎤     the single 1 sits at index
 *      r=1 ⎢  0    1    0    0  ⎥     r·dim + c = 1·4 + 1 = 5
 *      r=2 ⎢  0    0    0    0  ⎥
 *      r=3 ⎣  0    0    0    0  ⎦
 *
 * The diagonal is the Born-rule distribution: ρ_ii is the probability of
 * basis state i, which is why `probabilities()` is a stride-(dim+1) read and
 * nothing more.
 *
 * ────────────────────────────────────────────────────────────────────────
 * MEMORY IS THE HARD LIMIT — 4ⁿ × 16 bytes
 *
 *   | qubits | entries     | bytes  |
 *   | ------ | ----------- | ------ |
 *   | 4      | 256         | 4 KB   |
 *   | 8      | 65,536      | 1 MB   |
 *   | 10     | 1,048,576   | 16 MB  |
 *   | 12     | 16,777,216  | 256 MB |
 *   | 13     | 67,108,864  | 1 GB   |
 *   | 14     | 268,435,456 | 4 GB   |
 *
 * Every qubit multiplies the bill by four, so the useful range ends abruptly:
 * §3.3 puts the mode at 10–12 qubits and calls that fine, because it is a
 * study mode and not a scale mode. `MAX_DENSITY_QUBITS` makes the ceiling
 * explicit and `assertDensityFits` is called *before* any allocation, so the
 * failure is a typed error the UI can translate rather than a tab that
 * freezes or a `RangeError` thrown from inside a typed-array constructor with
 * nothing in it a user could act on.
 *
 * ────────────────────────────────────────────────────────────────────────
 * ρ → UρU† IN PLACE, IN O(4ⁿ) — the derivation, so the loops can be checked
 * against it rather than re-derived
 *
 * The naive reading of `UρU†` builds the 2ⁿ × 2ⁿ matrix of U and multiplies
 * twice: two matrix products at O(8ⁿ) each, plus the Kronecker product §5.2
 * already forbids for the statevector. At 10 qubits that is 10⁹ multiplications
 * per gate against the 10⁶ entries the answer has. Instead, write the entry
 * out and factor it:
 *
 *     (UρU†)_rc = Σ_a Σ_b U_ra · ρ_ab · (U†)_bc
 *               = Σ_a U_ra · ( Σ_b ρ_ab · conj(U_cb) )
 *
 * because (U†)_bc = conj(U_cb). That is two separate one-sided products, and
 * each one is the statevector kernel:
 *
 *   PASS 1 — σ = Uρ,  σ_rc = Σ_a U_ra ρ_ac.  The column index is a spectator:
 *   for each fixed c, the column vector ρ_·c transforms exactly like a
 *   statevector. A one-qubit gate on target t therefore mixes PAIRS OF ROWS
 *   that differ only in bit t — the `apply.ts` walk, with the row index in the
 *   amplitude index's place and `dim` columns carried along per pair.
 *
 *   PASS 2 — ρ' = σU†,  ρ'_rc = Σ_b σ_rb · conj(U_cb).  Now the row is the
 *   spectator and the matrix is indexed (c, b): with N = conj(U) entry by
 *   entry, ρ'_rc = Σ_b N_cb σ_rb, which is the same 2×2 acting on PAIRS OF
 *   COLUMNS. Note N is the elementwise conjugate and **not** U†: the transpose
 *   half of the dagger is already spent on the fact that this pass indexes the
 *   column. Using `dagger()` here would silently apply Uᵀ-conjugated-twice and
 *   still return a Hermitian, unit-trace matrix — wrong physics, valid-looking
 *   ρ, which is the failure mode this file is written to make impossible.
 *
 * Each pass touches every entry exactly once, so a one-qubit gate costs
 * 2 × 4ⁿ complex updates: O(4ⁿ), the size of the answer, with no allocation
 * and no temporary matrix. The passes must run in that order and to
 * completion — pass 2 reads what pass 1 wrote — but within a pass every pair
 * is independent, so both are safe to parallelise later.
 *
 * CONTROLS are the same filter as in `apply.ts`, applied to whichever index
 * the pass is walking: pass 1 skips row pairs whose ROW fails the condition,
 * pass 2 skips column pairs whose COLUMN fails it. That is not a symmetry
 * chosen for elegance, it is what `CU = P·U + (I−P)·I` says once you expand
 * `CU ρ CU†`.
 *
 * TWO-QUBIT GATES split each index at two points instead of one — the three
 * nested loops of `apply.ts` — and group four rows, then four columns.
 */

import type { ControlSpec } from './apply.js'
import { stateSize } from './conventions.js'
import type { Matrix2, Matrix4 } from './gates.js'
import type { Complex, Statevector } from './statevector.js'

/**
 * D6's tolerance, as an absolute bound. Absolute rather than relative is right
 * here because ρ is normalised: every entry is bounded by 1 in magnitude, so
 * there is no scale for a relative test to be relative to.
 */
const DEFAULT_TOLERANCE = 1e-10

const NO_CONTROLS: readonly ControlSpec[] = []

/**
 * The largest register the noise mode will allocate a density matrix for.
 *
 * §3.3 fixes the range at 10–12 qubits. Twelve is the top of it and it is the
 * number the budget below picks out exactly, so the two constants cannot drift
 * apart without a test noticing.
 */
export const MAX_DENSITY_QUBITS = 12

/**
 * The memory a single density matrix may occupy: 256 MiB.
 *
 * WHY THIS NUMBER. 4ⁿ × 16 bytes lands on 256 MiB at exactly 12 qubits and on
 * 1 GiB at 13, so a budget of 256 MiB admits the whole of §3.3's range and
 * refuses the first qubit past it — there is no gap to argue about. It is also
 * a quantity a browser tab can actually hold: a typed array this size is one
 * contiguous reservation, and the Chrome heap on a laptop starts refusing
 * allocations somewhere in the gigabyte range, at which point the failure
 * arrives as a dead tab rather than as an exception anything can catch.
 *
 * A server-side or WASM core (§5.6, phase 2) could raise it. It is exported so
 * that the raise is a change in one place and so the UI can report the budget
 * it is up against instead of a bare "too large".
 */
export const DENSITY_BUDGET_BYTES = 256 * 1024 * 1024

/** Bytes a density matrix for `qubits` wires needs: 4ⁿ entries × 16. */
export function densityBytes(qubits: number): number {
  return 4 ** qubits * 16
}

/**
 * A register too large for the density-matrix mode.
 *
 * Carries the numbers rather than only a sentence, because the UI has to say
 * this in three languages (D2) and a translated message needs the register
 * size, the ceiling and both byte counts as interpolation values — a string is
 * not something a catalog can take apart. `detail` is the English fallback for
 * a log or a non-localised caller.
 *
 * Extends `RangeError` so that a caller already catching `RangeError` around
 * an allocation keeps catching this, while `instanceof DensityTooLargeError`
 * still tells the panel to offer "reduce the register" instead of "something
 * went wrong".
 */
export class DensityTooLargeError extends RangeError {
  readonly qubits: number
  readonly maxQubits: number
  readonly requiredBytes: number
  readonly budgetBytes: number

  constructor(qubits: number) {
    const requiredBytes = densityBytes(qubits)
    super(
      `A density matrix for ${qubits} qubits needs ${formatBytes(requiredBytes)}` +
        `, over the ${formatBytes(DENSITY_BUDGET_BYTES)} budget. ρ grows as 4ⁿ ` +
        `and stops at ${MAX_DENSITY_QUBITS} qubits; run this circuit with ` +
        `Monte Carlo trajectories instead (runNoisy), which carries a ` +
        `statevector of 2ⁿ and pays in shots rather than in memory.`
    )
    this.name = 'DensityTooLargeError'
    this.qubits = qubits
    this.maxQubits = MAX_DENSITY_QUBITS
    this.requiredBytes = requiredBytes
    this.budgetBytes = DENSITY_BUDGET_BYTES
  }
}

/**
 * Throw unless `qubits` names a register the mode can hold.
 *
 * Exported so the editor can ask *before* offering the noise mode at all —
 * checking the ceiling is arithmetic on one integer, and the answer decides
 * whether a tab is enabled. Every allocating function here calls it first, so
 * no path can reach a typed-array constructor with an impossible length.
 */
export function assertDensityFits(qubits: number): void {
  if (!Number.isInteger(qubits) || qubits < 1) {
    throw new RangeError(
      `A density matrix needs at least 1 qubit, got ${qubits}.`
    )
  }
  if (qubits > MAX_DENSITY_QUBITS) throw new DensityTooLargeError(qubits)
}

/**
 * A mixed state. Like `Statevector` the arrays are mutable and the shape is
 * fixed at allocation: `re.length === im.length === size === dim² === 4ⁿ`.
 */
export interface DensityMatrix {
  readonly qubits: number
  /** 2ⁿ — the side. A row index and a column index each run over `[0, dim)`. */
  readonly dim: number
  /** 4ⁿ = dim², the number of complex entries and the length of `re`/`im`. */
  readonly size: number
  readonly re: Float64Array
  readonly im: Float64Array
}

/**
 * A fresh n-qubit ρ = |0…0⟩⟨0…0|.
 *
 * One write, as in `statevector.alloc`: the pure ground state has a single
 * non-zero entry, ρ₀₀ = 1, and `Float64Array` arrives zeroed.
 */
export function alloc(qubits: number): DensityMatrix {
  assertDensityFits(qubits)
  const dim = stateSize(qubits)
  const size = dim * dim
  const rho: DensityMatrix = {
    qubits,
    dim,
    size,
    re: new Float64Array(size),
    im: new Float64Array(size),
  }
  rho.re[0] = 1
  return rho
}

/** Return an existing ρ to |0…0⟩⟨0…0|, reusing its buffers. */
export function reset(rho: DensityMatrix): void {
  rho.re.fill(0)
  rho.im.fill(0)
  rho.re[0] = 1
}

/** An independent copy — no shared buffers. */
export function clone(rho: DensityMatrix): DensityMatrix {
  return {
    qubits: rho.qubits,
    dim: rho.dim,
    size: rho.size,
    re: rho.re.slice(),
    im: rho.im.slice(),
  }
}

/**
 * ρ = |ψ⟩⟨ψ|, the outer product — how a noisy run starts, from the pure state
 * the ideal run would have produced.
 *
 * With ψ_r = a + bi and ψ_c = c + di, the entry is
 *
 *     ρ_rc = ψ_r · conj(ψ_c) = (ac + bd) + i(bc − ad)
 *
 * and the loop hoists the row's pair: the inner pass reads one amplitude and
 * writes one contiguous entry, so the whole build is a sequential sweep.
 *
 * The result is a *pure* state written as a matrix — purity 1, and the
 * diagonal is the same Born-rule distribution `measure.probabilities` reads
 * off the vector. The tests hold both of those, because they are the two
 * statements that say this conversion lost nothing.
 */
export function fromStatevector(state: Statevector): DensityMatrix {
  const rho = alloc(state.qubits)
  const { re, im, dim } = rho
  const psiRe = state.re
  const psiIm = state.im

  for (let row = 0; row < dim; row++) {
    const ar = psiRe[row]
    const ai = psiIm[row]
    const rowBase = row * dim
    for (let column = 0; column < dim; column++) {
      const br = psiRe[column]
      const bi = psiIm[column]
      re[rowBase + column] = ar * br + ai * bi
      im[rowBase + column] = ai * br - ar * bi
    }
  }
  return rho
}

/** Entry (row, column), boxed. For tests and the UI, never for the kernel. */
export function entry(
  rho: DensityMatrix,
  row: number,
  column: number
): Complex {
  checkIndex(rho, row, 'row')
  checkIndex(rho, column, 'column')
  const at = row * rho.dim + column
  return { re: rho.re[at], im: rho.im[at] }
}

/**
 * Tr(ρ) — 1 for any physical state, and the cheapest check that one still is.
 *
 * The real part only. For a Hermitian ρ the diagonal is real by construction,
 * so the imaginary part carries no information — it carries *drift*, and
 * `isHermitian` is the function that reports it, since a diagonal entry with
 * an imaginary part is precisely a Hermiticity violation at r = c.
 */
export function trace(rho: DensityMatrix): number {
  const { re, dim } = rho
  let sum = 0
  for (let i = 0; i < dim; i++) sum += re[i * dim + i]
  return sum
}

/**
 * Scale ρ back to unit trace and return the trace it had before.
 *
 * Every operation in this file preserves the trace in exact arithmetic —
 * unitary evolution does, and so does any trace-preserving Kraus channel — so
 * this only ever mops up Float64 drift, on the interval D6 fixes
 * (`RENORMALIZE_INTERVAL`, `statevector.ts`). Multiplying by the reciprocal
 * once beats 4ⁿ divisions and gives the same answer.
 *
 * Throws on a zero or non-finite trace for the same reason
 * `statevector.renormalize` does: that ρ has no physical normalisation, and
 * scattering NaNs through 4ⁿ entries would hide where the trouble began.
 */
export function renormalize(rho: DensityMatrix): number {
  const previous = trace(rho)
  if (!Number.isFinite(previous) || previous === 0) {
    throw new RangeError(`Cannot renormalize a ρ whose trace is ${previous}.`)
  }
  const scale = 1 / previous
  const { re, im, size } = rho
  for (let i = 0; i < size; i++) {
    re[i] *= scale
    im[i] *= scale
  }
  return previous
}

/**
 * The Born-rule distribution: ρ_ii for every basis state, in index order.
 *
 * Same shape and same ordering as `measure.probabilities(state)`, so the
 * histogram of §3.2 can be handed either one. For ρ = |ψ⟩⟨ψ| the two agree
 * entry for entry — that equality is what the ideal-vs-noisy comparison of
 * §3.3 rests on, and it is asserted in the tests.
 */
export function probabilities(rho: DensityMatrix): Float64Array {
  const { re, dim } = rho
  const out = new Float64Array(dim)
  for (let i = 0; i < dim; i++) out[i] = re[i * dim + i]
  return out
}

/**
 * How far ρ is from Hermitian: the largest |ρ_rc − conj(ρ_cr)| over the whole
 * matrix, including the diagonal (where the statement is that ρ_rr is real).
 *
 * A number rather than a boolean, because this is what a failing test should
 * print. `isHermitian` is the thresholded reading of it.
 */
export function hermiticityDefect(rho: DensityMatrix): number {
  const { re, im, dim } = rho
  let worst = 0
  for (let row = 0; row < dim; row++) {
    const rowBase = row * dim
    // The diagonal: ρ_rr must equal its own conjugate, i.e. be real.
    const diagonal = Math.abs(im[rowBase + row])
    if (diagonal > worst) worst = diagonal
    // Only the upper triangle: the pair (r, c) says everything (c, r) would.
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

/**
 * Whether ρ = ρ†, to `tolerance`.
 *
 * Hermiticity is the weakest of the three density-matrix properties and the
 * one that survives the most mistakes — a wrong coefficient, a wrong sign on a
 * real entry and a mispaired qubit all keep it — which is exactly why it is
 * worth checking after every operation: when it *does* break, the cause is a
 * conjugate applied to the wrong factor, and nothing else looks like that.
 */
export function isHermitian(
  rho: DensityMatrix,
  tolerance = DEFAULT_TOLERANCE
): boolean {
  return hermiticityDefect(rho) <= tolerance
}

/**
 * Tr(ρ²) — the purity. 1 for a pure state, 1/2ⁿ for the maximally mixed one,
 * and never above 1 for a physical ρ.
 *
 * This is the number §3.3's panel reports as "how mixed the noise made it",
 * and it is also an invariant with teeth: unitary evolution preserves it
 * exactly (Tr(UρU†UρU†) = Tr(ρ²) by cyclicity), so a gate that moves the
 * purity moved something it had no business moving. A noise channel is the
 * only thing here allowed to lower it.
 *
 * Computed as Σ_rc ρ_rc·ρ_cr — the honest matrix product — rather than as
 * Σ|ρ_rc|². The two agree for a Hermitian ρ and only for a Hermitian ρ, so
 * the general form is the one that can disagree with `isHermitian` and be
 * read as a signal. The sum uses ρ_rc·ρ_cr = ρ_cr·ρ_rc to walk the upper
 * triangle once and double it, which halves the strided reads.
 */
export function purity(rho: DensityMatrix): number {
  const { re, im, dim } = rho
  let sum = 0
  for (let row = 0; row < dim; row++) {
    const rowBase = row * dim
    const dr = re[rowBase + row]
    const di = im[rowBase + row]
    sum += dr * dr - di * di
    for (let column = row + 1; column < dim; column++) {
      const upper = rowBase + column
      const lower = column * dim + row
      sum += 2 * (re[upper] * re[lower] - im[upper] * im[lower])
    }
  }
  return sum
}

/**
 * Whether ρ is positive semidefinite: ⟨v|ρ|v⟩ ≥ 0 for every |v⟩, equivalently
 * every eigenvalue ≥ 0, equivalently no basis in which some outcome has a
 * negative probability.
 *
 * THIS IS THE CHECK THAT CATCHES A WRONG SIGN. Hermiticity and unit trace
 * survive an astonishing number of errors — a Kraus coefficient off by a
 * factor, a conjugate on the wrong operand, a channel applied twice — and the
 * result still prints as a plausible probability distribution. Positivity does
 * not survive them: it is the statement that ρ is a mixture of real states,
 * and an operator that is not one has a direction in which it predicts a
 * negative probability. Nobody has an intuition for what a noisy distribution
 * should look like (§3.3), so this is the check that has to do the work.
 *
 * HOW. Cholesky with symmetric pivoting, on a copy. At step k the largest
 * remaining diagonal is brought to the front, and:
 *
 *   - a pivot below −tolerance is a negative eigenvalue in the making → false;
 *   - a pivot at (near) zero means the largest remaining diagonal is ~0, and
 *     for a positive semidefinite matrix |A_ij|² ≤ A_ii·A_jj, so every
 *     remaining entry must be ~0 as well. Checking that is what separates a
 *     genuine rank-deficient ρ from `[[0,1],[1,0]]`, whose diagonal is zero
 *     and whose eigenvalues are ±1;
 *   - otherwise eliminate and continue.
 *
 * Pivoting is not decoration. Unpivoted Cholesky on a singular positive
 * semidefinite matrix divides by a pivot that is only rounding noise and
 * reports a negative one a few steps later; taking the largest diagonal first
 * is what makes the factorisation of a semidefinite matrix backward stable.
 *
 * COST — O(8ⁿ) time and one extra ρ of memory, and that is deliberate. A
 * decomposition is not an index-pairing walk and cannot be made into one: this
 * is a verification tool, called by the tests on registers of a handful of
 * qubits and by the UI (if at all) on the same. It is emphatically not
 * something to run after every gate on a twelve-qubit register — `trace`,
 * `purity` and `isHermitian` are the O(4ⁿ) checks for that.
 */
export function isPositiveSemidefinite(
  rho: DensityMatrix,
  tolerance = DEFAULT_TOLERANCE
): boolean {
  const { dim } = rho
  const re = rho.re.slice()
  const im = rho.im.slice()

  // A complex diagonal entry means ⟨i|ρ|i⟩ is not even a real number, so no
  // reading of "≥ 0" applies. Cheap, and it keeps the factorisation below
  // from producing an answer about a matrix that is not Hermitian.
  for (let i = 0; i < dim; i++) {
    if (Math.abs(im[i * dim + i]) > tolerance) return false
  }

  const order = new Int32Array(dim)
  for (let i = 0; i < dim; i++) order[i] = i

  for (let k = 0; k < dim; k++) {
    let best = k
    let bestValue = re[order[k] * dim + order[k]]
    for (let j = k + 1; j < dim; j++) {
      const value = re[order[j] * dim + order[j]]
      if (value > bestValue) {
        best = j
        bestValue = value
      }
    }
    const swap = order[k]
    order[k] = order[best]
    order[best] = swap

    const pivot = order[k]
    const d = re[pivot * dim + pivot]
    if (d < -tolerance) return false
    if (d <= tolerance)
      return restIsNegligible(re, im, order, dim, k, tolerance)

    for (let i = k + 1; i < dim; i++) {
      const pi = order[i]
      const at = pi * dim + pivot
      const lr = re[at] / d
      const li = im[at] / d
      for (let j = k + 1; j < dim; j++) {
        const pj = order[j]
        // A_pi,pj −= L_i · conj(A_pj,pivot)
        const cr = re[pj * dim + pivot]
        const ci = -im[pj * dim + pivot]
        const target = pi * dim + pj
        re[target] -= lr * cr - li * ci
        im[target] -= lr * ci + li * cr
      }
    }
  }
  return true
}

/**
 * Everything left of the factorisation is within `tolerance` of zero.
 *
 * Reached when the largest remaining diagonal has gone to zero. For a positive
 * semidefinite matrix that forces the rest of the block to vanish too, so
 * anything surviving here is an off-diagonal without a diagonal to support it
 * — a matrix with eigenvalues of both signs.
 */
function restIsNegligible(
  re: Float64Array,
  im: Float64Array,
  order: Int32Array,
  dim: number,
  from: number,
  tolerance: number
): boolean {
  for (let i = from; i < dim; i++) {
    const pi = order[i]
    for (let j = from; j < dim; j++) {
      const at = pi * dim + order[j]
      if (Math.hypot(re[at], im[at]) > tolerance) return false
    }
  }
  return true
}

/* ─────────────────────────── unitary evolution ──────────────────────────── */

/**
 * ρ → UρU† for a 2×2 `matrix` on `target`, in place.
 *
 * Two passes, rows then columns, as derived in the header. No temporary
 * matrix, no Kronecker product, O(4ⁿ).
 */
export function apply1q(
  rho: DensityMatrix,
  matrix: Matrix2,
  target: number
): void {
  checkQubit(rho, target, 'target')
  checkMatrix(matrix, 8)
  transformRows(rho, matrix, target, 0, 0)
  transformColumns(rho, matrix, target, 0, 0)
}

/**
 * ρ → CU ρ CU† — the same walk, filtered.
 *
 * A mask of 0 accepts every index, so the uncontrolled case runs the same two
 * kernels with a test that is always true. `apply.ts` splits the two instead,
 * because there the test costs one compare per pair of amplitudes; here a row
 * pair carries `dim` entries, so in pass 1 the test is amortised to nothing
 * and in pass 2 it guards eight complex multiplications. One copy of each
 * kernel is worth more than the branch.
 */
export function applyControlled(
  rho: DensityMatrix,
  matrix: Matrix2,
  target: number,
  controls: readonly ControlSpec[]
): void {
  checkQubit(rho, target, 'target')
  checkMatrix(matrix, 8)
  checkControls(rho, controls, target)
  const mask = controlMask(controls)
  const value = controlValue(controls)
  transformRows(rho, matrix, target, mask, value)
  transformColumns(rho, matrix, target, mask, value)
}

/**
 * ρ → UρU† for an arbitrary 4×4 on `(q0, q1)`. Row order is `2·b₁ + b₀`, the
 * convention `apply.ts` fixes and `gates.ts` writes its matrices in.
 */
export function apply2q(
  rho: DensityMatrix,
  matrix: Matrix4,
  q0: number,
  q1: number
): void {
  checkQubit(rho, q0, 'target')
  checkQubit(rho, q1, 'target')
  checkDistinct(q0, q1)
  checkMatrix(matrix, 32)
  transformRowGroups(rho, matrix, q0, q1)
  transformColumnGroups(rho, matrix, q0, q1)
}

/**
 * SWAP, optionally controlled — `cswap` when `controls` is non-empty.
 *
 * A permutation, so both passes are moves rather than arithmetic: pass 1
 * exchanges two whole ROWS (the ones whose indices differ by having exactly
 * one of the two qubits set), pass 2 exchanges the matching pair of COLUMNS
 * inside every row. SWAP is real, so the conjugate of pass 2 is SWAP again.
 * Through `apply2q` this would be sixteen complex products per group to
 * compute a relabelling.
 */
export function applySwap(
  rho: DensityMatrix,
  q0: number,
  q1: number,
  controls: readonly ControlSpec[] = NO_CONTROLS
): void {
  checkQubit(rho, q0, 'target')
  checkQubit(rho, q1, 'target')
  checkDistinct(q0, q1)
  checkControls(rho, controls, q0, q1)

  const mask = controlMask(controls)
  const value = controlValue(controls)
  const { re, im, dim } = rho
  const bit0 = 1 << q0
  const bit1 = 1 << q1
  const lower = Math.min(bit0, bit1)
  const upper = Math.max(bit0, bit1)

  // Pass 1 — rows.
  for (let upperBase = 0; upperBase < dim; upperBase += upper << 1) {
    for (let middle = 0; middle < upper; middle += lower << 1) {
      for (let offset = 0; offset < lower; offset++) {
        const base = upperBase + middle + offset
        if ((base & mask) !== value) continue
        let a = (base + bit0) * dim
        let b = (base + bit1) * dim
        for (let column = 0; column < dim; column++, a++, b++) {
          swapEntries(re, im, a, b)
        }
      }
    }
  }

  // Pass 2 — columns, inside each row.
  for (let row = 0; row < dim; row++) {
    const rowBase = row * dim
    for (let upperBase = 0; upperBase < dim; upperBase += upper << 1) {
      for (let middle = 0; middle < upper; middle += lower << 1) {
        for (let offset = 0; offset < lower; offset++) {
          const base = upperBase + middle + offset
          if ((base & mask) !== value) continue
          swapEntries(re, im, rowBase + base + bit0, rowBase + base + bit1)
        }
      }
    }
  }
}

/**
 * iSWAP: exchange the two qubits and multiply the exchanged amplitudes by i.
 *
 * The two passes differ, and that difference is the whole content of the
 * dagger. Pass 1 carries the factor i — multiplication by i is `(x,y) →
 * (−y,x)`. Pass 2 carries conj(i) = −i, which is `(x,y) → (y,−x)`. Writing i
 * in both places produces a matrix that is still unit-trace and still looks
 * like a state, and is not one: it is not even Hermitian, which is what the
 * tests catch it with.
 *
 * No `controls` parameter, matching `apply.ts` and the contract: there is no
 * controlled iSWAP in the editor.
 */
export function applyISwap(rho: DensityMatrix, q0: number, q1: number): void {
  checkQubit(rho, q0, 'target')
  checkQubit(rho, q1, 'target')
  checkDistinct(q0, q1)

  const { re, im, dim } = rho
  const bit0 = 1 << q0
  const bit1 = 1 << q1
  const lower = Math.min(bit0, bit1)
  const upper = Math.max(bit0, bit1)

  // Pass 1 — rows, exchanged and multiplied by i.
  for (let upperBase = 0; upperBase < dim; upperBase += upper << 1) {
    for (let middle = 0; middle < upper; middle += lower << 1) {
      for (let offset = 0; offset < lower; offset++) {
        const base = upperBase + middle + offset
        let a = (base + bit0) * dim
        let b = (base + bit1) * dim
        for (let column = 0; column < dim; column++, a++, b++) {
          const ar = re[a]
          const ai = im[a]
          re[a] = -im[b]
          im[a] = re[b]
          re[b] = -ai
          im[b] = ar
        }
      }
    }
  }

  // Pass 2 — columns, exchanged and multiplied by −i.
  for (let row = 0; row < dim; row++) {
    const rowBase = row * dim
    for (let upperBase = 0; upperBase < dim; upperBase += upper << 1) {
      for (let middle = 0; middle < upper; middle += lower << 1) {
        for (let offset = 0; offset < lower; offset++) {
          const base = upperBase + middle + offset
          const a = rowBase + base + bit0
          const b = rowBase + base + bit1
          const ar = re[a]
          const ai = im[a]
          re[a] = im[b]
          im[a] = -re[b]
          re[b] = ai
          im[b] = -ar
        }
      }
    }
  }
}

/* ────────────────────────────── the kernels ─────────────────────────────── */

/**
 * PASS 1 — σ = Uρ. Pairs of rows differing in bit `target`, every column
 * carried along.
 *
 * The eight matrix entries go into locals once, as in `apply.ts`: they are
 * used 4ⁿ⁻¹ times below. The inner loop walks two rows in lockstep with
 * incrementing cursors — both are contiguous runs, which is the layout's
 * payoff and the reason the row pass is the cheap one.
 */
function transformRows(
  rho: DensityMatrix,
  matrix: Matrix2,
  target: number,
  mask: number,
  value: number
): void {
  const { re, im, dim } = rho
  const m00r = matrix[0]
  const m00i = matrix[1]
  const m01r = matrix[2]
  const m01i = matrix[3]
  const m10r = matrix[4]
  const m10i = matrix[5]
  const m11r = matrix[6]
  const m11i = matrix[7]

  const stride = 1 << target
  for (let base = 0; base < dim; base += stride << 1) {
    for (let offset = 0; offset < stride; offset++) {
      const row0 = base + offset
      if ((row0 & mask) !== value) continue
      let a = row0 * dim
      let b = a + stride * dim
      for (let column = 0; column < dim; column++, a++, b++) {
        const a0r = re[a]
        const a0i = im[a]
        const a1r = re[b]
        const a1i = im[b]
        re[a] = m00r * a0r - m00i * a0i + (m01r * a1r - m01i * a1i)
        im[a] = m00r * a0i + m00i * a0r + (m01r * a1i + m01i * a1r)
        re[b] = m10r * a0r - m10i * a0i + (m11r * a1r - m11i * a1i)
        im[b] = m10r * a0i + m10i * a0r + (m11r * a1i + m11i * a1r)
      }
    }
  }
}

/**
 * PASS 2 — ρ' = σU†. Pairs of columns differing in bit `target`, inside every
 * row, with the ELEMENTWISE CONJUGATE of the matrix.
 *
 * The conjugation is the four negated imaginary parts below and nothing else:
 * no transpose, for the reason spelled out in the header. Every `-matrix[k]`
 * on an odd index here is load-bearing, and a reader checking this function
 * should check those four signs first.
 */
function transformColumns(
  rho: DensityMatrix,
  matrix: Matrix2,
  target: number,
  mask: number,
  value: number
): void {
  const { re, im, dim } = rho
  const n00r = matrix[0]
  const n00i = -matrix[1]
  const n01r = matrix[2]
  const n01i = -matrix[3]
  const n10r = matrix[4]
  const n10i = -matrix[5]
  const n11r = matrix[6]
  const n11i = -matrix[7]

  const stride = 1 << target
  for (let row = 0; row < dim; row++) {
    const rowBase = row * dim
    for (let base = 0; base < dim; base += stride << 1) {
      for (let offset = 0; offset < stride; offset++) {
        const column0 = base + offset
        if ((column0 & mask) !== value) continue
        const a = rowBase + column0
        const b = a + stride
        const a0r = re[a]
        const a0i = im[a]
        const a1r = re[b]
        const a1i = im[b]
        re[a] = n00r * a0r - n00i * a0i + (n01r * a1r - n01i * a1i)
        im[a] = n00r * a0i + n00i * a0r + (n01r * a1i + n01i * a1r)
        re[b] = n10r * a0r - n10i * a0i + (n11r * a1r - n11i * a1i)
        im[b] = n10r * a0i + n10i * a0r + (n11r * a1i + n11i * a1r)
      }
    }
  }
}

/**
 * PASS 1 for a 4×4 — groups of four rows, every column carried along.
 *
 * The row/column loop over the 4×4 is kept rather than unrolled into sixteen
 * complex products, for the reason `apply2q` gives in `apply.ts`: every
 * two-qubit gate the editor can produce has a specialised path, so this is the
 * escape hatch for custom unitaries and not the hot road. The scratch buffers
 * are allocated once per gate, so the O(4ⁿ) part still allocates nothing.
 */
function transformRowGroups(
  rho: DensityMatrix,
  matrix: Matrix4,
  q0: number,
  q1: number
): void {
  const { re, im, dim } = rho
  const bit0 = 1 << q0
  const bit1 = 1 << q1
  const lower = Math.min(bit0, bit1)
  const upper = Math.max(bit0, bit1)

  const cursor = new Int32Array(4)
  const inR = new Float64Array(4)
  const inI = new Float64Array(4)
  const outR = new Float64Array(4)
  const outI = new Float64Array(4)

  for (let upperBase = 0; upperBase < dim; upperBase += upper << 1) {
    for (let middle = 0; middle < upper; middle += lower << 1) {
      for (let offset = 0; offset < lower; offset++) {
        const base = upperBase + middle + offset
        cursor[0] = base * dim
        cursor[1] = (base + bit0) * dim
        cursor[2] = (base + bit1) * dim
        cursor[3] = (base + bit0 + bit1) * dim

        for (let column = 0; column < dim; column++) {
          for (let k = 0; k < 4; k++) {
            inR[k] = re[cursor[k]]
            inI[k] = im[cursor[k]]
          }
          // U itself — the conjugate belongs to the column pass, and only
          // to it. These two `multiply4` calls are the same line apart from
          // this flag, which makes them easy to edit as a pair by mistake.
          multiply4(matrix, inR, inI, outR, outI, false)
          for (let k = 0; k < 4; k++) {
            re[cursor[k]] = outR[k]
            im[cursor[k]] = outI[k]
            cursor[k]++
          }
        }
      }
    }
  }
}

/** PASS 2 for a 4×4 — groups of four columns, with conj(U), inside each row. */
function transformColumnGroups(
  rho: DensityMatrix,
  matrix: Matrix4,
  q0: number,
  q1: number
): void {
  const { re, im, dim } = rho
  const bit0 = 1 << q0
  const bit1 = 1 << q1
  const lower = Math.min(bit0, bit1)
  const upper = Math.max(bit0, bit1)

  const cursor = new Int32Array(4)
  const inR = new Float64Array(4)
  const inI = new Float64Array(4)
  const outR = new Float64Array(4)
  const outI = new Float64Array(4)

  for (let row = 0; row < dim; row++) {
    const rowBase = row * dim
    for (let upperBase = 0; upperBase < dim; upperBase += upper << 1) {
      for (let middle = 0; middle < upper; middle += lower << 1) {
        for (let offset = 0; offset < lower; offset++) {
          const base = rowBase + upperBase + middle + offset
          cursor[0] = base
          cursor[1] = base + bit0
          cursor[2] = base + bit1
          cursor[3] = base + bit0 + bit1

          for (let k = 0; k < 4; k++) {
            inR[k] = re[cursor[k]]
            inI[k] = im[cursor[k]]
          }
          // conj(U), entry by entry — pass 2, as derived in the header.
          multiply4(matrix, inR, inI, outR, outI, true)
          for (let k = 0; k < 4; k++) {
            re[cursor[k]] = outR[k]
            im[cursor[k]] = outI[k]
          }
        }
      }
    }
  }
}

/**
 * `out = M · in` for a 4-vector, with `M` conjugated entry by entry when
 * `conjugate` is set — the one difference between the two passes, kept in one
 * place so the two cannot drift apart.
 */
function multiply4(
  matrix: Matrix4,
  inR: Float64Array,
  inI: Float64Array,
  outR: Float64Array,
  outI: Float64Array,
  conjugate: boolean
): void {
  const sign = conjugate ? -1 : 1
  for (let row = 0; row < 4; row++) {
    let sumR = 0
    let sumI = 0
    for (let column = 0; column < 4; column++) {
      const at = (row * 4 + column) * 2
      const mr = matrix[at]
      const mi = sign * matrix[at + 1]
      sumR += mr * inR[column] - mi * inI[column]
      sumI += mr * inI[column] + mi * inR[column]
    }
    outR[row] = sumR
    outI[row] = sumI
  }
}

/* ──────────────────────────────── guards ────────────────────────────────── */

function swapEntries(
  re: Float64Array,
  im: Float64Array,
  a: number,
  b: number
): void {
  const ar = re[a]
  const ai = im[a]
  re[a] = re[b]
  im[a] = im[b]
  re[b] = ar
  im[b] = ai
}

/** Bits the control condition examines. */
function controlMask(controls: readonly ControlSpec[]): number {
  let mask = 0
  for (const control of controls) mask |= 1 << control.qubit
  return mask
}

/** What those bits must equal: 1 for a positive control, 0 for a negative. */
function controlValue(controls: readonly ControlSpec[]): number {
  let value = 0
  for (const control of controls) {
    if (control.state === 1) value |= 1 << control.qubit
  }
  return value
}

/*
 * The four guards below are the ones `apply.ts` applies to a statevector,
 * restated for a density matrix. They are not shared: both sets are private
 * to their kernel, and a third module holding thirty lines of `RangeError`
 * would be a dependency between two files that otherwise only agree on
 * conventions. The messages differ where the object does.
 */

function checkQubit(rho: DensityMatrix, qubit: number, role: string): void {
  if (!Number.isInteger(qubit) || qubit < 0 || qubit >= rho.qubits) {
    throw new RangeError(
      `${role} qubit ${qubit} is outside [0, ${rho.qubits}).`
    )
  }
}

function checkIndex(rho: DensityMatrix, index: number, role: string): void {
  if (!Number.isInteger(index) || index < 0 || index >= rho.dim) {
    throw new RangeError(`${role} index ${index} is outside [0, ${rho.dim}).`)
  }
}

function checkDistinct(q0: number, q1: number): void {
  if (q0 === q1) {
    throw new RangeError(
      `A two-qubit gate needs two different qubits, got ${q0} twice.`
    )
  }
}

function checkMatrix(matrix: Float64Array, expected: number): void {
  if (matrix.length !== expected) {
    throw new RangeError(
      `Expected a matrix of ${expected} doubles, got ${matrix.length}. ` +
        `See the layout in gates.ts.`
    )
  }
}

function checkControls(
  rho: DensityMatrix,
  controls: readonly ControlSpec[],
  ...targets: number[]
): void {
  let seen = 0
  for (const control of controls) {
    checkQubit(rho, control.qubit, 'control')
    if (targets.includes(control.qubit)) {
      throw new RangeError(
        `Qubit ${control.qubit} is both a control and a target.`
      )
    }
    const bit = 1 << control.qubit
    if ((seen & bit) !== 0) {
      throw new RangeError(`Qubit ${control.qubit} is controlled twice.`)
    }
    seen |= bit
  }
}

/**
 * Bytes as the UI would print them — for the English message only. The typed
 * error carries the raw counts, and a translated string builds its own units
 * from those (D2): "MB" is not the same word everywhere, and a number formatted
 * in JavaScript's default locale inside an engine with no locale is a bug
 * waiting for a French user.
 */
function formatBytes(bytes: number): string {
  const units = ['bytes', 'KB', 'MB', 'GB', 'TB']
  let value = bytes
  let unit = 0
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024
    unit++
  }
  return `${Math.round(value * 100) / 100} ${units[unit]}`
}
