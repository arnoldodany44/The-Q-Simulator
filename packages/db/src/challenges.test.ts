import { describe, expect, it } from 'vitest'

import {
  challengeRuleSelect,
  challengeWithTargetSelect,
  prismaChallengeRepository,
} from './challenges.js'
import { Prisma } from './generated/prisma/client.js'
import type { PrismaClient } from './generated/prisma/client.js'

/**
 * The queries this repository makes, asserted as queries.
 *
 * The behaviour is exercised end to end by `apps/api`'s route tests against an
 * in-memory fake, so what is pinned here is what a fake could agree with while
 * production disagreed:
 *
 *   1. **Which columns leave Postgres.** Every read a browser can cause goes
 *      through `challengeRuleSelect`, which has no `targetData` in it. A
 *      projection is the leak defence closest to the data, and it is exactly
 *      the kind of thing a refactor "simplifies" into one shared select.
 *   2. **The ranking, in both of its spellings.** §3.6 says fewest gates, then
 *      least depth; the repository adds `createdAt` and then `id`, which is
 *      what makes the order total rather than merely specified. "Your best" is
 *      a Prisma `orderBy` and the board is SQL, so the two are compared
 *      against *each other* below rather than each against a copy written
 *      here.
 *   3. **Who appears, and when the filter runs.** The opt-out is applied after
 *      `row_number()`, which is the difference between hiding a name and
 *      withdrawing a result — and a leaderboard where the second was true
 *      could be climbed by asking other people to hide.
 *   4. **The seed converges rather than duplicates**, which is what makes a
 *      redeploy safe against the one shared database.
 */

interface Call {
  readonly model: string
  readonly method: string
  readonly args: Record<string, unknown>
}

/** One `$queryRaw` call, reassembled into the text and parameters it sent. */
interface RawCall {
  readonly sql: string
  readonly values: readonly unknown[]
}

function stubPrisma(
  calls: Call[],
  answers: Record<string, unknown> = {},
  raw: RawCall[] = []
) {
  const record =
    (model: string, method: string) =>
    (args: Record<string, unknown> = {}): Promise<unknown> => {
      calls.push({ model, method, args })
      return Promise.resolve(answers[`${model}.${method}`] ?? null)
    }

  return {
    challenge: {
      findMany: record('challenge', 'findMany'),
      findUnique: record('challenge', 'findUnique'),
      upsert: record('challenge', 'upsert'),
    },
    challengeSubmission: {
      create: record('challengeSubmission', 'create'),
      findFirst: record('challengeSubmission', 'findFirst'),
      findMany: record('challengeSubmission', 'findMany'),
    },
    /*
     * `Prisma.sql` is the very tag the client uses, so composing the captured
     * template through it flattens the nested fragment exactly as production
     * does — the assertions below then read the statement Postgres would.
     * Every interpolation lands in `values`, which is what makes "nothing is
     * pasted into the text" an assertion rather than a claim.
     */
    $queryRaw: (
      strings: TemplateStringsArray,
      ...values: unknown[]
    ): Promise<unknown> => {
      const composed = Prisma.sql(strings, ...values)
      raw.push({ sql: composed.sql, values: composed.values })
      return Promise.resolve(answers['$queryRaw'] ?? [])
    },
  } as unknown as PrismaClient
}

/**
 * `[{ gateCount: 'asc' }, …]` as SQL: `"gateCount" ASC, …`.
 *
 * The point of the translation is that the *test* holds neither spelling. The
 * ranking is read off the `orderBy` the repository hands Prisma for "your
 * best", turned into the form the leaderboard's SQL must use, and compared
 * against the statement that query actually sent — so the two spellings are
 * checked against each other rather than each against a copy in this file.
 */
function asSqlOrder(orderBy: readonly Record<string, string>[]): string {
  return orderBy
    .map((term) => {
      const [column, direction] = Object.entries(term)[0] as [string, string]
      return `"${column}" ${direction.toUpperCase()}`
    })
    .join(', ')
}

const USER = '11111111-1111-4111-8111-111111111111'

describe('the two projections', () => {
  it('keeps the target out of the one every listing uses', () => {
    expect(Object.keys(challengeRuleSelect)).not.toContain('targetData')
    // …and out of the prose columns, which are the English source and never
    // travel (D2 puts every user-facing word in apps/web).
    expect(Object.keys(challengeRuleSelect)).not.toContain('prompt')
    expect(Object.keys(challengeRuleSelect)).not.toContain('title')
  })

  it('adds it in exactly one place, for the path that has to compare', () => {
    expect(Object.keys(challengeWithTargetSelect)).toContain('targetData')
  })

  it('lists the ladder in order, without the answer', async () => {
    const calls: Call[] = []
    await prismaChallengeRepository(
      stubPrisma(calls, { 'challenge.findMany': [] })
    ).listChallenges()

    expect(calls[0]?.args).toMatchObject({
      orderBy: [{ orderIndex: 'asc' }, { slug: 'asc' }],
      select: challengeRuleSelect,
    })
  })

  it('reads one challenge without the answer by default', async () => {
    const calls: Call[] = []
    await prismaChallengeRepository(stubPrisma(calls)).findChallenge(
      'bell-pair'
    )
    expect(calls[0]?.args).toMatchObject({
      where: { slug: 'bell-pair' },
      select: challengeRuleSelect,
    })
  })
})

describe('recording a judged attempt', () => {
  it('writes exactly what the caller computed, and reads back the same five', async () => {
    const calls: Call[] = []
    await prismaChallengeRepository(
      stubPrisma(calls, {
        'challengeSubmission.create': {
          passed: false,
          fidelity: 0.5,
          gateCount: 3,
          depth: 2,
          createdAt: new Date(0),
        },
      })
    ).recordSubmission({
      challengeId: 'ch1',
      userId: USER,
      circuitData: { schemaVersion: 1 },
      passed: false,
      fidelity: 0.5,
      gateCount: 3,
      depth: 2,
    })

    expect(calls[0]?.args).toMatchObject({
      data: {
        challengeId: 'ch1',
        userId: USER,
        passed: false,
        fidelity: 0.5,
        gateCount: 3,
        depth: 2,
      },
    })
  })
})

describe('the ranking', () => {
  /**
   * §3.6 gives the first two keys. `createdAt` favours whoever got there
   * first — the only tie-break that does not move when a third person submits
   * — and `id` is what makes the order *total*: a timestamp is milliseconds,
   * two attempts can share one, and a comparator that can end in a tie leaves
   * the last word to the query plan.
   */
  const RANKING = [
    { gateCount: 'asc' },
    { depth: 'asc' },
    { createdAt: 'asc' },
    { id: 'asc' },
  ]

  it('orders "your best" by §3.6’s rule, and totally', async () => {
    const calls: Call[] = []
    await prismaChallengeRepository(stubPrisma(calls)).bestSubmission({
      challengeId: 'ch1',
      userId: USER,
    })

    expect(calls[0]?.args).toMatchObject({
      where: { challengeId: 'ch1', userId: USER, passed: true },
      orderBy: RANKING,
    })
  })

  it('ranks one row per person — their best, not their attempts', async () => {
    const raw: RawCall[] = []
    await prismaChallengeRepository(stubPrisma([], {}, raw)).leaderboard({
      challengeId: 'ch1',
      take: 10,
    })

    const { sql } = raw[0] ?? { sql: '' }
    // A reader with forty passing attempts is one competitor, not the top
    // forty. Deduplicated on the user, keeping the best under the ranking.
    expect(sql).toContain('DISTINCT ON ("userId")')
    expect(sql).toContain('"passed"')
  })

  it('spells the SQL ranking the same way it spells the Prisma one', async () => {
    const calls: Call[] = []
    const raw: RawCall[] = []
    const repository = prismaChallengeRepository(stubPrisma(calls, {}, raw))

    await repository.bestSubmission({ challengeId: 'ch1', userId: USER })
    await repository.leaderboard({ challengeId: 'ch1', take: 10 })

    const orderBy = (calls[0]?.args as { orderBy: Record<string, string>[] })
      .orderBy
    const expected = asSqlOrder(orderBy)
    const { sql } = raw[0] ?? { sql: '' }

    // Twice: once to choose which of a person's attempts is theirs, and once
    // to rank the people against each other. If those two ever differed, the
    // row shown would not be the row ranked.
    expect(sql).toContain(`ORDER BY "userId", ${expected}`)
    expect(sql).toContain(`row_number() OVER (ORDER BY ${expected})`)
  })

  it('assigns the rank in the database rather than by counting rows', async () => {
    const raw: RawCall[] = []
    await prismaChallengeRepository(stubPrisma([], {}, raw)).leaderboard({
      challengeId: 'ch1',
      take: 10,
    })

    // `row_number()` over the deduplicated set, not `rank()`: a shared
    // position would discard the tie-break that decides between two identical
    // answers.
    expect(raw[0]?.sql).toContain('row_number() OVER')
    expect(raw[0]?.sql).not.toContain('rank() OVER')
  })

  it('interpolates nothing into the statement text', async () => {
    const raw: RawCall[] = []
    const repository = prismaChallengeRepository(stubPrisma([], {}, raw))

    await repository.leaderboard({ challengeId: "ch1'; DROP TABLE", take: 10 })
    await repository.leaderboardStanding({ challengeId: 'ch1', userId: USER })

    for (const call of raw) {
      expect(call.sql).not.toContain('DROP TABLE')
      expect(call.sql).not.toContain(USER)
    }
    expect(raw[0]?.values).toEqual(["ch1'; DROP TABLE", 10])
    expect(raw[1]?.values).toEqual(['ch1', USER])
  })
})

describe('who appears on the board', () => {
  it('withholds an opted-out reader from the listing', async () => {
    const raw: RawCall[] = []
    await prismaChallengeRepository(stubPrisma([], {}, raw)).leaderboard({
      challengeId: 'ch1',
      take: 10,
    })

    expect(raw[0]?.sql).toContain('NOT u."leaderboardOptOut"')
  })

  /**
   * The property that makes the opt-out safe to offer: it hides a name, it
   * does not withdraw a result. If the filter ran inside the ranking CTE
   * instead, hiding would promote everybody below — a ladder you could climb
   * by asking other people to opt out.
   */
  it('filters after the rank is assigned, never before it', async () => {
    const raw: RawCall[] = []
    await prismaChallengeRepository(stubPrisma([], {}, raw)).leaderboard({
      challengeId: 'ch1',
      take: 10,
    })

    const sql = raw[0]?.sql ?? ''
    expect(sql.indexOf('row_number() OVER')).toBeLessThan(
      sql.indexOf('NOT u."leaderboardOptOut"')
    )
  })

  it('never selects a circuit onto the board', async () => {
    const raw: RawCall[] = []
    await prismaChallengeRepository(stubPrisma([], {}, raw)).leaderboard({
      challengeId: 'ch1',
      take: 10,
    })

    // Publishing the winning circuit publishes the answer — the leak the
    // target is protected from, one attempt later.
    expect(raw[0]?.sql).not.toContain('circuitData')
  })

  it('does not hide a reader’s own standing from them', async () => {
    const raw: RawCall[] = []
    await prismaChallengeRepository(
      stubPrisma([], {}, raw)
    ).leaderboardStanding({ challengeId: 'ch1', userId: USER })

    const sql = raw[0]?.sql ?? ''
    // It reads the column to report `listed`, and does not filter on it: "where
    // do I stand" is asked by the only person entitled to ask it.
    expect(sql).toContain('u."leaderboardOptOut"')
    expect(sql).not.toContain('NOT u."leaderboardOptOut"')
  })

  it('reports no standing for a reader who has never passed', async () => {
    const standing = await prismaChallengeRepository(
      stubPrisma([], { $queryRaw: [] })
    ).leaderboardStanding({ challengeId: 'ch1', userId: USER })
    expect(standing).toBeNull()
  })

  it('reports the rank the database computed, with the opt-out inverted', async () => {
    const createdAt = new Date(0)
    const standing = await prismaChallengeRepository(
      stubPrisma([], {
        $queryRaw: [
          {
            rank: 4,
            gateCount: 3,
            depth: 2,
            createdAt,
            leaderboardOptOut: true,
          },
        ],
      })
    ).leaderboardStanding({ challengeId: 'ch1', userId: USER })

    expect(standing).toEqual({
      rank: 4,
      gateCount: 3,
      depth: 2,
      createdAt,
      listed: false,
    })
  })
})

describe('which challenges a reader has solved', () => {
  it('asks nothing when the listing was empty', async () => {
    const calls: Call[] = []
    const solved = await prismaChallengeRepository(
      stubPrisma(calls)
    ).solvedAmong({ userId: USER, challengeIds: [] })
    expect(solved).toEqual([])
    expect(calls).toHaveLength(0)
  })

  it('scopes to the caller and to the ids the listing already returned', async () => {
    const calls: Call[] = []
    await prismaChallengeRepository(
      stubPrisma(calls, {
        'challengeSubmission.findMany': [{ challengeId: 'ch1' }],
      })
    ).solvedAmong({ userId: USER, challengeIds: ['ch1', 'ch2'] })

    expect(calls[0]?.args).toMatchObject({
      where: {
        userId: USER,
        passed: true,
        challengeId: { in: ['ch1', 'ch2'] },
      },
      distinct: ['challengeId'],
    })
  })
})

describe('seeding', () => {
  const seed = {
    slug: 'bell-pair',
    title: 'Bell pair',
    prompt: 'Produce the state (|00> + |11>)/sqrt(2).',
    difficulty: 2,
    qubitCount: 2,
    targetType: 'state',
    targetData: { type: 'state', qubits: 2, amplitudes: [] },
    allowedGates: ['h', 'cx'],
    maxGates: 2,
    fidelityThreshold: 0.99,
    orderIndex: 3,
  }

  it('upserts on the slug, so a redeploy converges instead of duplicating', async () => {
    const calls: Call[] = []
    const result = await prismaChallengeRepository(
      stubPrisma(calls, { 'challenge.findUnique': null })
    ).upsertChallenge(seed)

    const upsert = calls.find((call) => call.method === 'upsert')
    expect(upsert?.args).toMatchObject({ where: { slug: 'bell-pair' } })
    expect(result.created).toBe(true)
  })

  it('reports an existing row as converged rather than created', async () => {
    const calls: Call[] = []
    const result = await prismaChallengeRepository(
      stubPrisma(calls, { 'challenge.findUnique': { id: 'ch1' } })
    ).upsertChallenge(seed)
    expect(result.created).toBe(false)
  })

  it('writes the same columns on create and on update, so the two cannot drift', async () => {
    const calls: Call[] = []
    await prismaChallengeRepository(
      stubPrisma(calls, { 'challenge.findUnique': null })
    ).upsertChallenge(seed)

    const args = calls.find((call) => call.method === 'upsert')?.args as {
      create: Record<string, unknown>
      update: Record<string, unknown>
    }
    // The create carries the slug as well, because that is what identifies it.
    expect(Object.keys(args.create).sort()).toEqual(
      [...Object.keys(args.update), 'slug'].sort()
    )
  })
})
