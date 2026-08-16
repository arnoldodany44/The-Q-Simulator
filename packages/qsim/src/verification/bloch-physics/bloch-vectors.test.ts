/**
 * Independent verification of §5.5: the Bloch vector from the reduced density
 * matrix.
 *
 * Nothing here reuses the engine's own partial trace. `referenceDensity` below
 * builds the full 2ⁿ × 2ⁿ outer product |ψ⟩⟨ψ| and traces the other qubits out
 * with two explicit loops over pairs of basis indices — O(4ⁿ), obviously slow,
 * obviously correct — and the Bloch components come from Tr(ρσ) written out
 * with complex arithmetic rather than from §5.5's three-line shortcut. Every
 * expectation for a named state is derived by hand in the comment above it.
 *
 * The states checked are the ones whose answers are known without a computer:
 * the six cardinal single-qubit states, all four Bell states from both sides,
 * a GHZ triple, a product of three *different* one-qubit states (which is the
 * test a panel that mislabels qubit 0 with qubit 2's vector cannot survive),
 * and a partially entangled pair whose |r| is strictly inside (0, 1).
 */

import { describe, expect, it } from 'vitest'

import {
  GATE_MATRICES,
  apply1q,
  applyControlled,
  alloc,
  blochVector,
  formatKet,
  blochVectors,
  purity,
  reducedDensity,
  ryMatrix,
  run,
  type Statevector,
} from '../../index.js'

/* ─────────────────────── the independent reference ──────────────────── */

interface Cplx {
  re: number
  im: number
}

/**
 * ρ_q by brute force: every ordered pair of basis indices that agrees on
 * every qubit other than `q` contributes ψ_i·conj(ψ_j) to ρ[bit_q(i)][bit_q(j)].
 *
 * This is the definition of a partial trace with nothing folded away, and it
 * uses D1's `(i >> q) & 1` directly, so it is also an independent statement of
 * the endianness convention.
 */
function referenceDensity(state: Statevector, q: number): Cplx[][] {
  const { re, im, size } = state
  const rho: Cplx[][] = [
    [
      { re: 0, im: 0 },
      { re: 0, im: 0 },
    ],
    [
      { re: 0, im: 0 },
      { re: 0, im: 0 },
    ],
  ]
  const mask = ~(1 << q)
  for (let i = 0; i < size; i++) {
    for (let j = 0; j < size; j++) {
      if ((i & mask) !== (j & mask)) continue
      const a = (i >> q) & 1
      const b = (j >> q) & 1
      // ψ_i · conj(ψ_j)
      rho[a][b].re += re[i] * re[j] + im[i] * im[j]
      rho[a][b].im += im[i] * re[j] - re[i] * im[j]
    }
  }
  return rho
}

/** r = (Tr ρσx, Tr ρσy, Tr ρσz), each written out from the matrix entries. */
function referenceBloch(rho: Cplx[][]): [number, number, number] {
  // σx = [[0,1],[1,0]] → Tr(ρσx) = ρ01 + ρ10
  const rx = rho[0][1].re + rho[1][0].re
  // σy = [[0,-i],[i,0]] → Tr(ρσy) = i(ρ01 − ρ10); Re[i·d] = −Im d
  const ry = -(rho[0][1].im - rho[1][0].im)
  // σz = [[1,0],[0,-1]] → Tr(ρσz) = ρ00 − ρ11
  const rz = rho[0][0].re - rho[1][1].re
  return [rx, ry, rz]
}

/** Tr(ρ²) computed as Σ_ab ρ_ab ρ_ba, with no shortcut. */
function referencePurity(rho: Cplx[][]): number {
  let total = 0
  for (let a = 0; a < 2; a++) {
    for (let b = 0; b < 2; b++) {
      total += rho[a][b].re * rho[b][a].re - rho[a][b].im * rho[b][a].im
    }
  }
  return total
}

/** A state from a literal list of amplitudes, index by D1 (qubit 0 is bit 0). */
function stateOf(qubits: number, amplitudes: readonly Cplx[]): Statevector {
  const size = 1 << qubits
  const state: Statevector = {
    qubits,
    size,
    re: new Float64Array(size),
    im: new Float64Array(size),
  }
  amplitudes.forEach((amplitude, index) => {
    state.re[index] = amplitude.re
    state.im[index] = amplitude.im
  })
  return state
}

/** Kronecker product in D1 order: `factors[0]` is qubit 0, the low bit. */
function product(factors: readonly (readonly [Cplx, Cplx])[]): Statevector {
  const qubits = factors.length
  const size = 1 << qubits
  const amplitudes: Cplx[] = []
  for (let index = 0; index < size; index++) {
    let re = 1
    let im = 0
    for (let q = 0; q < qubits; q++) {
      const factor = factors[q][(index >> q) & 1]
      const nextRe = re * factor.re - im * factor.im
      const nextIm = re * factor.im + im * factor.re
      re = nextRe
      im = nextIm
    }
    amplitudes.push({ re, im })
  }
  return stateOf(qubits, amplitudes)
}

const c = (re: number, im = 0): Cplx => ({ re, im })
const INV_ROOT2 = Math.SQRT1_2

const KET0: readonly [Cplx, Cplx] = [c(1), c(0)]
const KET1: readonly [Cplx, Cplx] = [c(0), c(1)]
const PLUS: readonly [Cplx, Cplx] = [c(INV_ROOT2), c(INV_ROOT2)]
const MINUS: readonly [Cplx, Cplx] = [c(INV_ROOT2), c(-INV_ROOT2)]
const PLUS_I: readonly [Cplx, Cplx] = [c(INV_ROOT2), c(0, INV_ROOT2)]
const MINUS_I: readonly [Cplx, Cplx] = [c(INV_ROOT2), c(0, -INV_ROOT2)]

const TOL = 1e-12

function expectVector(
  got: { x: number; y: number; z: number; length: number },
  want: readonly [number, number, number]
): void {
  expect(got.x).toBeCloseTo(want[0], 12)
  expect(got.y).toBeCloseTo(want[1], 12)
  expect(got.z).toBeCloseTo(want[2], 12)
  expect(got.length).toBeCloseTo(Math.hypot(...want), 12)
}

/* ───────────────────── the six cardinal single states ───────────────── */

describe('single-qubit cardinal states, derived by hand', () => {
  /*
   * |0⟩: ρ = [[1,0],[0,0]]. rx = 0, ry = 0, rz = 1 − 0 = 1.
   * |1⟩: ρ = [[0,0],[0,1]]. rz = −1.
   * |+⟩ = (|0⟩+|1⟩)/√2: ρ01 = ½ → rx = 1.
   * |−⟩ = (|0⟩−|1⟩)/√2: ρ01 = −½ → rx = −1.
   * |i⟩ = (|0⟩+i|1⟩)/√2: ρ01 = ψ0·conj(ψ1) = (1/√2)(−i/√2) = −i/2,
   *        so Im ρ01 = −½ and ry = −2·Im ρ01 = +1.
   * |−i⟩: ρ01 = +i/2 → ry = −1.
   */
  const cases: readonly [
    string,
    readonly [Cplx, Cplx],
    [number, number, number],
  ][] = [
    ['|0>', KET0, [0, 0, 1]],
    ['|1>', KET1, [0, 0, -1]],
    ['|+>', PLUS, [1, 0, 0]],
    ['|->', MINUS, [-1, 0, 0]],
    ['|i>', PLUS_I, [0, 1, 0]],
    ['|-i>', MINUS_I, [0, -1, 0]],
  ]

  it.each(cases)('%s has the hand-derived vector', (_name, ket, want) => {
    const state = product([ket])
    expectVector(blochVector(state, 0), want)
    // and the brute-force reference agrees with the hand derivation too
    const reference = referenceBloch(referenceDensity(state, 0))
    for (let axis = 0; axis < 3; axis++) {
      expect(reference[axis]).toBeCloseTo(want[axis], 12)
    }
  })

  it.each(cases)('%s is pure: |r| = 1 and Tr(ρ²) = 1', (_name, ket) => {
    const state = product([ket])
    const density = reducedDensity(state, 0)
    expect(blochVector(state, 0).length).toBeCloseTo(1, 12)
    expect(purity(density)).toBeCloseTo(1, 12)
  })
})

/* ───────────────────────── all four Bell states ─────────────────────── */

describe('Bell states: both halves are the centre of the sphere', () => {
  const R = INV_ROOT2
  /*
   * D1 index order for two qubits: index = q0 + 2·q1, so |q1 q0⟩ printed the
   * conventional way means index 1 is |01⟩ (q0 = 1) and index 2 is |10⟩.
   *
   * Φ± = (|00⟩ ± |11⟩)/√2  →  amplitudes at indices 0 and 3
   * Ψ± = (|01⟩ ± |10⟩)/√2  →  amplitudes at indices 1 and 2
   *
   * Each half traces to I/2 in every case: the diagonal is ½,½ and the
   * off-diagonal sum has exactly one term of each pair missing, so ρ01 = 0.
   * Hence r = 0 and Tr(ρ²) = ½.
   */
  const bell: readonly [string, readonly Cplx[]][] = [
    ['Phi+', [c(R), c(0), c(0), c(R)]],
    ['Phi-', [c(R), c(0), c(0), c(-R)]],
    ['Psi+', [c(0), c(R), c(R), c(0)]],
    ['Psi-', [c(0), c(R), c(-R), c(0)]],
  ]

  it.each(bell)('%s: both qubits sit at the origin', (_name, amplitudes) => {
    const state = stateOf(2, amplitudes)
    for (const qubit of [0, 1]) {
      expectVector(blochVector(state, qubit), [0, 0, 0])
      const density = reducedDensity(state, qubit)
      expect(density.rho00).toBeCloseTo(0.5, 12)
      expect(density.rho11).toBeCloseTo(0.5, 12)
      expect(purity(density)).toBeCloseTo(0.5, 12)
      expect(referenceBloch(referenceDensity(state, qubit))).toEqual([
        expect.closeTo(0, 12),
        expect.closeTo(0, 12),
        expect.closeTo(0, 12),
      ])
    }
  })
})

/* ──────────────────────────────── GHZ ───────────────────────────────── */

describe('GHZ', () => {
  it('gives every one of its three qubits the zero vector', () => {
    // (|000⟩ + |111⟩)/√2 — indices 0 and 7.
    const amplitudes = Array.from({ length: 8 }, () => c(0))
    amplitudes[0] = c(INV_ROOT2)
    amplitudes[7] = c(INV_ROOT2)
    const state = stateOf(3, amplitudes)

    for (const vector of blochVectors(state)) {
      expectVector(vector, [0, 0, 0])
      expect(purity(reducedDensity(state, vector.qubit))).toBeCloseTo(0.5, 12)
    }
  })
})

/* ─────────────── a product of three DIFFERENT single states ─────────── */

describe('a three-qubit product state names its qubits correctly', () => {
  /*
   * q0 = |+⟩       → (1, 0, 0)
   * q1 = |i⟩       → (0, 1, 0)
   * q2 = Ry(θ)|0⟩  = cos(θ/2)|0⟩ + sin(θ/2)|1⟩ → (sin θ, 0, cos θ)
   *
   * Three vectors that share no component, on purpose: any permutation of the
   * three, and any endianness flip, moves at least one of them.
   */
  const THETA = Math.PI / 3
  const half = THETA / 2
  const qubit2: readonly [Cplx, Cplx] = [c(Math.cos(half)), c(Math.sin(half))]

  it('gives each qubit its own vector, in D1 order', () => {
    const state = product([PLUS, PLUS_I, qubit2])
    const vectors = blochVectors(state)

    expect(vectors.map((vector) => vector.qubit)).toEqual([0, 1, 2])
    expectVector(vectors[0], [1, 0, 0])
    expectVector(vectors[1], [0, 1, 0])
    expectVector(vectors[2], [Math.sin(THETA), 0, Math.cos(THETA)])

    // Unentangled ⇒ purity is 1 for every qubit.
    for (const vector of vectors) {
      expect(purity(reducedDensity(state, vector.qubit))).toBeCloseTo(1, 12)
      expect(vector.length).toBeCloseTo(1, 12)
    }
  })

  it('matches the brute-force partial trace qubit by qubit', () => {
    const state = product([PLUS, PLUS_I, qubit2])
    for (let q = 0; q < 3; q++) {
      const want = referenceBloch(referenceDensity(state, q))
      const got = blochVector(state, q)
      expect(got.x).toBeCloseTo(want[0], 12)
      expect(got.y).toBeCloseTo(want[1], 12)
      expect(got.z).toBeCloseTo(want[2], 12)
    }
  })
})

/* ─────────────────────── partial entanglement ───────────────────────── */

describe('a partially entangled pair', () => {
  /*
   * |ψ⟩ = cos α |00⟩ + sin α |11⟩, α = π/8.
   *
   * ρ_0 = diag(cos²α, sin²α), so r = (0, 0, cos²α − sin²α) = (0, 0, cos 2α)
   * and |r| = cos(π/4) = 0,70710678…, strictly between 0 and 1.
   * Tr(ρ²) = cos⁴α + sin⁴α = (1 + cos²2α)/2 = 0,75.
   */
  const ALPHA = Math.PI / 8

  it('shortens both vectors by the same amount', () => {
    const amplitudes = [c(Math.cos(ALPHA)), c(0), c(0), c(Math.sin(ALPHA))]
    const state = stateOf(2, amplitudes)

    for (const qubit of [0, 1]) {
      const vector = blochVector(state, qubit)
      expectVector(vector, [0, 0, Math.cos(2 * ALPHA)])
      expect(vector.length).toBeGreaterThan(0)
      expect(vector.length).toBeLessThan(1)
      expect(vector.length).toBeCloseTo(INV_ROOT2, 12)
      expect(purity(reducedDensity(state, qubit))).toBeCloseTo(0.75, 12)
    }
  })

  it('shortens a Schmidt pair equally even when the state is complex', () => {
    // |ψ⟩ = √0.9 |0⟩⊗|+⟩ + i√0.1 |1⟩⊗|−⟩ in the q1 ⊗ q0 sense: entangled,
    // and neither qubit's vector is axis-aligned.
    const a = Math.sqrt(0.9)
    const b = Math.sqrt(0.1)
    const state = stateOf(2, [
      c(a * INV_ROOT2), // |00⟩
      c(a * INV_ROOT2), // |01⟩  (q0 = 1)
      c(0, b * INV_ROOT2), // |10⟩ (q1 = 1)
      c(0, -b * INV_ROOT2), // |11⟩
    ])

    const first = blochVector(state, 0)
    const second = blochVector(state, 1)
    // Equal Schmidt spectra ⇒ equal |r| for the two halves of a pure pair.
    expect(first.length).toBeCloseTo(second.length, 12)
    expect(first.length).toBeGreaterThan(TOL)
    expect(first.length).toBeLessThan(1 - TOL)

    for (const q of [0, 1]) {
      const want = referenceBloch(referenceDensity(state, q))
      const got = blochVector(state, q)
      expect(got.x).toBeCloseTo(want[0], 12)
      expect(got.y).toBeCloseTo(want[1], 12)
      expect(got.z).toBeCloseTo(want[2], 12)
    }
  })
})

/* ───────────────── random states: the density-matrix laws ───────────── */

describe('random states obey the density-matrix laws', () => {
  /** A deterministic generator, so a failure here is reproducible. */
  function makeRandom(seed: number): () => number {
    let s = seed >>> 0
    return () => {
      s = (s * 1664525 + 1013904223) >>> 0
      return s / 0x100000000
    }
  }

  function randomState(qubits: number, random: () => number): Statevector {
    const size = 1 << qubits
    const re = new Float64Array(size)
    const im = new Float64Array(size)
    let norm = 0
    for (let i = 0; i < size; i++) {
      re[i] = random() * 2 - 1
      im[i] = random() * 2 - 1
      norm += re[i] * re[i] + im[i] * im[i]
    }
    const scale = 1 / Math.sqrt(norm)
    for (let i = 0; i < size; i++) {
      re[i] *= scale
      im[i] *= scale
    }
    return { qubits, size, re, im }
  }

  it('is Hermitian with trace 1, positive semidefinite, |r| ≤ 1', () => {
    const random = makeRandom(20260815)
    for (let trial = 0; trial < 200; trial++) {
      const qubits = 1 + (trial % 5)
      const state = randomState(qubits, random)
      for (let q = 0; q < qubits; q++) {
        const density = reducedDensity(state, q)
        const reference = referenceDensity(state, q)

        // Hermitian: the diagonal is real and ρ₁₀ = conj(ρ₀₁).
        expect(reference[0][0].im).toBeCloseTo(0, 12)
        expect(reference[1][1].im).toBeCloseTo(0, 12)
        expect(reference[1][0].re).toBeCloseTo(density.re01, 12)
        expect(reference[1][0].im).toBeCloseTo(-density.im01, 12)
        expect(reference[0][1].re).toBeCloseTo(density.re01, 12)
        expect(reference[0][1].im).toBeCloseTo(density.im01, 12)

        // Trace 1.
        expect(density.rho00 + density.rho11).toBeCloseTo(1, 12)
        // Non-negative diagonal, and eigenvalues (1 ± |r|)/2 ≥ 0.
        expect(density.rho00).toBeGreaterThanOrEqual(-TOL)
        expect(density.rho11).toBeGreaterThanOrEqual(-TOL)

        const vector = blochVector(state, q)
        expect(vector.length).toBeLessThanOrEqual(1 + 1e-12)

        // The two independent routes to Tr(ρ²) must agree, and both must
        // agree with the brute-force matrix.
        expect(purity(density)).toBeCloseTo((1 + vector.length ** 2) / 2, 12)
        expect(purity(density)).toBeCloseTo(referencePurity(reference), 12)

        const want = referenceBloch(reference)
        expect(vector.x).toBeCloseTo(want[0], 12)
        expect(vector.y).toBeCloseTo(want[1], 12)
        expect(vector.z).toBeCloseTo(want[2], 12)
      }
    }
  })

  it('reaches purity 1 only when the qubit factorises', () => {
    // A product of random one-qubit states must have purity 1 on every qubit;
    // one CNOT away from it, at least one qubit must fall strictly below.
    const random = makeRandom(7)
    for (let trial = 0; trial < 50; trial++) {
      const factors: (readonly [Cplx, Cplx])[] = []
      for (let q = 0; q < 3; q++) {
        const theta = random() * Math.PI
        const phi = random() * 2 * Math.PI
        factors.push([
          c(Math.cos(theta / 2)),
          c(
            Math.sin(theta / 2) * Math.cos(phi),
            Math.sin(theta / 2) * Math.sin(phi)
          ),
        ])
      }
      const state = product(factors)
      for (let q = 0; q < 3; q++) {
        expect(purity(reducedDensity(state, q))).toBeCloseTo(1, 12)
        expect(blochVector(state, q).length).toBeCloseTo(1, 12)
      }
    }
  })

  it('falls strictly below 1 the moment the qubit is entangled', () => {
    // The converse of the claim above, which the product cases cannot make:
    // a Schmidt pair with two non-zero coefficients has purity < 1 on both
    // halves, and purity 1/2 only when the two coefficients are equal.
    for (const alpha of [0.05, 0.3, Math.PI / 8, 0.9, Math.PI / 4 - 0.01]) {
      const state = stateOf(2, [
        c(Math.cos(alpha)),
        c(0),
        c(0),
        c(Math.sin(alpha)),
      ])
      for (const q of [0, 1]) {
        const value = purity(reducedDensity(state, q))
        expect(value).toBeLessThan(1 - 1e-6)
        expect(value).toBeGreaterThanOrEqual(0.5 - TOL)
        expect(blochVector(state, q).length).toBeLessThan(1 - 1e-6)
      }
    }
  })
})

/* ──────────── the same claims through the circuit runner ────────────── */

describe('D1 survives the whole pipeline: circuit JSON in, vectors out', () => {
  /** `run` answers a union; every circuit here is measurement-free. */
  function finalState(circuit: Parameters<typeof run>[0]): Statevector {
    const result = run(circuit)
    if (result.mode !== 'analytic') throw new Error('expected an analytic run')
    return result.state
  }

  it('puts X on the qubit the circuit names, not on its mirror', () => {
    for (const target of [0, 1, 2]) {
      const state = finalState({
        qubits: 3,
        operations: [{ id: 'g', gate: 'x', targets: [target], column: 0 }],
      })
      const vectors = blochVectors(state)
      for (let q = 0; q < 3; q++) {
        expectVector(vectors[q], [0, 0, q === target ? -1 : 1])
      }
      // and the amplitude that carries the whole norm is 2^target
      expect(state.re[1 << target]).toBeCloseTo(1, 12)
      /*
       * The two renderings of the same fact, tied together. The amplitude
       * table prints a ket highest-qubit-first (`formatKet`, Qiskit's reading
       * order) while the sphere grid lists q0 first, so the only way a reader
       * can compare them is if the bit `formatKet` writes for `target` and the
       * sphere that points at |1⟩ are the same qubit.
       */
      const ket = formatKet(1 << target, 3)
      expect(ket).toHaveLength(3)
      expect(ket[3 - 1 - target]).toBe('1')
      expect(ket.replace(/0/g, '')).toBe('1')
    }
  })

  it('refuses a qubit outside the register rather than reading past it', () => {
    const state = alloc(2)
    expect(() => blochVector(state, 2)).toThrow(RangeError)
    expect(() => blochVector(state, -1)).toThrow(RangeError)
  })

  it('draws H·CNOT as two vectors at the centre and the rest untouched', () => {
    const state = finalState({
      qubits: 3,
      operations: [
        { id: 'h', gate: 'h', targets: [0], column: 0 },
        { id: 'cx', gate: 'x', targets: [1], controls: [0], column: 1 },
      ],
    })
    const vectors = blochVectors(state)
    expectVector(vectors[0], [0, 0, 0])
    expectVector(vectors[1], [0, 0, 0])
    expectVector(vectors[2], [0, 0, 1])
  })

  it('agrees with a state built gate by gate through the kernel', () => {
    const state = alloc(3)
    apply1q(state, GATE_MATRICES.h, 0)
    apply1q(state, GATE_MATRICES.s, 0)
    apply1q(state, ryMatrix(Math.PI / 5), 2)
    applyControlled(state, GATE_MATRICES.x, 1, [{ qubit: 0, state: 1 }])

    for (let q = 0; q < 3; q++) {
      const want = referenceBloch(referenceDensity(state, q))
      const got = blochVector(state, q)
      expect(got.x).toBeCloseTo(want[0], 12)
      expect(got.y).toBeCloseTo(want[1], 12)
      expect(got.z).toBeCloseTo(want[2], 12)
    }
    // q2 is untouched by the entangler, so it stays on the surface at Ry(π/5).
    expectVector(blochVector(state, 2), [
      Math.sin(Math.PI / 5),
      0,
      Math.cos(Math.PI / 5),
    ])
  })
})
