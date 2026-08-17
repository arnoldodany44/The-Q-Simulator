import {
  depth as circuitDepth,
  gateCount as circuitGateCount,
  type Circuit,
} from '@qsim/schema'
import {
  parseStoredCircuit,
  toCircuitJson,
  toPreviewJson,
} from './circuit-data.js'
import { prismaAccountRepository, type AccountRepository } from './accounts.js'
import {
  prismaChallengeRepository,
  type ChallengeRepository,
} from './challenges.js'
import { prismaLessonRepository, type LessonRepository } from './lessons.js'
import {
  prismaCollectionRepository,
  type CollectionRepository,
} from './collections.js'
import { prismaCommentRepository, type CommentRepository } from './comments.js'
import {
  cursorAfter,
  galleryOrderBy,
  galleryWhere,
  type GalleryQuery,
} from './gallery.js'
import type { CursorPage, Page } from './pagination.js'
import { Visibility } from './generated/prisma/client.js'
import type { Prisma, PrismaClient } from './generated/prisma/client.js'
import {
  circuitCardSelect,
  circuitDetailSelect,
  circuitVersionSummarySelect,
  publicUserSelect,
  toCircuitCard,
  toCircuitDetail,
} from './projections.js'
import type {
  CircuitCard,
  CircuitDetail,
  CircuitVersionSummary,
  PublicUser,
} from './projections.js'
import { violatedConstraintMentions } from './prisma-errors.js'
import { generateCircuitSlug } from './slugs.js'
import {
  attachCircuitTags,
  MAX_TAGS_PER_CIRCUIT,
  readCircuitTagNames,
  setCircuitTags,
} from './tags.js'
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
 *
 * `preview` joined them in M1.5b and is derived by the same rule at the same
 * two statements, which is the point: `create` and `appendVersion` are the
 * only places in the system where a document becomes a row, so anything
 * derived from a document is derived exactly here or it is derived somewhere
 * that can be forgotten. A client that could send its own thumbnail could
 * draw a circuit other than the one it published.
 */

/*
 * The page shapes moved to `pagination.ts` when M1.9 gave collections their
 * own listings; they are re-exported here so nothing that already imported
 * them from this module has to change.
 */
export type { CursorPage, Page } from './pagination.js'

/** What a star endpoint answers with: the new state, for this viewer. */
export interface StarState {
  readonly starred: boolean
  readonly starCount: number
}

/** A version with its payload already through `parseCircuit`. */
export interface StoredVersion {
  readonly id: string
  readonly versionNum: number
  readonly message: string | null
  readonly createdAt: Date
  readonly data: Circuit
}

/**
 * The live CRDT document of a collaborative session, as stored.
 *
 * `state` is a Yjs update and nothing here knows what is in it — see the column
 * comment in the schema. `updatedAt` is not used to decide anything (the
 * session row and the version history are kept in order by `appendVersion`
 * clearing this row, not by comparing two clocks); it is carried because a relay
 * that resumes an hour-old document should be able to say so in a log line.
 */
export interface StoredSession {
  readonly state: Uint8Array
  readonly updatedAt: Date
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
  /**
   * Already normalised by `normalizeTagNames`. The canonical spelling is what
   * makes `Tag.name @unique` a facet rather than a collection of near
   * duplicates, so this is not a place to accept whatever a caller typed.
   */
  readonly tags?: readonly string[]
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
  /**
   * Replaces the whole set when present, and leaves it alone when absent —
   * `[]` therefore means "remove every tag", which is a thing a person can
   * ask for and `undefined` is not.
   */
  readonly tags?: readonly string[]
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

/**
 * Everything `apps/api` persists, behind one interface.
 *
 * It grew two more faces in M1.9 — collections and the account itself — and
 * they are `extends` rather than new members for a deliberate reason: the API
 * decorates exactly one repository onto the instance, and the route tests
 * inject exactly one double. A second seam would mean a second in-memory
 * implementation, and the value of the first one is that it evaluates the very
 * `where` fragments production passes to Postgres. Two doubles is two places
 * for a visibility rule to be modelled slightly differently, which is the one
 * thing a double must never do.
 *
 * The pieces are written in their own modules — `collections.ts`,
 * `accounts.ts` — and composed here.
 */
export interface CircuitRepository
  extends
    CollectionRepository,
    CommentRepository,
    AccountRepository,
    LessonRepository,
    ChallengeRepository {
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
   * The gallery, and the profile listing that is the same query scoped to one
   * author (§8). Both go through `galleryWhere`, which starts from
   * `listableCircuitFilter` and can only narrow — there is no variant of this
   * that takes a `where`, because a route that could pass one is a route that
   * could pass the wrong one.
   *
   * `take` is the page size; one extra row is read internally to decide
   * whether a next cursor exists.
   */
  listPublished(
    input: GalleryQuery & { take: number }
  ): Promise<CursorPage<CircuitCard>>

  /**
   * A user by their public handle, for `/users/:username/circuits`. The
   * projection is `publicUserSelect`, so `email` cannot come back.
   */
  findUserByUsername(username: string): Promise<PublicUser | null>

  /**
   * How many of this author's circuits this viewer may list — the number a
   * profile page shows beside their name (M1.9).
   *
   * It goes through `galleryWhere` like the listing itself, and that is the
   * whole reason it is a repository method rather than a `count` somebody
   * writes in a route: an aggregate is a listing. A count assembled from its
   * own `where` would answer "how many circuits does this person have",
   * including the private ones, in a single integer that looks far too small
   * to be a leak.
   */
  countPublished(query: GalleryQuery): Promise<number>

  /**
   * Stars a circuit, idempotently: a second call by the same user is not a
   * second star and does not move the count.
   *
   * The caller must already have established that this viewer may *read* the
   * circuit — pass an id that came back from `findReadable`.
   */
  star(input: { userId: string; circuitId: string }): Promise<StarState>

  /** Removes a star, idempotently. Unstarring twice is not a negative count. */
  unstar(input: { userId: string; circuitId: string }): Promise<StarState>

  /** Whether this viewer has already starred this circuit. */
  hasStarred(input: { userId: string; circuitId: string }): Promise<boolean>

  /**
   * Which of these circuits this viewer has starred — the listing's version of
   * `hasStarred` (M1.5b).
   *
   * Called with the ids a listing has *already returned*, which is what makes
   * it safe to answer without a visibility filter of its own: every id in the
   * question came back through `galleryWhere`, and the answer is scoped to the
   * caller's own `Star` rows. It cannot report a star on a circuit the viewer
   * may not see, because such a circuit is never in the question.
   *
   * One indexed read over the composite primary key `(userId, circuitId)`,
   * rather than one lookup per card. `apps/api` skips it entirely for an
   * anonymous caller, who has no stars to have.
   */
  starredAmong(input: {
    userId: string
    circuitIds: readonly string[]
  }): Promise<string[]>

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

  /**
   * The live CRDT document of a collaborative session, or `null` when there is
   * none — §3.4, M5.2. See `CircuitSession` in the schema for what this row is
   * and why it is not a version.
   *
   * Deliberately unscoped by viewer, and that is not an omission: this is
   * reached only by the relay, which has already decided that the caller may
   * read the circuit (`findReadable`) and, for a writer, that they may edit it
   * (`canEditCircuit`). A visibility filter here would be a *second* place the
   * rule lives, and two copies of an authorisation rule is how they come to
   * disagree. Never call it with a circuit id that has not been through one of
   * those two.
   */
  loadSession(circuitId: string): Promise<StoredSession | null>

  /**
   * Writes the live document, creating the row or replacing it.
   *
   * An upsert rather than an update, because the first write of a session is
   * the one that creates it, and because two replicas may reach this for one
   * circuit — the row is a checkpoint of a document both of them converge on, so
   * the later write is the better one and there is nothing to merge here.
   *
   * @throws when the circuit no longer exists, which is the foreign key doing
   * its job: a document must not outlive the circuit it describes.
   */
  saveSession(input: { circuitId: string; state: Uint8Array }): Promise<void>

  /**
   * Forgets the live document. `false` when there was none.
   *
   * The relay calls it when it decides a document is not one to keep — a state
   * past `MAX_COLLAB_STATE_BYTES`, or a row it could not read back as a circuit.
   * A save clears it too, but that happens inside `appendVersion` rather than
   * here, because it has to be in the same transaction as the version.
   */
  dropSession(circuitId: string): Promise<boolean>
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

/**
 * Raised when a circuit that was readable a statement ago is not there any
 * more — the owner deleted it while somebody was starring it.
 *
 * Its own class rather than a bare `null` return because the caller has
 * nothing sensible to do with "starred a circuit that does not exist": the
 * API maps it to 404, which is what the very next request would answer.
 */
export class CircuitGoneError extends Error {
  readonly code = 'CIRCUIT_GONE'

  constructor(readonly circuitId: string) {
    super(`Circuit ${circuitId} no longer exists`)
    this.name = 'CircuitGoneError'
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

/**
 * The circuit's current star count, or a refusal if it is gone.
 *
 * Read inside the star transaction rather than trusted from the caller's
 * earlier `findReadable`: the owner may have deleted the circuit in between,
 * and answering with a count for a row that no longer exists would be a lie
 * the client caches.
 */
async function readStarCount(
  tx: Prisma.TransactionClient,
  circuitId: string
): Promise<number> {
  const row = await tx.circuit.findUnique({
    where: { id: circuitId },
    select: { starCount: true },
  })
  if (row === null) throw new CircuitGoneError(circuitId)
  return row.starCount
}

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
    const preview = toPreviewJson(input.data)

    const tags = input.tags ?? []

    for (let attempt = 1; attempt <= MAX_SLUG_ATTEMPTS; attempt += 1) {
      try {
        return await prisma.$transaction(async (tx) => {
          const row = await tx.circuit.create({
            data: {
              ownerId: input.ownerId,
              title: input.title,
              description: input.description,
              visibility: input.visibility,
              slug: generateCircuitSlug(),
              forkedFromId: input.forkedFromId,
              preview,
              ...metrics,
            },
            select: circuitDetailSelect,
          })
          const version = await tx.circuitVersion.create({
            data: {
              circuitId: row.id,
              versionNum: 1,
              data: json,
              message: input.message,
            },
            select: versionRowSelect,
          })
          /*
           * In the same transaction as the circuit, so a tag can never point
           * at a circuit that was not created — and so a failure to tag takes
           * the circuit with it rather than leaving a half-filed row.
           */
          await attachCircuitTags(tx, row.id, tags)
          const circuit: CircuitDetail = {
            ...toCircuitDetail(row),
            tags: await readCircuitTagNames(tx, row.id),
          }
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
    /*
     * Composed rather than reimplemented. Collections and the account itself
     * are their own modules with their own arguments written down; this file
     * stays about circuits.
     */
    ...prismaCollectionRepository(prisma),
    ...prismaCommentRepository(prisma),
    ...prismaAccountRepository(prisma),
    ...prismaLessonRepository(prisma),
    ...prismaChallengeRepository(prisma),

    ensureOwner: (identity) => ensureUser(prisma, identity),

    async listOwned({ ownerId, skip, take }) {
      const [rows, total] = await prisma.$transaction([
        prisma.circuit.findMany({
          where: { ownerId },
          orderBy: { updatedAt: 'desc' },
          skip,
          take,
          select: circuitCardSelect,
        }),
        prisma.circuit.count({ where: { ownerId } }),
      ])
      return { items: rows.map(toCircuitCard), total }
    },

    async listPublished({ take, ...query }) {
      /*
       * One row more than asked for, which is how "is there a next page"
       * is answered without a second query — and without a COUNT over a
       * filtered, searched table on every request.
       */
      const rows = await prisma.circuit.findMany({
        where: galleryWhere(query),
        orderBy: galleryOrderBy(query.sort),
        take: take + 1,
        select: circuitCardSelect,
      })

      const items = rows.slice(0, take).map(toCircuitCard)
      const last = items.at(-1)
      const nextCursor =
        rows.length > take && last !== undefined
          ? cursorAfter(last, query.sort)
          : null
      return { items, nextCursor }
    },

    countPublished(query) {
      // The same `where` the listing uses, and no other. See the note on the
      // interface: an aggregate is a listing.
      return prisma.circuit.count({ where: galleryWhere(query) })
    },

    findUserByUsername(username) {
      return prisma.user.findUnique({
        where: { username },
        select: publicUserSelect,
      })
    },

    async findReadable(handle, viewerId) {
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
      const row = await prisma.circuit.findFirst({
        where: circuitHandleFilter(handle, viewerId),
        select: circuitDetailSelect,
      })
      return row === null ? null : toCircuitDetail(row)
    },

    create: insertCircuit,

    async update({ id, ownerId, tags, ...changes }) {
      return prisma.$transaction(async (tx) => {
        const { count } = await tx.circuit.updateMany({
          where: { id, ownerId },
          data: changes,
        })
        if (count === 0) return null
        // `undefined` leaves the tags alone; `[]` clears them. Both are
        // things a PATCH can mean and they are not the same request.
        if (tags !== undefined) await setCircuitTags(tx, id, tags)

        const row = await tx.circuit.findUnique({
          where: { id },
          select: circuitDetailSelect,
        })
        return row === null ? null : toCircuitDetail(row)
      }, TRANSACTION_OPTIONS)
    },

    async remove({ id, ownerId }) {
      return prisma.$transaction(async (tx) => {
        const { count } = await tx.circuit.deleteMany({
          where: { id, ownerId },
        })
        if (count === 0) return false

        /*
         * `CollectionItem.circuitId` carries no foreign key (§7), so nothing
         * in Postgres removes the memberships of a circuit that has just been
         * deleted — including the ones in *other people's* collections, which
         * is why this is not scoped to the owner. Left behind, each one is a
         * row naming a circuit that no longer exists, and
         * `readCollectionItems` would count it as withheld forever: a
         * permanent "there is something here you are not allowed to see"
         * about nothing at all.
         *
         * In the same transaction as the delete, so the two cannot disagree.
         */
        await tx.collectionItem.deleteMany({ where: { circuitId: id } })
        return true
      }, TRANSACTION_OPTIONS)
    },

    /*
     * ── Stars, and why there is no read-modify-write here ─────────────────
     *
     * `Circuit.starCount` is denormalised (§7) so the gallery can sort
     * without joining `Star`, which means there are two facts that must agree
     * and no database constraint that makes them. The obvious implementation
     * — "is it starred? no? then insert and set count = count + 1" — has a
     * window between the question and the answer, and two clicks that land in
     * that window produce one star row and two increments. The count is then
     * permanently wrong and nothing ever notices.
     *
     * So the row decides, not the reader. `createMany({ skipDuplicates })` is
     * `INSERT … ON CONFLICT DO NOTHING` against the composite primary key
     * `(userId, circuitId)`: exactly one of two concurrent inserts reports a
     * row, and the increment is conditional on *that* report rather than on
     * anything read earlier. The increment itself is `SET starCount =
     * starCount + 1`, computed by Postgres under the row lock, so it cannot
     * lose an update either. Both statements share one transaction, so a
     * crash between them cannot leave a star with no count or the reverse.
     */
    star({ userId, circuitId }) {
      return prisma.$transaction(async (tx) => {
        const { count } = await tx.star.createMany({
          data: [{ userId, circuitId }],
          skipDuplicates: true,
        })
        // Already starred. Idempotent: the answer is the current state, and
        // the count is untouched.
        if (count === 0) {
          return {
            starred: true,
            starCount: await readStarCount(tx, circuitId),
          }
        }

        const circuit = await tx.circuit.update({
          where: { id: circuitId },
          data: { starCount: { increment: 1 } },
          select: { starCount: true },
        })
        return { starred: true, starCount: circuit.starCount }
      }, TRANSACTION_OPTIONS)
    },

    unstar({ userId, circuitId }) {
      return prisma.$transaction(async (tx) => {
        const { count } = await tx.star.deleteMany({
          where: { userId, circuitId },
        })
        if (count > 0) {
          /*
           * `updateMany` with `starCount > 0` rather than `update`, so the
           * counter has a floor it cannot go under. It should never need one
           * — but `Star` rows cascade away when a `User` is deleted, and that
           * delete does not decrement anything, so a future account deletion
           * leaves counts that are too high. Too high is a cosmetic error;
           * negative is a number no interface knows how to draw.
           */
          await tx.circuit.updateMany({
            where: { id: circuitId, starCount: { gt: 0 } },
            data: { starCount: { decrement: 1 } },
          })
        }

        return {
          starred: false,
          starCount: await readStarCount(tx, circuitId),
        }
      }, TRANSACTION_OPTIONS)
    },

    async hasStarred({ userId, circuitId }) {
      const row = await prisma.star.findUnique({
        where: { userId_circuitId: { userId, circuitId } },
        select: { userId: true },
      })
      return row !== null
    },

    async starredAmong({ userId, circuitIds }) {
      // `IN ()` is not valid SQL and Prisma would send it; an empty page has
      // no stars to report anyway, so the round trip is skipped rather than
      // guarded downstream.
      if (circuitIds.length === 0) return []
      const rows = await prisma.star.findMany({
        where: { userId, circuitId: { in: [...circuitIds] } },
        select: { circuitId: true },
      })
      return rows.map((row) => row.circuitId)
    },

    async appendVersion({ circuitId, ownerId, data, message }) {
      const json = toCircuitJson(data)
      const metrics = metricsOf(data)
      const preview = toPreviewJson(data)

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
              // The thumbnail moves with the counters, in the same statement:
              // a card showing yesterday's diagram beside today's gate count
              // is two claims about one circuit that cannot both be true.
              data: { ...metrics, preview },
            })
            if (count === 0) throw new CircuitNotWritableError(circuitId)
            /*
             * A save supersedes the live document — see `CircuitSession` in the
             * schema. In the same transaction, so the two stores can never both
             * claim to be the newer one: the version that was just written *is*
             * what the document said, and the case this exists for is restore,
             * where the version written is deliberately *older* than the
             * document and a surviving row would silently undo it.
             *
             * `deleteMany` and not `delete`: almost every save has no live
             * document behind it, and `delete` would raise P2025 on the
             * ordinary path.
             */
            await tx.circuitSession.deleteMany({ where: { circuitId } })
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

    async loadSession(circuitId) {
      const row = await prisma.circuitSession.findUnique({
        where: { circuitId },
        select: { state: true, updatedAt: true },
      })
      if (row === null) return null
      /*
       * Copied rather than handed straight over. The driver returns a view onto
       * a buffer it owns — a Node `Buffer` from a shared pool, in the pg
       * adapter's case — and a Yjs decoder reads through `byteOffset` and
       * `byteLength`. A copy is a few hundred kilobytes once per session and
       * removes the whole class of bug where a document is decoded from memory
       * something else has since written to.
       */
      return {
        state: Uint8Array.from(row.state),
        updatedAt: row.updatedAt,
      }
    },

    async saveSession({ circuitId, state }) {
      // Copied on the way in for the mirror-image reason: this is a parameter
      // the driver will read asynchronously, and the caller's document keeps
      // changing while it does.
      const bytes = Uint8Array.from(state)
      await prisma.circuitSession.upsert({
        where: { circuitId },
        create: { circuitId, state: bytes },
        update: { state: bytes },
      })
    },

    async dropSession(circuitId) {
      const { count } = await prisma.circuitSession.deleteMany({
        where: { circuitId },
      })
      return count > 0
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
 *
 * The tags come across with it (M1.5). They describe what the circuit *is* —
 * `grover`, `teleportation` — and a fork is the same circuit until its new
 * owner changes it, so dropping them would file every fork under nothing.
 * They are already canonical, having been normalised when the source was
 * written, and they cost nothing to carry: the copy is PRIVATE, so it appears
 * in no tag facet until its owner publishes it.
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
    /*
     * Bounded here as well as in `attachCircuitTags`, and the two are not the
     * same guard. This one is a *copy* of somebody else's row, so it is the
     * one path where the number of tags is not something the caller chose and
     * no request schema has bounded: a source row that somehow carries more
     * than the cap would otherwise make every fork of it a 500. The write path
     * refuses, this path declines to ask — and the source is the authority on
     * its own first `MAX_TAGS_PER_CIRCUIT` tags, which is what a card shows.
     */
    tags: input.source.tags.slice(0, MAX_TAGS_PER_CIRCUIT),
  })
}
