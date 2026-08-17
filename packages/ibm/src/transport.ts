/**
 * The seam between this package and the network.
 *
 * ── Why the transport is a parameter ─────────────────────────────────────
 *
 * Because of the ten minutes. The Open Plan grants ten minutes of QPU time per
 * twenty-eight days, shared with whatever demonstration the owner is giving
 * that week, and it does not refill on request. A package whose tests reach the
 * real service is a package whose test suite spends that allowance, in CI, on
 * every push, for ever.
 *
 * So the entire protocol — the auth flow, the headers, the job body, the status
 * mapping, the result conversion — is exercised against a recorded transport,
 * and what the suites assert on is **the request that would have been sent**.
 * That is a stronger test than one against the live service, not a weaker one:
 * it can assert on the `Service-CRN` header, on the exact shape of a pub, and
 * on what happens when a device answers 429 — none of which a live run gives
 * you on demand.
 *
 * ── The shape is deliberately not `fetch` ────────────────────────────────
 *
 * `Request`/`Response` are stateful (a body can be read once), they carry a
 * `Headers` object with its own casing rules, and mocking them well is more
 * code than implementing them. Four plain fields in and four plain fields out
 * is something a test can write as an object literal, and it is what makes the
 * recorded fixtures readable.
 *
 * `fetchTransport` is the real one, and it is fifteen lines because that is all
 * this needs: a timeout, and no retries. Retries live one layer up in
 * `client.ts`, where the decision "is this worth trying again" can be made from
 * a classified failure rather than from a network stack's opinion.
 */

import { IbmError } from './errors.js'
import { describeRequest } from './redact.js'

export interface HttpRequest {
  readonly method: 'GET' | 'POST' | 'DELETE'
  readonly url: string
  /** Header names are lowercase by convention here, so a test can match them. */
  readonly headers: Readonly<Record<string, string>>
  /** Already-encoded body, or `null` for a request that carries none. */
  readonly body: string | null
  readonly timeoutMs: number
}

export interface HttpResponse {
  readonly status: number
  readonly headers: Readonly<Record<string, string>>
  /** The raw body. Empty string for 204 and for a response with none. */
  readonly body: string
}

export type HttpTransport = (request: HttpRequest) => Promise<HttpResponse>

/**
 * How long a metadata call may take before it is abandoned.
 *
 * Ten seconds. Every request this package makes is small — a token exchange, a
 * device listing, a job status — and none of them is the thing that takes
 * hours; that is the *device*, and this system learns about it by polling
 * rather than by holding a socket open. A request still running after ten
 * seconds is a network that is not going to answer.
 */
export const DEFAULT_TIMEOUT_MS = 10_000

/**
 * The real transport, over the platform `fetch`.
 *
 * `AbortController` rather than a `Promise.race`, because a race leaves the
 * request running: the socket stays open, the response is still read into
 * memory, and a worker polling a hundred jobs would accumulate one abandoned
 * request per timeout. Aborting frees it.
 *
 * Every network-level failure becomes `IBM_UNAVAILABLE` — DNS, TLS, a reset,
 * the abort above. They are the same fact to a caller (nothing was learned, and
 * asking again may work), and distinguishing them here would mean reading a
 * platform's error messages, which is exactly what `errors.ts` refuses to do.
 */
export function fetchTransport(): HttpTransport {
  return async (request) => {
    const controller = new AbortController()
    const timer = setTimeout(() => {
      controller.abort()
    }, request.timeoutMs)
    try {
      const response = await fetch(request.url, {
        method: request.method,
        headers: { ...request.headers },
        ...(request.body === null ? {} : { body: request.body }),
        signal: controller.signal,
      })
      const headers: Record<string, string> = {}
      response.headers.forEach((value, name) => {
        headers[name.toLowerCase()] = value
      })
      return {
        status: response.status,
        headers,
        // 204 has none; `text()` answers '' for it, which is what the callers
        // below check for rather than treating as a parse failure.
        body: response.status === 204 ? '' : await response.text(),
      }
    } catch (error) {
      throw new IbmError(
        'IBM_UNAVAILABLE',
        `${describeRequest(request.method, request.url)} did not complete`,
        { cause: error }
      )
    } finally {
      clearTimeout(timer)
    }
  }
}

/**
 * `Retry-After` in seconds, or null.
 *
 * The header is defined as either a delay in seconds or an HTTP date; both are
 * handled, and anything else is null rather than zero. Zero would mean "retry
 * immediately", which is the worst possible reading of a header a service sent
 * because it wants to be left alone.
 *
 * Bounded at an hour: a service asking for longer than that is asking for
 * longer than this system's poll schedule will ever wait, and honouring it
 * literally would park a job until a sweep noticed.
 */
export function retryAfterSeconds(
  headers: Readonly<Record<string, string>>
): number | null {
  const raw = headers['retry-after']
  if (raw === undefined) return null
  const seconds = Number(raw.trim())
  if (Number.isFinite(seconds) && seconds >= 0) {
    return Math.min(Math.round(seconds), 3600)
  }
  const at = Date.parse(raw)
  if (Number.isNaN(at)) return null
  const delta = Math.round((at - Date.now()) / 1000)
  return delta <= 0 ? 0 : Math.min(delta, 3600)
}
