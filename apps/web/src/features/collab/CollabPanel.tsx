/**
 * The shared session, as something a person can see — M5.6.
 *
 * ═══════════════════════════════════════════════════════════════════════
 * WHAT THIS FILE IS FOR, AND WHY IT IS THE WHOLE MILESTONE
 *
 * Fase 5 shipped a complete channel that nothing opened. The relay was real, the
 * transport was real, the roster and the caret layer were written and tested —
 * and no file outside `features/collab` and the verification suites imported any
 * of it, so no user action could reach a single frame of it. This is the piece
 * that was missing: one component that a page can mount, which turns a
 * `CollabSessionView` into the four things a reader is owed.
 *
 *   1. **Who is here** — `PresenceRoster`, which also carries the `role="status"`
 *      region that speaks arrivals, departures and edits. It is mounted whether
 *      or not anybody is here, and that is a requirement rather than tidiness: a
 *      live region inserted into the DOM *together with its first content* is
 *      frequently not announced at all. See that file's header.
 *   2. **Whether this session is writable** — `access: 'read'` is a watcher, and
 *      §3.4's decision 3 admits one on purpose ("un espectador invisible dejaría
 *      los cursores compartidos como una función que solo aprovecha quien ya es
 *      la única escritora"). The sentence is drawn, and the editor above it is
 *      put in read-only by the page.
 *   3. **Whether it is still connected** — reconnecting, and the four ways it can
 *      end. Each of them leaves a working editor, which is why none of them is an
 *      `alert`: nothing is broken, something is merely no longer shared.
 *   4. **What the document holds that the canvas does not** — `DeferredOperations`,
 *      the visible face of `project.ts`'s convergence decision.
 *
 * ═══════════════════════════════════════════════════════════════════════
 * WHY IT DRAWS NOTHING AT ALL FOR A SOLO EDITOR
 *
 * Because most sessions have one person in them, and the editor that shipped is
 * the common case. With `status: 'off'` — an unsaved circuit, a build with no
 * API, a deployment with collaboration switched off — every branch below is
 * false and the only element this renders is the empty live region, which is
 * `visually-hidden` and holds no text. `status: 'connecting'` is deliberately
 * silent too: a reader whose editor is working does not need to be told that a
 * feature they have not used yet is still handshaking.
 *
 * The presence store is the one thing built unconditionally, and it is eleven
 * lines of Map with no clock attached when nothing feeds it. That is the price of
 * having the live region exist before it has something to say, and it is the
 * right price.
 */

import { useMemo } from 'react'
import { useTranslation } from 'react-i18next'
import { useStore } from 'zustand'

import type { CircuitStore } from '../circuit-editor/useCircuitStore'
import { DeferredOperations } from './DeferredOperations'
import { PresenceRoster } from './PresenceRoster'
import { createPresenceStore } from './presence'
import type { CollabSessionView } from './useCollabSession'

export interface CollabPanelProps {
  readonly session: CollabSessionView
  /** The document on screen. Read for the wire count the roster describes. */
  readonly store: CircuitStore
}

export function CollabPanel({ session, store }: CollabPanelProps) {
  const { t } = useTranslation('collab')
  const qubits = useStore(store, (state) => state.circuit.qubits)

  /*
   * The session's store, or an inert one of this component's own.
   *
   * The fallback is what lets the live region exist before there is a session to
   * fill it — see the header — and it is memoised on the session's store so that
   * a render does not hand `useSyncExternalStore` a new object and loop.
   */
  const presence = useMemo(
    () => session.presence ?? createPresenceStore(),
    [session.presence]
  )

  return (
    <div className="collab-panel">
      {session.status === 'reconnecting' ? (
        <p className="notice collab-panel__notice" role="status">
          {t('session.reconnecting')}
        </p>
      ) : null}

      {session.ended === null ? null : (
        <p className="notice collab-panel__notice" role="status">
          {t(endedKeyOf(session.ended, session.error))}
        </p>
      )}

      {session.access === 'read' ? (
        <p className="notice collab-panel__notice" role="status">
          {t('session.readOnly')}
        </p>
      ) : null}

      {/*
       * The one divergence the transport cannot repair: an update, or a
       * reconnection delta, past `MAX_COLLAB_UPDATE_BYTES`. Reported because this
       * peer's document is then ahead of everybody else's and nothing else in the
       * system will ever notice — see `CollabSessionSnapshot.reconciled`.
       */}
      {session.reconciled ? null : (
        <p className="notice collab-panel__notice" role="status">
          {t('session.diverged')}
        </p>
      )}

      <DeferredOperations
        entries={session.deferredOperations}
        overflow={session.overflow}
        store={store}
        // A watcher may look at the list and select what is in the way; the
        // repair is an update, and the relay would refuse it.
        canEdit={session.access === 'write'}
      />

      <PresenceRoster store={presence} qubits={qubits} />
    </div>
  )
}

/**
 * Which sentence an ending gets.
 *
 * Three of the five are the relay's own `CollabEndReason`s and share a nested
 * key; the other two are this client's readings — a document it cannot project,
 * and a join it could not make — and neither of them is the relay saying
 * anything, so neither belongs under `ended`.
 *
 * ── WHY `unavailable` IS THREE SENTENCES AND NOT ONE ─────────────────────
 *
 * `collabSession.ts` says `error` «carries the relay's code, which `apps/web`
 * already translates», and the first version of this function never read it — so
 * four different refusals arrived as one sentence and a deployment with
 * collaboration switched off was indistinguishable from a circuit that does not
 * exist.
 *
 * Two of the four are worth telling apart, and §11 decides which. NOT_FOUND and
 * FORBIDDEN must stay indistinguishable — that is the whole point of conflating
 * "no such circuit" with "not yours to see" — and VALIDATION_FAILED is a version
 * skew, which is nothing a reader can act on. CIRCUIT_TOO_LARGE and
 * SIMULATION_UNAVAILABLE are different: one says this document cannot be shared,
 * the other says nothing here ever will be, and a reader waiting for a colleague
 * to appear deserves to know which.
 */
function endedKeyOf(
  ended: NonNullable<CollabSessionView['ended']>,
  error: CollabSessionView['error']
): string {
  if (ended === 'invalid') return 'session.invalid'
  if (ended === 'unavailable') {
    if (error === 'CIRCUIT_TOO_LARGE') return 'session.tooLarge'
    if (error === 'SIMULATION_UNAVAILABLE') return 'session.disabled'
    return 'session.unavailable'
  }
  return `session.ended.${ended}`
}
