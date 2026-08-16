/**
 * The Hermitian eigensolver, against spectra that are known on paper and
 * against matrices rebuilt from their own eigenpairs.
 *
 * WHY THIS FILE IS LONGER THAN THE MODULE IT TESTS. An eigensolver has the
 * worst failure mode in the package: it returns `dim` finite, sorted, entirely
 * plausible numbers whatever it does. There is no norm to violate, no trace to
 * check, no exception to throw. So every test below pins the answer from
 * outside the module:
 *
 *   1. **Known spectra.** The Paulis, a projector, a graded 2×2 — matrices
 *      whose eigenvalues can be written down and whose eigenvectors can be
 *      named. The complex ones (Y, and anything with an imaginary
 *      off-diagonal) are the ones that exercise the phase step, which is the
 *      half of each rotation a real Jacobi implementation does not have.
 *   2. **Degeneracy.** A repeated eigenvalue has no unique eigenvector, so the
 *      only thing to assert is that whatever came back is an orthonormal basis
 *      of the right eigenspace. An implementation that quietly returns the
 *      same vector twice passes an eigenvalue check and fails this one.
 *   3. **Reconstruction.** V Λ V† must be the matrix that went in, entry for
 *      entry. This is the assertion with the most teeth in the file: it fails
 *      if a single eigenvector is paired with the wrong eigenvalue, if the
 *      sort permutation is applied to one array and not the other, or if the
 *      transposed internal store is transposed back the wrong way — three
 *      defects that leave the spectrum perfectly correct.
 *   4. **The reason the method is Jacobi at all.** One test drives an
 *      eigenvalue twelve orders of magnitude below the largest and demands
 *      *relative* accuracy on it. That is the Demmel–Veselić property the
 *      header claims, it is what entropy needs (λ log λ weights the small
 *      eigenvalues), and a tridiagonal-QL implementation would fail it while
 *      passing everything else here.
 *   5. **Subnormals.** One describe below is a regression test for a defect
 *      this file's approach found and nothing else would have: an entry of
 *      1e-322 made the phase rotation non-unitary and moved the spectrum by
 *      7e-10, silently. Its story is written where it sits.
 */

import { describe, expect, it } from 'vitest'

import {
  EigenTooLargeError,
  MAX_EIGEN_DIM,
  NotHermitianError,
  eigenHermitian,
  eigenvaluesHermitian,
  type Eigensystem,
  type HermitianMatrix,
} from './eigen.js'
import { createRng } from './rng.js'

/** Decision D6: tolerance 1e-10, as digits for `toBeCloseTo`. */
const DIGITS = 10

/** A matrix from nested rows of `[re, im]` pairs. Readable, and slow. */
function hermitian(
  rows: readonly (readonly (readonly [number, number])[])[]
): HermitianMatrix {
  const dim = rows.length
  const re = new Float64Array(dim * dim)
  const im = new Float64Array(dim * dim)
  for (let r = 0; r < dim; r++) {
    for (let c = 0; c < dim; c++) {
      re[r * dim + c] = rows[r][c][0]
      im[r * dim + c] = rows[r][c][1]
    }
  }
  return { dim, re, im }
}

/** A diagonal matrix from its diagonal. */
function diagonal(values: readonly number[]): HermitianMatrix {
  const dim = values.length
  const re = new Float64Array(dim * dim)
  const im = new Float64Array(dim * dim)
  for (let i = 0; i < dim; i++) re[i * dim + i] = values[i]
  return { dim, re, im }
}

/**
 * A pseudo-random Hermitian matrix, seeded so a failure is reproducible.
 *
 * Built by writing the upper triangle and mirroring it with a conjugate, so
 * the input is Hermitian to the last bit and the solver's input guard is
 * never what is being tested.
 */
function randomHermitian(dim: number, seed: number): HermitianMatrix {
  const rng = createRng(seed)
  const re = new Float64Array(dim * dim)
  const im = new Float64Array(dim * dim)
  for (let r = 0; r < dim; r++) {
    for (let c = r; c < dim; c++) {
      const vr = rng.next() * 2 - 1
      const vi = r === c ? 0 : rng.next() * 2 - 1
      re[r * dim + c] = vr
      im[r * dim + c] = vi
      re[c * dim + r] = vr
      im[c * dim + r] = -vi
    }
  }
  return { dim, re, im }
}

/** (V Λ V†) — the matrix the decomposition claims it took apart. */
function reconstruct(system: Eigensystem, dim: number): HermitianMatrix {
  const re = new Float64Array(dim * dim)
  const im = new Float64Array(dim * dim)
  for (let i = 0; i < dim; i++) {
    for (let j = 0; j < dim; j++) {
      let sr = 0
      let si = 0
      for (let k = 0; k < dim; k++) {
        const ar = system.re[i * dim + k] * system.values[k]
        const ai = system.im[i * dim + k] * system.values[k]
        const br = system.re[j * dim + k]
        const bi = -system.im[j * dim + k]
        sr += ar * br - ai * bi
        si += ar * bi + ai * br
      }
      re[i * dim + j] = sr
      im[i * dim + j] = si
    }
  }
  return { dim, re, im }
}

function expectMatricesClose(
  actual: HermitianMatrix,
  expected: HermitianMatrix,
  label: string
): void {
  for (let i = 0; i < actual.re.length; i++) {
    expect(actual.re[i], `${label} re[${i}]`).toBeCloseTo(
      expected.re[i],
      DIGITS
    )
    expect(actual.im[i], `${label} im[${i}]`).toBeCloseTo(
      expected.im[i],
      DIGITS
    )
  }
}

/** V†V = I — the columns are an orthonormal basis. */
function expectUnitary(system: Eigensystem, dim: number, label: string): void {
  for (let a = 0; a < dim; a++) {
    for (let b = 0; b < dim; b++) {
      let sr = 0
      let si = 0
      for (let k = 0; k < dim; k++) {
        // conj(V_ka)·V_kb
        const ar = system.re[k * dim + a]
        const ai = -system.im[k * dim + a]
        const br = system.re[k * dim + b]
        const bi = system.im[k * dim + b]
        sr += ar * br - ai * bi
        si += ar * bi + ai * br
      }
      expect(sr, `${label} ⟨${a}|${b}⟩ re`).toBeCloseTo(a === b ? 1 : 0, DIGITS)
      expect(si, `${label} ⟨${a}|${b}⟩ im`).toBeCloseTo(0, DIGITS)
    }
  }
}

/** ‖A·v_j − λ_j·v_j‖∞ over every eigenpair. */
function worstResidual(matrix: HermitianMatrix, system: Eigensystem): number {
  const { dim, re, im } = matrix
  let worst = 0
  for (let j = 0; j < dim; j++) {
    for (let row = 0; row < dim; row++) {
      let sr = 0
      let si = 0
      for (let k = 0; k < dim; k++) {
        const ar = re[row * dim + k]
        const ai = im[row * dim + k]
        const br = system.re[k * dim + j]
        const bi = system.im[k * dim + j]
        sr += ar * br - ai * bi
        si += ar * bi + ai * br
      }
      const lr = system.values[j] * system.re[row * dim + j]
      const li = system.values[j] * system.im[row * dim + j]
      worst = Math.max(worst, Math.abs(sr - lr), Math.abs(si - li))
    }
  }
  return worst
}

describe('spectra that can be written down', () => {
  it('leaves a diagonal matrix alone, in ascending order', () => {
    const values = eigenvaluesHermitian(diagonal([3, 1, 2]))
    expect(Array.from(values)).toEqual([1, 2, 3])
  })

  it('needs no rotation at all on a diagonal matrix', () => {
    // Not a performance claim: it is the statement that the convergence test
    // reads the off-diagonal and not a sweep counter, so a matrix that is
    // already diagonal costs nothing and comes back untouched.
    const system = eigenHermitian(diagonal([5, -2, 0.5]))
    expect(system.sweeps).toBe(0)
    expectUnitary(system, 3, 'diagonal')
  })

  it('gives Pauli X the eigenvalues ∓1 on |−⟩ and |+⟩', () => {
    const system = eigenHermitian(
      hermitian([
        [
          [0, 0],
          [1, 0],
        ],
        [
          [1, 0],
          [0, 0],
        ],
      ])
    )
    expect(system.values[0]).toBeCloseTo(-1, DIGITS)
    expect(system.values[1]).toBeCloseTo(1, DIGITS)
    // |−⟩ = (1, −1)/√2 up to a global phase: the two components have equal
    // magnitude and opposite sign.
    const root = 1 / Math.SQRT2
    expect(Math.abs(system.re[0])).toBeCloseTo(root, DIGITS)
    expect(system.re[0] * system.re[2]).toBeCloseTo(-0.5, DIGITS)
    // |+⟩ = (1, 1)/√2: same magnitude, same sign.
    expect(system.re[1] * system.re[3]).toBeCloseTo(0.5, DIGITS)
  })

  it('gives Pauli Y the eigenvalues ∓1, which needs the phase step', () => {
    /*
     * Y is the smallest matrix whose off-diagonal is purely imaginary, so it
     * is the smallest input a real-symmetric Jacobi would get wrong: dropping
     * the phase rotation leaves the pair untouched and reports the diagonal,
     * (0, 0), as the spectrum. Both eigenvalues would be plausible numbers.
     */
    const y = hermitian([
      [
        [0, 0],
        [0, -1],
      ],
      [
        [0, 1],
        [0, 0],
      ],
    ])
    const system = eigenHermitian(y)
    expect(system.values[0]).toBeCloseTo(-1, DIGITS)
    expect(system.values[1]).toBeCloseTo(1, DIGITS)
    expect(worstResidual(y, system)).toBeLessThan(1e-12)
    expectMatricesClose(reconstruct(system, 2), y, 'Y')
  })

  it('splits [[2,1],[1,2]] into 1 and 3', () => {
    const values = eigenvaluesHermitian(
      hermitian([
        [
          [2, 0],
          [1, 0],
        ],
        [
          [1, 0],
          [2, 0],
        ],
      ])
    )
    expect(values[0]).toBeCloseTo(1, DIGITS)
    expect(values[1]).toBeCloseTo(3, DIGITS)
  })

  it('gives a rank-one projector the spectrum (0, …, 0, 1)', () => {
    // |v⟩⟨v| for a normalised complex |v⟩ on four dimensions.
    const dim = 4
    const rng = createRng(11)
    const vr = new Float64Array(dim)
    const vi = new Float64Array(dim)
    let norm = 0
    for (let i = 0; i < dim; i++) {
      vr[i] = rng.next() * 2 - 1
      vi[i] = rng.next() * 2 - 1
      norm += vr[i] * vr[i] + vi[i] * vi[i]
    }
    const scale = 1 / Math.sqrt(norm)
    for (let i = 0; i < dim; i++) {
      vr[i] *= scale
      vi[i] *= scale
    }
    const re = new Float64Array(dim * dim)
    const im = new Float64Array(dim * dim)
    for (let r = 0; r < dim; r++) {
      for (let c = 0; c < dim; c++) {
        re[r * dim + c] = vr[r] * vr[c] + vi[r] * vi[c]
        im[r * dim + c] = vi[r] * vr[c] - vr[r] * vi[c]
      }
    }

    const values = eigenvaluesHermitian({ dim, re, im })
    expect(values[0]).toBeCloseTo(0, DIGITS)
    expect(values[1]).toBeCloseTo(0, DIGITS)
    expect(values[2]).toBeCloseTo(0, DIGITS)
    expect(values[3]).toBeCloseTo(1, DIGITS)
  })

  it('finds nothing in a zero matrix and does not divide by it', () => {
    const system = eigenHermitian(diagonal([0, 0, 0]))
    expect(Array.from(system.values)).toEqual([0, 0, 0])
    expectUnitary(system, 3, 'zero')
  })

  it('handles a 1×1 matrix', () => {
    expect(Array.from(eigenvaluesHermitian(diagonal([7])))).toEqual([7])
  })

  it('agrees with itself whether or not vectors were asked for', () => {
    const matrix = randomHermitian(9, 3)
    const withVectors = eigenHermitian(matrix)
    const without = eigenvaluesHermitian(matrix)
    for (let i = 0; i < 9; i++) {
      expect(without[i]).toBeCloseTo(withVectors.values[i], DIGITS)
    }
  })
})

describe('degenerate spectra', () => {
  it('returns an orthonormal basis for the identity, not one vector four times', () => {
    const system = eigenHermitian(diagonal([1, 1, 1, 1]))
    expect(Array.from(system.values)).toEqual([1, 1, 1, 1])
    expectUnitary(system, 4, 'identity')
  })

  it('separates a doubly degenerate eigenvalue from a simple one', () => {
    const matrix = diagonal([2, 5, 2])
    const system = eigenHermitian(matrix)
    expect(system.values[0]).toBeCloseTo(2, DIGITS)
    expect(system.values[1]).toBeCloseTo(2, DIGITS)
    expect(system.values[2]).toBeCloseTo(5, DIGITS)
    expectUnitary(system, 3, 'diag(2,5,2)')
    expectMatricesClose(reconstruct(system, 3), matrix, 'diag(2,5,2)')
  })

  it('keeps a degenerate eigenspace intact after a unitary conjugation', () => {
    /*
     * A projector of rank two: eigenvalues (0, 0, 1, 1), and no basis of
     * either eigenspace is preferred. Rotating it into a general basis is
     * what makes the degeneracy non-trivial — the entries are then all
     * different and only the reconstruction can tell whether the two
     * eigenvectors that came back span the right plane.
     */
    const matrix = conjugateByRandomUnitary(diagonal([0, 0, 1, 1]), 21)
    const system = eigenHermitian(matrix)
    expect(system.values[0]).toBeCloseTo(0, DIGITS)
    expect(system.values[1]).toBeCloseTo(0, DIGITS)
    expect(system.values[2]).toBeCloseTo(1, DIGITS)
    expect(system.values[3]).toBeCloseTo(1, DIGITS)
    expectUnitary(system, 4, 'rank-two projector')
    expectMatricesClose(reconstruct(system, 4), matrix, 'rank-two projector')
  })
})

describe('random Hermitian matrices, checked by rebuilding them', () => {
  for (const dim of [2, 3, 5, 8, 16]) {
    it(`rebuilds a ${dim}×${dim} matrix from its eigenpairs`, () => {
      for (let seed = 0; seed < 5; seed++) {
        const matrix = randomHermitian(dim, seed + dim * 100)
        const system = eigenHermitian(matrix)
        expectMatricesClose(
          reconstruct(system, dim),
          matrix,
          `dim ${dim} seed ${seed}`
        )
        expectUnitary(system, dim, `dim ${dim} seed ${seed}`)
        expect(worstResidual(matrix, system)).toBeLessThan(1e-12)
      }
    })
  }

  it('returns eigenvalues in ascending order, always', () => {
    for (let seed = 0; seed < 20; seed++) {
      const values = eigenvaluesHermitian(randomHermitian(7, seed))
      for (let i = 1; i < values.length; i++) {
        expect(values[i], `seed ${seed}`).toBeGreaterThanOrEqual(values[i - 1])
      }
    }
  })

  it('sums the eigenvalues to the trace', () => {
    for (let seed = 0; seed < 10; seed++) {
      const dim = 6
      const matrix = randomHermitian(dim, seed + 500)
      let trace = 0
      for (let i = 0; i < dim; i++) trace += matrix.re[i * dim + i]
      const values = eigenvaluesHermitian(matrix)
      let sum = 0
      for (const value of values) sum += value
      expect(sum, `seed ${seed}`).toBeCloseTo(trace, DIGITS)
    }
  })

  it('is unaffected by the scale of the matrix', () => {
    // The convergence threshold is relative to ‖A‖_F. A matrix six orders up
    // and one six orders down must both decompose, and the spectra must be
    // the same numbers scaled — an absolute threshold would either spin
    // forever on the first or stop immediately on the second.
    const base = randomHermitian(5, 77)
    const small = scaled(base, 1e-6)
    const large = scaled(base, 1e6)
    const reference = eigenvaluesHermitian(base)
    const fromSmall = eigenvaluesHermitian(small)
    const fromLarge = eigenvaluesHermitian(large)
    for (let i = 0; i < 5; i++) {
      expect(fromSmall[i] * 1e6).toBeCloseTo(reference[i], DIGITS)
      expect(fromLarge[i] / 1e6).toBeCloseTo(reference[i], DIGITS)
    }
  })
})

describe('subnormal entries, which broke this once', () => {
  /*
   * A REGRESSION TEST WITH A STORY. The phase half of each rotation divides
   * A_pq by |A_pq| to get a unit complex number, and `Math.hypot` is not a
   * norm on subnormals — they carry only a handful of significant bits:
   *
   *     Math.hypot(1.1e-322, 1.5e-322) = 1.83e-322
   *     c² + s² = 1.0110
   *
   * A "phase" of modulus 1.0055 is not a unitary similarity, so it scaled a
   * whole row and column of the matrix and moved the spectrum with it. The
   * matrix below is the one that caught it — a reduced density matrix of a
   * four-qubit state whose amplitudes fast-check had shrunk down to
   * subnormals — and the failure was an eigenvalue of −7.3e-10 where zero
   * belonged, with the trace, the Hermiticity and every other invariant
   * intact. Nothing threw. The entropy read off it was wrong in the ninth
   * decimal and looked entirely reasonable.
   *
   * The assertion is that the subnormal imaginary parts change nothing:
   * they are 1e-322 against entries of order 1, so the two spectra must
   * agree to the last bit that matters.
   */
  const REAL_PART = [
    0.3396763327585419, 0.0, 0.0, 0.0, 0.0, -0.4733507648736782, 0.0,
    0.00037709193984829134,
  ]
  const CORNER = 4.1862890459203323e-7

  function graded(withSubnormals: boolean): HermitianMatrix {
    const re = new Float64Array(64)
    const im = new Float64Array(64)
    for (let c = 0; c < 8; c++) {
      re[c] = REAL_PART[c]
      re[c * 8] = REAL_PART[c]
    }
    re[5 * 8 + 5] = 0.6603232486125532
    re[5 * 8 + 7] = -0.0005254907126007267
    re[7 * 8 + 5] = -0.0005254907126007267
    re[7 * 8 + 7] = CORNER
    if (withSubnormals) {
      im[2] = 1.1e-322
      im[2 * 8] = -1.1e-322
      im[2 * 8 + 5] = 1.5e-322
      im[5 * 8 + 2] = -1.5e-322
    }
    return { dim: 8, re, im }
  }

  it('ignores an off-diagonal 322 orders below the matrix', () => {
    const clean = eigenvaluesHermitian(graded(false))
    const perturbed = eigenvaluesHermitian(graded(true))
    for (let i = 0; i < 8; i++) {
      expect(perturbed[i], `eigenvalue ${i}`).toBeCloseTo(clean[i], 14)
    }
    // And the answer is still a spectrum of a positive semidefinite matrix:
    // the defect this catches showed up precisely as a negative eigenvalue.
    expect(perturbed[0]).toBeGreaterThan(-1e-14)
  })
})

describe('the property the method was chosen for', () => {
  /*
   * A graded 2×2 whose eigenvalues are about 1 and about 1e-12. The small one
   * is what an entropy weights by log₂ of itself, so an absolute error of
   * 1e-16 on it — all a tridiagonal method guarantees, since that is ε‖A‖ —
   * would be a *relative* error of 1e-4 and would move the entropy in the
   * fourth decimal. Jacobi computes it to relative precision, and this test
   * is the claim in the header made falsifiable.
   */
  it('resolves an eigenvalue twelve orders below the largest, relatively', () => {
    const off = 1e-6
    const corner = 2e-12
    const matrix = hermitian([
      [
        [1, 0],
        [off, 0],
      ],
      [
        [off, 0],
        [corner, 0],
      ],
    ])
    // Exact roots of λ² − tλ + d, taken through the stable form: the larger
    // root by the quadratic formula, the smaller as d / larger.
    const t = 1 + corner
    const d = corner - off * off
    const larger = (t + Math.sqrt(t * t - 4 * d)) / 2
    const smaller = d / larger

    const values = eigenvaluesHermitian(matrix)
    expect(values[1]).toBeCloseTo(larger, DIGITS)
    expect(Math.abs(values[0] / smaller - 1)).toBeLessThan(1e-10)
  })
})

describe('refusals', () => {
  it('refuses a matrix that is not Hermitian', () => {
    const asymmetric = hermitian([
      [
        [1, 0],
        [2, 0],
      ],
      [
        [3, 0],
        [4, 0],
      ],
    ])
    expect(() => eigenvaluesHermitian(asymmetric)).toThrow(NotHermitianError)
  })

  it('refuses a complex diagonal, which is the same violation at r = c', () => {
    const matrix = hermitian([
      [
        [1, 0.5],
        [0, 0],
      ],
      [
        [0, 0],
        [1, 0],
      ],
    ])
    expect(() => eigenvaluesHermitian(matrix)).toThrow(NotHermitianError)
  })

  it('reports how far from Hermitian the input was', () => {
    const matrix = hermitian([
      [
        [1, 0],
        [0, 1],
      ],
      [
        [0, 1],
        [1, 0],
      ],
    ])
    try {
      eigenvaluesHermitian(matrix)
      expect.unreachable('should have refused')
    } catch (error) {
      expect(error).toBeInstanceOf(NotHermitianError)
      expect((error as NotHermitianError).defect).toBeCloseTo(2, DIGITS)
    }
  })

  it('accepts a defect within tolerance, as a partial trace leaves', () => {
    // Hermitian to 1e-14, which is what 2²⁰ Float64 additions produce.
    const matrix = hermitian([
      [
        [1, 0],
        [0.5, 1e-14],
      ],
      [
        [0.5, 0],
        [1, 0],
      ],
    ])
    expect(() => eigenvaluesHermitian(matrix)).not.toThrow()
  })

  it('refuses a matrix wider than the ceiling, before allocating', () => {
    const dim = MAX_EIGEN_DIM + 1
    // Deliberately not a real matrix: the check has to happen before anything
    // reads the arrays, so a shape this size costs nothing to refuse.
    const stub: HermitianMatrix = {
      dim,
      re: new Float64Array(0),
      im: new Float64Array(0),
    }
    expect(() => eigenvaluesHermitian(stub)).toThrow(EigenTooLargeError)
    try {
      eigenvaluesHermitian(stub)
    } catch (error) {
      expect((error as EigenTooLargeError).dim).toBe(dim)
      expect((error as EigenTooLargeError).maxDim).toBe(MAX_EIGEN_DIM)
    }
  })

  it('refuses arrays that do not match the declared dimension', () => {
    expect(() =>
      eigenvaluesHermitian({
        dim: 3,
        re: new Float64Array(4),
        im: new Float64Array(9),
      })
    ).toThrow(RangeError)
  })

  it('refuses a non-finite entry rather than returning NaN eigenvalues', () => {
    const matrix = diagonal([1, Number.NaN])
    expect(() => eigenvaluesHermitian(matrix)).toThrow(RangeError)
    const infinite = diagonal([1, Number.POSITIVE_INFINITY])
    expect(() => eigenvaluesHermitian(infinite)).toThrow(RangeError)
  })

  it('refuses a dimension that is not a positive integer', () => {
    expect(() =>
      eigenvaluesHermitian({
        dim: 0,
        re: new Float64Array(0),
        im: new Float64Array(0),
      })
    ).toThrow(RangeError)
  })
})

/** A·s, entry by entry — only the scale changes, so the spectrum scales too. */
function scaled(matrix: HermitianMatrix, factor: number): HermitianMatrix {
  const re = new Float64Array(matrix.re.length)
  const im = new Float64Array(matrix.im.length)
  for (let i = 0; i < re.length; i++) {
    re[i] = matrix.re[i] * factor
    im[i] = matrix.im[i] * factor
  }
  return { dim: matrix.dim, re, im }
}

/**
 * U A U† for a unitary U built by the solver-independent route: take the
 * eigenvectors of a random Hermitian matrix, which are orthonormal by the
 * spectral theorem whatever this module does to them, and check that with
 * `expectUnitary` before use.
 *
 * Circular only in appearance: if the vectors were not orthonormal the
 * conjugation would not be a similarity and the reconstruction assertions
 * would fail, which is exactly what the test is watching for.
 */
function conjugateByRandomUnitary(
  matrix: HermitianMatrix,
  seed: number
): HermitianMatrix {
  const { dim } = matrix
  const basis = eigenHermitian(randomHermitian(dim, seed))
  expectUnitary(basis, dim, `basis ${seed}`)

  // (U A U†)_ij = Σ_k Σ_l U_ik A_kl conj(U_jl)
  const re = new Float64Array(dim * dim)
  const im = new Float64Array(dim * dim)
  for (let i = 0; i < dim; i++) {
    for (let j = 0; j < dim; j++) {
      let sr = 0
      let si = 0
      for (let k = 0; k < dim; k++) {
        for (let l = 0; l < dim; l++) {
          // U_ik · A_kl
          const ur = basis.re[i * dim + k]
          const ui = basis.im[i * dim + k]
          const ar = matrix.re[k * dim + l]
          const ai = matrix.im[k * dim + l]
          const pr = ur * ar - ui * ai
          const pi = ur * ai + ui * ar
          // · conj(U_jl)
          const cr = basis.re[j * dim + l]
          const ci = -basis.im[j * dim + l]
          sr += pr * cr - pi * ci
          si += pr * ci + pi * cr
        }
      }
      re[i * dim + j] = sr
      im[i * dim + j] = si
    }
  }
  return { dim, re, im }
}
