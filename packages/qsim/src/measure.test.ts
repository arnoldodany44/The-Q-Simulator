/**
 * Measurement is where a silent bug becomes a visible lie: the histogram is
 * the thing the user reads. These tests hold it to distributions that are
 * known in closed form, and to the correlations that make entanglement
 * entanglement rather than two independent coins.
 *
 * Every sampling test is seeded (M0.3), so a failure here is a regression and
 * never the weather.
 */

import fc from 'fast-check'
import { describe, expect, it } from 'vitest'

import { apply1q, applyControlled, type ControlSpec } from './apply.js'
import { bitOf } from './conventions.js'
import { GATE_MATRICES, uMatrix } from './gates.js'
import {
  MidCircuitMeasurementError,
  analyticMode,
  assertMidCircuitAllowed,
  collapse,
  marginalProbability,
  measureQubit,
  orderedCounts,
  probabilities,
  sampleIndex,
  sampleShots,
  trajectoriesMode,
  type ExecutionOptions,
  type RunResult,
  type TrajectoriesResult,
} from './measure.js'
import { createRng, type Rng } from './rng.js'
import {
  alloc,
  amplitude,
  norm,
  renormalize,
  type Statevector,
} from './statevector.js'

/** Decision D6: tolerance 1e-10, expressed as digits for `toBeCloseTo`. */
const DIGITS = 10
const TOLERANCE = 1e-10

const { h, x, z } = GATE_MATRICES

const positive = (qubit: number): ControlSpec => ({ qubit, state: 1 })

/** H on q0 then CNOT q0→q1: `(|00⟩ + |11⟩)/√2`. */
function bellPair(): Statevector {
  const state = alloc(2)
  apply1q(state, h, 0)
  applyControlled(state, x, 1, [positive(0)])
  return state
}

/** A normalised state with no structure at all, from a seeded generator. */
function randomState(qubits: number, seed: number): Statevector {
  const state = alloc(qubits)
  const rng = createRng(seed)
  for (let i = 0; i < state.size; i++) {
    state.re[i] = rng.next() - 0.5
    state.im[i] = rng.next() - 0.5
  }
  renormalize(state)
  return state
}

/** A scripted generator, for pinning the edges of the binary search. */
function fixedRng(...values: number[]): Rng {
  let at = 0
  return { next: (): number => values[Math.min(at++, values.length - 1)] }
}

function totalShots(counts: Readonly<Record<string, number>>): number {
  return Object.values(counts).reduce((sum, count) => sum + count, 0)
}

/** Highest qubit first, spelled out rather than taken from `formatKet`. */
function ketLabel(index: number, qubits: number): string {
  let out = ''
  for (let qubit = qubits - 1; qubit >= 0; qubit--) out += bitOf(index, qubit)
  return out
}

describe('Born rule', () => {
  it('gives the Bell pair one half on |00⟩ and one half on |11⟩', () => {
    const distribution = probabilities(bellPair())
    expect([...distribution]).toHaveLength(4)
    expect(distribution[0]).toBeCloseTo(0.5, DIGITS)
    expect(distribution[1]).toBeCloseTo(0, DIGITS)
    expect(distribution[2]).toBeCloseTo(0, DIGITS)
    expect(distribution[3]).toBeCloseTo(0.5, DIGITS)
  })

  it('sums to one on random states', () => {
    for (let seed = 0; seed < 10; seed++) {
      const distribution = probabilities(randomState(4, seed))
      const total = distribution.reduce((sum, value) => sum + value, 0)
      expect(Math.abs(total - 1)).toBeLessThan(TOLERANCE)
    }
  })

  it('reads a marginal off a basis state', () => {
    // X on q1 of |000⟩ makes |010⟩ — qubit 1 is certain, the others cannot be.
    const state = alloc(3)
    apply1q(state, x, 1)
    expect(marginalProbability(state, 0)).toBeCloseTo(0, DIGITS)
    expect(marginalProbability(state, 1)).toBeCloseTo(1, DIGITS)
    expect(marginalProbability(state, 2)).toBeCloseTo(0, DIGITS)
  })

  it('gives each half of a Bell pair an even marginal', () => {
    const state = bellPair()
    expect(marginalProbability(state, 0)).toBeCloseTo(0.5, DIGITS)
    expect(marginalProbability(state, 1)).toBeCloseTo(0.5, DIGITS)
  })

  it('matches brute-force summation over the distribution (fast-check)', () => {
    // The marginal walks only the indices whose bit is set. This is the check
    // that the stride pattern selects the same set a bit test would.
    fc.assert(
      fc.property(
        fc.integer({ min: 1, max: 5 }),
        fc.integer({ min: 0, max: 2 ** 30 }),
        (qubits, seed) => {
          const state = randomState(qubits, seed)
          const distribution = probabilities(state)
          for (let qubit = 0; qubit < qubits; qubit++) {
            let brute = 0
            for (let i = 0; i < state.size; i++) {
              if (bitOf(i, qubit) === 1) brute += distribution[i]
            }
            expect(marginalProbability(state, qubit), `q${qubit}`).toBeCloseTo(
              brute,
              DIGITS
            )
          }
        }
      )
    )
  })

  it('rejects a qubit outside the register', () => {
    const state = alloc(2)
    expect(() => marginalProbability(state, 2)).toThrow(RangeError)
    expect(() => marginalProbability(state, -1)).toThrow(RangeError)
  })
})

describe('shot sampling', () => {
  it('splits a Bell pair 50/50 over 10 000 shots (χ², 1 dof)', () => {
    const counts = sampleShots(bellPair(), 10_000, createRng(20260814))

    // The correlated outcomes are the whole point: |01⟩ and |10⟩ have zero
    // amplitude, and a sampler that ever emits one has an off-by-one in the
    // binary search — the classic way this function fails.
    expect(Object.keys(counts).sort()).toEqual(['00', '11'])
    expect(totalShots(counts)).toBe(10_000)

    const expected = 5_000
    const chiSquared =
      (counts['00'] - expected) ** 2 / expected +
      (counts['11'] - expected) ** 2 / expected
    // 3.841 is the 95th percentile of χ² with 1 degree of freedom: below it,
    // the 50/50 hypothesis is not rejected.
    expect(chiSquared, `χ² = ${chiSquared}`).toBeLessThan(3.841)
  })

  it('reproduces its counts for the same seed and moves for another', () => {
    const state = alloc(3)
    for (let q = 0; q < 3; q++) apply1q(state, h, q)

    const first = sampleShots(state, 2_000, createRng(4242))
    const again = sampleShots(state, 2_000, createRng(4242))
    const other = sampleShots(state, 2_000, createRng(4243))

    expect(again).toEqual(first)
    expect(other).not.toEqual(first)
    expect(totalShots(other)).toBe(2_000)
  })

  it('leaves the state untouched — analytic mode keeps its vector', () => {
    const state = bellPair()
    const before = Array.from(state.re)
    sampleShots(state, 500, createRng(11))
    expect(Array.from(state.re)).toEqual(before)
  })

  it('lands on the first and last reachable outcome at the extremes', () => {
    // The search is `smallest index whose cumulative mass exceeds target`, so
    // a draw of 0 must give the lowest outcome with any probability and a draw
    // just under 1 the highest. Off-by-one here is invisible on a symmetric
    // distribution, which is why it gets its own test.
    const state = bellPair()
    expect(sampleShots(state, 3, fixedRng(0))).toEqual({ '00': 3 })
    expect(sampleShots(state, 3, fixedRng(1 - Number.EPSILON))).toEqual({
      '11': 3,
    })
  })

  it('keys counts highest-qubit-first, the way formatKet prints', () => {
    // |100⟩: qubit 2 is set, so the label reads "100" and not "001".
    const state = alloc(3)
    apply1q(state, x, 2)
    expect(sampleShots(state, 5, createRng(3))).toEqual({ '100': 5 })
  })

  it('returns nothing for zero shots and rejects nonsense counts', () => {
    const state = bellPair()
    expect(sampleShots(state, 0, createRng(1))).toEqual({})
    expect(() => sampleShots(state, -1, createRng(1))).toThrow(RangeError)
    expect(() => sampleShots(state, 1.5, createRng(1))).toThrow(RangeError)
  })
})

describe('drawing a single sample', () => {
  /**
   * `sampleIndex` exists for the noise trajectories of §5.4: every shot ends
   * in a different final state, so there is nothing to amortise a cumulative
   * array over and it would be built and thrown away once per shot.
   *
   * Its contract is that it agrees with `sampleShots` draw for draw. That is
   * not a nicety — it is what lets a noisy run at a zero-noise profile be
   * compared with an ordinary analytic run by *equality* rather than by χ²,
   * which is the sharpest assertion in the noise suite.
   */

  it('agrees with sampleShots, draw for draw', () => {
    const state = randomState(3, 20260816)
    const shots = 500
    const batched = sampleShots(state, shots, createRng(99))

    const rng = createRng(99)
    const tally: Record<string, number> = {}
    for (let shot = 0; shot < shots; shot++) {
      const index = sampleIndex(state, rng)
      const label = ketLabel(index, state.qubits)
      tally[label] = (tally[label] ?? 0) + 1
    }
    expect(tally).toEqual(batched)
  })

  it('lands on the first and last reachable outcome at the extremes', () => {
    // The same boundary `sampleShots` is pinned at, on the same state: a draw
    // of 0 is the lowest outcome with mass and a draw just under 1 the
    // highest. |01⟩ and |10⟩ have none and must be unreachable from either
    // end — 1 and 2 are exactly the indices an off-by-one would return.
    const state = bellPair()
    expect(sampleIndex(state, fixedRng(0))).toBe(0)
    expect(sampleIndex(state, fixedRng(1 - Number.EPSILON))).toBe(3)
  })

  it('never returns an outcome the state forbids', () => {
    const state = bellPair()
    for (let step = 0; step <= 200; step++) {
      const draw = step / 200
      expect([0, 3], `draw ${draw}`).toContain(
        sampleIndex(state, fixedRng(draw))
      )
    }
  })

  it('leaves the state untouched', () => {
    const state = bellPair()
    const before = Array.from(state.re)
    sampleIndex(state, createRng(7))
    expect(Array.from(state.re)).toEqual(before)
  })

  it('refuses a state with no probability', () => {
    const empty = alloc(2)
    empty.re[0] = 0
    expect(() => sampleIndex(empty, createRng(1))).toThrow(RangeError)
  })
})

describe('display order of a histogram', () => {
  /**
   * The blind spot that let a broken ordering guarantee ship: every assertion
   * above either sorts the keys first, or uses a single-outcome state where no
   * order can be observed. These do neither.
   *
   * WHY `Object.keys` IS NOT THE CONTRACT. A plain object enumerates its
   * canonical array-index keys in ascending numeric order *before* every other
   * key, and a fixed-width bitstring is an array index exactly when it has no
   * leading zero. So "11" is hoisted in front of "00" no matter what order the
   * engine inserted them in, and a sort at the insertion site is dead work.
   * `orderedCounts()` is the ordering contract; a consumer that reads the raw
   * keys is reading an unspecified property.
   */
  const uniform = (qubits: number): Statevector => {
    const state = alloc(qubits)
    for (let q = 0; q < qubits; q++) apply1q(state, h, q)
    return state
  }

  /** One shot per basis state, walking the distribution left to right. */
  const everyOutcome = (state: Statevector): ReturnType<typeof sampleShots> =>
    sampleShots(
      state,
      state.size,
      fixedRng(
        ...Array.from({ length: state.size }, (_, i) => (i + 0.5) / state.size)
      )
    )

  it('lays the Bell pair out with |00⟩ before |11⟩', () => {
    // The flagship demo of §13. Both labels are two characters and only one of
    // them is an array index, so this is the smallest case that can go wrong.
    const counts = sampleShots(bellPair(), 1_000, createRng(2026))
    expect(orderedCounts(counts).map(([label]) => label)).toEqual(['00', '11'])
  })

  it('counts up through every register width the hazard straddles', () => {
    // Widths 2–10 are where a bitstring read as decimal still fits in 2³²−1 and
    // is therefore hoisted; 11 and 12 are past it. Both sides must be ascending,
    // so the guarantee does not quietly depend on which side of the boundary a
    // teaching circuit happens to land on.
    for (let qubits = 1; qubits <= 12; qubits++) {
      const state = uniform(qubits)
      const labels = orderedCounts(everyOutcome(state)).map(([label]) => label)
      expect(labels, `${qubits} qubits`).toEqual(
        Array.from({ length: state.size }, (_, i) =>
          i.toString(2).padStart(qubits, '0')
        )
      )
    }
  })

  it('keeps its order across a JSON round trip', () => {
    // §8's POST /simulate and M0.6's worker both serialise the result, so the
    // ordered view has to survive the crossing rather than be rebuilt by trust.
    const counts = everyOutcome(uniform(3))
    const ordered = orderedCounts(counts)
    const crossed = orderedCounts(
      JSON.parse(JSON.stringify(counts)) as typeof counts
    )
    expect(crossed).toEqual(ordered)
    expect(crossed.map(([label]) => label)).toEqual([
      '000',
      '001',
      '010',
      '011',
      '100',
      '101',
      '110',
      '111',
    ])
  })

  it('carries every count, and nothing that never came up', () => {
    const counts = sampleShots(bellPair(), 64, createRng(9))
    const ordered = orderedCounts(counts)
    expect(ordered.reduce((sum, [, count]) => sum + count, 0)).toBe(64)
    expect(ordered).toHaveLength(2)
    expect(orderedCounts({})).toEqual([])
  })
})

describe('collapse', () => {
  it('leaves a normalised state, on any qubit of a random state', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 1, max: 5 }),
        fc.integer({ min: 0, max: 2 ** 30 }),
        fc.boolean(),
        (qubits, seed, measuresOne) => {
          const state = randomState(qubits, seed)
          collapse(state, qubits - 1, measuresOne ? 1 : 0)
          expect(Math.abs(norm(state) - 1)).toBeLessThan(TOLERANCE)
        }
      )
    )
  })

  it('zeroes every amplitude that disagrees with the outcome', () => {
    const state = randomState(4, 77)
    collapse(state, 2, 1)
    for (let i = 0; i < state.size; i++) {
      if (bitOf(i, 2) === 0) {
        expect(state.re[i], `re[${i}]`).toBe(0)
        expect(state.im[i], `im[${i}]`).toBe(0)
      }
    }
    expect(marginalProbability(state, 2)).toBeCloseTo(1, DIGITS)
  })

  it('keeps the surviving amplitudes in proportion', () => {
    // Collapsing renormalises; it must not otherwise redistribute anything.
    const state = randomState(3, 909)
    const before = probabilities(state)
    const kept = collapse(state, 0, 1)
    const after = probabilities(state)
    for (let i = 1; i < state.size; i += 2) {
      expect(after[i], `p[${i}]`).toBeCloseTo(before[i] / kept, DIGITS)
    }
  })

  it('returns the probability the outcome had', () => {
    const state = randomState(3, 123)
    const expected = marginalProbability(state, 1)
    expect(collapse(state, 1, 1)).toBeCloseTo(expected, DIGITS)
  })

  it('turns |+⟩ into |0⟩', () => {
    const state = alloc(1)
    apply1q(state, h, 0)
    collapse(state, 0, 0)
    expect(amplitude(state, 0).re).toBeCloseTo(1, DIGITS)
    expect(amplitude(state, 1).re).toBeCloseTo(0, DIGITS)
  })

  it('refuses an impossible outcome instead of producing NaNs', () => {
    const state = alloc(2) // |00⟩: qubit 0 cannot read 1
    expect(() => collapse(state, 0, 1)).toThrow(/probability 0/)
  })

  it('rejects an outcome that is not a bit', () => {
    const state = alloc(2)
    expect(() => collapse(state, 0, 2 as unknown as 0 | 1)).toThrow(RangeError)
  })
})

describe('measurement correlations', () => {
  it('forces the other half of a Bell pair', () => {
    // The defining property of the state: neither qubit has a value before the
    // measurement, and both have the same one after it.
    const seen = new Set<number>()
    for (let seed = 0; seed < 20; seed++) {
      const state = bellPair()
      const rng = createRng(seed)

      const first = measureQubit(state, 0, rng)
      seen.add(first)
      // The partner is now certain — before the measurement it was 50/50.
      expect(marginalProbability(state, 1)).toBeCloseTo(first, DIGITS)
      expect(measureQubit(state, 1, rng)).toBe(first)

      // And the state is the basis state both readings agree on.
      const index = first === 1 ? 3 : 0
      expect(amplitude(state, index).re).toBeCloseTo(1, DIGITS)
      expect(Math.abs(norm(state) - 1)).toBeLessThan(TOLERANCE)
    }
    // A generator stuck on one outcome would satisfy everything above.
    expect(seen).toEqual(new Set([0, 1]))
  })

  it('forces both partners in GHZ-3', () => {
    for (let seed = 0; seed < 10; seed++) {
      const state = alloc(3)
      apply1q(state, h, 0)
      applyControlled(state, x, 1, [positive(0)])
      applyControlled(state, x, 2, [positive(1)])

      const rng = createRng(seed + 500)
      const first = measureQubit(state, 1, rng)
      expect(measureQubit(state, 0, rng)).toBe(first)
      expect(measureQubit(state, 2, rng)).toBe(first)
    }
  })

  it('leaves an unentangled neighbour alone', () => {
    // |+⟩ on q0 and |+⟩ on q1: measuring one says nothing about the other.
    const state = alloc(2)
    apply1q(state, h, 0)
    apply1q(state, h, 1)
    measureQubit(state, 0, createRng(8))
    expect(marginalProbability(state, 1)).toBeCloseTo(0.5, DIGITS)
  })

  it('follows the drawn probability, not the coin', () => {
    // Rx-free check that the threshold is the marginal and not 0.5: a state
    // that is 90 % |1⟩ reads 1 for any draw below 0.9 and 0 above it.
    const heavy = (): Statevector => {
      const state = alloc(1)
      state.re[0] = Math.sqrt(0.1)
      state.re[1] = Math.sqrt(0.9)
      return state
    }
    expect(measureQubit(heavy(), 0, fixedRng(0.89))).toBe(1)
    expect(measureQubit(heavy(), 0, fixedRng(0.91))).toBe(0)
  })
})

describe('teleportation (specification §13)', () => {
  /**
   * The full protocol, with real collapses and real classical control — the
   * end-to-end proof that measurement, renormalisation and conditioned gates
   * compose. q0 carries the message, q1 is Alice's half of the pair, q2 is
   * Bob's.
   */
  interface Teleported {
    /** `|⟨ψ|bob⟩|²` — 1 when Bob holds exactly what Alice sent. */
    readonly fidelity: number
    /** The two classical bits, as `messageBit`/`pairBit`. */
    readonly branch: string
  }

  function teleport(
    theta: number,
    phi: number,
    rng: Rng,
    correct = true
  ): Teleported {
    const state = alloc(3)
    apply1q(state, uMatrix(theta, phi, 0), 0)

    apply1q(state, h, 1)
    applyControlled(state, x, 2, [positive(1)])

    applyControlled(state, x, 1, [positive(0)])
    apply1q(state, h, 0)

    const messageBit = measureQubit(state, 0, rng)
    const pairBit = measureQubit(state, 1, rng)
    if (correct) {
      if (pairBit === 1) apply1q(state, x, 2)
      if (messageBit === 1) apply1q(state, z, 2)
    }

    // Only the branch that was measured survives, so Bob's amplitudes sit at
    // the two indices with q0 = messageBit and q1 = pairBit.
    const base = messageBit + 2 * pairBit
    const bob0 = amplitude(state, base)
    const bob1 = amplitude(state, base + 4)

    // Fidelity |⟨ψ|bob⟩|² against the state that was sent.
    const inputRe = [Math.cos(theta / 2), Math.cos(phi) * Math.sin(theta / 2)]
    const inputIm = [0, Math.sin(phi) * Math.sin(theta / 2)]
    const overlapRe =
      inputRe[0] * bob0.re +
      inputIm[0] * bob0.im +
      (inputRe[1] * bob1.re + inputIm[1] * bob1.im)
    const overlapIm =
      inputRe[0] * bob0.im -
      inputIm[0] * bob0.re +
      (inputRe[1] * bob1.im - inputIm[1] * bob1.re)
    return {
      fidelity: overlapRe * overlapRe + overlapIm * overlapIm,
      branch: `${messageBit}${pairBit}`,
    }
  }

  it('delivers 20 random input states with fidelity 1', () => {
    const rng = createRng(31337)
    const branches = new Set<string>()
    for (let trial = 0; trial < 20; trial++) {
      const theta = rng.next() * Math.PI
      const phi = rng.next() * 2 * Math.PI
      const { fidelity, branch } = teleport(theta, phi, rng)
      expect(fidelity, `θ=${theta} φ=${phi}`).toBeCloseTo(1, DIGITS)
      branches.add(branch)
    }
    // All four measurement branches are exercised, so the corrections are
    // genuinely being used rather than being trivial on every run.
    expect(branches).toEqual(new Set(['00', '01', '10', '11']))
  })

  it('fails without the classical corrections', () => {
    // Otherwise the test above could be passing for the wrong reason: if
    // measurement left Bob's qubit already correct, the protocol would prove
    // nothing about conditioned gates.
    const broken = new Map<string, number>()
    for (let seed = 0; seed < 40; seed++) {
      const { fidelity, branch } = teleport(1.1, 0.7, createRng(seed), false)
      broken.set(branch, fidelity)
    }
    expect(broken.get('00')).toBeCloseTo(1, DIGITS)
    for (const branch of ['01', '10', '11']) {
      expect(broken.get(branch), branch).toBeLessThan(0.99)
    }
  })
})

describe('execution modes (specification §5.3)', () => {
  it('rejects a mid-circuit measurement in analytic mode', () => {
    const options: ExecutionOptions = analyticMode()
    expect(() => {
      assertMidCircuitAllowed(options, 'a measurement in column 3')
    }).toThrow(MidCircuitMeasurementError)

    try {
      assertMidCircuitAllowed(options, 'a measurement in column 3')
      expect.unreachable('the guard must throw in analytic mode')
    } catch (error) {
      // The message is what the user reads, so it names the operation and the
      // way out rather than only the rule.
      const message = (error as Error).message
      expect(message).toContain('a measurement in column 3')
      expect(message).toContain('trajectories mode')
    }
  })

  it('lets a trajectories run through, and hands over its generator', () => {
    const rng = createRng(5)
    const options: ExecutionOptions = trajectoriesMode(1024, rng)
    assertMidCircuitAllowed(options, 'a measurement')
    // Narrowed by the assertion: without passing the guard there is no `rng`
    // in scope here at all, which is the type-level half of the rule.
    expect(options.shots).toBe(1024)
    expect(options.rng.next()).toBeLessThan(1)
  })

  it('rejects a trajectories run with no shots', () => {
    expect(() => trajectoriesMode(0, createRng(1))).toThrow(RangeError)
    expect(() => trajectoriesMode(2.5, createRng(1))).toThrow(RangeError)
  })

  /**
   * The only way to reach a final state: narrow on the mode first. This
   * function is what a consumer of `run()` has to write, and it compiles only
   * because the analytic member is the one that has a `state`.
   */
  function finalStateOf(result: RunResult): Statevector | undefined {
    return result.mode === 'analytic' ? result.state : undefined
  }

  it('keeps the final state out of a trajectories result', () => {
    // A trajectories run has one state per shot and therefore none to report.
    // If this type ever gains a `state`, the assignment below stops compiling
    // — the distinction is enforced by the compiler, not by review.
    type CarriesState<T> = T extends { state: Statevector } ? true : false
    const trajectoriesCarriesState: CarriesState<TrajectoriesResult> = false
    expect(trajectoriesCarriesState).toBe(false)

    const counts = { '00': 1, '11': 1 }
    expect(
      finalStateOf({ mode: 'trajectories', shots: 2, counts })
    ).toBeUndefined()
  })

  it('carries the final state in an analytic result', () => {
    const state = finalStateOf({ mode: 'analytic', state: bellPair() })
    expect(state?.qubits).toBe(2)
  })
})
