/**
 * A gallery selection, read from and written to the address bar — M1.5b.
 *
 * ── Why the selection lives in the URL ────────────────────────────────────
 *
 * Because a filtered listing is a *place*: Back should return to it, a reload
 * should stay on it, and a link to it should work. `routes/circuits.tsx` makes
 * the same argument for its page number, and the same caveat applies — these
 * are safe to expose precisely because none of them is access control. A sort
 * order, a tag and a search term change which of the circuits a viewer may
 * already see are shown; §11 decides the "may" on the server, every time.
 *
 * ── Why the parsing is here and not in the route ──────────────────────────
 *
 * The selection is also the React Query cache key (`galleryKeys.browse`), so
 * two spellings of one selection — `?sort=recent` and no sort at all — must
 * not become two cache entries for one listing. Normalising in one pure
 * function is what makes that true; a component reading `searchParams.get`
 * inline would be a second normalisation, and the drift would show as a
 * listing that refetches when nothing changed.
 *
 * Everything here is a pure function of a `URLSearchParams`, which is what
 * makes it testable without a router.
 */

import {
  DEFAULT_GALLERY_SORT,
  GALLERY_SORTS,
  MAX_SEARCH_LENGTH,
  MAX_TAG_QUERY_LENGTH,
} from '@qsim/contract'
import type { GallerySort } from '@qsim/contract'

import type { GallerySelection } from '../../lib/api/useGallery'

export const SORT_PARAM = 'sort'
export const TAG_PARAM = 'tag'
export const SEARCH_PARAM = 'q'

/** Every parameter this feature owns, so a reset can clear exactly them. */
export const SELECTION_PARAMS = [SORT_PARAM, TAG_PARAM, SEARCH_PARAM] as const

function isSort(value: string): value is GallerySort {
  return (GALLERY_SORTS as readonly string[]).includes(value)
}

/**
 * The selection an address describes.
 *
 * A `sort` the vocabulary does not contain falls back to the default rather
 * than travelling to the server: the API would answer 400, and a hand-edited
 * or stale URL should show the gallery rather than an error about a parameter
 * the reader did not type. The tag and the term are *not* validated the same
 * way — they are content, the server has the authority on what is spellable,
 * and silently dropping one would answer a different question than the one
 * asked.
 *
 * Both are still bounded here, because the bound is the server's and a request
 * it is certain to refuse is a request worth not making.
 */
export function selectionFromSearch(search: URLSearchParams): GallerySelection {
  const sort = search.get(SORT_PARAM) ?? ''
  const tag = (search.get(TAG_PARAM) ?? '').trim()
  const term = (search.get(SEARCH_PARAM) ?? '').trim()

  return {
    sort: isSort(sort) ? sort : DEFAULT_GALLERY_SORT,
    ...(tag === '' ? {} : { tag: tag.slice(0, MAX_TAG_QUERY_LENGTH) }),
    ...(term === '' ? {} : { q: term.slice(0, MAX_SEARCH_LENGTH) }),
  }
}

/**
 * The same address with one selection replaced, leaving every other parameter
 * alone.
 *
 * Every field is written or removed rather than merged, so "clear the tag" is
 * expressible — the whole selection is one value, and a partial write would
 * leave the address describing a state nothing produced. Parameters this
 * feature does not own survive untouched, which is what lets a language or a
 * future flag ride along in the same URL.
 */
export function searchWithSelection(
  search: URLSearchParams,
  selection: GallerySelection
): URLSearchParams {
  const next = new URLSearchParams(search)

  // The default is expressed by absence. A `?sort=recent` that means exactly
  // what no parameter means is a longer URL and a second cache key.
  if (selection.sort === undefined || selection.sort === DEFAULT_GALLERY_SORT) {
    next.delete(SORT_PARAM)
  } else {
    next.set(SORT_PARAM, selection.sort)
  }

  for (const [key, value] of [
    [TAG_PARAM, selection.tag],
    [SEARCH_PARAM, selection.q],
  ] as const) {
    const text = (value ?? '').trim()
    if (text === '') next.delete(key)
    else next.set(key, text)
  }

  return next
}

/** Whether anything is narrowing the listing — what an empty state must know. */
export function isFiltered(selection: GallerySelection): boolean {
  return (selection.tag ?? '') !== '' || (selection.q ?? '') !== ''
}
