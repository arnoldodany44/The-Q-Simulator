/**
 * `/new` — a blank circuit — and `/c/:slug`, the same editor over a saved one
 * (specification §9, milestone M1.4a).
 *
 * The route is thin on purpose: it is a page frame around `CircuitEditor`,
 * which owns everything that is actually the editor. The two paths share this
 * one component precisely so that "the editor" cannot start meaning two
 * slightly different things depending on where the document came from.
 *
 * The page is wider than the landing's reading column: a circuit is a wide
 * thing, and forcing it into 42rem would put a scrollbar under every gate
 * from the third column onwards.
 *
 * ── Why the URL lives here and not in `CircuitEditor` (M0.9) ─────────────
 *
 * `useCircuitUrl` is mounted by the *page*, not by the editor component, and
 * the reason is the same one that makes the editor take its store as a prop:
 * a preview or a diff view will eventually put two editors on one screen, and
 * two components fighting over one address bar is not a thing that can be
 * made to work. There is one URL per page, so the page owns it. It also keeps
 * `CircuitEditor` free of the browser's history, which is what lets its own
 * tests build circuits without leaving a `?c=` behind for the next one.
 *
 * The examples, the share control and now the save control sit above the
 * editor rather than inside it for the same reason: they are commands about
 * the *document* — open another one, hand this one to somebody, give it a
 * home — while everything in the editor card is a command about the circuit
 * already open.
 *
 * ── THE ORDER OF THE THREE DOCUMENT HOOKS IS LOAD-BEARING ────────────────
 *
 * React runs layout effects in hook order, and all three of these can put a
 * document on screen. The precedence is:
 *
 *   1. `useCircuitDocument` — clears the canvas when the route is `/new` and a
 *      saved circuit was open a moment ago, so that "new circuit" means one.
 *      Its *other* effect, seeding from the server, cannot run this early: the
 *      fetch has not answered yet on the first pass, which is exactly why it
 *      cannot outrank either of the two below.
 *   2. `useCircuitUrl` — `?c=`, a circuit somebody built and sent, or the
 *      unsaved edit this same tab left in the address bar. It always wins,
 *      including over the version stored under the slug: it is the newer of
 *      the two documents, and showing the older one instead is the one outcome
 *      that loses work.
 *   3. `useExample` — `?example=bell`, a starting point, outranked by both.
 *
 * ── The address bar stops carrying a document that has a home ────────────
 *
 * `suppressed` is on while the editor holds exactly the version stored under
 * the slug. `/c/abc` then means "this is what is saved" and `/c/abc?c=…` means
 * "plus an edit that is not" — the unsaved-changes state, visible in the one
 * place every browser already shows the user. The reasoning, and why this is
 * the answer rather than autosave or a prompt, is in
 * `features/circuit-storage/useUnsavedWork.ts`.
 *
 * ── `?v=` REPLACES THE EDITOR; IT DOES NOT LOAD INTO IT (M1.4b) ──────────
 *
 * `/c/abc?v=3` shows version 3, read-only, and `/c/abc?v=3&vs=1` shows it with
 * the visual diff from version 1. Both render `VersionPreview` *instead of*
 * `CircuitEditor`, and neither touches the circuit store: the document being
 * edited stays exactly where it was, undo history and all, so closing the
 * preview is free. `useCircuitUrl` keeps mirroring that document into `?c=`
 * throughout, which is why the whole address reads `/c/abc?c=…&v=3` — the
 * unsaved edit, and the version being looked at, side by side and neither
 * standing in for the other.
 */

import { useTranslation } from 'react-i18next'
import { Link, useParams } from 'react-router'

import { LanguagePicker } from '../components/LanguagePicker'
import { AccountMenu } from '../features/auth'
import { CircuitEditor } from '../features/circuit-editor/CircuitEditor'
import { PresetPicker } from '../features/circuit-editor/PresetPicker'
import { ShareLink } from '../features/circuit-editor/ShareLink'
import { useCircuitStore } from '../features/circuit-editor/useCircuitStore'
import { useCircuitUrl } from '../features/circuit-editor/useCircuitUrl'
import { useExample } from '../features/circuit-editor/useExample'
import {
  SaveCircuitPanel,
  VersionHistoryPanel,
  VersionPreview,
  useCircuitDocument,
  useUnsavedWork,
  useVersionSelection,
} from '../features/circuit-storage'
import { useApiErrorMessage } from '../lib/api'

export function EditorRoute() {
  const { t } = useTranslation(['editor', 'circuits', 'common'])
  const describeError = useApiErrorMessage()
  const { slug } = useParams<{ slug: string }>()

  const doc = useCircuitDocument({ slug: slug ?? null })
  const url = useCircuitUrl({
    store: useCircuitStore,
    suppressed: doc.base !== null && !doc.dirty,
  })
  // After `useCircuitUrl`, never before: layout effects run in hook order and
  // a shared `?c=` circuit outranks a named example. See `useExample.ts`.
  useExample({ store: useCircuitStore })

  useUnsavedWork({ carried: !url.tooLarge, hasWork: doc.dirty })

  /*
   * The version being looked at, if any. Read here and passed down rather than
   * read in each component that cares, so there is exactly one place that
   * knows these two parameters exist — the same rule the header gives for the
   * address bar generally.
   *
   * A `?v=` on `/new`, or on a circuit that has not resolved, names nothing:
   * `doc.base` is what says there is a history to look at at all.
   */
  const { selection, select } = useVersionSelection()
  const base = doc.base
  const viewingVersion = base !== null && selection.version !== null

  /*
   * A document is on screen unless there is nothing yet to show. The draft
   * case is the one that makes this a condition rather than a status check: a
   * reload in the middle of editing arrives at `/c/abc?c=…`, the edit is
   * already painted, and hiding it behind "loading" while the metadata catches
   * up would replace the reader's work with a spinner.
   */
  const painted = doc.status !== 'loading' || doc.openedWithDraft

  return (
    <main className="page page--wide">
      <header className="page__header">
        <h1>
          <Link to="/">{t('common:appName')}</Link>
        </h1>
        <div className="page__header-tools">
          <AccountMenu />
          <LanguagePicker />
        </div>
      </header>

      <h2 className="section-heading">{t('editor:page.heading')}</h2>
      {doc.detail === null ? (
        <p>{t('editor:page.intro')}</p>
      ) : (
        /*
         * A saved circuit's own title replaces the generic introduction. It is
         * user-generated text rendered as text — React escapes it — and it is
         * not run through the catalog because it is not this app's words.
         */
        <p className="editor__document-title">{doc.detail.title}</p>
      )}

      <div className="document-bar">
        <PresetPicker store={useCircuitStore} />
        <ShareLink url={url} />
        <SaveCircuitPanel document={doc} carried={!url.tooLarge} />
        {/*
         * Only for a document that has a home. An unsaved circuit has no
         * versions, and a panel that could only ever say "nothing here" is
         * worse than no panel: it invites a click that answers nothing.
         */}
        {base === null ? null : (
          <VersionHistoryPanel
            handle={base.slug}
            currentVersion={base.versionNum}
            selection={selection}
            onSelect={select}
          />
        )}
      </div>

      {doc.status === 'unavailable' ? (
        <div className="notice" role="alert">
          {/*
           * §11 conflates "no such circuit" with "not yours to see" on
           * purpose, and so does this: one sentence for both, from the code
           * the API sent, in three languages.
           */}
          <p>{describeError(doc.error)}</p>
          <p>
            <Link className="page__cta" to="/new">
              {t('circuits:document.unavailableAction')}
            </Link>
          </p>
        </div>
      ) : null}

      {viewingVersion && base !== null ? (
        /*
         * Instead of the editor, never beside it. Two circuit canvases on one
         * screen — one editable, one historical — is the arrangement in which
         * somebody edits the wrong one, and the point of the whole preview is
         * that a past version cannot be mistaken for the live document.
         */
        <VersionPreview
          handle={base.slug}
          selection={selection}
          document={doc}
          onSelect={select}
        />
      ) : painted ? (
        <CircuitEditor />
      ) : doc.paused ? (
        /*
         * Not "loading". The request has not been sent — React Query pauses a
         * fetch while the browser is offline — so a loading line would be a
         * claim about a server nobody has spoken to, indistinguishable from a
         * slow one and lasting as long as the connection is down.
         */
        <p className="notice" role="status">
          {t('circuits:document.offline')}
        </p>
      ) : (
        /*
         * Not a blank editor. Painting a canvas that a circuit is about to
         * replace under the reader's eyes is the same defect `useCircuitUrl`
         * uses a layout effect to avoid — it reads as the link having failed,
         * and for the second it lasts the toolbar invites edits to a document
         * that is about to be thrown away.
         */
        <p className="page__loading" role="status">
          {t('circuits:document.loading')}
        </p>
      )}
    </main>
  )
}
