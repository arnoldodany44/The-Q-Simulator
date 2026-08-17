/**
 * Comments anchored to specific gates — §3.4, §14 (Fase 5, M5.4).
 *
 * ══════════════════════════════════════════════════════════════════════════
 * THE ANCHOR IS AN OPERATION ID, AND NOTHING ELSE IS ADMISSIBLE
 *
 * A comment says something about "the `H` on q0 at column 3". The obvious way
 * to record that is the coordinate pair, and it is wrong in a way that is worse
 * than losing the comment: insert a column before it and the anchor now points
 * at whatever moved into that cell. Nothing fails, nothing is empty — a reader
 * is simply shown a stranger's sentence about the gate they are looking at,
 * attributed to a person who never said it. A comment that has vanished is an
 * annoyance; a comment that has silently changed its subject is a lie.
 *
 * So the anchor is `operations[].id`, which §6 already gives every operation
 * and which the editor's store treats as the operation's identity: `moveTo`
 * keeps it, `addQubit`, `removeQubit` and `reorderQubits` remap coordinates and
 * keep it, and a *new* operation never receives an id that is in use
 * (`idAllocator` skips taken ids and `paste` always mints fresh ones). That
 * last property is the one doing the security work here: because an id is never
 * recycled, an anchor can fail to resolve but it can never resolve to the wrong
 * gate.
 *
 * ══════════════════════════════════════════════════════════════════════════
 * WHERE "DOES THE ANCHOR STILL RESOLVE?" IS ANSWERED: NOT HERE, AND NOT IN
 * THE DATABASE
 *
 * There is no `orphaned` column and no `orphaned` field in any response below.
 * Orphanhood is not a property of a comment. It is a property of the *pair*
 * (comment, document being displayed), and the documents differ:
 *
 *   - the head version, which is what a gallery visitor opens;
 *   - an older version, which the history sidebar renders;
 *   - the live collaborative session (M5.2), whose contents no `GET` has ever
 *     returned and which changes several times a second;
 *   - the editor's own unsaved buffer, which exists only in one tab.
 *
 * A stored boolean would be a claim about one of those, published as a fact
 * about all four. So the server sends `anchorOpId` and the client resolves it
 * against whatever it is drawing, every render.
 *
 * That decision is also what makes the hardest case free. Delete the gate, then
 * press undo: the operation returns with the same id, because the store's
 * delete is an array filter and its undo restores the array. No request was
 * sent, no row changed, and the comment re-attaches by itself. A stored flag
 * would have needed a compensating write that nothing would ever send — the
 * editor does not talk to the API on every keystroke.
 *
 * ══════════════════════════════════════════════════════════════════════════
 * WHAT HAPPENS WHEN THE ANCHOR DOES NOT RESOLVE: KEEP IT, SHOW IT, LABEL IT
 *
 * Three answers were available and this is the third.
 *
 *   - **Hide it.** Destroys the value of the feature — "we discussed this and
 *     decided" is the thing worth keeping — and destroys it invisibly: nobody
 *     can go looking for something they cannot tell is missing.
 *   - **Delete it.** A destructive write triggered by an edit that is itself
 *     undoable. The gate comes back; the conversation does not.
 *   - **Keep it, and say so.** The thread stays in the panel, listed against
 *     the circuit rather than pinned to a cell, carrying the note that the
 *     operation it was about is no longer in this document. Chosen: it is the
 *     only one of the three that survives delete-then-undo at no cost, and the
 *     only one where the reader is never misled — the comment is visible *and*
 *     it says its subject is gone.
 *
 * One consequence is worth stating because it looks like a bug and is not:
 * `inlineOperation` and `paste` both mint fresh ids, so exploding a custom-gate
 * call orphans comments on the call, and pasting a copy of a commented gate
 * does not copy its comments. Both are right. The call the comment was about
 * genuinely no longer exists, and a pasted gate is a different gate that
 * nobody has said anything about yet.
 *
 * ══════════════════════════════════════════════════════════════════════════
 * THREADS ARE TWO LEVELS, AND THE SHAPE IS WHAT ENFORCES IT
 *
 * `CommentThreadResponse` is a root plus a flat array of replies, and a reply
 * carries no `replies` of its own. A conversation about one gate, rendered in a
 * side panel, has no use for a fourth level of indentation, and the deny-list
 * version of this rule — "refuse a reply whose parent has a parent" — is a
 * check somebody can forget. This shape cannot express the thing it forbids,
 * which is the same move §6 makes with `column`.
 *
 * Resolution belongs to the root for the same reason: it is a statement about
 * the conversation, not about a sentence inside it. A resolved thread is
 * returned by the listing exactly like an open one, with `resolvedAt` set, and
 * the counts of both travel in every response so that "resolved" is a filter
 * with a number on it rather than a bucket things disappear into.
 *
 * ══════════════════════════════════════════════════════════════════════════
 * WHY THE VIEWER'S PERMISSIONS TRAVEL IN THE RESPONSE
 *
 * `viewerCanResolve` and `viewerCanDelete` are computed by the server and sent.
 * The client could derive them — it holds the author, the circuit's owner and
 * its own session — but that would be a second implementation of an
 * authorisation rule, and the failure mode of a second implementation is a
 * button that offers an action the server answers 403 to, or worse, a button
 * that is missing for somebody entitled to press it. One authority, and the
 * control and the enforcement cannot disagree.
 *
 * ══════════════════════════════════════════════════════════════════════════
 * MARKUP: AN ALLOW-LIST OF ONE THING
 *
 * A comment body is stored verbatim and rendered as text. The only markup is
 * the backtick convention this project already has (`features/lessons/prose.ts`
 * — a span between backticks becomes `Notation`, marked `translate="no"`), and
 * the renderer produces React elements, never HTML: there is no
 * `dangerouslySetInnerHTML` on this path and a test asserts it. That is what
 * "allow-list rather than deny-list" means when taken seriously — not a filter
 * over a rich format, but a format with two productions in it. No links, no
 * images, no raw HTML, so there is no sanitiser to be wrong.
 */

import { storableProse, storableText } from '@qsim/schema'
import { z } from 'zod'
import { pageNumber, serverTimestamp, wireTimestamp } from './circuits.js'

/**
 * Longest comment body.
 *
 * Two thousand characters is three or four paragraphs — enough to explain why a
 * gate is wrong and what to do instead, and short enough that a page of twenty
 * threads is tens of kilobytes rather than a megabyte. A review that needs more
 * is a description, and the circuit has one.
 */
export const MAX_COMMENT_LENGTH = 2000

/**
 * Most threads one circuit may carry, and most replies one thread may carry.
 *
 * These are not taste limits. `POST` is reachable by anybody who may *read* the
 * circuit — which for a PUBLIC one is everybody on the internet — so without a
 * ceiling the table is a place strangers may write into without bound. The rate
 * limiter bounds the speed; these bound the total, which is the number that
 * matters for a listing that has to stay cheap.
 */
export const MAX_THREADS_PER_CIRCUIT = 200
export const MAX_REPLIES_PER_THREAD = 100

/** Threads per page of the listing, and what `limit` means when nobody says. */
export const MAX_COMMENT_PAGE = 50
export const DEFAULT_COMMENT_PAGE = 20

/**
 * Highest page anybody may ask for. `MAX_THREADS_PER_CIRCUIT` threads at the
 * smallest page size is the last page that can hold anything, so a bound above
 * this would only buy an `OFFSET` over rows that cannot exist.
 */
export const MAX_COMMENT_PAGES = MAX_THREADS_PER_CIRCUIT

/**
 * The anchor: an `operations[].id` from §6, bounded exactly as the contract
 * bounds that field — 64 characters, `storableText`.
 *
 * Deliberately *not* validated against the circuit when a comment is posted.
 * The server would have to pick a document to validate against, and the four
 * candidate documents listed in this file's header disagree; the live session
 * in particular holds operations no `CircuitVersion` has ever contained, so
 * checking against the head version would refuse a comment on the gate the
 * author is looking at. An id that names nothing is exactly the orphan case,
 * which is already handled and is already visible.
 */
export const CommentAnchorSchema = storableText(z.string().min(1).max(64))

/**
 * The body. `storableProse` rather than `storableText`: a paragraph break is
 * meaningful in a comment, so `\n` is allowed — and nothing else from the
 * control ranges is, which is what keeps a NUL from reaching Postgres as a 500
 * (see `@qsim/schema`'s `text.ts`).
 */
export const CommentBodySchema = storableProse(
  z.string().trim().min(1).max(MAX_COMMENT_LENGTH)
)

/**
 * Posting a comment.
 *
 * `anchorOpId` absent or `null` means the comment is about the circuit as a
 * whole, which is what §3.4's original "comments on public circuits" were. The
 * anchor is what this milestone adds, not what it replaces.
 *
 * `parentId` and `anchorOpId` are mutually exclusive, and the refusal is
 * deliberate rather than "the anchor is ignored on a reply". A reply inherits
 * its root's anchor — that is what a thread *is* — so a client that sent both
 * believes something about where its comment landed, and silently dropping the
 * field lets it keep believing it.
 */
export const PostCommentBody = z
  .object({
    body: CommentBodySchema,
    anchorOpId: CommentAnchorSchema.nullish(),
    /** The root this is a reply to. Absent starts a new thread. */
    parentId: z.string().min(1).max(64).optional(),
  })
  .refine(
    (input) =>
      input.parentId === undefined ||
      input.anchorOpId === undefined ||
      input.anchorOpId === null,
    {
      error: 'a reply inherits its thread’s anchor and may not carry its own',
      path: ['anchorOpId'],
    }
  )

export type PostCommentRequest = z.input<typeof PostCommentBody>

/** Which threads a listing should carry. */
export const COMMENT_STATES = ['open', 'resolved', 'all'] as const

export type CommentState = (typeof COMMENT_STATES)[number]

/**
 * `open` by default.
 *
 * The panel's job is to show what still needs attention; a resolved thread is
 * kept because "we discussed this and decided" is worth keeping, not because it
 * should be in the way. It stays one toggle and one number away — never
 * unreachable, which is the whole difference between resolving and deleting.
 */
export const DEFAULT_COMMENT_STATE: CommentState = 'open'

/**
 * What a listing request may carry.
 *
 * `anchorOpId` narrows to one gate's threads, which is what clicking a marker
 * on the canvas asks for. It is matched literally against the stored column and
 * needs no existence check: an id naming nothing returns nothing.
 */
export const CommentQuerySchema = z.object({
  state: z.enum(COMMENT_STATES).default(DEFAULT_COMMENT_STATE),
  anchorOpId: CommentAnchorSchema.optional(),
  /*
   * `pageNumber` rather than a second spelling of it: decimal digits only, for
   * the reason argued beside it in `circuits.ts` — `?page=0x10` is not a page
   * number a person typed.
   */
  page: pageNumber(MAX_COMMENT_PAGES, 1),
  limit: pageNumber(MAX_COMMENT_PAGE, DEFAULT_COMMENT_PAGE),
})

export type CommentQuery = z.output<typeof CommentQuerySchema>
export type CommentQueryParams = Partial<z.input<typeof CommentQuerySchema>>

function buildCommentResponses<Timestamp extends z.ZodType>(
  timestamp: Timestamp
) {
  /**
   * Who said it.
   *
   * `displayName ?? username` is resolved by the client, and `email` has no
   * path to this object at all: the projection behind it is `publicUserSelect`,
   * which does not select the column (§11, and the same rule presence follows
   * in M5.3). A comment is user content shown to other users, and so is the
   * name beside it.
   */
  const CommentAuthor = z.object({
    id: z.string(),
    username: z.string(),
    displayName: z.string().nullable(),
    avatarUrl: z.string().nullable(),
  })

  const CommentResponse = z.object({
    id: z.string(),
    /** Verbatim, as it was stored. Rendered as text — see the header. */
    body: z.string(),
    /**
     * The operation this is about, or `null` for a comment about the circuit.
     * Whether it still resolves is the reader's question, not the server's.
     */
    anchorOpId: z.string().nullable(),
    createdAt: timestamp,
    author: CommentAuthor,
    /** See the header: the server decides, the button obeys. */
    viewerCanDelete: z.boolean(),
  })

  /**
   * A root and its replies. A reply has no `replies` — the two-level rule is
   * this shape rather than a check somewhere.
   */
  const CommentThreadResponse = z.object({
    root: CommentResponse,
    replies: z.array(CommentResponse),
    /** `null` while the thread is open. */
    resolvedAt: timestamp.nullable(),
    /** Who closed it, for the note that says so. `null` while open. */
    resolvedBy: CommentAuthor.nullable(),
    viewerCanResolve: z.boolean(),
    /**
     * Whether this viewer may add a reply. False for an anonymous reader, and
     * false once the thread has hit `MAX_REPLIES_PER_THREAD` — a form that
     * cannot succeed should not be drawn.
     */
    viewerCanReply: z.boolean(),
  })

  /**
   * How many threads hang off each operation, for the whole circuit rather
   * than for this page.
   *
   * The canvas draws a marker per anchored operation, so it needs every anchor
   * at once — a page of threads would leave markers missing on gates whose
   * conversation happens to be on page two. Two numbers per operation rather
   * than one, because a gate with three resolved threads and none open should
   * not wear the same mark as a gate with an open question on it.
   *
   * It carries no bodies and no ids, so it discloses nothing the listing does
   * not already: it is a tally over threads this viewer is being shown.
   */
  const CommentAnchorTally = z.object({
    open: z.int(),
    resolved: z.int(),
  })

  return {
    CommentAuthor,
    CommentResponse,
    CommentThreadResponse,
    CommentAnchorTally,
    CommentEnvelope: z.object({ comment: CommentResponse }),
    ThreadEnvelope: z.object({ thread: CommentThreadResponse }),
    CommentPageResponse: z.object({
      threads: z.array(CommentThreadResponse),
      page: z.int(),
      limit: z.int(),
      /** Threads matching the requested `state`, across every page. */
      total: z.int(),
      /**
       * Both counts, always, whatever `state` asked for. A filter whose other
       * side has no number on it is a filter nobody presses.
       */
      openCount: z.int(),
      resolvedCount: z.int(),
      /** Every anchored operation in the circuit, tallied. See above. */
      anchors: z.record(z.string(), CommentAnchorTally),
      /**
       * Whether this viewer may start a thread at all: signed in, and the
       * circuit is below `MAX_THREADS_PER_CIRCUIT`.
       */
      viewerCanComment: z.boolean(),
    }),
  }
}

export const serverCommentResponses = buildCommentResponses(serverTimestamp)
export const wireCommentResponses = buildCommentResponses(wireTimestamp)

export type CommentAuthor = z.infer<typeof wireCommentResponses.CommentAuthor>
export type Comment = z.infer<typeof wireCommentResponses.CommentResponse>
export type CommentThread = z.infer<
  typeof wireCommentResponses.CommentThreadResponse
>
export type CommentAnchorTally = z.infer<
  typeof wireCommentResponses.CommentAnchorTally
>
export type CommentPage = z.infer<
  typeof wireCommentResponses.CommentPageResponse
>
export type CommentEnvelope = z.infer<
  typeof wireCommentResponses.CommentEnvelope
>
export type ThreadEnvelope = z.infer<typeof wireCommentResponses.ThreadEnvelope>
