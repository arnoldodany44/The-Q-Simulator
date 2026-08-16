// @vitest-environment node
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'

import { describe, expect, it } from 'vitest'

import { NAMESPACES, SUPPORTED_LANGUAGES } from './index.js'

/**
 * Guards decision D2. Three locales only stay usable if they hold exactly the
 * same keys — a key present in `es` but missing in `fr` renders as a raw
 * identifier for French users, and nothing else in the toolchain notices.
 *
 * This test reads the catalogs off disk rather than importing them, so a file
 * that exists but was never registered still gets caught.
 */

const LOCALES_DIR = join(import.meta.dirname, 'locales')

/** Flattens `{ a: { b: "x" } }` into `["a.b"]`. */
function flattenKeys(value: unknown, prefix = ''): string[] {
  if (typeof value !== 'object' || value === null) return [prefix]
  return Object.entries(value).flatMap(([key, child]) =>
    flattenKeys(child, prefix ? `${prefix}.${key}` : key)
  )
}

function readCatalog(language: string, namespace: string): unknown {
  const path = join(LOCALES_DIR, language, `${namespace}.json`)
  return JSON.parse(readFileSync(path, 'utf8'))
}

describe('locale parity', () => {
  it('has a directory for every supported language and nothing else', () => {
    const onDisk = readdirSync(LOCALES_DIR, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort()

    expect(onDisk).toEqual([...SUPPORTED_LANGUAGES].sort())
  })

  /*
   * The guard the header promises, and the one the rest of this file cannot
   * give: every assertion below iterates NAMESPACES, so a catalog that exists
   * on disk but was never registered there is invisible to all of them. That
   * mistake is silent at runtime too — `loadCatalogs` iterates the same list,
   * so an unregistered file simply never loads and every key in it renders as
   * a raw identifier. Comparing the *set of files* against NAMESPACES closes
   * both halves at once: a file nobody registered, and a namespace registered
   * with a file missing from one language.
   */
  it.each(SUPPORTED_LANGUAGES)(
    'has exactly the registered namespaces on disk in "%s"',
    (language) => {
      const onDisk = readdirSync(join(LOCALES_DIR, language))
        .filter((name) => name.endsWith('.json'))
        .map((name) => name.replace(/\.json$/, ''))
        .sort()

      expect(onDisk).toEqual([...NAMESPACES].sort())
    }
  )

  /*
   * French sets a non-breaking space before ':', ';', '!' and '?' so the mark
   * cannot begin a line. `interpolation.escapeValue` is false, so the
   * character reaches the DOM intact; the only thing that can put an ordinary
   * space back is a translator's keyboard, which is what this catches.
   */
  it('never leaves a breaking space before French high punctuation', () => {
    for (const namespace of NAMESPACES) {
      const catalog = JSON.stringify(readCatalog('fr', namespace))
      expect(
        catalog.match(/ [:;!?]/g) ?? [],
        `fr/${namespace}.json needs U+00A0 before : ; ! ?`
      ).toEqual([])
    }
  })

  /*
   * One apostrophe, everywhere.
   *
   * U+2019 is the apostrophe of French and of English typography; U+0027 is
   * the typewriter substitute a keyboard produces. Mixing them is not a matter
   * of taste once both are on screen at once, and both *were*: the French
   * landing page rendered fifteen elisions with U+0027 ("s'exécute",
   * "l'éditeur", "d'un") beside one with U+2019 ("d'autres", from
   * `cta.gallery`) — one file, one page, two glyphs. Across the French
   * catalogs it was 223 against 41.
   *
   * The M1.5b and M1.9 catalogs got it right and the earlier ones did not,
   * which is exactly the shape of a rule nothing checks. This is the sibling
   * of the assertion above about French high punctuation, for the same reason:
   * a typographic convention that is only a convention drifts one commit at a
   * time.
   *
   * Spanish is included and simply has none, which is the correct answer for
   * it — the assertion is "never the typewriter glyph", not "always some
   * apostrophe".
   */
  it.each(SUPPORTED_LANGUAGES)(
    'never uses the typewriter apostrophe in "%s"',
    (language) => {
      for (const namespace of NAMESPACES) {
        const catalog = JSON.stringify(readCatalog(language, namespace))
        expect(
          catalog.match(/'/g) ?? [],
          `${language}/${namespace}.json needs U+2019, not U+0027`
        ).toEqual([])
      }
    }
  )

  it.each(NAMESPACES)(
    'has identical keys across all languages in "%s"',
    (namespace) => {
      const keysByLanguage = new Map<string, string[]>(
        SUPPORTED_LANGUAGES.map((language) => [
          language,
          flattenKeys(readCatalog(language, namespace)).sort(),
        ])
      )

      const reference = keysByLanguage.get('en')
      expect(reference, 'the en catalog is the reference').toBeDefined()

      for (const [language, keys] of keysByLanguage) {
        if (language === 'en') continue

        const missing = reference!.filter((key) => !keys.includes(key))
        const extra = keys.filter((key) => !reference!.includes(key))

        expect(
          missing,
          `${language}/${namespace}.json is missing keys present in en`
        ).toEqual([])
        expect(
          extra,
          `${language}/${namespace}.json has keys absent from en`
        ).toEqual([])
      }
    }
  )

  it('has no empty string values in any catalog', () => {
    for (const language of SUPPORTED_LANGUAGES) {
      for (const namespace of NAMESPACES) {
        const catalog = readCatalog(language, namespace) as Record<
          string,
          unknown
        >
        const entries = flattenKeys(catalog)
        for (const key of entries) {
          const value = key
            .split('.')
            .reduce<unknown>(
              (node, part) => (node as Record<string, unknown>)[part],
              catalog
            )
          expect(
            String(value).trim(),
            `${language}/${namespace}.json → ${key} is empty`
          ).not.toBe('')
        }
      }
    }
  })
})
