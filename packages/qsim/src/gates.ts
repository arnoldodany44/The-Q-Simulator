/**
 * The gate matrix catalog.
 *
 * MATRIX LAYOUT. A complex matrix is a flat `Float64Array` in row-major
 * order with real and imaginary parts interleaved. For a 2×2:
 *
 *        ⎡ m₀₀ m₀₁ ⎤
 *    M = ⎣ m₁₀ m₁₁ ⎦   →   [ m₀₀.re, m₀₀.im, m₀₁.re, m₀₁.im,
 *                            m₁₀.re, m₁₀.im, m₁₁.re, m₁₁.im ]
 *
 *    offset of entry (row r, column c) = (2r + c) · 2, imaginary part at +1
 *
 * A 4×4 follows the same rule with 32 doubles: `(4r + c) · 2`.
 *
 * WHY FLAT AND INTERLEAVED: the kernel loads the whole matrix into local
 * variables once and then runs 2ⁿ⁻¹ iterations against those locals. Eight
 * contiguous doubles are one cache line, there is no pointer to chase, and
 * the same buffer can be handed to a WASM core later (§5.6, phase 2) without
 * a layout conversion.
 *
 * The catalog constants are shared on every use, not copied. **Do not mutate
 * them.** JavaScript cannot freeze a typed array's elements, so this is a
 * convention the tests guard rather than something the compiler enforces.
 *
 * DEFINITIONS. Every matrix below is the standard textbook form, chosen to
 * agree entry for entry with Qiskit — including the global phases Qiskit
 * carries in `rz` and `u`. Export compatibility (M1.7) is not a matter of
 * translating names: a circuit that means something different once it reaches
 * real hardware is worse than no export at all.
 *
 * The gate ids mirror `@qsim/schema`'s `GateId`. That duplication is forced
 * by the zero-dependency rule (§12.3) — this package cannot import the
 * contract. The runner of M0.4 sees both and is where a divergence surfaces.
 */

/** A 2×2 complex matrix: 8 doubles, layout as documented in the header. */
export type Matrix2 = Float64Array

/** A 4×4 complex matrix: 32 doubles, layout as documented in the header. */
export type Matrix4 = Float64Array

const SQRT1_2 = Math.SQRT1_2

/** Identity. */
const I: Matrix2 = new Float64Array([1, 0, 0, 0, 0, 0, 1, 0])

/** Pauli X — the bit flip, `[[0,1],[1,0]]`. */
const X: Matrix2 = new Float64Array([0, 0, 1, 0, 1, 0, 0, 0])

/** Pauli Y — `[[0,-i],[i,0]]`. */
const Y: Matrix2 = new Float64Array([0, 0, 0, -1, 0, 1, 0, 0])

/** Pauli Z — the phase flip, `[[1,0],[0,-1]]`. */
const Z: Matrix2 = new Float64Array([1, 0, 0, 0, 0, 0, -1, 0])

/** Hadamard — `(1/√2)·[[1,1],[1,-1]]`, the superposition gate. */
const H: Matrix2 = new Float64Array([
  SQRT1_2,
  0,
  SQRT1_2,
  0,
  SQRT1_2,
  0,
  -SQRT1_2,
  0,
])

/** S = √Z — `[[1,0],[0,i]]`, a quarter turn about the Z axis. */
const S: Matrix2 = new Float64Array([1, 0, 0, 0, 0, 0, 0, 1])

/** S† — `[[1,0],[0,-i]]`. */
const SDG: Matrix2 = new Float64Array([1, 0, 0, 0, 0, 0, 0, -1])

/** T = √S — `[[1,0],[0,e^{iπ/4}]]`, and `e^{iπ/4} = (1+i)/√2`. */
const T: Matrix2 = new Float64Array([1, 0, 0, 0, 0, 0, SQRT1_2, SQRT1_2])

/** T† — `[[1,0],[0,e^{-iπ/4}]]`. */
const TDG: Matrix2 = new Float64Array([1, 0, 0, 0, 0, 0, SQRT1_2, -SQRT1_2])

/** √X — `(1/2)·[[1+i,1-i],[1-i,1+i]]`, and it does square to X. */
const SX: Matrix2 = new Float64Array([0.5, 0.5, 0.5, -0.5, 0.5, -0.5, 0.5, 0.5])

/** Gate ids that have a fixed 2×2 matrix, no parameters involved. */
export type FixedGateId =
  'i' | 'x' | 'y' | 'z' | 'h' | 's' | 'sdg' | 't' | 'tdg' | 'sx'

/** Gate ids that yield a 2×2 matrix, fixed or parametrised. */
export type OneQubitGateId = FixedGateId | 'rx' | 'ry' | 'rz' | 'p' | 'u'

/**
 * The fixed 2×2 gates, keyed by the schema's gate id.
 *
 * `cx`, `cz` and `ccx` are absent on purpose: the contract stores them as one
 * of these matrices plus controls (`GATES.cx.controlCount === 1`) and the
 * kernel applies them through `applyControlled`. Materialising a controlled
 * matrix would mean building a 4×4, and §5.2 forbids that road entirely.
 */
export const GATE_MATRICES: Readonly<Record<FixedGateId, Matrix2>> = {
  i: I,
  x: X,
  y: Y,
  z: Z,
  h: H,
  s: S,
  sdg: SDG,
  t: T,
  tdg: TDG,
  sx: SX,
}

/**
 * Rx(θ) = `[[cos(θ/2), -i·sin(θ/2)], [-i·sin(θ/2), cos(θ/2)]]`.
 *
 * The half angle is neither a typo nor a choice: a rotation by 2π on the
 * Bloch sphere is a rotation by π in state space, so `Rx(2π) = -I`. Dropping
 * the half would make every angle in the UI mean twice what it says.
 */
export function rxMatrix(theta: number): Matrix2 {
  const c = Math.cos(theta / 2)
  const s = Math.sin(theta / 2)
  return new Float64Array([c, 0, 0, -s, 0, -s, c, 0])
}

/** Ry(θ) = `[[cos(θ/2), -sin(θ/2)], [sin(θ/2), cos(θ/2)]]` — real throughout. */
export function ryMatrix(theta: number): Matrix2 {
  const c = Math.cos(theta / 2)
  const s = Math.sin(theta / 2)
  return new Float64Array([c, 0, -s, 0, s, 0, c, 0])
}

/**
 * Rz(θ) = `[[e^{-iθ/2}, 0], [0, e^{iθ/2}]]`.
 *
 * Symmetric about the identity, so it differs from `P(θ)` by a global phase
 * of `e^{-iθ/2}`. Qiskit's `RZGate` is exactly this, and the difference stops
 * being global the moment the gate is controlled: `crz` and `cp` are
 * genuinely different operations.
 */
export function rzMatrix(theta: number): Matrix2 {
  const c = Math.cos(theta / 2)
  const s = Math.sin(theta / 2)
  return new Float64Array([c, -s, 0, 0, 0, 0, c, s])
}

/** P(φ) = `[[1,0],[0,e^{iφ}]]` — phase on |1⟩ only. `P(π) = Z`, `P(π/2) = S`. */
export function pMatrix(phi: number): Matrix2 {
  return new Float64Array([1, 0, 0, 0, 0, 0, Math.cos(phi), Math.sin(phi)])
}

/**
 * The universal one-qubit gate, in Qiskit's convention:
 *
 *    U(θ,φ,λ) = ⎡ cos(θ/2)          -e^{iλ}·sin(θ/2)     ⎤
 *               ⎣ e^{iφ}·sin(θ/2)    e^{i(φ+λ)}·cos(θ/2) ⎦
 *
 * Every other one-qubit gate is a special case: `U(π,0,π) = X`,
 * `U(π/2,0,π) = H`, `U(0,0,λ) = P(λ)`. The tests assert those three, which is
 * the cheapest way to catch a transposed or misplaced phase here.
 *
 * WHY THE BOTTOM-RIGHT PHASE IS A PRODUCT AND NOT A TRIG CALL ON `φ+λ`.
 * `e^{i(φ+λ)}` is exactly `e^{iφ}·e^{iλ}`, but the two spellings are not the
 * same computation in Float64. Summing first commits an *absolute* error of
 * `ulp(φ)/2` radians before any trig runs, and this matrix is unitary only
 * when the phase in `m₁₁` is the one in `m₀₁` turned by the one in `m₁₀` —
 * so the rounded sum breaks the orthogonality of the two columns, by 2e-11 at
 * `φ = 1e6` and by 0.15 at `φ = 1e16`, past D6's 1e-10 and growing without
 * bound. It also overflows to `±Infinity` — and so to `NaN` through
 * `Math.cos` — while both operands are still perfectly finite doubles, which
 * `checkParams` cannot catch because it validates the operands, not their sum.
 * Reusing the four phasor components makes the cancellation exact by
 * construction, at no accuracy cost anywhere else and two trig calls fewer.
 */
export function uMatrix(theta: number, phi: number, lambda: number): Matrix2 {
  const c = Math.cos(theta / 2)
  const s = Math.sin(theta / 2)
  const cp = Math.cos(phi)
  const sp = Math.sin(phi)
  const cl = Math.cos(lambda)
  const sl = Math.sin(lambda)
  return new Float64Array([
    c,
    0,
    -cl * s,
    -sl * s,
    cp * s,
    sp * s,
    (cp * cl - sp * sl) * c,
    (cp * sl + sp * cl) * c,
  ])
}

/** Write one entry of a 4×4, so the callers below read like the matrix. */
function entry4(
  matrix: Matrix4,
  row: number,
  column: number,
  re: number,
  im: number
): void {
  matrix[(row * 4 + column) * 2] = re
  matrix[(row * 4 + column) * 2 + 1] = im
}

/**
 * `|00⟩` and `|11⟩` fixed, `|01⟩` and `|10⟩` exchanged and multiplied by
 * `(re, im)`. SWAP is the case `(1, 0)`, iSWAP the case `(0, 1)`.
 *
 * Row and column index is `2·b₁ + b₀`, where b₀ is the bit of the first qubit
 * argument — the local echo of D1, see the header of `apply.ts`.
 */
function exchange4(re: number, im: number): Matrix4 {
  const matrix = new Float64Array(32)
  entry4(matrix, 0, 0, 1, 0)
  entry4(matrix, 1, 2, re, im)
  entry4(matrix, 2, 1, re, im)
  entry4(matrix, 3, 3, 1, 0)
  return matrix
}

/**
 * SWAP written out as a 4×4, for reference and as a test oracle.
 *
 * The kernel does **not** use it: `applySwap` exchanges two amplitudes
 * directly, which is a quarter of the memory traffic and no arithmetic at
 * all. This constant is the definition that specialisation is checked
 * against.
 */
export const SWAP_MATRIX: Matrix4 = exchange4(1, 0)

/**
 * iSWAP: exchanges the two qubits and multiplies the exchanged amplitudes by
 * `i` — `|01⟩ → i|10⟩`, `|10⟩ → i|01⟩`, `|00⟩` and `|11⟩` untouched. Same
 * note as `SWAP_MATRIX`: an oracle, not the code path.
 */
export const ISWAP_MATRIX: Matrix4 = exchange4(0, 1)

const ONE_QUBIT_GATE_IDS: ReadonlySet<string> = new Set([
  ...Object.keys(GATE_MATRICES),
  'rx',
  'ry',
  'rz',
  'p',
  'u',
])

/** Whether `value` names a gate that has a 2×2 matrix. */
export function isOneQubitGateId(value: string): value is OneQubitGateId {
  return ONE_QUBIT_GATE_IDS.has(value)
}

/**
 * The 2×2 matrix of a one-qubit gate, resolving parameters positionally in
 * the order the schema's `paramNames` lists them.
 *
 * This is the seam the runner of M0.4 crosses: circuit JSON on one side,
 * numbers on the other. It is also where `cx`, `crz`, `cp` and `ccx` get
 * their matrix — they are `x`, `rz`, `p` and `x` plus controls.
 *
 * Throws a `RangeError` on a wrong parameter count for every id, including the
 * ten that take none. For the parametrised gates the reason is that defaulting
 * a missing angle to zero makes `Rx(0)` the identity: the gate would quietly
 * vanish from the circuit and the user would see nothing happen at all. For the
 * fixed gates the reason is that a stray angle means the operation never went
 * through `validateCircuit()`, and this package is extractable (§12.3) so it
 * cannot assume the schema was in the loop — saying so beats guessing which
 * half of the operation to believe.
 */
export function matrixFor(
  gate: OneQubitGateId,
  params: readonly number[] = []
): Matrix2 {
  switch (gate) {
    case 'rx':
      return rxMatrix(checkParams(gate, params, 1)[0])
    case 'ry':
      return ryMatrix(checkParams(gate, params, 1)[0])
    case 'rz':
      return rzMatrix(checkParams(gate, params, 1)[0])
    case 'p':
      return pMatrix(checkParams(gate, params, 1)[0])
    case 'u': {
      const [theta, phi, lambda] = checkParams(gate, params, 3)
      return uMatrix(theta, phi, lambda)
    }
    default:
      // The catalog constant is returned unchanged, not rebuilt: callers and
      // tests rely on `matrixFor(id)` being the very same shared buffer.
      checkParams(gate, params, 0)
      return GATE_MATRICES[gate]
  }
}

function checkParams(
  gate: string,
  params: readonly number[],
  expected: number
): readonly number[] {
  if (params.length !== expected) {
    throw new RangeError(
      `Gate "${gate}" takes ${expected} parameter(s), got ${params.length}.`
    )
  }
  for (const value of params) {
    if (!Number.isFinite(value)) {
      throw new RangeError(`Gate "${gate}" was given a non-finite parameter.`)
    }
  }
  return params
}

/**
 * Conjugate transpose — the inverse of a unitary, `M†[r][c] = conj(M[c][r])`.
 *
 * Undo, circuit inversion and the property-based tests all rest on
 * `U†·U = I`; this is the single place that identity is implemented.
 */
export function dagger(matrix: Matrix2): Matrix2 {
  if (matrix.length !== 8) {
    // Handed a 4×4 it would silently return a plausible 2×2 of the wrong
    // entries, which is the failure mode this package exists to avoid.
    throw new RangeError(
      `dagger takes a 2×2 (8 doubles), got ${matrix.length}.`
    )
  }
  return new Float64Array([
    matrix[0],
    -matrix[1],
    matrix[4],
    -matrix[5],
    matrix[2],
    -matrix[3],
    matrix[6],
    -matrix[7],
  ])
}
