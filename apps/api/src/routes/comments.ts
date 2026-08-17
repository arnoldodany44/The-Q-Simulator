/**
 * Comments anchored to specific gates — §3.4, §14 (Fase 5, M5.4).
 *
 * ── The shape of every route here ─────────────────────────────────────────
 *
 * The same four steps `circuits.ts` and `collections.ts` follow, because Prisma
 * connects as `postgres` and bypasses row-level security, so each of these rules
 * is a `where` somebody has to remember:
 *
 *   1. resolve the circuit through `findReadable`, which applies §11 inside the
 *      query and answers `null` for "no such circuit" and "not yours to open"
 *      alike;
 *   2. `null` → 404, never 403;
 *   3. for a write, require a session — and for resolve or delete, let the
 *      repository's filter decide, so the answer is the same whether the row is
 *      missing or is not this caller's to touch;
 *   4. scope the write to the pair (circuit, viewer) *inside* the repository, so
 *      a future route that skips step 3 still cannot reach somebody else's row.
 *
 * ── Who may read, and who may write ──────────────────────────────────────
 *
 * Reading is `findReadable`, so the comments on a circuit are exactly as
 * reachable as the circuit: a stranger reads the threads on a PUBLIC one, the
 * holder of a link reads the threads on an UNLISTED one, and a PRIVATE
 * circuit's threads are its owner's alone.
 *
 * Writing is *also* `findReadable` plus a session, and that is the one place
 * this file departs from the collaboration channel of M5.2 — which is
 * `canEditCircuit`, the owner and nobody else. The two are different features
 * and the asymmetry is deliberate: an update to the document changes the
 * circuit, while a comment is an opinion *about* it, and §3.4 asks for comments
 * on public circuits, which would mean nothing if only the owner could leave
 * one. What bounds the surface is that a comment can never change what the
 * circuit computes, and that the owner can delete any of them.
 *
 * ── There is no PATCH ────────────────────────────────────────────────────
 *
 * A comment cannot be edited. That is a decision and not an omission: this is a
 * conversation with a resolution state, and "we discussed this and decided"
 * stops meaning anything if the thing that was said can be rewritten after
 * somebody replied to it or after somebody resolved the thread on the strength
 * of it. The remedies are the two that do not have that problem: reply, or
 * delete and say it again.
 *
 * ── What is deliberately not here: notification ──────────────────────────
 *
 * Nobody is emailed, and no bell appears anywhere. §14 does not ask for it and
 * it does not fall out of anything above for free: it needs a delivery
 * mechanism this project has none of, a preference to switch it off, and a
 * digest so that a busy thread is not thirty messages. The listing carries
 * `openCount` so the circuit page can show a number, which is the part that
 * *is* free, and that is where this milestone stops.
 */

import {
  COMMENT_ROUTES,
  MAX_REPLIES_PER_THREAD as CONTRACT_MAX_REPLIES,
  MAX_THREADS_PER_CIRCUIT as CONTRACT_MAX_THREADS,
} from '@qsim/contract'
import {
  MAX_REPLIES_PER_THREAD,
  MAX_THREADS_PER_CIRCUIT,
  ParentCommentNotFoundError,
  ReplyDepthError,
} from '@qsim/db'
import type { CommentContext, StoredComment, StoredThread } from '@qsim/db'
import type { FastifyInstance, FastifyPluginCallback } from 'fastify'
import type { FastifyRequest } from 'fastify'
import type { ApiEnv } from '../env.js'
import { ApiError } from '../errors.js'
import { requireViewerId, viewerIdOf } from '../plugins/auth.js'
import { strictRateLimit } from '../plugins/rate-limit.js'
import type { ZodTypeProvider } from '../plugins/validation.js'
import { CircuitHandleParams } from './circuits.schemas.js'
import {
  CommentEnvelope,
  CommentPageResponse,
  CommentQuerySchema,
  CommentTargetParams,
  PostCommentBody,
  ThreadEnvelope,
} from './comments.schemas.js'

/*
 * The bounds are declared in two packages — `@qsim/db` holds them beside the
 * queries they protect, `@qsim/contract` beside the request they describe — and
 * this is the assertion that keeps them one number. The same arrangement
 * `MAX_COLLECTION_ITEMS` already has.
 */
if (
  MAX_THREADS_PER_CIRCUIT !== CONTRACT_MAX_THREADS ||
  MAX_REPLIES_PER_THREAD !== CONTRACT_MAX_REPLIES
) {
  throw new Error(
    'Comment bounds disagree between @qsim/db and @qsim/contract: ' +
      `${String(MAX_THREADS_PER_CIRCUIT)}/${String(MAX_REPLIES_PER_THREAD)} ` +
      `vs ${String(CONTRACT_MAX_THREADS)}/${String(CONTRACT_MAX_REPLIES)}`
  )
}

export interface CommentRoutesOptions {
  readonly env: ApiEnv
}

/** The circuit this request names, or 404 — never 403, never a leak. */
async function readableCircuit(
  app: FastifyInstance,
  request: FastifyRequest,
  handle: string
) {
  const circuit = await app.circuits.findReadable(handle, viewerIdOf(request))
  if (circuit === null) throw new ApiError('NOT_FOUND')
  return circuit
}

/**
 * Whether this viewer may remove this comment: its author, or the circuit's
 * owner (moderation on one's own circuit).
 *
 * A *description* of the rule the repository's `deletableCommentFilter`
 * enforces, used only to fill `viewerCanDelete` in the response so that a
 * button and a 403 cannot disagree — see the note in the contract. The
 * enforcement is the `where`, never this.
 */
function mayDelete(
  comment: { author: { id: string } },
  ownerId: string,
  viewerId: string | null
): boolean {
  if (viewerId === null) return false
  return comment.author.id === viewerId || ownerId === viewerId
}

/** The same, for resolution: the thread's author or the circuit's owner. */
function mayResolve(
  thread: StoredThread,
  ownerId: string,
  viewerId: string | null
): boolean {
  return mayDelete(thread.root, ownerId, viewerId)
}

function toCommentBody(
  comment: StoredComment,
  ownerId: string,
  viewerId: string | null
) {
  return {
    id: comment.id,
    body: comment.body,
    anchorOpId: comment.anchorOpId,
    createdAt: comment.createdAt,
    author: {
      id: comment.author.id,
      username: comment.author.username,
      displayName: comment.author.displayName,
      avatarUrl: comment.author.avatarUrl,
    },
    viewerCanDelete: mayDelete(comment, ownerId, viewerId),
  }
}

function toThreadBody(
  thread: StoredThread,
  ownerId: string,
  viewerId: string | null
) {
  const resolvedBy = thread.root.resolvedBy
  return {
    root: toCommentBody(thread.root, ownerId, viewerId),
    replies: thread.replies.map((reply) =>
      toCommentBody(reply, ownerId, viewerId)
    ),
    resolvedAt: thread.root.resolvedAt,
    resolvedBy:
      resolvedBy === null
        ? null
        : {
            id: resolvedBy.id,
            username: resolvedBy.username,
            displayName: resolvedBy.displayName,
            avatarUrl: resolvedBy.avatarUrl,
          },
    viewerCanResolve: mayResolve(thread, ownerId, viewerId),
    /*
     * A form that cannot succeed should not be drawn. Anonymous readers cannot
     * reply, and neither can anybody once the thread is at its ceiling — the
     * server would answer 409, and finding that out by pressing Send is worse
     * than being told beforehand.
     */
    viewerCanReply:
      viewerId !== null && thread.replies.length < MAX_REPLIES_PER_THREAD,
  }
}

/**
 * Turns the repository's two "full" refusals into one response code, carrying
 * the detail that says which ceiling it was.
 *
 * Caught here rather than left to `DOMAIN_ERROR_CODES` — which maps both codes
 * correctly — because the mapping alone cannot attach `details`, and the
 * contract promises them.
 */
function asLimitReached(error: unknown): never {
  const code = (error as { code?: unknown }).code
  if (code === 'COMMENTS_FULL') {
    throw new ApiError('COMMENT_LIMIT_REACHED', {
      details: [{ path: 'circuit', code: 'too_big' }],
      cause: error,
    })
  }
  if (code === 'THREAD_FULL') {
    throw new ApiError('COMMENT_LIMIT_REACHED', {
      details: [{ path: 'body.parentId', code: 'too_big' }],
      cause: error,
    })
  }
  throw error as Error
}

const plugin: FastifyPluginCallback<CommentRoutesOptions> = (
  instance,
  options,
  done
) => {
  const app = instance.withTypeProvider<ZodTypeProvider>()
  const { env } = options

  /*
   * The stricter budget, on the one route that creates rows. `POST /circuits`
   * has it for the same reason: this is the shape an unattended script uses to
   * fill a table, and here the script does not even need to own anything —
   * every PUBLIC circuit accepts comments from strangers by design.
   */
  const postLimit = strictRateLimit(env)

  app.get(
    COMMENT_ROUTES.collection,
    {
      /*
       * Anonymous is the point: this is how the threads on a PUBLIC circuit are
       * read, and how a link to an UNLISTED one works at all. The viewer id
       * decides twice — whether the circuit may be opened, and what
       * `viewerCan*` says about each thread.
       *
       * No `scope` on any route in this file, which `plugins/auth.ts` defines
       * as "unreachable with an API key, whatever its scopes". A key exists to
       * create circuits and run simulations (§3.5); reading a conversation is
       * not part of that, and writing into one certainly is not — a credential
       * that could post on every public circuit in the gallery is a spam engine
       * with an audit trail, and revoking it would not unsay anything.
       */
      config: { auth: 'optional' },
      schema: {
        params: CircuitHandleParams,
        querystring: CommentQuerySchema,
        response: { 200: CommentPageResponse },
      },
    },
    async (request) => {
      const circuit = await readableCircuit(app, request, request.params.id)
      const viewerId = viewerIdOf(request)
      const { state, anchorOpId, page, limit } = request.query

      const result = await app.circuits.listComments({
        circuitId: circuit.id,
        state,
        ...(anchorOpId === undefined ? {} : { anchorOpId }),
        skip: (page - 1) * limit,
        take: limit,
      })

      return {
        threads: result.threads.map((thread) =>
          toThreadBody(thread, circuit.ownerId, viewerId)
        ),
        page,
        limit,
        total: result.total,
        openCount: result.openCount,
        resolvedCount: result.resolvedCount,
        anchors: result.anchors,
        /*
         * Whether the composer is drawn at all. Against `circuitTotal` and not
         * against `openCount + resolvedCount`, because those two are narrowed by
         * `anchorOpId` — comparing a ceiling on the circuit with a count of one
         * gate's threads would offer a form the server refuses.
         */
        viewerCanComment:
          viewerId !== null && result.circuitTotal < MAX_THREADS_PER_CIRCUIT,
      }
    }
  )

  app.post(
    COMMENT_ROUTES.collection,
    {
      config: { auth: 'required', rateLimit: postLimit },
      schema: {
        params: CircuitHandleParams,
        body: PostCommentBody,
        response: { 201: CommentEnvelope },
      },
    },
    async (request, reply) => {
      const viewerId = requireViewerId(request)
      /*
       * The circuit is resolved through the ordinary filter, so a comment on
       * somebody else's PRIVATE circuit is a 404 here exactly as it is on GET.
       * "You cannot write into a conversation you cannot read" is therefore a
       * property of the query rather than of this handler remembering.
       */
      const circuit = await readableCircuit(app, request, request.params.id)

      /*
       * `ensureOwner` is deliberately absent, unlike `POST /collections`.
       * `Comment.userId` is a foreign key onto `public.User`, and a session that
       * has never written anything has no row there — but a commenter always
       * does, because `GET /me` runs on sign-in and creates it. The reason not to
       * paper over it here is that `ensureOwner` writes: putting a write on the
       * path of every comment would mean a route that creates a user row on
       * behalf of a token this API has never otherwise seen. If the foreign key
       * fails, the answer is the 500 that says so, not a row invented to avoid
       * it.
       */
      const { body, anchorOpId, parentId } = request.body

      try {
        const comment = await app.circuits.postComment({
          circuitId: circuit.id,
          userId: viewerId,
          body,
          ...(parentId === undefined ? {} : { parentId }),
          // A reply's anchor is read from its root by the repository; sending
          // one here is refused by the schema.
          ...(anchorOpId === undefined || anchorOpId === null
            ? {}
            : { anchorOpId }),
        })

        reply.status(201)
        return { comment: toCommentBody(comment, circuit.ownerId, viewerId) }
      } catch (error) {
        /*
         * A `parentId` that names nothing, or names a reply, is a bad *field* in
         * a well-formed request — so it is a 400 naming the field rather than a
         * 404, which on this route would read as "no such circuit" and send the
         * caller to check the wrong thing.
         */
        if (error instanceof ParentCommentNotFoundError) {
          throw new ApiError('VALIDATION_FAILED', {
            details: [{ path: 'body.parentId', code: 'invalid_value' }],
            cause: error,
          })
        }
        if (error instanceof ReplyDepthError) {
          throw new ApiError('VALIDATION_FAILED', {
            details: [{ path: 'body.parentId', code: 'reply_depth' }],
            cause: error,
          })
        }
        return asLimitReached(error)
      }
    }
  )

  app.put(
    COMMENT_ROUTES.resolution,
    {
      config: { auth: 'required' },
      schema: {
        params: CommentTargetParams,
        response: { 200: ThreadEnvelope },
      },
    },
    async (request) =>
      setResolution(app, request, request.params, {
        circuitHandle: request.params.id,
        resolved: true,
      })
  )

  app.delete(
    COMMENT_ROUTES.resolution,
    {
      config: { auth: 'required' },
      schema: {
        params: CommentTargetParams,
        response: { 200: ThreadEnvelope },
      },
    },
    async (request) =>
      setResolution(app, request, request.params, {
        circuitHandle: request.params.id,
        resolved: false,
      })
  )

  app.delete(
    COMMENT_ROUTES.item,
    {
      config: { auth: 'required' },
      schema: { params: CommentTargetParams },
    },
    async (request, reply) => {
      const viewerId = requireViewerId(request)
      const circuit = await readableCircuit(app, request, request.params.id)

      /*
       * Resolved first so that "no such comment" and "not yours to delete" can
       * be told apart — 404 and 403 respectively, which is the pair §11 asks
       * for once the caller has already proved they may read the circuit.
       */
      const context = await app.circuits.findCommentContext({
        circuitId: circuit.id,
        commentId: request.params.commentId,
      })
      if (context === null) throw new ApiError('NOT_FOUND')
      if (!mayDeleteContext(context, circuit.ownerId, viewerId)) {
        throw new ApiError('FORBIDDEN')
      }

      /*
       * The filter decides again inside the repository, so the check above is a
       * better error message rather than the security. Replies go with a root by
       * `ON DELETE CASCADE` (M5.4's migration), which is also what makes
       * deleting a thread one statement instead of a walk.
       */
      const removed = await app.circuits.deleteComment({
        circuitId: circuit.id,
        commentId: context.id,
        viewerId,
        ownerId: circuit.ownerId,
      })
      if (!removed) throw new ApiError('NOT_FOUND')
      return reply.status(204).send()
    }
  )

  done()
}

/** `mayDelete`, for the context projection rather than a whole comment. */
function mayDeleteContext(
  context: CommentContext,
  ownerId: string,
  viewerId: string
): boolean {
  return context.authorId === viewerId || ownerId === viewerId
}

/**
 * Both directions of resolution, which differ by one boolean.
 *
 * Answers with the whole thread rather than 204, for the reason the star routes
 * answer with a state: the client has just changed something rendered in three
 * places — the marker on the canvas, the filter's counts, the note on the thread
 * — and the alternative is an optimistic guess that drifts the first time two
 * tabs disagree.
 */
async function setResolution(
  app: FastifyInstance,
  request: FastifyRequest,
  params: { commentId: string },
  options: { circuitHandle: string; resolved: boolean }
) {
  const viewerId = requireViewerId(request)
  const circuit = await app.circuits.findReadable(
    options.circuitHandle,
    viewerIdOf(request)
  )
  if (circuit === null) throw new ApiError('NOT_FOUND')

  const context = await app.circuits.findCommentContext({
    circuitId: circuit.id,
    commentId: params.commentId,
  })
  if (context === null) throw new ApiError('NOT_FOUND')
  /*
   * A reply has no resolution, and asking to resolve one is a request about the
   * wrong resource rather than a permission problem: 404, because the thing
   * being addressed — a thread with this id — does not exist.
   */
  if (context.parentId !== null) throw new ApiError('NOT_FOUND')
  if (!mayDeleteContext(context, circuit.ownerId, viewerId)) {
    throw new ApiError('FORBIDDEN')
  }

  await app.circuits.setThreadResolution({
    circuitId: circuit.id,
    rootId: context.id,
    viewerId,
    ownerId: circuit.ownerId,
    resolved: options.resolved,
  })

  const thread = await app.circuits.findThread({
    circuitId: circuit.id,
    rootId: context.id,
  })
  // Only reachable if it was deleted between the write and the read.
  if (thread === null) throw new ApiError('NOT_FOUND')
  return { thread: toThreadBody(thread, circuit.ownerId, viewerId) }
}

export const commentRoutes = plugin
