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
  canResolveThreadFilter,
  circuitHandleFilter,
  CircuitCommentsFullError,
  CircuitGoneError,
  CircuitNotWritableError,
  collectionHandleFilter,
  CollectionFullError,
  deletableCommentFilter,
  CollectionNotWritableError,
  cursorAfter,
  ensureUser,
  galleryOrderBy,
  galleryWhere,
  generateCircuitSlug,
  listableCircuitFilter,
  listableCollectionFilter,
  metricsOf,
  MAX_COLLECTION_ITEMS,
  MAX_REPLIES_PER_THREAD,
  MAX_THREADS_PER_CIRCUIT,
  MAX_VERSION_ATTEMPTS,
  ParentCommentNotFoundError,
  ReplyDepthError,
  ThreadFullError,
  threadFilter,
  toCircuitJson,
  UsernameTakenError,
  VersionConflictError,
} from '@qsim/db'
import type {
  AccountDeletionReport,
  AccountUser,
  AnchorTally,
  CircuitCard,
  CommentThreadPage,
  CircuitDetail,
  CircuitRepository,
  CircuitVersionSummary,
  CircuitWithVersion,
  CollectionCard,
  GallerySort,
  StoredComment,
  StoredThread,
  Page,
  Prisma,
  PublicUser,
  SubmissionRecord,
  Visibility,
  StoredVersion,
  User,
  UserStore,
} from '@qsim/db'
import { emptyCircuit, previewOf } from '@qsim/schema'
import type { Circuit, CircuitPreview } from '@qsim/schema'

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
  /** Canonical names, as `Tag.name` holds them. */
  tags: string[]
  /**
   * The denormalised thumbnail, maintained by the two writes that store a
   * document — exactly as production maintains it (M1.5b). Modelled rather
   * than faked so that a route test can assert a card carries a picture, and
   * so that forgetting to update it on a save fails here too.
   */
  preview: CircuitPreview | null
}

interface StarRow {
  userId: string
  circuitId: string
}

/**
 * `Comment`, with the two things M5.4 added to it: the anchor and the
 * resolution.
 *
 * `anchorOpId` is stored and never interpreted, which is the *point* of it — the
 * double is faithful precisely because it does not go looking for an operation
 * either. Nothing in production reads a circuit document to decide whether an
 * anchor resolves, and a fake that did would be testing a rule that does not
 * exist.
 */
interface CommentRow {
  id: string
  circuitId: string
  userId: string
  body: string
  parentId: string | null
  anchorOpId: string | null
  resolvedAt: Date | null
  resolvedById: string | null
  createdAt: Date
}

/**
 * `LessonProgress`, whose primary key is the pair rather than an id — which is
 * why the fake looks a row up by both columns instead of by a surrogate.
 */
interface LessonProgressRow {
  userId: string
  slug: string
  stepIndex: number
  completed: boolean
  updatedAt: Date
}

/**
 * `Challenge` and `ChallengeSubmission`.
 *
 * The submission row keeps `circuitData` even though no route ever reads it
 * back, and that is deliberate: the property under test is that what was
 * *stored* is what the server computed rather than what the caller claimed, so
 * a test has to be able to look at the row rather than only at the response.
 */
interface ChallengeRow {
  id: string
  slug: string
  title: string
  prompt: string
  difficulty: number
  qubitCount: number
  targetType: string
  targetData: unknown
  allowedGates: string[]
  maxGates: number | null
  fidelityThreshold: number
  orderIndex: number
}

interface ChallengeSubmissionRow {
  /**
   * Present because it is the last key of the ranking, not because any route
   * returns it: two attempts can share a millisecond, and `id` is what decides
   * between them in production (see `rankingOrder` in @qsim/db).
   */
  id: string
  challengeId: string
  userId: string
  circuitData: unknown
  passed: boolean
  fidelity: number
  gateCount: number
  depth: number
  createdAt: Date
}

interface CollectionRow {
  id: string
  ownerId: string
  title: string
  description: string | null
  visibility: Visibility
  createdAt: Date
  updatedAt: Date
}

interface CollectionItemRow {
  collectionId: string
  circuitId: string
  orderIndex: number
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
  /**
   * Called before a star is written, so a test can interleave two requests.
   *
   * The insert itself is synchronous below and stays that way on purpose:
   * `INSERT … ON CONFLICT DO NOTHING` decides uniqueness inside one statement
   * in production, so a double that let two interleaved calls both insert
   * would be modelling a database this project does not have.
   */
  readonly beforeStarWrite?: (circuitId: string) => Promise<void> | void
}

export interface MemoryCircuitRepository extends CircuitRepository {
  /** Every version row, for assertions the HTTP surface cannot make. */
  allVersions(circuitId?: string): readonly VersionRow[]
  allCircuits(): readonly CircuitRow[]
  allStars(circuitId?: string): readonly StarRow[]
  allCollections(): readonly CollectionRow[]
  /**
   * Every membership row. The assertion this exists for is the orphan one:
   * deleting a circuit has to remove its memberships from *other people's*
   * collections, and no foreign key does that (§7), so nothing but a direct
   * look at the join table can tell whether it happened.
   */
  allCollectionItems(collectionId?: string): readonly CollectionItemRow[]
  /**
   * Every comment row (M5.4).
   *
   * The assertions this exists for are the ones the HTTP surface cannot make:
   * that a deleted root took its replies with it (the new `ON DELETE CASCADE`),
   * and that a reply was stored carrying its root's anchor rather than one the
   * caller supplied.
   */
  allComments(circuitId?: string): readonly CommentRow[]
  /**
   * Writes the next version number directly, the way a second process would.
   * Called from `beforeVersionWrite` it makes a save lose the race on
   * purpose, which is the only way to reach the retry path — and, when it is
   * called on every attempt, the 409 the retries eventually give up with.
   */
  stealNextVersion(circuitId: string): number
  /**
   * Every submission row, in the order they were written.
   *
   * This is what the "a client that lies gains nothing" test asserts against.
   * The response body would do for most of it, but not for all: only the row
   * shows what the leaderboard will later rank, and the whole claim is about
   * what was *stored*.
   */
  allChallengeSubmissions(
    challengeId?: string
  ): readonly ChallengeSubmissionRow[]
  /** Registers a user row without a circuit, for profile-page tests. */
  addUser(user: {
    id: string
    username: string
    displayName?: string | null
    avatarUrl?: string | null
    /** Defaults to `false`, which is the column's default and "never asked". */
    leaderboardOptOut?: boolean
  }): void
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/**
 * The `challengeRuleSelect` projection, modelled rather than approximated.
 *
 * Production leaves `targetData`, `title` and `prompt` in Postgres on every
 * read a browser can cause. A fake that returned them would make the leak
 * assertions vacuous — they would be asserting that a route does not return a
 * field it happened not to be given, rather than that the projection is what
 * keeps it away.
 */
function withoutTarget(row: {
  id: string
  slug: string
  difficulty: number
  qubitCount: number
  targetType: string
  allowedGates: string[]
  maxGates: number | null
  fidelityThreshold: number
  orderIndex: number
}) {
  return {
    id: row.id,
    slug: row.slug,
    difficulty: row.difficulty,
    qubitCount: row.qubitCount,
    targetType: row.targetType,
    allowedGates: [...row.allowedGates],
    maxGates: row.maxGates,
    fidelityThreshold: row.fidelityThreshold,
    orderIndex: row.orderIndex,
  }
}

/**
 * `accountSelect`, modelled: `publicUserSelect`'s columns plus the settings
 * that only their owner reads.
 *
 * Projected rather than handed over whole, and for the reason `withoutTarget`
 * above is: `email` is set on every fixture row precisely so a test can assert
 * it never comes back, and a double that returned the row would make that
 * assertion vacuous.
 */
function asAccount(user: User): AccountUser {
  return {
    id: user.id,
    username: user.username,
    displayName: user.displayName,
    avatarUrl: user.avatarUrl,
    createdAt: user.createdAt,
    leaderboardOptOut: user.leaderboardOptOut,
  }
}

/**
 * §3.6's ranking: fewest gates, then least depth, then whoever got there first,
 * then the row's own id.
 *
 * The same four keys `@qsim/db` gives Prisma and spells in SQL. `id` is the one
 * that makes the order *total*: without it two attempts written in the same
 * millisecond compare equal, `Array.prototype.sort` is free to leave them in
 * whichever order it found them, and the double would then be modelling a
 * ranking that shuffles — which is the very defect production spells `"id"
 * ASC` to prevent.
 */
function byRanking(
  a: { gateCount: number; depth: number; createdAt: Date; id: string },
  b: { gateCount: number; depth: number; createdAt: Date; id: string }
): number {
  return (
    a.gateCount - b.gateCount ||
    a.depth - b.depth ||
    a.createdAt.getTime() - b.createdAt.getTime() ||
    (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)
  )
}

/**
 * `submissionSelect`: the five columns the repository reads back after a write.
 *
 * The circuit, the owner and the row's id stay behind, which is what makes the
 * response of a submission unable to carry the document that produced it.
 */
function toSubmissionRecord(row: ChallengeSubmissionRow): SubmissionRecord {
  return {
    passed: row.passed,
    fidelity: row.fidelity,
    gateCount: row.gateCount,
    depth: row.depth,
    createdAt: row.createdAt,
  }
}

/**
 * Each solver's best passing attempt at one challenge, in rank order.
 *
 * Modelled rather than approximated, for the reason the LIKE compiler above is:
 * production runs a `DISTINCT ON ("userId")` and a double that returned every
 * attempt would let a route test pass while one reader with forty submissions
 * filled the whole real table. The rank is assigned here — over everybody,
 * before anybody is withheld — exactly as `row_number()` does inside the CTE
 * and before the opt-out filter runs outside it.
 */
function rankedBests(
  submissions: readonly ChallengeSubmissionRow[],
  challengeId: string
): { row: ChallengeSubmissionRow; rank: number }[] {
  const best = new Map<string, ChallengeSubmissionRow>()
  for (const row of submissions) {
    if (row.challengeId !== challengeId || !row.passed) continue
    const held = best.get(row.userId)
    if (held === undefined || byRanking(row, held) < 0)
      best.set(row.userId, row)
  }
  return [...best.values()]
    .sort(byRanking)
    .map((row, index) => ({ row, rank: index + 1 }))
}

/**
 * Compiles a SQL `LIKE` pattern the way Postgres reads one.
 *
 * This is modelled rather than approximated, and the difference matters. The
 * obvious shortcut — "`contains` means substring, so use `includes`" — cannot
 * see the bug this exists to catch: `@qsim/db` escapes `%` and `_` before
 * handing a search term to Prisma, and if it ever stopped, a search for `%`
 * would reach Postgres as `%%%` and return *every circuit in the gallery*. A
 * double that treats the pattern as a literal string matches nothing either
 * way and reports success on a broken escape.
 *
 * So `%` and `_` are wildcards here as they are there, `\` escapes them as it
 * does there, and the anchors are the whole string because Prisma wraps a
 * `contains` value in `%…%` itself.
 */
function likeToRegExp(pattern: string): RegExp {
  let source = ''
  for (let index = 0; index < pattern.length; index += 1) {
    const character = pattern[index] as string
    if (character === '\\') {
      const escaped = pattern[index + 1]
      if (escaped === undefined) {
        source += '\\\\'
        continue
      }
      source += escapeRegExp(escaped)
      index += 1
      continue
    }
    if (character === '%') {
      source += '[\\s\\S]*'
      continue
    }
    if (character === '_') {
      source += '[\\s\\S]'
      continue
    }
    source += escapeRegExp(character)
  }
  // `i` is Postgres's ILIKE, near enough for a double: both fold case.
  return new RegExp(`^${source}$`, 'i')
}

/** Prisma's scalar conditions, as `visibility.ts` and `gallery.ts` build them. */
interface ScalarCondition {
  lt?: unknown
  in?: unknown[]
  contains?: string
  mode?: string
}

function isCondition(value: unknown): value is ScalarCondition {
  return (
    typeof value === 'object' &&
    value !== null &&
    !(value instanceof Date) &&
    !Array.isArray(value)
  )
}

function comparable(value: unknown): number | string {
  return value instanceof Date ? value.getTime() : (value as number | string)
}

/**
 * One field against one condition — equality, `lt`, `in`, or a `contains`
 * that has to behave like ILIKE.
 */
function matchesScalar(actual: unknown, condition: unknown): boolean {
  if (!isCondition(condition)) {
    return comparable(actual) === comparable(condition)
  }
  if (condition.in !== undefined) {
    return condition.in.some(
      (entry) => comparable(entry) === comparable(actual)
    )
  }
  if (condition.lt !== undefined) {
    return comparable(actual) < comparable(condition.lt)
  }
  if (condition.contains !== undefined) {
    if (condition.mode !== 'insensitive') {
      throw new Error(
        'The in-memory repository only models case-insensitive `contains`, ' +
          'which is what the gallery search uses. Teach it the other mode ' +
          'rather than letting a test pass on a comparison it ignored.'
      )
    }
    if (typeof actual !== 'string') return false
    // Prisma wraps a `contains` value in `%…%`; so does this.
    return likeToRegExp(`%${condition.contains}%`).test(actual)
  }
  throw new Error(
    `The in-memory repository cannot evaluate the condition ${JSON.stringify(condition)}.`
  )
}

/**
 * Evaluates a `where` fragment from `visibility.ts` or `gallery.ts` against a
 * row.
 *
 * Deliberately total for the shapes those helpers produce and hostile to
 * everything else: an unrecognised key throws, because the alternative —
 * ignoring it — turns a filter that got stricter in production into a filter
 * these tests believe is still permissive. On the gallery that is not an
 * abstract concern: the fragment being evaluated here is the one thing
 * standing between an anonymous listing and every private circuit in the
 * table, so a double that quietly skipped a clause would report a leak as a
 * pass.
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
    if (key === 'id') return matchesScalar(row.id, value)
    if (key === 'title') return matchesScalar(row.title, value)
    if (key === 'description') return matchesScalar(row.description, value)
    if (key === 'starCount') return matchesScalar(row.starCount, value)
    if (key === 'createdAt') return matchesScalar(row.createdAt, value)
    if (key === 'tags') {
      // `{ tags: { some: { tag: { name } } } }` — the join, as Prisma spells
      // it. Written out rather than pattern-matched loosely so that a change
      // in how the relation is filtered fails here instead of passing.
      const some = (value as { some?: { tag?: { name?: unknown } } }).some
      const name = some?.tag?.name
      if (typeof name !== 'string') {
        throw new Error(
          'The in-memory repository only models `tags.some.tag.name`.'
        )
      }
      return row.tags.includes(name)
    }
    throw new Error(
      `The in-memory repository cannot evaluate the filter key "${key}". ` +
        'Teach it, rather than letting a test pass on a rule it ignored.'
    )
  })
}

/**
 * The same evaluation over a `Collection` row — M1.9.
 *
 * Separate from `matchesFilter` rather than generic, because the fragments it
 * evaluates are typed against a different model and the value of this whole
 * approach is that the double runs *the production fragment*. It is equally
 * hostile to a key it does not know, for the same reason: the alternative to
 * throwing is a filter that got stricter in production and permissive here,
 * which reports a leak as a pass.
 */
function matchesCollectionFilter(
  row: CollectionRow,
  filter: Prisma.CollectionWhereInput
): boolean {
  return Object.entries(filter).every(([key, value]) => {
    if (key === 'OR') {
      return (value as Prisma.CollectionWhereInput[]).some((branch) =>
        matchesCollectionFilter(row, branch)
      )
    }
    if (key === 'AND') {
      return (value as Prisma.CollectionWhereInput[]).every((branch) =>
        matchesCollectionFilter(row, branch)
      )
    }
    if (key === 'visibility') return row.visibility === value
    if (key === 'ownerId') return row.ownerId === value
    if (key === 'id') return row.id === value
    throw new Error(
      `The in-memory repository cannot evaluate the collection filter key ` +
        `"${key}". Teach it, rather than letting a test pass on a rule it ` +
        'ignored.'
    )
  })
}

/**
 * The same evaluation over a `Comment` row — M5.4.
 *
 * Its own function for the reason `matchesCollectionFilter` is: the fragments
 * are typed against a different model, and the value of this whole approach is
 * that the double evaluates *the production fragment* — `threadFilter`,
 * `canResolveThreadFilter` and `deletableCommentFilter`, imported from
 * `@qsim/db` — rather than a second description of it.
 *
 * `resolvedAt` is the interesting key. `{ resolvedAt: null }` means "open" and
 * `{ resolvedAt: { not: null } }` means "resolved", and getting that pair
 * backwards would make every resolution test assert the opposite of what it
 * says. Equally hostile to an unknown key, for the reason written on the
 * circuit one: ignoring a clause reports a leak as a pass.
 */
function matchesCommentFilter(
  row: CommentRow,
  filter: Prisma.CommentWhereInput
): boolean {
  return Object.entries(filter).every(([key, value]) => {
    if (key === 'OR') {
      return (value as Prisma.CommentWhereInput[]).some((branch) =>
        matchesCommentFilter(row, branch)
      )
    }
    if (key === 'AND') {
      return (value as Prisma.CommentWhereInput[]).every((branch) =>
        matchesCommentFilter(row, branch)
      )
    }
    if (key === 'id') return row.id === value
    if (key === 'circuitId') return row.circuitId === value
    if (key === 'userId') return matchesScalar(row.userId, value)
    if (key === 'parentId') {
      if (value === null) return row.parentId === null
      return matchesScalar(row.parentId, value)
    }
    if (key === 'anchorOpId') {
      if (value === null) return row.anchorOpId === null
      if (isCondition(value) && (value as { not?: unknown }).not === null) {
        return row.anchorOpId !== null
      }
      return row.anchorOpId === value
    }
    if (key === 'resolvedAt') {
      if (value === null) return row.resolvedAt === null
      if (isCondition(value) && (value as { not?: unknown }).not === null) {
        return row.resolvedAt !== null
      }
      throw new Error(
        'The in-memory repository models `resolvedAt` as null or { not: null } ' +
          'only, which is what `threadFilter` produces.'
      )
    }
    throw new Error(
      `The in-memory repository cannot evaluate the comment filter key ` +
        `"${key}". Teach it, rather than letting a test pass on a rule it ` +
        'ignored.'
    )
  })
}

/** The key a gallery ordering term names, and the direction it wants. */
type OrderKey = 'starCount' | 'createdAt' | 'id'

/**
 * A comparator built *from* `galleryOrderBy`, so the double cannot sort by
 * one rule while production sorts by another — which would make every cursor
 * assertion here meaningless.
 */
function galleryComparator(
  sort: GallerySort
): (a: CircuitRow, b: CircuitRow) => number {
  const terms = galleryOrderBy(sort).map((term) => {
    const [key, direction] = Object.entries(term)[0] as [string, string]
    if (key !== 'starCount' && key !== 'createdAt' && key !== 'id') {
      throw new Error(`The in-memory repository cannot order by "${key}".`)
    }
    if (direction !== 'desc') {
      throw new Error(`The in-memory repository only orders descending.`)
    }
    return key satisfies OrderKey
  })

  return (a, b) => {
    for (const key of terms) {
      const left = comparable(a[key])
      const right = comparable(b[key])
      if (left < right) return 1
      if (left > right) return -1
    }
    return 0
  }
}

export function createMemoryCircuitRepository(
  options: MemoryRepositoryOptions = {}
): MemoryCircuitRepository {
  const users = new Map<string, User>()
  const circuits: CircuitRow[] = []
  const versions: VersionRow[] = []
  const stars: StarRow[] = []
  const collections: CollectionRow[] = []
  const collectionItems: CollectionItemRow[] = []
  const comments: CommentRow[] = []
  const lessonProgress: LessonProgressRow[] = []
  const challenges: ChallengeRow[] = []
  const challengeSubmissions: ChallengeSubmissionRow[] = []
  /**
   * The live collaborative documents (M5.2), keyed by circuit — which is what
   * the real table's primary key is, so "two documents for one circuit" is
   * unrepresentable here for the same reason it is there.
   */
  const sessions = new Map<string, { state: Uint8Array; updatedAt: Date }>()
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
        // `leaderboardOptOut` is not in `NewUserData` and is not meant to be:
        // `ensureUser` writes the columns an identity supplies, and a setting
        // nobody has expressed takes the column default.
        const row: User = {
          ...data,
          leaderboardOptOut: false,
          createdAt: new Date(),
        }
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

  /** Oldest first, ties broken by id - the ordering production's query has. */
  function byCommentOrder(a: CommentRow, b: CommentRow): number {
    const left = a.createdAt.getTime()
    const right = b.createdAt.getTime()
    if (left !== right) return left - right
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0
  }

  /**
   * The `publicUserSelect` projection, modelled.
   *
   * No `email`, because production's projection does not select it (Section 11)
   * - and `addUser` deliberately writes one into the row, so a test can assert
   * that a comment author never carries it.
   */
  function publicUser(userId: string): PublicUser {
    const user = users.get(userId)
    return {
      id: userId,
      username: user?.username ?? 'unknown',
      displayName: user?.displayName ?? null,
      avatarUrl: user?.avatarUrl ?? null,
      createdAt: user?.createdAt ?? new Date(0),
    }
  }

  function toStoredComment(row: CommentRow): StoredComment {
    return {
      id: row.id,
      circuitId: row.circuitId,
      body: row.body,
      anchorOpId: row.anchorOpId,
      parentId: row.parentId,
      createdAt: row.createdAt,
      author: publicUser(row.userId),
      // Normalised on a reply exactly as production normalises it.
      resolvedAt: row.parentId === null ? row.resolvedAt : null,
      resolvedBy:
        row.parentId !== null || row.resolvedById === null
          ? null
          : publicUser(row.resolvedById),
    }
  }

  function toThread(root: CommentRow): StoredThread {
    return {
      root: toStoredComment(root),
      replies: comments
        .filter((row) => row.parentId === root.id)
        .sort(byCommentOrder)
        .map(toStoredComment),
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
      // Sorted, exactly as `toCircuitCard` sorts what Prisma returns.
      tags: [...row.tags].sort(),
      preview: row.preview,
    }
  }

  function starredBy(userId: string, circuitId: string): boolean {
    return stars.some(
      (row) => row.userId === userId && row.circuitId === circuitId
    )
  }

  function circuitOrThrow(circuitId: string): CircuitRow {
    const row = circuits.find((candidate) => candidate.id === circuitId)
    // What the foreign key on `Star.circuitId` would have said, and what a
    // caller racing a delete actually gets.
    if (row === undefined) throw new CircuitGoneError(circuitId)
    return row
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

  function toCollectionCard(row: CollectionRow): CollectionCard {
    return {
      ...row,
      owner: ownerRef(row.ownerId),
      itemCount: collectionItems.filter((item) => item.collectionId === row.id)
        .length,
    }
  }

  /** This owner's collections as this viewer may list them, newest first. */
  function listableCollections(
    ownerId: string,
    viewerId: string | null
  ): CollectionRow[] {
    const filter = listableCollectionFilter(viewerId)
    return collections
      .filter(
        (row) => row.ownerId === ownerId && matchesCollectionFilter(row, filter)
      )
      .sort((a, b) => {
        const byTime = b.updatedAt.getTime() - a.updatedAt.getTime()
        // The tie-break `collectionOrderBy` ends with, so a page boundary
        // falls in the same place here as it does in Postgres.
        return byTime !== 0 ? byTime : a.id < b.id ? 1 : -1
      })
  }

  function ownedCollection(
    collectionId: string,
    ownerId: string
  ): CollectionRow | null {
    return (
      collections.find(
        (row) => row.id === collectionId && row.ownerId === ownerId
      ) ?? null
    )
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

    listPublished({ take, ...query }) {
      /*
       * The production `where` in full, evaluated rather than reimplemented.
       * That is the whole point on this route: the gallery is an anonymous
       * listing over a table holding every private circuit, so a double that
       * decided visibility for itself would be testing its own opinion.
       */
      const filter = galleryWhere(query)
      const matching = circuits
        .filter((row) => matchesFilter(row, filter))
        .sort(galleryComparator(query.sort))

      // One more than asked for, exactly as the Prisma implementation reads
      // one more, so "is there a next page" is decided the same way.
      const window = matching.slice(0, take + 1)
      const items = window.slice(0, take).map(toCard)
      const last = items.at(-1)
      const nextCursor =
        window.length > take && last !== undefined
          ? cursorAfter(last, query.sort)
          : null
      return Promise.resolve({ items, nextCursor })
    },

    countPublished(query) {
      // The same fragment the listing evaluates, for the reason the interface
      // gives: an aggregate is a listing, and a count with its own `where` is
      // a count that can report on rows the listing would have hidden.
      const filter = galleryWhere(query)
      return Promise.resolve(
        circuits.filter((row) => matchesFilter(row, filter)).length
      )
    },

    findUserByUsername(username) {
      for (const user of users.values()) {
        if (user.username !== username) continue
        /*
         * `publicUserSelect`'s columns and no others — in particular no
         * `email`, which is the one column on User that must never reach
         * another user's browser, and no `leaderboardOptOut`, which is a
         * setting and not a public fact. A profile is read by strangers, so
         * this is the *narrow* projection; `asAccount` above is the wider one,
         * and only the caller's own row goes through it.
         */
        const projected: PublicUser = {
          id: user.id,
          username: user.username,
          displayName: user.displayName,
          avatarUrl: user.avatarUrl,
          createdAt: user.createdAt,
        }
        return Promise.resolve(projected)
      }
      return Promise.resolve(null)
    },

    async star({ userId, circuitId }) {
      const circuit = circuitOrThrow(circuitId)
      // The window a second request slips into. Everything below is the
      // atomic insert `ON CONFLICT DO NOTHING` performs in production.
      await options.beforeStarWrite?.(circuitId)

      if (!starredBy(userId, circuitId)) {
        stars.push({ userId, circuitId })
        circuit.starCount += 1
      }
      return { starred: true, starCount: circuit.starCount }
    },

    async unstar({ userId, circuitId }) {
      const circuit = circuitOrThrow(circuitId)
      await options.beforeStarWrite?.(circuitId)

      const index = stars.findIndex(
        (row) => row.userId === userId && row.circuitId === circuitId
      )
      if (index !== -1) {
        stars.splice(index, 1)
        // The floor the production `updateMany` enforces with `starCount > 0`.
        circuit.starCount = Math.max(0, circuit.starCount - 1)
      }
      return { starred: false, starCount: circuit.starCount }
    },

    hasStarred({ userId, circuitId }) {
      return Promise.resolve(starredBy(userId, circuitId))
    },

    starredAmong({ userId, circuitIds }) {
      // Scoped to the ids asked about, exactly as the `IN` clause is: this
      // must not become a way to learn what somebody starred on a page they
      // were not shown.
      return Promise.resolve(
        circuitIds.filter((circuitId) => starredBy(userId, circuitId))
      )
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
        // Already canonical: `normalizeTagNames` ran at the edge, which is
        // the same order the Prisma implementation relies on.
        tags: [...(input.tags ?? [])],
        preview: previewOf(input.data),
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
      // `undefined` leaves the set alone, `[]` clears it — two different
      // requests, as they are in `setCircuitTags`.
      if (changes.tags !== undefined) row.tags = [...changes.tags]
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
      // And on Star.circuitId, which is why a deleted circuit takes its
      // stars with it rather than leaving rows pointing at nothing.
      for (let i = stars.length - 1; i >= 0; i -= 1) {
        if (stars[i]?.circuitId === id) stars.splice(i, 1)
      }
      /*
       * What no foreign key does. `CollectionItem.circuitId` has none (§7), so
       * production sweeps these by hand inside the same transaction, and this
       * double has to sweep them too — otherwise a test would pass against a
       * fake that leaves no orphan while production leaves one in every
       * collection that held the circuit, including strangers'.
       */
      for (let i = collectionItems.length - 1; i >= 0; i -= 1) {
        if (collectionItems[i]?.circuitId === id) collectionItems.splice(i, 1)
      }
      // `CircuitSession_circuitId_fkey ON DELETE CASCADE`, in the double.
      sessions.delete(id)
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

        // The thumbnail moves with the counters, in the same assignment the
        // production `updateMany` makes in one statement.
        Object.assign(circuit, metrics, {
          preview: previewOf(data),
          updatedAt: new Date(),
        })
        /*
         * A save supersedes the live document, in the same act — see
         * `CircuitSession` in the schema. The double has to do it too or the
         * restore case passes here and undoes itself in production.
         */
        sessions.delete(circuitId)
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

    /* ── The live collaborative document (M5.2) ───────────────────────── */

    loadSession(circuitId) {
      const held = sessions.get(circuitId)
      return Promise.resolve(
        held === undefined
          ? null
          : // Copied on the way out, as Prisma's `bytea` read is: a caller that
            // mutated what it was handed must not reach back into the store.
            { state: Uint8Array.from(held.state), updatedAt: held.updatedAt }
      )
    },

    saveSession({ circuitId, state }) {
      // What `CircuitSession_circuitId_fkey` would have said. A document must
      // not outlive the circuit it describes, and the double has to refuse it
      // too — otherwise a test would pass against a fake that keeps orphans
      // while production raises.
      if (!circuits.some((candidate) => candidate.id === circuitId)) {
        return Promise.reject(new CircuitNotWritableError(circuitId))
      }
      sessions.set(circuitId, {
        state: Uint8Array.from(state),
        updatedAt: new Date(),
      })
      return Promise.resolve()
    },

    dropSession(circuitId) {
      return Promise.resolve(sessions.delete(circuitId))
    },

    /* ── Collections (M1.9) ───────────────────────────────────────────── */

    listCollections({ ownerId, viewerId, skip, take }) {
      const rows = listableCollections(ownerId, viewerId).map(toCollectionCard)
      return Promise.resolve(paginate(rows, skip, take))
    },

    countCollections({ ownerId, viewerId }) {
      return Promise.resolve(listableCollections(ownerId, viewerId).length)
    },

    findReadableCollection(id, viewerId) {
      // The production fragment in full, evaluated rather than reimplemented —
      // including the part that decides whether an id reaches an UNLISTED
      // collection, which is the decision `visibility.ts` argues at length.
      const filter = collectionHandleFilter(id, viewerId)
      const row = collections.find((candidate) =>
        matchesCollectionFilter(candidate, filter)
      )
      return Promise.resolve(row === undefined ? null : toCollectionCard(row))
    },

    readCollectionItems({ collectionId, viewerId }) {
      const memberships = collectionItems
        .filter((row) => row.collectionId === collectionId)
        .sort((a, b) =>
          a.orderIndex === b.orderIndex
            ? a.circuitId.localeCompare(b.circuitId)
            : a.orderIndex - b.orderIndex
        )

      /*
       * THE rule of this milestone, evaluated with the production fragment:
       * a collection's visibility governs the collection, and the circuits
       * inside it are filtered by their own. A double that skipped this would
       * report the leak it exists to catch as a pass.
       */
      const filter = listableCircuitFilter(viewerId)
      const visible = memberships
        .map((row) => circuits.find((circuit) => circuit.id === row.circuitId))
        .filter(
          (row): row is CircuitRow =>
            row !== undefined && matchesFilter(row, filter)
        )

      return Promise.resolve({
        items: visible.map(toCard),
        withheld: memberships.length - visible.length,
      })
    },

    createCollection(input) {
      const now = new Date()
      const row: CollectionRow = {
        id: nextId('col_'),
        ownerId: input.ownerId,
        title: input.title,
        description: input.description,
        visibility: input.visibility,
        createdAt: now,
        updatedAt: now,
      }
      collections.push(row)
      return Promise.resolve(toCollectionCard(row))
    },

    updateCollection({ id, ownerId, ...changes }) {
      const row = ownedCollection(id, ownerId)
      if (row === null) return Promise.resolve(null)
      if (changes.title !== undefined) row.title = changes.title
      if (changes.description !== undefined) {
        row.description = changes.description
      }
      if (changes.visibility !== undefined) row.visibility = changes.visibility
      row.updatedAt = new Date()
      return Promise.resolve(toCollectionCard(row))
    },

    removeCollection({ id, ownerId }) {
      const index = collections.findIndex(
        (row) => row.id === id && row.ownerId === ownerId
      )
      if (index === -1) return Promise.resolve(false)
      collections.splice(index, 1)
      // `onDelete: Cascade` on CollectionItem.collectionId — which this join
      // table does have, unlike its other column.
      for (let i = collectionItems.length - 1; i >= 0; i -= 1) {
        if (collectionItems[i]?.collectionId === id) {
          collectionItems.splice(i, 1)
        }
      }
      return Promise.resolve(true)
    },

    addCollectionItem({ collectionId, ownerId, circuitId }) {
      const row = ownedCollection(collectionId, ownerId)
      // What the owner-scoped read inside the production transaction says.
      if (row === null) throw new CollectionNotWritableError(collectionId)

      const held = collectionItems.filter(
        (item) => item.collectionId === collectionId
      )
      const already = held.some((item) => item.circuitId === circuitId)
      // The bound Postgres cannot express as a constraint, checked before the
      // insert exactly as the transaction checks it.
      if (!already && held.length >= MAX_COLLECTION_ITEMS) {
        throw new CollectionFullError(collectionId)
      }
      if (!already) {
        collectionItems.push({
          collectionId,
          circuitId,
          orderIndex: held.length,
        })
      }
      row.updatedAt = new Date()
      return Promise.resolve(toCollectionCard(row))
    },

    removeCollectionItem({ collectionId, ownerId, circuitId }) {
      const row = ownedCollection(collectionId, ownerId)
      if (row === null) return Promise.resolve(false)

      const index = collectionItems.findIndex(
        (item) =>
          item.collectionId === collectionId && item.circuitId === circuitId
      )
      if (index === -1) return Promise.resolve(false)
      collectionItems.splice(index, 1)
      row.updatedAt = new Date()
      return Promise.resolve(true)
    },

    collectionIdsHolding({ ownerId, circuitId }) {
      const mine = new Set(
        collections
          .filter((row) => row.ownerId === ownerId)
          .map((row) => row.id)
      )
      return Promise.resolve(
        collectionItems
          .filter(
            (item) =>
              item.circuitId === circuitId && mine.has(item.collectionId)
          )
          .map((item) => item.collectionId)
      )
    },

    /* ── The account itself (M1.9) ────────────────────────────────────── */

    findUserById(id) {
      const user = users.get(id)
      if (user === undefined) return Promise.resolve(null)
      return Promise.resolve(asAccount(user))
    },

    updateProfile({ userId, ...changes }) {
      const user = users.get(userId)
      if (user === undefined) {
        // What `prisma.user.update` raises for a row that is not there.
        throw Object.assign(new Error('Record to update not found'), {
          code: 'P2025',
        })
      }
      if (changes.username !== undefined) {
        // `User_username_key`. The write decides, exactly as it does in
        // production — there is no availability check anywhere.
        for (const other of users.values()) {
          if (other.id !== userId && other.username === changes.username) {
            throw new UsernameTakenError(changes.username)
          }
        }
        user.username = changes.username
      }
      if (changes.displayName !== undefined) {
        user.displayName = changes.displayName
      }
      if (changes.avatarUrl !== undefined) user.avatarUrl = changes.avatarUrl
      if (changes.leaderboardOptOut !== undefined) {
        user.leaderboardOptOut = changes.leaderboardOptOut
      }

      return Promise.resolve(asAccount(user))
    },

    /**
     * The deletion, modelled to the extent this double models the schema.
     *
     * `SimulationRun`, `HardwareJob` and `Comment` have no representation
     * here, because no route in this API touches them — so their counts come
     * back as zero and the sweeps over them are covered by the Prisma
     * implementation rather than from an HTTP test. What *is* modelled is
     * everything the routes can observe: the cascades, the star counts no
     * foreign key maintains, and the collection memberships in other people's
     * collections that no foreign key removes.
     */
    deleteAccount(userId) {
      const owned = circuits.filter((row) => row.ownerId === userId)
      const ownedIds = new Set(owned.map((row) => row.id))
      const mine = collections.filter((row) => row.ownerId === userId)

      // The denormalised counter nothing else maintains: cascading a `Star`
      // away leaves a count that is too high on somebody else's circuit.
      const starredByUser = stars.filter((row) => row.userId === userId)
      for (const star of starredByUser) {
        const circuit = circuits.find((row) => row.id === star.circuitId)
        if (circuit !== undefined) {
          circuit.starCount = Math.max(0, circuit.starCount - 1)
        }
      }

      let orphanedCollectionItems = 0
      for (let i = collectionItems.length - 1; i >= 0; i -= 1) {
        const item = collectionItems[i]
        if (item === undefined) continue
        const inOwnCollection = mine.some((row) => row.id === item.collectionId)
        // Rows in the user's own collections go by cascade; rows in anybody
        // else's naming one of the user's circuits are the orphans.
        if (ownedIds.has(item.circuitId) && !inOwnCollection) {
          orphanedCollectionItems += 1
          collectionItems.splice(i, 1)
          continue
        }
        if (inOwnCollection) collectionItems.splice(i, 1)
      }

      for (let i = collections.length - 1; i >= 0; i -= 1) {
        if (collections[i]?.ownerId === userId) collections.splice(i, 1)
      }
      for (let i = stars.length - 1; i >= 0; i -= 1) {
        const star = stars[i]
        if (star === undefined) continue
        if (star.userId === userId || ownedIds.has(star.circuitId)) {
          stars.splice(i, 1)
        }
      }
      for (let i = versions.length - 1; i >= 0; i -= 1) {
        const version = versions[i]
        if (version !== undefined && ownedIds.has(version.circuitId)) {
          versions.splice(i, 1)
        }
      }

      /*
       * Comments, and the two cascades that reach them (M5.4).
       *
       * `Comment.userId` cascades from `User`, and `Comment.parentId` now
       * cascades from `Comment` — so a reply by somebody else to one of this
       * user's comments goes too, which is what the foreign key added in M5.4
       * does and what the hand-written sweep in `accounts.ts` used to do.
       * Comments on this user's *circuits* go by the cascade from `Circuit`.
       *
       * The count reported is the user's own plus other people's replies to
       * them, which is exactly what production counts.
       */
      const ownCommentIds = new Set(
        comments.filter((row) => row.userId === userId).map((row) => row.id)
      )
      const foreignReplies = comments.filter(
        (row) =>
          row.parentId !== null &&
          ownCommentIds.has(row.parentId) &&
          row.userId !== userId
      ).length
      for (let i = comments.length - 1; i >= 0; i -= 1) {
        const row = comments[i]
        if (row === undefined) continue
        const doomed =
          row.userId === userId ||
          ownedIds.has(row.circuitId) ||
          (row.parentId !== null && ownCommentIds.has(row.parentId))
        if (doomed) comments.splice(i, 1)
        // `resolvedById` is SET NULL rather than a cascade: a thread that was
        // resolved stays resolved, it just stops naming who resolved it.
        else if (row.resolvedById === userId) row.resolvedById = null
      }

      for (let i = circuits.length - 1; i >= 0; i -= 1) {
        if (circuits[i]?.ownerId === userId) circuits.splice(i, 1)
      }
      users.delete(userId)

      const report: AccountDeletionReport = {
        circuits: owned.length,
        collections: mine.length,
        comments: ownCommentIds.size + foreignReplies,
        stars: starredByUser.length,
        simulationRuns: 0,
        hardwareJobs: 0,
        orphanedCollectionItems,
      }
      return Promise.resolve(report)
    },

    /* ── Comments anchored to gates (M5.4) ─────────────────────────────── */

    listComments({ circuitId, state, anchorOpId, skip, take }) {
      const matching = (input: {
        state: 'open' | 'resolved' | 'all'
        anchorOpId?: string
      }): CommentRow[] =>
        comments.filter((row) =>
          matchesCommentFilter(
            row,
            threadFilter({
              circuitId,
              state: input.state,
              ...(input.anchorOpId === undefined
                ? {}
                : { anchorOpId: input.anchorOpId }),
            })
          )
        )

      const narrowed = anchorOpId === undefined ? {} : { anchorOpId }
      const roots = matching({ state, ...narrowed }).sort(byCommentOrder)

      /*
       * The tally is over the whole circuit and both states, exactly as
       * production's `groupBy` is - unnarrowed by `state` and by `anchorOpId`,
       * because a marker has to appear on a gate whose only thread is resolved,
       * and on gates other than the one currently filtered to.
       */
      const anchors: Record<string, AnchorTally> = {}
      for (const row of matching({ state: 'all' })) {
        const key = row.anchorOpId
        if (key === null || row.parentId !== null) continue
        const current = anchors[key] ?? { open: 0, resolved: 0 }
        anchors[key] =
          row.resolvedAt === null
            ? { open: current.open + 1, resolved: current.resolved }
            : { open: current.open, resolved: current.resolved + 1 }
      }

      const page: CommentThreadPage = {
        threads: roots.slice(skip, skip + take).map((root) => toThread(root)),
        total: roots.length,
        openCount: matching({ state: 'open', ...narrowed }).length,
        resolvedCount: matching({ state: 'resolved', ...narrowed }).length,
        circuitTotal: matching({ state: 'all' }).length,
        anchors,
      }
      return Promise.resolve(page)
    },

    postComment({ circuitId, userId, body, anchorOpId, parentId }) {
      if (parentId !== undefined) {
        const parent = comments.find(
          (row) => row.id === parentId && row.circuitId === circuitId
        )
        if (parent === undefined) {
          return Promise.reject(new ParentCommentNotFoundError(parentId))
        }
        if (parent.parentId !== null) {
          return Promise.reject(new ReplyDepthError(parentId))
        }
        const replies = comments.filter((row) => row.parentId === parent.id)
        if (replies.length >= MAX_REPLIES_PER_THREAD) {
          return Promise.reject(new ThreadFullError(parentId))
        }
        /*
         * A reply inherits its root's anchor, read from the parent and never
         * from the caller - the same rule production enforces, modelled here so
         * that a test cannot pass by sending one.
         */
        const reply: CommentRow = {
          id: nextId('cmt_'),
          circuitId,
          userId,
          body,
          parentId: parent.id,
          anchorOpId: parent.anchorOpId,
          resolvedAt: null,
          resolvedById: null,
          createdAt: new Date(),
        }
        comments.push(reply)
        return Promise.resolve(toStoredComment(reply))
      }

      const roots = comments.filter(
        (row) => row.circuitId === circuitId && row.parentId === null
      )
      if (roots.length >= MAX_THREADS_PER_CIRCUIT) {
        return Promise.reject(new CircuitCommentsFullError(circuitId))
      }
      const root: CommentRow = {
        id: nextId('cmt_'),
        circuitId,
        userId,
        body,
        parentId: null,
        anchorOpId: anchorOpId ?? null,
        resolvedAt: null,
        resolvedById: null,
        createdAt: new Date(),
      }
      comments.push(root)
      return Promise.resolve(toStoredComment(root))
    },

    findThread({ circuitId, rootId }) {
      const root = comments.find(
        (row) =>
          row.id === rootId &&
          row.circuitId === circuitId &&
          row.parentId === null
      )
      return Promise.resolve(root === undefined ? null : toThread(root))
    },

    findCommentContext({ circuitId, commentId }) {
      const row = comments.find(
        (candidate) =>
          candidate.id === commentId && candidate.circuitId === circuitId
      )
      if (row === undefined) return Promise.resolve(null)
      return Promise.resolve({
        id: row.id,
        authorId: row.userId,
        parentId: row.parentId,
        resolvedAt: row.resolvedAt,
      })
    },

    setThreadResolution({ circuitId, rootId, viewerId, ownerId, resolved }) {
      const filter = canResolveThreadFilter({
        circuitId,
        rootId,
        viewerId,
        ownerId,
      })
      const target = comments.find((row) => matchesCommentFilter(row, filter))
      if (target === undefined) return Promise.resolve(false)
      target.resolvedAt = resolved ? new Date() : null
      target.resolvedById = resolved ? viewerId : null
      return Promise.resolve(true)
    },

    deleteComment({ circuitId, commentId, viewerId, ownerId }) {
      const filter = deletableCommentFilter({
        circuitId,
        commentId,
        viewerId,
        ownerId,
      })
      const index = comments.findIndex((row) =>
        matchesCommentFilter(row, filter)
      )
      if (index === -1) return Promise.resolve(false)
      const [removed] = comments.splice(index, 1)
      /*
       * `ON DELETE CASCADE` on `Comment.parentId`, modelled - the foreign key
       * M5.4 added. Without it the double would leave replies behind where
       * Postgres removes them, and a test about deleting a thread would be
       * asserting the opposite of what happens in production.
       */
      if (removed !== undefined) {
        for (let i = comments.length - 1; i >= 0; i -= 1) {
          if (comments[i]?.parentId === removed.id) comments.splice(i, 1)
        }
      }
      return Promise.resolve(true)
    },

    /* ── Lesson bookmarks (Phase 3) ───────────────────────────────────── */

    listLessonProgress(userId) {
      return Promise.resolve(
        lessonProgress
          .filter((row) => row.userId === userId)
          .map(({ userId: _userId, ...row }) => row)
          // The Prisma implementation orders by `updatedAt desc`, and a fake
          // that returned insertion order would let a route test pass while
          // the real listing came back backwards.
          .sort((a, b) => b.updatedAt.getTime() - a.updatedAt.getTime())
      )
    },

    saveLessonProgress({ userId, slug, stepIndex, completed }) {
      const existing = lessonProgress.find(
        (row) => row.userId === userId && row.slug === slug
      )
      const row = {
        userId,
        slug,
        stepIndex,
        /*
         * OR-ed, exactly as the repository documents: re-reading page one of a
         * finished lesson must not un-finish it. A fake that assigned instead
         * would make the route test agree with a bug production does not have.
         */
        completed: completed || (existing?.completed ?? false),
        updatedAt: new Date(),
      }
      if (existing === undefined) lessonProgress.push(row)
      else Object.assign(existing, row)
      const { userId: _userId, ...record } = row
      return Promise.resolve(record)
    },

    /* ── Challenges (Phase 3) ─────────────────────────────────────────── */

    listChallenges() {
      return Promise.resolve(
        [...challenges]
          .sort(
            (a, b) =>
              a.orderIndex - b.orderIndex || a.slug.localeCompare(b.slug)
          )
          .map(withoutTarget)
      )
    },

    findChallenge(slug) {
      const row = challenges.find((challenge) => challenge.slug === slug)
      /*
       * Deliberately projected, exactly as production projects. A fake that
       * handed the whole row back would let a route return a target and every
       * leak assertion in the suite would pass — the one thing a double must
       * never do is disagree with production about the rule under test, and the
       * rule here is that the answer does not leave the server.
       */
      return Promise.resolve(row === undefined ? null : withoutTarget(row))
    },

    findChallengeWithTarget(slug) {
      const row = challenges.find((challenge) => challenge.slug === slug)
      return Promise.resolve(
        row === undefined
          ? null
          : { ...withoutTarget(row), targetData: row.targetData }
      )
    },

    recordSubmission(input) {
      const row: ChallengeSubmissionRow = {
        id: nextId('sub_'),
        challengeId: input.challengeId,
        userId: input.userId,
        circuitData: input.circuitData,
        passed: input.passed,
        fidelity: input.fidelity,
        gateCount: input.gateCount,
        depth: input.depth,
        createdAt: new Date(),
      }
      challengeSubmissions.push(row)
      return Promise.resolve(toSubmissionRecord(row))
    },

    bestSubmission({ challengeId, userId }) {
      const mine = challengeSubmissions
        .filter(
          (row) =>
            row.challengeId === challengeId &&
            row.userId === userId &&
            row.passed
        )
        .sort(byRanking)
      const best = mine[0]
      if (best === undefined) return Promise.resolve(null)
      return Promise.resolve(toSubmissionRecord(best))
    },

    solvedAmong({ userId, challengeIds }) {
      const wanted = new Set(challengeIds)
      const solved = new Set(
        challengeSubmissions
          .filter(
            (row) =>
              row.userId === userId && row.passed && wanted.has(row.challengeId)
          )
          .map((row) => row.challengeId)
      )
      return Promise.resolve([...solved])
    },

    leaderboard({ challengeId, take }) {
      return Promise.resolve(
        rankedBests(challengeSubmissions, challengeId)
          /*
           * Withheld *after* the rank was assigned, exactly as the SQL filters
           * outside the window. A double that dropped the rows before ranking
           * would renumber everybody below an opted-out reader, and the route
           * test would then agree with a leaderboard you could climb by asking
           * other people to hide.
           *
           * `take` applies after the filter, so a page is `take` rows a reader
           * can actually see rather than `take` rows minus the hidden ones.
           */
          .filter(
            ({ row }) => users.get(row.userId)?.leaderboardOptOut !== true
          )
          .slice(0, take)
          .map(({ row, rank }) => {
            const user = users.get(row.userId)
            return {
              rank,
              username: user?.username ?? row.userId,
              displayName: user?.displayName ?? null,
              avatarUrl: user?.avatarUrl ?? null,
              gateCount: row.gateCount,
              depth: row.depth,
              createdAt: row.createdAt,
            }
          })
      )
    },

    leaderboardStanding({ challengeId, userId }) {
      const mine = rankedBests(challengeSubmissions, challengeId).find(
        ({ row }) => row.userId === userId
      )
      if (mine === undefined) return Promise.resolve(null)
      return Promise.resolve({
        rank: mine.rank,
        gateCount: mine.row.gateCount,
        depth: mine.row.depth,
        createdAt: mine.row.createdAt,
        // Not filtered by the opt-out, deliberately: this is the answer to
        // "where do I stand", asked by the only person entitled to ask it.
        listed: users.get(userId)?.leaderboardOptOut !== true,
      })
    },

    upsertChallenge(seed) {
      const existing = challenges.find(
        (challenge) => challenge.slug === seed.slug
      )
      const row: ChallengeRow = {
        id: existing?.id ?? nextId('chl'),
        slug: seed.slug,
        title: seed.title,
        prompt: seed.prompt,
        difficulty: seed.difficulty,
        qubitCount: seed.qubitCount,
        targetType: seed.targetType,
        targetData: seed.targetData,
        allowedGates: [...seed.allowedGates],
        maxGates: seed.maxGates,
        fidelityThreshold: seed.fidelityThreshold,
        orderIndex: seed.orderIndex,
      }
      if (existing === undefined) challenges.push(row)
      else Object.assign(existing, row)
      return Promise.resolve({ created: existing === undefined })
    },

    allVersions(circuitId) {
      return circuitId === undefined
        ? [...versions]
        : versions.filter((row) => row.circuitId === circuitId)
    },

    allChallengeSubmissions(challengeId) {
      return challengeId === undefined
        ? [...challengeSubmissions]
        : challengeSubmissions.filter((row) => row.challengeId === challengeId)
    },

    allCollections: () => [...collections],

    allCollectionItems(collectionId) {
      return collectionId === undefined
        ? [...collectionItems]
        : collectionItems.filter((row) => row.collectionId === collectionId)
    },

    allCircuits: () => [...circuits],

    allComments(circuitId) {
      return circuitId === undefined
        ? [...comments]
        : comments.filter((row) => row.circuitId === circuitId)
    },

    allStars(circuitId) {
      return circuitId === undefined
        ? [...stars]
        : stars.filter((row) => row.circuitId === circuitId)
    },

    addUser({
      id,
      username,
      displayName = null,
      avatarUrl = null,
      leaderboardOptOut = false,
    }) {
      users.set(id, {
        id,
        // Never returned by any projection, and present here precisely so a
        // test can assert that it is not.
        email: `${username}@example.invalid`,
        username,
        displayName,
        avatarUrl,
        leaderboardOptOut,
        createdAt: new Date(),
      })
    },

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
