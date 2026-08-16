/**
 * Independent verification (lens: ui-truth-a11y) — when the comparison chart
 * cannot draw the whole distribution, does it say so?
 *
 * §3.2's third rule is not about tidiness: "un histograma que se guarda la mitad
 * de la distribución sin decirlo es una mentira dibujada". The comparison chart
 * of §3.3 is the same component with two things overridden — its heading and
 * *its caption* — and the caption is where §3.2 puts the disclosure. So the
 * question this file asks is whether the two facts the disclosure carries, how
 * many basis states are not drawn and how much probability they hold, are still
 * on screen once that caption has been replaced.
 *
 * The register is seven qubits, so 128 basis states carry probability against a
 * cap of 32 and the remainder is most of the distribution — the case where
 * losing the disclosure would matter most.
 *
 * Expected values are counted here off the amplitudes, not read from the model.
 */

import { NOISE_PROFILES, run, type Statevector } from '@qsim/core'
import { parseCircuit, type Circuit, type CircuitInput } from '@qsim/schema'
import { cleanup, render, screen, within } from '@testing-library/react'
import { createInstance, type i18n as I18n } from 'i18next'
import { I18nextProvider, initReactI18next } from 'react-i18next'
import { afterEach, describe, expect, it } from 'vitest'

import { NoiseComparisonPanel } from '../../features/analysis/NoiseComparisonPanel'
import { runNoiseJob } from '../../features/simulation/noiseJob'
import type { NoiseSpec } from '../../features/simulation/protocol'
import enAnalysis from '../../i18n/locales/en/analysis.json'

/** A Hadamard on every wire: 2⁷ = 128 basis states, all occupied. */
const CIRCUIT: CircuitInput = {
  schemaVersion: 1,
  qubits: 7,
  operations: Array.from({ length: 7 }, (_unused, qubit) => ({
    id: `h${qubit}`,
    gate: 'h' as const,
    targets: [qubit],
    column: 0,
  })),
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

function stateOf(circuit: Circuit): Statevector {
  const result = run(circuit)
  if (result.mode !== 'analytic') throw new Error('expected an analytic run')
  return result.state
}

afterEach(cleanup)

describe('the capped comparison chart', () => {
  const circuit = parseCircuit(CIRCUIT)
  const state = stateOf(circuit)
  const payload = runNoiseJob(circuit, state, SPEC)
  if (!payload.ok) throw new Error('the engine refused the run')
  const reading = payload.reading

  function draw() {
    return render(
      <I18nextProvider i18n={i18nFor()}>
        <NoiseComparisonPanel state={state} reading={reading} />
      </I18nextProvider>
    )
  }

  /** Occupied basis states, counted off the amplitudes at §3.2's floor. */
  const occupied = (() => {
    let count = 0
    for (let i = 0; i < state.size; i++) {
      const re = state.re[i] ?? 0
      const im = state.im[i] ?? 0
      if (re * re + im * im > 1e-12) count += 1
    }
    return count
  })()

  it('is really capped, so the rest of this file has something to check', () => {
    expect(occupied).toBe(128)
    const view = draw()
    const bars = view.container.querySelectorAll(
      '.noise-comparison .histogram__row'
    )
    // 32 drawn plus one remainder.
    expect(bars.length).toBe(33)
  })

  it('draws the aggregated remainder rather than dropping it', () => {
    const view = draw()
    const remainder = view.container.querySelector(
      '.noise-comparison .histogram__row--remainder'
    )
    expect(remainder).not.toBeNull()
    const fill = Number(
      remainder
        ?.querySelector('.histogram__fill--remainder')
        ?.getAttribute('width')
    )
    const track = Number(
      remainder?.querySelector('.histogram__track')?.getAttribute('width')
    )
    // 96 of 128 states are not drawn, and on a flat distribution they hold
    // 96/128 = 75 % of the probability. A remainder bar that lost that would
    // be drawing a quarter of a distribution as if it were the whole one.
    expect(fill / track).toBeCloseTo(96 / 128, 6)
  })

  it('says in words how many states it is not drawing', () => {
    // The count and the share, on screen, once the §3.2 caption has been
    // replaced by §3.3's own sentence. The visible table is where they land.
    const view = draw()
    const table = view.container.querySelector(
      '.noise-comparison .histogram__table'
    )
    expect(table).not.toBeNull()
    const rows = within(table as HTMLElement).getAllByRole('row')
    const last = rows[rows.length - 1]
    const header = within(last as HTMLElement).getByRole('rowheader')
    expect(header.textContent).toContain('96')

    const cells = within(last as HTMLElement)
      .getAllByRole('cell')
      .map((cell) => cell.textContent ?? '')
    // Ideal share of the hidden states: 75 %.
    expect(cells[0]).toBe('75%')
  })

  it('keeps the panel’s own headline about the whole distribution', () => {
    // The fidelity and the moved probability are computed over all 128 states
    // on the worker, not over the 32 rows — otherwise the number beside a
    // capped chart would describe a quarter of the run.
    draw()
    expect(reading.distributionFidelity).toBeLessThan(1)
    // Reconstructed from the rows alone, the fidelity would be much smaller,
    // because thirty-two of a hundred and twenty-eight terms is a quarter of
    // the Bhattacharyya sum. This is the assertion that says the headline is
    // not the chart's arithmetic.
    let partial = 0
    for (let i = 0; i < 32; i++) {
      partial += Math.sqrt((1 / 128) * (reading.distribution?.[i] ?? 0))
    }
    expect(reading.distributionFidelity).toBeGreaterThan(partial * partial * 2)
  })

  it('never lets the chart’s summary claim the whole distribution is drawn', () => {
    const view = draw()
    const disclosure = view.container.querySelector(
      '.noise-comparison .histogram__disclosure'
    )
    expect(disclosure?.textContent).toBe(
      enAnalysis.noise.comparison.chart.summary
    )
    // The replaced sentence must not assert completeness. It describes what a
    // bar, a tick and a sliver mean, and says nothing about coverage — which is
    // why the table above has to carry the count.
    expect(disclosure?.textContent ?? '').not.toMatch(/every|all of|complete/iu)
    expect(screen.queryByText(/basis states have a non-zero/u)).toBeNull()
  })
})
