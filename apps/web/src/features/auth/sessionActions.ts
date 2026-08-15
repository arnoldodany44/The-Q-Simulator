/**
 * The seven things a user can do to their session, as plain functions.
 *
 * Deliberately not hooks and not a component: the whole file is testable by
 * calling it, and `SessionProvider` does nothing but build one of these and
 * put it on a context. Every one of them answers with a result rather than
 * throwing, because every one of them is called from a form submit handler
 * where "wrong password" is an ordinary outcome and not an exception.
 *
 * ── The result type carries a code, never a sentence ──────────────────────
 *
 * Same rule as the API (§11, D2): the transport layer produces machine-
 * readable codes and the screen translates them. Supabase's `error.message`
 * is English written by the auth server and it never leaves
 * `lib/supabase/authErrors.ts`. A form renders `t(authErrorMessageKey(code))`
 * and gets Spanish, English or French from one catalog that a parity test
 * keeps in step.
 *
 * ── Sign-up returns more than "ok" on purpose ─────────────────────────────
 *
 * Email confirmation is currently switched on for this project, so
 * registering does NOT sign you in: Supabase answers with a user and no
 * session, and the account cannot authenticate until the link in the inbox is
 * clicked. A flow that treats sign-up as sign-in leaves the new user at a
 * login form that rejects their brand-new, correct password, with no
 * explanation — the single most common way this setup goes wrong. So the
 * outcome says which of the two happened, read from the response rather than
 * from configuration, and the screen says "check your inbox" when it must.
 *
 * The same answer comes back when the address is already registered: Supabase
 * returns a user-shaped object and no session rather than admitting the
 * account exists, and that is the behaviour to preserve — "we sent you a
 * message" leaks nothing, while "that email is taken" turns a login form into
 * a membership oracle.
 */

import {
  authFailureCode,
  type AuthFailureCode,
  type EmailPasswordCredentials,
  type Provider,
} from '../../lib/supabase/index.js'

import { PASSWORD_UPDATE_PATH, absoluteAppUrl } from './paths.js'
import type { AuthRuntime } from './runtime.js'

export type AuthOutcome =
  { readonly ok: true } | { readonly ok: false; readonly code: AuthFailureCode }

export type SignUpOutcome =
  | {
      readonly ok: true
      /** True when no session came back: the inbox is the next step. */
      readonly confirmationRequired: boolean
    }
  | { readonly ok: false; readonly code: AuthFailureCode }

export interface SignInWithProviderOptions {
  /** Where to come back to. An app path; validated before it is used. */
  readonly redirectPath?: string
}

export interface SessionActions {
  signIn(credentials: EmailPasswordCredentials): Promise<AuthOutcome>
  signUp(credentials: EmailPasswordCredentials): Promise<SignUpOutcome>
  signInWithProvider(
    provider: string,
    options?: SignInWithProviderOptions
  ): Promise<AuthOutcome>
  signOut(): Promise<AuthOutcome>
  requestPasswordReset(email: string): Promise<AuthOutcome>
  /**
   * Another registration confirmation link.
   *
   * The flow this milestone was written around dead-ended without it: with
   * confirmation on, an account that never opened its link cannot sign in, the
   * screen correctly says so, and nothing anywhere could produce a second one.
   * Unlike `requestPasswordReset` this discloses nothing new — it is only ever
   * offered to somebody the server has already answered `email_not_confirmed`,
   * or immediately after their own registration.
   */
  resendConfirmation(email: string): Promise<AuthOutcome>
  /** Completing a reset, from the recovery session the link established. */
  updatePassword(password: string): Promise<AuthOutcome>
}

const OK: AuthOutcome = { ok: true }

/** The answer every action gives when this deployment has no auth project. */
const UNAVAILABLE: AuthOutcome = { ok: false, code: 'AUTH_UNAVAILABLE' }

/** The same answer, in the shape sign-up promises. */
const UNAVAILABLE_SIGN_UP: SignUpOutcome = UNAVAILABLE

function failure(code: AuthFailureCode): AuthOutcome {
  return { ok: false, code }
}

/**
 * Runs a Supabase call, turning both an `{ error }` result and a thrown value
 * into the same outcome.
 *
 * Both paths are real. supabase-js reports server rejections through `error`,
 * but a bug in this code, a `TypeError` from a runtime without `fetch`, or an
 * abort still throw — and an unhandled rejection inside a submit handler
 * leaves a form spinning with no message at all.
 */
async function attempt(
  call: () => Promise<{ error: unknown }>
): Promise<AuthOutcome> {
  try {
    const { error } = await call()
    const code = authFailureCode(error)
    return code === null ? OK : failure(code)
  } catch (thrown) {
    return failure(authFailureCode(thrown) ?? 'UNKNOWN')
  }
}

export interface SessionActionsOptions {
  /** `null` when no Supabase project is configured for this deployment. */
  readonly runtime: AuthRuntime | null
  /** This app's origin, for the links Supabase mails and redirects to. */
  readonly origin: string
}

export function createSessionActions({
  runtime,
  origin,
}: SessionActionsOptions): SessionActions {
  if (runtime === null) {
    /*
     * No project configured. Every action refuses with a code the UI can
     * translate, rather than the alternative of throwing at a form: a
     * deployment without accounts is a supported state (see
     * `lib/supabase/config.ts`) and the public half of the app still works.
     */
    return {
      signIn: () => Promise.resolve(UNAVAILABLE),
      signUp: () => Promise.resolve(UNAVAILABLE_SIGN_UP),
      signInWithProvider: () => Promise.resolve(UNAVAILABLE),
      signOut: () => Promise.resolve(UNAVAILABLE),
      requestPasswordReset: () => Promise.resolve(UNAVAILABLE),
      resendConfirmation: () => Promise.resolve(UNAVAILABLE),
      updatePassword: () => Promise.resolve(UNAVAILABLE),
    }
  }

  const { auth } = runtime

  return {
    signIn: (credentials) =>
      attempt(() => auth.signInWithPassword(credentials)),

    signUp: async ({ email, password }) => {
      try {
        const { data, error } = await auth.signUp({
          email,
          password,
          // Where the confirmation link lands. The user arrives already
          // signed in, so the app root is the right destination.
          options: { emailRedirectTo: origin },
        })

        const code = authFailureCode(error)
        if (code !== null) return { ok: false, code }

        // A session means confirmation is off and the user is already in. No
        // session means the link is in flight — see the header.
        return { ok: true, confirmationRequired: data.session === null }
      } catch (thrown) {
        return { ok: false, code: authFailureCode(thrown) ?? 'UNKNOWN' }
      }
    },

    signInWithProvider: (provider, options = {}) =>
      attempt(() =>
        auth.signInWithOAuth({
          /*
           * The provider name came from the project's own settings document,
           * so it is whatever that project has enabled — including one added
           * after this bundle was built, which is the entire point of
           * discovering providers instead of listing them. supabase-js types
           * the parameter as a union of the providers it knew about at
           * publication, so a widening cast is unavoidable here and is the
           * honest spelling of "the server decides".
           */
          provider: provider as Provider,
          ...(options.redirectPath === undefined
            ? {}
            : {
                options: {
                  redirectTo: absoluteAppUrl(options.redirectPath, origin),
                },
              }),
        })
      ),

    signOut: () => attempt(() => auth.signOut()),

    requestPasswordReset: (email) =>
      attempt(() =>
        auth.resetPasswordForEmail(email, {
          // The link has to land on the screen that can actually set a new
          // password, holding the recovery session it establishes.
          redirectTo: absoluteAppUrl(PASSWORD_UPDATE_PATH, origin),
        })
      ),

    resendConfirmation: (email) =>
      attempt(() =>
        auth.resend({
          type: 'signup',
          email,
          // The same destination the original registration used, so both
          // links land in the same place.
          options: { emailRedirectTo: origin },
        })
      ),

    updatePassword: (password) => attempt(() => auth.updateUser({ password })),
  }
}
