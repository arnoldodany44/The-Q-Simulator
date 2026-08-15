/**
 * An in-memory `CircuitRepository`, for driving the real routes with no
 * Postgres in reach.
 *
 * ── Why this exists, and what it is careful not to be ─────────────────────
 *
 * This project has one database. It is the owner's, it is shared between
 * development and production, and CI runs on every push — so a suite that
 * wrote to it would either be skipped (guarding nothing) or would insert rows
 * into production from a pull request. What is substituted here is Postgres
 * and nothing else: the Fastify instance, the hooks, the token verifier, the
 * Zod compilers, the visibility decisions and the error handler in every test
 * are the real ones.
 *
 * The one thing a fake must never do is disagree with production about the
 * rule under test, and the rule under test here is §11. So the visibility
 * decision is not reimplemented — `slugAddressableCircuitFilter` is called,
 * the very `where` fragment the Prisma implementation passes to the database,
 * and `matchesFilter` below evaluates it. It throws on a filter shape it does
 * not understand rather than defaulting to "visible", so a future change to
 * the filter breaks this loudly instead of quietly widening what these tests
 * consider allowed.
 *
 * Three constraints are modelled because three constraints are load-bearing:
 * `@@unique([circuitId, versionNum])`, the unique `slug`, and
 * `CircuitVersion_circuitId_fkey`. The first is what makes concurrent saves
 * testable at all — `beforeVersionWrite` opens the window between reading the
 * highest version and writing the next one, which is exactly where a second
 * writer can slip in.
 *
 * The foreign key was the one that was missing, and its absence is why two
 * production 500s had no failing test: this fake accepted a save against a
 * circuit that had just been deleted, answered 201, and left an orphan
 * version row, while Postgres raised P2003 and wrote nothing. A fake that
 * succeeds where production raises is not a weaker test, it is a test
 * pointing the wrong way.
 *
 * The Prisma implementation is covered separately, deliberately, against the
 * real database: `packages/db/src/circuits.db.test.ts`.
 */

import {
  circuitHandleFilter,
  CircuitNotWritableError,
  ensureUser,
  generateCircuitSlug,
  metricsOf,
  MAX_VERSION_ATTEMPTS,
  toCircuitJson,
  VersionConflictError,
} from '@qsim/db'
import type {
  CircuitCard,
  CircuitDetail,
  CircuitRepository,
  CircuitVersionSummary,
  CircuitWithVersion,
  Page,
  Prisma,
  Visibility,
  StoredVersion,
  User,
  UserStore,
} from '@qsim/db'
import { emptyCircuit } from '@qsim/schema'
import type { Circuit } from '@qsim/schema'

interface CircuitRow {
  id: string
  ownerId: string
  title: string
  description: string | null
  visibility: Visibility
  slug: string
  qubitCount: number
  gateCount: number
  depth: number
  forkedFromId: string | null
  starCount: number
  viewCount: number
  createdAt: Date
  updatedAt: Date
}

interface VersionRow {
  id: string
  circuitId: string
  versionNum: number
  data: Circuit
  message: string | null
  createdAt: Date
}

export interface MemoryRepositoryOptions {
  /**
   * Called after a save has read the highest existing version number and
   * before it writes the next one — the window in which a second writer can
   * claim the same number. A test that fires another save from inside this
   * hook reproduces the race the unique index exists to lose.
   */
  readonly beforeVersionWrite?: (circuitId: string) => Promise<void> | void
}

export interface MemoryCircuitRepository extends CircuitRepository {
  /** Every version row, for assertions the HTTP surface cannot make. */
  allVersions(circuitId?: string): readonly VersionRow[]
  allCircuits(): readonly CircuitRow[]
  /**
   * Writes the next version number directly, the way a second process would.
   * Called from `beforeVersionWrite` it makes a save lose the race on
   * purpose, which is the only way to reach the retry path — and, when it is
   * called on every attempt, the 409 the retries eventually give up with.
   */
  stealNextVersion(circuitId: string): number
}

/**
 * Evaluates one of `visibility.ts`'s `where` fragments against a row.
 *
 * Deliberately total for the shapes those helpers produce and hostile to
 * everything else: an unrecognised key throws, because the alternative —
 * ignoring it — turns a filter that got stricter in production into a filter
 * these tests believe is still permissive.
 */
function matchesFilter(
  row: CircuitRow,
  filter: Prisma.CircuitWhereInput
): boolean {
  const entries = Object.entries(filter)
  return entries.every(([key, value]) => {
    if (key === 'OR') {
      return (value as Prisma.CircuitWhereInput[]).some((branch) =>
        matchesFilter(row, branch)
      )
    }
    if (key === 'AND') {
      return (value as Prisma.CircuitWhereInput[]).every((branch) =>
        matchesFilter(row, branch)
      )
    }
    if (key === 'visibility') return row.visibility === value
    if (key === 'ownerId') return row.ownerId === value
    if (key === 'slug') return row.slug === value
    if (key === 'id') return row.id === value
    throw new Error(
      `The in-memory repository cannot evaluate the filter key "${key}". ` +
        'Teach it, rather than letting a test pass on a rule it ignored.'
    )
  })
}

export function createMemoryCircuitRepository(
  options: MemoryRepositoryOptions = {}
): MemoryCircuitRepository {
  const users = new Map<string, User>()
  const circuits: CircuitRow[] = []
  const versions: VersionRow[] = []
  let sequence = 0

  /** Ids long enough to satisfy the route's handle pattern, as a cuid is. */
  const nextId = (prefix: string): string => {
    sequence += 1
    return `${prefix}${String(sequence).padStart(9, '0')}`
  }

  const userStore: UserStore = {
    user: {
      findUnique: ({ where }) => Promise.resolve(users.get(where.id) ?? null),
      create: ({ data }) => {
        for (const existing of users.values()) {
          if (existing.username === data.username) {
            throw Object.assign(new Error('Unique constraint failed'), {
              code: 'P2002',
              meta: { target: ['username'] },
            })
          }
          if (existing.email === data.email) {
            throw Object.assign(new Error('Unique constraint failed'), {
              code: 'P2002',
              meta: { target: ['email'] },
            })
          }
        }
        const row: User = { ...data, createdAt: new Date() }
        users.set(row.id, row)
        return Promise.resolve(row)
      },
    },
  }

  function ownerRef(ownerId: string): CircuitCard['owner'] {
    const user = users.get(ownerId)
    return {
      id: ownerId,
      username: user?.username ?? 'unknown',
      avatarUrl: user?.avatarUrl ?? null,
    }
  }

  function toCard(row: CircuitRow): CircuitCard {
    return {
      id: row.id,
      slug: row.slug,
      title: row.title,
      visibility: row.visibility,
      qubitCount: row.qubitCount,
      gateCount: row.gateCount,
      depth: row.depth,
      starCount: row.starCount,
      viewCount: row.viewCount,
      forkedFromId: row.forkedFromId,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
      owner: ownerRef(row.ownerId),
    }
  }

  function toDetail(row: CircuitRow): CircuitDetail {
    return {
      ...toCard(row),
      ownerId: row.ownerId,
      description: row.description,
    }
  }

  function toStored(row: VersionRow): StoredVersion {
    return {
      id: row.id,
      versionNum: row.versionNum,
      message: row.message,
      createdAt: row.createdAt,
      data: row.data,
    }
  }

  function toSummary(row: VersionRow): CircuitVersionSummary {
    return {
      id: row.id,
      versionNum: row.versionNum,
      message: row.message,
      createdAt: row.createdAt,
    }
  }

  function highestVersion(circuitId: string): number {
    let highest = 0
    for (const version of versions) {
      if (version.circuitId === circuitId && version.versionNum > highest) {
        highest = version.versionNum
      }
    }
    return highest
  }

  function paginate<T>(
    rows: readonly T[],
    skip: number,
    take: number
  ): Page<T> {
    return { items: rows.slice(skip, skip + take), total: rows.length }
  }

  return {
    ensureOwner: (identity) => ensureUser(userStore, identity),

    listOwned({ ownerId, skip, take }) {
      const mine = circuits
        .filter((row) => row.ownerId === ownerId)
        .sort((a, b) => b.updatedAt.getTime() - a.updatedAt.getTime())
        .map(toCard)
      return Promise.resolve(paginate(mine, skip, take))
    },

    findReadable(handle, viewerId) {
      /*
       * The production `where` in full, evaluated rather than reimplemented —
       * including the part that matters most, that a slug and an id are not
       * addressed under the same rule. Reimplementing "find by id or slug,
       * then check" would have hidden exactly that distinction.
       */
      const filter = circuitHandleFilter(handle, viewerId)
      const row = circuits.find((candidate) => matchesFilter(candidate, filter))
      return Promise.resolve(row === undefined ? null : toDetail(row))
    },

    create(input): Promise<CircuitWithVersion> {
      // The same call the Prisma implementation makes, so the storage size
      // cap is enforced on this path too.
      toCircuitJson(input.data)
      const metrics = metricsOf(input.data)

      let slug = generateCircuitSlug()
      while (circuits.some((row) => row.slug === slug)) {
        slug = generateCircuitSlug()
      }

      const now = new Date()
      const circuit: CircuitRow = {
        id: nextId('cir_'),
        ownerId: input.ownerId,
        title: input.title,
        description: input.description,
        visibility: input.visibility,
        slug,
        forkedFromId: input.forkedFromId,
        starCount: 0,
        viewCount: 0,
        createdAt: now,
        updatedAt: now,
        ...metrics,
      }
      circuits.push(circuit)

      const version: VersionRow = {
        id: nextId('ver_'),
        circuitId: circuit.id,
        versionNum: 1,
        data: input.data,
        message: input.message,
        createdAt: now,
      }
      versions.push(version)

      return Promise.resolve({
        circuit: toDetail(circuit),
        version: toStored(version),
      })
    },

    update({ id, ownerId, ...changes }) {
      const row = circuits.find(
        (candidate) => candidate.id === id && candidate.ownerId === ownerId
      )
      if (row === undefined) return Promise.resolve(null)
      if (changes.title !== undefined) row.title = changes.title
      if (changes.description !== undefined) {
        row.description = changes.description
      }
      if (changes.visibility !== undefined) row.visibility = changes.visibility
      row.updatedAt = new Date()
      return Promise.resolve(toDetail(row))
    },

    remove({ id, ownerId }) {
      const index = circuits.findIndex(
        (candidate) => candidate.id === id && candidate.ownerId === ownerId
      )
      if (index === -1) return Promise.resolve(false)
      circuits.splice(index, 1)
      // `onDelete: Cascade` on CircuitVersion.circuitId.
      for (let i = versions.length - 1; i >= 0; i -= 1) {
        if (versions[i]?.circuitId === id) versions.splice(i, 1)
      }
      return Promise.resolve(true)
    },

    async appendVersion({ circuitId, ownerId, data, message }) {
      toCircuitJson(data)
      const metrics = metricsOf(data)

      for (let attempt = 1; attempt <= MAX_VERSION_ATTEMPTS; attempt += 1) {
        const versionNum = highestVersion(circuitId) + 1

        // The window a concurrent writer slips into. Everything above is the
        // read; everything below is the write.
        await options.beforeVersionWrite?.(circuitId)

        const taken = versions.some(
          (row) => row.circuitId === circuitId && row.versionNum === versionNum
        )
        // What `@@unique([circuitId, versionNum])` would have said.
        if (taken) continue

        /*
         * What `CircuitVersion_circuitId_fkey` and the owner-scoped update
         * would have said, in that order and before anything is written. The
         * Prisma implementation writes the version first and lets the
         * transaction roll it back; here there is no transaction, so the
         * check comes first and the observable outcome is the same — a
         * refused append leaves no row behind.
         */
        const circuit = circuits.find((candidate) => candidate.id === circuitId)
        if (circuit === undefined || circuit.ownerId !== ownerId) {
          throw new CircuitNotWritableError(circuitId)
        }

        const row: VersionRow = {
          id: nextId('ver_'),
          circuitId,
          versionNum,
          data,
          message,
          createdAt: new Date(),
        }
        versions.push(row)

        Object.assign(circuit, metrics, { updatedAt: new Date() })
        return toStored(row)
      }
      throw new VersionConflictError(circuitId, MAX_VERSION_ATTEMPTS)
    },

    listVersions({ circuitId, skip, take }) {
      const rows = versions
        .filter((row) => row.circuitId === circuitId)
        .sort((a, b) => b.versionNum - a.versionNum)
        .map(toSummary)
      return Promise.resolve(paginate(rows, skip, take))
    },

    findVersion({ circuitId, versionNum }) {
      const row = versions.find(
        (candidate) =>
          candidate.circuitId === circuitId &&
          candidate.versionNum === versionNum
      )
      return Promise.resolve(row === undefined ? null : toStored(row))
    },

    latestVersion(circuitId) {
      const rows = versions
        .filter((row) => row.circuitId === circuitId)
        .sort((a, b) => b.versionNum - a.versionNum)
      const row = rows[0]
      return Promise.resolve(row === undefined ? null : toStored(row))
    },

    allVersions(circuitId) {
      return circuitId === undefined
        ? [...versions]
        : versions.filter((row) => row.circuitId === circuitId)
    },

    allCircuits: () => [...circuits],

    stealNextVersion(circuitId) {
      const versionNum = highestVersion(circuitId) + 1
      versions.push({
        id: nextId('ver_'),
        circuitId,
        versionNum,
        data: emptyCircuit(1),
        message: 'written by somebody else',
        createdAt: new Date(),
      })
      return versionNum
    },
  }
}
