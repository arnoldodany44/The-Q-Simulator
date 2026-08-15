import { existsSync } from 'node:fs'
import path from 'node:path'
import process from 'node:process'
import { CIRCUIT_SCHEMA_VERSION } from '@qsim/schema'
import type { Circuit } from '@qsim/schema'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import { disconnectPrismaClient, getPrismaClient } from './client.js'
import {
  forkCircuit,
  isVersionNumberConflict,
  prismaCircuitRepository,
} from './circuits.js'
import type { CircuitRepository } from './circuits.js'
import { toCircuitJson } from './circuit-data.js'
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

  /** Deletes the two reserved users, and by cascade everything they own. */
  async function cleanup(): Promise<void> {
    await prisma.user.deleteMany({ where: { id: { in: RESERVED_IDS } } })
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
  })
})
