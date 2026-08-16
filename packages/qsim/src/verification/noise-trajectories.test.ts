/**
 * INDEPENDENT ADVERSARIAL VERIFICATION — MONTE CARLO NOISE TRAJECTORIES.
 *
 * This file exists because of one sentence in §5.4: a noisy circuit can be run
 * on a statevector by sampling the errors instead of on a density matrix by
 * summing them. Two implementations, one physics. **So the strongest evidence
 * available in this milestone is that they agree**, and it is stronger than
 * anything either could produce alone: the density path builds ρ, applies four
 * Kraus operators per channel and never draws a random number; the trajectory
 * path carries 2ⁿ amplitudes, applies exactly one operator per channel and is
 * random everywhere. They share the circuit walk and the noise model — that
 * sharing is deliberate, see `runner.ts` — and share nothing else. A bug in
 * either one moves one answer and not the other.
 *
 * The nine things this file is looking for:
 *
 *  1. **Uniform sampling.** The headline bug. Drawing each Kraus operator with
 *     probability 1/m instead of ‖Kₖψ‖² returns normalised states, a
 *     normalised histogram and a plausible amount of damage. Every convergence
 *     test here fails on it by a mile, and the single-channel ensemble test
 *     names the entry of ρ that moved.
 *
 *  2. **Weights computed once and cached.** pₖ depends on the current state.
 *     A sampler that evaluated them at the first gate and reused them would
 *     agree with ρ on the first column and drift after it, which is why the
 *     comparison circuits are deep enough to have an after.
 *
 *  3. **A missing renormalisation.** Kₖ|ψ⟩ is not normalised, and this is the
 *     one place where the convergence tests are *not* the sharpest instrument
 *     — which is worth saying plainly rather than claiming coverage that is
 *     not there. Every consumer downstream scales by the state's own total
 *     mass (the argument in `measure.measureQubit`), so a state left at norm
 *     √pₖ still yields the right *relative* distribution, and the χ² would
 *     pass. What it does instead is decay the norm geometrically until a deep
 *     circuit underflows to zero and the run dies with no clue why. So the
 *     jump's normalisation is pinned by invariant, in `trajectories.test.ts`
 *     and by "keeps every trajectory a unit vector" below, and not by a
 *     statistic.
 *
 *  4. **Both modes doing nothing.** The failure mode of a comparison test:
 *     two implementations that agree because neither applies any noise. Every
 *     agreement assertion here is paired with one that the noisy answer is
 *     *different from the ideal one*, by a margin far outside sampling error.
 *
 *  5. **Noise that misses the control wires.** A model that noises only the
 *     targets reports half of a two-qubit gate's published error while looking
 *     entirely reasonable. Checked on a circuit whose only gate leaves the
 *     state alone, so the control's excitation is the whole signal.
 *
 *  6. **A trajectory that is not reproducible.** Same seed, same counts,
 *     twice — otherwise every statistical assertion in this suite is weather.
 *
 *  7. **A zero-noise path that is not the clean path.** With the ideal
 *     profile there are no channels and no readout errors, so a noisy run must
 *     reproduce an ordinary analytic run *bit for bit* — same seed, identical
 *     counts, not merely a compatible histogram.
 *
 *  8. **A ρ that stopped being a state.** Hermitian, unit trace and positive
 *     semidefinite are checked after every column of a noisy density run.
 *     Positivity is the one that catches a sign, and a channel applied with a
 *     sign error still produces a unit-trace Hermitian matrix.
 *
 *  9. **A ceiling that is not enforced.** The whole point of trajectories is
 *     the register ρ cannot hold. Thirteen qubits must be a typed refusal from
 *     the density mode and an ordinary run in the trajectory one.
 *
 * WHERE THE TOLERANCES COME FROM. Every statistical assertion is a fixed seed
 * plus a bound derived from the shot count, never a number tuned until it
 * passed: a frequency over N shots has standard error √(p(1−p)/N), and the
 * χ² statistic of a correct sampler exceeds its 99.9th percentile once in a
 * thousand runs. The seeds are fixed, so those are the odds of the suite ever
 * having been red, not the odds of it going red tomorrow.
 */

import { describe, expect, it } from 'vitest'

import {
  fromStatevector,
  isHermitian,
  isPositiveSemidefinite,
  trace,
} from '../density.js'
import { DensityTooLargeError, MAX_DENSITY_QUBITS } from '../density.js'
import type { DensityMatrix } from '../density.js'
import { probabilities, sampleShots } from '../measure.js'
import type { ShotCounts } from '../measure.js'
import { distributionFidelity } from '../metrics.js'
import {
  NOISE_CHANNEL_KINDS,
  NOISE_PROFILES,
  channelFor,
  channelsForGate,
  isTracePreserving,
} from '../noise.js'
import type { KrausChannel, NoiseProfile } from '../noise.js'
import { createRng } from '../rng.js'
import { run, runNoisy, runNoisyDensity, runTrajectory } from '../runner.js'
import type { CircuitLike, OperationLike } from '../runner.js'
import { alloc, clone, norm } from '../statevector.js'
import type { Statevector } from '../statevector.js'
import { prepareChannel, sampleKraus } from '../trajectories.js'

/** D6: 1e-10, as digits for `toBeCloseTo`. */
const DIGITS = 10
const TOLERANCE = 1e-10

/** χ² critical values: the 99.9th and 95th percentiles at 7 dof. */
const CHI2_ALPHA_001_DOF7 = 24.322
const CHI2_ALPHA_050_DOF7 = 14.067

/* ────────────────── complex 2×2 arithmetic, by hand ─────────────────────── */

interface Cx {
  readonly re: number
  readonly im: number
}

type Mat2 = readonly [readonly [Cx, Cx], readonly [Cx, Cx]]

const cx = (re: number, im = 0): Cx => ({ re, im })
const add = (a: Cx, b: Cx): Cx => ({ re: a.re + b.re, im: a.im + b.im })
const conj = (a: Cx): Cx => ({ re: a.re, im: -a.im })
const mul = (a: Cx, b: Cx): Cx => ({
  re: a.re * b.re - a.im * b.im,
  im: a.re * b.im + a.im * b.re,
})

/** A `Matrix2` (flat, interleaved, row-major) read back as nested complexes. */
function asMatrix(operator: Float64Array): Mat2 {
  return [
    [cx(operator[0], operator[1]), cx(operator[2], operator[3])],
    [cx(operator[4], operator[5]), cx(operator[6], operator[7])],
  ]
}

/** A·B for 2×2, textbook triple loop written out. */
function product(a: Mat2, b: Mat2): Mat2 {
  const at = (row: number, column: number): Cx =>
    add(mul(a[row][0], b[0][column]), mul(a[row][1], b[1][column]))
  return [
    [at(0, 0), at(0, 1)],
    [at(1, 0), at(1, 1)],
  ]
}

/** A†: conjugate and transpose, in two visibly separate steps. */
function adjoint(a: Mat2): Mat2 {
  const conjugated: Mat2 = [
    [conj(a[0][0]), conj(a[0][1])],
    [conj(a[1][0]), conj(a[1][1])],
  ]
  return [
    [conjugated[0][0], conjugated[1][0]],
    [conjugated[0][1], conjugated[1][1]],
  ]
}

function sum(a: Mat2, b: Mat2): Mat2 {
  return [
    [add(a[0][0], b[0][0]), add(a[0][1], b[0][1])],
    [add(a[1][0], b[1][0]), add(a[1][1], b[1][1])],
  ]
}

const ZERO_MATRIX: Mat2 = [
  [cx(0), cx(0)],
  [cx(0), cx(0)],
]

/**
 * Σₖ Kₖ ρ Kₖ† for one qubit, evaluated with nested arrays of `{re, im}`.
 *
 * Nothing here touches `density.ts` or the 2×2-corner kernel of `noise.ts`:
 * this is the textbook definition, so a corner-walk bug and a sampling bug
 * cannot cancel.
 */
function channelOf(rho: Mat2, channel: KrausChannel): Mat2 {
  let out = ZERO_MATRIX
  for (const operator of channel.operators) {
    const k = asMatrix(operator)
    out = sum(out, product(product(k, rho), adjoint(k)))
  }
  return out
}

/** |ψ⟩⟨ψ| for a one-qubit state, as a nested 2×2. */
function outer(state: Statevector): Mat2 {
  const psi: readonly Cx[] = [
    cx(state.re[0], state.im[0]),
    cx(state.re[1], state.im[1]),
  ]
  return [
    [mul(psi[0], conj(psi[0])), mul(psi[0], conj(psi[1]))],
    [mul(psi[1], conj(psi[0])), mul(psi[1], conj(psi[1]))],
  ]
}

function scale(a: Mat2, factor: number): Mat2 {
  const at = (row: number, column: number): Cx => ({
    re: a[row][column].re * factor,
    im: a[row][column].im * factor,
  })
  return [
    [at(0, 0), at(0, 1)],
    [at(1, 0), at(1, 1)],
  ]
}

/* ─────────────────────────── circuits and states ────────────────────────── */

let nextId = 0

function op(
  gate: string,
  targets: number[],
  column: number,
  controls?: number[]
): OperationLike {
  nextId++
  return { id: `op${nextId}`, gate, targets, column, controls }
}

/**
 * The comparison circuit: a three-qubit GHZ state, then three diagonal gates.
 *
 * GHZ because its ideal distribution is **two peaks and six exact zeros**, so
 * everything the noise does is legible: the peaks come down and the zeros come
 * up, and a comparison against the ideal answer cannot be confused with a
 * comparison against the noisy one. A circuit whose ideal distribution is
 * already flat would make an absent noise model look like a present one.
 *
 * The three diagonal gates afterwards change no probability at all and are
 * there for depth: they add channel applications, and destroy coherence that
 * nothing later reads, so a sampler that evaluated its branch weights once and
 * cached them has five columns in which to drift away from ρ.
 *
 * Every gate is a fixed one, so the two modes cannot disagree over a
 * parameter — the point here is the noise, not the dispatch.
 */
function comparisonCircuit(): CircuitLike {
  return {
    qubits: 3,
    operations: [
      op('h', [0], 0),
      op('cx', [1], 1, [0]),
      op('cx', [2], 2, [1]),
      op('t', [0], 3),
      op('s', [1], 3),
      op('t', [2], 4),
    ],
  }
}

/** `columns` alternating layers of Hadamards and an entangling ladder. */
function deepCircuit(columns: number): CircuitLike {
  const operations: OperationLike[] = []
  for (let column = 0; column < columns; column++) {
    if (column % 2 === 0) {
      for (let qubit = 0; qubit < 3; qubit++)
        operations.push(op('h', [qubit], column))
    } else {
      operations.push(op('cx', [1], column, [0]))
      operations.push(op('t', [2], column))
    }
  }
  return { qubits: 3, operations }
}

/** A one-qubit state with no symmetry: H, T, H — used for the ensemble test. */
function skewed(): Statevector {
  const state = alloc(1)
  const sqrt = Math.SQRT1_2
  // Written out rather than run through the kernel: this file's job is to
  // disagree with the engine, so its inputs should not come from it either.
  const angle = Math.PI / 4
  state.re[0] = 0.5 * (1 + Math.cos(angle))
  state.im[0] = 0.5 * Math.sin(angle)
  state.re[1] = 0.5 * (1 - Math.cos(angle))
  state.im[1] = -0.5 * Math.sin(angle)
  const norm = Math.hypot(
    Math.hypot(state.re[0], state.im[0]),
    Math.hypot(state.re[1], state.im[1])
  )
  state.re[0] /= norm
  state.im[0] /= norm
  state.re[1] /= norm
  state.im[1] /= norm
  expect(sqrt).toBeGreaterThan(0)
  return state
}

/** The exact distribution of a noisy density run, as a label → probability map. */
function exactDistribution(
  circuit: CircuitLike,
  profile: NoiseProfile
): Map<string, number> {
  const result = runNoisyDensity(circuit, { profile })
  const out = new Map<string, number>()
  for (let index = 0; index < result.distribution.length; index++) {
    out.set(label(index, circuit.qubits), result.distribution[index])
  }
  return out
}

/** Highest qubit first, written out rather than imported from conventions. */
function label(index: number, qubits: number): string {
  let out = ''
  for (let qubit = qubits - 1; qubit >= 0; qubit--) out += (index >> qubit) & 1
  return out
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
 * Outcomes the theory forbids are not folded in — under noise there are none,
 * which is itself worth noticing: a noisy circuit reaches every basis state.
 */
function chiSquared(
  observed: ReadonlyMap<string, number>,
  expected: ReadonlyMap<string, number>,
  shots: number
): number {
  let value = 0
  for (const [key, probability] of expected) {
    const predicted = probability * shots
    const seen = observed.get(key) ?? 0
    value += ((seen - predicted) * (seen - predicted)) / predicted
  }
  return value
}

/** Total variation distance — the readable half of the same comparison. */
function totalVariation(
  observed: ReadonlyMap<string, number>,
  expected: ReadonlyMap<string, number>,
  shots: number
): number {
  let distance = 0
  for (const [key, probability] of expected) {
    distance += Math.abs((observed.get(key) ?? 0) / shots - probability)
  }
  return distance / 2
}

/* ──────────────────────────────── the tests ─────────────────────────────── */

describe('one channel: the trajectory ensemble is the channel', () => {
  it('reproduces Σ K ρ K† entry by entry, for every channel kind', () => {
    /*
     * The unravelling identity itself, at the smallest size where it can be
     * checked exhaustively: draw 20 000 trajectories from the same one-qubit
     * state through the same channel, average the outer products, and compare
     * with the textbook Σ Kₖ ρ Kₖ† built here from the same operators by
     * nested-array matrix products.
     *
     * This is the test uniform sampling cannot survive. For amplitude damping
     * at γ = 0.3 on this state the true ρ₁₁ is 0.19; sampling uniformly gives
     * 0.5 for the emission branch and lands near 0.06. Every kind is swept,
     * because the two damping channels take the state-dependent path and the
     * three Pauli channels take the fixed-weight one, and those are two
     * separate pieces of code that could each be wrong on their own.
     */
    const shots = 20_000
    for (const kind of NOISE_CHANNEL_KINDS) {
      const channel = channelFor(kind, 0.3)
      const prepared = prepareChannel(channel)
      const start = skewed()
      const expected = channelOf(outer(start), channel)

      let averaged = ZERO_MATRIX
      const rng = createRng(20260817)
      for (let shot = 0; shot < shots; shot++) {
        const state = clone(start)
        sampleKraus(state, prepared, 0, rng)
        averaged = sum(averaged, outer(state))
      }
      averaged = scale(averaged, 1 / shots)

      // Every entry of a one-qubit ρ is bounded by 1, so the standard error of
      // an averaged entry is under 1/(2√N) = 0.0035 here. 0.02 is ~6σ.
      for (let row = 0; row < 2; row++) {
        for (let column = 0; column < 2; column++) {
          const where = `${kind} ρ[${row}][${column}]`
          expect(averaged[row][column].re, where).toBeCloseTo(
            expected[row][column].re,
            2
          )
          expect(averaged[row][column].im, where).toBeCloseTo(
            expected[row][column].im,
            2
          )
        }
      }
    }
  })

  it('is a distribution because the Kraus set is trace preserving', () => {
    // Σₖ pₖ = ⟨ψ|Σ K†K|ψ⟩ = 1 — the link between the check `noise.ts` runs and
    // the sampler being able to draw at all. Swept over every channel every
    // profile can produce, at both arities.
    for (const profile of Object.values(NOISE_PROFILES)) {
      for (const arity of [1, 2] as const) {
        for (const channel of channelsForGate(profile, arity)) {
          expect(
            isTracePreserving(channel, TOLERANCE),
            `${profile.id} ${arity}q ${channel.kind}`
          ).toBe(true)
        }
      }
    }
  })
})

describe('a whole circuit: trajectories converge to the density matrix', () => {
  const circuit = comparisonCircuit()
  const profile = NOISE_PROFILES.teaching

  it('matches the exact distribution (χ², 7 dof, fixed seed)', () => {
    const shots = 40_000
    const expected = exactDistribution(circuit, profile)
    const counts = toMap(
      runNoisy(circuit, { profile, shots, rng: createRng(20260815) }).counts
    )
    expect(totalOf(counts)).toBe(shots)

    // Every basis state is reachable under noise, and every one of them has
    // an expected count in the thousands here, so χ² is well conditioned.
    expect(counts.size).toBe(8)
    const value = chiSquared(counts, expected, shots)
    expect(value, `χ² = ${value}`).toBeLessThan(CHI2_ALPHA_001_DOF7)

    // The same statement in a unit a reader can check by eye: no bar is more
    // than 4 standard errors from where ρ puts it, and the two distributions
    // are within a percent of each other in total variation.
    for (const [key, probability] of expected) {
      const sigma = Math.sqrt((probability * (1 - probability)) / shots)
      const seen = (counts.get(key) ?? 0) / shots
      expect(
        Math.abs(seen - probability),
        `${key}: ${seen} vs ${probability}`
      ).toBeLessThan(4 * sigma)
    }
    expect(totalVariation(counts, expected, shots)).toBeLessThan(0.01)
  })

  it('is unbiased — twelve seeds against the 95th percentile', () => {
    /*
     * One seed proves the sampler is not grossly wrong. A sweep proves the χ²
     * statistic is distributed the way it should be: about one seed in twenty
     * exceeds the 95th percentile by chance, and a sampler with a small
     * constant skew — a weight off by a factor of (1 + ε), a renormalisation
     * that is nearly right — would exceed it almost every time while still
     * passing any single run.
     */
    const shots = 8000
    const expected = exactDistribution(circuit, profile)
    let rejections = 0
    for (let seed = 1; seed <= 12; seed++) {
      const counts = toMap(
        runNoisy(circuit, { profile, shots, rng: createRng(seed) }).counts
      )
      if (chiSquared(counts, expected, shots) >= CHI2_ALPHA_050_DOF7) {
        rejections++
      }
    }
    expect(rejections, `${rejections}/12 seeds rejected`).toBeLessThanOrEqual(3)
  })

  it('agrees about a noisy answer, not about an absent one', () => {
    /*
     * The check that keeps the two tests above from being satisfied by two
     * implementations that both do nothing. The teaching profile has to move
     * this circuit's distribution by far more than 40 000 shots of sampling
     * error, and both modes have to see the same move.
     */
    const ideal = probabilities(idealState(circuit))
    const noisy = runNoisyDensity(circuit, { profile }).distribution

    // The ideal answer is (0.5, 0, 0, 0, 0, 0, 0, 0.5). The teaching profile
    // takes the peaks down to 0.43 and 0.37 and fills each zero to about 0.03,
    // which is a classical fidelity near 0.80 — a distribution nobody could
    // mistake for the clean one, which is the point of choosing a profile that
    // damages a lesson-sized circuit visibly (`NOISE_PROFILES.teaching`).
    expect(distributionFidelity(ideal, noisy)).toBeLessThan(0.9)
    for (let index = 1; index < ideal.length - 1; index++) {
      expect(ideal[index]).toBe(0)
      expect(noisy[index], `zero ${index} filled in`).toBeGreaterThan(0.01)
    }

    // …and the sampled answer is far from the ideal one in the same way and by
    // the same amount. A trajectory run that skipped its channels would score
    // 1 against the ideal distribution and 0.80 against the noisy one — this
    // pair of assertions is what makes the agreement above mean something.
    const shots = 40_000
    const counts = toMap(
      runNoisy(circuit, { profile, shots, rng: createRng(5150) }).counts
    )
    const empirical = new Float64Array(ideal.length)
    for (const [key, count] of counts) {
      empirical[parseInt(key, 2)] = count / shots
    }
    expect(distributionFidelity(ideal, empirical)).toBeLessThan(0.9)
    expect(distributionFidelity(noisy, empirical)).toBeGreaterThan(0.999)
  })

  it('gives the same counts twice from the same seed', () => {
    const options = { profile, shots: 2000, rng: createRng(4242) }
    const first = runNoisy(circuit, { ...options, rng: createRng(4242) })
    const second = runNoisy(circuit, { ...options, rng: createRng(4242) })
    expect(second.counts).toEqual(first.counts)
    // …and a different seed does not, or the generator is not being consulted.
    const other = runNoisy(circuit, { ...options, rng: createRng(4243) })
    expect(other.counts).not.toEqual(first.counts)
  })
})

describe('the noiseless limit is exact, not approximate', () => {
  const circuit = comparisonCircuit()

  it('reproduces an analytic run bit for bit at the ideal profile', () => {
    /*
     * `channelsForGate` returns nothing for a profile with no error and no
     * relaxation, and the readout errors are dropped for the same reason, so a
     * noisy trajectory run at the ideal profile does exactly what a clean run
     * does and draws exactly one random number per shot. Its counts must
     * therefore be *identical* to sampling the analytic final state with the
     * same seed — not close, identical. Any extra draw, any stray
     * multiplication by 1.0, any channel applied at parameter 0 would break
     * this and nothing else in the suite would notice.
     */
    const shots = 3000
    const noisy = runNoisy(circuit, {
      profile: NOISE_PROFILES.ideal,
      shots,
      rng: createRng(1234),
    })
    const clean = sampleShots(idealState(circuit), shots, createRng(1234))
    expect(noisy.counts).toEqual(clean)
  })

  it('gives the same ρ as the pure state at the ideal profile', () => {
    // The density path's own zero-noise check: with no channels, ρ must be
    // exactly |ψ⟩⟨ψ| for the ψ the statevector runner produces. This pins the
    // whole ρ → UρU† circuit walk — gate order, control filtering, parameter
    // resolution — against the heavily tested statevector one.
    const rho = runNoisyDensity(circuit, {
      profile: NOISE_PROFILES.ideal,
    }).rho
    const pure = fromStatevector(idealState(circuit))
    for (let i = 0; i < rho.size; i++) {
      expect(rho.re[i]).toBeCloseTo(pure.re[i], DIGITS)
      expect(rho.im[i]).toBeCloseTo(pure.im[i], DIGITS)
    }
  })
})

describe('the noise reaches every wire a gate touched', () => {
  it('excites the control of a gate that does nothing to the state', () => {
    /*
     * CX on |00⟩ leaves the state alone, so anything that shows up afterwards
     * is the noise and only the noise. Both wires carry the two-qubit channel
     * group, so both must pick up the same excitation — a model that noised
     * only the target would leave qubit 0 in exactly |0⟩ and would still look
     * completely plausible on the histogram, while reporting half the error
     * the device datasheet publishes.
     */
    const circuit: CircuitLike = {
      qubits: 2,
      operations: [op('cx', [1], 0, [0])],
    }
    const distribution = runNoisyDensity(circuit, {
      profile: NOISE_PROFILES.teaching,
      readout: false,
    }).distribution

    // P(qubit q = 1), summed over the basis states where that bit is set.
    const excited = (qubit: number): number => {
      let total = 0
      for (let index = 0; index < distribution.length; index++) {
        if (((index >> qubit) & 1) === 1) total += distribution[index]
      }
      return total
    }
    expect(excited(0)).toBeGreaterThan(1e-3)
    expect(excited(0)).toBeCloseTo(excited(1), DIGITS)
  })
})

describe('ρ stays a density matrix all the way through', () => {
  it('is Hermitian, unit trace and positive after every column', () => {
    /*
     * Run the same circuit again for each prefix of its columns and check the
     * three invariants on the ρ each prefix ends at. Positivity is the one
     * that earns its place: a Kraus operator applied with a sign error, or a
     * dagger written with a `+`, leaves the trace at 1 and the matrix
     * Hermitian, and shows up here as a negative eigenvalue.
     */
    const full = comparisonCircuit()
    const columns = [...new Set(full.operations.map((o) => o.column))].sort(
      (a, b) => a - b
    )
    for (const profile of [
      NOISE_PROFILES.teaching,
      NOISE_PROFILES.superconducting,
    ]) {
      for (const through of columns) {
        const prefix: CircuitLike = {
          qubits: full.qubits,
          operations: full.operations.filter((o) => o.column <= through),
        }
        const rho = runNoisyDensity(prefix, { profile }).rho
        const where = `${profile.id} through column ${through}`
        expectPhysical(rho, where)
      }
    }
  })

  it('keeps every trajectory a unit vector', () => {
    /*
     * The statevector half of the same statement, and the check that a missing
     * 1/√pₖ has to fail: Kₖ|ψ⟩ has norm √pₖ, so a trajectory that skipped the
     * renormalisation would come back from a twenty-column circuit with a norm
     * visibly below 1 and, on a long enough circuit, with a norm of zero.
     *
     * Twenty seeds, because the interesting trajectories are the ones that
     * jumped, and at a few per cent per application most of them do not.
     */
    const circuit = deepCircuit(20)
    for (let seed = 1; seed <= 20; seed++) {
      const trajectory = runTrajectory(circuit, createRng(seed), {
        profile: NOISE_PROFILES.teaching,
      })
      expect(norm(trajectory.state), `seed ${seed}`).toBeCloseTo(1, DIGITS)
    }
  })
})

describe('the memory ceiling and the escape from it', () => {
  it('refuses a register ρ cannot hold, and runs it as trajectories', () => {
    /*
     * §3.3's whole reason for existing as a study mode: ρ is 4ⁿ and stops
     * around twelve qubits, while a statevector is 2ⁿ and does not. Thirteen
     * qubits is 1 GB of density matrix — an allocation that would either take
     * the tab with it or fail from inside a typed-array constructor with
     * nothing a user could act on — and 128 KB of statevector.
     */
    const qubits = MAX_DENSITY_QUBITS + 1
    const circuit: CircuitLike = {
      qubits,
      operations: [
        op('h', [0], 0),
        ...Array.from({ length: qubits - 1 }, (_, i) =>
          op('cx', [i + 1], i + 1, [i])
        ),
      ],
    }
    const profile = NOISE_PROFILES.superconducting

    let caught: unknown
    try {
      runNoisyDensity(circuit, { profile })
    } catch (error) {
      caught = error
    }
    expect(caught).toBeInstanceOf(DensityTooLargeError)
    expect((caught as DensityTooLargeError).qubits).toBe(qubits)

    // The same circuit, the same profile, sampled instead of summed.
    const result = runNoisy(circuit, { profile, shots: 32, rng: createRng(8) })
    expect(totalOf(toMap(result.counts))).toBe(32)
    // A GHZ ladder under a little noise is still mostly |0…0⟩ and |1…1⟩.
    const zero = '0'.repeat(qubits)
    const one = '1'.repeat(qubits)
    const extreme = (result.counts[zero] ?? 0) + (result.counts[one] ?? 0)
    expect(extreme).toBeGreaterThan(24)
  })
})

/* ────────────────────────────── small helpers ───────────────────────────── */

function idealState(circuit: CircuitLike): Statevector {
  const result = run(circuit)
  if (result.mode !== 'analytic') expect.unreachable('expected analytic mode')
  return result.state
}

function expectPhysical(rho: DensityMatrix, where: string): void {
  expect(trace(rho), `${where}: trace`).toBeCloseTo(1, DIGITS)
  expect(isHermitian(rho, TOLERANCE), `${where}: Hermitian`).toBe(true)
  expect(isPositiveSemidefinite(rho, TOLERANCE), `${where}: positive`).toBe(
    true
  )
}
