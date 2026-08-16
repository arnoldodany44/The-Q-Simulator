/**
 * Independent verification (lens: ui-truth-a11y) — is every ket on the noise
 * panel marked as notation?
 *
 * D2 gives `components/Notation.tsx` as the one sanctioned route for text that
 * is identical in every language, and that component's own header says why the
 * marking is not decorative: `translate="no"` is what stops a browser-level
 * page translator from rewriting it. Every other ket in the analysis panel goes
 * through it — the histogram's labels, the amplitude table's rows, the
 * Q-sphere's rows, the shot sampler's rows, the density map's rows.
 *
 * The comparison's summary sentence interpolates a ket into a *translated*
 * string instead, so the ket lands in a bare paragraph. The consequence is the
 * one `Notation.tsx` names: nothing in the DOM tells Chrome's auto-translate to
 * leave `|011⟩` alone, in the one sentence on the panel that names a specific
 * outcome.
 *
 * FIXED, AND KEPT AS A REGRESSION TEST. The summary's notation arguments are
 * interpolated fenced and the finished sentence is split back apart on the
 * fence, so each ket is its own `Notation` span and the translator's prose is
 * left as prose. Kept because nothing else in the toolchain can see this:
 * `i18next/no-literal-string` sees a `t()` call and asks no more, and the
 * sentence rendered correctly in all three languages the whole time it was
 * unmarked.
 */

import { NOISE_PROFILES, run, type Statevector } from '@qsim/core'
import { parseCircuit, type Circuit, type CircuitInput } from '@qsim/schema'
import { cleanup, render } from '@testing-library/react'
import { createInstance, type i18n as I18n } from 'i18next'
import { I18nextProvider, initReactI18next } from 'react-i18next'
import { afterEach, describe, expect, it } from 'vitest'

import { NoiseComparisonPanel } from '../../features/analysis/NoiseComparisonPanel'
import { runNoiseJob } from '../../features/simulation/noiseJob'
import type { NoiseSpec } from '../../features/simulation/protocol'
import enAnalysis from '../../i18n/locales/en/analysis.json'

const CIRCUIT: CircuitInput = {
  schemaVersion: 1,
  qubits: 3,
  operations: [
    { id: 'a', gate: 'h', targets: [0], column: 0 },
    { id: 'b', gate: 'cx', targets: [1], controls: [0], column: 1 },
    { id: 'c', gate: 'x', targets: [2], column: 2 },
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

function stateOf(circuit: Circuit): Statevector {
  const result = run(circuit)
  if (result.mode !== 'analytic') throw new Error('expected an analytic run')
  return result.state
}

afterEach(cleanup)

describe('every ket is marked as notation', () => {
  const circuit = parseCircuit(CIRCUIT)
  const state = stateOf(circuit)

  it('marks the ket in the summary sentence too', () => {
    const payload = runNoiseJob(circuit, state, SPEC)
    if (!payload.ok) throw new Error('the engine refused the run')

    const view = render(
      <I18nextProvider i18n={i18nFor()}>
        <NoiseComparisonPanel state={state} reading={payload.reading} />
      </I18nextProvider>
    )

    const summary = view.container.querySelector('.noise-comparison__summary')
    expect(summary).not.toBeNull()
    // The sentence really does name an outcome, so there is something to mark.
    expect(summary?.textContent ?? '').toMatch(/[|｜]\d+⟩/u)

    // Every ket in it sits inside an element the page translator is told to
    // leave alone.
    const marked = [...(summary?.querySelectorAll('[translate="no"]') ?? [])]
      .map((node) => node.textContent ?? '')
      .join(' ')
    const kets = (summary?.textContent ?? '').match(/[|｜]\d+⟩/gu) ?? []
    for (const ket of kets) {
      expect(marked, `${ket} is notation and is not marked as such`).toContain(
        ket
      )
    }
  })
})
