import { GATE_IDS } from '@qsim/schema'
import { cleanup, render, screen } from '@testing-library/react'
import { createInstance, type i18n as I18n } from 'i18next'
import { I18nextProvider, initReactI18next } from 'react-i18next'
import { afterEach, describe, expect, it } from 'vitest'

import enGates from '../../i18n/locales/en/gates.json'
import esGates from '../../i18n/locales/es/gates.json'
import frGates from '../../i18n/locales/fr/gates.json'
import { GATE_KEYS } from './gateCatalog'
import { GatePalette } from './GatePalette'

/**
 * The palette explains itself to somebody who has never seen a gate before.
 *
 * ── WHY THIS IS ASSERTED AGAINST THE CONTRACT AND NOT AGAINST A LIST ─────
 *
 * The catalogue is `GATE_IDS`, in `@qsim/schema`, and a gate is added there —
 * not here. So the coverage test iterates *that*, which is what makes it a
 * gate that cannot ship without a sentence: adding one to the contract turns
 * this file red in three languages at once, and the failure names the gate.
 * A hand-written list of the twenty-six would pass forever and mean nothing,
 * because nobody would remember to extend it.
 *
 * The sentence is a `title`, i.e. a description, and deliberately not the
 * button's accessible name. The name stays the symbol: a screen reader user
 * arrowing the palette wants "H, button", not a paragraph per chip, and
 * `aria-keyshortcuts` already tells them the key. The description is what is
 * offered on hover and on request.
 */

const CATALOGUES = { en: enGates, es: esGates, fr: frGates }
type Language = keyof typeof CATALOGUES

function i18nFor(language: Language): I18n {
  const instance = createInstance()
  void instance.use(initReactI18next).init({
    lng: language,
    fallbackLng: false,
    ns: ['gates'],
    defaultNS: 'gates',
    resources: {
      en: { gates: enGates },
      es: { gates: esGates },
      fr: { gates: frGates },
    },
    interpolation: { escapeValue: false },
    react: { useSuspense: false },
  })
  return instance
}

afterEach(cleanup)

describe('every gate in the catalogue explains itself', () => {
  for (const language of Object.keys(CATALOGUES) as Language[]) {
    it(`has a description for all ${String(GATE_IDS.length)} gates in ${language}`, () => {
      const described = CATALOGUES[language].description as Record<
        string,
        string | undefined
      >
      const missing = GATE_IDS.filter((id) => {
        const sentence = described[id]
        return sentence === undefined || sentence.trim() === ''
      })
      expect(missing, `gates with no ${language} description`).toEqual([])
    })
  }

  it('says something different about each gate', () => {
    // A copy-paste that left two gates with the same sentence would pass the
    // coverage test above and teach the reader something false.
    const sentences = GATE_IDS.map((id) => enGates.description[id])
    expect(new Set(sentences).size).toBe(GATE_IDS.length)
  })
})

describe('the palette carries the explanations to the reader', () => {
  it('puts the sentence on the chip, without changing its name', () => {
    render(
      <I18nextProvider i18n={i18nFor('en')}>
        <GatePalette armed={null} onArm={() => undefined} />
      </I18nextProvider>
    )

    // The Hadamard chip: named by its symbol, described by its sentence.
    const chip = screen.getByRole('button', { name: 'H' })
    expect(chip.getAttribute('title')).toBe(enGates.description.h)
    expect(chip.getAttribute('aria-keyshortcuts')).toBe(GATE_KEYS.h)
  })

  it('describes every chip it renders, in the reader’s language', () => {
    render(
      <I18nextProvider i18n={i18nFor('es')}>
        <GatePalette armed={null} onArm={() => undefined} />
      </I18nextProvider>
    )

    const spanish = esGates.description as Record<string, string | undefined>
    const chips = document.querySelectorAll<HTMLElement>('[data-gate]')
    expect(chips.length).toBe(GATE_IDS.length)
    const undescribed: string[] = []
    for (const chip of chips) {
      const id = chip.dataset.gate ?? ''
      // Not merely present — the *Spanish* one, so a chip falling back to the
      // English catalogue is a failure rather than a pass.
      if (chip.getAttribute('title') !== spanish[id]) {
        undescribed.push(id)
      }
    }
    expect(undescribed, 'chips without their Spanish sentence').toEqual([])
  })
})
