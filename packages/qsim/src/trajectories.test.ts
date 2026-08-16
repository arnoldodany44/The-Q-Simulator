/**
 * A trajectory sampler fails quietly by construction: whatever weights it
 * draws with, it returns a normalised state, and the histogram of a few
 * thousand such states is a normalised distribution that nobody has an
 * intuition for (§3.3). So these tests never ask "does it look noisy" — they
 * ask the four questions that have answers:
 *
 *  1. **Are the weights the right numbers?** pₖ = ‖Kₖψ‖², checked against a
 *     hand-evaluated ⟨ψ|Kₖ†Kₖ|ψ⟩ and against closed forms — γ·P(1) for the
 *     emission branch of amplitude damping, the coefficients squared for a
 *     Pauli channel — and required to sum to 1 on any normalised state.
 *  2. **Are the impossible branches impossible?** A ground-state qubit cannot
 *     emit. A sampler that draws uniformly divides by zero there, and one that
 *     merely gets the weights slightly wrong emits at the wrong rate and looks
 *     fine. The scripted generators here push the draw to both ends of its
 *     range and demand the same answer.
 *  3. **Is the state after the jump still a state?** Normalised, and equal to
 *     the operator's own action rather than to something proportional to it.
 *  4. **Is the run reproducible?** One draw per application whatever the
 *     branch, and the same seed twice giving bit-identical results — which is
 *     what makes every statistical test in `verification/` a regression test
 *     rather than a weather report.
 *
 * The one thing not tested here is the thing that matters most, because it
 * needs the whole circuit: that averaging trajectories reproduces the density
 * matrix. That is `verification/noise-trajectories.test.ts`.
 */

import fc from 'fast-check'
import { describe, expect, it } from 'vitest'

import { apply1q, applyControlled } from './apply.js'
import type { ControlSpec } from './apply.js'
import { GATE_MATRICES } from './gates.js'
import type { Matrix2 } from './gates.js'
import {
  NOISE_CHANNEL_KINDS,
  NotTracePreservingError,
  amplitudeDampingChannel,
  bitFlipChannel,
  channelFor,
  depolarizingChannel,
  phaseDampingChannel,
  phaseFlipChannel,
} from './noise.js'
import type { KrausChannel, NoiseChannelKind } from './noise.js'
import { createRng } from './rng.js'
import type { Rng } from './rng.js'
import { alloc, clone, norm } from './statevector.js'
import type { Statevector } from './statevector.js'
import {
  applyTrajectoryChannels,
  krausWeights,
  prepareChannel,
  prepareChannels,
  sampleKraus,
} from './trajectories.js'

/** Decision D6: tolerance 1e-10, expressed as digits for `toBeCloseTo`. */
const DIGITS = 10
const TOLERANCE = 1e-10

const { h, t, x } = GATE_MATRICES

const positive = (qubit: number): ControlSpec => ({ qubit, state: 1 })

/**
 * A scripted generator — the engine's own docs sanction this. `0` is the
 * bottom of the unit interval and `1 - 2⁻⁵³` is the top; both must land on a
 * branch with mass.
 */
const ALMOST_ONE = 1 - Number.EPSILON / 2

function fixedRng(...values: number[]): Rng {
  let at = 0
  return { next: (): number => values[Math.min(at++, values.length - 1)] }
}

/** Wraps a generator and counts how many numbers were taken from it. */
function countingRng(inner: Rng): { rng: Rng; draws: () => number } {
  let draws = 0
  return {
    rng: {
      next: (): number => {
        draws++
        return inner.next()
      },
    },
    draws: () => draws,
  }
}

/** |1⟩ on one wire. */
function excited(): Statevector {
  const state = alloc(1)
  apply1q(state, x, 0)
  return state
}

/** A one-qubit state with no symmetry left in it: H then T then H. */
function skewed(): Statevector {
  const state = alloc(1)
  apply1q(state, h, 0)
  apply1q(state, t, 0)
  apply1q(state, h, 0)
  return state
}

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
  let total = 0
  for (let i = 0; i < state.size; i++) {
    const re = rng.next() * 2 - 1
    const im = rng.next() * 2 - 1
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

/** ⟨ψ|K†K|ψ⟩ for a one-qubit operator on `target`, evaluated the long way. */
function expectationOfKdaggerK(
  state: Statevector,
  operator: Matrix2,
  target: number
): number {
  // Kψ, into a fresh copy, using the audited kernel — then its own norm².
  // This is the definition, not the implementation: `krausWeights` never
  // materialises Kψ.
  const copy = clone(state)
  apply1q(copy, operator, target)
  let sum = 0
  for (let i = 0; i < copy.size; i++) {
    sum += copy.re[i] * copy.re[i] + copy.im[i] * copy.im[i]
  }
  return sum
}

/** Probability that `qubit` reads 1, by brute force over the indices. */
function marginal(state: Statevector, qubit: number): number {
  let sum = 0
  for (let i = 0; i < state.size; i++) {
    if (((i >> qubit) & 1) === 1) {
      sum += state.re[i] * state.re[i] + state.im[i] * state.im[i]
    }
  }
  return sum
}

/** Every channel kind at a parameter that is not a special value. */
const EVERY_CHANNEL: readonly KrausChannel[] = NOISE_CHANNEL_KINDS.map((kind) =>
  channelFor(kind, 0.37)
)

describe('preparing a channel', () => {
  it('refuses a Kraus set that is not trace preserving', () => {
    // √½·I alone: Σ K†K = ½·I. A perfectly reasonable-looking operator that
    // loses half the probability, which as branch weights means the draw is
    // scaled by a total of ½ and every trajectory is quietly reweighted.
    const half: KrausChannel = {
      kind: 'depolarizing',
      parameter: 0.5,
      operators: [
        new Float64Array([Math.SQRT1_2, 0, 0, 0, 0, 0, Math.SQRT1_2, 0]),
      ],
    }
    expect(() => prepareChannel(half)).toThrow(NotTracePreservingError)
    try {
      prepareChannel(half)
    } catch (error) {
      expect((error as NotTracePreservingError).defect).toBeCloseTo(0.5, DIGITS)
    }
  })

  it('refuses a channel with no operators', () => {
    const empty: KrausChannel = {
      kind: 'bitFlip',
      parameter: 0,
      operators: [],
    }
    expect(() => prepareChannel(empty)).toThrow(RangeError)
  })

  it('accepts every channel the profiles build', () => {
    for (const channel of EVERY_CHANNEL) {
      expect(() => prepareChannel(channel)).not.toThrow()
    }
  })

  it('finds the state-independent weights exactly where they exist', () => {
    // Derived, not switched on `kind`: the Pauli channels are scalar multiples
    // of unitaries, so K†K = c²·I and the state cancels. The damping channels
    // have K₀†K₀ = diag(1, 1−γ), which is not a multiple of the identity, and
    // must therefore pay for a pass over the state on every application.
    const fixed = ['depolarizing', 'bitFlip', 'phaseFlip']
    for (const kind of NOISE_CHANNEL_KINDS) {
      const prepared = prepareChannel(channelFor(kind, 0.37))
      expect(prepared.fixedWeights !== undefined, kind).toBe(
        fixed.includes(kind)
      )
    }
  })

  it('reads the fixed weights off the coefficients', () => {
    // Depolarising at p: {√(1−3p/4)·I, √(p/4)·X, √(p/4)·Y, √(p/4)·Z}, so the
    // branch probabilities are 1−3p/4 and three copies of p/4. Getting this
    // wrong by the factor of four that separates the two conventions in the
    // literature (see `depolarizingChannel`) is the error this pins.
    const p = 0.4
    const weights = prepareChannel(depolarizingChannel(p))
    expect(weights.fixedWeights).toBeDefined()
    expect([...weights.fixedWeights!]).toEqual([
      expect.closeTo(1 - (3 * p) / 4, DIGITS),
      expect.closeTo(p / 4, DIGITS),
      expect.closeTo(p / 4, DIGITS),
      expect.closeTo(p / 4, DIGITS),
    ])
  })

  it('marks the no-error branch as the identity, and nothing else', () => {
    const depolarizing = prepareChannel(depolarizingChannel(0.2))
    // K₀ = √(1−3p/4)·I is a positive multiple of I; X, Y and Z are not.
    expect([...depolarizing.identity]).toEqual([true, false, false, false])

    // Amplitude damping's K₀ = diag(1, √(1−γ)) is *nearly* the identity at a
    // small γ and must not be treated as one: the whole point of the branch is
    // that it shrinks the excited amplitude.
    const damping = prepareChannel(amplitudeDampingChannel(1e-6))
    expect([...damping.identity]).toEqual([false, false])

    // At parameter 0 every channel is exactly {I}, plus zeros.
    for (const kind of NOISE_CHANNEL_KINDS) {
      expect(prepareChannel(channelFor(kind, 0)).identity[0], kind).toBe(true)
    }
  })
})

describe('branch probabilities', () => {
  it('sums to 1 on any normalised state, for every channel', () => {
    fc.assert(
      fc.property(
        fc.constantFrom(...NOISE_CHANNEL_KINDS),
        fc.double({ min: 0, max: 1, noNaN: true }),
        fc.integer({ min: 1, max: 5000 }),
        fc.integer({ min: 0, max: 2 }),
        (kind: NoiseChannelKind, parameter, seed, target) => {
          const state = randomState(3, seed)
          const weights = krausWeights(
            state,
            channelFor(kind, parameter),
            target
          )
          let total = 0
          for (const weight of weights) {
            expect(weight).toBeGreaterThanOrEqual(0)
            total += weight
          }
          expect(total).toBeCloseTo(1, DIGITS)
        }
      ),
      { numRuns: 120 }
    )
  })

  it('equals ⟨ψ|K†K|ψ⟩ operator by operator', () => {
    for (const channel of EVERY_CHANNEL) {
      const state = randomState(3, 4242)
      const weights = krausWeights(state, channel, 1)
      for (let k = 0; k < channel.operators.length; k++) {
        expect(weights[k], `${channel.kind} K${k}`).toBeCloseTo(
          expectationOfKdaggerK(state, channel.operators[k], 1),
          DIGITS
        )
      }
    }
  })

  it('gives amplitude damping the closed form γ·P(1)', () => {
    // p₁ = ⟨ψ|K₁†K₁|ψ⟩ = γ·⟨ψ|1⟩⟨1|ψ⟩ — the emission branch is the excited
    // population times γ, which is what makes the weights state-dependent and
    // why they cannot be computed once and cached.
    const gamma = 0.3
    const channel = amplitudeDampingChannel(gamma)
    for (const seed of [1, 2, 3, 11]) {
      const state = randomState(2, seed)
      const excitedPopulation = marginal(state, 0)
      const weights = krausWeights(state, channel, 0)
      expect(weights[1]).toBeCloseTo(gamma * excitedPopulation, DIGITS)
      expect(weights[0]).toBeCloseTo(1 - gamma * excitedPopulation, DIGITS)
    }
  })

  it('gives a ground-state qubit no way to emit', () => {
    // The headline case for why uniform sampling is wrong: K₁|0⟩ is the zero
    // vector, so p₁ = 0 exactly, and a uniform draw would take that branch half
    // the time and divide by a norm of zero.
    const weights = krausWeights(alloc(1), amplitudeDampingChannel(0.5), 0)
    expect(weights[0]).toBe(1)
    expect(weights[1]).toBe(0)
  })

  it('does not depend on the state where the channel is a unitary mixture', () => {
    // The fast path's licence, checked against the general pass on states with
    // nothing in common: if this ever drifts, `sampleKraus` is drawing from a
    // distribution that is not the one `krausWeights` reports.
    for (const kind of ['depolarizing', 'bitFlip', 'phaseFlip'] as const) {
      const channel = channelFor(kind, 0.37)
      const fixed = prepareChannel(channel).fixedWeights
      expect(fixed, kind).toBeDefined()
      for (const seed of [5, 55, 555]) {
        const walked = krausWeights(randomState(3, seed), channel, 2)
        for (let k = 0; k < walked.length; k++) {
          expect(walked[k], `${kind} K${k} seed ${seed}`).toBeCloseTo(
            fixed![k],
            DIGITS
          )
        }
      }
    }
  })

  it('refuses a target outside the register', () => {
    const state = alloc(2)
    const channel = depolarizingChannel(0.1)
    expect(() => krausWeights(state, channel, 2)).toThrow(RangeError)
    expect(() => krausWeights(state, channel, -1)).toThrow(RangeError)
    expect(() =>
      sampleKraus(state, prepareChannel(channel), 2, createRng(1))
    ).toThrow(RangeError)
  })
})

describe('the jump', () => {
  it('leaves the state normalised, whatever is drawn', () => {
    fc.assert(
      fc.property(
        fc.constantFrom(...NOISE_CHANNEL_KINDS),
        fc.double({ min: 0, max: 1, noNaN: true }),
        fc.integer({ min: 1, max: 5000 }),
        (kind: NoiseChannelKind, parameter, seed) => {
          const state = randomState(3, seed)
          const prepared = prepareChannel(channelFor(kind, parameter))
          const rng = createRng(seed)
          for (let step = 0; step < 8; step++) {
            sampleKraus(state, prepared, step % 3, rng)
            expect(norm(state)).toBeCloseTo(1, DIGITS)
          }
        }
      ),
      { numRuns: 80 }
    )
  })

  it('sends every state to |0⟩ at γ = 1, on either branch', () => {
    // The one statement about amplitude damping that no coefficient error
    // survives. Both branches are exercised: from |1⟩ only the emission branch
    // has mass, from a superposition both do.
    const prepared = prepareChannel(amplitudeDampingChannel(1))
    for (const state of [excited(), skewed(), alloc(1)]) {
      for (const draw of [0, 0.5, ALMOST_ONE]) {
        const copy = clone(state)
        sampleKraus(copy, prepared, 0, fixedRng(draw))
        expect(copy.re[0] * copy.re[0] + copy.im[0] * copy.im[0]).toBeCloseTo(
          1,
          DIGITS
        )
        expect(copy.re[1]).toBeCloseTo(0, DIGITS)
        expect(copy.im[1]).toBeCloseTo(0, DIGITS)
      }
    }
  })

  it('moves a population per trajectory and not on average', () => {
    /*
     * Phase damping is the channel a histogram cannot see: on ρ it kills the
     * coherences and leaves every diagonal entry exactly where it was.
     *
     * A SINGLE TRAJECTORY DOES NOT DO THAT, and expecting it to is the most
     * natural way to misread the method. K₁ = √λ·|1⟩⟨1| is a projector: on
     * that branch the qubit ends up in |1⟩ with certainty. K₀ shrinks the
     * excited amplitude and the renormalisation hands the difference to |0⟩.
     * Both branches move the population; they move it in opposite directions
     * and by amounts that cancel *in the average*, which is the only place the
     * channel's statement holds. Hence the two halves of this test.
     */
    const lambda = 0.4
    const prepared = prepareChannel(phaseDampingChannel(lambda))

    const jumped = skewed()
    const populationBefore = marginal(jumped, 0)
    expect(sampleKraus(jumped, prepared, 0, fixedRng(ALMOST_ONE))).toBe(1)
    expect(marginal(jumped, 0)).toBeCloseTo(1, DIGITS)
    expect(populationBefore).toBeLessThan(0.9)

    const shots = 20_000
    const rng = createRng(31415)
    let total = 0
    for (let shot = 0; shot < shots; shot++) {
      const state = skewed()
      sampleKraus(state, prepared, 0, rng)
      total += marginal(state, 0)
    }
    // 4σ of a mean of bounded values over 20 000 draws is well under 0.01.
    expect(Math.abs(total / shots - populationBefore)).toBeLessThan(0.01)
  })

  it('leaves the amplitudes bit-for-bit alone on the identity branch', () => {
    // (c·I)ψ renormalised is ψ, exactly — so the branch that happens on almost
    // every gate of every shot must introduce no drift at all. `toBe`, not
    // `toBeCloseTo`: an ulp per gate per shot is a systematic bias.
    const prepared = prepareChannel(depolarizingChannel(0.01))
    const state = randomState(3, 17)
    const before = clone(state)
    const chosen = sampleKraus(state, prepared, 1, fixedRng(0))
    expect(chosen).toBe(0)
    for (let i = 0; i < state.size; i++) {
      expect(state.re[i]).toBe(before.re[i])
      expect(state.im[i]).toBe(before.im[i])
    }
  })

  it('applies a Pauli branch as exactly that Pauli', () => {
    // K₁ = √p·X drawn and renormalised is X, and the division that produces it
    // is x/x, which IEEE 754 makes exactly 1. So a bit-flip that happened is
    // indistinguishable from having applied X — no drift on the error branch
    // either.
    const prepared = prepareChannel(bitFlipChannel(0.25))
    const state = randomState(2, 31)
    const flipped = clone(state)
    apply1q(flipped, x, 0)
    const chosen = sampleKraus(state, prepared, 0, fixedRng(ALMOST_ONE))
    expect(chosen).toBe(1)
    for (let i = 0; i < state.size; i++) {
      expect(state.re[i]).toBe(flipped.re[i])
      expect(state.im[i]).toBe(flipped.im[i])
    }
  })

  it('touches no wire but its own', () => {
    // A channel on qubit 0 of a Bell pair may destroy the correlation, but the
    // partner's own population cannot move: the operator is K ⊗ I. A target
    // slip is otherwise invisible here — both qubits have marginal ½.
    const prepared = prepareChannel(bitFlipChannel(1))
    const state = bellPair()
    sampleKraus(state, prepared, 0, fixedRng(0.5))
    expect(marginal(state, 1)).toBeCloseTo(0.5, DIGITS)
    // p = 1 is a deterministic X on qubit 0, so |00⟩+|11⟩ became |01⟩+|10⟩.
    expect(marginal(state, 0)).toBeCloseTo(0.5, DIGITS)
    expect(state.re[1] * state.re[1]).toBeCloseTo(0.5, DIGITS)
    expect(state.re[2] * state.re[2]).toBeCloseTo(0.5, DIGITS)
    expect(state.re[0]).toBeCloseTo(0, DIGITS)
    expect(state.re[3]).toBeCloseTo(0, DIGITS)
  })

  it('cannot draw a branch with no probability', () => {
    // Both ends of the unit interval, on the state where one branch is
    // impossible. A sampler that reached K₁ here would divide by zero; one
    // that reached it after a collapse left the norm at 1 − 2e-14 would do it
    // once in 10¹⁴ runs, which is the bug that never reproduces.
    const prepared = prepareChannel(amplitudeDampingChannel(0.5))
    for (const draw of [0, 0.5, ALMOST_ONE, 1]) {
      const state = alloc(1)
      expect(sampleKraus(state, prepared, 0, fixedRng(draw))).toBe(0)
      expect(state.re[0]).toBe(1)
    }
  })

  it('refuses a state with no probability left — where it can tell', () => {
    // The general path divides by ‖Kψ‖ and must say so when there is nothing
    // to divide by, rather than filling the register with NaN.
    const empty = alloc(1)
    empty.re[0] = 0
    expect(() =>
      sampleKraus(
        empty,
        prepareChannel(amplitudeDampingChannel(0.5)),
        0,
        createRng(1)
      )
    ).toThrow(RangeError)

    // A unitary-mixture channel never looks at the state, so it cannot tell —
    // and it does not need to: the branch it draws is a unitary applied by the
    // ordinary kernel, which leaves a zero vector a zero vector without
    // dividing by anything. `apply1q` does not refuse that state either, and
    // an inconsistency between the two would be the surprising thing.
    const alsoEmpty = alloc(1)
    alsoEmpty.re[0] = 0
    expect(() =>
      sampleKraus(
        alsoEmpty,
        prepareChannel(bitFlipChannel(0.5)),
        0,
        createRng(1)
      )
    ).not.toThrow()
  })
})

describe('the draw distribution', () => {
  it('matches the branch probabilities over many draws', () => {
    // The direct test of the sampler's fairness, one channel at a time: draw
    // 20 000 times from the same state and compare the frequency of each
    // branch with the weight it was supposed to have. Uniform sampling would
    // report 1/4, 1/4, 1/4, 1/4 against 0.7, 0.1, 0.1, 0.1 here.
    const channel = depolarizingChannel(0.4)
    const prepared = prepareChannel(channel)
    const state = randomState(1, 2026)
    const weights = krausWeights(state, channel, 0)
    const shots = 20_000
    const tally = [0, 0, 0, 0]
    const rng = createRng(20260815)
    for (let shot = 0; shot < shots; shot++) {
      const copy = clone(state)
      tally[sampleKraus(copy, prepared, 0, rng)]++
    }
    for (let k = 0; k < 4; k++) {
      // 3σ at p = 0.7 over 20 000 draws is about 0.010; at p = 0.1, 0.006.
      const sigma = Math.sqrt((weights[k] * (1 - weights[k])) / shots)
      expect(Math.abs(tally[k] / shots - weights[k]), `K${k}`).toBeLessThan(
        4 * sigma
      )
    }
  })

  it('follows the state when the weights depend on it', () => {
    // Amplitude damping from |1⟩ emits with probability γ; from |0⟩, never.
    // Same channel, same seed, two states — a sampler that cached the weights
    // from the first call would report γ for both.
    const gamma = 0.25
    const prepared = prepareChannel(amplitudeDampingChannel(gamma))
    const shots = 5000
    let emissions = 0
    const rng = createRng(4)
    for (let shot = 0; shot < shots; shot++) {
      if (sampleKraus(excited(), prepared, 0, rng) === 1) emissions++
    }
    const sigma = Math.sqrt((gamma * (1 - gamma)) / shots)
    expect(Math.abs(emissions / shots - gamma)).toBeLessThan(4 * sigma)

    for (let shot = 0; shot < 100; shot++) {
      expect(sampleKraus(alloc(1), prepared, 0, rng)).toBe(0)
    }
  })
})

describe('the generator contract', () => {
  it('takes exactly one number per application, on every branch', () => {
    // The contract that keeps a noisy run reproducible: if the identity branch
    // consumed a different number of draws from the jump branch, then every
    // later collapse in that shot would depend on which Kraus operator came
    // up, and the fast paths could not be optimised without moving results.
    for (const kind of NOISE_CHANNEL_KINDS) {
      const prepared = prepareChannel(channelFor(kind, 0.5))
      for (const draw of [0, 0.5, ALMOST_ONE]) {
        const counter = countingRng(fixedRng(draw))
        sampleKraus(skewed(), prepared, 0, counter.rng)
        expect(counter.draws(), `${kind} at ${draw}`).toBe(1)
      }
    }
  })

  it('takes one number per channel in a group, in order', () => {
    const channels = prepareChannels([
      depolarizingChannel(0.1),
      amplitudeDampingChannel(0.1),
      phaseDampingChannel(0.1),
    ])
    const counter = countingRng(createRng(9))
    applyTrajectoryChannels(skewed(), channels, 0, counter.rng)
    expect(counter.draws()).toBe(3)
  })

  it('gives the same answer twice from the same seed', () => {
    const channels = prepareChannels([
      depolarizingChannel(0.2),
      amplitudeDampingChannel(0.3),
      phaseDampingChannel(0.15),
    ])
    const runOnce = (): Statevector => {
      const state = randomState(3, 77)
      const rng = createRng(20260816)
      for (let round = 0; round < 20; round++) {
        applyTrajectoryChannels(state, channels, round % 3, rng)
      }
      return state
    }
    const first = runOnce()
    const second = runOnce()
    for (let i = 0; i < first.size; i++) {
      expect(second.re[i]).toBe(first.re[i])
      expect(second.im[i]).toBe(first.im[i])
    }
  })

  it('is the exact identity at parameter 0, for every channel', () => {
    // At parameter 0 every constructor yields {I} plus zero operators, so a
    // trajectory through a zero-noise channel must return the state it was
    // given, bit for bit. This is what makes the ideal profile's trajectory run
    // comparable with a clean analytic run by equality rather than by χ².
    for (const kind of NOISE_CHANNEL_KINDS) {
      const prepared = prepareChannel(channelFor(kind, 0))
      const state = randomState(2, 606)
      const before = clone(state)
      for (const draw of [0, ALMOST_ONE]) {
        sampleKraus(state, prepared, 1, fixedRng(draw))
      }
      for (let i = 0; i < state.size; i++) {
        expect(state.re[i], `${kind} re[${i}]`).toBe(before.re[i])
        expect(state.im[i], `${kind} im[${i}]`).toBe(before.im[i])
      }
    }
  })

  it('keeps a drifted norm rather than inventing one', () => {
    // A Pauli branch is a unitary, so it preserves whatever norm it was given —
    // it is not a renormalisation in disguise. D6 schedules the renormalisation
    // separately, and a channel that silently fixed the norm would hide the
    // drift the schedule exists to bound.
    const state = alloc(1)
    state.re[0] = 0.6
    state.re[1] = 0.8 * (1 + 1e-9)
    const before = norm(state)
    sampleKraus(state, prepareChannel(phaseFlipChannel(0.5)), 0, fixedRng(0.9))
    expect(norm(state)).toBeCloseTo(before, DIGITS)
    expect(Math.abs(norm(state) - 1)).toBeGreaterThan(TOLERANCE)
  })
})
