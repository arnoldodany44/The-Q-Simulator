/**
 * `/sign-up` — registration, with this project's email confirmation stated
 * out loud rather than discovered.
 *
 * ── The sentence this screen exists to say ────────────────────────────────
 *
 * `mailer_autoconfirm` is false on this project, confirmed against the live
 * settings document. Registering therefore does NOT sign anybody in: Supabase
 * answers with a user and no session, and the account cannot authenticate
 * until the link in the inbox has been opened. A screen that omits this drops
 * a brand-new user at a login form that rejects their brand-new, correct
 * password with "those credentials do not match an account", and the honest
 * conclusion from there is that the app is broken.
 *
 * So it is said twice, deliberately. Once **before** the form is submitted,
 * because a user who knows a link is coming will go and look for it, and once
 * **after**, naming the address it went to. The first is driven by
 * `emailConfirmationRequired` from the settings document; the second by what
 * the sign-up response actually contained, which is the authoritative answer
 * for this attempt.
 *
 * The second one also offers to send the link again. A confirmation mail that
 * never arrives — the project's hourly quota was spent, the message went to
 * spam, the link expired — used to leave the reader with an instruction to
 * open something they did not have and nothing anywhere in the app that could
 * produce another.
 *
 * ── Why "we sent you a link" is also the answer for an existing account ───
 *
 * Supabase, with confirmation on, replies to a sign-up for an address it
 * already knows with a user-shaped object and no session — the same shape as
 * a genuinely new registration. `sessionActions.ts` preserves that, and so
 * does this screen: "check your inbox" leaks nothing, while "that email is
 * taken" turns a public form into a membership oracle. The
 * `EMAIL_ALREADY_REGISTERED` sentence exists for the configurations that do
 * report it, and it is the server's decision to make, not this screen's.
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
  MAX_PASSWORD_BYTES,
  MIN_PASSWORD_LENGTH,
  ProviderSignInButtons,
  SIGN_IN_PATH,
  emailProblem,
  newPasswordProblem,
  useAuthProviders,
  useIntendedPath,
  useSessionActions,
} from '../features/auth'
import type { AuthFailureCode } from '../lib/supabase'

export function SignUpRoute() {
  const { t } = useTranslation('auth')
  const actions = useSessionActions()
  const { settings } = useAuthProviders()
  const intended = useIntendedPath()

  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [emailError, setEmailError] = useState<string | null>(null)
  const [passwordError, setPasswordError] = useState<string | null>(null)
  const [failure, setFailure] = useState<AuthFailureCode | null>(null)
  const [pending, setPending] = useState(false)
  /** The address the confirmation went to; non-null once it has been sent. */
  const [sentTo, setSentTo] = useState<string | null>(null)
  const [resending, setResending] = useState(false)
  const [resent, setResent] = useState(false)

  const emailRef = useRef<HTMLInputElement>(null)
  const passwordRef = useRef<HTMLInputElement>(null)

  const passwordLimits = {
    min: MIN_PASSWORD_LENGTH,
    max: MAX_PASSWORD_BYTES,
  }

  function submit(event: FormEvent<HTMLFormElement>): void {
    event.preventDefault()
    if (pending) return

    const emailIssue = emailProblem(email)
    const passwordIssue = newPasswordProblem(password)

    // Committed before the focus move — see the note in `sign-in.tsx`.
    flushSync(() => {
      setEmailError(emailIssue === null ? null : t(`validation.${emailIssue}`))
      setPasswordError(
        passwordIssue === null
          ? null
          : t(`validation.${passwordIssue}`, passwordLimits)
      )
    })

    if (emailIssue !== null || passwordIssue !== null) {
      const target = emailIssue !== null ? emailRef : passwordRef
      target.current?.focus()
      return
    }

    const address = email.trim()
    setFailure(null)
    setPending(true)
    void actions.signUp({ email: address, password }).then((outcome) => {
      setPending(false)
      if (!outcome.ok) {
        setFailure(outcome.code)
        return
      }
      /*
       * `confirmationRequired` is read from the response rather than from the
       * settings document: it says whether a session actually came back for
       * *this* attempt. When one did, the session provider has already been
       * told and `RedirectWhenSignedIn` is about to move the user, so there
       * is nothing to render.
       */
      if (outcome.confirmationRequired) setSentTo(address)
    })
  }

  function resend(address: string): void {
    if (resending) return
    setResending(true)
    setResent(false)
    void actions.resendConfirmation(address).then((outcome) => {
      setResending(false)
      if (outcome.ok) {
        setFailure(null)
        setResent(true)
        return
      }
      setFailure(outcome.code)
    })
  }

  if (!settings.signUpEnabled) {
    return (
      <AuthPage title={t('signUp.title')}>
        <AuthNotice>
          <p>{t('signUp.closed')}</p>
        </AuthNotice>
        <p className="auth-links">
          <Link to={SIGN_IN_PATH}>{t('signUp.signInInstead')}</Link>
        </p>
      </AuthPage>
    )
  }

  if (sentTo !== null) {
    return (
      <AuthPage title={t('signUp.title')}>
        <AuthNotice>
          <p>{t('confirmation.sent', { email: sentTo })}</p>
          <p>{t('signUp.nextStep')}</p>
        </AuthNotice>

        {failure === null ? null : <AuthErrorAlert code={failure} />}
        {resent ? (
          <AuthNotice>
            <p>{t('confirmation.resent', { email: sentTo })}</p>
          </AuthNotice>
        ) : null}

        {/* The way out of "open the link we sent" for a reader who never got
            one. See the header. */}
        <p className="auth-links">
          <button
            className="link-button"
            type="button"
            aria-disabled={resending}
            onClick={() => {
              resend(sentTo)
            }}
          >
            {t('confirmation.resend')}
          </button>
        </p>

        <p className="auth-links">
          <Link to={SIGN_IN_PATH}>{t('signUp.signInInstead')}</Link>
        </p>
      </AuthPage>
    )
  }

  const links = (
    <p className="auth-links">
      {t('signUp.haveAccount')}{' '}
      <Link to={SIGN_IN_PATH}>{t('signUp.signInInstead')}</Link>
    </p>
  )

  // A project with the email provider switched off refuses every registration
  // with `email_provider_disabled`; see `sign-in.tsx` on why the form is not
  // offered in that case.
  if (!settings.emailEnabled) {
    return (
      <AuthPage title={t('signUp.title')} lead={t('signUp.lead')}>
        <AuthNotice>
          <p>{t('signUp.emailDisabled')}</p>
        </AuthNotice>
        {links}
        <ProviderSignInButtons redirectPath={intended} onFailure={setFailure} />
      </AuthPage>
    )
  }

  return (
    <AuthPage title={t('signUp.title')} lead={t('signUp.lead')}>
      {/*
       * Present from the first paint, so it is not a live region: it is what
       * the reader is deciding on, not a response to something they did.
       */}
      {settings.emailConfirmationRequired ? (
        <p className="auth-warning">{t('signUp.confirmationWarning')}</p>
      ) : null}

      <form className="auth-form" noValidate onSubmit={submit}>
        {failure === null ? null : <AuthErrorAlert code={failure} />}

        <AuthField
          label={t('fields.email')}
          type="email"
          name="email"
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
          autoComplete="new-password"
          value={password}
          onChange={setPassword}
          // The project's actual rules, both of them, and no others. See
          // passwordPolicy.ts for why nothing stricter is invented here — and
          // for why the ceiling is measured rather than assumed absent.
          hint={t('fields.passwordHint', passwordLimits)}
          error={passwordError ?? undefined}
          inputRef={passwordRef}
          busy={pending}
        />

        {/* `aria-disabled` rather than `disabled` — see `sign-in.tsx`. */}
        <button className="page__cta" type="submit" aria-disabled={pending}>
          {t('signUp.submit')}
        </button>

        {pending ? (
          <p className="auth-form__pending" role="status">
            {t('signUp.pending')}
          </p>
        ) : null}
      </form>

      {links}

      {/* Last, so nothing it appears above can move under a pointer — see the
          header of `sign-in.tsx`. */}
      <ProviderSignInButtons redirectPath={intended} onFailure={setFailure} />
    </AuthPage>
  )
}
