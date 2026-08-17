import { existsSync } from 'node:fs'
import path from 'node:path'
import process from 'node:process'
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from 'vitest'
import { prismaChallengeRepository } from './challenges.js'
import type { ChallengeRepository } from './challenges.js'
import { disconnectPrismaClient, getPrismaClient } from './client.js'
import type { PrismaClient } from './generated/prisma/client.js'

/**
 * The leaderboard queries, against the real database — §3.6, Phase 3.
 *
 * ── Why this file exists at all ───────────────────────────────────────────
 *
 * `challenges.test.ts` beside it asserts the *statements* the repository
 * sends, which is the right test for a projection and the wrong one for these
 * two: the board and the standing are raw SQL, and every interesting thing
 * about them is something only Postgres can answer. Does `DISTINCT ON` keep
 * the row the ranking would have chosen. Does `row_number()` run over the
 * deduplicated set rather than the raw one. Does the `::uuid` cast make the
 * standing's join work at all, or does the driver's text parameter meet a uuid
 * column and error. Does the opt-out filter, applied outside the window, leave
 * the ranks of everybody else alone. A stub that agrees with the text agrees
 * with a broken statement just as readily.
 *
 * ── Off by default, and the reason is not timidity ────────────────────────
 *
 * This project has one Postgres, development and production are the same
 * instance, and `pnpm verify` runs constantly — so a suite that connected on
 * every run would compete with the application for the pooler's single
 * connection and would write rows into production from a pull request. Run it
 * deliberately:
 *
 *   QSIM_DB_INTEGRATION=1 pnpm --filter @qsim/db test
 *
 * ── The hygiene rules, which are not negotiable here ──────────────────────
 *
 * 1. Everything created belongs to three reserved identities whose UUIDs and
 *    e-mail addresses are recognisably this suite's and cannot collide with a
 *    real Supabase user (`.invalid` is reserved by RFC 2606), plus one
 *    challenge whose slug is reserved the same way.
 * 2. Cleanup deletes those four rows and nothing else. Submissions cascade
 *    from both the user and the challenge, so this cannot reach a row the
 *    suite did not write.
 * 3. No test reads or asserts over rows it did not create. Every query here is
 *    scoped to the reserved challenge, so a real solver's row cannot appear in
 *    an assertion — and a real challenge's board cannot be touched by one.
 */
const enabled = process.env.QSIM_DB_INTEGRATION === '1'

/*
 * Vitest does not read `.env`. Load the repo-root file the way
 * `prisma.config.ts` does, and only when this suite is going to run.
 */
if (enabled && process.env.DATABASE_URL === undefined) {
  const repoRootEnv = path.resolve(import.meta.dirname, '../../../.env')
  if (existsSync(repoRootEnv)) process.loadEnvFile(repoRootEnv)
}

/** Three solvers: two who are listed, and one who asked not to be. */
const ADA = '00000000-0000-4000-8000-0000000c0001'
const GRACE = '00000000-0000-4000-8000-0000000c0002'
const HIDDEN = '00000000-0000-4000-8000-0000000c0003'
const RESERVED_IDS = [ADA, GRACE, HIDDEN]

const SLUG = 'qsim-itest-leaderboard'

/*
 * Every test is a round trip to a shared pooler with `connection_limit=1`, so
 * its wall clock is the network's rather than the code's.
 */
vi.setConfig({ testTimeout: 60_000 })

describe.skipIf(!enabled)('the leaderboard, against Postgres', () => {
  let prisma: PrismaClient
  let repository: ChallengeRepository
  let challengeId: string

  /**
   * Removes the three reserved users and the reserved challenge. Submissions
   * carry `ON DELETE CASCADE` from both, so one delete per parent removes
   * exactly what this file wrote and can reach nothing else.
   */
  async function cleanup(): Promise<void> {
    await prisma.challengeSubmission.deleteMany({
      where: { userId: { in: RESERVED_IDS } },
    })
    await prisma.user.deleteMany({ where: { id: { in: RESERVED_IDS } } })
    await prisma.challenge.deleteMany({ where: { slug: SLUG } })
  }

  async function addUser(id: string, optOut = false): Promise<void> {
    await prisma.user.create({
      data: {
        id,
        email: `qsim-itest-${id.slice(-4)}@example.invalid`,
        username: `qsim-itest-${id.slice(-4)}`,
        leaderboardOptOut: optOut,
      },
    })
  }

  /**
   * One judged attempt. The figures are handed in rather than computed,
   * because what is under test here is the ordering and not the physics —
   * `apps/api` owns the claim that these numbers come from the engine.
   */
  async function submit(
    userId: string,
    figures: {
      gateCount: number
      depth: number
      passed?: boolean
      createdAt?: Date
    }
  ): Promise<void> {
    await prisma.challengeSubmission.create({
      data: {
        challengeId,
        userId,
        circuitData: { schemaVersion: 1 },
        passed: figures.passed ?? true,
        fidelity: 1,
        gateCount: figures.gateCount,
        depth: figures.depth,
        ...(figures.createdAt === undefined
          ? {}
          : { createdAt: figures.createdAt }),
      },
    })
  }

  beforeAll(async () => {
    prisma = getPrismaClient()
    repository = prismaChallengeRepository(prisma)
    // A previous run that crashed mid-test would otherwise leave rows behind
    // and make the first assertion fail for the wrong reason.
    await cleanup()
  })

  beforeEach(async () => {
    const challenge = await prisma.challenge.create({
      data: {
        slug: SLUG,
        title: 'Integration leaderboard',
        prompt: 'Not a real challenge. Written and removed by this suite.',
        difficulty: 1,
        qubitCount: 1,
        targetType: 'state',
        targetData: { type: 'state', qubits: 1, amplitudes: [] },
        allowedGates: [],
        maxGates: null,
        fidelityThreshold: 0.99,
        orderIndex: 0,
      },
      select: { id: true },
    })
    challengeId = challenge.id
    await addUser(ADA)
    await addUser(GRACE)
    await addUser(HIDDEN, true)
  })

  afterEach(cleanup)

  afterAll(async () => {
    await disconnectPrismaClient()
  })

  it('gives one person one row, however many times they solved it', async () => {
    await submit(ADA, { gateCount: 5, depth: 4 })
    await submit(ADA, { gateCount: 2, depth: 2 })
    await submit(ADA, { gateCount: 3, depth: 1 })
    await submit(GRACE, { gateCount: 4, depth: 3 })

    const board = await repository.leaderboard({ challengeId, take: 10 })

    expect(board).toHaveLength(2)
    // Ada's best is the two-gate one, not her latest and not her deepest-cut.
    expect(board[0]).toMatchObject({ rank: 1, gateCount: 2, depth: 2 })
    expect(board[1]).toMatchObject({ rank: 2, gateCount: 4, depth: 3 })
  })

  it('breaks a tie on gates with depth, exactly as §3.6 says', async () => {
    await submit(ADA, { gateCount: 3, depth: 3 })
    await submit(GRACE, { gateCount: 3, depth: 2 })

    const board = await repository.leaderboard({ challengeId, take: 10 })
    expect(board.map((row) => row.depth)).toEqual([2, 3])
  })

  it('ignores attempts the server judged as failures', async () => {
    await submit(ADA, { gateCount: 1, depth: 1, passed: false })
    await submit(GRACE, { gateCount: 9, depth: 9 })

    const board = await repository.leaderboard({ challengeId, take: 10 })
    expect(board).toHaveLength(1)
    expect(board[0]).toMatchObject({ rank: 1, gateCount: 9 })
  })

  it('is stable across identical requests when two attempts share a moment', async () => {
    // The same millisecond on both rows, which is what `id` in the ordering
    // exists for: without it the last word belongs to the query plan.
    const moment = new Date('2026-01-01T00:00:00.000Z')
    await submit(ADA, { gateCount: 3, depth: 2, createdAt: moment })
    await submit(GRACE, { gateCount: 3, depth: 2, createdAt: moment })

    const first = await repository.leaderboard({ challengeId, take: 10 })
    const second = await repository.leaderboard({ challengeId, take: 10 })
    expect(second.map((row) => row.username)).toEqual(
      first.map((row) => row.username)
    )
  })

  it('withholds an opted-out name and leaves everybody else’s rank alone', async () => {
    await submit(HIDDEN, { gateCount: 1, depth: 1 })
    await submit(ADA, { gateCount: 2, depth: 2 })
    await submit(GRACE, { gateCount: 3, depth: 3 })

    const board = await repository.leaderboard({ challengeId, take: 10 })

    expect(board).toHaveLength(2)
    // Ada is second and stays second. Hiding cannot promote anybody.
    expect(board.map((row) => row.rank)).toEqual([2, 3])
    expect(board.map((row) => row.gateCount)).toEqual([2, 3])
  })

  it('tells a hidden reader where they stand', async () => {
    await submit(HIDDEN, { gateCount: 1, depth: 1 })
    await submit(ADA, { gateCount: 2, depth: 2 })

    const standing = await repository.leaderboardStanding({
      challengeId,
      userId: HIDDEN,
    })

    expect(standing).toMatchObject({
      rank: 1,
      gateCount: 1,
      depth: 1,
      listed: false,
    })
  })

  it('gives a listed reader the rank the table shows for them', async () => {
    await submit(ADA, { gateCount: 1, depth: 1 })
    await submit(GRACE, { gateCount: 2, depth: 2 })

    const board = await repository.leaderboard({ challengeId, take: 10 })
    const standing = await repository.leaderboardStanding({
      challengeId,
      userId: GRACE,
    })

    const row = board.find((entry) => entry.gateCount === 2)
    expect(standing?.rank).toBe(row?.rank)
    expect(standing?.listed).toBe(true)
  })

  it('reports no standing for somebody who has not solved it', async () => {
    await submit(ADA, { gateCount: 1, depth: 1 })

    const standing = await repository.leaderboardStanding({
      challengeId,
      userId: GRACE,
    })
    expect(standing).toBeNull()
  })

  it('takes a page of rows a reader can see, not a page minus the hidden ones', async () => {
    await submit(HIDDEN, { gateCount: 1, depth: 1 })
    await submit(ADA, { gateCount: 2, depth: 2 })
    await submit(GRACE, { gateCount: 3, depth: 3 })

    const board = await repository.leaderboard({ challengeId, take: 2 })
    expect(board).toHaveLength(2)
  })

  it('leaves nothing behind', async () => {
    await submit(ADA, { gateCount: 1, depth: 1 })
    await cleanup()

    const rows = await prisma.challengeSubmission.count({
      where: { userId: { in: RESERVED_IDS } },
    })
    const users = await prisma.user.count({
      where: { id: { in: RESERVED_IDS } },
    })
    const challenges = await prisma.challenge.count({ where: { slug: SLUG } })
    expect([rows, users, challenges]).toEqual([0, 0, 0])
  })
})
