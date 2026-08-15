import { API_ERROR_CODES } from '@qsim/contract'
import { describe, expect, it } from 'vitest'

import {
  ApiRequestError,
  CLIENT_ERROR_CODES,
  ERROR_CODES,
  errorCodeForStatus,
  errorMessageKey,
  isApiRequestError,
  isForbidden,
  isNotFound,
  isRetryable,
  requiresAuthentication,
} from './errors.js'

describe('ApiRequestError', () => {
  it('defaults everything the server did not send', () => {
    const error = new ApiRequestError('NETWORK_UNREACHABLE')

    expect(error.status).toBeNull()
    expect(error.requestId).toBeNull()
    expect(error.details).toEqual([])
    expect(error.serverCode).toBeNull()
    expect(isApiRequestError(error)).toBe(true)
  })

  it('is not confused with an ordinary Error', () => {
    expect(isApiRequestError(new Error('boom'))).toBe(false)
    expect(isApiRequestError(null)).toBe(false)
  })
})

describe('the 401 / 403 distinction', () => {
  /*
   * The reason this file exists. 401 means "we do not know who you are" and
   * the answer is a sign-in prompt. 403 means "we know exactly who you are
   * and this is not yours", where a sign-in prompt does nothing — the user is
   * already signed in — and is how an app ends up bouncing someone to a login
   * screen in a loop.
   */
  const unauthenticated = new ApiRequestError('AUTH_REQUIRED', { status: 401 })
  const expired = new ApiRequestError('AUTH_TOKEN_EXPIRED', { status: 401 })
  const forbidden = new ApiRequestError('FORBIDDEN', { status: 403 })

  it('answers exactly one of the two for each', () => {
    expect(requiresAuthentication(unauthenticated)).toBe(true)
    expect(isForbidden(unauthenticated)).toBe(false)

    expect(requiresAuthentication(expired)).toBe(true)
    expect(isForbidden(expired)).toBe(false)

    expect(isForbidden(forbidden)).toBe(true)
    expect(requiresAuthentication(forbidden)).toBe(false)
  })

  it('does not treat an unavailable signing key as a sign-in problem', () => {
    // AUTH_KEY_UNAVAILABLE is a 503: the JWKS endpoint is down, and the
    // caller's credentials are fine. Logging the user out here would be wrong.
    const keys = new ApiRequestError('AUTH_KEY_UNAVAILABLE', { status: 503 })

    expect(requiresAuthentication(keys)).toBe(false)
    expect(isForbidden(keys)).toBe(false)
    expect(isRetryable(keys)).toBe(true)
  })

  it('treats a missing email claim as an authorisation problem', () => {
    // USER_EMAIL_REQUIRED is a 403: genuine credentials, not sufficient to
    // own anything. Offering a sign-in would loop.
    const noEmail = new ApiRequestError('USER_EMAIL_REQUIRED', { status: 403 })

    expect(isForbidden(noEmail)).toBe(true)
    expect(requiresAuthentication(noEmail)).toBe(false)
  })

  it('says neither for anything that is not an API error', () => {
    expect(requiresAuthentication(new Error('boom'))).toBe(false)
    expect(isForbidden('403')).toBe(false)
  })
})

describe('isNotFound', () => {
  it('covers both meanings of 404, because §11 makes them one', () => {
    expect(isNotFound(new ApiRequestError('NOT_FOUND', { status: 404 }))).toBe(
      true
    )
  })
})

describe('isRetryable', () => {
  it('is false for everything the client itself got wrong', () => {
    for (const status of [400, 401, 403, 404, 409, 413, 415]) {
      expect(
        isRetryable(new ApiRequestError('VALIDATION_FAILED', { status })),
        String(status)
      ).toBe(false)
    }
  })

  it('is true for a server fault, a rate limit and an unreachable server', () => {
    expect(
      isRetryable(new ApiRequestError('INTERNAL_ERROR', { status: 500 }))
    ).toBe(true)
    expect(
      isRetryable(new ApiRequestError('RATE_LIMITED', { status: 429 }))
    ).toBe(true)
    expect(isRetryable(new ApiRequestError('NETWORK_UNREACHABLE'))).toBe(true)
  })

  it('is false for a malformed response, which will be malformed again', () => {
    expect(
      isRetryable(new ApiRequestError('RESPONSE_MALFORMED', { status: 200 }))
    ).toBe(false)
  })
})

describe('errorCodeForStatus', () => {
  it('keeps the statuses whose meaning needs no body', () => {
    expect(errorCodeForStatus(401)).toBe('AUTH_REQUIRED')
    expect(errorCodeForStatus(403)).toBe('FORBIDDEN')
    expect(errorCodeForStatus(404)).toBe('NOT_FOUND')
    expect(errorCodeForStatus(429)).toBe('RATE_LIMITED')
  })

  it('refuses to guess where a status has several meanings', () => {
    // A bare 409 could be a version conflict or an email collision, and
    // guessing puts the wrong sentence on screen.
    expect(errorCodeForStatus(409)).toBe('INTERNAL_ERROR')
    expect(errorCodeForStatus(503)).toBe('INTERNAL_ERROR')
  })
})

describe('errorMessageKey', () => {
  it('names a catalog entry for every code both ends know', () => {
    for (const code of ERROR_CODES) {
      expect(errorMessageKey(new ApiRequestError(code))).toBe(`errors:${code}`)
    }
  })

  it('falls back for anything that is not an API error at all', () => {
    expect(errorMessageKey(new Error('boom'))).toBe('errors:UNKNOWN')
    expect(errorMessageKey(undefined)).toBe('errors:UNKNOWN')
  })
})

describe('ERROR_CODES', () => {
  it('is the API vocabulary plus the failures that happen on this side', () => {
    expect(ERROR_CODES).toEqual([...API_ERROR_CODES, ...CLIENT_ERROR_CODES])
  })

  it('does not reuse an API code for a client-side failure', () => {
    for (const code of CLIENT_ERROR_CODES) {
      expect(API_ERROR_CODES as readonly string[]).not.toContain(code)
    }
  })
})
