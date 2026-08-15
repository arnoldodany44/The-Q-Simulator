/**
 * The slice of supabase-js this app is allowed to touch, as one interface.
 *
 * ── Why a port and not `SupabaseClient` everywhere ────────────────────────
 *
 * Three reasons, in order of how much they cost when ignored.
 *
 * **Tests.** A real client opens `localStorage`, installs `visibilitychange`
 * and `online` listeners, and starts a refresh timer the moment it is
 * constructed. Every session test would then be a test of jsdom's storage and
 * of a timer. Against this interface a test double is an object literal, the
 * three states are driven by calling `emit()`, and nothing is mocked.
 *
 * **Scope.** `SupabaseClient` also carries `.from()`, `.storage` and
 * `.realtime` — a Postgres client, in the browser, one autocomplete away.
 * §12.3 says the frontend talks to the API and never to the database; this
 * app has no `@qsim/db` import to forbid, but `supabase.from('circuits')`
 * would be exactly the same mistake wearing a different name. It is not on
 * this interface, so it cannot be reached from the session layer.
 *
 * **Surface.** Everything here is used. When a later milestone needs MFA or
 * identity linking, adding it is a deliberate line in this file rather than a
 * discovery in review.
 *
 * ── How the narrowing is kept honest ──────────────────────────────────────
 *
 * `authPortOf` is the only construction site, and it is a plain return of
 * `client.auth`. That single assignment is a compile-time proof that the real
 * client satisfies this interface: if supabase-js changes a signature, this
 * file fails to typecheck rather than some component failing at runtime. The
 * return types below are deliberately *looser* than the library's — it
 * discriminates `{ data, error: null } | { data: nulls, error: AuthError }`,
 * and none of the callers here destructure `data` on a failure path, so the
 * simpler shape is both assignable and easier to build in a test.
 */

import type {
  AuthChangeEvent,
  AuthError,
  Provider,
  Session,
  SupabaseClient,
  User,
} from '@supabase/supabase-js'

export type {
  AuthChangeEvent,
  AuthError,
  Provider,
  Session,
  User,
} from '@supabase/supabase-js'

/** What `onAuthStateChange` hands back so a listener can be removed. */
export interface AuthSubscription {
  unsubscribe: () => void
}

export interface EmailPasswordCredentials {
  readonly email: string
  readonly password: string
}

export interface SupabaseAuthPort {
  /**
   * The stored session, refreshed first if it has expired.
   *
   * Asynchronous, and that asynchrony is the whole of the three-state problem
   * (`features/auth/sessionState.ts`): on a hard refresh there is a window in
   * which the app does not yet know whether anybody is signed in.
   */
  getSession(): Promise<{
    data: { session: Session | null }
    error: AuthError | null
  }>

  /**
   * Every subsequent change, plus one `INITIAL_SESSION` event once the stored
   * session has been read — which is what resolves the loading state.
   *
   * The synchronous overload on purpose. supabase-js deprecated the async one
   * because a callback that triggers a refresh from inside a
   * `TOKEN_REFRESHED` event deadlocks against the refresh that is still
   * settling. Nothing this app does in a listener needs to await anything.
   */
  onAuthStateChange(
    callback: (event: AuthChangeEvent, session: Session | null) => void
  ): { data: { subscription: AuthSubscription } }

  /*
   * The six actions report failure as `unknown` rather than as `AuthError`,
   * and that is deliberate on both sides of the port. Callers must go through
   * `authFailureCode`, which takes `unknown` because a thrown `TypeError` and
   * a returned `AuthError` have to reach the same place — so nothing is
   * gained by narrowing here, and narrowing would cost the test double the
   * ability to script a failure at all: `AuthError` has a protected field, so
   * only a real instance satisfies it and a plain object never can.
   *
   * `getSession` keeps the real type, because `accessToken.ts` rethrows what
   * it finds there and rethrowing an `unknown` is how a stack trace goes
   * missing.
   */
  signInWithPassword(
    credentials: EmailPasswordCredentials
  ): Promise<{ error: unknown }>

  signUp(
    credentials: EmailPasswordCredentials & {
      options?: { emailRedirectTo?: string }
    }
  ): Promise<{
    data: { session: Session | null; user: User | null }
    error: unknown
  }>

  signInWithOAuth(credentials: {
    provider: Provider
    options?: { redirectTo?: string }
  }): Promise<{ error: unknown }>

  signOut(): Promise<{ error: unknown }>

  resetPasswordForEmail(
    email: string,
    options?: { redirectTo?: string }
  ): Promise<{ error: unknown }>

  /**
   * Another confirmation message for an account that has not opened the first
   * one.
   *
   * The `type` is narrowed to `signup` because that is the only resend this
   * app has a route for: `email_change` and `phone_change` belong to flows it
   * does not have, and widening the parameter would be an invitation to send a
   * message nothing on any screen has asked for.
   */
  resend(attributes: {
    type: 'signup'
    email: string
    options?: { emailRedirectTo?: string }
  }): Promise<{ error: unknown }>

  updateUser(attributes: { password: string }): Promise<{ error: unknown }>
}

/**
 * Narrows a real client to the port. The assignment is the proof; there is
 * deliberately no cast, so a breaking change upstream is a compile error here.
 *
 * The parameter is `Pick<SupabaseClient, 'auth'>` rather than the whole
 * client because `SupabaseClient` is generic over a database schema and its
 * five type arguments have already changed defaults once. `auth` is the same
 * type at every instantiation, so picking it accepts any client and keeps the
 * proof intact — while also stating, in the signature, that this is the only
 * property the app is allowed to reach for.
 */
export function authPortOf(
  client: Pick<SupabaseClient, 'auth'>
): SupabaseAuthPort {
  return client.auth
}
