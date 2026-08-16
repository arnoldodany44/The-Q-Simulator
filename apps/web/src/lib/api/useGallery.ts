/**
 * React Query hooks for the public listings — §9, milestone M1.5b.
 *
 * ── Why these are infinite queries and the owner's listing is not ─────────
 *
 * `GET /circuits` is paged by number and the gallery is paged by cursor, and
 * that is a decision the server made for a reason (`GalleryCursor` in
 * @qsim/db): the default ordering is by a column other people change while a
 * reader is reading, so an offset silently repeats or skips rows. A cursor
 * listing cannot be numbered — there is no way to ask for "page 4" without
 * walking to it — so the client shape that matches it is one accumulating
 * query with a "show more" control, not a pager.
 *
 * `useInfiniteQuery` holds every page of one selection under a single cache
 * entry, which is why the cursor is deliberately absent from the query key:
 * a key that varied with it would give each page its own cache line and there
 * would be no listing to accumulate.
 *
 * ── The star mutation is the interesting one ──────────────────────────────
 *
 * It is optimistic, because a star that waits for a round trip feels broken,
 * and it is *reconciled*, because an optimistic update that is never corrected
 * is a lie the cache keeps telling. Three callbacks divide that work:
 *
 *   - `onMutate` cancels in-flight reads (a refetch landing mid-mutation would
 *     overwrite the optimistic state with the pre-click server value),
 *     snapshots every affected cache entry, and writes the guess;
 *   - `onError` puts the snapshots back, so a refused star visibly reverts
 *     rather than leaving a filled star on a circuit nobody starred;
 *   - `onSuccess` writes the server's own `starCount`, which is the number a
 *     second tab and a hundred other readers also moved.
 *
 * What it deliberately does *not* do is invalidate the listing. Under
 * `sort=stars` a refetch would reorder the gallery under the reader's cursor
 * as a direct consequence of their own click — the card they just starred
 * jumping somewhere else while they look at it. The count on the card is
 * already the server's; the ordering catches up the next time the listing is
 * genuinely refetched.
 */

import {
  useInfiniteQuery,
  useMutation,
  useQueryClient,
} from '@tanstack/react-query'
import type {
  InfiniteData,
  QueryClient,
  UseInfiniteQueryResult,
  UseMutationResult,
} from '@tanstack/react-query'
import type {
  CircuitView,
  GalleryPage,
  GalleryQueryParams,
  StarState,
  UserCircuitsPage,
} from '@qsim/contract'

import { useApiClient } from './ApiContext.js'
import {
  listGallery,
  listUserCircuits,
  starCircuit,
  unstarCircuit,
} from './gallery.js'
import { circuitKeys, galleryKeys } from './queryKeys.js'
import {
  applyStarToPages,
  applyStarToView,
  type StarUpdate,
  type StarrablePage,
} from './stars.js'

/** What a listing selection carries; the cursor is the query's own business. */
export type GallerySelection = Omit<GalleryQueryParams, 'cursor'>

/**
 * `GET /gallery` — every PUBLIC circuit, plus the caller's own (§11).
 *
 * `initialPageParam` is `undefined` rather than `null` or `''`: the first page
 * is the request with no cursor at all, and sending `cursor=` would be a
 * cursor that does not decode, which the API answers with a 400 by design.
 */
export function useGallery(
  selection: GallerySelection = {}
): UseInfiniteQueryResult<InfiniteData<GalleryPage>, unknown> {
  const client = useApiClient()
  return useInfiniteQuery({
    queryKey: galleryKeys.browse(selection),
    queryFn: ({ pageParam, signal }) =>
      listGallery(client, { ...selection, cursor: pageParam }, { signal }),
    initialPageParam: undefined as string | undefined,
    // `null` is the server saying "that was the last page"; React Query wants
    // `undefined` for the same statement, and conflating them would leave a
    // "show more" button that fetches the first page again forever.
    getNextPageParam: (last: GalleryPage) => last.nextCursor ?? undefined,
  })
}

/** `GET /users/:username/circuits` — the same listing scoped to one author. */
export function useUserCircuits(
  username: string | null,
  selection: GallerySelection = {}
): UseInfiniteQueryResult<InfiniteData<UserCircuitsPage>, unknown> {
  const client = useApiClient()
  return useInfiniteQuery({
    queryKey: galleryKeys.user(username ?? '', selection),
    queryFn: ({ pageParam, signal }) =>
      listUserCircuits(
        client,
        username!,
        { ...selection, cursor: pageParam },
        { signal }
      ),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (last: UserCircuitsPage) => last.nextCursor ?? undefined,
    enabled: username !== null,
  })
}

export interface StarVariables {
  /**
   * What the star route is addressed by — the *slug*, always.
   *
   * Not the id, and the difference is a rule rather than a preference: an id
   * reaches only the circuits a listing may show (`idAddressableCircuitFilter`
   * is `listableCircuitFilter`), while a slug also reaches an UNLISTED one,
   * which is exactly the case where somebody is looking at a circuit they were
   * sent a link to and wants to star it.
   */
  readonly handle: string
  /** What identifies this circuit inside every cache entry that draws it. */
  readonly circuitId: string
  /** The state being asked for. Both directions are idempotent on the server. */
  readonly starred: boolean
}

/** Every cache entry that draws a star, patched with one update. */
function writeStar(queryClient: QueryClient, update: StarUpdate): void {
  queryClient.setQueriesData<InfiniteData<StarrablePage>>(
    { queryKey: galleryKeys.all },
    (data) => (data === undefined ? data : applyStarToPages(data, update))
  )
  /*
   * And the circuit's own page. Walked with a predicate rather than by key
   * because the detail cache is keyed by handle — the same circuit reached by
   * slug and by id is two entries — and `applyStarToView` checks the id before
   * touching anything, so a stale sibling entry cannot be written with another
   * circuit's state.
   */
  queryClient.setQueriesData(
    { queryKey: circuitKeys.details() },
    (data: unknown) =>
      data !== null &&
      typeof data === 'object' &&
      'circuit' in data &&
      'starred' in data
        ? applyStarToView(data as CircuitView, update)
        : data
  )
}

/**
 * `POST`/`DELETE /circuits/:id/star`, optimistic and reconciled.
 *
 * One mutation for both directions rather than two hooks: they move the same
 * two numbers in opposite directions, and a second hook would be a second
 * place for the rollback to be forgotten.
 */
export function useStarCircuit(): UseMutationResult<
  StarState,
  unknown,
  StarVariables,
  { restore: () => void }
> {
  const client = useApiClient()
  const queryClient = useQueryClient()

  return useMutation({
    mutationFn: ({ handle, starred }: StarVariables) =>
      starred ? starCircuit(client, handle) : unstarCircuit(client, handle),

    onMutate: async ({ circuitId, starred }) => {
      /*
       * A refetch already in flight would land *after* the optimistic write
       * and put the pre-click value back, which looks to the reader like a
       * star that un-starred itself half a second later.
       */
      await queryClient.cancelQueries({ queryKey: galleryKeys.all })
      await queryClient.cancelQueries({ queryKey: circuitKeys.details() })

      const listings = queryClient.getQueriesData({
        queryKey: galleryKeys.all,
      })
      const details = queryClient.getQueriesData({
        queryKey: circuitKeys.details(),
      })

      writeStar(queryClient, { circuitId, starred })

      /*
       * The undo, captured as a closure over what was there. Returning the
       * snapshots and restoring them in `onError` is the whole of "a failed
       * star must visibly revert": without it the cache keeps the guess and
       * nothing on screen ever contradicts it.
       */
      return {
        restore: () => {
          for (const [key, value] of [...listings, ...details]) {
            queryClient.setQueryData(key, value)
          }
        },
      }
    },

    onError: (_error, _variables, context) => {
      context?.restore()
    },

    onSuccess: (state, { circuitId }) => {
      // The server's count, not the guess: two tabs and a hundred other
      // readers move this number too, and the response is the only place the
      // client can learn what it actually became.
      writeStar(queryClient, {
        circuitId,
        starred: state.starred,
        starCount: state.starCount,
      })
    },
  })
}
