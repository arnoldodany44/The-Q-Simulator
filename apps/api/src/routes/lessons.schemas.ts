/**
 * The lesson-progress routes' schemas, as this process uses them — §8,
 * Phase 3.
 *
 * Same division as `users.schemas.ts`: everything both ends must agree on
 * lives in `@qsim/contract`, and what stays here is the server-side
 * serialisation half — Fastify serialises through `serverLessonResponses`,
 * whose timestamp is the `Date` a handler holds, while the browser parses
 * through the wire twin, whose timestamp is the ISO-8601 string that arrives.
 */

import { serverLessonResponses } from '@qsim/contract'

export { LessonSlugParams, UpdateLessonProgressBody } from '@qsim/contract'

export const { LessonProgressEnvelope, LessonProgressListResponse } =
  serverLessonResponses
