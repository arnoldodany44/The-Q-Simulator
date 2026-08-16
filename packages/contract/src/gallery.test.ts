import { describe, expect, it } from 'vitest'
import {
  DEFAULT_GALLERY_LIMIT,
  DEFAULT_GALLERY_SORT,
  GalleryQuerySchema,
  MAX_CURSOR_LENGTH,
  MAX_GALLERY_LIMIT,
  MAX_SEARCH_LENGTH,
  MIN_SEARCH_LENGTH,
  StarStateResponse,
} from './gallery.js'

/**
 * The gallery's request bounds.
 *
 * Every assertion here is about the same thing: this is the one listing an
 * anonymous caller can drive, so the shape of what they may ask for is part
 * of its cost. A term the index cannot serve, a cursor a megabyte long, a
 * limit of ten thousand — each of those is a way to make the server work that
 * costs the caller nothing.
 */

describe('the gallery query', () => {
  it('applies the server defaults when a caller says nothing', () => {
    expect(GalleryQuerySchema.parse({})).toEqual({
      sort: DEFAULT_GALLERY_SORT,
      limit: DEFAULT_GALLERY_LIMIT,
    })
  })

  it('defaults to recent, not to stars', () => {
    /*
     * On a young gallery everything has zero stars, so a star ordering is an
     * arbitrary one wearing a meaningful name — and the circuits somebody
     * just published would be unreachable behind whatever the tie-break put
     * first.
     */
    expect(GalleryQuerySchema.parse({}).sort).toBe('recent')
  })

  it('accepts only the two orderings §8 names', () => {
    expect(GalleryQuerySchema.parse({ sort: 'stars' }).sort).toBe('stars')
    expect(GalleryQuerySchema.safeParse({ sort: 'starCount' }).success).toBe(
      false
    )
    expect(GalleryQuerySchema.safeParse({ sort: 'RECENT' }).success).toBe(false)
  })

  it('refuses a search term the trigram index cannot serve', () => {
    /*
     * The one bound that is about the database rather than about taste: a
     * term shorter than a trigram produces no trigrams, so `?q=a` cannot use
     * `Circuit_title_trgm_idx` and becomes a sequential scan of every circuit
     * in the table — on an unauthenticated route.
     */
    expect(GalleryQuerySchema.safeParse({ q: 'a' }).success).toBe(false)
    expect(GalleryQuerySchema.safeParse({ q: 'ab' }).success).toBe(false)
    expect(GalleryQuerySchema.parse({ q: 'ghz' }).q).toBe('ghz')
    expect(MIN_SEARCH_LENGTH).toBe(3)
  })

  it('trims a search term before measuring it', () => {
    expect(GalleryQuerySchema.parse({ q: '  grover  ' }).q).toBe('grover')
    expect(GalleryQuerySchema.safeParse({ q: '     ' }).success).toBe(false)
  })

  it('refuses a search term of pathological length', () => {
    expect(
      GalleryQuerySchema.parse({ q: 'a'.repeat(MAX_SEARCH_LENGTH) }).q
    ).toHaveLength(MAX_SEARCH_LENGTH)
    expect(
      GalleryQuerySchema.safeParse({ q: 'a'.repeat(MAX_SEARCH_LENGTH + 1) })
        .success
    ).toBe(false)
  })

  it('accepts a term made of wildcards, because escaping is not its job', () => {
    /*
     * `%` and `_` are ordinary characters to a person searching for "100%".
     * Refusing them here would be the wrong fix for the right worry — the
     * pattern language is escaped where the query is built, in @qsim/db.
     */
    expect(GalleryQuerySchema.parse({ q: '%%%' }).q).toBe('%%%')
    expect(GalleryQuerySchema.parse({ q: '100% sure' }).q).toBe('100% sure')
  })

  it('refuses a NUL in a search term or a tag', () => {
    // It reaches Postgres as an invalid UTF-8 byte and comes back as a driver
    // error — a 500 caused by one character in a URL.
    const NUL = String.fromCharCode(0)
    expect(GalleryQuerySchema.safeParse({ q: `bell${NUL}` }).success).toBe(
      false
    )
    expect(GalleryQuerySchema.safeParse({ tag: `bell${NUL}` }).success).toBe(
      false
    )
  })

  it('bounds the page size and reads it as decimal digits', () => {
    expect(GalleryQuerySchema.parse({ limit: '5' }).limit).toBe(5)
    expect(
      GalleryQuerySchema.parse({ limit: String(MAX_GALLERY_LIMIT) }).limit
    ).toBe(MAX_GALLERY_LIMIT)
    expect(
      GalleryQuerySchema.safeParse({ limit: String(MAX_GALLERY_LIMIT + 1) })
        .success
    ).toBe(false)
    expect(GalleryQuerySchema.safeParse({ limit: '0' }).success).toBe(false)
    expect(GalleryQuerySchema.safeParse({ limit: '0x20' }).success).toBe(false)
  })

  it('refuses a cursor longer than the decoder will read', () => {
    // The point of the bound: an unauthenticated route must not be a base64
    // decoder and a JSON parser for whatever a caller pastes into a URL.
    expect(
      GalleryQuerySchema.safeParse({ cursor: 'A'.repeat(MAX_CURSOR_LENGTH) })
        .success
    ).toBe(true)
    expect(
      GalleryQuerySchema.safeParse({
        cursor: 'A'.repeat(MAX_CURSOR_LENGTH + 1),
      }).success
    ).toBe(false)
  })

  it('treats the cursor as an opaque string and does not try to read it', () => {
    // The contract's job is the bound; the meaning belongs to the server,
    // and a client that parsed one would be building on a shape that is free
    // to change.
    expect(GalleryQuerySchema.parse({ cursor: 'not-a-cursor' }).cursor).toBe(
      'not-a-cursor'
    )
  })
})

describe('the star state', () => {
  it('carries the viewer’s own star and the shared count', () => {
    expect(StarStateResponse.parse({ starred: true, starCount: 3 })).toEqual({
      starred: true,
      starCount: 3,
    })
    expect(
      StarStateResponse.safeParse({ starred: true, starCount: 1.5 }).success
    ).toBe(false)
  })
})
