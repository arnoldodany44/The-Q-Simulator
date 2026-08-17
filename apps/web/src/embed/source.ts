/**
 * What the address asks for — the embed's whole router.
 *
 * There is no React Router in this graph and there must not be one. An embed
 * has exactly two addresses and never navigates: it is a document dropped into
 * somebody else's page, and every link it might have offered is a link that
 * belongs in the surrounding page instead (see `EmbedView.tsx`). A router is
 * a history integration, a matcher and a context for a decision this file
 * makes in fifteen lines — and it is the sort of dependency that arrives
 * looking free and takes the rest of the app's shell with it.
 *
 * Reading the address is therefore a pure function of `(pathname, search)`,
 * called once at mount. Nothing here observes `popstate`, because nothing in
 * the frame can change the address.
 */

import {
  EMBED_CIRCUIT_ROUTE,
  EMBED_LANGUAGE_PARAM,
  EMBED_INLINE_ROUTE,
} from './paths'

/**
 * The three things an address can be asking for.
 *
 * `invalid` is a state and not an error thrown, for the reason the whole
 * embed is written around: a frame that throws renders a blank rectangle in
 * the middle of a lecture slide, and blank is the one outcome that says
 * nothing about what went wrong.
 */
export type EmbedRequest =
  | { readonly kind: 'slug'; readonly slug: string }
  | { readonly kind: 'inline'; readonly payload: string }
  | { readonly kind: 'invalid' }

export interface EmbedAddress {
  readonly request: EmbedRequest
  /**
   * The language the *teacher* pinned, or `null` to fall back to the reader's
   * browser. See `paths.ts` for why an embed does not simply detect.
   */
  readonly language: string | null
}

/**
 * The same shape a slug has everywhere else in the product: nanoid's URL-safe
 * alphabet, and a length the API's own `CIRCUIT_HANDLE_PATTERN` also accepts.
 *
 * Checked here rather than left to the server so that a path which cannot
 * possibly be a handle never becomes a request — and so the failure a reader
 * sees for `/embed/c/../../etc` is the embed's own sentence rather than a
 * network round trip ending in a 400.
 */
const SLUG_SHAPE = /^[A-Za-z0-9_-]{1,64}$/

/** The three the catalogs exist for. An unknown tag is ignored, not honoured. */
const LANGUAGES = new Set(['en', 'es', 'fr'])

export function readEmbedAddress(
  pathname: string,
  search: string
): EmbedAddress {
  const params = new URLSearchParams(search)
  const requested = params.get(EMBED_LANGUAGE_PARAM)
  const language =
    requested !== null && LANGUAGES.has(requested) ? requested : null

  return { request: readRequest(pathname, params), language }
}

function readRequest(pathname: string, params: URLSearchParams): EmbedRequest {
  if (pathname.startsWith(EMBED_CIRCUIT_ROUTE)) {
    /*
     * `decodeURIComponent` can throw on a malformed escape — `%zz` — which is
     * a thing anybody can put in an address bar. Caught rather than allowed
     * to take the frame down.
     */
    let slug: string
    try {
      slug = decodeURIComponent(pathname.slice(EMBED_CIRCUIT_ROUTE.length))
    } catch {
      return { kind: 'invalid' }
    }
    return SLUG_SHAPE.test(slug) ? { kind: 'slug', slug } : { kind: 'invalid' }
  }

  /*
   * `/embed` and `/embed.html` alike: the deployment rewrites the first to
   * the second, and in a browser that opened the built file directly the
   * pathname really is `/embed.html`. Both mean "the circuit is in the query".
   */
  if (pathname === EMBED_INLINE_ROUTE || pathname === '/embed.html') {
    const payload = params.get('c')
    return payload === null || payload === ''
      ? { kind: 'invalid' }
      : { kind: 'inline', payload }
  }

  return { kind: 'invalid' }
}
