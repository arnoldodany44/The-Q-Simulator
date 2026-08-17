import { existsSync } from 'node:fs'
import path from 'node:path'
import process from 'node:process'
import { CIRCUIT_SCHEMA_VERSION, previewOf } from '@qsim/schema'
import type { Circuit } from '@qsim/schema'
import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  it,
  vi,
} from 'vitest'
import {
  createPrismaClient,
  disconnectPrismaClient,
  getPrismaClient,
} from './client.js'
import {
  forkCircuit,
  isVersionNumberConflict,
  prismaCircuitRepository,
} from './circuits.js'
import type { CircuitRepository } from './circuits.js'
import { toCircuitJson } from './circuit-data.js'
import { decodeGalleryCursor } from './gallery.js'
import { Visibility } from './generated/prisma/client.js'
import type { PrismaClient } from './generated/prisma/client.js'
import type { SupabaseIdentity } from './users.js'

/**
 * The Prisma implementation, against the real database.
 *
 * ── Off by default, and the reason is not timidity ────────────────────────
 *
 * This project has one Postgres. It is the owner's, development and
 * production are the same instance, and `pnpm verify` runs constantly — so a
 * suite that connected on every run would compete with the application for
 * the pooler's single connection, would turn a dropped wifi link into a red
 * build, and would write rows into production from a pull request. The route
 * behaviour is covered with no database at all (`apps/api`); this file covers
 * the half that only Postgres can answer: does the `where` fragment actually
 * filter, does the unique index actually fire, does `ON DELETE CASCADE`
 * actually reach the versions.
 *
 * Run it deliberately:
 *
 *   QSIM_DB_INTEGRATION=1 pnpm --filter @qsim/db test
 *
 * ── The hygiene rules, which are not negotiable here ──────────────────────
 *
 * 1. Everything created belongs to one of two reserved identities, whose
 *    UUIDs and e-mail addresses are recognisably this suite's and cannot
 *    collide with a real Supabase user (`.invalid` is reserved by RFC 2606).
 * 2. Cleanup deletes those two `User` rows and nothing else. Circuits cascade
 *    from the user, versions cascade from the circuit, so one delete per user
 *    removes exactly what this file wrote and cannot reach a row it did not.
 * 3. No test reads or asserts over rows it did not create — every query is
 *    scoped by owner or by an id this suite holds.
 *
 * A wrapping transaction that rolls back would be tidier and is not
 * available: the code under test opens its own `$transaction`, and Prisma has
 * no nested-transaction or savepoint API to run those inside an outer one.
 * Deleting by reserved owner is the compensating design, and the last test
 * asserts it left nothing behind.
 */
const enabled = process.env.QSIM_DB_INTEGRATION === '1'

/*
 * Vitest does not read `.env`, and Vite only surfaces `VITE_`-prefixed values
 * to a client bundle. Load the repo-root file the way `prisma.config.ts`
 * does, and only when this suite is going to run.
 */
if (enabled && process.env.DATABASE_URL === undefined) {
  const repoRootEnv = path.resolve(import.meta.dirname, '../../../.env')
  if (existsSync(repoRootEnv)) process.loadEnvFile(repoRootEnv)
}

const OWNER: SupabaseIdentity = {
  id: '00000000-0000-4000-8000-0000000d0001',
  email: 'qsim-itest-owner@example.invalid',
  displayName: 'Integration Owner',
  avatarUrl: null,
}

const STRANGER: SupabaseIdentity = {
  id: '00000000-0000-4000-8000-0000000d0002',
  email: 'qsim-itest-stranger@example.invalid',
  displayName: 'Integration Stranger',
  avatarUrl: null,
}

const RESERVED_IDS = [OWNER.id, STRANGER.id]

/**
 * Tags this suite may create, listed exhaustively.
 *
 * `Tag` is the one table here that hangs off no user, so nothing cascades it
 * away and cleanup has to name it. An explicit list rather than a prefix
 * match, so a delete cannot reach a row this file did not write — and the
 * names are recognisably this suite's for the same reason the reserved UUIDs
 * are.
 */
const RESERVED_TAGS = [
  'qsim-itest-alpha',
  'qsim-itest-beta',
  'qsim-itest-shared',
  // The concurrent-replacement test's four disjoint sets, two names each.
  'qsim-itest-w0',
  'qsim-itest-w1',
  'qsim-itest-x0',
  'qsim-itest-x1',
  'qsim-itest-y0',
  'qsim-itest-y1',
  'qsim-itest-z0',
  'qsim-itest-z1',
]

/**
 * The four disjoint tag sets the concurrent-replacement test writes, one per
 * connection. Two names each rather than eight: what is being measured is
 * whether the sets *accumulate*, and four sets of two accumulate to eight just
 * as visibly as four sets of eight accumulate to thirty-two — while keeping
 * the list of rows this suite may delete short enough to read.
 */
const CONCURRENT_TAG_SETS = [
  ['qsim-itest-w0', 'qsim-itest-w1'],
  ['qsim-itest-x0', 'qsim-itest-x1'],
  ['qsim-itest-y0', 'qsim-itest-y1'],
  ['qsim-itest-z0', 'qsim-itest-z1'],
]

/*
 * Every test here is a round trip to a shared Supabase pooler with
 * `connection_limit=1`, so its wall clock is the network's rather than the
 * code's: a test that creates five circuits is five serialised round trips
 * plus their transactions, which passes Vitest's five-second default while
 * nothing at all is wrong. Stated for the file rather than per test, because
 * the cost is a property of the connection and not of any one assertion.
 */
vi.setConfig({ testTimeout: 60_000 })

const bell: Circuit = {
  schemaVersion: CIRCUIT_SCHEMA_VERSION,
  qubits: 2,
  clbits: 0,
  operations: [
    { id: 'op-0', gate: 'h', targets: [0], column: 0 },
    { id: 'op-1', gate: 'cx', targets: [1], controls: [0], column: 1 },
  ],
}

const ghz: Circuit = {
  schemaVersion: CIRCUIT_SCHEMA_VERSION,
  qubits: 3,
  clbits: 0,
  operations: [
    { id: 'op-0', gate: 'h', targets: [0], column: 0 },
    { id: 'op-1', gate: 'cx', targets: [1], controls: [0], column: 1 },
    { id: 'op-2', gate: 'cx', targets: [2], controls: [1], column: 2 },
  ],
}

describe.skipIf(!enabled)('the Prisma circuit repository', () => {
  let prisma: PrismaClient
  let repository: CircuitRepository

  /**
   * Deletes the two reserved users — and by cascade their circuits, versions
   * and stars — plus the tags this suite is allowed to have created, which
   * belong to no user and so cascade from nothing.
   */
  async function cleanup(): Promise<void> {
    await prisma.user.deleteMany({ where: { id: { in: RESERVED_IDS } } })
    await prisma.tag.deleteMany({ where: { name: { in: RESERVED_TAGS } } })
  }

  beforeAll(async () => {
    prisma = getPrismaClient()
    repository = prismaCircuitRepository(prisma)
    // A previous run that crashed mid-test would otherwise leave rows behind
    // and make the first assertion here fail for the wrong reason.
    await cleanup()
  })

  afterEach(cleanup)

  afterAll(async () => {
    await disconnectPrismaClient()
  })

  async function owned(
    visibility: Visibility = Visibility.PRIVATE,
    data: Circuit = bell
  ) {
    await repository.ensureOwner(OWNER)
    return repository.create({
      ownerId: OWNER.id,
      title: 'Integration circuit',
      description: null,
      visibility,
      data,
      message: 'first',
      forkedFromId: null,
    })
  }

  it('creates a circuit with its first version and derived counters', async () => {
    const { circuit, version } = await owned()

    expect(circuit.qubitCount).toBe(2)
    expect(circuit.gateCount).toBe(2)
    expect(circuit.depth).toBe(2)
    expect(circuit.slug).toMatch(/^[A-Za-z0-9_-]{21}$/)
    expect(version.versionNum).toBe(1)
    // Round-tripped through JSONB and back through `parseCircuit`.
    expect(version.data).toEqual(bell)
  })

  it('stores a thumbnail beside the counters and reads it back', async () => {
    /*
     * The half of M1.5b that only Postgres can answer: `preview` is a JSONB
     * column with no shape Prisma can check, so "the value written is the
     * value read" is a claim about the driver and the column rather than about
     * `previewOf`. A card that draws nothing is the failure this catches, and
     * it is silent everywhere else — the gallery would simply render the
     * fallback for every circuit in the database.
     */
    const { circuit } = await owned(Visibility.PUBLIC)
    expect(circuit.preview).toEqual(previewOf(bell))

    // And it moves with the document. A thumbnail left behind by a save is a
    // picture of a circuit nobody can open any more.
    await repository.appendVersion({
      circuitId: circuit.id,
      ownerId: OWNER.id,
      data: ghz,
      message: 'now a GHZ',
    })

    const reread = await repository.findReadable(circuit.slug, null)
    expect(reread?.preview).toEqual(previewOf(ghz))
    expect(reread?.qubitCount).toBe(3)
  })

  it('applies the §11 filter in SQL, not in the caller', async () => {
    /*
     * The assertion the whole design rests on. Prisma connects as `postgres`
     * and bypasses row-level security, so this is the only thing standing
     * between a PRIVATE circuit and anyone who asks for it.
     */
    const priv = await owned(Visibility.PRIVATE)
    const unlisted = await owned(Visibility.UNLISTED)
    const publik = await owned(Visibility.PUBLIC)

    const cases: [string, string, string | null, boolean][] = [
      ['PRIVATE', priv.circuit.slug, OWNER.id, true],
      ['PRIVATE', priv.circuit.slug, STRANGER.id, false],
      ['PRIVATE', priv.circuit.slug, null, false],
      ['UNLISTED', unlisted.circuit.slug, OWNER.id, true],
      ['UNLISTED', unlisted.circuit.slug, STRANGER.id, true],
      ['UNLISTED', unlisted.circuit.slug, null, true],
      ['PUBLIC', publik.circuit.slug, OWNER.id, true],
      ['PUBLIC', publik.circuit.slug, STRANGER.id, true],
      ['PUBLIC', publik.circuit.slug, null, true],
    ]

    for (const [label, slug, viewer, visible] of cases) {
      const found = await repository.findReadable(slug, viewer)
      expect(found !== null, `${label} for viewer ${String(viewer)}`).toBe(
        visible
      )
    }
  })

  it('addresses the same circuit by slug and by id', async () => {
    const { circuit } = await owned(Visibility.PUBLIC)

    const bySlug = await repository.findReadable(circuit.slug, null)
    const byId = await repository.findReadable(circuit.id, null)

    expect(bySlug?.id).toBe(circuit.id)
    expect(byId?.slug).toBe(circuit.slug)
  })

  it('lists only the owner’s own circuits', async () => {
    await owned(Visibility.PUBLIC)
    await repository.ensureOwner(STRANGER)

    const mine = await repository.listOwned({
      ownerId: OWNER.id,
      skip: 0,
      take: 20,
    })
    const theirs = await repository.listOwned({
      ownerId: STRANGER.id,
      skip: 0,
      take: 20,
    })

    expect(mine.total).toBe(1)
    // A PUBLIC circuit is readable by everyone and still is not part of
    // anybody else's list of their own work.
    expect(theirs.total).toBe(0)
  })

  it('appends versions monotonically and leaves the earlier ones alone', async () => {
    const { circuit } = await owned()

    const second = await repository.appendVersion({
      circuitId: circuit.id,
      ownerId: OWNER.id,
      data: ghz,
      message: 'grew a qubit',
    })
    const third = await repository.appendVersion({
      circuitId: circuit.id,
      ownerId: OWNER.id,
      data: bell,
      message: 'back to two',
    })

    expect(second.versionNum).toBe(2)
    expect(third.versionNum).toBe(3)

    const first = await repository.findVersion({
      circuitId: circuit.id,
      versionNum: 1,
    })
    expect(first?.data).toEqual(bell)
    expect(first?.message).toBe('first')

    const history = await repository.listVersions({
      circuitId: circuit.id,
      skip: 0,
      take: 20,
    })
    expect(history.total).toBe(3)
    expect(history.items.map((item) => item.versionNum)).toEqual([3, 2, 1])
  })

  it('updates the circuit’s counters with the version it saved', async () => {
    const { circuit } = await owned()

    await repository.appendVersion({
      circuitId: circuit.id,
      ownerId: OWNER.id,
      data: ghz,
      message: null,
    })

    const after = await repository.findReadable(circuit.id, OWNER.id)
    expect(after?.qubitCount).toBe(3)
    expect(after?.gateCount).toBe(3)
    expect(after?.depth).toBe(3)
  })

  it('refuses a second version 2 at the database, and says so recognisably', async () => {
    /*
     * The backstop, exercised for real. Two things are asserted and both
     * matter: that `@@unique([circuitId, versionNum])` exists in the deployed
     * schema at all, and that the error Postgres and Prisma actually produce
     * is the one `isVersionNumberConflict` matches. That second half is the
     * likeliest thing to be quietly wrong — the retry loop only works if it
     * recognises the error it is retrying.
     */
    const { circuit } = await owned()

    let raised: unknown = null
    try {
      await prisma.circuitVersion.create({
        data: {
          circuitId: circuit.id,
          versionNum: 1,
          data: toCircuitJson(ghz),
          message: 'a duplicate',
        },
      })
    } catch (error) {
      raised = error
    }

    expect(raised).not.toBeNull()
    expect(isVersionNumberConflict(raised)).toBe(true)

    // And nothing was written: still one version, still the original payload.
    const history = await repository.listVersions({
      circuitId: circuit.id,
      skip: 0,
      take: 20,
    })
    expect(history.total).toBe(1)
  })

  it('recovers the next free number after a version is taken behind its back', async () => {
    // What the retry loop does when it loses: read again, write the number
    // that is now free. Here the "other writer" is this test.
    const { circuit } = await owned()
    await prisma.circuitVersion.create({
      data: {
        circuitId: circuit.id,
        versionNum: 2,
        data: toCircuitJson(ghz),
        message: 'the other tab',
      },
    })

    const next = await repository.appendVersion({
      circuitId: circuit.id,
      ownerId: OWNER.id,
      data: bell,
      message: 'this tab',
    })

    expect(next.versionNum).toBe(3)
  })

  it('scopes an update to the owner', async () => {
    const { circuit } = await owned()

    const byStranger = await repository.update({
      id: circuit.id,
      ownerId: STRANGER.id,
      title: 'Mine now',
    })
    const byOwner = await repository.update({
      id: circuit.id,
      ownerId: OWNER.id,
      title: 'Renamed',
    })

    expect(byStranger).toBeNull()
    expect(byOwner?.title).toBe('Renamed')
  })

  it('scopes a delete to the owner, and takes the versions with it', async () => {
    const { circuit } = await owned()
    await repository.appendVersion({
      circuitId: circuit.id,
      ownerId: OWNER.id,
      data: ghz,
      message: null,
    })

    const byStranger = await repository.remove({
      id: circuit.id,
      ownerId: STRANGER.id,
    })
    const byOwner = await repository.remove({
      id: circuit.id,
      ownerId: OWNER.id,
    })

    expect(byStranger).toBe(false)
    expect(byOwner).toBe(true)
    // `ON DELETE CASCADE` on CircuitVersion.circuitId, asserted rather than
    // assumed: an orphaned version would be a row nothing can ever reach.
    const orphans = await prisma.circuitVersion.count({
      where: { circuitId: circuit.id },
    })
    expect(orphans).toBe(0)
  })

  it('forks into a new circuit that keeps the attribution', async () => {
    const source = await owned(Visibility.PUBLIC)
    await repository.appendVersion({
      circuitId: source.circuit.id,
      ownerId: OWNER.id,
      data: ghz,
      message: 'the version to copy',
    })
    await repository.ensureOwner(STRANGER)

    const fork = await forkCircuit(repository, {
      source: source.circuit,
      ownerId: STRANGER.id,
    })

    expect(fork.circuit.id).not.toBe(source.circuit.id)
    expect(fork.circuit.ownerId).toBe(STRANGER.id)
    expect(fork.circuit.forkedFromId).toBe(source.circuit.id)
    // A fork of a public circuit is not itself published.
    expect(fork.circuit.visibility).toBe(Visibility.PRIVATE)

    const copied = await repository.latestVersion(fork.circuit.id)
    expect(copied?.versionNum).toBe(1)
    // The *current* version, not the first one.
    expect(copied?.data).toEqual(ghz)
  })

  it('scopes an append to the owner, in the query and not in the caller', async () => {
    const { circuit } = await owned()

    await expect(
      repository.appendVersion({
        circuitId: circuit.id,
        ownerId: STRANGER.id,
        data: ghz,
        message: 'not yours',
      })
    ).rejects.toMatchObject({ code: 'CIRCUIT_NOT_WRITABLE' })

    // And the refusal wrote nothing: the version insert happens before the
    // owner-scoped update, so the whole transaction has to roll back or this
    // leaves a row in a stranger's history that nothing can remove.
    const history = await repository.listVersions({
      circuitId: circuit.id,
      skip: 0,
      take: 20,
    })
    expect(history.total).toBe(1)
  })

  it('answers a save against a deleted circuit without writing anything', async () => {
    const { circuit } = await owned()
    expect(await repository.remove({ id: circuit.id, ownerId: OWNER.id })).toBe(
      true
    )

    /*
     * The foreign key on CircuitVersion.circuitId is what fires here — P2003,
     * not the P2025 the error mapping used to expect — and it fires before
     * the owner-scoped update is reached. What matters at this level is that
     * nothing is written; the API maps it to 404.
     */
    await expect(
      repository.appendVersion({
        circuitId: circuit.id,
        ownerId: OWNER.id,
        data: ghz,
        message: 'into the void',
      })
    ).rejects.toThrow()

    const orphans = await prisma.circuitVersion.count({
      where: { circuitId: circuit.id },
    })
    expect(orphans).toBe(0)
  })

  it('does not let a circuit id stand in for an unlisted circuit’s slug', async () => {
    /*
     * The id is not a credential. It has been published by this API before —
     * `forkedFromId` rode out in every card — and a caller holding one must
     * not be able to open an UNLISTED circuit with it. The slug is what
     * UNLISTED is protected by, and it is the only handle that admits it.
     */
    const { circuit } = await owned(Visibility.UNLISTED)

    expect(await repository.findReadable(circuit.slug, null)).not.toBeNull()
    expect(await repository.findReadable(circuit.id, null)).toBeNull()
    expect(await repository.findReadable(circuit.id, STRANGER.id)).toBeNull()
    // The owner still reaches their own circuit either way.
    expect(await repository.findReadable(circuit.id, OWNER.id)).not.toBeNull()

    // And a PUBLIC circuit is addressable by id, which is what keeps
    // `/circuits/:id/versions` working for the gallery.
    const open = await owned(Visibility.PUBLIC)
    expect(await repository.findReadable(open.circuit.id, null)).not.toBeNull()
  })

  it('refuses to store a circuit over the size cap, before touching Postgres', async () => {
    await repository.ensureOwner(OWNER)
    const operations = []
    for (let column = 0; column < 3200; column += 1) {
      operations.push({
        id: `op-a-${String(column)}`,
        gate: 'h',
        targets: [0],
        column,
      })
      operations.push({
        id: `op-b-${String(column)}`,
        gate: 'h',
        targets: [1],
        column,
      })
    }

    await expect(
      repository.create({
        ownerId: OWNER.id,
        title: 'Enormous',
        description: null,
        visibility: Visibility.PRIVATE,
        data: { ...bell, operations },
        message: null,
        forkedFromId: null,
      })
    ).rejects.toThrow()

    const written = await repository.listOwned({
      ownerId: OWNER.id,
      skip: 0,
      take: 20,
    })
    expect(written.total).toBe(0)
  })

  it('creates the owner row once and reuses it', async () => {
    const first = await repository.ensureOwner(OWNER)
    const second = await repository.ensureOwner(OWNER)

    expect(first.id).toBe(OWNER.id)
    expect(second.id).toBe(OWNER.id)
    const rows = await prisma.user.count({ where: { id: OWNER.id } })
    expect(rows).toBe(1)
  })

  /* ── The gallery, against real SQL ──────────────────────────────────── */

  it('applies the gallery filter in SQL, from a stranger’s point of view', async () => {
    /*
     * The assertion the whole milestone rests on. `listPublished` is reached
     * by an unauthenticated route over a table holding every private circuit
     * in the database, and Prisma connects as `postgres` — which owns these
     * tables and carries rolbypassrls — so this `where` is the only thing
     * between the two.
     */
    await owned(Visibility.PRIVATE)
    await owned(Visibility.UNLISTED)
    await owned(Visibility.PUBLIC)

    const cases: [string, string | null, number][] = [
      ['anonymous', null, 1],
      ['a stranger', STRANGER.id, 1],
      ['the owner', OWNER.id, 3],
    ]

    for (const [label, viewerId, expected] of cases) {
      const page = await repository.listPublished({
        viewerId,
        sort: 'recent',
        take: 20,
      })
      expect(page.items, label).toHaveLength(expected)
      if (viewerId !== OWNER.id) {
        expect(
          page.items.map((item) => item.visibility),
          label
        ).toEqual([Visibility.PUBLIC])
      }
    }
  })

  it('scopes a profile listing to one author without losing the rule', async () => {
    await owned(Visibility.PUBLIC)
    await owned(Visibility.PRIVATE)
    await repository.ensureOwner(STRANGER)

    const asStranger = await repository.listPublished({
      viewerId: STRANGER.id,
      ownerId: OWNER.id,
      sort: 'recent',
      take: 20,
    })
    const asOwner = await repository.listPublished({
      viewerId: OWNER.id,
      ownerId: OWNER.id,
      sort: 'recent',
      take: 20,
    })
    const theirsAsSeenByOwner = await repository.listPublished({
      viewerId: OWNER.id,
      ownerId: STRANGER.id,
      sort: 'recent',
      take: 20,
    })

    expect(asStranger.items).toHaveLength(1)
    expect(asOwner.items).toHaveLength(2)
    // Scoping to another author must not smuggle the viewer's own rows in.
    expect(theirsAsSeenByOwner.items).toHaveLength(0)
  })

  it('searches title and description inside a word, case-insensitively', async () => {
    // What the trigram index is for, and what `to_tsvector` could not do:
    // "grov" finds Grover.
    await repository.ensureOwner(OWNER)
    await repository.create({
      ownerId: OWNER.id,
      title: 'Grover search',
      description: 'Amplitude amplification over four items',
      visibility: Visibility.PUBLIC,
      data: bell,
      message: null,
      forkedFromId: null,
    })
    await owned(Visibility.PUBLIC)

    const byTitle = await repository.listPublished({
      viewerId: null,
      sort: 'recent',
      search: 'GROV',
      take: 20,
    })
    const byDescription = await repository.listPublished({
      viewerId: null,
      sort: 'recent',
      search: 'amplification',
      take: 20,
    })

    expect(byTitle.items.map((item) => item.title)).toEqual(['Grover search'])
    expect(byDescription.items.map((item) => item.title)).toEqual([
      'Grover search',
    ])
  })

  it('treats a LIKE wildcard in the search term as a character', async () => {
    /*
     * The escape, exercised against the database that actually interprets
     * the pattern. Unescaped, `%` reaches Postgres as `ILIKE '%%%'` and
     * returns every row — an accidental "list everything" on the one route
     * where listing everything is the failure mode. The in-memory double
     * models this, and this is the assertion that the model is right.
     */
    await repository.ensureOwner(OWNER)
    await repository.create({
      ownerId: OWNER.id,
      title: 'Ninety-nine percent',
      description: null,
      visibility: Visibility.PUBLIC,
      data: bell,
      message: null,
      forkedFromId: null,
    })
    await repository.create({
      ownerId: OWNER.id,
      title: '100% fidelity',
      description: null,
      visibility: Visibility.PUBLIC,
      data: bell,
      message: null,
      forkedFromId: null,
    })

    const wildcard = await repository.listPublished({
      viewerId: null,
      sort: 'recent',
      search: '%%%',
      take: 20,
    })
    const literal = await repository.listPublished({
      viewerId: null,
      sort: 'recent',
      search: '100%',
      take: 20,
    })
    const underscore = await repository.listPublished({
      viewerId: null,
      sort: 'recent',
      search: 'Nine_y',
      take: 20,
    })

    expect(wildcard.items).toHaveLength(0)
    expect(literal.items.map((item) => item.title)).toEqual(['100% fidelity'])
    expect(underscore.items).toHaveLength(0)
  })

  it('keeps a private circuit out of a search that matches it exactly', async () => {
    await repository.ensureOwner(OWNER)
    await repository.create({
      ownerId: OWNER.id,
      title: 'Grover secret',
      description: null,
      visibility: Visibility.PRIVATE,
      data: bell,
      message: null,
      forkedFromId: null,
    })

    const page = await repository.listPublished({
      viewerId: STRANGER.id,
      sort: 'recent',
      search: 'Grover',
      take: 20,
    })

    expect(page.items).toHaveLength(0)
  })

  it('paginates by cursor without repeating or skipping a row', async () => {
    await repository.ensureOwner(OWNER)
    const titles: string[] = []
    for (let index = 0; index < 5; index += 1) {
      const title = `Paged ${String(index)}`
      titles.push(title)
      await repository.create({
        ownerId: OWNER.id,
        title,
        description: null,
        visibility: Visibility.PUBLIC,
        data: bell,
        message: null,
        forkedFromId: null,
      })
    }

    const seen: string[] = []
    let cursor = null as ReturnType<typeof decodeGalleryCursor>
    let raw: string | null = null
    for (let page = 0; page < 10; page += 1) {
      const result = await repository.listPublished({
        viewerId: null,
        sort: 'recent',
        take: 2,
        cursor,
      })
      seen.push(...result.items.map((item) => item.title))
      raw = result.nextCursor
      if (raw === null) break
      cursor = decodeGalleryCursor(raw, 'recent')
      expect(cursor).not.toBeNull()
    }

    expect(raw).toBeNull()
    expect(new Set(seen).size).toBe(5)
    expect([...seen].sort()).toEqual([...titles].sort())
  })

  /* ── Stars ──────────────────────────────────────────────────────────── */

  it('counts one star however many times the same user asks', async () => {
    /*
     * The concurrency case, against the database that decides it. Four
     * simultaneous stars from one user must produce one `Star` row and a
     * `starCount` of exactly one: the insert is `ON CONFLICT DO NOTHING`, so
     * three of the four are told "0 rows" and skip the increment. A
     * read-modify-write here would produce four.
     */
    const { circuit } = await owned(Visibility.PUBLIC)
    await repository.ensureOwner(STRANGER)

    const results = await Promise.all(
      Array.from({ length: 4 }, () =>
        repository.star({ userId: STRANGER.id, circuitId: circuit.id })
      )
    )

    for (const result of results) expect(result.starred).toBe(true)
    const rows = await prisma.star.count({ where: { circuitId: circuit.id } })
    const after = await repository.findReadable(circuit.id, null)
    expect(rows).toBe(1)
    expect(after?.starCount).toBe(1)
  })

  it('counts two people as two stars', async () => {
    const { circuit } = await owned(Visibility.PUBLIC)
    await repository.ensureOwner(STRANGER)

    await repository.star({ userId: OWNER.id, circuitId: circuit.id })
    const second = await repository.star({
      userId: STRANGER.id,
      circuitId: circuit.id,
    })

    expect(second.starCount).toBe(2)
  })

  it('unstars idempotently and never below zero', async () => {
    const { circuit } = await owned(Visibility.PUBLIC)
    await repository.ensureOwner(STRANGER)
    await repository.star({ userId: STRANGER.id, circuitId: circuit.id })

    const first = await repository.unstar({
      userId: STRANGER.id,
      circuitId: circuit.id,
    })
    const second = await repository.unstar({
      userId: STRANGER.id,
      circuitId: circuit.id,
    })
    const never = await repository.unstar({
      userId: OWNER.id,
      circuitId: circuit.id,
    })

    expect(first).toEqual({ starred: false, starCount: 0 })
    expect(second).toEqual({ starred: false, starCount: 0 })
    expect(never).toEqual({ starred: false, starCount: 0 })
    expect(await prisma.star.count({ where: { circuitId: circuit.id } })).toBe(
      0
    )
  })

  it('reports whether this viewer has starred, and nobody else’s star', async () => {
    const { circuit } = await owned(Visibility.PUBLIC)
    await repository.ensureOwner(STRANGER)
    await repository.star({ userId: STRANGER.id, circuitId: circuit.id })

    expect(
      await repository.hasStarred({
        userId: STRANGER.id,
        circuitId: circuit.id,
      })
    ).toBe(true)
    expect(
      await repository.hasStarred({ userId: OWNER.id, circuitId: circuit.id })
    ).toBe(false)
  })

  it('answers a star against a deleted circuit rather than inventing one', async () => {
    const { circuit } = await owned(Visibility.PUBLIC)
    await repository.ensureOwner(STRANGER)
    await repository.remove({ id: circuit.id, ownerId: OWNER.id })

    // The foreign key on Star.circuitId is what fires. What matters at this
    // level is that nothing is written; the API maps it to 404.
    await expect(
      repository.star({ userId: STRANGER.id, circuitId: circuit.id })
    ).rejects.toThrow()
    expect(await prisma.star.count({ where: { circuitId: circuit.id } })).toBe(
      0
    )
  })

  it('takes a circuit’s stars with it when the circuit is deleted', async () => {
    const { circuit } = await owned(Visibility.PUBLIC)
    await repository.star({ userId: OWNER.id, circuitId: circuit.id })

    await repository.remove({ id: circuit.id, ownerId: OWNER.id })

    // `ON DELETE CASCADE` on Star.circuitId, asserted rather than assumed: an
    // orphaned star would be a row nothing can ever reach or remove.
    expect(await prisma.star.count({ where: { circuitId: circuit.id } })).toBe(
      0
    )
  })

  /* ── Tags ───────────────────────────────────────────────────────────── */

  it('creates a tag once however many circuits claim it at the same time', async () => {
    /*
     * `Tag.name` is unique, and a popular tag is by definition one many
     * people are writing at the same moment. The naive "look it up, insert
     * if missing" loses that race and fails an unrelated save with P2002;
     * `ON CONFLICT DO NOTHING` cannot.
     */
    await repository.ensureOwner(OWNER)

    await Promise.all(
      Array.from({ length: 3 }, (_, index) =>
        repository.create({
          ownerId: OWNER.id,
          title: `Tagged ${String(index)}`,
          description: null,
          visibility: Visibility.PUBLIC,
          data: bell,
          message: null,
          forkedFromId: null,
          tags: ['qsim-itest-shared'],
        })
      )
    )

    const tags = await prisma.tag.count({
      where: { name: 'qsim-itest-shared' },
    })
    const links = await prisma.circuitTag.count({
      where: { tag: { name: 'qsim-itest-shared' } },
    })
    expect(tags).toBe(1)
    expect(links).toBe(3)
  })

  it('filters the gallery by tag, through the join', async () => {
    await repository.ensureOwner(OWNER)
    await repository.create({
      ownerId: OWNER.id,
      title: 'Has alpha',
      description: null,
      visibility: Visibility.PUBLIC,
      data: bell,
      message: null,
      forkedFromId: null,
      tags: ['qsim-itest-alpha', 'qsim-itest-beta'],
    })
    await owned(Visibility.PUBLIC)

    const matching = await repository.listPublished({
      viewerId: null,
      sort: 'recent',
      tag: 'qsim-itest-alpha',
      take: 20,
    })
    const missing = await repository.listPublished({
      viewerId: null,
      sort: 'recent',
      tag: 'qsim-itest-nobody',
      take: 20,
    })

    expect(matching.items.map((item) => item.title)).toEqual(['Has alpha'])
    expect(matching.items[0]?.tags).toEqual([
      'qsim-itest-alpha',
      'qsim-itest-beta',
    ])
    expect(missing.items).toHaveLength(0)
  })

  it('keeps a private circuit out of a tag facet it matches', async () => {
    await repository.ensureOwner(OWNER)
    await repository.create({
      ownerId: OWNER.id,
      title: 'Private but tagged',
      description: null,
      visibility: Visibility.PRIVATE,
      data: bell,
      message: null,
      forkedFromId: null,
      tags: ['qsim-itest-alpha'],
    })

    const page = await repository.listPublished({
      viewerId: STRANGER.id,
      sort: 'recent',
      tag: 'qsim-itest-alpha',
      take: 20,
    })

    expect(page.items).toHaveLength(0)
  })

  it('replaces a tag set on update and leaves it alone when unmentioned', async () => {
    const { circuit } = await owned(Visibility.PUBLIC)
    await repository.update({
      id: circuit.id,
      ownerId: OWNER.id,
      tags: ['qsim-itest-alpha', 'qsim-itest-beta'],
    })

    const replaced = await repository.update({
      id: circuit.id,
      ownerId: OWNER.id,
      tags: ['qsim-itest-beta'],
    })
    const renamed = await repository.update({
      id: circuit.id,
      ownerId: OWNER.id,
      title: 'Renamed',
    })
    const cleared = await repository.update({
      id: circuit.id,
      ownerId: OWNER.id,
      tags: [],
    })

    expect(replaced?.tags).toEqual(['qsim-itest-beta'])
    expect(renamed?.tags).toEqual(['qsim-itest-beta'])
    expect(cleared?.tags).toEqual([])
    // The join rows go, the `Tag` row stays — nothing sweeps unused tags,
    // and a sweep would have to race every save about to reference one.
    expect(
      await prisma.circuitTag.count({ where: { circuitId: circuit.id } })
    ).toBe(0)
  })

  it('replaces rather than accumulates when the replacements are concurrent', async () => {
    /*
     * THE DEFECT, and the only place it is visible.
     *
     * `setCircuitTags` is a DELETE followed by an INSERT over a *set*, and
     * Postgres has no constraint that can arbitrate one. Under READ COMMITTED
     * the delete removes only the join rows in its own transaction's snapshot,
     * so two concurrent PATCHes each deleted the pre-existing set, each
     * inserted their own, and neither insert conflicted with the other: both
     * answered 200 and the circuit ended up carrying the union. Measured
     * before the fix, with four connections and eight names each: 32 rows on a
     * circuit whose card promises at most 8, answering to 32 gallery facets —
     * and `forkCircuit` then copies all of them onto a new circuit with no
     * concurrency involved at all.
     *
     * It needs more than one connection to reproduce, which is why it is here
     * and not in `tags.test.ts` or in the API's route tests: the in-memory
     * double replaces the array wholesale and *cannot* exhibit it, and the
     * project's own pooler URL carries `connection_limit=1`, so a single
     * client serialises the writes and the suite stays green while production
     * with two replicas does not. Each writer therefore gets its own client.
     *
     * The assertion is the last writer's set exactly — not "at most eight".
     * "At most eight" would also pass if three of the four replacements were
     * silently lost, which is a different defect wearing the same number.
     */
    const url = process.env.DATABASE_URL
    expect(
      url,
      'DATABASE_URL must be set for the integration suite'
    ).toBeTruthy()

    const { circuit } = await owned(Visibility.PUBLIC)
    const clients = CONCURRENT_TAG_SETS.map(() => createPrismaClient(url!))

    try {
      const results = await Promise.all(
        clients.map((client, index) =>
          prismaCircuitRepository(client).update({
            id: circuit.id,
            ownerId: OWNER.id,
            tags: CONCURRENT_TAG_SETS[index],
          })
        )
      )

      // Every one of them succeeded, so every one of them is a writer whose
      // answer a client believed.
      for (const result of results) expect(result).not.toBeNull()

      const rows = await prisma.circuitTag.findMany({
        where: { circuitId: circuit.id },
        select: { tag: { select: { name: true } } },
      })
      const stored = rows.map((row) => row.tag.name).sort()

      expect(stored).toHaveLength(2)
      expect(CONCURRENT_TAG_SETS.map((set) => [...set].sort())).toContainEqual(
        stored
      )

      /*
       * And what the winner was told matches what is stored. Before the fix
       * three of the four responses reported a set that was neither what was
       * asked for nor what the row held.
       */
      const winner = results.find(
        (result) =>
          JSON.stringify([...(result?.tags ?? [])].sort()) ===
          JSON.stringify(stored)
      )
      expect(winner, 'some response must describe the stored set').toBeDefined()
    } finally {
      await Promise.all(clients.map((client) => client.$disconnect()))
    }
  })

  /* ── The live collaborative document (M5.2) ───────────────────────────── */

  it('round-trips a session document as bytes, not as text', async () => {
    const circuit = await owned(Visibility.PRIVATE)
    // Every byte value, so a `bytea` that had become `text` somewhere would not
    // survive: a Yjs update is arbitrary binary and 0x00 is a legal byte in it.
    const state = Uint8Array.from({ length: 256 }, (_, index) => index)

    await repository.saveSession({ circuitId: circuit.circuit.id, state })
    const loaded = await repository.loadSession(circuit.circuit.id)

    expect(loaded?.state).toEqual(state)
    expect(loaded?.updatedAt).toBeInstanceOf(Date)
  })

  it('holds one document per circuit, replacing rather than accumulating', async () => {
    const circuit = await owned(Visibility.PRIVATE)
    await repository.saveSession({
      circuitId: circuit.circuit.id,
      state: new Uint8Array([1]),
    })
    await repository.saveSession({
      circuitId: circuit.circuit.id,
      state: new Uint8Array([2, 3]),
    })

    expect((await repository.loadSession(circuit.circuit.id))?.state).toEqual(
      new Uint8Array([2, 3])
    )
    expect(
      await prisma.circuitSession.count({
        where: { circuitId: circuit.circuit.id },
      })
    ).toBe(1)
  })

  /**
   * The reconciliation between an immutable history and a continuous session, in
   * one assertion. The case it exists for is restore: restoring version 3
   * appends a version carrying version 3's circuit, and a surviving session row
   * would make the next session resume the pre-restore document — silently
   * undoing the restore.
   */
  it('forgets the live document when a version is appended', async () => {
    const circuit = await owned(Visibility.PRIVATE)
    await repository.saveSession({
      circuitId: circuit.circuit.id,
      state: new Uint8Array([1, 2, 3]),
    })

    await repository.appendVersion({
      circuitId: circuit.circuit.id,
      ownerId: OWNER.id,
      data: ghz,
      message: 'saved',
    })

    expect(await repository.loadSession(circuit.circuit.id)).toBeNull()
  })

  /**
   * And it must not forget it when the append is refused. A save that never
   * happened has no business discarding an hour of somebody's session — and the
   * delete is inside the same transaction precisely so that it rolls back with
   * the version.
   */
  it('keeps the live document when the append is refused', async () => {
    const circuit = await owned(Visibility.PRIVATE)
    await repository.saveSession({
      circuitId: circuit.circuit.id,
      state: new Uint8Array([1, 2, 3]),
    })

    await expect(
      repository.appendVersion({
        circuitId: circuit.circuit.id,
        // Not this circuit's owner, so the owner-scoped update matches no row.
        ownerId: STRANGER.id,
        data: ghz,
        message: 'not mine',
      })
    ).rejects.toThrow()

    expect((await repository.loadSession(circuit.circuit.id))?.state).toEqual(
      new Uint8Array([1, 2, 3])
    )
  })

  it('drops a document on request, idempotently', async () => {
    const circuit = await owned(Visibility.PRIVATE)
    await repository.saveSession({
      circuitId: circuit.circuit.id,
      state: new Uint8Array([9]),
    })

    expect(await repository.dropSession(circuit.circuit.id)).toBe(true)
    expect(await repository.dropSession(circuit.circuit.id)).toBe(false)
    expect(await repository.loadSession(circuit.circuit.id)).toBeNull()
  })

  it('refuses a document for a circuit that does not exist', async () => {
    // `CircuitSession_circuitId_fkey`, and the reason it is there: a document
    // must not be able to outlive the circuit it describes.
    await expect(
      repository.saveSession({
        circuitId: 'qsim-itest-no-such-circuit',
        state: new Uint8Array([1]),
      })
    ).rejects.toThrow()
  })

  it('takes a circuit’s document with it when the circuit is deleted', async () => {
    const circuit = await owned(Visibility.PRIVATE)
    await repository.saveSession({
      circuitId: circuit.circuit.id,
      state: new Uint8Array([1]),
    })

    expect(
      await repository.remove({ id: circuit.circuit.id, ownerId: OWNER.id })
    ).toBe(true)
    expect(
      await prisma.circuitSession.count({
        where: { circuitId: circuit.circuit.id },
      })
    ).toBe(0)
  })

  /* ── Comments anchored to gates (M5.4) ────────────────────────────────── */

  /**
   * Everything in this block is a claim about SQL that no unit test can settle.
   * The API's own suite runs against a fake repository, so the two foreign keys
   * this milestone added, the cascade the delete route depends on, and the
   * `groupBy` behind every marker on the canvas are only ever exercised here.
   */

  it('stores an anchor verbatim and does not care whether it resolves', async () => {
    const { circuit } = await owned(Visibility.PUBLIC)
    await repository.ensureOwner(OWNER)

    // An id no operation in this document carries. There is no foreign key to
    // refuse it and none is wanted: which document an anchor is resolved against
    // is the reader's question, and the four candidates disagree.
    const stored = await repository.postComment({
      circuitId: circuit.id,
      userId: OWNER.id,
      body: 'About a gate that is not here.',
      anchorOpId: 'op-never-existed',
    })

    expect(stored.anchorOpId).toBe('op-never-existed')
    expect(stored.resolvedAt).toBeNull()
  })

  it('tallies every anchor on the circuit, narrowed by neither page nor state', async () => {
    const { circuit } = await owned(Visibility.PUBLIC)
    await repository.ensureOwner(OWNER)

    const onOpZero = await repository.postComment({
      circuitId: circuit.id,
      userId: OWNER.id,
      body: 'First, about op-0.',
      anchorOpId: 'op-0',
    })
    await repository.postComment({
      circuitId: circuit.id,
      userId: OWNER.id,
      body: 'Second, about op-0.',
      anchorOpId: 'op-0',
    })
    await repository.postComment({
      circuitId: circuit.id,
      userId: OWNER.id,
      body: 'About op-1.',
      anchorOpId: 'op-1',
    })
    await repository.postComment({
      circuitId: circuit.id,
      userId: OWNER.id,
      body: 'About the circuit as a whole.',
    })

    await repository.setThreadResolution({
      circuitId: circuit.id,
      rootId: onOpZero.id,
      viewerId: OWNER.id,
      ownerId: OWNER.id,
      resolved: true,
    })

    /*
     * Asked with the *default* filter and a page of one, which is the shape that
     * would break a page-derived tally: the canvas has to mark op-1 even though
     * it is not on this page, and it has to mark op-0 even though the only
     * thread there that is resolved would fall outside `state: 'open'`.
     */
    const page = await repository.listComments({
      circuitId: circuit.id,
      state: 'open',
      skip: 0,
      take: 1,
    })

    expect(page.threads).toHaveLength(1)
    expect(page.openCount).toBe(3)
    expect(page.resolvedCount).toBe(1)
    expect(page.circuitTotal).toBe(4)
    expect(page.anchors).toEqual({
      'op-0': { open: 1, resolved: 1 },
      'op-1': { open: 1, resolved: 0 },
    })
  })

  it('takes a thread’s replies with it, by cascade rather than by a sweep', async () => {
    const { circuit } = await owned(Visibility.PUBLIC)
    await repository.ensureOwner(OWNER)
    await repository.ensureOwner(STRANGER)

    const root = await repository.postComment({
      circuitId: circuit.id,
      userId: OWNER.id,
      body: 'Is this `H` needed?',
      anchorOpId: 'op-0',
    })
    // Somebody else's reply, which is the case the retired sweep in
    // `accounts.ts` existed for: it must go with the root it hangs off.
    await repository.postComment({
      circuitId: circuit.id,
      userId: STRANGER.id,
      body: 'No.',
      parentId: root.id,
    })

    // A reply inherits its root's anchor, read from the parent rather than
    // accepted from the caller.
    const thread = await repository.findThread({
      circuitId: circuit.id,
      rootId: root.id,
    })
    expect(thread?.replies.map((reply) => reply.anchorOpId)).toEqual(['op-0'])

    expect(
      await repository.deleteComment({
        circuitId: circuit.id,
        commentId: root.id,
        viewerId: OWNER.id,
        ownerId: OWNER.id,
      })
    ).toBe(true)
    expect(
      await prisma.comment.count({ where: { circuitId: circuit.id } })
    ).toBe(0)
  })

  it('keeps a thread resolved after the resolver’s account is deleted', async () => {
    /*
     * `resolvedById` is `ON DELETE SET NULL` and not `ON DELETE CASCADE`, and the
     * difference is the whole point of resolving: a conversation that was settled
     * stays settled when the person who settled it leaves. Cascade would delete
     * the conversation instead.
     */
    const { circuit } = await owned(Visibility.PUBLIC)
    await repository.ensureOwner(OWNER)
    await repository.ensureOwner(STRANGER)

    const root = await repository.postComment({
      circuitId: circuit.id,
      userId: OWNER.id,
      body: 'Worth checking.',
      anchorOpId: 'op-1',
    })
    await repository.setThreadResolution({
      circuitId: circuit.id,
      rootId: root.id,
      viewerId: STRANGER.id,
      // The circuit's owner is admitted by the filter, and so is the thread's
      // author; here the stranger resolves as the owner of nothing, so the
      // filter has to be given the owner it is checking against.
      ownerId: STRANGER.id,
      resolved: true,
    })

    await prisma.user.delete({ where: { id: STRANGER.id } })

    const after = await repository.findThread({
      circuitId: circuit.id,
      rootId: root.id,
    })
    expect(after?.root.resolvedAt).toBeInstanceOf(Date)
    // Only the attribution is lost, which the panel can say without a name.
    expect(after?.root.resolvedBy).toBeNull()
  })

  it('refuses a reply to a reply, and a parent on another circuit', async () => {
    const first = await owned(Visibility.PUBLIC)
    const second = await owned(Visibility.PUBLIC)
    await repository.ensureOwner(OWNER)

    const root = await repository.postComment({
      circuitId: first.circuit.id,
      userId: OWNER.id,
      body: 'Root.',
      anchorOpId: 'op-0',
    })
    const reply = await repository.postComment({
      circuitId: first.circuit.id,
      userId: OWNER.id,
      body: 'Reply.',
      parentId: root.id,
    })

    await expect(
      repository.postComment({
        circuitId: first.circuit.id,
        userId: OWNER.id,
        body: 'A third level.',
        parentId: reply.id,
      })
    ).rejects.toThrow()

    // The parent is looked up *scoped to the circuit*, so a real comment id from
    // somewhere else is as absent as one that never existed.
    await expect(
      repository.postComment({
        circuitId: second.circuit.id,
        userId: OWNER.id,
        body: 'Wrong circuit.',
        parentId: root.id,
      })
    ).rejects.toThrow()
  })

  it('takes a circuit’s comments with it when the circuit is deleted', async () => {
    const { circuit } = await owned(Visibility.PUBLIC)
    await repository.ensureOwner(OWNER)
    await repository.postComment({
      circuitId: circuit.id,
      userId: OWNER.id,
      body: 'About op-0.',
      anchorOpId: 'op-0',
    })

    expect(await repository.remove({ id: circuit.id, ownerId: OWNER.id })).toBe(
      true
    )
    expect(
      await prisma.comment.count({ where: { circuitId: circuit.id } })
    ).toBe(0)
  })

  it('finds a user by their public handle, without their email', async () => {
    await repository.ensureOwner(OWNER)
    const created = await prisma.user.findUnique({ where: { id: OWNER.id } })

    const found = await repository.findUserByUsername(
      created?.username ?? 'missing'
    )

    expect(found?.id).toBe(OWNER.id)
    expect(found).not.toHaveProperty('email')
    expect(await repository.findUserByUsername('qsim-itest-nobody')).toBeNull()
  })

  it('leaves the database exactly as it found it', async () => {
    /*
     * The last word on hygiene. Everything above ran `cleanup` after it, and
     * `cleanup` deletes two `User` rows and lets the cascades do the rest.
     * This asserts the cascades actually reached: no reserved user, and no
     * circuit belonging to one.
     */
    await owned(Visibility.PUBLIC)
    await cleanup()

    expect(
      await prisma.user.count({ where: { id: { in: RESERVED_IDS } } })
    ).toBe(0)
    expect(
      await prisma.circuit.count({ where: { ownerId: { in: RESERVED_IDS } } })
    ).toBe(0)
    // Every version this suite wrote belonged to a circuit owned by one of
    // the two, so an orphan would mean a cascade did not fire.
    expect(
      await prisma.circuitVersion.count({
        where: { circuit: { ownerId: { in: RESERVED_IDS } } },
      })
    ).toBe(0)
    // And the same for a session document, which cascades from the circuit for
    // the same reason a version does (M5.2).
    expect(
      await prisma.circuitSession.count({
        where: { circuit: { ownerId: { in: RESERVED_IDS } } },
      })
    ).toBe(0)
    /*
     * And for a comment (M5.4), which cascades twice over: from the circuit it is
     * about and from the user who wrote it. A reply left behind would mean the
     * `parentId` key this milestone added is not doing what `accounts.ts` now
     * relies on it for.
     */
    expect(
      await prisma.comment.count({
        where: {
          OR: [
            { circuit: { ownerId: { in: RESERVED_IDS } } },
            { userId: { in: RESERVED_IDS } },
          ],
        },
      })
    ).toBe(0)
  })
})
