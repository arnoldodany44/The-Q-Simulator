/**
 * Lesson bookmarks — §3.6, §8, Phase 3.
 *
 * ── This is the route that is NOT the challenge route ─────────────────────
 *
 * §4 and risk 5 make the server authoritative for challenges: a submission is
 * re-simulated here, with the same engine, precisely so that a client cannot
 * mark its own homework — because a challenge has a leaderboard, and a
 * position is a thing worth lying for.
 *
 * A lesson has nothing to win. Nothing here is ranked, nothing is shown to
 * another reader, and this handler does not know how many steps a lesson has,
 * let alone whether the reader's circuit satisfied one. What it stores is a
 * bookmark that the same account asked it to store and only that account can
 * read back. The one thing a client could gain by lying is a different number
 * on its own screen next time it visits — which it can also obtain by pressing
 * "next", because a lesson's objective does not gate navigation either
 * (`features/lessons/format.ts` in `apps/web` argues that end).
 *
 * Writing that down matters because the two routes will sit next to each other
 * and look alike, and the wrong lesson to draw from this one is that the
 * challenge one can be equally relaxed.
 *
 * ── Both routes require a session, and neither takes a user id ────────────
 *
 * The address of the resource is (the caller, the slug), and the caller half
 * comes from the verified token — never from a path or a body. There is no
 * route for reading somebody else's progress, so there is no authorisation
 * decision here at all: the only reachable rows are the caller's own, by
 * construction rather than by a filter somebody has to remember to apply.
 *
 * ── The slug is stored without being resolved ─────────────────────────────
 *
 * There is no lesson table (see `@qsim/db`'s `lessons.ts`). The API accepts
 * any well-formed slug and stores it, which is what keeps "add a lesson" a
 * deploy of `apps/web` rather than a migration of the one shared database. A
 * bookmark for a lesson that no longer exists is one unused row, and the
 * client lists its own catalog rather than this response.
 */

import { LESSON_ROUTES } from '@qsim/contract'
import type { FastifyPluginCallback, FastifyRequest } from 'fastify'

import { ApiError } from '../errors.js'
import { requireViewerId } from '../plugins/auth.js'
import type { ZodTypeProvider } from '../plugins/validation.js'
import {
  LessonProgressEnvelope,
  LessonProgressListResponse,
  LessonSlugParams,
  UpdateLessonProgressBody,
} from './lessons.schemas.js'

const plugin: FastifyPluginCallback = (instance, _options, done) => {
  const app = instance.withTypeProvider<ZodTypeProvider>()

  /**
   * The caller's id, with their `public.User` row guaranteed to exist.
   *
   * `LessonProgress.userId` is a foreign key, and a lesson is very plausibly
   * the first authenticated thing a new account ever does — sign up, land on
   * the lessons index, start reading. So the write path brings the row into
   * existence the way `GET /me` does, rather than answering 404 to somebody
   * whose account is a minute old.
   */
  async function ownerId(request: FastifyRequest): Promise<string> {
    const identity = request.auth
    // Unreachable on a route declaring `auth: 'required'`; throwing rather
    // than asserting keeps a policy mistake a 401 instead of a 500.
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
    LESSON_ROUTES.progress,
    {
      config: { auth: 'required' },
      schema: { response: { 200: LessonProgressListResponse } },
    },
    async (request) => {
      /*
       * `requireViewerId` and not `ownerId`: reading creates nothing. An
       * account that has never written a bookmark has no `public.User` row
       * either, and the honest answer for it is an empty list rather than a
       * row inserted so that a `SELECT` could return nothing.
       */
      const items = await app.circuits.listLessonProgress(
        requireViewerId(request)
      )
      return { items }
    }
  )

  app.put(
    LESSON_ROUTES.item,
    {
      config: { auth: 'required' },
      schema: {
        params: LessonSlugParams,
        body: UpdateLessonProgressBody,
        response: { 200: LessonProgressEnvelope },
      },
    },
    async (request) => {
      const progress = await app.circuits.saveLessonProgress({
        userId: await ownerId(request),
        slug: request.params.slug,
        stepIndex: request.body.stepIndex,
        completed: request.body.completed,
      })
      return { progress }
    }
  )

  done()
}

export const lessonRoutes = plugin
