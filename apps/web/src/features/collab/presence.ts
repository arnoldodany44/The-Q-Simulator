/**
 * Who else is here, as this tab holds it — M5.3.
 *
 * ═══════════════════════════════════════════════════════════════════════
 * WHY THIS IS NOT THE CIRCUIT STORE, AND NOT ZUSTAND EITHER
 *
 * The document store is the single judge of a legal edit, it has an undo history,
 * and every commit through it is a fact about the circuit. A cursor is none of
 * those things: it is not part of the document (§3.4 — a caret in the Y.Doc would
 * be merged, tombstoned, persisted and *validated*), it must not be undoable, and
 * it changes eight times a second while somebody drags. Putting it in the store
 * would put presence inside the undo stack and make every remote cursor movement a
 * store commit that every subscriber of the circuit re-reads.
 *
 * So it is its own tiny store, and it is hand-rolled rather than a second Zustand
 * one for two reasons that both come down to the same thing — this is the one
 * piece of state in the app that is *driven by a clock*:
 *
 *   - **Expiry is a function of time, not of an action.** A peer disappears
 *     because nothing arrived for `PRESENCE_TIMEOUT_MS`, and testing that needs an
 *     injected `now` at the boundary rather than a mocked global.
 *   - **`useSyncExternalStore` is the whole contract React needs.** `subscribe`
 *     and a referentially stable `snapshot` are eleven lines here, and they let the
 *     presence layer re-render without the grid re-rendering — which is the
 *     performance requirement of this milestone stated as an architecture.
 *
 * ── WHAT IS ANNOUNCED, AND WHAT IS DELIBERATELY NOT ──────────────────────
 *
 * A live region that spoke every cursor movement would be unusable: a peer moving
 * across a circuit is dozens of updates a second, and a screen reader would be
 * reading coordinates for the rest of the afternoon while the person listening
 * tried to do anything else at all.
 *
 * So this store distinguishes *events* from *state*. The state is the roster, read
 * on demand — a list a reader can walk with their own cursor whenever they want to
 * know who is here. The events are the three things worth interrupting somebody
 * for, and there are exactly three:
 *
 *   `joined`  a peer appeared. Somebody else is in the document now.
 *   `left`    a peer went, or timed out. Their caret is gone.
 *   `edited`  a peer *changed the circuit*. This is the one that matters, and it
 *             is why `edits` is in the frame at all: a CRDT update carries no
 *             author, so a peer counts its own committed gestures and a grown
 *             count is an edit. Cursor movement and selection changes produce no
 *             event, ever.
 *
 * Each event carries a sequence number, because that is what a `role="status"`
 * region can actually deliver: a node React replaces so the region sees a change
 * (the same trick the editor's own status line uses for two identical reports in
 * a row).
 *
 * ── THE TWO THINGS A SINGLE EVENT SLOT GOT WRONG ─────────────────────────
 *
 * The first version held exactly one event, and both defects came from that.
 *
 * **Simultaneous departures.** One dropped network takes two peers with it, so
 * one `expire` sweep removes both — and the second `announce` overwrote the
 * first, so a listener was told one caret went and left believing the other
 * person was still in the document. So the snapshot carries a *list* of what the
 * last change produced, and the region renders one node per event: two nodes
 * added in one commit are two sentences read, which is what a live region is for.
 *
 * **An edit burst.** A peer dragging one rotation slider commits dozens of times
 * a second, so `edits` grew on every throttled frame and the region re-read the
 * identical sentence about eight times a second for as long as the drag lasted —
 * eighty utterances of one sentence for a ten-second drag. A screen reader that
 * will not stop talking is a screen reader somebody switches off, and the 120 ms
 * send throttle bounds network traffic rather than speech. So an `edited`
 * announcement is capped at one per peer per `EDIT_ANNOUNCE_QUIET_MS`: a drag
 * becomes one sentence, and two deliberate edits a second apart stay two.
 * ═══════════════════════════════════════════════════════════════════════
 */

import { PRESENCE_TIMEOUT_MS } from '@qsim/contract'
import type {
  CollabAccess,
  PresenceCursor,
  PresenceState,
} from '@qsim/contract'

/** A peer as this tab holds it: what they said, and when they last said it. */
export interface PeerPresence {
  readonly peerId: string
  /** `null` for somebody who never signed in. The word for that is the UI's. */
  readonly name: string | null
  readonly access: CollabAccess
  readonly cursor: PresenceCursor | null
  readonly selection: readonly string[]
  readonly edits: number
  /** This tab's clock when the peer was last heard from. */
  readonly seenAt: number
}

export type PresenceEventKind = 'joined' | 'left' | 'edited'

/** Something worth telling a screen reader about. Never a cursor movement. */
export interface PresenceEvent {
  /**
   * Monotonic, and the reason it exists: two identical announcements in a row —
   * Ana edits twice in the same column — render the same sentence, and React
   * leaves the text node untouched. No mutation, no announcement. Keying a node
   * on this is what makes every event a change the live region can see.
   */
  readonly seq: number
  readonly kind: PresenceEventKind
  readonly peerId: string
  readonly name: string | null
  /** Where it happened, when the event was about a place. */
  readonly cursor: PresenceCursor | null
}

/**
 * How long after announcing that a peer edited before saying it again.
 *
 * A drag is dozens of commits a second; two seconds turns one gesture into one
 * sentence and still reports two deliberate edits a second apart separately. It
 * is not the network throttle (`PRESENCE_THROTTLE_MS`, 120 ms), and conflating
 * the two is what made the region chatter: one bounds bytes, this bounds speech.
 */
export const EDIT_ANNOUNCE_QUIET_MS = 2_000

export interface PresenceSnapshot {
  /** In the order the peers first appeared, so the list does not reshuffle. */
  readonly peers: readonly PeerPresence[]
  /**
   * Everything the last change produced, oldest first.
   *
   * A list and not one slot: a single `expire` sweep can remove two peers, and a
   * single slot silently dropped all but the last of them.
   */
  readonly events: readonly PresenceEvent[]
}

export interface PresenceStore {
  /**
   * A `collab:presence` frame's payload. `null` means the peer has gone.
   *
   * Takes the two fields rather than the frame so that nothing here has to know
   * about circuit ids: one store per session, and the transport is what decides
   * which session a frame belongs to.
   */
  readonly receive: (
    peerId: string,
    state: PresenceState | null,
    now: number
  ) => void
  /**
   * Drops every peer not heard from for `PRESENCE_TIMEOUT_MS`.
   *
   * Applied here as well as on the relay, and neither end depends on the other
   * having done it: the relay expires a ghost so that a joiner is not handed one,
   * and this expires a ghost whose *server* went away — a dropped Redis message, a
   * replica that died, a socket this tab lost without noticing.
   */
  readonly expire: (now: number) => void
  /**
   * Forgets everybody, silently.
   *
   * For leaving a session or losing the connection. No `left` events: the peers
   * did not go anywhere, this tab did, and announcing four departures to somebody
   * whose network dropped would be describing the wrong event entirely.
   */
  readonly clear: () => void
  readonly snapshot: () => PresenceSnapshot
  readonly subscribe: (listener: () => void) => () => void
}

const EMPTY: PresenceSnapshot = { peers: [], events: [] }

export function createPresenceStore(): PresenceStore {
  /* Insertion-ordered, and re-receiving a peer keeps its place — see `entries`. */
  const peers = new Map<string, PeerPresence>()
  const listeners = new Set<() => void>()
  let events: PresenceEvent[] = []
  /** What *this* change has produced so far; see `rebuild`. */
  let pending: PresenceEvent[] = []
  let seq = 0
  /** When each peer's edit was last *spoken* — see `EDIT_ANNOUNCE_QUIET_MS`. */
  const spokeEditAt = new Map<string, number>()
  /**
   * The last snapshot handed out.
   *
   * `useSyncExternalStore` calls `getSnapshot` on every render and compares by
   * identity: a fresh object each time is an infinite render loop. So the snapshot
   * is built when something changes and cached until the next change.
   */
  let cached: PresenceSnapshot = EMPTY

  /**
   * Publishes a change, replacing the announcements only when there are new ones.
   *
   * A change that produced no event leaves the previous sentences where they are:
   * a live region's content is not re-read because it stayed the same, and
   * removing it would announce nothing either. What must never happen is one
   * event overwriting another *of the same change* — two peers timing out in one
   * sweep — which is why this is a list.
   */
  function rebuild(): void {
    if (pending.length > 0) {
      events = pending
      pending = []
    }
    cached = { peers: [...peers.values()], events }
    for (const listener of listeners) listener()
  }

  function announce(
    kind: PresenceEventKind,
    peer: Pick<PeerPresence, 'peerId' | 'name' | 'cursor'>
  ): void {
    seq += 1
    pending.push({
      seq,
      kind,
      peerId: peer.peerId,
      name: peer.name,
      cursor: peer.cursor,
    })
  }

  return {
    receive(peerId, state, now) {
      const known = peers.get(peerId)

      if (state === null) {
        if (known === undefined) return
        peers.delete(peerId)
        spokeEditAt.delete(peerId)
        announce('left', known)
        rebuild()
        return
      }

      peers.set(peerId, {
        peerId,
        name: state.name,
        access: state.access,
        cursor: state.cursor,
        selection: state.selection,
        edits: state.edits,
        seenAt: now,
      })

      if (known === undefined) {
        // Deliberately *not* stamped as spoken: an edit made straight after
        // arriving is news, and only a second one inside the quiet period is not.
        announce('joined', { peerId, name: state.name, cursor: state.cursor })
      } else if (state.edits > known.edits) {
        /*
         * The one movement-adjacent event that is announced, and only because the
         * *count* grew: a peer that dragged its cursor across the canvas without
         * committing anything produces no sentence at all. A count that went
         * *down* is a peer that reconnected and started counting again, which is
         * not news.
         *
         * Capped, because a slider drag grows the count eight times a second and
         * every one of them rendered the same sentence again. The *state* still
         * updates on every frame — the roster and the carets are live — only the
         * speaking is rationed.
         */
        const spoke = spokeEditAt.get(peerId) ?? -Infinity
        if (now - spoke >= EDIT_ANNOUNCE_QUIET_MS) {
          spokeEditAt.set(peerId, now)
          announce('edited', { peerId, name: state.name, cursor: state.cursor })
        }
      }
      rebuild()
    },

    expire(now) {
      const gone = [...peers.values()].filter(
        (peer) => now - peer.seenAt >= PRESENCE_TIMEOUT_MS
      )
      if (gone.length === 0) return
      // Every departure, not just the last: one dropped network takes two peers
      // with it, and a listener told about one of them is a listener misinformed.
      for (const peer of gone) {
        peers.delete(peer.peerId)
        spokeEditAt.delete(peer.peerId)
        announce('left', peer)
      }
      rebuild()
    },

    clear() {
      if (peers.size === 0 && events.length === 0) return
      peers.clear()
      spokeEditAt.clear()
      events = []
      pending = []
      cached = EMPTY
      for (const listener of listeners) listener()
    },

    snapshot: () => cached,

    subscribe(listener) {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },
  }
}
