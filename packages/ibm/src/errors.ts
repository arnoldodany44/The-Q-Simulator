/**
 * Why a call to IBM did not produce an answer, as a code rather than a
 * sentence.
 *
 * ── One vocabulary, because two processes and three languages read it ────
 *
 * A hardware failure is written into `HardwareJob.errorMessage`, read back by
 * `GET /hardware/jobs/:id`, and rendered by a trilingual client (D2). So what
 * is stored is a member of the list below and never the prose IBM sent: their
 * message is English, it changes without notice, and it sits outside every
 * catalog parity test. The prose goes to the log line beside the row, where a
 * person reading an incident wants it.
 *
 * ── Classification is by shape, never by message text ────────────────────
 *
 * The same discipline as the API's `toApiError`. A 401 is a credential
 * failure because it is a 401; the words "Error authenticating user" are not
 * consulted, because a service that reworded them would silently reclassify
 * every failure in this system.
 *
 * The one exception is the *code number* IBM puts in its error envelope, which
 * is a machine-readable field and is treated as one: 1234 ("cannot get results
 * for a job in a non-terminal state") is how the live service answers a
 * results read on a queued job, and it means "not yet" rather than "wrong" —
 * see `RESULTS_NOT_READY`.
 */

import { scrub } from './redact.js'

/**
 * Every way a call to IBM can fail, from this system's point of view.
 *
 *   `IBM_CREDENTIAL_INVALID`  the API key or the CRN was refused. The one code
 *                             the *user* can act on: their key expired, or was
 *                             revoked, or the CRN is for another service.
 *   `IBM_FORBIDDEN`           authenticated, and not allowed. A CRN for an
 *                             instance this key cannot use.
 *   `IBM_NOT_FOUND`           no such backend, or no such job. Also what a
 *                             wrong region answers — see `crn.ts`.
 *   `IBM_RATE_LIMITED`        429. Retryable, and the only failure with a
 *                             `Retry-After` worth honouring.
 *   `IBM_QUOTA_EXHAUSTED`     the instance is out of QPU seconds for the
 *                             period. Distinct from RATE_LIMITED because
 *                             waiting does not fix it inside any horizon this
 *                             system polls over.
 *   `IBM_UNAVAILABLE`         5xx, a timeout, a socket that never opened. The
 *                             service, not the request. Retryable.
 *   `IBM_MALFORMED_RESPONSE`  a 200 whose body is not what this version of the
 *                             API promises. Its own code because it is *our*
 *                             bug or a version drift, never the caller's — see
 *                             `IBM_API_VERSION` in `client.ts` for the drift
 *                             that is already known to exist.
 *   `IBM_REFUSED`             a 4xx that is none of the above: the job body was
 *                             rejected. Not retryable.
 */
export const IBM_FAILURE_CODES = [
  'IBM_CREDENTIAL_INVALID',
  'IBM_FORBIDDEN',
  'IBM_NOT_FOUND',
  'IBM_RATE_LIMITED',
  'IBM_QUOTA_EXHAUSTED',
  'IBM_UNAVAILABLE',
  'IBM_MALFORMED_RESPONSE',
  'IBM_REFUSED',
] as const

export type IbmFailureCode = (typeof IBM_FAILURE_CODES)[number]

const RETRYABLE: ReadonlySet<IbmFailureCode> = new Set([
  'IBM_RATE_LIMITED',
  'IBM_UNAVAILABLE',
])

/** Whether waiting and asking again is a sensible response to this failure. */
export function isRetryable(code: IbmFailureCode): boolean {
  return RETRYABLE.has(code)
}

/**
 * A failure with its code attached.
 *
 * `detail` is English and is for the log. It is scrubbed on the way in rather
 * than on the way out, because the thing that most often ends up in one of
 * these is a URL or a header this package built, and scrubbing at the sink
 * means every sink has to remember.
 */
export class IbmError extends Error {
  readonly code: IbmFailureCode
  /** The HTTP status, when there was a response at all. */
  readonly status: number | null
  /** Seconds the service asked us to wait, from `Retry-After`. */
  readonly retryAfterSeconds: number | null

  constructor(
    code: IbmFailureCode,
    detail: string,
    options: {
      status?: number | null
      retryAfterSeconds?: number | null
      cause?: unknown
    } = {}
  ) {
    super(scrub(detail), { cause: options.cause })
    this.name = 'IbmError'
    this.code = code
    this.status = options.status ?? null
    this.retryAfterSeconds = options.retryAfterSeconds ?? null
  }

  get retryable(): boolean {
    return isRetryable(this.code)
  }
}

/**
 * IBM's own error code for "this job has not finished".
 *
 * Measured against the live service: `GET /jobs/{id}/results` on a queued job
 * answers **400**, not the 204 the documentation suggests, with this number in
 * the envelope. Both are handled — see `readResults` — and the number is named
 * here so the branch is a fact about their API rather than a magic constant in
 * a client.
 */
export const RESULTS_NOT_READY = 1234

/**
 * The error envelope the Quantum API answers 4xx and 5xx with.
 *
 * `errors` is `unknown[]` rather than an array of a shape, because the two
 * readers below are walking a body that came off the network: giving the
 * elements a declared shape here would be a claim about somebody else's JSON,
 * and the whole point of these functions is to hold that claim to one `typeof`
 * per field.
 */
interface ServiceErrorEnvelope {
  readonly errors?: readonly unknown[]
}

/** One field of one entry, or `undefined`. Never assumes the entry is an object. */
function entryField(entry: unknown, field: string): unknown {
  if (typeof entry !== 'object' || entry === null) return undefined
  return (entry as Record<string, unknown>)[field]
}

/**
 * The numeric codes in a service error body, if it is one.
 *
 * Returns numbers only. IBM uses both `1234` and `"not_found"` in this field
 * depending on the endpoint, and a branch that compared loosely would treat the
 * string `"1234"` as the numeric one.
 */
export function serviceErrorCodes(body: unknown): readonly number[] {
  if (typeof body !== 'object' || body === null) return []
  const errors = (body as ServiceErrorEnvelope).errors
  if (!Array.isArray(errors)) return []
  const codes: number[] = []
  for (const entry of errors) {
    const code = entryField(entry, 'code')
    if (typeof code === 'number' && Number.isFinite(code)) codes.push(code)
  }
  return codes
}

/**
 * The one-line summary of a service error, for the log and for nothing else.
 *
 * Bounded, because it is somebody else's text going into a structured log, and
 * scrubbed, because a service is entirely capable of quoting the request back.
 */
export function serviceErrorSummary(body: unknown): string {
  if (typeof body !== 'object' || body === null) return ''
  const errors = (body as ServiceErrorEnvelope).errors
  if (!Array.isArray(errors) || errors.length === 0) return ''
  const first = entryField(errors[0], 'message')
  if (typeof first !== 'string') return ''
  return scrub(first).slice(0, 300)
}

/**
 * The failure code an HTTP status means.
 *
 * 402 and 403 are separated deliberately: a payment-required answer on the Open
 * Plan is the ten-minute allowance being gone, which is a fact about the month
 * rather than about permissions, and a client that told somebody "you are not
 * allowed" when the truth is "come back next period" would be wrong in a way
 * that costs a support conversation.
 */
export function failureCodeForStatus(status: number): IbmFailureCode {
  if (status === 401) return 'IBM_CREDENTIAL_INVALID'
  if (status === 402) return 'IBM_QUOTA_EXHAUSTED'
  if (status === 403) return 'IBM_FORBIDDEN'
  if (status === 404) return 'IBM_NOT_FOUND'
  if (status === 429) return 'IBM_RATE_LIMITED'
  if (status >= 500) return 'IBM_UNAVAILABLE'
  return 'IBM_REFUSED'
}
