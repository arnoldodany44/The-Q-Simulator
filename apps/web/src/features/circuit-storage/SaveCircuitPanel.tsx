/**
 * The save control: the editor's one connection to an account — M1.4a.
 *
 * ── Four audiences, and none of them may see a broken promise ─────────────
 *
 *   - **Session still resolving.** Neither shape is rendered. A control that
 *     reads "not known yet" as "signed out" puts *Sign in to save* in front of
 *     somebody who is already signed in, for the frame or two it takes
 *     supabase-js to read storage — long enough to click on a slow refresh.
 *     Same rule, same reason, as `RequireSession` and `AccountMenu`.
 *   - **Anonymous.** Phase 0, unchanged: nothing is uploaded, the address bar
 *     is still the document, and the control is an invitation rather than a
 *     button that can only fail. It carries the destination in history state,
 *     never in a query parameter — an UNLISTED slug is its own access control
 *     (§11), and `?next=/c/…` would copy it into history and `Referer`.
 *   - **Signed in, on an unsaved document.** Title, description and visibility,
 *     then `POST /circuits`, then the address becomes `/c/:slug`.
 *   - **Signed in, on a circuit somebody else owns.** The *append a version*
 *     control is not offered, because it would be answered with 403. That is a
 *     convenience and not a check: §11 puts authorisation on the server, the
 *     answer can change between the paint and the click, and the failure path
 *     below handles a 403 or a 404 arriving anyway — with the one recovery
 *     that always works, saving the document as a circuit of your own.
 *
 * ── What the form deliberately does not have ──────────────────────────────
 *
 * A tags field. `Circuit.tags` exists in the Prisma schema, and there is no
 * `tags` in `CreateCircuitBody` or `UpdateCircuitBody`, no `tags` in any
 * response, and no handling in `routes/circuits.ts` — tags arrive with the
 * gallery in M1.5. Zod object schemas strip what they do not declare, so a
 * tags input today would be accepted by the form, sent, silently dropped, and
 * shown as saved. An input that discards what is typed into it is worse than
 * an absent one.
 *
 * ── A rejected submit has to reach somebody who cannot see the form ───────
 *
 * Focus follows the *first* refusal, whichever field it is in. It used to
 * follow only a title problem, so pasting 4200 characters into the description
 * moved nothing, announced nothing, and left the reader with a button that
 * appeared to do nothing at all — the red paragraph under the textarea was the
 * only feedback, and a screen reader never reaches it on its own. The messages
 * also carry `role="alert"` for the case a focus move cannot help with: the
 * field the reader was already in.
 */

import { useEffect, useId, useRef, useState } from 'react'
import { flushSync } from 'react-dom'
import { useTranslation } from 'react-i18next'
import { Link, useLocation, useNavigate } from 'react-router'
import { useStore } from 'zustand'
import { VISIBILITY_VALUES, Visibility } from '@qsim/contract'
import type { UpdateCircuitRequest } from '@qsim/contract'

import {
  INTENDED_PATH_STATE_KEY,
  SIGN_IN_PATH,
  useAuthRuntime,
  useSession,
} from '../auth'
import { useApiErrorMessage, isForbidden, isNotFound } from '../../lib/api'
import {
  useCircuitStore,
  type CircuitStore,
} from '../circuit-editor/useCircuitStore'
import {
  useDocumentBinding,
  type DocumentBindingStore,
} from './documentBinding.js'
import { circuitPagePath } from './paths.js'
import {
  descriptionProblem,
  messageProblem,
  optionalText,
  titleProblem,
  type SaveProblem,
} from './saveDecisions.js'
import { useSaveCircuit } from './useSaveCircuit.js'
import type { SaveVariables } from './useSaveCircuit.js'
import type { CircuitDocumentView } from './useCircuitDocument.js'

export interface SaveCircuitPanelProps {
  readonly document: CircuitDocumentView
  /**
   * Whether the address bar is currently holding the document — Phase 0's
   * draft, and the reason an unsaved edit survives a reload. False for a
   * circuit past the URL budget, which is the one case work is genuinely at
   * risk. See `useUnsavedWork.ts`.
   */
  readonly carried: boolean
  readonly store?: CircuitStore
  readonly binding?: DocumentBindingStore
}

export function SaveCircuitPanel({
  document: doc,
  carried,
  store = useCircuitStore,
  binding = useDocumentBinding,
}: SaveCircuitPanelProps) {
  const { t } = useTranslation('circuits')
  const runtime = useAuthRuntime()
  const session = useSession()
  const location = useLocation()
  const headingId = useId()

  // No Supabase project on this deployment: there are no accounts to save to,
  // and the editor is exactly the Phase 0 one.
  if (runtime === null) return null

  /*
   * Two different "not known yet"s, and both render nothing rather than a
   * guess. The session one is the flash `RequireSession` and `AccountMenu`
   * describe. The document one is its twin: while a `/c/:slug` is still in
   * flight the panel does not know whether this is a circuit the viewer may
   * append a version to, and offering *Save circuit* — the control for a
   * document with no home — would put the wrong action under the cursor for
   * as long as the round trip takes.
   *
   * Inert and `aria-hidden`, not `null`, so the document bar does not jump
   * when the answer arrives.
   */
  if (session.status === 'loading' || doc.status === 'loading') {
    return (
      <section className="save-panel save-panel--pending" aria-hidden="true" />
    )
  }

  if (session.status === 'anonymous') {
    return (
      <section className="save-panel" aria-labelledby={headingId}>
        <h3 className="save-panel__heading" id={headingId}>
          {t('save.heading')}
        </h3>
        <p className="save-panel__status">{t('save.status.anonymous')}</p>
        <Link
          className="save-panel__signin"
          to={SIGN_IN_PATH}
          state={{
            [INTENDED_PATH_STATE_KEY]: `${location.pathname}${location.search}`,
          }}
        >
          {t('save.signIn')}
        </Link>
      </section>
    )
  }

  return (
    <SignedInPanel
      document={doc}
      carried={carried}
      store={store}
      binding={binding}
      userId={session.user.id}
      headingId={headingId}
    />
  )
}

interface SignedInPanelProps extends SaveCircuitPanelProps {
  readonly store: CircuitStore
  readonly binding: DocumentBindingStore
  readonly userId: string
  readonly headingId: string
}

/**
 * Split out so the hooks below run only for a resolved, signed-in session.
 * Putting them above the three early returns would mean a mutation, a form and
 * a navigation existing for every anonymous reader of a public circuit.
 */
function SignedInPanel({
  document: doc,
  carried,
  store,
  binding,
  userId,
  headingId,
}: SignedInPanelProps) {
  const { t, i18n } = useTranslation('circuits')
  const describeError = useApiErrorMessage()
  const navigate = useNavigate()
  const circuit = useStore(store, (state) => state.circuit)
  const save = useSaveCircuit({ binding })
  // §10: figures reach the reader through `Intl.NumberFormat`, version numbers
  // included — the history list next to this panel already did.
  const numbers = new Intl.NumberFormat(i18n.language)

  const [open, setOpen] = useState(false)
  /**
   * Set when the server refused a save on this circuit — 403 or 404 — which
   * turns the form into the one thing that still works: a circuit of your own.
   * It is not cleared by editing, only by opening a different document.
   */
  const [ownershipLost, setOwnershipLost] = useState(false)
  const [nothingToSave, setNothingToSave] = useState(false)
  /**
   * The attempt the conflict panel is about, kept so that answering "save it
   * anyway" sends the *same* save — the same message, the same metadata — and
   * not a stripped-down second one that silently drops what was typed.
   */
  const [refused, setRefused] = useState<SaveVariables | null>(null)

  const base = doc.base
  const owned = doc.ownedBy(userId)
  const canAppend = base !== null && owned && !ownershipLost
  const result = save.data ?? null

  const statusLine =
    base === null
      ? t('save.status.unsaved')
      : !carried && doc.dirty
        ? t('save.status.uncarried', {
            version: numbers.format(base.versionNum),
          })
        : doc.dirty
          ? t('save.status.dirty', { version: numbers.format(base.versionNum) })
          : t('save.status.clean', { version: numbers.format(base.versionNum) })

  return (
    <section className="save-panel" aria-labelledby={headingId}>
      <h3 className="save-panel__heading" id={headingId}>
        {t('save.heading')}
      </h3>

      {/* The one line that is always true, whatever else is on screen. */}
      <p className="save-panel__status" role="status">
        {statusLine}
      </p>

      {result?.kind === 'stale' ? (
        <div className="save-panel__conflict" role="alert">
          <p>
            {t('conflict.body', {
              base: numbers.format(result.conflict.base),
              server: numbers.format(result.conflict.server),
            })}
          </p>
          <div className="save-panel__conflict-actions">
            <button
              type="button"
              onClick={() => {
                if (refused === null || refused.kind !== 'version') return
                save.mutate(
                  { ...refused, force: true },
                  {
                    onSuccess: () => {
                      setOpen(false)
                      setRefused(null)
                    },
                  }
                )
              }}
            >
              {t('conflict.saveAnyway')}
            </button>
            <button
              type="button"
              onClick={() => {
                /*
                 * Discards the edit on screen, and says so in its label. The
                 * server's document goes through `loadCircuit` like every
                 * other one that came from outside, and the binding moves to
                 * the version it came from — so the next save is clean rather
                 * than immediately stale again.
                 */
                const { latest } = result
                store.getState().loadCircuit(latest.version.circuit)
                binding.getState().bind({
                  circuitId: latest.circuit.id,
                  slug: latest.circuit.slug,
                  versionNum: latest.version.versionNum,
                  circuit: latest.version.circuit,
                })
                save.reset()
                setRefused(null)
                setOpen(false)
              }}
            >
              {t('conflict.discardMine', {
                version: numbers.format(result.latest.version.versionNum),
              })}
            </button>
            <button
              type="button"
              onClick={() => {
                save.reset()
              }}
            >
              {t('conflict.keepEditing')}
            </button>
          </div>
        </div>
      ) : null}

      {result?.kind === 'saved' && result.raced !== null ? (
        <p className="save-panel__conflict" role="alert">
          {t('conflict.raced', {
            landed: numbers.format(result.raced.landed),
            other: numbers.format(result.raced.landed - 1),
          })}
        </p>
      ) : null}

      {save.isError ? (
        <p className="save-panel__error" role="alert">
          {describeError(save.error)}
        </p>
      ) : null}

      {nothingToSave ? (
        <p className="save-panel__note" role="status">
          {t('save.nothingToSave')}
        </p>
      ) : null}

      {ownershipLost ? (
        <p className="save-panel__note">{t('save.ownershipLost')}</p>
      ) : null}

      <button
        className="save-panel__toggle"
        type="button"
        aria-expanded={open}
        onClick={() => {
          setNothingToSave(false)
          setOpen((wasOpen) => !wasOpen)
        }}
      >
        {open
          ? t('save.close')
          : canAppend
            ? t('save.openVersion')
            : t('save.openNew')}
      </button>

      {open ? (
        <SaveForm
          /*
           * Keyed by the document, so opening a different circuit gives a
           * form with that circuit's title in it rather than one that has to
           * be synchronised by an effect — the kind that overwrites what
           * somebody is halfway through typing.
           */
          key={base?.circuitId ?? 'new'}
          mode={canAppend ? 'version' : 'create'}
          initialTitle={doc.detail?.title ?? ''}
          initialDescription={doc.detail?.description ?? ''}
          initialVisibility={doc.detail?.visibility ?? Visibility.PRIVATE}
          pending={save.isPending}
          onSubmit={({ title, description, visibility, message }) => {
            setNothingToSave(false)

            if (!canAppend || base === null) {
              save.mutate(
                {
                  kind: 'create',
                  circuit,
                  details: { title, description, visibility },
                  message: null,
                },
                {
                  onSuccess: (created) => {
                    if (created.kind !== 'created') return
                    setOpen(false)
                    setOwnershipLost(false)
                    /*
                     * `replace`, so Back leaves the editor rather than
                     * returning to `/new` — an address that now names a
                     * document which has a home of its own.
                     */
                    void navigate(circuitPagePath(created.circuit.slug), {
                      replace: true,
                    })
                  },
                  onError: () => {
                    // A failed create is not an ownership problem; leave the
                    // form open with the message above it.
                  },
                }
              )
              return
            }

            const detail = doc.detail
            const details = changedDetails(
              { title, description, visibility },
              detail === null
                ? null
                : {
                    title: detail.title,
                    description: detail.description,
                    visibility: detail.visibility,
                  }
            )
            if (!doc.dirty && details === null) {
              setNothingToSave(true)
              return
            }

            const attempt: SaveVariables = {
              kind: 'version',
              base,
              circuit: doc.dirty ? circuit : null,
              message,
              details,
            }
            setRefused(attempt)

            save.mutate(attempt, {
              onSuccess: (saved) => {
                if (saved.kind === 'stale') return
                setRefused(null)
                setOpen(false)
              },
              onError: (error) => {
                /*
                 * §11 conflates "no such circuit" with "not yours to see", and
                 * a 403 is the same news arriving on a write. Either way the
                 * answer is the same and it is not "try again": this account
                 * cannot add to that history, and what it can do is keep the
                 * work under its own name.
                 */
                if (isNotFound(error) || isForbidden(error)) {
                  setOwnershipLost(true)
                }
              },
            })
          }}
        />
      ) : null}
    </section>
  )
}

interface SaveFormValues {
  readonly title: string
  readonly description: string | null
  readonly visibility: Visibility
  readonly message: string | null
}

interface SaveFormProps {
  readonly mode: 'create' | 'version'
  readonly initialTitle: string
  readonly initialDescription: string
  readonly initialVisibility: Visibility
  readonly pending: boolean
  readonly onSubmit: (values: SaveFormValues) => void
}

function SaveForm({
  mode,
  initialTitle,
  initialDescription,
  initialVisibility,
  pending,
  onSubmit,
}: SaveFormProps) {
  const { t } = useTranslation('circuits')
  const fieldIds = {
    title: useId(),
    description: useId(),
    message: useId(),
    visibility: useId(),
  }
  const titleRef = useRef<HTMLInputElement>(null)
  const descriptionRef = useRef<HTMLTextAreaElement>(null)
  const messageRef = useRef<HTMLInputElement>(null)

  const [title, setTitle] = useState(initialTitle)
  const [description, setDescription] = useState(initialDescription)
  const [visibility, setVisibility] = useState<Visibility>(initialVisibility)
  const [message, setMessage] = useState('')
  const [problems, setProblems] = useState<readonly SaveProblem[]>([])

  // The form appeared because the user asked for it, so the caret belongs in
  // its first field rather than three tab stops above it.
  useEffect(() => {
    titleRef.current?.focus()
  }, [])

  const problemOf = (candidates: readonly SaveProblem[]): SaveProblem | null =>
    problems.find((problem) => candidates.includes(problem)) ?? null

  const titleFault = problemOf(['title-required', 'title-too-long'])
  const descriptionFault = problemOf(['description-too-long'])
  const messageFault = problemOf(['message-too-long'])

  /** The control a refusal belongs to, so focus can be put on it. */
  const fieldFor = (problem: SaveProblem | undefined): HTMLElement | null => {
    if (problem === undefined) return null
    if (problem.startsWith('title')) return titleRef.current
    if (problem === 'description-too-long') return descriptionRef.current
    return messageRef.current
  }

  return (
    <form
      className="save-form"
      noValidate
      onSubmit={(event) => {
        event.preventDefault()
        if (pending) return

        const found = [
          titleProblem(title),
          descriptionProblem(description),
          mode === 'version' ? messageProblem(message) : null,
        ].filter((problem): problem is SaveProblem => problem !== null)

        /*
         * Committed before the focus move, for the reason `sign-in.tsx` gives:
         * React batches state set in a discrete event, so focusing first would
         * land on a field that does not yet carry `aria-invalid` or a pointer
         * to the message — the one instant that decides what is announced.
         */
        flushSync(() => {
          setProblems(found)
        })
        if (found.length > 0) {
          // Focus follows the first refusal — whichever field it is in. It used
          // to follow only a title problem, which meant a rejected description
          // or note moved nothing and announced nothing.
          fieldFor(found[0])?.focus()
          return
        }

        onSubmit({
          title: title.trim(),
          description: optionalText(description),
          visibility,
          message: mode === 'version' ? optionalText(message) : null,
        })
      }}
    >
      <div className="field">
        <label className="field__label" htmlFor={fieldIds.title}>
          {t('save.title.label')}
        </label>
        <input
          className="field__input"
          id={fieldIds.title}
          ref={titleRef}
          name="title"
          type="text"
          value={title}
          /* `readOnly`, never `disabled`: a disabled control cannot hold
             focus, so disabling a field mid-submit hands the caret to the
             document body. Same reasoning as the submit button below. */
          readOnly={pending}
          aria-disabled={pending || undefined}
          aria-invalid={titleFault === null ? undefined : true}
          aria-describedby={
            titleFault === null ? undefined : `${fieldIds.title}-error`
          }
          onChange={(event) => {
            setTitle(event.target.value)
          }}
        />
        {titleFault === null ? null : (
          <p
            className="field__error"
            id={`${fieldIds.title}-error`}
            role="alert"
          >
            {t(`save.problem.${titleFault}`)}
          </p>
        )}
      </div>

      <div className="field">
        <label className="field__label" htmlFor={fieldIds.description}>
          {t('save.description.label')}
        </label>
        <textarea
          className="field__input"
          id={fieldIds.description}
          name="description"
          rows={3}
          ref={descriptionRef}
          value={description}
          readOnly={pending}
          aria-disabled={pending || undefined}
          aria-invalid={descriptionFault === null ? undefined : true}
          aria-describedby={
            descriptionFault === null
              ? undefined
              : `${fieldIds.description}-error`
          }
          onChange={(event) => {
            setDescription(event.target.value)
          }}
        />
        {descriptionFault === null ? null : (
          <p
            className="field__error"
            id={`${fieldIds.description}-error`}
            role="alert"
          >
            {t(`save.problem.${descriptionFault}`)}
          </p>
        )}
      </div>

      <fieldset className="save-form__visibility">
        <legend className="field__label">{t('save.visibility.label')}</legend>
        {VISIBILITY_VALUES.map((value) => (
          <div className="save-form__option" key={value}>
            <input
              id={`${fieldIds.visibility}-${value}`}
              type="radio"
              name="visibility"
              value={value}
              checked={visibility === value}
              // Focusable while a save is in flight, and inert — see the note
              // on the submit button.
              aria-disabled={pending || undefined}
              aria-describedby={`${fieldIds.visibility}-${value}-hint`}
              onChange={() => {
                if (pending) return
                setVisibility(value)
              }}
            />
            <label htmlFor={`${fieldIds.visibility}-${value}`}>
              {t(`visibility.${value}`)}
            </label>
            <p
              className="save-form__hint"
              id={`${fieldIds.visibility}-${value}-hint`}
            >
              {t(`save.visibility.${value}`)}
            </p>
          </div>
        ))}
      </fieldset>

      {mode === 'version' ? (
        <div className="field">
          <label className="field__label" htmlFor={fieldIds.message}>
            {t('save.message.label')}
          </label>
          <p className="field__hint" id={`${fieldIds.message}-hint`}>
            {t('save.message.hint')}
          </p>
          <input
            className="field__input"
            id={fieldIds.message}
            name="message"
            type="text"
            ref={messageRef}
            value={message}
            readOnly={pending}
            aria-disabled={pending || undefined}
            aria-invalid={messageFault === null ? undefined : true}
            aria-describedby={
              messageFault === null
                ? `${fieldIds.message}-hint`
                : `${fieldIds.message}-hint ${fieldIds.message}-error`
            }
            onChange={(event) => {
              setMessage(event.target.value)
            }}
          />
          {messageFault === null ? null : (
            <p
              className="field__error"
              id={`${fieldIds.message}-error`}
              role="alert"
            >
              {t(`save.problem.${messageFault}`)}
            </p>
          )}
        </div>
      ) : null}

      {/* `aria-disabled`, not `disabled` — see `routes/sign-in.tsx`. The
          double submit it guarded is refused by the handler above. */}
      <button type="submit" aria-disabled={pending}>
        {mode === 'version' ? t('save.submitVersion') : t('save.submitNew')}
      </button>
      {pending ? (
        <p className="save-form__pending" role="status">
          {t('save.saving')}
        </p>
      ) : null}
    </form>
  )
}

/**
 * The metadata fields that actually differ, or `null` when none do.
 *
 * `UpdateCircuitBody` refuses an empty object — "at least one field must be
 * present" — so sending an unchanged form would be a 400 on a save that had
 * nothing wrong with it. Skipping the request entirely is also the honest
 * thing: `PATCH` moves `updatedAt`, and a rename that renamed nothing should
 * not make a circuit look freshly touched in every listing.
 */
function changedDetails(
  next: { title: string; description: string | null; visibility: Visibility },
  current: {
    title: string
    description: string | null
    visibility: Visibility
  } | null
): UpdateCircuitRequest | null {
  if (current === null) return null
  const patch: {
    title?: string
    description?: string | null
    visibility?: Visibility
  } = {}
  if (next.title !== current.title) patch.title = next.title
  if (next.description !== current.description) {
    patch.description = next.description
  }
  if (next.visibility !== current.visibility) patch.visibility = next.visibility
  return Object.keys(patch).length === 0 ? null : patch
}
