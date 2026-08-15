/**
 * The two things an account screen has to say back, and how each is announced.
 *
 * ── A failure is an alert; a confirmation is a status ─────────────────────
 *
 * They are different live regions on purpose. `role="alert"` is assertive: it
 * interrupts, which is right for "that did not work, here is what to do" —
 * the user pressed a button and is waiting for the answer. `role="status"` is
 * polite: it waits for a pause, which is right for "we sent you a link", a
 * sentence that is usually rendered alongside a heading the user is about to
 * read anyway.
 *
 * Getting this backwards is a real defect and an invisible one: a polite
 * failure message is announced after whatever the user does next, so the
 * screen-reader user hears "invalid credentials" while typing their password
 * again, and an assertive confirmation talks over the page it just replaced.
 *
 * ── The code never becomes a sentence anywhere else ──────────────────────
 *
 * `authErrorMessageKey` is the single mapping from Supabase's machine-readable
 * code to a catalog key, and `authCatalog.test.ts` holds the three catalogs to
 * exactly the code list. So every screen renders failures through this
 * component rather than reaching for `t()` with a key it assembles itself —
 * which is how one screen ends up with a sentence the other two do not have.
 */

import { useTranslation } from 'react-i18next'
import type { ReactNode } from 'react'

import { authErrorMessageKey } from '../../lib/supabase/index.js'
import type { AuthFailureCode } from '../../lib/supabase/index.js'

export interface AuthErrorAlertProps {
  readonly code: AuthFailureCode
}

/** What went wrong, in the reader's language, naming their next step. */
export function AuthErrorAlert({ code }: AuthErrorAlertProps) {
  const { t } = useTranslation('auth')
  return (
    <p className="auth-alert" role="alert">
      {t(authErrorMessageKey(code))}
    </p>
  )
}

export interface AuthNoticeProps {
  readonly children: ReactNode
}

/** Something worked, or something is about to arrive in an inbox. */
export function AuthNotice({ children }: AuthNoticeProps) {
  return (
    <div className="auth-notice" role="status">
      {children}
    </div>
  )
}
