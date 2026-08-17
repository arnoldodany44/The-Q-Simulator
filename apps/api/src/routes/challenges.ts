/**
 * Challenges — §3.6, §8, and the reason §4 gives for this service existing.
 *
 * ════════════════════════════════════════════════════════════════════════
 * THIS IS THE ROUTE THAT IS NOT THE LESSON ROUTE.
 *
 * `routes/lessons.ts` next door stores whatever the client says, because a
 * lesson has nothing to win. Here the opposite holds in every particular: the
 * server holds the target, the server runs the circuit, the server decides, and
 * a client's claim about its own result has nowhere to enter the request at
 * all. Risk 5 is one sentence — "por eso la validación es autoritativa en el
 * servidor, con el mismo motor compartido" — and this file plus
 * `challenges/validate.ts` are that sentence.
 *
 * ════════════════════════════════════════════════════════════════════════
 * THE TARGET DOES NOT LEAVE THIS PROCESS. THREE THINGS ENFORCE IT.
 *
 *   1. `challengeRuleSelect` — the projection every browser-reachable read
 *      uses — never asks Postgres for `targetData`. Only the submit handler
 *      calls `findChallengeWithTarget`.
 *   2. `serverChallengeResponses.ChallengeResponse` has no field for it, and
 *      Fastify serialises through that schema, so an object carrying one would
 *      be stripped on the way out.
 *   3. `toChallengeResponse` lists the eight fields by name rather than
 *      spreading a row.
 *
 * Each of the three is enough on its own. That is the point of having three:
 * the leak this guards against is not a bug somebody writes deliberately, it is
 * a `...row` somebody writes while doing something else. `challenges.test.ts`
 * asserts the property from the outside — it seeds a target with a
 * recognisable amplitude and greps every response body for it.
 *
 * ════════════════════════════════════════════════════════════════════════
 * WHO MAY DO WHAT.
 *
 * Reading is anonymous, like the gallery and the lessons: §2 makes the learning
 * surfaces the product's reason to exist, and a puzzle behind a sign-up is a
 * puzzle nobody sees. Submitting requires a session, and not as policy —
 * `ChallengeSubmission.userId` is a non-null foreign key, because a submission
 * that belongs to nobody could not be ranked, could not be shown back to its
 * author, and would make the leaderboard unauditable.
 *
 * §11 singles these routes out for rate limiting, and `submit` carries the
 * strict budget for the same reason `/simulate` does: it is a request that
 * spends CPU on arithmetic a stranger chose. It is also the loop a brute-force
 * search would run — submit, read the fidelity, adjust — so the budget is what
 * keeps "a fidelity readout is legitimate feedback" true.
 *
 * ════════════════════════════════════════════════════════════════════════
 * THE LEADERBOARD IS THE ONE PUBLIC LISTING OF PEOPLE, SO IT IS THE NARROWEST.
 *
 * A gallery card lists somebody's work and a leaderboard lists *them*. Three
 * things follow, and none of them is enforced in this file alone:
 *
 *   1. **A name, never an address.** `@qsim/db` reads the two public *name*
 *      columns — not `publicUserSelect`, which carries an id and the account's
 *      own settings — and `LeaderboardEntryResponse` has no field for anything
 *      else. `email` is not reachable from either end, and neither is
 *      `avatarUrl`: this listing is served to anonymous readers, so an avatar
 *      would be a third-party request and an IP address per reader — which is
 *      exactly what `@qsim/contract`'s embed projection omits it to avoid.
 *   2. **No circuits.** A published winning circuit is the answer published,
 *      one attempt after the target was protected from exactly that. The
 *      response schema has no field for a circuit, `challenges.test.ts` greps
 *      the serialised body for one, and the query never selects the column.
 *   3. **A reader can withdraw their name.** `User.leaderboardOptOut`, set from
 *      `PATCH /me`, withholds the row *after* the rank is assigned — so a
 *      privacy setting cannot promote anybody else, and the person who set it
 *      still sees where they stand in `standing`.
 */

import { CHALLENGE_ROUTES } from '@qsim/contract'
import { MAX_SUBMISSION_JSON_BYTES, toCircuitJson } from '@qsim/db'
import {
  CircuitValidationError,
  pruneUnusedDefinitions,
  safeParseCircuit,
} from '@qsim/schema'
import type { Circuit } from '@qsim/schema'
import type { FastifyPluginCallback, FastifyRequest } from 'fastify'

import {
  ChallengeTargetError,
  parseChallengeTarget,
} from '../challenges/target.js'
import {
  SubmissionTooLargeError,
  judgeSubmission,
} from '../challenges/validate.js'
import type { ApiEnv } from '../env.js'
import { ApiError } from '../errors.js'
import { viewerIdOf } from '../plugins/auth.js'
import { strictRateLimit } from '../plugins/rate-limit.js'
import {
  MAX_ERROR_DETAILS,
  withTruncationMarker,
} from '../plugins/validation.js'
import type { ZodTypeProvider } from '../plugins/validation.js'
import {
  ChallengeEnvelope,
  ChallengeListResponse,
  ChallengeSlugParams,
  LeaderboardQuerySchema,
  LeaderboardResponse,
  SubmissionEnvelope,
  SubmitChallengeBody,
  toChallengeResponse,
  toSubmissionResponse,
} from './challenges.schemas.js'

export interface ChallengeRoutesOptions {
  readonly env: ApiEnv
}

/**
 * Validates an incoming circuit with @qsim/schema and nothing else — the same
 * function, for the same reason, as `acceptCircuit` in `routes/circuits.ts`
 * and `routes/simulate.ts`.
 *
 * §11 requires the full contract, not merely the shape, before the engine sees
 * anything. It is the *first* thing this route does with a body, ahead of every
 * bound in `validate.ts`, because a circuit that is not a circuit has no qubit
 * count to bound.
 */
function acceptCircuit(input: unknown): Circuit {
  const result = safeParseCircuit(input)
  if (result.ok) return result.circuit

  const details = result.issues.slice(0, MAX_ERROR_DETAILS).map((issue) => ({
    path:
      issue.operationId === undefined
        ? 'body.circuit'
        : `body.circuit.operations.${issue.operationId}`,
    code: issue.code,
  }))

  throw new ApiError('VALIDATION_FAILED', {
    details: withTruncationMarker(
      details,
      result.issues.length,
      'body.circuit'
    ),
    cause: new CircuitValidationError(result.issues),
  })
}

const plugin: FastifyPluginCallback<ChallengeRoutesOptions> = (
  instance,
  options,
  done
) => {
  const app = instance.withTypeProvider<ZodTypeProvider>()
  const { env } = options

  /**
   * The caller's id, with their `public.User` row guaranteed to exist.
   *
   * `ChallengeSubmission.userId` is a foreign key, and a challenge is very
   * plausibly among the first authenticated things a new account does. Same
   * arrangement as `routes/lessons.ts`, for the same reason: answering 404 to
   * somebody whose account is a minute old would be answering the wrong
   * question.
   */
  async function ownerId(request: FastifyRequest): Promise<string> {
    const identity = request.auth
    // Unreachable on a route declaring `auth: 'required'`; throwing rather than
    // asserting keeps a policy mistake a 401 instead of a 500.
    if (identity === null) throw new ApiError('AUTH_REQUIRED')
    if (identity.email === null) throw new ApiError('USER_EMAIL_REQUIRED')

    await app.circuits.ensureOwner({
      id: identity.userId,
      email: identity.email,
      displayName: identity.displayName,
      avatarUrl: identity.avatarUrl,
    })
    return identity.userId
  }

  app.get(
    CHALLENGE_ROUTES.collection,
    {
      config: { auth: 'optional' },
      schema: { response: { 200: ChallengeListResponse } },
    },
    async (request) => {
      const rows = await app.circuits.listChallenges()
      const viewerId = viewerIdOf(request)

      /*
       * Skipped entirely for an anonymous caller, who has no submissions to
       * have — the same shortcut `starredAmong` gets on a gallery page, and for
       * the same reason: it is a round trip whose answer is known.
       */
      const solvedIds =
        viewerId === null
          ? []
          : await app.circuits.solvedAmong({
              userId: viewerId,
              challengeIds: rows.map((row) => row.id),
            })

      const slugById = new Map(rows.map((row) => [row.id, row.slug]))
      return {
        items: rows.map(toChallengeResponse),
        /*
         * Slugs and not ids. The id is a database key the client has no other
         * use for; the slug is the address it already navigates by, and it is
         * what a card matches on.
         */
        solved: solvedIds
          .map((id) => slugById.get(id))
          .filter((slug): slug is string => slug !== undefined),
      }
    }
  )

  app.get(
    CHALLENGE_ROUTES.item,
    {
      config: { auth: 'optional' },
      schema: {
        params: ChallengeSlugParams,
        response: { 200: ChallengeEnvelope },
      },
    },
    async (request) => {
      // The projection without the target, on the route a browser opens.
      const rules = await app.circuits.findChallenge(request.params.slug)
      if (rules === null) throw new ApiError('NOT_FOUND')

      const viewerId = viewerIdOf(request)
      const best =
        viewerId === null
          ? null
          : await app.circuits.bestSubmission({
              challengeId: rules.id,
              userId: viewerId,
            })

      return {
        challenge: toChallengeResponse(rules),
        best: best === null ? null : toSubmissionResponse(best),
      }
    }
  )

  app.post(
    CHALLENGE_ROUTES.submit,
    {
      /*
       * A session, because the row's owner column is a foreign key — see
       * `ownerId` above. And the strict budget §11 asks for: this is the one
       * route in the API where a caller's own arithmetic runs in the request
       * path, and the one whose repeated use is how a brute-force search would
       * look.
       */
      config: { auth: 'required', rateLimit: strictRateLimit(env) },
      schema: {
        params: ChallengeSlugParams,
        body: SubmitChallengeBody,
        response: { 201: SubmissionEnvelope },
      },
    },
    async (request, reply) => {
      const { slug } = request.params
      const challenge = await app.circuits.findChallengeWithTarget(slug)
      if (challenge === null) throw new ApiError('NOT_FOUND')

      /*
       * §11's order: the contract first, then the bounds, then the engine.
       * `request.body` has exactly one property — Zod stripped everything else
       * the caller sent, including any claim about the result — and this turns
       * that one property into a document the engine can be trusted with.
       */
      const circuit = acceptCircuit(request.body.circuit)

      const target = readTarget(slug, challenge)
      const verdict = judge(slug, challenge, target, circuit)

      /*
       * The user row is ensured *after* the verdict, so a malformed submission
       * from a brand-new account does not write a row to answer 400 with. It
       * is before the insert, which is what the foreign key needs.
       */
      const userId = await ownerId(request)

      /*
       * `toCircuitJson` is the same door every stored circuit goes through,
       * with the submission's own ceiling rather than the document one.
       *
       * A submission is NOT a stored circuit like any other, which is what the
       * comment here used to say. It is permanent, immutable, written on every
       * attempt, unbounded in number per person, and never read back except as
       * the four aggregate columns beside it — so its row is the one place in
       * this API where a caller chooses how much disk to spend. At the
       * document ceiling one authenticated account could write about two
       * megabytes a minute of rows nothing prunes, on the single shared
       * database the editor and the gallery also live in.
       *
       * Two bounds, and the first is why the second can be tight:
       * `pruneUnusedDefinitions` drops custom-gate definitions no operation
       * reaches. They cost the expansion budget nothing — `safeExpandCircuit`
       * never walks them — so they were the amplifier: a two-gate answer with
       * 1,830 definitions nobody invokes is still a two-gate answer, and was
       * still a quarter of a megabyte.
       */
      const record = await app.circuits.recordSubmission({
        challengeId: challenge.id,
        userId,
        circuitData: toCircuitJson(
          pruneUnusedDefinitions(circuit),
          MAX_SUBMISSION_JSON_BYTES
        ),
        passed: verdict.passed,
        fidelity: verdict.fidelity,
        gateCount: verdict.gateCount,
        depth: verdict.depth,
      })

      /*
       * 201, because an attempt is a resource and this created one — including
       * a failed attempt, which is a perfectly good row and the thing a
       * leaderboard's denominator is made of.
       *
       * The body reports what was STORED rather than what was computed, and
       * they are the same object for a reason worth keeping: it makes "what the
       * client is told" and "what the leaderboard will rank" impossible to
       * disagree.
       */
      reply.status(201)
      return {
        submission: toSubmissionResponse(record),
        feedback: verdict.feedback,
      }
    }
  )

  app.get(
    CHALLENGE_ROUTES.leaderboard,
    {
      config: { auth: 'optional' },
      schema: {
        params: ChallengeSlugParams,
        querystring: LeaderboardQuerySchema,
        response: { 200: LeaderboardResponse },
      },
    },
    async (request) => {
      const rules = await app.circuits.findChallenge(request.params.slug)
      if (rules === null) throw new ApiError('NOT_FOUND')

      const viewerId = viewerIdOf(request)

      /*
       * Two reads and not one, because they answer different questions of the
       * same ranked set: "who is at the top" and "where is this reader". The
       * second is skipped entirely for an anonymous caller, who has no
       * standing to have — the same shortcut `solvedAmong` gets on the ladder.
       */
      const [rows, standing] = await Promise.all([
        app.circuits.leaderboard({
          challengeId: rules.id,
          take: request.query.limit,
        }),
        viewerId === null
          ? Promise.resolve(null)
          : app.circuits.leaderboardStanding({
              challengeId: rules.id,
              userId: viewerId,
            }),
      ])

      /*
       * `rank` comes off the row and is not recomputed from the array index.
       * It is a position over everybody, and the listing has already had the
       * readers who opted out removed from it — so an index would renumber
       * them away, which would let anybody promote the field by hiding and
       * would make the table disagree with the standing beneath it.
       *
       * Nothing here is derived from a request body. Every figure below was
       * recomputed by the validator from a submitted circuit and stored (risk
       * 5); this route only sorts.
       */
      return {
        entries: rows.map((row) => ({
          rank: row.rank,
          username: row.username,
          displayName: row.displayName,
          gateCount: row.gateCount,
          depth: row.depth,
          createdAt: row.createdAt,
        })),
        standing,
      }
    }
  )

  done()
}

/** The stored target, or a 500 that says the row is the problem. */
function readTarget(
  slug: string,
  challenge: { targetType: string; targetData: unknown }
) {
  try {
    return parseChallengeTarget({
      slug,
      targetType: challenge.targetType,
      targetData: challenge.targetData,
    })
  } catch (error) {
    if (error instanceof ChallengeTargetError) {
      /*
       * Deliberately a 500 and not a 400. Nothing about the caller's request is
       * wrong; a row this service seeded is unreadable, and telling the caller
       * their circuit was invalid would send them to debug their own work.
       */
      throw new ApiError('INTERNAL_ERROR', { cause: error })
    }
    throw error
  }
}

/** The verdict, or the 413 that says which bound the submission hit. */
function judge(
  slug: string,
  challenge: {
    qubitCount: number
    allowedGates: string[]
    maxGates: number | null
    fidelityThreshold: number
  },
  target: ReturnType<typeof parseChallengeTarget>,
  circuit: Circuit
) {
  try {
    return judgeSubmission({
      slug,
      constraints: {
        qubitCount: challenge.qubitCount,
        allowedGates: challenge.allowedGates,
        maxGates: challenge.maxGates,
        fidelityThreshold: challenge.fidelityThreshold,
      },
      target,
      circuit,
    })
  } catch (error) {
    if (error instanceof SubmissionTooLargeError) {
      /*
       * The same code and the same detail shape `/simulate` uses for §11's
       * resource limits, so a client translates one vocabulary rather than two.
       * `value` and `limit` are numbers and safe to echo: one came from the
       * request, the other from a constant.
       */
      throw new ApiError('SIMULATION_TOO_LARGE', {
        details: [
          { path: 'body.circuit', code: error.code },
          { path: 'body.circuit', code: `value:${String(error.value)}` },
          { path: 'body.circuit', code: `limit:${String(error.limit)}` },
        ],
        cause: error,
      })
    }
    if (error instanceof ChallengeTargetError) {
      throw new ApiError('INTERNAL_ERROR', { cause: error })
    }
    throw error
  }
}

export const challengeRoutes = plugin
