// @vitest-environment node
import { describe, expect, it } from 'vitest'

import { createSessionActions } from './sessionActions.js'
import { PASSWORD_UPDATE_PATH } from './paths.js'
import {
  TEST_SUPABASE_CONFIG,
  authError,
  createFakeAuth,
  fakeSession,
} from './testing.js'
import type { FakeAuthPort } from './testing.js'

/**
 * The actions, as plain functions — no React, no rendering.
 *
 * Two of these carry the milestone's actual risk. The first is that a
 * failure must arrive as a code and never as Supabase's English, because that
 * English is in no catalog and no lint rule can see it. The second is that
 * sign-up must be able to say "we sent you a link": email confirmation is
 * switched on for this project, so registering does not sign anybody in, and
 * a flow that assumes it did leaves a new user at a login form rejecting a
 * password that is perfectly correct.
 */

const ORIGIN = 'https://qsim.test'

function actionsFor(auth: FakeAuthPort) {
  return createSessionActions({
    runtime: { auth, config: TEST_SUPABASE_CONFIG },
    origin: ORIGIN,
  })
}

describe('signIn', () => {
  it('passes the credentials through and succeeds', async () => {
    const auth = createFakeAuth({ settled: null })

    const outcome = await actionsFor(auth).signIn({
      email: 'ada@example.test',
      password: 'correct horse',
    })

    expect(outcome).toEqual({ ok: true })
    expect(auth.calls.signInWithPassword[0]).toEqual({
      email: 'ada@example.test',
      password: 'correct horse',
    })
  })

  it('reports a wrong password as a translatable code', async () => {
    const auth = createFakeAuth({ settled: null })
    auth.script.signInError = authError('invalid_credentials', 400)

    const outcome = await actionsFor(auth).signIn({
      email: 'ada@example.test',
      password: 'wrong',
    })

    expect(outcome).toEqual({ ok: false, code: 'INVALID_CREDENTIALS' })
  })

  it('never lets the server’s English out of the transport layer', async () => {
    // The message on the error object is deliberately unlike anything in a
    // catalog, so a test that found it on screen would have found a defect.
    const auth = createFakeAuth({ settled: null })
    auth.script.signInError = authError('invalid_credentials')

    const outcome = await actionsFor(auth).signIn({
      email: 'ada@example.test',
      password: 'wrong',
    })

    expect(JSON.stringify(outcome)).not.toContain('Developer-facing')
  })

  it('reports an unconfirmed address distinctly from a wrong password', async () => {
    // Different next action: open an inbox, not type again.
    const auth = createFakeAuth({ settled: null })
    auth.script.signInError = authError('email_not_confirmed', 400)

    expect(
      await actionsFor(auth).signIn({ email: 'a@b.test', password: 'x' })
    ).toEqual({ ok: false, code: 'EMAIL_NOT_CONFIRMED' })
  })

  it('turns a thrown value into an outcome rather than a rejection', async () => {
    // An unhandled rejection inside a submit handler leaves the form spinning
    // with nothing on screen.
    const auth = createFakeAuth({ settled: null })
    auth.script.signInError = null
    const actions = createSessionActions({
      runtime: {
        auth: {
          ...auth,
          signInWithPassword: () => {
            throw new TypeError('fetch is not a function')
          },
        },
        config: TEST_SUPABASE_CONFIG,
      },
      origin: ORIGIN,
    })

    await expect(
      actions.signIn({ email: 'a@b.test', password: 'x' })
    ).resolves.toEqual({ ok: false, code: 'UNKNOWN' })
  })
})

describe('signUp', () => {
  it('says confirmation is required when no session comes back', async () => {
    // The live configuration: `mailer_autoconfirm` is false.
    const auth = createFakeAuth({ settled: null })
    auth.script.signUpSession = null

    expect(
      await actionsFor(auth).signUp({
        email: 'ada@example.test',
        password: 'x',
      })
    ).toEqual({ ok: true, confirmationRequired: true })
  })

  it('says confirmation is not required when a session comes back', async () => {
    const auth = createFakeAuth({ settled: null })
    auth.script.signUpSession = fakeSession('ada')

    expect(
      await actionsFor(auth).signUp({
        email: 'ada@example.test',
        password: 'x',
      })
    ).toEqual({ ok: true, confirmationRequired: false })
  })

  it('tells Supabase where the confirmation link should land', async () => {
    const auth = createFakeAuth({ settled: null })

    await actionsFor(auth).signUp({ email: 'ada@example.test', password: 'x' })

    expect(auth.calls.signUp[0]?.emailRedirectTo).toBe(ORIGIN)
  })

  it('reports a weak password as a code', async () => {
    const auth = createFakeAuth({ settled: null })
    auth.script.signUpError = authError('weak_password', 422)

    expect(
      await actionsFor(auth).signUp({ email: 'a@b.test', password: 'x' })
    ).toEqual({ ok: false, code: 'WEAK_PASSWORD' })
  })
})

describe('signInWithProvider', () => {
  it('passes through a provider this bundle never named', async () => {
    /*
     * The point of discovery: the day GitHub is enabled in the dashboard, the
     * button appears and this call works, with no edit here. Nothing in the
     * path from the settings document to `signInWithOAuth` checks the name
     * against a list.
     */
    const auth = createFakeAuth({ settled: null })

    expect(await actionsFor(auth).signInWithProvider('github')).toEqual({
      ok: true,
    })
    expect(auth.calls.signInWithOAuth[0]?.provider).toBe('github')
  })

  it('builds an absolute return URL from an app path', async () => {
    const auth = createFakeAuth({ settled: null })

    await actionsFor(auth).signInWithProvider('github', {
      redirectPath: '/c/bell',
    })

    expect(auth.calls.signInWithOAuth[0]?.redirectTo).toBe(
      'https://qsim.test/c/bell'
    )
  })

  it('refuses to send the user off this origin after signing in', async () => {
    // An OAuth `redirect_uri` pointing at somebody else's host is a phishing
    // page reached from the real domain, right after a real sign-in.
    const auth = createFakeAuth({ settled: null })

    await actionsFor(auth).signInWithProvider('github', {
      redirectPath: '//evil.example',
    })

    expect(auth.calls.signInWithOAuth[0]?.redirectTo).toBe('https://qsim.test/')
  })

  it('reports a provider that is not actually enabled', async () => {
    const auth = createFakeAuth({ settled: null })
    auth.script.signInWithOAuthError = authError('provider_disabled', 400)

    expect(await actionsFor(auth).signInWithProvider('github')).toEqual({
      ok: false,
      code: 'PROVIDER_DISABLED',
    })
  })
})

describe('requestPasswordReset', () => {
  it('sends the link to the screen that can set a password', async () => {
    const auth = createFakeAuth({ settled: null })

    await actionsFor(auth).requestPasswordReset('ada@example.test')

    expect(auth.calls.resetPasswordForEmail[0]).toEqual({
      email: 'ada@example.test',
      redirectTo: `${ORIGIN}${PASSWORD_UPDATE_PATH}`,
    })
  })

  it('reports a consumed or expired link when the reset is completed', async () => {
    const auth = createFakeAuth({ settled: null })
    auth.script.updateUserError = authError('otp_expired', 401)

    expect(await actionsFor(auth).updatePassword('new password')).toEqual({
      ok: false,
      code: 'LINK_EXPIRED',
    })
  })
})

describe('with no Supabase project configured', () => {
  it('refuses every action with a code the UI can translate', async () => {
    // A deployment without accounts is supported. Throwing at a form is not.
    const actions = createSessionActions({ runtime: null, origin: ORIGIN })
    const expected = { ok: false, code: 'AUTH_UNAVAILABLE' }

    expect(await actions.signIn({ email: 'a@b.test', password: 'x' })).toEqual(
      expected
    )
    expect(await actions.signUp({ email: 'a@b.test', password: 'x' })).toEqual(
      expected
    )
    expect(await actions.signInWithProvider('github')).toEqual(expected)
    expect(await actions.signOut()).toEqual(expected)
    expect(await actions.requestPasswordReset('a@b.test')).toEqual(expected)
    expect(await actions.resendConfirmation('a@b.test')).toEqual(expected)
    expect(await actions.updatePassword('x')).toEqual(expected)
  })
})

/**
 * The way out of the state the sign-up screen carefully warns about.
 *
 * With confirmation on, an account that never opened its link cannot sign in.
 * The screens said so correctly in three languages and nothing anywhere could
 * produce a second link — `auth.resend` was called from nowhere in the app.
 */
describe('another confirmation link', () => {
  it('asks for one for the address given, landing back on this origin', async () => {
    const auth = createFakeAuth({ settled: null })

    expect(
      await actionsFor(auth).resendConfirmation('ada@example.test')
    ).toEqual({
      ok: true,
    })
    expect(auth.calls.resend).toEqual([
      { email: 'ada@example.test', emailRedirectTo: ORIGIN },
    ])
  })

  it('reports the project mail quota as itself, not as too many attempts', async () => {
    const auth = createFakeAuth({ settled: null })
    auth.script.resendError = authError('over_email_send_rate_limit', 429)

    expect(
      await actionsFor(auth).resendConfirmation('ada@example.test')
    ).toEqual({
      ok: false,
      code: 'EMAIL_SEND_LIMITED',
    })
  })
})
