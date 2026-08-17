/**
 * The challenge routes' schemas, as this process uses them — §8, Phase 3.
 *
 * Same division as `lessons.schemas.ts`: everything both ends must agree on
 * lives in `@qsim/contract`, and what stays here is the server-side
 * serialisation half — Fastify serialises through `serverChallengeResponses`,
 * whose timestamp is the `Date` a handler holds, while the browser parses
 * through the wire twin.
 *
 * The serialisation half is doing real work here rather than only converting
 * dates. Fastify's serialiser is what actually decides which properties leave
 * this process, so a handler that returned a row straight out of Prisma —
 * `targetData` and all — would still answer without it, because the schema has
 * no field to put it in. That is the second of the two defences: the first is
 * that `challengeRuleSelect` never reads the column.
 */

import { serverChallengeResponses } from '@qsim/contract'
import type { ChallengeRules, SubmissionRecord } from '@qsim/db'
import type { z } from 'zod'

export {
  ChallengeSlugParams,
  LeaderboardQuerySchema,
  SubmitChallengeBody,
} from '@qsim/contract'

export const {
  ChallengeEnvelope,
  ChallengeListResponse,
  LeaderboardResponse,
  SubmissionEnvelope,
} = serverChallengeResponses

type ChallengeResponse = z.infer<
  typeof serverChallengeResponses.ChallengeResponse
>

/**
 * A stored challenge as the wire carries it.
 *
 * Written out field by field rather than spread, and that is the point: a
 * spread would carry whatever the row happened to have, and this is the one
 * resource in the API whose row holds an answer. Listing the eight fields makes
 * "what a client may know about a challenge" a thing one function decides.
 */
export function toChallengeResponse(rules: ChallengeRules): ChallengeResponse {
  return {
    slug: rules.slug,
    difficulty: rules.difficulty,
    qubitCount: rules.qubitCount,
    // The column is `String` in Postgres; the contract's enum is what makes it
    // one of three, and a row carrying anything else fails serialisation here
    // rather than reaching a client that has no branch for it.
    targetType: rules.targetType as ChallengeResponse['targetType'],
    allowedGates: [...rules.allowedGates],
    maxGates: rules.maxGates,
    fidelityThreshold: rules.fidelityThreshold,
    orderIndex: rules.orderIndex,
  }
}

type SubmissionResponse = z.infer<
  typeof serverChallengeResponses.SubmissionResponse
>

export function toSubmissionResponse(
  record: SubmissionRecord
): SubmissionResponse {
  return {
    passed: record.passed,
    fidelity: record.fidelity,
    gateCount: record.gateCount,
    depth: record.depth,
    createdAt: record.createdAt,
  }
}
