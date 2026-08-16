/**
 * Independent verification (lens: ui-truth-a11y) — are the two distributions on
 * screen the same circuit under two settings?
 *
 * This is the failure a noise panel must never be able to have, because it is
 * indistinguishable from physics: if the ideal half describes column 3 and the
 * noisy half describes the whole circuit, every column the ideal half has not
 * run yet is attributed to the device. The result is a normalised, plausible
 * distribution with a plausible fidelity, and nothing on screen says otherwise.
 *
 * So the checks here compare the payload the job produced against reference runs
 * this file made itself, of circuits it truncated itself — never against the
 * job's own idea of which cut it used:
 *
 *  1. At a scrub position, the noisy distribution is the noisy run of the
 *     *prefix*, and it is measurably not the noisy run of the whole circuit.
 *  2. The ideal state in the same message is the ideal run of that same prefix.
 *  3. The bar lengths the reader sees are the ideal probabilities, unchanged by
 *     the overlay — an overlay that quietly rewrote the bar would make the
 *     comparison a chart of the noisy run against itself.
 *  4. Changing only the noise profile leaves every ideal bar exactly where it
 *     was. Two settings, one circuit.
 */

import {
  NOISE_PROFILES,
  run,
  runNoisyDensity,
  type Statevector,
} from '@qsim/core'
import { parseCircuit, type Circuit, type CircuitInput } from '@qsim/schema'
import { cleanup, render } from '@testing-library/react'
import { createInstance, type i18n as I18n } from 'i18next'
import { I18nextProvider, initReactI18next } from 'react-i18next'
import { afterEach, describe, expect, it } from 'vitest'

import { NoiseComparisonPanel } from '../../features/analysis/NoiseComparisonPanel'
import { runJob } from '../../features/simulation/job'
import { runNoiseJob } from '../../features/simulation/noiseJob'
import {
  decodeState,
  type AnalyticRequest,
  type NoiseSpec,
} from '../../features/simulation/protocol'
import { createCheckpoints } from '@qsim/core'
import enAnalysis from '../../i18n/locales/en/analysis.json'

/**
 * Four columns, each of which changes the distribution.
 *
 * Column 0 puts qubit 0 in superposition, column 1 entangles qubit 1 onto it,
 * column 2 turns qubit 2 on unconditionally and column 3 rotates qubit 1 — so
 * the distribution after column 1 and the distribution after column 3 disagree
 * on every basis state, and a comparison that mixed the two cuts cannot pass by
 * luck.
 */
const CIRCUIT: CircuitInput = {
  schemaVersion: 1,
  qubits: 3,
  operations: [
    { id: 'a', gate: 'h', targets: [0], column: 0 },
    { id: 'b', gate: 'cx', targets: [1], controls: [0], column: 1 },
    { id: 'c', gate: 'x', targets: [2], column: 2 },
    { id: 'd', gate: 'ry', targets: [1], params: [0.8], column: 3 },
  ],
}

const SPEC: NoiseSpec = {
  profile: NOISE_PROFILES.teaching,
  readout: true,
  method: 'density',
  shots: 1000,
  seed: 1,
}

function i18nFor(): I18n {
  const instance = createInstance()
  void instance.use(initReactI18next).init({
    lng: 'en',
    fallbackLng: 'en',
    ns: ['analysis'],
    defaultNS: 'analysis',
    resources: { en: { analysis: enAnalysis } },
    interpolation: { escapeValue: false },
    react: { useSuspense: false },
  })
  return instance
}

/** The prefix of a circuit up to and including `column`, built here. */
function prefix(circuit: Circuit, column: number): Circuit {
  return {
    ...circuit,
    operations: circuit.operations.filter(
      (operation) => operation.column <= column
    ),
  }
}

function idealState(circuit: Circuit): Statevector {
  const result = run(circuit)
  if (result.mode !== 'analytic') throw new Error('expected an analytic run')
  return result.state
}

function bornProbabilities(state: Statevector): number[] {
  const out: number[] = []
  for (let i = 0; i < state.size; i++) {
    const re = state.re[i] ?? 0
    const im = state.im[i] ?? 0
    out.push(re * re + im * im)
  }
  return out
}

function analyticRequest(
  circuit: Circuit,
  throughColumn: number | null
): AnalyticRequest {
  return {
    kind: 'simulate',
    id: 1,
    circuit,
    fromColumn: 0,
    sharedMemory: false,
    mode: 'analytic',
    throughColumn,
    sample: null,
    noise: SPEC,
  }
}

afterEach(cleanup)

describe('the ideal half and the noisy half describe one circuit', () => {
  const circuit = parseCircuit(CIRCUIT)

  it('runs the noisy half over the same cut the ideal half stopped at', () => {
    const job = runJob(createCheckpoints(), analyticRequest(circuit, 1), false)
    const response = job.response
    if (response.kind !== 'result' || response.mode !== 'analytic') {
      throw new Error('the job did not answer analytically')
    }
    if (response.noise === null || !response.noise.ok) {
      throw new Error('the job carried no noisy reading')
    }

    const cut = runNoisyDensity(prefix(circuit, 1), {
      profile: SPEC.profile,
      readout: SPEC.readout,
    })
    const whole = runNoisyDensity(circuit, {
      profile: SPEC.profile,
      readout: SPEC.readout,
    })

    const shown = response.noise.reading.distribution
    expect(shown).not.toBeNull()
    for (let i = 0; i < cut.distribution.length; i++) {
      expect(shown?.[i] ?? -1, `basis state ${i}`).toBeCloseTo(
        cut.distribution[i] ?? 0,
        12
      )
    }

    // And the two cuts really are different, so the assertion above had
    // something to catch.
    const apart = cut.distribution.reduce(
      (worst, value, i) =>
        Math.max(worst, Math.abs(value - (whole.distribution[i] ?? 0))),
      0
    )
    expect(apart).toBeGreaterThan(0.05)
  })

  it('answers with the ideal state of that same cut', () => {
    const job = runJob(createCheckpoints(), analyticRequest(circuit, 1), false)
    const response = job.response
    if (response.kind !== 'result' || response.mode !== 'analytic') {
      throw new Error('the job did not answer analytically')
    }
    const shown = bornProbabilities(decodeState(response.state))
    const expected = bornProbabilities(idealState(prefix(circuit, 1)))
    for (let i = 0; i < expected.length; i++) {
      expect(shown[i] ?? -1, `basis state ${i}`).toBeCloseTo(
        expected[i] ?? 0,
        12
      )
    }
  })

  it('draws the bars at the ideal probabilities, not the noisy ones', () => {
    const state = idealState(circuit)
    const payload = runNoiseJob(circuit, state, SPEC)
    if (!payload.ok) throw new Error('the engine refused the run')

    const view = render(
      <I18nextProvider i18n={i18nFor()}>
        <NoiseComparisonPanel state={state} reading={payload.reading} />
      </I18nextProvider>
    )

    const ideal = bornProbabilities(state)
    const track = view.container.querySelector(
      '.noise-comparison .histogram__track'
    )
    const trackWidth = Number(track?.getAttribute('width'))
    expect(trackWidth).toBeGreaterThan(0)

    const rows = [
      ...view.container.querySelectorAll('.noise-comparison .histogram__row'),
    ].filter((row) => !row.classList.contains('histogram__row--remainder'))
    expect(rows.length).toBeGreaterThan(1)

    for (const row of rows) {
      const label = (
        row.querySelector('.histogram__label')?.textContent ?? ''
      ).replace(/[|⟩]/gu, '')
      // `formatKet` prints the highest qubit first, so the label read as a
      // binary numeral is the statevector index — D1 stated as a round trip.
      const index = Number.parseInt(label, 2)
      const fill = Number(
        row.querySelector('.histogram__fill')?.getAttribute('width')
      )
      expect(fill / trackWidth, `bar ${label}`).toBeCloseTo(
        ideal[index] ?? 0,
        9
      )
    }
  })

  it('leaves every ideal bar untouched when only the profile changes', () => {
    const state = idealState(circuit)
    const widths = (spec: NoiseSpec): string[] => {
      const payload = runNoiseJob(circuit, state, spec)
      if (!payload.ok) throw new Error('the engine refused the run')
      const view = render(
        <I18nextProvider i18n={i18nFor()}>
          <NoiseComparisonPanel state={state} reading={payload.reading} />
        </I18nextProvider>
      )
      const drawn = [
        ...view.container.querySelectorAll(
          '.noise-comparison .histogram__fill'
        ),
      ].map((rect) => rect.getAttribute('width') ?? '')
      cleanup()
      return drawn
    }

    const teaching = widths(SPEC)
    const superconducting = widths({
      ...SPEC,
      profile: NOISE_PROFILES.superconducting,
    })
    expect(teaching).toEqual(superconducting)
    expect(teaching.length).toBeGreaterThan(1)
  })
})
