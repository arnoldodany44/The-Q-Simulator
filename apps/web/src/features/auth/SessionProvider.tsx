/**
 * Who is signed in, kept current for as long as the tab is open.
 *
 * ── Resolving the three states ────────────────────────────────────────────
 *
 * The provider starts in `loading` and leaves it exactly once. Two things can
 * end it, and both are wired because they fail differently:
 *
 *   1. `onAuthStateChange` emits `INITIAL_SESSION` as soon as supabase-js has
 *      read (and if necessary refreshed) the stored session. This is the
 *      documented path and the one that also delivers every later change.
 *   2. `getSession()` answers the same question directly. It is here as a
 *      floor: if the initial event were ever not to arrive — a storage read
 *      that throws, a version that stops emitting it — the app would sit in
 *      `loading` forever and every guarded route would show a spinner that
 *      never resolves. That is a far worse failure than one redundant read.
 *
 * The second only applies its answer **while the state is still `loading`**,
 * which is what keeps the redundancy from becoming a race: a late
 * `getSession` can never overwrite a newer `SIGNED_IN`, and it can never
 * produce the anonymous-then-authenticated flicker that would look like a
 * user change and throw away the cache for nothing.
 *
 * ── Discarding the previous user's cache ──────────────────────────────────
 *
 * When the user changes, everything React Query is holding belonged to
 * somebody else. Two people share a laptop, one signs out, the other signs in
 * — and without this, the second sees the first's private circuit list, from
 * cache, instantly, before any request goes out. It is a real leak and it
 * looks like a rendering bug.
 *
 * `resetQueries()`, and not either of the two obvious alternatives.
 *
 * `invalidateQueries()` marks data stale and refetches *while continuing to
 * serve the old data* — which is precisely the leak, just with a shorter
 * lifetime.
 *
 * `clear()` looks stronger and is weaker. It removes and destroys the cache
 * entries, so `getQueryData` really does answer `undefined` — but a
 * `QueryObserver` that is already subscribed keeps the result it last computed
 * and is never asked to fetch again. A component mounted across the change
 * therefore goes on rendering the previous user's data indefinitely, with no
 * request in between. Guarded routes hide that only because `RequireSession`
 * unmounts them; the editor at `/c/:slug` is deliberately not guarded — a
 * PUBLIC circuit has to stay readable — so it stays mounted through the
 * sign-out and the next sign-in, and that is where one person's private
 * circuit stayed on screen for the next one.
 *
 * `resetQueries()` puts every entry back to its initial state *and notifies
 * its observers*, so a mounted query renders nothing of the previous identity
 * and the active ones refetch immediately under the new one. It also cancels
 * whatever was in flight under the old token.
 *
 * The cost is that unrelated cached data is dropped too, including the
 * provider-discovery document. That is the right trade: an allow-list of
 * "queries that are safe to keep" is a list somebody has to remember to
 * update, and the failure mode of forgetting is a leak rather than a refetch.
 *
 * ── A token the server rejects ends the session here ──────────────────────
 *
 * supabase-js only checks a stored session's expiry, so a token whose
 * signature no longer verifies — the project's JWT key rotated, the user
 * deleted server-side — is served happily to every request while the API
 * answers 401 to all of them. Left alone, the app looks signed in, nothing
 * works, and the sentence on screen tells the reader to sign in again on a
 * screen with no sign-in control. `lib/api/errors.ts` already knows which
 * failures mean that (`requiresAuthentication`), so one subscription to the
 * query cache turns the dead state into the one the user can act on.
 *
 * It is deliberately keyed on the *API's* answer rather than on anything this
 * app guesses: `accessToken.ts` reads through `getSession()`, which refreshes
 * an expired token before returning it, so a 401 that survives that is a
 * credential the server will not accept at all.
 *
 * ── What this component deliberately does not do ──────────────────────────
 *
 * It does not touch the access token. supabase-js holds it, refreshes it on a
 * timer, and `lib/supabase/accessToken.ts` reads it per request — nothing
 * here copies it into state, into storage or into a log. It also does not
 * enforce anything: §11 puts authorisation on the server, and every rule this
 * UI appears to apply is already applied by the API.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import { useQueryClient } from '@tanstack/react-query'

import { requiresAuthentication } from '../../lib/api/errors.js'
import type { Session } from '../../lib/supabase/index.js'

import {
  AuthRuntimeContext,
  SessionActionsContext,
  SessionStateContext,
} from './SessionContext.js'
import type { AuthRuntime } from './runtime.js'
import { createSessionActions } from './sessionActions.js'
import {
  ANONYMOUS_SESSION,
  LOADING_SESSION,
  isUserChange,
  resolvedSessionState,
} from './sessionState.js'
import type { SessionState } from './sessionState.js'

export interface SessionProviderProps {
  /** `null` when this deployment has no Supabase project (see runtime.ts). */
  readonly runtime: AuthRuntime | null
  /**
   * This app's origin, for the links Supabase mails out. Injected so a test
   * does not assert against whatever origin its DOM implementation invented.
   */
  readonly origin?: string
  readonly children: ReactNode
}

/**
 * With no auth configured there is nothing to wait for, so the state starts
 * resolved. Beginning at `loading` and settling in an effect would give every
 * guard on such a deployment one pointless frame of "checking…".
 */
function initialState(runtime: AuthRuntime | null): SessionState {
  return runtime === null ? ANONYMOUS_SESSION : LOADING_SESSION
}

export function SessionProvider({
  runtime,
  origin = window.location.origin,
  children,
}: SessionProviderProps) {
  const queryClient = useQueryClient()
  const [state, setState] = useState<SessionState>(() => initialState(runtime))

  /*
   * The state as the last commit left it, which is not the same thing as
   * `state`: the auth listener fires outside React's render cycle, and a
   * closure over `state` would compare against whatever value that render
   * captured. The eviction decision has to be made against what was actually
   * last applied, so it is made against a ref.
   */
  const applied = useRef<SessionState>(initialState(runtime))

  const commit = useCallback(
    (next: SessionState) => {
      const previous = applied.current
      applied.current = next
      // See the header: reset rather than clear, so a query that is mounted
      // across the change is told, refetches, and renders nothing meanwhile.
      if (isUserChange(previous, next)) void queryClient.resetQueries()
      setState(next)
    },
    [queryClient]
  )

  useEffect(() => {
    /*
     * Nothing to subscribe to, and nothing to wait for: `initialState` has
     * already put the machine in `anonymous`, so there is no state to set
     * here. Setting it anyway would be a synchronous `setState` inside an
     * effect — a second render for a value that was correct on the first.
     */
    if (runtime === null) return

    let active = true

    const { data } = runtime.auth.onAuthStateChange((_event, session) => {
      if (!active) return
      commit(resolvedSessionState(session))
    })

    const settleIfStillUnknown = (session: Session | null) => {
      if (!active || applied.current.status !== 'loading') return
      commit(resolvedSessionState(session))
    }

    void runtime.auth
      .getSession()
      .then(({ data: read }) => {
        settleIfStillUnknown(read.session)
      })
      .catch((cause: unknown) => {
        /*
         * The stored session could not be read at all. Leaving the app in
         * `loading` would hang every guard, so it resolves to signed-out —
         * the state a user can act on, since the sign-in screen is reachable
         * from it and signing in writes a fresh session over the broken one.
         */
        console.error('the stored session could not be read', cause)
        settleIfStillUnknown(null)
      })

    return () => {
      active = false
      data.subscription.unsubscribe()
    }
  }, [runtime, commit])

  const actions = useMemo(
    () => createSessionActions({ runtime, origin }),
    [runtime, origin]
  )

  useEffect(() => {
    if (runtime === null) return

    /*
     * One subscription for the whole app rather than a check per screen: any
     * query can be the one that discovers the token is dead, and a rule that
     * has to be repeated on every screen is a rule one screen will miss.
     */
    return queryClient.getQueryCache().subscribe((event) => {
      if (event.type !== 'updated') return
      if (event.query.state.status !== 'error') return
      if (!requiresAuthentication(event.query.state.error)) return
      // Only from a session this app believes in: after the sign-out below the
      // same 401 can arrive from a request that was already in flight, and
      // signing out twice would be a second eviction for nothing.
      if (applied.current.status !== 'authenticated') return
      void actions.signOut()
    })
  }, [runtime, queryClient, actions])

  return (
    <AuthRuntimeContext.Provider value={runtime}>
      <SessionActionsContext.Provider value={actions}>
        <SessionStateContext.Provider value={state}>
          {children}
        </SessionStateContext.Provider>
      </SessionActionsContext.Provider>
    </AuthRuntimeContext.Provider>
  )
}
