/**
 * §3.3's comparison model: the two distributions lined up on one set of rows.
 *
 * Nothing here computes physics — both distributions arrive finished — so what
 * is asserted is the lining up, and every claim is one a wrong answer would
 * quietly satisfy if it were not checked:
 *
 *  - The rows are the *chart's* rows. Three renderings of one distribution that
 *    each chose their own states would let a bar exist with no row beside it.
 *  - The remainder carries the noisy mass that has nowhere else to go —
 *    including probability the noise *created*, which by construction has no
 *    row of its own, because rows are chosen by ideal probability.
 *  - Both payload shapes join to the same rows: a distribution by index, a
 *    tally by ket label.
 */

import { run, type Statevector } from '@qsim/core'
import { parseCircuit, type CircuitInput } from '@qsim/schema'
import { describe, expect, it } from 'vitest'

import type { NoiseReading } from '../simulation/protocol'
import { buildHistogram } from './histogram'
import { buildNoiseComparison, overlayOf } from './noiseComparison'

const DIGITS = 10

function stateOf(input: CircuitInput): Statevector {
  const result = run(parseCircuit(input))
  if (result.mode !== 'analytic') throw new Error('expected an analytic run')
  return result.state
}

/** A Bell pair: exactly two occupied basis states, |00⟩ and |11⟩. */
function bell(): Statevector {
  return stateOf({
    schemaVersion: 1,
    qubits: 2,
    operations: [
      { id: 'h', gate: 'h', targets: [0], column: 0 },
      { id: 'cx', gate: 'x', targets: [1], controls: [0], column: 1 },
    ],
  })
}

function exact(distribution: number[]): NoiseReading {
  return {
    method: 'density',
    distribution: Float64Array.from(distribution),
    counts: null,
    shots: null,
    distributionFidelity: 0.9,
    totalVariation: 0.1,
    stateFidelity: 0.8,
    purity: 0.7,
    density: null,
  }
}

function sampled(counts: Record<string, number>, shots: number): NoiseReading {
  return {
    method: 'trajectories',
    distribution: null,
    counts,
    shots,
    distributionFidelity: 0.9,
    totalVariation: 0.1,
    stateFidelity: null,
    purity: null,
    density: null,
  }
}

describe('buildNoiseComparison', () => {
  it('draws exactly the states the chart draws', () => {
    const state = bell()
    const model = buildHistogram(state)
    const comparison = buildNoiseComparison(
      state,
      exact([0.4, 0.05, 0.05, 0.5])
    )

    expect(comparison.rows.map((row) => row.index)).toEqual(
      model.bars.map((bar) => bar.index)
    )
    expect(comparison.rows.map((row) => row.ideal)).toEqual(
      model.bars.map((bar) => bar.probability)
    )
  })

  it('reads the signed difference the way a reader would subtract it', () => {
    const comparison = buildNoiseComparison(
      bell(),
      exact([0.4, 0.05, 0.05, 0.5])
    )
    const [first, second] = comparison.rows
    expect(first?.noisy).toBeCloseTo(0.4, DIGITS)
    expect(first?.delta).toBeCloseTo(-0.1, DIGITS)
    expect(second?.noisy).toBeCloseTo(0.5, DIGITS)
    expect(second?.delta).toBeCloseTo(0, DIGITS)
  })

  it('puts probability the noise created into the remainder row', () => {
    /*
     * |01⟩ and |10⟩ carry nothing ideally, so they have no bars — the selection
     * is by ideal probability, which is what keeps the chart from reordering
     * itself on every slider tick. The 10 % the noise put there is not lost: it
     * is the remainder's own gain, and a positive delta on that row is exactly
     * "the noise put probability where the circuit put none".
     */
    const comparison = buildNoiseComparison(
      bell(),
      exact([0.45, 0.05, 0.05, 0.45])
    )
    expect(comparison.rows).toHaveLength(2)
    expect(comparison.remainder).not.toBeNull()
    expect(comparison.remainder?.ideal).toBeCloseTo(0, DIGITS)
    expect(comparison.remainder?.noisy).toBeCloseTo(0.1, DIGITS)
    expect(comparison.remainder?.delta).toBeCloseTo(0.1, DIGITS)
    // Those two states carry nothing ideally, so nothing counts them as hidden.
    expect(comparison.hiddenStates).toBe(0)
  })

  it('has no remainder when nothing moved outside the drawn rows', () => {
    const comparison = buildNoiseComparison(bell(), exact([0.5, 0, 0, 0.5]))
    expect(comparison.remainder).toBeNull()
  })

  it('names the biggest gain and the biggest loss', () => {
    const comparison = buildNoiseComparison(bell(), exact([0.3, 0, 0, 0.7]))
    expect(comparison.largestLoss?.index).toBe(0)
    expect(comparison.largestLoss?.delta).toBeCloseTo(-0.2, DIGITS)
    expect(comparison.largestGain?.index).toBe(3)
    expect(comparison.largestGain?.delta).toBeCloseTo(0.2, DIGITS)
  })

  it('names neither when the distribution did not move', () => {
    /*
     * A Bell pair's ideal probability is 0.5000000000000001 — a Hadamard's
     * 1/√2 squared — so an exactly-0.5 noisy reading has a delta of −1.1e-16.
     * Without a floor the panel would announce "|00⟩ lost the most, 0 %" over a
     * chart where nothing moved. `MOVEMENT_FLOOR` is half of the last digit the
     * delta column prints, so the sentence and the digits cannot disagree.
     */
    const comparison = buildNoiseComparison(bell(), exact([0.5, 0, 0, 0.5]))
    expect(comparison.largestGain).toBeNull()
    expect(comparison.largestLoss).toBeNull()
  })

  it('still names a movement the delta column would print', () => {
    // The floor must not swallow anything visible: one part in ten thousand is
    // `0,01 %`, which is a number on screen.
    const comparison = buildNoiseComparison(
      bell(),
      exact([0.4999, 0.0001, 0, 0.5])
    )
    expect(comparison.largestLoss?.index).toBe(0)
    expect(comparison.largestGain?.index).toBeNull()
  })

  it('joins a tally by ket label and a distribution by index to the same rows', () => {
    // The two payload shapes are the two methods, and a comparison that read
    // one of them back to front would be a mirror image nobody could spot: a
    // Bell pair is symmetric under it.
    const asDistribution = buildNoiseComparison(bell(), exact([0.3, 0, 0, 0.7]))
    const asCounts = buildNoiseComparison(
      bell(),
      sampled({ '00': 300, '11': 700 }, 1000)
    )
    expect(asCounts.rows.map((row) => row.noisy)).toEqual(
      asDistribution.rows.map((row) => row.noisy)
    )
  })

  it('reads shots that landed outside the drawn rows as the remainder', () => {
    const comparison = buildNoiseComparison(
      bell(),
      sampled({ '00': 450, '01': 50, '10': 50, '11': 450 }, 1000)
    )
    expect(comparison.remainder?.noisy).toBeCloseTo(0.1, DIGITS)
  })

  it('answers zero rather than NaN for a run that drew nothing', () => {
    // One NaN in a width attribute takes the whole chart down, and `shots = 0`
    // is a legitimate request rather than a bug.
    const comparison = buildNoiseComparison(bell(), sampled({}, 0))
    for (const row of comparison.rows) {
      expect(Number.isFinite(row.noisy)).toBe(true)
      expect(row.noisy).toBe(0)
    }
  })

  it('carries the four headline numbers through untouched', () => {
    // They are computed on the worker over the whole distribution, not over
    // the drawn rows — so this module must pass them along rather than
    // re-deriving them from thirty-two bars.
    const reading = exact([0.4, 0.05, 0.05, 0.5])
    const comparison = buildNoiseComparison(bell(), reading)
    expect(comparison.distributionFidelity).toBe(reading.distributionFidelity)
    expect(comparison.totalVariation).toBe(reading.totalVariation)
    expect(comparison.stateFidelity).toBe(reading.stateFidelity)
    expect(comparison.purity).toBe(reading.purity)
    expect(comparison.method).toBe('density')
  })
})

describe('overlayOf', () => {
  it('gives the chart one entry per drawn row, keyed by index', () => {
    const comparison = buildNoiseComparison(
      bell(),
      exact([0.4, 0.05, 0.05, 0.5])
    )
    const overlay = overlayOf(comparison, 'noisy', 'difference')

    expect([...overlay.probabilities.keys()].sort((a, b) => a - b)).toEqual([
      0, 3,
    ])
    expect(overlay.probabilities.get(0)).toBeCloseTo(0.4, DIGITS)
    expect(overlay.remainder).toBeCloseTo(0.1, DIGITS)
    expect(overlay.label).toBe('noisy')
    expect(overlay.deltaLabel).toBe('difference')
  })

  it('reports a remainder of zero when there is no remainder row', () => {
    const comparison = buildNoiseComparison(bell(), exact([0.5, 0, 0, 0.5]))
    expect(overlayOf(comparison, 'a', 'b').remainder).toBe(0)
  })
})
