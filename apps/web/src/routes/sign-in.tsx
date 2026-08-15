/**
 * `/sign-in` — email and password, plus whatever else the project offers.
 *
 * ── This screen never navigates ───────────────────────────────────────────
 *
 * A successful sign-in is not followed by `navigate()` here. The route is
 * wrapped in `RedirectWhenSignedIn` (see `App.tsx`), so the session becoming
 * authenticated is what moves the user — to the path the guard recorded when
 * it sent them here, or to the app root. Doing it in both places is how a
 * flow ends up with two history entries for one sign-in, and how a redirect
 * silently stops happening for a user who signed in *in another tab*: the
 * session arrives by event, not by this promise.
 *
 * So `pending` is deliberately left true after a success. The redirect is on
 * its way, and a form that re-enabled itself in the meantime is a form that
 * can be submitted a second time.
 *
 * ── Why the password is only checked for being empty ──────────────────────
 *
 * `passwordPolicy.ts` has the argument in full: a length rule belongs to
 * passwords being *set*, and applying it here would refuse to even try an
 * older password that the account still has — locking out the one user who
 * cannot afford it, over a rule that did not exist when they registered.
 *
 * ── The two sign-in failures a user acts on differently ───────────────────
 *
 * `INVALID_CREDENTIALS` and `EMAIL_NOT_CONFIRMED` are both "we did not sign
 * you in", and Supabase's own English for the first is what a person reads as
 * the second. They are kept apart all the way from `authErrors.ts` to the
 * three catalogs, because one is fixed by typing the password again and the
 * other by opening an inbox — and this project has email confirmation
 * switched on, so the second is what a brand-new account hits.
 *
 * The second one now also carries a way out. "Open the link we sent when you
 * registered" is a dead end for the reader whose link never arrived — which on
 * a project whose mail quota is routinely spent is the common case, not the
 * unlucky one — so the sentence is followed by a control that sends another.
 * `update-password.tsx` already answers its own equivalent that way, with a
 * real link to ask for a fresh one; this is the same shape.
 *
 * ── The email form is not unconditional ───────────────────────────────────
 *
 * `settings.emailEnabled` is read off the project alongside the provider list.
 * A project with the email provider switched off answers every sign-in with
 * `email_provider_disabled`, so rendering the form there offers a control that
 * can only fail — the thing `ProviderSignInButtons` exists to avoid for the
 * providers, applied to the built-in one.
 *
 * ── Where the provider buttons sit, and why it is the bottom ──────────────
 *
 * Below the links, not between the form and them. The list is injected after
 * first paint — it waits on `GET /auth/v1/settings` — and anything rendered
 * *above* an interactive element moves that element when it arrives. Measured
 * against a 1500 ms settings response with GitHub enabled, "Forgotten your
 * password?" moved 58 px down and a click aimed at it landed on "Continue with
 * GitHub" and started an OAuth round trip. Nothing follows the list, so
 * nothing it appears above can move under a pointer.
 */

import { useRef, useState } from 'react'
import { flushSync } from 'react-dom'
import { useTranslation } from 'react-i18next'
import { Link } from 'react-router'
import type { FormEvent } from 'react'

import {
  AuthErrorAlert,
  AuthField,
  AuthNotice,
  AuthPage,
  PASSWORD_RESET_PATH,
  ProviderSignInButtons,
  SIGN_UP_PATH,
  emailProblem,
  useAuthProviders,
  useIntendedPath,
  useSessionActions,
} from '../features/auth'
import type { AuthFailureCode } from '../lib/supabase'

export function SignInRoute() {
  const { t } = useTranslation('auth')
  const actions = useSessionActions()
  const { settings } = useAuthProviders()
  /*
   * Where the guard was taking them. Handed to the provider buttons so an
   * OAuth round trip comes back to the same place an email sign-in would.
   */
  const intended = useIntendedPath()

  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [emailError, setEmailError] = useState<string | null>(null)
  const [passwordError, setPasswordError] = useState<string | null>(null)
  const [failure, setFailure] = useState<AuthFailureCode | null>(null)
  const [pending, setPending] = useState(false)
  /** The address another confirmation link has just been sent to. */
  const [resentTo, setResentTo] = useState<string | null>(null)
  const [resending, setResending] = useState(false)

  const emailRef = useRef<HTMLInputElement>(null)
  const passwordRef = useRef<HTMLInputElement>(null)

  function submit(event: FormEvent<HTMLFormElement>): void {
    event.preventDefault()
    if (pending) return

    const emailIssue = emailProblem(email)
    // Empty, and nothing else. See the header.
    const passwordIssue = password === '' ? 'passwordRequired' : null

    /*
     * Committed before the focus move, not batched with it. React flushes the
     * state set in a discrete event at the *end* of the event, so a `focus()`
     * written after a plain `setState` runs while the field still carries
     * neither `aria-invalid` nor a pointer to the message — the one instant
     * that decides what a screen reader announces. `flushSync` puts the
     * wiring in the DOM first, which is the whole point of having it.
     */
    flushSync(() => {
      setEmailError(emailIssue === null ? null : t(`validation.${emailIssue}`))
      setPasswordError(
        passwordIssue === null ? null : t(`validation.${passwordIssue}`)
      )
    })

    if (emailIssue !== null || passwordIssue !== null) {
      /*
       * Focus the first field that was rejected. The message is announced by
       * its own live region either way — including in the case this cannot
       * help with, where the field already had focus and `focus()` does
       * nothing — and this is what puts the caret where the correction has to
       * happen rather than leaving it at the button.
       */
      const target = emailIssue !== null ? emailRef : passwordRef
      target.current?.focus()
      return
    }

    setFailure(null)
    setResentTo(null)
    setPending(true)
    void actions.signIn({ email: email.trim(), password }).then((outcome) => {
      if (outcome.ok) return
      setPending(false)
      setFailure(outcome.code)
    })
  }

  function resendConfirmation(): void {
    if (resending) return
    const address = email.trim()
    if (address === '') return
    setResending(true)
    void actions.resendConfirmation(address).then((outcome) => {
      setResending(false)
      if (outcome.ok) {
        setFailure(null)
        setResentTo(address)
        return
      }
      setFailure(outcome.code)
    })
  }

  const links = (
    <>
      <p className="auth-links">
        <Link to={PASSWORD_RESET_PATH}>{t('signIn.forgot')}</Link>
      </p>
      <p className="auth-links">
        {t('signIn.noAccount')}{' '}
        <Link to={SIGN_UP_PATH}>{t('signIn.createOne')}</Link>
      </p>
    </>
  )

  if (!settings.emailEnabled) {
    return (
      <AuthPage title={t('signIn.title')} lead={t('signIn.lead')}>
        <AuthNotice>
          <p>{t('signIn.emailDisabled')}</p>
        </AuthNotice>
        {links}
        <ProviderSignInButtons redirectPath={intended} onFailure={setFailure} />
      </AuthPage>
    )
  }

  return (
    <AuthPage title={t('signIn.title')} lead={t('signIn.lead')}>
      <form className="auth-form" noValidate onSubmit={submit}>
        {failure === null ? null : <AuthErrorAlert code={failure} />}

        {failure === 'EMAIL_NOT_CONFIRMED' ? (
          <p className="auth-links">
            <button
              className="link-button"
              type="button"
              aria-disabled={resending}
              onClick={resendConfirmation}
            >
              {t('confirmation.resend')}
            </button>
          </p>
        ) : null}

        {resentTo === null ? null : (
          <AuthNotice>
            <p>{t('confirmation.resent', { email: resentTo })}</p>
          </AuthNotice>
        )}

        <AuthField
          label={t('fields.email')}
          type="email"
          name="email"
          // `username` rather than `email`: it is what pairs with
          // `current-password` for a password manager to offer a saved login.
          autoComplete="username"
          value={email}
          onChange={setEmail}
          error={emailError ?? undefined}
          inputRef={emailRef}
          busy={pending}
        />

        <AuthField
          label={t('fields.password')}
          type="password"
          name="password"
          autoComplete="current-password"
          value={password}
          onChange={setPassword}
          error={passwordError ?? undefined}
          inputRef={passwordRef}
          busy={pending}
        />

        {/*
         * `aria-disabled`, never `disabled`. This is the control a keyboard
         * user pressed Enter on, and a disabled element cannot hold focus — so
         * disabling it dropped the caret to the document body for the whole
         * request and left it there afterwards, seven Tab stops from the field
         * that needed correcting. The double submit it was guarding against is
         * already refused by `if (pending) return` above.
         */}
        <button className="page__cta" type="submit" aria-disabled={pending}>
          {t('signIn.submit')}
        </button>

        {/* Polite, and separate from the button, so the button's accessible
            name does not change under a voice-control user mid-submit. */}
        {pending ? (
          <p className="auth-form__pending" role="status">
            {t('signIn.pending')}
          </p>
        ) : null}
      </form>

      {links}

      <ProviderSignInButtons redirectPath={intended} onFailure={setFailure} />
    </AuthPage>
  )
}
