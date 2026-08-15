import { renderHook } from '@testing-library/react'
import { createInstance, type i18n as I18n } from 'i18next'
import { I18nextProvider, initReactI18next } from 'react-i18next'
import { describe, expect, it } from 'vitest'

import enErrors from '../../i18n/locales/en/errors.json'
import esErrors from '../../i18n/locales/es/errors.json'
import frErrors from '../../i18n/locales/fr/errors.json'
import { ApiRequestError } from './errors.js'
import { useApiErrorMessage } from './useApiErrorMessage.js'

/**
 * The last step of the chain the API's error design exists for: a code
 * crosses the wire, and the sentence the reader gets is in their language.
 *
 * Asserted in all three (D2) rather than only in English, because the whole
 * point of sending codes is that the French user does not read English — and
 * a catalog wired up for one language and not the others is exactly the
 * mistake this arrangement is meant to make impossible.
 */

type Language = 'en' | 'es' | 'fr'

const CATALOGS: Record<Language, typeof enErrors> = {
  en: enErrors,
  es: esErrors,
  fr: frErrors,
}

function i18nFor(language: Language): I18n {
  const instance = createInstance()
  void instance.use(initReactI18next).init({
    lng: language,
    fallbackLng: 'en',
    ns: ['errors'],
    defaultNS: 'errors',
    resources: {
      en: { errors: enErrors },
      es: { errors: esErrors },
      fr: { errors: frErrors },
    },
    interpolation: { escapeValue: false },
    react: { useSuspense: false },
  })
  return instance
}

function messageFor(error: unknown, language: Language = 'en'): string {
  const { result } = renderHook(() => useApiErrorMessage(), {
    wrapper: ({ children }) => (
      <I18nextProvider i18n={i18nFor(language)}>{children}</I18nextProvider>
    ),
  })
  return result.current(error)
}

describe('useApiErrorMessage', () => {
  it.each(['en', 'es', 'fr'] as const)(
    'translates a code into %s',
    (language) => {
      const message = messageFor(
        new ApiRequestError('AUTH_TOKEN_EXPIRED', { status: 401 }),
        language
      )

      expect(message).toBe(CATALOGS[language].AUTH_TOKEN_EXPIRED)
      // Never the raw key, which is what a missing namespace looks like.
      expect(message).not.toBe('AUTH_TOKEN_EXPIRED')
    }
  )

  it('says something rather than nothing for an unrecognised failure', () => {
    // React Query types `error` as whatever was thrown, so a bug in a
    // `select` arrives here too. A blank banner is worse than a vague one.
    expect(messageFor(new TypeError('undefined is not a function'))).toBe(
      CATALOGS.en.UNKNOWN
    )
  })

  it('translates a code the client itself produced', () => {
    expect(messageFor(new ApiRequestError('NETWORK_UNREACHABLE'), 'fr')).toBe(
      CATALOGS.fr.NETWORK_UNREACHABLE
    )
  })

  it('never surfaces the API developer message', () => {
    const error = new ApiRequestError('INTERNAL_ERROR', {
      status: 500,
      requestId: 'req-9',
    })

    const message = messageFor(error, 'es')

    expect(message).toBe(CATALOGS.es.INTERNAL_ERROR)
    expect(message).not.toContain('Unexpected server error')
  })
})
