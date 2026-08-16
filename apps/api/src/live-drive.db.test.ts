// @vitest-environment node
import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'
import process from 'node:process'
import { CIRCUIT_SCHEMA_VERSION } from '@qsim/schema'
import type { Circuit } from '@qsim/schema'
import {
  createPrismaClient,
  forkCircuit,
  prismaCircuitRepository,
} from '@qsim/db'
import type { CircuitRepository, PrismaClient } from '@qsim/db'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'

import type { ApiInstance } from './app.js'
import { createTestApp } from './testing/app.js'
import {
  createSigningKey,
  createTestJwksCache,
  signToken,
  stubJwksEndpoint,
} from './testing/tokens.js'
import type { TestSigningKey } from './testing/tokens.js'

/**
 * The Phase 1 feature set, driven end to end against the real database.
 *
 * Off by default, exactly like `circuits.db.test.ts`, and for the same reason:
 * this project has one Postgres, development and production are the same
 * instance, and a suite that connected on every `pnpm verify` would write rows
 * into production from a pull request.
 *
 *   QSIM_LIVE_DRIVE=1 pnpm --filter api test
 *
 * ── What is real here, and what is not ────────────────────────────────────
 *
 * Real: the Fastify app, every route, every schema, the authorization
 * helpers, and the Prisma repository against the live database. Requests go
 * through `app.inject`, which runs the whole request lifecycle — hooks, auth,
 * serialisation — and differs from a socket only in the transport.
 *
 * Not real, deliberately: the identities. Supabase owns `auth.users` and this
 * work is not permitted to touch that schema, so the two people below exist
 * only as `public.User` rows — which is precisely what `ensureUser` creates on
 * a first authenticated request — and their bearer tokens are signed by a key
 * pair generated in this process and published through a stubbed JWKS
 * endpoint. The verifier, the issuer check, the audience check and the `sub`
 * check are all the production ones; only the signing key is local.
 *
 * ── Hygiene, which is not negotiable ──────────────────────────────────────
 *
 * Two reserved UUIDs and two `.invalid` addresses (RFC 2606), distinct from
 * the ones `circuits.db.test.ts` reserves. Cleanup deletes those two `User`
 * rows — circuits, versions and stars cascade from them — plus the one tag
 * this file is allowed to have created, which hangs off no user. Nothing here
 * reads or deletes a row it did not write.
 */
const enabled = process.env.QSIM_LIVE_DRIVE === '1'

/**
 * The live connection string, read from the repo-root `.env`.
 *
 * `vitest.config.ts` deliberately clears `DATABASE_URL` for this package — a
 * route test that only passes because a developer exported one is a route test
 * that fails in CI — so it cannot simply be inherited, and `loadEnvFile` will
 * not overwrite a key that is already present as the empty string. The file is
 * parsed here instead, for one key, and the value is never logged.
 */
function liveDatabaseUrl(): string {
  const fromEnv = process.env.DATABASE_URL ?? ''
  if (fromEnv !== '') return fromEnv

  const repoRootEnv = path.resolve(import.meta.dirname, '../../../.env')
  if (!existsSync(repoRootEnv)) return ''
  for (const line of readFileSync(repoRootEnv, 'utf8').split('\n')) {
    const match = /^\s*DATABASE_URL\s*=\s*(.*)$/.exec(line)
    if (match === null) continue
    return (match[1] ?? '').trim().replace(/^["']|["']$/g, '')
  }
  return ''
}

const ALICE = '00000000-0000-4000-8000-0000000e0001'
const BOB = '00000000-0000-4000-8000-0000000e0002'
const RESERVED_IDS = [ALICE, BOB]
const RESERVED_TAGS = ['qsim-drive-bell']

const ALICE_EMAIL = 'qsim-drive-alice@example.invalid'
const BOB_EMAIL = 'qsim-drive-bob@example.invalid'

const bell: Circuit = {
  schemaVersion: CIRCUIT_SCHEMA_VERSION,
  qubits: 2,
  clbits: 0,
  operations: [
    { id: 'op-0', gate: 'h', targets: [0], column: 0 },
    { id: 'op-1', gate: 'cx', targets: [1], controls: [0], column: 1 },
  ],
}

const secret: Circuit = {
  schemaVersion: CIRCUIT_SCHEMA_VERSION,
  qubits: 3,
  clbits: 1,
  operations: [
    { id: 'op-0', gate: 'ry', targets: [0], params: [Math.PI / 3], column: 0 },
    { id: 'op-1', gate: 'measure', targets: [0], clbitTargets: [0], column: 1 },
  ],
}

vi.setConfig({ testTimeout: 120_000 })

describe.skipIf(!enabled)('Phase 1, against the live database', () => {
  let prisma: PrismaClient
  let repository: CircuitRepository
  let app: ApiInstance
  let key: TestSigningKey
  let aliceToken: string
  let bobToken: string

  /** Everything this file may have written, and nothing else. */
  async function cleanup(): Promise<void> {
    await prisma.collectionItem.deleteMany({
      where: { collection: { ownerId: { in: RESERVED_IDS } } },
    })
    await prisma.user.deleteMany({ where: { id: { in: RESERVED_IDS } } })
    await prisma.tag.deleteMany({ where: { name: { in: RESERVED_TAGS } } })
  }

  beforeAll(async () => {
    const url = liveDatabaseUrl()
    if (url === '') {
      throw new Error('No DATABASE_URL in the environment or in the repo .env')
    }

    prisma = createPrismaClient(url)
    repository = prismaCircuitRepository(prisma)
    await cleanup()

    key = await createSigningKey('live-drive')
    const jwks = stubJwksEndpoint([key])
    app = await createTestApp({
      jwks: createTestJwksCache(jwks),
      circuits: { repository },
      database: { probe: () => Promise.resolve() },
    })

    aliceToken = await signToken(key, {
      subject: ALICE,
      email: ALICE_EMAIL,
      userMetadata: { full_name: 'Alice Live' },
    })
    bobToken = await signToken(key, {
      subject: BOB,
      email: BOB_EMAIL,
      userMetadata: { full_name: 'Bob Live' },
    })
  })

  afterAll(async () => {
    await cleanup()
    await app.close()
    await prisma.$disconnect()
  })

  const auth = (token: string) => ({ authorization: `Bearer ${token}` })

  it('drives two people through the whole feature set', async () => {
    /* ── Alice publishes one circuit and keeps another private ─────────── */

    const published = await app.inject({
      method: 'POST',
      url: '/api/v1/circuits',
      headers: auth(aliceToken),
      payload: {
        title: 'Live drive Bell pair',
        description: 'Two qubits, maximally entangled.',
        visibility: 'PUBLIC',
        circuit: bell,
        tags: ['QSIM-Drive-Bell'],
      },
    })
    expect(published.statusCode).toBe(201)
    const publicCircuit = published.json<{
      circuit: {
        id: string
        slug: string
        tags: string[]
        owner: { username: string }
      }
    }>().circuit
    // Normalised on the way in, once, where the row is written.
    expect(publicCircuit.tags).toEqual(['qsim-drive-bell'])

    const kept = await app.inject({
      method: 'POST',
      url: '/api/v1/circuits',
      headers: auth(aliceToken),
      payload: {
        title: 'Live drive private',
        visibility: 'PRIVATE',
        circuit: secret,
      },
    })
    expect(kept.statusCode).toBe(201)
    const privateCircuit = kept.json<{
      circuit: { id: string; slug: string }
    }>().circuit

    const aliceHandle = publicCircuit.owner.username

    /* ── A stranger, and an anonymous reader, see only the public one ──── */

    for (const headers of [{}, auth(bobToken)]) {
      const gallery = await app.inject({
        method: 'GET',
        url: '/api/v1/gallery?sort=recent&limit=50',
        headers,
      })
      expect(gallery.statusCode).toBe(200)
      const ids = gallery
        .json<{ items: { id: string }[] }>()
        .items.map((item) => item.id)
      expect(ids).toContain(publicCircuit.id)
      expect(ids).not.toContain(privateCircuit.id)

      // The tag facet is a listing too, and so is the search.
      for (const query of [
        `?tag=QSIM-Drive-Bell&limit=50`,
        `?q=Live%20drive&limit=50`,
      ]) {
        const faceted = await app.inject({
          method: 'GET',
          url: `/api/v1/gallery${query}`,
          headers,
        })
        expect(faceted.statusCode).toBe(200)
        const facetIds = faceted
          .json<{ items: { id: string }[] }>()
          .items.map((item) => item.id)
        expect(facetIds).not.toContain(privateCircuit.id)
      }

      // And the private circuit is not reachable by its own address either.
      const direct = await app.inject({
        method: 'GET',
        url: `/api/v1/circuits/${privateCircuit.slug}`,
        headers,
      })
      expect(direct.statusCode).toBe(404)
    }

    /* ── Bob stars it, and the count is the one the gallery reports ────── */

    const starred = await app.inject({
      method: 'POST',
      url: `/api/v1/circuits/${publicCircuit.slug}/star`,
      headers: auth(bobToken),
    })
    expect(starred.statusCode).toBe(200)
    expect(
      starred.json<{ starred: boolean; starCount: number }>()
    ).toMatchObject({ starred: true, starCount: 1 })

    const afterStar = await app.inject({
      method: 'GET',
      url: '/api/v1/gallery?sort=stars&limit=50',
      headers: auth(bobToken),
    })
    const starredCard = afterStar.json<{
      items: { id: string; starCount: number }[]
      starred: string[]
    }>()
    expect(
      starredCard.items.find((item) => item.id === publicCircuit.id)?.starCount
    ).toBe(1)
    expect(starredCard.starred).toContain(publicCircuit.id)

    /* ── Bob forks it, and the copy is his and private ─────────────────── */

    const forked = await app.inject({
      method: 'POST',
      url: `/api/v1/circuits/${publicCircuit.slug}/fork`,
      headers: auth(bobToken),
    })
    expect(forked.statusCode).toBe(201)
    const fork = forked.json<{
      circuit: {
        id: string
        slug: string
        visibility: string
        forkedFromId: string | null
        owner: { id: string; username: string }
        tags: string[]
      }
    }>().circuit

    // Forking a public circuit is not publishing one.
    expect(fork.visibility).toBe('PRIVATE')
    expect(fork.owner.id).toBe(BOB)
    expect(fork.tags).toEqual(['qsim-drive-bell'])
    expect(fork.tags.length).toBeLessThanOrEqual(8)

    /*
     * The attribution is NOT in the response, and that is the design rather
     * than an omission: `forkedFromId` is a handle to another row whose
     * visibility may differ, so no projection carries it (`projections.ts`) and
     * the client states the provenance from its own navigation instead
     * (`forkAttribution.ts`). Asserted both ways: absent on the wire, present
     * in the row.
     */
    expect(forked.body).not.toContain('forkedFrom')
    const linked = await prisma.circuit.findUnique({
      where: { id: fork.id },
      select: { forkedFromId: true, ownerId: true, visibility: true },
    })
    expect(linked).toMatchObject({
      forkedFromId: publicCircuit.id,
      ownerId: BOB,
      visibility: 'PRIVATE',
    })

    // Bob can open his own copy…
    const opened = await app.inject({
      method: 'GET',
      url: `/api/v1/circuits/${fork.slug}`,
      headers: auth(bobToken),
    })
    expect(opened.statusCode).toBe(200)
    const openedVersion = await app.inject({
      method: 'GET',
      url: `/api/v1/circuits/${fork.id}/versions/1`,
      headers: auth(bobToken),
    })
    expect(openedVersion.statusCode).toBe(200)
    expect(
      openedVersion.json<{ version: { circuit: Circuit } }>().version.circuit
    ).toEqual(bell)

    // …and nobody else can, including its source's author.
    for (const headers of [{}, auth(aliceToken)]) {
      const denied = await app.inject({
        method: 'GET',
        url: `/api/v1/circuits/${fork.slug}`,
        headers,
      })
      expect(denied.statusCode).toBe(404)
    }
    const forkGallery = await app.inject({
      method: 'GET',
      url: '/api/v1/gallery?sort=recent&limit=50',
    })
    expect(
      forkGallery.json<{ items: { id: string }[] }>().items.map((i) => i.id)
    ).not.toContain(fork.id)

    /* ── Alice's public page: no address, no private circuit ───────────── */

    const profile = await app.inject({
      method: 'GET',
      url: `/api/v1/users/${aliceHandle}`,
    })
    expect(profile.statusCode).toBe(200)
    const profileText = profile.body
    expect(profileText).not.toContain(ALICE_EMAIL)
    expect(profileText).not.toContain('@example.invalid')
    expect(profileText).not.toContain('email')
    expect(profile.json<{ circuitCount: number }>().circuitCount).toBe(1)

    const authored = await app.inject({
      method: 'GET',
      url: `/api/v1/users/${aliceHandle}/circuits?limit=50`,
    })
    expect(authored.statusCode).toBe(200)
    const authoredBody = authored.body
    expect(authoredBody).not.toContain(ALICE_EMAIL)
    const authoredIds = authored
      .json<{ items: { id: string }[] }>()
      .items.map((item) => item.id)
    expect(authoredIds).toEqual([publicCircuit.id])

    const authoredCollections = await app.inject({
      method: 'GET',
      url: `/api/v1/users/${aliceHandle}/collections`,
    })
    expect(authoredCollections.statusCode).toBe(200)
    expect(authoredCollections.body).not.toContain(ALICE_EMAIL)

    /* ── The gallery cursor no longer answers 500 to a forged number ───── */

    const forged = Buffer.from(
      JSON.stringify({
        v: 1,
        s: 'stars',
        n: 2_147_483_648,
        t: '2026-01-01T00:00:00.000Z',
        i: 'aaaaaaaaaaaaaaaaaaaaaaaa',
      })
    ).toString('base64url')
    const overflowed = await app.inject({
      method: 'GET',
      url: `/api/v1/gallery?sort=stars&limit=5&cursor=${forged}`,
    })
    expect(overflowed.statusCode).toBe(400)
    expect(overflowed.json<{ error: { code: string } }>().error.code).toBe(
      'VALIDATION_FAILED'
    )

    // And the cursor at the column's ceiling is still a readable position.
    const atCeiling = Buffer.from(
      JSON.stringify({
        v: 1,
        s: 'stars',
        n: 2_147_483_647,
        t: '2026-01-01T00:00:00.000Z',
        i: 'aaaaaaaaaaaaaaaaaaaaaaaa',
      })
    ).toString('base64url')
    const ceiling = await app.inject({
      method: 'GET',
      url: `/api/v1/gallery?sort=stars&limit=5&cursor=${atCeiling}`,
    })
    expect(ceiling.statusCode).toBe(200)

    /* ── A blank display name is refused rather than stored ────────────── */

    const blank = await app.inject({
      method: 'PATCH',
      url: '/api/v1/me',
      headers: auth(aliceToken),
      payload: { displayName: '   ' },
    })
    expect(blank.statusCode).toBe(400)
    const stillNamed = await app.inject({
      method: 'GET',
      url: '/api/v1/me',
      headers: auth(aliceToken),
    })
    expect(
      stillNamed.json<{ user: { displayName: string | null } }>().user
        .displayName
    ).toBe('Alice Live')

    /* ── forkCircuit, called directly, cannot exceed the tag cap ───────── */

    const detail = await repository.findReadable(publicCircuit.id, ALICE)
    expect(detail).not.toBeNull()
    const second = await forkCircuit(repository, {
      source: {
        ...detail!,
        tags: Array.from({ length: 20 }, (_, i) => `t${String(i)}`),
      },
      ownerId: BOB,
    })
    expect(second.circuit.tags.length).toBeLessThanOrEqual(8)
  })

  it('leaves nothing behind', async () => {
    await cleanup()
    expect(
      await prisma.user.count({ where: { id: { in: RESERVED_IDS } } })
    ).toBe(0)
    expect(
      await prisma.circuit.count({ where: { ownerId: { in: RESERVED_IDS } } })
    ).toBe(0)
    expect(
      await prisma.tag.count({ where: { name: { in: RESERVED_TAGS } } })
    ).toBe(0)
  })
})
