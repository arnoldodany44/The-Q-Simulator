/**
 * The challenge routes of §8, as functions — Phase 3.
 *
 * Same rules as `lessons.ts` beside it: the path comes from `@qsim/contract`'s
 * builders, the response is parsed with its wire schemas, and nothing is
 * declared here.
 *
 * ── What this module cannot do, and why that is the design ────────────────
 *
 * It cannot tell you whether a circuit solves a challenge. There is no target
 * in any of these responses — §4 and risk 5 put the judgement on the server
 * with the same engine, precisely so a browser cannot mark its own homework —
 * so `submitChallenge` is the only way to find out, and what comes back is the
 * server's verdict rather than a number this side computed.
 *
 * What the browser *can* say without asking is everything that is a property of
 * the reader's own circuit: how many gates it has, how deep it is, whether it
 * uses a gate the challenge disallows. `features/challenges/local.ts` does
 * exactly that and no more.
 */

import {
  SubmitChallengeBody,
  challengePath,
  wireChallengeResponses,
} from '@qsim/contract'
import type {
  ChallengeList,
  ChallengeSubmissionResult,
  ChallengeView,
  Leaderboard,
} from '@qsim/contract'
import type { Circuit } from '@qsim/schema'

import type { ApiClient } from './client.js'
import type { RequestContext } from './circuits.js'

/** `GET /challenges` — the ladder, and which of it this caller has solved. */
export function listChallenges(
  client: ApiClient,
  context: RequestContext = {}
): Promise<ChallengeList> {
  return client.request({
    method: 'GET',
    path: challengePath.collection(),
    schema: wireChallengeResponses.ChallengeListResponse,
    ...context,
  })
}

/** `GET /challenges/:slug` — the rules, and this caller's best attempt. */
export function getChallenge(
  client: ApiClient,
  slug: string,
  context: RequestContext = {}
): Promise<ChallengeView> {
  return client.request({
    method: 'GET',
    path: challengePath.item(slug),
    schema: wireChallengeResponses.ChallengeEnvelope,
    ...context,
  })
}

/**
 * `POST /challenges/:slug/submit` — the circuit, and nothing else.
 *
 * The body goes through the contract schema before it is sent, like every other
 * write in this directory. Here that has a second effect worth naming: the
 * schema has exactly one field, so this function *cannot* send a claim about
 * the result even if a caller handed it one. The server would ignore it
 * anyway — that is the whole of risk 5 — and this is the same promise made one
 * layer earlier, where it is visible to whoever reads the client.
 */
export function submitChallenge(
  client: ApiClient,
  slug: string,
  circuit: Circuit,
  context: RequestContext = {}
): Promise<ChallengeSubmissionResult> {
  return client.request({
    method: 'POST',
    path: challengePath.submit(slug),
    body: SubmitChallengeBody.parse({ circuit }),
    schema: wireChallengeResponses.SubmissionEnvelope,
    ...context,
  })
}

/** `GET /challenges/:slug/leaderboard` — fewest gates, then least depth. */
export function getLeaderboard(
  client: ApiClient,
  slug: string,
  limit?: number,
  context: RequestContext = {}
): Promise<Leaderboard> {
  return client.request({
    method: 'GET',
    path: challengePath.leaderboard(slug),
    ...(limit === undefined ? {} : { query: { limit } }),
    schema: wireChallengeResponses.LeaderboardResponse,
    ...context,
  })
}
