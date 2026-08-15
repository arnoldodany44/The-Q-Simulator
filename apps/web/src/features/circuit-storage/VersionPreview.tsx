/**
 * A past version, on screen and clearly not the document you are editing —
 * §3.4, milestone M1.4b.
 *
 * ── Nothing is loaded into the editor to show it ──────────────────────────
 *
 * The obvious implementation is to call `loadCircuit` with version 3 and let
 * the editor draw it. It is also the one that loses work: `loadCircuit`
 * replaces the document and clears the undo history, so "let me glance at what
 * version 3 said" would silently throw away an afternoon of unsaved edits and
 * every step that could have undone them.
 *
 * So the past version is rendered *beside* the editing session rather than
 * into it: a read-only `CircuitCanvas` over the version's own circuit, with
 * the store untouched. Closing the preview returns to exactly the document
 * that was on screen — including its `?c=` draft and its undo stack — because
 * nothing ever moved.
 *
 * The one place a version does cross into the store is the restore below, and
 * there the crossing is the whole point of the action and is announced before
 * it happens.
 *
 * ── Saying which document this is, twice ──────────────────────────────────
 *
 * A page that shows an old circuit in the editor's own frame is a page a
 * reader can misread as their work, and the cost of that mistake is edits made
 * to the wrong thing. The banner is therefore a block of its own with a
 * `role="status"` — not a tint, not a border — and the canvas is genuinely
 * inert rather than merely styled as such: `readOnly` removes the drop
 * targets, the row controls and the keyboard cursor, so a gate cannot be
 * dropped on history even by someone who missed the banner entirely.
 *
 * ── Restore appends; it never rewrites ────────────────────────────────────
 *
 * §3.4 and `apps/api/src/routes/circuits.ts` agree: there is no update and no
 * delete for a version. Restoring version 3 saves version 3's document as a
 * *new* version, and both survive. The interface has to make that legible, so
 * the confirmation names both numbers — the one that came back and the one it
 * landed on — and the default note carried into the history says the same
 * thing in the language of whoever pressed the button.
 *
 * ── WHY THE RESTORE STATE LIVES IN `RestoreSection` AND NOT IN THE FORM ───
 *
 * Because a successful restore makes its own gate close. `useSaveCircuit`
 * rebinds the document's base to the version the server echoed, which is by
 * construction the version being previewed — so a `sameCircuit(circuit,
 * base.circuit)` test placed *above* the form flips to true the instant the
 * save lands, unmounting the form. React Query does not invoke a
 * mutate-scoped callback for an observer with no listeners, so everything that
 * completes the restore went with it: the store was never given the restored
 * document, the confirmation never rendered, and the reader was told "there is
 * nothing to bring back" one click after pressing Restore. The editor was then
 * dirty against the version the restore had just created, and the next save
 * appended the pre-restore document again — silently undoing the rollback.
 *
 * So the mutation, the landed version number and the "this is already what you
 * have open" test all live in one component that the save cannot unmount, and
 * `landed` is checked before that test. The ownership gate above it is
 * separate because it answers a different question — who may press this — and
 * it does not change when a save succeeds.
 */

import { useEffect, useId, useRef, useState } from 'react'
import { flushSync } from 'react-dom'
import { useTranslation } from 'react-i18next'
import type { Circuit } from '@qsim/schema'

import { useSession } from '../auth'
import {
  isNotFound,
  useApiErrorMessage,
  useCircuitVersion,
} from '../../lib/api'
import { CircuitCanvas } from '../circuit-editor/CircuitCanvas'
import {
  sameCircuit,
  useCircuitStore,
  type CircuitStore,
} from '../circuit-editor/useCircuitStore'
import { CircuitDiffView } from './CircuitDiffView.js'
import {
  useDocumentBinding,
  type DocumentBase,
  type DocumentBindingStore,
} from './documentBinding.js'
import {
  messageProblem,
  optionalText,
  type SaveProblem,
} from './saveDecisions.js'
import { useSaveCircuit } from './useSaveCircuit.js'
import type { CircuitDocumentView } from './useCircuitDocument.js'
import { NO_VERSION_SELECTED, type VersionSelection } from './versionParams.js'

export interface VersionPreviewProps {
  /** The circuit's slug — or its id; the route accepts either. */
  readonly handle: string
  /** The selection from the address. `version` is what put this on screen. */
  readonly selection: VersionSelection
  readonly document: CircuitDocumentView
  readonly onSelect: (next: VersionSelection) => void
  readonly store?: CircuitStore
  readonly binding?: DocumentBindingStore
}

export function VersionPreview({
  handle,
  selection,
  document: doc,
  onSelect,
  store = useCircuitStore,
  binding = useDocumentBinding,
}: VersionPreviewProps) {
  const { t, i18n } = useTranslation('circuits')
  const describeError = useApiErrorMessage()

  const viewing = selection.version
  const viewed = useCircuitVersion(handle, viewing)
  const compared = useCircuitVersion(handle, selection.compare)

  const numbers = new Intl.NumberFormat(i18n.language)

  const close = () => {
    onSelect(NO_VERSION_SELECTED)
  }

  const back = (
    <button className="page__cta" type="button" onClick={close}>
      {t('history.backToDocument')}
    </button>
  )

  if (viewing === null) return null

  if (viewed.isPending) {
    return (
      <p className="page__loading" role="status">
        {t('history.opening', { number: numbers.format(viewing) })}
      </p>
    )
  }

  if (viewed.isError || viewed.data === undefined) {
    return (
      <div className="notice" role="alert">
        {/*
         * §11 conflates "no such version" with "not yours to see", and so does
         * this: one sentence for both. But the sentence has to name what was
         * not found — the shared `NOT_FOUND` copy is written about circuits,
         * and printing it inside the editor for a circuit that is open, with
         * its title in the heading, tells the reader something they can see is
         * false. Same non-disclosure, different subject.
         */}
        <p>
          {isNotFound(viewed.error)
            ? t('history.versionUnavailable')
            : describeError(viewed.error)}
        </p>
        <p>{back}</p>
      </div>
    )
  }

  const version = viewed.data.version
  const when = new Intl.DateTimeFormat(i18n.language, {
    dateStyle: 'long',
    timeStyle: 'short',
  })

  const other = compared.data?.version ?? null
  const pair =
    other === null
      ? null
      : orderByVersion(
          { number: version.versionNum, circuit: version.circuit },
          { number: other.versionNum, circuit: other.circuit }
        )

  return (
    <section className="version-preview">
      <div className="version-preview__banner" role="status">
        <p className="version-preview__title">
          {t('history.viewing', { number: numbers.format(version.versionNum) })}
        </p>
        <p className="version-preview__when">
          <time dateTime={version.createdAt.toISOString()}>
            {when.format(version.createdAt)}
          </time>
        </p>
        {version.message === null ? null : (
          <p className="version-preview__message">{version.message}</p>
        )}
        <p className="version-preview__explain">{t('history.notLive')}</p>
        {back}
      </div>

      {/*
       * A comparison the server refused. Silence would be the easy answer and
       * the wrong one: the reader asked to see two versions side by side, and
       * a page that quietly shows one of them looks like a diff with nothing
       * in it — which is a different claim entirely.
       */}
      {selection.compare !== null && compared.isError ? (
        <div className="notice" role="alert">
          <p>{t('history.compareUnavailable')}</p>
          <p>
            {isNotFound(compared.error)
              ? t('history.versionUnavailable')
              : describeError(compared.error)}
          </p>
        </div>
      ) : null}

      {pair === null ? null : (
        <CircuitDiffView
          before={pair.older.circuit}
          after={pair.newer.circuit}
          from={pair.older.number}
          to={pair.newer.number}
        />
      )}

      <CircuitCanvas
        circuit={version.circuit}
        readOnly
        /* The banner above says why this cannot be edited, in stronger words
           and in the right ones; the canvas's own notice is about small
           screens and would contradict it. */
        readOnlyNotice={null}
      />

      <RestoreControl
        /*
         * Keyed by the version, so opening a different one from the history
         * gives a restore control that has not already landed somewhere.
         */
        key={version.versionNum}
        version={version.versionNum}
        circuit={version.circuit}
        document={doc}
        onDone={close}
        store={store}
        binding={binding}
      />
    </section>
  )
}

/* ── Restore ────────────────────────────────────────────────────────────── */

interface RestoreControlProps {
  readonly version: number
  readonly circuit: Circuit
  readonly document: CircuitDocumentView
  readonly onDone: () => void
  readonly store: CircuitStore
  readonly binding: DocumentBindingStore
}

/**
 * Who may press it — and nothing else, so that nothing a *save* changes can
 * take the control away mid-restore. See the header.
 *
 * The ownership test is a convenience and never a check — §11 puts
 * authorisation on the server, `POST /circuits/:id/versions` answers 403 for
 * anyone but the owner, and the reason to hide the control is that a button
 * which can only fail is worse than no button. The failure path is still
 * handled, because the answer can change between the paint and the click.
 */
function RestoreControl({
  version,
  circuit,
  document: doc,
  onDone,
  store,
  binding,
}: RestoreControlProps) {
  const session = useSession()

  // Same three-state rule as `SaveCircuitPanel`: "not known yet" is not
  // "signed out", and rendering a sign-in invitation at somebody who is
  // already signed in is a defect even when it lasts two frames.
  if (session.status !== 'authenticated') return null

  const base = doc.base
  if (base === null || !doc.ownedBy(session.user.id)) return null

  return (
    <RestoreSection
      version={version}
      circuit={circuit}
      base={base}
      dirty={doc.dirty}
      onDone={onDone}
      store={store}
      binding={binding}
    />
  )
}

interface RestoreSectionProps {
  readonly version: number
  readonly circuit: Circuit
  readonly base: DocumentBase
  readonly dirty: boolean
  readonly onDone: () => void
  readonly store: CircuitStore
  readonly binding: DocumentBindingStore
}

function RestoreSection({
  version,
  circuit,
  base,
  dirty,
  onDone,
  store,
  binding,
}: RestoreSectionProps) {
  const { t, i18n } = useTranslation('circuits')
  const describeError = useApiErrorMessage()
  const messageId = useId()
  const numbers = new Intl.NumberFormat(i18n.language)
  const save = useSaveCircuit({ binding })

  const [message, setMessage] = useState(() =>
    t('history.restore.defaultMessage', { number: numbers.format(version) })
  )
  const [problem, setProblem] = useState<SaveProblem | null>(null)
  /** The version number this restore landed on, once it has. */
  const [landed, setLanded] = useState<number | null>(null)

  const messageRef = useRef<HTMLInputElement>(null)
  const doneRef = useRef<HTMLDivElement>(null)

  /*
   * The submit button disabled itself while the request was in flight, so at
   * this moment focus is wherever the browser puts it when the focused element
   * goes away — the document body. The confirmation is where the reader's
   * question is answered, so that is where the caret belongs; a `role="status"`
   * alone is announced by a screen reader and leaves a keyboard user tabbing
   * from the top of the page.
   */
  useEffect(() => {
    if (landed === null) return
    doneRef.current?.focus()
  }, [landed])

  const result = save.data ?? null

  const restore = (force: boolean): void => {
    if (save.isPending) return

    const fault = messageProblem(message)
    /*
     * Flushed before the focus move, not after. React batches state set in a
     * discrete event and commits at the end of it, so a `focus()` written
     * below a plain `setProblem` runs while the field still carries neither
     * `aria-invalid` nor a description — the one instant that decides what is
     * announced. Committing first is what makes the wiring in the DOM the
     * wiring a screen reader reads.
     */
    flushSync(() => {
      setProblem(fault)
    })
    if (fault !== null) {
      // The message is the only field here, so it is the only place the
      // correction can happen. Without this the submit does nothing visible to
      // anybody who is not looking at the paragraph under the input.
      messageRef.current?.focus()
      return
    }

    save.mutate(
      {
        kind: 'version',
        base,
        circuit,
        message: optionalText(message),
        // A restore is about the document and never about the title, the
        // description or the visibility: those belong to the circuit, not to
        // the version, and rolling them back is not what was asked for.
        details: null,
        ...(force ? { force: true } : {}),
      },
      {
        onSuccess: (saved) => {
          if (saved.kind !== 'saved' || saved.version === null) return
          /*
           * The server's echo, not the document sent: the same value parsed
           * through the same schema, and taking theirs makes it an assertion
           * rather than an assumption. `useSaveCircuit` has already moved the
           * binding to this version, so after the load the editor is clean
           * rather than immediately dirty against a base it never held.
           */
          store.getState().loadCircuit(saved.version.circuit)
          setLanded(saved.version.versionNum)
        },
      }
    )
  }

  if (landed !== null) {
    return (
      <div
        className="version-preview__done"
        role="status"
        ref={doneRef}
        tabIndex={-1}
      >
        {/*
         * The whole point of the milestone, in one sentence: which version
         * came back, which number it landed on, and that nothing was rewritten
         * or removed to make it happen.
         */}
        <p>
          {t('history.restore.done', {
            number: numbers.format(version),
            landed: numbers.format(landed),
          })}
        </p>
        <button className="page__cta" type="button" onClick={onDone}>
          {t('history.backToDocument')}
        </button>
      </div>
    )
  }

  if (result?.kind === 'stale') {
    return (
      <div className="version-preview__conflict" role="alert">
        <p>
          {t('history.restore.stale', {
            number: numbers.format(version),
            server: numbers.format(result.conflict.server),
          })}
        </p>
        <div className="save-panel__conflict-actions">
          <button
            type="button"
            onClick={() => {
              restore(true)
            }}
          >
            {t('history.restore.anyway')}
          </button>
          <button
            type="button"
            onClick={() => {
              save.reset()
            }}
          >
            {t('history.restore.cancel')}
          </button>
        </div>
      </div>
    )
  }

  /*
   * Below `landed` on purpose: a restore that has just succeeded makes this
   * true by construction — the previewed version and the new base are the same
   * document — and answering "there is nothing to bring back" to somebody who
   * pressed Restore a second ago is a flat contradiction of what happened.
   */
  if (sameCircuit(circuit, base.circuit)) {
    return (
      <p className="version-preview__note">
        {t('history.restore.alreadyHere', {
          number: numbers.format(base.versionNum),
        })}
      </p>
    )
  }

  return (
    <form
      className="version-preview__restore"
      noValidate
      onSubmit={(event) => {
        event.preventDefault()
        restore(false)
      }}
    >
      <p className="version-preview__explain">
        {t('history.restore.explain', { number: numbers.format(version) })}
      </p>

      {dirty ? (
        <p className="version-preview__warning">
          {t('history.restore.dirtyWarning')}
        </p>
      ) : null}

      {save.isError ? (
        <p className="save-panel__error" role="alert">
          {describeError(save.error)}
        </p>
      ) : null}

      <div className="field">
        <label className="field__label" htmlFor={messageId}>
          {t('history.restore.message.label')}
        </label>
        <p className="field__hint" id={`${messageId}-hint`}>
          {t('history.restore.message.hint')}
        </p>
        <input
          className="field__input"
          id={messageId}
          ref={messageRef}
          name="message"
          type="text"
          value={message}
          /*
           * `readOnly`, never `disabled`. A disabled element cannot hold focus,
           * so disabling the field somebody submitted from drops the caret to
           * the document body — see the note on the submit button below.
           */
          readOnly={save.isPending}
          aria-invalid={problem === null ? undefined : true}
          aria-describedby={
            problem === null
              ? `${messageId}-hint`
              : `${messageId}-hint ${messageId}-error`
          }
          onChange={(event) => {
            setMessage(event.target.value)
          }}
        />
        {problem === null ? null : (
          <p className="field__error" id={`${messageId}-error`} role="alert">
            {t(`save.problem.${problem}`)}
          </p>
        )}
      </div>

      {/*
       * `aria-disabled` rather than `disabled`: a disabled button loses focus
       * to the document body, and this is the button a keyboard user pressed
       * Enter on. The second submit it would have prevented is prevented by
       * the mutation's own pending state instead.
       */}
      <button
        type="submit"
        aria-disabled={save.isPending}
        onClick={(event) => {
          if (!save.isPending) return
          event.preventDefault()
        }}
      >
        {t('history.restore.submit', { number: numbers.format(version) })}
      </button>
      {save.isPending ? (
        <p className="save-form__pending" role="status">
          {t('history.restore.saving')}
        </p>
      ) : null}
    </form>
  )
}

/* ── Helpers ────────────────────────────────────────────────────────────── */

interface NumberedCircuit {
  readonly number: number
  readonly circuit: Circuit
}

/**
 * A diff reads from the older version to the newer one, whichever order the
 * two were picked in. Version numbers are monotonic on the server, so the
 * smaller number is the earlier document — no timestamp comparison needed.
 */
function orderByVersion(
  left: NumberedCircuit,
  right: NumberedCircuit
): { older: NumberedCircuit; newer: NumberedCircuit } {
  return left.number <= right.number
    ? { older: left, newer: right }
    : { older: right, newer: left }
}
