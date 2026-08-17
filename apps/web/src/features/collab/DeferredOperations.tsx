/**
 * What the document holds and the canvas does not — M5.6.
 *
 * ═══════════════════════════════════════════════════════════════════════
 * WITHOUT THIS PANEL, THE CONVERGENCE DECISION IS INVISIBLE
 *
 * `project.ts` decides the hardest question in the phase: a merged document can
 * hold two operations that both want (q0, c3), nobody may repair the bytes, so
 * every peer places what fits in one deterministic order and **defers the rest**.
 * The document keeps them, both peers compute the same partition, and the circuit
 * stays valid — which is what lets the canvas, the simulator and the exporters go
 * on assuming what they have always assumed.
 *
 * The cost of that decision is one sentence, and it is the reason this file
 * exists: **a gate you placed can arrive on the other peer's screen as a deferred
 * gate rather than as a gate.** `project.ts` says out loud that it "has to be
 * surfaced — an editor that quietly holds two of your gates back is worse than
 * one that shows a conflict". Everything up to now surfaced it as a *number* on a
 * session snapshot that nothing rendered, which is the quiet version with
 * telemetry attached.
 *
 * ═══════════════════════════════════════════════════════════════════════
 * THREE THINGS IT SAYS, IN THIS ORDER
 *
 *   1. **Nothing was lost.** The first thing a person reading "2 gates are held
 *      back" needs to know is whether their work is gone. It is not: the
 *      operations are in the document, every peer agrees, and the panel says so
 *      before it says anything else.
 *   2. **Which ones, and why.** The gate as notation, the cell it wanted, and the
 *      reason in words — the five `DeferralReason`s are five different situations
 *      and only two of them are a contested cell.
 *   3. **What to do.** `deferredResolution.ts` argues why every repair is an
 *      ordinary edit through the store. Two buttons: show what is in the way
 *      (which selects it on the canvas, exactly as a comment's "show this gate"
 *      does), and make room for it. A reader with no write access gets the first
 *      and not the second — and that is a drawing decision, never a permission:
 *      §11 puts authorisation on the relay, which refuses the update.
 *
 * ═══════════════════════════════════════════════════════════════════════
 * WHY THE LIVE REGION CARRIES THE COUNT AND NOT THE LIST
 *
 * A person whose gate was held back has to be *told*, not left to notice a panel.
 * But the deferral list is recomputed on every update the session delivers, so a
 * region carrying the list would speak on every keystroke of every peer — the
 * chatter `presence.ts` went to some trouble to avoid.
 *
 * The count is the field that does not chatter. It changes when the situation
 * changes and not when somebody types, and two identical sentences in a row are
 * not re-announced by any assistive technology, which here is the correct
 * behaviour rather than a limitation: "2 operations are held back" is not news
 * twice. The outcome of a button press takes the region over when there is one,
 * keyed on a counter for the reason the editor's own status line is — React
 * leaves an unchanged text node alone, and an unchanged region says nothing.
 *
 * ═══════════════════════════════════════════════════════════════════════
 * THE REGION IS MOUNTED BEFORE IT HAS ANYTHING TO SAY, AND THAT IS THE POINT
 *
 * The first version returned `null` while nothing was held back, so the section,
 * the region and its first sentence all entered the DOM in one commit — and a
 * live region inserted *together with its first content* is frequently not
 * announced at all: the assistive technology has nothing to compare against. So
 * the one sentence a reader most needs, "your gate was held back", was the one
 * sentence never spoken. `PresenceRoster` documents the same rule and follows it;
 * this now does too. What is conditional is the chrome, never the region.
 *
 * ═══════════════════════════════════════════════════════════════════════
 * WHERE FOCUS GOES WHEN THE ROW A BUTTON WAS IN DISAPPEARS
 *
 * A successful repair empties the list — that is what success means — so the
 * `<li>` holding the button that was just pressed is gone in the same commit that
 * announces the success, and focus with it. `document.body` is a dozen document
 * controls above where a keyboard reader was, and `CommentThreadView` already
 * states the rule this project follows: "a disabled button cannot hold focus, so
 * the keyboard user who just pressed it is returned to the document body".
 *
 * A button cannot be kept alive here — the list is derived from the document, not
 * from this component — so focus is moved deliberately instead, to the panel
 * itself. It is a labelled group with `tabIndex={-1}`, so landing on it names
 * where the reader is, and the region inside it is what says what happened.
 */

import type { DeferredOperation } from '@qsim/collab'
import { useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useStore } from 'zustand'

import { Notation } from '../../components/Notation'
import { gateSymbol } from '../circuit-editor/operationRoles'
import type { CircuitStore } from '../circuit-editor/useCircuitStore'
import { applyRepair, repairFor, revealBlockers } from './deferredResolution'

/**
 * How many are listed before the panel starts counting instead.
 *
 * A deferral list is bounded by `MAX_DOCUMENT_OPERATIONS` (8192), so it is not a
 * short list by construction — and a hostile document is exactly the one that
 * makes it long. Five rows is more than any real merge produces (§6's conflict is
 * two people reaching for one cell) and the rest is a number, which is the same
 * trade `overflow` itself makes.
 */
export const MAX_LISTED_DEFERRALS = 5

export interface DeferredOperationsProps {
  readonly entries: readonly DeferredOperation[]
  /** Slots past `MAX_DOCUMENT_OPERATIONS`, which are never read. */
  readonly overflow: number
  readonly store: CircuitStore
  /**
   * Whether to offer the repair. A drawing decision only: the relay refuses a
   * `collab:update` from a read-only peer, and may start refusing at any moment.
   */
  readonly canEdit: boolean
}

interface Outcome {
  readonly seq: number
  readonly key: string
  readonly values?: Record<string, unknown>
}

export function DeferredOperations({
  entries,
  overflow,
  store,
  canEdit,
}: DeferredOperationsProps) {
  const { t, i18n } = useTranslation('collab')
  const circuit = useStore(store, (state) => state.circuit)
  const [outcome, setOutcome] = useState<Outcome | null>(null)
  const panel = useRef<HTMLDivElement>(null)

  /*
   * §10: figures reach the reader through `Intl.NumberFormat`, and this panel's do
   * not fit in three digits — a column is legal to 4095, a deferral list is
   * bounded by `MAX_DOCUMENT_OPERATIONS` (8192) and `overflow` counts slots past
   * that. `count` stays a number because it is what selects the plural form; the
   * figure the sentence *shows* is `formatted`. The timeline beside this panel
   * already reads «1 234» in French, and «1234» here would be one number spelled
   * two ways on one screen.
   */
  const numbers = useMemo(
    () => new Intl.NumberFormat(i18n.language),
    [i18n.language]
  )

  /*
   * Nothing held back and nothing past the ceiling — the ordinary case, including
   * every session that never conflicts. The *chrome* goes; the live region below
   * stays, because a region that arrives with its first sentence is a region that
   * is never read. See the header.
   */
  const quiet = entries.length === 0 && overflow === 0

  const listed = entries.slice(0, MAX_LISTED_DEFERRALS)
  const hidden = entries.length - listed.length

  const say = (key: string, values?: Record<string, unknown>): void => {
    setOutcome((previous) => ({
      seq: (previous?.seq ?? 0) + 1,
      key,
      ...(values === undefined ? {} : { values }),
    }))
  }

  /**
   * What the live region holds: nothing at all until there is news, then the
   * outcome of a press if there was one, otherwise the count.
   */
  const said =
    outcome !== null
      ? t(outcome.key, outcome.values)
      : entries.length > 0
        ? t('deferred.heading', {
            count: entries.length,
            formatted: numbers.format(entries.length),
          })
        : overflow > 0
          ? t('deferred.overflow', {
              count: overflow,
              formatted: numbers.format(overflow),
            })
          : ''

  return (
    <div
      className={
        quiet ? 'deferred-panel deferred-panel--quiet' : 'deferred-panel'
      }
      /*
       * A labelled group rather than a `section`: it has to be focusable so a
       * repair that removes the pressed button has somewhere deliberate to send
       * focus, and `role="group"` names it without adding a landmark to every
       * editor page that never conflicts.
       */
      role="group"
      aria-label={t('deferred.label')}
      tabIndex={-1}
      ref={panel}
    >
      {entries.length === 0 ? null : (
        <>
          <p className="deferred-panel__heading">
            {t('deferred.heading', {
              count: entries.length,
              formatted: numbers.format(entries.length),
            })}
          </p>
          <p className="deferred-panel__hint">{t('deferred.hint')}</p>
          <ul className="deferred-panel__list">
            {listed.map((entry) => {
              const repair = repairFor(entry, circuit)
              const operation = entry.operation
              return (
                <li key={entry.slot} className="deferred-panel__entry">
                  <span className="deferred-panel__what">
                    {operation === undefined ? (
                      t('deferred.unreadable')
                    ) : (
                      <>
                        {/*
                         * D2: a gate symbol means the same thing in all three
                         * languages and never enters the catalog. Same rule the
                         * editor's own status line follows.
                         */}
                        <Notation value={gateSymbol(operation.gate, circuit)} />{' '}
                        {t('deferred.wanted', {
                          qubit: numbers.format(operation.targets[0] ?? 0),
                          column: numbers.format(operation.column),
                        })}
                      </>
                    )}
                  </span>
                  <span className="deferred-panel__why">
                    {t(`deferred.reason.${entry.reason}`)}
                  </span>
                  <span className="deferred-panel__actions">
                    {entry.blockedBy.length === 0 ? null : (
                      <button
                        type="button"
                        onClick={() => {
                          if (revealBlockers(store, entry)) {
                            say('deferred.announce.revealed', {
                              count: entry.blockedBy.length,
                            })
                            return
                          }
                          say('deferred.announce.gone')
                        }}
                      >
                        {t('deferred.reveal')}
                      </button>
                    )}
                    {!canEdit || repair.kind === 'none' ? null : (
                      <button
                        type="button"
                        onClick={() => {
                          if (!applyRepair(store, repair)) {
                            say('deferred.announce.refused')
                            return
                          }
                          say(
                            repair.kind === 'room'
                              ? 'deferred.announce.madeRoom'
                              : 'deferred.announce.widened'
                          )
                          /*
                           * A repair that worked removes this row, and this
                           * button with it. Focus is moved before that commit
                           * paints so the keyboard reader stays in the panel
                           * instead of being returned to `document.body` — see
                           * the header.
                           */
                          panel.current?.focus()
                        }}
                      >
                        {t(
                          repair.kind === 'room'
                            ? 'deferred.makeRoom'
                            : 'deferred.widen'
                        )}
                      </button>
                    )}
                    {repair.kind === 'none' && entry.blockedBy.length === 0 ? (
                      <span className="deferred-panel__stuck">
                        {t('deferred.unresolvable')}
                      </span>
                    ) : null}
                  </span>
                </li>
              )
            })}
          </ul>
          {hidden > 0 ? (
            <p className="deferred-panel__more">
              {t('deferred.more', {
                count: hidden,
                formatted: numbers.format(hidden),
              })}
            </p>
          ) : null}
        </>
      )}

      {overflow > 0 ? (
        <p className="deferred-panel__overflow">
          {t('deferred.overflow', {
            count: overflow,
            formatted: numbers.format(overflow),
          })}
        </p>
      ) : null}

      {/*
       * One region, mounted from the first render and empty until there is news —
       * see the header on why it cannot arrive with its first sentence. The
       * outcome of a press wins over the count because it is the newer fact and
       * the one the reader asked for.
       */}
      <p className="deferred-panel__status visually-hidden" role="status">
        <span key={outcome?.seq ?? 0}>{said}</span>
      </p>
    </div>
  )
}
