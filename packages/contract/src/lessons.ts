/**
 * Lesson progress, as the wire carries it — §3.6, Phase 3.
 *
 * ── What the server stores, and what it deliberately does not ─────────────
 *
 * One row per (user, lesson): the step they stopped on, and whether they
 * reached the end. That is the whole resource, and its smallness is the
 * design. A lesson's *content* — the circuits, the objectives, the prose — is
 * static and lives in `apps/web`; the only thing the API has any business
 * knowing is a bookmark.
 *
 * In particular, the reader's circuit is not sent. It is tempting (resume
 * exactly where you were, mid-build) and it would turn a bookmark into a
 * document store with no versioning, no size limit worth the name and a copy
 * of §11's visibility problem. Somebody who wants to keep a circuit already
 * has `POST /circuits`.
 *
 * ── Why `PUT` and not `POST` ──────────────────────────────────────────────
 *
 * The address of the resource is `(the caller, this lesson)`, and the caller
 * is the token — so the client always knows the full address before it writes,
 * and writing twice must be the same as writing once. That is exactly `PUT`.
 * It also makes the offline story trivial: a client that is unsure whether its
 * last write landed can simply send it again.
 *
 * ── The slug is validated here, not looked up ─────────────────────────────
 *
 * The API has no lesson table and must not grow one to answer this: a lesson
 * is a file in the client, and the set of them changes with a deploy of
 * `apps/web` rather than with a migration. So the server takes any slug that
 * *could* be a lesson — the same lowercase alphabet a URL segment uses — and
 * stores it. The cost is that a client can bookmark a lesson that does not
 * exist; the consequence of that is one unused row, which the client ignores
 * because it iterates its own catalog rather than the response.
 *
 * The alternative — shipping the list of slugs into `@qsim/contract` so the
 * server could reject an unknown one — would mean that adding a lesson to the
 * web app requires deploying the API, which is the coupling this arrangement
 * exists to avoid.
 */

import { storableText } from '@qsim/schema'
import { z } from 'zod'
import { serverTimestamp, wireTimestamp } from './circuits.js'

/**
 * Longest lesson slug accepted. Generous against the nine §3.6 names —
 * `deutsch-jozsa`, `superdense-coding` — and short enough that the column is
 * an index rather than a body.
 */
export const MAX_LESSON_SLUG_LENGTH = 64

/**
 * Highest step index a client may bookmark.
 *
 * A bound rather than a policy: the server cannot know how many steps a
 * lesson has (see the header), so what it enforces is that the number is a
 * small non-negative integer and not an arbitrary one. A lesson with more than
 * 256 steps is not a lesson.
 */
export const MAX_LESSON_STEP_INDEX = 255

/**
 * The alphabet a slug may use: lowercase, digits, hyphen — the shape of a URL
 * segment, since that is what a slug is. Deliberately narrower than
 * `storableText` allows, because this value is echoed back in a response and
 * an alphabet is cheaper to reason about than an escaping rule.
 */
export const LESSON_SLUG_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/

export const LessonSlugSchema = storableText(
  z.string().min(1).max(MAX_LESSON_SLUG_LENGTH).regex(LESSON_SLUG_PATTERN)
)

export const LessonSlugParams = z.object({ slug: LessonSlugSchema })

export const UpdateLessonProgressBody = z.object({
  /** The step the reader is standing on, zero-based. */
  stepIndex: z.int().min(0).max(MAX_LESSON_STEP_INDEX),
  /**
   * Whether they have reached the end at least once.
   *
   * Stored as well as `stepIndex` rather than derived from it, because the
   * server does not know how long the lesson is — and because "finished, then
   * went back to re-read step 2" is a real state that a derived flag would
   * erase.
   */
  completed: z.boolean(),
})

export type UpdateLessonProgressRequest = z.input<
  typeof UpdateLessonProgressBody
>

function buildLessonResponses<Timestamp extends z.ZodType>(
  timestamp: Timestamp
) {
  const LessonProgressResponse = z.object({
    slug: z.string(),
    stepIndex: z.int(),
    completed: z.boolean(),
    updatedAt: timestamp,
  })

  return {
    LessonProgressResponse,
    LessonProgressEnvelope: z.object({ progress: LessonProgressResponse }),
    /*
     * Every lesson the caller has touched, in one response and with no
     * pagination. Nine lessons is the ceiling §3.6 sets, and a client that
     * renders the index needs all of them at once to draw the list — a paged
     * bookmark list would be a page of a page.
     */
    LessonProgressListResponse: z.object({
      items: z.array(LessonProgressResponse),
    }),
  }
}

export const serverLessonResponses = buildLessonResponses(serverTimestamp)
export const wireLessonResponses = buildLessonResponses(wireTimestamp)

export type LessonProgress = z.infer<
  typeof wireLessonResponses.LessonProgressResponse
>
export type LessonProgressList = z.infer<
  typeof wireLessonResponses.LessonProgressListResponse
>
