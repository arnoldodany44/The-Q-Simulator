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

import type { PaginationParams } from '@qsim/contract'

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
