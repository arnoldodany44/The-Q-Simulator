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
 * That fixed the sweep and not the general case, because the general case is not
 * one change. The relay's *graceful* departure path is two separate
 * `collab:presence` frames with `state: null`, each arriving in its own
 * macrotask — measured 1 ms and 17 ms apart with two contexts closed together —
 * and a list rebuilt from scratch per change still held one sentence at a time. A
 * `role="status"` region is `aria-atomic` by default, so two mutations inside one
 * screen-reader turn are announced *once*, with the final content: one of the two
 * departures was lost. So events are **retained** for
 * `ANNOUNCE_RETENTION_MS` rather than replaced — long enough that anything
 * arriving in the same turn is read together, short enough that the region does
 * not accumulate a transcript.
 *
 * **An edit burst.** A peer dragging one rotation slider commits dozens of times
 * a second, so `edits` grew on every throttled frame and the region re-read the
 * identical sentence about eight times a second for as long as the drag lasted —
 * eighty utterances of one sentence for a ten-second drag. A screen reader that
 * will not stop talking is a screen reader somebody switches off, and the 120 ms
 * send throttle bounds network traffic rather than speech.
 *
 * The first answer was a two-second cap per peer, and it was wrong in both
 * directions at once: a nine-second drag still produced three or four
 * repetitions, while eight *deliberate* edits over six seconds produced two
 * announcements and six silences. A cap is a rate, and a rate cannot tell one
 * gesture from eight decisions.
 *
 * What can is the *gap*. A gesture arrives as a continuous stream of increments —
 * one per throttled frame, at most `PRESENCE_THROTTLE_MS` apart — and separate
 * edits arrive with a person's pause between them. So an `edited` announcement is
 * made when the count grows after a gap of at least `EDIT_BURST_MS`, and
 * suppressed while the growth is a continuation of the stream: a drag of any
 * length becomes exactly one sentence, and two deliberate edits a second apart
 * stay two. The sender helps rather than being relied on — `collabSession.ts`
 * counts one edit per store gesture — and this rule holds even for a peer whose
 * client does not.
 * ═══════════════════════════════════════════════════════════════════════
 */

import { PRESENCE_THROTTLE_MS, PRESENCE_TIMEOUT_MS } from '@qsim/contract'
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
  /** This tab's clock when it happened — see `ANNOUNCE_RETENTION_MS`. */
  readonly at: number
}

/**
 * How long a gap in a peer's edit count separates two edits from one gesture.
 *
 * A gesture reaches this store as a stream of increments at most
 * `PRESENCE_THROTTLE_MS` (120 ms) apart, because that is the rate the channel
 * sends at; a person deciding to place another gate takes longer than that. Twice
 * the throttle leaves room for a dropped frame or a slow tab without letting a
 * continuous drag look like a decision.
 *
 * It is not a cap on speech and that distinction is the whole point: a cap
 * silences deliberate edits and still repeats a long drag, which is what a
 * two-second cap was measured doing in both directions.
 */
export const EDIT_BURST_MS = PRESENCE_THROTTLE_MS * 2

/**
 * How long an announcement stays in the region before a later one replaces it.
 *
 * A `role="status"` region is atomic: two mutations inside one screen-reader turn
 * are read once, with whatever the region holds at the end. So sentences produced
 * close together have to be in the region *together* — two peers whose tabs
 * closed at the same moment arrive 1 to 17 ms apart, in separate macrotasks — and
 * a second is comfortably longer than that and far shorter than a transcript.
 */
export const ANNOUNCE_RETENTION_MS = 1_000

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
  /** When each peer's edit count last *grew* — see `EDIT_BURST_MS`. */
  const grewEditsAt = new Map<string, number>()
  /**
   * The last snapshot handed out.
   *
   * `useSyncExternalStore` calls `getSnapshot` on every render and compares by
   * identity: a fresh object each time is an infinite render loop. So the snapshot
   * is built when something changes and cached until the next change.
   */
  let cached: PresenceSnapshot = EMPTY

  /**
   * Publishes a change, keeping recent announcements alongside any new ones.
   *
   * A change that produced no event leaves the previous sentences where they are
   * until they age out: a live region's content is not re-read because it stayed
   * the same, and removing it announces nothing either.
   *
   * What must never happen is one sentence replacing another the listener has not
   * heard yet, and there are two ways for that to arise — two peers timing out in
   * one sweep, and two peers whose graceful departures arrive in consecutive
   * macrotasks. A list answers the first; retaining the list for
   * `ANNOUNCE_RETENTION_MS` answers the second. See the header.
   */
  function rebuild(now: number): void {
    if (pending.length > 0) {
      events = [
        ...events.filter((event) => now - event.at < ANNOUNCE_RETENTION_MS),
        ...pending,
      ]
      pending = []
    } else {
      const kept = events.filter(
        (event) => now - event.at < ANNOUNCE_RETENTION_MS
      )
      if (kept.length !== events.length) events = kept
    }
    cached = { peers: [...peers.values()], events }
    for (const listener of listeners) listener()
  }

  function announce(
    kind: PresenceEventKind,
    peer: Pick<PeerPresence, 'peerId' | 'name' | 'cursor'>,
    now: number
  ): void {
    seq += 1
    pending.push({
      seq,
      kind,
      peerId: peer.peerId,
      name: peer.name,
      cursor: peer.cursor,
      at: now,
    })
  }

  return {
    receive(peerId, state, now) {
      const known = peers.get(peerId)

      if (state === null) {
        if (known === undefined) return
        peers.delete(peerId)
        grewEditsAt.delete(peerId)
        announce('left', known, now)
        rebuild(now)
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
        /*
         * Deliberately *not* stamped in `grewEditsAt`: an edit made straight after
         * arriving is a decision rather than the continuation of a gesture this
         * tab was never watching, and it is news.
         */
        announce(
          'joined',
          { peerId, name: state.name, cursor: state.cursor },
          now
        )
      } else if (state.edits > known.edits) {
        /*
         * The one movement-adjacent event that is announced, and only because the
         * *count* grew: a peer that dragged its cursor across the canvas without
         * committing anything produces no sentence at all. A count that went
         * *down* is a peer that reconnected and started counting again, which is
         * not news.
         *
         * Spoken when the growth follows a *gap*, and silent while it is the
         * continuation of a stream — see `EDIT_BURST_MS`. The stamp moves on every
         * increment either way, so a drag stays one gesture however long it runs
         * and the sentence after it is its own. The *state* updates on every frame
         * regardless: the roster and the carets are live, only the speaking is
         * rationed.
         */
        const grew = grewEditsAt.get(peerId) ?? -Infinity
        grewEditsAt.set(peerId, now)
        if (now - grew >= EDIT_BURST_MS) {
          announce(
            'edited',
            { peerId, name: state.name, cursor: state.cursor },
            now
          )
        }
      }
      rebuild(now)
    },

    expire(now) {
      const gone = [...peers.values()].filter(
        (peer) => now - peer.seenAt >= PRESENCE_TIMEOUT_MS
      )
      if (gone.length === 0) {
        /*
         * Still a rebuild when a *sentence* has aged out, and only then: this is
         * the one call the store gets on a clock (`presenceChannel` sweeps on the
         * heartbeat), so it is what empties the region in a session that has gone
         * quiet — and `useSyncExternalStore` compares snapshots by identity, so a
         * rebuild that changed nothing would be a render loop.
         */
        const stale = events.some(
          (event) => now - event.at >= ANNOUNCE_RETENTION_MS
        )
        if (stale) rebuild(now)
        return
      }
      // Every departure, not just the last: one dropped network takes two peers
      // with it, and a listener told about one of them is a listener misinformed.
      for (const peer of gone) {
        peers.delete(peer.peerId)
        grewEditsAt.delete(peer.peerId)
        announce('left', peer, now)
      }
      rebuild(now)
    },

    clear() {
      if (peers.size === 0 && events.length === 0) return
      peers.clear()
      grewEditsAt.clear()
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
