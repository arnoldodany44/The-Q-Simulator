/**
 * The demonstration path, driven independently: one stored row, no network,
 * three locales — and every number on screen checked against one computed here
 * by an obviously-correct method rather than against the component's own model.
 */

import { run, type Statevector } from '@qsim/core'
import type { HardwareJob } from '@qsim/contract'
import { parseCircuit, type Circuit } from '@qsim/schema'
import { cleanup, render, screen, within } from '@testing-library/react'
import { createInstance, type i18n as I18n } from 'i18next'
import { I18nextProvider, initReactI18next } from 'react-i18next'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import enAnalysis from '../../../../i18n/locales/en/analysis.json'
import esAnalysis from '../../../../i18n/locales/es/analysis.json'
import frAnalysis from '../../../../i18n/locales/fr/analysis.json'
import enHardware from '../../../../i18n/locales/en/hardware.json'
import esHardware from '../../../../i18n/locales/es/hardware.json'
import frHardware from '../../../../i18n/locales/fr/hardware.json'
import { buildNoiseComparison } from '../../../analysis/noiseComparison'
import type { NoiseReading } from '../../../simulation/protocol'
import { HardwareResultView } from '../../HardwareResultView'
import { idealCircuitOf } from '../../ideal'

type Language = 'en' | 'es' | 'fr'

function i18nFor(language: Language): I18n {
  const instance = createInstance()
  void instance.use(initReactI18next).init({
    lng: language,
    fallbackLng: 'en',
    ns: ['hardware', 'analysis'],
    defaultNS: 'hardware',
    resources: {
      en: { hardware: enHardware, analysis: enAnalysis },
      es: { hardware: esHardware, analysis: esAnalysis },
      fr: { hardware: frHardware, analysis: frAnalysis },
    },
    interpolation: { escapeValue: false },
  })
  return instance
}

const BELL: Circuit = parseCircuit({
  schemaVersion: 1,
  qubits: 2,
  clbits: 2,
  operations: [
    { id: 'h', gate: 'h', targets: [0], column: 0 },
    { id: 'cx', gate: 'cx', targets: [1], controls: [0], column: 1 },
    { id: 'm0', gate: 'measure', targets: [0], clbitTargets: [0], column: 2 },
    { id: 'm1', gate: 'measure', targets: [1], clbitTargets: [1], column: 2 },
  ],
})

const COUNTS = { '00': 451, '11': 449, '01': 55, '10': 45 }
const TOTAL = 1000

const QASM = `OPENQASM 3.0;
include "stdgates.inc";

bit[2] c;
rz(1.5707963267948966) $53;
sx $53;
rz(1.5707963267948966) $53;
cz $53, $54;
rz(1.5707963267948966) $54;
sx $54;
rz(1.5707963267948966) $54;
c[0] = measure $53;
c[1] = measure $54;
`

function job(overrides: Partial<HardwareJob> = {}): HardwareJob {
  return {
    id: 'job_abc',
    circuitId: 'circ_abc',
    provider: 'ibm',
    backend: 'ibm_marrakesh',
    providerJobId: 'd0abc',
    shots: 1000,
    status: 'DONE',
    queuePosition: null,
    program: { qasm: QASM, layout: [53, 54], register: 'c', clbits: 2 },
    result: {
      backend: 'ibm_marrakesh',
      shots: 1000,
      counts: COUNTS,
      layout: [53, 54],
      calibratedAt: null,
      quantumSeconds: 2.5,
    },
    error: null,
    submittedAt: '2026-08-15T09:00:00.000Z',
    completedAt: '2026-08-15T09:41:00.000Z',
    ...overrides,
  } as HardwareJob
}

function idealState(): Statevector {
  const outcome = idealCircuitOf(BELL)
  if (!outcome.ok) throw new Error('the Bell pair has an ideal state')
  const result = run(outcome.circuit)
  if (result.mode !== 'analytic') {
    throw new Error('the default execution mode is analytic')
  }
  return result.state
}

/** A density reading built by hand, so the noisy column claims a known profile. */
function noisyReading(
  state: Statevector,
  distribution: Float64Array
): NoiseReading {
  const ideal: number[] = []
  for (let i = 0; i < state.size; i++) {
    const re = state.re[i] ?? 0
    const im = state.im[i] ?? 0
    ideal.push(re * re + im * im)
  }
  let f = 0
  let tv = 0
  for (let i = 0; i < ideal.length; i++) {
    f += Math.sqrt((ideal[i] ?? 0) * (distribution[i] ?? 0))
    tv += Math.abs((ideal[i] ?? 0) - (distribution[i] ?? 0))
  }
  return {
    method: 'density',
    distribution,
    counts: null,
    shots: null,
    distributionFidelity: f * f,
    totalVariation: tv / 2,
    stateFidelity: 0.94,
    purity: 0.9,
    density: null,
  }
}

function renderRun(language: Language) {
  const state = idealState()
  const noisy = new Float64Array([0.47, 0.02, 0.02, 0.49])
  const reading = noisyReading(state, noisy)
  const comparison = buildNoiseComparison(state, reading)
  const instance = i18nFor(language)

  render(
    <I18nextProvider i18n={instance}>
      <HardwareResultView
        job={job()}
        circuit={BELL}
        state={state}
        noise={comparison}
        noisyDistribution={noisy}
      />
    </I18nextProvider>
  )
  return { state, noisy }
}

afterEach(cleanup)

describe('a stored run renders from the row alone', () => {
  beforeEach(() => {
    // If anything on this page reaches the network, the demonstration is
    // gambling on a provider being up. Nothing may.
    vi.stubGlobal(
      'fetch',
      vi.fn(() => {
        throw new Error('the stored path reached the network')
      })
    )
  })

  it('draws three readings on one chart, with the device counts as given', () => {
    renderRun('en')

    // The device's share of each outcome, computed here from the raw counts.
    const shares = {
      '00': 451 / TOTAL,
      '11': 449 / TOTAL,
      remainder: (55 + 45) / TOTAL,
    }

    const table = screen.getByRole('table', {
      name: /outcome by outcome|state|reading/i,
    })
    const rows = within(table).getAllByRole('row')
    // header + |00⟩ + |11⟩ + remainder
    expect(rows).toHaveLength(4)

    const zeroRow = rows[1] as HTMLElement
    const cells = within(zeroRow).getAllByRole('cell')
    // ideal, noisy, noisy delta, real, real delta, phase
    expect(cells).toHaveLength(6)
    expect(cells[0]?.textContent).toBe('50%')
    expect(cells[1]?.textContent).toBe('47%')
    expect(cells[3]?.textContent).toBe(
      new Intl.NumberFormat('en', {
        style: 'percent',
        maximumFractionDigits: 2,
      }).format(shares['00'])
    )
  })

  it('prints the device fidelity the formula gives', () => {
    const { state } = renderRun('en')
    const real = [451, 55, 45, 449].map((count) => count / TOTAL)
    // distributionFromCounts maps c[0]=q0, c[1]=q1 → index order 00,01,10,11.
    let sum = 0
    for (let i = 0; i < 4; i++) {
      const re = state.re[i] ?? 0
      const im = state.im[i] ?? 0
      sum += Math.sqrt((re * re + im * im) * (real[i] ?? 0))
    }
    const expected = sum * sum
    const printed = new Intl.NumberFormat('en', {
      minimumFractionDigits: 4,
      maximumFractionDigits: 4,
    }).format(Math.round(expected * 1e4) / 1e4)
    expect(screen.getByText(printed)).toBeTruthy()
  })

  it('says nothing in a raw key, in any of the three languages', () => {
    for (const language of ['en', 'es', 'fr'] as const) {
      cleanup()
      renderRun(language)
      const text = document.body.textContent ?? ''
      expect(text).not.toMatch(
        /\b(comparison|program|device|job|status)\.[a-z]/i
      )
      expect(text.length).toBeGreaterThan(200)
    }
  })

  it('writes its numbers the way each language writes them', () => {
    cleanup()
    renderRun('fr')
    // French: decimal comma and a narrow no-break space before the percent.
    const text = document.body.textContent ?? ''
    expect(text).toMatch(/45,1/)
    expect(text).not.toMatch(/45\.1\s?%/)
  })

  it('counts the executed program from the stored text, not from a re-run', () => {
    renderRun('en')
    /*
     * Counted here by reading QASM above by hand: 4 rz + 2 sx + 1 cz = 7 gate
     * calls and 2 measurements, against a drawn h + cx = 2. The growth sentence
     * has to be those two numbers and their ratio, and nothing else.
     */
    const text = (document.body.textContent ?? '').replace(/\s+/g, ' ')
    expect(text).toMatch(/2 drawn gates became 7 on the device\. 3\.5× as many/)
    // And the cost groups have to sum to the executed total.
    expect(text).toMatch(/Frame changes4Pulses2Entangling1Other0/)
  })
})
