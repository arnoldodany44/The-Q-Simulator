/**
 * The contexts the session provider fills, and the hooks that read them.
 *
 * ── Why three contexts and not one object ─────────────────────────────────
 *
 * They change at completely different rates. The session state changes on
 * every auth event — sign-in, sign-out, and a token refresh every hour in
 * every open tab. The actions and the runtime never change at all.
 *
 * With one context, a sign-in form re-renders on every token refresh in order
 * to read a `signIn` function that is the same function it already had. With
 * three, a component subscribes to precisely what it uses: a guard reads the
 * state, a form reads the actions, and the provider-discovery hook reads the
 * runtime. It costs two extra `createContext` calls.
 *
 * ── Why the default is `null` and the hooks throw ─────────────────────────
 *
 * The tempting default for the state context is `LOADING_SESSION`, and it is
 * a trap: a component rendered outside the provider would sit in the loading
 * state forever, which looks exactly like a slow network and nothing in the
 * console would say otherwise. `useApiClient` made the same call for the same
 * reason — a missing provider should say "there is no provider".
 *
 * These live in a `.ts` file rather than beside the component because
 * `react-refresh/only-export-components` is right: a module that exports both
 * a component and a hook loses fast refresh for the component.
 */

import { createContext, useContext } from 'react'

import type { AuthRuntime } from './runtime.js'
import type { SessionActions } from './sessionActions.js'
import type { SessionState } from './sessionState.js'

export const SessionStateContext = createContext<SessionState | null>(null)
export const SessionActionsContext = createContext<SessionActions | null>(null)

/**
 * `null` twice over, meaning two different things — which is why the hook
 * below does not throw on it. The context is absent when there is no
 * provider; the *value* is null when the provider has no Supabase project
 * configured. Only the first is a programming error.
 */
export const AuthRuntimeContext = createContext<AuthRuntime | null>(null)

function missingProvider(hook: string): Error {
  return new Error(
    `${hook} must be used inside <SessionProvider>. Wrap the tree in ` +
      'main.tsx, or render the provider explicitly in a test.'
  )
}

/**
 * The three-state session: `loading`, `authenticated` or `anonymous`.
 *
 * Callers must narrow on `status` before reading `user` — see
 * `sessionState.ts` for why treating `loading` as signed-out is a defect
 * rather than a simplification.
 */
export function useSession(): SessionState {
  const state = useContext(SessionStateContext)
  if (state === null) throw missingProvider('useSession')
  return state
}

export function useSessionActions(): SessionActions {
  const actions = useContext(SessionActionsContext)
  if (actions === null) throw missingProvider('useSessionActions')
  return actions
}

/** The Supabase runtime, or `null` when this deployment has no auth. */
export function useAuthRuntime(): AuthRuntime | null {
  return useContext(AuthRuntimeContext)
}
