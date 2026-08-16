import { describe, expect, it } from 'vitest'
import {
  cursorAfter,
  decodeGalleryCursor,
  encodeGalleryCursor,
  escapeLikePattern,
  GALLERY_SORTS,
  galleryOrderBy,
  galleryWhere,
  isGallerySort,
  MAX_CURSOR_LENGTH,
  MAX_STAR_COUNT,
} from './gallery.js'
import { listableCircuitFilter } from './visibility.js'

/**
 * The gallery query, asserted without a database.
 *
 * What these tests are for is narrow and important: the gallery is an
 * unauthenticated listing over a table that also holds every PRIVATE circuit,
 * and the only thing between the two is the shape of a `where`. So the shape
 * is asserted directly — that §11 is always in it, that nothing a caller
 * sends can be a sibling of it rather than a conjunct, and that the search
 * term reaches Postgres as text rather than as pattern syntax.
 *
 * That the filter *works* against real SQL is asserted separately, against
 * Postgres, in `circuits.db.test.ts`.
 */

const ANONYMOUS = null
const VIEWER = '11111111-1111-4111-8111-111111111111'

describe('the gallery filter', () => {
  it('starts from §11 and never from anything a caller sent', () => {
    const where = galleryWhere({ viewerId: ANONYMOUS, sort: 'recent' })
    expect(where.AND).toEqual([listableCircuitFilter(ANONYMOUS)])
  })

  it('keeps §11 first whatever else is asked for', () => {
    const where = galleryWhere({
      viewerId: VIEWER,
      sort: 'stars',
      tag: 'grover',
      search: 'bell',
      ownerId: 'someone-else',
      cursor: {
        sort: 'stars',
        starCount: 3,
        createdAt: new Date('2026-01-01T00:00:00Z'),
        id: 'cir_1',
      },
    })
    const conjuncts = where.AND as Record<string, unknown>[]
    expect(conjuncts[0]).toEqual(listableCircuitFilter(VIEWER))
    expect(conjuncts).toHaveLength(5)
  })

  it('is a conjunction at the top level, so no filter can widen it', () => {
    /*
     * The shape is the whole guarantee. `{ AND: [ §11, … ] }` cannot admit a
     * row §11 rejects, whatever the other conjuncts say. A top-level `OR`
     * could — and that is the one edit that would turn every knob on this
     * route into a way to ask for somebody else's private work.
     */
    for (const sort of GALLERY_SORTS) {
      const where = galleryWhere({
        viewerId: ANONYMOUS,
        sort,
        tag: 'bell',
        search: 'x',
      })
      expect(Object.keys(where)).toEqual(['AND'])
    }
  })

  it('narrows to one author without replacing the visibility rule', () => {
    const where = galleryWhere({
      viewerId: ANONYMOUS,
      sort: 'recent',
      ownerId: 'author-uuid',
    })
    expect(where.AND).toEqual([
      listableCircuitFilter(ANONYMOUS),
      { ownerId: 'author-uuid' },
    ])
  })

  it('looks a tag up under the spelling it was written with', () => {
    const where = galleryWhere({
      viewerId: ANONYMOUS,
      sort: 'recent',
      tag: '  Deutsch–Jozsa ',
    })
    expect(where.AND).toContainEqual({
      tags: { some: { tag: { name: 'deutsch-jozsa' } } },
    })
  })

  it('matches nothing for a tag that cannot be spelled', () => {
    /*
     * Not "ignores the filter". Ignoring it would answer a different
     * question — every circuit this viewer may see — which on this route is
     * the one answer that must never be produced by accident.
     */
    const where = galleryWhere({
      viewerId: ANONYMOUS,
      sort: 'recent',
      tag: '---',
    })
    expect(where.AND).toContainEqual({ id: { in: [] } })
  })

  it('searches title and description, case-insensitively', () => {
    const where = galleryWhere({
      viewerId: ANONYMOUS,
      sort: 'recent',
      search: 'Grover',
    })
    expect(where.AND).toContainEqual({
      OR: [
        { title: { contains: 'Grover', mode: 'insensitive' } },
        { description: { contains: 'Grover', mode: 'insensitive' } },
      ],
    })
  })

  it('ignores a search term that is only whitespace', () => {
    const where = galleryWhere({
      viewerId: ANONYMOUS,
      sort: 'recent',
      search: '  ',
    })
    expect(where.AND).toHaveLength(1)
  })
})

describe('escapeLikePattern', () => {
  it('turns the pattern language into literal text', () => {
    /*
     * The bug this prevents: Prisma passes a `contains` value as a bound
     * parameter — so it is never injection — but it does not escape the
     * pattern inside it. Unescaped, `?q=%` reaches Postgres as `%%%` and
     * returns the entire gallery, and `?q=_` matches any character.
     */
    expect(escapeLikePattern('100%')).toBe('100\\%')
    expect(escapeLikePattern('a_b')).toBe('a\\_b')
    expect(escapeLikePattern('back\\slash')).toBe('back\\\\slash')
  })

  it('escapes the backslash before the characters it would escape', () => {
    // Wrong order and `\%` becomes `\\%` — a literal backslash followed by a
    // live wildcard, which is the very thing being escaped.
    expect(escapeLikePattern('\\%')).toBe('\\\\\\%')
  })

  it('leaves ordinary text alone', () => {
    expect(escapeLikePattern('Deutsch–Jozsa')).toBe('Deutsch–Jozsa')
  })

  it('survives a term made entirely of metacharacters', () => {
    const hostile = '%_\\'.repeat(20)
    const escaped = escapeLikePattern(hostile)
    // Every metacharacter is preceded by a backslash that is itself not one.
    expect(escaped).not.toMatch(/(^|[^\\])[%_]/)
  })
})

describe('the gallery cursor', () => {
  const CREATED = new Date('2026-03-04T05:06:07.008Z')

  it('round-trips a position in each ordering', () => {
    for (const sort of GALLERY_SORTS) {
      const cursor = {
        sort,
        starCount: sort === 'stars' ? 12 : null,
        createdAt: CREATED,
        id: 'cir_abc',
      }
      expect(decodeGalleryCursor(encodeGalleryCursor(cursor), sort)).toEqual(
        cursor
      )
    }
  })

  it('is url-safe, because it rides in a query string', () => {
    const encoded = encodeGalleryCursor({
      sort: 'stars',
      starCount: 0,
      createdAt: CREATED,
      id: 'cir_+/=',
    })
    expect(encoded).toMatch(/^[A-Za-z0-9_-]+$/)
    expect(encodeURIComponent(encoded)).toBe(encoded)
  })

  it('refuses a cursor minted under the other ordering', () => {
    /*
     * A `stars` cursor describes a position that does not exist under
     * `recent`. The keyset comparison would still run and would hand back an
     * arbitrary window of rows — a wrong answer that looks like a right one.
     */
    const encoded = encodeGalleryCursor({
      sort: 'stars',
      starCount: 4,
      createdAt: CREATED,
      id: 'cir_abc',
    })
    expect(decodeGalleryCursor(encoded, 'recent')).toBeNull()
  })

  it('refuses anything that is not one of ours', () => {
    for (const raw of [
      '',
      'not base64 at all!!',
      Buffer.from('null').toString('base64url'),
      Buffer.from('[]').toString('base64url'),
      Buffer.from('{"v":2,"s":"recent","t":"x","i":"y"}').toString('base64url'),
      Buffer.from('{"v":1,"s":"nope","t":"x","i":"y"}').toString('base64url'),
      Buffer.from('{"v":1,"s":"recent","t":"not a date","i":"y"}').toString(
        'base64url'
      ),
      Buffer.from('{"v":1,"s":"recent","t":"2026-01-01","i":""}').toString(
        'base64url'
      ),
    ]) {
      expect(decodeGalleryCursor(raw, 'recent'), raw).toBeNull()
    }
  })

  it('refuses a star count that is not a count', () => {
    const payload = (n: unknown) =>
      Buffer.from(
        JSON.stringify({
          v: 1,
          s: 'stars',
          n,
          t: CREATED.toISOString(),
          i: 'a',
        })
      ).toString('base64url')

    expect(decodeGalleryCursor(payload(-1), 'stars')).toBeNull()
    expect(decodeGalleryCursor(payload(1.5), 'stars')).toBeNull()
    expect(decodeGalleryCursor(payload('4'), 'stars')).toBeNull()
    expect(decodeGalleryCursor(payload(4), 'stars')?.starCount).toBe(4)
  })

  it('refuses a star count no int4 column could hold', () => {
    /*
     * THE DEFECT. `Number.isSafeInteger` was the only bound, and it describes
     * what a double can represent rather than what a row can hold. A cursor
     * carrying 2 147 483 648 therefore reached Postgres as a `where` on an
     * `integer` column, came back as P2020, and turned this — the
     * unauthenticated front-page route — into a deterministic 500 for anybody
     * who can base64 a JSON object.
     *
     * The boundary is asserted on both sides, because "rejects something
     * enormous" would also pass if the bound were set too low and started
     * refusing cursors the gallery itself mints.
     */
    const payload = (n: number) =>
      Buffer.from(
        JSON.stringify({
          v: 1,
          s: 'stars',
          n,
          t: CREATED.toISOString(),
          i: 'a',
        })
      ).toString('base64url')

    expect(
      decodeGalleryCursor(payload(MAX_STAR_COUNT), 'stars')?.starCount
    ).toBe(MAX_STAR_COUNT)
    expect(decodeGalleryCursor(payload(MAX_STAR_COUNT + 1), 'stars')).toBeNull()
    expect(decodeGalleryCursor(payload(2 ** 40), 'stars')).toBeNull()
    expect(
      decodeGalleryCursor(payload(Number.MAX_SAFE_INTEGER), 'stars')
    ).toBeNull()
  })

  it('refuses one longer than the cap before it decodes anything', () => {
    // An unauthenticated route must not be a base64 decoder and a JSON
    // parser for whatever a caller pastes into a URL.
    const enormous = 'A'.repeat(MAX_CURSOR_LENGTH + 1)
    expect(decodeGalleryCursor(enormous, 'recent')).toBeNull()
  })

  it('refuses an id long enough to be something else', () => {
    const payload = Buffer.from(
      JSON.stringify({
        v: 1,
        s: 'recent',
        t: CREATED.toISOString(),
        i: 'x'.repeat(65),
      })
    ).toString('base64url')
    expect(decodeGalleryCursor(payload, 'recent')).toBeNull()
  })

  it('carries no star count in the recent ordering', () => {
    // Belt and braces on the encoder's own output: a `recent` cursor with a
    // star count in it would be a cursor from a different query shape.
    const payload = Buffer.from(
      JSON.stringify({
        v: 1,
        s: 'recent',
        n: 3,
        t: CREATED.toISOString(),
        i: 'a',
      })
    ).toString('base64url')
    expect(decodeGalleryCursor(payload, 'recent')).toBeNull()
  })

  it('builds the next cursor from the last row of a page', () => {
    const row = { starCount: 7, createdAt: CREATED, id: 'cir_last' }
    expect(decodeGalleryCursor(cursorAfter(row, 'stars'), 'stars')).toEqual({
      sort: 'stars',
      starCount: 7,
      createdAt: CREATED,
      id: 'cir_last',
    })
    expect(decodeGalleryCursor(cursorAfter(row, 'recent'), 'recent')).toEqual({
      sort: 'recent',
      starCount: null,
      createdAt: CREATED,
      id: 'cir_last',
    })
  })
})

describe('the keyset comparison', () => {
  const CREATED = new Date('2026-03-04T05:06:07.008Z')

  it('compares the whole tuple, not just the leading column', () => {
    /*
     * Comparing on `starCount` alone would skip every other row with the
     * same count — and since most circuits have none, that is most of the
     * gallery, silently missing from page two onwards.
     */
    const where = galleryWhere({
      viewerId: ANONYMOUS,
      sort: 'stars',
      cursor: { sort: 'stars', starCount: 5, createdAt: CREATED, id: 'cir_9' },
    })
    expect(where.AND).toContainEqual({
      OR: [
        { starCount: { lt: 5 } },
        { AND: [{ starCount: 5 }, { createdAt: { lt: CREATED } }] },
        {
          AND: [
            { starCount: 5 },
            { createdAt: CREATED },
            { id: { lt: 'cir_9' } },
          ],
        },
      ],
    })
  })

  it('breaks ties on the primary key in both orderings', () => {
    // Without a total order two rows can come back in either order on two
    // requests, and a cursor built from an ambiguous position repeats or
    // skips exactly those rows.
    expect(galleryOrderBy('recent').at(-1)).toEqual({ id: 'desc' })
    expect(galleryOrderBy('stars').at(-1)).toEqual({ id: 'desc' })
    expect(galleryOrderBy('stars')[0]).toEqual({ starCount: 'desc' })
  })
})

describe('isGallerySort', () => {
  it('accepts only what §8 names', () => {
    expect(isGallerySort('stars')).toBe(true)
    expect(isGallerySort('recent')).toBe(true)
    expect(isGallerySort('starCount')).toBe(false)
    expect(isGallerySort(null)).toBe(false)
  })
})
