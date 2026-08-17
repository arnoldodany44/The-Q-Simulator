/**
 * §3.7's three readings, lined up on one set of rows.
 *
 * Nothing here computes physics — all three distributions arrive finished — so
 * what is asserted is the lining up, and every claim is one a wrong answer
 * would quietly satisfy if it were not checked:
 *
 *  - The rows are the *chart's* rows, chosen by ideal probability, so an
 *    outcome the device created out of nothing lands in the remainder rather
 *    than vanishing.
 *  - The noisy column is taken from the worker's own reading and never
 *    recomputed, so two numbers labelled "fidelity" on one screen agree.
 *  - The model-versus-device number exists only when a full noisy distribution
 *    does, because a trajectories tally is not one.
 */

import { run, type Statevector } from '@qsim/core'
import { parseCircuit, type CircuitInput } from '@qsim/schema'
import { describe, expect, it } from 'vitest'

import { buildNoiseComparison } from '../analysis/noiseComparison'
import type { NoiseReading } from '../simulation/protocol'
import { buildHardwareComparison, overlaysOf } from './comparison'

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

function reading(distribution: number[]): NoiseReading {
  return {
    method: 'density',
    distribution: Float64Array.from(distribution),
    counts: null,
    shots: null,
    distributionFidelity: 0.94,
    totalVariation: 0.06,
    stateFidelity: 0.91,
    purity: 0.88,
    density: null,
  }
}

const LABELS = {
  noisy: 'model',
  noisyDelta: 'model change',
  real: 'device',
  realDelta: 'device change',
}

/** A device that found the two Bell outcomes plus a little leakage. */
const DEVICE = Float64Array.from([0.46, 0.03, 0.04, 0.47])

describe('the three readings on one set of rows', () => {
  const state = bell()
  const noise = buildNoiseComparison(state, reading([0.47, 0.02, 0.02, 0.49]))
  const comparison = buildHardwareComparison(
    state,
    DEVICE,
    1024,
    noise,
    Float64Array.from([0.47, 0.02, 0.02, 0.49])
  )

  it('draws the states the histogram drew, in basis-state order', () => {
    expect(comparison.rows.map((row) => row.label)).toEqual(['00', '11'])
    expect(comparison.qubits).toBe(2)
  })

  it('carries all three values and both differences on every row', () => {
    const [first] = comparison.rows

    expect(first?.ideal).toBeCloseTo(0.5, DIGITS)
    expect(first?.noisy).toBeCloseTo(0.47, DIGITS)
    expect(first?.real).toBeCloseTo(0.46, DIGITS)
    expect(first?.noisyDelta).toBeCloseTo(-0.03, DIGITS)
    expect(first?.realDelta).toBeCloseTo(-0.04, DIGITS)
  })

  /**
   * The rows are chosen by *ideal* probability, so |01⟩ and |10⟩ — which the
   * circuit never reaches — have no rows. The probability the device put there
   * is real and has to be somewhere; the remainder is that somewhere.
   */
  it('puts probability the device created into the remainder', () => {
    expect(comparison.remainder).not.toBeNull()
    expect(comparison.remainder?.ideal).toBeCloseTo(0, DIGITS)
    expect(comparison.remainder?.real).toBeCloseTo(0.07, DIGITS)
    expect(comparison.remainder?.realDelta).toBeCloseTo(0.07, DIGITS)
  })

  it('names the outcome the device gained most and the one it lost most', () => {
    // The remainder gained 7 %, more than either bar lost, and it is a row like
    // any other for this purpose — "the device put probability where the
    // circuit put none" is the most important thing on the chart.
    expect(comparison.largestGain?.index).toBeNull()
    // |00⟩ lost 4 % against |11⟩'s 3 %.
    expect(comparison.largestLoss?.label).toBe('00')
  })

  it('takes the model s own fidelity rather than recomputing one', () => {
    // The worker computed these over all 2ⁿ states; this module only ever sees
    // the drawn rows. Two numbers labelled "fidelity" that disagreed would be
    // worse than either.
    expect(comparison.noiseVsIdeal?.fidelity).toBe(0.94)
    expect(comparison.noiseVsIdeal?.totalVariation).toBe(0.06)
  })

  it('measures the device against the ideal state', () => {
    expect(comparison.deviceVsIdeal.fidelity).toBeGreaterThan(0.9)
    expect(comparison.deviceVsIdeal.fidelity).toBeLessThan(1)
    // ½ Σ|Δ| over every state: 0.04 + 0.03 + 0.04 + 0.03, halved.
    expect(comparison.deviceVsIdeal.totalVariation).toBeCloseTo(0.07, DIGITS)
  })

  it('measures how good the model was, which neither other pair says', () => {
    expect(comparison.modelVsReal).not.toBeNull()
    // The model predicted the device better than the ideal circuit did, which
    // is the whole reason a noise profile is worth having.
    expect(comparison.modelVsReal?.fidelity).toBeGreaterThan(
      comparison.deviceVsIdeal.fidelity
    )
  })

  it('reports the shots the third column was drawn from', () => {
    expect(comparison.shots).toBe(1024)
  })
})

describe('when there is no noisy run to compare against', () => {
  const state = bell()
  const comparison = buildHardwareComparison(state, DEVICE, 512, null, null)

  it('still lines the device up against the ideal state', () => {
    expect(comparison.rows.map((row) => row.real)).toEqual([0.46, 0.47])
    expect(comparison.deviceVsIdeal.fidelity).toBeGreaterThan(0.9)
  })

  it('leaves both model figures absent rather than inventing them', () => {
    expect(comparison.noiseVsIdeal).toBeNull()
    expect(comparison.modelVsReal).toBeNull()
    expect(comparison.rows.every((row) => row.noisy === null)).toBe(true)
    expect(comparison.rows.every((row) => row.noisyDelta === null)).toBe(true)
  })

  it('draws one overlay, not a lane of zeros for a model nobody ran', () => {
    const overlays = overlaysOf(comparison, LABELS)

    expect(overlays).toHaveLength(1)
    expect(overlays[0]?.label).toBe('device')
  })
})

describe('when the noisy run was sampled rather than exact', () => {
  const state = bell()
  const sampled: NoiseReading = {
    method: 'trajectories',
    distribution: null,
    counts: { '00': 470, '11': 490, '01': 20, '10': 20 },
    shots: 1000,
    distributionFidelity: 0.93,
    totalVariation: 0.07,
    stateFidelity: null,
    purity: null,
    density: null,
  }
  const noise = buildNoiseComparison(state, sampled)
  const comparison = buildHardwareComparison(state, DEVICE, 1024, noise, null)

  it('still shows the model column, which the tally does carry', () => {
    expect(comparison.noiseVsIdeal?.fidelity).toBe(0.93)
    expect(comparison.rows[0]?.noisy).toBeCloseTo(0.47, DIGITS)
  })

  /**
   * A tally over the states a sampled run happened to visit is not a
   * distribution over all of them, and reconstructing one from it and labelling
   * it the same thing would make a number silently change meaning with a method
   * chosen in a different panel.
   */
  it('leaves the model-versus-device figure absent', () => {
    expect(comparison.modelVsReal).toBeNull()
  })
})

describe('the overlays the chart consumes', () => {
  const state = bell()
  const noise = buildNoiseComparison(state, reading([0.47, 0.02, 0.02, 0.49]))
  const comparison = buildHardwareComparison(
    state,
    DEVICE,
    1024,
    noise,
    Float64Array.from([0.47, 0.02, 0.02, 0.49])
  )
  const overlays = overlaysOf(comparison, LABELS)

  it('puts the model before the device, which is the order they happened', () => {
    expect(overlays.map((overlay) => overlay.label)).toEqual([
      'model',
      'device',
    ])
  })

  it('gives each overlay the rows it belongs to, keyed by basis state', () => {
    const [model, device] = overlays

    expect(model?.probabilities.get(0)).toBeCloseTo(0.47, DIGITS)
    expect(device?.probabilities.get(0)).toBeCloseTo(0.46, DIGITS)
    expect(device?.probabilities.get(3)).toBeCloseTo(0.47, DIGITS)
    // |01⟩ and |10⟩ are not rows, so they are not in either map — they are in
    // the remainder, which the chart draws as its own bar.
    expect(device?.probabilities.has(1)).toBe(false)
  })

  it('carries each reading s share of the remainder', () => {
    const [model, device] = overlays

    expect(model?.remainder).toBeCloseTo(0.04, DIGITS)
    expect(device?.remainder).toBeCloseTo(0.07, DIGITS)
  })
})
