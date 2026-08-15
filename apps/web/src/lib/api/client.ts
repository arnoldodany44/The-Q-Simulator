/**
 * The one place this app talks to the network — §8, §9.
 *
 * ── What it is responsible for ────────────────────────────────────────────
 *
 *   1. building the URL from `@qsim/contract`'s prefix and path templates, so
 *      a route rename is a compile error rather than a 404;
 *   2. attaching the bearer token when a session can produce one, and sending
 *      the request anonymously when it cannot;
 *   3. parsing every response through the contract's schema, so a payload the
 *      API did not promise fails here — loudly, once — instead of becoming
 *      `undefined` inside a component three layers away;
 *   4. turning every failure, HTTP or transport, into one `ApiRequestError`
 *      carrying a translatable code.
 *
 * ── What it deliberately does not do ──────────────────────────────────────
 *
 * No caching, no deduplication, no retries, no loading flags. That is React
 * Query's job (§9), and a transport that also caches is a transport nobody
 * can test. `fetch` and the token provider are both injectable for the same
 * reason: every test in this directory drives the real client against a
 * function, with no network and no server.
 *
 * It also holds no circuit state. §9 is explicit that Zustand owns the
 * document being edited and React Query owns what came from the server, and
 * that the two do not mix — so nothing here reaches into the editor store,
 * and nothing here is written back into it implicitly.
 */

import { API_PREFIX, ErrorResponseSchema, isApiErrorCode } from '@qsim/contract'

import { resolveApiBaseUrl } from './config.js'
import { ApiRequestError, errorCodeForStatus } from './errors.js'
import { currentAccessTokenProvider } from './session.js'
import type { AccessTokenProvider } from './session.js'

export type HttpMethod = 'GET' | 'POST' | 'PATCH' | 'DELETE'

/** Values a query string can carry. `undefined` means "omit the parameter". */
export type QueryParams = Readonly<
  Record<string, string | number | boolean | undefined>
>

/** Only the part of `fetch` this client uses, so a test can be one function. */
export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>

/**
 * What this client needs of a response schema, which is exactly `safeParse`.
 *
 * Structural rather than `z.ZodType` on purpose: `apps/web` has no direct
 * dependency on Zod — it reaches the library only through `@qsim/schema` and
 * `@qsim/contract` — and the transport genuinely does not care whether the
 * parser is Zod. Every contract schema satisfies this shape, and a test can
 * pass a three-line object to prove what happens when parsing fails.
 */
export interface ResponseSchema<T> {
  safeParse(
    value: unknown
  ): { success: true; data: T } | { success: false; error: unknown }
}

export interface ApiClientOptions {
  /** Origin only, no path. Defaults to `VITE_API_URL`. */
  readonly baseUrl?: string
  /**
   * Defaults to whatever `setAccessTokenProvider` installed *at the time of
   * the request*, not at construction — see session.ts.
   */
  readonly getAccessToken?: AccessTokenProvider
  readonly fetch?: FetchLike
}

export interface RequestSpec<T> {
  readonly method: HttpMethod
  /** A path from `@qsim/contract`'s `circuitPath`, relative to the prefix. */
  readonly path: string
  readonly query?: QueryParams
  /** Serialised as JSON. `undefined` sends no body and no content type. */
  readonly body?: unknown
  /**
   * The contract schema the response is parsed with, or `null` for a route
   * that answers 204. Not optional: a route whose response nobody validates
   * is how a shape drifts unnoticed, so skipping it has to be deliberate.
   */
  readonly schema: ResponseSchema<T> | null
  /** React Query passes one; aborting must stay abort, not become an error. */
  readonly signal?: AbortSignal
}

export interface ApiClient {
  readonly baseUrl: string
  request: {
    <T>(spec: RequestSpec<T> & { schema: ResponseSchema<T> }): Promise<T>
    (spec: RequestSpec<void> & { schema: null }): Promise<void>
  }
}

function buildQuery(query: QueryParams | undefined): string {
  if (query === undefined) return ''
  const search = new URLSearchParams()
  for (const [key, value] of Object.entries(query)) {
    // `undefined` is "not specified" and must not become the string
    // "undefined", which is what URLSearchParams would happily send.
    if (value === undefined) continue
    search.set(key, String(value))
  }
  const rendered = search.toString()
  return rendered === '' ? '' : `?${rendered}`
}

/**
 * `AbortError` is not a failure to report, it is a request nobody wants any
 * more — React Query aborts the previous fetch on every keystroke of a
 * search. Wrapping it in an `ApiRequestError` would make the cancellation
 * look like a network problem and put a red banner on screen for working
 * software.
 *
 * Matched by `name` rather than by `instanceof DOMException`, because a
 * `DOMException` does not extend `Error` in every runtime and not every
 * runtime throws one: the name is the part the specification pins down.
 */
function isAbortError(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    (error as { name?: unknown }).name === 'AbortError'
  )
}

/** Reads the error body if there is one, without ever letting it throw. */
async function readErrorBody(response: Response): Promise<unknown> {
  try {
    return await response.json()
  } catch {
    return null
  }
}

async function toRequestError(response: Response): Promise<ApiRequestError> {
  const status = response.status
  const parsed = ErrorResponseSchema.safeParse(await readErrorBody(response))

  if (!parsed.success) {
    /*
     * Not an API error body at all: a proxy's HTML page, an empty 502, a
     * captive portal. The status is still meaningful, and mapping it keeps
     * the one distinction the UI depends on — 401 versus 403 — alive even
     * when nothing else about the response survived.
     */
    return new ApiRequestError(errorCodeForStatus(status), { status })
  }

  const { code, requestId, details } = parsed.data.error
  if (isApiErrorCode(code)) {
    return new ApiRequestError(code, { status, requestId, details })
  }

  /*
   * A code from an API newer than this bundle. Falling back to the status
   * keeps the message sensible, and `serverCode` keeps the real one visible
   * in a console or a bug report.
   */
  return new ApiRequestError(errorCodeForStatus(status), {
    status,
    requestId,
    details,
    serverCode: code,
  })
}

export function createApiClient(options: ApiClientOptions = {}): ApiClient {
  const baseUrl = options.baseUrl ?? resolveApiBaseUrl()
  const doFetch = options.fetch ?? ((input, init) => fetch(input, init))

  async function accessToken(): Promise<string | null> {
    const provider = options.getAccessToken ?? currentAccessTokenProvider()
    try {
      return await provider()
    } catch (cause) {
      /*
       * The provider failing is not the same as having no session. Treating
       * it as anonymous would quietly show a signed-in user the public view,
       * which looks exactly like a permissions bug and is impossible to
       * diagnose from a screenshot.
       */
      throw new ApiRequestError('SESSION_UNAVAILABLE', { cause })
    }
  }

  async function request<T>(spec: RequestSpec<T>): Promise<T | void> {
    const token = await accessToken()

    const headers: Record<string, string> = { Accept: 'application/json' }
    if (spec.body !== undefined) headers['Content-Type'] = 'application/json'
    if (token !== null) headers.Authorization = `Bearer ${token}`

    const url = `${baseUrl}${API_PREFIX}${spec.path}${buildQuery(spec.query)}`

    let response: Response
    try {
      response = await doFetch(url, {
        method: spec.method,
        headers,
        ...(spec.body === undefined ? {} : { body: JSON.stringify(spec.body) }),
        ...(spec.signal === undefined ? {} : { signal: spec.signal }),
      })
    } catch (cause) {
      if (isAbortError(cause)) throw cause
      throw new ApiRequestError('NETWORK_UNREACHABLE', { cause })
    }

    if (!response.ok) throw await toRequestError(response)

    // 204, and every other route that promises no body. Reading `.json()`
    // here would throw on the empty payload.
    if (spec.schema === null) return

    let payload: unknown
    try {
      payload = await response.json()
    } catch (cause) {
      throw new ApiRequestError('RESPONSE_MALFORMED', {
        status: response.status,
        cause,
      })
    }

    const parsed = spec.schema.safeParse(payload)
    if (!parsed.success) {
      /*
       * The response was a 200 and it was not the shape the contract
       * promises. Failing here rather than returning it is the point of
       * sharing schemas at all: the alternative is a card rendering
       * `undefined` and a developer bisecting the UI for a server change.
       */
      throw new ApiRequestError('RESPONSE_MALFORMED', {
        status: response.status,
        cause: parsed.error,
      })
    }
    return parsed.data
  }

  return { baseUrl, request }
}
