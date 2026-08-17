/**
 * The lesson-progress routes of §8, as functions — Phase 3.
 *
 * Same rules as `account.ts` beside it: the path comes from `@qsim/contract`'s
 * builders, the response is parsed with its wire schemas, and nothing is
 * declared here.
 *
 * Both routes need a session. There is no anonymous variant and there must not
 * be: an anonymous reader's bookmark lives in `localStorage`, which is the
 * right store for it — it is a fact about this browser, nobody else can read
 * it, and it costs no round trip. See `features/lessons/progress.ts`.
 */

import {
  UpdateLessonProgressBody,
  lessonPath,
  wireLessonResponses,
} from '@qsim/contract'
import type { LessonProgress, LessonProgressList } from '@qsim/contract'

import type { ApiClient } from './client.js'
import type { RequestContext } from './circuits.js'

/** `GET /lessons/progress` — every lesson this caller has a bookmark in. */
export function listLessonProgress(
  client: ApiClient,
  context: RequestContext = {}
): Promise<LessonProgressList> {
  return client.request({
    method: 'GET',
    path: lessonPath.progress(),
    schema: wireLessonResponses.LessonProgressListResponse,
    ...context,
  })
}

/**
 * `PUT /lessons/:slug/progress` — where the reader stopped.
 *
 * The body goes through the contract schema before it is sent, like every
 * other write in this directory: the same schema the server validates with, so
 * an impossible step index is refused here rather than becoming a 400 nobody
 * can act on.
 */
export function saveLessonProgress(
  client: ApiClient,
  slug: string,
  progress: { stepIndex: number; completed: boolean },
  context: RequestContext = {}
): Promise<LessonProgress> {
  return client
    .request({
      method: 'PUT',
      path: lessonPath.item(slug),
      body: UpdateLessonProgressBody.parse(progress),
      schema: wireLessonResponses.LessonProgressEnvelope,
      ...context,
    })
    .then((envelope) => envelope.progress)
}
