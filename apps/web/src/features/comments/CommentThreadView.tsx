/**
 * One conversation about one gate — Fase 5, M5.4.
 *
 * ── A resolved thread stays where it was ──────────────────────────────────
 *
 * "We discussed this and decided" is the value of the feature, so resolving is
 * not a way of making something go away. A resolved thread renders here exactly
 * as an open one does, with a note saying who closed it and when, and the filter
 * above carries a count for both sides so that finding it again is one press with
 * a number on it rather than a bucket things vanish into.
 *
 * ── Two levels, and the shape is what enforces it ─────────────────────────
 *
 * A reply has no replies, because `CommentThreadResponse` has no field for one
 * (`@qsim/contract`). There is no depth check here and there is nothing to
 * forget: this component cannot render a third level, and the server cannot store
 * one.
 *
 * ── Who may do what is the server's answer, rendered ──────────────────────
 *
 * `viewerCanResolve`, `viewerCanDelete` and `viewerCanReply` are computed by the
 * API and travel in the response. Nothing here re-derives them from the author,
 * the owner and the session — that would be a second implementation of an
 * authorisation rule, and the failure mode of a second implementation is a button
 * that produces a 403 or a button missing from somebody entitled to press it.
 *
 * ── Deleting asks first ──────────────────────────────────────────────────
 *
 * Deleting a root takes its replies with it (`ON DELETE CASCADE`), and there is no
 * undo for a row. So the control is two presses, and the second one names what it
 * is about to take: a thread with four replies says four. Not a `window.confirm`,
 * which is unstyled, untranslatable in practice and blocks the whole tab.
 */

import type { Comment, CommentThread } from '@qsim/contract'
import type { Circuit } from '@qsim/schema'
import { useEffect, useId, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'

import { MAX_COMMENT_LENGTH } from '@qsim/contract'
import { useApiErrorMessage } from '../../lib/api'
import { AnchorLabel } from './AnchorLabel'
import { CommentBody } from './CommentBody'
import { operationForAnchor } from './anchors'

export interface CommentThreadViewProps {
  readonly thread: CommentThread
  /** The document on screen; the anchor is resolved against it every render. */
  readonly circuit: Circuit
  /** Whether this thread's gate is the one currently selected on the canvas. */
  readonly selected: boolean
  /** Selects the anchored gate, which is how "show me" works. */
  readonly onReveal: (anchorOpId: string) => void
  readonly onReply: (body: string) => void
  readonly onResolve: (resolved: boolean) => void
  readonly onDelete: (commentId: string) => void
  /** In flight, for the controls that must decline rather than disappear. */
  readonly busy: boolean
  readonly error: unknown
}

export function CommentThreadView({
  thread,
  circuit,
  selected,
  onReveal,
  onReply,
  onResolve,
  onDelete,
  busy,
  error,
}: CommentThreadViewProps) {
  const { t } = useTranslation('collab')
  const describeError = useApiErrorMessage()
  const anchorId = useId()

  const anchorOpId = thread.root.anchorOpId
  const present =
    anchorOpId !== null && operationForAnchor(circuit, anchorOpId) !== undefined
  const resolved = thread.resolvedAt !== null

  return (
    <li
      className={
        resolved ? 'comment-thread comment-thread--resolved' : 'comment-thread'
      }
      aria-labelledby={anchorId}
      /*
       * "This is the thread whose gate you have selected" — as state rather than
       * as a colour, so it reaches a screen reader too (§10: colour is never the
       * only carrier).
       */
      {...(selected ? { 'aria-current': true as const } : {})}
    >
      <p className="comment-thread__header" id={anchorId}>
        <AnchorLabel circuit={circuit} anchorOpId={anchorOpId} />
        {resolved ? (
          <span className="comment-thread__badge">
            {t('comments.thread.resolvedBadge')}
          </span>
        ) : null}
      </p>

      {/*
       * Only for an anchor this document still holds. On an orphan there is no
       * cell to reveal, and a control that scrolled to a nearby one would be the
       * coordinate mistake wearing a button.
       */}
      {present && anchorOpId !== null ? (
        <p className="comment-thread__actions">
          <button
            type="button"
            onClick={() => {
              onReveal(anchorOpId)
            }}
          >
            {t('comments.thread.reveal')}
          </button>
        </p>
      ) : null}

      <CommentView
        comment={thread.root}
        busy={busy}
        replyCount={thread.replies.length}
        onDelete={onDelete}
      />

      {thread.replies.length === 0 ? null : (
        <ol className="comment-replies">
          {thread.replies.map((reply) => (
            <li className="comment-replies__item" key={reply.id}>
              <CommentView
                comment={reply}
                busy={busy}
                replyCount={0}
                onDelete={onDelete}
              />
            </li>
          ))}
        </ol>
      )}

      {resolved && thread.resolvedBy !== null ? (
        <p className="comment-thread__resolution">
          {t('comments.thread.resolvedBy', {
            name: nameOf(thread.resolvedBy),
          })}
        </p>
      ) : null}

      <div className="comment-thread__footer">
        {thread.viewerCanReply ? (
          <ReplyForm busy={busy} onReply={onReply} />
        ) : null}

        {thread.viewerCanResolve ? (
          <button
            className="comment-thread__resolve"
            type="button"
            /*
             * `aria-disabled` and not `disabled`, for the reason every control in
             * this app gives: a disabled button cannot hold focus, so the
             * keyboard user who just pressed it is returned to the document body.
             * The handler declines instead.
             */
            aria-disabled={busy}
            onClick={() => {
              if (busy) return
              onResolve(!resolved)
            }}
          >
            {resolved
              ? t('comments.thread.reopen')
              : t('comments.thread.resolve')}
          </button>
        ) : null}
      </div>

      {error === null || error === undefined ? null : (
        <p className="comment-thread__error" role="alert">
          {describeError(error)}
        </p>
      )}
    </li>
  )
}

/** `displayName ?? username`. `email` is not in this projection at all (§11). */
function nameOf(author: Comment['author']): string {
  return author.displayName ?? author.username
}

interface CommentViewProps {
  readonly comment: Comment
  readonly busy: boolean
  /** Replies that would go with this one, for the confirmation's wording. */
  readonly replyCount: number
  readonly onDelete: (commentId: string) => void
}

function CommentView({
  comment,
  busy,
  replyCount,
  onDelete,
}: CommentViewProps) {
  const { t, i18n } = useTranslation('collab')
  const [confirming, setConfirming] = useState(false)
  /**
   * Where focus goes when a disclosure closes.
   *
   * This file already makes the argument for `aria-disabled` over `disabled` — "a
   * disabled button cannot hold focus, so the keyboard user who just pressed it is
   * returned to the document body" — and then reintroduced the same failure by
   * *unmounting* the button that was pressed. Cancelling a delete dropped focus to
   * `document.body`, so the next Tab restarted at the top of the page, past the
   * toolbar, the palette and the canvas's two-thousand-cell grid, with nothing
   * announced. WCAG 2.4.3.
   */
  const deleteButton = useRef<HTMLButtonElement | null>(null)
  const confirmButton = useRef<HTMLButtonElement | null>(null)
  /** Whether the last change of `confirming` came from a keypress of the user's. */
  const returning = useRef<'open' | 'close' | null>(null)

  useEffect(() => {
    const move = returning.current
    returning.current = null
    if (move === 'open') confirmButton.current?.focus()
    if (move === 'close') deleteButton.current?.focus()
  }, [confirming])

  const when = new Intl.DateTimeFormat(i18n.language, {
    dateStyle: 'medium',
    timeStyle: 'short',
  })

  return (
    <article className="comment">
      <p className="comment__byline">
        {/*
         * The author's name is user-generated text rendered as text — React
         * escapes it — and it is not run through the catalog because it is not
         * this app's words.
         */}
        {/* `dir="auto"` for the same reason as the body — see `CommentBody`. */}
        <span className="comment__author" dir="auto">
          {nameOf(comment.author)}
        </span>
        <time
          className="comment__when"
          dateTime={comment.createdAt.toISOString()}
        >
          {when.format(comment.createdAt)}
        </time>
      </p>

      {/* The one renderer for a comment body. See `CommentBody.tsx`. */}
      <CommentBody body={comment.body} />

      {comment.viewerCanDelete ? (
        <p className="comment__actions">
          {confirming ? (
            <>
              <button
                className="comment__delete-confirm"
                type="button"
                ref={confirmButton}
                aria-disabled={busy}
                onClick={() => {
                  if (busy) return
                  onDelete(comment.id)
                }}
              >
                {replyCount > 0
                  ? t('comments.comment.deleteWithReplies', {
                      count: replyCount,
                    })
                  : t('comments.comment.deleteConfirm')}
              </button>
              <button
                type="button"
                onClick={() => {
                  returning.current = 'close'
                  setConfirming(false)
                }}
              >
                {t('comments.comment.deleteCancel')}
              </button>
            </>
          ) : (
            <button
              type="button"
              ref={deleteButton}
              onClick={() => {
                returning.current = 'open'
                setConfirming(true)
              }}
            >
              {t('comments.comment.delete')}
            </button>
          )}
        </p>
      ) : null}
    </article>
  )
}

/**
 * A reply box that is closed until somebody asks for it.
 *
 * A thread list with an open textarea under every thread is a panel of forms
 * rather than a conversation, and on a circuit with twenty threads it is twenty
 * tab stops between the reader and the next thing they wanted to read.
 */
function ReplyForm({
  busy,
  onReply,
}: {
  readonly busy: boolean
  readonly onReply: (body: string) => void
}) {
  const { t } = useTranslation('collab')
  const fieldId = useId()
  const [open, setOpen] = useState(false)
  const [body, setBody] = useState('')
  /**
   * The two ends of the disclosure, so a keyboard user is never dropped.
   *
   * Opening moves focus *into* the textarea — the thing that just appeared and the
   * only reason to press the button — and closing puts it back on the button that
   * reappears in its place. Without this, both presses left focus on
   * `document.body`, so the next Tab restarted from the top of the document and a
   * screen reader said nothing about the form that had opened. WCAG 2.4.3.
   */
  const openButton = useRef<HTMLButtonElement | null>(null)
  const field = useRef<HTMLTextAreaElement | null>(null)
  const returning = useRef<'open' | 'close' | null>(null)

  useEffect(() => {
    const move = returning.current
    returning.current = null
    if (move === 'open') field.current?.focus()
    if (move === 'close') openButton.current?.focus()
  }, [open])

  if (!open) {
    return (
      <button
        className="comment-thread__reply-open"
        type="button"
        ref={openButton}
        onClick={() => {
          returning.current = 'open'
          setOpen(true)
        }}
      >
        {t('comments.reply.open')}
      </button>
    )
  }

  return (
    <form
      className="comment-form"
      onSubmit={(event) => {
        event.preventDefault()
        if (busy) return
        const trimmed = body.trim()
        if (trimmed === '') return
        onReply(trimmed)
        setBody('')
        returning.current = 'close'
        setOpen(false)
      }}
    >
      <label className="field__label" htmlFor={fieldId}>
        {t('comments.reply.label')}
      </label>
      <textarea
        className="field__input comment-form__input"
        id={fieldId}
        ref={field}
        maxLength={MAX_COMMENT_LENGTH}
        rows={3}
        value={body}
        onChange={(event) => {
          setBody(event.target.value)
        }}
      />
      <div className="comment-form__actions">
        <button type="submit" aria-disabled={busy || body.trim() === ''}>
          {t('comments.reply.submit')}
        </button>
        <button
          type="button"
          onClick={() => {
            returning.current = 'close'
            setOpen(false)
            setBody('')
          }}
        >
          {t('comments.reply.cancel')}
        </button>
      </div>
    </form>
  )
}
