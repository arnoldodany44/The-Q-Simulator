/**
 * The error vocabulary, as the wire carries it — §11.
 *
 * The API never sends display text. It sends a code, and `apps/web`
 * translates that code into `es`, `en` and `fr`. That rule only holds if both
 * ends agree on *which* codes exist, and the way to make that agreement
 * checkable is to declare the list once, here, where neither side owns it:
 *
 *   - `apps/api/src/errors.ts` builds its status-and-message table
 *     `satisfies Record<ApiErrorCode, ErrorDefinition>`, so a code added here
 *     and not defined there is a compile error, and a code defined there and
 *     absent here is an excess-property error. The two directions matter
 *     equally: the first would be a code the API cannot produce, the second a
 *     code the client has never heard of.
 *   - `apps/web` asserts its `errors` catalog has exactly these keys in all
 *     three languages, so a new code cannot ship untranslated.
 *
 * The `message` that travels beside the code is developer-facing and fixed
 * (see the API's table). A client that renders it has a bug: it is English,
 * it is not in any catalog, and no parity test can see it.
 */

import { z } from 'zod'

/**
 * Every code the API is allowed to answer with.
 *
 * Ordered by the situation rather than alphabetically, because the grouping
 * is the useful thing: the four authentication failures, then authorisation,
 * then the request, then the server. A client that switches on this union
 * usually cares about the group, not the member.
 */
export const API_ERROR_CODES = [
  // 401 — who are you?
  'AUTH_REQUIRED',
  'AUTH_INVALID_TOKEN',
  'AUTH_TOKEN_EXPIRED',
  // 503 — the signing keys, not the caller
  'AUTH_KEY_UNAVAILABLE',
  // 403 — we know who you are, and no
  'FORBIDDEN',
  'USER_EMAIL_REQUIRED',
  /*
   * 403 — the API key verified, and it does not carry the scope this route
   * asked for (§3.5).
   *
   * Its own code because the fix is specific and cheap: mint a key with the
   * missing scope. `FORBIDDEN` would send the same holder looking for a
   * permission problem on their *account*, which is never what this is — a key
   * can do no more than its user and this says it is doing less on purpose.
   * The `details` name the scope that was required.
   */
  'API_KEY_SCOPE_REQUIRED',
  /*
   * 403 — a valid API key on a route no key may ever reach.
   *
   * Kept apart from the code above, and the distinction is the whole reason
   * both exist: that one is answered by minting a better key, and this one is
   * answered by *not using a key at all*. Key management and hardware are the
   * two surfaces behind it — a key that could mint keys would outlive its own
   * revocation, and a key that could submit a hardware job would spend an
   * allowance that does not refill (risk 4). Telling a caller to widen their
   * scopes here would send them round a loop with no exit.
   */
  'API_KEY_NOT_ACCEPTED',
  // 404 — including "exists, but not yours to see"
  'NOT_FOUND',
  // 4xx — the request itself
  'VALIDATION_FAILED',
  'MALFORMED_JSON',
  'UNSUPPORTED_MEDIA_TYPE',
  'PAYLOAD_TOO_LARGE',
  'CIRCUIT_TOO_LARGE',
  'VERSION_CONFLICT',
  'USER_EMAIL_ALREADY_LINKED',
  /*
   * 409 — the username somebody typed into their settings belongs to another
   * account. It says exactly what a public profile already says about that
   * handle and nothing more: reachable only by a signed-in caller changing
   * their own name, it costs a write, and it never says whose.
   */
  'USERNAME_TAKEN',
  /** 409 — the collection already holds `MAX_COLLECTION_ITEMS` circuits. */
  'COLLECTION_FULL',
  /*
   * 409 — the account already holds `MAX_ACTIVE_API_KEYS` unrevoked keys.
   *
   * A 409 and not a 403: nothing about the request was wrong and nobody is
   * forbidden anything — the resource is in a state that refuses another one,
   * and the move is to revoke a key that is no longer in use. The same shape
   * as `COLLECTION_FULL`, for the same reason.
   */
  'API_KEY_LIMIT_REACHED',
  /*
   * 413 — the circuit is past a §11 resource limit for a *server run*: the
   * qubit ceiling, the operation count, the shot count, or the work budget the
   * wall-clock bound implies.
   *
   * Distinct from CIRCUIT_TOO_LARGE, and the distinction is what the caller
   * can do about it. CIRCUIT_TOO_LARGE is about bytes and is answered by
   * saving something smaller; this is about 2ⁿ and is answered by simulating
   * something smaller — a circuit far below the storage limit can be far past
   * this one, because a statevector's cost has nothing to do with how much
   * text describes it.
   */
  'SIMULATION_TOO_LARGE',
  /*
   * 422 — the circuit cannot be run on this device at all. §3.7, Phase 4.
   *
   * Its own code and not VALIDATION_FAILED, because the request was perfectly
   * valid: the circuit is real, the backend exists, and the answer is still no.
   * A Heron processor couples 1.46 % of the pairs a drawn circuit assumes, so
   * the ordinary refusal is "no placement exists in which every interacting
   * pair is genuinely wired together" — which is a fact about the machine and
   * is answered by drawing a shallower circuit or choosing another device,
   * never by fixing the request. The `details` carry what the circuit needed
   * and what the device has.
   */
  'HARDWARE_UNRUNNABLE',
  /*
   * 502 — the provider refused, and it is about the credential.
   *
   * The one hardware failure the *user* can act on: their IBM Cloud API key
   * expired, was revoked, or the CRN names an instance it cannot reach. Kept
   * apart from every other provider failure precisely because the response is
   * different — this one says "go and re-enter your key", and the others say
   * "wait".
   */
  'HARDWARE_CREDENTIAL_REJECTED',
  /*
   * 502 — the provider could not be reached, or answered with something this
   * build does not understand. Retryable, and about them rather than about the
   * caller.
   */
  'HARDWARE_UNAVAILABLE',
  /*
   * 402 — the plan's QPU allowance is spent.
   *
   * Its own code because it is neither a permission problem nor a rate limit,
   * and telling somebody "you are not allowed" when the truth is "your ten
   * minutes are gone until the period rolls over" sends them to fix a thing
   * that is not broken. The Open Plan grants ten minutes per twenty-eight days
   * and does not refill on request (risk 4), so this is a state a real user
   * reaches.
   */
  'HARDWARE_QUOTA_EXHAUSTED',
  'RATE_LIMITED',
  // 5xx — us
  'USERNAME_UNAVAILABLE',
  'DATABASE_UNAVAILABLE',
  /*
   * 503 — the job queue is not reachable, so a run cannot be accepted.
   *
   * Its own code rather than DATABASE_UNAVAILABLE because it is a different
   * dependency with a different blast radius: every other route in this API
   * works perfectly while this one does not, and a client that logged the user
   * out or hid the gallery on a Redis outage would be reacting to the wrong
   * fact. Retryable, and the client is told so by the status.
   */
  'SIMULATION_UNAVAILABLE',
  'INTERNAL_ERROR',
] as const

export type ApiErrorCode = (typeof API_ERROR_CODES)[number]

const API_ERROR_CODE_SET: ReadonlySet<string> = new Set(API_ERROR_CODES)

/**
 * Narrows a string that arrived over the network to a code both ends know.
 *
 * Used by the client on the error path, where the response is by definition
 * untrusted: an API deployed ahead of the browser tab can answer with a code
 * this bundle has no translation for, and rendering a raw identifier is worse
 * than falling back to a generic sentence.
 */
export function isApiErrorCode(value: unknown): value is ApiErrorCode {
  return typeof value === 'string' && API_ERROR_CODE_SET.has(value)
}

/**
 * Which part of the request failed validation, and how.
 *
 * `code` is Zod's issue code (`invalid_type`, `too_big`, …) or one of
 * @qsim/schema's semantic codes — never a sentence. The client holds the very
 * same schema, so it can say more about `body.circuit.operations.op-3` than
 * the server could ever fit in a message.
 */
export const ErrorDetailSchema = z.object({
  path: z.string(),
  code: z.string(),
})

export type ErrorDetail = z.infer<typeof ErrorDetailSchema>

/**
 * The exact JSON body of every error response.
 *
 * The client parses through this rather than trusting the shape, because the
 * error path is precisely where a body might not have come from the API at
 * all — a proxy's HTML 502, a captive portal, a rewrite rule. What cannot be
 * parsed is mapped by status code instead.
 */
export const ErrorResponseSchema = z.object({
  error: z.object({
    code: z.string(),
    /** Developer-facing and fixed. Clients translate `code`, never this. */
    message: z.string(),
    /** Correlates the response with the server log line for this request. */
    requestId: z.string(),
    details: z.array(ErrorDetailSchema).optional(),
  }),
})

export type ErrorResponseBody = z.infer<typeof ErrorResponseSchema>
