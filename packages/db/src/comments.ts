import type { Prisma, PrismaClient } from './generated/prisma/client.js'
import { publicUserSelect } from './projections.js'
import type { PublicUser } from './projections.js'

/**
 * Comments anchored to specific gates — §3.4, §14 (Fase 5, M5.4).
 *
 * ── What this file is and is not responsible for ──────────────────────────
 *
 * It is responsible for the *shape* of a conversation: a root and its replies,
 * two levels, resolution on the root, and the bounds that keep a table anybody
 * who can read a circuit may write into from growing without limit.
 *
 * It is emphatically **not** responsible for deciding whether an anchor still
 * names an operation. Nothing here reads a circuit document, and that is a
 * deliberate omission rather than a gap:
 *
 *   - the operations live in `CircuitVersion.data`, a `jsonb` column, and there
 *     are several of them per circuit;
 *   - the document a reader is actually looking at may be the head version, an
 *     older version, the live CRDT session of M5.2, or an unsaved buffer in one
 *     tab, and those four disagree about which ids exist;
 *   - so any answer this layer gave would be a claim about one document,
 *     published as a fact about all of them.
 *
 * The column records what the comment is about; the client resolves it against
 * whatever it is drawing. The whole argument, including why that makes
 * delete-then-undo work with no writes at all, is in `@qsim/contract`'s
 * `comments.ts`.
 *
 * ── Two levels, enforced here as well as in the response shape ────────────
 *
 * `@qsim/contract` makes a third level unrepresentable on the wire — a reply
 * carries no `replies` — but a repository that accepted one would still store
 * it, and it would then be invisible rather than absent. So `postComment`
 * resolves the parent and refuses when the parent itself has one
 * (`ReplyDepthError`). The check and the shape agree; neither is load-bearing
 * alone.
 *
 * ── Where §11 is, and where it is not ─────────────────────────────────────
 *
 * Not here. Every function below takes a `circuitId` that the *route* has
 * already resolved through `findReadable`, which is the one door that applies
 * the visibility rules (`visibility.ts`). A second filter here would be a
 * second implementation of §11, and the value of having exactly one is that it
 * is the one that gets reviewed.
 *
 * What this file does own is the narrower authorisation of the actions
 * themselves — who may resolve, who may delete — because those are properties
 * of a comment and its circuit rather than of visibility. They are expressed as
 * `where` clauses on the write (`canResolveThreadFilter`,
 * `deletableCommentFilter`) and not as an `if` in a handler, so a future route
 * that forgets to check still cannot touch a row it may not.
 */

/**
 * Most root threads one circuit may carry, and most replies one thread may
 * carry. Mirrors the constants in `@qsim/contract`, which is where the argument
 * is; `apps/api` asserts the two agree.
 */
export const MAX_THREADS_PER_CIRCUIT = 200
export const MAX_REPLIES_PER_THREAD = 100

/**
 * Which threads a listing wants. Re-declared here rather than imported: this
 * package may not reach `@qsim/contract` (§12.3), and `apps/api` asserts the two
 * vocabularies agree — the same arrangement `Visibility` already has.
 */
export type CommentState = 'open' | 'resolved' | 'all'

/** Raised when a circuit already holds `MAX_THREADS_PER_CIRCUIT` threads. */
export class CircuitCommentsFullError extends Error {
  readonly code = 'COMMENTS_FULL'

  constructor(readonly circuitId: string) {
    super(
      `Circuit ${circuitId} already holds ${String(MAX_THREADS_PER_CIRCUIT)} ` +
        `comment threads`
    )
    this.name = 'CircuitCommentsFullError'
  }
}

/** Raised when a thread already holds `MAX_REPLIES_PER_THREAD` replies. */
export class ThreadFullError extends Error {
  readonly code = 'THREAD_FULL'

  constructor(readonly parentId: string) {
    super(
      `Thread ${parentId} already holds ${String(MAX_REPLIES_PER_THREAD)} ` +
        `replies`
    )
    this.name = 'ThreadFullError'
  }
}

/**
 * Raised when the named parent is not a root — a reply to a reply.
 *
 * A distinct error from "no such parent" because they mean different things to
 * a client: one is a stale id, the other is a request the product does not have
 * a shape for. Both are refusals rather than repairs; quietly re-parenting to
 * the root would put a sentence under a different sentence than the author
 * chose, which is the same class of mistake as a coordinate anchor.
 */
export class ReplyDepthError extends Error {
  readonly code = 'REPLY_DEPTH'

  constructor(readonly parentId: string) {
    super(`Comment ${parentId} is itself a reply and cannot be replied to`)
    this.name = 'ReplyDepthError'
  }
}

/** Raised when the named parent does not exist, or is on another circuit. */
export class ParentCommentNotFoundError extends Error {
  readonly code = 'PARENT_NOT_FOUND'

  constructor(readonly parentId: string) {
    super(`No comment ${parentId} on this circuit`)
    this.name = 'ParentCommentNotFoundError'
  }
}

/** One stored comment, with its author already projected. */
export interface StoredComment {
  readonly id: string
  readonly circuitId: string
  readonly body: string
  /** `operations[].id` from §6, or `null` for a comment about the circuit. */
  readonly anchorOpId: string | null
  readonly parentId: string | null
  readonly createdAt: Date
  readonly author: PublicUser
  /** Only ever set on a root; `null` on every reply. */
  readonly resolvedAt: Date | null
  readonly resolvedBy: PublicUser | null
}

/** A root and its replies, oldest first within each. */
export interface StoredThread {
  readonly root: StoredComment
  readonly replies: readonly StoredComment[]
}

/** How many threads hang off one operation, split by state. */
export interface AnchorTally {
  readonly open: number
  readonly resolved: number
}

/** One page of a circuit's threads, plus the numbers a panel renders. */
export interface CommentThreadPage {
  readonly threads: readonly StoredThread[]
  /** Threads matching the requested state, across every page. */
  readonly total: number
  /**
   * The two sides of the state filter, narrowed by `anchorOpId` exactly as
   * `total` is — they are what the panel's own toggle counts.
   */
  readonly openCount: number
  readonly resolvedCount: number
  /**
   * Every root thread on the circuit, narrowed by nothing.
   *
   * A separate number because the three above answer "how many match what you
   * asked for" and this one answers "is this circuit full" — and once
   * `anchorOpId` narrows a request, the sum of the other two is a count of one
   * gate's threads. A flag derived from that sum would tell a reader they may
   * start a thread on a circuit that has refused every one for a week.
   */
  readonly circuitTotal: number
  /**
   * Every anchored operation in the circuit, tallied — not merely the ones on
   * this page. The canvas draws one marker per anchor, and a page-shaped tally
   * would leave markers missing from gates whose conversation is on page two.
   */
  readonly anchors: Readonly<Record<string, AnchorTally>>
}

export interface ListCommentsInput {
  readonly circuitId: string
  /** `'all'` includes resolved threads; see the contract on the default. */
  readonly state: CommentState
  /** Narrows to one gate's threads, which is what clicking a marker asks. */
  readonly anchorOpId?: string
  readonly skip: number
  readonly take: number
}

export interface PostCommentInput {
  readonly circuitId: string
  /** The verified `sub` of the author. Never a value from a request body. */
  readonly userId: string
  readonly body: string
  /** Ignored when `parentId` is given: a reply inherits its root's anchor. */
  readonly anchorOpId?: string | null
  readonly parentId?: string
}

export interface CommentRepository {
  /** One page of a circuit's threads, plus the counts and the anchor tally. */
  listComments(input: ListCommentsInput): Promise<CommentThreadPage>

  /**
   * @throws {CircuitCommentsFullError} at `MAX_THREADS_PER_CIRCUIT`.
   * @throws {ThreadFullError} at `MAX_REPLIES_PER_THREAD`.
   * @throws {ParentCommentNotFoundError} for a parent on another circuit.
   * @throws {ReplyDepthError} for a reply to a reply.
   */
  postComment(input: PostCommentInput): Promise<StoredComment>

  /** One thread by the id of its root, or `null`. */
  findThread(input: {
    circuitId: string
    rootId: string
  }): Promise<StoredThread | null>

  /**
   * One comment's authorisation facts — its author, its circuit's owner, and
   * whether it is a root. What a route needs to answer 403 rather than 404, and
   * to tell a thread from a reply before acting on it.
   */
  findCommentContext(input: {
    circuitId: string
    commentId: string
  }): Promise<CommentContext | null>

  /**
   * Resolves or reopens a thread. Scoped to the root *and* to the two people
   * entitled to do it, so a route that skipped its check still could not.
   *
   * Idempotent in both directions: resolving a resolved thread rewrites the
   * same fact, and the route answers with the thread either way.
   *
   * `false` means no row matched — the comment is gone, is a reply rather than a
   * root, or this viewer is neither its author nor the circuit's owner.
   */
  setThreadResolution(input: {
    circuitId: string
    rootId: string
    /** The verified viewer. `null` is never permitted to resolve. */
    viewerId: string
    /** The circuit's owner, so the filter can admit them too. */
    ownerId: string
    resolved: boolean
  }): Promise<boolean>

  /**
   * Deletes one comment. Replies go with a root by `ON DELETE CASCADE`.
   *
   * Scoped to the author or the circuit's owner in the `where`, for the same
   * reason the resolution write is: the rule lives in the statement.
   */
  deleteComment(input: {
    circuitId: string
    commentId: string
    viewerId: string
    ownerId: string
  }): Promise<boolean>
}

/** What a route needs to know about a comment before acting on it. */
export interface CommentContext {
  readonly id: string
  readonly authorId: string
  readonly parentId: string | null
  readonly resolvedAt: Date | null
}

/**
 * The author's own projection, and the resolver's.
 *
 * `publicUserSelect` and nothing else, which is the point: it does not select
 * `User.email`, so there is no path from this query to the one column that must
 * never reach another user's browser (§11). A comment is user content shown to
 * other users, and so is the name beside it.
 */
const commentSelect = {
  id: true,
  circuitId: true,
  body: true,
  anchorOpId: true,
  parentId: true,
  createdAt: true,
  resolvedAt: true,
  user: { select: publicUserSelect },
  resolvedBy: { select: publicUserSelect },
} as const

interface CommentRow {
  id: string
  circuitId: string
  body: string
  anchorOpId: string | null
  parentId: string | null
  createdAt: Date
  resolvedAt: Date | null
  user: PublicUser
  resolvedBy: PublicUser | null
}

function toStoredComment(row: CommentRow): StoredComment {
  return {
    id: row.id,
    circuitId: row.circuitId,
    body: row.body,
    anchorOpId: row.anchorOpId,
    parentId: row.parentId,
    createdAt: row.createdAt,
    author: row.user,
    /*
     * Normalised to `null` on a reply rather than trusted. Only a root is ever
     * written with these, but a listing renders "resolved by X" from them, and
     * a stray value on a reply would draw that note in the wrong place.
     */
    resolvedAt: row.parentId === null ? row.resolvedAt : null,
    resolvedBy: row.parentId === null ? row.resolvedBy : null,
  }
}

/**
 * "Threads of this circuit", as a `where` fragment — roots only.
 *
 * `parentId: null` is what makes a thread a thread. Without it a listing would
 * return replies as top-level rows, which is the shape the panel is built to
 * make impossible.
 */
export function threadFilter(input: {
  circuitId: string
  state: CommentState
  anchorOpId?: string
}): Prisma.CommentWhereInput {
  return {
    circuitId: input.circuitId,
    parentId: null,
    ...(input.state === 'all' ? {} : { resolvedAt: stateClause(input.state) }),
    ...(input.anchorOpId === undefined ? {} : { anchorOpId: input.anchorOpId }),
  }
}

function stateClause(state: 'open' | 'resolved'): null | { not: null } {
  return state === 'open' ? null : { not: null }
}

/**
 * Who may resolve a thread: its author, or the circuit's owner.
 *
 * Both, and deliberately not one of them. The owner, because it is their
 * circuit and a thread nobody can close is graffiti on it. The author, because
 * "never mind, I was wrong" should not require somebody else's attention. And
 * emphatically *not* any commenter: a stranger closing somebody else's open
 * question is the failure this pair of clauses exists to prevent.
 */
export function canResolveThreadFilter(input: {
  circuitId: string
  rootId: string
  viewerId: string
  ownerId: string
}): Prisma.CommentWhereInput {
  return {
    id: input.rootId,
    circuitId: input.circuitId,
    // A reply has no resolution to set. Part of the filter rather than a
    // check, so the write cannot land on one.
    parentId: null,
    ...(input.viewerId === input.ownerId ? {} : { userId: input.viewerId }),
  }
}

/**
 * Who may delete a comment: its author, or the circuit's owner.
 *
 * The owner's half is moderation, and it is the only reason it exists: a public
 * circuit accepts comments from strangers, so its owner needs a way to remove
 * one without asking a database administrator. It is scoped to their own
 * circuit by the `circuitId` in the same object.
 */
export function deletableCommentFilter(input: {
  circuitId: string
  commentId: string
  viewerId: string
  ownerId: string
}): Prisma.CommentWhereInput {
  return {
    id: input.commentId,
    circuitId: input.circuitId,
    ...(input.viewerId === input.ownerId ? {} : { userId: input.viewerId }),
  }
}

export function prismaCommentRepository(
  prisma: PrismaClient
): CommentRepository {
  const repliesOf = async (
    circuitId: string,
    rootIds: readonly string[]
  ): Promise<Map<string, StoredComment[]>> => {
    const byRoot = new Map<string, StoredComment[]>()
    if (rootIds.length === 0) return byRoot

    const rows = await prisma.comment.findMany({
      where: { circuitId, parentId: { in: [...rootIds] } },
      select: commentSelect,
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
      /*
       * The bound is stated in the query rather than assumed from
       * `MAX_REPLIES_PER_THREAD`. The write side holds that ceiling, but a
       * ceiling enforced on writes is a claim about rows written *since* it
       * existed, and this is the read that a page of twenty threads pays for.
       */
      take: rootIds.length * MAX_REPLIES_PER_THREAD,
    })

    for (const row of rows) {
      const parentId = row.parentId
      if (parentId === null) continue
      const list = byRoot.get(parentId)
      if (list === undefined) byRoot.set(parentId, [toStoredComment(row)])
      else list.push(toStoredComment(row))
    }
    return byRoot
  }

  return {
    async listComments({ circuitId, state, anchorOpId, skip, take }) {
      const where = threadFilter({ circuitId, state, anchorOpId })

      const [roots, total, openCount, resolvedCount, circuitTotal, anchorRows] =
        await Promise.all([
          prisma.comment.findMany({
            where,
            select: commentSelect,
            // Oldest first: a conversation reads in the order it happened, and
            // this is the order `Comment_circuitId_createdAt_idx` holds.
            orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
            skip,
            take,
          }),
          prisma.comment.count({ where }),
          prisma.comment.count({
            where: threadFilter({ circuitId, state: 'open', anchorOpId }),
          }),
          prisma.comment.count({
            where: threadFilter({ circuitId, state: 'resolved', anchorOpId }),
          }),
          // Unnarrowed: "is this circuit full", which is a different question
          // from any of the three above. See `circuitTotal`.
          prisma.comment.count({
            where: threadFilter({ circuitId, state: 'all' }),
          }),
          /*
           * The anchor tally, over the whole circuit and both states at once.
           * `groupBy` rather than one count per operation: the canvas needs
           * every marker, and a query per gate would be a query per gate.
           *
           * Deliberately not narrowed by `state` or by `anchorOpId` — a marker
           * has to appear on a gate whose only thread is resolved, and on
           * gates other than the one currently filtered to, or the filter
           * would hide the way back out of itself.
           */
          prisma.comment.groupBy({
            by: ['anchorOpId', 'resolvedAt'],
            where: {
              circuitId,
              parentId: null,
              anchorOpId: { not: null },
            },
            _count: { _all: true },
          }),
        ])

      const anchors: Record<string, AnchorTally> = {}
      for (const row of anchorRows) {
        const key = row.anchorOpId
        if (key === null) continue
        const current = anchors[key] ?? { open: 0, resolved: 0 }
        const count = row._count._all
        anchors[key] =
          row.resolvedAt === null
            ? { open: current.open + count, resolved: current.resolved }
            : { open: current.open, resolved: current.resolved + count }
      }

      const byRoot = await repliesOf(
        circuitId,
        roots.map((row) => row.id)
      )

      return {
        threads: roots.map((row) => ({
          root: toStoredComment(row),
          replies: byRoot.get(row.id) ?? [],
        })),
        total,
        openCount,
        resolvedCount,
        circuitTotal,
        anchors,
      }
    },

    async postComment({ circuitId, userId, body, anchorOpId, parentId }) {
      /*
       * A reply's anchor is its root's, always. Read from the parent rather
       * than accepted from the caller — the contract refuses a body carrying
       * both, and this is the other half: even a caller that got past the
       * schema cannot make a reply point somewhere its thread does not.
       */
      if (parentId !== undefined) {
        const parent = await prisma.comment.findFirst({
          where: { id: parentId, circuitId },
          select: {
            id: true,
            parentId: true,
            anchorOpId: true,
            _count: { select: { replies: true } },
          },
        })
        if (parent === null) throw new ParentCommentNotFoundError(parentId)
        if (parent.parentId !== null) throw new ReplyDepthError(parentId)
        if (parent._count.replies >= MAX_REPLIES_PER_THREAD) {
          throw new ThreadFullError(parentId)
        }

        const created = await prisma.comment.create({
          data: {
            circuitId,
            userId,
            body,
            parentId: parent.id,
            anchorOpId: parent.anchorOpId,
          },
          select: commentSelect,
        })
        return toStoredComment(created)
      }

      /*
       * The ceiling is checked and then written, which is a race — two
       * simultaneous posts can both see 199. It is deliberately not closed with
       * a lock or a transaction: the failure mode is one comment past the
       * bound, and a `SELECT … FOR UPDATE` on the whole circuit's comments
       * would serialise every post on a pooler whose connection budget is one.
       * The bound exists to stop unbounded growth, and 201 threads is bounded.
       */
      const threads = await prisma.comment.count({
        where: { circuitId, parentId: null },
      })
      if (threads >= MAX_THREADS_PER_CIRCUIT) {
        throw new CircuitCommentsFullError(circuitId)
      }

      const created = await prisma.comment.create({
        data: {
          circuitId,
          userId,
          body,
          // `null` is "about the circuit", which is what §3.4's comments were
          // before this milestone; `undefined` would mean the same to Prisma,
          // but saying it explicitly keeps the two cases visible here.
          anchorOpId: anchorOpId ?? null,
        },
        select: commentSelect,
      })
      return toStoredComment(created)
    },

    async findThread({ circuitId, rootId }) {
      const root = await prisma.comment.findFirst({
        where: { id: rootId, circuitId, parentId: null },
        select: commentSelect,
      })
      if (root === null) return null
      const byRoot = await repliesOf(circuitId, [root.id])
      return { root: toStoredComment(root), replies: byRoot.get(root.id) ?? [] }
    },

    async findCommentContext({ circuitId, commentId }) {
      const row = await prisma.comment.findFirst({
        where: { id: commentId, circuitId },
        select: {
          id: true,
          userId: true,
          parentId: true,
          resolvedAt: true,
        },
      })
      if (row === null) return null
      return {
        id: row.id,
        authorId: row.userId,
        parentId: row.parentId,
        resolvedAt: row.resolvedAt,
      }
    },

    async setThreadResolution({
      circuitId,
      rootId,
      viewerId,
      ownerId,
      resolved,
    }) {
      const result = await prisma.comment.updateMany({
        where: canResolveThreadFilter({
          circuitId,
          rootId,
          viewerId,
          ownerId,
        }),
        data: resolved
          ? { resolvedAt: new Date(), resolvedById: viewerId }
          : // Reopening clears both. A thread that is open and remembers who
            // once closed it would render "resolved by X" beside an open
            // question.
            { resolvedAt: null, resolvedById: null },
      })
      return result.count > 0
    },

    async deleteComment({ circuitId, commentId, viewerId, ownerId }) {
      const result = await prisma.comment.deleteMany({
        where: deletableCommentFilter({
          circuitId,
          commentId,
          viewerId,
          ownerId,
        }),
      })
      return result.count > 0
    },
  }
}
