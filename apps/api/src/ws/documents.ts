/**
 * The shared documents this process holds, and everything that happens to one.
 *
 * `ws/session.ts` owns a *socket*; this owns a *circuit*. One document per
 * circuit, however many peers are attached to it, seeded from persistence when
 * the first one arrives and given back when the last one leaves.
 *
 * ═══════════════════════════════════════════════════════════════════════
 * WHAT THE RELAY DOES WITH A HOSTILE UPDATE, AND WHY IT IS IN THIS ORDER
 *
 * A CRDT update is opaque binary from a browser. Four things are done to one,
 * and the order is the whole of the argument:
 *
 *   1. **Bounded before it is decoded.** `MAX_COLLAB_UPDATE_BYTES`, checked by
 *      the frame schema and again here. A ceiling on bytes is the only judgement
 *      available before the bytes mean anything.
 *
 *   2. **Decoded before it is integrated.** `Y.decodeUpdate` parses the binary
 *      and throws on garbage *without touching any document*. This step is the
 *      difference between this file and the browser's bridge, and it is there
 *      for one reason: `Y.applyUpdate` has no rollback, and a document that has
 *      taken half of a malformed update is in a state nobody promised anything
 *      about. In the browser that document belongs to one person and
 *      `applyCircuitUpdate`'s refusal is enough. Here it belongs to everybody in
 *      the session, so a peer must not be able to poison it — and the honest
 *      way to refuse an update is to refuse it before it lands, not to try to
 *      undo it afterwards. `@qsim/collab` deliberately does not do this itself
 *      (a scratch copy per keystroke is what `update.ts` rules out); a decode is
 *      one linear pass and buys the property outright.
 *
 *   3. **Applied, then projected, then validated.** `applyCircuitUpdate` runs
 *      `projectCircuit` and `validateCircuit` over the result. Note what this
 *      does *not* mean: it is not a gate on convergence. The CRDT layer's
 *      decision (`project.ts`) is that a merged document converges and the
 *      *projection* partitions it — every peer places operations in one
 *      deterministic order, keeps what fits and defers the rest — so the
 *      projection is valid by construction and this check is the assertion of
 *      that, not the enforcement of it.
 *
 *   4. **Fanned out only if all three passed.** A refused update reaches no
 *      other peer and is never persisted, so a peer that sends nonsense makes
 *      its own document strange and nobody else's.
 *
 * ── The one case that decides whether this design is coherent ─────────────
 *
 * What if a well-formed update, correctly applied, yields a projection
 * `validateCircuit` refuses? By `project.ts` that cannot happen; if it does, it
 * is a bug in the projection rather than an attack, and the two available
 * responses are opposite. Accept-and-mark would leave every peer holding a
 * document the relay has declared invalid, with no way back — the document
 * cannot be un-applied. So the update is **refused**: the sender is told
 * `VALIDATION_FAILED`, and because the bytes were already integrated into this
 * process's copy, the document is dropped and every peer is asked to rejoin
 * (`gone`). They rebuild from the last good persisted state, which is the last
 * state that projected cleanly.
 *
 * That is deliberately consistent with the CRDT layer rather than a second
 * opinion about validity: the layer's promise is "the projection is always a
 * legal circuit", and the relay's response to that promise failing is to stop
 * serving the document rather than to invent a repair. A reader that writes is
 * how a CRDT diverges (`project.ts`), and a relay that repaired one would be
 * exactly that reader.
 *
 * ═══════════════════════════════════════════════════════════════════════
 * PERSISTENCE: THE DOCUMENT SURVIVES EVERYBODY LEAVING
 *
 * The row is `CircuitSession`, one per circuit, and the argument for why a
 * session is not a version is in the schema beside it. What is here is the
 * writing policy, which has three parts and one rule.
 *
 *   - **Debounced.** A write per keystroke would be a write per keystroke on a
 *     pooler whose connection limit is one. `PERSIST_QUIET_MS` after the last
 *     change is when a row is written.
 *   - **Capped.** A session that never goes quiet would never be written, so
 *     `PERSIST_MAX_INTERVAL_MS` forces one. That number is the honest statement
 *     of how much work a crash may cost: fifteen seconds.
 *   - **Flushed on teardown.** The last peer leaving writes immediately, which
 *     is the case the whole row exists for.
 *
 * The rule: **only a projection that validated is ever persisted.** The state is
 * captured at the moment an update is accepted, not read off the document when
 * the timer fires, so a row can never hold bytes that were refused.
 *
 * ═══════════════════════════════════════════════════════════════════════
 * PRESENCE SITS BESIDE THE DOCUMENT, NEVER INSIDE IT (M5.3)
 *
 * A cursor is not part of the circuit, and putting it in the Y.Doc would make it
 * one: merged, tombstoned, persisted into `CircuitSession`, projected by
 * `projectCircuit`, and — the part that decides it — *validated*, so a caret on a
 * cell would be something `validateCircuit` had an opinion about. So the roster
 * is a plain map beside the document (`presence.ts`), it is never written to a
 * row, and dropping the document drops it.
 *
 * The consequences of that separation are worth stating, because they are the
 * three places presence behaves unlike everything else in this file:
 *
 *   - **A missed presence is not a divergence.** An update may never be dropped
 *     (see `MAX_COLLAB_PENDING_DELIVERIES` in `session.ts`); a presence may be
 *     dropped freely, because the next heartbeat restates the whole truth.
 *   - **A peer expires.** No close frame arrives from a killed tab, so a record
 *     dies of old age unless it is renewed. Both ends apply the timeout.
 *   - **Identity is composed here, not asserted there.** A peer says where it is
 *     looking; `session.ts` stamps the name and the access onto it. §11's rule
 *     about presence — a display name, never an email — is enforceable only
 *     because the field is the server's to write.
 *
 * ═══════════════════════════════════════════════════════════════════════
 * TWO REPLICAS
 *
 * A document edited on replica A must reach a peer on replica B. `CollabBus` is
 * that, and `plugins/collab.ts` implements it over the Redis this service
 * already has. Two message kinds are enough for the *document*, because a CRDT
 * does the rest:
 *
 *   - an **update**, republished as it arrived, applied by whoever holds the
 *     document. Both replicas converge; both may persist; the later write wins
 *     and is a superset, because it was written by a document that had seen the
 *     other's updates.
 *   - a **sync**, which closes the one gap a pure fan-out leaves. When B builds
 *     a document it seeds from the persisted row, which may be up to
 *     `PERSIST_QUIET_MS` behind A's memory — and a delta that depends on that
 *     gap sits in Yjs's pending queue forever. So a new document asks, and any
 *     replica holding one answers with its whole state, which merges.
 *
 * A third carries **presence**, and it needs no handshake of its own: a heartbeat
 * is already a periodic broadcast of the whole truth, so a replica that has just
 * built a document learns who is on the others within `PRESENCE_HEARTBEAT_MS`
 * instead of asking. See `CollabMessage`.
 *
 * What is *not* solved, stated plainly because it is the residual risk: Redis
 * pub/sub is at-most-once, so a dropped message can leave two replicas'
 * documents apart until the next sync. Nothing here detects that. The service
 * runs one replica today; if it ever runs several in anger, the answer is either
 * routing a circuit's sockets to one replica or a periodic state-vector
 * exchange between them, and this file is where the second one would go.
 */

import {
  MAX_COLLAB_STATE_BYTES,
  MAX_COLLAB_UPDATE_BYTES,
  circuitChannel,
} from '@qsim/contract'
import type { PresenceState } from '@qsim/contract'
import {
  applyCircuitUpdate,
  documentOf,
  projectCircuit,
  writeCircuit,
} from '@qsim/collab'
import type { Circuit } from '@qsim/schema'
import { emptyCircuit } from '@qsim/schema'
import * as Y from 'yjs'
import { createPresenceRoster, type PresenceRecord } from './presence.js'

/** How long a document waits, unchanged, before it is written. */
export const PERSIST_QUIET_MS = 2_000

/**
 * How long a continuously edited document may go unwritten.
 *
 * The debounce alone is not a policy: a session where somebody is typing never
 * goes quiet, so it would never be written and a redeploy mid-flow would lose
 * the lot. This is the ceiling, and it is the honest statement of what a crash
 * costs — fifteen seconds of one session's edits.
 */
export const PERSIST_MAX_INTERVAL_MS = 15_000

/**
 * How many documents this process will hold at once.
 *
 * Every document is a Y.Doc in memory, up to `MAX_COLLAB_STATE_BYTES` of it, and
 * a read-only peer can bring one into being — anybody who may read a PUBLIC
 * circuit may watch its session. So the ceiling is not about editors, it is
 * about what an anonymous crowd can make this container hold: thirty-two
 * documents is at most thirty-two megabytes of state on a container that has a
 * few hundred, and far more concurrent sessions than this deployment expects.
 * (It was sixty-four while a document was capped at 512 KiB; that cap had to
 * double so a session could carry the largest circuit anybody can *save*, and
 * this halved with it so the memory the pair admits stayed where it was.)
 * Past it a join is refused with `RATE_LIMITED` and the socket stays open.
 */
export const MAX_DOCUMENTS = 32

/**
 * Capacity kept for peers who may *write*.
 *
 * Both ceilings used to be first-come with no distinction between reading and
 * writing, and that inverts what they are for. §3.4 admits watchers precisely
 * because a circuit has exactly one writer, so a crowd of watchers filling the
 * slots locked the owner out of their own live session: sixteen anonymous read
 * peers filled a document and the owner's write attach was refused
 * `too-many-peers`; sixty-four watched circuits filled the replica and every
 * further join anywhere, owners included, was refused `too-many-documents`. A
 * resource ceiling reached by readers must not be the thing that removes the
 * writer's access.
 *
 * So a reader is refused a little earlier than a writer, which is the whole
 * mechanism: no eviction, no priority queue, no way for a reader to take the
 * last slot. Two is enough because a circuit has one writer and a second tab of
 * theirs is the realistic case.
 */
export const RESERVED_FOR_WRITERS = 2

/**
 * How many peers may attach to one document.
 *
 * §3.4 describes two people editing; a classroom watching one is the case that
 * makes this bigger than two. Every peer is a listener in a fan-out loop that
 * runs on every update, so this bounds the work one update costs as well as the
 * memory: sixteen peers × 120 updates per ten seconds is the busiest thing one
 * circuit can ask of this process.
 */
export const MAX_PEERS_PER_DOCUMENT = 16

/** Why a document was dropped, as a peer is told. */
export type DropReason = 'gone'

export interface DocumentPorts {
  /**
   * The last saved circuit, for seeding a document nobody has a session for.
   * `null` when the circuit has no version — which cannot happen through the
   * REST surface (creating a circuit creates version 1) and is handled anyway.
   */
  readonly latestCircuit: (circuitId: string) => Promise<Circuit | null>
  /** The live document, or null. See `CircuitSession` in the schema. */
  readonly loadSession: (
    circuitId: string
  ) => Promise<{ state: Uint8Array } | null>
  readonly saveSession: (circuitId: string, state: Uint8Array) => Promise<void>
  readonly dropSession: (circuitId: string) => Promise<void>
  /** Cross-replica fan-out, or `null` for a single-instance deployment. */
  readonly bus: CollabBus | null
  readonly now: () => number
  /**
   * Schedules `run` in `ms`. Injected so a test can drive the debounce without
   * waiting for it, and so the handle can be cleared on teardown.
   */
  readonly schedule: (run: () => void, ms: number) => () => void
  readonly log: (
    level: 'info' | 'warn' | 'error',
    fields: Record<string, unknown>,
    message: string
  ) => void
}

/**
 * Cross-replica fan-out for one circuit's document.
 *
 * A port rather than an import, for the reason every other Redis consumer in
 * this app is one: `null` is a supported deployment (no REDIS_URL) and a test
 * that needs two replicas needs two registries over one bus it can inspect.
 */
export interface CollabBus {
  publish(channel: string, message: CollabMessage): Promise<void>
  subscribe(
    channel: string,
    listener: (message: CollabMessage) => void
  ): Promise<() => void>
}

/**
 * What crosses between replicas.
 *
 * `origin` is the publishing replica's id, so a replica can ignore its own
 * messages — the subscriber is a second connection and Redis delivers a publish
 * back to the publisher.
 */
export type CollabMessage =
  /** An accepted update, to be applied by whoever holds the document. */
  | {
      readonly kind: 'update'
      readonly origin: string
      readonly bytes: Uint8Array
    }
  /** "I have just built this document; whoever has one, tell me about it." */
  | { readonly kind: 'sync-request'; readonly origin: string }
  /** A whole document state, in answer to the above. */
  | {
      readonly kind: 'sync-state'
      readonly origin: string
      readonly bytes: Uint8Array
    }
  /**
   * Where a peer on another replica is looking, or `null` for one that has gone.
   *
   * Presence crosses replicas and the *roster* deliberately does not: there is
   * no `presence-request` beside `sync-request`, because a heartbeat is already
   * a periodic broadcast of the whole truth. A replica that has just built a
   * document learns about the peers on the others within
   * `PRESENCE_HEARTBEAT_MS` — ten seconds — with no handshake, no fan-out storm
   * on every join, and no state to reconcile. That delay is the cost, it is
   * stated rather than hidden, and it is paid only in a deployment that runs
   * more than one replica, which this one does not.
   */
  | {
      readonly kind: 'presence'
      readonly origin: string
      readonly peerId: string
      readonly state: PresenceState | null
    }
  /**
   * "A version was written for this circuit; give up your copy of the document."
   *
   * The replica that served the REST call brings its own document in line (see
   * `settle`), which is the gentle answer and the one the peers who are actually
   * editing get. A replica that merely *holds* a copy cannot be sent a diff — the
   * diff was computed against a document it may not have — so it is asked to drop
   * it instead: its peers rejoin, and a rejoin seeds from the row or the head
   * version, both of which are now the version that was written.
   */
  | { readonly kind: 'settled'; readonly origin: string }

/** What a peer is handed when it attaches. */
export interface DocumentAttachment {
  readonly access: 'write' | 'read'
  /**
   * Everybody else already in the session, for the frames a joiner is sent.
   *
   * Expired records are pruned as this is read, and the peers that went are
   * announced to everybody — see `PresenceRoster.prune`. It excludes the
   * attaching peer itself, which knows where its own cursor is.
   */
  readonly roster: () => readonly PresenceRecord[]
  /**
   * States where this peer is, or `null` to say it has gone.
   *
   * Fanned out to every other peer here and published to the other replicas.
   * Never echoed back to this peer. It is deliberately not validated beyond the
   * contract's schema: presence is self-asserted by design (see
   * `PresencePositionSchema`), and the two fields that are not — `name` and
   * `access` — are composed by `session.ts` from what the socket proved.
   */
  readonly publishPresence: (state: PresenceState | null) => void
  /**
   * Everything this peer is missing, as one update.
   *
   * `since` is the peer's state vector, or `null` for a peer with nothing. The
   * difference rather than the whole document is what makes a reconnect cheap
   * and, more to the point, what makes it correct: a peer that edited while
   * disconnected keeps its edits and is sent only the gap.
   */
  readonly missing: (since: Uint8Array | null) => Uint8Array | null
  /**
   * This document's state vector, so a joiner can send back what the *session*
   * is missing.
   *
   * `missing` closes the gap in one direction only. A peer that edited while it
   * was disconnected keeps its edits — that is the CRDT working — and nothing ever
   * asked it for them, so it stayed diverged from everybody until it volunteered
   * its whole document. With this it computes a delta instead, which is one small
   * frame rather than one that may not fit.
   */
  readonly vector: () => Uint8Array
  readonly deferred: number
  readonly overflow: number
  /** Applies an update this peer sent. Never throws. */
  readonly apply: (update: Uint8Array) => ApplyOutcome
  readonly detach: () => void
}

export type ApplyRefusal =
  /** Past `MAX_COLLAB_UPDATE_BYTES`. Refused before being decoded. */
  | 'too-large'
  /** Yjs could not decode it. The document was not touched. */
  | 'malformed'
  /** A version this build cannot read, or a projection it cannot accept. */
  | 'invalid'
  /** The document would exceed `MAX_COLLAB_STATE_BYTES`. */
  | 'document-too-large'

export type ApplyOutcome =
  | {
      readonly ok: true
      readonly deferred: number
      readonly overflow: number
      /**
       * How much document this update made the relay reproject, in operations.
       *
       * Reported rather than metered here because the budget belongs to the
       * *socket* and a document may have several attached to it — see
       * `MAX_COLLAB_WORK_PER_WINDOW`. It is the honest measure of what an
       * accepted update cost, which the byte count is not: the projection is
       * linear in the document.
       */
      readonly work: number
    }
  | { readonly ok: false; readonly reason: ApplyRefusal }

export interface DocumentRegistry {
  /**
   * Attaches a peer, building or resuming the document as needed.
   *
   * `deliver` receives every update that reaches the document from anywhere
   * except this peer. It must not throw and must not be slow: it is called
   * inside the fan-out loop.
   */
  attach(input: {
    circuitId: string
    /**
     * This connection's opaque handle inside the session — minted by
     * `session.ts`, one per socket. It is what makes `detach` able to take a
     * cursor off everybody's screen without being told twice.
     */
    peerId: string
    access: 'write' | 'read'
    deliver: (update: Uint8Array) => void
    /** Somebody else's presence, or `null` for a peer that has gone. */
    deliverPresence: (peerId: string, state: PresenceState | null) => void
    dropped: (reason: DropReason) => void
  }): Promise<DocumentAttachment | { readonly refused: AttachRefusal }>
  /**
   * Bring the live document in line with a version that has just been written.
   *
   * ── Why deleting the `CircuitSession` row is necessary and not sufficient ──
   *
   * §3.4 M5.2 decision 3 rests on one sentence: `appendVersion` deletes the
   * session row in the same transaction that writes the version, "which is what
   * makes restoring version 3 not undo itself". `seed` relies on the other half
   * of it — a row that exists is newer than the last version *by construction*.
   *
   * A restore breaks the construction, deliberately: it writes a version that is
   * **older** than the document the relay is holding. The delete was invisible to
   * this registry, so the armed debounce fired and put the pre-restore document
   * straight back into the row — with no further user action at all — and the next
   * person to open the circuit was seeded from it. `GET /circuits/:id` answered
   * the restored circuit while `collab:join` handed out the one it replaced.
   *
   * So a version append settles the document too. A diff rather than a drop,
   * because the diff is what a person asked for: every peer's canvas becomes the
   * version that was restored, in one ordinary update, and an *ordinary* save —
   * where the version equals what the session already holds — produces no update
   * at all and disturbs nobody.
   */
  settle(circuitId: string, circuit: Circuit): void
  /** For the shutdown hook: flush every document and let them all go. */
  close(): Promise<void>
  /** For tests and log lines, never for a decision. */
  documentCount(): number
}

export type AttachRefusal =
  /** This process already holds `MAX_DOCUMENTS`. */
  | 'too-many-documents'
  /** This document already holds `MAX_PEERS_PER_DOCUMENT`. */
  | 'too-many-peers'
  /** The circuit has no readable content, or the row could not be read. */
  | 'unavailable'
  /** The stored document is past `MAX_COLLAB_STATE_BYTES`. */
  | 'too-large'

interface Peer {
  readonly peerId: string
  readonly deliver: (update: Uint8Array) => void
  readonly deliverPresence: (
    peerId: string,
    state: PresenceState | null
  ) => void
  readonly dropped: (reason: DropReason) => void
  detached: boolean
}

interface LiveDocument {
  readonly circuitId: string
  readonly doc: Y.Doc
  readonly peers: Set<Peer>
  /**
   * Who is here, including peers attached to another replica.
   *
   * It is *not* derived from `peers`, and that is the point: a peer on replica B
   * is a record here with no socket of its own, and a peer here may have a
   * socket and no presence at all — a client that joined and never sent a
   * position, which is every client for the first frame or two.
   */
  readonly presence: ReturnType<typeof createPresenceRoster>
  /** Unsubscribes from the cross-replica channel. */
  release: (() => void) | null
  /**
   * Whether the document has changed since its last write, awaiting one.
   *
   * A flag and not the bytes. Capturing the whole state at the moment an update
   * was accepted was one `Y.encodeStateAsUpdate` per keystroke — work linear in
   * the *document*, not in the update, which is what the byte budget claims to
   * bound — and it bought nothing: an update that does not project drops the
   * document and deletes the row in the same breath, so there is no path by which
   * bytes that were refused can be persisted. The state is therefore read when
   * the timer fires, from a document every accepted update left projectable.
   */
  pending: boolean
  /**
   * The document's encoded size the last time it was measured, and how many
   * bytes of update have been accepted since.
   *
   * The pair is what makes the document ceiling enforceable without a full
   * re-encode per update. `measured + sinceMeasured` is an upper bound on the
   * present size — an update cannot add more to a state than it carries — so the
   * expensive measurement is only taken when that bound reaches the ceiling. The
   * work is then amortised over `MAX_COLLAB_STATE_BYTES` of traffic, which is
   * what "the byte budget bounds the work" has to mean if it is to mean anything.
   */
  measured: number
  sinceMeasured: number
  /** Cancels the debounce timer, when one is armed. */
  cancelTimer: (() => void) | null
  /** When the current unwritten run of changes began. */
  dirtySince: number
  deferred: number
  overflow: number
  dropping: boolean
}

/**
 * The origin every locally applied update carries into the document.
 *
 * A sentinel object rather than a string: `applyCircuitUpdate` puts it on the
 * transaction, and nothing in this process reads it — it exists so that a future
 * `Y.UndoManager` or observer on the server could tell a relayed change from a
 * seeded one, and so the origin is never accidentally equal to the browser
 * bridge's.
 */
const RELAY_ORIGIN = { qsim: 'relay' }

export function createDocumentRegistry(
  ports: DocumentPorts,
  replicaId: string
): DocumentRegistry {
  const documents = new Map<string, LiveDocument>()
  /**
   * Documents being built, so two peers arriving together share one.
   *
   * Without it, two `collab:join` frames for one circuit — two tabs, or a peer
   * on each of two sockets — each await the database and each build a document,
   * and the second silently replaces the first: the peers attached to the first
   * would then be in a session nobody else can see.
   */
  const building = new Map<string, Promise<LiveDocument | AttachRefusal>>()
  let closed = false

  function summarise(live: LiveDocument): void {
    const projection = projectCircuit(live.doc)
    live.deferred = projection.deferred.length
    live.overflow = projection.overflow
  }

  /* ── persistence ─────────────────────────────────────────────────────── */

  async function flush(live: LiveDocument): Promise<void> {
    if (!live.pending) return
    live.pending = false
    live.cancelTimer?.()
    live.cancelTimer = null
    const state = Y.encodeStateAsUpdate(live.doc)
    live.measured = state.byteLength
    live.sinceMeasured = 0
    try {
      await ports.saveSession(live.circuitId, state)
    } catch (error) {
      /*
       * Logged and dropped, never propagated. This runs on a timer and on the
       * teardown path, where a rejection is an unhandled one; and the failure it
       * reports is "this session's work may be lost if everyone leaves now",
       * which is not worth severing live connections over. The peers all still
       * hold the document.
       */
      ports.log(
        'warn',
        { circuitId: live.circuitId, err: error },
        'could not persist a collaborative document'
      )
    }
  }

  /**
   * Records that the document changed, and arms the writer.
   *
   * Two clocks in one function: the quiet timer, re-armed on every change, and
   * the ceiling, which is not re-armed and therefore fires even under a stream
   * of edits that never goes quiet.
   */
  function markDirty(live: LiveDocument): void {
    const now = ports.now()
    if (!live.pending) live.dirtySince = now
    live.pending = true
    live.cancelTimer?.()
    const elapsed = now - live.dirtySince
    const wait = Math.max(
      0,
      Math.min(PERSIST_QUIET_MS, PERSIST_MAX_INTERVAL_MS - elapsed)
    )
    live.cancelTimer = ports.schedule(() => {
      live.cancelTimer = null
      void flush(live)
    }, wait)
  }

  /* ── fan-out ─────────────────────────────────────────────────────────── */

  function fanOut(
    live: LiveDocument,
    update: Uint8Array,
    from: Peer | null
  ): void {
    for (const peer of live.peers) {
      if (peer === from || peer.detached) continue
      try {
        peer.deliver(update)
      } catch (error) {
        // One peer's failure must not deafen the others, exactly as in the run
        // event bus. A socket that cannot be written to is closed by its own
        // route, not by this loop.
        ports.log(
          'warn',
          { circuitId: live.circuitId, err: error },
          'a collaboration peer could not be delivered to'
        )
      }
    }
  }

  /**
   * Somebody's presence, to everybody except its author.
   *
   * Its own loop rather than a generalisation of `fanOut`, because the payloads
   * are different in the one way that matters here: an update is bytes every peer
   * must receive or diverge, and a presence is a statement that will be restated
   * in ten seconds. So a failure to deliver one is logged at the same place and
   * means much less, and — the reason they cannot share a loop — the peer to skip
   * is identified differently: an update skips the *connection* it arrived on,
   * while a presence skips the *peer id* it describes, which may not be attached
   * here at all.
   */
  function fanOutPresence(
    live: LiveDocument,
    peerId: string,
    state: PresenceState | null
  ): void {
    for (const peer of live.peers) {
      if (peer.peerId === peerId || peer.detached) continue
      try {
        peer.deliverPresence(peerId, state)
      } catch (error) {
        ports.log(
          'warn',
          { circuitId: live.circuitId, err: error },
          'a collaboration peer could not be told about a presence'
        )
      }
    }
  }

  /**
   * Expires stale presences and tells everybody who went.
   *
   * Called wherever the roster is about to be used — a publish, a join — which
   * is what keeps a ghost from being handed to a joiner as somebody who is here.
   * See `presence.ts` rule 2 for why this is lazy rather than a timer.
   */
  function prunePresence(live: LiveDocument): void {
    for (const peerId of live.presence.prune(ports.now())) {
      fanOutPresence(live, peerId, null)
    }
  }

  /**
   * Gives up a document and tells every peer to rejoin.
   *
   * The two reasons it happens are opposite in cause and identical in the right
   * response: the process is shutting down, or the document reached a state this
   * relay will not serve. In both cases a peer's own copy is still good — Yjs
   * will merge it into whatever it is given next — so `gone` is an instruction
   * to rejoin and not a report of lost work.
   */
  function drop(live: LiveDocument, keepRow: boolean): void {
    if (live.dropping) return
    live.dropping = true
    documents.delete(live.circuitId)
    live.cancelTimer?.()
    live.cancelTimer = null
    live.release?.()
    live.release = null
    const peers = [...live.peers]
    live.peers.clear()
    for (const peer of peers) {
      if (peer.detached) continue
      peer.detached = true
      try {
        peer.dropped('gone')
      } catch {
        /* the peer's socket is its route's problem */
      }
    }
    if (keepRow) return
    /*
     * The row goes with it. This is the "the document reached a state this relay
     * will not serve" case, and leaving the row would mean every rejoin loads
     * the same unserveable bytes and is refused again — a session nobody can
     * ever open. Dropping it costs the unsaved tail of one session and lets the
     * next join seed cleanly from the last saved version, which is a state
     * somebody chose.
     */
    void ports.dropSession(live.circuitId).catch((error: unknown) => {
      ports.log(
        'warn',
        { circuitId: live.circuitId, err: error },
        'could not forget an unserveable collaborative document'
      )
    })
  }

  /* ── building ────────────────────────────────────────────────────────── */

  /**
   * Seeds a document: the live row if there is one, otherwise the head version.
   *
   * The row wins because it is newer *by construction* rather than by a
   * comparison of clocks — `appendVersion` deletes it in the same transaction
   * that writes a version, so a row that exists is a row written after the last
   * save. That is the whole of the reconciliation between an immutable history
   * and a continuous session, and it is what makes "restore version 3" work: the
   * restore appends a version, the row goes, and the next session starts from
   * what was restored.
   */
  async function seed(circuitId: string): Promise<Y.Doc | AttachRefusal> {
    let stored: { state: Uint8Array } | null
    try {
      stored = await ports.loadSession(circuitId)
    } catch (error) {
      ports.log(
        'warn',
        { circuitId, err: error },
        'could not read a collaborative document'
      )
      return 'unavailable'
    }

    if (stored !== null) {
      if (stored.state.byteLength > MAX_COLLAB_STATE_BYTES) {
        // Refused rather than truncated, and the row is left alone: a person has
        // to look at a document this big, and the last saved version is still
        // reachable through the ordinary editor.
        ports.log(
          'warn',
          { circuitId, bytes: stored.state.byteLength },
          'a stored collaborative document is past the size ceiling'
        )
        return 'too-large'
      }
      const doc = new Y.Doc()
      const applied = applyCircuitUpdate(doc, stored.state, {
        origin: RELAY_ORIGIN,
        maxBytes: MAX_COLLAB_STATE_BYTES,
      })
      if (applied.ok) return doc
      /*
       * A row this build cannot read back as a circuit. It was written by a
       * process that validated it, so this is version skew or corruption rather
       * than an attack — and either way the honest move is to forget it and
       * start from the last saved version, which is a state a person chose.
       */
      ports.log(
        'warn',
        { circuitId, reason: applied.reason },
        'a stored collaborative document did not project; seeding from the head version'
      )
      await ports.dropSession(circuitId).catch(() => undefined)
    }

    let circuit: Circuit | null
    try {
      circuit = await ports.latestCircuit(circuitId)
    } catch (error) {
      ports.log(
        'warn',
        { circuitId, err: error },
        'could not read a circuit’s head version'
      )
      return 'unavailable'
    }
    /*
     * A circuit with no version is unreachable through the REST surface, which
     * creates version 1 with the circuit. An empty single-wire document is still
     * the right answer rather than a refusal: it is what the editor shows for a
     * circuit it cannot load, and a session is not the place to discover that a
     * row is broken.
     */
    return documentOf(circuit ?? emptyCircuit(1, 0), RELAY_ORIGIN)
  }

  /** Applies a message from another replica. */
  function receiveRemote(live: LiveDocument, message: CollabMessage): void {
    if (message.origin === replicaId || live.dropping) return

    if (message.kind === 'presence') {
      /*
       * A peer on another replica. Recorded in the roster so that a joiner here
       * is told about them, and delivered to every local peer — but never
       * republished, for the same reason a relayed update is not: the replica
       * that originated it already published it, and a republish would be a loop
       * with as many hops as there are replicas.
       *
       * A record that does not fit is dropped silently. It is a cursor on a
       * container that is already holding thirty-two of them; the peer's own
       * heartbeat retries in ten seconds and an expiry will have made room.
       */
      if (message.state === null) {
        if (live.presence.remove(message.peerId)) {
          fanOutPresence(live, message.peerId, null)
        }
        return
      }
      prunePresence(live)
      if (live.presence.publish(message.peerId, message.state, ports.now())) {
        fanOutPresence(live, message.peerId, message.state)
      }
      return
    }

    if (message.kind === 'settled') {
      drop(live, true)
      return
    }

    if (message.kind === 'sync-request') {
      const state = Y.encodeStateAsUpdate(live.doc)
      if (state.byteLength > MAX_COLLAB_STATE_BYTES) return
      void ports.bus
        ?.publish(circuitChannel(live.circuitId), {
          kind: 'sync-state',
          origin: replicaId,
          bytes: state,
        })
        .catch(() => undefined)
      return
    }

    /*
     * Both remaining kinds are bytes to integrate, and both are bounded — an
     * update by the transport ceiling, a whole state by the document ceiling.
     * They are decoded before they are applied for the same reason a client's
     * update is: another replica is a peer this process does not control either,
     * and a poisoned document would take every local peer with it.
     */
    const ceiling =
      message.kind === 'sync-state'
        ? MAX_COLLAB_STATE_BYTES
        : MAX_COLLAB_UPDATE_BYTES
    if (message.bytes.byteLength > ceiling) return
    try {
      Y.decodeUpdate(message.bytes)
    } catch {
      ports.log(
        'warn',
        { circuitId: live.circuitId, kind: message.kind },
        'a replica published bytes that are not a Yjs update'
      )
      return
    }
    const applied = applyCircuitUpdate(live.doc, message.bytes, {
      origin: RELAY_ORIGIN,
      maxBytes: ceiling,
    })
    if (!applied.ok) {
      ports.log(
        'warn',
        { circuitId: live.circuitId, reason: applied.reason },
        'a replica’s update left the document unprojectable'
      )
      drop(live, false)
      return
    }
    live.deferred = applied.projection.deferred.length
    live.overflow = applied.projection.overflow
    live.sinceMeasured += message.bytes.byteLength
    /*
     * Delivered to every local peer and *not* republished — the replica that
     * originated it already published it, and a republish would be a loop with
     * as many hops as there are replicas.
     *
     * Not marked dirty either: the replica that accepted the edit from its own
     * client is the one that owes the row a write. Two replicas persisting the
     * same convergent document is harmless but pointless, and this keeps a
     * container full of watchers from writing.
     */
    fanOut(live, message.bytes, null)
  }

  async function build(
    circuitId: string
  ): Promise<LiveDocument | AttachRefusal> {
    const seeded = await seed(circuitId)
    if (typeof seeded === 'string') return seeded
    if (closed) return 'unavailable'

    const live: LiveDocument = {
      circuitId,
      doc: seeded,
      peers: new Set(),
      presence: createPresenceRoster(),
      release: null,
      pending: false,
      measured: Y.encodeStateAsUpdate(seeded).byteLength,
      sinceMeasured: 0,
      cancelTimer: null,
      dirtySince: ports.now(),
      deferred: 0,
      overflow: 0,
      dropping: false,
    }
    summarise(live)
    documents.set(circuitId, live)

    const bus = ports.bus
    if (bus !== null) {
      const channel = circuitChannel(circuitId)
      try {
        live.release = await bus.subscribe(channel, (message) => {
          receiveRemote(live, message)
        })
        /*
         * The document was seeded from a row that may be up to
         * `PERSIST_QUIET_MS` behind another replica's memory, and a delta that
         * depends on that gap would sit in Yjs's pending queue forever. So ask.
         * Whoever holds the document answers with its whole state, which merges.
         */
        await bus.publish(channel, { kind: 'sync-request', origin: replicaId })
      } catch (error) {
        /*
         * The session works anyway, for every peer on *this* replica. Degrading
         * rather than refusing is right because the common deployment has one
         * replica, where the bus does nothing at all — refusing the join would
         * turn a Redis blip into "collaboration is down" on a service where it
         * is not.
         */
        ports.log(
          'warn',
          { circuitId, err: error },
          'a collaborative document has no cross-replica fan-out'
        )
      }
    }
    return live
  }

  /* ── the registry ────────────────────────────────────────────────────── */

  return {
    async attach({
      circuitId,
      peerId,
      access,
      deliver,
      deliverPresence,
      dropped,
    }) {
      if (closed) return { refused: 'unavailable' }

      let live = documents.get(circuitId)
      if (live === undefined) {
        /*
         * The ceiling is checked before the database is read, and before a place
         * in `building` is taken — the same ordering `subscribe` uses in
         * `session.ts`, for the same reason: a caller already over the limit must
         * not be able to buy a query with a frame.
         */
        const documentCeiling =
          access === 'write'
            ? MAX_DOCUMENTS
            : MAX_DOCUMENTS - RESERVED_FOR_WRITERS
        if (documents.size + building.size >= documentCeiling) {
          return { refused: 'too-many-documents' }
        }
        const started =
          building.get(circuitId) ??
          build(circuitId).finally(() => {
            building.delete(circuitId)
          })
        building.set(circuitId, started)
        const built = await started
        if (typeof built === 'string') return { refused: built }
        live = built
      }

      // Re-read: the document may have been dropped while this call awaited.
      if (live.dropping || documents.get(circuitId) !== live) {
        return { refused: 'unavailable' }
      }
      const peerCeiling =
        access === 'write'
          ? MAX_PEERS_PER_DOCUMENT
          : MAX_PEERS_PER_DOCUMENT - RESERVED_FOR_WRITERS
      if (live.peers.size >= peerCeiling) {
        return { refused: 'too-many-peers' }
      }

      const peer: Peer = {
        peerId,
        deliver,
        deliverPresence,
        dropped,
        detached: false,
      }
      live.peers.add(peer)
      const attached = live

      return {
        access,

        roster: () => {
          prunePresence(attached)
          /*
           * Without the attaching peer itself. A rejoin — a reconnect, a second
           * `collab:join` for the same circuit — would otherwise hand a client
           * its own cursor as somebody else's, and the client has no way to tell
           * that it is looking at itself: the peer id is the server's, not
           * something it minted.
           */
          return attached.presence
            .entries()
            .filter((record) => record.peerId !== peerId)
        },

        publishPresence: (state) => {
          if (peer.detached || attached.dropping) return
          if (state === null) {
            if (!attached.presence.remove(peerId)) return
            fanOutPresence(attached, peerId, null)
          } else {
            prunePresence(attached)
            if (!attached.presence.publish(peerId, state, ports.now())) return
            fanOutPresence(attached, peerId, state)
          }
          /*
           * Published to the other replicas *after* the local fan-out, so a
           * Redis stall delays the peers who are not here rather than the ones
           * who are. A failure is logged and dropped: a missed presence is a
           * caret that arrives ten seconds late on another instance, which is
           * what the heartbeat is for.
           */
          void ports.bus
            ?.publish(circuitChannel(attached.circuitId), {
              kind: 'presence',
              origin: replicaId,
              peerId,
              state,
            })
            .catch((error: unknown) => {
              ports.log(
                'warn',
                { circuitId: attached.circuitId, err: error },
                'could not fan a presence out to other replicas'
              )
            })
        },

        missing: (since) => {
          const state =
            since === null
              ? Y.encodeStateAsUpdate(attached.doc)
              : Y.encodeStateAsUpdate(attached.doc, since)
          // Bounded on the way out too. A frame past the ceiling is one no
          // client will parse, so sending it would look like a working join and
          // be a silent one.
          return state.byteLength > MAX_COLLAB_STATE_BYTES ? null : state
        },
        vector: () => Y.encodeStateVector(attached.doc),
        get deferred() {
          return attached.deferred
        },
        get overflow() {
          return attached.overflow
        },

        apply: (update) => {
          if (peer.detached || attached.dropping) {
            return { ok: false, reason: 'malformed' }
          }
          if (update.byteLength > MAX_COLLAB_UPDATE_BYTES) {
            return { ok: false, reason: 'too-large' }
          }
          /*
           * Step 2 of the four in the header. Decoding throws on garbage and
           * touches no document, which is what lets this refusal be a refusal
           * rather than the report of a document already damaged.
           */
          try {
            Y.decodeUpdate(update)
          } catch {
            return { ok: false, reason: 'malformed' }
          }

          const applied = applyCircuitUpdate(attached.doc, update, {
            origin: RELAY_ORIGIN,
            maxBytes: MAX_COLLAB_UPDATE_BYTES,
          })
          if (!applied.ok) {
            /*
             * `projectCircuit` promises this cannot happen (see the header). It
             * has happened, so the bytes are already in this process's document
             * and there is no way back: the document is given up and every peer
             * is asked to rejoin from the last state that validated.
             */
            ports.log(
              'warn',
              { circuitId: attached.circuitId, reason: applied.reason },
              'an update left the shared document unprojectable'
            )
            drop(attached, false)
            return { ok: false, reason: 'invalid' }
          }

          /*
           * The document ceiling, checked against a running bound rather than by
           * re-encoding on every keystroke. `measured + sinceMeasured` cannot be
           * less than the true size, so a document that has not reached the
           * ceiling by that bound has certainly not reached it — and one that has
           * is measured for real, once, and the counter reset. See `measured`.
           */
          attached.sinceMeasured += update.byteLength
          if (
            attached.measured + attached.sinceMeasured >
            MAX_COLLAB_STATE_BYTES
          ) {
            const bytes = Y.encodeStateAsUpdate(attached.doc).byteLength
            attached.measured = bytes
            attached.sinceMeasured = 0
            if (bytes > MAX_COLLAB_STATE_BYTES) {
              /*
               * The update was legal and the document it produced is one this
               * relay cannot serve or store. Accepted here and refused to the
               * sender is not an option — it is already applied — so the session
               * ends and the row goes, which puts everybody back on the last
               * saved version rather than on a document that can never be
               * reopened.
               */
              ports.log(
                'warn',
                { circuitId: attached.circuitId, bytes },
                'a shared document grew past the size ceiling'
              )
              drop(attached, false)
              return { ok: false, reason: 'document-too-large' }
            }
          }

          attached.deferred = applied.projection.deferred.length
          attached.overflow = applied.projection.overflow
          markDirty(attached)
          fanOut(attached, update, peer)
          void ports.bus
            ?.publish(circuitChannel(attached.circuitId), {
              kind: 'update',
              origin: replicaId,
              bytes: update,
            })
            .catch((error: unknown) => {
              // A peer on another replica misses this edit. Logged rather than
              // failed: the peers here are correct, and the sync on the next
              // document build is what recovers a replica that fell behind.
              ports.log(
                'warn',
                { circuitId: attached.circuitId, err: error },
                'could not fan a collaborative update out to other replicas'
              )
            })
          return {
            ok: true,
            deferred: attached.deferred,
            overflow: attached.overflow,
            work:
              applied.projection.circuit.operations.length +
              applied.projection.deferred.length,
          }
        },

        detach: () => {
          if (peer.detached) return
          peer.detached = true
          attached.peers.delete(peer)
          /*
           * The cursor goes with the connection, and it goes *now* rather than at
           * the timeout. A socket that closed is the one reliable signal presence
           * ever gets (see `presence.ts` rule 2), so it would be perverse to
           * leave a caret on screen for thirty seconds after the definitive
           * answer arrived. `peer.detached` is already set, so the fan-out below
           * skips this peer without needing to know that it is the one leaving.
           */
          if (attached.presence.remove(peerId)) {
            fanOutPresence(attached, peerId, null)
            void ports.bus
              ?.publish(circuitChannel(attached.circuitId), {
                kind: 'presence',
                origin: replicaId,
                peerId,
                state: null,
              })
              .catch(() => undefined)
          }
          if (attached.peers.size > 0 || attached.dropping) return
          /*
           * The last peer has gone. Written immediately rather than on the
           * debounce, because this is the case the row exists for: everybody
           * closed their laptop and the next person to open the circuit should
           * find the session where it was left.
           *
           * The document is dropped from the registry only once that write has
           * *landed*, and the ordering is the point. Removing it first left a
           * window — one database round trip wide — in which the circuit had no
           * live document and an out-of-date row, so a rejoin inside it was
           * seeded from the stale row and its first write replaced the state the
           * outgoing peer was still saving. In this deployment
           * `connection_limit=1` usually serialises the two by accident; a pool
           * of two would reopen it, and an accident is not an ordering.
           */
          attached.release?.()
          attached.release = null
          void flush(attached).finally(() => {
            // Unless somebody rejoined in the meantime, in which case the
            // document they are attached to is this one and it stays.
            if (attached.peers.size === 0 && !attached.dropping) {
              documents.delete(attached.circuitId)
            }
          })
        },
      }
    },

    async close() {
      closed = true
      const live = [...documents.values()]
      documents.clear()
      /*
       * Flushed before the peers are told, so a client that reconnects to
       * another replica immediately finds the state this one had. Then dropped
       * with the row kept — the process is going away, the document is not.
       */
      await Promise.all(live.map((entry) => flush(entry)))
      for (const entry of live) {
        documents.set(entry.circuitId, entry)
        drop(entry, true)
      }
    },

    settle(circuitId, circuit) {
      /*
       * Told to every replica whether or not this one holds the document: the one
       * that does may not be the one that served the REST call, and a copy left
       * holding the pre-restore state would write it back within
       * `PERSIST_QUIET_MS`.
       */
      void ports.bus
        ?.publish(circuitChannel(circuitId), {
          kind: 'settled',
          origin: replicaId,
        })
        .catch((error: unknown) => {
          ports.log(
            'warn',
            { circuitId, err: error },
            'could not tell other replicas that a version was written'
          )
        })

      const live = documents.get(circuitId)
      if (live === undefined || live.dropping) return

      /*
       * The update the write produced, captured from the document rather than
       * recomputed: a state-vector diff would also carry anything a peer sent
       * while this call was in flight, and fanning that back out would echo it to
       * its own sender.
       */
      const captured: { update: Uint8Array | null } = { update: null }
      const capture = (update: Uint8Array, origin: unknown): void => {
        if (origin === RELAY_ORIGIN) captured.update = update
      }
      live.doc.on('update', capture)
      try {
        writeCircuit(live.doc, circuit, {
          origin: RELAY_ORIGIN,
          baseline: projectCircuit(live.doc),
        })
      } catch (error) {
        ports.log(
          'warn',
          { circuitId, err: error },
          'could not settle a shared document against a new version'
        )
        return
      } finally {
        live.doc.off('update', capture)
      }
      // An ordinary save: the version is what the session already says, so there
      // is nothing to tell anybody.
      const update = captured.update
      if (update === null) return

      summarise(live)
      live.sinceMeasured += update.byteLength
      markDirty(live)
      fanOut(live, update, null)
      void ports.bus
        ?.publish(circuitChannel(circuitId), {
          kind: 'update',
          origin: replicaId,
          bytes: update,
        })
        .catch(() => undefined)
    },

    documentCount: () => documents.size,
  }
}
