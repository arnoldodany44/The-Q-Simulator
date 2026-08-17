/**
 * The one request an embed makes.
 *
 * ═══════════════════════════════════════════════════════════════════════
 * IT DOES NOT USE `lib/api/client.ts`, AND THAT IS THE POINT
 * ═══════════════════════════════════════════════════════════════════════
 *
 * `createApiClient` is the right transport for the app: it attaches the
 * session's bearer token through `currentAccessTokenProvider`, which is what
 * makes every screen in the product work. That is precisely what an embed must
 * not do.
 *
 * The reasoning is not "the token would probably be absent". An embed is
 * served from the app's own origin, so a frame running in that origin sits on
 * top of the same `localStorage` the Supabase session lives in — and if this
 * file used the shared client, a reader who happens to be signed in would send
 * their token from inside a stranger's page, on every frame, on every page
 * load. Whether the API then answered differently is a second question; the
 * first is that the credential left.
 *
 * So the embed has its own eleven-line transport with three properties the
 * shared one cannot be made to promise:
 *
 *   1. no `Authorization` header exists anywhere in this module;
 *   2. `credentials: 'omit'`, so no cookie is attached even if this project
 *      ever acquires one;
 *   3. nothing in the embed's module graph imports `lib/api/session.ts` or
 *      `@supabase/supabase-js` at all — `.dependency-cruiser.cjs` fails the
 *      build if that changes, which is the version of this promise that
 *      survives a refactor.
 *
 * The API is the other half and is not merely trusting this: `GET
 * /embed/:handle` is `auth: 'public'`, so the header is not consulted even
 * when one is sent.
 *
 * ═══════════════════════════════════════════════════════════════════════
 * FAILURES ARE CODES, LIKE EVERYWHERE ELSE
 * ═══════════════════════════════════════════════════════════════════════
 *
 * Three of them, and they are the three a reader can act on, not the three
 * HTTP has: the circuit is not embeddable (which includes "there is no such
 * circuit" and must, §11), this deployment has no API, and everything else.
 * `EmbedView` renders each as a sentence in the frame's language (D2).
 */

import { API_PREFIX, EmbedCircuitResponse, embedPath } from '@qsim/contract'
import type { EmbedCircuitView } from '@qsim/contract'

import { resolveApiBaseUrl } from '../lib/api/config'

export const EMBED_FETCH_ERRORS = [
  /**
   * The server would not serve it. One code for a slug that names nothing and
   * for a PRIVATE circuit alike, because the server answers both with the
   * same 404 on purpose and this client must not invent a distinction the
   * response does not carry.
   */
  'unavailable',
  /** `VITE_API_URL` is unset, so this build has no server to ask. */
  'no-api',
  /** Offline, DNS, CORS, a 500, a body that is not what the contract says. */
  'failed',
] as const

export type EmbedFetchError = (typeof EMBED_FETCH_ERRORS)[number]

export type EmbedFetchResult =
  | { readonly ok: true; readonly embed: EmbedCircuitView }
  | { readonly ok: false; readonly code: EmbedFetchError }

/** Only the part of `fetch` this module uses, so a test can be one function. */
export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>

export interface FetchEmbedOptions {
  readonly fetch?: FetchLike
  /** Injected by tests; production reads `import.meta.env`. */
  readonly baseUrl?: string | null
  readonly signal?: AbortSignal
}

export async function fetchEmbed(
  slug: string,
  options: FetchEmbedOptions = {}
): Promise<EmbedFetchResult> {
  const baseUrl =
    options.baseUrl === undefined ? resolveApiBaseUrl() : options.baseUrl
  if (baseUrl === null) return { ok: false, code: 'no-api' }

  const doFetch = options.fetch ?? globalThis.fetch.bind(globalThis)
  const url = `${baseUrl}${API_PREFIX}${embedPath.item(slug)}`

  let response: Response
  try {
    response = await doFetch(url, {
      method: 'GET',
      headers: { accept: 'application/json' },
      /*
       * Never `include`, and never the `same-origin` default either: the
       * request is cross-origin (the API is a different host), so the default
       * would already omit cookies — but stating it means the guarantee
       * survives the day somebody puts the API behind the app's own domain.
       */
      credentials: 'omit',
      ...(options.signal === undefined ? {} : { signal: options.signal }),
    })
  } catch {
    return { ok: false, code: 'failed' }
  }

  // 404 is the embeddability answer. 403 cannot happen — the API never sends
  // one here, because a 403 would confirm the circuit exists — but it is
  // folded in rather than left to `failed`, so that a future server which
  // regressed to sending one still reads as "not embeddable" to a reader.
  if (response.status === 404 || response.status === 403) {
    return { ok: false, code: 'unavailable' }
  }
  if (!response.ok) return { ok: false, code: 'failed' }

  let body: unknown
  try {
    body = await response.json()
  } catch {
    return { ok: false, code: 'failed' }
  }

  /*
   * Parsed through the contract rather than cast. A body that is not what the
   * API promised — a Vercel rewrite answering with `index.html` because the
   * origin was misconfigured, which is a failure this project has actually had
   * — fails here, once, instead of becoming `undefined` inside a renderer.
   */
  const parsed = EmbedCircuitResponse.safeParse(body)
  if (!parsed.success) return { ok: false, code: 'failed' }
  return { ok: true, embed: parsed.data.embed }
}
