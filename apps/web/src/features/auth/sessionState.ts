/**
 * Loading, signed in and signed out are THREE states.
 *
 * ── The bug this file exists to make unrepresentable ──────────────────────
 *
 * The natural shape is `user: User | null`, and it is wrong. supabase-js
 * reads its stored session from `localStorage` asynchronously — it has to,
 * because it may need to exchange a refresh token before it knows who the
 * user is — so between the first render and that answer, `user` is `null` and
 * means "not known yet". A guard written against two states reads that `null`
 * as "signed out" and redirects an authenticated user to the login screen for
 * a frame or two on every hard refresh. The user sees a flash of a login form
 * on a page they are already allowed to see, and then the page. It looks like
 * a rendering glitch and it is an authorisation model that cannot express
 * ignorance.
 *
 * The mirror image is just as real and slightly worse: a sign-in route that
 * treats "not known yet" as "signed out" shows its form to somebody who is
 * already signed in, and then yanks it away.
 *
 * So the union below has three members and `user` is only reachable on one of
 * them. A component cannot read a user without having narrowed the status
 * first, and there is no value of this type that means "signed out" and
 * "still checking" at once.
 *
 * ── Why the shape is a union and not a boolean pair ───────────────────────
 *
 * `{ isLoading, user }` permits `{ isLoading: true, user: someone }`, which
 * has no meaning, and permits reading `user` without consulting `isLoading`,
 * which is the defect above wearing a seatbelt. A discriminated union costs
 * one `switch` at each guard and makes the invalid combinations unwritable.
 */

import type { Session, User } from '../../lib/supabase/index.js'

export type SessionStatus = 'loading' | 'authenticated' | 'anonymous'

/**
 * Just the identity the interface needs. Deliberately not Supabase's `User`:
 * that object carries `app_metadata`, `identities` and every provider token
 * response, and none of it belongs in a React context that a hundred
 * components can read. The profile the app displays comes from the API — it
 * is a row this project owns — and arrives through React Query.
 */
export interface SessionUser {
  /** The `sub` claim the API verifies. Same value as `User.id`. */
  readonly id: string
  /** Null on providers that do not release one. */
  readonly email: string | null
}

export type SessionState =
  | { readonly status: 'loading'; readonly user: null }
  | { readonly status: 'anonymous'; readonly user: null }
  | { readonly status: 'authenticated'; readonly user: SessionUser }

/** Before the stored session has been read. The initial value, and only that. */
export const LOADING_SESSION: SessionState = { status: 'loading', user: null }

/** Resolved, and nobody is signed in. */
export const ANONYMOUS_SESSION: SessionState = {
  status: 'anonymous',
  user: null,
}

export function toSessionUser(user: User): SessionUser {
  return { id: user.id, email: user.email ?? null }
}

/**
 * The resolved state for a session that has been read — `null` meaning there
 * is none, which is a real answer and never "not yet".
 */
export function resolvedSessionState(session: Session | null): SessionState {
  if (session === null) return ANONYMOUS_SESSION
  return { status: 'authenticated', user: toSessionUser(session.user) }
}

/**
 * Whether the person the app is serving has changed, which is the trigger for
 * throwing away everything React Query cached — see `SessionProvider`.
 *
 * Two cases return `false` on purpose:
 *
 *   - anything to `loading`. The state machine never goes back, but if it
 *     did, evicting on "we stopped knowing" would clear the cache on a
 *     transient rather than on a change.
 *   - `loading` to anything. That is the first resolution of this page load.
 *     The query cache is constructed fresh in `main.tsx` and nothing has
 *     persisted into it from an earlier visit, so there is no other user's
 *     data to discard — and evicting here would cancel the queries a route
 *     fired on its first paint, on every single load.
 *
 * Everything else compares identities, including the transitions through
 * anonymous. `A → anonymous → B` is the shape of two people sharing a
 * browser, and it is the case the eviction exists for.
 */
export function isUserChange(
  previous: SessionState,
  next: SessionState
): boolean {
  if (previous.status === 'loading' || next.status === 'loading') return false
  return previous.user?.id !== next.user?.id
}
