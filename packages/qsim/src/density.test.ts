/**
 * `density.ts` — the density matrix, its ceiling, and ρ → UρU†.
 *
 * THE SHAPE OF THE RISK THIS FILE IS ANSWERING. A physics bug in a mixed-state
 * engine throws nothing. Apply the wrong conjugate and ρ comes back Hermitian,
 * unit-trace and positive, with a probability distribution that sums to one and
 * looks entirely reasonable — and nobody has an intuition for what a noisy
 * distribution should look like (§3.3), so no reader is going to catch it by
 * eye. Two strategies follow from that, and both are used below.
 *
 *  1. **Check ρ against a path that already survived an audit.** For a pure
 *     state the two representations must agree: evolving |ψ⟩ with `apply.ts`
 *     and then taking the outer product must land on exactly the same matrix as
 *     taking the outer product first and evolving it with `density.ts`. The
 *     statevector kernel is verified by an adversarial suite of its own, so this
 *     equivalence borrows all of it. Every gate in the catalog is put through
 *     it, enumerated from `GATE_MATRICES` rather than listed by hand, so a gate
 *     added later cannot quietly skip the check.
 *
 *  2. **Check the properties that define a density matrix, after every
 *     operation.** Hermitian, trace 1, positive semidefinite. Positivity is the
 *     one with teeth: Hermiticity and trace survive most sign errors and it does
 *     not.
 *
 * `verification/density-evolution.test.ts` is the independent half — a naive
 * full-matrix oracle that shares no loop with this module.
 */

import { describe, expect, it } from 'vitest'

import { applyControlled, apply1q, applySwap, applyISwap } from './apply.js'
import type { ControlSpec } from './apply.js'
import {
  DENSITY_BUDGET_BYTES,
  DensityTooLargeError,
  MAX_DENSITY_QUBITS,
  alloc,
  apply2q as densityApply2q,
  applyControlled as densityApplyControlled,
  applyISwap as densityApplyISwap,
  applySwap as densityApplySwap,
  apply1q as densityApply1q,
  assertDensityFits,
  clone,
  densityBytes,
  entry,
  fromStatevector,
  hermiticityDefect,
  isHermitian,
  isPositiveSemidefinite,
  probabilities,
  purity,
  renormalize,
  reset,
  trace,
} from './density.js'
import type { DensityMatrix } from './density.js'
import {
  GATE_MATRICES,
  ISWAP_MATRIX,
  SWAP_MATRIX,
  matrixFor,
  pMatrix,
  rxMatrix,
  ryMatrix,
  rzMatrix,
  uMatrix,
} from './gates.js'
import type { Matrix2, Matrix4 } from './gates.js'
import { probabilities as stateProbabilities } from './measure.js'
import { createRng } from './rng.js'
import type { Rng } from './rng.js'
import { alloc as allocState } from './statevector.js'
import type { Statevector } from './statevector.js'

/** D6: 1e-10, as a bound and as digits for `toBeCloseTo`. */
const TOLERANCE = 1e-10
const DIGITS = 10

/* ─────────────────────────────── fixtures ───────────────────────────────── */

/**
 * A generic entangled state, built with the statevector kernel.
 *
 * Three layers of arbitrary `U(θ,φ,λ)` on every wire with a CNOT ladder
 * between them: no symmetry across the register, no zero amplitudes, no real
 * amplitudes. A state with structure would let a mispaired index or a dropped
 * conjugate agree with the right answer by accident, and this one does not.
 */
function randomState(qubits: number, rng: Rng): Statevector {
  const angle = (): number => (rng.next() - 0.5) * 6
  const state = allocState(qubits)
  for (let layer = 0; layer < 3; layer++) {
    for (let q = 0; q < qubits; q++) {
      apply1q(state, uMatrix(angle(), angle(), angle()), q)
    }
    for (let q = 0; q + 1 < qubits; q++) {
      applyControlled(state, GATE_MATRICES.x, q + 1, [{ qubit: q, state: 1 }])
    }
  }
  return state
}

/** Largest entry-wise difference between two density matrices. */
function maxDeviation(actual: DensityMatrix, expected: DensityMatrix): number {
  let worst = 0
  for (let i = 0; i < expected.size; i++) {
    const dr = Math.abs(actual.re[i] - expected.re[i])
    const di = Math.abs(actual.im[i] - expected.im[i])
    if (dr > worst) worst = dr
    if (di > worst) worst = di
  }
  return worst
}

function expectSameDensity(
  actual: DensityMatrix,
  expected: DensityMatrix,
  label: string
): void {
  expect(actual.size).toBe(expected.size)
  expect(maxDeviation(actual, expected), label).toBeLessThan(TOLERANCE)
}

/**
 * The three statements that make a matrix a state, asserted together.
 *
 * Every gate case below ends here. Positivity is the expensive one — O(8ⁿ) and
 * a copy, see `isPositiveSemidefinite` — which is affordable precisely because
 * these registers are three and four qubits wide.
 */
function expectValidDensity(rho: DensityMatrix, label: string): void {
  expect(hermiticityDefect(rho), `${label}: Hermitian`).toBeLessThan(TOLERANCE)
  expect(trace(rho), `${label}: unit trace`).toBeCloseTo(1, DIGITS)
  expect(isPositiveSemidefinite(rho), `${label}: positive semidefinite`).toBe(
    true
  )
}

/**
 * A mixed state that is genuinely mixed: an even blend of four random pure
 * states, so no pure-state shortcut applies to it.
 *
 * Built by averaging outer products, which is the definition of a mixture and
 * uses none of the machinery under test beyond `fromStatevector`.
 */
function mixedState(qubits: number, rng: Rng, parts = 4): DensityMatrix {
  const rho = alloc(qubits)
  rho.re[0] = 0
  for (let k = 0; k < parts; k++) {
    const piece = fromStatevector(randomState(qubits, rng))
    for (let i = 0; i < rho.size; i++) {
      rho.re[i] += piece.re[i] / parts
      rho.im[i] += piece.im[i] / parts
    }
  }
  return rho
}

/* ──────────────────────────── layout and lifecycle ──────────────────────── */

describe('the layout is the one documented at the top of the file', () => {
  it('allocates ρ = |0…0⟩⟨0…0| with 4ⁿ entries', () => {
    for (const qubits of [1, 2, 3, 5]) {
      const rho = alloc(qubits)
      expect(rho.dim).toBe(2 ** qubits)
      expect(rho.size).toBe(4 ** qubits)
      expect(rho.re.length).toBe(rho.size)
      expect(rho.im.length).toBe(rho.size)

      // Exactly one non-zero entry, at (0, 0).
      expect(entry(rho, 0, 0)).toEqual({ re: 1, im: 0 })
      let nonZero = 0
      for (let i = 0; i < rho.size; i++) {
        if (rho.re[i] !== 0 || rho.im[i] !== 0) nonZero++
      }
      expect(nonZero).toBe(1)
      expectValidDensity(rho, `ground state of ${qubits} qubits`)
      expect(purity(rho)).toBeCloseTo(1, DIGITS)
    }
  })

  it('indexes entry (r, c) at r·dim + c, row-major', () => {
    // ρ = |01⟩⟨01| — qubit 0 set, qubit 1 clear, so the row and the column are
    // both statevector index 1 and the entry is at 1·4 + 1 = 5.
    const psi = allocState(2)
    apply1q(psi, GATE_MATRICES.x, 0)
    const rho = fromStatevector(psi)

    expect(rho.re[5]).toBeCloseTo(1, DIGITS)
    expect(entry(rho, 1, 1).re).toBeCloseTo(1, DIGITS)
    for (let i = 0; i < rho.size; i++) {
      if (i !== 5) expect(rho.re[i]).toBeCloseTo(0, DIGITS)
    }
  })

  it('puts the ket in the row index and the bra in the column index', () => {
    /*
     * ρ = |ψ⟩⟨ψ| with ψ = (|00⟩ + |10⟩)/√2 — qubit 1 in superposition, qubit 0
     * clear. The off-diagonal coherence must sit at (row 0, column 2) and
     * (row 2, column 0), i.e. on the qubit-1 bit of each index. A row/column
     * transposition or a bit-order slip lands it on 1 instead of 2.
     */
    const psi = allocState(2)
    apply1q(psi, GATE_MATRICES.h, 1)
    const rho = fromStatevector(psi)

    expect(entry(rho, 0, 2).re).toBeCloseTo(0.5, DIGITS)
    expect(entry(rho, 2, 0).re).toBeCloseTo(0.5, DIGITS)
    expect(entry(rho, 0, 1).re).toBeCloseTo(0, DIGITS)
    expect(entry(rho, 1, 0).re).toBeCloseTo(0, DIGITS)
  })

  it('rejects an out-of-range entry rather than reading past a row', () => {
    const rho = alloc(2)
    expect(() => entry(rho, 4, 0)).toThrow(RangeError)
    expect(() => entry(rho, 0, -1)).toThrow(RangeError)
    expect(() => entry(rho, 1.5, 0)).toThrow(RangeError)
  })

  it('resets and clones without sharing buffers', () => {
    const rng = createRng(11)
    const rho = fromStatevector(randomState(3, rng))
    const copy = clone(rho)
    expectSameDensity(copy, rho, 'clone')

    reset(rho)
    expect(entry(rho, 0, 0).re).toBe(1)
    expect(trace(rho)).toBeCloseTo(1, DIGITS)
    // The clone kept its own values: it did not alias the reset buffers.
    expect(maxDeviation(copy, rho)).toBeGreaterThan(0.1)
    expect(copy.re.buffer).not.toBe(rho.re.buffer)
  })
})

/* ────────────────────────────── the ceiling ─────────────────────────────── */

describe('the memory ceiling is explicit, checked, and typed', () => {
  it('agrees with §5.4 arithmetic: 4ⁿ × 16 bytes', () => {
    expect(densityBytes(1)).toBe(64)
    expect(densityBytes(4)).toBe(4 * 1024)
    expect(densityBytes(10)).toBe(16 * 1024 * 1024)
    expect(densityBytes(12)).toBe(256 * 1024 * 1024)
    expect(densityBytes(14)).toBe(4 * 1024 * 1024 * 1024)
  })

  it('picks a budget that admits exactly MAX_DENSITY_QUBITS', () => {
    /*
     * The two constants are independent statements — a ceiling in qubits and a
     * ceiling in bytes — and this is the assertion that stops them drifting
     * apart. Raising one without the other now fails here rather than in a
     * browser tab.
     */
    expect(densityBytes(MAX_DENSITY_QUBITS)).toBe(DENSITY_BUDGET_BYTES)
    expect(densityBytes(MAX_DENSITY_QUBITS + 1)).toBeGreaterThan(
      DENSITY_BUDGET_BYTES
    )
    // §3.3 puts the mode at 10 to 12 qubits.
    expect(MAX_DENSITY_QUBITS).toBe(12)
  })

  it('accepts every register inside the ceiling without allocating one', () => {
    // `assertDensityFits` is arithmetic on one integer, which is what lets the
    // editor ask "can this circuit run noisily?" before committing 256 MB.
    for (let qubits = 1; qubits <= MAX_DENSITY_QUBITS; qubits++) {
      expect(() => assertDensityFits(qubits)).not.toThrow()
    }
  })

  it('refuses the first qubit past the ceiling, with the numbers attached', () => {
    const qubits = MAX_DENSITY_QUBITS + 1
    let caught: unknown
    try {
      assertDensityFits(qubits)
    } catch (error) {
      caught = error
    }

    expect(caught).toBeInstanceOf(DensityTooLargeError)
    // Also a RangeError, so a caller guarding an allocation still catches it.
    expect(caught).toBeInstanceOf(RangeError)
    const failure = caught as DensityTooLargeError
    expect(failure.name).toBe('DensityTooLargeError')
    expect(failure.qubits).toBe(qubits)
    expect(failure.maxQubits).toBe(MAX_DENSITY_QUBITS)
    expect(failure.requiredBytes).toBe(densityBytes(qubits))
    expect(failure.budgetBytes).toBe(DENSITY_BUDGET_BYTES)
    // The four numbers are what a translated message interpolates (D2); the
    // English sentence is the fallback, not the payload.
    expect(failure.message).toContain('13 qubits')
  })

  it('refuses before allocating, not from inside a typed array', () => {
    /*
     * 30 qubits is 4³⁰ entries: a `Float64Array` of that length throws its own
     * `RangeError` with a message about typed array lengths, and 13 qubits is
     * worse — it would *succeed*, reserve a gigabyte and take the tab with it.
     * Both must arrive here as the same typed refusal, which they can only do
     * if the check runs first.
     */
    expect(() => alloc(13)).toThrow(DensityTooLargeError)
    expect(() => alloc(30)).toThrow(DensityTooLargeError)
    expect(() => alloc(64)).toThrow(DensityTooLargeError)

    // The same guard on the way in from a pure state: a 13-qubit statevector
    // is 128 KB and perfectly ordinary, and its outer product is a gigabyte.
    const oversized = allocState(13)
    expect(() => fromStatevector(oversized)).toThrow(DensityTooLargeError)
  })

  it('rejects a register size that is not a register size', () => {
    for (const qubits of [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(() => alloc(qubits)).toThrow(RangeError)
    }
    // …and those are plain RangeErrors, not "too large": the UI has nothing to
    // offer the user about a fractional qubit count.
    expect(() => alloc(0)).not.toThrow(DensityTooLargeError)
  })
})

/* ─────────────────────────── from a pure state ──────────────────────────── */

describe('ρ from a statevector is the same state, written differently', () => {
  it('has purity 1 and unit trace, on random states', () => {
    const rng = createRng(3)
    for (let qubits = 1; qubits <= 5; qubits++) {
      for (let trial = 0; trial < 5; trial++) {
        const rho = fromStatevector(randomState(qubits, rng))
        expect(trace(rho)).toBeCloseTo(1, DIGITS)
        expect(purity(rho), `purity at ${qubits} qubits`).toBeCloseTo(1, DIGITS)
        expectValidDensity(rho, `|ψ⟩⟨ψ| at ${qubits} qubits`)
      }
    }
  })

  it('reproduces the probabilities the statevector gives, entry for entry', () => {
    const rng = createRng(5)
    for (let qubits = 1; qubits <= 5; qubits++) {
      const psi = randomState(qubits, rng)
      const fromMatrix = probabilities(fromStatevector(psi))
      const fromVector = stateProbabilities(psi)

      expect(fromMatrix.length).toBe(fromVector.length)
      for (let i = 0; i < fromVector.length; i++) {
        expect(fromMatrix[i], `P(${i}) at ${qubits} qubits`).toBeCloseTo(
          fromVector[i],
          DIGITS
        )
      }
    }
  })

  it('places the coherences as ψ_r·conj(ψ_c), not as its conjugate', () => {
    /*
     * A state with a deliberate phase: ψ = (|0⟩ + i|1⟩)/√2 = S·H|0⟩. Then
     * ρ₀₁ = ψ₀·conj(ψ₁) = ½·conj(i) = −i/2. Taking conj(ψ₀)·ψ₁ instead flips the
     * sign of every imaginary entry — and leaves the diagonal, the trace, the
     * purity and Hermiticity all intact, so this assertion is the one that
     * notices.
     */
    const psi = allocState(1)
    apply1q(psi, GATE_MATRICES.h, 0)
    apply1q(psi, GATE_MATRICES.s, 0)
    const rho = fromStatevector(psi)

    expect(entry(rho, 0, 0).re).toBeCloseTo(0.5, DIGITS)
    expect(entry(rho, 1, 1).re).toBeCloseTo(0.5, DIGITS)
    expect(entry(rho, 0, 1).re).toBeCloseTo(0, DIGITS)
    expect(entry(rho, 0, 1).im).toBeCloseTo(-0.5, DIGITS)
    expect(entry(rho, 1, 0).im).toBeCloseTo(0.5, DIGITS)
  })

  it('gives a Bell pair its four corners and nothing else', () => {
    const psi = allocState(2)
    apply1q(psi, GATE_MATRICES.h, 0)
    applyControlled(psi, GATE_MATRICES.x, 1, [{ qubit: 0, state: 1 }])
    const rho = fromStatevector(psi)

    for (const [row, column] of [
      [0, 0],
      [0, 3],
      [3, 0],
      [3, 3],
    ] as const) {
      expect(entry(rho, row, column).re).toBeCloseTo(0.5, DIGITS)
    }
    expect(purity(rho)).toBeCloseTo(1, DIGITS)
    // Sixteen entries, four of them ½: everything else is exactly zero.
    let mass = 0
    for (let i = 0; i < rho.size; i++) mass += Math.abs(rho.re[i])
    expect(mass).toBeCloseTo(2, DIGITS)
  })
})

/* ───────────────────────── trace and renormalisation ────────────────────── */

describe('trace, renormalisation and purity', () => {
  it('divides by the trace and reports what it was', () => {
    const rng = createRng(7)
    const rho = fromStatevector(randomState(3, rng))
    for (let i = 0; i < rho.size; i++) {
      rho.re[i] *= 3
      rho.im[i] *= 3
    }

    expect(trace(rho)).toBeCloseTo(3, DIGITS)
    expect(renormalize(rho)).toBeCloseTo(3, DIGITS)
    expect(trace(rho)).toBeCloseTo(1, DIGITS)
    expectValidDensity(rho, 'renormalised ρ')
  })

  it('refuses a trace of zero rather than spraying NaN over 4ⁿ entries', () => {
    const rho = alloc(2)
    rho.re[0] = 0
    expect(() => renormalize(rho)).toThrow(RangeError)

    const broken = alloc(2)
    broken.re[0] = Number.NaN
    expect(() => renormalize(broken)).toThrow(RangeError)
  })

  it('reports 1/2ⁿ for the maximally mixed state', () => {
    for (const qubits of [1, 2, 3, 4]) {
      const rho = alloc(qubits)
      rho.re[0] = 0
      for (let i = 0; i < rho.dim; i++) rho.re[i * rho.dim + i] = 1 / rho.dim
      expect(trace(rho)).toBeCloseTo(1, DIGITS)
      expect(purity(rho), `purity of I/${rho.dim}`).toBeCloseTo(
        1 / rho.dim,
        DIGITS
      )
      expectValidDensity(rho, `I/${rho.dim}`)
    }
  })

  it('puts a genuine mixture strictly between the two extremes', () => {
    const rng = createRng(13)
    for (const qubits of [1, 2, 3]) {
      const rho = mixedState(qubits, rng)
      const value = purity(rho)
      expect(trace(rho)).toBeCloseTo(1, DIGITS)
      expect(value).toBeLessThan(1 - 1e-6)
      expect(value).toBeGreaterThan(1 / rho.dim - TOLERANCE)
      expectValidDensity(rho, `mixture of 4 states, ${qubits} qubits`)
    }
  })
})

/* ──────────────────────── the three validity checks ─────────────────────── */

describe('the validity checks catch what they are there to catch', () => {
  it('reports a broken conjugate as non-Hermitian', () => {
    const rng = createRng(17)
    const rho = fromStatevector(randomState(2, rng))
    expect(isHermitian(rho)).toBe(true)

    // ρ₀₁ and ρ₁₀ given the same imaginary part instead of opposite ones —
    // the shape a conjugate applied to the wrong factor produces. The trace
    // does not move, the diagonal does not move, and this is the only one of
    // the three checks that says anything at all.
    rho.im[1] = 0.25
    rho.im[4] = 0.25
    expect(isHermitian(rho)).toBe(false)
    expect(hermiticityDefect(rho)).toBeGreaterThan(TOLERANCE)
    expect(trace(rho)).toBeCloseTo(1, DIGITS)
  })

  it('calls a complex diagonal entry non-Hermitian and not positive', () => {
    const rho = alloc(2)
    rho.im[0] = 0.5
    expect(isHermitian(rho)).toBe(false)
    expect(isPositiveSemidefinite(rho)).toBe(false)
  })

  it('rejects a matrix with a negative eigenvalue', () => {
    /*
     * ½(I + 1.4·Z) as a one-qubit ρ has eigenvalues 1.2 and −0.2: Hermitian,
     * trace 1, a "probability" of −0.2. This is the shape a wrong Kraus
     * coefficient produces, and positivity is the only one of the three
     * properties that notices.
     */
    const rho = alloc(1)
    rho.re[0] = 1.2
    rho.re[3] = -0.2
    expect(isHermitian(rho)).toBe(true)
    expect(trace(rho)).toBeCloseTo(1, DIGITS)
    expect(isPositiveSemidefinite(rho)).toBe(false)
  })

  it('rejects a zero diagonal with off-diagonal mass', () => {
    // [[0,1],[1,0]] has eigenvalues ±1 and a diagonal of zeros. A positivity
    // check that stopped at the first vanishing pivot would call it positive.
    const rho = alloc(1)
    rho.re[0] = 0
    rho.re[1] = 1
    rho.re[2] = 1
    expect(isPositiveSemidefinite(rho)).toBe(false)
  })

  it('accepts a rank-deficient state — a pure state is one', () => {
    // |ψ⟩⟨ψ| has one non-zero eigenvalue and 2ⁿ−1 zeros, so the factorisation
    // meets a vanishing pivot on its second step and must not fail there.
    const rng = createRng(19)
    for (const qubits of [1, 2, 3, 4]) {
      const rho = fromStatevector(randomState(qubits, rng))
      expect(isPositiveSemidefinite(rho), `pure state, ${qubits} qubits`).toBe(
        true
      )
    }
  })

  it('accepts a state that is positive only just', () => {
    // Eigenvalues 1 and 0 exactly, plus a nudge below the tolerance: the
    // boundary case a strict `pivot > 0` test would fail.
    const rho = alloc(1)
    rho.re[0] = 1 + 1e-13
    rho.re[3] = -1e-13
    expect(isPositiveSemidefinite(rho)).toBe(true)
    expect(isPositiveSemidefinite(rho, 1e-15)).toBe(false)
  })
})

/* ─────────────────────── the catalog, gate by gate ──────────────────────── */

/**
 * One gate, expressed twice: once against a statevector and once against ρ.
 *
 * The two closures are what the equivalence compares. Writing the pair by hand
 * per case is the point — a shared dispatcher would let the same mistake into
 * both sides, and then the test would agree with itself.
 */
interface GateCase {
  readonly name: string
  readonly qubits: number
  readonly onState: (state: Statevector) => void
  readonly onDensity: (rho: DensityMatrix) => void
}

function oneQubitCase(
  name: string,
  matrix: Matrix2,
  target: number,
  qubits = 3
): GateCase {
  return {
    name: `${name} on q${target}`,
    qubits,
    onState: (state) => apply1q(state, matrix, target),
    onDensity: (rho) => densityApply1q(rho, matrix, target),
  }
}

function controlledCase(
  name: string,
  matrix: Matrix2,
  target: number,
  controls: readonly ControlSpec[],
  qubits = 3
): GateCase {
  const label = controls
    .map((control) => `${control.state === 1 ? '' : '¬'}q${control.qubit}`)
    .join(',')
  return {
    name: `${name} on q${target} controlled by ${label}`,
    qubits,
    onState: (state) => applyControlled(state, matrix, target, controls),
    onDensity: (rho) => densityApplyControlled(rho, matrix, target, controls),
  }
}

/**
 * The 4×4 of `m0` on `q0` and `m1` on `q1` — a Kronecker product, built here
 * because a test may be naive where the kernel may not.
 *
 * Row and column index is `2·b₁ + b₀`, the convention of `apply.ts`. Feeding
 * this to `apply2q` and the two 2×2s to `apply1q` gives two routes to one
 * state, which is what makes the arbitrary-unitary path checkable at all: the
 * editor has no gate that produces a general 4×4.
 */
function tensor4(m0: Matrix2, m1: Matrix2): Matrix4 {
  const out = new Float64Array(32)
  for (let row = 0; row < 4; row++) {
    for (let column = 0; column < 4; column++) {
      const r0 = row & 1
      const r1 = (row >> 1) & 1
      const c0 = column & 1
      const c1 = (column >> 1) & 1
      const a = (2 * r0 + c0) * 2
      const b = (2 * r1 + c1) * 2
      const re = m0[a] * m1[b] - m0[a + 1] * m1[b + 1]
      const im = m0[a] * m1[b + 1] + m0[a + 1] * m1[b]
      out[(row * 4 + column) * 2] = re
      out[(row * 4 + column) * 2 + 1] = im
    }
  }
  return out
}

function gateCases(): GateCase[] {
  const cases: GateCase[] = []

  // Every fixed gate in the catalog, enumerated rather than listed, on a low
  // and on a high wire — a stride mix-up shows on one and not the other.
  for (const id of Object.keys(GATE_MATRICES)) {
    const matrix = matrixFor(id as keyof typeof GATE_MATRICES)
    cases.push(oneQubitCase(id, matrix, 0))
    cases.push(oneQubitCase(id, matrix, 2))
  }

  // The parametrised ones, at angles with no symmetry to hide behind.
  cases.push(oneQubitCase('rx(0.7)', rxMatrix(0.7), 1))
  cases.push(oneQubitCase('ry(-2.1)', ryMatrix(-2.1), 0))
  cases.push(oneQubitCase('rz(1.3)', rzMatrix(1.3), 2))
  cases.push(oneQubitCase('p(2.6)', pMatrix(2.6), 1))
  cases.push(oneQubitCase('u(0.4,1.1,-0.9)', uMatrix(0.4, 1.1, -0.9), 2))

  // Controlled shapes: cx, cz, a controlled rotation, a negative control, and
  // the two-control case (ccx).
  cases.push(controlledCase('cx', GATE_MATRICES.x, 1, [{ qubit: 0, state: 1 }]))
  cases.push(controlledCase('cz', GATE_MATRICES.z, 2, [{ qubit: 1, state: 1 }]))
  cases.push(controlledCase('crz', rzMatrix(0.9), 0, [{ qubit: 2, state: 1 }]))
  cases.push(controlledCase('cp', pMatrix(-1.4), 2, [{ qubit: 0, state: 1 }]))
  cases.push(
    controlledCase('¬cx', GATE_MATRICES.x, 1, [{ qubit: 2, state: 0 }])
  )
  cases.push(
    controlledCase('ccx', GATE_MATRICES.x, 2, [
      { qubit: 0, state: 1 },
      { qubit: 1, state: 1 },
    ])
  )
  cases.push(
    controlledCase('ch with a mixed pair', GATE_MATRICES.h, 0, [
      { qubit: 1, state: 1 },
      { qubit: 2, state: 0 },
    ])
  )

  // The exchange family, in both argument orders — SWAP is symmetric and hides
  // a transposition, iSWAP is not and does not.
  cases.push({
    name: 'swap(0, 2)',
    qubits: 3,
    onState: (state) => applySwap(state, 0, 2),
    onDensity: (rho) => densityApplySwap(rho, 0, 2),
  })
  cases.push({
    name: 'cswap(1, 2) controlled by q0',
    qubits: 3,
    onState: (state) => applySwap(state, 1, 2, [{ qubit: 0, state: 1 }]),
    onDensity: (rho) => densityApplySwap(rho, 1, 2, [{ qubit: 0, state: 1 }]),
  })
  cases.push({
    name: 'iswap(0, 1)',
    qubits: 3,
    onState: (state) => applyISwap(state, 0, 1),
    onDensity: (rho) => densityApplyISwap(rho, 0, 1),
  })
  cases.push({
    name: 'iswap(2, 0) — arguments reversed',
    qubits: 3,
    onState: (state) => applyISwap(state, 2, 0),
    onDensity: (rho) => densityApplyISwap(rho, 2, 0),
  })

  // The arbitrary-4×4 path, including the two exchange matrices `gates.ts`
  // keeps as oracles for the specialised kernels above.
  cases.push({
    name: 'apply2q(SWAP_MATRIX, 0, 1)',
    qubits: 3,
    onState: (state) => applySwap(state, 0, 1),
    onDensity: (rho) => densityApply2q(rho, SWAP_MATRIX, 0, 1),
  })
  cases.push({
    name: 'apply2q(ISWAP_MATRIX, 1, 2)',
    qubits: 3,
    onState: (state) => applyISwap(state, 1, 2),
    onDensity: (rho) => densityApply2q(rho, ISWAP_MATRIX, 1, 2),
  })
  cases.push({
    name: 'apply2q(H ⊗ S, 2, 0)',
    qubits: 3,
    onState: (state) => {
      apply1q(state, GATE_MATRICES.h, 2)
      apply1q(state, GATE_MATRICES.s, 0)
    },
    onDensity: (rho) =>
      densityApply2q(rho, tensor4(GATE_MATRICES.h, GATE_MATRICES.s), 2, 0),
  })
  cases.push({
    name: 'apply2q(U ⊗ Rx, 0, 3) on 4 qubits',
    qubits: 4,
    onState: (state) => {
      apply1q(state, uMatrix(0.8, -0.3, 2.2), 0)
      apply1q(state, rxMatrix(1.9), 3)
    },
    onDensity: (rho) =>
      densityApply2q(
        rho,
        tensor4(uMatrix(0.8, -0.3, 2.2), rxMatrix(1.9)),
        0,
        3
      ),
  })

  return cases
}

describe('every gate in the catalog agrees with the statevector kernel', () => {
  /*
   * THE STRONGEST TEST AVAILABLE HERE. `apply.ts` has an adversarial suite of
   * its own — endianness, controlled gates, known algorithms, numerical
   * stability — so checking ρ against it inherits all of that verification
   * instead of restating it. For a pure state the diagram must commute:
   *
   *        |ψ⟩  ──apply.ts──▶  U|ψ⟩
   *         │                    │
   *   fromStatevector      fromStatevector
   *         ▼                    ▼
   *         ρ   ──density.ts──▶  UρU†
   *
   * Anything the two paths do differently — a conjugate, a transpose, a
   * control filtered on the wrong index, a stride on the wrong bit — breaks
   * the square. Nothing else in this milestone is this sharp.
   */
  const rng = createRng(23)

  for (const gate of gateCases()) {
    it(`${gate.name} commutes with |ψ⟩ ↦ |ψ⟩⟨ψ|`, () => {
      const psi = randomState(gate.qubits, rng)
      const rho = fromStatevector(psi)

      gate.onDensity(rho)
      gate.onState(psi)

      expectSameDensity(rho, fromStatevector(psi), `${gate.name}: UρU†`)
      expectValidDensity(rho, gate.name)
      // Unitary evolution is exactly purity-preserving: Tr((UρU†)²) = Tr(ρ²).
      expect(purity(rho), `${gate.name}: purity`).toBeCloseTo(1, DIGITS)
    })
  }
})

describe('unitary evolution of a mixed state', () => {
  it('preserves trace, Hermiticity, positivity and purity', () => {
    /*
     * The equivalence above only speaks about pure states, since a mixture has
     * no statevector to compare against. What still holds is the invariant:
     * Tr((UρU†)²) = Tr(ρ²) by cyclicity of the trace, exactly, for every
     * unitary. A gate that leaked amplitude between the ket and the bra index
     * — the single most likely error in a two-pass kernel — moves the purity
     * even when it leaves the trace alone.
     */
    const rng = createRng(29)
    const rho = mixedState(3, rng)
    const before = purity(rho)
    expect(before).toBeLessThan(1)

    for (const gate of gateCases()) {
      if (gate.qubits !== 3) continue
      gate.onDensity(rho)
      expect(trace(rho), `${gate.name}: trace`).toBeCloseTo(1, DIGITS)
      expect(purity(rho), `${gate.name}: purity`).toBeCloseTo(before, DIGITS)
      expect(isHermitian(rho), `${gate.name}: Hermitian`).toBe(true)
    }
    expect(isPositiveSemidefinite(rho)).toBe(true)
  })

  it('is undone by the inverse gate, entry for entry', () => {
    // U†UρU†U = ρ. Independent of any statevector: it is a statement about the
    // two passes composing correctly, and it fails if either pass conjugates
    // the wrong side.
    const rng = createRng(31)
    const rho = mixedState(2, rng)
    const original = clone(rho)

    densityApply1q(rho, uMatrix(1.2, -0.6, 0.3), 1)
    densityApply1q(rho, matrixFor('u', [-1.2, -0.3, 0.6]), 1)
    expectSameDensity(rho, original, 'U† U ρ U† U')
  })
})

/* ────────────────────────────── the guards ──────────────────────────────── */

describe('the kernels refuse the shapes they were not written for', () => {
  it('rejects a qubit outside the register', () => {
    const rho = alloc(2)
    expect(() => densityApply1q(rho, GATE_MATRICES.x, 2)).toThrow(RangeError)
    expect(() => densityApply1q(rho, GATE_MATRICES.x, -1)).toThrow(RangeError)
    expect(() => densityApplySwap(rho, 0, 5)).toThrow(RangeError)
    expect(() => densityApplyISwap(rho, 0, 9)).toThrow(RangeError)
  })

  it('rejects a matrix of the wrong size', () => {
    const rho = alloc(2)
    expect(() => densityApply1q(rho, SWAP_MATRIX, 0)).toThrow(RangeError)
    expect(() => densityApply2q(rho, GATE_MATRICES.x, 0, 1)).toThrow(RangeError)
  })

  it('rejects a two-qubit gate on one qubit twice', () => {
    const rho = alloc(2)
    expect(() => densityApply2q(rho, SWAP_MATRIX, 1, 1)).toThrow(RangeError)
    expect(() => densityApplySwap(rho, 0, 0)).toThrow(RangeError)
  })

  it('rejects a control that is also a target, or repeated', () => {
    const rho = alloc(3)
    expect(() =>
      densityApplyControlled(rho, GATE_MATRICES.x, 1, [{ qubit: 1, state: 1 }])
    ).toThrow(RangeError)
    expect(() =>
      densityApplyControlled(rho, GATE_MATRICES.x, 2, [
        { qubit: 0, state: 1 },
        { qubit: 0, state: 0 },
      ])
    ).toThrow(RangeError)
  })

  it('leaves ρ untouched when a control is never satisfied', () => {
    // |00⟩⟨00| with a positive control on q0: nothing fires, and "nothing"
    // must be exactly nothing rather than a rounding of it.
    const rho = alloc(2)
    const before = clone(rho)
    densityApplyControlled(rho, GATE_MATRICES.x, 1, [{ qubit: 0, state: 1 }])
    expect(maxDeviation(rho, before)).toBe(0)
  })
})

/* ──────────────────────────── the cost, in situ ─────────────────────────── */

describe('a gate costs O(4ⁿ), not O(8ⁿ)', () => {
  /*
   * THE ASSERTION IS THAT THIS TEST FINISHES. There is no wall-clock budget
   * here — those live in `density.perf.test.ts`, because a timing assertion
   * running beside three other workspaces measures the scheduler. What runs
   * here is the guarantee itself, in the shape `numerical-stability.test.ts`
   * uses for the statevector kernel: a register large enough that the
   * forbidden implementation could not complete at all.
   *
   * Ten qubits is a million entries, 16 MB, and twenty gates of two sweeps
   * each: about forty million complex updates, a fraction of a second. The
   * O(8ⁿ) version — build the 1024 × 1024 unitary, multiply twice — is a
   * billion operations per product, roughly four orders of magnitude more, and
   * would blow the runner's timeout on the first gate. So a "simplification"
   * that reintroduced the Kronecker construction shows up here as a suite that
   * hangs, with no timing assertion needed to catch it.
   */
  it('evolves a 10-qubit ρ through twenty gates and stays physical', () => {
    const rho = alloc(10)
    expect(rho.size).toBe(1024 * 1024)

    for (let k = 0; k < 20; k++) {
      const q = k % rho.qubits
      if (k % 3 === 0) densityApply1q(rho, GATE_MATRICES.h, q)
      else if (k % 3 === 1) densityApply1q(rho, rzMatrix(0.3 * k), q)
      else {
        densityApplyControlled(rho, GATE_MATRICES.x, (q + 4) % rho.qubits, [
          { qubit: q, state: 1 },
        ])
      }
    }

    expect(trace(rho)).toBeCloseTo(1, DIGITS)
    expect(isHermitian(rho)).toBe(true)
    // Still pure — it started pure and only unitaries have touched it — so the
    // probability the register is in some basis state adds to one.
    expect(purity(rho)).toBeCloseTo(1, DIGITS)
    const mass = probabilities(rho).reduce((sum, value) => sum + value, 0)
    expect(mass).toBeCloseTo(1, DIGITS)
  })
})
