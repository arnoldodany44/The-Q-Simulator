/**
 * React Query hooks for comments anchored to gates — §9, §3.4 (Fase 5, M5.4).
 *
 * ── Every write invalidates the whole circuit's comments, and nothing else ──
 *
 * `useCollections` writes the response into the cache and refetches only what
 * the server alone can compute. This file does the opposite and refetches all of
 * one circuit's listings, which is a deliberate downgrade rather than
 * laziness — three of the numbers a panel renders cannot be patched from any
 * single response:
 *
 *   - `openCount` and `resolvedCount` move when a thread is resolved, and they
 *     are rendered on the *other* side of the filter, which is a cache entry the
 *     response says nothing about;
 *   - `anchors` is a tally over the whole circuit, so a new thread on a gate has
 *     to reach the marker layer even when the reader is filtered to another
 *     gate's threads;
 *   - `viewerCanComment` depends on `circuitTotal`, which no write returns.
 *
 * Patching two of the five and refetching the rest is how a panel comes to show
 * a marker for a thread it does not list. Invalidating `commentKeys.circuit()`
 * is one prefix and refetches only the listings of the circuit that changed.
 *
 * ── Nothing here touches the document store ────────────────────────────────
 *
 * §9 is explicit that Zustand owns the circuit being edited and React Query owns
 * what came from the server. A comment's anchor is an `operations[].id`, so it is
 * tempting to have a mutation reach into the store to check it — and that would
 * make posting a comment an edit to the document. The anchor is resolved for
 * *rendering*, in `features/comments/anchors.ts`, and never for writing.
 */

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import type {
  QueryClient,
  UseMutationResult,
  UseQueryResult,
} from '@tanstack/react-query'
import type {
  CommentEnvelope,
  CommentPage,
  CommentQueryParams,
  PostCommentRequest,
  ThreadEnvelope,
} from '@qsim/contract'

import { useApiClient } from './ApiContext.js'
import {
  deleteComment,
  listComments,
  postComment,
  setThreadResolution,
} from './comments.js'
import { commentKeys } from './queryKeys.js'

/** Every listing of one circuit's threads. See the header for why all of them. */
function invalidateComments(queryClient: QueryClient, handle: string): void {
  void queryClient.invalidateQueries({ queryKey: commentKeys.circuit(handle) })
}

/**
 * `GET /circuits/:id/comments` — one page of threads for one selection.
 *
 * Fetched as soon as a saved circuit is on screen rather than behind a
 * disclosure, unlike the version history. The reason is the markers: a gate
 * wearing an open question has to say so on first paint, and the tally that
 * draws those markers arrives with this listing. A panel nobody opens still owes
 * the reader the mark that tells them to open it.
 */
export function useComments(
  handle: string | null,
  params: CommentQueryParams = {},
  enabled = true
): UseQueryResult<CommentPage, unknown> {
  const client = useApiClient()
  return useQuery({
    queryKey: commentKeys.list(handle ?? '', params),
    queryFn: ({ signal }) => listComments(client, handle!, params, { signal }),
    enabled: enabled && handle !== null,
  })
}

export interface PostCommentVariables {
  /** The circuit's slug or id, whichever the caller holds. */
  readonly handle: string
  readonly input: PostCommentRequest
}

export function usePostComment(): UseMutationResult<
  CommentEnvelope,
  unknown,
  PostCommentVariables
> {
  const client = useApiClient()
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: ({ handle, input }: PostCommentVariables) =>
      postComment(client, handle, input),
    onSuccess: (_result, { handle }) => {
      invalidateComments(queryClient, handle)
    },
  })
}

export interface ThreadResolutionVariables {
  readonly handle: string
  /** The root's id. A reply has no resolution; the server answers 404. */
  readonly commentId: string
  readonly resolved: boolean
}

export function useResolveThread(): UseMutationResult<
  ThreadEnvelope,
  unknown,
  ThreadResolutionVariables
> {
  const client = useApiClient()
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: ({ handle, commentId, resolved }: ThreadResolutionVariables) =>
      setThreadResolution(client, handle, commentId, resolved),
    onSuccess: (_result, { handle }) => {
      invalidateComments(queryClient, handle)
    },
  })
}

export interface DeleteCommentVariables {
  readonly handle: string
  readonly commentId: string
}

export function useDeleteComment(): UseMutationResult<
  void,
  unknown,
  DeleteCommentVariables
> {
  const client = useApiClient()
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: ({ handle, commentId }: DeleteCommentVariables) =>
      deleteComment(client, handle, commentId),
    onSuccess: (_result, { handle }) => {
      invalidateComments(queryClient, handle)
    },
  })
}
