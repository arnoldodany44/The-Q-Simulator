/**
 * Every way a request can fail, as one type the UI can switch on — §11, D2.
 *
 * ── The rule that shapes this file ────────────────────────────────────────
 *
 * The API never sends display text. It sends `{ code, message, requestId }`
 * where `message` is fixed English for whoever is holding a terminal, and
 * `code` is the machine-readable token this client translates into `es`, `en`
 * and `fr`. So nothing here ever surfaces `message`: it is kept for the
 * console and for a bug report, and `code` is what reaches
 * `useApiErrorMessage`.
 *
 * ── Why 401 and 403 must stay distinguishable ─────────────────────────────
 *
 * They are the same word in casual speech and completely different things on
 * screen. A 401 means "we do not know who you are" and the answer is a sign-in
 * prompt — and after signing in, the same action will work. A 403 means "we
 * know exactly who you are and this is not yours", where offering a sign-in
 * prompt is worse than useless: the user is already signed in, and the button
 * does nothing. Collapsing the two is how an app ends up bouncing a logged-in
 * user to a login screen forever.
 *
 * `requiresAuthentication` and `isForbidden` are therefore keyed on the HTTP
 * status, which is present even when the body was mangled by a proxy, and the
 * code sets exist for the cases where the difference within a status matters —
 * an expired token can be refreshed and retried; a missing one cannot.
 *
 * Note that 404 is doing double duty by design (§11): a PRIVATE circuit that
 * belongs to somebody else answers "no such circuit", never 403, because 403
 * would confirm the slug exists. The client cannot tell those apart and must
 * not try to.
 */

import { API_ERROR_CODES, isApiErrorCode } from '@qsim/contract'
import type { ApiErrorCode, ErrorDetail } from '@qsim/contract'

/**
 * Failures that happen on this side of the wire, so the API has no code for
 * them. They are translated from the same catalog because to a user they are
 * indistinguishable from a server error: something did not work.
 */
export const CLIENT_ERROR_CODES = [
  /** The request never got an answer: offline, DNS, TLS, CORS, a dead host. */
  'NETWORK_UNREACHABLE',
  /**
   * An answer arrived and it was not what the contract promises. Almost
   * always a deployment skew (a browser tab older than the API) or something
   * that is not the API at all — a captive portal, a proxy's HTML error page.
   */
  'RESPONSE_MALFORMED',
  /**
   * The session could not produce a token. Distinct from AUTH_REQUIRED, which
   * is the *server* saying no: this is the client failing before it asked, and
   * silently downgrading to an anonymous request would show a signed-in user
   * the public view with no explanation.
   */
  'SESSION_UNAVAILABLE',
] as const

export type ClientErrorCode = (typeof CLIENT_ERROR_CODES)[number]

/** Everything `useApiErrorMessage` must be able to say something about. */
export type ErrorCode = ApiErrorCode | ClientErrorCode

/** The union, as a list — used by the catalog parity test. */
export const ERROR_CODES: readonly ErrorCode[] = [
  ...API_ERROR_CODES,
  ...CLIENT_ERROR_CODES,
]

/** The catalog key used when the code is one this bundle has never heard of. */
export const UNKNOWN_ERROR_KEY = 'UNKNOWN'

export interface ApiRequestErrorOptions {
  /** The HTTP status, or `null` when no response arrived at all. */
  readonly status?: number | null
  /** Correlates with the API's log line. Worth showing in a bug report. */
  readonly requestId?: string | null
  readonly details?: readonly ErrorDetail[]
  /**
   * The code the server actually sent, when it was not one this bundle knows.
   * Kept so a console or a Sentry event can name it even though no catalog
   * can translate it.
   */
  readonly serverCode?: string | null
  readonly cause?: unknown
}

export class ApiRequestError extends Error {
  readonly code: ErrorCode
  readonly status: number | null
  readonly requestId: string | null
  readonly details: readonly ErrorDetail[]
  readonly serverCode: string | null

  constructor(code: ErrorCode, options: ApiRequestErrorOptions = {}) {
    /*
     * The `Error` message is for a developer reading a stack trace, and it is
     * deliberately the code rather than a sentence: a sentence here would be
     * English text outside every catalog, and sooner or later somebody would
     * render it.
     */
    super(code, { cause: options.cause })
    this.name = 'ApiRequestError'
    this.code = code
    this.status = options.status ?? null
    this.requestId = options.requestId ?? null
    this.details = options.details ?? []
    this.serverCode = options.serverCode ?? null
  }
}

export function isApiRequestError(error: unknown): error is ApiRequestError {
  return error instanceof ApiRequestError
}

/**
 * Maps a status to a code when the body could not be read as an API error.
 *
 * The list is short on purpose. Only statuses whose meaning is unambiguous
 * without a body are here — a bare 409 could be a version conflict or an
 * email collision, and guessing would put the wrong sentence on screen — and
 * everything else becomes INTERNAL_ERROR, which is honest: something went
 * wrong and this client cannot say what.
 */
export function errorCodeForStatus(status: number): ApiErrorCode {
  switch (status) {
    case 400:
      return 'VALIDATION_FAILED'
    case 401:
      return 'AUTH_REQUIRED'
    case 403:
      return 'FORBIDDEN'
    case 404:
      return 'NOT_FOUND'
    case 413:
      return 'PAYLOAD_TOO_LARGE'
    case 415:
      return 'UNSUPPORTED_MEDIA_TYPE'
    case 429:
      return 'RATE_LIMITED'
    default:
      return 'INTERNAL_ERROR'
  }
}

/** The 401 family: nobody is signed in, or the token is no longer good. */
const AUTHENTICATION_CODES: ReadonlySet<string> = new Set([
  'AUTH_REQUIRED',
  'AUTH_INVALID_TOKEN',
  'AUTH_TOKEN_EXPIRED',
])

/** The 403 family: signed in, and still not allowed. */
const AUTHORIZATION_CODES: ReadonlySet<string> = new Set([
  'FORBIDDEN',
  'USER_EMAIL_REQUIRED',
])

/** "Sign in" is the useful answer. */
export function requiresAuthentication(error: unknown): boolean {
  if (!isApiRequestError(error)) return false
  return error.status === 401 || AUTHENTICATION_CODES.has(error.code)
}

/** "This is not yours." Never answer this one with a sign-in prompt. */
export function isForbidden(error: unknown): boolean {
  if (!isApiRequestError(error)) return false
  return error.status === 403 || AUTHORIZATION_CODES.has(error.code)
}

/** Covers "no such circuit" and "not yours to see" alike — §11 conflates them. */
export function isNotFound(error: unknown): boolean {
  return isApiRequestError(error) && error.status === 404
}

/**
 * Whether trying the exact same request again could plausibly work.
 *
 * The negative half is what matters: retrying a 403 cannot succeed, and
 * retrying a 400 sends the same rejected body again. React Query's default is
 * three retries on *everything*, so without this every mistyped slug costs
 * four round trips and every unauthorised action looks slow before it fails.
 */
export function isRetryable(error: unknown): boolean {
  if (!isApiRequestError(error)) return false
  // No response at all: a flaky connection is the most retryable thing there is.
  if (error.status === null) return error.code === 'NETWORK_UNREACHABLE'
  if (error.status === 429) return true
  return error.status >= 500
}

/**
 * The i18next key for an error, in the `errors` namespace.
 *
 * Takes `unknown` because it is called from React Query's `error`, which is
 * typed as whatever was thrown — including a `TypeError` from a bug in a
 * `select`. Anything unrecognised gets the generic key rather than nothing:
 * a screen with no message is worse than a vague one.
 */
export function errorMessageKey(error: unknown): string {
  if (!isApiRequestError(error)) return `errors:${UNKNOWN_ERROR_KEY}`
  if (isApiErrorCode(error.code) || isClientErrorCode(error.code)) {
    return `errors:${error.code}`
  }
  return `errors:${UNKNOWN_ERROR_KEY}`
}

function isClientErrorCode(value: string): value is ClientErrorCode {
  return (CLIENT_ERROR_CODES as readonly string[]).includes(value)
}
