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
 * ── THE SHARED SESSION IS OPENED HERE (M5.6) ─────────────────────────────
 *
 * `useCollabSession` is mounted by this page and by nothing else, which is what
 * makes §3.4's collaboration reachable at all — the same relationship
 * `CircuitEditor` has with `SimulationPanel`, and it is worth stating in the same
 * words: deleting the call below would not fail a single test in
 * `features/collab`, because every one of them drives the transport or a
 * component directly, and the product would go back to shipping a channel nobody
 * can open. `editor.test.tsx` asserts the mounting, where the mounting happens.
 *
 * The condition is `doc.base`, the circuit the *server answered* with, rather
 * than the `:slug` the address matched; the reasoning is at the call site. What
 * comes back drives three things on this page and nothing else: the panel that
 * says who is here, the caret layer the canvas draws, and whether the editor is
 * read-only because this viewer may watch and not write.
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
/*
 * The comment layer (M5.4). The page owns it for the same reason it owns the
 * URL, the save control and — since M5.3 — anything drawn over the canvas: a
 * conversation is about the *document*, and `CircuitEditor` is what edits the
 * circuit already open in one. The arrow also has to keep pointing one way, so
 * the markers arrive as the canvas's opaque `overlay` rather than as a prop the
 * editor understands.
 */
import { CommentMarkerLayer, CommentsPanel } from '../features/comments'
/*
 * The shared session (M5.6). The page owns it for the same reason it owns the
 * comment layer: a session is about the *document*, and `CircuitEditor` is what
 * edits the circuit already open in one. It is also the only place that knows
 * whether this document has a home, which is the one condition §8's
 * `circuit:<id>` cannot do without.
 */
import {
  CollabPanel,
  PresenceCursorLayer,
  useCollabSession,
} from '../features/collab'
import { PresetPicker } from '../features/circuit-editor/PresetPicker'
import { ShareLink } from '../features/circuit-editor/ShareLink'
import { useCircuitStore } from '../features/circuit-editor/useCircuitStore'
import { useCircuitUrl } from '../features/circuit-editor/useCircuitUrl'
import { useExample } from '../features/circuit-editor/useExample'
import { ExportPanel } from '../features/export'
import { ImportMenu } from '../features/import'
import {
  SaveCircuitPanel,
  VersionHistoryPanel,
  VersionPreview,
  useCircuitDocument,
  useUnsavedWork,
  useVersionSelection,
} from '../features/circuit-storage'
/*
 * The two public actions on somebody else's circuit (M1.5b). They live in the
 * gallery feature because that is where they are used most, and the editor is
 * the *other* place a circuit is shown — the brief asks for a fork from a card
 * and from an open circuit, and one implementation is what keeps those two the
 * same action.
 */
import { ForkButton, ForkedFromNotice, StarButton } from '../features/gallery'
/*
 * Sending this circuit to a real device (3.7). Mounted by the page and not
 * by the editor for the reason everything else here is: it is a command
 * about the *document* -- it names a stored circuit, and an unsaved draft
 * has nothing for the job row to key against.
 */
import { SubmitToHardwarePanel } from '../features/hardware'
/*
 * From `src/embed/`, which is otherwise a document of its own with its own
 * entry point. This one component is the exception and it is a deliberate
 * one: it imports only `embed/paths.ts` (which imports nothing) and
 * `circuit-storage/paths.ts`, so nothing of the frame's graph comes with it,
 * and putting the snippet builder anywhere else would mean the address of an
 * embed was spelled in two places.
 */
import { EmbedSnippet } from '../embed/EmbedSnippet'
import { useSession } from '../features/auth'
import { useApiErrorMessage } from '../lib/api'

export function EditorRoute() {
  const { t } = useTranslation(['editor', 'circuits', 'common'])
  const describeError = useApiErrorMessage()
  const session = useSession()
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

  /*
   * ── THE SHARED SESSION IS MOUNTED HERE (M5.6) ──────────────────────────
   *
   * Everything in `features/collab` existed and was tested before this line, and
   * none of it could be reached: no file outside that folder and the verification
   * suites imported the transport, so no user action opened a channel and no
   * `CircuitSession` row could ever be written. This is the join, and it is the
   * whole milestone.
   *
   * `base` and not `slug` is what enables it, and the difference is the point.
   * `slug` is what the address bar says; `base` is what the *server answered* —
   * so a session is opened for a circuit that resolved, and never for a slug
   * nobody minted, a circuit this viewer may not read, or a load that has not
   * come back yet. `circuit:<id>` addresses one row, and asking the relay about a
   * handle we have not confirmed exists would earn a NOT_FOUND per attempt.
   *
   * Not while a past version is on screen. `?v=3` renders `VersionPreview`
   * *instead of* the editor and touches no store, so there is no document for a
   * session to be about — and a roster drawn over a historical circuit would say
   * that four people are editing something nobody can edit.
   *
   * A watcher gets a session too, and that is §3.4's decision 3 rather than an
   * oversight: presence writes nothing that outlives the connection, and «un
   * espectador invisible dejaría los cursores compartidos como una función que
   * solo aprovecha quien ya es la única escritora del circuito». The relay decides
   * who may write — `canEditCircuit`, the owner and nobody else today — and hands
   * back `access`, which is what puts the editor below in read-only.
   */
  const collab = useCollabSession({
    /*
     * ── THE SLUG, NOT THE ID, AND IT IS NOT A DETAIL ────────────────────
     *
     * The relay resolves either handle to one document, one row and one channel
     * — but `findReadable` does not admit either handle for every circuit. An id
     * reaches only what a listing may show (`idAddressableCircuitFilter`), and
     * §11 deliberately leaves UNLISTED out of that: **the slug is an unlisted
     * circuit's access control, and therefore the only handle that addresses
     * it.** Joining by id worked for the owner of anything and for a reader of a
     * PUBLIC circuit, and answered NOT_FOUND for the one case §3.4 built
     * watchers for — somebody who was sent an unlisted link. The editor showed
     * them the circuit, over REST, by slug, and then told them the session
     * "could not be opened".
     *
     * Found by the two-browser suite (`e2e/live/collaboration.spec.ts`), which
     * is the first test in this repository where the two peers are two different
     * people rather than one document opened twice.
     */
    circuitId: base?.slug ?? null,
    enabled: !viewingVersion,
    /*
     * Which viewer this session belongs to. It is what makes the session reopen
     * when the credential arrives: a page whose Supabase session had not been
     * restored when the socket opened joined anonymously, the relay granted
     * `read` on a circuit the reader in fact owns, and the editor told the owner
     * she was watching until she reloaded. See `UseCollabSessionOptions.identity`.
     */
    identity: session.user?.id ?? null,
    /*
     * The version the canvas was seeded from, so a join can tell this reader's
     * unpublished work from an operation a peer deleted — see
     * `BridgeOptions.saved`. `base.circuit` is exactly that version.
     */
    saved: base?.circuit ?? null,
  })
  /*
   * Read-only from the relay's answer, and only once it has answered. `access` is
   * null while connecting and after the session ends, and neither of those may
   * disable an editor that works perfectly well on its own — the degradation path
   * is the whole promise of this feature, and an editor that went read-only
   * because a socket was slow would be the opposite of it.
   *
   * It does *not* go away during a reconnect, and that is not this file's doing:
   * the transport keeps the last access the relay stated until the session ends
   * (see `CollabSessionSnapshot.access`), because a watcher handed a writable
   * editor for the length of every dropped socket wrote gates into a document
   * that no other replica would ever hold.
   */
  const watching = collab.access === 'read'

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

      {/*
       * Above the title, because it is the answer to the question the title
       * raises: the heading says the name of a circuit the reader was just
       * looking at somewhere else, and this is what says the document under it
       * is their own copy of it (M1.5b).
       */}
      <ForkedFromNotice />

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

      {/*
       * Two columns, and which panel is in which is decided here rather than
       * in the stylesheet — see the `.document-bar` block in index.css for why
       * neither a plain grid nor multi-column could both pack these heights
       * and place them.
       *
       * The export panel is alone on the right because it is the outlier: five
       * formats, each with a sentence explaining it, make it about three times
       * the height of anything beside it. Everything else stacks on the left,
       * where the panels are short and of a kind — what this circuit is, where
       * it goes, whether it is saved.
       */}
      <div className="document-bar">
        <div className="document-bar__column">
          <PresetPicker store={useCircuitStore} />
          <ShareLink url={url} />
          {/*
           * Beside the share control and the export, because it is the third
           * answer to "how do I get this circuit out of here" — a link, a file,
           * and a frame in somebody else's page (§3.4).
           *
           * Only for a circuit that has a home. Unlike the export, an embed is
           * a pointer rather than a copy: it names a slug the server resolves on
           * every load, so there is nothing for it to point at until the
           * document is saved. It reads `doc.detail` rather than the store for
           * the same reason — what a reader of the blog post will see is the
           * *saved* version, not the unsaved edit on this screen, and offering a
           * snippet built from the latter would promise something else.
           */}
          {doc.detail === null ? null : (
            <EmbedSnippet
              slug={doc.detail.slug}
              title={doc.detail.title}
              qubitCount={doc.detail.qubitCount}
              visibility={doc.detail.visibility}
              origin={window.location.origin}
            />
          )}
          <SaveCircuitPanel document={doc} carried={!url.tooLarge} />
          <SubmitToHardwarePanel
            handle={base?.slug ?? null}
            signedIn={session.status === 'authenticated'}
          />
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

          {/*
           * Star and fork, for a circuit that has a home (M1.5b). Both are
           * addressed by *slug*, which is what makes them work on an UNLISTED
           * circuit somebody was sent a link to — an id reaches only what a
           * listing may show (`idAddressableCircuitFilter`).
           *
           * The fork is offered on somebody else's circuit and not on your own:
           * forking your own is a duplicate rather than a fork, the API would
           * happily do it, and the attribution sentence it lands on — "your copy
           * of X, by you" — is a thing no reader needs to be told. The star is
           * offered on both, because starring your own work is ordinary.
           *
           * The ownership test is a convenience and never a check: §11 puts
           * authorisation on the server, and the point of hiding a control is
           * that a button which can only produce a 403 is worse than no button.
           */}
          {doc.detail === null ? null : (
            <div className="document-bar__social">
              <StarButton
                slug={doc.detail.slug}
                circuitId={doc.detail.id}
                starred={doc.starred}
                starCount={doc.detail.starCount}
              />
              {doc.ownedBy(session.user?.id ?? null) ? null : (
                <ForkButton
                  slug={doc.detail.slug}
                  title={doc.detail.title}
                  username={doc.detail.owner.username}
                  variant="primary"
                />
              )}
            </div>
          )}
        </div>

        <div className="document-bar__column">
          {/*
           * Alone in its column, and the only panel here that is. It reads the
           * document from the store rather than from `doc`, so it exports the
           * circuit on screen including edits that have not been saved.
           */}
          <ExportPanel
            store={useCircuitStore}
            title={doc.detail?.title ?? ''}
          />
        </div>
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

      {/*
       * Who is here, whether this session is writable, and what the document
       * holds that the canvas does not (M5.6). Above the editor, because all
       * three change how the thing below is to be read — a reader who finds out
       * they are watching *after* trying to place a gate has been misled by the
       * layout.
       *
       * Only for a document with a home, and never over a version preview. For
       * `/new` and for an unsaved draft this renders nothing at all, which is
       * what keeps the page those visitors see byte-identical to the one that
       * shipped.
       */}
      {base === null || viewingVersion ? null : (
        <CollabPanel session={collab} store={useCircuitStore} />
      )}

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
        <CircuitEditor
          /*
           * Two layers over the canvas, as its one opaque overlay: the badges
           * over the anchored gates (M5.4) and the other people's carets (M5.3).
           * Only for a document with a home — a comment is a row against a
           * circuit id and a session is a channel named after one, so `/new` and
           * an unsaved draft have nothing to draw and nothing to fetch.
           *
           * The canvas takes one node and never looks inside it, which is exactly
           * why two features can share the slot without either learning about the
           * other. Order is paint order: a comment badge sits above a caret,
           * because a badge is a handle a reader clicks and a caret is somebody
           * else's position.
           */
          {...(base === null
            ? {}
            : {
                canvasOverlay: (
                  <>
                    <PresenceCursorLayer store={collab.presence} />
                    <CommentMarkerLayer
                      handle={base.slug}
                      store={useCircuitStore}
                    />
                  </>
                ),
              })}
          /*
           * The overflow at the end of the toolbar. Mounted by the page, like
           * everything else here that acts on the document rather than on the
           * circuit — and, concretely, because its graph carries an OpenQASM
           * parser that has no business in the editor's chunk. Unconditional:
           * an import is how a reader gets a circuit *in*, so it is exactly as
           * useful on `/new` as on a saved document.
           */
          toolbarOverflow={<ImportMenu store={useCircuitStore} />}
          /*
           * The relay's answer, drawn. A watcher may look and not write, and the
           * refusal is the relay's on every frame — this only stops the editor
           * from inviting an edit it will drop.
           */
          readOnly={watching}
          /*
           * The outbound half of presence: only the grid knows where this reader
           * is looking. Passed straight through rather than wrapped in an arrow,
           * because the session's own `setCursor` is stable for the life of the
           * session and a fresh function per render would be a cursor frame per
           * keystroke.
           */
          onCursorMove={collab.setCursor}
        />
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

      {/*
       * The conversation, under the editor rather than beside it (M5.4). Below,
       * because a circuit is a wide thing and a panel in a column beside it would
       * cost the canvas the width it needs at twenty wires; and *after* the canvas
       * in the DOM, so the reading order and the tab order both meet the document
       * before the discussion about it.
       *
       * Not rendered while a past version is on screen. The anchors in a thread
       * are resolved against the document the reader is looking at, and a version
       * preview is a *different* document — every thread on a gate added since
       * would correctly report itself orphaned, which is true and useless. The
       * threads are one press away, on the live document, where they mean
       * something.
       */}
      {base === null || viewingVersion ? null : (
        <CommentsPanel handle={base.slug} store={useCircuitStore} />
      )}
    </main>
  )
}
