/**
 * INDEPENDENT ADVERSARIAL VERIFICATION — CHANNEL MATHEMATICS LENS.
 *
 * Nothing in this file is derived from `noise.ts`, from `density.ts` or from
 * either module's own test file. The oracle here is a deliberately slow dense
 * linear algebra written from the definitions: boxed complex numbers in nested
 * arrays, O(n³) products, explicit 2ⁿ × 2ⁿ lifts of a one-qubit operator built
 * by enumerating basis states and comparing bits one at a time. It shares no
 * stride, no accumulator and no index arithmetic with the implementation, which
 * is the only reason it is able to disagree with it.
 *
 * Three oracles, in increasing strength.
 *
 *  1. **Σ Kₖ†Kₖ = I, multiplied out.** `krausDefect` computes this with a
 *     hand-unrolled accumulator; this file computes conj(K)ᵀ·K with a triple
 *     loop and adds the results as matrices. A coefficient that is wrong by any
 *     factor moves it, so this is the cheap net under every constructor.
 *
 *  2. **The closed form, as an action rather than as operators.** Re-typing
 *     §5.4's operators and checking they equal themselves would prove nothing.
 *     So each channel is specified here by what it *does* to ρ — depolarising
 *     is (1−p)ρ + p·I/2, amplitude damping moves γ of the excited population
 *     down and carries the coherence by √(1−γ), phase damping moves no
 *     population at all — and the implementation's operators are expanded by
 *     dense multiplication and required to reproduce that map. The two live
 *     conventions for the depolarising p differ by exactly a factor of four
 *     and both give a valid ρ; only this test separates them.
 *
 *  3. **The Choi matrix.** J(ε) = Σᵢⱼ |i⟩⟨j| ⊗ ε(|i⟩⟨j|) is the whole channel
 *     as a single 4×4 matrix, and it settles both properties at once for
 *     *every* input rather than for the ones a test happened to try: ε is
 *     completely positive iff J ⪰ 0, and trace preserving iff Tr_out(J) = I.
 *     It is built here by running the implementation's `applyChannel` on the
 *     maximally entangled two-qubit ρ — the physical construction — and its
 *     spectrum is taken with a Jacobi eigensolver written in this file, on the
 *     real 2n × 2n embedding of the Hermitian matrix. Nothing borrowed from
 *     `eigen.ts` and nothing borrowed from `isPositiveSemidefinite`, because
 *     positivity is the check that catches a wrong sign and an oracle sharing
 *     a decomposition with the code it audits catches nothing.
 *
 * Choi equality is also what "these two channels are the same map" means here:
 * the composition laws below compare Choi matrices, not sample outputs, so a
 * composed rate that is right on the states tried and wrong elsewhere has
 * nowhere to hide.
 *
 * The infidelity conversions get their own independent route: F_avg is
 * computed as (Σₖ |Tr Kₖ|² + d) / (d(d+1)), which is a statement about the
 * operators, where `relaxationInfidelity` computes it from the diagonal of the
 * Bloch map. Two derivations, one number.
 */

import { describe, expect, it } from 'vitest'

import { alloc as densityAlloc } from '../density.js'
import type { DensityMatrix } from '../density.js'
import {
  MAX_ONE_QUBIT_GATE_ERROR,
  MAX_TWO_QUBIT_GATE_ERROR,
  NOISE_CHANNEL_KINDS,
  NOISE_PROFILES,
  NoiseProfileError,
  amplitudeDampingChannel,
  applyChannel,
  applyReadoutError,
  bitFlipChannel,
  channelFor,
  channelsForGate,
  channelsForIdle,
  depolarizingChannel,
  depolarizingFromGateError,
  localDepolarizingFromPairError,
  phaseDampingChannel,
  phaseFlipChannel,
  relaxationFor,
  relaxationInfidelity,
} from '../noise.js'
import { alloc as stateAlloc } from '../statevector.js'
import { krausWeights } from '../trajectories.js'
import type { KrausChannel, NoiseChannelKind, ReadoutError } from '../noise.js'

/** D6's tolerance. Every comparison below is absolute and against this. */
const TOL = 1e-10

/**
 * The parameters every channel is swept over.
 *
 * The endpoints are here because they are where the closed forms bite, and
 * 1e-12 is here because a channel that is nearly the identity is what a
 * coefficient error looks like from a distance.
 */
const PARAMETERS = [0, 1e-12, 0.001, 0.1, 0.25, 1 / 3, 0.5, 0.75, 0.9, 1]

/** The kinds as a plain array — `it.each` will not take a readonly tuple. */
const KINDS = [...NOISE_CHANNEL_KINDS]

/* ─────────────────────── slow, obvious complex algebra ──────────────────── */

interface Cx {
  readonly re: number
  readonly im: number
}

type Mat = Cx[][]

const cx = (re: number, im = 0): Cx => ({ re, im })
const cadd = (a: Cx, b: Cx): Cx => ({ re: a.re + b.re, im: a.im + b.im })
const cmul = (a: Cx, b: Cx): Cx => ({
  re: a.re * b.re - a.im * b.im,
  im: a.re * b.im + a.im * b.re,
})
const cconj = (a: Cx): Cx => ({ re: a.re, im: -a.im })
const cscale = (a: Cx, s: number): Cx => ({ re: a.re * s, im: a.im * s })

function zeros(n: number): Mat {
  return Array.from({ length: n }, () => Array.from({ length: n }, () => cx(0)))
}

function eye(n: number): Mat {
  const out = zeros(n)
  for (let i = 0; i < n; i++) out[i][i] = cx(1)
  return out
}

/** The honest O(n³) product. */
function matMul(a: Mat, b: Mat): Mat {
  const n = a.length
  const out = zeros(n)
  for (let i = 0; i < n; i++) {
    for (let j = 0; j < n; j++) {
      let sum = cx(0)
      for (let k = 0; k < n; k++) sum = cadd(sum, cmul(a[i][k], b[k][j]))
      out[i][j] = sum
    }
  }
  return out
}

function matAdd(a: Mat, b: Mat): Mat {
  const n = a.length
  const out = zeros(n)
  for (let i = 0; i < n; i++) {
    for (let j = 0; j < n; j++) out[i][j] = cadd(a[i][j], b[i][j])
  }
  return out
}

function matScale(a: Mat, s: number): Mat {
  return a.map((row) => row.map((value) => cscale(value, s)))
}

/** Conjugate transpose, written as the definition and not as a flag. */
function matDagger(a: Mat): Mat {
  const n = a.length
  const out = zeros(n)
  for (let i = 0; i < n; i++) {
    for (let j = 0; j < n; j++) out[i][j] = cconj(a[j][i])
  }
  return out
}

function matTrace(a: Mat): Cx {
  let sum = cx(0)
  for (let i = 0; i < a.length; i++) sum = cadd(sum, a[i][i])
  return sum
}

/** The largest |a_ij − b_ij| over the whole matrix. */
function maxDiff(a: Mat, b: Mat): number {
  let worst = 0
  for (let i = 0; i < a.length; i++) {
    for (let j = 0; j < a.length; j++) {
      const d = Math.hypot(a[i][j].re - b[i][j].re, a[i][j].im - b[i][j].im)
      if (d > worst) worst = d
    }
  }
  return worst
}

/* ────────────────── an eigensolver owed to nothing in the tree ──────────── */

/**
 * Eigenvalues of a real symmetric matrix by cyclic Jacobi rotations.
 *
 * Written out here rather than imported from `eigen.ts` on purpose: this is
 * the oracle for positivity, and an oracle that shares a decomposition with
 * the code under test cannot contradict it.
 */
function jacobiEigenvalues(input: number[][]): number[] {
  const n = input.length
  const a = input.map((row) => row.slice())
  for (let sweep = 0; sweep < 60; sweep++) {
    let off = 0
    for (let p = 0; p < n; p++) {
      for (let q = p + 1; q < n; q++) off += a[p][q] * a[p][q]
    }
    // Jacobi converges quadratically, so a handful of sweeps takes the
    // off-diagonal mass to ~1e-28 and the eigenvalues to well inside D6's
    // 1e-10; the sweep cap only exists so a pathological input cannot hang.
    if (off < 1e-28) break
    for (let p = 0; p < n; p++) {
      for (let q = p + 1; q < n; q++) {
        if (Math.abs(a[p][q]) < 1e-300) continue
        // t solves t² + 2θt − 1 = 0, the root of smaller magnitude.
        const theta = (a[q][q] - a[p][p]) / (2 * a[p][q])
        const sign = theta >= 0 ? 1 : -1
        const t = sign / (Math.abs(theta) + Math.sqrt(theta * theta + 1))
        const c = 1 / Math.sqrt(t * t + 1)
        const s = t * c
        // A ← JᵀAJ with J = I except J_pp = J_qq = c, J_pq = s, J_qp = −s.
        for (let k = 0; k < n; k++) {
          const akp = a[k][p]
          const akq = a[k][q]
          a[k][p] = c * akp - s * akq
          a[k][q] = s * akp + c * akq
        }
        for (let k = 0; k < n; k++) {
          const apk = a[p][k]
          const aqk = a[q][k]
          a[p][k] = c * apk - s * aqk
          a[q][k] = s * apk + c * aqk
        }
      }
    }
  }
  return a.map((row, i) => row[i])
}

/**
 * The spectrum of a Hermitian matrix, via the real embedding
 *
 *     H = A + iB   ↦   ⎡ A  −B ⎤
 *                      ⎣ B   A ⎦
 *
 * which is real symmetric when A is symmetric and B antisymmetric, and whose
 * eigenvalues are those of H each appearing twice. One short function instead
 * of a complex Jacobi, and every step of it is checkable by hand.
 */
function hermitianEigenvalues(m: Mat): number[] {
  const n = m.length
  const size = 2 * n
  const a: number[][] = Array.from({ length: size }, () =>
    new Array<number>(size).fill(0)
  )
  for (let i = 0; i < n; i++) {
    for (let j = 0; j < n; j++) {
      a[i][j] = m[i][j].re
      a[i][j + n] = -m[i][j].im
      a[i + n][j] = m[i][j].im
      a[i + n][j + n] = m[i][j].re
    }
  }
  return jacobiEigenvalues(a)
}

function minEigenvalue(m: Mat): number {
  return Math.min(...hermitianEigenvalues(m))
}

/** |m_ij − conj(m_ji)| at its worst, the diagonal included. */
function hermiticityGap(m: Mat): number {
  let worst = 0
  for (let i = 0; i < m.length; i++) {
    for (let j = 0; j < m.length; j++) {
      const other = cconj(m[j][i])
      const d = Math.hypot(m[i][j].re - other.re, m[i][j].im - other.im)
      if (d > worst) worst = d
    }
  }
  return worst
}

/**
 * Assert that `m` is a density matrix: Hermitian, unit trace, and positive
 * semidefinite. The third is the one that catches a sign — the first two
 * survive a wrong coefficient, a doubled application and a conjugate on the
 * wrong operand.
 */
function expectValidDensity(m: Mat, what: string): void {
  expect(hermiticityGap(m), `${what}: Hermiticity`).toBeLessThan(TOL)
  const tr = matTrace(m)
  expect(tr.re, `${what}: Tr(ρ)`).toBeCloseTo(1, 10)
  expect(Math.abs(tr.im), `${what}: Im Tr(ρ)`).toBeLessThan(TOL)
  expect(minEigenvalue(m), `${what}: λ_min`).toBeGreaterThan(-TOL)
}

/* ───────────────────────── bridges to the implementation ────────────────── */

/**
 * A `Matrix2` as a 2×2 — the flat, row-major, interleaved layout `gates.ts`
 * documents, unpacked once here so no other line in this file has to know it.
 */
function fromMatrix2(m: Float64Array): Mat {
  return [
    [cx(m[0], m[1]), cx(m[2], m[3])],
    [cx(m[4], m[5]), cx(m[6], m[7])],
  ]
}

function fromDensity(rho: DensityMatrix): Mat {
  const out = zeros(rho.dim)
  for (let r = 0; r < rho.dim; r++) {
    for (let c = 0; c < rho.dim; c++) {
      const at = r * rho.dim + c
      out[r][c] = cx(rho.re[at], rho.im[at])
    }
  }
  return out
}

function intoDensity(rho: DensityMatrix, m: Mat): void {
  for (let r = 0; r < rho.dim; r++) {
    for (let c = 0; c < rho.dim; c++) {
      const at = r * rho.dim + c
      rho.re[at] = m[r][c].re
      rho.im[at] = m[r][c].im
    }
  }
}

function densityOf(qubits: number, m: Mat): DensityMatrix {
  const rho = densityAlloc(qubits)
  intoDensity(rho, m)
  return rho
}

/**
 * A one-qubit operator as a 2ⁿ × 2ⁿ matrix on `target`, built by enumerating
 * basis states and comparing every other bit one at a time.
 *
 * This is the Kronecker product D1 implies, written the slow way on purpose:
 * `I ⊗ … ⊗ k ⊗ … ⊗ I` with the factor order little-endian is exactly the
 * statement that rows and columns agreeing on every wire but `target` carry
 * k's entry for that wire, and nothing else is non-zero. No strides.
 */
function liftOperator(k: Mat, qubits: number, target: number): Mat {
  const dim = 1 << qubits
  const out = zeros(dim)
  for (let r = 0; r < dim; r++) {
    for (let c = 0; c < dim; c++) {
      let spectatorsAgree = true
      for (let q = 0; q < qubits; q++) {
        if (q === target) continue
        if (((r >> q) & 1) !== ((c >> q) & 1)) spectatorsAgree = false
      }
      if (!spectatorsAgree) continue
      out[r][c] = k[(r >> target) & 1][(c >> target) & 1]
    }
  }
  return out
}

/** Σₖ Kₖ ρ Kₖ†, by dense multiplication. The definition, nothing more. */
function applyDense(operators: readonly Mat[], rho: Mat): Mat {
  let out = zeros(rho.length)
  for (const k of operators) {
    out = matAdd(out, matMul(matMul(k, rho), matDagger(k)))
  }
  return out
}

/** The channel's operators, as 2×2 matrices this file can multiply. */
function operatorsOf(channel: KrausChannel): Mat[] {
  return channel.operators.map((k) => fromMatrix2(k))
}

/* ─────────────────────── the closed forms, written as maps ──────────────── */

const PAULI_X: Mat = [
  [cx(0), cx(1)],
  [cx(1), cx(0)],
]
const PAULI_Z: Mat = [
  [cx(1), cx(0)],
  [cx(0), cx(-1)],
]

/**
 * What each channel *does* to a one-qubit ρ, from the physics rather than from
 * a Kraus set.
 *
 * These are the independent statements this whole file turns on:
 *
 *   depolarising     ρ ↦ (1−p)·ρ + p·I/2   (p = P[replaced by the mixed state])
 *   amplitude damp.  population γ of the excited level moves to the ground
 *                    level, coherence carried by √(1−γ)
 *   phase damping    populations untouched, coherence carried by √(1−λ)
 *   bit flip         ρ ↦ (1−p)·ρ + p·XρX
 *   phase flip       ρ ↦ (1−p)·ρ + p·ZρZ
 */
function closedForm(kind: NoiseChannelKind, x: number, rho: Mat): Mat {
  switch (kind) {
    case 'depolarizing':
      // Tr(ρ)·I/2 and not I/2: the map has to be LINEAR to be a channel, and
      // the Choi construction below feeds it the matrix units |i⟩⟨j|, whose
      // trace is 0 for i ≠ j. Writing the constant term without the trace
      // gives a map that agrees on every state and is not linear — which is
      // exactly the kind of thing that looks right until it is asked a
      // question no state can ask.
      return matAdd(
        matScale(rho, 1 - x),
        matScale(eye(2), (x * matTrace(rho).re) / 2)
      )
    case 'amplitudeDamping': {
      const carried = Math.sqrt(1 - x)
      return [
        [cadd(rho[0][0], cscale(rho[1][1], x)), cscale(rho[0][1], carried)],
        [cscale(rho[1][0], carried), cscale(rho[1][1], 1 - x)],
      ]
    }
    case 'phaseDamping': {
      const carried = Math.sqrt(1 - x)
      return [
        [rho[0][0], cscale(rho[0][1], carried)],
        [cscale(rho[1][0], carried), rho[1][1]],
      ]
    }
    case 'bitFlip':
      return matAdd(
        matScale(rho, 1 - x),
        matScale(matMul(matMul(PAULI_X, rho), PAULI_X), x)
      )
    case 'phaseFlip':
      return matAdd(
        matScale(rho, 1 - x),
        matScale(matMul(matMul(PAULI_Z, rho), PAULI_Z), x)
      )
  }
}

/* ───────────────────────────── random states ────────────────────────────── */

/** A deterministic generator, so a failure here is a failure every time. */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

/**
 * A random density matrix: ρ = GG†/Tr(GG†) for a random complex G.
 *
 * Positive semidefinite and unit trace by construction, and generically full
 * rank and complex — which matters, because a real ρ cannot see a sign error
 * on an imaginary part and a rank-1 ρ cannot see a channel that only moves
 * mixtures around.
 */
function randomDensity(dim: number, next: () => number): Mat {
  const g = zeros(dim)
  for (let i = 0; i < dim; i++) {
    for (let j = 0; j < dim; j++) {
      g[i][j] = cx(next() * 2 - 1, next() * 2 - 1)
    }
  }
  const gg = matMul(g, matDagger(g))
  return matScale(gg, 1 / matTrace(gg).re)
}

/* ───────────── the Choi matrix: the whole channel as one matrix ─────────── */

/**
 * J(ε) = (id ⊗ ε)(|Ω⟩⟨Ω|) with |Ω⟩ = (|00⟩ + |11⟩)/√2 — the channel applied to
 * half of a maximally entangled pair, which is a state and can therefore be
 * produced by the implementation's own `applyChannel`.
 *
 * Qubit 0 is the one the channel acts on and qubit 1 is the untouched
 * reference. Two channels are the same map exactly when their Choi matrices
 * agree, so this is the object every "is the composed rate right" test below
 * compares — a much stronger claim than agreement on the states a test
 * happened to pick.
 */
function choiOf(apply: (rho: DensityMatrix) => void): Mat {
  // |Ω⟩⟨Ω| with |Ω⟩ = (|00⟩ + |11⟩)/√2. In D1's indexing the two basis states
  // with both bits equal are 0 and 3.
  const omega = zeros(4)
  for (const r of [0, 3]) {
    for (const c of [0, 3]) omega[r][c] = cx(0.5)
  }
  const rho = densityOf(2, omega)
  apply(rho)
  return fromDensity(rho)
}

function choiOfChannels(channels: readonly KrausChannel[]): Mat {
  return choiOf((rho) => {
    for (const channel of channels) applyChannel(rho, channel, 0)
  })
}

/**
 * Tr over the qubit the channel acted on (qubit 0), leaving the reference.
 *
 * For a trace-preserving channel this is the identity on the reference, scaled
 * by 1/2 because |Ω⟩⟨Ω| is normalised — which is the Choi statement of
 * Σ Kₖ†Kₖ = I, arrived at from the other end.
 */
function traceOutSystem(choi: Mat): Mat {
  const out = zeros(2)
  for (let a = 0; a < 2; a++) {
    for (let b = 0; b < 2; b++) {
      let sum = cx(0)
      for (let s = 0; s < 2; s++) {
        // Index = s (bit 0, the system) + 2·(reference bit).
        sum = cadd(sum, choi[s + 2 * a][s + 2 * b])
      }
      out[a][b] = sum
    }
  }
  return out
}

/* ══════════════════════════════ the tests ═══════════════════════════════ */

describe('trace preservation, multiplied out', () => {
  it.each(KINDS)('Σ K†K = I for %s', (kind) => {
    for (const x of PARAMETERS) {
      const operators = operatorsOf(channelFor(kind, x))
      let sum = zeros(2)
      for (const k of operators) {
        sum = matAdd(sum, matMul(matDagger(k), k))
      }
      expect(maxDiff(sum, eye(2)), `${kind} at ${x}`).toBeLessThan(TOL)
    }
  })

  it('every operator set has at least one operator', () => {
    for (const kind of NOISE_CHANNEL_KINDS) {
      for (const x of PARAMETERS) {
        expect(channelFor(kind, x).operators.length).toBeGreaterThan(0)
      }
    }
  })

  it('the depolarising p is the mixing probability, not the Pauli one', () => {
    // The competing convention writes the identity coefficient as √(1−3p) and
    // caps p at 1/3. The two differ by exactly four, so Σ K†K = I holds for
    // both and only the action separates them. At p = 1/3 this channel must
    // shrink the Bloch vector by 2/3; the other convention would erase it.
    const channel = depolarizingChannel(1 / 3)
    const rho: Mat = [
      [cx(1), cx(0)],
      [cx(0), cx(0)],
    ]
    const out = applyDense(operatorsOf(channel), rho)
    // r_z = ρ₀₀ − ρ₁₁, which starts at 1 and must land on 1 − p = 2/3.
    expect(out[0][0].re - out[1][1].re).toBeCloseTo(2 / 3, 12)
  })
})

describe('the operators reproduce the closed forms', () => {
  it.each(KINDS)('%s on random ρ', (kind) => {
    const next = mulberry32(0x5eed + kind.length)
    for (const x of PARAMETERS) {
      const operators = operatorsOf(channelFor(kind, x))
      for (let trial = 0; trial < 12; trial++) {
        const rho = randomDensity(2, next)
        const got = applyDense(operators, rho)
        const want = closedForm(kind, x, rho)
        expect(maxDiff(got, want), `${kind} at ${x}`).toBeLessThan(TOL)
        expectValidDensity(got, `${kind} at ${x}`)
      }
    }
  })
})

describe('the named closed forms', () => {
  it('depolarising at p = 1 fixes the maximally mixed state', () => {
    const mixed = matScale(eye(2), 0.5)
    const out = applyDense(operatorsOf(depolarizingChannel(1)), mixed)
    expect(maxDiff(out, mixed)).toBeLessThan(TOL)
  })

  it('depolarising at p = 1 sends every state to the mixed one', () => {
    const next = mulberry32(11)
    const mixed = matScale(eye(2), 0.5)
    const operators = operatorsOf(depolarizingChannel(1))
    for (let trial = 0; trial < 20; trial++) {
      const out = applyDense(operators, randomDensity(2, next))
      expect(maxDiff(out, mixed)).toBeLessThan(TOL)
    }
  })

  it('depolarising fixes the maximally mixed state at every p', () => {
    // The mixed state is the fixed point of the channel for all p, not only
    // at the endpoint — the statement that the channel is unital.
    const mixed = matScale(eye(2), 0.5)
    for (const p of PARAMETERS) {
      const out = applyDense(operatorsOf(depolarizingChannel(p)), mixed)
      expect(maxDiff(out, mixed), `p = ${p}`).toBeLessThan(TOL)
    }
  })

  it('amplitude damping at γ = 1 sends every state to |0⟩⟨0|', () => {
    const next = mulberry32(23)
    const ground: Mat = [
      [cx(1), cx(0)],
      [cx(0), cx(0)],
    ]
    const operators = operatorsOf(amplitudeDampingChannel(1))
    for (let trial = 0; trial < 20; trial++) {
      const out = applyDense(operators, randomDensity(2, next))
      expect(maxDiff(out, ground)).toBeLessThan(TOL)
    }
  })

  it('phase damping leaves populations alone and kills coherences', () => {
    const next = mulberry32(37)
    for (const lambda of PARAMETERS) {
      const operators = operatorsOf(phaseDampingChannel(lambda))
      for (let trial = 0; trial < 8; trial++) {
        const rho = randomDensity(2, next)
        const out = applyDense(operators, rho)
        expect(out[0][0].re, `ρ₀₀ at λ = ${lambda}`).toBeCloseTo(
          rho[0][0].re,
          12
        )
        expect(out[1][1].re, `ρ₁₁ at λ = ${lambda}`).toBeCloseTo(
          rho[1][1].re,
          12
        )
        const carried = Math.sqrt(1 - lambda)
        expect(out[0][1].re).toBeCloseTo(rho[0][1].re * carried, 12)
        expect(out[0][1].im).toBeCloseTo(rho[0][1].im * carried, 12)
      }
    }
  })

  it('phase damping at λ = 1 erases the coherences exactly', () => {
    const next = mulberry32(41)
    const operators = operatorsOf(phaseDampingChannel(1))
    for (let trial = 0; trial < 10; trial++) {
      const rho = randomDensity(2, next)
      const out = applyDense(operators, rho)
      expect(out[0][1].re).toBe(0)
      expect(out[0][1].im).toBe(0)
      expect(out[1][0].re).toBe(0)
      expect(out[1][0].im).toBe(0)
    }
  })

  it('the Bloch action of every channel is the documented one', () => {
    // r = (2·Re ρ₀₁, 2·Im ρ₁₀, ρ₀₀ − ρ₁₁), §5.5. Each channel's contraction
    // factors are a statement independent of its operators.
    const next = mulberry32(53)
    const bloch = (m: Mat): [number, number, number] => [
      2 * m[0][1].re,
      2 * m[1][0].im,
      m[0][0].re - m[1][1].re,
    ]
    for (const x of PARAMETERS) {
      const cases: Array<[KrausChannel, [number, number, number]]> = [
        [depolarizingChannel(x), [1 - x, 1 - x, 1 - x]],
        [bitFlipChannel(x), [1, 1 - 2 * x, 1 - 2 * x]],
        [phaseFlipChannel(x), [1 - 2 * x, 1 - 2 * x, 1]],
        [phaseDampingChannel(x), [Math.sqrt(1 - x), Math.sqrt(1 - x), 1]],
      ]
      for (const [channel, factors] of cases) {
        for (let trial = 0; trial < 6; trial++) {
          const rho = randomDensity(2, next)
          const before = bloch(rho)
          const after = bloch(applyDense(operatorsOf(channel), rho))
          for (let axis = 0; axis < 3; axis++) {
            expect(
              after[axis],
              `${channel.kind} at ${x}, axis ${axis}`
            ).toBeCloseTo(before[axis] * factors[axis], 11)
          }
        }
      }
      // Amplitude damping is the one affine map here: z → (1−γ)z + γ.
      const damped = amplitudeDampingChannel(x)
      for (let trial = 0; trial < 6; trial++) {
        const rho = randomDensity(2, next)
        const before = bloch(rho)
        const after = bloch(applyDense(operatorsOf(damped), rho))
        expect(after[0]).toBeCloseTo(before[0] * Math.sqrt(1 - x), 11)
        expect(after[1]).toBeCloseTo(before[1] * Math.sqrt(1 - x), 11)
        expect(after[2]).toBeCloseTo(before[2] * (1 - x) + x, 11)
      }
    }
  })
})

describe('parameter 0 is the identity map, bit for bit', () => {
  it.each(KINDS)('%s at 0 changes nothing', (kind) => {
    const next = mulberry32(67)
    const before = randomDensity(8, next)
    const rho = densityOf(3, before)
    for (let target = 0; target < 3; target++) {
      applyChannel(rho, channelFor(kind, 0), target)
    }
    const after = fromDensity(rho)
    // Exact equality, not closeness: at parameter 0 every constructor produces
    // the identity plus zeros, and identity arithmetic in Float64 is exact.
    for (let r = 0; r < 8; r++) {
      for (let c = 0; c < 8; c++) {
        expect(after[r][c].re).toBe(before[r][c].re)
        expect(after[r][c].im).toBe(before[r][c].im)
      }
    }
  })
})

describe('applyChannel against a dense Kronecker reference', () => {
  it.each(KINDS)('%s on every wire of a 3-qubit ρ', (kind) => {
    const next = mulberry32(0xbeef + kind.length)
    for (const x of PARAMETERS) {
      const channel = channelFor(kind, x)
      for (let target = 0; target < 3; target++) {
        const before = randomDensity(8, next)
        const rho = densityOf(3, before)
        applyChannel(rho, channel, target)
        const got = fromDensity(rho)

        const lifted = operatorsOf(channel).map((k) =>
          liftOperator(k, 3, target)
        )
        const want = applyDense(lifted, before)
        expect(
          maxDiff(got, want),
          `${kind} at ${x} on wire ${target}`
        ).toBeLessThan(TOL)
        expectValidDensity(got, `${kind} at ${x} on wire ${target}`)
      }
    }
  })

  it('a chain of channels on different wires stays a density matrix', () => {
    const next = mulberry32(97)
    for (let trial = 0; trial < 8; trial++) {
      const rho = densityOf(3, randomDensity(8, next))
      for (const kind of NOISE_CHANNEL_KINDS) {
        for (let target = 0; target < 3; target++) {
          applyChannel(rho, channelFor(kind, 0.17 + 0.05 * target), target)
          expectValidDensity(fromDensity(rho), `after ${kind} on ${target}`)
        }
      }
    }
  })
})

describe('the Choi matrix — complete positivity and trace preservation', () => {
  it.each(KINDS)('J(%s) is a valid Choi state', (kind) => {
    for (const x of PARAMETERS) {
      const choi = choiOfChannels([channelFor(kind, x)])
      expectValidDensity(choi, `J(${kind} at ${x})`)
      // Trace preservation, from the Choi end: Tr_system J = I/2.
      expect(
        maxDiff(traceOutSystem(choi), matScale(eye(2), 0.5)),
        `Tr_sys J(${kind} at ${x})`
      ).toBeLessThan(TOL)
    }
  })

  it('J matches the closed-form channel, entry for entry', () => {
    // (id ⊗ ε)(|Ω⟩⟨Ω|) = ½·Σ_ij |i⟩⟨j|_ref ⊗ ε(|i⟩⟨j|)_sys, so the reference
    // Choi is built by pushing the four matrix units through `closedForm`.
    for (const kind of NOISE_CHANNEL_KINDS) {
      for (const x of PARAMETERS) {
        const want = zeros(4)
        for (let i = 0; i < 2; i++) {
          for (let j = 0; j < 2; j++) {
            const unit = zeros(2)
            unit[i][j] = cx(1)
            const image = closedForm(kind, x, unit)
            for (let r = 0; r < 2; r++) {
              for (let c = 0; c < 2; c++) {
                // System is qubit 0 (bit 0), reference is qubit 1 (bit 1).
                want[r + 2 * i][c + 2 * j] = cscale(image[r][c], 0.5)
              }
            }
          }
        }
        const got = choiOfChannels([channelFor(kind, x)])
        expect(maxDiff(got, want), `J(${kind} at ${x})`).toBeLessThan(TOL)
      }
    }
  })
})

describe('composition laws, derived here and compared as maps', () => {
  const pairs: Array<[number, number]> = [
    [0, 0.3],
    [0.1, 0.4],
    [0.25, 0.25],
    [0.5, 0.5],
    [0.9, 0.05],
    [1, 0.4],
  ]

  it('amplitude damping composes as γ = γ₁ + γ₂ − γ₁γ₂', () => {
    // Derived, not quoted: the surviving excited population multiplies,
    // (1−γ₁)(1−γ₂), so 1 − γ = (1−γ₁)(1−γ₂).
    for (const [a, b] of pairs) {
      const composed = 1 - (1 - a) * (1 - b)
      const twice = choiOfChannels([
        amplitudeDampingChannel(a),
        amplitudeDampingChannel(b),
      ])
      const once = choiOfChannels([amplitudeDampingChannel(composed)])
      expect(maxDiff(twice, once), `γ = ${a}, ${b}`).toBeLessThan(TOL)
    }
  })

  it('phase damping composes as 1 − λ = (1−λ₁)(1−λ₂)', () => {
    // The coherence is carried by √(1−λ) and the factors multiply.
    for (const [a, b] of pairs) {
      const composed = 1 - (1 - a) * (1 - b)
      const twice = choiOfChannels([
        phaseDampingChannel(a),
        phaseDampingChannel(b),
      ])
      const once = choiOfChannels([phaseDampingChannel(composed)])
      expect(maxDiff(twice, once), `λ = ${a}, ${b}`).toBeLessThan(TOL)
    }
  })

  it('depolarising composes as 1 − p = (1−p₁)(1−p₂)', () => {
    for (const [a, b] of pairs) {
      const composed = 1 - (1 - a) * (1 - b)
      const twice = choiOfChannels([
        depolarizingChannel(a),
        depolarizingChannel(b),
      ])
      const once = choiOfChannels([depolarizingChannel(composed)])
      expect(maxDiff(twice, once), `p = ${a}, ${b}`).toBeLessThan(TOL)
    }
  })

  it('bit flip composes as p = p₁(1−p₂) + p₂(1−p₁)', () => {
    // Two independent flips leave the bit flipped only an odd number of times.
    for (const [a, b] of pairs) {
      const composed = a * (1 - b) + b * (1 - a)
      const twice = choiOfChannels([bitFlipChannel(a), bitFlipChannel(b)])
      const once = choiOfChannels([bitFlipChannel(composed)])
      expect(maxDiff(twice, once), `p = ${a}, ${b}`).toBeLessThan(TOL)
    }
  })

  it('phase flip at p and phase damping at λ agree when 1 − 2p = √(1−λ)', () => {
    // Both squash x and y and fix z; the module claims they are the same
    // channel under this substitution, which is a claim about the whole map.
    for (const lambda of [0, 0.1, 0.36, 0.75, 1]) {
      const p = (1 - Math.sqrt(1 - lambda)) / 2
      const fromFlip = choiOfChannels([phaseFlipChannel(p)])
      const fromDamping = choiOfChannels([phaseDampingChannel(lambda)])
      expect(maxDiff(fromFlip, fromDamping), `λ = ${lambda}`).toBeLessThan(TOL)
    }
  })

  it('the damping order does not matter for T1 and T2 together', () => {
    // Amplitude and phase damping commute as maps — both are diagonal in the
    // same Bloch basis — so `channelsForGate`'s fixed order is a choice about
    // the depolarising term only. If this ever fails, the order in the runner
    // has become load-bearing and the comment saying it is not is wrong.
    for (const [gamma, lambda] of pairs) {
      const forward = choiOfChannels([
        amplitudeDampingChannel(gamma),
        phaseDampingChannel(lambda),
      ])
      const backward = choiOfChannels([
        phaseDampingChannel(lambda),
        amplitudeDampingChannel(gamma),
      ])
      expect(maxDiff(forward, backward), `${gamma}, ${lambda}`).toBeLessThan(
        TOL
      )
    }
  })
})

describe('T1/T2 → channel parameters, derived from the Lindblad solution', () => {
  const cases: Array<[number, number, number]> = [
    [100_000, 120_000, 35],
    [100_000, 120_000, 300],
    [20_000, 15_000, 50],
    [20_000, 15_000, 400],
    [1e10, 1e9, 200_000],
    [50_000, 100_000, 1000], // T2 exactly at the 2·T1 bound: Tφ = ∞
  ]

  it('the population decays as e^(−t/T1) and the coherence as e^(−t/T2)', () => {
    // The whole point of the conversion. ρ₁₁(t) = e^{−t/T₁}ρ₁₁(0) and
    // ρ₀₁(t) = e^{−t/T₂}ρ₀₁(0) are the solutions of the Lindblad equation;
    // whatever γ and λ are, applying the two channels must reproduce them.
    const rho: Mat = [
      [cx(0.5), cx(0.5)],
      [cx(0.5), cx(0.5)],
    ]
    for (const [t1, t2, t] of cases) {
      const { gamma, lambda } = relaxationFor(t1, t2, t)
      let out = applyDense(operatorsOf(amplitudeDampingChannel(gamma)), rho)
      out = applyDense(operatorsOf(phaseDampingChannel(lambda)), out)
      expect(out[1][1].re, `ρ₁₁ for ${t1}/${t2}/${t}`).toBeCloseTo(
        0.5 * Math.exp(-t / t1),
        12
      )
      expect(out[0][1].re, `ρ₀₁ for ${t1}/${t2}/${t}`).toBeCloseTo(
        0.5 * Math.exp(-t / t2),
        12
      )
    }
  })

  it('splitting a duration in two gives the same map', () => {
    // γ = 1 − e^{−t/T₁} is the unique parameterisation under which composing
    // over consecutive intervals adds the times; the same holds for λ. Checked
    // as maps, so both rates are pinned at once.
    for (const [t1, t2, t] of cases) {
      const whole = relaxationFor(t1, t2, t)
      const half = relaxationFor(t1, t2, t / 2)
      const once = choiOfChannels([
        amplitudeDampingChannel(whole.gamma),
        phaseDampingChannel(whole.lambda),
      ])
      const twice = choiOfChannels([
        amplitudeDampingChannel(half.gamma),
        phaseDampingChannel(half.lambda),
        amplitudeDampingChannel(half.gamma),
        phaseDampingChannel(half.lambda),
      ])
      expect(maxDiff(once, twice), `${t1}/${t2}/${t}`).toBeLessThan(TOL)
    }
  })

  it('a zero duration costs nothing at all', () => {
    for (const [t1, t2] of cases) {
      const { gamma, lambda } = relaxationFor(t1, t2, 0)
      expect(gamma).toBe(0)
      expect(lambda).toBe(0)
    }
  })
})

describe('infidelity conversions, via the Kraus-trace formula', () => {
  /**
   * F_avg(ε) = (Σₖ |Tr Kₖ|² + d) / (d(d+1)) — the average fidelity of a channel
   * against the identity, as a function of the operators.
   *
   * This is a different derivation from `relaxationInfidelity`'s, which reads
   * the diagonal of the Bloch map. Two routes to one number is the point.
   */
  function averageInfidelity(operators: readonly Mat[], d: number): number {
    let sum = 0
    for (const k of operators) {
      const tr = matTrace(k)
      sum += tr.re * tr.re + tr.im * tr.im
    }
    return 1 - (sum + d) / (d * (d + 1))
  }

  /** Every product Lᵢ·Kⱼ — the Kraus set of the composed channel. */
  function composeOperators(second: Mat[], first: Mat[]): Mat[] {
    const out: Mat[] = []
    for (const l of second) {
      for (const k of first) out.push(matMul(l, k))
    }
    return out
  }

  it('relaxationInfidelity matches the trace formula', () => {
    for (const gamma of [0, 0.001, 0.01, 0.2, 0.5, 1]) {
      for (const lambda of [0, 0.001, 0.01, 0.3, 0.9, 1]) {
        const composed = composeOperators(
          operatorsOf(phaseDampingChannel(lambda)),
          operatorsOf(amplitudeDampingChannel(gamma))
        )
        expect(
          relaxationInfidelity(gamma, lambda),
          `γ = ${gamma}, λ = ${lambda}`
        ).toBeCloseTo(averageInfidelity(composed, 2), 12)
      }
    }
  })

  it('depolarizingFromGateError inverts the one-qubit infidelity', () => {
    for (const r of [0, 1e-6, 3e-4, 0.01, 0.1, 0.4, 0.5]) {
      const p = depolarizingFromGateError(r)
      const got = averageInfidelity(operatorsOf(depolarizingChannel(p)), 2)
      expect(got, `r = ${r}`).toBeCloseTo(r, 12)
    }
  })

  it('localDepolarizingFromPairError inverts the pair infidelity', () => {
    // The reference is D_p ⊗ D_p written out: sixteen 4×4 Kraus operators,
    // built as explicit tensor products of the one-qubit ones.
    for (const r of [0, 1e-6, 8e-3, 0.05, 0.2, 0.5, 0.75]) {
      const p = localDepolarizingFromPairError(r)
      const one = operatorsOf(depolarizingChannel(p))
      const pair: Mat[] = []
      for (const a of one) {
        for (const b of one) pair.push(tensor2(a, b))
      }
      expect(averageInfidelity(pair, 4), `r = ${r}`).toBeCloseTo(r, 10)
    }
  })

  /** A ⊗ B for two 2×2s, in D1's index order: row = 2·(wire 1) + (wire 0). */
  function tensor2(a: Mat, b: Mat): Mat {
    const out = zeros(4)
    for (let i = 0; i < 2; i++) {
      for (let j = 0; j < 2; j++) {
        for (let k = 0; k < 2; k++) {
          for (let l = 0; l < 2; l++) {
            out[2 * i + k][2 * j + l] = cmul(a[i][j], b[k][l])
          }
        }
      }
    }
    return out
  }

  it('every preset profile reproduces its reported gate errors', () => {
    // The end-to-end claim of `channelsForGate`: the channels it returns cost,
    // in total, what the profile says that gate costs. For arity 2 the channel
    // that has to reproduce the number is the one on the PAIR, so the per-wire
    // set is tensored with itself before the fidelity is taken.
    for (const profile of Object.values(NOISE_PROFILES)) {
      for (const arity of [1, 2] as const) {
        const channels = channelsForGate(profile, arity)
        let wire: Mat[] = [eye(2)]
        for (const channel of channels) {
          wire = composeOperators(operatorsOf(channel), wire)
        }
        const reported =
          arity === 1 ? profile.oneQubitGateError : profile.twoQubitGateError
        let got: number
        if (arity === 1) got = averageInfidelity(wire, 2)
        else {
          const pair: Mat[] = []
          for (const a of wire) {
            for (const b of wire) pair.push(tensor2(a, b))
          }
          got = averageInfidelity(pair, 4)
        }
        // The residual is subtracted in the depolarising parameter rather than
        // in the infidelity, so the agreement is first order in the error
        // rate. 5% of the reported number is the slack that buys.
        const slack = Math.max(1e-12, reported * 0.05)
        expect(
          Math.abs(got - reported),
          `${profile.id} arity ${arity}: got ${got}, reported ${reported}`
        ).toBeLessThan(slack)
      }
    }
  })

  it('the ideal profile produces no channels at all', () => {
    expect(channelsForGate(NOISE_PROFILES.ideal, 1)).toHaveLength(0)
    expect(channelsForGate(NOISE_PROFILES.ideal, 2)).toHaveLength(0)
    expect(channelsForIdle(NOISE_PROFILES.ideal, 1e6)).toHaveLength(0)
  })

  it('idling costs exactly the relaxation of its duration', () => {
    const profile = NOISE_PROFILES.superconducting
    const duration = 5_000
    const { gamma, lambda } = relaxationFor(
      profile.t1Ns,
      profile.t2Ns,
      duration
    )
    const got = choiOfChannels(channelsForIdle(profile, duration))
    const want = choiOfChannels([
      amplitudeDampingChannel(gamma),
      phaseDampingChannel(lambda),
    ])
    expect(maxDiff(got, want)).toBeLessThan(TOL)
  })
})

describe('a set that is not trace preserving is refused', () => {
  it('applyChannel throws and leaves ρ untouched', () => {
    const next = mulberry32(131)
    const before = randomDensity(4, next)
    const rho = densityOf(2, before)
    const broken: KrausChannel = {
      kind: 'depolarizing',
      parameter: 0.5,
      // √(p/2) instead of √(p/4) on the Paulis — the error the module's header
      // names, which leaves every other property of ρ intact.
      operators: [
        new Float64Array([
          Math.sqrt(1 - 3 * 0.125),
          0,
          0,
          0,
          0,
          0,
          Math.sqrt(1 - 3 * 0.125),
          0,
        ]),
        new Float64Array([0, 0, Math.sqrt(0.25), 0, Math.sqrt(0.25), 0, 0, 0]),
      ],
    }
    expect(() => {
      applyChannel(rho, broken, 0)
    }).toThrow(/trace preserving/i)
    expect(maxDiff(fromDensity(rho), before)).toBe(0)
  })
})

describe('readout error is a classical stochastic map', () => {
  /**
   * The full 2ⁿ × 2ⁿ confusion matrix, as the tensor product of the per-qubit
   * 2×2s — built here by looping over every (prepared, read) pair and
   * multiplying one factor per wire. O(4ⁿ) and obviously correct.
   */
  function confusionMatrix(
    qubits: number,
    errors: readonly ReadoutError[]
  ): number[][] {
    const dim = 1 << qubits
    const byQubit = new Map<number, ReadoutError>()
    for (const error of errors) byQubit.set(error.qubit, error)
    const out: number[][] = Array.from({ length: dim }, () =>
      new Array<number>(dim).fill(0)
    )
    for (let prepared = 0; prepared < dim; prepared++) {
      for (let read = 0; read < dim; read++) {
        let probability = 1
        for (let q = 0; q < qubits; q++) {
          const from = (prepared >> q) & 1
          const to = (read >> q) & 1
          const error = byQubit.get(q)
          const p0to1 = error === undefined ? 0 : error.p0to1
          const p1to0 = error === undefined ? 0 : error.p1to0
          if (from === 0) probability *= to === 0 ? 1 - p0to1 : p0to1
          else probability *= to === 1 ? 1 - p1to0 : p1to0
        }
        out[read][prepared] = probability
      }
    }
    return out
  }

  it('matches the brute-force tensor product of confusion matrices', () => {
    const next = mulberry32(211)
    for (let trial = 0; trial < 6; trial++) {
      const qubits = 3
      const dim = 1 << qubits
      const errors: ReadoutError[] = []
      for (let q = 0; q < qubits; q++) {
        errors.push({ qubit: q, p0to1: next() * 0.3, p1to0: next() * 0.3 })
      }
      const raw = new Float64Array(dim)
      let total = 0
      for (let i = 0; i < dim; i++) {
        raw[i] = next()
        total += raw[i]
      }
      for (let i = 0; i < dim; i++) raw[i] /= total

      const got = applyReadoutError(raw, errors)
      const matrix = confusionMatrix(qubits, errors)
      for (let read = 0; read < dim; read++) {
        let want = 0
        for (let prepared = 0; prepared < dim; prepared++) {
          want += matrix[read][prepared] * raw[prepared]
        }
        expect(got[read], `outcome ${read}`).toBeCloseTo(want, 12)
      }
      // A stochastic map conserves probability, which is the classical
      // statement of Σ K†K = I.
      let sum = 0
      for (let i = 0; i < dim; i++) sum += got[i]
      expect(sum).toBeCloseTo(1, 12)
    }
  })

  it('leaves the input distribution untouched', () => {
    const raw = new Float64Array([0.4, 0.1, 0.2, 0.3])
    const copy = raw.slice()
    applyReadoutError(raw, [{ qubit: 0, p0to1: 0.1, p1to0: 0.2 }])
    expect(Array.from(raw)).toEqual(Array.from(copy))
  })

  it('zero error rates are the exact identity', () => {
    const raw = new Float64Array([0.4, 0.1, 0.2, 0.3])
    const out = applyReadoutError(raw, [
      { qubit: 0, p0to1: 0, p1to0: 0 },
      { qubit: 1, p0to1: 0, p1to0: 0 },
    ])
    expect(Array.from(out)).toEqual(Array.from(raw))
  })
})

describe('the kernel on arbitrary complex Kraus sets', () => {
  /**
   * A random trace-preserving Kraus set with complex entries everywhere.
   *
   * BUILT FROM AN ISOMETRY, which is why it is trace preserving by
   * construction rather than by a coefficient anyone chose: stack the
   * operators into a 2m × 2 matrix V, and Σₖ Kₖ†Kₖ = V†V, so a V with
   * orthonormal columns gives a channel and nothing else has to be arranged.
   * Gram–Schmidt supplies the orthonormality.
   *
   * WHY IT MATTERS. Every channel of §3.3 is real apart from the Y of the
   * depolarising set, so the four minus signs that make `applyChannel`'s
   * second multiplication a dagger rather than a transpose are barely
   * exercised by the catalog. Here every entry has a phase, and the reference
   * multiplies K ρ K† with a dagger written from its own definition.
   */
  function randomChannel(count: number, next: () => number): KrausChannel {
    const rows = 2 * count
    const columns: Cx[][] = [[], []]
    for (let j = 0; j < 2; j++) {
      for (let i = 0; i < rows; i++) {
        columns[j].push(cx(next() * 2 - 1, next() * 2 - 1))
      }
    }
    // Gram–Schmidt on the two columns: ⟨u, v⟩ = Σ conj(u_i)·v_i.
    const dot = (u: Cx[], v: Cx[]): Cx => {
      let sum = cx(0)
      for (let i = 0; i < rows; i++) sum = cadd(sum, cmul(cconj(u[i]), v[i]))
      return sum
    }
    const normalize = (u: Cx[]): Cx[] => {
      const scale = 1 / Math.sqrt(dot(u, u).re)
      return u.map((value) => cscale(value, scale))
    }
    const first = normalize(columns[0])
    const overlap = dot(first, columns[1])
    const second = normalize(
      columns[1].map((value, i) => ({
        re: value.re - (overlap.re * first[i].re - overlap.im * first[i].im),
        im: value.im - (overlap.re * first[i].im + overlap.im * first[i].re),
      }))
    )

    const operators: Float64Array[] = []
    for (let k = 0; k < count; k++) {
      const a = first[2 * k]
      const b = second[2 * k]
      const c = first[2 * k + 1]
      const d = second[2 * k + 1]
      operators.push(
        new Float64Array([a.re, a.im, b.re, b.im, c.re, c.im, d.re, d.im])
      )
    }
    return { kind: 'depolarizing', parameter: 0, operators }
  }

  it('is trace preserving by construction', () => {
    const next = mulberry32(313)
    for (let trial = 0; trial < 20; trial++) {
      const channel = randomChannel(2 + (trial % 3), next)
      let sum = zeros(2)
      for (const k of operatorsOf(channel)) {
        sum = matAdd(sum, matMul(matDagger(k), k))
      }
      expect(maxDiff(sum, eye(2))).toBeLessThan(TOL)
    }
  })

  it('matches the dense reference on 3- and 4-qubit registers', () => {
    const next = mulberry32(317)
    for (const qubits of [3, 4]) {
      const dim = 1 << qubits
      for (let trial = 0; trial < 3; trial++) {
        const channel = randomChannel(2 + trial, next)
        for (let target = 0; target < qubits; target++) {
          const before = randomDensity(dim, next)
          const rho = densityOf(qubits, before)
          applyChannel(rho, channel, target)
          const got = fromDensity(rho)
          const lifted = operatorsOf(channel).map((k) =>
            liftOperator(k, qubits, target)
          )
          expect(
            maxDiff(got, applyDense(lifted, before)),
            `${qubits} qubits, wire ${target}`
          ).toBeLessThan(TOL)
          expectValidDensity(got, `${qubits} qubits, wire ${target}`)
        }
      }
    }
  })

  it('is a linear map, on matrices that are not states', () => {
    // A channel is linear, so ε(A + 3B) = ε(A) + 3·ε(B) for any A and B — no
    // trace, no positivity, no Hermiticity required. A kernel that quietly
    // symmetrised or renormalised would pass every test above and fail this.
    const next = mulberry32(331)
    const channel = randomChannel(3, next)
    const a = randomDensity(4, next)
    const b = randomDensity(4, next)
    const mixed = matAdd(a, matScale(b, 3))

    const run = (m: Mat): Mat => {
      const rho = densityOf(2, m)
      applyChannel(rho, channel, 1)
      return fromDensity(rho)
    }
    const want = matAdd(run(a), matScale(run(b), 3))
    expect(maxDiff(run(mixed), want)).toBeLessThan(TOL)
  })
})

describe('reset is amplitude damping at γ = 1, on one wire only', () => {
  /** The index with bit `target` removed — "the rest" of the register. */
  function compress(index: number, target: number): number {
    const low = index & ((1 << target) - 1)
    const high = index >> (target + 1)
    return (high << target) | low
  }

  /** Tr over qubit `target`, written from the definition. */
  function traceOutWire(m: Mat, target: number): Mat {
    const dim = m.length
    const out = zeros(dim / 2)
    for (let r = 0; r < dim; r++) {
      for (let c = 0; c < dim; c++) {
        if (((r >> target) & 1) !== ((c >> target) & 1)) continue
        const i = compress(r, target)
        const j = compress(c, target)
        out[i][j] = cadd(out[i][j], m[r][c])
      }
    }
    return out
  }

  it('sends wire q to |0⟩ and leaves the rest as the reduced state', () => {
    // The claim in `runner.resetDensity`. If amplitude damping at γ = 1 acted
    // on more than its wire, or kept the wire correlated with the rest instead
    // of discarding it, this is where it would show: the answer must factor.
    const next = mulberry32(401)
    const qubits = 3
    const dim = 1 << qubits
    for (let target = 0; target < qubits; target++) {
      const before = randomDensity(dim, next)
      const rho = densityOf(qubits, before)
      applyChannel(rho, amplitudeDampingChannel(1), target)
      const got = fromDensity(rho)

      const rest = traceOutWire(before, target)
      // |0⟩⟨0| on the wire ⊗ the reduced state on the rest, written back into
      // full indices so the comparison never leaves D1's ordering.
      const want = zeros(dim)
      for (let r = 0; r < dim; r++) {
        for (let c = 0; c < dim; c++) {
          if (((r >> target) & 1) !== 0) continue
          if (((c >> target) & 1) !== 0) continue
          want[r][c] = rest[compress(r, target)][compress(c, target)]
        }
      }
      expect(maxDiff(got, want), `wire ${target}`).toBeLessThan(TOL)
      expectValidDensity(got, `wire ${target}`)
    }
  })
})

describe('the trajectory weights are the ones the unravelling needs', () => {
  it('pₖ = ‖Kₖψ‖² and Σₖ Kₖ|ψ⟩⟨ψ|Kₖ† is the channel', () => {
    // Checked without sampling anything: the identity that makes the average
    // of trajectories equal ρ is algebraic, and a wrong weight is a reweighted
    // ensemble that is still normalised and still the wrong physics.
    const next = mulberry32(499)
    const qubits = 2
    const dim = 1 << qubits
    for (const kind of KINDS) {
      for (const x of [0.1, 0.4, 0.9]) {
        const channel = channelFor(kind, x)
        const state = stateAlloc(qubits)
        let norm = 0
        for (let i = 0; i < dim; i++) {
          state.re[i] = next() * 2 - 1
          state.im[i] = next() * 2 - 1
          norm += state.re[i] * state.re[i] + state.im[i] * state.im[i]
        }
        const scale = 1 / Math.sqrt(norm)
        for (let i = 0; i < dim; i++) {
          state.re[i] *= scale
          state.im[i] *= scale
        }
        // ρ = |ψ⟩⟨ψ|, built here rather than by `densityFromStatevector`.
        const psi = Array.from({ length: dim }, (_, i) =>
          cx(state.re[i], state.im[i])
        )
        const rho = zeros(dim)
        for (let r = 0; r < dim; r++) {
          for (let c = 0; c < dim; c++) {
            rho[r][c] = cmul(psi[r], cconj(psi[c]))
          }
        }

        for (let target = 0; target < qubits; target++) {
          const weights = krausWeights(state, channel, target)
          const lifted = operatorsOf(channel).map((k) =>
            liftOperator(k, qubits, target)
          )
          expect(lifted.length).toBe(weights.length)
          let total = 0
          lifted.forEach((k, index) => {
            // ‖Kψ‖², from the vector rather than from the matrix.
            let mass = 0
            for (let r = 0; r < dim; r++) {
              let sum = cx(0)
              for (let c = 0; c < dim; c++) {
                sum = cadd(sum, cmul(k[r][c], psi[c]))
              }
              mass += sum.re * sum.re + sum.im * sum.im
            }
            expect(
              weights[index],
              `${kind} at ${x}, branch ${index}`
            ).toBeCloseTo(mass, 12)
            total += mass
          })
          expect(total, `${kind} at ${x}`).toBeCloseTo(1, 12)

          // And the ensemble those weights define is the channel itself.
          const density = densityOf(qubits, rho)
          applyChannel(density, channel, target)
          expect(
            maxDiff(fromDensity(density), applyDense(lifted, rho))
          ).toBeLessThan(TOL)
        }
      }
    }
  })
})

describe('the depolarising stand-in over its whole accepted domain', () => {
  /** F_avg = (Σₖ |Tr Kₖ|² + d)/(d(d+1)), again. */
  function infidelityOf(operators: readonly Mat[], d: number): number {
    let sum = 0
    for (const k of operators) {
      const tr = matTrace(k)
      sum += tr.re * tr.re + tr.im * tr.im
    }
    return 1 - (sum + d) / (d * (d + 1))
  }

  /** D_p ⊗ D_p written out: sixteen 4×4 Kraus operators, explicitly tensored. */
  function pairOperators(p: number): Mat[] {
    const one = operatorsOf(depolarizingChannel(p))
    const pair: Mat[] = []
    for (const a of one) {
      for (const b of one) {
        const out = zeros(4)
        for (let i = 0; i < 2; i++) {
          for (let j = 0; j < 2; j++) {
            for (let k = 0; k < 2; k++) {
              for (let l = 0; l < 2; l++) {
                out[2 * i + k][2 * j + l] = cmul(a[i][j], b[k][l])
              }
            }
          }
        }
        pair.push(out)
      }
    }
    return pair
  }

  it('depolarizingFromGateError reproduces every rate it accepts', () => {
    /*
     * The function's contract is "the depolarising p that reproduces it", so
     * the property is an equality over its whole domain and a refusal outside
     * it. There is no third option: r = p/2 wants p > 1 above r = 1/2, a p
     * above 1 is not a probability, and clamping it to 1 returns a channel
     * whose infidelity is 1/2 whatever was reported — the reported number
     * silently understated by up to a factor of two, in a module whose header
     * is written against exactly that.
     *
     * THE CONVENTION, so nobody re-widens the domain: the ceiling is the r at
     * which p reaches 1, which for a one-qubit depolarising channel is 1/2 and
     * not 1. §3.3's custom-profile panel bounds the field there.
     */
    for (const r of [0, 0.1, 0.4, 0.5]) {
      const p = depolarizingFromGateError(r)
      expect(p, `p is a probability at r = ${r}`).toBeLessThanOrEqual(1)
      expect(
        infidelityOf(operatorsOf(depolarizingChannel(p)), 2),
        `reported r = ${r}, p = ${p}`
      ).toBeCloseTo(r, 9)
    }
    // And what it cannot reproduce it refuses, naming the field so the panel
    // can mark the input rather than reporting a bug in the app.
    for (const r of [0.5 + Number.EPSILON, 0.55, 0.6, 0.8, 1]) {
      expect(() => depolarizingFromGateError(r), `r = ${r}`).toThrow(
        NoiseProfileError
      )
    }
  })

  it('localDepolarizingFromPairError reproduces every rate it accepts', () => {
    /*
     * Same property, and the same convention one dimension up. Two thresholds
     * live in p = 4(1 − √(1 − 5r/4))/3 and they are different numbers: the
     * square root goes imaginary at r = 4/5, but p reaches 1 at r = 3/4, which
     * is exactly the average infidelity of the maximally mixing pair channel
     * D_1 ⊗ D_1. The guard belongs at 3/4 — where the *model* ends — because
     * (3/4, 4/5] was accepted, clamped, and modelled as 3/4: neither
     * reproduced nor refused.
     *
     * The oracle is D_p ⊗ D_p written out as sixteen explicit 4×4 Kraus tensor
     * products with F_avg = (Σ |Tr K|² + 4)/20.
     */
    for (const r of [0, 0.05, 0.5, 0.7, 0.75]) {
      const p = localDepolarizingFromPairError(r)
      expect(p, `p is a probability at r = ${r}`).toBeLessThanOrEqual(1)
      expect(
        infidelityOf(pairOperators(p), 4),
        `reported r = ${r}, p = ${p}`
      ).toBeCloseTo(r, 9)
    }
    for (const r of [0.76, 0.78, 0.8, 0.9, 1]) {
      expect(() => localDepolarizingFromPairError(r), `r = ${r}`).toThrow(
        NoiseProfileError
      )
    }
  })

  it('the published ceilings are where p reaches 1, in both dimensions', () => {
    // The constants the panel bounds its inputs with, checked against the
    // channels rather than against the formulas that produced them.
    expect(depolarizingFromGateError(MAX_ONE_QUBIT_GATE_ERROR)).toBeCloseTo(
      1,
      12
    )
    expect(
      localDepolarizingFromPairError(MAX_TWO_QUBIT_GATE_ERROR)
    ).toBeCloseTo(1, 12)
    // …and those saturated channels really do cost what the ceilings claim.
    expect(infidelityOf(operatorsOf(depolarizingChannel(1)), 2)).toBeCloseTo(
      MAX_ONE_QUBIT_GATE_ERROR,
      12
    )
    expect(infidelityOf(pairOperators(1), 4)).toBeCloseTo(
      MAX_TWO_QUBIT_GATE_ERROR,
      12
    )
  })
})
