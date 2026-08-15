// @vitest-environment node
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import { describe, expect, it } from 'vitest'

import { SUPPORTED_LANGUAGES } from '../../i18n/index.js'
import { AUTH_FAILURE_CODES } from '../../lib/supabase/index.js'

/**
 * The same guard `lib/api/messages.test.ts` provides for the API's error
 * codes, applied to Supabase's.
 *
 * The failure mode it catches: a code is added to `AUTH_FAILURE_CODES`, the
 * mapping starts producing it, and no catalog has an entry — so the sign-in
 * screen renders the raw identifier, in all three languages at once. Nothing
 * else in the toolchain sees that. `i18next/no-literal-string` sees a `t()`
 * call and is satisfied. Locale parity compares the three catalogs against
 * each other, and they agree perfectly, because all three are equally
 * missing the key.
 *
 * So this compares the catalogs against the *code list* instead, in both
 * directions. Read off disk rather than imported, for the same reason the
 * other two catalog tests do it.
 */

const LOCALES_DIR = join(import.meta.dirname, '..', '..', 'i18n', 'locales')

function readAuthCatalog(language: string): Record<string, unknown> {
  const path = join(LOCALES_DIR, language, 'auth.json')
  return JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>
}

function errorEntries(language: string): Record<string, unknown> {
  const errors = readAuthCatalog(language).errors
  expect(typeof errors, `${language}/auth.json needs an "errors" object`).toBe(
    'object'
  )
  return errors as Record<string, unknown>
}

describe('the auth catalog', () => {
  it.each(SUPPORTED_LANGUAGES)(
    'has exactly one sentence per failure code in "%s"',
    (language) => {
      expect(Object.keys(errorEntries(language)).sort()).toEqual(
        [...AUTH_FAILURE_CODES].sort()
      )
    }
  )

  it.each(SUPPORTED_LANGUAGES)(
    'has a real sentence, not the code copied across, in "%s"',
    (language) => {
      for (const [key, value] of Object.entries(errorEntries(language))) {
        expect(String(value), key).not.toBe(key)
        expect(String(value).trim().length, key).toBeGreaterThan(0)
      }
    }
  )

  it('never leaks a Supabase message into a catalog', () => {
    // Supabase's own English is developer-facing and belongs in no catalog.
    // If one of its phrases appears here, somebody translated the wrong
    // string and the sentence will drift the next time the server is updated.
    for (const language of SUPPORTED_LANGUAGES) {
      const catalog = JSON.stringify(readAuthCatalog(language))
      expect(catalog).not.toContain('Invalid login credentials')
      expect(catalog).not.toContain('Email not confirmed')
      expect(catalog).not.toContain('AuthApiError')
    }
  })

  it('keeps the two sign-in failures worded differently', () => {
    /*
     * They are the pair a user acts on differently — retype the password
     * versus open an inbox — and a catalog that gives them the same sentence
     * silently undoes the distinction the code carefully preserves.
     */
    for (const language of SUPPORTED_LANGUAGES) {
      const errors = errorEntries(language)
      expect(errors.INVALID_CREDENTIALS).not.toBe(errors.EMAIL_NOT_CONFIRMED)
    }
  })
})
