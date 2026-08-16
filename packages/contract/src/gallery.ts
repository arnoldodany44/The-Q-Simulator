/**
 * The gallery's wire contract — §3.4 and §8, milestone M1.5.
 *
 * ── What this file is guarding ────────────────────────────────────────────
 *
 * The gallery is the only unauthenticated *listing* in the API, over a table
 * that also holds every PRIVATE circuit in the database. The visibility rule
 * itself lives in `@qsim/db` and is applied inside the query; what lives here
 * is the other half — the shape of what a caller may ask for, bounded so that
 * no request can turn a cheap indexed lookup into a scan of the whole table.
 *
 * Three bounds do that work, and each one is a decision rather than a
 * default:
 *
 *   - `q` is at least three characters, because the search index is a
 *     trigram index and a term shorter than a trigram cannot use it. Without
 *     this bound, `?q=a` is a sequential scan over every circuit, on a route
 *     anyone can call.
 *   - `q` is at most `MAX_SEARCH_LENGTH`, because the recheck cost of an
 *     `ILIKE` grows with the pattern and nobody searches in paragraphs.
 *   - `cursor` is at most `MAX_CURSOR_LENGTH`, so a megabyte of base64 is
 *     rejected before anything decodes or parses it.
 *
 * The wildcard problem — a term of `%%%` matching everything — is *not*
 * solved here. It cannot be: escaping is a property of the query language,
 * so it belongs beside the query, in `@qsim/db`'s `escapeLikePattern`.
 */

import { storableText } from '@qsim/schema'
import { z } from 'zod'
import { pageNumber } from './circuits.js'

/**
 * The orderings §8 names, re-declared here for the same reason `Visibility`
 * is: `apps/web` may not import `@qsim/db`, and a third independent spelling
 * inside the browser would be the one nothing checks. `apps/api` imports both
 * and asserts they agree.
 */
export const GALLERY_SORTS = ['recent', 'stars'] as const

export type GallerySort = (typeof GALLERY_SORTS)[number]

export const GallerySortSchema = z.enum(GALLERY_SORTS)

/**
 * What the gallery shows when nobody says.
 *
 * `recent` rather than `stars`, and not arbitrarily: on a young gallery
 * everything has zero stars, so a star ordering is an arbitrary ordering
 * wearing a meaningful name, and the circuits somebody just published — the
 * reason to visit at all — would be unreachable behind whatever the tie-break
 * happened to put first.
 */
export const DEFAULT_GALLERY_SORT: GallerySort = 'recent'

/** A trigram is three characters. Shorter than that cannot use the index. */
export const MIN_SEARCH_LENGTH = 3
export const MAX_SEARCH_LENGTH = 64

/** Longest tag a `?tag=` filter may name, before normalisation. */
export const MAX_TAG_QUERY_LENGTH = 64

/** Mirrors `MAX_CURSOR_LENGTH` in `@qsim/db`; `apps/api` asserts they agree. */
export const MAX_CURSOR_LENGTH = 256

/** Largest page the gallery will serve, whatever `limit` asks for. */
export const MAX_GALLERY_LIMIT = 50
/** What `limit` means when a client does not say. */
export const DEFAULT_GALLERY_LIMIT = 20

/**
 * A search term.
 *
 * `storableText` for the same reason every other free-text field has it: a
 * U+0000 in a query parameter reaches Postgres as an invalid UTF-8 byte and
 * comes back as a driver error, which is a 500 produced by one character
 * anybody can type into a URL.
 */
const SearchSchema = storableText(
  z.string().trim().min(MIN_SEARCH_LENGTH).max(MAX_SEARCH_LENGTH)
)

const TagQuerySchema = storableText(
  z.string().trim().min(1).max(MAX_TAG_QUERY_LENGTH)
)

/**
 * Everything a gallery request may carry. Every field is optional and every
 * default is the server's.
 *
 * `limit` is parsed with the same rule as a page number — decimal digits
 * only, never `Number()`'s grammar — for the reason argued on `pageNumber`:
 * `?limit=0x20` is not a number a person typed.
 */
export const GalleryQuerySchema = z.object({
  sort: GallerySortSchema.default(DEFAULT_GALLERY_SORT),
  tag: TagQuerySchema.optional(),
  q: SearchSchema.optional(),
  cursor: z.string().max(MAX_CURSOR_LENGTH).optional(),
  limit: pageNumber(MAX_GALLERY_LIMIT, DEFAULT_GALLERY_LIMIT),
})

/** A resolved gallery selection: what the server ends up working with. */
export type GalleryQuery = z.output<typeof GalleryQuerySchema>
/** What a caller may ask for. Every field has a server-side default. */
export type GalleryQueryParams = Partial<z.input<typeof GalleryQuerySchema>>

/**
 * The state of one viewer's star on one circuit.
 *
 * Both `POST` and `DELETE` answer with this rather than 204, and the reason
 * is the denormalised counter: the client has just changed a number that is
 * rendered on every card, and the alternative to sending it back is an
 * optimistic guess that drifts from the server the first time two tabs
 * disagree. `starred` is this viewer's own state, which is what the button
 * draws.
 */
export const StarStateResponse = z.object({
  starred: z.boolean(),
  starCount: z.int(),
})

export type StarState = z.infer<typeof StarStateResponse>
