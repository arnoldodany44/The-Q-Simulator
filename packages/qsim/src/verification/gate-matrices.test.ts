/**
 * Independent adversarial verification — lens: gate matrices.
 *
 * Nothing here is derived from `gates.ts` or from its own test file. The
 * reference values below come from the standard textbook definitions
 * (Nielsen & Chuang chapter 4, Qiskit's circuit library) written out by hand,
 * and from an obviously-correct-but-slow complex linear algebra kit built in
 * this file: naive O(n³) multiplication, Laplace-expansion determinants, and
 * a scaling-and-squaring matrix exponential. The implementation is then
 * checked against those, never the other way round.
 *
 * WHY THE MATRIX EXPONENTIAL. `Rx(θ) = [[cos(θ/2), -i·sin(θ/2)], …]` is
 * itself a closed form somebody derived; asserting it back at the code proves
 * only that two people copied the same table. The definition underneath is
 * `Rx(θ) = exp(-i·θ·X/2)`, so the rotation gates are checked against a
 * numerically summed exponential of the Pauli they rotate about. That is the
 * one check here that cannot share a blind spot with the implementation.
 *
 * WHY THE KERNEL APPEARS IN A MATRIX FILE. A matrix and the loop that reads
 * it can be transposed together and stay self-consistent, so entry-level
 * agreement with the textbook is not enough on its own. The last section
 * embeds each gate into a 3-qubit dense operator by brute force and compares
 * the kernel's output against it, which pins the flat layout to actual
 * physics.
 */

import fc from 'fast-check'
import { describe, expect, it } from 'vitest'

import { apply1q, apply2q } from '../apply.js'
import { bitOf } from '../conventions.js'
import {
  GATE_MATRICES,
  ISWAP_MATRIX,
  SWAP_MATRIX,
  dagger,
  isOneQubitGateId,
  matrixFor,
  pMatrix,
  rxMatrix,
  ryMatrix,
  rzMatrix,
  uMatrix,
  type Matrix2,
} from '../gates.js'
import { alloc, type Statevector } from '../statevector.js'

/* ───────────────── a slow, obviously-correct complex kit ───────────────── */

/** Decision D6 fixes the engine tolerance at 1e-10. */
const TOL = 1e-10

interface C {
  readonly re: number
  readonly im: number
}

/** A dense complex matrix, row-major, as plain objects. Slow on purpose. */
type M = readonly (readonly C[])[]

function c(re: number, im = 0): C {
  return { re, im }
}

/** `e^{iθ}`, so the reference entries read as phases rather than decimals. */
function phase(theta: number): C {
  return c(Math.cos(theta), Math.sin(theta))
}

function cadd(a: C, b: C): C {
  return c(a.re + b.re, a.im + b.im)
}

function csub(a: C, b: C): C {
  return c(a.re - b.re, a.im - b.im)
}

function cmul(a: C, b: C): C {
  return c(a.re * b.re - a.im * b.im, a.re * b.im + a.im * b.re)
}

function cdiv(a: C, b: C): C {
  const d = b.re * b.re + b.im * b.im
  return c((a.re * b.re + a.im * b.im) / d, (a.im * b.re - a.re * b.im) / d)
}

function cconj(a: C): C {
  return c(a.re, -a.im)
}

function cabs(a: C): number {
  return Math.hypot(a.re, a.im)
}

function eye(n: number): M {
  return Array.from({ length: n }, (_, row) =>
    Array.from({ length: n }, (_, column) => c(row === column ? 1 : 0))
  )
}

function matMul(a: M, b: M): M {
  const n = a.length
  return Array.from({ length: n }, (_, row) =>
    Array.from({ length: b[0].length }, (_, column) => {
      let sum = c(0)
      for (let k = 0; k < b.length; k++) {
        sum = cadd(sum, cmul(a[row][k], b[k][column]))
      }
      return sum
    })
  )
}

function matAdd(a: M, b: M): M {
  return a.map((row, r) => row.map((value, k) => cadd(value, b[r][k])))
}

function matScale(a: M, s: C): M {
  return a.map((row) => row.map((value) => cmul(value, s)))
}

function matDagger(a: M): M {
  return Array.from({ length: a[0].length }, (_, row) =>
    Array.from({ length: a.length }, (_, column) => cconj(a[column][row]))
  )
}

/** Laplace expansion. Exponential in `n`, which at n ≤ 4 is 24 terms. */
function det(a: M): C {
  const n = a.length
  if (n === 1) return a[0][0]
  let sum = c(0)
  for (let column = 0; column < n; column++) {
    const minor = a
      .slice(1)
      .map((row) => row.filter((_, index) => index !== column))
    const term = cmul(a[0][column], det(minor))
    sum = column % 2 === 0 ? cadd(sum, term) : csub(sum, term)
  }
  return sum
}

/** Largest absolute difference between two matrices of the same shape. */
function maxDiff(a: M, b: M): number {
  let worst = 0
  for (let row = 0; row < a.length; row++) {
    for (let column = 0; column < a[row].length; column++) {
      worst = Math.max(worst, cabs(csub(a[row][column], b[row][column])))
    }
  }
  return worst
}

/**
 * `exp(a)` by scaling and squaring: divide until the norm is small, sum the
 * Taylor series, then square back. Thirty terms at ‖a‖ ≤ 1/16 is well past
 * double precision, so this is exact for the purposes of a 1e-10 tolerance.
 */
function expm(a: M): M {
  let norm = 0
  for (const row of a) {
    norm = Math.max(
      norm,
      row.reduce((sum, value) => sum + cabs(value), 0)
    )
  }
  const squarings = Math.max(0, Math.ceil(Math.log2(norm + 1)) + 4)
  const scaled = matScale(a, c(2 ** -squarings))

  let result = eye(a.length)
  let term = eye(a.length)
  for (let k = 1; k <= 30; k++) {
    term = matScale(matMul(term, scaled), c(1 / k))
    result = matAdd(result, term)
  }
  for (let k = 0; k < squarings; k++) result = matMul(result, result)
  return result
}

/**
 * Read the package's flat interleaved buffer as a dense matrix, using the
 * layout documented in `gates.ts`: entry (r, c) of an n×n lives at
 * `(n·r + c)·2`, imaginary part next to it.
 */
function fromFlat(flat: Float64Array, n: number): M {
  return Array.from({ length: n }, (_, row) =>
    Array.from({ length: n }, (_, column) => {
      const at = (n * row + column) * 2
      return c(flat[at], flat[at + 1])
    })
  )
}

/** Whether `a` equals `b` after multiplying `b` by some unit-modulus scalar. */
function equalUpToPhase(a: M, b: M, tol = TOL): boolean {
  let ratio: C | undefined
  for (let row = 0; row < a.length && ratio === undefined; row++) {
    for (let column = 0; column < a.length; column++) {
      if (cabs(b[row][column]) > 1e-6) {
        ratio = cdiv(a[row][column], b[row][column])
        break
      }
    }
  }
  if (ratio === undefined) return false
  if (Math.abs(cabs(ratio) - 1) > tol) return false
  return maxDiff(a, matScale(b, ratio)) <= tol
}

/* ───────────── the textbook catalog, written out independently ──────────── */

const R = Math.SQRT1_2

/**
 * The standard definitions. Hand-typed from the literature, not read from the
 * implementation. `t` and `tdg` are spelled as phases rather than as √2/2 so
 * that a wrong quadrant would be visible here.
 */
const TEXTBOOK: Readonly<Record<string, M>> = {
  i: [
    [c(1), c(0)],
    [c(0), c(1)],
  ],
  x: [
    [c(0), c(1)],
    [c(1), c(0)],
  ],
  y: [
    [c(0), c(0, -1)],
    [c(0, 1), c(0)],
  ],
  z: [
    [c(1), c(0)],
    [c(0), c(-1)],
  ],
  h: [
    [c(R), c(R)],
    [c(R), c(-R)],
  ],
  s: [
    [c(1), c(0)],
    [c(0), c(0, 1)],
  ],
  sdg: [
    [c(1), c(0)],
    [c(0), c(0, -1)],
  ],
  t: [
    [c(1), c(0)],
    [c(0), phase(Math.PI / 4)],
  ],
  tdg: [
    [c(1), c(0)],
    [c(0), phase(-Math.PI / 4)],
  ],
  sx: [
    [c(0.5, 0.5), c(0.5, -0.5)],
    [c(0.5, -0.5), c(0.5, 0.5)],
  ],
}

const FIXED_IDS = [
  'i',
  'x',
  'y',
  'z',
  'h',
  's',
  'sdg',
  't',
  'tdg',
  'sx',
] as const

/** SWAP, spelled out in the basis order `2·b₁ + b₀` that `apply2q` uses. */
const SWAP_TEXTBOOK: M = [
  [c(1), c(0), c(0), c(0)],
  [c(0), c(0), c(1), c(0)],
  [c(0), c(1), c(0), c(0)],
  [c(0), c(0), c(0), c(1)],
]

const ISWAP_TEXTBOOK: M = [
  [c(1), c(0), c(0), c(0)],
  [c(0), c(0), c(0, 1), c(0)],
  [c(0), c(0, 1), c(0), c(0)],
  [c(0), c(0), c(0), c(1)],
]

/** Angles that exercise the quadrants, the zeros and the wrap-arounds. */
const ANGLES = [
  0,
  1e-12,
  1e-8,
  0.1,
  Math.PI / 8,
  Math.PI / 4,
  Math.PI / 3,
  Math.PI / 2,
  (2 * Math.PI) / 3,
  Math.PI,
  (3 * Math.PI) / 2,
  2 * Math.PI,
  3 * Math.PI,
  -Math.PI / 2,
  -Math.PI,
  -7.3,
  12.5,
]

/* ─────────────────────── entry-by-entry agreement ─────────────────────── */

describe('fixed gates match the textbook entry for entry', () => {
  it.each(FIXED_IDS)('%s', (id) => {
    const actual = GATE_MATRICES[id]
    expect(actual.length).toBe(8)
    expect(maxDiff(fromFlat(actual, 2), TEXTBOOK[id])).toBeLessThanOrEqual(TOL)
  })

  it('catalogs exactly the ten unparametrised gates of §3.1', () => {
    expect(Object.keys(GATE_MATRICES).sort()).toEqual([...FIXED_IDS].sort())
  })

  it('gives every gate its own buffer, so a mutation cannot spread', () => {
    const buffers = FIXED_IDS.map((id) => GATE_MATRICES[id])
    expect(new Set(buffers).size).toBe(FIXED_IDS.length)
    expect(SWAP_MATRIX).not.toBe(ISWAP_MATRIX)
  })
})

describe('the two-qubit constants match the textbook', () => {
  it('SWAP', () => {
    expect(SWAP_MATRIX.length).toBe(32)
    expect(
      maxDiff(fromFlat(SWAP_MATRIX, 4), SWAP_TEXTBOOK)
    ).toBeLessThanOrEqual(TOL)
  })

  it('iSWAP', () => {
    expect(ISWAP_MATRIX.length).toBe(32)
    expect(
      maxDiff(fromFlat(ISWAP_MATRIX, 4), ISWAP_TEXTBOOK)
    ).toBeLessThanOrEqual(TOL)
  })
})

/* ──────────────────────────── unitarity ─────────────────────────────── */

/** Every matrix the catalog can produce, labelled, for the sweeps below. */
function everyMatrix(): { label: string; n: number; flat: Float64Array }[] {
  const all: { label: string; n: number; flat: Float64Array }[] = []
  for (const id of FIXED_IDS)
    all.push({ label: id, n: 2, flat: GATE_MATRICES[id] })
  all.push({ label: 'swap', n: 4, flat: SWAP_MATRIX })
  all.push({ label: 'iswap', n: 4, flat: ISWAP_MATRIX })
  for (const theta of ANGLES) {
    all.push({ label: `rx(${theta})`, n: 2, flat: rxMatrix(theta) })
    all.push({ label: `ry(${theta})`, n: 2, flat: ryMatrix(theta) })
    all.push({ label: `rz(${theta})`, n: 2, flat: rzMatrix(theta) })
    all.push({ label: `p(${theta})`, n: 2, flat: pMatrix(theta) })
    for (const phi of [0, 0.7, Math.PI / 2, -2.4]) {
      for (const lambda of [0, 1.3, Math.PI, -0.9]) {
        all.push({
          label: `u(${theta},${phi},${lambda})`,
          n: 2,
          flat: uMatrix(theta, phi, lambda),
        })
      }
    }
  }
  return all
}

describe('unitarity and determinant modulus', () => {
  it('U·U† = I for every matrix in the catalog', () => {
    for (const { label, n, flat } of everyMatrix()) {
      const m = fromFlat(flat, n)
      const worst = Math.max(
        maxDiff(matMul(m, matDagger(m)), eye(n)),
        maxDiff(matMul(matDagger(m), m), eye(n))
      )
      expect(worst, `${label} is not unitary`).toBeLessThanOrEqual(TOL)
    }
  })

  it('|det| = 1 for every matrix in the catalog', () => {
    for (const { label, n, flat } of everyMatrix()) {
      const modulus = cabs(det(fromFlat(flat, n)))
      expect(modulus, `|det ${label}|`).toBeCloseTo(1, 10)
    }
  })

  it('the rotation gates live in SU(2): det is exactly 1', () => {
    for (const theta of ANGLES) {
      for (const build of [rxMatrix, ryMatrix, rzMatrix]) {
        const d = det(fromFlat(build(theta), 2))
        expect(cabs(csub(d, c(1)))).toBeLessThanOrEqual(TOL)
      }
    }
  })

  it('det P(φ) = e^{iφ} and det U(θ,φ,λ) = e^{i(φ+λ)}', () => {
    for (const theta of ANGLES) {
      expect(
        cabs(csub(det(fromFlat(pMatrix(theta), 2)), phase(theta)))
      ).toBeLessThanOrEqual(TOL)
      const d = det(fromFlat(uMatrix(theta, 0.7, -1.9), 2))
      expect(cabs(csub(d, phase(0.7 - 1.9)))).toBeLessThanOrEqual(TOL)
    }
  })

  it('stays unitary at random angles (fast-check)', () => {
    fc.assert(
      fc.property(
        fc.double({ min: -50, max: 50, noNaN: true }),
        fc.double({ min: -50, max: 50, noNaN: true }),
        fc.double({ min: -50, max: 50, noNaN: true }),
        (theta, phi, lambda) => {
          for (const flat of [
            rxMatrix(theta),
            ryMatrix(theta),
            rzMatrix(theta),
            pMatrix(theta),
            uMatrix(theta, phi, lambda),
          ]) {
            const m = fromFlat(flat, 2)
            expect(
              maxDiff(matMul(m, matDagger(m)), eye(2))
            ).toBeLessThanOrEqual(TOL)
          }
        }
      ),
      { numRuns: 300 }
    )
  })
})

/* ─────────────────── the algebraic identities of §13 ────────────────── */

function ref(id: (typeof FIXED_IDS)[number]): M {
  return fromFlat(GATE_MATRICES[id], 2)
}

describe('gate algebra', () => {
  it('S² = Z', () => {
    expect(maxDiff(matMul(ref('s'), ref('s')), ref('z'))).toBeLessThanOrEqual(
      TOL
    )
  })

  it('T² = S', () => {
    expect(maxDiff(matMul(ref('t'), ref('t')), ref('s'))).toBeLessThanOrEqual(
      TOL
    )
  })

  it('T⁸ = I', () => {
    let acc = eye(2)
    for (let k = 0; k < 8; k++) acc = matMul(acc, ref('t'))
    expect(maxDiff(acc, eye(2))).toBeLessThanOrEqual(TOL)
  })

  it('SX² = X', () => {
    expect(maxDiff(matMul(ref('sx'), ref('sx')), ref('x'))).toBeLessThanOrEqual(
      TOL
    )
  })

  it('H² = I and X² = Y² = Z² = I', () => {
    for (const id of ['h', 'x', 'y', 'z'] as const) {
      expect(maxDiff(matMul(ref(id), ref(id)), eye(2))).toBeLessThanOrEqual(TOL)
    }
  })

  it('X·Y·Z = i·I', () => {
    const product = matMul(matMul(ref('x'), ref('y')), ref('z'))
    expect(maxDiff(product, matScale(eye(2), c(0, 1)))).toBeLessThanOrEqual(TOL)
  })

  it('the daggered gates really are the inverses they are named for', () => {
    expect(maxDiff(matMul(ref('s'), ref('sdg')), eye(2))).toBeLessThanOrEqual(
      TOL
    )
    expect(maxDiff(matMul(ref('t'), ref('tdg')), eye(2))).toBeLessThanOrEqual(
      TOL
    )
  })

  it('H conjugates the Paulis: HXH = Z, HZH = X, HYH = -Y', () => {
    const h = ref('h')
    expect(
      maxDiff(matMul(matMul(h, ref('x')), h), ref('z'))
    ).toBeLessThanOrEqual(TOL)
    expect(
      maxDiff(matMul(matMul(h, ref('z')), h), ref('x'))
    ).toBeLessThanOrEqual(TOL)
    expect(
      maxDiff(matMul(matMul(h, ref('y')), h), matScale(ref('y'), c(-1)))
    ).toBeLessThanOrEqual(TOL)
  })

  it('H = (X + Z)/√2', () => {
    expect(
      maxDiff(matScale(matAdd(ref('x'), ref('z')), c(R)), ref('h'))
    ).toBeLessThanOrEqual(TOL)
  })

  it('SWAP² = I and iSWAP² = the Z⊗Z-phased swap-free operator', () => {
    const swap = fromFlat(SWAP_MATRIX, 4)
    expect(maxDiff(matMul(swap, swap), eye(4))).toBeLessThanOrEqual(TOL)
    // iSWAP² leaves |00⟩ and |11⟩ alone and negates |01⟩ and |10⟩.
    const iswap = fromFlat(ISWAP_MATRIX, 4)
    const expected: M = [
      [c(1), c(0), c(0), c(0)],
      [c(0), c(-1), c(0), c(0)],
      [c(0), c(0), c(-1), c(0)],
      [c(0), c(0), c(0), c(1)],
    ]
    expect(maxDiff(matMul(iswap, iswap), expected)).toBeLessThanOrEqual(TOL)
  })
})

/* ───────── rotations against a numerically summed exponential ────────── */

describe('the rotation gates are the exponentials they claim to be', () => {
  it('Rx(θ) = exp(-i·θ·X/2)', () => {
    for (const theta of ANGLES) {
      const expected = expm(matScale(TEXTBOOK.x, c(0, -theta / 2)))
      expect(
        maxDiff(fromFlat(rxMatrix(theta), 2), expected),
        `Rx(${theta})`
      ).toBeLessThanOrEqual(TOL)
    }
  })

  it('Ry(θ) = exp(-i·θ·Y/2)', () => {
    for (const theta of ANGLES) {
      const expected = expm(matScale(TEXTBOOK.y, c(0, -theta / 2)))
      expect(
        maxDiff(fromFlat(ryMatrix(theta), 2), expected),
        `Ry(${theta})`
      ).toBeLessThanOrEqual(TOL)
    }
  })

  it('Rz(θ) = exp(-i·θ·Z/2)', () => {
    for (const theta of ANGLES) {
      const expected = expm(matScale(TEXTBOOK.z, c(0, -theta / 2)))
      expect(
        maxDiff(fromFlat(rzMatrix(theta), 2), expected),
        `Rz(${theta})`
      ).toBeLessThanOrEqual(TOL)
    }
  })

  it('P(φ) = exp(i·φ·|1⟩⟨1|)', () => {
    const projector: M = [
      [c(0), c(0)],
      [c(0), c(1)],
    ]
    for (const phi of ANGLES) {
      const expected = expm(matScale(projector, c(0, phi)))
      expect(
        maxDiff(fromFlat(pMatrix(phi), 2), expected),
        `P(${phi})`
      ).toBeLessThanOrEqual(TOL)
    }
  })
})

/* ───────────────── special and small angles, spelled out ────────────── */

describe('special angles', () => {
  it('Rz(π) = Z up to a global phase, and the phase is e^{-iπ/2}', () => {
    const actual = fromFlat(rzMatrix(Math.PI), 2)
    expect(equalUpToPhase(actual, TEXTBOOK.z)).toBe(true)
    expect(
      maxDiff(actual, matScale(TEXTBOOK.z, phase(-Math.PI / 2)))
    ).toBeLessThanOrEqual(TOL)
  })

  it('Rx(π) = -i·X, Ry(π) = -i·Y', () => {
    expect(
      maxDiff(fromFlat(rxMatrix(Math.PI), 2), matScale(TEXTBOOK.x, c(0, -1)))
    ).toBeLessThanOrEqual(TOL)
    expect(
      maxDiff(fromFlat(ryMatrix(Math.PI), 2), matScale(TEXTBOOK.y, c(0, -1)))
    ).toBeLessThanOrEqual(TOL)
  })

  it('a 2π rotation is -I, not I — the half angle is really there', () => {
    for (const build of [rxMatrix, ryMatrix, rzMatrix]) {
      expect(
        maxDiff(fromFlat(build(2 * Math.PI), 2), matScale(eye(2), c(-1)))
      ).toBeLessThanOrEqual(TOL)
      expect(
        maxDiff(fromFlat(build(4 * Math.PI), 2), eye(2))
      ).toBeLessThanOrEqual(TOL)
    }
  })

  it('a 0 rotation is exactly the identity', () => {
    for (const build of [rxMatrix, ryMatrix, rzMatrix]) {
      expect(maxDiff(fromFlat(build(0), 2), eye(2))).toBe(0)
    }
    expect(maxDiff(fromFlat(pMatrix(0), 2), eye(2))).toBe(0)
    expect(maxDiff(fromFlat(uMatrix(0, 0, 0), 2), eye(2))).toBe(0)
  })

  it('P hits Z, S, T and S† at the quarter turns', () => {
    expect(
      maxDiff(fromFlat(pMatrix(Math.PI), 2), TEXTBOOK.z)
    ).toBeLessThanOrEqual(TOL)
    expect(
      maxDiff(fromFlat(pMatrix(Math.PI / 2), 2), TEXTBOOK.s)
    ).toBeLessThanOrEqual(TOL)
    expect(
      maxDiff(fromFlat(pMatrix(Math.PI / 4), 2), TEXTBOOK.t)
    ).toBeLessThanOrEqual(TOL)
    expect(
      maxDiff(fromFlat(pMatrix(-Math.PI / 2), 2), TEXTBOOK.sdg)
    ).toBeLessThanOrEqual(TOL)
    expect(
      maxDiff(fromFlat(pMatrix(-Math.PI / 4), 2), TEXTBOOK.tdg)
    ).toBeLessThanOrEqual(TOL)
  })

  it('SX = e^{iπ/4}·Rx(π/2)', () => {
    expect(
      maxDiff(
        fromFlat(GATE_MATRICES.sx, 2),
        matScale(fromFlat(rxMatrix(Math.PI / 2), 2), phase(Math.PI / 4))
      )
    ).toBeLessThanOrEqual(TOL)
  })

  it('Ry(π/2) rotates |0⟩ onto |+⟩ and Ry(-π/2) onto |−⟩', () => {
    const plus = fromFlat(ryMatrix(Math.PI / 2), 2)
    expect(plus[0][0].re).toBeCloseTo(R, 12)
    expect(plus[1][0].re).toBeCloseTo(R, 12)
    const minus = fromFlat(ryMatrix(-Math.PI / 2), 2)
    expect(minus[0][0].re).toBeCloseTo(R, 12)
    expect(minus[1][0].re).toBeCloseTo(-R, 12)
  })

  it('small angles keep the half factor to full relative precision', () => {
    for (const eps of [1e-4, 1e-8, 1e-12, 1e-15]) {
      const rx = fromFlat(rxMatrix(eps), 2)
      // First order: Rx(ε) ≈ I − i·(ε/2)·X, so the off-diagonal is −i·ε/2.
      expect(rx[0][1].im / (-eps / 2)).toBeCloseTo(1, 8)
      expect(rx[1][0].im / (-eps / 2)).toBeCloseTo(1, 8)
      expect(rx[0][0].re).toBe(Math.cos(eps / 2))

      const ry = fromFlat(ryMatrix(eps), 2)
      expect(ry[1][0].re / (eps / 2)).toBeCloseTo(1, 8)
      expect(ry[0][1].re / (-eps / 2)).toBeCloseTo(1, 8)

      const rz = fromFlat(rzMatrix(eps), 2)
      expect(rz[0][0].im / (-eps / 2)).toBeCloseTo(1, 8)
      expect(rz[1][1].im / (eps / 2)).toBeCloseTo(1, 8)

      const p = fromFlat(pMatrix(eps), 2)
      expect(p[1][1].im / eps).toBeCloseTo(1, 8)
    }
  })

  it('the second-order diagonal deficit is ε²/8, not ε²/2', () => {
    // 1 − cos(ε/2) = ε²/8 + O(ε⁴). A full-angle rotation would give ε²/2, so
    // this is the half angle showing up on the diagonal rather than in the
    // off-diagonal sine. Only ε where ε²/8 is comfortably above the double
    // epsilon: at ε = 1e-8 the deficit is 1.25e-17 and rounds away entirely.
    for (const eps of [1e-3, 1e-4]) {
      for (const build of [rxMatrix, ryMatrix, rzMatrix]) {
        const diagonal = fromFlat(build(eps), 2)[0][0].re
        expect((1 - diagonal) / (eps * eps * 0.125), `${eps}`).toBeCloseTo(1, 6)
      }
    }
  })
})

/* ─────────────── U(θ,φ,λ) reproduces the rest of the family ───────────── */

describe('U(θ,φ,λ) is the universal one-qubit gate it claims to be', () => {
  it('matches the Qiskit closed form entry for entry', () => {
    fc.assert(
      fc.property(
        fc.double({ min: -20, max: 20, noNaN: true }),
        fc.double({ min: -20, max: 20, noNaN: true }),
        fc.double({ min: -20, max: 20, noNaN: true }),
        (theta, phi, lambda) => {
          const cosine = Math.cos(theta / 2)
          const sine = Math.sin(theta / 2)
          const expected: M = [
            [c(cosine), matScale([[phase(lambda)]], c(-sine))[0][0]],
            [cmul(phase(phi), c(sine)), cmul(phase(phi + lambda), c(cosine))],
          ]
          expect(
            maxDiff(fromFlat(uMatrix(theta, phi, lambda), 2), expected)
          ).toBeLessThanOrEqual(TOL)
        }
      ),
      { numRuns: 300 }
    )
  })

  it('U(π,0,π) = X', () => {
    expect(
      maxDiff(fromFlat(uMatrix(Math.PI, 0, Math.PI), 2), TEXTBOOK.x)
    ).toBeLessThanOrEqual(TOL)
  })

  it('U(π,π/2,π/2) = Y', () => {
    expect(
      maxDiff(
        fromFlat(uMatrix(Math.PI, Math.PI / 2, Math.PI / 2), 2),
        TEXTBOOK.y
      )
    ).toBeLessThanOrEqual(TOL)
  })

  it('U(π/2,0,π) = H', () => {
    expect(
      maxDiff(fromFlat(uMatrix(Math.PI / 2, 0, Math.PI), 2), TEXTBOOK.h)
    ).toBeLessThanOrEqual(TOL)
  })

  it('U(0,0,λ) = P(λ), exactly and for every λ', () => {
    for (const lambda of ANGLES) {
      expect(
        maxDiff(
          fromFlat(uMatrix(0, 0, lambda), 2),
          fromFlat(pMatrix(lambda), 2)
        ),
        `λ = ${lambda}`
      ).toBeLessThanOrEqual(TOL)
    }
  })

  it('U(0,0,π/2) = S, U(0,0,π/4) = T, U(0,0,π) = Z', () => {
    expect(
      maxDiff(fromFlat(uMatrix(0, 0, Math.PI / 2), 2), TEXTBOOK.s)
    ).toBeLessThanOrEqual(TOL)
    expect(
      maxDiff(fromFlat(uMatrix(0, 0, Math.PI / 4), 2), TEXTBOOK.t)
    ).toBeLessThanOrEqual(TOL)
    expect(
      maxDiff(fromFlat(uMatrix(0, 0, Math.PI), 2), TEXTBOOK.z)
    ).toBeLessThanOrEqual(TOL)
  })

  it('U(θ,-π/2,π/2) = Rx(θ) with no phase left over', () => {
    for (const theta of ANGLES) {
      expect(
        maxDiff(
          fromFlat(uMatrix(theta, -Math.PI / 2, Math.PI / 2), 2),
          fromFlat(rxMatrix(theta), 2)
        ),
        `θ = ${theta}`
      ).toBeLessThanOrEqual(TOL)
    }
  })

  it('U(θ,0,0) = Ry(θ) with no phase left over', () => {
    for (const theta of ANGLES) {
      expect(
        maxDiff(
          fromFlat(uMatrix(theta, 0, 0), 2),
          fromFlat(ryMatrix(theta), 2)
        ),
        `θ = ${theta}`
      ).toBeLessThanOrEqual(TOL)
    }
  })

  it('U(0,0,θ) = e^{iθ/2}·Rz(θ) — the global phase Qiskit carries', () => {
    for (const theta of ANGLES) {
      expect(
        maxDiff(
          fromFlat(uMatrix(0, 0, theta), 2),
          matScale(fromFlat(rzMatrix(theta), 2), phase(theta / 2))
        ),
        `θ = ${theta}`
      ).toBeLessThanOrEqual(TOL)
    }
  })

  it('U(π/2,-π/2,π/2) = SX up to the phase e^{-iπ/4}', () => {
    const u = fromFlat(uMatrix(Math.PI / 2, -Math.PI / 2, Math.PI / 2), 2)
    expect(equalUpToPhase(fromFlat(GATE_MATRICES.sx, 2), u)).toBe(true)
    expect(
      maxDiff(u, matScale(fromFlat(GATE_MATRICES.sx, 2), phase(-Math.PI / 4)))
    ).toBeLessThanOrEqual(TOL)
  })

  it('U(θ,φ,λ)† = U(-θ,-λ,-φ)', () => {
    fc.assert(
      fc.property(
        fc.double({ min: -10, max: 10, noNaN: true }),
        fc.double({ min: -10, max: 10, noNaN: true }),
        fc.double({ min: -10, max: 10, noNaN: true }),
        (theta, phi, lambda) => {
          expect(
            maxDiff(
              matDagger(fromFlat(uMatrix(theta, phi, lambda), 2)),
              fromFlat(uMatrix(-theta, -lambda, -phi), 2)
            )
          ).toBeLessThanOrEqual(TOL)
        }
      ),
      { numRuns: 200 }
    )
  })
})

/* ──────────────────────────── dagger() ──────────────────────────────── */

describe('dagger is the conjugate transpose', () => {
  it('agrees with the reference on every catalog matrix', () => {
    for (const { label, flat } of everyMatrix().filter((e) => e.n === 2)) {
      expect(
        maxDiff(fromFlat(dagger(flat), 2), matDagger(fromFlat(flat, 2))),
        label
      ).toBeLessThanOrEqual(TOL)
    }
  })

  it('agrees on arbitrary non-unitary matrices (fast-check)', () => {
    fc.assert(
      fc.property(
        fc.array(fc.double({ min: -5, max: 5, noNaN: true }), {
          minLength: 8,
          maxLength: 8,
        }),
        (values) => {
          const flat = new Float64Array(values)
          expect(
            maxDiff(fromFlat(dagger(flat), 2), matDagger(fromFlat(flat, 2)))
          ).toBe(0)
        }
      ),
      { numRuns: 200 }
    )
  })

  it('inverts the parametrised gates by negating their angles', () => {
    for (const theta of ANGLES) {
      expect(
        maxDiff(
          fromFlat(dagger(rxMatrix(theta)), 2),
          fromFlat(rxMatrix(-theta), 2)
        )
      ).toBeLessThanOrEqual(TOL)
      expect(
        maxDiff(
          fromFlat(dagger(ryMatrix(theta)), 2),
          fromFlat(ryMatrix(-theta), 2)
        )
      ).toBeLessThanOrEqual(TOL)
      expect(
        maxDiff(
          fromFlat(dagger(rzMatrix(theta)), 2),
          fromFlat(rzMatrix(-theta), 2)
        )
      ).toBeLessThanOrEqual(TOL)
      expect(
        maxDiff(
          fromFlat(dagger(pMatrix(theta)), 2),
          fromFlat(pMatrix(-theta), 2)
        )
      ).toBeLessThanOrEqual(TOL)
    }
  })

  it('refuses a 4×4 rather than silently returning a wrong 2×2', () => {
    expect(() => dagger(SWAP_MATRIX)).toThrow(RangeError)
  })
})

/* ──────────────────────── the matrixFor dispatch ───────────────────── */

describe('matrixFor resolves the catalog', () => {
  it.each(FIXED_IDS)('%s returns the shared catalog constant', (id) => {
    expect(matrixFor(id)).toBe(GATE_MATRICES[id])
  })

  it('resolves the parametrised gates positionally, as §6 names them', () => {
    expect(Array.from(matrixFor('rx', [0.7]))).toEqual(
      Array.from(rxMatrix(0.7))
    )
    expect(Array.from(matrixFor('ry', [0.7]))).toEqual(
      Array.from(ryMatrix(0.7))
    )
    expect(Array.from(matrixFor('rz', [0.7]))).toEqual(
      Array.from(rzMatrix(0.7))
    )
    expect(Array.from(matrixFor('p', [0.7]))).toEqual(Array.from(pMatrix(0.7)))
    // paramNames is ['theta', 'phi', 'lambda'] — that order, not any other.
    expect(Array.from(matrixFor('u', [0.7, 1.1, -0.3]))).toEqual(
      Array.from(uMatrix(0.7, 1.1, -0.3))
    )
  })

  it('throws rather than defaulting a missing or extra angle', () => {
    expect(() => matrixFor('rx')).toThrow(RangeError)
    expect(() => matrixFor('rx', [])).toThrow(RangeError)
    expect(() => matrixFor('rx', [0.1, 0.2])).toThrow(RangeError)
    expect(() => matrixFor('u', [0.1, 0.2])).toThrow(RangeError)
    expect(() => matrixFor('u', [0.1, 0.2, 0.3, 0.4])).toThrow(RangeError)
  })

  it('throws on a non-finite angle', () => {
    expect(() => matrixFor('rz', [Number.NaN])).toThrow(RangeError)
    expect(() => matrixFor('rz', [Number.POSITIVE_INFINITY])).toThrow(
      RangeError
    )
    expect(() => matrixFor('u', [0, Number.NaN, 0])).toThrow(RangeError)
  })

  it('rejects parameters on a gate that takes none', () => {
    // `x` has paramCount 0 in the contract. Accepting an angle here means a
    // circuit that carries one is simulated as though it did not, and the
    // runner hands every one-qubit gate's params straight to this function.
    expect(() => matrixFor('x', [0.5])).toThrow(RangeError)
  })

  it('isOneQubitGateId accepts exactly the fifteen 2×2 gates', () => {
    for (const id of [...FIXED_IDS, 'rx', 'ry', 'rz', 'p', 'u']) {
      expect(isOneQubitGateId(id), id).toBe(true)
    }
    for (const id of [
      'cx',
      'cz',
      'swap',
      'iswap',
      'crz',
      'cp',
      'ccx',
      'cswap',
      'barrier',
      'reset',
      'measure',
      'X',
      'H',
      '',
      'toString',
    ]) {
      expect(isOneQubitGateId(id), id).toBe(false)
    }
  })
})

/* ────────── the flat layout, pinned to physics through the kernel ─────── */

/**
 * Embed a 2×2 into an n-qubit dense operator by brute force: entry (i, j) is
 * `m[bit(i,t)][bit(j,t)]` when i and j agree on every other qubit, and zero
 * otherwise. This is the Kronecker product §5.2 forbids the engine from
 * building — which is exactly why it belongs in a test as the oracle.
 */
function embed1q(m: M, qubits: number, target: number): M {
  const size = 1 << qubits
  const rest = ~(1 << target)
  return Array.from({ length: size }, (_, row) =>
    Array.from({ length: size }, (_, column) =>
      (row & rest) === (column & rest)
        ? m[bitOf(row, target)][bitOf(column, target)]
        : c(0)
    )
  )
}

/** Same idea for a 4×4, with the local index `2·b(q1) + b(q0)` of §5.2. */
function embed2q(m: M, qubits: number, q0: number, q1: number): M {
  const size = 1 << qubits
  const rest = ~((1 << q0) | (1 << q1))
  const local = (index: number): number =>
    2 * bitOf(index, q1) + bitOf(index, q0)
  return Array.from({ length: size }, (_, row) =>
    Array.from({ length: size }, (_, column) =>
      (row & rest) === (column & rest) ? m[local(row)][local(column)] : c(0)
    )
  )
}

/** A reproducible, non-degenerate test vector. Normalisation is irrelevant. */
function seededVector(size: number): { re: Float64Array; im: Float64Array } {
  const re = new Float64Array(size)
  const im = new Float64Array(size)
  let seed = 0x2f6e2b1
  const next = (): number => {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff
    return seed / 0x7fffffff - 0.5
  }
  for (let k = 0; k < size; k++) {
    re[k] = next()
    im[k] = next()
  }
  return { re, im }
}

function stateWith(qubits: number): Statevector {
  const state = alloc(qubits)
  const { re, im } = seededVector(state.size)
  state.re.set(re)
  state.im.set(im)
  return state
}

/** Dense matrix times vector, the slow way. */
function denseApply(
  m: M,
  re: Float64Array,
  im: Float64Array
): { re: number[]; im: number[] } {
  const outRe: number[] = []
  const outIm: number[] = []
  for (let row = 0; row < m.length; row++) {
    let sum = c(0)
    for (let column = 0; column < m.length; column++) {
      sum = cadd(sum, cmul(m[row][column], c(re[column], im[column])))
    }
    outRe.push(sum.re)
    outIm.push(sum.im)
  }
  return { re: outRe, im: outIm }
}

function expectSameState(
  state: Statevector,
  expected: { re: number[]; im: number[] },
  label: string
): void {
  for (let k = 0; k < state.size; k++) {
    expect(state.re[k], `${label} re[${k}]`).toBeCloseTo(expected.re[k], 12)
    expect(state.im[k], `${label} im[${k}]`).toBeCloseTo(expected.im[k], 12)
  }
}

describe('the flat layout means what the header says it means', () => {
  it.each(FIXED_IDS)(
    '%s acts on a 3-qubit state exactly as its dense embedding does',
    (id) => {
      for (const target of [0, 1, 2]) {
        const state = stateWith(3)
        const expected = denseApply(
          embed1q(TEXTBOOK[id], 3, target),
          new Float64Array(state.re),
          new Float64Array(state.im)
        )
        apply1q(state, GATE_MATRICES[id], target)
        expectSameState(state, expected, `${id} on q${target}`)
      }
    }
  )

  it('the parametrised gates do too', () => {
    const cases: { label: string; flat: Matrix2; m: M }[] = []
    const theta = 0.9
    cases.push({
      label: 'rx',
      flat: rxMatrix(theta),
      m: expm(matScale(TEXTBOOK.x, c(0, -theta / 2))),
    })
    cases.push({
      label: 'ry',
      flat: ryMatrix(theta),
      m: expm(matScale(TEXTBOOK.y, c(0, -theta / 2))),
    })
    cases.push({
      label: 'rz',
      flat: rzMatrix(theta),
      m: expm(matScale(TEXTBOOK.z, c(0, -theta / 2))),
    })
    cases.push({
      label: 'p',
      flat: pMatrix(theta),
      m: [
        [c(1), c(0)],
        [c(0), phase(theta)],
      ],
    })
    cases.push({
      label: 'u',
      flat: uMatrix(0.9, 1.4, -0.6),
      m: [
        [
          c(Math.cos(0.45)),
          matScale([[phase(-0.6)]], c(-Math.sin(0.45)))[0][0],
        ],
        [
          cmul(phase(1.4), c(Math.sin(0.45))),
          cmul(phase(1.4 - 0.6), c(Math.cos(0.45))),
        ],
      ],
    })

    for (const { label, flat, m } of cases) {
      for (const target of [0, 1, 2]) {
        const state = stateWith(3)
        const expected = denseApply(
          embed1q(m, 3, target),
          new Float64Array(state.re),
          new Float64Array(state.im)
        )
        apply1q(state, flat, target)
        expectSameState(state, expected, `${label} on q${target}`)
      }
    }
  })

  it('SWAP_MATRIX and ISWAP_MATRIX act as the textbook 4×4 does', () => {
    for (const [label, m] of [
      ['swap', SWAP_TEXTBOOK],
      ['iswap', ISWAP_TEXTBOOK],
    ] as const) {
      for (const [q0, q1] of [
        [0, 1],
        [1, 0],
        [0, 2],
        [2, 1],
      ]) {
        const state = stateWith(3)
        const expected = denseApply(
          embed2q(m, 3, q0, q1),
          new Float64Array(state.re),
          new Float64Array(state.im)
        )
        apply2q(state, label === 'swap' ? SWAP_MATRIX : ISWAP_MATRIX, q0, q1)
        expectSameState(state, expected, `${label} on (${q0},${q1})`)
      }
    }
  })

  it('a deliberately asymmetric 4×4 pins the basis order 2·b₁ + b₀', () => {
    // CNOT with the control on the FIRST argument. In the basis order the
    // header claims, that is the permutation |b₁ b₀⟩ → |b₁⊕b₀ , b₀⟩:
    // row 0←0, row 3←1, row 2←2, row 1←3.
    const cnotOnFirst: M = [
      [c(1), c(0), c(0), c(0)],
      [c(0), c(0), c(0), c(1)],
      [c(0), c(0), c(1), c(0)],
      [c(0), c(1), c(0), c(0)],
    ]
    const flat = new Float64Array(32)
    for (let row = 0; row < 4; row++) {
      for (let column = 0; column < 4; column++) {
        flat[(row * 4 + column) * 2] = cnotOnFirst[row][column].re
        flat[(row * 4 + column) * 2 + 1] = cnotOnFirst[row][column].im
      }
    }
    const state = stateWith(3)
    const expected = denseApply(
      embed2q(cnotOnFirst, 3, 0, 1),
      new Float64Array(state.re),
      new Float64Array(state.im)
    )
    apply2q(state, flat, 0, 1)
    expectSameState(state, expected, 'cnot(control=q0, target=q1)')

    // And it really is the CNOT: control q0, target q1 flips index 1 → 3.
    const ket = alloc(3)
    ket.re[0] = 0
    ket.re[1] = 1
    apply2q(ket, flat, 0, 1)
    expect(Array.from(ket.re)).toEqual([0, 0, 0, 1, 0, 0, 0, 0])
  })
})
