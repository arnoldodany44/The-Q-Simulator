import { cleanup, render, screen } from '@testing-library/react'
import { createInstance, type i18n as I18n } from 'i18next'
import { I18nextProvider, initReactI18next } from 'react-i18next'
import { MemoryRouter } from 'react-router'
import { afterEach, describe, expect, it } from 'vitest'

import enAnalysis from '../i18n/locales/en/analysis.json'
import enCommon from '../i18n/locales/en/common.json'
import enLanding from '../i18n/locales/en/landing.json'
import esAnalysis from '../i18n/locales/es/analysis.json'
import esCommon from '../i18n/locales/es/common.json'
import esLanding from '../i18n/locales/es/landing.json'
import frAnalysis from '../i18n/locales/fr/analysis.json'
import frCommon from '../i18n/locales/fr/common.json'
import frLanding from '../i18n/locales/fr/landing.json'
import { LandingRoute } from './landing'

/**
 * The page around the demonstration.
 *
 * `LiveDemo.test.tsx` owns the physics and the stage sequence, so what is left
 * here is the frame: that the page really is a page in all three languages —
 * one h1, a heading per section, every string resolved — and that both ways
 * onwards exist and point somewhere different. The copy on this page is the
 * most visible text in the product, and a key that never made it into a
 * catalog renders as its own identifier, which looks like nothing at all until
 * somebody screenshots it.
 */

type Language = 'en' | 'es' | 'fr'

const CATALOGS = {
  en: { analysis: enAnalysis, common: enCommon, landing: enLanding },
  es: { analysis: esAnalysis, common: esCommon, landing: esLanding },
  fr: { analysis: frAnalysis, common: frCommon, landing: frLanding },
} as const

function i18nFor(language: Language): I18n {
  const instance = createInstance()
  void instance.use(initReactI18next).init({
    lng: language,
    fallbackLng: 'en',
    ns: ['analysis', 'common', 'landing'],
    defaultNS: 'common',
    resources: CATALOGS,
    interpolation: { escapeValue: false },
    react: { useSuspense: false },
  })
  return instance
}

function open(language: Language = 'en') {
  return render(
    <I18nextProvider i18n={i18nFor(language)}>
      <MemoryRouter initialEntries={['/']}>
        <LandingRoute />
      </MemoryRouter>
    </I18nextProvider>
  )
}

afterEach(cleanup)

describe('the landing page', () => {
  it('has one top-level heading and a heading for each section', () => {
    open()

    expect(screen.getAllByRole('heading', { level: 1 })).toHaveLength(1)
    // The demonstration and the notes: two sections, each named, so the page
    // can be navigated by heading rather than by scrolling.
    expect(screen.getAllByRole('heading', { level: 2 })).toHaveLength(2)
  })

  it('leads to a blank editor and to an example, and they differ', () => {
    open()

    const blank = screen.getAllByRole('link', { name: enLanding.cta.editor })
    const example = screen.getAllByRole('link', {
      name: enLanding.cta.examples,
    })

    expect(blank[0]?.getAttribute('href')).toBe('/new')
    expect(example[0]?.getAttribute('href')).toBe('/new?example=bell')
  })

  it('states the three things worth knowing about the product', () => {
    open()

    for (const note of ['local', 'link', 'state'] as const) {
      expect(screen.getByText(enLanding.notes[note].title)).toBeDefined()
      expect(screen.getByText(enLanding.notes[note].body)).toBeDefined()
    }
  })

  /*
   * D2, on the page D2 matters most. Nothing here checks the wording — the
   * parity test does that — only that every key resolved and that the page
   * really is in the language it was asked for.
   */
  it.each(['en', 'es', 'fr'] as const)('renders in "%s"', (language) => {
    const { container } = open(language)
    const text = container.textContent ?? ''

    expect(text).toContain(CATALOGS[language].landing.tagline)
    expect(text).toContain(CATALOGS[language].landing.lead)
    expect(text).toContain(CATALOGS[language].landing.closing)
    // An unresolved key renders as the key: `landing:` and a dotted path.
    expect(text).not.toContain('landing:')
    expect(text).not.toContain('notes.')
  })
})
