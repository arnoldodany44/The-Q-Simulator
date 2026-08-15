// @vitest-environment node
import { describe, expect, it } from 'vitest'

import { AUTH_FAILURE_CODES, authFailureCode } from './authErrors.js'

/**
 * What matters here is not the size of the table but two properties of it:
 * that a failure never escapes as Supabase's English, and that the two
 * outcomes a user acts on differently — "wrong password" and "confirm your
 * email" — stay apart. Email confirmation is switched on for this project, so
 * the second is the failure a brand-new account actually hits.
 */

function supabaseError(code: string, status = 400): unknown {
  return Object.assign(new Error('Invalid login credentials'), { code, status })
}

describe('authFailureCode', () => {
  it('answers null for the absence of an error', () => {
    expect(authFailureCode(null)).toBeNull()
    expect(authFailureCode(undefined)).toBeNull()
  })

  it('keeps a wrong password and an unconfirmed address apart', () => {
    // One is fixed by typing again, the other by opening an inbox. Collapsing
    // them leaves a new user retyping a password that is already correct.
    expect(authFailureCode(supabaseError('invalid_credentials'))).toBe(
      'INVALID_CREDENTIALS'
    )
    expect(authFailureCode(supabaseError('email_not_confirmed'))).toBe(
      'EMAIL_NOT_CONFIRMED'
    )
  })

  it.each([
    ['user_already_exists', 'EMAIL_ALREADY_REGISTERED'],
    ['email_exists', 'EMAIL_ALREADY_REGISTERED'],
    ['weak_password', 'WEAK_PASSWORD'],
    ['same_password', 'SAME_PASSWORD'],
    ['signup_disabled', 'SIGN_UP_DISABLED'],
    ['provider_disabled', 'PROVIDER_DISABLED'],
    ['user_banned', 'ACCOUNT_DISABLED'],
    ['email_address_invalid', 'EMAIL_INVALID'],
    ['over_request_rate_limit', 'RATE_LIMITED'],
    /*
     * NOT `RATE_LIMITED`. This one is the project's own quota for outgoing
     * mail: it trips on a first attempt from a fresh browser and clears on an
     * hourly boundary, so "too many attempts, wait a moment" is wrong about
     * the cause and wrong about the wait.
     */
    ['over_email_send_rate_limit', 'EMAIL_SEND_LIMITED'],
    ['email_provider_disabled', 'EMAIL_SIGN_IN_DISABLED'],
    ['validation_failed', 'INVALID_INPUT'],
    ['access_denied', 'PROVIDER_CANCELLED'],
    ['provider_email_needs_verification', 'PROVIDER_EMAIL_UNVERIFIED'],
    ['session_not_found', 'SESSION_MISSING'],
  ])('maps %s to %s', (code, expected) => {
    expect(authFailureCode(supabaseError(code))).toBe(expected)
  })

  it('collapses every dead-link shape onto one sentence', () => {
    // A user cannot act differently on "expired" versus "the verifier for
    // that PKCE flow is in another browser". Both mean: ask for a new link.
    for (const code of [
      'otp_expired',
      'flow_state_expired',
      'flow_state_not_found',
      'bad_code_verifier',
    ]) {
      expect(authFailureCode(supabaseError(code))).toBe('LINK_EXPIRED')
    }
  })

  it('recognises the offline error, which carries no code at all', () => {
    const offline = Object.assign(new Error('Failed to fetch'), {
      name: 'AuthRetryableFetchError',
    })
    expect(authFailureCode(offline)).toBe('NETWORK_UNREACHABLE')
  })

  it('falls back to the status only where the status is unambiguous', () => {
    expect(authFailureCode({ status: 429 })).toBe('RATE_LIMITED')
    /*
     * A bare 400 could be a malformed address or a wrong password, and
     * guessing puts the wrong instruction on screen. Vague beats wrong.
     */
    expect(authFailureCode({ status: 400 })).toBe('UNKNOWN')
  })

  it('answers UNKNOWN for a code from a newer auth server', () => {
    expect(authFailureCode(supabaseError('some_code_from_2027'))).toBe(
      'UNKNOWN'
    )
  })

  it('answers UNKNOWN for something that is not an error object', () => {
    // React Query and a submit handler both hand along whatever was thrown.
    expect(authFailureCode('boom')).toBe('UNKNOWN')
    expect(authFailureCode(new TypeError('x is not a function'))).toBe(
      'UNKNOWN'
    )
  })

  it('only ever produces codes the catalogs are checked against', () => {
    const produced = [
      authFailureCode(supabaseError('invalid_credentials')),
      authFailureCode(supabaseError('weak_password')),
      authFailureCode({ status: 429 }),
      authFailureCode('boom'),
    ]
    for (const code of produced) {
      expect(AUTH_FAILURE_CODES).toContain(code)
    }
  })
})
