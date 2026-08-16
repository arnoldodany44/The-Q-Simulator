/**
 * INDEPENDENT VERIFICATION — THE DENSITY PATH AGAINST THE STATEVECTOR PATH.
 *
 * LENS: with no noise at all, ρ → UρU† must be the statevector path written
 * twice. That is the strongest independent check available in this repository,
 * because `apply.ts` and `measure.ts` already survived an adversarial audit
 * (M0.x) while `density.ts` is new: any disagreement between them is a bug in
 * the new half, and the old half is a reference nobody had to write.
 *
 * WHAT THIS FILE DOES NOT DO. It does not read `density.test.ts` or
 * `verification/density-evolution.test.ts`, and it does not reuse
 * `testing/random-circuits.ts`. Those were written beside the implementation
 * and share whatever blind spot it has. Everything below is derived here:
 *
 *   - the gate matrices are written out from the textbook in this file, so a
 *     wrong entry in `gates.ts` cannot cancel against a wrong entry in a
 *     kernel — the SAME hand-written matrix is handed to `apply.ts`, to
 *     `density.ts` and to the dense oracle;
 *   - the full 2ⁿ × 2ⁿ operator is built entry by entry from the definition of
 *     a controlled gate and D1's bit rule (`conventions.ts`), which is exactly
 *     what §5.2 forbids the engine to do — that is the point, it shares no
 *     stride, no pairing walk and no flat layout with the code under test;
 *   - UρU† is then computed by two textbook triple-loop matrix products over
 *     nested arrays of `{ re, im }`, O(8ⁿ) and obviously correct.
 *
 * THE FOUR THINGS IT IS HUNTING.
 *
 *   1. A ρ that agrees on the diagonal and disagrees off it. Every histogram
 *      in §3.2 reads the diagonal, so an error confined to the coherences is
 *      invisible in the product and fatal to the noise mode, whose whole
 *      subject is what happens to coherences. Every comparison here is
 *      entry-for-entry against |ψ⟩⟨ψ|, never only against `probabilities()`.
 *
 *   2. A transposed ρ. An implementation that indexed rows where it meant
 *      columns returns ρᵀ, which for a Hermitian ρ is conj(ρ): still
 *      Hermitian, still unit trace, still positive semidefinite, still a
 *      plausible distribution, and wrong. It is caught only by an entry whose
 *      imaginary part is large and whose sign was derived by hand — which is
 *      what `describes D1 in ρ` below does.
 *
 *   3. A control filtered on the wrong index, a negative control read as
 *      positive, or a qubit pairing that only works when the wires are
 *      adjacent. Hence: positive and negative controls, two controls, both
 *      swap families, a custom 4×4 and every gate placed on non-adjacent and
 *      descending wires.
 *
 *   4. A purity that is not exactly 1 for a state that came from a
 *      statevector. Unitary evolution preserves Tr(ρ²) exactly, so a purity
 *      that moves is a gate that moved something it had no business moving.
 */

import { describe, expect, it } from 'vitest'

import {
  apply1q as stateApply1q,
  apply2q as stateApply2q,
  applyControlled as stateApplyControlled,
  applyISwap as stateApplyISwap,
  applySwap as stateApplySwap,
} from '../apply.js'
import type { ControlSpec } from '../apply.js'
import { bitOf } from '../conventions.js'
import {
  apply1q as densityApply1q,
  apply2q as densityApply2q,
  applyControlled as densityApplyControlled,
  applyISwap as densityApplyISwap,
  applySwap as densityApplySwap,
  fromStatevector,
  hermiticityDefect,
  isPositiveSemidefinite,
  probabilities as densityProbabilities,
  purity as densityPurity,
  trace as densityTrace,
} from '../density.js'
import type { DensityMatrix } from '../density.js'
import { probabilities as stateProbabilities } from '../measure.js'
import {
  densityFidelity,
  densityStateFidelity,
  partialTrace,
  partialTraceOfDensity,
  stateFidelity,
} from '../metrics.js'
import { NOISE_PROFILES } from '../noise.js'
import { run, runNoisyDensity } from '../runner.js'
import type { CircuitLike, OperationLike } from '../runner.js'
import { alloc } from '../statevector.js'
import type { Statevector } from '../statevector.js'

/** D6's tolerance, as an absolute bound on every comparison in this file. */
const TOLERANCE = 1e-10

/* ───────────────────── complex and dense linear algebra ─────────────────── */

interface Cx {
  readonly re: number
  readonly im: number
}

/** A dense complex matrix, row-major as nested arrays. Nothing flat here. */
type Mat = Cx[][]

const ZERO: Cx = { re: 0, im: 0 }
const ONE: Cx = { re: 1, im: 0 }

function cx(re: number, im = 0): Cx {
  return { re, im }
}

function cadd(a: Cx, b: Cx): Cx {
  return { re: a.re + b.re, im: a.im + b.im }
}

function cmul(a: Cx, b: Cx): Cx {
  return { re: a.re * b.re - a.im * b.im, im: a.re * b.im + a.im * b.re }
}

function cconj(a: Cx): Cx {
  return { re: a.re, im: -a.im }
}

/** e^{iθ}, written once so no phase below is a sin/cos typo twice. */
function phase(theta: number): Cx {
  return { re: Math.cos(theta), im: Math.sin(theta) }
}

function zeros(dim: number): Mat {
  return Array.from({ length: dim }, () => new Array<Cx>(dim).fill(ZERO))
}

/** C = A·B, the textbook triple loop. */
function matmul(a: Mat, b: Mat): Mat {
  const dim = a.length
  const out = zeros(dim)
  for (let row = 0; row < dim; row++) {
    for (let column = 0; column < dim; column++) {
      let sum = ZERO
      for (let k = 0; k < dim; k++)
        sum = cadd(sum, cmul(a[row][k], b[k][column]))
      out[row][column] = sum
    }
  }
  return out
}

/** A† — conjugate transpose, spelled out so there is no doubt which is which. */
function daggerOf(a: Mat): Mat {
  const dim = a.length
  const out = zeros(dim)
  for (let row = 0; row < dim; row++) {
    for (let column = 0; column < dim; column++) {
      out[row][column] = cconj(a[column][row])
    }
  }
  return out
}

/** ρ → UρU†, by two dense products. O(8ⁿ) and beyond suspicion. */
function conjugateBy(u: Mat, rho: Mat): Mat {
  return matmul(matmul(u, rho), daggerOf(u))
}

/** |ψ'⟩ = U|ψ⟩. */
function actOn(u: Mat, psi: readonly Cx[]): Cx[] {
  const dim = psi.length
  const out = new Array<Cx>(dim).fill(ZERO)
  for (let row = 0; row < dim; row++) {
    let sum = ZERO
    for (let column = 0; column < dim; column++) {
      sum = cadd(sum, cmul(u[row][column], psi[column]))
    }
    out[row] = sum
  }
  return out
}

/* ─────────────── the gate catalog, written out from the textbook ────────── */

const R2 = Math.SQRT1_2

const M_I: Mat = [
  [ONE, ZERO],
  [ZERO, ONE],
]
const M_X: Mat = [
  [ZERO, ONE],
  [ONE, ZERO],
]
const M_Y: Mat = [
  [ZERO, cx(0, -1)],
  [cx(0, 1), ZERO],
]
const M_Z: Mat = [
  [ONE, ZERO],
  [ZERO, cx(-1)],
]
const M_H: Mat = [
  [cx(R2), cx(R2)],
  [cx(R2), cx(-R2)],
]
const M_S: Mat = [
  [ONE, ZERO],
  [ZERO, cx(0, 1)],
]
const M_SDG: Mat = [
  [ONE, ZERO],
  [ZERO, cx(0, -1)],
]
const M_T: Mat = [
  [ONE, ZERO],
  [ZERO, phase(Math.PI / 4)],
]
const M_TDG: Mat = [
  [ONE, ZERO],
  [ZERO, phase(-Math.PI / 4)],
]
/** √X = ½[[1+i, 1−i], [1−i, 1+i]]. */
const M_SX: Mat = [
  [cx(0.5, 0.5), cx(0.5, -0.5)],
  [cx(0.5, -0.5), cx(0.5, 0.5)],
]

function mRx(theta: number): Mat {
  const c = Math.cos(theta / 2)
  const s = Math.sin(theta / 2)
  return [
    [cx(c), cx(0, -s)],
    [cx(0, -s), cx(c)],
  ]
}

function mRy(theta: number): Mat {
  const c = Math.cos(theta / 2)
  const s = Math.sin(theta / 2)
  return [
    [cx(c), cx(-s)],
    [cx(s), cx(c)],
  ]
}

function mRz(theta: number): Mat {
  return [
    [phase(-theta / 2), ZERO],
    [ZERO, phase(theta / 2)],
  ]
}

function mP(phi: number): Mat {
  return [
    [ONE, ZERO],
    [ZERO, phase(phi)],
  ]
}

function mU(theta: number, phi: number, lambda: number): Mat {
  const c = Math.cos(theta / 2)
  const s = Math.sin(theta / 2)
  return [
    [cx(c), cmul(phase(lambda), cx(-s))],
    [cmul(phase(phi), cx(s)), cmul(phase(phi + lambda), cx(c))],
  ]
}

/**
 * A 4×4 in the basis `2·b₁ + b₀`, with the exchanged amplitudes carrying
 * `factor`: SWAP is 1, iSWAP is i.
 */
function mExchange(factor: Cx): Mat {
  return [
    [ONE, ZERO, ZERO, ZERO],
    [ZERO, ZERO, factor, ZERO],
    [ZERO, factor, ZERO, ZERO],
    [ZERO, ZERO, ZERO, ONE],
  ]
}

const M_SWAP = mExchange(ONE)
const M_ISWAP = mExchange(cx(0, 1))

/* ───────── the flat layout of gates.ts, produced from the above ─────────── */

/**
 * `Mat` → the interleaved row-major `Float64Array` the kernels take. Written
 * from the layout comment in `gates.ts`, not by reading a catalog constant, so
 * that both kernels below are fed the matrix this file derived.
 */
function flatten(m: Mat): Float64Array {
  const side = m.length
  const out = new Float64Array(side * side * 2)
  for (let row = 0; row < side; row++) {
    for (let column = 0; column < side; column++) {
      const at = (row * side + column) * 2
      out[at] = m[row][column].re
      out[at + 1] = m[row][column].im
    }
  }
  return out
}

/* ────────── embedding a gate in an n-qubit register, from D1 alone ───────── */

function controlsHold(
  index: number,
  controls: readonly ControlSpec[]
): boolean {
  for (const control of controls) {
    if (bitOf(index, control.qubit) !== control.state) return false
  }
  return true
}

function withBit(index: number, qubit: number, value: number): number {
  return value === 1 ? index | (1 << qubit) : index & ~(1 << qubit)
}

/**
 * The full 2ⁿ × 2ⁿ operator of a one-qubit gate on `target` under `controls`.
 *
 * Straight from the definition: a column `c` of the operator is the image of
 * the basis state |c⟩. If the controls do not hold on |c⟩ the gate is the
 * identity there; if they do, |c⟩ maps to Σ_b m[b][c_target] |c with target
 * set to b⟩, where `c_target` is bit `target` of `c` — D1 and nothing else.
 */
function embed1q(
  qubits: number,
  m: Mat,
  target: number,
  controls: readonly ControlSpec[] = []
): Mat {
  const dim = 1 << qubits
  const u = zeros(dim)
  for (let column = 0; column < dim; column++) {
    if (!controlsHold(column, controls)) {
      u[column][column] = ONE
      continue
    }
    const from = bitOf(column, target)
    for (let to = 0; to < 2; to++) {
      u[withBit(column, target, to)][column] = m[to][from]
    }
  }
  return u
}

/**
 * The same for a 4×4 on `(q0, q1)`, with the row/column index `2·b₁ + b₀` the
 * kernels document — b₀ being the bit of the FIRST qubit argument.
 */
function embed2q(
  qubits: number,
  m: Mat,
  q0: number,
  q1: number,
  controls: readonly ControlSpec[] = []
): Mat {
  const dim = 1 << qubits
  const u = zeros(dim)
  for (let column = 0; column < dim; column++) {
    if (!controlsHold(column, controls)) {
      u[column][column] = ONE
      continue
    }
    const from = 2 * bitOf(column, q1) + bitOf(column, q0)
    for (let to = 0; to < 4; to++) {
      const row = withBit(withBit(column, q0, to & 1), q1, (to >> 1) & 1)
      u[row][column] = m[to][from]
    }
  }
  return u
}

/* ───────────────────────── engine ↔ oracle adapters ─────────────────────── */

function vectorOf(state: Statevector): Cx[] {
  const out = new Array<Cx>(state.size)
  for (let i = 0; i < state.size; i++) out[i] = cx(state.re[i], state.im[i])
  return out
}

function matrixOf(rho: DensityMatrix): Mat {
  const out = zeros(rho.dim)
  for (let row = 0; row < rho.dim; row++) {
    for (let column = 0; column < rho.dim; column++) {
      const at = row * rho.dim + column
      out[row][column] = cx(rho.re[at], rho.im[at])
    }
  }
  return out
}

/** |ψ⟩⟨ψ| from the definition: ρ_rc = ψ_r · conj(ψ_c). */
function outerProduct(psi: readonly Cx[]): Mat {
  const dim = psi.length
  const out = zeros(dim)
  for (let row = 0; row < dim; row++) {
    for (let column = 0; column < dim; column++) {
      out[row][column] = cmul(psi[row], cconj(psi[column]))
    }
  }
  return out
}

/** The largest |a_rc − b_rc| over the whole matrix. A number, so it prints. */
function maxDifference(a: Mat, b: Mat): number {
  let worst = 0
  for (let row = 0; row < a.length; row++) {
    for (let column = 0; column < a.length; column++) {
      const dr = Math.abs(a[row][column].re - b[row][column].re)
      const di = Math.abs(a[row][column].im - b[row][column].im)
      if (dr > worst) worst = dr
      if (di > worst) worst = di
    }
  }
  return worst
}

function maxVectorDifference(a: Float64Array, b: Float64Array): number {
  let worst = 0
  for (let i = 0; i < a.length; i++) {
    const d = Math.abs(a[i] - b[i])
    if (d > worst) worst = d
  }
  return worst
}

/* ──────────────────────────── random material ───────────────────────────── */

/**
 * mulberry32 — a small deterministic generator written here rather than
 * imported from `rng.ts`, so a seed in a failure message reproduces exactly
 * this file and nothing else has to be trusted to replay it.
 */
function seeded(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

/** A Haar-ish random pure state: complex Gaussian-free, then normalised. */
function randomState(qubits: number, next: () => number): Statevector {
  const state = alloc(qubits)
  let norm2 = 0
  for (let i = 0; i < state.size; i++) {
    const re = next() * 2 - 1
    const im = next() * 2 - 1
    state.re[i] = re
    state.im[i] = im
    norm2 += re * re + im * im
  }
  const scale = 1 / Math.sqrt(norm2)
  for (let i = 0; i < state.size; i++) {
    state.re[i] *= scale
    state.im[i] *= scale
  }
  return state
}

/* ──────────────────── one step, in three representations ────────────────── */

/**
 * A single unitary step expressed three ways: on a statevector through
 * `apply.ts`, on a ρ through `density.ts`, and as the full dense operator this
 * file derived. All three receive the same hand-written matrix.
 */
interface Step {
  readonly label: string
  readonly onState: (state: Statevector) => void
  readonly onDensity: (rho: DensityMatrix) => void
  readonly unitary: Mat
}

function step1q(
  qubits: number,
  label: string,
  m: Mat,
  target: number,
  controls: readonly ControlSpec[] = []
): Step {
  const flat = flatten(m)
  return {
    label,
    onState: (state) => stateApplyControlled(state, flat, target, controls),
    onDensity: (rho) => densityApplyControlled(rho, flat, target, controls),
    unitary: embed1q(qubits, m, target, controls),
  }
}

function stepSwap(
  qubits: number,
  q0: number,
  q1: number,
  controls: readonly ControlSpec[] = []
): Step {
  return {
    label: `${controls.length > 0 ? 'cswap' : 'swap'}(${q0},${q1})`,
    onState: (state) => stateApplySwap(state, q0, q1, controls),
    onDensity: (rho) => densityApplySwap(rho, q0, q1, controls),
    unitary: embed2q(qubits, M_SWAP, q0, q1, controls),
  }
}

function stepISwap(qubits: number, q0: number, q1: number): Step {
  return {
    label: `iswap(${q0},${q1})`,
    onState: (state) => stateApplyISwap(state, q0, q1),
    onDensity: (rho) => densityApplyISwap(rho, q0, q1),
    unitary: embed2q(qubits, M_ISWAP, q0, q1),
  }
}

function step2q(
  qubits: number,
  label: string,
  m: Mat,
  q0: number,
  q1: number
): Step {
  const flat = flatten(m)
  return {
    label,
    onState: (state) => stateApply2q(state, flat, q0, q1),
    onDensity: (rho) => densityApply2q(rho, flat, q0, q1),
    unitary: embed2q(qubits, m, q0, q1),
  }
}

const POSITIVE = (qubit: number): ControlSpec => ({ qubit, state: 1 })
const NEGATIVE = (qubit: number): ControlSpec => ({ qubit, state: 0 })

/**
 * A custom two-qubit unitary that is neither symmetric, nor real, nor a
 * permutation — built by composing this file's own embeddings on a two-qubit
 * register, which is exactly the 4×4 in the `2·b₁ + b₀` basis `apply2q` takes.
 * Nothing in `gates.ts` has this matrix, so it can only go through the generic
 * 4×4 path in both kernels.
 */
const CUSTOM_4X4: Mat = matmul(
  matmul(embed1q(2, M_T, 1), embed1q(2, M_X, 0, [POSITIVE(1)])),
  matmul(embed1q(2, mU(0.7, -1.3, 2.1), 0), embed1q(2, M_H, 1))
)

/**
 * Every kernel entry point, on wires chosen so nothing is adjacent and nothing
 * is in ascending order — a pairing that only works for `q0 < q1` or for
 * neighbouring bits fails here and nowhere else.
 */
function everyKernelStep(qubits: number): Step[] {
  return [
    step1q(qubits, 'h(0)', M_H, 0),
    step1q(qubits, 'x(3)', M_X, 3),
    step1q(qubits, 'y(2)', M_Y, 2),
    step1q(qubits, 'z(1)', M_Z, 1),
    step1q(qubits, 's(3)', M_S, 3),
    step1q(qubits, 'sdg(0)', M_SDG, 0),
    step1q(qubits, 't(2)', M_T, 2),
    step1q(qubits, 'tdg(1)', M_TDG, 1),
    step1q(qubits, 'sx(3)', M_SX, 3),
    step1q(qubits, 'i(1)', M_I, 1),
    step1q(qubits, 'rx(2)', mRx(0.83), 2),
    step1q(qubits, 'ry(0)', mRy(-2.4), 0),
    step1q(qubits, 'rz(3)', mRz(1.9), 3),
    step1q(qubits, 'p(1)', mP(-0.55), 1),
    step1q(qubits, 'u(2)', mU(1.1, -0.4, 2.7), 2),
    // Controls: positive, negative, control above the target, two of them.
    step1q(qubits, 'cx(0→3)', M_X, 3, [POSITIVE(0)]),
    step1q(qubits, 'cx(3→0)', M_X, 0, [POSITIVE(3)]),
    step1q(qubits, 'cz(1→3)', M_Z, 3, [POSITIVE(1)]),
    step1q(qubits, 'negative-cx(2→0)', M_X, 0, [NEGATIVE(2)]),
    step1q(qubits, 'negative-ch(3→1)', M_H, 1, [NEGATIVE(3)]),
    step1q(qubits, 'crz(3→1)', mRz(0.61), 1, [POSITIVE(3)]),
    step1q(qubits, 'cp(0→2)', mP(2.2), 2, [POSITIVE(0)]),
    step1q(qubits, 'ccx(0,3→1)', M_X, 1, [POSITIVE(0), POSITIVE(3)]),
    step1q(qubits, 'ccx mixed(3,0→2)', M_X, 2, [NEGATIVE(3), POSITIVE(0)]),
    // Two-qubit shapes, descending and non-adjacent.
    stepSwap(qubits, 3, 0),
    stepSwap(qubits, 1, 2),
    stepSwap(qubits, 3, 1, [POSITIVE(0)]),
    stepSwap(qubits, 0, 2, [NEGATIVE(1)]),
    stepISwap(qubits, 3, 0),
    stepISwap(qubits, 1, 3),
    step2q(qubits, 'custom4×4(3,1)', CUSTOM_4X4, 3, 1),
    step2q(qubits, 'custom4×4(1,3)', CUSTOM_4X4, 1, 3),
    step2q(qubits, 'custom4×4(0,2)', CUSTOM_4X4, 0, 2),
  ]
}

/** Assert the three invariants of a state that arrived from a statevector. */
function expectPureAndPhysical(rho: DensityMatrix, where: string): void {
  expect(hermiticityDefect(rho), `${where}: Hermiticity`).toBeLessThan(
    TOLERANCE
  )
  expect(Math.abs(densityTrace(rho) - 1), `${where}: trace`).toBeLessThan(
    TOLERANCE
  )
  expect(Math.abs(densityPurity(rho) - 1), `${where}: purity`).toBeLessThan(
    TOLERANCE
  )
  expect(isPositiveSemidefinite(rho), `${where}: positivity`).toBe(true)
}

/* ════════════════════════════════ the tests ═════════════════════════════ */

describe('one kernel step at a time, on a random pure state', () => {
  const QUBITS = 4

  for (const step of everyKernelStep(QUBITS)) {
    it(`${step.label}: ρ equals |ψ⟩⟨ψ| of the statevector path`, () => {
      const next = seeded(0x5eed)
      for (let trial = 0; trial < 8; trial++) {
        const state = randomState(QUBITS, next)
        const rho = fromStatevector(state)

        step.onState(state)
        step.onDensity(rho)

        // The whole matrix, not the diagonal: an error confined to the
        // coherences would pass a histogram comparison and fail here.
        expect(
          maxDifference(matrixOf(rho), outerProduct(vectorOf(state)))
        ).toBeLessThan(TOLERANCE)
        expectPureAndPhysical(rho, step.label)
      }
    })

    it(`${step.label}: ρ equals the dense UρU† derived here`, () => {
      const next = seeded(0xc0ffee)
      for (let trial = 0; trial < 4; trial++) {
        const state = randomState(QUBITS, next)
        const rho = fromStatevector(state)
        const before = matrixOf(rho)

        step.onDensity(rho)

        expect(
          maxDifference(matrixOf(rho), conjugateBy(step.unitary, before))
        ).toBeLessThan(TOLERANCE)
      }
    })

    it(`${step.label}: the statevector path matches the same dense U`, () => {
      // Not the subject of this lens, but it is what makes the comparison
      // above meaningful: if `apply.ts` and `density.ts` were wrong in the
      // same way, only an outside oracle would say so.
      const next = seeded(0xbadc0de)
      const state = randomState(QUBITS, next)
      const expected = actOn(step.unitary, vectorOf(state))

      step.onState(state)

      const actual = vectorOf(state)
      let worst = 0
      for (let i = 0; i < actual.length; i++) {
        worst = Math.max(
          worst,
          Math.abs(actual[i].re - expected[i].re),
          Math.abs(actual[i].im - expected[i].im)
        )
      }
      expect(worst).toBeLessThan(TOLERANCE)
    })
  }
})

describe('a mixed ρ, so the equality is not an artefact of purity', () => {
  const QUBITS = 3

  /**
   * ρ = Σ pₖ |ψₖ⟩⟨ψₖ| for four random states with unequal weights: Hermitian,
   * unit trace, positive, and emphatically not a projector. |ψ⟩⟨ψ| is a very
   * special matrix — rank one — and a kernel that happened to be right only on
   * rank-one inputs (a pass applied twice to the rows, say, is the identity on
   * some of them) would pass every test above.
   */
  function randomMixture(next: () => number): {
    rho: DensityMatrix
    dense: Mat
  } {
    const weights = [0.4, 0.3, 0.2, 0.1]
    const rho = fromStatevector(randomState(QUBITS, next))
    rho.re.fill(0)
    rho.im.fill(0)
    const dense = zeros(1 << QUBITS)
    for (const weight of weights) {
      const term = outerProduct(vectorOf(randomState(QUBITS, next)))
      for (let row = 0; row < term.length; row++) {
        for (let column = 0; column < term.length; column++) {
          const at = row * rho.dim + column
          rho.re[at] += weight * term[row][column].re
          rho.im[at] += weight * term[row][column].im
          dense[row][column] = cadd(
            dense[row][column],
            cmul(cx(weight), term[row][column])
          )
        }
      }
    }
    return { rho, dense }
  }

  /** The same coverage as `everyKernelStep`, restated on three wires. */
  function stepsOnThreeWires(): Step[] {
    return [
      step1q(QUBITS, 'h(0)', M_H, 0),
      step1q(QUBITS, 'y(2)', M_Y, 2),
      step1q(QUBITS, 't(1)', M_T, 1),
      step1q(QUBITS, 'sx(2)', M_SX, 2),
      step1q(QUBITS, 'u(1)', mU(1.1, -0.4, 2.7), 1),
      step1q(QUBITS, 'cx(0→2)', M_X, 2, [POSITIVE(0)]),
      step1q(QUBITS, 'cx(2→0)', M_X, 0, [POSITIVE(2)]),
      step1q(QUBITS, 'negative-ch(2→1)', M_H, 1, [NEGATIVE(2)]),
      step1q(QUBITS, 'crz(2→0)', mRz(0.61), 0, [POSITIVE(2)]),
      step1q(QUBITS, 'ccx(0,2→1)', M_X, 1, [POSITIVE(0), NEGATIVE(2)]),
      stepSwap(QUBITS, 2, 0),
      stepSwap(QUBITS, 2, 1, [POSITIVE(0)]),
      stepISwap(QUBITS, 2, 0),
      step2q(QUBITS, 'custom4×4(2,0)', CUSTOM_4X4, 2, 0),
      step2q(QUBITS, 'custom4×4(0,2)', CUSTOM_4X4, 0, 2),
    ]
  }

  for (const step of stepsOnThreeWires()) {
    it(`${step.label} on a rank-4 ρ matches the dense UρU†`, () => {
      const next = seeded(0x1234)
      const { rho, dense } = randomMixture(next)

      const purityBefore = densityPurity(rho)
      expect(purityBefore).toBeLessThan(0.9)

      step.onDensity(rho)

      expect(
        maxDifference(matrixOf(rho), conjugateBy(step.unitary, dense))
      ).toBeLessThan(TOLERANCE)
      // Unitary evolution moves neither the trace nor the purity.
      expect(Math.abs(densityTrace(rho) - 1)).toBeLessThan(TOLERANCE)
      expect(Math.abs(densityPurity(rho) - purityBefore)).toBeLessThan(
        TOLERANCE
      )
      expect(isPositiveSemidefinite(rho)).toBe(true)
    })
  }
})

describe('D1 in ρ: the row is the ket and the column is the bra', () => {
  /**
   * The transposition detector.
   *
   * ρ = |ψ⟩⟨ψ| with ψ = (|b₁⟩ + i|b₂⟩)/√2 has ρ_{b₁b₂} = ψ_{b₁}·conj(ψ_{b₂}) =
   * −i/2 and ρ_{b₂b₁} = +i/2. An implementation that indexed rows where it
   * meant columns returns ρᵀ = conj(ρ), which is still Hermitian, still unit
   * trace, still positive semidefinite and still gives the right histogram.
   * The only thing that separates the two is the SIGN of an imaginary part
   * whose magnitude is a half — nowhere near the tolerance, so this assertion
   * has teeth.
   */
  it('places the coherence of (|001⟩ + i|100⟩)/√2 with the right sign', () => {
    const state = alloc(3)
    // Little-endian: qubit 0 set is index 1, qubit 2 set is index 4.
    const b1 = 1
    const b2 = 4
    state.re[0] = 0
    state.re[b1] = Math.SQRT1_2
    state.im[b2] = Math.SQRT1_2

    const rho = fromStatevector(state)

    expect(rho.re[b1 * rho.dim + b1]).toBeCloseTo(0.5, 12)
    expect(rho.re[b2 * rho.dim + b2]).toBeCloseTo(0.5, 12)
    expect(rho.re[b1 * rho.dim + b2]).toBeCloseTo(0, 12)
    expect(rho.im[b1 * rho.dim + b2]).toBeCloseTo(-0.5, 12)
    expect(rho.im[b2 * rho.dim + b1]).toBeCloseTo(0.5, 12)
  })

  /**
   * The same detector, but for the KERNEL rather than the outer product: the
   * conjugate belongs to the column pass and only to it. H then S on qubit 2
   * of |000⟩ gives (|000⟩ + i|100⟩)/√2, so ρ_{0,4} must be −i/2. Swapping the
   * two passes — or daggering in both — flips that sign.
   */
  it('puts the conjugate on the column pass, not the row pass', () => {
    const rho = fromStatevector(alloc(3))
    densityApplyControlled(rho, flatten(M_H), 2, [])
    densityApplyControlled(rho, flatten(M_S), 2, [])

    expect(rho.re[0 * rho.dim + 0]).toBeCloseTo(0.5, 12)
    expect(rho.re[4 * rho.dim + 4]).toBeCloseTo(0.5, 12)
    expect(rho.im[0 * rho.dim + 4]).toBeCloseTo(-0.5, 12)
    expect(rho.im[4 * rho.dim + 0]).toBeCloseTo(0.5, 12)
  })

  /**
   * A permutation circuit on non-adjacent wires: X on qubit 0, then CX with
   * control 0 and target 3, on four qubits. The result is the basis state with
   * qubits 0 and 3 set, which under D1 is index 1 + 8 = 9 — printed |1001⟩.
   * A big-endian ρ would put the population at index 9's mirror, 0b1001
   * reversed is 0b1001, so the test uses a second, asymmetric case as well.
   */
  it('populates the basis index D1 names, for asymmetric bit patterns', () => {
    const cases: { steps: Step[]; index: number; ket: string }[] = [
      {
        steps: [
          step1q(4, 'x(0)', M_X, 0),
          step1q(4, 'cx(0→3)', M_X, 3, [POSITIVE(0)]),
        ],
        index: 0b1001,
        ket: '1001',
      },
      {
        // Qubits 0 and 1 set, qubits 2 and 3 clear: index 3, ket |0011⟩. Under
        // the opposite convention this would land on index 12.
        steps: [step1q(4, 'x(0)', M_X, 0), step1q(4, 'x(1)', M_X, 1)],
        index: 0b0011,
        ket: '0011',
      },
      {
        // A negative control that fires because qubit 2 is clear.
        steps: [step1q(4, 'ncx(2→3)', M_X, 3, [NEGATIVE(2)])],
        index: 0b1000,
        ket: '1000',
      },
    ]

    for (const testCase of cases) {
      const rho = fromStatevector(alloc(4))
      const state = alloc(4)
      for (const step of testCase.steps) {
        step.onDensity(rho)
        step.onState(state)
      }

      const distribution = densityProbabilities(rho)
      expect(distribution[testCase.index], testCase.ket).toBeCloseTo(1, 12)
      for (let i = 0; i < distribution.length; i++) {
        if (i !== testCase.index) expect(distribution[i]).toBeCloseTo(0, 12)
      }
      // And the statevector agrees about which index that is.
      expect(
        maxVectorDifference(distribution, stateProbabilities(state))
      ).toBeLessThan(TOLERANCE)
    }
  })

  it('orders densityProbabilities exactly as measure.probabilities', () => {
    const next = seeded(0xabc)
    for (let trial = 0; trial < 25; trial++) {
      const state = randomState(4, next)
      const rho = fromStatevector(state)
      for (const step of everyKernelStep(4)) {
        step.onState(state)
        step.onDensity(rho)
      }
      expect(
        maxVectorDifference(
          densityProbabilities(rho),
          stateProbabilities(state)
        )
      ).toBeLessThan(TOLERANCE)
    }
  })
})

describe('purity is exactly 1 for a ρ that came from a statevector', () => {
  it('holds through a long chain of every kernel entry point', () => {
    const next = seeded(0xfeed)
    const state = randomState(4, next)
    const rho = fromStatevector(state)

    expect(Math.abs(densityPurity(rho) - 1)).toBeLessThan(TOLERANCE)

    const steps = everyKernelStep(4)
    for (let round = 0; round < 4; round++) {
      for (const step of steps) {
        step.onDensity(rho)
        step.onState(state)
        expect(Math.abs(densityPurity(rho) - 1), step.label).toBeLessThan(
          TOLERANCE
        )
      }
    }
    expect(
      maxDifference(matrixOf(rho), outerProduct(vectorOf(state)))
    ).toBeLessThan(TOLERANCE)
  })

  it('is not 1 for a genuinely mixed ρ — the check can fail', () => {
    // Half of |00⟩⟨00| and half of |11⟩⟨11|: Tr(ρ²) = 1/2, not 1.
    const rho = fromStatevector(alloc(2))
    rho.re[0] = 0.5
    rho.re[3 * rho.dim + 3] = 0.5
    expect(densityPurity(rho)).toBeCloseTo(0.5, 12)
  })

  /**
   * A Bell pair is the case where the two readings of "mixed" part company:
   * the joint ρ is pure (Tr(ρ²) = 1) while either qubit alone is maximally
   * mixed. If `purity` were secretly reading a marginal, this would be ½ — so
   * the test above is not the only thing pinning the number down.
   */
  it('is 1 for a Bell pair, whose parts are maximally mixed', () => {
    const rho = fromStatevector(alloc(2))
    densityApplyControlled(rho, flatten(M_H), 0, [])
    densityApplyControlled(rho, flatten(M_X), 1, [POSITIVE(0)])

    expect(Math.abs(densityPurity(rho) - 1)).toBeLessThan(TOLERANCE)
    // ρ = ½(|00⟩⟨00| + |00⟩⟨11| + |11⟩⟨00| + |11⟩⟨11|), all real.
    for (const [row, column] of [
      [0, 0],
      [0, 3],
      [3, 0],
      [3, 3],
    ]) {
      expect(rho.re[row * rho.dim + column]).toBeCloseTo(0.5, 12)
      expect(rho.im[row * rho.dim + column]).toBeCloseTo(0, 12)
    }
  })
})

describe('the metrics that read ρ agree with their statevector twins', () => {
  /**
   * `partialTraceOfDensity(|ψ⟩⟨ψ|, S)` must equal `partialTrace(|ψ⟩, S)`. The
   * two weave the traced-out index into their loops differently — one sums
   * ψ_i·conj(ψ_j) over the environment, the other reads ρ's diagonal in the
   * environment — so agreeing is a real statement and not a tautology. It is
   * also the seam the Bloch spheres of §5.5 cross in noise mode: on the ideal
   * path they come from a statevector and on the noisy path from ρ, and a
   * disagreement here would be two panels drawing different spheres for the
   * same state.
   */
  it('partialTraceOfDensity reproduces partialTrace on every subsystem', () => {
    const next = seeded(0x5150)
    const QUBITS = 4
    const subsystems: number[][] = [
      [0],
      [1],
      [2],
      [3],
      [0, 1],
      [0, 3],
      [2, 3],
      [1, 2],
      [0, 1, 2],
      [1, 2, 3],
      [0, 2, 3],
      [0, 1, 2, 3],
    ]

    for (let trial = 0; trial < 6; trial++) {
      const state = randomState(QUBITS, next)
      // Entangle, so the reductions are genuinely mixed and a wrong pairing
      // has somewhere to show. A product state would hide most of them.
      for (const step of everyKernelStep(QUBITS).slice(0, 20)) {
        step.onState(state)
      }
      const rho = fromStatevector(state)

      for (const keep of subsystems) {
        const fromVector = partialTrace(state, keep)
        const fromDensity = partialTraceOfDensity(rho, keep)
        expect(
          maxDifference(matrixOf(fromVector), matrixOf(fromDensity)),
          `keep ${keep.join(',')}`
        ).toBeLessThan(TOLERANCE)
      }
    }
  })

  /**
   * ⟨ψ|ρ|ψ⟩ = 1 when ρ = |ψ⟩⟨ψ|, and this is a transpose detector in its own
   * right: for a transposed ρ the same expression evaluates to |⟨ψ|ψ*⟩|²,
   * which for a state with phases is well below 1.
   */
  it('densityStateFidelity is exactly 1 against its own statevector', () => {
    const next = seeded(0x9001)
    for (let trial = 0; trial < 10; trial++) {
      const state = randomState(4, next)
      for (const step of everyKernelStep(4)) step.onState(state)
      const rho = fromStatevector(state)
      expect(Math.abs(densityStateFidelity(rho, state) - 1)).toBeLessThan(
        TOLERANCE
      )
    }
  })

  /**
   * F(|ψ⟩⟨ψ|, |φ⟩⟨φ|) must be |⟨ψ|φ⟩|², the pure-state fidelity — the closed
   * form the general Uhlmann expression has to reduce to when both arguments
   * are rank one.
   */
  it('densityFidelity reduces to |⟨ψ|φ⟩|² for two pure states', () => {
    const next = seeded(0x9002)
    for (let trial = 0; trial < 8; trial++) {
      const a = randomState(3, next)
      const b = randomState(3, next)
      const expected = stateFidelity(a, b)
      const actual = densityFidelity(fromStatevector(a), fromStatevector(b))
      expect(Math.abs(actual - expected)).toBeLessThan(1e-8)
    }
  })
})

describe('apply1q, reached directly rather than through applyControlled', () => {
  it('matches the statevector twin on every wire of a 4-qubit register', () => {
    const next = seeded(0x777)
    for (const m of [M_H, M_Y, M_SX, M_T, mU(0.3, 1.7, -2.2), mRx(1.4)]) {
      const flat = flatten(m)
      for (let target = 0; target < 4; target++) {
        const state = randomState(4, next)
        const rho = fromStatevector(state)

        stateApply1q(state, flat, target)
        densityApply1q(rho, flat, target)

        expect(
          maxDifference(matrixOf(rho), outerProduct(vectorOf(state)))
        ).toBeLessThan(TOLERANCE)
        expect(Math.abs(densityPurity(rho) - 1)).toBeLessThan(TOLERANCE)
      }
    }
  })
})

/* ─────────────────── random circuits, through the runner ────────────────── */

let operationCounter = 0

function nextId(): string {
  operationCounter++
  return `v${operationCounter}`
}

/**
 * A random circuit over the whole gate catalog, generated here rather than
 * taken from `testing/random-circuits.ts` so that the two suites cannot share
 * a gap. `measure` and `reset` are absent on purpose: a mid-circuit
 * measurement is refused by both modes, and a reset of a superposed qubit is a
 * non-unitary map the analytic statevector path cannot represent at all — it
 * is covered separately below in the one case where both modes are defined.
 */
function randomCircuit(qubits: number, columns: number, next: () => number) {
  const operations: OperationLike[] = []
  const angle = (): number => (next() - 0.5) * 6
  const pick = <T>(values: readonly T[]): T =>
    values[Math.floor(next() * values.length)]

  for (let column = 0; column < columns; column++) {
    const free: number[] = []
    for (let qubit = 0; qubit < qubits; qubit++) free.push(qubit)
    const take = (): number =>
      free.splice(Math.floor(next() * free.length), 1)[0]

    while (free.length > 0) {
      const roll = Math.floor(next() * 9)
      if (roll <= 1) {
        operations.push({
          id: nextId(),
          gate: pick(['h', 'x', 'y', 'z', 's', 'sdg', 't', 'tdg', 'sx', 'i']),
          targets: [take()],
          column,
        })
      } else if (roll === 2) {
        const gate = pick(['rx', 'ry', 'rz', 'p'])
        operations.push({
          id: nextId(),
          gate,
          targets: [take()],
          column,
          params: [angle()],
        })
      } else if (roll === 3) {
        operations.push({
          id: nextId(),
          gate: 'u',
          targets: [take()],
          column,
          params: [angle(), angle(), angle()],
        })
      } else if (roll === 4 && free.length >= 2) {
        // A one-qubit gate the user added a control to, negative half the
        // time — the shape `applyControlled` exists for.
        const gate = pick(['x', 'z', 'h', 'y', 'sx'])
        operations.push({
          id: nextId(),
          gate,
          targets: [take()],
          column,
          controls: [{ qubit: take(), state: next() < 0.5 ? 0 : 1 }],
        })
      } else if (roll === 5 && free.length >= 2) {
        const gate = pick(['cx', 'cz', 'crz', 'cp'])
        operations.push({
          id: nextId(),
          gate,
          targets: [take()],
          column,
          controls: [take()],
          ...(gate === 'crz' || gate === 'cp' ? { params: [angle()] } : {}),
        })
      } else if (roll === 6 && free.length >= 2) {
        operations.push({
          id: nextId(),
          gate: pick(['swap', 'iswap']),
          targets: [take(), take()],
          column,
        })
      } else if (roll === 7 && free.length >= 3) {
        operations.push(
          next() < 0.5
            ? {
                id: nextId(),
                gate: 'ccx',
                targets: [take()],
                column,
                controls: [take(), take()],
              }
            : {
                id: nextId(),
                gate: 'cswap',
                targets: [take(), take()],
                column,
                controls: [take()],
              }
        )
      } else {
        operations.push({
          id: nextId(),
          gate: 'barrier',
          targets: [take()],
          column,
        })
      }
    }
  }
  return { qubits, operations } satisfies CircuitLike
}

describe('runNoisyDensity at zero noise reproduces the analytic run', () => {
  const IDEAL = { profile: NOISE_PROFILES.ideal, readout: false } as const

  for (const qubits of [2, 3, 4, 5]) {
    it(`${qubits} qubits, 40 random circuits, ρ = |ψ⟩⟨ψ| entry for entry`, () => {
      const next = seeded(0x9e3779b9 ^ qubits)
      for (let trial = 0; trial < 40; trial++) {
        const circuit = randomCircuit(qubits, 6, next)

        const analytic = run(circuit)
        expect(analytic.mode).toBe('analytic')
        if (analytic.mode !== 'analytic') return
        const noisy = runNoisyDensity(circuit, IDEAL)

        // (a) the distribution the histogram of §3.3 puts side by side
        expect(
          maxVectorDifference(
            noisy.distribution,
            stateProbabilities(analytic.state)
          ),
          `seed trial ${trial}`
        ).toBeLessThan(TOLERANCE)

        // (b) the whole ρ, which is strictly more than (a)
        expect(
          maxDifference(
            matrixOf(noisy.rho),
            outerProduct(vectorOf(analytic.state))
          ),
          `seed trial ${trial}`
        ).toBeLessThan(TOLERANCE)

        // (c) it is still a state, and still a pure one
        expectPureAndPhysical(noisy.rho, `trial ${trial}`)
      }
    })
  }

  /**
   * A deep circuit, because the two modes renormalise on different schedules:
   * `run` rescales the statevector's norm every `RENORMALIZE_INTERVAL` gates
   * and `runNoisyDensity` rescales ρ's trace on its own count. Those are
   * different corrections applied at different moments, so drift is the one
   * thing that could separate the paths without any indexing being wrong. Six
   * columns cannot show it; forty can.
   */
  it('still agrees to 1e-10 after 40 columns of gates', () => {
    const next = seeded(0x0dd1)
    for (let trial = 0; trial < 6; trial++) {
      const circuit = randomCircuit(5, 40, next)
      const analytic = run(circuit)
      if (analytic.mode !== 'analytic') return
      const noisy = runNoisyDensity(circuit, IDEAL)

      expect(
        maxDifference(
          matrixOf(noisy.rho),
          outerProduct(vectorOf(analytic.state))
        ),
        `deep trial ${trial}`
      ).toBeLessThan(TOLERANCE)
      expectPureAndPhysical(noisy.rho, `deep trial ${trial}`)
    }
  })

  /**
   * Six and seven qubits: the strides in every kernel are powers of two, and a
   * pairing walk that happens to be right for four wires can be wrong for a
   * target near the top of a wider register. ρ is 16 384 entries at 7 qubits,
   * so this is still cheap — and `isPositiveSemidefinite` is O(8ⁿ), hence the
   * cheaper invariants here.
   */
  for (const qubits of [6, 7]) {
    it(`${qubits} qubits: the wider strides pair the same way`, () => {
      const next = seeded(0xbeef ^ qubits)
      for (let trial = 0; trial < 4; trial++) {
        const circuit = randomCircuit(qubits, 8, next)
        const analytic = run(circuit)
        if (analytic.mode !== 'analytic') return
        const noisy = runNoisyDensity(circuit, IDEAL)

        expect(
          maxDifference(
            matrixOf(noisy.rho),
            outerProduct(vectorOf(analytic.state))
          ),
          `wide trial ${trial}`
        ).toBeLessThan(TOLERANCE)
        expect(hermiticityDefect(noisy.rho)).toBeLessThan(TOLERANCE)
        expect(Math.abs(densityTrace(noisy.rho) - 1)).toBeLessThan(TOLERANCE)
        expect(Math.abs(densityPurity(noisy.rho) - 1)).toBeLessThan(TOLERANCE)
      }
    })
  }

  it('also agrees when the readout term is left at its default', () => {
    const next = seeded(0x2468)
    for (let trial = 0; trial < 20; trial++) {
      const circuit = randomCircuit(4, 5, next)
      const analytic = run(circuit)
      if (analytic.mode !== 'analytic') return
      const noisy = runNoisyDensity(circuit, { profile: NOISE_PROFILES.ideal })
      expect(
        maxVectorDifference(
          noisy.distribution,
          stateProbabilities(analytic.state)
        )
      ).toBeLessThan(TOLERANCE)
    }
  })

  /**
   * `reset` reaches the density path as amplitude damping at γ = 1 and the
   * statevector path as collapse-and-flip. The two are the same map only when
   * the qubit is deterministic — which is the one case the analytic
   * statevector mode accepts — so that is the case compared here. It matters
   * because the coherence between the OTHER qubits must survive: a reset that
   * silently decohered its neighbours would still return a valid ρ.
   */
  it('resets a deterministic qubit the way the statevector path does', () => {
    for (const preparation of ['x', 'i'] as const) {
      const circuit: CircuitLike = {
        qubits: 3,
        operations: [
          { id: 'a', gate: 'h', targets: [1], column: 0 },
          { id: 'b', gate: 's', targets: [1], column: 1 },
          { id: 'c', gate: preparation, targets: [0], column: 2 },
          { id: 'd', gate: 'cx', targets: [2], column: 3, controls: [0] },
          { id: 'e', gate: 'reset', targets: [0], column: 4 },
        ],
      }
      const analytic = run(circuit)
      if (analytic.mode !== 'analytic') return
      const noisy = runNoisyDensity(circuit, {
        profile: NOISE_PROFILES.ideal,
        readout: false,
      })
      expect(
        maxDifference(
          matrixOf(noisy.rho),
          outerProduct(vectorOf(analytic.state))
        ),
        `reset after ${preparation}`
      ).toBeLessThan(TOLERANCE)
      expectPureAndPhysical(noisy.rho, `reset after ${preparation}`)
    }
  })
})
