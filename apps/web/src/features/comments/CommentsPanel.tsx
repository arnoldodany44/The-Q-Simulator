/**
 * Comments anchored to gates: the panel, and the index — §3.4, Fase 5 (M5.4).
 *
 * ══════════════════════════════════════════════════════════════════════════
 * THE PANEL *IS* THE WAY TO FIND A COMMENT WITHOUT HUNTING THE CANVAS
 *
 * A badge on a gate is only findable by somebody who is already looking at that
 * gate, and a circuit may reach column 4 096. So every thread is listed here with
 * its anchor named in words — "H on q0, column 3" — the list is filterable by
 * state with a count on each side, and each thread carries a control that selects
 * its gate on the canvas. A reader who cannot see the canvas at all gets exactly
 * the same list, which is the point: the accessible path and the fast path are one
 * path.
 *
 * ══════════════════════════════════════════════════════════════════════════
 * HOW A COMMENT COMES TO BE ABOUT A PARTICULAR GATE
 *
 * By selecting it. There is no new gesture, no "comment mode", and no second way
 * to point at a cell: the editor already has selection, it is already reachable by
 * keyboard through the ARIA grid, and it is already what the canvas draws a ring
 * around. The composer says which gate it is about, or says it is about the
 * circuit when nothing is selected, and it says it *before* the comment is
 * written rather than after it is posted.
 *
 * With more than one operation selected the composer falls back to the circuit.
 * A comment about two gates is not representable — `anchorOpId` is one id — and
 * silently taking the first of a multiple selection would attach a sentence to a
 * gate the author did not mean.
 *
 * ══════════════════════════════════════════════════════════════════════════
 * WHY THE LISTING IS FETCHED WITHOUT ANYBODY OPENING ANYTHING
 *
 * Unlike the version history, which is behind a disclosure so that a reader who
 * never looks never pays. The markers are the reason: a gate carrying an open
 * question has to say so on first paint, and the anchor tally that draws those
 * badges arrives with this listing. A panel nobody opens still owes the reader the
 * mark that tells them to open it.
 *
 * ══════════════════════════════════════════════════════════════════════════
 * WHAT IS NOT HERE: NOTIFICATION
 *
 * Nobody is emailed and no bell appears. §14 does not ask for it, and it does not
 * fall out of anything here for free — it needs a delivery mechanism this project
 * has none of, a preference to switch it off, and a digest so that a busy thread is
 * not thirty messages. What *is* free is the count, which is on the filter.
 */

import {
  COMMENT_STATES,
  MAX_COMMENT_LENGTH,
  MAX_THREADS_PER_CIRCUIT,
  type CommentState,
  type CommentThread,
} from '@qsim/contract'
import type { Circuit } from '@qsim/schema'
import { useId, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Link, useLocation } from 'react-router'
import { useStore } from 'zustand'

import { useSession } from '../auth'
import { INTENDED_PATH_STATE_KEY, SIGN_IN_PATH } from '../auth/paths'
import {
  useApiErrorMessage,
  useComments,
  useDeleteComment,
  usePostComment,
  useResolveThread,
} from '../../lib/api'
import {
  useCircuitStore,
  type CircuitStore,
} from '../circuit-editor/useCircuitStore'
import { qubitLabel } from '../circuit-editor/operationRoles'
import { AnchorLabel } from './AnchorLabel'
import { CommentThreadView } from './CommentThreadView'
import { anchorCellOf, operationForAnchor } from './anchors'
import { DEFAULT_COMMENT_VIEW, type CommentView } from './view'

export interface CommentsPanelProps {
  /** The circuit's slug, or its id; the route accepts either. */
  readonly handle: string
  /**
   * The document store, injectable for the same reason `CircuitEditor` takes one:
   * a screen may hold two documents, and a panel that reached for the module-level
   * store would comment on whichever of them was built first.
   */
  readonly store?: CircuitStore
}

export function CommentsPanel({
  handle,
  store = useCircuitStore,
}: CommentsPanelProps) {
  const { t, i18n } = useTranslation('collab')
  const describeError = useApiErrorMessage()
  const headingId = useId()

  const circuit = useStore(store, (state) => state.circuit)
  const selection = useStore(store, (state) => state.selection)

  /*
   * The filter and the page are one piece of state, because changing the filter
   * has to reset the page: "resolved, page 3" is a page that usually does not
   * exist, and landing on it shows an empty list under a count that says
   * otherwise.
   */
  const [view, setView] = useState<CommentView>(DEFAULT_COMMENT_VIEW)
  /**
   * What this panel has just done, for a reader who cannot see it happen.
   *
   * A counter beside the sentence for the reason `PresenceRoster` keys its span on
   * a sequence number: two identical reports in a row — resolve, unresolve,
   * resolve — render the same string, React leaves the text node untouched, and an
   * unchanged live region says nothing. The region itself is mounted *empty* from
   * the first render, because a region inserted together with its first content is
   * frequently never announced at all.
   *
   * Four writes and one reveal go through here. The reveal is the one that matters
   * most: §3.4 (M5.4 decision 6) designates "show this gate on the canvas" as the
   * bridge from the panel to the canvas, and selecting the gate is invisible to
   * anybody not looking at the pixels — the SVG and both overlays are
   * `aria-hidden`, and the grid's roving tab stop lives in `useKeyboardGrid`'s own
   * state where a store action cannot reach it.
   */
  const [said, setSaid] = useState<{ seq: number; text: string }>({
    seq: 0,
    text: '',
  })
  const say = (text: string): void => {
    setSaid((previous) => ({ seq: previous.seq + 1, text }))
  }

  const query = useComments(handle, { state: view.state, page: view.page })
  const post = usePostComment()
  const resolve = useResolveThread()
  const remove = useDeleteComment()

  const numbers = new Intl.NumberFormat(i18n.language)
  const page = query.data
  const busy = post.isPending || resolve.isPending || remove.isPending

  const threads = page?.threads ?? []
  const orphaned = threads.filter(
    (thread) =>
      thread.root.anchorOpId !== null &&
      operationForAnchor(circuit, thread.root.anchorOpId) === undefined
  ).length

  const pages =
    page === undefined ? 1 : Math.max(1, Math.ceil(page.total / page.limit))

  return (
    <section className="comments-panel" aria-labelledby={headingId}>
      <h3 className="comments-panel__heading" id={headingId}>
        {t('comments.heading')}
      </h3>
      <p className="comments-panel__hint">{t('comments.hint')}</p>

      {/*
       * Mounted from the first render and empty until there is news — see `said`.
       * The loading sentence goes through it too, rather than arriving as a region
       * of its own that no assistive technology was watching.
       */}
      <p className="visually-hidden" role="status">
        <span key={said.seq}>
          {query.isPending && said.text === ''
            ? t('comments.loading')
            : said.text}
        </span>
      </p>

      {query.isError ? (
        <>
          <p className="auth-alert" role="alert">
            {describeError(query.error)}
          </p>
          <button
            className="page__cta page__cta--quiet"
            type="button"
            onClick={() => {
              void query.refetch()
            }}
          >
            {t('comments.retry')}
          </button>
        </>
      ) : null}

      {page === undefined ? null : (
        <>
          <fieldset className="comments-filter">
            <legend>{t('comments.filter.legend')}</legend>
            {COMMENT_STATES.map((state) => (
              <label className="comments-filter__choice" key={state}>
                <input
                  type="radio"
                  name={`${headingId}-state`}
                  value={state}
                  checked={view.state === state}
                  onChange={() => {
                    setView({ state, page: 1 })
                  }}
                />
                {/*
                 * Every count, whatever the filter is showing. A filter whose
                 * other side has no number on it is a filter nobody presses —
                 * which is how a resolved thread becomes unfindable in practice
                 * while being perfectly reachable in principle.
                 *
                 * `shown` rather than `count`, and formatted rather than raw: the
                 * label is the same sentence at one and at twelve, so there is no
                 * plural to select, and `count` would put i18next's plural
                 * machinery on a value that only ever goes in brackets.
                 */}
                <span>
                  {t(`comments.filter.${state}`, {
                    shown: numbers.format(countFor(state, page)),
                  })}
                </span>
              </label>
            ))}
          </fieldset>

          <Composer
            circuit={circuit}
            selection={selection}
            canComment={page.viewerCanComment}
            busy={busy}
            /*
             * Only a *new thread's* failure belongs under the composer. A reply
             * that was refused is reported against the thread it was meant for —
             * see `errorFor` — because that is where the reader is looking.
             */
            error={
              post.variables?.input.parentId === undefined ? post.error : null
            }
            onPost={(body, anchorOpId) => {
              post.mutate({
                handle,
                input: {
                  body,
                  ...(anchorOpId === null ? {} : { anchorOpId }),
                },
              })
            }}
          />

          {orphaned > 0 ? (
            /*
             * Said once at the top as well as on each thread. A reader who is
             * looking for a conversation they remember needs to know that some of
             * this list is about gates that have left the document — otherwise the
             * notes on individual threads read as an error rather than as history.
             */
            <p className="comments-panel__orphans">
              {t('comments.orphanNotice', { count: orphaned })}
            </p>
          ) : null}

          {threads.length === 0 ? (
            <p className="comments-panel__empty">
              {t(`comments.empty.${view.state}`)}
            </p>
          ) : (
            <ol className="comment-threads">
              {threads.map((thread) => (
                <CommentThreadView
                  key={thread.root.id}
                  thread={thread}
                  circuit={circuit}
                  selected={isSelected(thread, selection)}
                  busy={busy}
                  error={errorFor(thread, post, resolve, remove)}
                  onReveal={(anchorOpId) => {
                    /*
                     * Through `getState()` rather than a selected action, which is
                     * how every other caller in the editor invokes one: subscribing
                     * to a function that never changes buys a re-render trigger for
                     * nothing, and reading it at the moment of the press cannot see
                     * a stale one.
                     *
                     * Selecting the gate *is* the "show me": the canvas draws a ring
                     * around a selection already, the keyboard grid can reach it,
                     * and the composer above then offers to comment on the same
                     * gate — one gesture, three consistent meanings.
                     */
                    store.getState().setSelection([anchorOpId])
                    /*
                     * And said out loud, because the ring the canvas draws is the
                     * only other feedback and it is invisible to a screen reader.
                     * The sentence names the cell, which is the fact the reader
                     * needs to find the gate with the grid's own keyboard cursor.
                     */
                    const cell = anchorCellOf(circuit, anchorOpId)
                    say(
                      cell === null
                        ? t('comments.announce.revealMissing')
                        : t('comments.announce.revealed', {
                            qubit: qubitLabel(circuit, cell.qubit),
                            column: cell.column,
                          })
                    )
                  }}
                  onReply={(body) => {
                    post.mutate({
                      handle,
                      input: { body, parentId: thread.root.id },
                    })
                    say(t('comments.announce.replied'))
                  }}
                  onResolve={(resolved) => {
                    resolve.mutate({
                      handle,
                      commentId: thread.root.id,
                      resolved,
                    })
                    say(
                      t(
                        resolved
                          ? 'comments.announce.resolved'
                          : 'comments.announce.reopened'
                      )
                    )
                  }}
                  onDelete={(commentId) => {
                    remove.mutate({ handle, commentId })
                    say(t('comments.announce.deleted'))
                  }}
                />
              ))}
            </ol>
          )}

          {pages > 1 ? (
            <nav className="pager" aria-label={t('comments.pager.label')}>
              {/* Focusable at the ends of the range — see routes/circuits.tsx. */}
              <button
                type="button"
                aria-disabled={page.page <= 1}
                onClick={() => {
                  if (page.page <= 1) return
                  setView({ state: view.state, page: page.page - 1 })
                }}
              >
                {t('comments.pager.previous')}
              </button>
              <p className="pager__position" role="status">
                {t('comments.pager.position', {
                  page: numbers.format(page.page),
                  pages: numbers.format(pages),
                  total: numbers.format(page.total),
                })}
              </p>
              <button
                type="button"
                aria-disabled={page.page >= pages}
                onClick={() => {
                  if (page.page >= pages) return
                  setView({ state: view.state, page: page.page + 1 })
                }}
              >
                {t('comments.pager.next')}
              </button>
            </nav>
          ) : null}
        </>
      )}
    </section>
  )
}

/**
 * The number beside one filter choice.
 *
 * `openCount` and `resolvedCount` are narrowed by the same `anchorOpId` the
 * request carried — nothing narrows them here, and the panel never asks for one
 * gate's threads, so the two are the whole circuit's. "All" is their sum rather
 * than `total`, because `total` counts only what the *current* filter matches.
 */
function countFor(
  state: CommentState,
  page: { readonly openCount: number; readonly resolvedCount: number }
): number {
  if (state === 'open') return page.openCount
  if (state === 'resolved') return page.resolvedCount
  return page.openCount + page.resolvedCount
}

/** Whether this thread's gate is the one selected on the canvas. */
function isSelected(
  thread: CommentThread,
  selection: readonly string[]
): boolean {
  const anchorOpId = thread.root.anchorOpId
  return (
    anchorOpId !== null && selection.length === 1 && selection[0] === anchorOpId
  )
}

/** The three mutations, as much of them as `errorFor` needs. */
interface FailedWrite<Variables> {
  readonly error: unknown
  readonly variables?: Variables
}

/**
 * The error to show against one thread.
 *
 * One mutation hook is shared by every thread in the list, so its `error` alone
 * would print a failed resolve under all twenty of them. `variables` is what says
 * which thread the failure was about — and it is the same object the request was
 * built from, so it cannot name a different one.
 */
function errorFor(
  thread: CommentThread,
  post: FailedWrite<{ input: { parentId?: string } }>,
  resolve: FailedWrite<{ commentId: string }>,
  remove: FailedWrite<{ commentId: string }>
): unknown {
  const ids = new Set([thread.root.id, ...thread.replies.map((r) => r.id)])
  if (
    post.error !== null &&
    post.error !== undefined &&
    post.variables?.input.parentId === thread.root.id
  ) {
    return post.error
  }
  if (
    resolve.error !== null &&
    resolve.error !== undefined &&
    ids.has(resolve.variables?.commentId ?? '')
  ) {
    return resolve.error
  }
  if (
    remove.error !== null &&
    remove.error !== undefined &&
    ids.has(remove.variables?.commentId ?? '')
  ) {
    return remove.error
  }
  return null
}

interface ComposerProps {
  readonly circuit: Circuit
  readonly selection: readonly string[]
  readonly canComment: boolean
  readonly busy: boolean
  readonly error: unknown
  readonly onPost: (body: string, anchorOpId: string | null) => void
}

/**
 * The box a new thread is written in, and the sentence that says what it will be
 * attached to.
 *
 * The anchor is read from the selection at *submit* time as well as displayed from
 * it, so what the label promised is what is sent. Selecting a different gate while
 * typing changes the label under the reader's eyes, which is the honest behaviour:
 * the alternative is a form that captured an anchor invisibly and posted against a
 * gate the reader stopped looking at.
 */
function Composer({
  circuit,
  selection,
  canComment,
  busy,
  error,
  onPost,
}: ComposerProps) {
  const { t, i18n } = useTranslation('collab')
  const describeError = useApiErrorMessage()
  const session = useSession()
  const location = useLocation()
  const fieldId = useId()
  const [body, setBody] = useState('')

  /*
   * One selected operation that this document actually holds. Anything else — no
   * selection, several, or a selection of something already deleted — is a comment
   * about the circuit, which is a real and useful thing to write rather than a
   * degraded case.
   */
  const anchorOpId =
    selection.length === 1 &&
    selection[0] !== undefined &&
    operationForAnchor(circuit, selection[0]) !== undefined
      ? selection[0]
      : null

  if (session.status === 'loading') {
    // Holds no space and says nothing: the session usually resolves before the
    // listing does, and a "please wait" for something nobody asked for is noise.
    return null
  }

  if (session.status !== 'authenticated') {
    return (
      <p className="comments-panel__signin">
        <Link
          to={SIGN_IN_PATH}
          /*
           * Where to come back to, in router state rather than in a query
           * parameter: an address in `?next=` leaks into history, into `Referer`
           * and into a shared link, and an UNLISTED slug *is* its access control
           * (`features/auth/paths.ts`).
           */
          state={{
            [INTENDED_PATH_STATE_KEY]: `${location.pathname}${location.search}`,
          }}
        >
          {t('comments.signIn')}
        </Link>
      </p>
    )
  }

  if (!canComment) {
    /*
     * Signed in and still refused, which leaves exactly one reason: the circuit is
     * at `MAX_THREADS_PER_CIRCUIT`. Said with the number in it, because "you
     * cannot comment" without a reason is indistinguishable from a broken page.
     */
    return (
      <p className="comments-panel__full">
        {t('comments.full', { max: MAX_THREADS_PER_CIRCUIT })}
      </p>
    )
  }

  return (
    <form
      className="comment-form comment-form--new"
      onSubmit={(event) => {
        event.preventDefault()
        if (busy) return
        const trimmed = body.trim()
        if (trimmed === '') return
        onPost(trimmed, anchorOpId)
        setBody('')
      }}
    >
      <label className="field__label" htmlFor={fieldId}>
        {t('comments.compose.label')}
      </label>
      <p className="comment-form__target">
        {t('comments.compose.about')}{' '}
        <AnchorLabel circuit={circuit} anchorOpId={anchorOpId} />
      </p>
      <p className="field__hint" id={`${fieldId}-hint`}>
        {t('comments.compose.hint', {
          max: new Intl.NumberFormat(i18n.language).format(MAX_COMMENT_LENGTH),
        })}
      </p>
      <textarea
        className="field__input comment-form__input"
        id={fieldId}
        aria-describedby={`${fieldId}-hint`}
        maxLength={MAX_COMMENT_LENGTH}
        rows={3}
        value={body}
        onChange={(event) => {
          setBody(event.target.value)
        }}
      />
      <div className="comment-form__actions">
        <button type="submit" aria-disabled={busy || body.trim() === ''}>
          {t('comments.compose.submit')}
        </button>
      </div>

      {error === null || error === undefined ? null : (
        <p className="comment-form__error" role="alert">
          {describeError(error)}
        </p>
      )}
    </form>
  )
}
