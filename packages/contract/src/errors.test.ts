import { describe, expect, it } from 'vitest'

import {
  API_ERROR_CODES,
  ErrorResponseSchema,
  isApiErrorCode,
} from './errors.js'

describe('API_ERROR_CODES', () => {
  it('has no duplicates', () => {
    expect(new Set(API_ERROR_CODES).size).toBe(API_ERROR_CODES.length)
  })

  it('is SCREAMING_SNAKE_CASE throughout', () => {
    for (const code of API_ERROR_CODES) expect(code).toMatch(/^[A-Z][A-Z_]*$/)
  })
})

describe('isApiErrorCode', () => {
  it('accepts a code both ends know', () => {
    expect(isApiErrorCode('FORBIDDEN')).toBe(true)
  })

  /*
   * The case that matters in production: an API deployed ahead of the tab
   * that is open. The client must be able to tell "a code I do not know"
   * from "a code I know", so it can fall back to a generic sentence rather
   * than render a raw identifier.
   */
  it('rejects a code from a newer API, and anything that is not a string', () => {
    expect(isApiErrorCode('QUOTA_EXCEEDED')).toBe(false)
    expect(isApiErrorCode(undefined)).toBe(false)
    expect(isApiErrorCode(404)).toBe(false)
  })
})

describe('ErrorResponseSchema', () => {
  it('accepts the documented body, with and without details', () => {
    expect(
      ErrorResponseSchema.safeParse({
        error: {
          code: 'NOT_FOUND',
          message: 'No such resource.',
          requestId: 'r',
        },
      }).success
    ).toBe(true)

    expect(
      ErrorResponseSchema.safeParse({
        error: {
          code: 'VALIDATION_FAILED',
          message: 'x',
          requestId: 'r',
          details: [{ path: 'body.title', code: 'too_small' }],
        },
      }).success
    ).toBe(true)
  })

  /*
   * A proxy's HTML 502, a captive portal, a rewrite rule that swallowed the
   * API — the error path is exactly where a body might not be ours at all.
   * The client maps these by status instead, so the parse must fail rather
   * than half-succeed.
   */
  it('rejects a body that did not come from this API', () => {
    expect(
      ErrorResponseSchema.safeParse({ message: 'Bad Gateway' }).success
    ).toBe(false)
    expect(ErrorResponseSchema.safeParse('<html>502</html>').success).toBe(
      false
    )
  })
})
