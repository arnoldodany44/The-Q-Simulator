/**
 * Challenge mode, as the wire carries it — §3.6, §8, risk 5, Phase 3.
 *
 * ════════════════════════════════════════════════════════════════════════
 * THE TARGET IS NOT IN THIS FILE, AND THAT IS THE POINT.
 *
 * A challenge names a state, a unitary or a truth table, and the learner
 * builds the circuit that produces it. If that target travelled to the
 * browser, the challenge would be a lookup: open the network tab, read the
 * amplitudes, write them back. So `targetData` — the one column that holds
 * the answer — has no representation here at all. It cannot be sent by
 * accident, because there is no field to put it in, and `challenges.test.ts`
 * in `apps/api` asserts the serialised body of every route against the
 * amplitudes of the seeded target.
 *
 * What a learner legitimately needs is here and is enough to work: which
 * register, which gates are allowed, how many gates are permitted, how close
 * the answer has to be, and — after a submission — how close *they* got and
 * what is wrong with it. The prompt itself is not here either, for a different
 * reason (below).
 *
 * ════════════════════════════════════════════════════════════════════════
 * NOR IS THE PROSE. THE API SENDS NO WORDS.
 *
 * §11 and D2 between them settle this: the API answers with codes and
 * `apps/web` owns every word a reader sees, in three catalogs. A challenge's
 * title and prompt are prose — long prose, in the case of the prompt — so they
 * are written where prose belongs, in `apps/web/src/i18n/locales/*` keyed by
 * slug, exactly as a lesson's are. The `Challenge.title` and `Challenge.prompt`
 * columns of §7 hold the English source the seed was written from; they are
 * what an operator reading the table sees, and they never leave the server.
 *
 * That arrangement needs one thing to be safe: both ends must agree on which
 * slugs exist, or a row seeded ahead of the client renders as a raw key.
 * `CHALLENGE_SLUGS` below is that agreement — the seed writes exactly this
 * list, the web catalogs are asserted to cover exactly this list, and a client
 * skips a slug it does not recognise rather than printing an identifier.
 *
 * Unlike a lesson, a challenge *cannot* be added by deploying the client alone:
 * its target and threshold live in a database row that only a seed can write.
 * So publishing the list here costs nothing that was not already true.
 *
 * ════════════════════════════════════════════════════════════════════════
 * FEEDBACK IS A LIST OF CODES, NEVER A SENTENCE.
 *
 * "Fidelity 0.83" is a number; "your state has the right magnitudes and the
 * wrong relative phase" is a lesson. The server is the only side that can tell
 * the difference — it is the only side holding the target — so it computes the
 * diagnosis and sends its *name*. The three catalogs turn each name into a
 * sentence. That keeps the teaching text translatable and keeps the target on
 * the server, which no single-sentence-from-the-API design manages at once.
 */

import { storableText } from '@qsim/schema'
import { z } from 'zod'
import { serverTimestamp, wireTimestamp } from './circuits.js'

/**
 * The slug of every seeded challenge, in ladder order.
 *
 * Ordered by difficulty, and the order is the curriculum: one qubit before
 * two, a state before an operation, an operation before a truth table. The
 * server sorts by `orderIndex` and this list is where those indices come from,
 * so the two cannot disagree.
 */
export const CHALLENGE_SLUGS = [
  'superposition',
  'minus-state',
  'bell-pair',
  'ghz-three',
  'y-eigenstate',
  'hadamard-conjugation',
  'cnot-reversed',
  'swap-from-cnots',
  'toffoli-truth-table',
] as const

export type ChallengeSlug = (typeof CHALLENGE_SLUGS)[number]

const CHALLENGE_SLUG_SET: ReadonlySet<string> = new Set(CHALLENGE_SLUGS)

/**
 * Narrows a slug that arrived over the network to one this bundle can render.
 *
 * Used by the client for the reason `isApiErrorCode` exists: an API seeded
 * ahead of the browser tab can list a challenge this bundle has no prose for,
 * and skipping it is better than printing `challenges.catalog.x.title` on the
 * page.
 */
export function isChallengeSlug(value: unknown): value is ChallengeSlug {
  return typeof value === 'string' && CHALLENGE_SLUG_SET.has(value)
}

/**
 * The three kinds of target §3.6 allows, as the `Challenge.targetType` column
 * spells them.
 *
 * Re-declared here rather than imported from `@qsim/db` for the reason
 * `visibility.ts` gives: this package is bundled into the browser and may not
 * reach for Prisma. The client needs the vocabulary because the three read
 * differently — a truth table is checked on basis states alone, and a reader
 * has to be told that.
 */
export const CHALLENGE_TARGET_TYPES = [
  'state',
  'unitary',
  'truth_table',
] as const

export type ChallengeTargetType = (typeof CHALLENGE_TARGET_TYPES)[number]

export const ChallengeTargetTypeSchema = z.enum(CHALLENGE_TARGET_TYPES)

/**
 * Every diagnosis the validator can reach, and therefore every sentence the
 * three catalogs have to carry.
 *
 * Grouped by what the reader should do about it: first the refusals that have
 * nothing to do with physics, then what is wrong with the state, then the two
 * that are information rather than fault.
 */
export const CHALLENGE_FEEDBACK_CODES = [
  // The submission was not an attempt at this challenge's shape.
  'wrong-qubit-count',
  'empty-circuit',
  'gate-not-allowed',
  'gate-budget-exceeded',
  /*
   * The submission broke a rule of the puzzle, so it was NOT compared with the
   * target at all and the fidelity beside it is not a reading.
   *
   * It exists because refusing to score is the only thing that makes
   * `allowedGates` bound the *probe* as well as the answer: a fidelity answered
   * for a circuit built out of gates the challenge forbids turns the submit
   * route into a tomography oracle, and risk 5 is the reason the route exists.
   * See `challenges/validate.ts`.
   */
  'not-scored',
  /*
   * The circuit has no single final state — it measures, resets, or gates on a
   * classical bit — so there is nothing to compare. `gate` names the operation
   * to remove when there is one to name.
   */
  'no-final-state',
  // What is wrong with the answer.
  'orthogonal',
  'relative-phase',
  'qubit-order-reversed',
  'entanglement-missing',
  'entanglement-unwanted',
  'too-few-outcomes',
  'too-many-outcomes',
  'nearly-there',
  // Truth tables only.
  'basis-states-only',
  'row-not-a-basis-state',
  'rows-wrong',
  // Not a fault: said out loud so nobody debugs a difference that is not one.
  'global-phase-ignored',
  'solved',
] as const

export type ChallengeFeedbackCode = (typeof CHALLENGE_FEEDBACK_CODES)[number]

/**
 * One diagnosis, and the two things that make it concrete where there are any.
 *
 * `value` is a plain number and never an identifier: how many rows failed, how
 * many outcomes the answer has, how many gates were used. It is safe to echo
 * because it is a property of *the submission*, which the caller wrote — the
 * only numbers derived from the target that ever leave the server are the
 * fidelity and the thresholds the challenge publishes anyway.
 *
 * `gate` names a gate of the submitted circuit, for the one diagnosis that is
 * meaningless without it: "you used a gate this challenge does not allow" has
 * to say which. It is a @qsim/schema gate id — `h`, `cx`, `sdg` — which D2
 * classes as invariant notation rather than as text, so it is rendered through
 * `Notation` and is identical in all three languages. Everything else about a
 * diagnosis is a code the client translates.
 */
export const ChallengeFeedbackSchema = z.object({
  code: z.enum(CHALLENGE_FEEDBACK_CODES),
  value: z.number().nullable(),
  gate: z.string().nullable(),
})

export type ChallengeFeedback = z.infer<typeof ChallengeFeedbackSchema>

/** Longest slug accepted in a path segment. Generous against the list above. */
export const MAX_CHALLENGE_SLUG_LENGTH = 64

/** Lowercase, digits, hyphen — the shape of a URL segment, which is what it is. */
export const CHALLENGE_SLUG_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/

export const ChallengeSlugSchema = storableText(
  z.string().min(1).max(MAX_CHALLENGE_SLUG_LENGTH).regex(CHALLENGE_SLUG_PATTERN)
)

export const ChallengeSlugParams = z.object({ slug: ChallengeSlugSchema })

/**
 * How many leaderboard rows a client may ask for, and how many it gets by
 * default.
 */
export const DEFAULT_LEADERBOARD_LIMIT = 10
export const MAX_LEADERBOARD_LIMIT = 50

export const LeaderboardQuerySchema = z.object({
  limit: z.coerce
    .number()
    .int()
    .min(1)
    .max(MAX_LEADERBOARD_LIMIT)
    .default(DEFAULT_LEADERBOARD_LIMIT),
})

export type LeaderboardQueryParams = z.input<typeof LeaderboardQuerySchema>

/**
 * A submission: the circuit, and nothing else.
 *
 * ── Why the object is not `.strict()` ─────────────────────────────────────
 *
 * A client that sends `{ circuit, passed: true, fidelity: 1, gateCount: 1 }`
 * gets a 201 and a stored row saying what its circuit actually does. Zod strips
 * the extra keys here, so the handler never sees them; the handler recomputes
 * every one of those figures from the circuit regardless. Two layers, and
 * neither depends on the other.
 *
 * Refusing the body outright would also be safe, and it would make the property
 * *unobservable*: "the server ignores what you claim" and "the server rejects
 * requests that claim anything" are different promises, and only the first one
 * survives a client that starts sending a harmless extra field. The test that
 * matters — submit a lie about every figure, assert the stored row carries the
 * truth — can only be written against the first.
 *
 * The circuit is `unknown` on purpose. `parseCircuit` from @qsim/schema is the
 * whole contract, including the thirteen rules a shape cannot express, and §11
 * requires it to run before the engine sees anything. Declaring the shape twice
 * would mean two places to keep in step, and the weaker of the two would be the
 * one that ran first.
 */
export const SubmitChallengeBody = z.object({
  circuit: z.unknown(),
})

export type SubmitChallengeRequest = z.input<typeof SubmitChallengeBody>

function buildChallengeResponses<Timestamp extends z.ZodType>(
  timestamp: Timestamp
) {
  /**
   * One challenge, as a list card and as the page's own header.
   *
   * Everything here is a rule of the puzzle. There is no `targetData`, no
   * `title` and no `prompt` — see the header for both omissions.
   */
  const ChallengeResponse = z.object({
    slug: z.string(),
    /** 1–5. Renders as a rung, and orders the ladder with `orderIndex`. */
    difficulty: z.int(),
    qubitCount: z.int(),
    targetType: ChallengeTargetTypeSchema,
    /**
     * The gates a solution may use, as @qsim/schema gate ids. Empty means
     * "any gate the catalog has" — a challenge with no restriction rather than
     * one with no gates, which is why the client renders the empty case as its
     * own sentence instead of an empty list.
     */
    allowedGates: z.array(z.string()),
    maxGates: z.int().nullable(),
    /** The fidelity a submission has to reach. 0.99 unless the row says otherwise. */
    fidelityThreshold: z.number(),
    orderIndex: z.int(),
  })

  /**
   * What the server computed about one submission. Every number is
   * recomputed server-side from the circuit; none of it is echoed from the
   * request (risk 5).
   */
  const SubmissionResponse = z.object({
    passed: z.boolean(),
    fidelity: z.number(),
    gateCount: z.int(),
    depth: z.int(),
    createdAt: timestamp,
  })

  /**
   * One row of the leaderboard: §3.6 ranks by fewest gates, then least depth.
   *
   * ── One row per person, and every figure is the server's ──────────────
   *
   * A row is somebody's *best* passing attempt, not one of their attempts:
   * forty submissions of the same three-gate answer are one competitor. And
   * `gateCount` and `depth` are what the validator recomputed from the
   * submitted circuit — a client that claims a smaller number gains a stored
   * row saying the true one (risk 5).
   *
   * ── The circuit is deliberately absent ────────────────────────────────
   *
   * A leaderboard that published the winning circuit would publish the answer,
   * which is the same leak the target is protected from — one attempt later,
   * and from the person who is best at the puzzle. A rank is a name and two
   * numbers, and there is no field here for anything else.
   *
   * ── And no avatar, for the reason `embed.ts` gives ────────────────────
   *
   * A leaderboard is served to anyone, signed in or not, so an avatar URL on a
   * row would be "una petición a un tercero, y una dirección IP, por cada
   * lector" — the exact cost `packages/contract/src/embed.ts` omits the field
   * to avoid, and it applies with more force here, because this is the one
   * public listing of *people* (§3.6, decision 5). The field was declared,
   * selected and serialised while nothing rendered it; it is gone from all
   * three.
   *
   * ── Why `rank` can skip a number ──────────────────────────────────────
   *
   * It is a position over everybody who solved the challenge, assigned before
   * the readers who asked not to be listed were removed. A withheld row leaves
   * a gap, which says "somebody is here" and does not say who; renumbering to
   * close it would mean a reader's own standing disagreed with the table they
   * are looking at, and would let anyone promote the field by hiding.
   */
  const LeaderboardEntryResponse = z.object({
    rank: z.int(),
    username: z.string(),
    displayName: z.string().nullable(),
    gateCount: z.int(),
    depth: z.int(),
    createdAt: timestamp,
  })

  /**
   * Where *this* reader stands, however far down the table they are.
   *
   * §3.6 gives a challenge a table of positions; a table that only shows the
   * top ten answers "who is winning" and never "how am I doing", which is the
   * question the person reading it actually has. So the rank the viewer holds
   * travels with the page rather than being something they have to page down
   * to find — and it comes from the same ranked set the entries do, so the row
   * highlighted in the table and the line printed beside it cannot disagree.
   *
   * `listed` is false when this reader has opted out of appearing. Their rank
   * is still theirs: opting out withdraws a name from a public listing, not a
   * result from the standings.
   */
  const LeaderboardStandingResponse = z.object({
    rank: z.int(),
    gateCount: z.int(),
    depth: z.int(),
    createdAt: timestamp,
    listed: z.boolean(),
  })

  return {
    ChallengeResponse,
    SubmissionResponse,
    LeaderboardEntryResponse,
    LeaderboardStandingResponse,
    /**
     * The ladder. `solved` is the slugs *this viewer* has already passed —
     * a property of (challenge, viewer) rather than of the challenge, so it
     * rides in the envelope beside the items exactly as `starred` does on a
     * gallery page. Empty for an anonymous caller.
     */
    ChallengeListResponse: z.object({
      items: z.array(ChallengeResponse),
      solved: z.array(z.string()),
    }),
    /**
     * One challenge, plus this viewer's best passing attempt at it if they
     * have one. `best` and not `latest`: it is what the leaderboard would rank,
     * and it is what a reader wants to beat.
     */
    ChallengeEnvelope: z.object({
      challenge: ChallengeResponse,
      best: SubmissionResponse.nullable(),
    }),
    /** The verdict on one submission, with the diagnosis that teaches. */
    SubmissionEnvelope: z.object({
      submission: SubmissionResponse,
      feedback: z.array(ChallengeFeedbackSchema),
    }),
    /**
     * The table, plus where the reader asking for it stands.
     *
     * `standing` rides in the envelope rather than on an entry for the reason
     * `starred` and `solved` do: it is a property of the pair (challenge,
     * viewer) and not of the challenge. It is `null` for an anonymous caller
     * and for a signed-in one who has not solved this challenge yet — the two
     * are the same answer to "where do you stand", which is "nowhere yet", and
     * the client already knows which of them it is.
     */
    LeaderboardResponse: z.object({
      entries: z.array(LeaderboardEntryResponse),
      standing: LeaderboardStandingResponse.nullable(),
    }),
  }
}

/** For Fastify's serialiser: takes the `Date` the handler returns. */
export const serverChallengeResponses = buildChallengeResponses(serverTimestamp)

/** For the browser: takes the ISO-8601 string and yields a `Date`. */
export const wireChallengeResponses = buildChallengeResponses(wireTimestamp)

export type Challenge = z.infer<typeof wireChallengeResponses.ChallengeResponse>
export type ChallengeList = z.infer<
  typeof wireChallengeResponses.ChallengeListResponse
>
export type ChallengeView = z.infer<
  typeof wireChallengeResponses.ChallengeEnvelope
>
export type ChallengeSubmission = z.infer<
  typeof wireChallengeResponses.SubmissionResponse
>
export type ChallengeSubmissionResult = z.infer<
  typeof wireChallengeResponses.SubmissionEnvelope
>
export type LeaderboardEntry = z.infer<
  typeof wireChallengeResponses.LeaderboardEntryResponse
>
export type LeaderboardStanding = z.infer<
  typeof wireChallengeResponses.LeaderboardStandingResponse
>
export type Leaderboard = z.infer<
  typeof wireChallengeResponses.LeaderboardResponse
>
