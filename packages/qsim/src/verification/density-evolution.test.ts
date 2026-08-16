/**
 * INDEPENDENT ADVERSARIAL VERIFICATION — DENSITY MATRIX AND UNITARY EVOLUTION.
 *
 * Nothing here is derived from `density.ts`. The oracle in this file does
 * exactly what §5.2 forbids the engine to do, and that is the point: it builds
 * the full 2ⁿ × 2ⁿ unitary entry by entry from the definition of a controlled
 * gate, then computes UρU† with two textbook triple-loop matrix products over
 * nested arrays of `{ re, im }`. It shares no stride, no pairing walk, no flat
 * layout and no accumulator with the implementation, which is what lets it
 * disagree. Its gate matrices are written out from the textbook here rather
 * than read from `gates.ts`, so a wrong entry in the catalog cannot cancel
 * against a wrong entry in the kernel.
 *
 * The six things this file is looking for:
 *
 *   1. **A dagger that is a transpose too many, or too few.** ρ → UρU† with
 *      Uᵀ, with conj(U) alone, or with the conjugation applied to the row pass
 *      instead of the column pass. Every one of those returns a matrix that is
 *      still unit-trace, still positive and still plausible on a histogram.
 *      Only an entry-for-entry comparison against the definition sees it.
 *
 *   2. **A control filtered on the wrong index.** Pass 1 must filter rows and
 *      pass 2 must filter columns. Filtering the same index twice leaves the
 *      diagonal — and therefore every probability the UI draws — correct, and
 *      corrupts only the coherences, which is to say only the part of the
 *      state that noise mode exists to show.
 *
 *   3. **A ρ that has stopped being a state.** Hermitian, unit trace, positive
 *      semidefinite, checked after every operation against an oracle that
 *      computes each of the three its own way.
 *
 *   4. **A positivity test that answers by luck.** `isPositiveSemidefinite` is
 *      checked against matrices with a *known* spectrum: ρ = HDH with a
 *      Householder reflector H (Hermitian and unitary, so the eigenvalues of ρ
 *      are exactly the diagonal of D). The answer is required to match the sign
 *      of the smallest eigenvalue, at the boundary as well as far from it, and
 *      when it says "not positive" the eigenvector is produced as a witness
 *      with a negative ⟨v|ρ|v⟩.
 *
 *   5. **A purity that is not Tr(ρ²).** Also checked against the known
 *      spectrum, where Tr(ρ²) = Σ dᵢ² with no matrix multiplication involved.
 *
 *   6. **An outer product with the conjugate on the wrong factor.** ρ = |ψ⟩⟨ψ|
 *      is rebuilt here from random states drawn by fast-check, and its
 *      diagonal is required to reproduce the Born rule the statevector gives.
 */

import fc from 'fast-check'
import { describe, expect, it } from 'vitest'

import {
  alloc,
  apply2q,
  applyControlled,
  applyISwap,
  applySwap,
  apply1q,
  clone,
  fromStatevector,
  hermiticityDefect,
  isHermitian,
  isPositiveSemidefinite,
  probabilities,
  purity,
  trace,
} from '../density.js'
import type { DensityMatrix } from '../density.js'
import type { Statevector } from '../statevector.js'

/** D6 again: 1e-10, as a bound and as digits for `toBeCloseTo`. */
const TOLERANCE = 1e-10
const DIGITS = 10

/* ─────────────────────── complex arithmetic, by hand ────────────────────── */

interface Cx {
  readonly re: number
  readonly im: number
}

type Mat = readonly (readonly Cx[])[]

const ZERO: Cx = { re: 0, im: 0 }
const ONE: Cx = { re: 1, im: 0 }
const I_UNIT: Cx = { re: 0, im: 1 }

const cx = (re: number, im = 0): Cx => ({ re, im })
const add = (a: Cx, b: Cx): Cx => ({ re: a.re + b.re, im: a.im + b.im })
const conj = (a: Cx): Cx => ({ re: a.re, im: -a.im })
const neg = (a: Cx): Cx => ({ re: -a.re, im: -a.im })
const mul = (a: Cx, b: Cx): Cx => ({
  re: a.re * b.re - a.im * b.im,
  im: a.re * b.im + a.im * b.re,
})
const scale = (a: Cx, k: number): Cx => ({ re: a.re * k, im: a.im * k })
const magnitude = (a: Cx): number => Math.hypot(a.re, a.im)

function zeros(dim: number): Cx[][] {
  const out: Cx[][] = []
  for (let r = 0; r < dim; r++) out.push(new Array<Cx>(dim).fill(ZERO))
  return out
}

function identity(dim: number): Mat {
  const out = zeros(dim)
  for (let i = 0; i < dim; i++) out[i][i] = ONE
  return out
}

/** A·B, the O(dim³) way. Slow on purpose. */
function product(a: Mat, b: Mat): Mat {
  const dim = a.length
  const out = zeros(dim)
  for (let r = 0; r < dim; r++) {
    for (let c = 0; c < dim; c++) {
      let sum = ZERO
      for (let k = 0; k < dim; k++) sum = add(sum, mul(a[r][k], b[k][c]))
      out[r][c] = sum
    }
  }
  return out
}

/** A† — conjugate AND transpose, spelled out where both halves are visible. */
function adjoint(a: Mat): Mat {
  const dim = a.length
  const out = zeros(dim)
  for (let r = 0; r < dim; r++) {
    for (let c = 0; c < dim; c++) out[r][c] = conj(a[c][r])
  }
  return out
}

/** UρU†, from §5.4's line, with nothing factored and nothing skipped. */
function evolve(rho: Mat, u: Mat): Mat {
  return product(product(u, rho), adjoint(u))
}

/* ──────────────────── the gate catalog, written out again ───────────────── */

const SQRT1_2 = Math.SQRT1_2

const ORACLE_GATES: Readonly<Record<string, Mat>> = {
  i: [
    [ONE, ZERO],
    [ZERO, ONE],
  ],
  x: [
    [ZERO, ONE],
    [ONE, ZERO],
  ],
  y: [
    [ZERO, neg(I_UNIT)],
    [I_UNIT, ZERO],
  ],
  z: [
    [ONE, ZERO],
    [ZERO, cx(-1)],
  ],
  h: [
    [cx(SQRT1_2), cx(SQRT1_2)],
    [cx(SQRT1_2), cx(-SQRT1_2)],
  ],
  s: [
    [ONE, ZERO],
    [ZERO, I_UNIT],
  ],
  sdg: [
    [ONE, ZERO],
    [ZERO, neg(I_UNIT)],
  ],
  t: [
    [ONE, ZERO],
    [ZERO, cx(SQRT1_2, SQRT1_2)],
  ],
  tdg: [
    [ONE, ZERO],
    [ZERO, cx(SQRT1_2, -SQRT1_2)],
  ],
  sx: [
    [cx(0.5, 0.5), cx(0.5, -0.5)],
    [cx(0.5, -0.5), cx(0.5, 0.5)],
  ],
}

/** Rx(θ) — half angle, from the textbook and not from `gates.ts`. */
function oracleRx(theta: number): Mat {
  const c = Math.cos(theta / 2)
  const s = Math.sin(theta / 2)
  return [
    [cx(c), cx(0, -s)],
    [cx(0, -s), cx(c)],
  ]
}

function oracleRy(theta: number): Mat {
  const c = Math.cos(theta / 2)
  const s = Math.sin(theta / 2)
  return [
    [cx(c), cx(-s)],
    [cx(s), cx(c)],
  ]
}

function oracleRz(theta: number): Mat {
  return [
    [cx(Math.cos(theta / 2), -Math.sin(theta / 2)), ZERO],
    [ZERO, cx(Math.cos(theta / 2), Math.sin(theta / 2))],
  ]
}

function oracleP(phi: number): Mat {
  return [
    [ONE, ZERO],
    [ZERO, cx(Math.cos(phi), Math.sin(phi))],
  ]
}

/** U(θ,φ,λ), Qiskit's convention, with the bottom-right phase summed here. */
function oracleU(theta: number, phi: number, lambda: number): Mat {
  const c = Math.cos(theta / 2)
  const s = Math.sin(theta / 2)
  return [
    [cx(c), neg(scale(cx(Math.cos(lambda), Math.sin(lambda)), s))],
    [
      scale(cx(Math.cos(phi), Math.sin(phi)), s),
      scale(cx(Math.cos(phi + lambda), Math.sin(phi + lambda)), c),
    ],
  ]
}

/**
 * The 4×4s, in the `2·b₁ + b₀` basis. `b₀` is the bit of the FIRST qubit
 * argument — the local reading of D1, and the one thing this file has to take
 * on trust from `apply.ts` because it is a statement about an argument list
 * rather than about physics. `swap` is symmetric and would survive getting it
 * wrong; `iswap` and the XY interaction below are not and do not.
 */
const ORACLE_SWAP: Mat = [
  [ONE, ZERO, ZERO, ZERO],
  [ZERO, ZERO, ONE, ZERO],
  [ZERO, ONE, ZERO, ZERO],
  [ZERO, ZERO, ZERO, ONE],
]

const ORACLE_ISWAP: Mat = [
  [ONE, ZERO, ZERO, ZERO],
  [ZERO, ZERO, I_UNIT, ZERO],
  [ZERO, I_UNIT, ZERO, ZERO],
  [ZERO, ZERO, ZERO, ONE],
]

/**
 * exp(−iθ(XX+YY)/4) — a dense two-qubit unitary that is not a permutation and
 * not a tensor product of one-qubit gates, so it exercises the arbitrary-4×4
 * path with something none of the specialised kernels could produce.
 */
function oracleXY(theta: number): Mat {
  const c = cx(Math.cos(theta / 2))
  const s = cx(0, -Math.sin(theta / 2))
  return [
    [ONE, ZERO, ZERO, ZERO],
    [ZERO, c, s, ZERO],
    [ZERO, s, c, ZERO],
    [ZERO, ZERO, ZERO, ONE],
  ]
}

/** The same matrix in the engine's flat interleaved layout (`gates.ts`). */
function flatten(m: Mat): Float64Array {
  const dim = m.length
  const out = new Float64Array(dim * dim * 2)
  for (let r = 0; r < dim; r++) {
    for (let c = 0; c < dim; c++) {
      out[(r * dim + c) * 2] = m[r][c].re
      out[(r * dim + c) * 2 + 1] = m[r][c].im
    }
  }
  return out
}

/* ─────────────── the full unitary, built the forbidden way ──────────────── */

interface Control {
  readonly qubit: number
  readonly state: 0 | 1
}

function fires(index: number, controls: readonly Control[]): boolean {
  return controls.every(
    (control) => ((index >> control.qubit) & 1) === control.state
  )
}

/**
 * The 2ⁿ × 2ⁿ matrix of a one-qubit gate on `target`, with controls — the
 * Kronecker product §5.2 forbids, written entry by entry from what a
 * controlled gate means:
 *
 *   - rows and columns that disagree on any qubit other than the target are
 *     zero, because the gate does not move those qubits;
 *   - where the control condition fails, the row is the identity's;
 *   - otherwise the entry is the 2×2 read at the target's bits.
 */
function oneQubitUnitary(
  qubits: number,
  m: Mat,
  target: number,
  controls: readonly Control[] = []
): Mat {
  const dim = 1 << qubits
  const bit = 1 << target
  const out = zeros(dim)
  for (let row = 0; row < dim; row++) {
    for (let column = 0; column < dim; column++) {
      if ((row & ~bit) !== (column & ~bit)) continue
      if (!fires(row, controls)) {
        out[row][column] = row === column ? ONE : ZERO
        continue
      }
      out[row][column] = m[(row >> target) & 1][(column >> target) & 1]
    }
  }
  return out
}

/** The same for a 4×4 on `(q0, q1)`, local index `2·b₁ + b₀`. */
function twoQubitUnitary(
  qubits: number,
  m: Mat,
  q0: number,
  q1: number,
  controls: readonly Control[] = []
): Mat {
  const dim = 1 << qubits
  const mask = (1 << q0) | (1 << q1)
  const local = (index: number): number =>
    ((index >> q0) & 1) + 2 * ((index >> q1) & 1)

  const out = zeros(dim)
  for (let row = 0; row < dim; row++) {
    for (let column = 0; column < dim; column++) {
      if ((row & ~mask) !== (column & ~mask)) continue
      if (!fires(row, controls)) {
        out[row][column] = row === column ? ONE : ZERO
        continue
      }
      out[row][column] = m[local(row)][local(column)]
    }
  }
  return out
}

/* ───────────────────────── bridging the two worlds ──────────────────────── */

function toOracle(rho: DensityMatrix): Mat {
  const out = zeros(rho.dim)
  for (let row = 0; row < rho.dim; row++) {
    for (let column = 0; column < rho.dim; column++) {
      const at = row * rho.dim + column
      out[row][column] = cx(rho.re[at], rho.im[at])
    }
  }
  return out
}

/** Overwrite an engine ρ with an oracle matrix, for the reverse direction. */
function writeInto(rho: DensityMatrix, m: Mat): void {
  for (let row = 0; row < rho.dim; row++) {
    for (let column = 0; column < rho.dim; column++) {
      const at = row * rho.dim + column
      rho.re[at] = m[row][column].re
      rho.im[at] = m[row][column].im
    }
  }
}

function expectMatches(rho: DensityMatrix, expected: Mat, label: string): void {
  let worst = 0
  for (let row = 0; row < rho.dim; row++) {
    for (let column = 0; column < rho.dim; column++) {
      const at = row * rho.dim + column
      const dr = Math.abs(rho.re[at] - expected[row][column].re)
      const di = Math.abs(rho.im[at] - expected[row][column].im)
      if (dr > worst) worst = dr
      if (di > worst) worst = di
    }
  }
  expect(worst, `${label}: largest entry difference`).toBeLessThan(TOLERANCE)
}

/* ──────────────────────────── random fixtures ───────────────────────────── */

/**
 * A deterministic stream, so a failure here is reproducible without a seed
 * printed anywhere. Not `Math.random`, and not the engine's `rng.ts` either:
 * this file brings its own of everything.
 */
function stream(seed: number): () => number {
  let state = seed >>> 0
  return () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0
    return state / 4294967296
  }
}

/** A normalised random state vector, as oracle complex numbers. */
function randomVector(dim: number, next: () => number): Cx[] {
  const raw: Cx[] = []
  for (let i = 0; i < dim; i++) {
    raw.push(cx(next() * 2 - 1, next() * 2 - 1))
  }
  let sum = 0
  for (const value of raw) sum += value.re * value.re + value.im * value.im
  const factor = 1 / Math.sqrt(sum)
  return raw.map((value) => scale(value, factor))
}

/** |ψ⟩⟨ψ| as an oracle matrix, from the definition of an outer product. */
function outer(psi: readonly Cx[]): Mat {
  const dim = psi.length
  const out = zeros(dim)
  for (let row = 0; row < dim; row++) {
    for (let column = 0; column < dim; column++) {
      out[row][column] = mul(psi[row], conj(psi[column]))
    }
  }
  return out
}

/** A mixture of `parts` random pure states, built as an oracle matrix. */
function randomMixture(qubits: number, next: () => number, parts = 3): Mat {
  const dim = 1 << qubits
  const weights: number[] = []
  let total = 0
  for (let k = 0; k < parts; k++) {
    const weight = 0.2 + next()
    weights.push(weight)
    total += weight
  }

  let out: Mat = zeros(dim)
  for (let k = 0; k < parts; k++) {
    const piece = outer(randomVector(dim, next))
    const blended = zeros(dim)
    for (let row = 0; row < dim; row++) {
      for (let column = 0; column < dim; column++) {
        blended[row][column] = add(
          out[row][column],
          scale(piece[row][column], weights[k] / total)
        )
      }
    }
    out = blended
  }
  return out
}

/** An engine ρ holding an arbitrary oracle matrix. */
function engineFrom(qubits: number, m: Mat): DensityMatrix {
  const rho = alloc(qubits)
  writeInto(rho, m)
  return rho
}

/* ─────────────────── evolution against the definition ───────────────────── */

interface Trial {
  readonly name: string
  readonly qubits: number
  readonly apply: (rho: DensityMatrix) => void
  readonly unitary: Mat
}

function trials(): Trial[] {
  const out: Trial[] = []
  const qubits = 3

  for (const [id, m] of Object.entries(ORACLE_GATES)) {
    for (const target of [0, 1, 2]) {
      const flat = flatten(m)
      out.push({
        name: `${id} on q${target}`,
        qubits,
        apply: (rho) => apply1q(rho, flat, target),
        unitary: oneQubitUnitary(qubits, m, target),
      })
    }
  }

  const parametrised: readonly (readonly [string, Mat])[] = [
    ['rx(1.1)', oracleRx(1.1)],
    ['ry(-0.4)', oracleRy(-0.4)],
    ['rz(2.7)', oracleRz(2.7)],
    ['p(-1.8)', oracleP(-1.8)],
    ['u(0.9,2.2,-1.5)', oracleU(0.9, 2.2, -1.5)],
  ]
  for (const [name, m] of parametrised) {
    const flat = flatten(m)
    out.push({
      name: `${name} on q1`,
      qubits,
      apply: (rho) => apply1q(rho, flat, 1),
      unitary: oneQubitUnitary(qubits, m, 1),
    })
  }

  const controlled: readonly (readonly [string, Mat, number, Control[]])[] = [
    ['cx', ORACLE_GATES.x, 2, [{ qubit: 0, state: 1 }]],
    ['cz', ORACLE_GATES.z, 0, [{ qubit: 2, state: 1 }]],
    ['ch', ORACLE_GATES.h, 1, [{ qubit: 0, state: 1 }]],
    ['crz(0.6)', oracleRz(0.6), 1, [{ qubit: 2, state: 1 }]],
    ['cp(2.4)', oracleP(2.4), 0, [{ qubit: 1, state: 1 }]],
    ['negatively controlled x', ORACLE_GATES.x, 1, [{ qubit: 2, state: 0 }]],
    [
      'ccx',
      ORACLE_GATES.x,
      2,
      [
        { qubit: 0, state: 1 },
        { qubit: 1, state: 1 },
      ],
    ],
    [
      'y with one positive and one negative control',
      ORACLE_GATES.y,
      0,
      [
        { qubit: 1, state: 1 },
        { qubit: 2, state: 0 },
      ],
    ],
  ]
  for (const [name, m, target, controls] of controlled) {
    const flat = flatten(m)
    out.push({
      name,
      qubits,
      apply: (rho) => applyControlled(rho, flat, target, controls),
      unitary: oneQubitUnitary(qubits, m, target, controls),
    })
  }

  out.push({
    name: 'swap(0, 2) through the specialised kernel',
    qubits,
    apply: (rho) => applySwap(rho, 0, 2),
    unitary: twoQubitUnitary(qubits, ORACLE_SWAP, 0, 2),
  })
  out.push({
    name: 'cswap(0, 1) controlled by q2',
    qubits,
    apply: (rho) => applySwap(rho, 0, 1, [{ qubit: 2, state: 1 }]),
    unitary: twoQubitUnitary(qubits, ORACLE_SWAP, 0, 1, [
      { qubit: 2, state: 1 },
    ]),
  })
  out.push({
    name: 'iswap(1, 2)',
    qubits,
    apply: (rho) => applyISwap(rho, 1, 2),
    unitary: twoQubitUnitary(qubits, ORACLE_ISWAP, 1, 2),
  })
  out.push({
    name: 'iswap(2, 0) — arguments reversed',
    qubits,
    apply: (rho) => applyISwap(rho, 2, 0),
    unitary: twoQubitUnitary(qubits, ORACLE_ISWAP, 2, 0),
  })
  out.push({
    name: 'apply2q with SWAP',
    qubits,
    apply: (rho) => apply2q(rho, flatten(ORACLE_SWAP), 1, 0),
    unitary: twoQubitUnitary(qubits, ORACLE_SWAP, 1, 0),
  })
  out.push({
    name: 'apply2q with iSWAP',
    qubits,
    apply: (rho) => apply2q(rho, flatten(ORACLE_ISWAP), 0, 2),
    unitary: twoQubitUnitary(qubits, ORACLE_ISWAP, 0, 2),
  })
  out.push({
    name: 'apply2q with the XY interaction',
    qubits,
    apply: (rho) => apply2q(rho, flatten(oracleXY(1.3)), 2, 1),
    unitary: twoQubitUnitary(qubits, oracleXY(1.3), 2, 1),
  })
  out.push({
    name: 'apply2q with the XY interaction on 4 qubits, q3 and q0',
    qubits: 4,
    apply: (rho) => apply2q(rho, flatten(oracleXY(-0.7)), 3, 0),
    unitary: twoQubitUnitary(4, oracleXY(-0.7), 3, 0),
  })

  return out
}

describe('ρ → UρU† matches the definition, gate by gate', () => {
  const next = stream(2024)

  for (const trial of trials()) {
    it(`${trial.name}, on a pure state`, () => {
      const psi = randomVector(1 << trial.qubits, next)
      const rho = engineFrom(trial.qubits, outer(psi))

      trial.apply(rho)
      expectMatches(rho, evolve(outer(psi), trial.unitary), trial.name)
    })

    it(`${trial.name}, on a mixed state`, () => {
      /*
       * A mixture is where the two representations stop being interchangeable:
       * there is no statevector to fall back on, so this comparison is the only
       * thing standing behind noise mode's arithmetic. It is also where a
       * conjugate on the wrong side stops being a global phase — on a pure
       * state some errors cancel between the ket and the bra, and on a mixture
       * of three states with unequal weights they do not.
       */
      const mixture = randomMixture(trial.qubits, next)
      const rho = engineFrom(trial.qubits, mixture)

      trial.apply(rho)
      expectMatches(rho, evolve(mixture, trial.unitary), trial.name)
    })
  }
})

describe('every operation leaves a valid density matrix behind', () => {
  const next = stream(97)

  it('keeps Hermiticity, unit trace and positivity through a long run', () => {
    /*
     * Every trial applied to one ρ in sequence, so errors accumulate rather
     * than being reset between assertions. The oracle recomputes the same
     * three quantities its own way at each step: the trace by summing the
     * diagonal of the oracle copy, positivity from a random-vector quadratic
     * form, Hermiticity by comparing against the adjoint.
     */
    const qubits = 3
    const rho = engineFrom(qubits, randomMixture(qubits, next))
    const startingPurity = purity(rho)
    expect(startingPurity).toBeLessThan(1)

    for (const trial of trials()) {
      if (trial.qubits !== qubits) continue
      trial.apply(rho)

      const oracle = toOracle(rho)
      const conjugate = adjoint(oracle)
      let asymmetry = 0
      let oracleTrace = ZERO
      for (let row = 0; row < oracle.length; row++) {
        oracleTrace = add(oracleTrace, oracle[row][row])
        for (let column = 0; column < oracle.length; column++) {
          asymmetry = Math.max(
            asymmetry,
            magnitude({
              re: oracle[row][column].re - conjugate[row][column].re,
              im: oracle[row][column].im - conjugate[row][column].im,
            })
          )
        }
      }

      expect(asymmetry, `${trial.name}: ρ − ρ†`).toBeLessThan(TOLERANCE)
      expect(oracleTrace.re, `${trial.name}: Tr ρ`).toBeCloseTo(1, DIGITS)
      expect(oracleTrace.im, `${trial.name}: Im Tr ρ`).toBeCloseTo(0, DIGITS)
      expect(hermiticityDefect(rho)).toBeLessThan(TOLERANCE)
      expect(trace(rho), `${trial.name}: engine trace`).toBeCloseTo(1, DIGITS)
      expect(isPositiveSemidefinite(rho), `${trial.name}: positive`).toBe(true)

      // Ten random directions per step: ⟨v|ρ|v⟩ ≥ 0 is the definition of
      // positivity and involves no factorisation at all, so it disagrees with
      // the Cholesky route rather than repeating it.
      for (let k = 0; k < 10; k++) {
        const v = randomVector(1 << qubits, next)
        expect(
          quadraticForm(oracle, v).re,
          `${trial.name}: ⟨v|ρ|v⟩`
        ).toBeGreaterThan(-TOLERANCE)
      }

      // Unitary evolution moves no eigenvalue, so it moves no purity.
      expect(purity(rho), `${trial.name}: Tr(ρ²)`).toBeCloseTo(
        startingPurity,
        DIGITS
      )
    }
  })
})

/** ⟨v|ρ|v⟩ — real and non-negative for any state, by definition. */
function quadraticForm(rho: Mat, v: readonly Cx[]): Cx {
  let sum = ZERO
  for (let row = 0; row < v.length; row++) {
    for (let column = 0; column < v.length; column++) {
      sum = add(sum, mul(conj(v[row]), mul(rho[row][column], v[column])))
    }
  }
  return sum
}

/* ───────────── positivity and purity against a known spectrum ───────────── */

/**
 * A Householder reflector, H = I − 2·vv†/⟨v|v⟩.
 *
 * Unitary *and* Hermitian, which is what makes it useful here: H D H† = H D H,
 * and the eigenvalues of that product are exactly the diagonal of D with the
 * columns of H as eigenvectors. So a matrix with any spectrum can be built to
 * order, without an eigensolver anywhere in the file, and `purity`,
 * `trace` and `isPositiveSemidefinite` can be checked against numbers that
 * were chosen rather than computed.
 */
function householder(v: readonly Cx[]): Mat {
  const dim = v.length
  let normSquared = 0
  for (const value of v)
    normSquared += value.re * value.re + value.im * value.im

  const out = zeros(dim)
  for (let row = 0; row < dim; row++) {
    for (let column = 0; column < dim; column++) {
      const outerEntry = mul(v[row], conj(v[column]))
      const base = row === column ? ONE : ZERO
      out[row][column] = {
        re: base.re - (2 * outerEntry.re) / normSquared,
        im: base.im - (2 * outerEntry.im) / normSquared,
      }
    }
  }
  return out
}

/** H·diag(spectrum)·H — a matrix whose eigenvalues are `spectrum`, exactly. */
function withSpectrum(spectrum: readonly number[], reflector: Mat): Mat {
  const dim = spectrum.length
  const d = zeros(dim)
  for (let i = 0; i < dim; i++) d[i][i] = cx(spectrum[i])
  return product(product(reflector, d), reflector)
}

describe('positivity and purity answer to a spectrum chosen in advance', () => {
  const next = stream(4242)
  const qubits = 2
  const dim = 1 << qubits
  const reflector = householder(randomVector(dim, next))

  it('is a unitary and Hermitian reflector, so the construction is sound', () => {
    // The eigenvalue claim below rests entirely on this: if H were neither
    // unitary nor Hermitian, HDH would have some other spectrum and every
    // assertion in this section would be measuring the wrong thing.
    const shouldBeIdentity = product(reflector, adjoint(reflector))
    const target = identity(dim)
    for (let row = 0; row < dim; row++) {
      for (let column = 0; column < dim; column++) {
        expect(shouldBeIdentity[row][column].re).toBeCloseTo(
          target[row][column].re,
          DIGITS
        )
        expect(shouldBeIdentity[row][column].im).toBeCloseTo(0, DIGITS)
        expect(reflector[row][column].re).toBeCloseTo(
          conj(reflector[column][row]).re,
          DIGITS
        )
        expect(reflector[row][column].im).toBeCloseTo(
          conj(reflector[column][row]).im,
          DIGITS
        )
      }
    }
  })

  const spectra: readonly (readonly [string, number[], boolean])[] = [
    ['a pure state', [1, 0, 0, 0], true],
    ['the maximally mixed state', [0.25, 0.25, 0.25, 0.25], true],
    ['a rank-2 mixture', [0.7, 0.3, 0, 0], true],
    ['a generic mixture', [0.4, 0.3, 0.2, 0.1], true],
    ['one negative eigenvalue', [0.6, 0.5, 0.0, -0.1], false],
    ['a barely negative eigenvalue', [0.5, 0.3, 0.2 + 1e-6, -1e-6], false],
    [
      'an eigenvalue below the noise floor',
      [0.5, 0.3, 0.2 + 1e-13, -1e-13],
      true,
    ],
    ['two negative eigenvalues', [0.9, 0.3, -0.1, -0.1], false],
  ]

  for (const [name, spectrum, positive] of spectra) {
    it(`calls ${name} ${positive ? 'positive' : 'not positive'}`, () => {
      const rho = engineFrom(qubits, withSpectrum(spectrum, reflector))
      const total = spectrum.reduce((sum, value) => sum + value, 0)

      // The three quantities, against arithmetic on the spectrum alone.
      expect(isHermitian(rho), `${name}: Hermitian`).toBe(true)
      expect(trace(rho), `${name}: Σλ`).toBeCloseTo(total, DIGITS)
      expect(purity(rho), `${name}: Σλ²`).toBeCloseTo(
        spectrum.reduce((sum, value) => sum + value * value, 0),
        DIGITS
      )
      expect(isPositiveSemidefinite(rho), `${name}: positivity`).toBe(positive)
    })
  }

  it('produces a witness whenever it says a matrix is not positive', () => {
    /*
     * "Not positive" is only meaningful if some direction really does carry a
     * negative probability. Column k of H is the eigenvector for λₖ, so the
     * quadratic form there must come back at λₖ — a negative number, computed
     * without going anywhere near the Cholesky factorisation.
     */
    const spectrum = [0.6, 0.5, 0.0, -0.1]
    const rho = engineFrom(qubits, withSpectrum(spectrum, reflector))
    expect(isPositiveSemidefinite(rho)).toBe(false)

    for (let k = 0; k < dim; k++) {
      const eigenvector: Cx[] = []
      for (let row = 0; row < dim; row++) eigenvector.push(reflector[row][k])
      const value = quadraticForm(toOracle(rho), eigenvector)
      expect(value.re, `⟨v${k}|ρ|v${k}⟩`).toBeCloseTo(spectrum[k], DIGITS)
      expect(value.im).toBeCloseTo(0, DIGITS)
    }
  })

  it('survives a matrix that is positive but singular in three directions', () => {
    // Rank 1 out of four: the factorisation meets a zero pivot on its second
    // step and has to keep going rather than divide by it.
    const rho = engineFrom(qubits, withSpectrum([1, 0, 0, 0], reflector))
    expect(isPositiveSemidefinite(rho)).toBe(true)
    expect(purity(rho)).toBeCloseTo(1, DIGITS)
  })
})

/* ──────────────── the outer product, over random states ─────────────────── */

/**
 * A normalised random state built without touching the engine, and without
 * `fc.double`'s exponent range destroying the normalisation on the way.
 *
 * The peak pass is the same one `reduced-density.test.ts` explains at length:
 * a draw of order 1e-161 squares to a subnormal, the sum of squares is then
 * wrong by percent, and every property below would fail against a fixture that
 * was never a state. Dividing by the largest component first puts the biggest
 * square at 1, where the sum is exact.
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
  const factor = 1 / Math.sqrt(sum)
  for (let i = 0; i < size; i++) {
    re[i] *= factor
    im[i] *= factor
  }
  return { qubits, size, re, im }
}

const component = fc.double({
  min: -1,
  max: 1,
  noNaN: true,
  noDefaultInfinity: true,
})

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

describe('|ψ⟩⟨ψ| is the outer product and nothing else', () => {
  it('matches an independently written outer product, entry for entry', () => {
    for (const qubits of [1, 2, 3]) {
      forRandomStates(qubits, 40, (state) => {
        const psi: Cx[] = []
        for (let i = 0; i < state.size; i++) {
          psi.push(cx(state.re[i], state.im[i]))
        }
        expectMatches(fromStatevector(state), outer(psi), 'outer product')
      })
    }
  })

  it('has purity 1, unit trace and a Born-rule diagonal', () => {
    for (const qubits of [1, 2, 3, 4]) {
      forRandomStates(qubits, 30, (state) => {
        const rho = fromStatevector(state)
        expect(trace(rho)).toBeCloseTo(1, DIGITS)
        expect(purity(rho)).toBeCloseTo(1, DIGITS)
        expect(isHermitian(rho)).toBe(true)

        const diagonal = probabilities(rho)
        for (let i = 0; i < state.size; i++) {
          const born = state.re[i] * state.re[i] + state.im[i] * state.im[i]
          expect(diagonal[i]).toBeCloseTo(born, DIGITS)
        }
      })
    }
  })

  it('is idempotent, as a pure state must be: ρ² = ρ', () => {
    // The statement purity 1 is a scalar shadow of. A matrix with the right
    // trace and the right purity can still fail this one.
    for (const qubits of [1, 2, 3]) {
      forRandomStates(qubits, 20, (state) => {
        const rho = fromStatevector(state)
        const oracle = toOracle(rho)
        expectMatches(rho, product(oracle, oracle), 'ρ² = ρ')
      })
    }
  })
})

/* ─────────────────────────── evolution composes ─────────────────────────── */

describe('the two passes compose the way matrix multiplication does', () => {
  const next = stream(555)

  it('(UV)ρ(UV)† equals U(VρV†)U†', () => {
    /*
     * Associativity is a property of the physics that the kernel has no
     * automatic claim to: the row pass and the column pass are separate walks,
     * and a kernel that mixed them — conjugating during pass 1, say — would
     * still be self-consistent gate by gate and would break here. The oracle
     * composes the two unitaries first; the engine applies them one after the
     * other.
     */
    const qubits = 3
    const v = oneQubitUnitary(qubits, oracleU(1.4, -0.2, 0.8), 1)
    const u = twoQubitUnitary(qubits, oracleXY(0.9), 0, 2)
    const composed = product(u, v)

    const start = randomMixture(qubits, next)
    const rho = engineFrom(qubits, start)
    apply1q(rho, flatten(oracleU(1.4, -0.2, 0.8)), 1)
    apply2q(rho, flatten(oracleXY(0.9)), 0, 2)

    expectMatches(rho, evolve(start, composed), 'composed evolution')
  })

  it('returns to where it started under U then U†', () => {
    const qubits = 3
    const start = randomMixture(qubits, next)
    const rho = engineFrom(qubits, start)
    const before = clone(rho)

    const m = oracleU(-2.1, 0.7, 1.9)
    apply1q(rho, flatten(m), 2)
    apply1q(rho, flatten(adjoint(m)), 2)

    expectMatches(rho, toOracle(before), 'U† U ρ U† U')
  })
})
