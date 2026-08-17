/**
 * Challenge mode, end to end — §3.6, §8, §4, risk 5.
 *
 * The real Fastify instance, the real auth policy, the real Zod compilers, the
 * real engine. What is substituted is Postgres, for the reason
 * `testing/circuit-repository.ts` sets out at length — and the fake models the
 * two things that matter here: the projection that keeps the target off every
 * browser-reachable read, and §3.6's ranking.
 *
 * Six properties, in descending order of what a bug in them would cost:
 *
 *   1. **A client that lies gains nothing.** A submission carrying a claim
 *      about its own fidelity, gate count, depth and pass/fail is stored with
 *      the values the server computed. This is risk 5, and it is the first test
 *      below.
 *   2. **The leaderboard ranks what was stored.** The other half of the same
 *      claim, and the half a position is worth lying for: a correct circuit
 *      wrapped in a claim that it is one gate long is ranked at its true
 *      length. Asserted through the HTTP surface rather than the row, because
 *      that is where a second reading of the request body could creep in.
 *   3. **The target does not leak.** Every response body of every route is
 *      searched for the amplitudes of the seeded target.
 *   4. **The comparisons are right**, including the traps: global phase for a
 *      state and for a unitary, and a truth table that says what it checked.
 *   5. **The constraints are enforced server-side** — allowed gates through a
 *      custom-gate wrapper, the gate budget, the register.
 *   6. **The board is a listing of people, so it is the narrowest one.** One
 *      row per person, no address, no circuit, and a reader who has withdrawn
 *      their name is withheld without anybody else moving up.
 */

import { CHALLENGE_SLUGS } from '@qsim/contract'
import { CIRCUIT_SCHEMA_VERSION } from '@qsim/schema'
import type { Circuit, Operation } from '@qsim/schema'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { CHALLENGES } from '../challenges/catalog.js'
import { seedChallenges } from '../challenges/seed.js'
import type { ApiInstance } from '../app.js'
import { createTestApp } from '../testing/app.js'
import { createMemoryCircuitRepository } from '../testing/circuit-repository.js'
import type { MemoryCircuitRepository } from '../testing/circuit-repository.js'
import {
  createSigningKey,
  createTestJwksCache,
  signToken,
  stubJwksEndpoint,
} from '../testing/tokens.js'

const LEARNER_ID = '55555555-5555-4555-8555-555555555555'
const RIVAL_ID = '66666666-6666-4666-8666-666666666666'

const listPath = '/api/v1/challenges'
const itemPath = (slug: string): string => `/api/v1/challenges/${slug}`
const submitPath = (slug: string): string => `/api/v1/challenges/${slug}/submit`
const boardPath = (slug: string): string =>
  `/api/v1/challenges/${slug}/leaderboard`

interface Harness {
  app: ApiInstance
  repository: MemoryCircuitRepository
  learner: Record<string, string>
  rival: Record<string, string>
}

let harness: Harness

beforeEach(async () => {
  const key = await createSigningKey('key-1')
  const repository = createMemoryCircuitRepository()
  // The real seed, with targets the real engine computed. Nothing in this file
  // types an amplitude.
  await seedChallenges(repository)

  const app = await createTestApp({
    jwks: createTestJwksCache(stubJwksEndpoint([key])),
    circuits: { repository },
  })
  await app.ready()

  harness = {
    app,
    repository,
    learner: {
      authorization: `Bearer ${await signToken(key, {
        subject: LEARNER_ID,
        email: 'learner@example.com',
        userMetadata: { user_name: 'learner' },
      })}`,
    },
    rival: {
      authorization: `Bearer ${await signToken(key, {
        subject: RIVAL_ID,
        email: 'rival@example.com',
        userMetadata: { user_name: 'rival' },
      })}`,
    },
  }
})

afterEach(async () => {
  await harness.app.close()
})

function op(
  id: string,
  gate: string,
  targets: number[],
  column: number,
  extra: Partial<Operation> = {}
): Operation {
  return { id, gate, targets, column, ...extra }
}

function circuit(qubits: number, operations: Operation[]): Circuit {
  return {
    schemaVersion: CIRCUIT_SCHEMA_VERSION,
    qubits,
    clbits: 0,
    operations,
  }
}

interface SubmissionBody {
  submission: {
    passed: boolean
    fidelity: number
    gateCount: number
    depth: number
  }
  feedback: { code: string; value: number | null; gate: string | null }[]
}

function submit(
  slug: string,
  payload: Record<string, unknown>,
  headers: Record<string, string> = harness.learner
) {
  return harness.app.inject({
    method: 'POST',
    url: submitPath(slug),
    headers,
    payload,
  })
}

async function verdictOf(
  slug: string,
  document: Circuit,
  headers: Record<string, string> = harness.learner
): Promise<SubmissionBody> {
  const response = await submit(slug, { circuit: document }, headers)
  expect(response.statusCode, response.body).toBe(201)
  return JSON.parse(response.body) as SubmissionBody
}

const codesOf = (body: SubmissionBody): string[] =>
  body.feedback.map((entry) => entry.code)

interface BoardBody {
  entries: {
    rank: number
    username: string
    gateCount: number
    depth: number
  }[]
  standing: {
    rank: number
    gateCount: number
    depth: number
    listed: boolean
  } | null
}

/**
 * Gives the two fixtures the handles the assertions below name.
 *
 * `ensureUser` derives a handle from the display name and a random suffix, and
 * these identities have no display name — so left alone they become
 * `user-9arm`, and an assertion about *whose* row appears could not be
 * written. Registering the row first is the same path a returning user takes:
 * `ensureUser` finds it by id and creates nothing.
 */
function nameTheContestants(): void {
  harness.repository.addUser({ id: LEARNER_ID, username: 'learner' })
  harness.repository.addUser({ id: RIVAL_ID, username: 'rival' })
}

/**
 * The board for `bell-pair`, as one caller sees it. Anonymous unless a token
 * is handed in, which is the difference between "who is winning" and "who is
 * winning, and where am I".
 */
async function boardOf(
  headers: Record<string, string> = {},
  query = ''
): Promise<BoardBody> {
  const response = await harness.app.inject({
    method: 'GET',
    url: `${boardPath('bell-pair')}${query}`,
    headers,
  })
  expect(response.statusCode, response.body).toBe(200)
  return JSON.parse(response.body) as BoardBody
}

/* ════════════════════════════════════════════════════════════════════════ */

describe('a client that lies about its own submission', () => {
  /**
   * THE TEST RISK 5 EXISTS FOR.
   *
   * The body carries a claim about every figure the row holds — passed,
   * fidelity, gateCount, depth — and every one of them is wrong. The circuit is
   * a five-gate answer to a challenge whose budget is two, and it is not even
   * the right state.
   */
  it('is stored with the truth, on every field at once', async () => {
    const wrong = circuit(2, [
      op('a', 'x', [0], 0),
      op('b', 'x', [0], 1),
      op('c', 'x', [0], 2),
      op('d', 'x', [0], 3),
      op('e', 'x', [0], 4),
    ])

    const response = await submit('bell-pair', {
      circuit: wrong,
      passed: true,
      fidelity: 1,
      gateCount: 1,
      depth: 1,
      submission: { passed: true, fidelity: 1 },
    })
    expect(response.statusCode).toBe(201)

    const stored = harness.repository.allChallengeSubmissions()
    expect(stored).toHaveLength(1)
    const row = stored[0]

    // Five X gates on one wire: five gates, depth five, and |00> untouched by
    // an even… no — five is odd, so the state is |01>, orthogonal to the Bell
    // pair. Every figure below was recomputed here.
    expect(row?.passed).toBe(false)
    expect(row?.gateCount).toBe(5)
    expect(row?.depth).toBe(5)
    expect(row?.fidelity).toBeCloseTo(0, 12)

    // And the response says the same thing the row does.
    const body = JSON.parse(response.body) as SubmissionBody
    expect(body.submission).toMatchObject({
      passed: false,
      gateCount: 5,
      depth: 5,
    })
  })

  it('cannot forge a pass on a challenge it did not solve', async () => {
    await submit('bell-pair', {
      circuit: circuit(2, [op('a', 'h', [0], 0)]),
      passed: true,
      fidelity: 0.999999,
    })
    expect(harness.repository.allChallengeSubmissions()[0]?.passed).toBe(false)

    // …and the ladder agrees, which is the surface a leaderboard is built on.
    const list = await harness.app.inject({
      method: 'GET',
      url: listPath,
      headers: harness.learner,
    })
    expect(
      (JSON.parse(list.body) as { solved: string[] }).solved
    ).not.toContain('bell-pair')
  })

  /*
   * The other half of the same claim: a *correct* circuit wrapped in a lie
   * about its size, which is what a leaderboard position is worth lying for.
   * The gate count is recomputed over the expanded circuit, so packaging the
   * answer in a block does not shrink it either.
   */
  it('cannot shrink its gate count, by claiming or by packaging', async () => {
    const packaged: Circuit = {
      ...circuit(2, [op('a', 'bell', [0, 1], 0)]),
      customGates: {
        bell: {
          qubits: 2,
          operations: [
            op('cg1', 'h', [0], 0),
            op('cg2', 'cx', [1], 1, { controls: [0] }),
          ],
        },
      },
    }
    const body = await verdictOf('bell-pair', packaged)
    expect(body.submission.passed).toBe(true)
    // One operation in the document, two gates in the circuit.
    expect(body.submission.gateCount).toBe(2)
    expect(harness.repository.allChallengeSubmissions()[0]?.gateCount).toBe(2)
  })
})

describe('the target does not leak', () => {
  /**
   * The Bell target's amplitude is 1/sqrt(2) = 0.7071067811865476, rounded by
   * the seed to twelve decimals. If any response carries the target, that
   * number is in the body — so this greps rather than asserting a field is
   * absent, which would only catch the field somebody thought of.
   */
  const TELLTALE = '0.707106781187'

  it('is absent from every browser-reachable response', async () => {
    const submission = await submit('bell-pair', {
      circuit: circuit(2, [
        op('a', 'h', [0], 0),
        op('b', 'cx', [1], 1, { controls: [0] }),
      ]),
    })

    const responses = [
      await harness.app.inject({ method: 'GET', url: listPath }),
      await harness.app.inject({ method: 'GET', url: itemPath('bell-pair') }),
      await harness.app.inject({ method: 'GET', url: boardPath('bell-pair') }),
      submission,
    ]

    for (const response of responses) {
      expect(response.body).not.toContain(TELLTALE)
      expect(response.body).not.toContain('targetData')
      expect(response.body).not.toContain('amplitudes')
    }
  })

  it('sends the rules a learner needs and nothing else', async () => {
    const response = await harness.app.inject({
      method: 'GET',
      url: itemPath('bell-pair'),
    })
    const body = JSON.parse(response.body) as {
      challenge: Record<string, unknown>
    }
    expect(Object.keys(body.challenge).sort()).toEqual([
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

  it('does not publish the winning circuit on the leaderboard either', async () => {
    await verdictOf(
      'bell-pair',
      circuit(2, [
        op('a', 'h', [0], 0),
        op('b', 'cx', [1], 1, { controls: [0] }),
      ])
    )
    const board = await harness.app.inject({
      method: 'GET',
      url: boardPath('bell-pair'),
    })
    expect(board.body).not.toContain('operations')
    expect(board.body).not.toContain('circuitData')
  })
})

describe('the ladder', () => {
  it('lists every seeded challenge in curriculum order', async () => {
    const response = await harness.app.inject({ method: 'GET', url: listPath })
    expect(response.statusCode).toBe(200)
    const body = JSON.parse(response.body) as {
      items: { slug: string; orderIndex: number }[]
      solved: string[]
    }
    expect(body.items.map((item) => item.slug)).toEqual([...CHALLENGE_SLUGS])
    expect(body.solved).toEqual([])
  })

  it('answers an anonymous caller, because a puzzle behind a sign-up is unseen', async () => {
    const response = await harness.app.inject({ method: 'GET', url: listPath })
    expect(response.statusCode).toBe(200)
  })

  it('404s a slug nobody seeded', async () => {
    const response = await harness.app.inject({
      method: 'GET',
      url: itemPath('not-a-challenge'),
    })
    expect(response.statusCode).toBe(404)
  })

  it('marks what this caller has solved, and only this caller', async () => {
    await verdictOf(
      'superposition',
      circuit(1, [op('a', 'h', [0], 0)]),
      harness.learner
    )

    const mine = await harness.app.inject({
      method: 'GET',
      url: listPath,
      headers: harness.learner,
    })
    expect((JSON.parse(mine.body) as { solved: string[] }).solved).toEqual([
      'superposition',
    ])

    const theirs = await harness.app.inject({
      method: 'GET',
      url: listPath,
      headers: harness.rival,
    })
    expect((JSON.parse(theirs.body) as { solved: string[] }).solved).toEqual([])
  })
})

describe('every reference circuit in the catalog', () => {
  /**
   * The catalog's own promise, checked: a challenge whose target was computed
   * from a circuit that the validator then refuses would be unsolvable, and
   * nothing else in the system would notice.
   *
   * Four references are excluded from their own challenge's allowed set on
   * purpose — `z`, `cx`, `swap` and `ccx` — because for those four the puzzle
   * *is* to rebuild the operation without them. Writing the reference out is
   * therefore refused, and refused WITHOUT A SCORE: a fidelity answered for a
   * circuit built from forbidden gates is a fidelity answered for any probe at
   * all, which is the oracle `challenges/validate.ts` closes. So `fidelity` is
   * asserted to be zero for those four rather than one, which is the opposite
   * of what this test used to require.
   */
  const REBUILD = new Set([
    'hadamard-conjugation',
    'cnot-reversed',
    'swap-from-cnots',
    'toffoli-truth-table',
  ])

  it.each(CHALLENGES.map((entry) => entry.slug))(
    '%s is solved by its own reference, or refuses it unscored',
    async (slug) => {
      const definition = CHALLENGES.find((entry) => entry.slug === slug)
      const body = await verdictOf(slug, definition!.reference)
      if (REBUILD.has(slug)) {
        expect(body.submission.passed).toBe(false)
        expect(body.submission.fidelity).toBe(0)
        expect(codesOf(body)).toContain('not-scored')
        expect(codesOf(body)).toContain('gate-not-allowed')
        return
      }
      expect(body.submission.fidelity).toBeCloseTo(1, 9)
      expect(body.submission.passed).toBe(true)
    }
  )
})

describe('a state target, up to global phase', () => {
  /**
   * THE TRAP THIS SUITE EXISTS FOR.
   *
   * The reference for `minus-state` is X then H, which is |->. This submission
   * is H, Z, X: H gives |+>, Z gives |->, and X gives **minus** |-> — the same
   * physical state with every amplitude negated. No measurement in any basis
   * distinguishes the two, so a validator that failed this would be wrong about
   * physics rather than strict.
   */
  it('accepts a solution differing by an overall factor', async () => {
    const negated = circuit(1, [
      op('a', 'h', [0], 0),
      op('b', 'z', [0], 1),
      op('c', 'x', [0], 2),
    ])
    const body = await verdictOf('minus-state', negated)
    expect(body.submission.fidelity).toBeCloseTo(1, 9)
    expect(body.submission.passed).toBe(true)
    // And the difference is named rather than left for the reader to chase
    // through their amplitude table.
    expect(codesOf(body)).toContain('global-phase-ignored')
  })

  it('calls a correct answer correct even when it is too long', async () => {
    // H then five Zs: Z^5 = Z, so this is |-> exactly — in six gates, against
    // a budget of three.
    const long = circuit(1, [
      op('a', 'h', [0], 0),
      op('b', 'z', [0], 1),
      op('c', 'z', [0], 2),
      op('d', 'z', [0], 3),
      op('e', 'z', [0], 4),
      op('f', 'z', [0], 5),
    ])
    const body = await verdictOf('minus-state', long)
    expect(body.submission.fidelity).toBeCloseTo(1, 9)
    expect(body.submission.passed).toBe(false)
    expect(codesOf(body)).toContain('gate-budget-exceeded')
  })

  /**
   * The other half of the same idea, and the sentence the brief asks for:
   * "your state has the right magnitudes but the wrong relative phase".
   */
  it('tells a learner whose magnitudes are right and whose phase is not', async () => {
    const plus = circuit(1, [op('a', 'h', [0], 0)])
    const body = await verdictOf('minus-state', plus)
    expect(body.submission.passed).toBe(false)
    expect(codesOf(body)).toContain('relative-phase')
  })

  it('names a missing entanglement rather than only a number', async () => {
    const product = circuit(2, [op('a', 'h', [0], 0), op('b', 'h', [1], 1)])
    const body = await verdictOf('bell-pair', product)
    expect(body.submission.passed).toBe(false)
    expect(codesOf(body)).toContain('entanglement-missing')
  })

  it('says when the answer is orthogonal to the target', async () => {
    // |01> has no overlap at all with (|00> + |11>)/sqrt(2).
    const body = await verdictOf(
      'bell-pair',
      circuit(2, [op('a', 'x', [0], 0)])
    )
    expect(body.submission.fidelity).toBe(0)
    expect(codesOf(body)).toContain('orthogonal')
  })
})

describe('a unitary target', () => {
  it('accepts H·X·H as Z, which a state target could not have asked', async () => {
    const body = await verdictOf(
      'hadamard-conjugation',
      circuit(1, [
        op('a', 'h', [0], 0),
        op('b', 'x', [0], 1),
        op('c', 'h', [0], 2),
      ])
    )
    expect(body.submission.passed).toBe(true)
    expect(body.submission.gateCount).toBe(3)
  })

  it('rejects a circuit that agrees with the target only on |0>', async () => {
    // The identity sends |0> to |0>, exactly as Z does — and is not Z.
    const body = await verdictOf(
      'hadamard-conjugation',
      circuit(1, [op('a', 'h', [0], 0), op('b', 'h', [0], 1)])
    )
    expect(body.submission.passed).toBe(false)
  })

  it('accepts the three-CNOT swap', async () => {
    const body = await verdictOf(
      'swap-from-cnots',
      circuit(2, [
        op('a', 'cx', [1], 0, { controls: [0] }),
        op('b', 'cx', [0], 1, { controls: [1] }),
        op('c', 'cx', [1], 2, { controls: [0] }),
      ])
    )
    expect(body.submission.passed).toBe(true)
    expect(body.submission.gateCount).toBe(3)
  })

  it('accepts the Hadamard sandwich that turns a CZ into the reversed CNOT', async () => {
    const body = await verdictOf(
      'cnot-reversed',
      circuit(2, [
        op('a', 'h', [0], 0),
        op('b', 'cz', [1], 1, { controls: [0] }),
        op('c', 'h', [0], 2),
      ])
    )
    expect(body.submission.passed).toBe(true)
    expect(body.submission.gateCount).toBe(3)
  })

  /**
   * The cheat this challenge used to permit, pinned so it cannot come back.
   *
   * The target IS the reversed CNOT, so a bare `cx` with control 1 reproduces
   * it exactly — one gate, depth one, fidelity one, and rank 1 on a board
   * nobody who does the exercise can ever beat. Both directions of a CNOT are
   * spelled `cx`, so the only thing that can refuse it is `cx` being outside
   * the allowed set, which is what the catalog now says.
   */
  it('refuses the one-gate answer that simply writes the target out', async () => {
    const body = await verdictOf(
      'cnot-reversed',
      circuit(2, [op('a', 'cx', [0], 0, { controls: [1] })])
    )
    expect(body.submission.passed).toBe(false)
    expect(body.submission.fidelity).toBe(0)
    expect(codesOf(body)).toContain('not-scored')
    expect(
      body.feedback.find((entry) => entry.code === 'gate-not-allowed')?.gate
    ).toBe('cx')
  })
})

describe('a truth table', () => {
  it('refuses the forbidden `ccx` without scoring it', async () => {
    /*
     * The reference uses `ccx`, which the challenge does not allow. It used to
     * be scored anyway — fidelity 1, `basis-states-only`, passed false — and
     * that is precisely the shape of the oracle: any gate at all, and a
     * reading of the target back. Now it is refused before anything runs.
     */
    const solved = await verdictOf(
      'toffoli-truth-table',
      circuit(3, [op('a', 'ccx', [2], 0, { controls: [0, 1] })])
    )
    expect(solved.submission.fidelity).toBe(0)
    expect(codesOf(solved)).toContain('not-scored')
    expect(codesOf(solved)).not.toContain('basis-states-only')
  })

  it('says what it checked, whenever it checked anything', async () => {
    const wrong = await verdictOf(
      'toffoli-truth-table',
      circuit(3, [op('a', 'cx', [2], 0, { controls: [0] })])
    )
    expect(codesOf(wrong)).toContain('basis-states-only')
    expect(codesOf(wrong)).toContain('rows-wrong')
  })

  it('scores the worst row rather than the average', async () => {
    // Correct on six of the eight inputs, and this must not read as 0.75.
    const body = await verdictOf(
      'toffoli-truth-table',
      circuit(3, [op('a', 'i', [0], 0)])
    )
    expect(body.submission.fidelity).toBe(0)
  })

  it('names a row that landed on a superposition rather than a bit', async () => {
    const body = await verdictOf(
      'toffoli-truth-table',
      circuit(3, [op('a', 'h', [2], 0)])
    )
    expect(codesOf(body)).toContain('row-not-a-basis-state')
  })
})

describe('the constraints, enforced on the server', () => {
  it('refuses a gate outside the allowed set and names it', async () => {
    const body = await verdictOf(
      'ghz-three',
      circuit(3, [
        op('a', 'h', [0], 0),
        op('b', 'cx', [1], 1, { controls: [0] }),
        op('c', 'cx', [2], 2, { controls: [0] }),
        op('d', 'sx', [0], 3),
      ])
    )
    expect(body.submission.passed).toBe(false)
    expect(body.feedback).toContainEqual({
      code: 'gate-not-allowed',
      value: null,
      gate: 'sx',
    })
  })

  /*
   * The one a client-side check could not make: the forbidden gate is inside a
   * custom-gate definition, so the document names `sneaky` and the engine runs
   * `sx`.
   */
  it('sees a forbidden gate hidden inside a block', async () => {
    const packaged: Circuit = {
      ...circuit(2, [
        op('a', 'h', [0], 0),
        op('b', 'cx', [1], 1, { controls: [0] }),
        op('c', 'sneaky', [0], 2),
      ]),
      customGates: {
        sneaky: { qubits: 1, operations: [op('cg1', 'sx', [0], 0)] },
      },
    }
    const body = await verdictOf('bell-pair', packaged)
    expect(body.feedback).toContainEqual({
      code: 'gate-not-allowed',
      value: null,
      gate: 'sx',
    })
  })

  it('refuses a register that is not the challenge’s', async () => {
    const body = await verdictOf(
      'bell-pair',
      circuit(3, [op('a', 'h', [0], 0)])
    )
    expect(body.submission.passed).toBe(false)
    expect(body.submission.fidelity).toBe(0)
    expect(codesOf(body)).toContain('wrong-qubit-count')
  })

  it('answers 413 for a register far past any plausible mistake', async () => {
    const response = await submit('bell-pair', {
      circuit: circuit(20, [op('a', 'h', [0], 0)]),
    })
    expect(response.statusCode).toBe(413)
    expect(response.body).toContain('too-many-qubits')
  })

  it('calls an empty circuit empty', async () => {
    const body = await verdictOf('superposition', circuit(1, []))
    expect(codesOf(body)).toContain('empty-circuit')
  })

  it('refuses a circuit that measures, because a target is not a distribution', async () => {
    const body = await verdictOf(
      'superposition',
      // `clbits: 1` so the measurement is legal in the contract; it is the
      // physics that has no answer.
      {
        ...circuit(1, [
          op('a', 'h', [0], 0),
          op('b', 'measure', [0], 1, { clbitTargets: [0] }),
        ]),
        clbits: 1,
      }
    )
    expect(body.submission.passed).toBe(false)
    /*
     * `measure` is outside this challenge's allowed set, so the gate rule is
     * what answers and the physics is never reached — which is the arrangement
     * that keeps `allowedGates` binding on the probe as well as on the answer.
     *
     * It is also said ONCE. Two paths used to produce the identical entry —
     * the allowed-gate walk and the mid-circuit refusal, which hard-coded
     * `measure` — so the reader saw one sentence printed twice.
     */
    expect(codesOf(body)).toEqual(['not-scored', 'gate-not-allowed'])
    expect(body.feedback.map((entry) => entry.gate)).toContain('measure')
  })

  /**
   * The other two documents @qsim/core refuses for the same reason, and they
   * are the ones that used to be misreported.
   *
   * The branch hard-coded `measure`, so a circuit whose only fault was a gate
   * carrying a classical condition — no measurement anywhere in it — was told
   * to remove a measurement it does not have.
   */
  it('names the operation that actually collapsed the run, not "measure"', async () => {
    const conditional = await verdictOf('superposition', {
      ...circuit(1, [
        op('a', 'h', [0], 0, { condition: { clbit: 0, equals: 1 } }),
      ]),
      clbits: 1,
    })
    expect(codesOf(conditional)).toContain('no-final-state')
    expect(conditional.feedback.map((entry) => entry.gate)).toEqual(['h'])
    expect(conditional.feedback.map((entry) => entry.gate)).not.toContain(
      'measure'
    )
  })
})

describe('what a submission is allowed to cost', () => {
  /**
   * A submission is permanent, immutable, written on every attempt and never
   * pruned, so the row is the one place in this API where a caller chooses how
   * much disk to spend. Unreferenced custom-gate definitions were the
   * amplifier: `safeExpandCircuit` never walks them, so they cost the
   * operation budget nothing and rode into the row verbatim — a two-gate
   * answer wrapped around 1,830 definitions nobody invokes stored a quarter of
   * a megabyte and answered 201 passed:true.
   */
  function withDecoys(count: number): Circuit {
    const customGates: Record<string, unknown> = {
      // One that IS invoked, so the pruning has something to keep.
      used: { qubits: 1, operations: [op('u1', 'h', [0], 0)] },
    }
    for (let index = 0; index < count; index++) {
      customGates[`decoy${String(index)}`] = {
        qubits: 1,
        symbol: `d${String(index % 9)}`,
        operations: [op(`d${String(index)}`, 'h', [0], 0)],
      }
    }
    return {
      ...circuit(2, [
        op('a', 'used', [0], 0),
        op('b', 'cx', [1], 1, { controls: [0] }),
      ]),
      customGates,
    } as Circuit
  }

  it('stores the answer without the definitions nothing reaches', async () => {
    const body = await verdictOf('bell-pair', withDecoys(400))
    expect(body.submission.passed).toBe(true)
    expect(body.submission.gateCount).toBe(2)

    const [row] = harness.repository.allChallengeSubmissions()
    const stored = row?.circuitData as { customGates: Record<string, unknown> }
    expect(Object.keys(stored.customGates)).toEqual(['used'])
    expect(JSON.stringify(stored).length).toBeLessThan(1024)
  })

  it('refuses a submission whose document is still too large to keep', async () => {
    /*
     * Reachable definitions, so pruning cannot help: one root that invokes
     * every leaf. It expands to 120 operations — well inside
     * `MAX_CHALLENGE_OPERATIONS` and only two levels deep — while the
     * *document* is far over the submission ceiling. That is exactly the case
     * the two bounds have to cover between them, and it is also far under
     * `MAX_CIRCUIT_JSON_BYTES`, the ceiling this used to be judged against,
     * which is the whole point.
     */
    const leaves = 120
    const name = (index: number): string =>
      `leaf${String(index).padStart(3, '0')}${'x'.repeat(50)}`
    const customGates: Record<string, unknown> = {
      root: {
        qubits: 1,
        operations: Array.from({ length: leaves }, (_value, index) =>
          op(`r${String(index)}`, name(index), [0], index)
        ),
      },
    }
    for (let index = 0; index < leaves; index++) {
      customGates[name(index)] = {
        qubits: 1,
        operations: [op(`op${String(index)}`, 'h', [0], 0)],
      }
    }

    const response = await submit('bell-pair', {
      circuit: {
        ...circuit(2, [
          op('a', 'root', [0], 0),
          op('b', 'cx', [1], 1, { controls: [0] }),
        ]),
        customGates,
      },
    })
    expect(response.statusCode).toBe(413)
    expect(response.body).toContain('CIRCUIT_TOO_LARGE')
    expect(harness.repository.allChallengeSubmissions()).toHaveLength(0)
  })
})

describe('the request itself', () => {
  it('needs a session to submit, because a submission has an owner', async () => {
    const response = await harness.app.inject({
      method: 'POST',
      url: submitPath('bell-pair'),
      payload: { circuit: circuit(1, [op('a', 'h', [0], 0)]) },
    })
    expect(response.statusCode).toBe(401)
  })

  it('refuses a circuit that is not a circuit, before the engine', async () => {
    const response = await submit('bell-pair', { circuit: { qubits: -1 } })
    expect(response.statusCode).toBe(400)
    expect(harness.repository.allChallengeSubmissions()).toHaveLength(0)
  })

  it('404s a submission to a challenge that does not exist', async () => {
    const response = await submit('not-a-challenge', {
      circuit: circuit(1, [op('a', 'h', [0], 0)]),
    })
    expect(response.statusCode).toBe(404)
  })
})

describe('the leaderboard', () => {
  const bell = (extra: Operation[] = []): Circuit =>
    circuit(2, [
      op('a', 'h', [0], 0),
      op('b', 'cx', [1], 1, { controls: [0] }),
      ...extra,
    ])

  beforeEach(nameTheContestants)

  it('ranks passing attempts by fewest gates, then least depth', async () => {
    // The rival takes the long way round: two extra Z gates that cancel.
    await verdictOf(
      'bell-pair',
      bell([op('c', 'z', [0], 2), op('d', 'z', [0], 3)]),
      harness.rival
    )
    await verdictOf('bell-pair', bell(), harness.learner)

    const response = await harness.app.inject({
      method: 'GET',
      url: boardPath('bell-pair'),
    })
    expect(response.statusCode).toBe(200)
    const body = JSON.parse(response.body) as {
      entries: { rank: number; username: string; gateCount: number }[]
    }
    expect(body.entries.map((entry) => entry.rank)).toEqual([1, 2])
    expect(body.entries[0]?.gateCount).toBe(2)
    expect(body.entries[1]?.gateCount).toBe(4)
  })

  it('holds no failed attempt', async () => {
    await verdictOf('bell-pair', circuit(2, [op('a', 'h', [0], 0)]))
    const response = await harness.app.inject({
      method: 'GET',
      url: boardPath('bell-pair'),
    })
    expect(
      (JSON.parse(response.body) as { entries: unknown[] }).entries
    ).toEqual([])
  })

  it('refuses a page size past the ceiling', async () => {
    const response = await harness.app.inject({
      method: 'GET',
      url: `${boardPath('bell-pair')}?limit=500`,
    })
    expect(response.statusCode).toBe(400)
  })

  /**
   * ONE ROW PER PERSON, AND IT IS THEIR BEST.
   *
   * Without this the table is a log of attempts wearing a ranking: whoever
   * presses the button most fills it, and a reader looking for "who solved
   * this in the fewest gates" reads one name nine times.
   */
  it('gives one person one row however many times they solved it', async () => {
    await verdictOf(
      'bell-pair',
      bell([op('c', 'z', [0], 2), op('d', 'z', [0], 3)])
    )
    await verdictOf('bell-pair', bell())
    await verdictOf(
      'bell-pair',
      bell([op('c', 'x', [0], 2), op('d', 'x', [0], 3)])
    )
    await verdictOf('bell-pair', bell(), harness.rival)

    // Four passing rows in the table…
    expect(
      harness.repository.allChallengeSubmissions().filter((row) => row.passed)
    ).toHaveLength(4)

    const body = await boardOf()
    // …and two competitors on the board.
    expect(body.entries).toHaveLength(2)
    expect(body.entries.map((entry) => entry.username).sort()).toEqual([
      'learner',
      'rival',
    ])
    // The learner's *best*, not their latest and not their first.
    expect(
      body.entries.find((entry) => entry.username === 'learner')?.gateCount
    ).toBe(2)
  })

  /**
   * THE OTHER HALF OF RISK 5, ONE MILESTONE LATER.
   *
   * `a client that lies about its own submission` proves the stored row holds
   * the truth. This proves the *ranking* reads that row and not the claim —
   * which is what a leaderboard position would be worth lying for.
   */
  it('ranks what the server computed, never what the client claimed', async () => {
    // The rival's honest two-gate answer.
    await verdictOf('bell-pair', bell(), harness.rival)
    // The learner sends a *longer* but still correct circuit — two cancelling
    // Z gates — wrapped in a claim that it is one gate long and one deep. Both
    // circuits pass; only the length decides the order, which is exactly the
    // figure the claim is about.
    const response = await submit('bell-pair', {
      circuit: bell([op('c', 'z', [0], 2), op('d', 'z', [0], 3)]),
      passed: true,
      gateCount: 1,
      depth: 1,
      fidelity: 1,
    })
    expect(response.statusCode).toBe(201)

    const body = await boardOf()
    // The lie bought nothing: four gates, and second place behind two.
    expect(body.entries.map((entry) => entry.gateCount)).toEqual([2, 4])
    expect(body.entries[0]?.username).toBe('rival')
    expect(body.entries[1]?.username).toBe('learner')
  })

  it('publishes a name and never an address', async () => {
    await verdictOf('bell-pair', bell())
    const response = await harness.app.inject({
      method: 'GET',
      url: boardPath('bell-pair'),
    })
    // The fixture gives every user an address precisely so this can look for
    // one. A leaderboard is the one public listing of *people* in the product.
    expect(response.body).not.toContain('@')
    expect(response.body).not.toContain('email')
  })
})

describe('a reader who asked not to be listed', () => {
  const bell = (extra: Operation[] = []): Circuit =>
    circuit(2, [
      op('a', 'h', [0], 0),
      op('b', 'cx', [1], 1, { controls: [0] }),
      ...extra,
    ])

  beforeEach(nameTheContestants)

  /** `PATCH /me`, which is where the choice is actually made. */
  async function optOut(headers: Record<string, string>): Promise<void> {
    const response = await harness.app.inject({
      method: 'PATCH',
      url: '/api/v1/me',
      headers,
      payload: { leaderboardOptOut: true },
    })
    expect(response.statusCode, response.body).toBe(200)
  }

  it('is withheld from the listing', async () => {
    await verdictOf('bell-pair', bell())
    await optOut(harness.learner)

    const body = await boardOf()
    expect(body.entries).toEqual([])
  })

  /**
   * THE PROPERTY THAT MAKES THE OPT-OUT SAFE TO OFFER.
   *
   * A privacy setting must not be a move in the game. If withholding a row
   * renumbered the table, the way to gain a place would be to persuade the
   * person above you to hide — and the ladder would be something other than a
   * measure of the circuits people wrote.
   */
  it('does not promote anybody by hiding', async () => {
    await verdictOf('bell-pair', bell(), harness.learner)
    await verdictOf(
      'bell-pair',
      bell([op('c', 'z', [0], 2), op('d', 'z', [0], 3)]),
      harness.rival
    )

    const before = await boardOf()
    expect(before.entries.map((entry) => entry.rank)).toEqual([1, 2])

    await optOut(harness.learner)

    const after = await boardOf()
    expect(after.entries).toHaveLength(1)
    // Still second. The rank column skips a number, which says "somebody is
    // here" and does not say who.
    expect(after.entries[0]).toMatchObject({ rank: 2, username: 'rival' })
  })

  it('still sees where they stand', async () => {
    await verdictOf('bell-pair', bell(), harness.learner)
    await optOut(harness.learner)

    const body = await boardOf(harness.learner)
    expect(body.entries).toEqual([])
    expect(body.standing).toMatchObject({
      rank: 1,
      gateCount: 2,
      listed: false,
    })
  })

  it('is listed again when they change their mind', async () => {
    await verdictOf('bell-pair', bell())
    await optOut(harness.learner)

    const response = await harness.app.inject({
      method: 'PATCH',
      url: '/api/v1/me',
      headers: harness.learner,
      payload: { leaderboardOptOut: false },
    })
    expect(response.statusCode).toBe(200)

    const body = await boardOf()
    expect(body.entries).toHaveLength(1)
  })

  it('keeps the preference off every other reader’s page', async () => {
    await verdictOf('bell-pair', bell())
    await optOut(harness.learner)

    // The board a stranger sees, the profile, and the gallery byline: a
    // setting is not a public fact about somebody.
    for (const url of [
      boardPath('bell-pair'),
      '/api/v1/users/learner',
      '/api/v1/gallery',
    ]) {
      const response = await harness.app.inject({ method: 'GET', url })
      expect(response.body, url).not.toContain('leaderboardOptOut')
    }
  })
})

describe('the reader’s own standing', () => {
  const bell = (extra: Operation[] = []): Circuit =>
    circuit(2, [
      op('a', 'h', [0], 0),
      op('b', 'cx', [1], 1, { controls: [0] }),
      ...extra,
    ])

  beforeEach(nameTheContestants)

  /**
   * The question a reader actually has. A table of ten answers "who is
   * winning" and never "how am I doing" — and the second is what brings
   * somebody back to shorten a circuit.
   */
  it('is reported even when the reader is off the visible page', async () => {
    await verdictOf('bell-pair', bell(), harness.rival)
    await verdictOf(
      'bell-pair',
      bell([op('c', 'z', [0], 2), op('d', 'z', [0], 3)]),
      harness.learner
    )

    const body = await boardOf(harness.learner, '?limit=1')
    expect(body.entries).toHaveLength(1)
    expect(body.entries[0]?.username).toBe('rival')
    expect(body.standing).toMatchObject({ rank: 2, gateCount: 4, listed: true })
  })

  it('agrees with the row the table shows for that reader', async () => {
    await verdictOf('bell-pair', bell(), harness.learner)
    await verdictOf(
      'bell-pair',
      bell([op('c', 'z', [0], 2), op('d', 'z', [0], 3)]),
      harness.rival
    )

    const body = await boardOf(harness.learner)
    const mine = body.entries.find((entry) => entry.username === 'learner')
    expect(body.standing?.rank).toBe(mine?.rank)
    expect(body.standing?.gateCount).toBe(mine?.gateCount)
    expect(body.standing?.depth).toBe(mine?.depth)
  })

  it('is null for a reader who has not solved it, and for a stranger', async () => {
    await verdictOf('bell-pair', bell(), harness.learner)

    expect((await boardOf(harness.rival)).standing).toBeNull()
    expect((await boardOf()).standing).toBeNull()
  })

  it('carries no circuit, so it cannot be read as a hint', async () => {
    await verdictOf('bell-pair', bell(), harness.learner)
    const response = await harness.app.inject({
      method: 'GET',
      url: boardPath('bell-pair'),
      headers: harness.learner,
    })
    expect(response.body).not.toContain('operations')
    expect(response.body).not.toContain('circuitData')
  })
})

describe('the caller’s own best attempt', () => {
  it('is the one the leaderboard would rank, not the latest', async () => {
    const good = circuit(2, [
      op('a', 'h', [0], 0),
      op('b', 'cx', [1], 1, { controls: [0] }),
    ])
    await verdictOf('bell-pair', good)
    // A later, worse pass must not replace it.
    await verdictOf(
      'bell-pair',
      circuit(2, [
        op('a', 'h', [0], 0),
        op('b', 'cx', [1], 1, { controls: [0] }),
        op('c', 'z', [0], 2),
        op('d', 'z', [0], 3),
      ])
    )

    const response = await harness.app.inject({
      method: 'GET',
      url: itemPath('bell-pair'),
      headers: harness.learner,
    })
    const body = JSON.parse(response.body) as {
      best: { gateCount: number } | null
    }
    expect(body.best?.gateCount).toBe(2)
  })

  it('is null for somebody who has not solved it', async () => {
    const response = await harness.app.inject({
      method: 'GET',
      url: itemPath('bell-pair'),
      headers: harness.rival,
    })
    expect((JSON.parse(response.body) as { best: unknown }).best).toBeNull()
  })

  it('is null for an anonymous reader, who has no attempts', async () => {
    const response = await harness.app.inject({
      method: 'GET',
      url: itemPath('bell-pair'),
    })
    expect((JSON.parse(response.body) as { best: unknown }).best).toBeNull()
  })
})

describe('seeding', () => {
  it('is idempotent: running it again converges rather than duplicating', async () => {
    const again = await seedChallenges(harness.repository)
    expect(again.created).toEqual([])
    expect(again.converged).toHaveLength(CHALLENGE_SLUGS.length)

    const response = await harness.app.inject({ method: 'GET', url: listPath })
    expect(
      (JSON.parse(response.body) as { items: unknown[] }).items
    ).toHaveLength(CHALLENGE_SLUGS.length)
  })
})
