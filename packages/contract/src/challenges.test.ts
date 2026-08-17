import { describe, expect, it } from 'vitest'

import {
  CHALLENGE_SLUGS,
  ChallengeSlugParams,
  LeaderboardQuerySchema,
  MAX_CHALLENGE_SLUG_LENGTH,
  MAX_LEADERBOARD_LIMIT,
  SubmitChallengeBody,
  isChallengeSlug,
  wireChallengeResponses,
} from './challenges.js'
import { challengePath } from './paths.js'

/**
 * The challenge contract, and the two properties that are the whole reason it
 * is written this way: the target never appears in it, and neither does prose.
 */

describe('what a challenge response may carry', () => {
  const body = {
    slug: 'bell-pair',
    difficulty: 2,
    qubitCount: 2,
    targetType: 'state' as const,
    allowedGates: ['cx', 'h'],
    maxGates: 2,
    fidelityThreshold: 0.99,
    orderIndex: 3,
  }

  it('parses the whole of a challenge card', () => {
    expect(wireChallengeResponses.ChallengeResponse.parse(body)).toEqual(body)
  })

  /*
   * THE LEAK TEST, at the level of the schema. Fastify serialises through
   * these objects, so a field that is not declared here cannot leave the
   * server even if a handler puts it on the object it returns — which is the
   * belt this route wears beside the braces of never projecting the column.
   */
  it('strips a target somebody put on the object anyway', () => {
    const parsed = wireChallengeResponses.ChallengeResponse.parse({
      ...body,
      targetData: { amplitudes: [[1, 0]] },
      target: 'anything',
      prompt: 'Build a Bell pair.',
      title: 'Bell pair',
    })
    expect(parsed).toEqual(body)
    expect(Object.keys(parsed)).not.toContain('targetData')
    expect(Object.keys(parsed)).not.toContain('prompt')
  })

  it('has no field for prose at all', () => {
    const shape = Object.keys(
      wireChallengeResponses.ChallengeResponse.shape
    ).sort()
    expect(shape).toEqual([
      'allowedGates',
      'difficulty',
      'fidelityThreshold',
      'maxGates',
      'orderIndex',
      'qubitCount',
      'slug',
      'targetType',
    ])
  })

  it('refuses a target type nobody implemented', () => {
    expect(
      wireChallengeResponses.ChallengeResponse.safeParse({
        ...body,
        targetType: 'hamiltonian',
      }).success
    ).toBe(false)
  })
})

describe('the submission body', () => {
  /*
   * The property risk 5 turns on, asserted at the boundary the request first
   * crosses: a claim about the result is not part of the request, so it is
   * gone before any handler could believe it.
   */
  it('keeps the circuit and drops every claim about the result', () => {
    const parsed = SubmitChallengeBody.parse({
      circuit: { schemaVersion: 1, qubits: 1, operations: [] },
      passed: true,
      fidelity: 1,
      gateCount: 1,
      depth: 1,
    })
    expect(Object.keys(parsed)).toEqual(['circuit'])
  })

  it('does not judge the circuit itself — @qsim/schema does that', () => {
    expect(SubmitChallengeBody.safeParse({ circuit: 'nonsense' }).success).toBe(
      true
    )
  })
})

describe('the leaderboard', () => {
  it('defaults and caps the row count', () => {
    expect(LeaderboardQuerySchema.parse({}).limit).toBe(10)
    expect(
      LeaderboardQuerySchema.safeParse({ limit: MAX_LEADERBOARD_LIMIT + 1 })
        .success
    ).toBe(false)
  })

  /**
   * A name and two numbers, and there is nowhere to put anything else.
   *
   * `avatarUrl` used to be on this list. Nothing rendered it — the board draws
   * `displayName ?? username` and reads no other field — but it was selected
   * from Postgres, serialised, and sent to every anonymous reader of every
   * board. §3.6 decision 5 says a row is "un nombre y dos números", and
   * `embed.ts` omits the same field from the embed projection on the stated
   * ground that it is "una petición a un tercero, y una dirección IP, por cada
   * lector". A leaderboard is the one public listing of *people*, so the
   * argument applies with more force here than there.
   */
  it('publishes a rank and a name, never an address or the winning circuit', () => {
    const shape = Object.keys(
      wireChallengeResponses.LeaderboardEntryResponse.shape
    ).sort()
    expect(shape).toEqual([
      'createdAt',
      'depth',
      'displayName',
      'gateCount',
      'rank',
      'username',
    ])
  })

  /**
   * A rank is a position over everybody who solved the challenge, assigned
   * before the readers who asked not to be listed were removed — so a page can
   * legitimately start at 2 and skip 3. The schema must not narrow it into
   * "the index of this row", which is what a `1`-based sequential check would
   * quietly assume.
   */
  it('accepts a page whose ranks skip the withheld', () => {
    const page = {
      entries: [
        {
          rank: 2,
          username: 'ada',
          displayName: null,
          avatarUrl: null,
          gateCount: 3,
          depth: 2,
          createdAt: '2026-01-01T00:00:00.000Z',
        },
        {
          rank: 5,
          username: 'grace',
          displayName: null,
          avatarUrl: null,
          gateCount: 4,
          depth: 3,
          createdAt: '2026-01-01T00:00:00.000Z',
        },
      ],
      standing: null,
    }
    const parsed = wireChallengeResponses.LeaderboardResponse.parse(page)
    expect(parsed.entries.map((entry) => entry.rank)).toEqual([2, 5])
  })

  /**
   * The reader's own line. It carries the figures as well as the rank so the
   * highlighted row and the sentence under the table come from one read, and
   * `listed` is what lets a withheld reader be told where they stand without
   * being shown to anybody else.
   */
  it('carries the viewer’s own standing, and no circuit there either', () => {
    const shape = Object.keys(
      wireChallengeResponses.LeaderboardStandingResponse.shape
    ).sort()
    expect(shape).toEqual(['createdAt', 'depth', 'gateCount', 'listed', 'rank'])
  })

  it('treats an absent standing as a real answer', () => {
    // Anonymous, and "signed in but has not solved it", are the same answer to
    // "where do you stand": nowhere yet.
    const parsed = wireChallengeResponses.LeaderboardResponse.parse({
      entries: [],
      standing: null,
    })
    expect(parsed.standing).toBeNull()
  })
})

describe('the slug vocabulary', () => {
  it.each(CHALLENGE_SLUGS)('%s is a well-formed path segment', (slug) => {
    expect(ChallengeSlugParams.safeParse({ slug }).success).toBe(true)
  })

  it('has no duplicates and is what the ladder is ordered by', () => {
    expect(new Set(CHALLENGE_SLUGS).size).toBe(CHALLENGE_SLUGS.length)
  })

  it.each([
    ['Bell-Pair', 'an uppercase letter'],
    ['bell pair', 'a space'],
    ['../etc/passwd', 'a path'],
    ['-leading', 'a leading hyphen'],
    ['', 'nothing at all'],
  ])('refuses "%s" (%s)', (slug) => {
    expect(ChallengeSlugParams.safeParse({ slug }).success).toBe(false)
  })

  it('refuses a slug longer than the column should hold', () => {
    const long = 'a'.repeat(MAX_CHALLENGE_SLUG_LENGTH + 1)
    expect(ChallengeSlugParams.safeParse({ slug: long }).success).toBe(false)
  })

  /*
   * The narrowing a client applies before rendering prose, for the reason
   * `isApiErrorCode` exists: an API seeded ahead of this bundle must not put a
   * raw i18n key on the page.
   */
  it('narrows an unknown slug rather than trusting it', () => {
    expect(isChallengeSlug('bell-pair')).toBe(true)
    expect(isChallengeSlug('a-challenge-from-the-future')).toBe(false)
    expect(isChallengeSlug(7)).toBe(false)
  })
})

describe('challengePath', () => {
  it('builds all four routes, encoding the segment', () => {
    expect(challengePath.collection()).toBe('/challenges')
    expect(challengePath.item('bell-pair')).toBe('/challenges/bell-pair')
    expect(challengePath.submit('bell-pair')).toBe(
      '/challenges/bell-pair/submit'
    )
    expect(challengePath.leaderboard('a/b')).toBe(
      '/challenges/a%2Fb/leaderboard'
    )
  })

  it('never leaves Fastify parameter notation in a built path', () => {
    for (const path of [
      challengePath.collection(),
      challengePath.item('x'),
      challengePath.submit('x'),
      challengePath.leaderboard('x'),
    ]) {
      expect(path).not.toMatch(/:[A-Za-z]/)
    }
  })
})
