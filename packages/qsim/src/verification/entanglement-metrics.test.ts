/**
 * INDEPENDENT ADVERSARIAL VERIFICATION — ENTROPY, CONCURRENCE, FIDELITY.
 *
 * Nothing in this file is derived from `metrics.ts` or from `eigen.ts`, and in
 * particular NOTHING HERE COMPUTES AN EIGENVALUE. That is the point. An
 * eigensolver checked against itself is checked against nothing, and the
 * numbers this milestone produces have no smell: a von Neumann entropy of
 * 0.94 looks exactly as reasonable as the 0.9183 it should have been, and a
 * concurrence of 0.61 looks exactly as reasonable as 2/3.
 *
 * So every oracle below reaches the same number by a route with no spectrum
 * in it:
 *
 *   1. **The partial trace, from the definition.** Nested loops over the
 *      configurations of the environment, with the traced index woven back in
 *      by explicit shifting into a nested-array complex matrix. It shares no
 *      stride, no submask walk and no accumulator with the implementation.
 *
 *   2. **Entropy, from Shannon.** A spectrum is not observable but it is
 *      *constructible*: draw probabilities p, draw a unitary U by Gram–Schmidt
 *      on random vectors, and U·diag(p)·U† is a density matrix whose
 *      eigenvalues are p by construction. Its von Neumann entropy must equal
 *      the plain Shannon entropy of p, summed in a loop. This turns the whole
 *      of `eigen.ts` into something falsifiable by arithmetic a reader can
 *      check, on arbitrary spectra rather than on the handful anyone can
 *      write down.
 *
 *   3. **Concurrence, from the amplitudes.** For a pure pair,
 *      C = 2·|ψ₀₀ψ₁₁ − ψ₀₁ψ₁₀| — four multiplications, no matrices at all.
 *      And separately C = |⟨ψ|(Y⊗Y)|ψ*⟩| with Y⊗Y assembled here by an
 *      explicit Kronecker product over little-endian bit indices, which is
 *      what pins the sign pattern `metrics.ts` hard-codes.
 *
 *   4. **Concurrence, from the X-state closed form.** For the family with
 *      only a diagonal and an antidiagonal,
 *      C = 2·max(0, |ρ₀₃| − √(ρ₁₁ρ₂₂), |ρ₁₂| − √(ρ₀₀ρ₃₃)). Mixed, not pure,
 *      random, and still closed-form: the case that catches a Wootters
 *      construction which happens to be right on pure states.
 *
 *   5. **Structural identities that no implementation can satisfy by
 *      accident.** S(A) = S(Ā) across every bipartition of a pure state,
 *      subadditivity, Araki–Lieb, zero concurrence for every mixture of
 *      product states, and fidelity's unitary invariance. These are where a
 *      partial trace that weaves one bit wrongly dies: it stays Hermitian,
 *      keeps trace 1, and disagrees with its own complement.
 */

import fc from 'fast-check'
import { describe, expect, it } from 'vitest'

import type { DensityMatrix } from '../density.js'
import {
  concurrence,
  concurrenceOf,
  densityFidelity,
  densityStateFidelity,
  distributionFidelity,
  partialTrace,
  partialTraceOfDensity,
  stateFidelity,
  subsystemEntropy,
  vonNeumannEntropy,
} from '../metrics.js'
import { createRng, type Rng } from '../rng.js'
import type { Statevector } from '../statevector.js'

/** D6 again: 1e-10, as digits for `toBeCloseTo`. */
const DIGITS = 10

interface Cx {
  readonly re: number
  readonly im: number
}

const ZERO: Cx = { re: 0, im: 0 }
const add = (a: Cx, b: Cx): Cx => ({ re: a.re + b.re, im: a.im + b.im })
const sub = (a: Cx, b: Cx): Cx => ({ re: a.re - b.re, im: a.im - b.im })
const conj = (a: Cx): Cx => ({ re: a.re, im: -a.im })
const mul = (a: Cx, b: Cx): Cx => ({
  re: a.re * b.re - a.im * b.im,
  im: a.re * b.im + a.im * b.re,
})
const abs = (a: Cx): number => Math.hypot(a.re, a.im)

/** A complex matrix as nested arrays. Slow on purpose. */
type Matrix = readonly (readonly Cx[])[]

function zeros(dim: number): Cx[][] {
  return Array.from({ length: dim }, () =>
    Array.from<Cx>({ length: dim }).fill(ZERO)
  )
}

/* ────────────────────────── fixtures, built here ────────────────────────── */

/**
 * A normalised random state, built without touching the engine.
 *
 * The peak pass is the same one `reduced-density.test.ts` argues for at
 * length, and for the same reason: `fc.double` samples the whole exponent
 * range, an ordinary draw is of order 1e-161, and the square of that is
 * subnormal. Dividing by the largest component before anything is squared is
 * what makes the fixture actually normalised rather than approximately so.
 */
function stateFrom(qubits: number, parts: readonly number[]): Statevector {
  const size = 1 << qubits
  const re = new Float64Array(size)
  const im = new Float64Array(size)

  let peak = 0
  for (let i = 0; i < size; i++) {
    re[i] = parts[2 * i]
    im[i] = parts[2 * i + 1]
    peak = Math.max(peak, Math.abs(re[i]), Math.abs(im[i]))
  }
  if (peak === 0) {
    re[0] = 1
    return { qubits, size, re, im }
  }

  let sum = 0
  for (let i = 0; i < size; i++) {
    re[i] /= peak
    im[i] /= peak
    sum += re[i] * re[i] + im[i] * im[i]
  }
  const scale = 1 / Math.sqrt(sum)
  for (let i = 0; i < size; i++) {
    re[i] *= scale
    im[i] *= scale
  }
  return { qubits, size, re, im }
}

const component = fc.double({
  min: -1,
  max: 1,
  noNaN: true,
  noDefaultInfinity: true,
})

/** Runs `check` over random normalised states of `qubits` wires. */
function forRandomStates(
  qubits: number,
  runs: number,
  check: (state: Statevector) => void
): void {
  fc.assert(
    fc.property(
      fc.array(component, { minLength: 2 << qubits, maxLength: 2 << qubits }),
      (parts) => {
        check(stateFrom(qubits, parts))
      }
    ),
    { numRuns: runs }
  )
}

/**
 * A unitary matrix, by modified Gram–Schmidt on random complex vectors.
 *
 * Deliberately not `eigenHermitian`'s eigenvectors, which would be the easy
 * way to get an orthonormal basis and would make every test below circular.
 * Gram–Schmidt is arithmetic on the vectors themselves; the tests assert its
 * output is unitary before relying on it.
 *
 * Returned as columns: `columns[j][i]` is U_ij.
 */
function randomUnitary(dim: number, rng: Rng): Cx[][] {
  const columns: Cx[][] = []
  for (let j = 0; j < dim; j++) {
    let vector: Cx[] = Array.from({ length: dim }, () => ({
      re: rng.next() * 2 - 1,
      im: rng.next() * 2 - 1,
    }))
    // Twice, because one pass of Gram–Schmidt loses orthogonality when the
    // draw happens to be nearly dependent, and "twice is enough" is the
    // classical result about it.
    for (let pass = 0; pass < 2; pass++) {
      for (const basis of columns) {
        let dot = ZERO
        for (let i = 0; i < dim; i++) {
          dot = add(dot, mul(conj(basis[i]), vector[i]))
        }
        vector = vector.map((entry, i) => sub(entry, mul(dot, basis[i])))
      }
    }
    let norm = 0
    for (const entry of vector)
      norm += entry.re * entry.re + entry.im * entry.im
    const scale = 1 / Math.sqrt(norm)
    columns.push(
      vector.map((entry) => ({
        re: entry.re * scale,
        im: entry.im * scale,
      }))
    )
  }
  return columns
}

/** U·diag(p)·U†, a density matrix whose spectrum is `p` by construction. */
function spectralState(
  p: readonly number[],
  columns: readonly Cx[][]
): DensityMatrix {
  const dim = p.length
  const re = new Float64Array(dim * dim)
  const im = new Float64Array(dim * dim)
  for (let i = 0; i < dim; i++) {
    for (let j = 0; j < dim; j++) {
      let sum = ZERO
      for (let k = 0; k < dim; k++) {
        const term = mul(columns[k][i], conj(columns[k][j]))
        sum = add(sum, { re: term.re * p[k], im: term.im * p[k] })
      }
      re[i * dim + j] = sum.re
      im[i * dim + j] = sum.im
    }
  }
  return { qubits: Math.round(Math.log2(dim)), dim, size: dim * dim, re, im }
}

/** −Σ p log₂ p, in a loop, with 0 log 0 = 0. */
function shannon(p: readonly number[]): number {
  let bits = 0
  for (const value of p) {
    if (value > 0) bits -= value * Math.log2(value)
  }
  return bits
}

/** `n` random probabilities summing to 1. */
function randomDistribution(n: number, rng: Rng): number[] {
  const out = Array.from({ length: n }, () => rng.next() + 1e-3)
  const total = out.reduce((sum, value) => sum + value, 0)
  return out.map((value) => value / total)
}

/* ───────────────────────── oracle: the partial trace ────────────────────── */

/** Every qubit of `[0, n)` that `keep` does not name, ascending. */
function complement(keep: readonly number[], qubits: number): number[] {
  const rest: number[] = []
  for (let qubit = 0; qubit < qubits; qubit++) {
    if (!keep.includes(qubit)) rest.push(qubit)
  }
  return rest
}

/**
 * The statevector index whose kept wires read `pattern` and whose remaining
 * wires read `env`, each bit placed by an explicit shift.
 *
 * The implementation never forms this number — it tabulates one half and
 * walks submasks for the other — so an error in its bit placement cannot be
 * an error in this one.
 */
function weave(
  keep: readonly number[],
  pattern: number,
  rest: readonly number[],
  env: number
): number {
  let index = 0
  for (let j = 0; j < keep.length; j++) {
    if ((pattern >> j) & 1) index |= 1 << keep[j]
  }
  for (let j = 0; j < rest.length; j++) {
    if ((env >> j) & 1) index |= 1 << rest[j]
  }
  return index
}

/** ρ_S = Σ_env ψ(a,env)·conj(ψ(b,env)), from the definition. */
function oracleTrace(state: Statevector, keep: readonly number[]): Matrix {
  const rest = complement(keep, state.qubits)
  const dim = 1 << keep.length
  const out = zeros(dim)
  for (let env = 0; env < 1 << rest.length; env++) {
    for (let a = 0; a < dim; a++) {
      const ia = weave(keep, a, rest, env)
      const psiA: Cx = { re: state.re[ia], im: state.im[ia] }
      for (let b = 0; b < dim; b++) {
        const ib = weave(keep, b, rest, env)
        const psiB: Cx = { re: state.re[ib], im: state.im[ib] }
        out[a][b] = add(out[a][b], mul(psiA, conj(psiB)))
      }
    }
  }
  return out
}

/** The same, starting from ρ: a sum over the diagonal of the traced factor. */
function oracleTraceOfDensity(
  rho: DensityMatrix,
  keep: readonly number[]
): Matrix {
  const rest = complement(keep, rho.qubits)
  const dim = 1 << keep.length
  const out = zeros(dim)
  for (let env = 0; env < 1 << rest.length; env++) {
    for (let a = 0; a < dim; a++) {
      const ia = weave(keep, a, rest, env)
      for (let b = 0; b < dim; b++) {
        const ib = weave(keep, b, rest, env)
        const at = ia * rho.dim + ib
        out[a][b] = add(out[a][b], { re: rho.re[at], im: rho.im[at] })
      }
    }
  }
  return out
}

function expectMatchesOracle(
  actual: DensityMatrix,
  oracle: Matrix,
  label: string
): void {
  for (let a = 0; a < actual.dim; a++) {
    for (let b = 0; b < actual.dim; b++) {
      const at = a * actual.dim + b
      expect(actual.re[at], `${label} re[${a}][${b}]`).toBeCloseTo(
        oracle[a][b].re,
        DIGITS
      )
      expect(actual.im[at], `${label} im[${a}][${b}]`).toBeCloseTo(
        oracle[a][b].im,
        DIGITS
      )
    }
  }
}

/* ─────────────────────── oracle: Y⊗Y and concurrence ────────────────────── */

/**
 * Y⊗Y, assembled by an explicit Kronecker product over little-endian bit
 * indices (D1): entry (a, c) is Y[a₁][c₁]·Y[a₀][c₀] with bit 1 the *high*
 * qubit of the pair.
 *
 * `metrics.ts` hard-codes the resulting sign pattern and argues that the
 * qubit ordering cannot reach it. This is that argument made falsifiable —
 * the matrix is built the long way here, with the ordering explicit, and the
 * concurrence tests below run through it.
 */
function kroneckerYY(): Matrix {
  const y: Matrix = [
    [ZERO, { re: 0, im: -1 }],
    [{ re: 0, im: 1 }, ZERO],
  ]
  const out = zeros(4)
  for (let a = 0; a < 4; a++) {
    for (let c = 0; c < 4; c++) {
      out[a][c] = mul(y[(a >> 1) & 1][(c >> 1) & 1], y[a & 1][c & 1])
    }
  }
  return out
}

const YY = kroneckerYY()

/** C = |⟨ψ|(Y⊗Y)|ψ*⟩| for a two-qubit pure state, through the built matrix. */
function pureConcurrenceViaYY(state: Statevector): number {
  let sum = ZERO
  for (let a = 0; a < 4; a++) {
    const left = conj({ re: state.re[a], im: state.im[a] })
    for (let b = 0; b < 4; b++) {
      const right = conj({ re: state.re[b], im: state.im[b] })
      sum = add(sum, mul(mul(left, YY[a][b]), right))
    }
  }
  return abs(sum)
}

/** C = 2·|ψ₀₀ψ₁₁ − ψ₀₁ψ₁₀| — four multiplications and no matrix at all. */
function pureConcurrenceViaAmplitudes(state: Statevector): number {
  const a: Cx = { re: state.re[0], im: state.im[0] }
  const b: Cx = { re: state.re[1], im: state.im[1] }
  const c: Cx = { re: state.re[2], im: state.im[2] }
  const d: Cx = { re: state.re[3], im: state.im[3] }
  return 2 * abs(sub(mul(a, d), mul(b, c)))
}

/**
 * A random X-state: a diagonal, an antidiagonal, and zeros everywhere else.
 *
 * The off-diagonal magnitudes are drawn as a fraction of the bound
 * positivity imposes (|ρ₀₃|² ≤ ρ₀₀ρ₃₃), so every draw is a genuine density
 * matrix and the family sweeps from diagonal (separable) to maximally
 * entangled.
 */
function randomXState(rng: Rng): DensityMatrix {
  const [a, b, c, d] = randomDistribution(4, rng)
  const wMag = rng.next() * Math.sqrt(a * d)
  const zMag = rng.next() * Math.sqrt(b * c)
  const wPhase = rng.next() * 2 * Math.PI
  const zPhase = rng.next() * 2 * Math.PI
  const re = new Float64Array(16)
  const im = new Float64Array(16)
  re[0] = a
  re[5] = b
  re[10] = c
  re[15] = d
  re[3] = wMag * Math.cos(wPhase)
  im[3] = wMag * Math.sin(wPhase)
  re[12] = re[3]
  im[12] = -im[3]
  re[6] = zMag * Math.cos(zPhase)
  im[6] = zMag * Math.sin(zPhase)
  re[9] = re[6]
  im[9] = -im[6]
  return { qubits: 2, dim: 4, size: 16, re, im }
}

/** The X-state closed form: C = 2·max(0, |ρ₀₃| − √(ρ₁₁ρ₂₂), |ρ₁₂| − √(ρ₀₀ρ₃₃)). */
function xStateConcurrence(rho: DensityMatrix): number {
  const w = Math.hypot(rho.re[3], rho.im[3])
  const z = Math.hypot(rho.re[6], rho.im[6])
  return (
    2 *
    Math.max(
      0,
      w - Math.sqrt(rho.re[5] * rho.re[10]),
      z - Math.sqrt(rho.re[0] * rho.re[15])
    )
  )
}

/* ═══════════════ 1. the partial trace against the definition ═════════════ */

describe('the partial trace agrees with the definition', () => {
  it('matches the oracle entry for entry, on every subsystem of 2 to 4 qubits', () => {
    for (const qubits of [2, 3, 4]) {
      const subsets: number[][] = []
      for (let mask = 1; mask < 1 << qubits; mask++) {
        const keep: number[] = []
        for (let q = 0; q < qubits; q++) if ((mask >> q) & 1) keep.push(q)
        subsets.push(keep)
      }
      forRandomStates(qubits, 20, (state) => {
        for (const keep of subsets) {
          expectMatchesOracle(
            partialTrace(state, keep),
            oracleTrace(state, keep),
            `${qubits}q keep ${keep.join(',')}`
          )
        }
      })
    }
  })

  it('matches the oracle when the kept qubits are named out of order', () => {
    // The ordering of `keep` relabels the subsystem, which the oracle does
    // too — by the same explicit shifts. An implementation that sorted `keep`
    // silently would agree with the oracle on ascending lists and disagree
    // here, on nothing else.
    forRandomStates(3, 40, (state) => {
      for (const keep of [
        [2, 0],
        [1, 2],
        [2, 1, 0],
        [0, 2, 1],
      ]) {
        expectMatchesOracle(
          partialTrace(state, keep),
          oracleTrace(state, keep),
          `keep ${keep.join(',')}`
        )
      }
    })
  })

  it('matches the oracle starting from a mixed state', () => {
    const rng = createRng(4242)
    for (let trial = 0; trial < 12; trial++) {
      const columns = randomUnitary(8, rng)
      const rho = spectralState(randomDistribution(8, rng), columns)
      for (const keep of [[0], [1], [2], [0, 2], [1, 0], [2, 1, 0]]) {
        expectMatchesOracle(
          partialTraceOfDensity(rho, keep),
          oracleTraceOfDensity(rho, keep),
          `trial ${trial} keep ${keep.join(',')}`
        )
      }
    }
  })
})

/* ══════════ 2. entropy against Shannon, on constructed spectra ═══════════ */

describe('von Neumann entropy against a Shannon oracle', () => {
  it('builds unitaries that are unitary, or the rest of this file means nothing', () => {
    const rng = createRng(7)
    for (const dim of [2, 4, 8]) {
      const columns = randomUnitary(dim, rng)
      for (let a = 0; a < dim; a++) {
        for (let b = 0; b < dim; b++) {
          let dot = ZERO
          for (let i = 0; i < dim; i++) {
            dot = add(dot, mul(conj(columns[a][i]), columns[b][i]))
          }
          expect(dot.re, `⟨${a}|${b}⟩`).toBeCloseTo(a === b ? 1 : 0, 12)
          expect(dot.im, `⟨${a}|${b}⟩`).toBeCloseTo(0, 12)
        }
      }
    }
  })

  it('returns the Shannon entropy of a spectrum it was handed', () => {
    /*
     * THE CENTRAL TEST OF THIS FILE. The spectrum of U·diag(p)·U† is p, for
     * any unitary U, and that is a fact about the construction rather than
     * about anything in the package. So the von Neumann entropy — which the
     * module obtains by decomposing a matrix whose entries are all different
     * from p and from each other — has to come back as −Σ p log₂ p, summed
     * here in four lines. Any coefficient error, any wrong logarithm base,
     * any mishandled degeneracy, and the two disagree.
     */
    const rng = createRng(99)
    for (const dim of [2, 4, 8]) {
      for (let trial = 0; trial < 15; trial++) {
        const p = randomDistribution(dim, rng)
        const rho = spectralState(p, randomUnitary(dim, rng))
        expect(vonNeumannEntropy(rho), `dim ${dim} trial ${trial}`).toBeCloseTo(
          shannon(p),
          DIGITS
        )
      }
    }
  })

  it('handles a spectrum with exact zeros in it', () => {
    // Rank-deficient by construction: 0·log 0 = 0 is the convention under
    // test, and a NaN here would be the most obvious possible failure — which
    // is exactly why it deserves a case of its own rather than being left to
    // chance in the random draws above.
    const rng = createRng(1234)
    for (const p of [
      [1, 0, 0, 0],
      [0.5, 0.5, 0, 0],
      [0.25, 0.25, 0.25, 0.25],
      [0.7, 0.3, 0, 0],
    ]) {
      const rho = spectralState(p, randomUnitary(4, rng))
      expect(vonNeumannEntropy(rho), p.join(',')).toBeCloseTo(
        shannon(p),
        DIGITS
      )
    }
  })

  it('gives a pure state exactly zero, not a small positive number', () => {
    const rng = createRng(5150)
    for (let trial = 0; trial < 10; trial++) {
      const rho = spectralState([1, 0, 0, 0], randomUnitary(4, rng))
      expect(vonNeumannEntropy(rho)).toBeCloseTo(0, DIGITS)
      expect(vonNeumannEntropy(rho)).toBeGreaterThanOrEqual(0)
    }
  })
})

/* ═══════════ 3. entropy identities no implementation fakes ═══════════════ */

describe('entropy identities on random states', () => {
  it('gives a bipartition of a pure state the same entropy on both sides', () => {
    // S(A) = S(Ā). Two different partial traces, of different sizes, over
    // different environments — and one number. A single mis-woven bit breaks
    // this while leaving every ρ Hermitian, positive and unit-trace.
    forRandomStates(4, 40, (state) => {
      for (let mask = 1; mask < 15; mask++) {
        const keep: number[] = []
        const rest: number[] = []
        for (let q = 0; q < 4; q++) ((mask >> q) & 1 ? keep : rest).push(q)
        expect(subsystemEntropy(state, keep), `mask ${mask}`).toBeCloseTo(
          subsystemEntropy(state, rest),
          DIGITS
        )
      }
    })
  })

  it('is subadditive: S(AB) ≤ S(A) + S(B)', () => {
    forRandomStates(4, 40, (state) => {
      const a = [0, 1]
      const b = [2, 3]
      const joint = subsystemEntropy(state, [...a, ...b])
      const separate = subsystemEntropy(state, a) + subsystemEntropy(state, b)
      // The slack is 1e-8 rather than D6's 1e-10 because this is a one-sided
      // bound, not an equality: a genuine violation of subadditivity is a
      // defect of order 0.1, and a bound that goes red on rounding noise
      // would be a bound nobody trusts.
      expect(joint).toBeLessThanOrEqual(separate + 1e-8)
    })
  })

  it('satisfies Araki–Lieb: |S(A) − S(B)| ≤ S(AB)', () => {
    forRandomStates(4, 40, (state) => {
      const first = subsystemEntropy(state, [0])
      const second = subsystemEntropy(state, [1, 2])
      const joint = subsystemEntropy(state, [0, 1, 2])
      expect(Math.abs(first - second)).toBeLessThanOrEqual(joint + 1e-8)
    })
  })

  it('stays within [0, log₂ dim] for every subsystem', () => {
    forRandomStates(3, 60, (state) => {
      for (const keep of [[0], [1], [2], [0, 1], [1, 2], [0, 1, 2]]) {
        const bits = subsystemEntropy(state, keep)
        expect(bits).toBeGreaterThanOrEqual(-1e-12)
        expect(bits).toBeLessThanOrEqual(keep.length + 1e-12)
      }
    })
  })
})

/* ════════════ 4. concurrence against formulas with no matrices ═══════════ */

describe('concurrence against closed forms', () => {
  it('matches 2·|ψ₀₀ψ₁₁ − ψ₀₁ψ₁₀| on random pure pairs', () => {
    forRandomStates(2, 120, (state) => {
      expect(concurrenceOf(state, 0, 1)).toBeCloseTo(
        pureConcurrenceViaAmplitudes(state),
        DIGITS
      )
    })
  })

  it('matches |⟨ψ|(Y⊗Y)|ψ*⟩| with Y⊗Y built by hand', () => {
    // The same number by a third route, and the one that pins the sign
    // pattern: an implementation that used antidiag(1, −1, −1, 1) — the
    // plausible sign error — agrees with the amplitude formula on some states
    // and with this one on none.
    forRandomStates(2, 120, (state) => {
      expect(concurrenceOf(state, 0, 1)).toBeCloseTo(
        pureConcurrenceViaYY(state),
        DIGITS
      )
    })
  })

  it('matches the pure formula on a pair inside a larger register', () => {
    // Only when the pair is not entangled with the rest, which is what makes
    // this a check on the partial trace as well: prepare a product of a
    // two-qubit state and a one-qubit state, then read the pair back out.
    fc.assert(
      fc.property(
        fc.array(component, { minLength: 8, maxLength: 8 }),
        fc.array(component, { minLength: 4, maxLength: 4 }),
        (pairParts, soloParts) => {
          const pair = stateFrom(2, pairParts)
          const solo = stateFrom(1, soloParts)
          const joint: Statevector = {
            qubits: 3,
            size: 8,
            re: new Float64Array(8),
            im: new Float64Array(8),
          }
          for (let s = 0; s < 2; s++) {
            for (let p = 0; p < 4; p++) {
              const index = p | (s << 2)
              const product = mul(
                { re: pair.re[p], im: pair.im[p] },
                { re: solo.re[s], im: solo.im[s] }
              )
              joint.re[index] = product.re
              joint.im[index] = product.im
            }
          }
          expect(concurrenceOf(joint, 0, 1)).toBeCloseTo(
            pureConcurrenceViaAmplitudes(pair),
            DIGITS
          )
        }
      ),
      { numRuns: 60 }
    )
  })

  it('matches the X-state closed form on random mixed states', () => {
    /*
     * The case that separates a correct Wootters construction from one that
     * only works on pure states. An X-state is mixed, has rank up to four,
     * and still has a concurrence anyone can write down — which makes it the
     * only family where a *mixed* answer can be checked without running the
     * same algorithm twice.
     */
    const rng = createRng(20250816)
    let sawEntangled = 0
    let sawSeparable = 0
    for (let trial = 0; trial < 200; trial++) {
      const rho = randomXState(rng)
      const expected = xStateConcurrence(rho)
      expect(concurrence(rho), `trial ${trial}`).toBeCloseTo(expected, DIGITS)
      if (expected > 1e-6) sawEntangled++
      else sawSeparable++
    }
    // A family that came out entirely on one side of the threshold would make
    // the assertion above much weaker than it looks.
    expect(sawEntangled).toBeGreaterThan(20)
    expect(sawSeparable).toBeGreaterThan(20)
  })

  it('is zero for every mixture of product states', () => {
    /*
     * Separability is the definition of "not entangled", and a mixture of
     * product states is separable whatever the mixture. No closed form is
     * needed and none is used: the answer must be exactly zero for any number
     * of components, any weights and any single-qubit states. This is the
     * check a concurrence built out of the wrong spin flip fails immediately,
     * because it would find "entanglement" in a classical mixture.
     */
    const rng = createRng(31337)
    for (let trial = 0; trial < 40; trial++) {
      const dim = 4
      const re = new Float64Array(dim * dim)
      const im = new Float64Array(dim * dim)
      const weights = randomDistribution(3 + (trial % 3), rng)
      for (const weight of weights) {
        // |a⟩⊗|b⟩ for random single-qubit |a⟩ and |b⟩.
        const a = randomQubit(rng)
        const b = randomQubit(rng)
        const psi: Cx[] = []
        for (let index = 0; index < 4; index++) {
          psi.push(mul(a[index & 1], b[(index >> 1) & 1]))
        }
        for (let r = 0; r < 4; r++) {
          for (let c = 0; c < 4; c++) {
            const entry = mul(psi[r], conj(psi[c]))
            re[r * 4 + c] += weight * entry.re
            im[r * 4 + c] += weight * entry.im
          }
        }
      }
      const rho: DensityMatrix = { qubits: 2, dim: 4, size: 16, re, im }
      expect(concurrence(rho), `trial ${trial}`).toBeCloseTo(0, DIGITS)
    }
  })

  it('never leaves [0, 1], whatever it is handed', () => {
    const rng = createRng(808)
    for (let trial = 0; trial < 100; trial++) {
      const value = concurrence(
        spectralState(randomDistribution(4, rng), randomUnitary(4, rng))
      )
      expect(value).toBeGreaterThanOrEqual(0)
      expect(value).toBeLessThanOrEqual(1 + 1e-12)
    }
  })
})

/* ═════════════════ 5. fidelity against independent routes ════════════════ */

describe('fidelity against independent routes', () => {
  it('is |⟨ψ|φ⟩|² computed as a plain inner product', () => {
    fc.assert(
      fc.property(
        fc.array(component, { minLength: 8, maxLength: 8 }),
        fc.array(component, { minLength: 8, maxLength: 8 }),
        (first, second) => {
          const a = stateFrom(2, first)
          const b = stateFrom(2, second)
          let overlap = ZERO
          for (let i = 0; i < 4; i++) {
            overlap = add(
              overlap,
              mul({ re: a.re[i], im: -a.im[i] }, { re: b.re[i], im: b.im[i] })
            )
          }
          const expected = abs(overlap) ** 2
          expect(stateFidelity(a, b)).toBeCloseTo(expected, DIGITS)
          expect(densityStateFidelity(outer(a), b)).toBeCloseTo(
            expected,
            DIGITS
          )
          expect(densityFidelity(outer(a), outer(b))).toBeCloseTo(
            expected,
            DIGITS
          )
        }
      ),
      { numRuns: 80 }
    )
  })

  it('is (Σ√(pq))² for two states that commute', () => {
    /*
     * Two density matrices diagonal in the *same* basis are a purely
     * classical pair, and the quantum formula must collapse onto the
     * classical one — computed here in a loop with no matrix in it. This is
     * also the test that pins the squared convention: under the unsquared one
     * the two sides differ by exactly a square, at every draw.
     */
    const rng = createRng(616)
    for (let trial = 0; trial < 20; trial++) {
      const columns = randomUnitary(4, rng)
      const p = randomDistribution(4, rng)
      const q = randomDistribution(4, rng)
      let classical = 0
      for (let i = 0; i < 4; i++) classical += Math.sqrt(p[i] * q[i])
      classical *= classical

      expect(
        densityFidelity(spectralState(p, columns), spectralState(q, columns)),
        `trial ${trial}`
      ).toBeCloseTo(classical, DIGITS)
      expect(distributionFidelity(p, q), `trial ${trial}`).toBeCloseTo(
        classical,
        DIGITS
      )
    }
  })

  it('is unchanged when both states are rotated by the same unitary', () => {
    // F(UρU†, UσU†) = F(ρ, σ), with U drawn by Gram–Schmidt rather than by
    // anything in the package. Conjugation changes every entry of both
    // matrices and must change nothing about the answer.
    const rng = createRng(1717)
    for (let trial = 0; trial < 15; trial++) {
      const p = randomDistribution(4, rng)
      const q = randomDistribution(4, rng)
      const identity = randomUnitary(4, createRng(1))
      const rotated = randomUnitary(4, rng)
      const plain = densityFidelity(
        spectralState(p, identity),
        spectralState(q, identity)
      )
      const turned = densityFidelity(
        spectralState(p, rotated),
        spectralState(q, rotated)
      )
      // Both are diagonal in *some* basis, so the classical value applies to
      // each — but only if the module never looked at the basis.
      expect(turned, `trial ${trial}`).toBeCloseTo(plain, DIGITS)
    }
  })

  it('is symmetric, bounded, and exactly 1 only on identical states', () => {
    const rng = createRng(2024)
    for (let trial = 0; trial < 20; trial++) {
      const a = spectralState(randomDistribution(4, rng), randomUnitary(4, rng))
      const b = spectralState(randomDistribution(4, rng), randomUnitary(4, rng))
      const forward = densityFidelity(a, b)
      expect(densityFidelity(b, a), `trial ${trial}`).toBeCloseTo(
        forward,
        DIGITS
      )
      expect(forward).toBeGreaterThanOrEqual(-1e-12)
      expect(forward).toBeLessThanOrEqual(1 + 1e-9)
      expect(densityFidelity(a, a), `trial ${trial}`).toBeCloseTo(1, DIGITS)
      // Two independently drawn spectra in independently drawn bases are not
      // the same state, so the metric has to be able to say so.
      expect(forward).toBeLessThan(1 - 1e-6)
    }
  })
})

/* ──────────────────────────── small fixtures ────────────────────────────── */

/** A random normalised single-qubit state, as two complex amplitudes. */
function randomQubit(rng: Rng): [Cx, Cx] {
  const theta = Math.acos(2 * rng.next() - 1)
  const phi = rng.next() * 2 * Math.PI
  return [
    { re: Math.cos(theta / 2), im: 0 },
    {
      re: Math.sin(theta / 2) * Math.cos(phi),
      im: Math.sin(theta / 2) * Math.sin(phi),
    },
  ]
}

/** |ψ⟩⟨ψ|, built here so the fidelity tests do not lean on `density.ts`. */
function outer(state: Statevector): DensityMatrix {
  const dim = state.size
  const re = new Float64Array(dim * dim)
  const im = new Float64Array(dim * dim)
  for (let r = 0; r < dim; r++) {
    for (let c = 0; c < dim; c++) {
      const entry = mul(
        { re: state.re[r], im: state.im[r] },
        { re: state.re[c], im: -state.im[c] }
      )
      re[r * dim + c] = entry.re
      im[r * dim + c] = entry.im
    }
  }
  return { qubits: state.qubits, dim, size: dim * dim, re, im }
}
