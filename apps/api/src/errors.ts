/**
 * The error vocabulary the API speaks — specification §11.
 *
 * Two rules govern every response that leaves this file, and both exist
 * because the client is trilingual (D2) and because an error is the most
 * likely place for an internal detail to escape:
 *
 * 1. **The payload carries a code, not a sentence.** `apps/web` translates
 *    `AUTH_TOKEN_EXPIRED` into three catalogs. If the API sent English prose
 *    for display, the French user would read English, and the string would
 *    live outside i18next where no parity test can see it.
 * 2. **Nothing derived from the failure is sent.** No stack, no
 *    `error.message` from an exception we did not author, no Prisma text. A
 *    Prisma connection error contains the connection string; a validation
 *    error from a driver can contain a row's contents. The mapping in
 *    `toApiError` therefore *discards* the original and picks a code by
 *    shape — the original goes to the log, where it belongs.
 *
 * The `message` field in the payload is a fixed string from the table below.
 * It exists for whoever is holding a terminal, and it is deliberately never
 * derived from the underlying error. It is not for display: a client that
 * renders it instead of translating `code` has a bug.
 *
 * The *list* of codes is not declared here. It lives in `@qsim/contract`,
 * which `apps/web` imports too, and the table below is bound to it with
 * `satisfies Record<ApiErrorCode, ErrorDefinition>` — so a code the contract
 * publishes and this file does not define is a compile error, and a
 * definition here for a code the contract has never heard of is an
 * excess-property error. Both directions matter: the first is a code the API
 * cannot actually produce, the second is a code that would reach a browser
 * with no translation for it.
 */

import type { ApiErrorCode, ErrorDetail } from '@qsim/contract'

export type { ErrorDetail } from '@qsim/contract'

/** The status and the developer-facing text, kept together so they cannot drift. */
interface ErrorDefinition {
  readonly status: number
  readonly message: string
}

/**
 * Every error this API is allowed to produce.
 *
 * Adding a code here is a contract change: it starts in `@qsim/contract`, and
 * `apps/web` needs a translation in `es`, `en` and `fr` before it can reach a
 * user — its own catalog parity test refuses the build otherwise.
 */
export const ERROR_DEFINITIONS = {
  /** No credentials at all on a route that requires a user. */
  AUTH_REQUIRED: {
    status: 401,
    message: 'This endpoint requires an authenticated user.',
  },
  /**
   * A token was presented and it did not verify: bad signature, unknown key,
   * wrong issuer, wrong audience, unusable shape. Deliberately one code for
   * all of them — telling a caller *which* check failed helps an attacker
   * more than it helps a client, and the client's reaction is the same.
   */
  AUTH_INVALID_TOKEN: {
    status: 401,
    message: 'The access token could not be verified.',
  },
  /**
   * Expiry is the one verification failure that gets its own code, because
   * it is the one the client can act on: refresh the session and retry.
   * Collapsing it into AUTH_INVALID_TOKEN would make every client either
   * refresh on any 401 (a refresh storm against a genuinely bad token) or
   * never refresh (a session that dies after an hour).
   */
  AUTH_TOKEN_EXPIRED: {
    status: 401,
    message: 'The access token has expired; refresh the session and retry.',
  },
  /**
   * The JWKS endpoint could not be reached and no cached key covers this
   * token. A 503 rather than a 401: nothing is wrong with the caller's
   * credentials, so a client that logged the user out here would be wrong.
   */
  AUTH_KEY_UNAVAILABLE: {
    status: 503,
    message: 'Token signing keys are temporarily unavailable.',
  },
  /** Authenticated, but not allowed to touch this particular resource. */
  FORBIDDEN: {
    status: 403,
    message: 'The authenticated user may not perform this action.',
  },
  /**
   * Also the answer for a resource that exists but the caller may not see —
   * a PRIVATE circuit answers 404, not 403, because 403 would confirm that
   * the slug exists (§11).
   */
  NOT_FOUND: { status: 404, message: 'No such resource.' },
  VALIDATION_FAILED: {
    status: 400,
    message: 'The request did not match the expected shape.',
  },
  MALFORMED_JSON: {
    status: 400,
    message: 'The request body is not valid JSON.',
  },
  UNSUPPORTED_MEDIA_TYPE: {
    status: 415,
    message: 'This endpoint accepts application/json.',
  },
  PAYLOAD_TOO_LARGE: {
    status: 413,
    message: 'The request body exceeds the size limit.',
  },
  /**
   * Distinct from PAYLOAD_TOO_LARGE, and the distinction is what the client
   * can do about it: the request was well within the body limit, and the
   * *circuit* is too big to be stored as an immutable version. A version can
   * never be rewritten smaller, so the refusal has to come before the write.
   */
  CIRCUIT_TOO_LARGE: {
    status: 413,
    message: 'The circuit exceeds the storage size limit.',
  },
  /**
   * Two saves raced for the same version number and this one kept losing.
   * Versions are immutable and numbered per circuit, so there is no merge to
   * offer: the client reloads the history and saves again. A 409 rather than
   * a 500 because nothing is broken — the request simply arrived second.
   */
  VERSION_CONFLICT: {
    status: 409,
    message: 'Another save claimed this version number; reload and retry.',
  },
  /**
   * The token verified but carries no `email` claim, and `User.email` is NOT
   * NULL and unique. Nothing can be created for this identity until Supabase
   * issues a token that has one. A 403 rather than a 401: the credentials are
   * genuine, they are just not sufficient to own anything.
   */
  USER_EMAIL_REQUIRED: {
    status: 403,
    message: 'The access token carries no email claim.',
  },
  /**
   * A different user id already holds this email — an account deleted from
   * Supabase and recreated, leaving a stale `public.User` row. Returning the
   * other row instead would be an account takeover, so this fails loudly.
   */
  USER_EMAIL_ALREADY_LINKED: {
    status: 409,
    message: 'Another account already holds this email address.',
  },
  /**
   * The username in a settings change belongs to another account. Decided by
   * `User_username_key` rather than by a prior lookup, so two simultaneous
   * claims cannot both succeed — see `accounts.ts` in @qsim/db for why there
   * is no "is this available?" endpoint beside it.
   */
  USERNAME_TAKEN: {
    status: 409,
    message: 'That username belongs to another account.',
  },
  /**
   * The collection already holds `MAX_COLLECTION_ITEMS`. A 409 rather than a
   * 400: nothing about the request was malformed, the resource is simply in a
   * state that refuses it, and the client's move is to remove something.
   */
  COLLECTION_FULL: {
    status: 409,
    message: 'This collection already holds the maximum number of circuits.',
  },
  /**
   * The circuit is past a §11 resource limit for a *server run*.
   *
   * Distinct from CIRCUIT_TOO_LARGE, and the distinction is what the caller
   * can do about it: that one is about bytes and is answered by saving
   * something smaller, this one is about 2ⁿ and is answered by simulating
   * something smaller. A four-kilobyte circuit can be far past this limit,
   * because a statevector's cost has nothing to do with how much text
   * describes it.
   */
  SIMULATION_TOO_LARGE: {
    status: 413,
    message: 'The circuit exceeds the limits for a server-side simulation.',
  },
  /**
   * The job queue is unreachable, so no run can be accepted.
   *
   * Its own code rather than DATABASE_UNAVAILABLE because it is a different
   * dependency with a much smaller blast radius: every other route works
   * perfectly while this one does not, and §4 means the browser can still run
   * anything below the client ceiling on its own.
   */
  SIMULATION_UNAVAILABLE: {
    status: 503,
    message: 'Server-side simulation is temporarily unavailable.',
  },
  /** Every generated username candidate was taken. Retryable. */
  USERNAME_UNAVAILABLE: {
    status: 503,
    message: 'Could not allocate a username; retry.',
  },
  RATE_LIMITED: {
    status: 429,
    message: 'Too many requests; retry after the interval in Retry-After.',
  },
  DATABASE_UNAVAILABLE: {
    status: 503,
    message: 'The database is not reachable.',
  },
  INTERNAL_ERROR: { status: 500, message: 'Unexpected server error.' },
} as const satisfies Record<ApiErrorCode, ErrorDefinition>

export type ErrorCode = ApiErrorCode

/**
 * The exact JSON shape of every error response.
 *
 * Narrower than the contract's `ErrorResponseSchema` in exactly one place:
 * `code` is the union rather than `string`. The server knows which codes it
 * can emit; the client parses an untrusted body and must handle a code from a
 * newer deployment, which is why the shared schema is the looser of the two.
 */
export interface ErrorResponseBody {
  readonly error: {
    readonly code: ErrorCode
    /** Developer-facing and fixed. Clients translate `code`, never this. */
    readonly message: string
    /** Correlates the response with the server log line for the same request. */
    readonly requestId: string
    readonly details?: readonly ErrorDetail[]
  }
}

export interface ApiErrorOptions {
  readonly details?: readonly ErrorDetail[]
  /** Kept for the log only. Never serialised into a response. */
  readonly cause?: unknown
}

/**
 * The only error type that is allowed to decide a response.
 *
 * `statusCode` is a plain field rather than a getter on purpose: Fastify's
 * validation pipeline assigns `err.statusCode` and `err.code` when it wraps a
 * rejected schema (`lib/validation.js`, `wrapValidationError`), and an
 * accessor with no setter would throw at exactly that point.
 */
export class ApiError extends Error {
  readonly code: ErrorCode
  statusCode: number
  readonly details: readonly ErrorDetail[] | undefined

  constructor(code: ErrorCode, options: ApiErrorOptions = {}) {
    const definition = ERROR_DEFINITIONS[code]
    super(definition.message, { cause: options.cause })
    this.name = 'ApiError'
    this.code = code
    this.statusCode = definition.status
    this.details = options.details
  }

  toResponse(requestId: string): ErrorResponseBody {
    return {
      error: {
        code: this.code,
        message: ERROR_DEFINITIONS[this.code].message,
        requestId,
        ...(this.details === undefined ? {} : { details: this.details }),
      },
    }
  }
}

export function isApiError(error: unknown): error is ApiError {
  return error instanceof ApiError
}

/** Reads a string `code` off an unknown error without trusting its type. */
function errorCodeOf(error: unknown): string | null {
  if (typeof error !== 'object' || error === null) return null
  const code = (error as { code?: unknown }).code
  return typeof code === 'string' ? code : null
}

function statusCodeOf(error: unknown): number | null {
  if (typeof error !== 'object' || error === null) return null
  const status = (error as { statusCode?: unknown }).statusCode
  return typeof status === 'number' ? status : null
}

/**
 * Domain failures that already carry a machine-readable `code`, mapped onto
 * the response vocabulary.
 *
 * `@qsim/db` raises these — `VersionConflictError`, `CircuitTooLargeError`,
 * `UserIdentityConflictError` — with a `code` field for exactly this purpose
 * (§11: a token the client translates, never a sentence). The names coincide
 * with the response codes today; the table is here so that they are free to
 * stop coinciding, and so that a domain error whose name is *not* listed
 * cannot leak its class through as if it were part of the contract.
 *
 * Anything not listed falls through to INTERNAL_ERROR, which is the right
 * answer for a domain error that genuinely means the data is inconsistent
 * rather than that the caller did something wrong. Deciding which is which is
 * the whole content of this table — see the note on MISSING_VERSION, which
 * was on the wrong side of that line.
 */
const DOMAIN_ERROR_CODES: Record<string, ErrorCode> = {
  CIRCUIT_TOO_LARGE: 'CIRCUIT_TOO_LARGE',
  VERSION_CONFLICT: 'VERSION_CONFLICT',
  USER_EMAIL_ALREADY_LINKED: 'USER_EMAIL_ALREADY_LINKED',
  USERNAME_UNAVAILABLE: 'USERNAME_UNAVAILABLE',
  USERNAME_TAKEN: 'USERNAME_TAKEN',
  COLLECTION_FULL: 'COLLECTION_FULL',
  /*
   * `QueueUnavailableError` from `plugins/queue.ts`, covering "not
   * configured", "cannot connect", "timed out" and "Redis replied with an
   * error" alike. They are one fact to a client and one code here.
   */
  SIMULATION_UNAVAILABLE: 'SIMULATION_UNAVAILABLE',
  /*
   * `addCollectionItem` matched no collection for this owner. Unreachable
   * through the routes, which resolve the collection and check ownership
   * first; if it ever is reached the caller is racing a delete or asking about
   * somebody else's collection, and 404 answers both — 403 would confirm the
   * row exists.
   */
  COLLECTION_NOT_WRITABLE: 'NOT_FOUND',
  /*
   * `MissingVersionError` used to be deliberately absent, on the reading that
   * a circuit with no versions means the data is inconsistent. That reading
   * is right about a row that *stays* in that state and wrong about the only
   * way anyone actually reaches it: the owner deleted the circuit between
   * `findReadable` and `latestVersion`, and the cascade took its versions.
   * Nothing is broken, the caller simply lost a race — and the cost of
   * calling it a 500 was real, because `forkCircuit` raises the same error,
   * so forking a circuit that had just been deleted was a server fault in the
   * error budget and the alerting. 404 is what the next request would say.
   */
  MISSING_VERSION: 'NOT_FOUND',
  /*
   * `appendVersion` matched no circuit for this owner. Unreachable through
   * the routes, which check ownership first; if it ever is reached, the
   * caller is either racing a delete or asking about a circuit that is not
   * theirs, and 404 is the answer to both — 403 would confirm the row exists.
   */
  CIRCUIT_NOT_WRITABLE: 'NOT_FOUND',
  /*
   * A star landed on a circuit its owner deleted in the meantime. Nothing is
   * broken — the caller lost a race — and 404 is what the next request would
   * say, so calling it a 500 would put an ordinary race in the error budget.
   */
  CIRCUIT_GONE: 'NOT_FOUND',
}

/**
 * Maps anything thrown during a request onto exactly one `ApiError`.
 *
 * The classification is by *shape* — the framework's error code, the status
 * it suggested, the Prisma error prefix — and never by message text. That is
 * the point: the original object is dropped here and only the code survives
 * into the response, so no wording from a library or a driver can reach a
 * client by accident.
 *
 * Prisma's `P1xxx` family is the connection layer (server unreachable, TLS
 * failure, timeout) and is genuinely a 503 the caller can retry. Every other
 * `Pxxxx` is a query the server got wrong, which is a 500 whatever it says.
 */
export function toApiError(error: unknown): ApiError {
  if (isApiError(error)) return error

  const code = errorCodeOf(error)
  const status = statusCodeOf(error)

  if (code !== null) {
    const domain = DOMAIN_ERROR_CODES[code]
    if (domain !== undefined) return new ApiError(domain, { cause: error })
  }
  if (code === 'FST_ERR_VALIDATION') {
    return new ApiError('VALIDATION_FAILED', { cause: error })
  }
  if (code === 'FST_ERR_CTP_INVALID_MEDIA_TYPE') {
    return new ApiError('UNSUPPORTED_MEDIA_TYPE', { cause: error })
  }
  if (code === 'FST_ERR_CTP_BODY_TOO_LARGE' || status === 413) {
    return new ApiError('PAYLOAD_TOO_LARGE', { cause: error })
  }
  if (code !== null && code.startsWith('FST_ERR_CTP_')) {
    // Everything else the content-type parser raises is a body it could not
    // read: empty when required, invalid JSON, a broken charset.
    return new ApiError('MALFORMED_JSON', { cause: error })
  }
  if (code !== null && /^P1\d{3}$/.test(code)) {
    return new ApiError('DATABASE_UNAVAILABLE', { cause: error })
  }
  if (code === 'P2025' || code === 'P2003') {
    /*
     * P2025 is "an operation failed because it depends on records that were
     * required but not found" — a row that existed when the request started
     * and does not now.
     *
     * P2003 is the foreign key, and it is the one that actually fires. A
     * concurrent DELETE of the circuit a version is being appended to was
     * always the case this branch was written for, and P2025 turns out to be
     * unreachable on that path: `appendVersion` inserts the version *before*
     * it touches the circuit row, so the FK on `CircuitVersion.circuitId`
     * raises 23503 first — and the share lock that insert takes means a
     * delete cannot win the window between the two statements either. The
     * result was a 500 for an ordinary lost race, in the retryable class,
     * inviting the client to try again against a circuit that will never
     * exist. 404 is the honest answer to both.
     */
    return new ApiError('NOT_FOUND', { cause: error })
  }
  if (code === 'P2028') {
    /*
     * "Unable to start a transaction in the given time." Not a query fault
     * and not the caller's doing: `DATABASE_URL` carries `connection_limit=1`
     * because that is the Supabase pooler's budget, so concurrent writes
     * queue on a pool of one and a queue longer than `maxWait` is rejected
     * here. Eight concurrent creates of eight *different* circuits reproduced
     * it, which is not contention over anything — it is capacity.
     *
     * 503 rather than 500: nothing is broken, the database was momentarily
     * out of reach for this request, and `DATABASE_UNAVAILABLE` is what
     * apps/web already treats as retryable. The queue itself is bounded in
     * @qsim/db, where the transaction options are set.
     */
    return new ApiError('DATABASE_UNAVAILABLE', { cause: error })
  }
  if (status === 429) return new ApiError('RATE_LIMITED', { cause: error })
  if (status === 404) return new ApiError('NOT_FOUND', { cause: error })
  if (status === 415) {
    return new ApiError('UNSUPPORTED_MEDIA_TYPE', { cause: error })
  }
  if (status === 403) return new ApiError('FORBIDDEN', { cause: error })
  if (status === 401) return new ApiError('AUTH_REQUIRED', { cause: error })
  if (status !== null && status >= 400 && status < 500) {
    return new ApiError('VALIDATION_FAILED', { cause: error })
  }

  return new ApiError('INTERNAL_ERROR', { cause: error })
}
