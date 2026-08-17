/**
 * The comment routes of §8, as functions — Fase 5, M5.4.
 *
 * ── What this client deliberately does not do ─────────────────────────────
 *
 * It does not decide whether an anchor still resolves. `anchorOpId` comes back
 * exactly as it was stored, and the question "is that gate still in this
 * document" is answered by `features/comments/anchors.ts` against whatever the
 * tab is drawing — which may be the head version, an older one, or an unsaved
 * buffer no server has seen. A transport that filtered orphans would be
 * answering that question for one of the four documents and publishing the
 * answer as a fact about all of them.
 *
 * It also does not derive `viewerCanResolve`, `viewerCanDelete` or
 * `viewerCanComment`. Those travel in the response because there must be one
 * authority for an authorisation rule (see `@qsim/contract`'s `comments.ts`); a
 * second implementation here would eventually offer a button the server answers
 * 403 to, or hide one from somebody entitled to press it.
 */

import {
  PostCommentBody,
  commentPath,
  wireCommentResponses,
} from '@qsim/contract'
import type {
  CommentEnvelope,
  CommentPage,
  CommentQueryParams,
  PostCommentRequest,
  ThreadEnvelope,
} from '@qsim/contract'

import type { RequestContext } from './circuits.js'
import type { ApiClient } from './client.js'

/**
 * `GET /circuits/:id/comments` — one page of threads, plus the counts and the
 * anchor tally the canvas markers are drawn from.
 *
 * Addressed by *handle*, slug or id, for the reason every social route is: an id
 * reaches only the circuits a listing may show, while a slug also reaches an
 * UNLISTED one — which is exactly the reader who was sent a link.
 */
export function listComments(
  client: ApiClient,
  handle: string,
  params: CommentQueryParams = {},
  context: RequestContext = {}
): Promise<CommentPage> {
  return client.request({
    method: 'GET',
    path: commentPath.collection(handle),
    query: {
      state: params.state,
      anchorOpId: params.anchorOpId,
      page: params.page,
      limit: params.limit,
    },
    schema: wireCommentResponses.CommentPageResponse,
    ...context,
  })
}

/**
 * `POST /circuits/:id/comments` — a new thread, or a reply to one.
 *
 * The body is parsed through the contract's own schema before it is sent, which
 * is what makes the mutually exclusive pair (`parentId`, `anchorOpId`) a failure
 * here rather than a 400 from the server: a caller that sent both believes
 * something about where its comment landed, and the refusal is the only thing
 * that stops it believing it.
 */
export function postComment(
  client: ApiClient,
  handle: string,
  input: PostCommentRequest,
  context: RequestContext = {}
): Promise<CommentEnvelope> {
  return client.request({
    method: 'POST',
    path: commentPath.collection(handle),
    body: PostCommentBody.parse(input),
    schema: wireCommentResponses.CommentEnvelope,
    ...context,
  })
}

/**
 * `PUT`/`DELETE /circuits/:id/comments/:commentId/resolution` — close a thread
 * or reopen it.
 *
 * One function for both directions because they are one subresource with two
 * verbs, and both are idempotent: a retry after a dropped response must not
 * toggle the thread back. The whole thread comes back either way, which is what
 * keeps the marker, the filter's counts and the note on the thread from being
 * three optimistic guesses.
 */
export function setThreadResolution(
  client: ApiClient,
  handle: string,
  commentId: string,
  resolved: boolean,
  context: RequestContext = {}
): Promise<ThreadEnvelope> {
  return client.request({
    method: resolved ? 'PUT' : 'DELETE',
    path: commentPath.resolution(handle, commentId),
    schema: wireCommentResponses.ThreadEnvelope,
    ...context,
  })
}

/**
 * `DELETE /circuits/:id/comments/:commentId` — one comment.
 *
 * Deleting a root takes its replies with it (`ON DELETE CASCADE`), which is why
 * the caller has to be sure: the control that reaches this asks first.
 */
export function deleteComment(
  client: ApiClient,
  handle: string,
  commentId: string,
  context: RequestContext = {}
): Promise<void> {
  return client.request({
    method: 'DELETE',
    path: commentPath.item(handle, commentId),
    // 204: there is no body to parse, and reading one would throw.
    schema: null,
    ...context,
  })
}
