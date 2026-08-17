/**
 * Who is in a session, and where they are looking — M5.3.
 *
 * One roster per shared document, held beside it in `ws/documents.ts`. It is a
 * map from peer id to the last thing that peer said about itself, and three
 * rules over that map. Nothing here knows about a socket, a document or Redis,
 * for the same reason `session.ts` has no `ws` in it: every interesting failure
 * is a *sequence* — a peer that left and came back, a heartbeat that arrived
 * after the expiry that removed its sender, a ghost that outlived its tab — and
 * a sequencing bug reproducible only through a real connection is one that never
 * gets a regression test.
 *
 * ── 1. PRESENCE IS NOT PART OF THE DOCUMENT, AND MUST NOT BEHAVE LIKE IT ──
 *
 * A CRDT update is kept forever: it is merged, persisted, and every peer must
 * see it or diverge. Presence is the opposite on all three counts. It is
 * *replaced* rather than merged (the newest position is the only one that
 * matters), it is never written to a row, and a peer that misses one is a peer
 * whose caret is briefly stale — which the next heartbeat fixes. So this file
 * has none of the machinery `documents.ts` needs, and that asymmetry is the
 * whole reason presence is not carried inside the Y.Doc: it would make every
 * cursor movement a permanent, persisted, tombstoned fact.
 *
 * ── 2. A PEER EXPIRES; IT DOES NOT WAIT TO BE COLLECTED ──────────────────
 *
 * The events that end a presence are, in order of how reliable they are: the
 * client saying `collab:leave`, the socket closing, and — the one that actually
 * happens — nothing at all. A laptop lid, a killed tab, a phone that changed
 * network: no close frame, and the socket layer notices only on its own ping
 * cycle, up to a minute later. A cursor that lingers for a minute is not a
 * degraded cursor, it is a false statement about where a person is.
 *
 * So a record dies of old age (`PRESENCE_TIMEOUT_MS`) unless its peer keeps
 * restating it (`PRESENCE_HEARTBEAT_MS`), and expiry is *lazy*: it happens when
 * somebody publishes and when a joiner asks for the roster, which are the only
 * two moments the answer is used. A timer per document would be a timer per
 * document, on a container that runs sixty-four of them, to compute something
 * nobody was asking for.
 *
 * That leaves one gap, and it is closed at the other end rather than here: a
 * session where the *only* peer left is a ghost produces no publishes, so
 * nothing prunes it. Every client applies the same timeout to what it holds, so
 * the caret disappears from every screen on schedule regardless — see
 * `PRESENCE_TIMEOUT_MS`. What this file's pruning buys is that everybody is
 * *told*, at once, instead of each browser reaching the same conclusion alone.
 *
 * ── 3. WHAT A STRANGER CAN MAKE THIS PROCESS HOLD IS BOUNDED ─────────────
 *
 * A record is a peer id, a name, a cell and up to `MAX_PRESENCE_SELECTION`
 * operation ids: a few hundred bytes, bounded by the contract's schema before it
 * reaches here. What is bounded *here* is how many of them a document may hold,
 * because the map has entries from other replicas in it too — a peer on replica
 * B is a record on replica A with no local socket to close it. See
 * `MAX_PRESENCE_RECORDS`.
 */

import { PRESENCE_TIMEOUT_MS } from '@qsim/contract'
import type { PresenceState } from '@qsim/contract'

/**
 * How many peers one document's roster will hold.
 *
 * Twice `MAX_PEERS_PER_DOCUMENT`, and the factor of two is the second replica:
 * sixteen peers may be attached *here*, and the same document may have sixteen
 * more on another instance whose presence arrives over the bus. A record is a
 * few hundred bytes, so thirty-two of them is kilobytes per document and tens of
 * kilobytes for a container holding `MAX_DOCUMENTS` — but the bound exists
 * anyway, because a remote record has no socket whose closing would remove it,
 * and "grows with what other instances publish" is not a shape a memory
 * footprint should have.
 *
 * Past it a publish for a *new* peer is refused, never one for a peer already in
 * the roster: dropping an update from somebody already visible would freeze their
 * caret and, worse, stop their heartbeats from renewing it, so the peer would
 * expire while still present. A refusal is silent — the peer's own cursor is
 * unaffected and the next expiry makes room.
 */
export const MAX_PRESENCE_RECORDS = 32

export interface PresenceRecord {
  readonly peerId: string
  readonly state: PresenceState
  /** This process's clock when the record was last stated. */
  readonly seenAt: number
}

export interface PresenceRoster {
  /**
   * Records where a peer is. `false` when the roster is full and this peer is
   * not already in it — see `MAX_PRESENCE_RECORDS`.
   */
  readonly publish: (
    peerId: string,
    state: PresenceState,
    now: number
  ) => boolean
  /** Forgets a peer. `true` when there was one to forget. */
  readonly remove: (peerId: string) => boolean
  /**
   * Removes every record older than `PRESENCE_TIMEOUT_MS` and answers with the
   * peers that went.
   *
   * The caller fans `state: null` out for each, which is what makes a ghost
   * disappear from everybody's screen at the same instant rather than at each
   * client's own timeout.
   */
  readonly prune: (now: number) => readonly string[]
  /** Everybody currently known, in the order they first appeared. */
  readonly entries: () => readonly PresenceRecord[]
  readonly size: () => number
}

export function createPresenceRoster(): PresenceRoster {
  /*
   * Insertion-ordered by construction (a `Map` iterates in insertion order), and
   * re-publishing an existing peer keeps its place rather than moving it to the
   * end: the roster a person reads should not reshuffle itself because somebody
   * moved their cursor. A record is replaced in place, so the *value* is always
   * the newest thing that peer said.
   */
  const records = new Map<string, PresenceRecord>()

  return {
    publish(peerId, state, now) {
      if (!records.has(peerId) && records.size >= MAX_PRESENCE_RECORDS) {
        return false
      }
      records.set(peerId, { peerId, state, seenAt: now })
      return true
    },

    remove: (peerId) => records.delete(peerId),

    prune(now) {
      const expired: string[] = []
      for (const record of records.values()) {
        if (now - record.seenAt >= PRESENCE_TIMEOUT_MS)
          expired.push(record.peerId)
      }
      for (const peerId of expired) records.delete(peerId)
      return expired
    },

    entries: () => [...records.values()],
    size: () => records.size,
  }
}
