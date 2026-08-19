/**
 * Cache keys, built by a factory rather than written out at each call site.
 *
 * The reason is invalidation. `queryClient.invalidateQueries({ queryKey })`
 * matches by prefix, so the *shape* of a key decides what a mutation can
 * invalidate. Hand-written arrays drift — `['circuit', id]` here and
 * `['circuits', id]` there — and the symptom is not an error: it is a screen
 * that keeps showing the old title after a rename, because the invalidation
 * matched nothing.
 *
 * The hierarchy is deliberate:
 *
 *     ['circuits']                          everything
 *     ['circuits','list']                   every listing
 *     ['circuits','list',{page,perPage}]    one page of one listing
 *     ['circuits','detail',handle]          one circuit, and below it
 *     ['circuits','detail',handle,'versions',…]
 *
 * so that saving a version invalidates that circuit and its history without
 * touching anybody else's, while creating a circuit invalidates every listing
 * and no detail.
 *
 * A circuit is addressed by `handle` — a slug or an id, whichever the caller
 * has — because that is what the route accepts. The same circuit reached both
 * ways occupies two cache entries, which costs one extra fetch and is far
 * better than the alternative of pretending the two are one and serving a
 * cache entry under an address that was never requested.
 */

import type {
  CommentQueryParams,
  GalleryQueryParams,
  PaginationParams,
} from '@qsim/contract'

export const circuitKeys = {
  all: ['circuits'] as const,

  lists: () => [...circuitKeys.all, 'list'] as const,
  list: (params: PaginationParams = {}) =>
    [
      ...circuitKeys.lists(),
      { page: params.page, perPage: params.perPage },
    ] as const,

  details: () => [...circuitKeys.all, 'detail'] as const,
  detail: (handle: string) => [...circuitKeys.details(), handle] as const,

  versions: (handle: string) =>
    [...circuitKeys.detail(handle), 'versions'] as const,
  versionList: (handle: string, params: PaginationParams = {}) =>
    [
      ...circuitKeys.versions(handle),
      { page: params.page, perPage: params.perPage },
    ] as const,
  version: (handle: string, versionNum: number) =>
    [...circuitKeys.versions(handle), versionNum] as const,
} as const

/**
 * The public listings (M1.5b), under their own root rather than beneath
 * `circuits`.
 *
 * They are a different question about a different set of rows: `circuits` is
 * "mine", the gallery is "everyone's, filtered by §11". Nesting them would
 * make `invalidateQueries({ queryKey: circuitKeys.lists() })` — which every
 * save and every delete already fires — refetch every gallery page the reader
 * has scrolled through, on a route whose pages are cursor-linked and therefore
 * expensive to rebuild.
 *
 *     ['gallery']                                    everything public
 *     ['gallery','browse',{sort,tag,q,limit}]        one selection, all pages
 *     ['gallery','user',username,{sort,tag,q,limit}] one author's listing
 *
 * The cursor is deliberately absent from the key, and `limit` deliberately is
 * not. React Query's infinite query holds every page of one selection under a
 * single entry — that is what makes "show more" append rather than replace —
 * so a key that varied with the cursor would give each page its own cache line
 * and no listing at all. A different page size, on the other hand, is a
 * different listing: its cursors do not describe positions in the other one.
 */
export const galleryKeys = {
  all: ['gallery'] as const,

  browses: () => [...galleryKeys.all, 'browse'] as const,
  browse: (params: GalleryQueryParams = {}) =>
    [...galleryKeys.browses(), selectionOf(params)] as const,

  users: () => [...galleryKeys.all, 'user'] as const,
  user: (username: string, params: GalleryQueryParams = {}) =>
    [...galleryKeys.users(), username, selectionOf(params)] as const,
} as const

/**
 * Everything about a request that decides *which listing* it is, spelled out
 * field by field rather than spread.
 *
 * Spreading would put the cursor in the key the first time somebody passed a
 * whole `GalleryQueryParams` through, which is the one field that must not be
 * there — and the failure would be a "show more" that silently replaced the
 * listing instead of growing it.
 */
/**
 * The account and the collections (M1.9), each under their own root.
 *
 * `account` is one row and has no listing beneath it, so it is a single key.
 * It is separate from `gallery` and from `circuits` because the thing that
 * invalidates it is different from what invalidates either: renaming yourself
 * changes every byline in every listing, which is why `useUpdateProfile`
 * invalidates all three rather than trying to patch cards in place.
 *
 *     ['account']                       the caller's own row
 *     ['collections']                   everything about collections
 *     ['collections','list',{page}]     the caller's own index
 *     ['collections','detail',id]       one collection and its items
 *     ['collections','user',username,…] one author's, on their profile
 *     ['collections','holding',handle]  which of mine hold this circuit
 */
export const accountKeys = {
  all: ['account'] as const,
  me: () => [...accountKeys.all, 'me'] as const,
  profile: (username: string) =>
    [...accountKeys.all, 'profile', username] as const,
} as const

/**
 * The caller's API keys (§3.5), under their own root rather than beneath
 * `account`.
 *
 * They are not part of the account row and they change for different reasons:
 * renaming yourself invalidates `account` and every byline in the gallery, and
 * has nothing whatever to say about which credentials exist. Nesting them
 * would make every profile save refetch a list of credentials, which is both
 * pointless and the sort of request that looks alarming in a log.
 *
 * There is deliberately no `detail(id)`. A single key is never fetched: no
 * route returns one on its own, the listing carries everything there is, and a
 * key-shaped cache entry would be the first place somebody tried to keep a
 * secret that must not survive its own response.
 */
export const apiKeyKeys = {
  all: ['api-keys'] as const,
  list: () => [...apiKeyKeys.all, 'list'] as const,
} as const

export const collectionKeys = {
  all: ['collections'] as const,

  lists: () => [...collectionKeys.all, 'list'] as const,
  list: (params: PaginationParams = {}) =>
    [
      ...collectionKeys.lists(),
      { page: params.page, perPage: params.perPage },
    ] as const,

  details: () => [...collectionKeys.all, 'detail'] as const,
  detail: (id: string) => [...collectionKeys.details(), id] as const,

  users: () => [...collectionKeys.all, 'user'] as const,
  user: (username: string, params: PaginationParams = {}) =>
    [
      ...collectionKeys.users(),
      username,
      { page: params.page, perPage: params.perPage },
    ] as const,

  holding: (handle: string) =>
    [...collectionKeys.all, 'holding', handle] as const,
} as const

/**
 * The signed-in reader's lesson bookmarks (Phase 3), under a root of their
 * own.
 *
 * One key and no sub-keys, because there is one request: `GET
 * /lessons/progress` returns every lesson the caller has touched in one
 * response — §3.6 plans nine, so a page of bookmarks would be a page of a
 * page. The player writes one lesson at a time and updates this entry in
 * place rather than invalidating it, which is what keeps a step change from
 * costing a round trip on every press of "next".
 *
 *     ['lessons','progress']    every bookmark this caller has
 */
export const lessonKeys = {
  all: ['lessons'] as const,
  progress: () => [...lessonKeys.all, 'progress'] as const,
} as const

/**
 * Challenges (Phase 3), under a root of their own.
 *
 *     ['challenges','list']                    the ladder, with solved marks
 *     ['challenges','detail',slug]             the rules and this reader's best
 *     ['challenges','detail',slug,'board',n]   one page of the leaderboard
 *
 * The leaderboard is nested *under* the challenge rather than beside it, which
 * is the opposite of what `galleryKeys` does with the gallery, and the
 * difference is what invalidation costs. A pass changes exactly one challenge's
 * board, so `invalidateQueries({ queryKey: challengeKeys.leaderboards(slug) })`
 * refetches that one and leaves the other eight alone — while a gallery star
 * genuinely can move any page of any listing, which is why that key is flat.
 *
 * `limit` is part of the key because a board of ten and a board of fifty are
 * different answers to different questions, and serving one under the other's
 * address would silently truncate a page the reader asked to expand.
 */
/**
 * Hardware jobs (§3.7), under a root of their own.
 *
 *     ['hardware','job',id]    one stored job, with its program and its result
 *
 * Separate from `circuits` even though a job belongs to a circuit, and the
 * reason is what invalidation would cost in the other direction: every save of
 * a circuit fires `invalidateQueries({ queryKey: circuitKeys.detail(handle) })`,
 * and a job nested beneath that key would be refetched by an edit — while the
 * job itself is **immutable once it is DONE**. Editing the document cannot
 * change what a device measured yesterday, and a page that refetched the
 * measurement because somebody moved a gate would be claiming otherwise.
 *
 * There is no listing key here, because this milestone's route reads one job by
 * id. A `['hardware','jobs',…]` sits naturally beneath `all` when a listing
 * arrives.
 */
export const hardwareKeys = {
  all: ['hardware'] as const,

  jobs: () => [...hardwareKeys.all, 'job'] as const,
  job: (id: string) => [...hardwareKeys.jobs(), id] as const,

  /** The caller's stored keys. One list, so one key and no parameters. */
  credentials: () => [...hardwareKeys.all, 'credential'] as const,

  /**
   * The devices one credential can see, keyed *by that credential*.
   *
   * Two keys on one account can be pointed at different instances and see
   * different devices with different queues, so a single `['backends']` would
   * serve one credential's fleet to the other and rank a queue that was never
   * measured. It is also why this is not invalidated when a credential is
   * added: the new one has its own entry and nothing already cached is stale.
   */
  backends: (credentialId: string) =>
    [...hardwareKeys.all, 'backends', credentialId] as const,
} as const

/**
 * A circuit's comment threads (§3.4, Fase 5), under a root of their own rather
 * than beneath `circuitKeys.detail(handle)`.
 *
 * Nesting is the reflex here — a comment belongs to a circuit, which is exactly
 * what `collectionKeys.holding` argues for — and it is wrong for the reason
 * `hardwareKeys` gives: `circuitKeys.detail(handle)` is invalidated by every
 * save, every rename and every visibility change, and none of those can change
 * what anybody said about a gate. A conversation refetched because the author
 * moved a gate is a request that always returns the same rows, on the one screen
 * where an extra round trip is paid by everybody.
 *
 *     ['comments','circuit',handle]              every listing of one circuit's
 *     ['comments','circuit',handle,{state,…}]    one page of one selection
 *
 * The handle is part of the key for the reason `circuitKeys` states: the same
 * circuit reached by slug and by id occupies two entries, which costs one fetch
 * and is better than serving a cache line under an address nobody asked for.
 *
 * `anchorOpId` is in the selection because narrowing to one gate is a different
 * listing, and `state` is because "open" and "all" are different sets — while
 * the *counts* travel in every response, so a filter change never has to guess
 * what the other side of it holds.
 */
export const commentKeys = {
  all: ['comments'] as const,

  circuits: () => [...commentKeys.all, 'circuit'] as const,
  circuit: (handle: string) => [...commentKeys.circuits(), handle] as const,
  list: (handle: string, params: CommentQueryParams = {}) =>
    [
      ...commentKeys.circuit(handle),
      {
        state: params.state,
        anchorOpId: params.anchorOpId,
        page: params.page,
        limit: params.limit,
      },
    ] as const,
} as const

export const challengeKeys = {
  all: ['challenges'] as const,

  list: () => [...challengeKeys.all, 'list'] as const,

  details: () => [...challengeKeys.all, 'detail'] as const,
  detail: (slug: string) => [...challengeKeys.details(), slug] as const,

  leaderboards: (slug: string) =>
    [...challengeKeys.detail(slug), 'board'] as const,
  leaderboard: (slug: string, limit?: number) =>
    [...challengeKeys.leaderboards(slug), { limit }] as const,
} as const

function selectionOf(params: GalleryQueryParams) {
  return {
    sort: params.sort,
    tag: params.tag,
    q: params.q,
    limit: params.limit,
  }
}
