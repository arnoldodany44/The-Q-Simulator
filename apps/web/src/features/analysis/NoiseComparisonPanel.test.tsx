/**
 * §3.3's comparison, as a reader meets it.
 *
 * The property the milestone turns on is that this is **one chart**. Two
 * adjacent histograms would show two sets of lengths and leave the reader
 * subtracting them across a gap; what §3.3 asks for is which outcomes gained
 * probability and which lost it, and that is a quantity neither chart states.
 * So the assertions below are about the difference being *on screen*: as a
 * signed number in a visible table, as a mark on the track the bar already
 * occupies, and as a sentence naming the biggest mover.
 *
 * The table being visible is the second property. A bar's length is something a
 * sighted reader can compare, which is what lets the histogram's own table be
 * `visually-hidden`; a two-pixel sliver between a bar's end and a tick is not,
 * so with an overlay the numbers become the rendering — the Bloch panel's
 * argument, applied to the one case where this chart is in the Bloch panel's
 * position.
 */

import { run, type Statevector } from '@qsim/core'
import { parseCircuit, type CircuitInput } from '@qsim/schema'
import { cleanup, render, screen, within } from '@testing-library/react'
import { createInstance, type i18n as I18n } from 'i18next'
import { I18nextProvider, initReactI18next } from 'react-i18next'
import { afterEach, describe, expect, it } from 'vitest'

import enAnalysis from '../../i18n/locales/en/analysis.json'
import esAnalysis from '../../i18n/locales/es/analysis.json'
import frAnalysis from '../../i18n/locales/fr/analysis.json'
import type { NoiseReading } from '../simulation/protocol'
import { NoiseComparisonPanel } from './NoiseComparisonPanel'

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

function bell(): Statevector {
  const result = run(
    parseCircuit({
      schemaVersion: 1,
      qubits: 2,
      operations: [
        { id: 'h', gate: 'h', targets: [0], column: 0 },
        { id: 'cx', gate: 'x', targets: [1], controls: [0], column: 1 },
      ],
    } satisfies CircuitInput)
  )
  if (result.mode !== 'analytic') throw new Error('expected an analytic run')
  return result.state
}

function exact(distribution: number[]): NoiseReading {
  return {
    method: 'density',
    distribution: Float64Array.from(distribution),
    counts: null,
    shots: null,
    distributionFidelity: 0.94,
    totalVariation: 0.1,
    stateFidelity: 0.88,
    purity: 0.82,
    density: null,
  }
}

function draw(reading: NoiseReading, language: Language = 'en') {
  return render(
    <I18nextProvider i18n={i18nFor(language)}>
      <NoiseComparisonPanel state={bell()} reading={reading} />
    </I18nextProvider>
  )
}

afterEach(cleanup)

describe('one chart, not two', () => {
  it('draws exactly one histogram', () => {
    const view = draw(exact([0.4, 0.05, 0.05, 0.5]))
    expect(view.container.querySelectorAll('.histogram')).toHaveLength(1)
    expect(view.container.querySelectorAll('.histogram__plot')).toHaveLength(1)
  })

  it('marks the second reading on the same track as the bar', () => {
    // The mark is what turns two lengths into a gap. One per drawn row, on the
    // row the bar is on — not on a second axis somewhere below it.
    const view = draw(exact([0.4, 0.05, 0.05, 0.5]))
    const rows = view.container.querySelectorAll('.histogram__row')
    expect(rows.length).toBeGreaterThan(0)
    for (const row of rows) {
      expect(row.querySelector('.histogram__second')).not.toBeNull()
    }
  })

  it('draws a loss inside the bar and a gain outside it', () => {
    /*
     * The primary encoding, and the one that survives with no colour vision at
     * all: a sliver that starts where the bar ends is probability arriving, and
     * one that ends where the bar ends is probability leaving. The x of the
     * rectangle is what says which.
     */
    const view = draw(exact([0.4, 0.05, 0.05, 0.6]))
    const moves = [...view.container.querySelectorAll('.histogram__move')]
    const loss = moves.find((node) =>
      node.classList.contains('histogram__delta--loss')
    )
    const gain = moves.find((node) =>
      node.classList.contains('histogram__delta--gain')
    )
    expect(loss).toBeDefined()
    expect(gain).toBeDefined()

    // |00⟩ fell from ½ to 0.4, so its sliver spans 0.4…0.5 of the track.
    const trackX = Number(
      view.container.querySelector('.histogram__track')?.getAttribute('x')
    )
    const width = Number(
      view.container.querySelector('.histogram__track')?.getAttribute('width')
    )
    expect(Number(loss!.getAttribute('x'))).toBeCloseTo(trackX + 0.4 * width, 6)
    expect(Number(loss!.getAttribute('width'))).toBeCloseTo(0.1 * width, 6)
  })

  it('prints the difference as a signed number', () => {
    // Third carrier, after the side of the bar and before the hue: the sign is
    // explicit, so `+` and `−` say the direction without any colour at all.
    const view = draw(exact([0.4, 0.05, 0.05, 0.5]))
    const deltas = [
      ...view.container.querySelectorAll('.histogram__delta'),
    ].map((node) => node.textContent)
    expect(
      deltas.some((text) => text?.startsWith('-') || text?.startsWith('−'))
    ).toBe(true)
  })
})

describe('the table', () => {
  it('is visible, with the two extra columns', () => {
    // Visible because a sliver is not a length anyone can measure by eye. The
    // wrapper is a scroller rather than `.visually-hidden`.
    const view = draw(exact([0.4, 0.05, 0.05, 0.5]))
    const table = view.container.querySelector('.histogram__table')
    expect(table).not.toBeNull()
    expect(table?.closest('.visually-hidden')).toBeNull()

    const headers = within(table as HTMLElement)
      .getAllByRole('columnheader')
      .map((cell) => cell.textContent)
    expect(headers).toContain(CATALOGS.en.noise.comparison.column.noisy)
    expect(headers).toContain(CATALOGS.en.noise.comparison.column.difference)
  })

  it('lists the same rows the chart draws, and the remainder with them', () => {
    const view = draw(exact([0.45, 0.05, 0.05, 0.45]))
    const rows = view.container.querySelectorAll(
      '.histogram__table tbody .histogram__table-row'
    )
    // Two bars, plus the remainder that carries the probability the noise put
    // where the circuit put none.
    expect(rows).toHaveLength(3)
  })
})

describe('the numbers beside it', () => {
  it('names all four for the exact method', () => {
    draw(exact([0.4, 0.05, 0.05, 0.5]))
    for (const term of [
      CATALOGS.en.noise.comparison.fidelity,
      CATALOGS.en.noise.comparison.moved,
      CATALOGS.en.noise.comparison.stateFidelity,
      CATALOGS.en.noise.comparison.purity,
    ]) {
      expect(screen.getByText(term)).toBeTruthy()
    }
    expect(
      screen.getByText(CATALOGS.en.noise.comparison.ranDensity)
    ).toBeTruthy()
  })

  it('omits the two a sampled run cannot answer, and prints its own error', () => {
    // A fidelity read to four digits off ten thousand shots would be four
    // digits of shot noise, so the panel says how big that noise is instead of
    // letting a reader assume there is none.
    draw({
      method: 'trajectories',
      distribution: null,
      counts: { '00': 480, '11': 520 },
      shots: 1000,
      distributionFidelity: 0.99,
      totalVariation: 0.02,
      stateFidelity: null,
      purity: null,
      density: null,
    })
    expect(
      screen.queryByText(CATALOGS.en.noise.comparison.stateFidelity)
    ).toBeNull()
    expect(screen.queryByText(CATALOGS.en.noise.comparison.purity)).toBeNull()
    expect(screen.getByText(/1,000/u)).toBeTruthy()
  })
})

describe('the sentence', () => {
  it('names the biggest loser and the biggest winner', () => {
    draw(exact([0.3, 0, 0, 0.7]))
    const summary = document.querySelector('.noise-comparison__summary')
    expect(summary?.textContent).toContain('|00⟩')
    expect(summary?.textContent).toContain('|11⟩')
  })

  it('names the states not drawn in words rather than as an ellipsis', () => {
    // The remainder row has no ket, and an ellipsis in the middle of a
    // sentence would be a riddle.
    draw(exact([0.45, 0.05, 0.05, 0.45]))
    const summary = document.querySelector('.noise-comparison__summary')
    expect(summary?.textContent).toContain(
      CATALOGS.en.noise.comparison.movement.others
    )
  })

  it('says so plainly when nothing moved', () => {
    draw(exact([0.5, 0, 0, 0.5]))
    expect(
      screen.getByText(CATALOGS.en.noise.comparison.movement.none)
    ).toBeTruthy()
  })
})

describe('three languages', () => {
  it.each(['en', 'es', 'fr'] as const)(
    'renders words, not keys, in %s',
    (language) => {
      const view = draw(exact([0.4, 0.05, 0.05, 0.5]), language)
      const text = view.container.textContent ?? ''
      expect(text).not.toMatch(/noise\.comparison\./u)
      expect(text).toContain(CATALOGS[language].noise.comparison.heading)
    }
  )
})
