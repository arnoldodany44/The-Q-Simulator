/**
 * The browser's end of §8's `circuit:<id>` — one session, joined, kept and
 * left (M5.5).
 *
 * ═══════════════════════════════════════════════════════════════════════
 * WHY THIS IS A PLAIN OBJECT AND `useCollabSession` IS ONLY A LIFETIME
 *
 * The same reason the API's `ws/session.ts` is a plain object over ports:
 * everything that can go wrong in here is a *sequence*. A join that lands after
 * the socket dropped, a `collab:left` racing a local edit, an update produced
 * while the connection is down, a rejoin that has to reconcile in both
 * directions — none of it is reproducible on demand against a real network, and
 * a sequencing bug that needs one is a sequencing bug with no regression test.
 * So the socket is injected, the clock is injected, the jitter is injected, and
 * the hook does nothing but tie this object's lifetime to a component.
 *
 * ═══════════════════════════════════════════════════════════════════════
 * A SOLO EDITOR MUST NOT REGRESS, AND THAT IS A STATEMENT ABOUT THIS FILE
 *
 * Most sessions have one person in them. Every path below that cannot open a
 * session leaves the editor *exactly* as it shipped — same store, same zundo
 * history, same behaviour — and the mechanism is one rule:
 *
 *   **Nothing touches the store until a `collab:joined` has been applied.**
 *
 * The bridge is what writes the store and takes over its undo
 * (`attachHistory`), and it is built in one place: the first successful join.
 * So an unsaved circuit (no id to join), a build with no API (no socket to open,
 * and therefore no session object at all), an API that is down, a join refused
 * with NOT_FOUND, a deployment with collaboration switched off — all of them end
 * with a session that never existed and an editor nobody disturbed.
 *
 * When a session that *did* open ends, the bridge is **kept** and the document
 * becomes this tab's alone. Detaching would call `attachHistory(null)`, which
 * empties the undo stack — and the session's stack holds only this client's own
 * transactions, so emptying it over a relay frame nobody asked for took the undo
 * history away from a solo editor while their gates were still on the canvas. The
 * bridge is released by `stop`, when the component holding the history is going
 * away anyway; see `detachBridge`.
 *
 * ═══════════════════════════════════════════════════════════════════════
 * WHAT A RECONNECT OWES, IN BOTH DIRECTIONS
 *
 * Sockets drop routinely — a lid, a network hand-off, a redeploy — and Redis
 * pub/sub promises nothing about what was published while one was down. Frames
 * are therefore never replayed. Instead a rejoin exchanges state vectors, which
 * is the only mechanism that closes *both* halves of the gap:
 *
 *   - `collab:join`'s `since` is this peer's vector: "here is what I have".
 *     The relay answers with the difference, not the document.
 *   - `collab:joined`'s `vector` is the relay's: what the *session* is missing
 *     from a peer that went on editing while it was away. Without it such a peer
 *     stays diverged from everybody with nothing to tell it so.
 *
 * Both are bounded, and the bounds are the interesting part. A vector past
 * `MAX_JOIN_VECTOR_BYTES` is omitted rather than truncated — the relay then
 * sends the whole document, which is correct and merely expensive, where a
 * truncated vector would be a lie about what this peer holds. A delta past
 * `MAX_COLLAB_UPDATE_BYTES` cannot be sent at all, and that is the one residual
 * divergence in this file: it is reported as `reconciled: false` rather than
 * hidden, because a peer whose edits never reached the session is exactly what a
 * CRDT cannot repair by itself.
 *
 * ═══════════════════════════════════════════════════════════════════════
 * OUTBOUND UPDATES ARE COALESCED, BECAUSE THE CONTRACT SIZED ITS BUDGET FOR IT
 *
 * `MAX_COLLAB_UPDATES_PER_WINDOW` is 120 per ten seconds "above what a
 * coalescing client produces — the bridge commits per gesture and the transport
 * merges what accumulates between flushes". This is that transport. The editor's
 * store commits every intermediate value of a slider drag on purpose (watching
 * the phasors turn is the point of the control), so a frame per commit would be
 * sixty a second and the relay would close the socket of somebody using the
 * product. `Y.mergeUpdates` is what makes the coalescing free: the merge of two
 * updates *is* an update, so a window's worth of a drag travels as one frame.
 *
 * ═══════════════════════════════════════════════════════════════════════
 * WHY A SOCKET OF ITS OWN, WHEN THE RELAY PUT BOTH CHANNELS ON ONE
 *
 * `ws/session.ts` argues at length that `circuit:<id>` belongs on the same
 * socket as the run feed — and every word of that argument is about the
 * *server's* resources: one authenticated identity, one authorisation cache, one
 * frame budget, one violation counter. None of it says a browser must use one
 * connection, and on this side the two features have unrelated lifetimes: the
 * run socket opens when a circuit crosses §4's ceiling and closes when the last
 * run is done, while a session lasts as long as a document is open. Multiplexing
 * them would mean rewriting `runSocket.ts` — shipped, tested, and the transport
 * every server run depends on — into a connection manager, to save one socket
 * out of the sixteen `MAX_SOCKETS_PER_ADDRESS` allows. The two frame vocabularies
 * are disjoint, so the server cannot tell the difference.
 */

import { applyCircuitUpdate } from '@qsim/collab'
import type { DeferredOperation } from '@qsim/collab'
import {
  MAX_COLLAB_STATE_BYTES,
  MAX_COLLAB_UPDATE_BYTES,
  SOCKET_CLOSE,
  decodeBinaryPayload,
  encodeBinaryPayload,
  encodeFrame,
  parseServerFrame,
} from '@qsim/contract'
import type {
  ClientFrame,
  CollabAccess,
  CollabEndReason,
  PresenceCursor,
  ServerFrame,
  SocketErrorCode,
} from '@qsim/contract'
import type { Circuit } from '@qsim/schema'
import * as Y from 'yjs'

import type { CircuitStore } from '../circuit-editor/useCircuitStore'
import { bridgeCircuitDocument } from './circuitDocument'
import type { CircuitDocumentBridge } from './circuitDocument'
import type { PresenceStore } from './presence'
import { createPresenceChannel } from './presenceChannel'
import type { PresenceChannel } from './presenceChannel'

/**
 * The part of `WebSocket` this file uses.
 *
 * Structurally identical to `runSocket.ts`'s `SocketLike`, and deliberately not
 * imported from it: a real `WebSocket` satisfies both, and two features that
 * share no behaviour should not depend on each other for an eight-line type.
 */
export interface CollabSocketLike {
  send(data: string): void
  close(code?: number, reason?: string): void
  onopen: ((event: unknown) => void) | null
  onmessage: ((event: { data: unknown }) => void) | null
  onclose: ((event: { code?: number }) => void) | null
  onerror: ((event: unknown) => void) | null
}

/**
 * How long to wait before each reconnection attempt, in milliseconds.
 *
 * The same table `runSocket.ts` uses, for the same reasons — front-loaded
 * because the common cause is momentary, flattening at fifteen seconds because
 * the other cause is an API that is down and a tab left open against a dead host
 * must not become a request per second. Restated here rather than imported so
 * that the collaboration chunk does not pull the run feed in behind it; the two
 * numbers agreeing is a coincidence worth keeping, not a dependency.
 */
export const RECONNECT_BACKOFF_MS = [
  500, 1_000, 2_000, 4_000, 8_000, 15_000,
] as const

/**
 * How much the delay is randomised, as a fraction.
 *
 * A redeploy drops every socket at the same instant, and a fixed backoff would
 * bring them all back at the same instant too.
 */
export const RECONNECT_JITTER = 0.25

/**
 * How long local updates accumulate before they travel, in milliseconds.
 *
 * The arithmetic is the whole justification: `MAX_COLLAB_UPDATES_PER_WINDOW` is
 * 120 per ten seconds, so twelve frames a second is the ceiling and this makes
 * ten of them the maximum a continuous gesture produces. The first update after
 * a quiet period is sent immediately — a placement that took 100 ms to reach the
 * other screen is a placement that feels broken — and everything inside the
 * window is merged into one trailing frame.
 */
export const UPDATE_COALESCE_MS = 100

/**
 * How many times a session rejoins after the relay ends it, per connection.
 *
 * `gone` and `overloaded` are both instructions to rejoin (see
 * `COLLAB_END_REASONS`), and rejoining is right: the document was let go or this
 * peer fell behind, and a rejoin is a resync from a state everybody agrees on.
 * What it must not become is a loop — a document that is dropped by every join,
 * because the projection it holds is one the relay will not serve, would
 * otherwise be rejoined forever.
 *
 * Three, counted per connection and reset when a new socket opens, so a long
 * session that is dropped once an hour keeps recovering while a session that
 * cannot hold still gives up and says so.
 */
export const MAX_REJOIN_ATTEMPTS = 3

/**
 * The largest state vector `collab:join` will carry, in bytes.
 *
 * The contract's schema is the authority (`since: base64Field(2048)`); this is
 * the same figure on the sending side so that an oversized vector is *omitted*
 * rather than refused by the relay. A vector is one clock per peer that has ever
 * written — nine bytes or so each — so 2 KiB is hundreds of writers, and a
 * document with more than that gets a whole-state join instead of a delta.
 */
export const MAX_JOIN_VECTOR_BYTES = 2048

/** Why the session is not open. `null` while it is, or before it was tried. */
export type CollabSessionEnd =
  /** The relay ended the attachment — see `COLLAB_END_REASONS`. */
  | CollabEndReason
  /**
   * A document this build cannot read: the relay served, or a peer sent, bytes
   * whose projection the contract refuses. The session is let go rather than
   * repaired — a CRDT cannot un-apply, and a reader that writes is how one
   * diverges.
   */
  | 'invalid'
  /**
   * The join was refused, or collaboration is not available here. `error`
   * carries the relay's code, which `apps/web` already translates.
   */
  | 'unavailable'

export type CollabSessionStatus =
  /**
   * Nothing is being attempted, and there is nothing to say. An unsaved
   * circuit, a build with no API, a caller that switched the session off, or a
   * tab that has opened another document.
   */
  | 'off'
  /** Connecting, authenticating or joining, for the first time. */
  | 'connecting'
  /** Joined. `access` says whether this peer may write. */
  | 'open'
  /** The socket went away. Local editing continues; a rejoin will reconcile. */
  | 'reconnecting'
  /** It stopped, and `ended` says why. */
  | 'ended'

export interface CollabSessionSnapshot {
  readonly status: CollabSessionStatus
  /**
   * What the relay says this peer may do, or `null` before it has said anything.
   *
   * A convenience for hiding a control, never a permission: read-only is
   * enforced on every frame by the relay, and it may arrive *after* the
   * interface has drawn — an owner who transfers a circuit mid-session is
   * downgraded in place, and the next update this client sends is refused with
   * FORBIDDEN, which lands here as `access: 'read'`.
   *
   * ── IT SURVIVES A DROPPED SOCKET, AND THAT IS THE INTERESTING PART ───────
   *
   * The first version cleared it on every close, and a page drawing read-only
   * from `access === 'read'` therefore handed a *watcher* a fully writable editor
   * for the length of every reconnect — undo enabled, palette back, and the gate
   * they then placed committed to their own document and to nobody else's, since
   * `flush` and `reconcile` both require write access. The rejoin restored the
   * notice and left the divergence in place permanently.
   *
   * So a reconnect keeps the last access the relay stated: it is the best
   * available answer to "may I write" while the session is coming back, and it
   * errs towards not inviting an edit that will be dropped. Only an *ending* —
   * `end` or `stop` — clears it, because then there is no session to have access
   * to. Nothing in this file trusts it for that: every send is additionally
   * gated on `joined`, which a close clears.
   */
  readonly access: CollabAccess | null
  readonly ended: CollabSessionEnd | null
  /** The relay's code for `ended: 'unavailable'`, or a refusal it survived. */
  readonly error: SocketErrorCode | null
  /** Operations the document holds that the circuit cannot carry (§6). */
  readonly deferred: number
  /**
   * Which ones, so that a reader can be told and can do something about it.
   *
   * The count on its own was not a surface: `project.ts` argues that a deferred
   * operation must be shown because "an editor that quietly holds two of your
   * gates back is worse than one that shows a conflict", and "3 gates are held
   * back" with no handle on any of them is the quiet version with a number on
   * it. Each entry carries the slot, the reason, the operation and the ids of
   * what blocked it — which is exactly what `deferredResolution.ts` needs to
   * turn a conflict back into an ordinary edit.
   *
   * The array is the projection's own, not a copy: it is rebuilt by
   * `projectCircuit` on every update anyway, and copying it per keystroke to
   * hand a component a list it will cap at a handful of rows would be work for
   * nothing.
   */
  readonly deferredOperations: readonly DeferredOperation[]
  /** Slots past `MAX_DOCUMENT_OPERATIONS`, which are not read at all. */
  readonly overflow: number
  /**
   * Whether everything this client has written has reached the session.
   *
   * False is the one divergence this transport cannot repair: an update, or a
   * reconnection delta, past `MAX_COLLAB_UPDATE_BYTES`. It is surfaced rather
   * than swallowed because the peer's own document is then ahead of everybody
   * else's and nothing else in the system will ever notice.
   */
  readonly reconciled: boolean
}

export interface CollabSession {
  /** Stable between changes, for `useSyncExternalStore`. */
  readonly snapshot: () => CollabSessionSnapshot
  readonly subscribe: (listener: () => void) => () => void
  /** Who else is here, for the roster and the carets. */
  readonly presence: PresenceStore
  /**
   * Where this client is looking. Coalesced by the presence channel.
   *
   * The selection travels with it and is read from the store, because a
   * selection is document state; a cursor is not, which is why only this half
   * has to be told.
   */
  readonly setCursor: (cursor: PresenceCursor | null) => void
  /** Leaves the channel, closes the socket and hands undo back to the store. */
  readonly stop: () => void
}

export interface CollabSessionPorts {
  /**
   * The saved circuit's id or slug — whatever handle addresses it.
   *
   * There is no session without one, which is what "an unsaved document has no
   * id to join" means: the caller passes `null` and never builds this object.
   */
  readonly circuitId: string
  readonly store: CircuitStore
  /**
   * Opens a socket. May throw; a URL the browser refuses is retried.
   *
   * Not nullable, deliberately. "This build has no API" and "the caller switched
   * the session off" are answered by *not building this object at all* — see
   * `useCollabSession` — because a session that exists and does nothing would
   * still hold a presence heartbeat and a store subscription, and the whole
   * promise of the degradation path is that a solo editor pays nothing.
   */
  readonly connect: () => CollabSocketLike
  /** A bearer token, or null for an anonymous socket. Asked per connection. */
  readonly getToken?: () => Promise<string | null>
  /**
   * The document. Supplied by a test that wants to inspect it; otherwise one is
   * made here and belongs to this session.
   */
  readonly doc?: Y.Doc
  /**
   * What wins on the first join — see `BridgeOptions.seed`.
   *
   * The default adopts the session's document, which is right for joining one
   * and for starting one. `'store'` publishes what this tab has open, and a
   * caller that passes it is saying the shared document is expendable.
   */
  readonly seed?: 'document' | 'store'
  /**
   * The saved version the store was seeded from — see `BridgeOptions.saved`.
   *
   * A getter rather than a value: a session outlives a save, and the version the
   * store descends from is what the *next* join has to be compared against.
   */
  readonly saved?: () => Circuit | null
  readonly now?: () => number
  readonly schedule?: (run: () => void, ms: number) => () => void
  readonly random?: () => number
}

/** The origin the relay's seeded state is applied under, before the bridge. */
const SEED_ORIGIN = { qsim: 'session-seed' }

/** What a session that is over has to say about the document it was in. */
const CLEARED = {
  deferred: 0,
  deferredOperations: [] as readonly DeferredOperation[],
  overflow: 0,
} satisfies Partial<CollabSessionSnapshot>

const EMPTY: CollabSessionSnapshot = {
  status: 'off',
  access: null,
  ended: null,
  error: null,
  deferred: 0,
  deferredOperations: [],
  overflow: 0,
  reconciled: true,
}

export function createCollabSession(ports: CollabSessionPorts): CollabSession {
  const now = ports.now ?? (() => Date.now())
  const schedule = ports.schedule ?? defaultSchedule
  const random = ports.random ?? Math.random
  const getToken = ports.getToken ?? (() => Promise.resolve(null))
  const circuitId = ports.circuitId
  const store = ports.store
  const doc = ports.doc ?? new Y.Doc()

  const listeners = new Set<() => void>()
  let snapshot: CollabSessionSnapshot = EMPTY

  let socket: CollabSocketLike | null = null
  /** Whether the socket is open, which is when a frame may be written. */
  let ready = false
  /**
   * Which connection a callback belongs to.
   *
   * A replaced socket can still deliver a queued `onmessage` or a late
   * `onclose`, and acting on either would reopen a connection that already
   * exists or mark a live one dead — the same staleness guard `runSocket.ts`
   * applies, for the same reason.
   */
  let generation = 0
  let joined = false
  let access: CollabAccess | null = null
  /** Set once a join has succeeded, so a reconnect can say so. */
  let everJoined = false
  /** Terminal: nothing reconnects, rejoins or sends after this. */
  let finished = false
  let attempt = 0
  let cancelRetry: (() => void) | null = null
  let rejoinAttempt = 0
  let cancelRejoin: (() => void) | null = null
  /**
   * Whether a `ready` frame reporting no viewer should be ignored.
   *
   * The relay sends `ready` when the socket opens and *again* after a successful
   * `authenticate`, so a client that presented a token sees two — and joining on
   * the first would ask the relay to authorise the circuit against an anonymous
   * viewer, which for a PRIVATE circuit is a NOT_FOUND for something the reader
   * can plainly see.
   */
  let awaitingAuthenticatedReady = false
  /**
   * Whether a join is already in flight on this connection.
   *
   * There are two legitimate triggers for one — the token resolving, and the
   * `ready` frame that answers it — and on an anonymous socket both fire. The
   * relay treats a duplicate join as idempotent, so the cost is not correctness:
   * it is a database read on a pool of one, charged against the frame budget,
   * for an answer this client already has coming. `runSocket.ts` keeps a set of
   * claimed run ids for exactly this reason; one document needs one flag.
   */
  let joinRequested = false

  /** Local updates waiting for the coalescing window — see `flush`. */
  let pending: Uint8Array[] = []
  let cancelFlush: (() => void) | null = null
  let lastSentAt: number | null = null

  /**
   * Built on the first successful join and never before it.
   *
   * This is the whole of "a solo editor must not regress": the bridge is what
   * writes the store and takes its undo over, so a session that never opens
   * cannot have touched either.
   */
  let bridge: CircuitDocumentBridge | null = null
  let releaseLocal: (() => void) | null = null
  /** Whether the store has a gesture open — see `onLocalUpdate`. */
  let gesturing = false
  /** Whether this gesture has already been counted as an edit. */
  let notedGesture = false

  function emit(next: Partial<CollabSessionSnapshot>): void {
    snapshot = { ...snapshot, ...next }
    for (const listener of [...listeners]) listener()
  }

  /* ── presence ────────────────────────────────────────────────────────── */

  let cursor: PresenceCursor | null = null

  const channel: PresenceChannel = createPresenceChannel({
    // Dropped when the session is not open, which the channel's own contract
    // permits: the next heartbeat is at most `PRESENCE_HEARTBEAT_MS` away and
    // carries the whole truth.
    send: (position) => {
      if (!joined) return
      send({ type: 'collab:presence', circuitId, state: position })
    },
    now,
    schedule,
  })

  /**
   * The selection is read from the store rather than pushed in.
   *
   * A selection is part of the document's state and the store is where it
   * lives; a cursor is a view concern and the editor owns it. `moved` is a
   * no-op when nothing actually moved, so subscribing to every store change
   * costs a comparison and cannot defeat the throttle.
   */
  const releaseStore = store.subscribe((next) => {
    channel.moved({ cursor, selection: next.selection })
  })

  /* ── frames ──────────────────────────────────────────────────────────── */

  function send(frame: ClientFrame): void {
    if (socket === null || !ready) return
    try {
      socket.send(encodeFrame(frame))
    } catch {
      // A send on a socket that died between the check and the call. Its close
      // handler is already on its way and will reconnect.
    }
  }

  function sendUpdate(update: Uint8Array): void {
    send({
      type: 'collab:update',
      circuitId,
      update: encodeBinaryPayload(update),
    })
  }

  /**
   * Sends what has accumulated, as one update.
   *
   * The merge is what keeps a gesture inside the relay's budget. When the merge
   * is past the transport ceiling the pieces are sent instead — each was one
   * commit, so each is far smaller — and anything that is too large *alone* is
   * the divergence `reconciled` exists to report.
   */
  function flush(): void {
    cancelFlush?.()
    cancelFlush = null
    const queued = pending
    if (queued.length === 0) return
    pending = []
    if (!joined || access !== 'write') return
    lastSentAt = now()

    const merged =
      queued.length === 1
        ? (queued[0] as Uint8Array)
        : Y.mergeUpdates([...queued])
    if (merged.byteLength <= MAX_COLLAB_UPDATE_BYTES) {
      sendUpdate(merged)
      return
    }
    for (const update of queued) {
      if (update.byteLength <= MAX_COLLAB_UPDATE_BYTES) sendUpdate(update)
      else emit({ reconciled: false })
    }
  }

  /**
   * One update this client produced, on its way out.
   *
   * Everything the bridge announces travels, including an undo and an undo's
   * repairs: they are equally this client's, they carry different origins, and a
   * transport that filtered on one origin would forward a placement and swallow
   * the undo of it — a divergence with nobody at fault.
   *
   * While the session is not open they are *dropped*, and the rejoin delta is
   * what recovers them. Queueing them instead would mean holding an unbounded
   * list of edits for a connection that may never come back, to send bytes the
   * state vector will ask for anyway.
   */
  function onLocalUpdate(update: Uint8Array): void {
    /*
     * One edit per *gesture*, not per commit.
     *
     * The store commits every intermediate value of a slider drag on purpose, so
     * a count bumped per commit grew eight times a second — and the peers reading
     * it cannot tell that stream from a person placing eight gates. They tried,
     * by rate, and got it wrong in both directions: a nine-second drag still
     * repeated the same sentence three or four times while six of eight
     * deliberate edits were never announced at all. The gesture is known *here*,
     * so the count says one thing per gesture and `presence.ts` can trust it.
     *
     * The first update of a gesture is the one that counts, so the sentence
     * arrives when the drag starts rather than when it ends.
     */
    if (!gesturing || !notedGesture) {
      notedGesture = true
      channel.noteEdit()
    }
    if (finished || !joined || access !== 'write') return
    pending.push(update)
    const at = now()
    if (lastSentAt === null || at - lastSentAt >= UPDATE_COALESCE_MS) {
      flush()
      return
    }
    if (cancelFlush !== null) return
    cancelFlush = schedule(flush, UPDATE_COALESCE_MS - (at - lastSentAt))
  }

  function join(): void {
    if (finished || !ready || joined || joinRequested) return
    joinRequested = true
    /*
     * A vector only once there is a document worth describing. On the first join
     * the document is empty and unbridged, and `since: ''` would ask the relay
     * to decode an empty state vector — so the frame simply omits it and the
     * relay sends everything, which is what a first join wants.
     */
    const vector = bridge === null ? null : Y.encodeStateVector(bridge.doc)
    const since =
      vector === null || vector.byteLength > MAX_JOIN_VECTOR_BYTES
        ? undefined
        : encodeBinaryPayload(vector)
    send({
      type: 'collab:join',
      circuitId,
      ...(since === undefined ? {} : { since }),
    })
  }

  /**
   * Adopts the document the relay served, and the access it granted.
   *
   * The order is the contract the bridge documents: the state is applied to the
   * document *before* the bridge attaches, because an unsynced document is
   * indistinguishable from a new one and a bridge over a new one publishes the
   * store's circuit into it.
   */
  function joinedWith(frame: ServerFrame & { type: 'collab:joined' }): void {
    const update = decodeBinaryPayload(frame.update)
    if (update === null) {
      // The relay's own frame did not decode. Nothing has been applied, so this
      // is a refusal rather than a damaged document — but it is also not a
      // session anybody can converge in.
      end('invalid')
      return
    }

    let held = bridge
    if (held === null) {
      if (!isEmptyUpdate(update)) {
        const seeded = applyCircuitUpdate(doc, update, {
          origin: SEED_ORIGIN,
          maxBytes: MAX_COLLAB_STATE_BYTES,
        })
        if (!seeded.ok) {
          end('invalid')
          return
        }
      }
      const saved = ports.saved?.() ?? null
      held = bridgeCircuitDocument({
        store,
        doc,
        ...(ports.seed === undefined ? {} : { seed: ports.seed }),
        // What the store was seeded from, so the bridge can tell this reader's
        // own unpublished work from an operation a peer deleted. See
        // `BridgeOptions.saved`.
        ...(saved === null ? {} : { saved }),
        // A gesture is one edit as far as presence is concerned; see
        // `onLocalUpdate`.
        onGesture: (active) => {
          gesturing = active
          notedGesture = false
        },
        onProjection: (projection) => {
          emit({
            deferred: projection.deferred.length,
            deferredOperations: projection.deferred,
            overflow: projection.overflow,
          })
        },
        onDocumentReplaced: () => {
          /*
           * This tab opened another circuit. The bridge has already stopped, so
           * nothing more of this document is published and nothing more of the
           * session is adopted; leaving the channel is what is left, and there
           * is nothing to tell the reader — they went somewhere else.
           */
          stop()
        },
      })
      bridge = held
      releaseLocal = held.onLocalUpdate(onLocalUpdate)
    } else if (!isEmptyUpdate(update)) {
      // A rejoin. The single door for foreign bytes, so the ceiling and the
      // origin discipline stay in one place.
      const applied = held.receive(update)
      if (!applied.ok) {
        end('invalid')
        return
      }
    }

    joined = true
    joinRequested = false
    everJoined = true
    access = frame.access
    /*
     * A rejoin that was still armed has been answered. Left running it would
     * send a second `collab:join` into a session this peer is already in — see
     * `rejoin`, which now re-arms itself precisely because nothing else does.
     */
    cancelRejoin?.()
    cancelRejoin = null
    /*
     * The projection's two numbers rather than the frame's, which carry the
     * same pair: the relay computed them from this same document, and reading
     * them locally means "how many operations are deferred" has one code path
     * for the join and for every update after it. The frame carries them for a
     * client that would rather not project before it paints.
     */
    const projection = held.projection()
    emit({
      status: 'open',
      access: frame.access,
      ended: null,
      error: null,
      deferred: projection.deferred.length,
      deferredOperations: projection.deferred,
      overflow: projection.overflow,
      /*
       * A successful join *is* the repair for a divergence, so the notice goes
       * with it. `since` told the relay what this peer lacked and `reconcile`
       * below sends what the relay lacks: after both halves there is no gap
       * left to describe, and a sentence that stayed on screen for the rest of
       * the session named other people to a reader who was alone.
       */
      reconciled: true,
    })

    reconcile(frame.vector)
    /*
     * A watcher that carried unpublished work into its own document is the one
     * divergence a rejoin cannot close: `flush` and `reconcile` both require
     * write access, so those bytes are in this replica and in no other. Said
     * rather than swallowed — that is what `reconciled` is for.
     */
    if (held.carried && frame.access !== 'write') emit({ reconciled: false })
    /*
     * States where this client is without waiting for it to move. A peer that
     * joins and reads has a null cursor and nothing to report, and would be
     * invisible to everybody until its first heartbeat — ten seconds of "nobody
     * else is here" on a screen where somebody is.
     */
    channel.announce()
  }

  /**
   * Sends the session what it is missing from this peer.
   *
   * The other half of a reconnect. `since` told the relay what this client
   * lacked; this answers the `vector` it sent back, so edits made while
   * disconnected reach everybody instead of living in one tab forever.
   *
   * It is also what publishes a *seed* write. When the relay serves an empty
   * document the bridge writes this tab's circuit into it, and that write
   * happens inside `bridgeCircuitDocument` — before there is anything to
   * subscribe to it with. The delta against the relay's vector carries it, which
   * is why this runs on a first join and not only on a rejoin.
   */
  function reconcile(encoded: string): void {
    const held = bridge
    if (held === null || access !== 'write') return
    const vector = decodeBinaryPayload(encoded)
    if (vector === null) return
    let delta: Uint8Array
    try {
      delta = Y.encodeStateAsUpdate(held.doc, vector)
    } catch {
      // Bytes that are not a state vector. Dropped rather than fatal: the
      // session is otherwise working, and the cost is that a peer which edited
      // offline waits for its next edit to be seen.
      emit({ reconciled: false })
      return
    }
    if (isEmptyUpdate(delta)) return
    if (delta.byteLength > MAX_COLLAB_UPDATE_BYTES) {
      // More offline editing than one frame can carry. See `reconciled`.
      emit({ reconciled: false })
      return
    }
    sendUpdate(delta)
  }

  function handle(frame: ServerFrame): void {
    switch (frame.type) {
      case 'ready':
        if (awaitingAuthenticatedReady && frame.viewer === null) return
        awaitingAuthenticatedReady = false
        join()
        return

      case 'collab:joined':
        if (frame.circuitId !== circuitId) return
        joinedWith(frame)
        return

      case 'collab:update': {
        if (frame.circuitId !== circuitId) return
        const held = bridge
        if (held === null) return
        const bytes = decodeBinaryPayload(frame.update)
        // A payload that is not base64 reached no document, so nothing is
        // damaged and nothing is applied. The next update from that peer will
        // carry the same content, because a CRDT update is cumulative.
        if (bytes === null) return
        const applied = held.receive(bytes)
        if (!applied.ok) {
          /*
           * The projection refuses what the document now says. There is no way
           * back — `applyCircuitUpdate` has no rollback — so the session is let
           * go and the editor keeps the circuit it has. The relay reaches the
           * same conclusion from its side and drops the document.
           */
          end('invalid')
        }
        return
      }

      case 'collab:presence':
        if (frame.circuitId !== circuitId) return
        channel.receive(frame.peerId, frame.state)
        return

      case 'collab:left':
        if (frame.circuitId !== circuitId) return
        leftBy(frame.reason)
        return

      case 'collab:error':
        if (frame.circuitId !== circuitId) return
        refused(frame.code)
        return

      case 'error':
        /*
         * Not about any circuit. The one that matters is a token that did not
         * verify: there will be no second `ready`, so the session joins
         * anonymously rather than waiting for a frame that is not coming. For a
         * PUBLIC circuit that is a working session; for anything else the join
         * is refused with NOT_FOUND, which is handled above.
         */
        if (frame.runId === null && frame.code === 'AUTH_INVALID_TOKEN') {
          awaitingAuthenticatedReady = false
          join()
        }
        return

      default:
        // A run frame on this socket, a `pong`, or a frame from an API deployed
        // ahead of this bundle. Dropped, never fatal.
        return
    }
  }

  /** The relay ended the attachment without being asked. */
  function leftBy(reason: CollabEndReason): void {
    joined = false
    joinRequested = false
    // `access` is deliberately kept — see the field's own comment. A peer that is
    // rejoining is still the peer the relay last described, and every send is
    // gated on `joined` rather than on this.
    pending = []
    cancelFlush?.()
    cancelFlush = null
    channel.reset()

    if (reason === 'unauthorised') {
      // The circuit stopped being this viewer's to read or to write. Rejoining
      // would be refused, and the honest thing is to say what happened.
      end('unauthorised')
      return
    }
    // `gone` and `overloaded` are both instructions to rejoin, and a rejoin is
    // a resync — the local document is still good and will be merged.
    rejoin(reason)
  }

  /** A refusal that arrived on the channel rather than as a close. */
  function refused(code: SocketErrorCode): void {
    switch (code) {
      case 'FORBIDDEN':
        /*
         * This peer may read and may not write, and it just tried. Reported by
         * the relay on the frame rather than by an interface that declines to
         * draw a button — which is why it can arrive at any moment, including
         * long after the session opened, when a circuit is transferred.
         *
         * The session continues as a watcher. The queued updates are dropped
         * because they will never be accepted; the local document keeps them,
         * which is what a read-only peer's own copy is for.
         */
        access = 'read'
        pending = []
        cancelFlush?.()
        cancelFlush = null
        emit({ access: 'read', error: 'FORBIDDEN' })
        return

      case 'PAYLOAD_TOO_LARGE':
        /*
         * One update was refused for its size, or the socket is past its byte
         * budget for this window. The attachment survives, so the session goes
         * on — but the refused bytes are in this client's document and in
         * nobody else's, and that is exactly what `reconciled` reports.
         */
        emit({ error: code, reconciled: false })
        return

      case 'RATE_LIMITED':
      case 'DATABASE_UNAVAILABLE':
        // The relay is full, or the row could not be read. Both are transient
        // and both are answered by trying the join again, on the backoff.
        joined = false
        joinRequested = false
        emit({ error: code })
        rejoin(null)
        return

      default:
        /*
         * NOT_FOUND (no such circuit, or not this viewer's to see),
         * CIRCUIT_TOO_LARGE (the document cannot be served at all),
         * VALIDATION_FAILED (a frame this build produced was refused) and
         * SIMULATION_UNAVAILABLE (collaboration is switched off on this
         * deployment). None of them is fixed by trying again, and every one of
         * them leaves a working solo editor.
         */
        end('unavailable', code)
        return
    }
  }

  /* ── the connection ──────────────────────────────────────────────────── */

  function connect(): void {
    if (finished || socket !== null) return
    const mine = ++generation
    emit({ status: everJoined ? 'reconnecting' : 'connecting' })

    let candidate: CollabSocketLike
    try {
      candidate = ports.connect()
    } catch {
      // A URL the browser refuses, or a page whose CSP forbids the connection.
      // Indistinguishable from a host that is down, and answered the same way.
      retry()
      return
    }
    socket = candidate

    candidate.onopen = () => {
      if (mine !== generation) return
      ready = true
      attempt = 0
      rejoinAttempt = 0
      /*
       * The token is fetched per connection and never captured: a reconnect an
       * hour later must not present the credential this session was opened
       * with, and the reader may have signed in or out in between.
       */
      void getToken()
        .then((token) => {
          if (mine !== generation) return
          if (token === null) {
            join()
            return
          }
          awaitingAuthenticatedReady = true
          send({ type: 'authenticate', token })
        })
        .catch(() => {
          // No token available. An anonymous socket joins a PUBLIC circuit
          // perfectly well, and anything else is refused with NOT_FOUND.
          if (mine === generation) join()
        })
    }

    candidate.onmessage = (event) => {
      if (mine !== generation) return
      if (typeof event.data !== 'string') return
      const frame = parseServerFrame(event.data)
      if (frame === null) return
      handle(frame)
    }

    candidate.onerror = () => {
      // Deliberately empty. A browser fires `error` and then `close` for the
      // same failure, and reconnecting from both would double every attempt.
    }

    candidate.onclose = (event) => {
      if (mine !== generation) return
      ready = false
      socket = null
      joined = false
      joinRequested = false
      // `access` survives a dropped socket on purpose — see the field's comment.
      awaitingAuthenticatedReady = false
      pending = []
      cancelFlush?.()
      cancelFlush = null
      cancelRejoin?.()
      cancelRejoin = null
      /*
       * Everybody's caret goes, and no departures are announced: those peers
       * did not leave, this tab did, and telling a screen reader that four
       * people left would describe the wrong event entirely.
       */
      channel.reset()
      if (finished) return
      if (event.code === SOCKET_CLOSE.PROTOCOL) {
        /*
         * The relay refused frames this build produced. Reconnecting would
         * reproduce it immediately and forever, so the session stops — quietly,
         * because a version skew is not something to explain to a reader whose
         * editor is working.
         */
        end('unavailable')
        return
      }
      /*
       * "Reconnecting" only if there was ever a connection to lose. A tab open
       * against an API that is down would otherwise report itself as
       * reconnecting to a session it was never in, which is a sentence about
       * somebody else's work that is simply not true.
       */
      emit({ status: everJoined ? 'reconnecting' : 'connecting' })
      retry()
    }
  }

  function retry(): void {
    if (finished || cancelRetry !== null) return
    const base =
      RECONNECT_BACKOFF_MS[
        Math.min(attempt, RECONNECT_BACKOFF_MS.length - 1)
      ] ?? 15_000
    attempt += 1
    const spread = base * RECONNECT_JITTER
    const delay = Math.max(0, Math.round(base - spread + random() * 2 * spread))
    cancelRetry = schedule(() => {
      cancelRetry = null
      connect()
    }, delay)
  }

  /**
   * Asks for the attachment again, on the same backoff and bounded.
   *
   * `reason` is what the reader is told if the attempts run out; `null` is a
   * refusal that already reported its own code.
   *
   * ── WHY IT RE-ARMS ITSELF ────────────────────────────────────────────────
   *
   * Because nothing else does, and an unanswered attempt is a real state. The
   * first version scheduled exactly one `collab:join` and was re-entered only by
   * another `collab:left` or another refusal — so a frame lost on a half-open
   * socket, or a relay that dropped the document and never answered, left the
   * panel saying «Reconnecting to the shared session…» permanently with nothing
   * scheduled behind it and no ending ever reported. A status line that claims
   * work is in progress when none is has to be either true or gone.
   *
   * `MAX_REJOIN_ATTEMPTS` still bounds it, and a `collab:joined` cancels the
   * armed attempt and resets the counter, so a session that recovers pays
   * nothing.
   */
  function rejoin(reason: CollabEndReason | null): void {
    if (finished || cancelRejoin !== null) return
    if (rejoinAttempt >= MAX_REJOIN_ATTEMPTS) {
      end(reason ?? 'unavailable')
      return
    }
    const base =
      RECONNECT_BACKOFF_MS[
        Math.min(rejoinAttempt, RECONNECT_BACKOFF_MS.length - 1)
      ] ?? 15_000
    rejoinAttempt += 1
    // As in `onclose`: a join that has never succeeded is still connecting.
    emit({ status: everJoined ? 'reconnecting' : 'connecting' })
    armJoin(base)
  }

  /**
   * Sends one `collab:join` after `delay`, and arms the next one behind it.
   *
   * The escalation is `retry`'s, not `rejoin`'s, and the two counters are
   * separate on purpose. `rejoinAttempt` counts endings the relay *answered*
   * with, which is what `MAX_REJOIN_ATTEMPTS` bounds: a document the relay will
   * not serve answers every join and must not be rejoined forever. A join nobody
   * answers is the other thing entirely — indistinguishable from a dead socket —
   * and is retried on the flattening backoff exactly as `retry` retries a
   * connection, because the alternative is the state the panel was found in:
   * «Reconnecting to the shared session…» with nothing scheduled behind it.
   *
   * `joinedWith` cancels whatever is armed, so a session that comes back pays
   * for one timer.
   */
  function armJoin(delay: number): void {
    cancelRejoin = schedule(() => {
      cancelRejoin = null
      // A *retry* of a join nobody answered, so the guard that stops the token
      // and the `ready` frame from both joining is stood down.
      joinRequested = false
      join()
      const next =
        RECONNECT_BACKOFF_MS.find((step) => step > delay) ??
        RECONNECT_BACKOFF_MS[RECONNECT_BACKOFF_MS.length - 1] ??
        15_000
      armJoin(next)
    }, delay)
  }

  /* ── endings ─────────────────────────────────────────────────────────── */

  /** Tells the relay this client is going, when there is still a socket. */
  function leaveChannel(): void {
    if (joined) send({ type: 'collab:leave', circuitId })
    joined = false
  }

  function closeSocket(): void {
    generation += 1
    cancelRetry?.()
    cancelRetry = null
    cancelRejoin?.()
    cancelRejoin = null
    const current = socket
    socket = null
    ready = false
    if (current === null) return
    current.onopen = null
    current.onmessage = null
    current.onclose = null
    current.onerror = null
    try {
      current.close()
    } catch {
      /* already gone */
    }
  }

  /**
   * Hands undo back to the store, which clears the history.
   *
   * ── WHY AN *ENDING* DOES NOT DO THIS ─────────────────────────────────────
   *
   * `attachHistory(null)` clears the store's history in both directions, and the
   * argument the store gives for that is about other people: «a stack of
   * snapshots taken before other people edited is a stack of documents that were
   * only ever this client's». That argument does not apply to what a *session*
   * accumulated. `sharedUndo` records this client's own transactions and nobody
   * else's — that is what `trackedOrigins` is for — so every step on it is this
   * reader's work.
   *
   * Detaching on an ending therefore did the one thing this whole feature
   * promised not to: a relay frame nobody asked for — `collab:left unauthorised`,
   * a NOT_FOUND, a document the projection refuses — emptied the undo stack of a
   * solo editor while their gates were still on the canvas, and four presses
   * reported «There is nothing left to undo».
   *
   * So an ending keeps the bridge and the document becomes this tab's alone: the
   * store still commits through it, undo still walks this client's steps, and the
   * only thing that stopped is the transport. The bridge is released here, by the
   * component that is going away, which is the one moment the history is going
   * away anyway.
   */
  function detachBridge(): void {
    releaseLocal?.()
    releaseLocal = null
    bridge?.detach()
    bridge = null
  }

  function teardown(): void {
    finished = true
    flush()
    leaveChannel()
    closeSocket()
    releaseStore()
    channel.stop()
    pending = []
    cancelFlush?.()
    cancelFlush = null
    access = null
  }

  function end(reason: CollabSessionEnd, code?: SocketErrorCode): void {
    if (finished) return
    teardown()
    emit({
      status: 'ended',
      access: null,
      ended: reason,
      // The deferral list goes with the session. It names slots in a document
      // nothing is writing any more, so every repair it offered would be an
      // edit to a document nobody else can see.
      ...CLEARED,
      ...(code === undefined ? {} : { error: code }),
    })
  }

  /**
   * The caller is done with this session — an unmount, a `pagehide`, or a tab
   * that opened another circuit.
   *
   * Reachable *after* an ending, and that is deliberate: `end` leaves the bridge
   * attached so undo survives, so something has to release it, and this is the
   * only moment at which the component holding the history is going away too.
   */
  function stop(): void {
    const ending = finished
    if (!ending) teardown()
    detachBridge()
    if (ending) return
    emit({ status: 'off', access: null, ...CLEARED })
  }

  connect()

  return {
    snapshot: () => snapshot,
    subscribe: (listener) => {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },
    presence: channel.store,
    setCursor: (next) => {
      cursor = next
      channel.moved({ cursor: next, selection: store.getState().selection })
    },
    stop,
  }
}

/**
 * Whether an update carries nothing.
 *
 * A Yjs update with no structs and no deletions encodes to two zero bytes, and
 * `Y.encodeStateAsUpdate(doc, vector)` produces exactly that when the vector is
 * already current — which is the ordinary case on a reconnect that missed
 * nothing. Sending it would cost a frame, a budget entry and a reprojection on
 * the relay for no content at all.
 */
function isEmptyUpdate(update: Uint8Array): boolean {
  return update.byteLength <= 2
}

function defaultSchedule(run: () => void, ms: number): () => void {
  const handle = setTimeout(run, ms)
  return () => {
    clearTimeout(handle)
  }
}
