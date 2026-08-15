/**
 * A Supabase auth port that never touches a network, with the clock in the
 * test's hands.
 *
 * The reason this exists rather than a mocking library: the thing under test
 * is a *state machine over time* — the window between "the page rendered" and
 * "supabase-js finished reading storage" is exactly where the three-state bug
 * lives, and a stub that resolves immediately cannot express it. Here
 * `getSession()` hangs until the test calls `settle()`, so the loading state
 * is a state the test can assert on rather than a frame it has to race.
 *
 * Imported only from `*.test.ts(x)`, and a boundary rule enforces that: this
 * file would otherwise be a fake session provider sitting inside the shipped
 * bundle, and the tests would go on passing.
 */

import type {
  AuthChangeEvent,
  Session,
  SupabaseAuthPort,
  SupabaseConfig,
  User,
} from '../../lib/supabase/index.js'

/** A configuration that names nothing real. */
export const TEST_SUPABASE_CONFIG: SupabaseConfig = {
  url: 'https://project.supabase.test',
  publishableKey: 'sb_publishable_test',
}

/** The shape supabase-js gives an `AuthError`: a code, a status, a message. */
export function authError(
  code: string,
  status = 400
): Error & {
  code: string
  status: number
} {
  return Object.assign(
    // Deliberately English and deliberately unlike anything in a catalog: a
    // test that finds this string on screen has found a real defect.
    new Error('Developer-facing text the client must never display.'),
    { code, status }
  )
}

/** A session for a user, with only the fields this app reads. */
export function fakeSession(
  id: string,
  email: string | null = `${id}@example.test`
): Session {
  return {
    access_token: `token-for-${id}`,
    refresh_token: `refresh-for-${id}`,
    expires_in: 3600,
    token_type: 'bearer',
    // `User` carries a dozen fields this app never reads (app_metadata,
    // identities, factors). Only the two `SessionUser` keeps are real here,
    // which is itself the assertion that nothing else is being relied on.
    user: { id, email: email ?? undefined } as User,
  }
}

/** Every call the port received, for asserting what was sent and when. */
export interface AuthCallLog {
  readonly signInWithPassword: { email: string; password: string }[]
  readonly signUp: {
    email: string
    password: string
    emailRedirectTo: string | undefined
  }[]
  readonly signInWithOAuth: {
    provider: string
    redirectTo: string | undefined
  }[]
  /* Counters rather than argument lists: neither call takes anything worth
     recording, and how many times each happened is the assertion. */
  signOut: number
  getSession: number
  readonly resetPasswordForEmail: {
    email: string
    redirectTo: string | undefined
  }[]
  readonly resend: { email: string; emailRedirectTo: string | undefined }[]
  readonly updateUser: { password: string }[]
}

/**
 * What each action answers. Mutable so a test can script one failure without
 * rebuilding the port, which keeps a "then it succeeds" assertion in the same
 * test as the failure it follows.
 */
export interface AuthScript {
  signInError: unknown
  signUpError: unknown
  /** Null models email confirmation being on: a user, and no session yet. */
  signUpSession: Session | null
  signInWithOAuthError: unknown
  signOutError: unknown
  resetPasswordError: unknown
  resendError: unknown
  updateUserError: unknown
  /**
   * Made to reject, for the "the stored session is unreadable" path. Typed as
   * an `Error` rather than `unknown` because it is *thrown* rather than
   * returned, and throwing a non-error is how a stack trace goes missing.
   */
  getSessionThrows: Error | null
}

export interface FakeAuthPort extends SupabaseAuthPort {
  /** Resolves the pending `getSession()` and ends the loading state. */
  readonly settle: (session: Session | null) => void
  /** Delivers an auth event to every live listener. */
  readonly emit: (event: AuthChangeEvent, session: Session | null) => void
  /** How many listeners are subscribed — zero after a clean unmount. */
  readonly listenerCount: () => number
  readonly calls: AuthCallLog
  readonly script: AuthScript
}

export interface FakeAuthOptions {
  /**
   * Answer `getSession()` immediately with this session instead of hanging.
   * Use for tests that are not about the loading window.
   */
  readonly settled?: Session | null
}

export function createFakeAuth(options: FakeAuthOptions = {}): FakeAuthPort {
  const listeners = new Set<
    (event: AuthChangeEvent, session: Session | null) => void
  >()

  const calls: AuthCallLog = {
    signInWithPassword: [],
    signUp: [],
    signInWithOAuth: [],
    signOut: 0,
    resetPasswordForEmail: [],
    resend: [],
    updateUser: [],
    getSession: 0,
  }

  const script: AuthScript = {
    signInError: null,
    signUpError: null,
    signUpSession: null,
    signInWithOAuthError: null,
    signOutError: null,
    resetPasswordError: null,
    resendError: null,
    updateUserError: null,
    getSessionThrows: null,
  }

  let current: Session | null = options.settled ?? null
  /*
   * `getSession()` waits on this gate, so a test that does not pass `settled`
   * holds the provider in its loading state for as long as it likes.
   */
  let release = (): void => {}
  const gate = new Promise<void>((resolve) => {
    release = resolve
  })
  if (options.settled !== undefined) release()

  const port: FakeAuthPort = {
    getSession: async () => {
      calls.getSession += 1
      await gate
      if (script.getSessionThrows !== null) throw script.getSessionThrows
      return { data: { session: current }, error: null }
    },

    onAuthStateChange: (callback) => {
      listeners.add(callback)
      return {
        data: {
          subscription: {
            unsubscribe: () => {
              listeners.delete(callback)
            },
          },
        },
      }
    },

    signInWithPassword: ({ email, password }) => {
      calls.signInWithPassword.push({ email, password })
      return Promise.resolve({ error: script.signInError })
    },

    signUp: ({ email, password, options: signUpOptions }) => {
      calls.signUp.push({
        email,
        password,
        emailRedirectTo: signUpOptions?.emailRedirectTo,
      })
      return Promise.resolve({
        data: {
          session: script.signUpSession,
          user: script.signUpSession?.user ?? ({ id: 'new-user' } as User),
        },
        error: script.signUpError,
      })
    },

    signInWithOAuth: ({ provider, options: oauthOptions }) => {
      calls.signInWithOAuth.push({
        provider,
        redirectTo: oauthOptions?.redirectTo,
      })
      return Promise.resolve({ error: script.signInWithOAuthError })
    },

    signOut: () => {
      calls.signOut += 1
      return Promise.resolve({ error: script.signOutError })
    },

    resetPasswordForEmail: (email, resetOptions) => {
      calls.resetPasswordForEmail.push({
        email,
        redirectTo: resetOptions?.redirectTo,
      })
      return Promise.resolve({ error: script.resetPasswordError })
    },

    resend: ({ email, options: resendOptions }) => {
      calls.resend.push({
        email,
        emailRedirectTo: resendOptions?.emailRedirectTo,
      })
      return Promise.resolve({ error: script.resendError })
    },

    updateUser: ({ password }) => {
      calls.updateUser.push({ password })
      return Promise.resolve({ error: script.updateUserError })
    },

    settle: (session) => {
      current = session
      release()
    },

    emit: (event, session) => {
      current = session
      for (const listener of [...listeners]) listener(event, session)
    },

    listenerCount: () => listeners.size,
    calls,
    script,
  }

  return port
}
