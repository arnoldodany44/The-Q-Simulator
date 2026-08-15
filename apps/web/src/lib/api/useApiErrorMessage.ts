/**
 * Turning an API failure into a sentence the reader's language has — D2.
 *
 * This is the whole reason the API sends `AUTH_TOKEN_EXPIRED` and not "your
 * session expired": the sentence lives in three catalogs that a parity test
 * keeps in step, and the server never has to know which language the tab is
 * in. `errors.json` is the only catalog whose keys are not invented by a
 * designer — they are `@qsim/contract`'s codes, and `messages.test.ts`
 * asserts the two lists are identical.
 *
 * The function is returned rather than the string because the caller usually
 * has the error in hand at render time and often has several: a form can show
 * one message per failed mutation.
 */

import { useCallback } from 'react'
import { useTranslation } from 'react-i18next'

import { errorMessageKey } from './errors.js'

export type ApiErrorMessage = (error: unknown) => string

export function useApiErrorMessage(): ApiErrorMessage {
  const { t } = useTranslation('errors')

  return useCallback(
    (error: unknown) => t(errorMessageKey(error)),
    // `t` changes identity when the language does, which is what re-renders
    // an error banner into the new language rather than leaving it behind.
    [t]
  )
}
