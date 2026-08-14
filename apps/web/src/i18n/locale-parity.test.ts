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
