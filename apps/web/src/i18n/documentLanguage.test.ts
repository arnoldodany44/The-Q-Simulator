import { beforeEach, describe, expect, it, vi } from 'vitest'

import { LANGUAGE_STORAGE_KEY } from './index'

/**
 * `<html lang>` has to name the language actually on screen.
 *
 * It is the attribute a screen reader picks its speech synthesiser from, so
 * a Spanish or French interface left declared as English is read aloud with
 * English phonetics — a defect a sighted reviewer cannot see at all.
 *
 * This is the only guard that catches it. `locale-parity.test.ts` reads the
 * catalogs off disk and never renders a document, and Lighthouse's
 * `html-has-lang` / `html-lang-valid` audits pass on a well-formed value that
 * happens to be the wrong one — so the M0.7 "Lighthouse ≥ 95" criterion gives
 * no protection here either.
 *
 * Each case boots a fresh copy of the module graph. `initI18n` initialises
 * the i18next singleton, and re-initialising one instance three times over
 * would leave each case reading the previous case's detection.
 */

async function boot(stored?: string) {
  window.localStorage.clear()
  if (stored !== undefined)
    window.localStorage.setItem(LANGUAGE_STORAGE_KEY, stored)
  vi.resetModules()
  return import('./index')
}

/** The tag `index.html` ships, so a passing case proves it was rewritten. */
const SHIPPED_DESCRIPTION =
  'Build quantum circuits in your browser, watch the state evolve, and run them on real hardware.'

/**
 * Every tag `index.html` ships that carries a translated value, as
 * `[attribute, value]` pairs. Open Graph identifies its tags by `property`
 * and the other two by `name`, which is the whole reason this is a list.
 */
const SHIPPED_META: readonly (readonly [string, string])[] = [
  ['name', 'description'],
  ['property', 'og:description'],
  ['name', 'twitter:description'],
]

function contentOf(selector: string): string | null {
  return document.querySelector(selector)?.getAttribute('content') ?? null
}

function description(): string | null {
  return contentOf('meta[name="description"]')
}

beforeEach(() => {
  window.localStorage.clear()
  // The values index.html ships with: correct before boot, wrong after it for
  // two of the three languages. Every case starts from them, so a case that
  // passes proves the tag was written rather than merely left alone.
  document.documentElement.lang = 'en'
  document.head.innerHTML = ''
  for (const [attribute, value] of SHIPPED_META) {
    const meta = document.createElement('meta')
    meta.setAttribute(attribute, value)
    meta.setAttribute('content', SHIPPED_DESCRIPTION)
    document.head.appendChild(meta)
  }
  const locale = document.createElement('meta')
  locale.setAttribute('property', 'og:locale')
  // The pre-boot value `index.html` ships, in the format Open Graph defines.
  locale.setAttribute('content', 'en_US')
  document.head.appendChild(locale)
})

describe('the document language follows the interface language', () => {
  it('is set from the detected language before the first render', async () => {
    const { initI18n } = await boot('fr')

    await initI18n()

    expect(document.documentElement.lang).toBe('fr')
  })

  it('follows a switch through the picker', async () => {
    const { initI18n, changeLanguage } = await boot('en')
    await initI18n()

    await changeLanguage('es')

    expect(document.documentElement.lang).toBe('es')
  })

  it('narrows a regional tag to the catalog that is actually served', async () => {
    const { initI18n } = await boot('es-MX')

    await initI18n()

    // `es-MX` would declare a locale whose strings are not the ones on
    // screen: what was loaded, and what is rendered, is the `es` catalog.
    expect(document.documentElement.lang).toBe('es')
  })

  it('touches nothing when the module is only imported', async () => {
    await boot('fr')

    expect(document.documentElement.lang).toBe('en')
    expect(description()).toBe(SHIPPED_DESCRIPTION)
  })
})

/*
 * The description is the last user-facing string in the shipped HTML, and D2
 * covers it: it is what a bookmark, a link preview and a search result show.
 * It used to be English prose that no code ever read, so a Spanish or French
 * session shared a page describing itself in a language nobody had chosen.
 */
describe('the page description follows the interface language', () => {
  it('is rewritten from the catalog on boot', async () => {
    const { initI18n } = await boot('es')

    await initI18n()

    expect(description()).not.toBe(SHIPPED_DESCRIPTION)
    expect(description()).toContain('circuitos cuánticos')
  })

  it('follows a switch through the picker', async () => {
    const { initI18n, changeLanguage } = await boot('en')
    await initI18n()
    expect(description()).toBe(SHIPPED_DESCRIPTION)

    await changeLanguage('fr')

    expect(description()).toContain('circuits quantiques')
  })
})

/*
 * The link preview, added in M0.9b. A shared landing page is the most visible
 * thing this product has, and a card is three tags carrying one sentence: if
 * only the `description` were rewritten, a French reader sharing the page
 * would hand their contacts an English card — the exact defect the
 * `description` had before M0.7 fixed it, wearing two new names.
 */
describe('the link preview follows the interface language', () => {
  it('rewrites both social descriptions alongside the plain one', async () => {
    const { initI18n } = await boot('fr')

    await initI18n()

    const expected = description()
    expect(expected).toContain('circuits quantiques')
    expect(contentOf('meta[property="og:description"]')).toBe(expected)
    expect(contentOf('meta[name="twitter:description"]')).toBe(expected)
  })

  /*
   * `og:locale` is a different specification from `<html lang>` and takes a
   * different value: ogp.me defines it as `language_TERRITORY` and says the
   * default is `en_US`, so a consumer handed a bare `fr` does not recognise it
   * and falls back — announcing a French card as English. The two were written
   * from one string, which conflated a BCP 47 tag with an Open Graph one.
   */
  it('declares the card locale in the format Open Graph defines', async () => {
    const { initI18n, changeLanguage } = await boot('es-MX')

    await initI18n()
    // Narrowed like `lang` — a browser reporting es-MX is served the `es`
    // catalog — and then written in the format this attribute takes.
    expect(document.documentElement.lang).toBe('es')
    expect(contentOf('meta[property="og:locale"]')).toBe('es_ES')

    await changeLanguage('fr')
    expect(contentOf('meta[property="og:locale"]')).toBe('fr_FR')
  })

  it('touches no metadata when the module is only imported', async () => {
    await boot('fr')

    expect(contentOf('meta[property="og:description"]')).toBe(
      SHIPPED_DESCRIPTION
    )
    expect(contentOf('meta[property="og:locale"]')).toBe('en_US')
  })
})
