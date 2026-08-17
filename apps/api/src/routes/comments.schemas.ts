/**
 * The comment routes' schemas, as this process uses them — §3.4, M5.4.
 *
 * The shapes are in `@qsim/contract`; the path parameters are here, validated
 * against `@qsim/db`'s handle pattern, which the browser may not import (§12.3)
 * and does not need to.
 */

import { serverCommentResponses } from '@qsim/contract'
import { CIRCUIT_HANDLE_PATTERN } from '@qsim/db'
import { z } from 'zod'

export { CommentQuerySchema, PostCommentBody } from '@qsim/contract'

export const {
  CommentEnvelope,
  CommentPageResponse,
  CommentResponse,
  CommentThreadResponse,
  ThreadEnvelope,
} = serverCommentResponses

/**
 * The circuit and the comment a request names.
 *
 * A comment id is a `cuid(2)`, the same alphabet and length class as the
 * circuit handles `CIRCUIT_HANDLE_PATTERN` already describes, so the pattern is
 * reused rather than a second nearly-identical one written beside it — exactly
 * as `CollectionIdParams` does. It is a cheap gate rather than a statement about
 * what exists: it keeps a kilobyte of path, or a `%00`, from reaching an indexed
 * lookup, and the row is what decides existence.
 */
export const CommentTargetParams = z.object({
  id: z.string().regex(CIRCUIT_HANDLE_PATTERN),
  commentId: z.string().regex(CIRCUIT_HANDLE_PATTERN),
})
