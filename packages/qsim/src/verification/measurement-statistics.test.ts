/**
 * INDEPENDENT VERIFICATION — measurement semantics and statistics.
 *
 * Written against the specification (§5.3, §6, §13) and the textbook
 * definitions, not against the engine's own test suite. Wherever an answer can
 * be obtained twice, it is: once from the implementation and once from a slow,
 * obviously-correct reference written here — brute-force enumeration over basis
 * states, closed-form distributions derived by hand, explicit Kronecker
 * products.
 *
 * WHAT IS BEING CHECKED, AND AGAINST WHAT
 *
 *  - Born rule: `probabilities` and `marginalProbability` against a summation
 *    over every index, on states whose amplitudes are set directly so that no
 *    gate kernel sits between the input and the expected answer.
 *  - Collapse: the projection postulate. `⟨P⟩` returned, the disagreeing
 *    amplitudes exactly zero, the survivors rescaled by 1/√p and nothing else,
 *    and the chain rule `P(a ∧ b) = P(a)·P(b|a)` reproduced by two collapses.
 *  - Repeatability: measurement is idempotent. A qubit read as 1 reads 1 again,
 *    for every draw the generator is able to produce.
 *  - Sampling: the joint distribution of shots against distributions computed
 *    in closed form (products of sin²(θ/2), a Bell correlation), by χ² with a
 *    fixed seed, through all three paths that produce counts — the CDF sampler,
 *    repeated `measureQubit`, and a trajectories run.
 *  - The mode boundary: every route into analytic mode that could return a
 *    number for a circuit that has no single final state.
 *
 * The local generators and helpers are deliberately hand-rolled rather than
 * imported: an input built by the code under test cannot falsify it.
 */

import fc from 'fast-check'
import { describe, expect, it } from 'vitest'

import { apply1q, applyControlled, type ControlSpec } from '../apply.js'
import { bitOf } from '../conventions.js'
import { GATE_MATRICES, ryMatrix } from '../gates.js'
import {
  MidCircuitMeasurementError,
  analyticMode,
  collapse,
  marginalProbability,
  measureQubit,
  probabilities,
  sampleShots,
  trajectoriesMode,
  type RunResult,
  type ShotCounts,
} from '../measure.js'
import { createRng, type Rng } from '../rng.js'
import {
  CircuitRunError,
  createCheckpoints,
  run,
  runFrom,
  runTrajectory,
  stateAfterColumn,
  type CircuitLike,
  type OperationLike,
} from '../runner.js'
import { alloc, type Statevector } from '../statevector.js'

/** Decision D6: engine tolerance 1e-10, as digits for `toBeCloseTo`. */
const DIGITS = 10
const TOLERANCE = 1e-10

/**
 * The largest value `Rng.next()` can return.
 *
 * `createRng` builds its double from 27 + 26 bits, so its maximum output is
 * exactly `(2⁵³ − 1)/2⁵³`. Any invariant of the form "this outcome is certain"
 * has to hold at this draw, because a real seeded run reaches it.
 */
const MAX_DRAW = 1 - Number.EPSILON / 2

/**
 * χ² upper-tail critical values. α = 0.001 rather than the usual 0.05: the
 * seeds are fixed, so the only thing a loose threshold buys is a 1-in-20 chance
 * of a red suite that means nothing, while the power against a genuinely wrong
 * distribution at these sample sizes is unaffected.
 */
const CHI2_ALPHA_001 = { dof1: 10.828, dof3: 16.266, dof7: 24.322 }

/** The 95th percentile, for the calibration sweep over many seeds. */
const CHI2_ALPHA_050 = { dof7: 14.067 }

const positive = (qubit: number): ControlSpec => ({ qubit, state: 1 })

/* ───────────────────────── independent references ────────────────────── */

/**
 * A scripted generator. The engine's own docs sanction this — it is how a
 * branch that a seeded run reaches once in 2⁵³ draws becomes a test.
 */
function fixedRng(...values: number[]): Rng {
  let at = 0
  return { next: (): number => values[Math.min(at++, values.length - 1)] }
}

/** A local LCG, so the states under test are not built by `rng.ts`. */
function lcg(seed: number): () => number {
  let word = seed >>> 0 || 0x9e3779b9
  return (): number => {
    word = (Math.imul(word, 1664525) + 1013904223) >>> 0
    return word / 0x100000000
  }
}

/** Amplitudes written straight into the arrays, then normalised by hand. */
function randomState(qubits: number, seed: number): Statevector {
  const state = alloc(qubits)
  const random = lcg(seed)
  let total = 0
  for (let i = 0; i < state.size; i++) {
    const re = random() * 2 - 1
    const im = random() * 2 - 1
    state.re[i] = re
    state.im[i] = im
    total += re * re + im * im
  }
  const scale = 1 / Math.sqrt(total)
  for (let i = 0; i < state.size; i++) {
    state.re[i] *= scale
    state.im[i] *= scale
  }
  return state
}

function copyOf(state: Statevector): Statevector {
  const out = alloc(state.qubits)
  out.re.set(state.re)
  out.im.set(state.im)
  return out
}

/** Σ|aᵢ|², by direct summation over every index. */
function bruteNorm2(state: Statevector): number {
  let total = 0
  for (let i = 0; i < state.size; i++) {
    total += state.re[i] * state.re[i] + state.im[i] * state.im[i]
  }
  return total
}

/** P(qubit = outcome) by testing the bit of every index in turn. */
function bruteMarginal(
  state: Statevector,
  qubit: number,
  outcome: 0 | 1
): number {
  let total = 0
  for (let i = 0; i < state.size; i++) {
    if (bitOf(i, qubit) !== outcome) continue
    total += state.re[i] * state.re[i] + state.im[i] * state.im[i]
  }
  return total
}

/** The 2×2 joint distribution of two qubits, by enumeration. */
function bruteJoint(
  state: Statevector,
  first: number,
  second: number
): number[][] {
  const table = [
    [0, 0],
    [0, 0],
  ]
  for (let i = 0; i < state.size; i++) {
    table[bitOf(i, first)][bitOf(i, second)] +=
      state.re[i] * state.re[i] + state.im[i] * state.im[i]
  }
  return table
}

/** Ket label, highest qubit first — the convention of D1, rewritten here. */
function ketLabel(index: number, qubits: number): string {
  let out = ''
  for (let q = qubits - 1; q >= 0; q--) out += bitOf(index, q)
  return out
}

/** A one-qubit amplitude pair, for the explicit tensor product below. */
interface Ket1 {
  readonly re: readonly number[]
  readonly im: readonly number[]
}

/**
 * Complex Kronecker product `a ⊗ b`, textbook definition: the entry at
 * `iₐ·dim(b) + i_b` is `aᵢₐ·b_ib`. With the highest qubit as the leftmost
 * factor this reproduces D1's index layout without using any of its helpers.
 */
function kron(a: Ket1, b: Ket1): Ket1 {
  const re: number[] = []
  const im: number[] = []
  for (let ia = 0; ia < a.re.length; ia++) {
    for (let ib = 0; ib < b.re.length; ib++) {
      re.push(a.re[ia] * b.re[ib] - a.im[ia] * b.im[ib])
      im.push(a.re[ia] * b.im[ib] + a.im[ia] * b.re[ib])
    }
  }
  return { re, im }
}

function stateFromKet(ket: Ket1, qubits: number): Statevector {
  const state = alloc(qubits)
  state.re.set(ket.re)
  state.im.set(ket.im)
  return state
}

function toMap(counts: ShotCounts): Map<string, number> {
  return new Map(Object.entries(counts))
}

function totalOf(counts: ReadonlyMap<string, number>): number {
  let total = 0
  for (const value of counts.values()) total += value
  return total
}

/**
 * Pearson's χ² of an observed tally against a theoretical distribution.
 * Outcomes the theory forbids are not folded in — they are asserted absent
 * separately, because an impossible outcome is a defect and not a large χ².
 */
function chiSquared(
  observed: ReadonlyMap<string, number>,
  expected: ReadonlyMap<string, number>,
  shots: number
): number {
  let sum = 0
  for (const [key, probability] of expected) {
    const predicted = probability * shots
    const seen = observed.get(key) ?? 0
    sum += ((seen - predicted) * (seen - predicted)) / predicted
  }
  return sum
}

/* ───────────────────── hand-derived reference states ──────────────────── */

/**
 * Three independent Ry rotations. Ry(θ)|0⟩ = cos(θ/2)|0⟩ + sin(θ/2)|1⟩, so the
 * joint distribution is the product of the per-qubit ones — closed form, no
 * simulation involved. The angles are unequal and none of them is a special
 * value, so a swapped qubit index or a dropped half-angle changes the answer.
 */
const PRODUCT_ANGLES = [0.7, 1.9, 2.6] as const

function productState(): Statevector {
  const state = alloc(PRODUCT_ANGLES.length)
  for (let q = 0; q < PRODUCT_ANGLES.length; q++) {
    apply1q(state, ryMatrix(PRODUCT_ANGLES[q]), q)
  }
  return state
}

function productDistribution(): Map<string, number> {
  const qubits = PRODUCT_ANGLES.length
  const out = new Map<string, number>()
  for (let index = 0; index < 1 << qubits; index++) {
    let probability = 1
    for (let q = 0; q < qubits; q++) {
      const half = PRODUCT_ANGLES[q] / 2
      const one = Math.sin(half) * Math.sin(half)
      probability *= bitOf(index, q) === 1 ? one : 1 - one
    }
    out.set(ketLabel(index, qubits), probability)
  }
  return out
}

/** The marginal each qubit of `productState()` must have: sin²(θ/2). */
function productMarginal(qubit: number): number {
  const half = PRODUCT_ANGLES[qubit] / 2
  return Math.sin(half) * Math.sin(half)
}

const ENTANGLED_ANGLE = 1.1

/**
 * H q0, CX q0→q1, Ry(φ) q2 — a correlated pair beside an independent qubit.
 * Half of the eight basis states are forbidden, which is what makes it a
 * sharper test of a sampler than any product distribution.
 */
function entangledState(): Statevector {
  const state = alloc(3)
  apply1q(state, GATE_MATRICES.h, 0)
  applyControlled(state, GATE_MATRICES.x, 1, [positive(0)])
  apply1q(state, ryMatrix(ENTANGLED_ANGLE), 2)
  return state
}

/** P(b₂b₁b₀) = ½·[b₀ = b₁]·(sin² or cos² of φ/2). Derived by hand. */
function entangledDistribution(): Map<string, number> {
  const half = ENTANGLED_ANGLE / 2
  const one = Math.sin(half) * Math.sin(half)
  const out = new Map<string, number>()
  for (let index = 0; index < 8; index++) {
    if (bitOf(index, 0) !== bitOf(index, 1)) continue
    const top = bitOf(index, 2) === 1 ? one : 1 - one
    out.set(ketLabel(index, 3), 0.5 * top)
  }
  return out
}

/* ──────────────────────────── test circuits ──────────────────────────── */

/** The product state, with every qubit measured into the matching clbit. */
function measureAllCircuit(): CircuitLike {
  const operations: OperationLike[] = []
  for (let q = 0; q < PRODUCT_ANGLES.length; q++) {
    operations.push({
      id: `ry${q}`,
      gate: 'ry',
      targets: [q],
      params: [PRODUCT_ANGLES[q]],
      column: 0,
    })
  }
  for (let q = 0; q < PRODUCT_ANGLES.length; q++) {
    operations.push({
      id: `m${q}`,
      gate: 'measure',
      targets: [q],
      clbitTargets: [q],
      column: 1,
    })
  }
  return {
    qubits: PRODUCT_ANGLES.length,
    clbits: PRODUCT_ANGLES.length,
    operations,
  }
}

/** H, then the same qubit measured twice into two different clbits. */
const REMEASURE_CIRCUIT: CircuitLike = {
  qubits: 1,
  clbits: 2,
  operations: [
    { id: 'h', gate: 'h', targets: [0], column: 0 },
    { id: 'm0', gate: 'measure', targets: [0], clbitTargets: [0], column: 1 },
    { id: 'm1', gate: 'measure', targets: [0], clbitTargets: [1], column: 2 },
  ],
}

/** The §6 shape: measure, then a gate conditioned on what was read. */
const CONDITIONED_CIRCUIT: CircuitLike = {
  qubits: 2,
  clbits: 2,
  operations: [
    { id: 'h', gate: 'h', targets: [0], column: 0 },
    { id: 'm0', gate: 'measure', targets: [0], clbitTargets: [0], column: 1 },
    {
      id: 'x',
      gate: 'x',
      targets: [1],
      column: 2,
      condition: { clbit: 0, equals: 1 },
    },
    { id: 'm1', gate: 'measure', targets: [1], clbitTargets: [1], column: 3 },
  ],
}

function countsOf(result: RunResult): ShotCounts {
  if (result.mode !== 'trajectories') {
    throw new Error('expected a trajectories result')
  }
  return result.counts
}

function stateOf(result: RunResult): Statevector {
  if (result.mode !== 'analytic') {
    throw new Error('expected an analytic result')
  }
  return result.state
}

/* ═══════════════════════════════ the tests ════════════════════════════ */

describe('Born rule against brute force', () => {
  it('gives every basis state |aᵢ|², on states with no structure', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 1, max: 6 }),
        fc.integer({ min: 1, max: 2 ** 30 }),
        (qubits, seed) => {
          const state = randomState(qubits, seed)
          const engine = probabilities(state)
          expect(engine).toHaveLength(state.size)
          for (let i = 0; i < state.size; i++) {
            const re = state.re[i]
            const im = state.im[i]
            expect(engine[i], `p[${i}]`).toBeCloseTo(re * re + im * im, DIGITS)
          }
        }
      )
    )
  })

  it('sums to one, and never emits a negative probability', () => {
    for (let seed = 1; seed <= 25; seed++) {
      const state = randomState(5, seed)
      const engine = probabilities(state)
      let total = 0
      for (let i = 0; i < engine.length; i++) {
        expect(engine[i], `p[${i}]`).toBeGreaterThanOrEqual(0)
        total += engine[i]
      }
      expect(Math.abs(total - 1), `seed ${seed}`).toBeLessThan(TOLERANCE)
    }
  })

  it('matches a marginal summed index by index, on every qubit', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 1, max: 6 }),
        fc.integer({ min: 1, max: 2 ** 30 }),
        (qubits, seed) => {
          const state = randomState(qubits, seed)
          for (let q = 0; q < qubits; q++) {
            expect(marginalProbability(state, q), `q${q}`).toBeCloseTo(
              bruteMarginal(state, q, 1),
              DIGITS
            )
          }
        }
      )
    )
  })

  it('has complementary marginals that sum to one on every qubit', () => {
    // P(q=0) is not computed by the engine, so this is the arithmetic the UI
    // will do: the pair has to close, or one of the two bars is wrong.
    for (let seed = 1; seed <= 20; seed++) {
      const state = randomState(4, seed)
      for (let q = 0; q < 4; q++) {
        const one = marginalProbability(state, q)
        const zero = bruteMarginal(state, q, 0)
        expect(Math.abs(one + zero - 1), `seed ${seed} q${q}`).toBeLessThan(
          TOLERANCE
        )
      }
    }
  })

  it('reads the marginal off the right qubit — explicit tensor product', () => {
    // ψ = ψ₂ ⊗ ψ₁ ⊗ ψ₀, built by the textbook Kronecker product with the
    // highest qubit leftmost. Three different marginals, so a reversed bit
    // order cannot hide behind a symmetric state: big-endian would report
    // 0.5 for qubit 0 and 0.64 for qubit 2.
    const q0: Ket1 = { re: [0.6, 0.8], im: [0, 0] } // P(1) = 0.64
    const q1: Ket1 = { re: [0, 0], im: [0.28, 0.96] } // P(1) = 0.9216
    const q2: Ket1 = { re: [Math.SQRT1_2, 0], im: [0, Math.SQRT1_2] } // 0.5
    const state = stateFromKet(kron(q2, kron(q1, q0)), 3)

    expect(bruteNorm2(state)).toBeCloseTo(1, DIGITS)
    expect(marginalProbability(state, 0), 'q0').toBeCloseTo(0.64, DIGITS)
    expect(marginalProbability(state, 1), 'q1').toBeCloseTo(0.9216, DIGITS)
    expect(marginalProbability(state, 2), 'q2').toBeCloseTo(0.5, DIGITS)
  })

  it('matches the closed form of a product of Ry rotations', () => {
    const state = productState()
    for (let q = 0; q < PRODUCT_ANGLES.length; q++) {
      expect(marginalProbability(state, q), `q${q}`).toBeCloseTo(
        productMarginal(q),
        DIGITS
      )
    }
    const expected = productDistribution()
    const engine = probabilities(state)
    for (let index = 0; index < state.size; index++) {
      const key = ketLabel(index, 3)
      expect(engine[index], key).toBeCloseTo(expected.get(key) ?? -1, DIGITS)
    }
  })

  it('keeps the joint distinct from the product of marginals when entangled', () => {
    // The check that the marginal is a marginal and not a factorisation: in a
    // Bell pair both marginals are ½ but P(1,1) is ½, not ¼.
    const state = alloc(2)
    apply1q(state, GATE_MATRICES.h, 0)
    applyControlled(state, GATE_MATRICES.x, 1, [positive(0)])

    const joint = bruteJoint(state, 0, 1)
    expect(marginalProbability(state, 0)).toBeCloseTo(0.5, DIGITS)
    expect(marginalProbability(state, 1)).toBeCloseTo(0.5, DIGITS)
    expect(joint[1][1]).toBeCloseTo(0.5, DIGITS)
    expect(joint[0][1]).toBeCloseTo(0, DIGITS)
    expect(joint[1][0]).toBeCloseTo(0, DIGITS)
    // And the marginal is the sum of the joint over the partner.
    expect(joint[1][0] + joint[1][1]).toBeCloseTo(
      marginalProbability(state, 0),
      DIGITS
    )
  })
})

describe('collapse — the projection postulate', () => {
  it('zeroes exactly the disagreeing amplitudes and no others', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 1, max: 5 }),
        fc.integer({ min: 1, max: 2 ** 30 }),
        fc.integer({ min: 0, max: 1 }),
        (qubits, seed, bit) => {
          const outcome = bit as 0 | 1
          const before = randomState(qubits, seed)
          const state = copyOf(before)
          const target = qubits - 1
          collapse(state, target, outcome)
          for (let i = 0; i < state.size; i++) {
            if (bitOf(i, target) === outcome) {
              // A survivor of a random state is never exactly zero, so this
              // catches an over-eager sweep as well as a misplaced stride.
              expect(state.re[i] !== 0 || state.im[i] !== 0, `kept ${i}`).toBe(
                true
              )
            } else {
              expect(state.re[i], `re[${i}]`).toBe(0)
              expect(state.im[i], `im[${i}]`).toBe(0)
            }
          }
        }
      )
    )
  })

  it('leaves a unit-norm state for every qubit and both outcomes', () => {
    for (let seed = 1; seed <= 12; seed++) {
      for (let q = 0; q < 4; q++) {
        for (const outcome of [0, 1] as const) {
          const state = randomState(4, seed)
          collapse(state, q, outcome)
          const drift = Math.abs(bruteNorm2(state) - 1)
          expect(drift, `seed ${seed} q${q} → ${outcome}`).toBeLessThan(
            TOLERANCE
          )
        }
      }
    }
  })

  it('renormalises by 1/√p and redistributes nothing', () => {
    // Bayes: P(i | q = b) = P(i)/P(b) for the surviving half. Anything else
    // is the engine inventing correlations the measurement did not create.
    const source = randomState(4, 4242)
    for (const outcome of [0, 1] as const) {
      const state = copyOf(source)
      const before = probabilities(source)
      const p = collapse(state, 2, outcome)
      const after = probabilities(state)
      for (let i = 0; i < state.size; i++) {
        const expected = bitOf(i, 2) === outcome ? before[i] / p : 0
        expect(after[i], `outcome ${outcome} p[${i}]`).toBeCloseTo(
          expected,
          DIGITS
        )
      }
    }
  })

  it('returns the probability the outcome had, brute-forced', () => {
    for (let seed = 1; seed <= 10; seed++) {
      for (const outcome of [0, 1] as const) {
        const source = randomState(3, seed)
        const expected = bruteMarginal(source, 1, outcome)
        const state = copyOf(source)
        expect(collapse(state, 1, outcome), `seed ${seed}`).toBeCloseTo(
          expected,
          DIGITS
        )
      }
    }
  })

  it('reproduces a two-qubit joint through the chain rule', () => {
    // P(q₀=a ∧ q₂=b) = P(q₀=a)·P(q₂=b | q₀=a). The left side comes from
    // enumeration over the untouched state, the right from two collapses.
    const source = randomState(4, 8080)
    const joint = bruteJoint(source, 0, 2)
    for (const a of [0, 1] as const) {
      for (const b of [0, 1] as const) {
        const state = copyOf(source)
        const first = collapse(state, 0, a)
        const second = collapse(state, 2, b)
        expect(first * second, `P(${a},${b})`).toBeCloseTo(joint[a][b], DIGITS)
      }
    }
  })

  it('leaves the other qubits at their conditional marginals', () => {
    const source = randomState(4, 31415)
    for (const outcome of [0, 1] as const) {
      const conditioning = bruteMarginal(source, 0, outcome)
      const state = copyOf(source)
      collapse(state, 0, outcome)
      for (let q = 1; q < 4; q++) {
        // P(q=1 | q₀=outcome), summed by hand over the agreeing indices.
        let joint = 0
        for (let i = 0; i < source.size; i++) {
          if (bitOf(i, 0) !== outcome || bitOf(i, q) !== 1) continue
          joint += source.re[i] * source.re[i] + source.im[i] * source.im[i]
        }
        expect(marginalProbability(state, q), `q${q}|${outcome}`).toBeCloseTo(
          joint / conditioning,
          DIGITS
        )
      }
    }
  })

  it('refuses an outcome the state forbids rather than emitting NaNs', () => {
    const state = alloc(2)
    apply1q(state, GATE_MATRICES.x, 1) // |10⟩: qubit 0 can only read 0
    expect(() => collapse(state, 0, 1)).toThrow(RangeError)
  })

  it('leaves the state intact when it refuses', () => {
    // A rejected operation must not consume the state on its way out: a caller
    // that catches the error — the editor showing "that outcome is impossible"
    // and keeping the last good state — must still be holding a physical
    // vector. Bit-for-bit rather than by norm, because atomicity is the
    // invariant and a norm of 1 is only its cheapest consequence.
    const state = alloc(2)
    apply1q(state, GATE_MATRICES.x, 1) // |10⟩
    const before = copyOf(state)
    expect(() => collapse(state, 0, 1)).toThrow(RangeError)
    expect(Array.from(state.re)).toEqual(Array.from(before.re))
    expect(Array.from(state.im)).toEqual(Array.from(before.im))
    expect(bruteNorm2(state)).toBeCloseTo(1, DIGITS)
  })
})

describe('repeated measurement is idempotent', () => {
  it('reads the same value twice, over many states and seeds', () => {
    for (let seed = 1; seed <= 30; seed++) {
      const state = randomState(4, seed)
      const rng = createRng(seed)
      for (let q = 0; q < 4; q++) {
        const first = measureQubit(state, q, rng)
        expect(measureQubit(state, q, rng), `seed ${seed} q${q}`).toBe(first)
        expect(measureQubit(state, q, rng), `seed ${seed} q${q}`).toBe(first)
      }
    }
  })

  it('makes the read value certain for every draw the generator can emit', () => {
    // THE CORRECT INVARIANT, restated: `marginalProbability >= 1` is not it.
    // Renormalising by 1/√kept leaves the surviving half at 1 − 2e-16 here and
    // 1 − 2e-14 at twenty qubits, and no Float64 renormalisation can reach 1
    // exactly — demanding it would mean nudging the scale in a loop. What the
    // projection postulate actually requires is that the *primitive* be
    // idempotent for every value `next()` can emit, which is exact once the
    // draw is scaled by the state's own mass instead of compared with a
    // marginal that assumes a unit norm. So: the marginal is within D6's
    // tolerance of 1, and no draw in range re-reads the other outcome.
    const state = alloc(2)
    apply1q(state, GATE_MATRICES.h, 0)
    apply1q(state, GATE_MATRICES.h, 1)
    expect(measureQubit(state, 0, fixedRng(0.1))).toBe(1)
    expect(marginalProbability(state, 0)).toBeCloseTo(1, DIGITS)
    for (const draw of [0, 0.5, MAX_DRAW]) {
      expect(measureQubit(state, 0, fixedRng(draw)), `draw ${draw}`).toBe(1)
    }
  })

  it('re-reads 1 at the top of the draw range', () => {
    // The consequence of the invariant above, exercised through the public
    // primitive: a second measurement of an already-collapsed qubit, with the
    // generator at its maximum output.
    const state = alloc(2)
    apply1q(state, GATE_MATRICES.h, 0)
    apply1q(state, GATE_MATRICES.h, 1)
    const first = measureQubit(state, 0, fixedRng(0.1))
    expect(measureQubit(state, 0, fixedRng(MAX_DRAW))).toBe(first)
  })

  it('never reads 1 on a qubit collapsed onto 0, at any draw', () => {
    const state = alloc(2)
    apply1q(state, GATE_MATRICES.h, 0)
    apply1q(state, GATE_MATRICES.h, 1)
    expect(measureQubit(state, 0, fixedRng(0.9))).toBe(0)
    expect(marginalProbability(state, 0)).toBe(0)
    expect(measureQubit(state, 0, fixedRng(0))).toBe(0)
  })

  it('agrees with itself across a circuit that measures twice', () => {
    const result = run(REMEASURE_CIRCUIT, trajectoriesMode(2_000, createRng(7)))
    const counts = countsOf(result)
    // The register prints highest clbit first, and both clbits hold the same
    // qubit, so "01" or "10" would be a qubit that changed its mind.
    expect(Object.keys(counts).sort()).toEqual(['00', '11'])
    expect(totalOf(toMap(counts))).toBe(2_000)
  })

  it('leaves an entangled partner certain too', () => {
    // Measuring one half of a Bell pair fixes the other; reading the partner
    // must then be free of randomness, not merely likely to agree.
    for (let seed = 1; seed <= 25; seed++) {
      const state = alloc(2)
      apply1q(state, GATE_MATRICES.h, 0)
      applyControlled(state, GATE_MATRICES.x, 1, [positive(0)])
      const first = measureQubit(state, 0, createRng(seed))
      expect(bruteMarginal(state, 1, first), `seed ${seed}`).toBeCloseTo(
        1,
        DIGITS
      )
      expect(measureQubit(state, 1, fixedRng(0.5)), `seed ${seed}`).toBe(first)
    }
  })
})

describe('shot sampling converges to the theoretical distribution', () => {
  const SHOTS = 100_000

  it('matches a product of Ry rotations (χ², 7 dof, fixed seed)', () => {
    const expected = productDistribution()
    const counts = toMap(
      sampleShots(productState(), SHOTS, createRng(20260814))
    )
    expect(totalOf(counts)).toBe(SHOTS)
    for (const key of counts.keys()) expect(expected.has(key)).toBe(true)

    const value = chiSquared(counts, expected, SHOTS)
    expect(value, `χ² = ${value}`).toBeLessThan(CHI2_ALPHA_001.dof7)
  })

  it('matches a correlated pair beside a rotation (χ², 3 dof)', () => {
    const expected = entangledDistribution()
    const counts = toMap(sampleShots(entangledState(), SHOTS, createRng(1917)))
    expect(totalOf(counts)).toBe(SHOTS)
    // Four of the eight basis states have zero amplitude. A sampler that ever
    // emits one has a boundary bug, and no χ² would express it.
    expect([...counts.keys()].sort()).toEqual([...expected.keys()].sort())

    const value = chiSquared(counts, expected, SHOTS)
    expect(value, `χ² = ${value}`).toBeLessThan(CHI2_ALPHA_001.dof3)
  })

  it('is not systematically biased — 20 seeds at the 95th percentile', () => {
    // One fixed seed proves the sampler is not grossly wrong. A sweep proves
    // the χ² statistic itself is distributed the way it should be: about one
    // rejection in twenty is expected, and a sampler with a small constant
    // skew would reject far more often while still passing any single seed.
    const expected = productDistribution()
    let rejections = 0
    for (let seed = 1; seed <= 20; seed++) {
      const counts = toMap(sampleShots(productState(), 20_000, createRng(seed)))
      if (chiSquared(counts, expected, 20_000) >= CHI2_ALPHA_050.dof7) {
        rejections++
      }
    }
    expect(rejections, `${rejections}/20 seeds rejected`).toBeLessThanOrEqual(5)
  })

  it('recovers each qubit marginal from the labels it wrote', () => {
    // Binds the histogram's key order to the physics. The three marginals are
    // 0.118, 0.660 and 0.928, so reading the label back to front would be a
    // gross mismatch rather than a subtle one.
    const state = productState()
    const counts = toMap(sampleShots(state, SHOTS, createRng(5150)))
    for (let q = 0; q < PRODUCT_ANGLES.length; q++) {
      let ones = 0
      for (const [key, count] of counts) {
        if (key[PRODUCT_ANGLES.length - 1 - q] === '1') ones += count
      }
      // 100 000 shots put the standard error near 0.0016; 0.01 is ~6σ.
      expect(ones / SHOTS, `q${q}`).toBeCloseTo(productMarginal(q), 2)
      expect(
        Math.abs(ones / SHOTS - marginalProbability(state, q)),
        `q${q}`
      ).toBeLessThan(0.01)
    }
  })

  it('never hands out an outcome of probability zero', () => {
    const bell = alloc(2)
    apply1q(bell, GATE_MATRICES.h, 0)
    applyControlled(bell, GATE_MATRICES.x, 1, [positive(0)])
    expect(
      Object.keys(sampleShots(bell, 50_000, createRng(918273))).sort()
    ).toEqual(['00', '11'])

    // The two draws where a cumulative search goes wrong: the very bottom,
    // where a leading zero-probability outcome sits, and the very top, where
    // a trailing one does. (`alloc` starts in |00⟩, so index 0 is cleared
    // explicitly — otherwise the leading outcome is not the forbidden one.)
    const leading = alloc(2)
    leading.re[0] = 0
    leading.re[1] = 0.6
    leading.re[2] = 0.8
    expect(sampleShots(leading, 2, fixedRng(0))).toEqual({ '01': 2 })

    const trailing = alloc(2)
    trailing.re[0] = 0.6
    trailing.re[1] = 0.8
    expect(sampleShots(trailing, 2, fixedRng(MAX_DRAW))).toEqual({ '01': 2 })
  })

  it('does not disturb the state it sampled', () => {
    const state = productState()
    const re = Array.from(state.re)
    const im = Array.from(state.im)
    sampleShots(state, 5_000, createRng(3))
    expect(Array.from(state.re)).toEqual(re)
    expect(Array.from(state.im)).toEqual(im)
  })
})

describe('collapse-based measurement reproduces the same distribution', () => {
  const TRIALS = 40_000

  it('tallies sequential measureQubit into the theoretical joint (χ²)', () => {
    // The chain rule, exercised the way a trajectory does it: measure q0,
    // collapse, measure q1 against the conditional, and so on. If collapse
    // renormalised wrongly the later qubits would drift even though each
    // individual marginal looked right.
    const rng = createRng(606)
    const tally = new Map<string, number>()
    for (let trial = 0; trial < TRIALS; trial++) {
      const state = productState()
      let index = 0
      for (let q = 0; q < PRODUCT_ANGLES.length; q++) {
        if (measureQubit(state, q, rng) === 1) index |= 1 << q
      }
      const key = ketLabel(index, PRODUCT_ANGLES.length)
      tally.set(key, (tally.get(key) ?? 0) + 1)
    }
    expect(totalOf(tally)).toBe(TRIALS)

    const value = chiSquared(tally, productDistribution(), TRIALS)
    expect(value, `χ² = ${value}`).toBeLessThan(CHI2_ALPHA_001.dof7)
  })

  it('measures an entangled state in reverse qubit order and still agrees', () => {
    // Measurement order must not matter: the joint is a property of the state.
    // Here q2, then q1, then q0 — the opposite of the order above.
    const rng = createRng(707)
    const tally = new Map<string, number>()
    for (let trial = 0; trial < TRIALS; trial++) {
      const state = entangledState()
      let index = 0
      for (let q = 2; q >= 0; q--) {
        if (measureQubit(state, q, rng) === 1) index |= 1 << q
      }
      tally.set(ketLabel(index, 3), (tally.get(ketLabel(index, 3)) ?? 0) + 1)
    }
    const expected = entangledDistribution()
    for (const key of tally.keys()) expect(expected.has(key)).toBe(true)

    const value = chiSquared(tally, expected, TRIALS)
    expect(value, `χ² = ${value}`).toBeLessThan(CHI2_ALPHA_001.dof3)
  })

  it('tallies a trajectories run into the same theoretical joint (χ²)', () => {
    const shots = 40_000
    const counts = toMap(
      countsOf(run(measureAllCircuit(), trajectoriesMode(shots, createRng(99))))
    )
    expect(totalOf(counts)).toBe(shots)

    const value = chiSquared(counts, productDistribution(), shots)
    expect(value, `χ² = ${value}`).toBeLessThan(CHI2_ALPHA_001.dof7)
  })

  it('propagates a measurement through a classically conditioned gate', () => {
    // H, measure q0, X q1 if the bit read 1, measure q1. The two clbits must
    // agree in every shot and split evenly — the §6 example, as statistics.
    const shots = 20_000
    const counts = toMap(
      countsOf(run(CONDITIONED_CIRCUIT, trajectoriesMode(shots, createRng(21))))
    )
    expect(Object.keys(Object.fromEntries(counts)).sort()).toEqual(['00', '11'])

    const expected = new Map([
      ['00', 0.5],
      ['11', 0.5],
    ])
    const value = chiSquared(counts, expected, shots)
    expect(value, `χ² = ${value}`).toBeLessThan(CHI2_ALPHA_001.dof1)
  })

  it('clears the classical register between shots', () => {
    // q1 is |1⟩ and is measured only when the first reading was 1, so clbit 1
    // is written in half the shots and left alone in the other half. If the
    // register survived a shot, those untouched shots would report the
    // previous trajectory's bit and "10" would appear in the histogram.
    const circuit: CircuitLike = {
      qubits: 2,
      clbits: 2,
      operations: [
        { id: 'x1', gate: 'x', targets: [1], column: 0 },
        { id: 'h0', gate: 'h', targets: [0], column: 1 },
        {
          id: 'm0',
          gate: 'measure',
          targets: [0],
          clbitTargets: [0],
          column: 2,
        },
        {
          id: 'm1',
          gate: 'measure',
          targets: [1],
          clbitTargets: [1],
          column: 3,
          condition: { clbit: 0, equals: 1 },
        },
      ],
    }
    const shots = 20_000
    const counts = toMap(
      countsOf(run(circuit, trajectoriesMode(shots, createRng(4004))))
    )
    expect([...counts.keys()].sort()).toEqual(['00', '11'])

    const expected = new Map([
      ['00', 0.5],
      ['11', 0.5],
    ])
    const value = chiSquared(counts, expected, shots)
    expect(value, `χ² = ${value}`).toBeLessThan(CHI2_ALPHA_001.dof1)
  })

  it('reports exactly the shots it was asked for, reproducibly', () => {
    // §13 and D5: a seeded run is a regression test only if the same seed
    // gives the same histogram and a different one does not.
    const circuit = measureAllCircuit()
    const first = run(circuit, trajectoriesMode(3_000, createRng(2718)))
    const again = run(circuit, trajectoriesMode(3_000, createRng(2718)))
    const other = run(circuit, trajectoriesMode(3_000, createRng(2719)))
    expect(first.mode === 'trajectories' && first.shots).toBe(3_000)
    expect(totalOf(toMap(countsOf(first)))).toBe(3_000)
    expect(countsOf(again)).toEqual(countsOf(first))
    expect(countsOf(other)).not.toEqual(countsOf(first))
  })

  it('gives one trajectory a state that is a basis state of the measured qubit', () => {
    for (let seed = 1; seed <= 10; seed++) {
      const { state, register } = runTrajectory(
        CONDITIONED_CIRCUIT,
        createRng(seed)
      )
      // Both qubits were measured, so nothing is in superposition any more.
      expect(marginalProbability(state, 0)).toBeCloseTo(register[0], DIGITS)
      expect(marginalProbability(state, 1)).toBeCloseTo(register[1], DIGITS)
      expect(bruteNorm2(state)).toBeCloseTo(1, DIGITS)
    }
  })
})

describe('the analytic / trajectories boundary is enforced', () => {
  it('refuses a circuit that measures, naming the operation and the way out', () => {
    expect(() => run(measureAllCircuit(), analyticMode())).toThrow(
      MidCircuitMeasurementError
    )
    try {
      run(REMEASURE_CIRCUIT, analyticMode())
      expect.unreachable('analytic mode must refuse a measuring circuit')
    } catch (error) {
      const message = (error as Error).message
      expect(message).toContain('m0')
      expect(message).toContain('trajectories mode')
    }
  })

  it('refuses a conditioned gate even with no measurement in sight', () => {
    // A condition reads a classical bit, and analytic mode has no register to
    // read it from. Applying it as if the bit were 0 would be silent physics.
    const circuit: CircuitLike = {
      qubits: 1,
      clbits: 1,
      operations: [
        {
          id: 'cx',
          gate: 'x',
          targets: [0],
          column: 0,
          condition: { clbit: 0, equals: 0 },
        },
      ],
    }
    expect(() => run(circuit, analyticMode())).toThrow(
      MidCircuitMeasurementError
    )
  })

  it('refuses a reset of a qubit that is in superposition', () => {
    const circuit: CircuitLike = {
      qubits: 1,
      operations: [
        { id: 'h', gate: 'h', targets: [0], column: 0 },
        { id: 'r', gate: 'reset', targets: [0], column: 1 },
      ],
    }
    expect(() => run(circuit, analyticMode())).toThrow(
      MidCircuitMeasurementError
    )
  })

  it('allows a reset that is not random, and gets it right', () => {
    // |1⟩ resets to |0⟩ with no coin involved, so refusing it would make
    // analytic mode reject circuits that have no ambiguity in them.
    const circuit: CircuitLike = {
      qubits: 2,
      operations: [
        { id: 'x0', gate: 'x', targets: [0], column: 0 },
        { id: 'x1', gate: 'x', targets: [1], column: 0 },
        { id: 'r', gate: 'reset', targets: [0], column: 1 },
      ],
    }
    const state = stateOf(run(circuit, analyticMode()))
    // |10⟩: qubit 1 still set, qubit 0 back to zero.
    expect(marginalProbability(state, 0)).toBeCloseTo(0, DIGITS)
    expect(marginalProbability(state, 1)).toBeCloseTo(1, DIGITS)
    expect(probabilities(state)[2]).toBeCloseTo(1, DIGITS)
  })

  it('refuses a partial run of a measuring circuit rather than half-answering', () => {
    const cache = createCheckpoints()
    expect(() => stateAfterColumn(cache, REMEASURE_CIRCUIT, 0)).toThrow(
      MidCircuitMeasurementError
    )
    expect(() => runFrom(cache, REMEASURE_CIRCUIT, 0)).toThrow(
      MidCircuitMeasurementError
    )
  })

  it('refuses a trajectories run that has no register to report', () => {
    const circuit: CircuitLike = {
      qubits: 1,
      operations: [{ id: 'h', gate: 'h', targets: [0], column: 0 }],
    }
    expect(() => run(circuit, trajectoriesMode(10, createRng(1)))).toThrow(
      CircuitRunError
    )
  })

  it('does not expose a final state on a trajectories result', () => {
    // The type says so; this is the runtime half. A caller reaching for
    // `result.state` after a cast must find nothing there, because there is
    // one state per shot and no single one to hand back.
    const result = run(REMEASURE_CIRCUIT, trajectoriesMode(8, createRng(2)))
    expect(result.mode).toBe('trajectories')
    expect('state' in result).toBe(false)
  })

  it('keeps the two modes agreeing where they overlap', () => {
    // A terminal measurement changes nothing observable, so the counts of a
    // trajectories run and the analytic histogram of the same circuit without
    // the measurement must describe the same distribution. If they diverged,
    // one of the two modes would be lying to the user about the same circuit.
    const shots = 40_000
    const trajectory = toMap(
      countsOf(run(measureAllCircuit(), trajectoriesMode(shots, createRng(11))))
    )
    const analytic = toMap(sampleShots(productState(), shots, createRng(12)))

    const expected = productDistribution()
    const a = chiSquared(trajectory, expected, shots)
    const b = chiSquared(analytic, expected, shots)
    expect(a, `trajectories χ² = ${a}`).toBeLessThan(CHI2_ALPHA_001.dof7)
    expect(b, `analytic χ² = ${b}`).toBeLessThan(CHI2_ALPHA_001.dof7)
    for (const key of expected.keys()) {
      const one = (trajectory.get(key) ?? 0) / shots
      const two = (analytic.get(key) ?? 0) / shots
      expect(Math.abs(one - two), key).toBeLessThan(0.02)
    }
  })
})
