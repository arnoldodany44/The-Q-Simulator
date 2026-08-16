/**
 * The gallery routes of §8, as functions — milestone M1.5b.
 *
 * Same rules as `circuits.ts` beside it: the path comes from `@qsim/contract`'s
 * builders, the response is parsed with its wire schemas, and nothing is
 * declared here. The one thing worth stating separately is what a *cursor* is
 * on this side of the wire.
 *
 * ── The cursor is opaque and stays opaque ─────────────────────────────────
 *
 * `nextCursor` encodes a position in a server-side ordering. This client never
 * builds one, never parses one and never invents one: it sends back exactly
 * the string the previous page answered with. That is not superstition — the
 * encoding is free to change, and a client that understood it would be a
 * client the server could break. It is also not a credential: every page
 * re-applies the visibility filter, so a cursor moves the window and cannot
 * widen it.
 *
 * ── Why `q` is dropped below its minimum rather than sent ─────────────────
 *
 * `@qsim/contract` refuses a search term shorter than three characters,
 * because a term with no trigrams in it cannot use the index and would turn
 * the front page into a sequential scan. A search box produces one- and
 * two-character terms constantly — they are what the third keystroke is made
 * of — so sending them would mean a 400 on the way to every real query.
 * Omitting the parameter asks the honest question instead: the unfiltered
 * gallery, which is what the reader is still looking at.
 */

import {
  MIN_SEARCH_LENGTH,
  StarStateResponse,
  circuitPath,
  galleryPath,
  wireCircuitResponses,
} from '@qsim/contract'
import type {
  GalleryPage,
  GalleryQueryParams,
  StarState,
  UserCircuitsPage,
} from '@qsim/contract'

import type { ApiClient, QueryParams } from './client.js'
import type { RequestContext } from './circuits.js'

/**
 * A gallery selection as a query string.
 *
 * Every field is omitted when it is empty, so the URL a listing requests is
 * the shortest one that means what it means — which matters because that URL
 * is also this app's React Query cache key, and `?tag=` versus no tag at all
 * must not be two entries for one listing.
 */
export function galleryQuery(params: GalleryQueryParams = {}): QueryParams {
  const search = params.q?.trim() ?? ''
  return {
    sort: params.sort,
    tag: params.tag === '' ? undefined : params.tag,
    // See the header: a term the server is bound to refuse is not sent.
    q: search.length >= MIN_SEARCH_LENGTH ? search : undefined,
    cursor: params.cursor,
    limit: params.limit,
  }
}

/** `GET /gallery` — every PUBLIC circuit, plus the caller's own (§11). */
export function listGallery(
  client: ApiClient,
  params: GalleryQueryParams = {},
  context: RequestContext = {}
): Promise<GalleryPage> {
  return client.request({
    method: 'GET',
    path: galleryPath.gallery(),
    query: galleryQuery(params),
    schema: wireCircuitResponses.GalleryPageResponse,
    ...context,
  })
}

/**
 * `GET /users/:username/circuits` — one author's listing.
 *
 * The same query as the gallery with one more `AND` on the server, which is
 * why it takes the same parameters. A stranger sees that author's PUBLIC
 * circuits; the author sees all of their own.
 */
export function listUserCircuits(
  client: ApiClient,
  username: string,
  params: GalleryQueryParams = {},
  context: RequestContext = {}
): Promise<UserCircuitsPage> {
  return client.request({
    method: 'GET',
    path: galleryPath.userCircuits(username),
    query: galleryQuery(params),
    schema: wireCircuitResponses.UserCircuitsResponse,
    ...context,
  })
}

/**
 * `POST /circuits/:id/star` — idempotent, and answers with the resulting
 * state rather than 204.
 *
 * The body is what makes an optimistic star correctable: the caller has just
 * moved a counter that is rendered on every card, and `starCount` coming back
 * is the server's number rather than the client's guess.
 */
export function starCircuit(
  client: ApiClient,
  handle: string,
  context: RequestContext = {}
): Promise<StarState> {
  return client.request({
    method: 'POST',
    path: circuitPath.star(handle),
    schema: StarStateResponse,
    ...context,
  })
}

/** `DELETE /circuits/:id/star` — idempotent; unstarring twice is not -1. */
export function unstarCircuit(
  client: ApiClient,
  handle: string,
  context: RequestContext = {}
): Promise<StarState> {
  return client.request({
    method: 'DELETE',
    path: circuitPath.star(handle),
    schema: StarStateResponse,
    ...context,
  })
}
