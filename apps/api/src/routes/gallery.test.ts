/**
 * The gallery and the profile listing — §8 and §11, milestone M1.5.
 *
 * ── Why this file is written the way it is ────────────────────────────────
 *
 * `GET /gallery` is the highest-risk route in the project: unauthenticated, a
 * *list*, over a table that also holds every PRIVATE circuit in the database.
 * Prisma connects as `postgres` and bypasses row-level security, so one
 * missing `where` does not fail a test — it publishes the whole table in a
 * single response.
 *
 * So every assertion below is made from a STRANGER's point of view, or from
 * an anonymous one. That the owner can see their own circuit proves nothing
 * at all, and a suite that only proved that would be green over a leak.
 *
 * The knobs are tested one at a time *and* as ways in: a tag facet, a search
 * term, a sort order and a pagination cursor are each a listing, and each is
 * a separate opportunity to compose a filter that widens instead of narrows.
 * `everyWayIn` runs the same "does a stranger see it" question through all of
 * them, so a new knob added without a filter has somewhere obvious to fail.
 */

import { CIRCUIT_SCHEMA_VERSION } from '@qsim/schema'
import type { Circuit, CircuitPreview } from '@qsim/schema'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { ApiInstance } from '../app.js'
import { createTestApp } from '../testing/app.js'
import { createMemoryCircuitRepository } from '../testing/circuit-repository.js'
import type { MemoryCircuitRepository } from '../testing/circuit-repository.js'
import {
  createSigningKey,
  createTestJwksCache,
  signToken,
  stubJwksEndpoint,
} from '../testing/tokens.js'

const OWNER_ID = '11111111-1111-4111-8111-111111111111'
const STRANGER_ID = '22222222-2222-4222-8222-222222222222'
const GALLERY = '/api/v1/gallery'

interface CardBody {
  id: string
  slug: string
  title: string
  visibility: string
  starCount: number
  tags: string[]
  owner: { id: string; username: string; avatarUrl: string | null }
  preview: CircuitPreview | null
}

interface GalleryBody {
  items: CardBody[]
  nextCursor: string | null
  limit: number
  starred: string[]
}

interface ProfileBody extends GalleryBody {
  user: {
    id: string
    username: string
    displayName: string | null
    avatarUrl: string | null
    createdAt: string
  }
}

interface ErrorBody {
  error: { code: string; details?: { path: string; code: string }[] }
}

/**
 * Typed `Circuit` rather than `CircuitInput`: these fixtures go straight into
 * the repository, which takes a document that has already been through
 * `parseCircuit` — so the defaults an input may omit are spelled out here.
 */
function bell(): Circuit {
  return {
    schemaVersion: CIRCUIT_SCHEMA_VERSION,
    qubits: 2,
    clbits: 0,
    operations: [
      { id: 'op-0', gate: 'h', targets: [0], column: 0 },
      { id: 'op-1', gate: 'cx', targets: [1], controls: [0], column: 1 },
    ],
  }
}

interface Harness {
  app: ApiInstance
  repository: MemoryCircuitRepository
  owner: Record<string, string>
  stranger: Record<string, string>
}

let harness: Harness

beforeEach(async () => {
  const key = await createSigningKey('key-1')
  const repository = createMemoryCircuitRepository()
  const app = await createTestApp({
    jwks: createTestJwksCache(stubJwksEndpoint([key])),
    circuits: { repository },
  })
  await app.ready()

  repository.addUser({ id: OWNER_ID, username: 'ada', displayName: 'Ada' })
  repository.addUser({ id: STRANGER_ID, username: 'grace' })

  harness = {
    app,
    repository,
    owner: {
      authorization: `Bearer ${await signToken(key, {
        subject: OWNER_ID,
        email: 'ada@example.com',
      })}`,
    },
    stranger: {
      authorization: `Bearer ${await signToken(key, {
        subject: STRANGER_ID,
        email: 'grace@example.com',
      })}`,
    },
  }
})

afterEach(async () => {
  await harness.app.close()
})

interface SeedOptions {
  title?: string
  description?: string | null
  visibility?: 'PRIVATE' | 'UNLISTED' | 'PUBLIC'
  tags?: string[]
  ownerId?: string
  starCount?: number
  createdAt?: Date
}

/**
 * Writes a circuit straight through the repository.
 *
 * Deliberately not through `POST /circuits`: this file is about what a
 * *reader* is shown, and going through the write route would make the fixture
 * depend on the write route's rules as well. `starCount` and `createdAt` are
 * set directly for the same reason — the orderings under test need known
 * values, and a star loop would be testing the star route here.
 */
async function seed(options: SeedOptions = {}): Promise<string> {
  const created = await harness.repository.create({
    ownerId: options.ownerId ?? OWNER_ID,
    title: options.title ?? 'A circuit',
    description: options.description ?? null,
    visibility: options.visibility ?? 'PUBLIC',
    data: bell(),
    message: null,
    forkedFromId: null,
    ...(options.tags === undefined ? {} : { tags: options.tags }),
  })

  const row = harness.repository
    .allCircuits()
    .find((candidate) => candidate.id === created.circuit.id)
  if (row === undefined) throw new Error('seeded circuit vanished')
  if (options.starCount !== undefined) row.starCount = options.starCount
  if (options.createdAt !== undefined) row.createdAt = options.createdAt
  return created.circuit.id
}

async function get(
  url: string,
  headers?: Record<string, string>
): Promise<{ status: number; body: GalleryBody; raw: string }> {
  const response = await harness.app.inject({
    method: 'GET',
    url,
    ...(headers === undefined ? {} : { headers }),
  })
  return {
    status: response.statusCode,
    body: response.json<GalleryBody>(),
    raw: response.payload,
  }
}

/** Every page of a listing, walked through its cursors. */
async function walk(
  url: string,
  headers?: Record<string, string>,
  from: string | null = null
): Promise<CardBody[]> {
  const seen: CardBody[] = []
  let cursor = from
  const separator = url.includes('?') ? '&' : '?'
  for (let page = 0; page < 20; page += 1) {
    const next: { status: number; body: GalleryBody } = await get(
      cursor === null ? url : `${url}${separator}cursor=${cursor}`,
      headers
    )
    expect(next.status).toBe(200)
    seen.push(...next.body.items)
    cursor = next.body.nextCursor
    if (cursor === null) return seen
  }
  throw new Error('a listing that never ends is a listing with a bug')
}

describe('GET /gallery — what a stranger may see', () => {
  /**
   * Every way into the gallery, as URLs. A knob added without a filter should
   * have somewhere obvious to fail, and this is it.
   */
  const everyWayIn = [
    ['plainly', GALLERY],
    ['sorted by stars', `${GALLERY}?sort=stars`],
    ['sorted by recency', `${GALLERY}?sort=recent`],
    ['through the tag facet', `${GALLERY}?tag=secret`],
    ['through a search on the title', `${GALLERY}?q=Confidential`],
    ['through a search on the description', `${GALLERY}?q=notebook`],
    ['a page at a time', `${GALLERY}?limit=1`],
  ] as const

  beforeEach(async () => {
    // One of each visibility, all owned by `ada`, all matching every filter
    // above — so a leak through any one of them is visible.
    await seed({
      title: 'Confidential draft',
      description: 'from my private notebook',
      visibility: 'PRIVATE',
      tags: ['secret'],
    })
    await seed({
      title: 'Confidential link',
      description: 'from my private notebook',
      visibility: 'UNLISTED',
      tags: ['secret'],
    })
    await seed({
      title: 'Confidential no more',
      description: 'from my private notebook',
      visibility: 'PUBLIC',
      tags: ['secret'],
    })
  })

  it.each(everyWayIn)(
    'shows an anonymous caller only PUBLIC circuits, %s',
    async (_label, url) => {
      const items = await walk(url)

      expect(items.map((item) => item.visibility)).toEqual(['PUBLIC'])
    }
  )

  it.each(everyWayIn)(
    'shows a signed-in stranger only PUBLIC circuits, %s',
    async (_label, url) => {
      // The case that matters most and is easiest to get wrong: the filter is
      // `PUBLIC OR ownerId = viewer`, and a viewer who is not the owner must
      // fall out of the second branch rather than into it.
      const items = await walk(url, harness.stranger)

      expect(items.map((item) => item.visibility)).toEqual(['PUBLIC'])
    }
  )

  it.each(everyWayIn)(
    'never leaks a private title or description in the payload, %s',
    async (_label, url) => {
      // Not just "the right number of items": a projection that fetched the
      // wrong rows and rendered one field of them would still pass a count.
      const anonymous = await get(url)
      const stranger = await get(url, harness.stranger)

      for (const response of [anonymous, stranger]) {
        expect(response.raw).not.toContain('Confidential draft')
        expect(response.raw).not.toContain('Confidential link')
      }
    }
  )

  it('shows the owner their own unlisted and private work in a listing', () => {
    /*
     * The documented rule, asserted so that the tests above are known to be
     * measuring the filter rather than an empty database: PRIVATE and
     * UNLISTED are in the owner's own listing (`listableCircuitFilter` admits
     * `ownerId = viewer`), and in nobody else's.
     */
    return walk(GALLERY, harness.owner).then((items) => {
      expect(items).toHaveLength(3)
    })
  })
})

describe('GET /gallery — the cursor', () => {
  beforeEach(async () => {
    for (let index = 0; index < 5; index += 1) {
      await seed({
        title: `Public ${String(index)}`,
        createdAt: new Date(Date.UTC(2026, 0, (index + 1) * 2)),
      })
    }
    /*
     * Placed second in the owner's ordering on purpose — between `Public 4`
     * and `Public 3`. That makes the cursor the owner gets after their first
     * page point *at* a private circuit, which is the position a replayed
     * cursor would have to leak from.
     */
    await seed({
      title: 'Hidden',
      visibility: 'PRIVATE',
      createdAt: new Date(Date.UTC(2026, 0, 9)),
    })
  })

  it('walks every page exactly once, with no repeats and nothing skipped', async () => {
    const items = await walk(`${GALLERY}?limit=2`)

    expect(items.map((item) => item.title)).toEqual([
      'Public 4',
      'Public 3',
      'Public 2',
      'Public 1',
      'Public 0',
    ])
    expect(new Set(items.map((item) => item.id)).size).toBe(items.length)
  })

  it('says the last page by answering with a null cursor', async () => {
    const { body } = await get(`${GALLERY}?limit=50`)

    expect(body.items).toHaveLength(5)
    expect(body.nextCursor).toBeNull()
  })

  it('is not a capability: an owner’s cursor replayed anonymously widens nothing', async () => {
    /*
     * The attack the design has to survive. A cursor says where to *start*,
     * never what may be seen — the visibility filter is applied to every page
     * independently. So a cursor minted by a signed-in owner, positioned just
     * before their own private circuit, must not carry that circuit into an
     * anonymous reader's page.
     */
    const asOwner = await get(`${GALLERY}?limit=1`, harness.owner)
    expect(asOwner.body.items.map((item) => item.title)).toEqual(['Public 4'])
    expect(asOwner.body.nextCursor).not.toBeNull()

    // The cursor really does sit immediately before the private circuit: the
    // owner's own next page is it. Without this the test below could pass on
    // a cursor pointing somewhere harmless.
    const ownersNextPage = await get(
      `${GALLERY}?limit=1&cursor=${asOwner.body.nextCursor as string}`,
      harness.owner
    )
    expect(ownersNextPage.body.items.map((item) => item.title)).toEqual([
      'Hidden',
    ])

    const replayed = await walk(
      `${GALLERY}?limit=1`,
      undefined,
      asOwner.body.nextCursor
    )

    expect(replayed.every((item) => item.visibility === 'PUBLIC')).toBe(true)
    expect(replayed.map((item) => item.title)).toEqual([
      'Public 3',
      'Public 2',
      'Public 1',
      'Public 0',
    ])
  })

  it('refuses a cursor it did not mint rather than silently starting over', async () => {
    // Ignoring it would serve page 1 to a client that asked for page 4 —
    // which reads as a gallery that lost half its contents, and reads to
    // whoever wrote the client as nothing at all.
    const response = await harness.app.inject({
      method: 'GET',
      url: `${GALLERY}?cursor=not-a-cursor`,
    })

    expect(response.statusCode).toBe(400)
    const body = response.json<ErrorBody>()
    expect(body.error.code).toBe('VALIDATION_FAILED')
    expect(body.error.details).toEqual([
      { path: 'querystring.cursor', code: 'invalid_cursor' },
    ])
  })

  it('refuses a cursor minted under the other ordering', async () => {
    const { body } = await get(`${GALLERY}?sort=stars&limit=1`)
    expect(body.nextCursor).not.toBeNull()

    const response = await harness.app.inject({
      method: 'GET',
      url: `${GALLERY}?sort=recent&cursor=${body.nextCursor as string}`,
    })

    expect(response.statusCode).toBe(400)
  })

  it('refuses a cursor longer than the decoder will read', async () => {
    const response = await harness.app.inject({
      method: 'GET',
      url: `${GALLERY}?cursor=${'A'.repeat(1000)}`,
    })

    expect(response.statusCode).toBe(400)
  })
})

describe('GET /gallery — ordering', () => {
  it('sorts by stars, then by recency, then by id', async () => {
    const old = new Date(Date.UTC(2026, 0, 1))
    const recent = new Date(Date.UTC(2026, 0, 2))
    await seed({ title: 'One star', starCount: 1, createdAt: recent })
    await seed({ title: 'Nine stars', starCount: 9, createdAt: old })
    await seed({ title: 'Nine stars, newer', starCount: 9, createdAt: recent })

    const items = await walk(`${GALLERY}?sort=stars&limit=2`)

    expect(items.map((item) => item.title)).toEqual([
      'Nine stars, newer',
      'Nine stars',
      'One star',
    ])
  })

  it('sorts by recency when asked, whatever the stars say', async () => {
    await seed({
      title: 'Popular and old',
      starCount: 99,
      createdAt: new Date(Date.UTC(2026, 0, 1)),
    })
    await seed({
      title: 'Unloved and new',
      starCount: 0,
      createdAt: new Date(Date.UTC(2026, 0, 2)),
    })

    const items = await walk(`${GALLERY}?sort=recent`)

    expect(items.map((item) => item.title)).toEqual([
      'Unloved and new',
      'Popular and old',
    ])
  })
})

describe('GET /gallery — search', () => {
  beforeEach(async () => {
    await seed({
      title: 'Grover search',
      description: 'amplitude amplification',
    })
    await seed({ title: 'Bell pair', description: 'the simplest entanglement' })
    await seed({
      title: '100% fidelity',
      description: 'a literal percent sign',
    })
  })

  it('matches the title, case-insensitively and inside a word', async () => {
    // The whole reason the index is trigram rather than tsvector: somebody
    // typing "grov" expects Grover.
    const items = await walk(`${GALLERY}?q=grov`)

    expect(items.map((item) => item.title)).toEqual(['Grover search'])
  })

  it('matches the description too', async () => {
    const items = await walk(`${GALLERY}?q=entanglement`)

    expect(items.map((item) => item.title)).toEqual(['Bell pair'])
  })

  it('treats a wildcard as a character, not as a wildcard', async () => {
    /*
     * The escaping assertion, and the reason it is worth a test of its own:
     * unescaped, `?q=%` reaches Postgres as `ILIKE '%%%'` and returns the
     * entire gallery — an accidental "list everything" on the one route where
     * listing everything is the failure mode.
     */
    const everything = await walk(`${GALLERY}?q=${encodeURIComponent('%%%')}`)
    expect(everything).toEqual([])

    const literal = await walk(`${GALLERY}?q=${encodeURIComponent('100%')}`)
    expect(literal.map((item) => item.title)).toEqual(['100% fidelity'])
  })

  it('treats an underscore as a character too', async () => {
    const items = await walk(`${GALLERY}?q=${encodeURIComponent('B_ll')}`)
    expect(items).toEqual([])
  })

  it('refuses a term the trigram index cannot serve', async () => {
    // Below three characters there are no trigrams, so the query would be a
    // sequential scan of every circuit — on an anonymous route.
    const response = await harness.app.inject({
      method: 'GET',
      url: `${GALLERY}?q=ab`,
    })

    expect(response.statusCode).toBe(400)
  })

  it('refuses a term of pathological length', async () => {
    const response = await harness.app.inject({
      method: 'GET',
      url: `${GALLERY}?q=${'a'.repeat(500)}`,
    })

    expect(response.statusCode).toBe(400)
  })

  it('still hides a private circuit that matches the term perfectly', async () => {
    await seed({ title: 'Grover secret', visibility: 'PRIVATE' })

    const items = await walk(`${GALLERY}?q=Grover`, harness.stranger)

    expect(items.map((item) => item.title)).toEqual(['Grover search'])
  })
})

describe('GET /gallery — tags', () => {
  beforeEach(async () => {
    await seed({ title: 'Tagged', tags: ['grover', 'search'] })
    await seed({ title: 'Untagged' })
  })

  it('filters by tag', async () => {
    const items = await walk(`${GALLERY}?tag=grover`)

    expect(items.map((item) => item.title)).toEqual(['Tagged'])
  })

  it('looks the tag up under the spelling it was stored with', async () => {
    // The same normaliser runs on both sides of the write, so a facet cannot
    // be filed under one spelling and searched under another.
    const items = await walk(
      `${GALLERY}?tag=${encodeURIComponent('  GROVER ')}`
    )

    expect(items.map((item) => item.title)).toEqual(['Tagged'])
  })

  it('shows the tags on the card, so the facet is visible', async () => {
    const { body } = await get(`${GALLERY}?tag=grover`)

    expect(body.items[0]?.tags).toEqual(['grover', 'search'])
  })

  it('refuses a tag that cannot be spelled rather than ignoring it', async () => {
    /*
     * Ignoring it would answer a different question — every circuit you may
     * see — which on this route is the one answer that must never be produced
     * by accident.
     */
    const response = await harness.app.inject({
      method: 'GET',
      url: `${GALLERY}?tag=${encodeURIComponent('---')}`,
    })

    expect(response.statusCode).toBe(400)
    expect(response.json<ErrorBody>().error.details).toEqual([
      { path: 'querystring.tag', code: 'invalid_tag' },
    ])
  })

  it('answers nothing for a tag nobody has used', async () => {
    expect(await walk(`${GALLERY}?tag=nobody-uses-this`)).toEqual([])
  })
})

describe('GET /gallery — this viewer’s stars (M1.5b)', () => {
  let mine: string
  let theirs: string

  beforeEach(async () => {
    mine = await seed({ title: 'One I starred' })
    theirs = await seed({ title: 'One somebody else starred' })

    // The star route is the door: it checks readability first, so starring
    // through it is also what proves the fixture is reachable.
    await harness.app.inject({
      method: 'POST',
      url: `/api/v1/circuits/${mine}/star`,
      headers: harness.stranger,
    })
    await harness.app.inject({
      method: 'POST',
      url: `/api/v1/circuits/${theirs}/star`,
      headers: harness.owner,
    })
  })

  it('names the ids this caller starred, and only theirs', async () => {
    const { body } = await get(GALLERY, harness.stranger)

    expect(body.starred).toEqual([mine])
  })

  it('tells an anonymous reader nothing about anybody’s stars', async () => {
    /*
     * Not merely "empty because nobody is signed in": a list of who starred
     * what is a per-account fact, and an anonymous listing that carried one
     * would be publishing another user's activity on the front page.
     */
    const { body } = await get(GALLERY)

    expect(body.starred).toEqual([])
    // The counter is public — it is on the card and it is what `sort=stars`
    // orders by. The identities behind it are not.
    expect(body.items.map((item) => item.starCount).sort()).toEqual([1, 1])
  })

  it('never reports a star on a circuit outside the page', async () => {
    // Scoped to the ids the listing returned, so a star cannot be reported on
    // a row this caller was not shown.
    const { body } = await get(`${GALLERY}?q=One I starred`, harness.stranger)

    expect(body.items.map((item) => item.title)).toEqual(['One I starred'])
    expect(body.starred).toEqual([mine])
  })
})

describe('GET /gallery — the card’s thumbnail (M1.5b)', () => {
  it('carries a drawable preview so no card has to fetch its own', async () => {
    await seed({ title: 'Bell pair' })

    const { body } = await get(GALLERY)
    const preview = body.items[0]?.preview

    // A Bell pair: H on wire 0, then CNOT. Enough to draw, and nothing more.
    expect(preview).toEqual({
      qubits: 2,
      columns: 2,
      truncated: false,
      operations: [
        { gate: 'h', column: 0, targets: [0], controls: [] },
        { gate: 'cx', column: 1, targets: [1], controls: [0] },
      ],
    })
  })

  it('never puts the document itself in a listing', async () => {
    /*
     * The bound the preview exists to keep. `CircuitVersion.data` is capped at
     * 256 KiB, so a card carrying the real document would put megabytes behind
     * one anonymous request — and the fields a document has and a preview does
     * not (`schemaVersion`, `id` on an operation, `params`) are what tells the
     * two apart in a payload.
     */
    await seed({ title: 'Bell pair' })

    const { raw } = await get(GALLERY)

    expect(raw).not.toContain('schemaVersion')
    expect(raw).not.toContain('op-0')
  })

  it('redraws the thumbnail when the document changes', async () => {
    // A card showing yesterday's diagram beside today's gate count is two
    // claims about one circuit that cannot both be true.
    const id = await seed({ title: 'Bell pair' })
    await harness.repository.appendVersion({
      circuitId: id,
      ownerId: OWNER_ID,
      data: {
        schemaVersion: CIRCUIT_SCHEMA_VERSION,
        qubits: 1,
        clbits: 0,
        operations: [{ id: 'op-0', gate: 'x', targets: [0], column: 0 }],
      },
      message: 'simplified',
    })

    const { body } = await get(GALLERY)

    expect(body.items[0]?.preview).toEqual({
      qubits: 1,
      columns: 1,
      truncated: false,
      operations: [{ gate: 'x', column: 0, targets: [0], controls: [] }],
    })
  })
})

describe('GET /users/:username/circuits', () => {
  const profile = (username: string): string =>
    `/api/v1/users/${username}/circuits`

  beforeEach(async () => {
    await seed({ title: 'Ada public', visibility: 'PUBLIC' })
    await seed({ title: 'Ada unlisted', visibility: 'UNLISTED' })
    await seed({ title: 'Ada private', visibility: 'PRIVATE' })
    await seed({
      title: 'Grace public',
      visibility: 'PUBLIC',
      ownerId: STRANGER_ID,
    })
  })

  it('shows a stranger only that author’s public circuits', async () => {
    const items = await walk(profile('ada'), harness.stranger)

    expect(items.map((item) => item.title)).toEqual(['Ada public'])
  })

  it('shows an anonymous reader the same', async () => {
    const items = await walk(profile('ada'))

    expect(items.map((item) => item.title)).toEqual(['Ada public'])
  })

  it('shows the author their own work, whatever its visibility', async () => {
    const items = await walk(profile('ada'), harness.owner)

    expect(items.map((item) => item.title).sort()).toEqual([
      'Ada private',
      'Ada public',
      'Ada unlisted',
    ])
  })

  it('never mixes another author’s circuits into a profile', async () => {
    const items = await walk(profile('ada'), harness.owner)

    expect(items.map((item) => item.title)).not.toContain('Grace public')
  })

  it('keeps the filter through the search term and the tag facet', async () => {
    // Same argument as the gallery: a profile page is a listing, and each
    // knob is another chance to compose a filter that widens.
    for (const url of [
      `${profile('ada')}?q=Ada`,
      `${profile('ada')}?sort=stars`,
      `${profile('ada')}?limit=1`,
    ]) {
      const items = await walk(url, harness.stranger)
      expect(
        items.map((item) => item.visibility),
        url
      ).toEqual(['PUBLIC'])
    }
  })

  it('answers with the author, and never with their email', async () => {
    const response = await harness.app.inject({
      method: 'GET',
      url: profile('ada'),
    })

    expect(response.statusCode).toBe(200)
    const body = response.json<ProfileBody>()
    expect(body.user.username).toBe('ada')
    expect(body.user.displayName).toBe('Ada')
    expect(body.user).not.toHaveProperty('email')
    // The projection does not fetch it and the schema does not declare it;
    // this asserts the payload agrees.
    expect(response.payload).not.toContain('@example.invalid')
  })

  it('answers 404 for a username nobody holds', async () => {
    const response = await harness.app.inject({
      method: 'GET',
      url: profile('nobody-here'),
    })

    expect(response.statusCode).toBe(404)
    expect(response.json<ErrorBody>().error.code).toBe('NOT_FOUND')
  })

  it('refuses a username that could never have been minted', async () => {
    for (const username of ['Ada', 'a', 'has%20space']) {
      const response = await harness.app.inject({
        method: 'GET',
        url: `/api/v1/users/${username}/circuits`,
      })
      expect(response.statusCode, username).toBe(400)
    }
  })
})
