/**
 * Challenges and their submissions — §3.6, §7, risk 5, Phase 3.
 *
 * The opposite table to `lessons.ts` beside it, and the difference is worth
 * stating rather than leaving to be noticed. A lesson bookmark is the reader's
 * own note about their own reading, and the client decides what it means. A
 * challenge submission is *judged*, by the server, with the same engine the
 * browser used — because a challenge has a leaderboard and a position is a
 * thing worth lying for (risk 5). Every figure stored below was recomputed in
 * `apps/api` from the submitted circuit; none of it was taken from a request
 * body.
 *
 * ── TWO PROJECTIONS, AND THE REASON THERE ARE TWO ─────────────────────────
 *
 * `challengeRuleSelect` is every column *except* `targetData`;
 * `challengeWithTargetSelect` adds it. The split is the leak defence closest to
 * the data: a route that lists challenges cannot accidentally serialise the
 * answer, because the answer was never read out of Postgres. Only the
 * submission path — the one that has to compare against it — asks for the
 * target, and what it returns to the caller is a fidelity.
 *
 * ── THIS FILE HAS NO OPINION ABOUT WHAT A TARGET *IS* ─────────────────────
 *
 * `targetData` comes back as `unknown`. Its shape is physics — a state vector,
 * a matrix, a truth table — and physics is `@qsim/core`'s, which this package
 * may not import (`db-depends-only-on-schema` in `.dependency-cruiser.cjs`,
 * whose comment says exactly why: if the persistence layer could run the
 * engine, "the server simulates authoritatively" would quietly become "the
 * database layer decides"). `apps/api` parses it, next to the validator that
 * uses it.
 *
 * ── THE LEADERBOARD RANKS PEOPLE, NOT ATTEMPTS ────────────────────────────
 *
 * §3.6 asks for a "tabla de posiciones por reto", and a position belongs to a
 * person: a reader who submits the same three-gate answer forty times is one
 * competitor and not the whole top forty. So the board is one row per user —
 * their best — which is a `DISTINCT ON ("userId")` under the ranking order,
 * and it is written as SQL rather than assembled here for two reasons. Prisma's
 * `distinct` combined with `take` is a filter applied around a limit rather
 * than under it, so it can return fewer rows than asked for and cannot say
 * which; and the rank has to be `row_number()` over the *deduplicated* set,
 * which is a window function and has no Prisma expression at all.
 *
 * ── THE ORDER IS TOTAL, AND THAT IS THE POINT ─────────────────────────────
 *
 * `rankingOrder` is (gateCount, depth, createdAt, id). §3.6 supplies the first
 * two; `createdAt` breaks the remaining tie in favour of whoever got there
 * first, which is the only tie-break that does not change when a third person
 * submits. `id` is what makes it *total*: a timestamp is milliseconds, two
 * attempts can share one, and any comparator that ends in a tie leaves the
 * order to the query plan — which is a ranking that shuffles between two
 * identical requests, with no bug to find afterwards. It is used identically
 * inside the DISTINCT ON (which best attempt is *yours*) and outside it (which
 * of the bests comes first), so the two cannot disagree.
 *
 * ── OPTING OUT HIDES A NAME, NEVER A RESULT ───────────────────────────────
 *
 * `User.leaderboardOptOut` is filtered *after* `row_number()` has run, so the
 * ranks in the listing are ranks over everybody. Two consequences, both
 * intended. Somebody withdrawing their name cannot promote the people below
 * them — a privacy setting that rewrote other people's positions would make a
 * ladder something you could climb by asking others to hide. And a reader's
 * own standing (`leaderboardStanding`) is the truth about where they stand
 * whether or not they are listed, which is what makes it worth showing them.
 * The visible cost is that the rank column can skip a number. That is the
 * honest disclosure — "somebody is here" without saying who — and it is why
 * this response needs no separate withheld count, unlike a collection, whose
 * items carry no rank to leave a gap in.
 *
 * ── WHY `upsertChallenge` IS PART OF THE REPOSITORY ───────────────────────
 *
 * Seeding is a write against the one shared database, so it goes through the
 * same interface every other write does rather than through a script holding
 * its own client. It is keyed on the unique `slug` and it is therefore
 * idempotent: a redeploy converges the row instead of adding a second copy of
 * every challenge. It never deletes: a challenge withdrawn from the catalog
 * keeps its row, because its submissions have a foreign key to it and somebody
 * earned those.
 */

import { Prisma } from './generated/prisma/client.js'
import type { PrismaClient } from './generated/prisma/client.js'

/** The rules of one challenge. Everything except the answer. */
export interface ChallengeRules {
  readonly id: string
  readonly slug: string
  readonly difficulty: number
  readonly qubitCount: number
  readonly targetType: string
  readonly allowedGates: string[]
  readonly maxGates: number | null
  readonly fidelityThreshold: number
  readonly orderIndex: number
}

/** The rules plus the target, read only by the path that has to compare. */
export interface ChallengeWithTarget extends ChallengeRules {
  /**
   * Whatever the seed wrote. Typed as `unknown` and not as a shape — see the
   * header: this package does not know what a target is.
   */
  readonly targetData: unknown
}

/** What the server computed about one attempt. */
export interface SubmissionRecord {
  readonly passed: boolean
  readonly fidelity: number
  readonly gateCount: number
  readonly depth: number
  readonly createdAt: Date
}

export interface RecordSubmissionInput {
  readonly challengeId: string
  readonly userId: string
  /** The circuit as submitted, already through `parseCircuit`. */
  readonly circuitData: Prisma.InputJsonValue
  readonly passed: boolean
  readonly fidelity: number
  readonly gateCount: number
  readonly depth: number
}

/** One rung of the leaderboard: who, and what it cost them. */
export interface LeaderboardRow {
  /**
   * Position over *everybody* who has solved this challenge, so it can skip a
   * number where somebody opted out of being listed. Assigned by the database
   * from the same order the rows come back in, never by counting them here —
   * a rank recomputed from an array index would be a second implementation of
   * the ordering, and the second one is the one that goes wrong quietly.
   */
  readonly rank: number
  readonly username: string
  readonly displayName: string | null
  readonly gateCount: number
  readonly depth: number
  readonly createdAt: Date
}

/**
 * Where one reader stands, listed or not.
 *
 * Carries the figures as well as the rank, and from the same query: the row
 * highlighted in the table and the line printed under it are then literally
 * one row, rather than two reads that agree until somebody submits between
 * them.
 */
export interface LeaderboardStanding {
  readonly rank: number
  readonly gateCount: number
  readonly depth: number
  readonly createdAt: Date
  /** `false` when this reader has asked not to appear. Their rank still holds. */
  readonly listed: boolean
}

/** One row of the seed. `title` and `prompt` are the English source (§8). */
export interface ChallengeSeed {
  readonly slug: string
  readonly title: string
  readonly prompt: string
  readonly difficulty: number
  readonly qubitCount: number
  readonly targetType: string
  readonly targetData: Prisma.InputJsonValue
  readonly allowedGates: readonly string[]
  readonly maxGates: number | null
  readonly fidelityThreshold: number
  readonly orderIndex: number
}

export interface ChallengeRepository {
  /** The ladder, in `orderIndex` order. Never carries a target. */
  listChallenges(): Promise<ChallengeRules[]>

  /**
   * One challenge including its target — the submission path's read, and the
   * only one that touches the column.
   */
  findChallengeWithTarget(slug: string): Promise<ChallengeWithTarget | null>

  /** One challenge without its target — every read a browser can cause. */
  findChallenge(slug: string): Promise<ChallengeRules | null>

  /** Stores one judged attempt. Every figure here came from the engine. */
  recordSubmission(input: RecordSubmissionInput): Promise<SubmissionRecord>

  /**
   * This caller's best *passing* attempt at one challenge — fewest gates, then
   * least depth, which is the leaderboard's own ordering so that "your best"
   * and "your rank" can never disagree.
   */
  bestSubmission(input: {
    challengeId: string
    userId: string
  }): Promise<SubmissionRecord | null>

  /**
   * Which of these challenges this caller has already passed.
   *
   * Called with the ids a listing has already returned, exactly as
   * `starredAmong` is: one indexed read instead of one lookup per card, and
   * scoped to the caller's own rows, so it can report nothing about anybody
   * else.
   */
  solvedAmong(input: {
    userId: string
    challengeIds: readonly string[]
  }): Promise<string[]>

  /**
   * §3.6's table: one row per person — their best passing attempt — fewest
   * gates then least depth, and the rank each of them holds.
   *
   * Readers who opted out are ranked and then withheld, so `take` counts rows
   * that will actually be shown while the numbers on them stay true.
   */
  leaderboard(input: {
    challengeId: string
    take: number
  }): Promise<LeaderboardRow[]>

  /**
   * Where one reader stands on that same table, however far down they are.
   *
   * `null` when they have never passed this challenge. Computed from the same
   * ranked set the listing comes from, and *not* filtered by the opt-out: it
   * is the answer to "where am I", asked by the only person entitled to ask.
   */
  leaderboardStanding(input: {
    challengeId: string
    userId: string
  }): Promise<LeaderboardStanding | null>

  /**
   * Writes one challenge, creating it or converging it. Idempotent on `slug`.
   * Only the seed calls this.
   */
  upsertChallenge(seed: ChallengeSeed): Promise<{ created: boolean }>
}

/**
 * Every column but the answer.
 *
 * `title` and `prompt` are absent as well, and deliberately: they are the
 * English source the seed was written from, they never travel (D2 puts every
 * user-facing word in `apps/web`'s catalogs), and a projection that read them
 * would sooner or later be the projection a route returned.
 */
export const challengeRuleSelect = {
  id: true,
  slug: true,
  difficulty: true,
  qubitCount: true,
  targetType: true,
  allowedGates: true,
  maxGates: true,
  fidelityThreshold: true,
  orderIndex: true,
} as const

export const challengeWithTargetSelect = {
  ...challengeRuleSelect,
  targetData: true,
} as const

const submissionSelect = {
  passed: true,
  fidelity: true,
  gateCount: true,
  depth: true,
  createdAt: true,
} as const

/**
 * The leaderboard's ordering, in one place because everything that ranks sorts
 * by it. See the header for the whole argument; in short: §3.6 supplies the
 * first two keys, `createdAt` favours whoever got there first, and `id` is what
 * makes the order total rather than merely specified.
 *
 * The SQL below spells the same four columns rather than importing this
 * constant, because a `DISTINCT ON` and a window frame are not `orderBy`
 * arrays. `challenges.test.ts` asserts the two spellings agree, which is the
 * only way one file can hold both.
 */
const rankingOrder = [
  { gateCount: 'asc' },
  { depth: 'asc' },
  { createdAt: 'asc' },
  { id: 'asc' },
] as const

/**
 * The ranking as SQL, and the one place it is written.
 *
 * `Prisma.sql` is a fragment, not a string: it is composed into the two
 * queries below by the tagged-template machinery, so neither of them can hold
 * a divergent copy of the order. Nothing here is interpolated — these are four
 * column names, fixed at authoring time.
 */
const RANKING_SQL = Prisma.sql`"gateCount" ASC, "depth" ASC, "createdAt" ASC, "id" ASC`

/**
 * Every solver's best attempt at one challenge, ranked.
 *
 * `DISTINCT ON ("userId")` keeps the first row of each user under an ORDER BY
 * that starts with `userId` and continues with the ranking — so the row kept
 * is that user's best, by the very comparison the board then ranks them with.
 * `row_number()` runs over the deduplicated set, which is why it is a second
 * CTE and not a window on the first; and it is `row_number` rather than `rank`
 * because a shared position would throw away the only tie-break that does not
 * move when a third person submits. Its result is cast to `int` because a
 * bigint crosses the driver as a `BigInt`, which no JSON response can carry.
 *
 * `passed` is in the WHERE and is not negotiable: it is the column the server
 * wrote after simulating (see the header), so "on the board" means "the server
 * ran this circuit and it reached the target".
 *
 * Every identifier below is written out at authoring time; the only values that
 * cross as parameters are the challenge id here and the limit or user id at the
 * call site, both bound by the driver rather than pasted into the text.
 */
function rankedBests(challengeId: string): Prisma.Sql {
  return Prisma.sql`
    WITH best AS (
      SELECT DISTINCT ON ("userId")
             "userId", "gateCount", "depth", "createdAt", "id"
        FROM "ChallengeSubmission"
       WHERE "challengeId" = ${challengeId} AND "passed"
       ORDER BY "userId", ${RANKING_SQL}
    ),
    ranked AS (
      SELECT "userId", "gateCount", "depth", "createdAt",
             row_number() OVER (ORDER BY ${RANKING_SQL})::int AS "rank"
        FROM best
    )
  `
}

/** One row of the ranked listing, as the driver hands it back. */
interface LeaderboardQueryRow {
  rank: number
  gateCount: number
  depth: number
  createdAt: Date
  username: string
  displayName: string | null
}

interface StandingQueryRow {
  rank: number
  gateCount: number
  depth: number
  createdAt: Date
  leaderboardOptOut: boolean
}

export function prismaChallengeRepository(
  prisma: PrismaClient
): ChallengeRepository {
  return {
    listChallenges() {
      return prisma.challenge.findMany({
        orderBy: [{ orderIndex: 'asc' }, { slug: 'asc' }],
        select: challengeRuleSelect,
      })
    },

    findChallenge(slug) {
      return prisma.challenge.findUnique({
        where: { slug },
        select: challengeRuleSelect,
      })
    },

    findChallengeWithTarget(slug) {
      return prisma.challenge.findUnique({
        where: { slug },
        select: challengeWithTargetSelect,
      })
    },

    recordSubmission(input) {
      return prisma.challengeSubmission.create({
        data: {
          challengeId: input.challengeId,
          userId: input.userId,
          circuitData: input.circuitData,
          passed: input.passed,
          fidelity: input.fidelity,
          gateCount: input.gateCount,
          depth: input.depth,
        },
        select: submissionSelect,
      })
    },

    bestSubmission({ challengeId, userId }) {
      return prisma.challengeSubmission.findFirst({
        where: { challengeId, userId, passed: true },
        orderBy: [...rankingOrder],
        select: submissionSelect,
      })
    },

    async solvedAmong({ userId, challengeIds }) {
      if (challengeIds.length === 0) return []
      const rows = await prisma.challengeSubmission.findMany({
        where: { userId, passed: true, challengeId: { in: [...challengeIds] } },
        // `distinct` rather than a group-by: the question is which challenges
        // appear at all, and a reader with forty attempts at one challenge
        // should not cost forty rows to answer it.
        distinct: ['challengeId'],
        select: { challengeId: true },
      })
      return rows.map((row) => row.challengeId)
    },

    async leaderboard({ challengeId, take }) {
      /*
       * The author through the two public *name* columns and no more — not
       * even the third byline column. Not `publicUserSelect`, which carries
       * the id and the account's own settings; and not `avatarUrl`, because a
       * rank is a name and two numbers, and an avatar on a board served to
       * anonymous readers is a third-party request and an IP address per
       * reader (`@qsim/contract`'s `LeaderboardEntryResponse` argues it).
       * The submitted circuit is not here and must never be — publishing the
       * winning circuit publishes the answer, which is the leak the target is
       * protected from arriving one attempt later.
       *
       * `NOT u."leaderboardOptOut"` is the whole of the privacy filter, and it
       * sits after `row_number()` has already run inside `ranked`. See the
       * header: it withholds the row, not the position.
       */
      const rows = await prisma.$queryRaw<LeaderboardQueryRow[]>`
        ${rankedBests(challengeId)}
        SELECT r."rank", r."gateCount", r."depth", r."createdAt",
               u."username", u."displayName"
          FROM ranked r
          JOIN "User" u ON u."id" = r."userId"
         WHERE NOT u."leaderboardOptOut"
         ORDER BY r."rank"
         LIMIT ${take}
      `
      return rows.map((row) => ({
        rank: row.rank,
        username: row.username,
        displayName: row.displayName,
        gateCount: row.gateCount,
        depth: row.depth,
        createdAt: row.createdAt,
      }))
    },

    async leaderboardStanding({ challengeId, userId }) {
      /*
       * The same ranked set, read at one row instead of the top of it — so the
       * number a reader is told is the number the table would have shown them,
       * computed the one time by the one expression.
       *
       * `::uuid` because `ChallengeSubmission.userId` is a uuid column and the
       * driver sends a bound parameter as text; without the cast Postgres has
       * no `uuid = text` operator and answers with an error rather than with
       * nothing.
       */
      const rows = await prisma.$queryRaw<StandingQueryRow[]>`
        ${rankedBests(challengeId)}
        SELECT r."rank", r."gateCount", r."depth", r."createdAt",
               u."leaderboardOptOut"
          FROM ranked r
          JOIN "User" u ON u."id" = r."userId"
         WHERE r."userId" = ${userId}::uuid
      `
      const row = rows[0]
      if (row === undefined) return null
      return {
        rank: row.rank,
        gateCount: row.gateCount,
        depth: row.depth,
        createdAt: row.createdAt,
        listed: !row.leaderboardOptOut,
      }
    },

    async upsertChallenge(seed) {
      const existing = await prisma.challenge.findUnique({
        where: { slug: seed.slug },
        select: { id: true },
      })
      const data = {
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
      await prisma.challenge.upsert({
        where: { slug: seed.slug },
        create: { slug: seed.slug, ...data },
        update: data,
      })
      return { created: existing === null }
    },
  }
}
