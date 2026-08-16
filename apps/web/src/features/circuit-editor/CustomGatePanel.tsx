/**
 * The blocks panel — §3.1, milestone M2.3.
 *
 * Five commands, and the fifth is the one this component exists to make safe:
 * package the selection, place a block, expand one back, duplicate a
 * definition, and edit a definition.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * THE DECISION THIS PANEL MAKES VISIBLE
 *
 * A definition is shared by reference inside its document. Editing it changes
 * every use, at once, and there is no way to change one of them — which is the
 * feature (that is what a block is *for*) and is data loss for anyone who
 * expected a copy. Deciding one meaning and hiding the other would be wrong
 * either way, so the editor decides both and shows the consequence:
 *
 *   - Every entry prints its use count in this circuit, always, not only when
 *     something is about to happen.
 *   - Opening a definition puts a persistent line at the top of the editor
 *     saying how many uses the pending change will alter. It is not a dialog
 *     that was dismissed on the way in — it is on screen for as long as the
 *     editing lasts, which is when the user is actually deciding.
 *   - "Duplicate" sits next to "Edit definition", because the answer to "I
 *     want to change this one use" is a different block, and an escape hatch
 *     nobody can find is not one.
 *
 * Sharing stops at the document. A definition installed from the library is
 * copied in, so nobody else's edit and nobody else's deletion can reach a
 * circuit already using it (`@qsim/db`'s `custom-gates.ts` carries that
 * argument in full).
 *
 * ─────────────────────────────────────────────────────────────────────────
 * WHY THE FEEDBACK LINE IS A LIVE REGION
 *
 * Every command here changes a diagram the reader may not be looking at, and
 * the store answers with a machine-readable `RejectionReason` rather than a
 * sentence (its rule 3). So a refusal is rendered through the `rejection`
 * catalog in all three languages, into a `role="status"`, keyed by a counter —
 * the same shape `PresetPicker` uses, and for the same reason: pressing a
 * refused button twice produces the same string, and React would leave the
 * text node untouched.
 *
 * AND SUCCESS IS NEWS TOO. The line used to be written only when a command was
 * refused, so every command that worked was silent — Package, Edit definition,
 * Apply to every use, Discard, and a Delete that succeeded. That is precisely
 * backwards for the sentence above: a refusal leaves the diagram alone, and a
 * success is the case where a reader who is not looking at the canvas has just
 * had it change underneath them.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * AND FOCUS HAS TO LAND SOMEWHERE
 *
 * Four of these commands re-render the panel into a different shape: opening a
 * definition replaces the whole list with the editor, applying and discarding
 * put it back, and deleting removes the row the button was in. The button that
 * was focused stops existing, and the browser's answer to that is
 * `document.body` — no focus ring for a keyboard reader, and the next Tab
 * starting from the top of the document.
 *
 * So every command that changes the shape says where focus goes: the
 * definition editor's first control when one opens, and the panel's own
 * heading when one closes or an entry disappears. The heading carries
 * `tabIndex={-1}` for exactly this and joins no tab order.
 */

import { customGateUsage, gateCount, type Circuit } from '@qsim/schema'
import { pluralCount } from '../analysis/format'
import { useEffect, useId, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useStore } from 'zustand'

import { MAX_SYMBOL_LENGTH, definitionsOf, signatureOf } from './customGates'
import type {
  CircuitStore,
  EditResult,
  RejectionReason,
} from './useCircuitStore'

export interface CustomGatePanelProps {
  readonly store: CircuitStore
  /** The wire a fresh placement starts on — the grid cursor's qubit. */
  readonly qubit?: number
}

interface Report {
  readonly reason: RejectionReason | null
  /** The sentence for a command that worked, already translated. */
  readonly done: string | null
  readonly seq: number
}

/** Where focus goes once the panel has re-rendered into its new shape. */
type FocusTarget = 'heading' | 'editor' | null

export function CustomGatePanel({ store, qubit = 0 }: CustomGatePanelProps) {
  const { t, i18n } = useTranslation('editor')
  /**
   * A count, formatted for the reader's locale, with the plural still selected
   * by a plain number.
   *
   * `{{count}}` is stringified with `String()`, so a block with fifteen hundred
   * gates in it printed "1500 gates" beside an import status that had just said
   * "1,500 gates" — the same figure written two ways on one screen in one
   * language. `pluralCount` clamps the selector, exactly as `format.ts`
   * prescribes and as `ImportPanel` already does.
   */
  const counted = (key: string, value: number): string =>
    t(key, {
      count: pluralCount(value),
      value: new Intl.NumberFormat(i18n.language).format(value),
    })
  const headingId = useId()
  const nameId = useId()
  const symbolId = useId()

  const circuit = useStore(store, (state) => state.circuit)
  const selection = useStore(store, (state) => state.selection)
  const editing = useStore(store, (state) => state.definitionEdit)

  const [name, setName] = useState('')
  const [symbol, setSymbol] = useState('')
  const [report, setReport] = useState<Report>({
    reason: null,
    done: null,
    seq: 0,
  })
  const heading = useRef<HTMLHeadingElement>(null)
  const firstControl = useRef<HTMLInputElement>(null)
  /**
   * Where the last command asked focus to go, until the next render puts it
   * there.
   *
   * A ref and not state: this is a message to the DOM rather than something
   * rendered, and holding it in state would mean a second render to clear it —
   * a cascading render the linter is right to refuse.
   */
  const pendingFocus = useRef<FocusTarget>(null)

  /*
   * After the render that changed the shape, never during the handler that
   * asked for it: the element focus is meant to land on may not exist yet.
   */
  useEffect(() => {
    const target = pendingFocus.current
    if (target === null) return
    pendingFocus.current = null
    const node = target === 'editor' ? firstControl.current : heading.current
    node?.focus()
  })

  /**
   * Says what happened, and moves focus when the panel changed shape.
   *
   * `done` is the sentence for the success case and is required of every
   * command: see the header. `focus` is omitted by the commands that leave the
   * button they were pressed from on screen.
   */
  const announce = (
    result: EditResult,
    done: string,
    focus: FocusTarget = null
  ): void => {
    setReport((current) => ({
      reason: result.ok ? null : result.reason,
      done: result.ok ? done : null,
      seq: current.seq + 1,
    }))
    if (result.ok && focus !== null) pendingFocus.current = focus
  }

  if (editing !== null) {
    return (
      <section className="custom-gates" aria-labelledby={headingId}>
        <h3
          id={headingId}
          className="custom-gates__heading"
          ref={heading}
          tabIndex={-1}
        >
          {t('customGates.editing.heading', { name: editing.name })}
        </h3>
        {/*
         * The sentence stays on screen for the whole session. It is the
         * consent this feature needs and a dialog is not: by the time someone
         * has drawn three gates they have forgotten what they clicked through.
         */}
        <p className="custom-gates__warning">
          <strong>{t('customGates.shared.heading')}</strong>{' '}
          {editing.uses === 0
            ? t('customGates.shared.unused')
            : counted('customGates.shared.body', editing.uses)}{' '}
          {t('customGates.shared.escape')}
        </p>
        <p className="custom-gates__hint">{t('customGates.editing.note')}</p>

        <label className="custom-gates__field" htmlFor={symbolId}>
          {t('customGates.editing.symbol')}
        </label>
        <input
          id={symbolId}
          className="custom-gates__input"
          ref={firstControl}
          value={editing.symbol ?? ''}
          maxLength={MAX_SYMBOL_LENGTH}
          onChange={(event) => {
            store.getState().setDefinitionSymbol(event.target.value)
          }}
        />

        <div className="custom-gates__actions">
          <button
            type="button"
            className="custom-gates__action"
            onClick={() => {
              announce(
                store.getState().applyDefinition(),
                t('customGates.done.applied', { name: editing.name }),
                'heading'
              )
            }}
          >
            {t('customGates.editing.apply')}
          </button>
          <button
            type="button"
            className="custom-gates__action"
            onClick={() => {
              announce(
                store.getState().cancelDefinition(),
                t('customGates.done.discarded', { name: editing.name }),
                'heading'
              )
            }}
          >
            {t('customGates.editing.cancel')}
          </button>
        </div>

        <Feedback report={report} />
      </section>
    )
  }

  const definitions = definitionsOf(circuit)

  return (
    <section className="custom-gates" aria-labelledby={headingId}>
      <h3
        id={headingId}
        className="custom-gates__heading"
        ref={heading}
        tabIndex={-1}
      >
        {t('customGates.title')}
      </h3>
      <p className="custom-gates__hint">{t('customGates.summary')}</p>

      <form
        className="custom-gates__package"
        onSubmit={(event) => {
          event.preventDefault()
          const packaged = name.trim()
          const result = store
            .getState()
            .packageSelection(packaged, { symbol: symbol.trim() })
          // No focus move: the form's own button survives, and taking focus off
          // it would interrupt somebody packaging several fragments in a row.
          announce(result, t('customGates.done.packaged', { name: packaged }))
          if (result.ok) {
            setName('')
            setSymbol('')
          }
        }}
      >
        <h4 className="custom-gates__subheading">
          {t('customGates.package.heading')}
        </h4>
        <label className="custom-gates__field" htmlFor={nameId}>
          {t('customGates.package.name')}
        </label>
        <input
          id={nameId}
          className="custom-gates__input"
          value={name}
          placeholder={t('customGates.package.namePlaceholder')}
          onChange={(event) => {
            setName(event.target.value)
          }}
        />
        <label className="custom-gates__field" htmlFor={symbolId}>
          {t('customGates.package.symbol')}
        </label>
        <input
          id={symbolId}
          className="custom-gates__input"
          value={symbol}
          maxLength={MAX_SYMBOL_LENGTH}
          placeholder={t('customGates.package.symbolPlaceholder')}
          onChange={(event) => {
            setSymbol(event.target.value)
          }}
        />
        <p className="custom-gates__hint">{t('customGates.package.hint')}</p>
        <button
          type="submit"
          className="custom-gates__action"
          disabled={selection.length === 0 || name.trim().length === 0}
        >
          {t('customGates.package.submit')}
        </button>
      </form>

      {definitions.length === 0 ? (
        <p className="custom-gates__empty">{t('customGates.empty')}</p>
      ) : (
        <ul className="custom-gates__list">
          {definitions.map(([gateName, definition]) => {
            const usage = customGateUsage(circuit, gateName)
            return (
              <li key={gateName} className="custom-gates__entry">
                <span className="custom-gates__name">
                  {signatureOf(gateName, definition)}
                </span>
                <span className="custom-gates__meta">
                  {counted('customGates.entry.qubits', definition.qubits)}
                  {' · '}
                  {counted(
                    'customGates.entry.gates',
                    bodyGateCount(definition.qubits, definition)
                  )}
                  {' · '}
                  {usage.total === 0
                    ? t('customGates.entry.unused')
                    : counted('customGates.entry.uses', usage.total)}
                </span>
                <span className="custom-gates__actions">
                  <button
                    type="button"
                    className="custom-gates__action"
                    onClick={() => {
                      announce(
                        store.getState().placeCustomGate(gateName, qubit),
                        t('customGates.done.placed', { name: gateName })
                      )
                    }}
                  >
                    {t('customGates.actions.place')}
                  </button>
                  <button
                    type="button"
                    className="custom-gates__action"
                    onClick={() => {
                      announce(
                        store.getState().openDefinition(gateName),
                        t('customGates.done.opened', { name: gateName }),
                        // A substantial context change: the canvas stops
                        // showing the circuit and starts showing the body.
                        'editor'
                      )
                    }}
                  >
                    {t('customGates.actions.edit')}
                  </button>
                  <button
                    type="button"
                    className="custom-gates__action"
                    onClick={() => {
                      {
                        const into = freeName(circuit, gateName)
                        announce(
                          store.getState().duplicateCustomGate(gateName, into),
                          t('customGates.done.duplicated', {
                            name: gateName,
                            into,
                          })
                        )
                      }
                    }}
                  >
                    {t('customGates.actions.duplicate')}
                  </button>
                  <button
                    type="button"
                    className="custom-gates__action"
                    disabled={usage.operationIds.length === 0}
                    onClick={() => {
                      const first = usage.operationIds[0]
                      if (first === undefined) return
                      announce(
                        store.getState().inlineOperation(first),
                        t('customGates.done.inlined', { name: gateName })
                      )
                    }}
                  >
                    {t('customGates.actions.inline')}
                  </button>
                  <button
                    type="button"
                    className="custom-gates__action"
                    onClick={() => {
                      announce(
                        store.getState().removeCustomGate(gateName),
                        t('customGates.done.removed', { name: gateName }),
                        // The row this button lives in is about to go.
                        'heading'
                      )
                    }}
                  >
                    {t('customGates.actions.remove')}
                  </button>
                </span>
              </li>
            )
          })}
        </ul>
      )}

      <Feedback report={report} />
    </section>
  )
}

function Feedback({ report }: { readonly report: Report }) {
  const { t } = useTranslation('editor')
  return (
    <p className="custom-gates__status" role="status">
      <span key={report.seq}>
        {report.reason === null ? report.done : t(`rejection.${report.reason}`)}
      </span>
    </p>
  )
}

/**
 * How many gates a definition's body runs, through the contract's own counter
 * so the figure beside a block is the figure a leaderboard would use.
 */
function bodyGateCount(
  qubits: number,
  definition: { readonly operations: Circuit['operations'] }
): number {
  return gateCount({
    schemaVersion: 1,
    qubits,
    clbits: 0,
    operations: definition.operations,
  })
}

/**
 * `name2`, `name3`, … — the first spelling this document has not taken.
 *
 * Generated rather than prompted because the point of "duplicate" is to be one
 * press away from "edit": a dialog between the two makes branching feel like
 * the expensive option, and it is the safe one.
 */
function freeName(circuit: Circuit, base: string): string {
  const taken = circuit.customGates ?? {}
  let index = 2
  while (Object.hasOwn(taken, `${base}${String(index)}`)) index += 1
  return `${base}${String(index)}`
}
