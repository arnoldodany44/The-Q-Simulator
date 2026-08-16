/**
 * The density heat map, as a reader meets it.
 *
 * The picture is `aria-hidden` and the table beside it is the rendering — the
 * Bloch panel's decision, taken here for the same reason: a cell's colour and
 * opacity are not a length anyone can compare by eye. So the assertions are
 * that the numbers are visible, that the cap is stated, and that the two grids
 * really are two.
 *
 * The one drawn property worth pinning is the encoding, because it is the place
 * where a sign becomes a colour: a positive real part is phase 0 and a negative
 * one is phase π (§10's mapping, once, for everything). Painting a coherence as
 * its own negation would be exactly wrong and would look exactly right.
 */

import { cleanup, render, screen } from '@testing-library/react'
import { createInstance, type i18n as I18n } from 'i18next'
import { I18nextProvider, initReactI18next } from 'react-i18next'
import { afterEach, describe, expect, it } from 'vitest'

import enAnalysis from '../../i18n/locales/en/analysis.json'
import esAnalysis from '../../i18n/locales/es/analysis.json'
import frAnalysis from '../../i18n/locales/fr/analysis.json'
import { phaseToColour } from '../../lib/phase-colour'
import type { DensityBlock } from '../simulation/protocol'
import { DensityHeatmap } from './DensityHeatmap'

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

function blockOf(
  labels: string[],
  entries: [number, number][],
  patch: Partial<DensityBlock> = {}
): DensityBlock {
  return {
    indices: labels.map((_unused, index) => index),
    labels,
    re: Float64Array.from(entries.map(([re]) => re)),
    im: Float64Array.from(entries.map(([, im]) => im)),
    hidden: 0,
    hiddenPopulation: 0,
    limit: 16,
    ...patch,
  }
}

/** ρ of a Bell pair: ½ in all four entries, all real. */
function bellBlock(patch: Partial<DensityBlock> = {}): DensityBlock {
  return blockOf(
    ['00', '11'],
    [
      [0.5, 0],
      [0.5, 0],
      [0.5, 0],
      [0.5, 0],
    ],
    patch
  )
}

function draw(block: DensityBlock, language: Language = 'en') {
  return render(
    <I18nextProvider i18n={i18nFor(language)}>
      <DensityHeatmap block={block} />
    </I18nextProvider>
  )
}

afterEach(cleanup)

describe('the two grids', () => {
  it('draws the real part and the imaginary part separately', () => {
    const view = draw(bellBlock())
    expect(view.container.querySelectorAll('.density__plot')).toHaveLength(2)
    expect(screen.getByText(CATALOGS.en.density.part.real)).toBeTruthy()
    expect(screen.getByText(CATALOGS.en.density.part.imaginary)).toBeTruthy()
  })

  it('hides them from a screen reader, because the table is the rendering', () => {
    const view = draw(bellBlock())
    for (const plot of view.container.querySelectorAll('.density__plot')) {
      expect(plot.getAttribute('aria-hidden')).toBe('true')
    }
  })

  it('paints a positive entry and a negative one as opposite phases', () => {
    /*
     * §10's mapping, once: colour is phase, so a positive real part is phase 0
     * and a negative one is phase π — which is also what the phasors already
     * taught, so "opposite colours cancel" stays a true statement about the
     * physics rather than a convention of this panel.
     */
    const view = draw(
      blockOf(
        ['0', '1'],
        [
          [0.5, 0],
          [-0.5, 0],
          [-0.5, 0],
          [0.5, 0],
        ]
      )
    )
    const cells = [
      ...view.container
        .querySelectorAll('.density__plot')[0]!
        .querySelectorAll('.density__cell'),
    ]
    expect(cells[0]?.getAttribute('fill')).toBe(phaseToColour(0))
    expect(cells[1]?.getAttribute('fill')).toBe(phaseToColour(Math.PI))
  })

  it('fades a cell to nothing rather than painting a coherence that is absent', () => {
    const view = draw(
      blockOf(
        ['0', '1'],
        [
          [1, 0],
          [0, 0],
          [0, 0],
          [0, 0],
        ]
      )
    )
    const cells = [
      ...view.container
        .querySelectorAll('.density__plot')[0]!
        .querySelectorAll('.density__cell'),
    ]
    expect(Number(cells[0]?.getAttribute('fill-opacity'))).toBe(1)
    expect(Number(cells[1]?.getAttribute('fill-opacity'))).toBe(0)
  })
})

describe('the table', () => {
  it('is visible and lists one row per entry above the floor', () => {
    const view = draw(bellBlock())
    const table = view.container.querySelector('.density__grid-table')
    expect(table).not.toBeNull()
    expect(table?.closest('.visually-hidden')).toBeNull()
    expect(view.container.querySelectorAll('.density__row')).toHaveLength(4)
  })

  it('says which entries are populations and which are coherences', () => {
    // The distinction the picture exists for: the diagonal is the histogram,
    // and everything off it is what a superposition is made of.
    const view = draw(bellBlock())
    const kinds = [...view.container.querySelectorAll('.density__kind')].map(
      (node) => node.textContent
    )
    expect(
      kinds.filter((kind) => kind === CATALOGS.en.density.table.population)
    ).toHaveLength(2)
    expect(
      kinds.filter((kind) => kind === CATALOGS.en.density.table.coherence)
    ).toHaveLength(2)
  })

  it('names the two basis states an off-diagonal entry connects', () => {
    const view = draw(bellBlock())
    const states = [...view.container.querySelectorAll('.density__state')].map(
      (node) => node.textContent
    )
    expect(states).toContain('|00⟩')
    expect(states).toContain('|11⟩')
  })
})

describe('the cap and the scale', () => {
  it('states what the block left out, the way the histogram does', () => {
    const view = draw(bellBlock({ hidden: 14, hiddenPopulation: 0.25 }))
    const expected = CATALOGS.en.density.caption.capped_other
      .replace('{{shown}}', '2')
      .replace('{{hidden}}', '14')
      .replace('{{share}}', '25%')
    expect(view.container.textContent).toContain(expected)
  })

  it('prints the peak the opacity is measured against', () => {
    // The map is scaled to the block's own largest entry, so the scale is never
    // something a reader has to infer from a uniformly pale square.
    const view = draw(bellBlock())
    expect(view.container.textContent).toContain(
      CATALOGS.en.density.scale.replace('{{peak}}', '0.5000')
    )
  })

  it('says so rather than drawing an empty square for a ρ with no population', () => {
    const view = draw(blockOf([], []))
    expect(screen.getByText(CATALOGS.en.density.empty)).toBeTruthy()
    expect(view.container.querySelector('.density__plot')).toBeNull()
  })
})

describe('three languages', () => {
  it.each(['en', 'es', 'fr'] as const)(
    'renders words, not keys, in %s',
    (language) => {
      const view = draw(bellBlock(), language)
      expect(view.container.textContent).not.toMatch(/density\.[a-z]/u)
      expect(view.container.textContent).toContain(
        CATALOGS[language].density.heading
      )
    }
  )
})
