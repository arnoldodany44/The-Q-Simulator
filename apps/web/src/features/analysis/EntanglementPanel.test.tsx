/**
 * The entanglement metrics, as a reader meets them.
 *
 * The milestone's brief is that a bare number teaches nobody anything, so every
 * assertion below is about the *sentence* beside the number as much as the
 * number: "entropy 1 means this qubit alone has no state of its own" is a fact
 * a reader can use, and "1,0000" is not.
 *
 * The other property is the one §3.2 asks for two metrics to show. GHZ₃ has
 * every qubit at entropy 1 and every pair at concurrence 0, and a panel that
 * printed only entropies would call it the same state as W₃.
 */

import { run, type Statevector } from '@qsim/core'
import { parseCircuit, type CircuitInput } from '@qsim/schema'
import { cleanup, render, screen } from '@testing-library/react'
import { createInstance, type i18n as I18n } from 'i18next'
import { I18nextProvider, initReactI18next } from 'react-i18next'
import { afterEach, describe, expect, it } from 'vitest'

import enAnalysis from '../../i18n/locales/en/analysis.json'
import esAnalysis from '../../i18n/locales/es/analysis.json'
import frAnalysis from '../../i18n/locales/fr/analysis.json'
import { EntanglementPanel } from './EntanglementPanel'
import { MAX_CONCURRENCE_QUBITS } from './entanglement'

type Language = 'en' | 'es' | 'fr'

const CATALOGS: Record<Language, typeof enAnalysis> = {
  en: enAnalysis,
  es: esAnalysis,
  fr: frAnalysis,
}

function i18nFor(language: Language): I18n {
  const instance = createInstance()
  void instance.use(initReactI18next).init({
    lng: language,
    fallbackLng: 'en',
    ns: ['analysis'],
    defaultNS: 'analysis',
    resources: {
      en: { analysis: enAnalysis },
      es: { analysis: esAnalysis },
      fr: { analysis: frAnalysis },
    },
    interpolation: { escapeValue: false },
    react: { useSuspense: false },
  })
  return instance
}

function stateOf(input: CircuitInput): Statevector {
  const result = run(parseCircuit(input))
  if (result.mode !== 'analytic') throw new Error('expected an analytic run')
  return result.state
}

function ghz(qubits: number): Statevector {
  return stateOf({
    schemaVersion: 1,
    qubits,
    operations: [
      { id: 'h', gate: 'h', targets: [0], column: 0 },
      ...Array.from({ length: qubits - 1 }, (_unused, index) => ({
        id: `cx${index}`,
        gate: 'x',
        targets: [index + 1],
        controls: [index],
        column: index + 1,
      })),
    ],
  })
}

function product(qubits: number): Statevector {
  return stateOf({
    schemaVersion: 1,
    qubits,
    operations: Array.from({ length: qubits }, (_unused, wire) => ({
      id: `h${wire}`,
      gate: 'h',
      targets: [wire],
      column: 0,
    })),
  })
}

function draw(state: Statevector, language: Language = 'en') {
  return render(
    <I18nextProvider i18n={i18nFor(language)}>
      <EntanglementPanel state={state} />
    </I18nextProvider>
  )
}

function readings(view: ReturnType<typeof draw>): string[] {
  return [...view.container.querySelectorAll('.entanglement__reading')].map(
    (node) => node.textContent ?? ''
  )
}

afterEach(cleanup)

describe('a number and a sentence, never a number alone', () => {
  it('says a Bell half has no state of its own', () => {
    // The brief's own example. The number is 1,0000 and the sentence is what
    // makes it teach.
    const view = draw(ghz(2))
    const numbers = [
      ...view.container.querySelectorAll('.entanglement__number'),
    ].map((node) => node.textContent)
    expect(numbers.slice(0, 2)).toEqual(['1.0000', '1.0000'])
    for (const reading of readings(view).slice(0, 2)) {
      expect(reading).toBe(CATALOGS.en.entanglement.entropy.reading.none)
    }
  })

  it('says a product state’s qubits each have a state of their own', () => {
    const view = draw(product(2))
    expect(readings(view).slice(0, 2)).toEqual([
      CATALOGS.en.entanglement.entropy.reading.own,
      CATALOGS.en.entanglement.entropy.reading.own,
    ])
  })

  it('never prints a reading that contradicts the digits beside it', () => {
    // The threshold is half of the last printed digit (`entanglement.ts`), so
    // a row reading 1,0000 beside "partly entangled" is impossible by
    // construction rather than by luck.
    const view = draw(ghz(3))
    const rows = [...view.container.querySelectorAll('.entanglement__row')]
    for (const row of rows) {
      const value = row.querySelector('.entanglement__number')?.textContent
      const reading = row.querySelector('.entanglement__reading')?.textContent
      if (value === '1.0000') {
        expect([
          CATALOGS.en.entanglement.entropy.reading.none,
          CATALOGS.en.entanglement.pairs.reading.maximal,
        ]).toContain(reading)
      }
      if (value === '0.0000') {
        expect([
          CATALOGS.en.entanglement.entropy.reading.own,
          CATALOGS.en.entanglement.pairs.reading.separable,
        ]).toContain(reading)
      }
    }
  })
})

describe('two metrics, because one is not enough', () => {
  it('shows GHZ₃ as entangled qubits that share nothing pairwise', () => {
    const view = draw(ghz(3))
    // Three qubits, all with no state of their own…
    expect(
      readings(view).filter(
        (text) => text === CATALOGS.en.entanglement.entropy.reading.none
      )
    ).toHaveLength(3)
    // …and three pairs, none of which shares anything.
    expect(
      readings(view).filter(
        (text) => text === CATALOGS.en.entanglement.pairs.reading.separable
      )
    ).toHaveLength(3)
    // Which looks like a contradiction, so the panel explains it.
    expect(screen.getByText(CATALOGS.en.entanglement.shared.none)).toBeTruthy()
  })

  it('does not explain a contradiction there is none of', () => {
    const view = draw(ghz(2))
    expect(view.container.textContent).not.toContain(
      CATALOGS.en.entanglement.shared.none
    )
  })

  it('lists every pair of a register', () => {
    const view = draw(product(4))
    const pairRows = [
      ...view.container.querySelectorAll('.entanglement__name'),
    ].filter((node) => (node.textContent ?? '').includes('·'))
    expect(pairRows).toHaveLength(6)
  })
})

describe('the pair table’s ceiling', () => {
  it('says which limit it hit rather than thinning the table', () => {
    const wide = product(MAX_CONCURRENCE_QUBITS + 1)
    const view = draw(wide)
    const expected = CATALOGS.en.entanglement.pairs.tooWide
      .replace('{{qubits}}', String(MAX_CONCURRENCE_QUBITS + 1))
      .replace('{{limit}}', String(MAX_CONCURRENCE_QUBITS))
    expect(screen.getByText(expected)).toBeTruthy()

    // And the entropies are still there: `qubitEntropy` has no such ceiling,
    // which is the engine's own split and the reason for this one's shape.
    expect(view.container.querySelectorAll('.entanglement__row')).toHaveLength(
      MAX_CONCURRENCE_QUBITS + 1
    )
  })

  it('says a single qubit has no pair rather than showing an empty table', () => {
    draw(product(1))
    expect(screen.getByText(CATALOGS.en.entanglement.pairs.single)).toBeTruthy()
  })
})

describe('three languages', () => {
  it.each(['en', 'es', 'fr'] as const)(
    'renders words, not keys, in %s',
    (language) => {
      const view = draw(ghz(3), language)
      expect(view.container.textContent).not.toMatch(/entanglement\.[a-z]/u)
      expect(view.container.textContent).toContain(
        CATALOGS[language].entanglement.heading
      )
    }
  )
})
