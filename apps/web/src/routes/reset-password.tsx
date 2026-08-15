/**
 * `/reset-password` — asking for a link, without answering a question nobody
 * should be able to ask here.
 *
 * ── The confirmation is the same either way, and that is the feature ──────
 *
 * A form that says "we sent you a link" for a registered address and "no
 * account with that email" for an unregistered one is a membership oracle: an
 * attacker with a list of addresses learns which of them have accounts here,
 * one request at a time, from a page that needs no credentials. That is a
 * disclosure with real consequences — it links a person to this site, and it
 * narrows a credential-stuffing list to the addresses worth trying.
 *
 * Supabase's *success* answer is the same either way, so the way to keep the
 * property is to not add a branch: this screen sends, and renders one
 * sentence, phrased conditionally — *if* an account exists for that address.
 * Nothing here reads the address back, and nothing checks it first.
 *
 * ── WHY A FAILURE IS USUALLY ALSO THE CONFIRMATION ───────────────────────
 *
 * This file used to say that failures were safe to show "because none of them
 * depends on the address: rate limiting is per sender". Measured against this
 * project, that is false, and the screen was a working oracle in spite of
 * every other precaution taken here.
 *
 * `POST /auth/v1/recover` answers an address with no account `200 {}`, every
 * time. It answers a registered one `429 {"error_code":
 * "over_email_send_rate_limit"}` whenever the mail quota is spent or the
 * per-address minimum interval has not elapsed. The asymmetry is structural
 * rather than incidental: GoTrue consults the mail rate limiter only on the
 * code path that actually sends a message, and that path exists only for an
 * address that has an account. So one request per address, with no
 * credentials, sorted the registered from the unregistered — deterministically,
 * in all three languages, on the first try — while the page printed a sentence
 * promising it could not.
 *
 * The rule that replaces the old one: a failure is shown only when this screen
 * can prove it says nothing about the address. That is a short list —
 * unreachable network, no auth project configured, a malformed address, a
 * refused field — and it is written out below rather than derived, because the
 * safe default for anything not on it is the confirmation. Showing the
 * confirmation for a send that did not happen costs one reader one wasted look
 * at an inbox; showing the failure costs every reader on a list their privacy.
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
  SIGN_IN_PATH,
  emailProblem,
  useSessionActions,
} from '../features/auth'
import type { AuthFailureCode } from '../lib/supabase'

/**
 * The failures this screen may render, because each is a fact about the
 * request or about the string that was typed, and none of them can be reached
 * only for an address that has an account.
 *
 * Everything else — `RATE_LIMITED`, `EMAIL_SEND_LIMITED`, `UNKNOWN`, anything
 * a later Supabase release adds — renders the confirmation instead. See the
 * header: the list is an allow-list on purpose, so a code nobody has thought
 * about yet fails closed.
 */
const ADDRESS_INDEPENDENT_FAILURES: ReadonlySet<AuthFailureCode> = new Set([
  'NETWORK_UNREACHABLE',
  'AUTH_UNAVAILABLE',
  'EMAIL_INVALID',
  'INVALID_INPUT',
])

export function RequestPasswordResetRoute() {
  const { t } = useTranslation('auth')
  const actions = useSessionActions()

  const [email, setEmail] = useState('')
  const [emailError, setEmailError] = useState<string | null>(null)
  const [failure, setFailure] = useState<AuthFailureCode | null>(null)
  const [pending, setPending] = useState(false)
  /** The address the request was made for — never whether it exists. */
  const [requestedFor, setRequestedFor] = useState<string | null>(null)

  const emailRef = useRef<HTMLInputElement>(null)

  function submit(event: FormEvent<HTMLFormElement>): void {
    event.preventDefault()
    if (pending) return

    const emailIssue = emailProblem(email)
    // Committed before the focus move — see the note in `sign-in.tsx`.
    flushSync(() => {
      setEmailError(emailIssue === null ? null : t(`validation.${emailIssue}`))
    })
    if (emailIssue !== null) {
      emailRef.current?.focus()
      return
    }

    const address = email.trim()
    setFailure(null)
    setPending(true)
    void actions.requestPasswordReset(address).then((outcome) => {
      setPending(false)
      if (outcome.ok || !ADDRESS_INDEPENDENT_FAILURES.has(outcome.code)) {
        setRequestedFor(address)
        return
      }
      setFailure(outcome.code)
    })
  }

  if (requestedFor !== null) {
    return (
      <AuthPage title={t('reset.title')}>
        <AuthNotice>
          <p>{t('reset.sent', { email: requestedFor })}</p>
          <p>{t('reset.privacy')}</p>
        </AuthNotice>
        <p className="auth-links">
          <Link to={SIGN_IN_PATH}>{t('reset.backToSignIn')}</Link>
        </p>
      </AuthPage>
    )
  }

  return (
    <AuthPage title={t('reset.title')} lead={t('reset.lead')}>
      <form className="auth-form" noValidate onSubmit={submit}>
        {failure === null ? null : <AuthErrorAlert code={failure} />}

        <AuthField
          label={t('fields.email')}
          type="email"
          name="email"
          // No password on this form, so `email` is the token that describes
          // it. `username` would ask a password manager to fill a login.
          autoComplete="email"
          value={email}
          onChange={setEmail}
          error={emailError ?? undefined}
          inputRef={emailRef}
          busy={pending}
        />

        {/* `aria-disabled` rather than `disabled` — see `sign-in.tsx`. */}
        <button className="page__cta" type="submit" aria-disabled={pending}>
          {t('reset.submit')}
        </button>

        {pending ? (
          <p className="auth-form__pending" role="status">
            {t('reset.pending')}
          </p>
        ) : null}
      </form>

      <p className="auth-links">
        <Link to={SIGN_IN_PATH}>{t('reset.backToSignIn')}</Link>
      </p>
    </AuthPage>
  )
}
