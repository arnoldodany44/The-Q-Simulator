import {
  depth as circuitDepth,
  gateCount as circuitGateCount,
  type Circuit,
} from '@qsim/schema'
import { parseStoredCircuit, toCircuitJson } from './circuit-data.js'
import { Visibility } from './generated/prisma/client.js'
import type { Prisma, PrismaClient } from './generated/prisma/client.js'
import {
  circuitCardSelect,
  circuitDetailSelect,
  circuitVersionSummarySelect,
} from './projections.js'
import type {
  CircuitCard,
  CircuitDetail,
  CircuitVersionSummary,
} from './projections.js'
import { violatedConstraintMentions } from './prisma-errors.js'
import { generateCircuitSlug } from './slugs.js'
import { ensureUser } from './users.js'
import type { SupabaseIdentity } from './users.js'
import { circuitHandleFilter } from './visibility.js'
import type { ViewerId } from './visibility.js'

/**
 * Circuit persistence — specification §7 and §8, milestone M1.4.
 *
 * ── Why this is an interface and not just Prisma calls ────────────────────
 *
 * Two reasons, and neither is "for mocking".
 *
 * The first is that `apps/api` must be testable with no database in reach.
 * CI runs on every push and this project has exactly one Postgres — the
 * owner's, shared between development and production. A suite that needs it
 * would either be skipped in CI (so it guards nothing) or would write to the
 * live database on every pull request. With an interface, the whole HTTP
 * surface — routing, token verification, the §11 visibility rules, Zod
 * validation, error shapes — is exercised against an in-memory implementation
 * that models the same constraints, and the Prisma implementation is
 * exercised separately, on purpose, against the real thing.
 *
 * The second is that the visibility rules belong *inside* the query. Prisma
 * connects as the `postgres` role and bypasses row-level security entirely,
 * so "PRIVATE is verified on the server" is only true if every read composes
 * the filter. `findReadable` is the single door, it takes a `ViewerId`, and
 * it has no variant that skips the check — a route cannot forget what it was
 * never offered.
 *
 * ── What is derived and what is accepted ──────────────────────────────────
 *
 * `qubitCount`, `gateCount` and `depth` are computed here from the circuit
 * with @qsim/schema's helpers, on every write, and are never read from a
 * request. They are denormalised onto `Circuit` so the gallery can sort
 * without a join (§7), which means a client that could set them would be a
 * client that could rank itself first — in the gallery today and on a
 * challenge leaderboard in Phase 3.
 */

/** A page of rows plus the total, which is what a pager needs to render. */
export interface Page<T> {
  readonly items: readonly T[]
  readonly total: number
}

/** A version with its payload already through `parseCircuit`. */
export interface StoredVersion {
  readonly id: string
  readonly versionNum: number
  readonly message: string | null
  readonly createdAt: Date
  readonly data: Circuit
}

/** A newly created circuit and the version that was created with it. */
export interface CircuitWithVersion {
  readonly circuit: CircuitDetail
  readonly version: StoredVersion
}

/** The denormalised counters, derived from the circuit and nothing else. */
export interface CircuitMetrics {
  readonly qubitCount: number
  readonly gateCount: number
  readonly depth: number
}

export interface CreateCircuitInput {
  readonly ownerId: string
  readonly title: string
  readonly description: string | null
  readonly visibility: Visibility
  readonly data: Circuit
  readonly message: string | null
  /** Set by a fork, for attribution. Never accepted from a request body. */
  readonly forkedFromId: string | null
}

export interface UpdateCircuitInput {
  readonly id: string
  /**
   * Scopes the write to the owner's own row. The route has already checked
   * ownership; this makes the query itself unable to touch anybody else's
   * circuit, so a future route that forgets the check still cannot.
   */
  readonly ownerId: string
  readonly title?: string
  readonly description?: string | null
  readonly visibility?: Visibility
}

export interface AppendVersionInput {
  readonly circuitId: string
  /**
   * Scopes the write to the owner's own circuit, exactly as `update` and
   * `remove` do.
   *
   * This was the one write on the repository whose signature could not carry
   * the guard, so its safety rested entirely on the route remembering to call
   * `assertOwner` — and its failure mode is the worst of the three: a
   * permanent, immutable row in somebody else's history, which no later
   * request can remove. The route is correct today; a signature that cannot
   * express the rule is how it stops being correct later.
   */
  readonly ownerId: string
  readonly data: Circuit
  readonly message: string | null
}

export interface CircuitRepository {
  /**
   * The `public.User` row for a verified identity, created on first use.
   * Circuits carry a foreign key to it, so this has to happen before the
   * first write — see `users.ts` for why it is here and not in a trigger.
   */
  ensureOwner(identity: SupabaseIdentity): Promise<{ id: string }>

  /** The caller's own circuits, newest first, whatever their visibility. */
  listOwned(input: {
    ownerId: string
    skip: number
    take: number
  }): Promise<Page<CircuitCard>>

  /**
   * One circuit by slug or id, with the §11 filter applied in the query.
   * `null` means "does not exist, or exists and is not yours to see" — the
   * caller must not distinguish the two.
   */
  findReadable(
    handle: string,
    viewerId: ViewerId
  ): Promise<CircuitDetail | null>

  create(input: CreateCircuitInput): Promise<CircuitWithVersion>

  /** `null` when no row matched — which includes "not the owner's". */
  update(input: UpdateCircuitInput): Promise<CircuitDetail | null>

  /** `false` when no row matched. Versions go with it, by cascade. */
  remove(input: { id: string; ownerId: string }): Promise<boolean>

  /**
   * Appends the next version. Never updates one; see the note below.
   *
   * @throws {CircuitNotWritableError} when no circuit with this id belongs to
   * this owner — a delete that landed mid-request, or a route that skipped its
   * ownership check.
   */
  appendVersion(input: AppendVersionInput): Promise<StoredVersion>

  listVersions(input: {
    circuitId: string
    skip: number
    take: number
  }): Promise<Page<CircuitVersionSummary>>

  findVersion(input: {
    circuitId: string
    versionNum: number
  }): Promise<StoredVersion | null>

  /** The version a fork copies and the editor opens. */
  latestVersion(circuitId: string): Promise<StoredVersion | null>
}

/**
 * Counters derived from the circuit itself.
 *
 * `gateCount` is @qsim/schema's, which excludes barriers, resets and
 * measurements — structure, not gates — and counts a custom gate as one.
 * `depth` counts occupied columns and ignores barriers, matching Qiskit.
 * Both definitions live in one place precisely so the number in the database
 * is the number the editor showed.
 */
export function metricsOf(circuit: Circuit): CircuitMetrics {
  return {
    qubitCount: circuit.qubits,
    gateCount: circuitGateCount(circuit),
    depth: circuitDepth(circuit),
  }
}

/**
 * How many times a save may lose the race for a version number before the
 * API gives up and says so.
 *
 * Losing once is ordinary: two tabs saving the same circuit both read the
 * same maximum. Losing this many times in a row means sustained contention on
 * one circuit, and at that point retrying forever is how a request turns into
 * a hung connection instead of an answer the client can act on.
 */
export const MAX_VERSION_ATTEMPTS = 5

/**
 * Longest a retry waits before trying again, in milliseconds.
 *
 * ── Why there is a wait at all ────────────────────────────────────────────
 *
 * Without one the budget is not "five attempts under contention", it is a
 * guarantee of failure at six concurrent saves. Every loser re-enters the
 * same unsynchronised read-max-then-write race at the same instant as every
 * other loser, so each round eliminates exactly one contender and N
 * simultaneous saves produce exactly N − MAX_VERSION_ATTEMPTS rejections —
 * measured, not estimated, against the real database: N=5 gave none, N=6 gave
 * one, N=8 gave two.
 *
 * The lockstep is the whole problem, and jitter is the whole fix. A random
 * wait that grows with the attempt spreads the losers across the window
 * instead of colliding them, so the same five attempts survive concurrency
 * that used to be arithmetic. The upper bound is small on purpose: this is a
 * save, and a person is watching it.
 */
export const VERSION_RETRY_BASE_DELAY_MS = 12
const VERSION_RETRY_MAX_DELAY_MS = 200

/**
 * Backoff for attempt `n` (1-based), full-jittered.
 *
 * Full jitter rather than a fixed step, because a fixed step re-synchronises
 * everything it separated: two writers that collided at t and both wait 12 ms
 * collide again at t+12.
 */
export function versionRetryDelayMs(
  attempt: number,
  random: () => number = Math.random
): number {
  const ceiling = Math.min(
    VERSION_RETRY_MAX_DELAY_MS,
    VERSION_RETRY_BASE_DELAY_MS * 2 ** (attempt - 1)
  )
  return Math.round(random() * ceiling)
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/**
 * Raised when a version is appended to a circuit the caller does not own, or
 * to one that no longer exists.
 *
 * Unreachable through the HTTP surface — `POST /circuits/:id/versions` checks
 * ownership two hooks earlier — which is exactly why it exists: the guard that
 * matters is the one that still holds when the caller forgot.
 */
export class CircuitNotWritableError extends Error {
  readonly code = 'CIRCUIT_NOT_WRITABLE'

  constructor(readonly circuitId: string) {
    super(`Circuit ${circuitId} is not writable by this owner`)
    this.name = 'CircuitNotWritableError'
  }
}

/** How many fresh slugs to try before treating a collision as a real fault. */
export const MAX_SLUG_ATTEMPTS = 5

/**
 * How an interactive transaction is bounded, and why the defaults are wrong
 * for this deployment.
 *
 * `DATABASE_URL` carries `connection_limit=1` because that is the Supabase
 * shared transaction pooler's budget, so every write in this file queues
 * behind every other write in the process on a pool of exactly one. Prisma's
 * default `maxWait` is two seconds — the time a transaction may spend waiting
 * for a connection before it gives up — and a round trip to the pooler is
 * tens of milliseconds, so eight concurrent saves exhaust it and the eighth
 * is rejected with P2028, `Unable to start a transaction in the given time`.
 * That is a 500 produced by ordinary concurrency on rows that do not even
 * contend: eight *different* circuits being created reproduce it.
 *
 * Waiting is the right answer where the alternative is failing, so `maxWait`
 * is raised to something larger than the queue can plausibly take. `timeout`
 * bounds the transaction once it has a connection and stays short: a
 * transaction that is actually running for ten seconds is holding the only
 * connection this process has, and killing it is better than everything
 * behind it waiting on it.
 */
const TRANSACTION_OPTIONS = { maxWait: 15_000, timeout: 10_000 } as const

/**
 * Raised when `MAX_VERSION_ATTEMPTS` saves in a row all lost the race.
 *
 * This is the deliberate answer to "what happens when the unique constraint
 * fires". The constraint is the backstop that makes two version 4s
 * impossible; it is not the design, because a constraint violation reaching a
 * client as a 500 tells them nothing and invites a retry storm. The API maps
 * this to 409 with a code the client can act on: reload the history, rebase,
 * save again.
 */
export class VersionConflictError extends Error {
  readonly code = 'VERSION_CONFLICT'

  constructor(
    readonly circuitId: string,
    readonly attempts: number
  ) {
    super(
      `Could not allocate a version number for circuit ${circuitId} after ` +
        `${String(attempts)} attempts`
    )
    this.name = 'VersionConflictError'
  }
}

/** Raised when several freshly generated slugs were all taken. */
export class SlugUnavailableError extends Error {
  readonly code = 'SLUG_UNAVAILABLE'

  constructor(readonly attempts: number) {
    super(`Could not find a free slug after ${String(attempts)} attempts`)
    this.name = 'SlugUnavailableError'
  }
}

/**
 * Raised when a circuit that was readable a statement ago has no version to
 * read.
 *
 * The name says "cannot happen" and it is half right. A circuit is created
 * with version 1 in the same transaction, and versions are never deleted on
 * their own — so a *persistent* row in this state would indeed mean the data
 * is inconsistent. But there is a second way to reach it, and it is ordinary:
 * the owner deleted the circuit between `findReadable` and `latestVersion`,
 * and the cascade took the versions with it. Nothing is broken; the caller
 * simply lost a race with a delete.
 *
 * Both readings are answered with 404 (see `DOMAIN_ERROR_CODES` in the API),
 * because 404 is what the very next request would say either way, and because
 * a reader who happens to load a PUBLIC circuit at the moment its owner
 * removes it must not be told the server is broken.
 */
export class MissingVersionError extends Error {
  readonly code = 'MISSING_VERSION'

  constructor(readonly circuitId: string) {
    super(`Circuit ${circuitId} has no versions`)
    this.name = 'MissingVersionError'
  }
}

/**
 * A save that lost the race for `versionNum`. Retryable.
 *
 * Which shape the error arrives in is `prisma-errors.ts`'s problem, and it is
 * a real problem: Prisma 7's driver adapter does not populate `meta.target`
 * at all. Getting this predicate wrong does not fail loudly — it just stops
 * the retry, and a lost race becomes a 500.
 */
export function isVersionNumberConflict(error: unknown): boolean {
  return violatedConstraintMentions(error, ['versionNum'])
}

/** A generated slug that was already taken. Retryable with a fresh one. */
export function isSlugConflict(error: unknown): boolean {
  return violatedConstraintMentions(error, ['slug'])
}

/**
 * The `select` for a version's own row. Written out rather than reusing
 * `circuitVersionSummarySelect` because this one also fetches `data`, and the
 * summary exists precisely so a history listing does not.
 */
const versionRowSelect = {
  ...circuitVersionSummarySelect,
  data: true,
} satisfies Prisma.CircuitVersionSelect

type VersionRow = Prisma.CircuitVersionGetPayload<{
  select: typeof versionRowSelect
}>

function toStoredVersion(row: VersionRow): StoredVersion {
  // Every read of `data` goes through `parseCircuit`. A row written months
  // ago by an older build is exactly the payload that must not reach the
  // engine unchecked.
  return { ...row, data: parseStoredCircuit(row.data) }
}

/**
 * The Prisma-backed implementation.
 *
 * ── Version numbers under concurrency ─────────────────────────────────────
 *
 * `versionNum` is per circuit and monotonic, and two simultaneous saves must
 * not both claim 4. There is no sequence to lean on — the numbering restarts
 * at 1 for every circuit — so the number is read and written inside one
 * transaction, and `@@unique([circuitId, versionNum])` decides the race.
 *
 * Under READ COMMITTED, two transactions can still both read a maximum of 3
 * and both try to write 4. Exactly one commits; the other is told P2002 and
 * this loop retries, reading a maximum of 4 the second time and writing 5.
 * That is the design: the constraint is what makes a duplicate impossible,
 * the retry is what keeps the loser from seeing an error it cannot act on,
 * and `VersionConflictError` — a 409, not a 500 — is what a client is told
 * when contention outlasts the retries.
 *
 * The alternative, `SELECT … FOR UPDATE` on the parent row, was not chosen:
 * it serialises every save of a circuit behind a row lock held for the
 * duration of a write that includes a JSON payload, and it buys nothing the
 * constraint does not already guarantee.
 *
 * The counters on `Circuit` are updated in the same transaction, so a
 * version and the metrics describing it can never disagree — and `updatedAt`
 * moves with them, which is what the owner's listing sorts on.
 */
export function prismaCircuitRepository(
  prisma: PrismaClient
): CircuitRepository {
  async function insertCircuit(
    input: CreateCircuitInput
  ): Promise<CircuitWithVersion> {
    // Both throw before any connection is taken: too-large payloads and
    // impossible circuits should never cost a transaction.
    const json = toCircuitJson(input.data)
    const metrics = metricsOf(input.data)

    for (let attempt = 1; attempt <= MAX_SLUG_ATTEMPTS; attempt += 1) {
      try {
        return await prisma.$transaction(async (tx) => {
          const circuit = await tx.circuit.create({
            data: {
              ownerId: input.ownerId,
              title: input.title,
              description: input.description,
              visibility: input.visibility,
              slug: generateCircuitSlug(),
              forkedFromId: input.forkedFromId,
              ...metrics,
            },
            select: circuitDetailSelect,
          })
          const version = await tx.circuitVersion.create({
            data: {
              circuitId: circuit.id,
              versionNum: 1,
              data: json,
              message: input.message,
            },
            select: versionRowSelect,
          })
          return { circuit, version: toStoredVersion(version) }
        }, TRANSACTION_OPTIONS)
      } catch (error) {
        if (isSlugConflict(error)) continue
        throw error
      }
    }
    throw new SlugUnavailableError(MAX_SLUG_ATTEMPTS)
  }

  return {
    ensureOwner: (identity) => ensureUser(prisma, identity),

    async listOwned({ ownerId, skip, take }) {
      const [items, total] = await prisma.$transaction([
        prisma.circuit.findMany({
          where: { ownerId },
          orderBy: { updatedAt: 'desc' },
          skip,
          take,
          select: circuitCardSelect,
        }),
        prisma.circuit.count({ where: { ownerId } }),
      ])
      return { items, total }
    },

    findReadable(handle, viewerId) {
      /*
       * The handle is a slug or the circuit's id, and both are matched here
       * because §8 addresses the same circuit both ways — `GET /circuits/
       * :slug` for the page, `/circuits/:id/versions` for its history. Both
       * are unique indexes, so this is two index probes and no scan.
       *
       * They are *not* matched under the same rule. A slug admits UNLISTED,
       * because a shared link is what UNLISTED is for; an id does not, because
       * an id is not a credential and has been published by this API in the
       * past. `circuitHandleFilter` holds that argument in full.
       */
      return prisma.circuit.findFirst({
        where: circuitHandleFilter(handle, viewerId),
        select: circuitDetailSelect,
      })
    },

    create: insertCircuit,

    async update({ id, ownerId, ...changes }) {
      const { count } = await prisma.circuit.updateMany({
        where: { id, ownerId },
        data: changes,
      })
      if (count === 0) return null
      return prisma.circuit.findUnique({
        where: { id },
        select: circuitDetailSelect,
      })
    },

    async remove({ id, ownerId }) {
      const { count } = await prisma.circuit.deleteMany({
        where: { id, ownerId },
      })
      return count > 0
    },

    async appendVersion({ circuitId, ownerId, data, message }) {
      const json = toCircuitJson(data)
      const metrics = metricsOf(data)

      for (let attempt = 1; attempt <= MAX_VERSION_ATTEMPTS; attempt += 1) {
        try {
          return await prisma.$transaction(async (tx) => {
            const highest = await tx.circuitVersion.findFirst({
              where: { circuitId },
              orderBy: { versionNum: 'desc' },
              select: { versionNum: true },
            })
            const row = await tx.circuitVersion.create({
              data: {
                circuitId,
                versionNum: (highest?.versionNum ?? 0) + 1,
                data: json,
                message,
              },
              select: versionRowSelect,
            })
            /*
             * `updateMany` scoped to {id, ownerId} rather than `update` by id:
             * this is the second guard, the one that holds when a future route
             * forgets `assertOwner`. Zero rows matched means the circuit is
             * gone or is not this owner's, and throwing rolls the version
             * insert above back with it — so a refused append leaves nothing
             * behind, which a two-statement version without a transaction
             * could not promise.
             */
            const { count } = await tx.circuit.updateMany({
              where: { id: circuitId, ownerId },
              data: metrics,
            })
            if (count === 0) throw new CircuitNotWritableError(circuitId)
            return toStoredVersion(row)
          }, TRANSACTION_OPTIONS)
        } catch (error) {
          if (!isVersionNumberConflict(error)) throw error
          // Jittered, so the losers of one round do not all collide again in
          // the next one. See VERSION_RETRY_BASE_DELAY_MS.
          if (attempt < MAX_VERSION_ATTEMPTS) {
            await sleep(versionRetryDelayMs(attempt))
          }
        }
      }
      throw new VersionConflictError(circuitId, MAX_VERSION_ATTEMPTS)
    },

    async listVersions({ circuitId, skip, take }) {
      const [items, total] = await prisma.$transaction([
        prisma.circuitVersion.findMany({
          where: { circuitId },
          orderBy: { versionNum: 'desc' },
          skip,
          take,
          select: circuitVersionSummarySelect,
        }),
        prisma.circuitVersion.count({ where: { circuitId } }),
      ])
      return { items, total }
    },

    async findVersion({ circuitId, versionNum }) {
      const row = await prisma.circuitVersion.findUnique({
        where: { circuitId_versionNum: { circuitId, versionNum } },
        select: versionRowSelect,
      })
      return row === null ? null : toStoredVersion(row)
    },

    async latestVersion(circuitId) {
      const row = await prisma.circuitVersion.findFirst({
        where: { circuitId },
        orderBy: { versionNum: 'desc' },
        select: versionRowSelect,
      })
      return row === null ? null : toStoredVersion(row)
    },
  }
}

/**
 * A fork: the source's current version, copied into a new circuit owned by
 * the caller, with `forkedFromId` set for attribution.
 *
 * It lives beside the repository rather than inside it because the part that
 * can go wrong is not the writing, it is the reading: the caller must be
 * allowed to see the source. That check is the caller's — pass a circuit that
 * came back from `findReadable` for this viewer and nothing else.
 *
 * The copy is PRIVATE regardless of the source's visibility. Forking a public
 * circuit is not publishing one, and the alternative — inheriting PUBLIC —
 * would put an unfinished experiment in the gallery the moment somebody
 * pressed a button labelled "fork".
 */
export async function forkCircuit(
  repository: CircuitRepository,
  input: {
    readonly source: CircuitDetail
    readonly ownerId: string
    readonly title?: string | undefined
    readonly message?: string | null | undefined
  }
): Promise<CircuitWithVersion> {
  const latest = await repository.latestVersion(input.source.id)
  if (latest === null) throw new MissingVersionError(input.source.id)

  return repository.create({
    ownerId: input.ownerId,
    title: input.title ?? input.source.title,
    description: input.source.description,
    visibility: Visibility.PRIVATE,
    data: latest.data,
    message: input.message ?? null,
    forkedFromId: input.source.id,
  })
}
