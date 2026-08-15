import { cleanup, render, screen } from '@testing-library/react'
import { createInstance, type i18n as I18n } from 'i18next'
import { I18nextProvider, initReactI18next } from 'react-i18next'
import { afterEach, describe, expect, it } from 'vitest'

import enAuth from '../../i18n/locales/en/auth.json'
import esAuth from '../../i18n/locales/es/auth.json'
import frAuth from '../../i18n/locales/fr/auth.json'
import { AUTH_FAILURE_CODES } from '../../lib/supabase/index.js'
import { AuthErrorAlert } from './AuthMessage.js'

/**
 * Every failure code becomes its own sentence, in every language, and that
 * sentence is never the code.
 *
 * `authCatalog.test.ts` already compares the catalogs against the code list
 * off disk. This is the other half and the half that would still be missing:
 * that the component actually *renders* the entry for the code it was given.
 * A screen that assembled its own key — `t('errors.' + code)` with the wrong
 * namespace, say — passes every catalog test in the project and shows the
 * reader `errors.INVALID_CREDENTIALS`.
 *
 * The distinctness assertion is the point of the whole error-mapping design.
 * Fifteen codes collapsing onto twelve sentences would mean three failures a
 * user is told to act on identically, and with confirmation switched on for
 * this project the pair that must never merge is `INVALID_CREDENTIALS` and
 * `EMAIL_NOT_CONFIRMED`: one is fixed by typing the password again, the other
 * by opening an inbox, and Supabase's own English for the first is what a
 * person reads as the second.
 */

afterEach(cleanup)

const CATALOGS = { en: enAuth, es: esAuth, fr: frAuth } as const
type Language = keyof typeof CATALOGS

function i18nFor(language: Language): I18n {
  const instance = createInstance()
  void instance.use(initReactI18next).init({
    lng: language,
    // No fallback: a missing key must fail this test rather than quietly
    // render English inside the French interface.
    fallbackLng: false,
    ns: ['auth'],
    defaultNS: 'auth',
    resources: {
      en: { auth: enAuth },
      es: { auth: esAuth },
      fr: { auth: frAuth },
    },
    interpolation: { escapeValue: false },
    react: { useSuspense: false },
  })
  return instance
}

function sentenceFor(language: Language, code: string): string {
  render(
    <I18nextProvider i18n={i18nFor(language)}>
      <AuthErrorAlert code={code as (typeof AUTH_FAILURE_CODES)[number]} />
    </I18nextProvider>
  )
  const text = screen.getByRole('alert').textContent ?? ''
  cleanup()
  return text
}

describe.each(['en', 'es', 'fr'] as const)('in "%s"', (language) => {
  it.each(AUTH_FAILURE_CODES)('renders a sentence for %s', (code) => {
    const text = sentenceFor(language, code)

    expect(text).toBe(CATALOGS[language].errors[code])
    // Not the key, not the raw identifier, not empty.
    expect(text).not.toBe(code)
    expect(text).not.toContain('errors.')
    expect(text.trim().length).toBeGreaterThan(0)
  })

  it('gives every code a sentence of its own', () => {
    const sentences = AUTH_FAILURE_CODES.map((code) =>
      sentenceFor(language, code)
    )
    expect(new Set(sentences).size).toBe(AUTH_FAILURE_CODES.length)
  })

  it('never shows Supabase its own English back', () => {
    // The developer-facing message is what `lib/supabase/authErrors.ts` exists
    // to stop reaching a screen. If it appears here, the mapping was bypassed.
    for (const code of AUTH_FAILURE_CODES) {
      expect(sentenceFor(language, code)).not.toContain(
        'Invalid login credentials'
      )
    }
  })
})

describe('the two sign-in failures', () => {
  it('reads differently in all three languages', () => {
    for (const language of ['en', 'es', 'fr'] as const) {
      expect(sentenceFor(language, 'EMAIL_NOT_CONFIRMED')).not.toBe(
        sentenceFor(language, 'INVALID_CREDENTIALS')
      )
    }
  })
})

describe('the live region', () => {
  it('is assertive, because the user is waiting for this answer', () => {
    // `role="alert"` and not `role="status"`: a polite failure is announced
    // after whatever the user does next, which is usually retyping the
    // password the message is about.
    render(
      <I18nextProvider i18n={i18nFor('en')}>
        <AuthErrorAlert code="RATE_LIMITED" />
      </I18nextProvider>
    )
    expect(screen.getByRole('alert')).toBeDefined()
  })
})
