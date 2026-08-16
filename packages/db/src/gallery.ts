import { normalizeTagName } from './tags.js'
import type { Prisma } from './generated/prisma/client.js'
import { listableCircuitFilter } from './visibility.js'
import type { ViewerId } from './visibility.js'

/**
 * The gallery query — §3.4 and §8, milestone M1.5.
 *
 * ── The one thing this file exists to prevent ─────────────────────────────
 *
 * The gallery is an unauthenticated *list* over a table that also holds every
 * PRIVATE circuit in the database. Prisma connects as `postgres`, which owns
 * these tables and carries `rolbypassrls`, so Postgres enforces nothing for
 * us: the only thing between a private circuit and an anonymous reader is
 * that somebody remembered a `where`. One forgotten filter does not fail a
 * test — it publishes the whole table at once.
 *
 * So there is no way to build a gallery `where` except through
 * `galleryWhere`, and `galleryWhere` starts from `listableCircuitFilter` and
 * then only ever *narrows*. Every knob a caller has — tag, search, cursor,
 * owner — is an `AND` on top of that. Adding a filter cannot widen the
 * result set, whatever the filter is, because conjunction cannot.
 *
 * ── Search: trigrams, and why not tsvector ────────────────────────────────
 *
 * The comparison is written out in full in the migration that adds the index
 * (`20260815231448_gallery_search_and_tag_indexes`). In one paragraph:
 * `to_tsvector` needs a text-search configuration, a configuration names one
 * language, and this product is trilingual by decision (D2), so two thirds of
 * the corpus would be stemmed by the wrong dictionary — and a lexeme index
 * cannot match inside a word, while a person typing "grov" into a search box
 * expects Grover. `pg_trgm` has no opinion about language, matches anywhere
 * in a word, and turns `ILIKE '%grov%'` into an index lookup. Its price is
 * that a term under three characters yields no trigrams and cannot use the
 * index, which is why @qsim/contract refuses one.
 *
 * The term itself is never interpolated: it travels as a bound parameter,
 * with the LIKE metacharacters escaped here so a search for `%` is a search
 * for a percent sign rather than a request for the entire table.
 */

/** The orderings §8 names. */
export const GALLERY_SORTS = ['recent', 'stars'] as const

export type GallerySort = (typeof GALLERY_SORTS)[number]

export function isGallerySort(value: unknown): value is GallerySort {
  return (
    typeof value === 'string' &&
    (GALLERY_SORTS as readonly string[]).includes(value)
  )
}

/**
 * Escapes the three characters `LIKE` treats as syntax.
 *
 * Prisma's `contains` builds `ILIKE '%' || value || '%'` and passes the value
 * as a parameter — which is what stops it being SQL injection — but it does
 * *not* escape the pattern language inside it. So a search for `%` reaches
 * Postgres as `%%%` and matches every row, and `_` matches any character.
 * Neither is a security hole, but both are wrong answers, and a gallery that
 * returns everything for a one-character query is also the cheapest way to
 * make the server work.
 *
 * The backslash goes first, or escaping the others would double-escape it.
 * Backslash is Postgres's default `LIKE` escape character, so no `ESCAPE`
 * clause is needed — and Prisma gives us nowhere to put one anyway.
 */
export function escapeLikePattern(term: string): string {
  return term.replace(/\\/g, '\\\\').replace(/%/g, '\\%').replace(/_/g, '\\_')
}

/**
 * A position in a sorted gallery: the sort key of the last row a client has
 * seen, plus the id that breaks ties.
 *
 * ── Why a cursor and not `?page=` ─────────────────────────────────────────
 *
 * §8 spells the gallery `?page=`, and an offset is wrong here for a reason
 * that has nothing to do with performance. `OFFSET 40` means "skip the first
 * forty rows *of the query as it is now*", and the gallery's default ordering
 * is `starCount`, a column other people change while a reader is reading. One
 * star awarded to a circuit on page 1 pushes a row across the boundary, and
 * page 3 then either repeats a circuit or skips one — silently, with no way
 * for the client to detect it. A keyset says "the rows after *this* one",
 * which is a stable question whatever happened above it.
 *
 * It is also the cheaper query: `OFFSET 10000` makes Postgres walk ten
 * thousand index entries to throw them away, while a keyset seeks straight to
 * the position. That matters second; correctness is the argument.
 *
 * Sorting by stars is still sorting by a mutable column, and a keyset cannot
 * make that stable — if a circuit's star count changes between two requests
 * it can move across a page boundary either way. What a keyset guarantees is
 * that the *page* is a contiguous window of the ordering as it stands, rather
 * than an arithmetic slice of an ordering that has since changed underneath.
 *
 * ── What a cursor is not ──────────────────────────────────────────────────
 *
 * It is not a capability. It says where to *start*, never what may be seen:
 * the visibility filter is applied to every page independently, so a forged
 * or replayed cursor can move the window and cannot widen it. That is why it
 * is base64 rather than signed — signing would imply the value is trusted for
 * something, and it is trusted for nothing.
 */
export interface GalleryCursor {
  readonly sort: GallerySort
  /** Present for `stars` and absent for `recent`, matching the ordering. */
  readonly starCount: number | null
  readonly createdAt: Date
  readonly id: string
}

/**
 * Longest cursor string accepted, before any decoding happens.
 *
 * A well-formed cursor is around 120 characters. The cap is what stops a
 * megabyte of base64 from being decoded and parsed as JSON on an
 * unauthenticated route.
 */
export const MAX_CURSOR_LENGTH = 256

/**
 * Largest `starCount` a cursor may name: the ceiling of the `int4` column it
 * is compared against.
 *
 * WHY THIS IS NOT MERELY TIDINESS. `Circuit.starCount` is a Postgres integer,
 * and Prisma hands a `where` value to the driver as it was given. A cursor
 * carrying 2 147 483 648 therefore reaches Postgres as a number no `integer`
 * can hold, which comes back as P2020 and leaves this — an unauthenticated
 * route, the product's front page — answering 500 to anybody who can base64 a
 * JSON object. The sibling parameter `VersionParams.n` was bounded for exactly
 * this reason and this field was not.
 *
 * `Number.isSafeInteger` was never the right bound: it describes what a double
 * can represent, and the question here is what a row can hold. A star count
 * above this cannot correspond to any row, so a cursor naming one is malformed
 * and gets the answer every other unreadable cursor gets.
 */
export const MAX_STAR_COUNT = 2_147_483_647

/** The shape encoded, kept short because it rides in every gallery URL. */
interface CursorPayload {
  v: 1
  s: GallerySort
  n?: number
  t: string
  i: string
}

export function encodeGalleryCursor(cursor: GalleryCursor): string {
  const payload: CursorPayload = {
    v: 1,
    s: cursor.sort,
    ...(cursor.starCount === null ? {} : { n: cursor.starCount }),
    t: cursor.createdAt.toISOString(),
    i: cursor.id,
  }
  return Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url')
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

/**
 * Reads a cursor a client sent back, or `null` for anything that is not one.
 *
 * Everything here is a rejection rather than a repair: a cursor that does not
 * decode is a client bug or a probe, and guessing what it meant would turn
 * either into a silently wrong page. The API answers 400 and names the
 * parameter.
 *
 * `sort` is checked against the request's own `sort`, not just against the
 * vocabulary, because a cursor minted while sorting by stars describes a
 * position in an ordering that does not exist under `recent` — the keyset
 * comparison would still run and would return an arbitrary window.
 */
export function decodeGalleryCursor(
  raw: string,
  sort: GallerySort
): GalleryCursor | null {
  if (raw.length === 0 || raw.length > MAX_CURSOR_LENGTH) return null

  let payload: unknown
  try {
    payload = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8'))
  } catch {
    // Not base64, not UTF-8, or not JSON. All the same answer.
    return null
  }
  if (!isRecord(payload)) return null
  if (payload.v !== 1) return null
  if (payload.s !== sort) return null
  if (typeof payload.i !== 'string' || payload.i.length === 0) return null
  if (payload.i.length > 64) return null
  if (typeof payload.t !== 'string') return null

  const createdAt = new Date(payload.t)
  if (Number.isNaN(createdAt.getTime())) return null

  if (sort === 'stars') {
    const starCount = payload.n
    if (typeof starCount !== 'number') return null
    if (!Number.isInteger(starCount) || starCount < 0) return null
    // Bounded by the column, not by the double. See `MAX_STAR_COUNT`.
    if (starCount > MAX_STAR_COUNT) return null
    return { sort, starCount, createdAt, id: payload.i }
  }
  if (payload.n !== undefined) return null
  return { sort, starCount: null, createdAt, id: payload.i }
}

/** The cursor that resumes a listing after this row. */
export function cursorAfter(
  row: { starCount: number; createdAt: Date; id: string },
  sort: GallerySort
): string {
  return encodeGalleryCursor({
    sort,
    starCount: sort === 'stars' ? row.starCount : null,
    createdAt: row.createdAt,
    id: row.id,
  })
}

export interface GalleryQuery {
  /** `null` for an anonymous caller; otherwise a *verified* `sub` claim. */
  readonly viewerId: ViewerId
  /** Scopes the listing to one author — the profile page of §8. */
  readonly ownerId?: string | null
  readonly sort: GallerySort
  readonly tag?: string | null
  readonly search?: string | null
  readonly cursor?: GalleryCursor | null
}

/**
 * A predicate no row satisfies.
 *
 * Used where a filter cannot possibly match anything — a tag whose name
 * cannot be spelled. Returning "nothing" rather than dropping the filter is
 * the important half: a dropped filter answers a *different question* than
 * the one asked, and on this route the different question is "every circuit
 * you are allowed to see", which is exactly the answer nobody wants to
 * produce by accident.
 */
const MATCHES_NOTHING: Prisma.CircuitWhereInput = { id: { in: [] } }

/**
 * The complete `where` for a gallery page. Starts from §11 and narrows.
 *
 * Built here rather than in the repository so the Prisma implementation and
 * the in-memory one behind the API's route tests decide with the same
 * fragment rather than with two descriptions of it — which is what makes a
 * test written from a stranger's point of view mean anything.
 */
export function galleryWhere(query: GalleryQuery): Prisma.CircuitWhereInput {
  /*
   * First, and never conditionally. Everything after this can only remove
   * rows from what §11 already allows.
   */
  const and: Prisma.CircuitWhereInput[] = [
    listableCircuitFilter(query.viewerId),
  ]

  const ownerId = query.ownerId ?? null
  if (ownerId !== null) and.push({ ownerId })

  const rawTag = query.tag ?? null
  if (rawTag !== null) {
    // Normalised here as well as at the edge: the canonical spelling is what
    // was written to `Tag.name`, so a lookup under any other spelling finds
    // nothing and would look like an empty gallery rather than a mismatch.
    const tag = normalizeTagName(rawTag)
    and.push(
      tag === null
        ? MATCHES_NOTHING
        : { tags: { some: { tag: { name: tag } } } }
    )
  }

  const search = (query.search ?? '').trim()
  if (search.length > 0) {
    const contains = escapeLikePattern(search)
    and.push({
      OR: [
        { title: { contains, mode: 'insensitive' } },
        { description: { contains, mode: 'insensitive' } },
      ],
    })
  }

  const cursor = query.cursor ?? null
  if (cursor !== null) and.push(keysetFilter(cursor))

  return { AND: and }
}

/**
 * "Strictly after this row in the ordering", as a tuple comparison spelled
 * out.
 *
 * Postgres understands `(a, b) < (x, y)` natively and Prisma does not expose
 * it, so the lexicographic comparison is written by hand. It has to be the
 * *whole* tuple: comparing on `starCount` alone would drop every other row
 * with the same star count, and since most circuits have none that is most of
 * the gallery.
 */
function keysetFilter(cursor: GalleryCursor): Prisma.CircuitWhereInput {
  if (cursor.sort === 'recent') {
    return {
      OR: [
        { createdAt: { lt: cursor.createdAt } },
        { AND: [{ createdAt: cursor.createdAt }, { id: { lt: cursor.id } }] },
      ],
    }
  }

  const starCount = cursor.starCount ?? 0
  return {
    OR: [
      { starCount: { lt: starCount } },
      { AND: [{ starCount }, { createdAt: { lt: cursor.createdAt } }] },
      {
        AND: [
          { starCount },
          { createdAt: cursor.createdAt },
          { id: { lt: cursor.id } },
        ],
      },
    ],
  }
}

/**
 * The ordering, tie-broken all the way down to the primary key.
 *
 * The last term is not decoration: without a total order, two rows with the
 * same key can come back in either order on two requests, and a keyset cursor
 * built from an ambiguous position skips or repeats exactly those rows. `id`
 * is unique, so appending it makes the ordering total.
 */
export function galleryOrderBy(
  sort: GallerySort
): Prisma.CircuitOrderByWithRelationInput[] {
  if (sort === 'recent') return [{ createdAt: 'desc' }, { id: 'desc' }]
  return [{ starCount: 'desc' }, { createdAt: 'desc' }, { id: 'desc' }]
}
