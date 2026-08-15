/**
 * `/update-password` — the screen the emailed recovery link lands on.
 *
 * ── Why this route is not behind `RequireSession` ─────────────────────────
 *
 * Because both of its outcomes are correct pages, and the guard can only
 * produce one of them. The link carries a single-use `?code=`, which
 * supabase-js exchanges for a recovery session on load (`flowType: 'pkce'`,
 * `detectSessionInUrl: true` — see `lib/supabase/client.ts`). If the exchange
 * succeeds there is a session and the form is shown. If it fails — the link
 * was used, it expired, it was opened in a browser that never held the
 * verifier — there is no session, and the right answer is a sentence saying
 * so with a way to ask for another. `RequireSession` would instead bounce
 * that user to the sign-in screen, where nothing explains why the link they
 * just clicked did nothing.
 *
 * So the three session states are read directly, and all three are rendered:
 * `loading` while the exchange is in flight (never the form, never the
 * failure — that is the flash `sessionState.ts` exists to prevent, and here
 * it would be a false "your link is broken" shown to a perfectly good link),
 * `anonymous` as the expired-link explanation, `authenticated` as the form.
 *
 * A signed-in user who simply navigates here gets the same form, which is
 * correct: this is also how you change a password you still know.
 *
 * ── Why there is a second field ───────────────────────────────────────────
 *
 * The input is masked, the user cannot see what they typed, and getting it
 * wrong locks them out of the account they are in the middle of recovering —
 * recoverable only by another mail round trip. The repeat is not a rule
 * invented for the server to disagree with; it is a check on the one thing
 * the server cannot see, which is whether the string was the one intended.
 *
 * ── And why there is a third field nobody can see ─────────────────────────
 *
 * A change-password form with two `new-password` boxes and no account
 * identifier is, to a password manager, a pair of unrelated new-password
 * inputs: it has nothing to key the update to, so it offers to save a *new*
 * entry rather than to update the stale one. This is the one screen where that
 * costs the most, because it is the screen that makes the saved credential
 * stale. The signed-in address goes in a read-only `autocomplete="username"`
 * field, out of the tab order and out of the accessibility tree — it is for
 * the manager, and the reader already knows which account they are in.
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
  CIRCUITS_PATH,
  MAX_PASSWORD_BYTES,
  MIN_PASSWORD_LENGTH,
  PASSWORD_RESET_PATH,
  SessionPending,
  newPasswordProblem,
  useSession,
  useSessionActions,
} from '../features/auth'
import type { AuthFailureCode } from '../lib/supabase'

export function UpdatePasswordRoute() {
  const { t } = useTranslation('auth')
  const session = useSession()
  const actions = useSessionActions()

  const [password, setPassword] = useState('')
  const [repeat, setRepeat] = useState('')
  const [passwordError, setPasswordError] = useState<string | null>(null)
  const [repeatError, setRepeatError] = useState<string | null>(null)
  const [failure, setFailure] = useState<AuthFailureCode | null>(null)
  const [pending, setPending] = useState(false)
  const [done, setDone] = useState(false)

  const passwordRef = useRef<HTMLInputElement>(null)
  const repeatRef = useRef<HTMLInputElement>(null)

  const passwordLimits = {
    min: MIN_PASSWORD_LENGTH,
    max: MAX_PASSWORD_BYTES,
  }

  function submit(event: FormEvent<HTMLFormElement>): void {
    event.preventDefault()
    if (pending) return

    const passwordIssue = newPasswordProblem(password)
    const repeatIssue = password === repeat ? null : 'passwordMismatch'

    // Committed before the focus move — see the note in `sign-in.tsx`.
    flushSync(() => {
      setPasswordError(
        passwordIssue === null
          ? null
          : t(`validation.${passwordIssue}`, passwordLimits)
      )
      setRepeatError(
        repeatIssue === null ? null : t(`validation.${repeatIssue}`)
      )
    })

    if (passwordIssue !== null || repeatIssue !== null) {
      const target = passwordIssue !== null ? passwordRef : repeatRef
      target.current?.focus()
      return
    }

    setFailure(null)
    setPending(true)
    void actions.updatePassword(password).then((outcome) => {
      setPending(false)
      if (outcome.ok) {
        setDone(true)
        return
      }
      setFailure(outcome.code)
    })
  }

  // Never the form and never the failure while the code exchange is in
  // flight: both would be a claim about a session nobody has read yet.
  if (session.status === 'loading') return <SessionPending />

  if (done) {
    return (
      <AuthPage title={t('update.title')}>
        <AuthNotice>
          <p>{t('update.done')}</p>
        </AuthNotice>
        <p className="auth-links">
          <Link to={CIRCUITS_PATH}>{t('update.continue')}</Link>
        </p>
      </AuthPage>
    )
  }

  if (session.status === 'anonymous') {
    return (
      <AuthPage title={t('update.title')}>
        {/* The link, not the password, is what failed — and the next step is
            to ask for another one rather than to try again here. */}
        <AuthErrorAlert code="LINK_EXPIRED" />
        <p>{t('update.expired')}</p>
        <p className="auth-links">
          <Link to={PASSWORD_RESET_PATH}>{t('update.requestAnother')}</Link>
        </p>
      </AuthPage>
    )
  }

  return (
    <AuthPage title={t('update.title')} lead={t('update.lead')}>
      <form className="auth-form" noValidate onSubmit={submit}>
        {failure === null ? null : <AuthErrorAlert code={failure} />}

        {/* For the password manager, not for the reader. See the header. */}
        {session.user.email === null ? null : (
          <input
            className="visually-hidden"
            type="text"
            name="username"
            autoComplete="username"
            value={session.user.email}
            readOnly
            tabIndex={-1}
            aria-hidden="true"
          />
        )}

        <AuthField
          label={t('fields.newPassword')}
          type="password"
          name="password"
          autoComplete="new-password"
          value={password}
          onChange={setPassword}
          hint={t('fields.passwordHint', passwordLimits)}
          error={passwordError ?? undefined}
          inputRef={passwordRef}
          busy={pending}
        />

        <AuthField
          label={t('fields.repeatPassword')}
          type="password"
          name="password-repeat"
          autoComplete="new-password"
          value={repeat}
          onChange={setRepeat}
          error={repeatError ?? undefined}
          inputRef={repeatRef}
          busy={pending}
        />

        {/* `aria-disabled` rather than `disabled` — see `sign-in.tsx`. */}
        <button className="page__cta" type="submit" aria-disabled={pending}>
          {t('update.submit')}
        </button>

        {pending ? (
          <p className="auth-form__pending" role="status">
            {t('update.pending')}
          </p>
        ) : null}
      </form>
    </AuthPage>
  )
}
