/**
 * One socket's whole behaviour, as a plain object over six ports.
 *
 * There is no `ws` in this file and no Fastify either, for the same reason the
 * browser's scheduler has no `Worker` in it: everything that can go wrong here
 * is a *sequence* — a frame arriving before another, an authorisation that was
 * true and stopped being true, a completion racing a subscription — and a
 * sequencing bug that can only be reproduced through a real socket is a
 * sequencing bug that never gets a regression test. `routes/ws.ts` is the
 * twenty lines that bind this to a real connection.
 *
 * ═══════════════════════════════════════════════════════════════════════
 * THE THREE RULES, IN THE ORDER THEY MATTER
 *
 * 1. AUTHORISATION IS CHECKED AT SUBSCRIBE TIME **AND KEPT TRUE**.
 *
 * The bug this file exists to not have is the one every socket implementation
 * has: the subscription is authorised once, and then events flow for as long as
 * the connection lasts. That is wrong here for a concrete, reachable reason.
 * `simulationRunFilter` does not only ask whether the run belongs to the
 * viewer — it also asks whether the *circuit the run names* is one this viewer
 * may read. An anonymous run over a PUBLIC circuit is readable by whoever holds
 * its id; the owner then sets that circuit to PRIVATE, and the run stops being
 * readable. If the check happened only at subscribe time, a stranger who
 * subscribed a second earlier would go on receiving that run's progress and its
 * completion, past a revocation the owner believes took effect.
 *
 * So every delivery consults a cached decision, and the cache expires after
 * `AUTHORISATION_TTL_MS`. The TTL is not zero because `DATABASE_URL` carries
 * `connection_limit=1`: a query per event, at the four-a-second `shouldReport`
 * already throttles progress to, would queue socket traffic behind the gallery
 * on a pool of one. Two seconds bounds the revocation window at about the time
 * it takes a person to notice, costs at most one query per two seconds per
 * watched run, and — the part that makes it defensible — the events it can
 * leak inside that window carry no result. The *answer* travels over
 * `GET /simulate/:runId`, which re-applies the filter with no cache at all.
 *
 * A subscription that fails the re-check is ended and the client is told
 * (`unsubscribed`, reason `unauthorised`) rather than left silently starved:
 * a stream that goes quiet is indistinguishable from a run that is taking a
 * long time, and a client that cannot tell those apart waits forever.
 *
 * 2. A SUBSCRIPTION IS ORDERED, EVEN THOUGH THE CHECK IS ASYNCHRONOUS.
 *
 * Re-checking authorisation means an `await` between "an event arrived" and "a
 * frame was sent". Without care that turns Redis's ordered stream into whatever
 * order the promises happen to settle in, and a progress bar that goes
 * backwards is a bar the reader stops believing. Each subscription therefore
 * owns a promise chain, and every event is appended to it — so frames leave in
 * the order they arrived, and a slow check delays rather than reorders.
 *
 * Two guards keep that chain from becoming a queue nobody drains. A
 * `run:progress` that has been superseded while it waited is dropped rather
 * than sent, because it describes a moment that has passed; and an event older
 * than one already delivered is dropped outright, which is what `at` is
 * carried for (`@qsim/jobs`' `events.ts`) — pub/sub promises nothing about
 * order across a reconnect.
 *
 * 3. EVERY BOUND IS A BOUND ON WHAT A STRANGER CAN MAKE THIS PROCESS HOLD.
 *
 * §11 does not stop applying because the transport changed. A socket may watch
 * `MAX_SOCKET_SUBSCRIPTIONS` runs and no more; it is closed if it sits with
 * nothing subscribed for `IDLE_TIMEOUT_MS`; it is closed when the token it
 * authenticated with expires, so a connection cannot outlive its credential;
 * a client that sends frames this protocol does not define is closed after a
 * handful rather than answered indefinitely; and a client that sends frames
 * this protocol *does* define, faster than `MAX_SOCKET_FRAMES_PER_WINDOW`, is
 * closed too.
 *
 * That last bound is not a footnote to the others. The upgrade is rate limited
 * once, by Fastify, and a socket is a request that never ends: without a budget
 * on frames, one connection buys unlimited `findReadableRun` calls against a
 * pool of one and unlimited ES256 verifications — the two pieces of work §11
 * singles out as the ones to meter hardest. The ceiling on *successful*
 * subscriptions bounds neither, because both are paid before a subscription
 * succeeds; so the ceiling is now checked before the database is asked, and the
 * budget is checked before anything is.
 *
 * ── An expired credential grants nothing, from the frame that carries it ──
 *
 * A socket's authority ends at its token's `exp` and not at the next sweep.
 * `sweep()` runs on a timer, so enforcing expiry only there left a window —
 * fifteen seconds by default — in which a dead credential still bought *new*
 * subscriptions to that user's private runs, not merely the tail of an old
 * one. Expiry is therefore checked on every frame and before every delivery,
 * and the sweep is what closes a socket nobody is talking on. The three checks
 * are the same predicate, applied wherever authority is about to be used.
 *
 * ═══════════════════════════════════════════════════════════════════════
 * THE COLLABORATION CHANNEL — §8's `circuit:<id>`, Fase 5 (M5.2)
 *
 * A second channel on this socket, not a second socket, because everything
 * above already exists here: an authenticated identity, an authorisation cache
 * that expires, a frame budget, a violation counter, an ordered frame queue and
 * a close vocabulary. A second connection would have meant a second copy of all
 * six, and the one that gets forgotten is the one that matters.
 *
 * It is also the first channel on this socket that **writes**, so the three
 * rules above are joined by three more.
 *
 * 4. WHO MAY WATCH, AND WHO MAY WRITE, ARE DIFFERENT QUESTIONS WITH ONE ANSWER
 *    EACH.
 *
 * Writing is `canEditCircuit`: the owner, and nobody else. §11 makes visibility
 * irrelevant to write access — a PUBLIC circuit is readable by everyone and
 * editable by its owner alone, and forking is how somebody else builds on it —
 * so there is no visibility under which a stranger may send an update. When a
 * grant beyond the owner exists (an invited collaborator), it belongs in
 * `canEditCircuit` and this file changes in one place: `readCircuit` already
 * answers a single question, "may this viewer write, read, or neither".
 *
 * Watching is `findReadable`, which is the same filter `GET /circuits/:id`
 * applies. That admits a read-only peer, and it is a deliberate decision with a
 * consequence worth writing down: **joining the live session of a PUBLIC or
 * UNLISTED circuit shows edits its owner has not saved.** The alternative —
 * only writers may attach — would have made §3.4's shared cursors meaningless,
 * since a circuit has exactly one writer today. The consequence is bounded by
 * the filter doing the admitting: a PRIVATE circuit's only reader is its owner,
 * so unsaved work is exposed only for a circuit whose author has already chosen
 * to publish it or to hand out its slug.
 *
 * Read-only is enforced **here**, on the frame, and not by declining to draw a
 * button: a `collab:update` from a read-only peer is refused with FORBIDDEN and
 * never reaches the document. That is the difference between an interface that
 * discourages something and a server that does not permit it.
 *
 * 5. THE DECISION IS RE-CHECKED WHILE THE SESSION RUNS.
 *
 * A token expires, a circuit is unpublished, an owner revokes access — and an
 * attachment authorised once would outlive all three. So the same cached
 * decision the run subscriptions use is used here, with the same
 * `AUTHORISATION_TTL_MS`, and the argument for a non-zero TTL is *stronger*
 * here rather than weaker: a query per update would be a database round trip per
 * keystroke on a pool of one.
 *
 * What bounds the two-second window is what the window can *reach*. An update
 * accepted inside it changes a scratch document and nothing a reader can see:
 * no version, no gallery card, no run. Anything durable goes through the REST
 * surface, and `appendVersion` re-checks ownership in the same transaction that
 * writes — with no cache at all — so a revocation takes effect immediately for
 * everything that outlives the session. The re-check also runs on **delivery**,
 * so a peer whose read access is withdrawn stops receiving other people's edits.
 *
 * 6. AN UPDATE IS METERED SEPARATELY, BECAUSE IT COSTS SOMETHING ELSE.
 *
 * `MAX_SOCKET_FRAMES_PER_WINDOW` is sixty per ten seconds because every frame it
 * counts is a database read or an ES256 verification. A collaboration update is
 * neither — its authorisation is cached — and counting a slider drag against
 * that budget would close the socket of somebody using the product. So updates
 * have a budget of their own, in two dimensions: `MAX_COLLAB_UPDATES_PER_WINDOW`
 * bounds frames and `MAX_COLLAB_BYTES_PER_WINDOW` bounds work, which is linear
 * in bytes.
 *
 * **A separate budget is not the absence of one.** The exemption above used to be
 * unconditional — a frame of type `collab:update` or `collab:presence` skipped
 * the general budget on the strength of its type alone — while the handlers that
 * charge the collaboration budgets returned early on a missing attachment,
 * *before* charging. So a socket that had never authenticated and never joined
 * anything could push full-sized frames at line rate for free: two thousand
 * 87 KiB frames in three seconds, every one of them a `JSON.parse` and a base64
 * scan, none of them metered, and `lastActivityAt` refreshed each time so the
 * idle timeout never fired either. `collab:leave` reopened the hole.
 *
 * The exemption is therefore *earned*: a collaboration frame skips the general
 * budget only when this socket actually holds an attachment for the circuit it
 * names, which is the only case in which the specialised budget will charge it.
 * Everything else is an ordinary frame and is charged like one.
 *
 * ═══════════════════════════════════════════════════════════════════════
 * PRESENCE — WHO IS HERE AND WHERE THEY ARE LOOKING (M5.3)
 *
 * 7. A PEER SAYS WHERE IT IS LOOKING; THE SERVER SAYS WHO IT IS.
 *
 * `collab:presence` carries a cursor, a selection and a count of committed edits
 * — all self-asserted, all harmless if false (a caret in the wrong place). It
 * does **not** carry a name, and that is the whole shape of §11 applied to
 * presence: the frame that reaches every other browser is composed *here*, from
 * the identity this socket proved (`readViewerName`, which resolves
 * `displayName ?? username` and cannot reach `email`) and from the access
 * decision the attachment already holds. A peer cannot name itself, cannot
 * impersonate another, and cannot claim to be a writer.
 *
 * It has a budget of its own for the reason updates do, and a *different* reason:
 * a presence frame costs no database read and no document work at all — it is a
 * fan-out and a map write — so `MAX_COLLAB_PRESENCE_PER_WINDOW` is set against
 * what a throttled client produces rather than against Postgres.
 *
 * A read-only peer may send it. Nothing it says survives the connection, so the
 * sentence "read-only is enforced on every frame" is not weakened: there is no
 * document write here to refuse. What is enforced is the attachment — a peer
 * whose read access is withdrawn stops being relayed, and stops receiving
 * everybody else's cursors, inside `AUTHORISATION_TTL_MS`.
 *
 * The delivery path is deliberately unlike the update path, and `deliverPresence`
 * argues why: an update may never be dropped, while a presence is replaced by the
 * next one and may be. What it may *not* be is dropped in the steady state, which
 * is what a staleness test with a two-second TTL and a ten-second heartbeat did
 * to every renewal in a quiet session.
 */

import {
  MAX_COLLAB_BYTES_PER_WINDOW,
  MAX_COLLAB_DOCUMENTS_PER_SOCKET,
  MAX_COLLAB_PRESENCE_PER_WINDOW,
  MAX_COLLAB_UPDATES_PER_WINDOW,
  MAX_COLLAB_WORK_PER_WINDOW,
  MAX_PRESENCE_NAME_LENGTH,
  MAX_SOCKET_FRAMES_PER_WINDOW,
  MAX_SOCKET_SUBSCRIPTIONS,
  SOCKET_CLOSE,
  SOCKET_FRAME_WINDOW_MS,
  decodeBinaryPayload,
  encodeBinaryPayload,
  parseClientFrame,
} from '@qsim/contract'
import type {
  CollabAccess,
  CollabEndReason,
  PresencePosition,
  PresenceState,
  ServerFrame,
  SocketCloseCode,
  SocketErrorCode,
} from '@qsim/contract'
import { isTerminalHardwareStatus, isTerminalStatus } from '@qsim/jobs'
import type { HardwareStatus, RunEvent, RunStatus } from '@qsim/jobs'

/**
 * How long an authorisation decision is trusted before it is asked again.
 *
 * See rule 1. Two seconds is chosen against the database's connection budget,
 * not against a threat model that thinks two seconds is safe: what it bounds is
 * the delivery of *notifications*, and the payload they point at is fetched
 * through a route that applies the filter afresh.
 */
export const AUTHORISATION_TTL_MS = 2_000

/**
 * How long a socket may hold no subscription before it is closed.
 *
 * Two minutes. Long enough that a client which finishes one run and starts
 * editing towards the next keeps its connection, short enough that a socket
 * opened and forgotten — by a crawler, by a tab that was closed without the
 * close frame arriving — does not sit in this process's memory indefinitely. A
 * client that wants to hold an idle socket open says so with `ping`, which is
 * what that frame is for.
 */
export const IDLE_TIMEOUT_MS = 120_000

/**
 * How many frames this protocol does not define may arrive before the socket is
 * closed.
 *
 * Not one, because a client mid-deploy can legitimately send a frame from a
 * newer build, and severing the connection over a single unknown message would
 * make every rollout a disconnection storm. Not unbounded, because answering
 * `VALIDATION_FAILED` forever is a free amplifier: one byte in, a frame out.
 */
export const MAX_PROTOCOL_VIOLATIONS = 5

/**
 * What a socket may watch.
 *
 * Two kinds, one subscription mechanism. A client subscribes to an **id**; what
 * kind of thing that id names is decided *here*, when the subscription is
 * authorised, and is then evident to the client from the status that comes back
 * — SUBMITTED and CANCELLED exist only for hardware.
 *
 * That is deliberately not a second `subscribe` frame. A second frame would
 * have meant a second ceiling, a second authorisation path, a second ordering
 * guard and a second delivery chain, all to carry the same sentence: "you are
 * now watching this, and here is where it had got to". The two lifecycles
 * differ in their *statuses*, not in what watching one means.
 */
export type WatchKind = 'run' | 'hardware'

/** A watchable as this session needs it: its kind, its status, nothing else. */
export interface ReadableRun {
  readonly kind: WatchKind
  readonly status: RunStatus | HardwareStatus
}

export type SubscribePort = (
  id: string,
  kind: WatchKind,
  listener: (event: RunEvent) => void
) => Promise<() => void>

/**
 * What a peer may do with one circuit's document, as one answer.
 *
 * One question and not two (`mayRead` plus `mayWrite`) because the two are never
 * independent — writing implies reading — and because a port that answered two
 * booleans would let a caller compose them in the one combination that must not
 * exist. `null` is "no such circuit, or not this viewer's to see", which is the
 * same `null` `findReadable` returns and for the same reason: a socket must not
 * be able to distinguish those two either.
 */
export interface CircuitAccess {
  readonly access: CollabAccess
  /**
   * The circuit's own id, whatever handle was asked about.
   *
   * `findReadable` admits two handles — an id, and the slug that is the *only*
   * way to address an UNLISTED circuit — and everything downstream of a join keys
   * off one of them: the live document, the `CircuitSession` row, and the Redis
   * channel §8 names `circuit:<id>`. Keying those off the handle the frame carried
   * meant a slug join opened a *second*, empty session: the peer was told it
   * could write, handed `emptyCircuit(1, 0)` instead of the circuit that was
   * saved, and its edits reached nobody — the debounced write was refused by the
   * foreign key and only logged. Two documents, two peer sets, one circuit.
   *
   * So the port answers the identity as well as the permission, and this file
   * uses it for everything except the code it reports back to the client, which
   * quotes the handle the client used.
   */
  readonly circuitId: string
}

/**
 * Attaching to a circuit's shared document. `null` for a deployment with
 * collaboration switched off, which answers `SIMULATION_UNAVAILABLE` on the
 * frame rather than closing the socket — the same shape the run feed uses when
 * no queue is configured.
 */
export type AttachPort = (input: {
  circuitId: string
  peerId: string
  access: CollabAccess
  deliver: (update: Uint8Array) => void
  deliverPresence: (peerId: string, state: PresenceState | null) => void
  dropped: () => void
}) => Promise<DocumentPeer | { readonly refused: AttachRefusalCode }>

/** Why an attachment was refused, in the vocabulary this file answers with. */
export type AttachRefusalCode =
  'too-many-documents' | 'too-many-peers' | 'unavailable' | 'too-large'

export interface DocumentPeer {
  readonly missing: (since: Uint8Array | null) => Uint8Array | null
  /** This document's state vector, for the delta a returning peer owes it. */
  readonly vector: () => Uint8Array
  readonly deferred: number
  readonly overflow: number
  /** Everybody else already here, for the frames a joiner is sent. */
  readonly roster: () => readonly {
    readonly peerId: string
    readonly state: PresenceState
  }[]
  /** States where this peer is, or `null` to say it has gone. */
  readonly publishPresence: (state: PresenceState | null) => void
  readonly apply: (update: Uint8Array) =>
    | { readonly ok: true; readonly work: number }
    | {
        readonly ok: false
        readonly reason:
          'too-large' | 'malformed' | 'invalid' | 'document-too-large'
      }
  readonly detach: () => void
}

export interface SocketSessionPorts {
  /**
   * An identity the *upgrade request* already proved, or `null`.
   *
   * Non-null only for a client that could set an `Authorization` header, which
   * a browser cannot — so this is the script case, and it exists so such a
   * client does not have to say twice what it already said. A browser starts
   * anonymous here and sends `authenticate`.
   */
  readonly identity: { userId: string; expiresAt: number } | null
  /** Sends one frame. Must not throw; a dead socket is not this file's problem. */
  readonly send: (frame: ServerFrame) => void
  readonly close: (code: SocketCloseCode) => void
  /**
   * Verifies a bearer token, or rejects.
   *
   * The very verifier `plugins/auth.ts` uses, handed in rather than imported so
   * that this file has no opinion about JWTs — and so the boundary rule that
   * keeps `jose` inside `src/auth` needs no exception for a socket.
   */
  readonly verify: (
    token: string
  ) => Promise<{ userId: string; expiresAt: number }>
  /**
   * The run this id names, if this viewer may read it — §11 applied in the
   * query, exactly as `GET /simulate/:runId` applies it. `null` covers both
   * "no such run" and "not yours", which is what makes the `NOT_FOUND` honest.
   */
  readonly readRun: (
    runId: string,
    viewerId: string | null
  ) => Promise<ReadableRun | null>
  /**
   * The hardware job this id names, if this viewer may read it — §11 applied in
   * the query, exactly as `GET /hardware/jobs/:id` applies it.
   *
   * Asked only when `readRun` answered null, so an id is a run first and a
   * hardware job second. The order costs one extra read on a hardware
   * subscription and keeps the far commoner case at one query; it is safe in
   * either order because both reads are scoped to the same viewer, and the two
   * id spaces are separate tables — a value in one is never a value in the
   * other.
   *
   * `null` when no hardware is configured on this deployment, which is a
   * supported state (see `plugins/hardware.ts`) and produces the same
   * `NOT_FOUND` a stranger's job would.
   */
  readonly readHardwareJob:
    | ((jobId: string, viewerId: string | null) => Promise<ReadableRun | null>)
    | null
  /**
   * Starts delivering a run's events, or `null` when no queue is configured.
   *
   * `null` is a supported state and not a missing port: it is the
   * REDIS_URL-absent case that `plugins/queue.ts` argues for at length, and it
   * produces `SIMULATION_UNAVAILABLE` on the frame rather than a closed socket.
   */
  readonly subscribe: SubscribePort | null
  /**
   * What this viewer may do with this circuit — §11 applied in the query, twice
   * over: `findReadable` decides whether they may watch and `canEditCircuit`
   * whether they may write. See rule 4.
   *
   * `null` when collaboration is not available on this deployment, which is the
   * same first-class state a missing REDIS_URL is for the run feed.
   */
  readonly readCircuit:
    | ((
        circuitId: string,
        viewerId: string | null
      ) => Promise<CircuitAccess | null>)
    | null
  /** `null` alongside `readCircuit`; the two are configured together. */
  readonly attachDocument: AttachPort | null
  /**
   * This viewer's display name, as other peers in a session may see it — §11
   * applied to presence.
   *
   * `null` for a viewer with no row, and never asked at all for an anonymous
   * socket. What it must return is a *public* name: `displayName ?? username`,
   * both of which are already published on every gallery card and profile page.
   * It must never return an email, which is why the port answers a string rather
   * than a user: a port shaped as "give me the user" is one property access away
   * from putting `email` in a frame that goes to everybody in the session, and
   * the projection behind it (`publicUserSelect`) does not even select the
   * column.
   *
   * Asked once per socket and cached for its lifetime. A name that changes
   * mid-session is not worth a query per presence frame on a pool of one.
   */
  readonly readViewerName: ((viewerId: string) => Promise<string | null>) | null
  /**
   * A fresh opaque id for this connection's place in a session.
   *
   * A port so that a test can hand out `peer-1`, `peer-2` and read the frames it
   * expects, and so that this file needs no `node:crypto` — it has no imports
   * from the platform at all, which is what lets its whole state machine be
   * driven synchronously.
   */
  readonly newPeerId: () => string
  readonly now: () => number
  readonly log: (
    level: 'info' | 'warn',
    fields: Record<string, unknown>,
    message: string
  ) => void
}

export interface SocketSession {
  /** One frame off the wire. Never rejects. */
  readonly receive: (raw: string) => Promise<void>
  /**
   * The periodic check for the two things no frame announces: a token that
   * expired, and a socket nobody is using. Called on a timer by the route.
   */
  readonly sweep: () => void
  /** The socket is gone. Releases every subscription. */
  readonly close: () => Promise<void>
  /** For tests and for the log line, never for a decision. */
  readonly viewerId: () => string | null
  readonly subscriptionCount: () => number
  readonly attachmentCount: () => number
}

interface Subscription {
  readonly runId: string
  readonly kind: WatchKind
  release: () => void
  /** When authorisation was last confirmed, in this process's clock. */
  checkedAt: number
  /** `at` of the newest event delivered, so a late one can be dropped. */
  deliveredAt: number
  /** Events appended but not yet delivered — see rule 2. */
  queued: number
  chain: Promise<void>
  ended: boolean
}

/**
 * How many updates may wait for an authorisation re-check before this peer is
 * given up as too slow.
 *
 * The run feed drops a superseded `run:progress` rather than queueing it, because
 * progress describes a moment. **An update may never be dropped**: a CRDT
 * document is the merge of every update, so a peer that silently missed one holds
 * a document nobody else has and cannot know it. So they queue in order, and when
 * the queue outgrows this the attachment is ended with `overloaded` — which tells
 * the peer to rejoin, and a rejoin is a resync.
 *
 * Sixteen is a second of edits at the rate the budget allows, which is far more
 * than one authorisation re-check takes and far less than a queue worth
 * remembering.
 */
export const MAX_COLLAB_PENDING_DELIVERIES = 16

interface Attachment {
  readonly circuitId: string
  /**
   * The handle the *client* named, which every frame about this attachment
   * quotes.
   *
   * `circuitId` above is the resolved id — what keys the document, the row and
   * the channel — and the two differ whenever a peer joined by slug, which is
   * the only handle that reaches an UNLISTED circuit (`findReadable`). The join
   * answer and every refusal already quoted the client's handle, because that is
   * what the client asked about; `collab:update`, `collab:presence` and
   * `collab:left` quoted the resolved id instead, and that asymmetry made a
   * slug-joined session **silently deaf**: the browser's transport drops any
   * frame whose `circuitId` is not the handle it joined with (see
   * `collabSession.ts`), so a watcher who opened an unlisted link saw the
   * document once, at the join, and never another edit or another caret.
   *
   * Found by the two-browser suite in `apps/web/e2e/live`, which is the only
   * test in this repository where one side joins by slug and then waits to be
   * told something.
   */
  readonly handle: string
  /**
   * What this peer was authorised to do at `checkedAt`.
   *
   * Mutable, because it is re-decided: an owner who transfers a circuit keeps
   * read access and loses write access, and that has to be able to happen to a
   * live attachment rather than only to a new one.
   */
  access: CollabAccess
  checkedAt: number
  peer: DocumentPeer | null
  /** Deliveries appended but not yet sent — see `MAX_COLLAB_PENDING_DELIVERIES`. */
  queued: number
  chain: Promise<void>
  ended: boolean
}

export function createSocketSession(ports: SocketSessionPorts): SocketSession {
  const subscriptions = new Map<string, Subscription>()
  const attachments = new Map<string, Attachment>()
  let viewerId: string | null = ports.identity?.userId ?? null
  // `exp` is seconds since the epoch (RFC 7519); this clock is milliseconds.
  let expiresAt: number | null =
    ports.identity === null ? null : ports.identity.expiresAt * 1000
  let violations = 0
  let lastActivityAt = ports.now()
  let closed = false
  /** Frames counted in the current budget window, and when it opened. */
  let framesInWindow = 0
  let windowOpenedAt = ports.now()
  /** The collaboration channel's own budget — see rule 6. */
  let collabUpdatesInWindow = 0
  let collabBytesInWindow = 0
  let collabWorkInWindow = 0
  let collabWindowOpenedAt = ports.now()
  /** And presence's, which meters a third kind of work — see rule 7. */
  let presenceInWindow = 0
  let presenceWindowOpenedAt = ports.now()
  /**
   * This connection's handle inside a session, minted on first use.
   *
   * Lazily, because most sockets in this system watch a run and never join a
   * document, and an id nobody will read is a `randomUUID` nobody needed.
   */
  let peerId: string | null = null
  /**
   * This viewer's display name, and whose it is.
   *
   * Cached for the socket rather than read per presence frame: a name is stable
   * for the length of a session and the read is a query on a pool of one. The
   * second field is what makes the cache correct across `authenticate` — a
   * socket that starts anonymous and then proves an identity must not go on
   * presenting the `null` it resolved while it was anonymous.
   */
  let viewerName: string | null = null
  let viewerNameFor: string | null = null

  ports.send({ type: 'ready', viewer: viewerId, expiresAt })

  function fail(code: SocketErrorCode, runId: string | null): void {
    ports.send({ type: 'error', code, runId })
  }

  function failCircuit(circuitId: string, code: SocketErrorCode): void {
    ports.send({ type: 'collab:error', circuitId, code })
  }

  function shut(code: SocketCloseCode): void {
    if (closed) return
    closed = true
    ports.close(code)
  }

  /**
   * Whether the credential this socket presented has passed its `exp`.
   *
   * Asked wherever authority is about to be used rather than only on the sweep
   * timer — see the header. An anonymous socket has no credential and therefore
   * nothing to expire; what bounds *it* is the idle timeout and the frame
   * budget.
   */
  function credentialExpired(): boolean {
    return expiresAt !== null && ports.now() >= expiresAt
  }

  /**
   * Counts this frame against the window, answering whether it may be handled.
   *
   * A fixed window rather than a sliding one: the point is a ceiling on server
   * work per connection, and the factor-of-two a fixed window allows at a
   * boundary is irrelevant against a budget already two orders of magnitude
   * above what a real client sends.
   */
  function withinFrameBudget(): boolean {
    const now = ports.now()
    if (now - windowOpenedAt >= SOCKET_FRAME_WINDOW_MS) {
      windowOpenedAt = now
      framesInWindow = 0
    }
    framesInWindow += 1
    return framesInWindow <= MAX_SOCKET_FRAMES_PER_WINDOW
  }

  async function authenticate(token: string): Promise<void> {
    let identity: { userId: string; expiresAt: number }
    try {
      identity = await ports.verify(token)
    } catch {
      // The token, never the reason. A socket that distinguished "expired" from
      // "wrong signature" would be an oracle, and the client's answer is the
      // same either way: get a fresh token and reconnect.
      fail('AUTH_INVALID_TOKEN', null)
      return
    }

    if (viewerId !== null && viewerId !== identity.userId) {
      /*
       * A second identity on one socket. Refused by closing rather than by an
       * error frame, because every subscription already open was authorised
       * against the first viewer and there is no honest way to reconcile that
       * — and because no legitimate client does it. A token *refresh* for the
       * same subject is the case this allows, and it is the useful one: it
       * extends the socket past the hour a Supabase token lives, without a
       * reconnect.
       */
      ports.log(
        'warn',
        { viewerId, presented: identity.userId },
        'a socket presented a second identity; closing'
      )
      shut(SOCKET_CLOSE.PROTOCOL)
      return
    }

    viewerId = identity.userId
    expiresAt = identity.expiresAt * 1000
    ports.send({ type: 'ready', viewer: viewerId, expiresAt })
  }

  function endSubscription(
    subscription: Subscription,
    reason: 'unauthorised' | 'finished'
  ): void {
    if (subscription.ended) return
    subscription.ended = true
    subscription.release()
    subscriptions.delete(subscription.runId)
    ports.send({
      type: 'unsubscribed',
      runId: subscription.runId,
      reason,
    })
  }

  /** Whether this viewer may still read the run, asked at most every TTL. */
  async function stillAllowed(subscription: Subscription): Promise<boolean> {
    const now = ports.now()
    // Not subject to the TTL: an expired credential is not a decision that may
    // be cached for two more seconds, it is the end of this socket's authority.
    if (credentialExpired()) return false
    if (now - subscription.checkedAt < AUTHORISATION_TTL_MS) return true
    /*
     * Re-checked against the table the subscription was authorised on, and not
     * against both. Falling back to the other one would let a subscription
     * survive by matching a *different* row that happened to share the id —
     * where the whole point of the re-check is that this exact row is still
     * readable by this viewer.
     */
    const still =
      subscription.kind === 'run'
        ? await ports.readRun(subscription.runId, viewerId)
        : ports.readHardwareJob === null
          ? null
          : await ports.readHardwareJob(subscription.runId, viewerId)
    if (still === null) return false
    subscription.checkedAt = now
    return true
  }

  /** Whether a status of either lifecycle is one nothing leaves. */
  function terminal(status: RunStatus | HardwareStatus): boolean {
    return status === 'SUBMITTED' || status === 'CANCELLED'
      ? isTerminalHardwareStatus(status)
      : isTerminalStatus(status)
  }

  function frameFor(event: RunEvent): ServerFrame | null {
    switch (event.type) {
      case 'run:progress':
        return {
          type: 'run:progress',
          runId: event.runId,
          phase: event.progress.phase,
          completed: event.progress.completed,
          total: event.progress.total,
        }
      case 'job:status':
        return {
          type: 'job:status',
          runId: event.runId,
          status: event.status,
        }
      case 'run:complete':
        return {
          type: 'run:complete',
          runId: event.runId,
          status: event.status,
          durationMs: event.durationMs,
          error: event.error,
        }
      case 'hardware:status':
        return {
          type: 'hardware:status',
          runId: event.runId,
          status: event.status,
          queuePosition: event.queuePosition,
        }
      case 'hardware:complete':
        return {
          type: 'hardware:complete',
          runId: event.runId,
          status: event.status,
          error: event.error,
        }
      default:
        return null
    }
  }

  async function deliver(
    subscription: Subscription,
    event: RunEvent
  ): Promise<void> {
    subscription.queued -= 1
    if (subscription.ended || closed) return
    /*
     * The event has to be about the run the subscription was authorised for.
     * `@qsim/jobs` bounds the incoming `runId` with a schema because the id is
     * echoed into a frame and anything holding the connection string can
     * publish; this is the other half of that argument. Without it, a payload
     * published on one run's channel naming another run is delivered under the
     * *other* run's id — a frame about a run this socket was explicitly refused
     * — and a `run:complete` inside it tears down a subscription whose own run
     * is still going, so the completion it is waiting for can never arrive.
     */
    if (event.runId !== subscription.runId) {
      ports.log(
        'warn',
        { runId: subscription.runId, published: event.runId },
        'an event named a run other than the one it was published for'
      )
      return
    }
    if (credentialExpired()) {
      // See the header: authority ends at `exp`, not at the next sweep.
      shut(SOCKET_CLOSE.EXPIRED)
      return
    }
    /*
     * Superseded while it waited for an authorisation check. Progress describes
     * a moment, and a moment that has already been overtaken is not worth a
     * frame — but a completion is never dropped this way, because it is the one
     * event a client is actually waiting for.
     */
    if (event.type === 'run:progress' && subscription.queued > 0) return
    // Out of order. `at` is the publisher's clock and is compared only against
    // itself, which is the one comparison it is valid for.
    if (event.at < subscription.deliveredAt) return

    /*
     * A hardware event on a run's subscription, or the reverse. The channels
     * are separately namespaced so this is unreachable through Redis routing;
     * it is checked anyway because the *authorisation* was decided about one
     * row, and a frame of the other kind would be a frame about something this
     * socket was never granted.
     */
    const hardwareEvent =
      event.type === 'hardware:status' || event.type === 'hardware:complete'
    if (hardwareEvent !== (subscription.kind === 'hardware')) {
      ports.log(
        'warn',
        { runId: subscription.runId, published: event.type },
        'an event of the wrong kind arrived on a subscription'
      )
      return
    }

    if (!(await stillAllowed(subscription))) {
      ports.log(
        'info',
        { runId: subscription.runId, viewerId },
        'a subscription stopped being readable and was ended mid-stream'
      )
      endSubscription(subscription, 'unauthorised')
      return
    }
    if (subscription.ended || closed) return

    const frame = frameFor(event)
    if (frame === null) return
    subscription.deliveredAt = event.at
    ports.send(frame)

    if (event.type === 'run:complete' || event.type === 'hardware:complete') {
      // Nothing more will ever be published on this channel, so the Redis
      // subscription is released here rather than waiting for a client that
      // may simply close the tab.
      endSubscription(subscription, 'finished')
    }
  }

  async function subscribe(runId: string): Promise<void> {
    const existing = subscriptions.get(runId)

    if (credentialExpired()) {
      /*
       * `subscribe` is the one frame that makes a fresh authorisation decision,
       * so it is the one that must not be answered on a dead credential —
       * otherwise an expired token buys *new* access to a private run rather
       * than merely the tail of a stream it already had. The upgrade refuses an
       * expired token with 401 and `authenticate` refuses it with
       * AUTH_INVALID_TOKEN; this is the same refusal at the third door.
       */
      shut(SOCKET_CLOSE.EXPIRED)
      return
    }

    /*
     * Before the database read, and that order is the point. This ceiling used
     * to be checked after `readRun`, so a socket already at its ceiling still
     * paid a query per frame — an unmetered read on `connection_limit=1` from a
     * connection that had already been told it may watch nothing more.
     */
    if (
      existing === undefined &&
      subscriptions.size >= MAX_SOCKET_SUBSCRIPTIONS
    ) {
      fail('RATE_LIMITED', runId)
      return
    }

    /*
     * A run first, a hardware job second. The order is the common case first
     * and nothing more: both reads apply §11 in the query against the same
     * viewer, so neither can answer for a row the other should have refused.
     */
    const run =
      (await ports.readRun(runId, viewerId)) ??
      (ports.readHardwareJob === null
        ? null
        : await ports.readHardwareJob(runId, viewerId))
    if (run === null) {
      // 404 and never 403, for the reason every read in this API does it: 403
      // would confirm that the run exists.
      fail('NOT_FOUND', runId)
      if (existing !== undefined) endSubscription(existing, 'unauthorised')
      return
    }

    if (existing !== undefined) {
      /*
       * Idempotent. A client that reconnects re-subscribes to everything it was
       * watching, and a duplicate must not cost it a slot or an error — it
       * re-confirms the authorisation and re-states the status, which is
       * exactly what a fresh subscription would have done.
       */
      existing.checkedAt = ports.now()
      ports.send({ type: 'subscribed', runId, status: run.status })
      return
    }

    if (terminal(run.status)) {
      /*
       * Nothing will ever be published for a finished run, so no channel is
       * opened. The `subscribed` frame still goes out carrying the terminal
       * status, which is what tells the client to stop waiting and read the
       * run — and this is the common case for a small run that finished inside
       * the synchronous window while the socket was still opening.
       */
      ports.send({ type: 'subscribed', runId, status: run.status })
      return
    }

    const open = ports.subscribe
    if (open === null) {
      fail('SIMULATION_UNAVAILABLE', runId)
      return
    }

    const subscription: Subscription = {
      runId,
      kind: run.kind,
      release: () => undefined,
      checkedAt: ports.now(),
      deliveredAt: 0,
      queued: 0,
      chain: Promise.resolve(),
      ended: false,
    }
    // Registered before the await so that two `subscribe` frames for one run,
    // arriving back to back, cannot both open a channel.
    subscriptions.set(runId, subscription)

    let release: () => void
    try {
      release = await open(runId, run.kind, (event) => {
        subscription.queued += 1
        subscription.chain = subscription.chain.then(() =>
          deliver(subscription, event)
        )
      })
    } catch (error) {
      subscriptions.delete(runId)
      ports.log(
        'warn',
        { runId, err: error },
        'could not subscribe to a run’s events'
      )
      fail('SIMULATION_UNAVAILABLE', runId)
      return
    }

    if (subscription.ended || closed) {
      // The socket went away while the subscription was being established.
      release()
      subscriptions.delete(runId)
      return
    }

    subscription.release = release
    ports.send({ type: 'subscribed', runId, status: run.status })
  }

  /* ────────────────── the collaboration channel (rules 4-6) ───────────── */

  /**
   * Counts one update against the channel's budget, in both dimensions.
   *
   * A fixed window, like the frame budget above, and for the same reason: what is
   * being bounded is server work per connection, and the factor of two a window
   * boundary allows is irrelevant against a budget an order of magnitude above
   * what a real client sends.
   */
  function withinCollabBudget(bytes: number): boolean {
    const now = ports.now()
    if (now - collabWindowOpenedAt >= SOCKET_FRAME_WINDOW_MS) {
      collabWindowOpenedAt = now
      collabUpdatesInWindow = 0
      collabBytesInWindow = 0
      collabWorkInWindow = 0
    }
    collabUpdatesInWindow += 1
    collabBytesInWindow += bytes
    return (
      collabUpdatesInWindow <= MAX_COLLAB_UPDATES_PER_WINDOW &&
      collabBytesInWindow <= MAX_COLLAB_BYTES_PER_WINDOW
    )
  }

  /**
   * Charges what an accepted update actually cost the relay — rule 6, third
   * dimension.
   *
   * Charged *after* the fact and not before, because the cost is not knowable
   * from the frame: it is linear in the document, which the relay knows and the
   * frame does not. So the update that crosses the ceiling is served and the
   * socket is closed behind it, which is the same shape the byte budget has at a
   * window boundary and is bounded by one update's worth of work.
   */
  function withinCollabWorkBudget(work: number): boolean {
    collabWorkInWindow += work
    return collabWorkInWindow <= MAX_COLLAB_WORK_PER_WINDOW
  }

  /**
   * Counts one presence frame against its own budget — see rule 7.
   *
   * A fixed window, like the other two, and the same argument applies: what is
   * bounded is server work per connection, and a factor of two at a window
   * boundary is irrelevant against a budget well above what a throttled client
   * produces.
   */
  function withinPresenceBudget(): boolean {
    const now = ports.now()
    if (now - presenceWindowOpenedAt >= SOCKET_FRAME_WINDOW_MS) {
      presenceWindowOpenedAt = now
      presenceInWindow = 0
    }
    presenceInWindow += 1
    return presenceInWindow <= MAX_COLLAB_PRESENCE_PER_WINDOW
  }

  /** This connection's peer id, minted once. */
  function myPeerId(): string {
    peerId ??= ports.newPeerId()
    return peerId
  }

  /**
   * The name other peers see, or `null`.
   *
   * `null` covers three different situations on purpose, because they are one
   * situation to a reader: this socket never authenticated, the deployment has no
   * name to give, or the row could not be read. All three mean "somebody is here
   * and I cannot tell you who", and the *word* for that is the client's to choose
   * — D2 puts every user-facing string in three catalogs, so a server that
   * answered "Anonymous" would be sending English to a French reader.
   */
  async function displayName(): Promise<string | null> {
    const viewer = viewerId
    if (viewerNameFor === viewer) return viewerName
    viewerNameFor = viewer
    viewerName = null
    const read = ports.readViewerName
    if (viewer === null || read === null) return null
    try {
      const name = await read(viewer)
      // Truncated rather than refused: see `MAX_PRESENCE_NAME_LENGTH`. A name is
      // not something the peer chose in this frame, so refusing it would hide a
      // person from a session over the length of their own display name.
      viewerName =
        name === null || name.length === 0
          ? null
          : name.slice(0, MAX_PRESENCE_NAME_LENGTH)
    } catch (error) {
      ports.log(
        'warn',
        { viewerId: viewer, err: error },
        'could not read a viewer’s display name for presence'
      )
    }
    // The read may have raced `authenticate`. Whatever the viewer is *now* is
    // what the cache must describe, so a name resolved for a viewer this socket
    // has since stopped being is thrown away rather than shown.
    if (viewerNameFor !== viewerId) {
      viewerNameFor = null
      viewerName = null
      return null
    }
    return viewerName
  }

  function endAttachment(
    attachment: Attachment,
    reason: CollabEndReason
  ): void {
    if (attachment.ended) return
    attachment.ended = true
    attachment.peer?.detach()
    attachment.peer = null
    forget(attachment)
    ports.send({
      type: 'collab:left',
      // The handle this client used, not the resolved id — see `handle`.
      circuitId: attachment.handle,
      reason,
    })
  }

  /**
   * Whether this peer may still do what it was attached for, asked at most every
   * TTL — rule 5.
   *
   * Two things can change and they are answered differently. Losing *read*
   * access ends the attachment: there is nothing left to be part of. Losing only
   * *write* access downgrades it in place, because a peer who may still read
   * should keep watching rather than be disconnected — and the next update it
   * sends is then refused with FORBIDDEN, which is the honest thing to tell
   * somebody whose circuit was transferred out from under them.
   */
  /**
   * How many documents this socket holds, whichever handles address them.
   *
   * `attachments` maps *both* an id and a slug onto one attachment, so its `size`
   * is not a count of documents and must never be compared to
   * `MAX_COLLAB_DOCUMENTS_PER_SOCKET`.
   */
  function documentCount(): number {
    return new Set(attachments.values()).size
  }

  async function stillAttached(attachment: Attachment): Promise<boolean> {
    // Not subject to the TTL, for the same reason it is not for a subscription:
    // an expired credential is the end of this socket's authority, not a
    // decision that may be cached for two more seconds.
    if (credentialExpired()) return false
    const read = ports.readCircuit
    if (read === null) return false
    const now = ports.now()
    if (now - attachment.checkedAt < AUTHORISATION_TTL_MS) return true

    let decision: CircuitAccess | null
    try {
      /*
       * ── ASKED ABOUT THE HANDLE THE CLIENT PRESENTED, NOT THE RESOLVED ID ──
       *
       * The two differ for a slug join, and re-checking the *id* asks a question
       * this viewer was never granted an answer to: an id reaches only what a
       * listing may show (`idAddressableCircuitFilter`), so for a stranger
       * holding a link to an UNLISTED circuit `findReadable(id)` is null while
       * `findReadable(slug)` is the circuit. The re-check therefore ejected
       * exactly the peer the join had just admitted, two seconds after admitting
       * them — `collab:left` with reason `unauthorised`, and a reader told their
       * circuit "stopped being yours to open" while they were looking at it.
       *
       * Re-asking the original question is also the only *correct* re-check:
       * revocation has to be measured against the access this peer actually
       * claimed. A circuit made PRIVATE stops resolving by slug too, so nothing
       * is weakened — the two-browser suite in `apps/web/e2e/live` covers both
       * directions.
       */
      decision = await read(attachment.handle, viewerId)
    } catch (error) {
      /*
       * The database is unreachable. The attachment is *kept*, which is a
       * deliberate choice against failing closed: what it protects is a session
       * that two people are in the middle of, the cached decision was true two
       * seconds ago, and the same outage will refuse the version they are about
       * to save. Failing closed here would turn a pooler blip into everybody's
       * work being disconnected, and the window it would close is two seconds
       * wide on a scratch document.
       */
      ports.log(
        'warn',
        { circuitId: attachment.circuitId, err: error },
        'could not re-check a collaboration attachment; keeping it'
      )
      return true
    }
    if (decision === null) return false
    /*
     * A handle that now names a different circuit. Unreachable today — a slug is
     * unique and immutable, and an id is a primary key — and checked anyway,
     * because the alternative would be to go on relaying one circuit's document
     * to a peer authorised against another.
     */
    if (decision.circuitId !== attachment.circuitId) return false
    attachment.access = decision.access
    attachment.checkedAt = now
    return true
  }

  /** One update, on its way out to a peer. Ordered, and never dropped. */
  async function deliverUpdate(
    attachment: Attachment,
    update: Uint8Array
  ): Promise<void> {
    attachment.queued -= 1
    if (attachment.ended || closed) return
    if (credentialExpired()) {
      shut(SOCKET_CLOSE.EXPIRED)
      return
    }
    if (!(await stillAttached(attachment))) {
      ports.log(
        'info',
        { circuitId: attachment.circuitId, viewerId },
        'a collaboration attachment stopped being readable and was ended'
      )
      endAttachment(attachment, 'unauthorised')
      return
    }
    if (attachment.ended || closed) return
    ports.send({
      type: 'collab:update',
      // The handle this client used, not the resolved id — see `handle`.
      circuitId: attachment.handle,
      update: encodeBinaryPayload(update),
    })
  }

  /**
   * Somebody else's presence, on its way out — M5.3.
   *
   * ── Why this does not queue behind a check *per delivery*, and updates do ──
   *
   * An update may never be dropped: a document is the merge of every update, so a
   * peer that missed one holds a document nobody else has (see
   * `MAX_COLLAB_PENDING_DELIVERIES`). A presence is the opposite in exactly that
   * respect — it is *replaced* by the next one, and the next one is at most
   * `PRESENCE_HEARTBEAT_MS` away. So the common path sends it immediately: a
   * per-delivery authorisation await would put every other peer's caret behind a
   * database round trip on a pool of one.
   *
   * ── What happens when the cached decision has gone stale ──────────────────
   *
   * The first version *dropped* the frame and scheduled a refresh, and that was
   * wrong in a way the arithmetic makes obvious: the TTL is two seconds and a
   * presence renewal arrives every ten, so in a quiet session **every heartbeat
   * was dropped**. Two idle peers stopped hearing each other, each client's own
   * thirty-second expiry deleted the other from its roster, and the mechanism
   * that exists to prevent exactly that was the thing being thrown away. The
   * `state: null` that takes an *ejected* peer's caret off the remaining screens
   * went the same way, so somebody the relay had removed for losing read access
   * stayed drawn, with their name and their access, for up to thirty seconds.
   *
   * Sending it anyway is not the answer either: it would relay a cursor to a
   * viewer whose read access may already be gone, which is the one thing this
   * channel's re-checking exists to prevent.
   *
   * So a stale frame *waits* for the single read that refreshes the decision, on
   * the attachment's own chain — the same chain updates use, so presence and
   * updates cannot overtake each other. That costs one database read per
   * `AUTHORISATION_TTL_MS` per attachment and delays at most one frame of a drag
   * by it, because the refresh makes the decision fresh for the next two seconds.
   * It is bounded by `MAX_COLLAB_PENDING_DELIVERIES` like everything else on this
   * chain, and past that a presence *is* dropped — which is sound for a presence
   * and never for an update: the next heartbeat restates the whole truth.
   */
  function deliverPresence(
    attachment: Attachment,
    subject: string,
    state: PresenceState | null
  ): void {
    if (attachment.ended || closed) return
    if (credentialExpired()) {
      shut(SOCKET_CLOSE.EXPIRED)
      return
    }
    const frame: ServerFrame = {
      type: 'collab:presence',
      // The handle this client used, not the resolved id — see `handle`.
      circuitId: attachment.handle,
      peerId: subject,
      state,
    }
    if (ports.now() - attachment.checkedAt < AUTHORISATION_TTL_MS) {
      ports.send(frame)
      return
    }
    if (attachment.queued >= MAX_COLLAB_PENDING_DELIVERIES) return
    attachment.queued += 1
    attachment.chain = attachment.chain.then(async () => {
      attachment.queued -= 1
      if (attachment.ended || closed) return
      if (credentialExpired()) {
        shut(SOCKET_CLOSE.EXPIRED)
        return
      }
      if (!(await stillAttached(attachment))) {
        ports.log(
          'info',
          { circuitId: attachment.circuitId, viewerId },
          'a collaboration attachment stopped being readable and was ended'
        )
        endAttachment(attachment, 'unauthorised')
        return
      }
      if (attachment.ended || closed) return
      ports.send(frame)
    })
  }

  /**
   * One `collab:presence` from this client, on its way in.
   *
   * The identity is composed here and nowhere else: what arrived is a position,
   * and `name` and `access` are added from what this socket proved and from the
   * decision the attachment already holds. A peer therefore cannot name itself,
   * cannot claim write access, and cannot be the path by which an email reaches
   * another browser.
   *
   * A read-only peer is *allowed* here, which is the one place on this channel
   * where that sentence is not a hole. Presence writes nothing: no document, no
   * row, nothing that outlives the connection. A watcher who could not be seen
   * would make §3.4's shared cursors a feature only the sole writer of a circuit
   * ever benefits from.
   */
  async function presence(
    circuitId: string,
    position: PresencePosition
  ): Promise<void> {
    const attachment = attachments.get(circuitId)
    // Silence, exactly as an update for a circuit this socket never joined gets:
    // it is what a client sends in the moment after its attachment ended, and
    // with no attachment there is nothing to reach.
    if (attachment === undefined || attachment.ended) return

    if (!withinPresenceBudget()) {
      ports.log(
        'warn',
        { viewerId, circuitId, presences: presenceInWindow },
        'a socket exceeded its presence budget; closing'
      )
      shut(SOCKET_CLOSE.OVERLOADED)
      return
    }

    if (!(await stillAttached(attachment))) {
      endAttachment(attachment, 'unauthorised')
      return
    }
    if (attachment.ended || closed) return

    const peer = attachment.peer
    if (peer === null) return
    peer.publishPresence({
      ...position,
      name: await displayName(),
      access: attachment.access,
    })
  }

  async function join(circuitId: string, since?: string): Promise<void> {
    if (credentialExpired()) {
      // The same refusal `subscribe` makes at the same door: an expired token
      // must not buy *new* access, only lose the tail of what it had.
      shut(SOCKET_CLOSE.EXPIRED)
      return
    }

    const read = ports.readCircuit
    const attach = ports.attachDocument
    if (read === null || attach === null) {
      failCircuit(circuitId, 'SIMULATION_UNAVAILABLE')
      return
    }

    /*
     * Before the database read, as the subscription ceiling is: a socket already
     * holding as many documents as it may must not be able to buy a query with a
     * frame.
     *
     * ── COUNTED PER DOCUMENT, NOT PER HANDLE ────────────────────────────────
     *
     * `attachments` is keyed by *both* handles of every document it holds — see
     * the registration below, which is what lets a slug join and an id join for
     * one circuit find each other rather than build two sessions. So `size` is up
     * to twice the number of documents, and comparing it to the ceiling made a
     * single slug join fill a budget of two: the enforced bound was one, for every
     * client that joins by slug, which is every browser (`editor.tsx` passes
     * `base.slug`). Measured — three joins by id are admitted, admitted, refused,
     * while two joins by slug are admitted, refused.
     *
     * `documentCount` counts the distinct attachments instead, which is the figure
     * the constant is named after.
     */
    if (
      attachments.get(circuitId) === undefined &&
      documentCount() >= MAX_COLLAB_DOCUMENTS_PER_SOCKET
    ) {
      failCircuit(circuitId, 'RATE_LIMITED')
      return
    }

    /*
     * A state vector the client sent. Decoded here rather than trusted: the
     * schema bounded its length and its alphabet, and this is where a payload
     * that is neither `undefined` nor readable becomes a refusal instead of a
     * `null` that quietly means "send them everything".
     */
    let vector: Uint8Array | null = null
    if (since !== undefined) {
      vector = decodeBinaryPayload(since)
      if (vector === null) {
        failCircuit(circuitId, 'VALIDATION_FAILED')
        return
      }
    }

    let decision: CircuitAccess | null
    try {
      decision = await read(circuitId, viewerId)
    } catch (error) {
      ports.log(
        'warn',
        { circuitId, err: error },
        'could not decide a collaboration attachment'
      )
      failCircuit(circuitId, 'DATABASE_UNAVAILABLE')
      return
    }
    if (decision === null) {
      // 404 and never 403, for the reason every read in this API does it: a 403
      // would confirm that the circuit exists.
      failCircuit(circuitId, 'NOT_FOUND')
      const held = attachments.get(circuitId)
      if (held !== undefined) endAttachment(held, 'unauthorised')
      return
    }

    /*
     * From here on the *resolved* id is what identifies the session, so that a
     * slug and an id reach one document, one row and one channel. The handle the
     * client used is still what the answers quote, because that is what the
     * client asked about.
     */
    const documentId = decision.circuitId
    const existing =
      attachments.get(documentId) ??
      (documentId === circuitId ? undefined : attachments.get(circuitId))

    if (existing !== undefined) {
      /*
       * Idempotent, exactly as a duplicate `subscribe` is. A client that
       * reconnects re-joins everything it was in, and a rejoin must not cost it a
       * slot — it re-confirms the authorisation, adopts whatever access it now
       * has, and re-states the document from the vector it sent, which is what a
       * fresh attachment would have done.
       */
      existing.access = decision.access
      existing.checkedAt = ports.now()
      const peer = existing.peer
      /*
       * The first join is still establishing its attachment. Unreachable while
       * frames are handled one at a time, which the route guarantees — and
       * answered with silence rather than a code, because every code available
       * here would be a lie: nothing is too large, nothing is unavailable, and
       * the `collab:joined` this client is waiting for is already on its way.
       */
      if (peer === null) return
      const state = peer.missing(vector)
      if (state === null) {
        failCircuit(circuitId, 'CIRCUIT_TOO_LARGE')
        return
      }
      ports.send({
        type: 'collab:joined',
        circuitId,
        access: existing.access,
        update: encodeBinaryPayload(state),
        vector: encodeBinaryPayload(peer.vector()),
        deferred: peer.deferred,
        overflow: peer.overflow,
      })
      sendRoster(existing, peer)
      return
    }

    const attachment: Attachment = {
      circuitId: documentId,
      // What the client asked about, which is what its frames will quote back.
      handle: circuitId,
      access: decision.access,
      checkedAt: ports.now(),
      peer: null,
      queued: 0,
      chain: Promise.resolve(),
      ended: false,
    }
    // Registered before the await so that two `collab:join` frames for one
    // circuit, arriving back to back, cannot both attach a peer. Under both
    // handles, so that a slug join and an id join for one circuit find each
    // other rather than building two sessions.
    attachments.set(documentId, attachment)
    if (documentId !== circuitId) attachments.set(circuitId, attachment)

    let attached: Awaited<ReturnType<AttachPort>>
    try {
      attached = await attach({
        circuitId: documentId,
        peerId: myPeerId(),
        access: decision.access,
        deliverPresence: (subject, state) => {
          deliverPresence(attachment, subject, state)
        },
        deliver: (update) => {
          if (attachment.ended) return
          if (attachment.queued >= MAX_COLLAB_PENDING_DELIVERIES) {
            /*
             * This peer cannot keep up. Ended rather than starved, because an
             * update it never receives is a divergence it cannot detect — see
             * `MAX_COLLAB_PENDING_DELIVERIES`.
             */
            ports.log(
              'info',
              { circuitId, viewerId },
              'a collaboration peer fell behind and was ended'
            )
            endAttachment(attachment, 'overloaded')
            return
          }
          attachment.queued += 1
          attachment.chain = attachment.chain.then(() =>
            deliverUpdate(attachment, update)
          )
        },
        dropped: () => {
          endAttachment(attachment, 'gone')
        },
      })
    } catch (error) {
      forget(attachment)
      ports.log(
        'warn',
        { circuitId: documentId, err: error },
        'could not attach to a circuit’s document'
      )
      failCircuit(circuitId, 'DATABASE_UNAVAILABLE')
      return
    }

    if ('refused' in attached) {
      forget(attachment)
      failCircuit(circuitId, refusalCode(attached.refused))
      return
    }

    if (attachment.ended || closed) {
      // The socket went away while the attachment was being established.
      attached.detach()
      forget(attachment)
      return
    }

    attachment.peer = attached
    const state = attached.missing(vector)
    if (state === null) {
      // A document too big to put in a frame. The attachment is given up rather
      // than left half-open: a peer with no initial state can never converge.
      endAttachment(attachment, 'gone')
      failCircuit(circuitId, 'CIRCUIT_TOO_LARGE')
      return
    }
    ports.send({
      type: 'collab:joined',
      circuitId,
      access: attachment.access,
      update: encodeBinaryPayload(state),
      /*
       * The relay's own state vector, which is what closes the *other* half of a
       * reconnect. `since` tells the relay what the peer lacks; nothing ever
       * asked what the session lacks from a peer that edited while it was away,
       * so such a peer stayed diverged from everybody until it volunteered its
       * whole document. With this it computes a delta instead.
       */
      vector: encodeBinaryPayload(attached.vector()),
      deferred: attached.deferred,
      overflow: attached.overflow,
    })
    sendRoster(attachment, attached)
  }

  /** Removes an attachment from every handle it was registered under. */
  function forget(attachment: Attachment): void {
    for (const [handle, held] of [...attachments]) {
      if (held === attachment) attachments.delete(handle)
    }
  }

  /**
   * Who is already here, one frame per peer, right after the join.
   *
   * After `collab:joined` rather than inside it: a client that has not yet
   * adopted the document cannot place a cursor on a cell, and a roster carried on
   * the join frame would have to be applied in the same tick as a document the
   * reducer has not seen. Two frames in a fixed order is one less thing to get
   * right, and it means "a peer exists" has exactly one code path in the client
   * whether that peer was here first or arrived later.
   *
   * Bounded by `MAX_PEERS_PER_DOCUMENT`, and by the roster's own ceiling for
   * peers attached to another replica.
   */
  function sendRoster(attachment: Attachment, peer: DocumentPeer): void {
    for (const record of peer.roster()) {
      if (attachment.ended || closed) return
      ports.send({
        type: 'collab:presence',
        // The handle this client used, not the resolved id — see `handle`.
        circuitId: attachment.handle,
        peerId: record.peerId,
        state: record.state,
      })
    }
  }

  /** An attachment refusal, in the vocabulary a client already translates. */
  function refusalCode(refusal: AttachRefusalCode): SocketErrorCode {
    switch (refusal) {
      case 'too-many-documents':
      case 'too-many-peers':
        return 'RATE_LIMITED'
      case 'too-large':
        return 'CIRCUIT_TOO_LARGE'
      default:
        return 'DATABASE_UNAVAILABLE'
    }
  }

  async function update(circuitId: string, payload: string): Promise<void> {
    const attachment = attachments.get(circuitId)
    /*
     * Silence, and deliberately. An update for a circuit this socket never
     * joined is what a client sends in the moment after its attachment was ended
     * — it has a frame in flight and has not read `collab:left` yet — and
     * answering it would turn every teardown into an error the client has to
     * explain to somebody. It is not an authorisation hole: with no attachment
     * there is no document to reach.
     */
    if (attachment === undefined || attachment.ended) return

    /*
     * The budget is charged before the work and before the authorisation
     * re-check, because both are what it is protecting. Charged on the *encoded*
     * length, which is what actually arrived and is what a sender controls.
     */
    if (!withinCollabBudget(payload.length)) {
      ports.log(
        'warn',
        {
          viewerId,
          circuitId,
          updates: collabUpdatesInWindow,
          bytes: collabBytesInWindow,
        },
        'a socket exceeded its collaboration budget; closing'
      )
      shut(SOCKET_CLOSE.OVERLOADED)
      return
    }

    if (!(await stillAttached(attachment))) {
      endAttachment(attachment, 'unauthorised')
      return
    }
    if (attachment.ended || closed) return

    /*
     * Rule 4, on the frame. A read-only peer is refused here and not by an
     * interface that declines to offer it — the whole difference between
     * discouraging a write and not permitting one.
     */
    if (attachment.access !== 'write') {
      ports.log(
        'info',
        { circuitId, viewerId },
        'a read-only peer tried to write to a shared document'
      )
      failCircuit(circuitId, 'FORBIDDEN')
      return
    }

    const bytes = decodeBinaryPayload(payload)
    if (bytes === null) {
      // The schema accepted the alphabet and the length; this is the second
      // refusal, and having both is what keeps either from being the only one.
      failCircuit(circuitId, 'VALIDATION_FAILED')
      return
    }

    const peer = attachment.peer
    if (peer === null) return
    const applied = peer.apply(bytes)
    if (applied.ok) {
      if (!withinCollabWorkBudget(applied.work)) {
        ports.log(
          'warn',
          { viewerId, circuitId, work: collabWorkInWindow },
          'a socket exceeded its collaboration work budget; closing'
        )
        shut(SOCKET_CLOSE.OVERLOADED)
      }
      return
    }

    switch (applied.reason) {
      case 'too-large':
        failCircuit(circuitId, 'PAYLOAD_TOO_LARGE')
        return
      case 'document-too-large':
        failCircuit(circuitId, 'CIRCUIT_TOO_LARGE')
        return
      case 'malformed':
        /*
         * Bytes that are not a Yjs update at all. The document was not touched —
         * the relay decodes before it integrates — so this is a refusal and not
         * a report of damage, and the socket is closed rather than answered: a
         * peer sending undecodable binary is broken or hostile, and either way is
         * not a peer to keep relaying for.
         */
        ports.log(
          'warn',
          { circuitId, viewerId },
          'a peer sent bytes that are not a Yjs update; closing'
        )
        shut(SOCKET_CLOSE.PROTOCOL)
        return
      default:
        // The projection refused what the document now says, which `project.ts`
        // promises cannot happen. The relay has already given the document up
        // and told every peer to rejoin; this tells the sender why.
        failCircuit(circuitId, 'VALIDATION_FAILED')
        return
    }
  }

  /**
   * Whether this frame is charged to a budget of its own rather than the general
   * one — see rule 6.
   *
   * True only for a collaboration frame naming a circuit this socket is attached
   * to and has not left, because that is exactly when `update()` and
   * `presence()` reach their own meters. An unattached socket's `collab:update`
   * is a frame like any other and is charged like one.
   */
  function metered(frame: { type: string; circuitId?: string }): boolean {
    if (frame.type !== 'collab:update' && frame.type !== 'collab:presence') {
      return false
    }
    const circuitId = frame.circuitId
    if (circuitId === undefined) return false
    const attachment = attachments.get(circuitId)
    return attachment !== undefined && !attachment.ended
  }

  return {
    async receive(raw) {
      if (closed) return

      if (credentialExpired()) {
        // Before the frame is even parsed: a socket past its `exp` gets no more
        // work out of this process, whatever it is asking for.
        shut(SOCKET_CLOSE.EXPIRED)
        return
      }

      const frame = parseClientFrame(raw)
      if (frame === null) {
        /*
         * Counted against the general budget even though it was not parsed: an
         * unparseable frame still costs this process a JSON parse and an answer,
         * and a frame that is charged only when it is *valid* is a budget a
         * flood of garbage escapes.
         */
        if (!withinFrameBudget()) {
          ports.log(
            'warn',
            { viewerId, frames: framesInWindow },
            'a socket exceeded its frame budget; closing'
          )
          shut(SOCKET_CLOSE.OVERLOADED)
          return
        }
        violations += 1
        fail('VALIDATION_FAILED', null)
        if (violations >= MAX_PROTOCOL_VIOLATIONS) {
          shut(SOCKET_CLOSE.PROTOCOL)
        }
        return
      }

      /*
       * A collaboration update has a budget of its own — rule 6 — and so does a
       * presence — rule 7. Neither is counted here, *provided the socket holds
       * the attachment the frame names*: that is the condition under which the
       * specialised budget will charge it, and without it the exemption was a
       * free channel for anybody who could open a socket. Every other frame is
       * counted here, including `collab:join` and `collab:leave`: a join is a
       * database read, which is exactly the work this budget was sized against.
       */
      if (!metered(frame) && !withinFrameBudget()) {
        ports.log(
          'warn',
          { viewerId, frames: framesInWindow },
          'a socket exceeded its frame budget; closing'
        )
        shut(SOCKET_CLOSE.OVERLOADED)
        return
      }

      /*
       * After the budget and not before it. Refreshing it first meant a socket
       * being closed for flooding kept resetting the idle timer on the way, so a
       * flood of frames that bought nothing still bought immortality.
       */
      lastActivityAt = ports.now()

      switch (frame.type) {
        case 'ping':
          ports.send({ type: 'pong' })
          return
        case 'authenticate':
          await authenticate(frame.token)
          return
        case 'subscribe':
          await subscribe(frame.runId)
          return
        case 'unsubscribe': {
          const subscription = subscriptions.get(frame.runId)
          if (subscription === undefined) return
          subscription.ended = true
          subscription.release()
          subscriptions.delete(frame.runId)
          return
        }
        case 'collab:join':
          await join(frame.circuitId, frame.since)
          return
        case 'collab:update':
          await update(frame.circuitId, frame.update)
          return
        case 'collab:presence':
          await presence(frame.circuitId, frame.state)
          return
        default: {
          const attachment = attachments.get(frame.circuitId)
          if (attachment === undefined || attachment.ended) return
          attachment.ended = true
          attachment.peer?.detach()
          attachment.peer = null
          forget(attachment)
          // No `collab:left`: the client asked, so it knows. The frame exists for
          // the endings the client did not ask for.
          return
        }
      }
    },

    sweep() {
      if (closed) return
      const now = ports.now()
      if (credentialExpired()) {
        /*
         * A socket must not outlive the credential it was opened with. The
         * client reconnects with a fresh token, which it already has to be able
         * to do — see `SOCKET_CLOSE.EXPIRED`.
         *
         * This is no longer the *enforcement* of expiry, only its collection: a
         * socket that says nothing after its token dies is closed here, and one
         * that says anything at all is closed by the check in `receive`.
         */
        shut(SOCKET_CLOSE.EXPIRED)
        return
      }
      /*
       * ── REVOCATION IS RE-DECIDED HERE, NOT ONLY WHEN A PEER SPEAKS ─────────
       *
       * `stillAttached` is reached from `update`, `presence`, `deliverUpdate` and
       * `deliverPresence` — every one of which needs *traffic*. A peer that stops
       * speaking therefore kept its attachment, its reader slot and its hold on
       * the live document after its read access had been withdrawn, and was told
       * nothing: measured at 32 s of silence after a circuit was made PRIVATE,
       * with the socket still open and no `collab:left` sent. No data leaked — the
       * first frame after the owner edits is the ejection, never the edit — but
       * this channel's own vocabulary promises the decision is «re-checked while
       * the session runs», and "while somebody chooses to speak" is not that.
       *
       * So the sweep asks, on the attachment's own chain so it cannot overtake a
       * frame in flight. It costs one read per document per sweep at most: the TTL
       * check inside `stillAttached` returns immediately for anything a live
       * session has just re-checked, so an active peer pays nothing here and a
       * silent one pays a query every `SWEEP` interval.
       */
      for (const attachment of new Set(attachments.values())) {
        if (attachment.ended) continue
        if (now - attachment.checkedAt < AUTHORISATION_TTL_MS) continue
        attachment.chain = attachment.chain.then(async () => {
          if (attachment.ended || closed) return
          if (await stillAttached(attachment)) return
          ports.log(
            'info',
            { circuitId: attachment.circuitId, viewerId },
            'a silent collaboration attachment lost read access and was ended'
          )
          endAttachment(attachment, 'unauthorised')
        })
      }

      /*
       * An attachment counts as much as a subscription, and forgetting it would
       * be the bug this whole channel is most likely to grow: a watcher in a
       * shared session says nothing for minutes at a time — that is what
       * watching is — and closing them after two minutes of silence would make
       * the feature look broken for exactly the person it was built for.
       */
      if (subscriptions.size > 0 || attachments.size > 0) return
      if (now - lastActivityAt >= IDLE_TIMEOUT_MS) shut(SOCKET_CLOSE.IDLE)
    },

    async close() {
      closed = true
      const pending = [...subscriptions.values()]
      subscriptions.clear()
      for (const subscription of pending) {
        subscription.ended = true
        subscription.release()
      }
      const attached = [...attachments.values()]
      attachments.clear()
      for (const attachment of attached) {
        attachment.ended = true
        /*
         * Detaching is what lets the registry write the document: this may be the
         * last peer, and the last peer leaving is the moment `CircuitSession`
         * exists for. A socket that closed without detaching would leave a
         * document held by a peer that is gone and an hour of work unwritten.
         */
        attachment.peer?.detach()
        attachment.peer = null
      }
      // Drain the chains so a check in flight cannot resolve into a `send` on a
      // socket that is already gone.
      await Promise.all([
        ...pending.map((subscription) => subscription.chain),
        ...attached.map((attachment) => attachment.chain),
      ])
    },

    viewerId: () => viewerId,
    subscriptionCount: () => subscriptions.size,
    // Documents, not map entries: one document joined by slug occupies two keys.
    attachmentCount: documentCount,
  }
}
