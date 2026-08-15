/**
 * The route guards, and the two flashes they exist to prevent.
 *
 * ── Neither guard may decide anything while the session is unknown ────────
 *
 * A guard that treats `loading` as signed-out bounces an authenticated user
 * to the login screen on every hard refresh — for one or two frames, long
 * enough to see, short enough that it reads as a glitch rather than a bug.
 * The mirror image is `RedirectWhenSignedIn`: a sign-in route that treats
 * `loading` as signed-out shows its form to somebody who is already in, then
 * takes it away. Worse, the form is focusable in that window, so a fast typist
 * loses a keystroke into a component that is about to unmount.
 *
 * Both are prevented the same way: while the status is `loading`, neither
 * guard renders its subject and neither navigates. What is on screen is a
 * status line — not the protected page, not the login form, and not `null`,
 * because a blank frame on a slow session is indistinguishable from a broken
 * route and says nothing to a screen reader.
 *
 * ── The client is a convenience, never the control ────────────────────────
 *
 * §11: authorisation is verified on the server, always. `RequireSession`
 * saves a signed-out visitor a pointless round trip and a 401 they cannot
 * read; it is not what stops them reading a private circuit. Removing it
 * changes what is comfortable, not what is permitted — every route it covers
 * is already covered by `auth: 'required'` in `apps/api`, and the API is what
 * decides.
 *
 * ── Redirecting back afterwards ───────────────────────────────────────────
 *
 * The destination travels in history state rather than in a `?next=` query
 * parameter. An UNLISTED circuit's slug is its access control (§11) and a
 * query parameter would carry it into history, into `Referer` headers and
 * into anything the user pastes — see `paths.ts`.
 */

import { useTranslation } from 'react-i18next'
import { Navigate, useLocation } from 'react-router'
import type { Location } from 'react-router'
import type { ReactNode } from 'react'

import { useSession } from './SessionContext.js'
import {
  DEFAULT_SIGNED_IN_PATH,
  INTENDED_PATH_STATE_KEY,
  SIGN_IN_PATH,
  intendedPathFrom,
} from './paths.js'

/**
 * What is on screen while the stored session is being read.
 *
 * `role="status"` rather than a bare paragraph: the wait is usually a few
 * milliseconds and occasionally a token refresh over a bad connection, and in
 * the second case somebody using a screen reader needs to be told that the
 * page is working rather than finished. `aria-live` is polite by definition
 * on `status`, so it never interrupts.
 */
export function SessionPending() {
  const { t } = useTranslation('common')
  return (
    <p className="page page__loading" role="status">
      {t('loading')}
    </p>
  )
}

/**
 * Where the user was trying to go, as a path this app can navigate back to.
 *
 * The hash is deliberately dropped. It is where an implicit-flow OAuth
 * response would put an access token, and although this app uses PKCE
 * precisely so that never happens, carrying a fragment into a stored redirect
 * target is how a credential ends up persisted in a history entry.
 */
function currentPath(location: Location): string {
  return `${location.pathname}${location.search}`
}

export interface RequireSessionProps {
  readonly children: ReactNode
  /** Where an anonymous visitor is sent. Overridable for a nested flow. */
  readonly signInPath?: string
}

/** Renders `children` only for a signed-in user. */
export function RequireSession({
  children,
  signInPath = SIGN_IN_PATH,
}: RequireSessionProps) {
  const session = useSession()
  const location = useLocation()

  if (session.status === 'loading') return <SessionPending />

  if (session.status === 'anonymous') {
    return (
      <Navigate
        to={signInPath}
        // `replace`, so that pressing Back from the sign-in screen does not
        // land on the guarded route and bounce straight back here — a loop
        // the user cannot escape with the one control they reached for.
        replace
        state={{ [INTENDED_PATH_STATE_KEY]: currentPath(location) }}
      />
    )
  }

  return <>{children}</>
}

export interface RedirectWhenSignedInProps {
  readonly children: ReactNode
  /** Where to go instead, when no destination was recorded. */
  readonly fallbackPath?: string
}

/**
 * The mirror guard, for the sign-in and sign-up routes: a user who is already
 * signed in has no business being shown a login form.
 */
export function RedirectWhenSignedIn({
  children,
  fallbackPath = DEFAULT_SIGNED_IN_PATH,
}: RedirectWhenSignedInProps) {
  const session = useSession()
  const location = useLocation()

  if (session.status === 'loading') return <SessionPending />

  if (session.status === 'authenticated') {
    const intended = intendedPathFrom(location.state)
    return (
      <Navigate
        to={intended === DEFAULT_SIGNED_IN_PATH ? fallbackPath : intended}
        replace
      />
    )
  }

  return <>{children}</>
}
