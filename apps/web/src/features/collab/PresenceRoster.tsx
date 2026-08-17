/**
 * Who is here, in words — M5.3, and the accessible half of the presence pair.
 *
 * ═══════════════════════════════════════════════════════════════════════
 * HOW "ANA IS EDITING COLUMN 4" REACHES SOMEBODY WHO CANNOT SEE IT
 *
 * The canvas is `aria-hidden` and paired with a described ARIA grid; the presence
 * layer over it is `aria-hidden` for exactly the same reason (a caret is pixels).
 * That leaves the whole of presence unreachable to a screen reader unless something
 * says it out loud, and the obvious answer — a live region carrying the cursors —
 * is unusable: a peer crossing a twenty-column circuit is dozens of updates a
 * second, and the region would read coordinates over everything else the listener
 * was trying to do. A screen reader that will not stop talking is a screen reader
 * somebody switches off.
 *
 * So presence reaches them through **two** surfaces with different politeness, and
 * the split is the whole design:
 *
 *   1. **A list, read on demand.** Every peer as a `<li>`: their name, whether they
 *      are editing or watching, and where they are. Nothing about it interrupts —
 *      a reader arrives here with their own cursor when they want to know who is
 *      in the document, exactly as a sighted person glances at the avatars.
 *
 *   2. **A `role="status"` region, for the three things worth interrupting for.**
 *      Arrivals, departures and edits. Not motion, not selection, not a heartbeat.
 *      `presence.ts` is where that filter lives, and it is one comparison: the
 *      peer's own count of committed gestures grew.
 *
 * The region is mounted whether or not anybody is here, and that is not tidiness:
 * a live region inserted into the DOM *together with its first content* is
 * frequently not announced at all — the assistive technology has nothing to compare
 * against. So it exists from the first render, empty, and only its children change.
 * Each child is keyed on its event's sequence number for the reason the editor's
 * own status line is: two identical sentences in a row (Ana edits twice in the same
 * cell) would leave the text node untouched, and an unchanged region says nothing.
 *
 * *Children*, plural, and that is the fix for the case one node could not carry: a
 * single `expire` sweep can remove two peers at once — one dropped network — and a
 * region with one slot announced only the last of them, leaving a listener sure
 * that somebody who had gone was still there.
 * ═══════════════════════════════════════════════════════════════════════
 */

import { useSyncExternalStore } from 'react'
import { useTranslation } from 'react-i18next'

import { collaboratorHue } from '../../lib/collab-colour'
import type { PeerPresence, PresenceEvent } from './presence'
import type { PresenceStore } from './presence'

export interface PresenceRosterProps {
  readonly store: PresenceStore
  /**
   * How many qubit wires the circuit has, so the classical register can be named
   * rather than reported as one more qubit.
   *
   * A number rather than the circuit: this component describes *people*, and the
   * only thing it needs to know about the document is where the wires stop.
   */
  readonly qubits: number
}

export function PresenceRoster({ store, qubits }: PresenceRosterProps) {
  const { t } = useTranslation('collab')
  const snapshot = useSyncExternalStore(store.subscribe, store.snapshot)
  const { peers, events } = snapshot

  return (
    <>
      {peers.length === 0 ? null : (
        <div className="presence-roster">
          <p className="presence-roster__heading">
            {t('presence.heading', { count: peers.length })}
          </p>
          <ul className="presence-roster__list">
            {peers.map((peer) => (
              <li
                key={peer.peerId}
                className={
                  peer.access === 'read'
                    ? 'presence-roster__peer presence-roster__peer--reader'
                    : 'presence-roster__peer'
                }
                style={{
                  ['--collab-hue' as string]: String(
                    collaboratorHue(peer.peerId)
                  ),
                }}
              >
                {/*
                 * The tie between a name here and a caret on the canvas. It is
                 * `aria-hidden` because a colour is not a fact a screen reader can
                 * use, and the two things it distinguishes — editing from watching
                 * — are said in words on the same line.
                 */}
                <span className="presence-roster__swatch" aria-hidden="true" />
                <span>{peer.name ?? t('presence.anonymous')}</span>
                <span className="presence-roster__where">
                  {describe(peer, qubits, t)}
                </span>
              </li>
            ))}
          </ul>
        </div>
      )}

      {/*
       * Always mounted, always empty until there is news. See the header for why
       * the region cannot arrive at the same moment as its first sentence.
       */}
      <p className="visually-hidden" role="status">
        {events.map((event) => (
          <span key={event.seq}>{announce(event, qubits, t)}</span>
        ))}
      </p>
    </>
  )
}

type Translate = (key: string, values?: Record<string, unknown>) => string

/**
 * One peer, as a sentence: what they are doing and where.
 *
 * "Editing" and "watching" are the words `access` becomes, and they carry the
 * distinction the swatch also draws — a disc against a ring — because colour and
 * shape are both unavailable to a listener. The place is a qubit and a column,
 * except on the classical register, which is a row of the grid and not a qubit
 * (`geometry.ts`): reporting it as "qubit 3" on a three-wire circuit would name a
 * wire that does not exist.
 */
function describe(peer: PeerPresence, qubits: number, t: Translate): string {
  const doing = t(
    peer.access === 'read' ? 'presence.watching' : 'presence.editing'
  )
  const held =
    peer.selection.length === 0
      ? null
      : t('presence.holding', { count: peer.selection.length })
  const where = place(peer, qubits, t)
  return [doing, where, held].filter((part) => part !== null).join(' · ')
}

function place(peer: PeerPresence, qubits: number, t: Translate): string {
  const cursor = peer.cursor
  if (cursor === null) return t('presence.nowhere')
  return cursor.qubit >= qubits
    ? t('presence.atRegister', { column: cursor.column })
    : t('presence.atCell', { qubit: cursor.qubit, column: cursor.column })
}

/**
 * The one sentence the live region says, or nothing.
 *
 * An edit is reported *with its place* when the peer had a cursor, because that is
 * the sentence a listener can act on — "somebody changed something somewhere" is an
 * interruption that costs attention and returns nothing.
 */
function announce(event: PresenceEvent, qubits: number, t: Translate): string {
  const name = event.name ?? t('presence.anonymous')
  if (event.kind === 'joined') return t('presence.announce.joined', { name })
  if (event.kind === 'left') return t('presence.announce.left', { name })
  const cursor = event.cursor
  if (cursor === null) return t('presence.announce.edited', { name })
  return cursor.qubit >= qubits
    ? t('presence.announce.editedRegister', { name, column: cursor.column })
    : t('presence.announce.editedCell', {
        name,
        qubit: cursor.qubit,
        column: cursor.column,
      })
}
