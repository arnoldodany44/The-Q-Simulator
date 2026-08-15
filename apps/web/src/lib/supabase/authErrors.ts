/**
 * Turning whatever supabase-js threw into a code this app has three
 * sentences for — D2, §11.
 *
 * ── Why Supabase's own message never reaches a screen ─────────────────────
 *
 * `AuthError.message` is English, written by the auth server, and it changes
 * between releases. Rendering it would put untranslated text in the French
 * and Spanish interfaces, invisible to `i18next/no-literal-string` (it is not
 * a literal — it arrived over the network) and invisible to the locale parity
 * test (it is in no catalog). It is exactly the arrangement `packages/
 * contract` exists to prevent on the API side, applied to the one other
 * server this app talks to: a code crosses the wire, and the sentence lives
 * here in three languages.
 *
 * So this maps `error.code` — a stable, documented identifier — onto a small
 * closed set, and everything unrecognised becomes `UNKNOWN` rather than a
 * passed-through message. `auth-codes.test.ts` asserts the catalogs hold
 * exactly this list, so a code added below cannot ship untranslated.
 *
 * ── What the grouping is for ──────────────────────────────────────────────
 *
 * Several Supabase codes collapse onto one sentence on purpose. A user does
 * not need to know whether their recovery link was consumed, expired, or
 * belonged to a flow this browser no longer has the verifier for — in all
 * three cases the answer is "ask for a new link". Distinctions are kept only
 * where the *next action* differs, which is why `EMAIL_NOT_CONFIRMED` is not
 * folded into `INVALID_CREDENTIALS` despite both being a failed sign-in: one
 * is fixed by checking an inbox and the other by typing the password again.
 * That distinction is the whole point of the milestone note about
 * confirmation being switched on.
 */

/** Every failure the sign-in surfaces can name. */
export const AUTH_FAILURE_CODES = [
  // Signing in
  'INVALID_CREDENTIALS',
  'EMAIL_NOT_CONFIRMED',
  'ACCOUNT_DISABLED',
  // Signing up
  'EMAIL_ALREADY_REGISTERED',
  'EMAIL_INVALID',
  'WEAK_PASSWORD',
  'SAME_PASSWORD',
  'SIGN_UP_DISABLED',
  /**
   * The server refused a field. Distinct from `WEAK_PASSWORD` because the
   * server sends it for anything it validates — the password ceiling is the
   * one this app hits — and putting "choose a longer password" on screen for a
   * malformed address would be worse than being vague.
   */
  'INVALID_INPUT',
  // Third-party providers
  'PROVIDER_DISABLED',
  /** The round trip came back without a session because the user stopped it. */
  'PROVIDER_CANCELLED',
  /** The provider released no address this project is willing to trust. */
  'PROVIDER_EMAIL_UNVERIFIED',
  /**
   * Email and password sign-in is switched off on this project. Separate from
   * `PROVIDER_DISABLED`, whose sentence tells the reader to use their email
   * address and password — which is exactly what has just been refused.
   */
  'EMAIL_SIGN_IN_DISABLED',
  // Links that arrive by email
  'LINK_EXPIRED',
  // The session itself
  'SESSION_MISSING',
  // Neither the credentials nor the account
  'RATE_LIMITED',
  /**
   * The project's own quota for outgoing mail, which is a fact about the
   * deployment rather than about the reader. It trips on a first-ever attempt
   * and clears on an hourly boundary, so "too many attempts, wait a moment" is
   * wrong about the cause and wrong about the wait.
   */
  'EMAIL_SEND_LIMITED',
  'NETWORK_UNREACHABLE',
  'AUTH_UNAVAILABLE',
  'UNKNOWN',
] as const

export type AuthFailureCode = (typeof AUTH_FAILURE_CODES)[number]

/**
 * Supabase's `error.code` values, mapped onto the set above.
 *
 * Written as a lookup rather than a `switch` so the grouping is visible as
 * data: which server codes collapse onto one sentence is the interesting part
 * of this file, and a `switch` would bury it in fallthrough.
 */
const CODE_MAP: Readonly<Record<string, AuthFailureCode>> = {
  invalid_credentials: 'INVALID_CREDENTIALS',
  email_not_confirmed: 'EMAIL_NOT_CONFIRMED',
  phone_not_confirmed: 'EMAIL_NOT_CONFIRMED',
  user_banned: 'ACCOUNT_DISABLED',

  user_already_exists: 'EMAIL_ALREADY_REGISTERED',
  email_exists: 'EMAIL_ALREADY_REGISTERED',
  identity_already_exists: 'EMAIL_ALREADY_REGISTERED',

  email_address_invalid: 'EMAIL_INVALID',
  email_address_not_authorized: 'EMAIL_INVALID',

  weak_password: 'WEAK_PASSWORD',
  same_password: 'SAME_PASSWORD',
  signup_disabled: 'SIGN_UP_DISABLED',

  /*
   * GoTrue's catch-all for a field it will not accept, and the code this app
   * meets when a password is past bcrypt's 72-byte ceiling. Unmapped, it came
   * back `UNKNOWN` and the password screens told the reader their sign-in had
   * failed. `passwordPolicy.ts` now catches that case before the round trip;
   * this is what keeps the *next* server-side rule from being silent too.
   */
  validation_failed: 'INVALID_INPUT',

  provider_disabled: 'PROVIDER_DISABLED',
  oauth_provider_not_supported: 'PROVIDER_DISABLED',
  /*
   * Kept apart from the two above. All three mean "not that way", but the
   * third-party sentence names email and password as the way that *does* work,
   * and saying that to somebody whose email sign-in was just refused is a loop.
   */
  email_provider_disabled: 'EMAIL_SIGN_IN_DISABLED',

  /*
   * The OAuth return leg. These arrive as query or fragment parameters on the
   * address the provider sent the user back to, not as a thrown `AuthError` —
   * `features/auth/providerReturn.ts` reads them and hands them here.
   */
  provider_email_needs_verification: 'PROVIDER_EMAIL_UNVERIFIED',
  access_denied: 'PROVIDER_CANCELLED',

  /*
   * All four mean "that link is no longer usable", and the difference between
   * them is not something a user can act on differently: `bad_code_verifier`
   * is a PKCE flow started in another browser, `flow_state_not_found` is one
   * whose verifier this browser has since cleared. Ask for a new link.
   */
  otp_expired: 'LINK_EXPIRED',
  flow_state_expired: 'LINK_EXPIRED',
  flow_state_not_found: 'LINK_EXPIRED',
  bad_code_verifier: 'LINK_EXPIRED',

  session_not_found: 'SESSION_MISSING',
  session_expired: 'SESSION_MISSING',
  refresh_token_not_found: 'SESSION_MISSING',
  refresh_token_already_used: 'SESSION_MISSING',

  over_request_rate_limit: 'RATE_LIMITED',
  over_sms_send_rate_limit: 'RATE_LIMITED',
  /*
   * NOT folded into `RATE_LIMITED`, and this is the grouping rule applied
   * rather than abandoned: the next action differs. "You have tried too many
   * times, wait a moment" is about the reader. This one is the project's
   * hourly quota for outgoing mail — it trips on a first-ever attempt from a
   * fresh browser, and it clears on the hour rather than in a moment. One
   * sentence for both told first-time visitors they had made too many
   * attempts, which was false in both halves.
   */
  over_email_send_rate_limit: 'EMAIL_SEND_LIMITED',

  request_timeout: 'NETWORK_UNREACHABLE',
}

/**
 * The error supabase-js raises when the request never reached the auth server
 * — offline, DNS, TLS, a dead host. It carries no `code`, because a code only
 * exists once there is a response to read it from.
 */
const RETRYABLE_FETCH_ERROR = 'AuthRetryableFetchError'

interface ErrorLike {
  readonly name?: unknown
  readonly code?: unknown
  readonly status?: unknown
}

/**
 * Classifies anything a caller may have been handed: an `AuthError`, a
 * `TypeError` from a bug in this code, `null` from a successful call.
 *
 * `null` and `undefined` return `null` so the call sites can read as
 * `const failure = authFailureCode(error); if (failure !== null) …` without a
 * separate emptiness check.
 */
export function authFailureCode(error: unknown): AuthFailureCode | null {
  if (error === null || error === undefined) return null
  if (typeof error !== 'object') return 'UNKNOWN'

  const { name, code, status } = error as ErrorLike

  if (name === RETRYABLE_FETCH_ERROR) return 'NETWORK_UNREACHABLE'

  if (typeof code === 'string') {
    const mapped = CODE_MAP[code]
    if (mapped !== undefined) return mapped
  }

  /*
   * No code, or one this bundle predates. The status is the only other thing
   * that is stable, and only 429 says something a user can act on — "wait".
   * Guessing at 400 would put "wrong password" on screen for a malformed
   * email, which is worse than being vague.
   */
  if (status === 429) return 'RATE_LIMITED'

  return 'UNKNOWN'
}

/** The i18next key for a failure, in the `auth` namespace. */
export function authErrorMessageKey(code: AuthFailureCode): string {
  return `auth:errors.${code}`
}
