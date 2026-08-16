/**
 * The noisy half of a job, against the real engine.
 *
 * A PHYSICS BUG THROWS NO EXCEPTION. A depolarising channel with the wrong
 * coefficient still returns a normalised distribution that looks entirely
 * plausible, and nobody has an intuition for what a noisy histogram should look
 * like — so every assertion below is against a case with a known answer rather
 * than against this module's own output:
 *
 *  - The `ideal` profile has no channels at all, so the noisy distribution must
 *    equal the ideal one *exactly* and every fidelity must be 1.
 *  - Amplitude damping at γ = 1 is a reset, so a circuit run under a profile
 *    whose gate time swamps its T1 collapses onto the ground state.
 *  - The exact method and the sampled one are the same physics evaluated two
 *    ways, so their distributions converge as the shot count rises.
 *
 * And the ceiling is a returned refusal carrying its numbers, never a throw and
 * never an allocation: the ideal half of the message it rides on is a perfectly
 * good answer, and losing a histogram to report a limit on one panel is the
 * failure §3.3 forbids wearing the opposite mask.
 */

import {
  NOISE_PROFILES,
  distributionFidelity,
  probabilities,
  run,
  type Statevector,
} from '@qsim/core'
import { parseCircuit, type Circuit, type CircuitInput } from '@qsim/schema'
import { describe, expect, it } from 'vitest'

import { DENSITY_BLOCK_LIMIT, runNoiseJob } from './noiseJob'
import {
  MAX_DENSITY_CLIENT_QUBITS,
  type NoiseReading,
  type NoiseSpec,
} from './protocol'

const DIGITS = 10

function circuitOf(input: CircuitInput): Circuit {
  return parseCircuit(input)
}

function stateOf(circuit: Circuit): Statevector {
  const result = run(circuit)
  if (result.mode !== 'analytic') throw new Error('expected an analytic run')
  return result.state
}

/** H on 0, CNOT 0→1: the two-qubit Bell pair everything below is built on. */
function bell(qubits = 2): Circuit {
  return circuitOf({
    schemaVersion: 1,
    qubits,
    operations: [
      { id: 'h', gate: 'h', targets: [0], column: 0 },
      { id: 'cx', gate: 'x', targets: [1], controls: [0], column: 1 },
    ],
  })
}

function spec(patch: Partial<NoiseSpec> = {}): NoiseSpec {
  return {
    profile: NOISE_PROFILES.teaching,
    readout: true,
    method: 'density',
    shots: 4000,
    seed: 7,
    ...patch,
  }
}

function reading(
  circuit: Circuit,
  patch: Partial<NoiseSpec> = {}
): NoiseReading {
  const payload = runNoiseJob(circuit, stateOf(circuit), spec(patch))
  if (!payload.ok) throw new Error(`refused: ${payload.refusal.detail}`)
  return payload.reading
}

describe('the exact method', () => {
  it('reproduces the ideal run exactly at zero noise', () => {
    // `channelsForGate` drops channels whose parameter is zero, so under the
    // ideal profile the noisy path *is* the unitary path — the same arithmetic
    // in the same order. Anything less than exact equality here would mean a
    // channel is being applied that should not exist.
    const circuit = bell()
    const ideal = probabilities(stateOf(circuit))
    const noisy = reading(circuit, { profile: NOISE_PROFILES.ideal })

    expect(noisy.distribution).not.toBeNull()
    expect([...noisy.distribution!]).toEqual([...ideal])
    expect(noisy.distributionFidelity).toBeCloseTo(1, DIGITS)
    expect(noisy.stateFidelity).toBeCloseTo(1, DIGITS)
    expect(noisy.purity).toBeCloseTo(1, DIGITS)
    expect(noisy.totalVariation).toBeCloseTo(0, DIGITS)
  })

  it('returns a normalised distribution under a noisy profile', () => {
    // The check that catches nothing on its own and everything in combination:
    // a wrong coefficient usually still normalises, which is exactly why the
    // assertions above and below are about known answers instead.
    const noisy = reading(bell())
    const total = [...noisy.distribution!].reduce((sum, p) => sum + p, 0)
    expect(total).toBeCloseTo(1, DIGITS)
    for (const p of noisy.distribution!) expect(p).toBeGreaterThanOrEqual(0)
  })

  it('degrades the state and says so in four different numbers', () => {
    const noisy = reading(bell())
    for (const value of [
      noisy.distributionFidelity,
      noisy.stateFidelity!,
      noisy.purity!,
    ]) {
      expect(value).toBeGreaterThan(0)
      expect(value).toBeLessThan(1)
    }
    expect(noisy.totalVariation).toBeGreaterThan(0)
    expect(noisy.totalVariation).toBeLessThan(1)
  })

  it('never reports a state fidelity above the distribution fidelity', () => {
    /*
     * Data-processing monotonicity, and it is a real check rather than a
     * tautology: measuring in the computational basis is a channel, fidelity
     * cannot decrease under one, so the classical fidelity of the two
     * histograms is an upper bound on the fidelity of the two states. A
     * coefficient error that made ρ *more* like |ψ⟩ than its own diagonal is
     * would break this and would break nothing else here.
     *
     * Readout error is off, and has to be: it is a classical channel applied to
     * one side of the comparison only, so with it on the two numbers are
     * answering questions about different objects (the test above pins exactly
     * that).
     */
    for (const profile of [
      NOISE_PROFILES.teaching,
      NOISE_PROFILES.superconducting,
      NOISE_PROFILES.trappedIon,
    ]) {
      const noisy = reading(bell(3), { readout: false, profile })
      expect(noisy.stateFidelity!).toBeLessThanOrEqual(
        noisy.distributionFidelity + 1e-9
      )
    }
  })

  it('collapses onto the ground state when the gate time swamps T1', () => {
    // γ = 1 − e^{−t/T1}, so a gate a thousand T1 long damps with certainty and
    // the whole register ends in the ground state. A closed form the arithmetic
    // has no way to fake.
    const collapsed = reading(bell(), {
      readout: false,
      profile: {
        id: 'custom',
        t1Ns: 1,
        t2Ns: 2,
        oneQubitGateNs: 1000,
        twoQubitGateNs: 1000,
        oneQubitGateError: 0,
        twoQubitGateError: 0,
        readoutP0to1: 0,
        readoutP1to0: 0,
      },
    })
    expect(collapsed.distribution?.[0]).toBeCloseTo(1, 6)
    // And the answer is a pure state again: |0…0⟩ is pure, however it got there.
    expect(collapsed.purity).toBeCloseTo(1, 6)
  })

  it('measures the state fidelity against ρ rather than against the reported histogram', () => {
    // Readout error is a classifier misreading a voltage after the qubit is
    // gone, so it belongs to the histogram and not to the state. Turning it on
    // must move the distribution fidelity and leave ⟨ψ|ρ|ψ⟩ where it was.
    const withReadout = reading(bell(), { readout: true })
    const without = reading(bell(), { readout: false })

    expect(withReadout.stateFidelity).toBeCloseTo(
      without.stateFidelity!,
      DIGITS
    )
    expect(withReadout.distributionFidelity).not.toBeCloseTo(
      without.distributionFidelity,
      6
    )
  })
})

describe('the block of ρ the heat map draws', () => {
  it('draws a Bell pair whole: two states, four entries, the coherences on the corners', () => {
    const block = reading(bell(), { profile: NOISE_PROFILES.ideal }).density
    expect(block).not.toBeNull()
    expect(block!.indices).toEqual([0, 3])
    expect(block!.labels).toEqual(['00', '11'])
    expect(block!.hidden).toBe(0)
    // ρ = ½(|00⟩+|11⟩)(⟨00|+⟨11|): every entry is ½ and every one is real.
    // Closeness rather than equality — a Hadamard's 1/√2 squared is 0.5 plus
    // an ulp, which is D6's Float64 drift and not a coefficient.
    for (const value of block!.re) expect(value).toBeCloseTo(0.5, DIGITS)
    for (const value of block!.im) expect(value).toBeCloseTo(0, DIGITS)
  })

  it('caps the block and reports what it left out', () => {
    // Sixteen states, not thirty-two: a chart of k states is k marks and a
    // matrix of them is k², so the histogram's cap would be 1024 cells.
    const wide = circuitOf({
      schemaVersion: 1,
      qubits: 5,
      operations: Array.from({ length: 5 }, (_unused, wire) => ({
        id: `h${wire}`,
        gate: 'h',
        targets: [wire],
        column: 0,
      })),
    })
    const block = reading(wide, { profile: NOISE_PROFILES.ideal }).density
    expect(block!.indices).toHaveLength(DENSITY_BLOCK_LIMIT)
    expect(block!.limit).toBe(DENSITY_BLOCK_LIMIT)
    expect(block!.hidden).toBe(32 - DENSITY_BLOCK_LIMIT)
    expect(block!.hiddenPopulation).toBeCloseTo(16 / 32, DIGITS)
    // Drawn in basis-state order, so a row keeps its place between answers.
    expect([...block!.indices]).toEqual(
      [...block!.indices].sort((a, b) => a - b)
    )
  })

  it('is Hermitian, as ρ is', () => {
    const block = reading(bell()).density!
    const size = block.indices.length
    for (let row = 0; row < size; row++) {
      for (let column = 0; column < size; column++) {
        expect(block.re[row * size + column]).toBeCloseTo(
          block.re[column * size + row]!,
          DIGITS
        )
        expect(block.im[row * size + column]).toBeCloseTo(
          -block.im[column * size + row]!,
          DIGITS
        )
      }
    }
  })
})

describe('the sampled method', () => {
  it('answers with counts and no ρ', () => {
    const sampled = reading(bell(), { method: 'trajectories' })
    expect(sampled.method).toBe('trajectories')
    expect(sampled.counts).not.toBeNull()
    expect(sampled.shots).toBe(4000)
    // The three questions only a matrix can answer are honestly absent.
    expect(sampled.distribution).toBeNull()
    expect(sampled.stateFidelity).toBeNull()
    expect(sampled.purity).toBeNull()
    expect(sampled.density).toBeNull()
  })

  it('tallies every shot exactly once', () => {
    const sampled = reading(bell(), { method: 'trajectories' })
    const total = Object.values(sampled.counts!).reduce((a, b) => a + b, 0)
    expect(total).toBe(4000)
  })

  it('reproduces the ideal counts exactly at zero noise', () => {
    const sampled = reading(bell(), {
      method: 'trajectories',
      profile: NOISE_PROFILES.ideal,
    })
    // Nothing outside the support of the ideal state, and the fidelity of a
    // sample against the distribution it was drawn from is 1 to shot noise.
    expect(Object.keys(sampled.counts!).sort()).toEqual(['00', '11'])
    expect(sampled.distributionFidelity).toBeGreaterThan(0.999)
  })

  it('converges on the exact method as the shots rise', () => {
    // The two are the same physics evaluated two ways (§5.4), so this is the
    // strongest single check that neither is wrong: a coefficient error in one
    // path would not be reproduced by the other.
    const circuit = bell()
    const exact = reading(circuit)
    const few = reading(circuit, { method: 'trajectories', shots: 200 })
    const many = reading(circuit, { method: 'trajectories', shots: 40_000 })

    const gap = (sampled: NoiseReading): number => {
      const shots = sampled.shots ?? 1
      const drawn = new Float64Array(4)
      for (const [label, count] of Object.entries(sampled.counts ?? {})) {
        drawn[Number.parseInt(label, 2)] = count / shots
      }
      return 1 - distributionFidelity(exact.distribution!, drawn)
    }

    expect(gap(many)).toBeLessThan(gap(few))
    expect(gap(many)).toBeLessThan(1e-3)
  })

  it('reads a ket label back to the index formatKet built it from', () => {
    // The one coupling `spread` rests on: `formatKet` prints the register
    // highest-qubit-first, i.e. as a plain binary numeral, so `parseInt(·, 2)`
    // is its inverse. A change to either would turn every sampled fidelity
    // into a plausible wrong number, so it is pinned rather than assumed.
    const sampled = reading(bell(3), {
      method: 'trajectories',
      profile: NOISE_PROFILES.ideal,
    })
    for (const label of Object.keys(sampled.counts!)) {
      expect(label).toMatch(/^[01]{3}$/u)
      // D1: qubit 0 is the least significant bit, so |011⟩ is index 3.
      expect(Number.parseInt(label, 2)).toBeLessThan(8)
    }
    expect(Object.keys(sampled.counts!).sort()).toEqual(['000', '011'])
  })
})

describe('the ceiling', () => {
  it('refuses a register past the limit, with the numbers, before allocating', () => {
    const wide = circuitOf({
      schemaVersion: 1,
      qubits: MAX_DENSITY_CLIENT_QUBITS + 1,
      operations: [{ id: 'h', gate: 'h', targets: [0], column: 0 }],
    })
    // The ideal state for a 13-qubit register is cheap; ρ for one is 1 GiB.
    // The refusal has to arrive without either being attempted.
    const payload = runNoiseJob(wide, stateOf(wide), spec())

    expect(payload.ok).toBe(false)
    if (payload.ok) return
    expect(payload.refusal.code).toBe('density-too-large')
    expect(payload.refusal.qubits).toBe(MAX_DENSITY_CLIENT_QUBITS + 1)
    expect(payload.refusal.limit).toBe(MAX_DENSITY_CLIENT_QUBITS)
  })

  it('runs the same register happily under the sampled method', () => {
    // The alternative the refusal names has to actually work, or the sentence
    // is advice the reader cannot take.
    const wide = circuitOf({
      schemaVersion: 1,
      qubits: MAX_DENSITY_CLIENT_QUBITS + 1,
      operations: [{ id: 'h', gate: 'h', targets: [0], column: 0 }],
    })
    const payload = runNoiseJob(
      wide,
      stateOf(wide),
      spec({ method: 'trajectories', shots: 100 })
    )
    expect(payload.ok).toBe(true)
  })

  it('returns a refusal rather than throwing when the profile is impossible', () => {
    const payload = runNoiseJob(
      bell(),
      stateOf(bell()),
      spec({
        profile: { ...NOISE_PROFILES.teaching, t2Ns: 10 ** 9 },
      })
    )
    expect(payload.ok).toBe(false)
    if (payload.ok) return
    expect(payload.refusal.code).toBe('noise-failed')
    // The English prose is for a console, never for a reader.
    expect(payload.refusal.detail.length).toBeGreaterThan(0)
  })
})
