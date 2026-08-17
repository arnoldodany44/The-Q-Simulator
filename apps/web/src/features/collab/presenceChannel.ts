/**
 * The presence side of a session: what leaves this tab, and when — M5.3.
 *
 * The store holds what arrived (`presence.ts`). This holds the three pieces of
 * timing that make presence cheap enough to leave switched on, and it holds them
 * behind injected ports so that all three can be tested without waiting for a
 * clock.
 *
 * ── 1. A CURSOR MOVES FASTER THAN ANY NETWORK SHOULD CARE ABOUT ──────────
 *
 * The arrow keys repeat, a pointer drag fires per animation frame, and a selection
 * changes on every one of them. Sending a frame per change is sixty frames a second
 * per peer, fanned out to everybody in the session by a container on a small
 * Railway instance — for information that is stale the moment after it is drawn.
 *
 * So sends are coalesced to `PRESENCE_THROTTLE_MS`: the *first* change goes
 * immediately, because a caret that takes 120 ms to appear is a caret that feels
 * broken, and everything inside the window is collapsed into one trailing send
 * carrying the newest position. That is at most nine frames a second, against a
 * budget (`MAX_COLLAB_PRESENCE_PER_WINDOW`) sized for fifteen.
 *
 * ── 2. A CLOSED TAB SENDS NOTHING, INCLUDING A GOODBYE ───────────────────
 *
 * No close frame arrives from a killed tab, a closed lid, or a phone that changed
 * network, and the socket layer notices only on its own ping cycle up to a minute
 * later. So presence is a *claim with a lease*: every `PRESENCE_HEARTBEAT_MS` this
 * tab restates where it is, and every peer drops what it has not heard restated for
 * `PRESENCE_TIMEOUT_MS`. One timer does both halves — the restatement and the
 * sweep — because they run on the same cadence and a second interval would be a
 * second thing to leak.
 *
 * ── 3. AN EDIT IS COUNTED HERE, BECAUSE A CRDT UPDATE HAS NO AUTHOR ──────
 *
 * `noteEdit` is what a bridge calls when this client commits a gesture to the
 * document. It bumps a counter that travels in the position, and a peer that sees it
 * grow announces "somebody edited" to a screen reader (`presence.ts`). It is
 * deliberately not derived from the document: a Yjs update carries no author, and
 * asking the relay to add one would mean stamping identity onto every byte of the
 * document channel to serve a sentence in a live region.
 */

import {
  PRESENCE_HEARTBEAT_MS,
  PRESENCE_THROTTLE_MS,
  MAX_PRESENCE_SELECTION,
} from '@qsim/contract'
import type {
  PresenceCursor,
  PresencePosition,
  PresenceState,
} from '@qsim/contract'

import { createPresenceStore, type PresenceStore } from './presence'

/** Where this client is looking. The `edits` count is the channel's own. */
export interface LocalPresence {
  readonly cursor: PresenceCursor | null
  readonly selection: readonly string[]
}

export interface PresenceChannelPorts {
  /**
   * Sends one position. The transport wraps it in a `collab:presence` frame.
   *
   * It may be called while the socket is down; a transport that drops it is
   * correct, because the next heartbeat is at most `PRESENCE_HEARTBEAT_MS` away
   * and carries the whole truth.
   */
  readonly send: (position: PresencePosition) => void
  readonly now?: () => number
  /** One-shot timer, injected so a test can drive the heartbeat and the sweep. */
  readonly schedule?: (run: () => void, ms: number) => () => void
}

export interface PresenceChannel {
  /** What arrived, for the components to read. */
  readonly store: PresenceStore
  /**
   * States where this client is, now, without waiting for it to move.
   *
   * Called by the transport once the session is open. It exists because the
   * ordinary trigger — a movement — may never come: a peer that joins and reads
   * has a null cursor and nothing to report, and `moved` is deliberately a no-op
   * when nothing moved. Without this such a peer would be invisible to everybody
   * until its first heartbeat, which is up to ten seconds of "nobody else is
   * here" on a screen where somebody is.
   */
  readonly announce: () => void
  /** This client moved. Coalesced; the newest position wins. */
  readonly moved: (local: LocalPresence) => void
  /** This client committed an edit to the document. */
  readonly noteEdit: () => void
  /** A `collab:presence` frame arrived. */
  readonly receive: (peerId: string, state: PresenceState | null) => void
  /**
   * The session ended or the socket went away: forget everybody.
   *
   * The local position is *kept*, so a reconnect restates it without the editor
   * having to notice that anything happened.
   */
  readonly reset: () => void
  /** Stops the timer. Idempotent; nothing here survives it. */
  readonly stop: () => void
}

export function createPresenceChannel(
  ports: PresenceChannelPorts
): PresenceChannel {
  const now = ports.now ?? (() => Date.now())
  const schedule = ports.schedule ?? defaultSchedule
  const store = createPresenceStore()

  let local: LocalPresence = { cursor: null, selection: [] }
  let edits = 0
  /** Whether anything has been sent at all: the first send is not throttled. */
  let sentAt: number | null = null
  let cancelThrottle: (() => void) | null = null
  let cancelTick: (() => void) | null = null
  let stopped = false

  function position(): PresencePosition {
    return {
      cursor: local.cursor,
      /*
       * Truncated here rather than refused by the schema. A person may select two
       * hundred gates and what travels is what is *drawn* — eight outlines say "I
       * am working over here" as well as two hundred do, and the roster says how
       * many there are in words.
       */
      selection: local.selection.slice(0, MAX_PRESENCE_SELECTION),
      edits,
    }
  }

  function flush(): void {
    if (stopped) return
    cancelThrottle?.()
    cancelThrottle = null
    sentAt = now()
    ports.send(position())
    arm()
  }

  /**
   * Arms the one timer: the heartbeat and the sweep.
   *
   * Re-armed after every send, so a tab that is being typed in never pays for a
   * heartbeat it does not need — the last position is at most
   * `PRESENCE_HEARTBEAT_MS` old at any instant either way.
   */
  function arm(): void {
    if (stopped) return
    cancelTick?.()
    cancelTick = schedule(() => {
      cancelTick = null
      if (stopped) return
      // The sweep first: a ghost should go even in a session where this tab is the
      // only thing still sending.
      store.expire(now())
      flush()
    }, PRESENCE_HEARTBEAT_MS)
  }

  function change(): void {
    if (stopped) return
    const at = now()
    // The leading edge: the first movement after a quiet period goes at once, so a
    // caret appears where somebody just clicked rather than 120 ms later.
    if (sentAt === null || at - sentAt >= PRESENCE_THROTTLE_MS) {
      flush()
      return
    }
    if (cancelThrottle !== null) return
    cancelThrottle = schedule(
      () => {
        cancelThrottle = null
        flush()
      },
      PRESENCE_THROTTLE_MS - (at - sentAt)
    )
  }

  /*
   * The sweep runs whether or not this tab ever says anything, which is the case
   * that matters: a reader who joins and sits still is exactly the peer that would
   * otherwise keep a ghost's caret on screen forever, because nothing else in this
   * client is driven by a clock.
   */
  arm()

  return {
    store,

    announce: flush,

    moved(next) {
      // A change is only a change if something moved. The editor re-renders for
      // plenty of reasons that are not a cursor movement, and a frame per render
      // would defeat the throttle by arriving through the front door.
      if (same(local, next)) return
      local = { cursor: next.cursor, selection: [...next.selection] }
      change()
    },

    noteEdit() {
      edits += 1
      change()
    },

    receive: (peerId, state) => {
      store.receive(peerId, state, now())
    },

    reset() {
      store.clear()
      /*
       * The clock is reset too, so the first position after a reconnect is sent on
       * the leading edge rather than waiting out a throttle window that was opened
       * by a send the server never received.
       */
      sentAt = null
      cancelThrottle?.()
      cancelThrottle = null
    },

    stop() {
      stopped = true
      cancelThrottle?.()
      cancelThrottle = null
      cancelTick?.()
      cancelTick = null
      store.clear()
    },
  }
}

function same(left: LocalPresence, right: LocalPresence): boolean {
  if (left.cursor?.qubit !== right.cursor?.qubit) return false
  if (left.cursor?.column !== right.cursor?.column) return false
  if (left.selection.length !== right.selection.length) return false
  return left.selection.every((id, index) => id === right.selection[index])
}

function defaultSchedule(run: () => void, ms: number): () => void {
  const handle = setTimeout(run, ms)
  return () => {
    clearTimeout(handle)
  }
}
