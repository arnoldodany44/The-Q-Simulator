// @vitest-environment node
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import { describe, expect, it } from 'vitest'

import { SUPPORTED_LANGUAGES } from '../../i18n/index.js'
import { ERROR_CODES, UNKNOWN_ERROR_KEY } from './errors.js'

/**
 * The guard that makes "the API never sends display text" hold in practice.
 *
 * The API answers with `AUTH_TOKEN_EXPIRED`, and the sentence a user reads
 * exists only here, in three languages. That arrangement has one failure
 * mode: a code is added to `@qsim/contract`, the API starts sending it, and
 * no catalog has an entry — so the screen shows the raw identifier, in every
 * language at once. Nothing else in the toolchain can see that.
 * `i18next/no-literal-string` sees a `t()` call and is satisfied; the locale
 * parity test compares the catalogs against each other, and they agree
 * perfectly, because all three are equally missing the key.
 *
 * So this compares the catalogs against the *code list* instead, in both
 * directions: a code with no sentence, and a sentence for a code that no
 * longer exists.
 *
 * Read off disk rather than imported, for the same reason `locale-parity.
 * test.ts` does it: a catalog that exists but was never registered still gets
 * caught.
 */

const LOCALES_DIR = join(import.meta.dirname, '..', '..', 'i18n', 'locales')

function readErrorCatalog(language: string): Record<string, unknown> {
  const path = join(LOCALES_DIR, language, 'errors.json')
  return JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>
}

/** Every key that must be translatable: the wire codes plus the fallback. */
const REQUIRED_KEYS = [...ERROR_CODES, UNKNOWN_ERROR_KEY].sort()

describe('the errors catalog', () => {
  it.each(SUPPORTED_LANGUAGES)(
    'has exactly one sentence per error code in "%s"',
    (language) => {
      expect(Object.keys(readErrorCatalog(language)).sort()).toEqual(
        REQUIRED_KEYS
      )
    }
  )

  it.each(SUPPORTED_LANGUAGES)(
    'has a real sentence, not a placeholder, in "%s"',
    (language) => {
      for (const [key, value] of Object.entries(readErrorCatalog(language))) {
        expect(typeof value, key).toBe('string')
        expect(String(value).trim().length, key).toBeGreaterThan(0)
        /*
         * The failure this catches is a catalog filled in by copying the code
         * across — which reads as a translation in review and as gibberish on
         * screen.
         */
        expect(String(value), key).not.toBe(key)
      }
    }
  )

  it('never leaks the API developer message into a catalog', () => {
    // The API's own English is deliberately not for display. If a phrase from
    // it appears here, somebody translated the wrong string.
    for (const language of SUPPORTED_LANGUAGES) {
      const catalog = JSON.stringify(readErrorCatalog(language))
      expect(catalog).not.toContain('This endpoint')
      expect(catalog).not.toContain('Retry-After')
    }
  })
})
