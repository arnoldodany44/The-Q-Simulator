/**
 * The `/ws` frame contract — §8's `run:progress`, `run:complete` and
 * `job:status`, and §11 applied to a socket.
 *
 * ── A socket is not exempt from §11 because it is not HTTP ────────────────
 *
 * Everything the REST surface does about identity and visibility has to happen
 * here too, and the shape of the protocol is what makes that possible rather
 * than merely intended:
 *
 *   - **Identity arrives in a frame, never in the URL.** A browser's
 *     `WebSocket` constructor cannot set an `Authorization` header, which
 *     leaves exactly two options: a query parameter, or an in-band frame. A
 *     query parameter puts a bearer token in the request line — the one part of
 *     a request that every proxy, load balancer and access log records
 *     verbatim, and that a `Referer` can carry off the page. So the token
 *     travels as the first frame, over a connection that is already
 *     established and already encrypted, and `authenticate` is the only frame
 *     that carries one.
 *   - **A socket may stay anonymous.** `POST /simulate` accepts an anonymous
 *     submission (§4 puts the editor in front of people who have not signed
 *     in), and such a run is readable by whoever holds its id. So authenticating
 *     is optional and subscribing is not conditional on it — what decides
 *     access is `simulationRunFilter` with whatever viewer this socket proved,
 *     which is exactly what `GET /simulate/:runId` does.
 *   - **A subscription is a claim to be re-checked, not a grant.** See
 *     `SOCKET_CLOSE` and the API's `ws/session.ts`: authorisation is decided
 *     when `subscribe` arrives *and* re-decided while events are flowing, so a
 *     run whose circuit is unpublished mid-stream stops being delivered.
 *
 * ── The frames carry notifications, not answers ───────────────────────────
 *
 * `run:complete` says a run reached a terminal status. It does not carry the
 * result, and that is the same decision `completionKey` embodies in
 * `@qsim/jobs`: the answer lives in Postgres, a copy on a second transport
 * would be a second source of truth for the one value in this system that must
 * not have two, and — more sharply here — it would mean a payload leaving
 * through a channel whose authorisation was decided at some earlier moment.
 * The client reads `GET /simulate/:runId`, which applies the §11 filter afresh
 * on the way out.
 *
 * That is also what makes the reconnection story simple. A dropped socket loses
 * events, because Redis pub/sub promises nothing else; a client that reconnects
 * re-subscribes and reads the run, and is then exactly as correct as one that
 * never disconnected.
 */

import { MAX_COLUMNS, MAX_QUBITS, storableText } from '@qsim/schema'
import { z } from 'zod'
import { HardwareJobStatusSchema } from './hardware.js'
import { RunStatusSchema } from './simulate.js'

/**
 * Where the socket lives.
 *
 * Outside `API_PREFIX`, beside `/health`, and deliberately. §8 writes it as
 * `/ws` with no version, and a socket is not a resource whose representation
 * can be versioned by path: the frames are versioned by the union below, which
 * a client narrows and an unknown member of which it ignores.
 */
export const SOCKET_PATH = '/ws'

/* ────────────────────────────── client frames ───────────────────────── */

/**
 * The longest token this socket will read.
 *
 * A Supabase access token is a few hundred bytes of JWT; two kilobytes is
 * generous for one carrying a full `user_metadata` block and is far below the
 * frame ceiling. Bounded here so an oversized value is refused by the parser
 * rather than reaching the verifier.
 */
export const MAX_SOCKET_TOKEN_LENGTH = 2048

/**
 * The largest frame the server will read, in bytes.
 *
 * It is passed to the WebSocket server as `maxPayload`, which means an
 * oversized frame is refused by the protocol layer and the connection is
 * closed — the message is never buffered, which is the property that matters:
 * a socket is a stream, and a server that accumulated frames before deciding
 * they were too big would be a memory ceiling anybody could raise.
 *
 * ── Why it is 96 KiB and was 8 KiB ────────────────────────────────────────
 *
 * Because of one frame. Every other client frame is a type and either a run id
 * or a token, and 8 KiB was generous for all of them; `collab:update` carries a
 * CRDT update, which is `MAX_COLLAB_UPDATE_BYTES` of binary in base64 and
 * therefore the largest thing a legitimate client ever sends. The ceiling has
 * to admit it or a collaborative edit is refused by the transport, and a peer
 * whose update was refused is a peer whose document has silently diverged from
 * everybody else's — the one failure a CRDT cannot repair.
 *
 * Raising it does **not** widen the other frames, and that is the part worth
 * being precise about: each frame's own fields are still bounded where they
 * were (`MAX_SOCKET_TOKEN_LENGTH` for a token, 64 characters for an id), so a
 * 90 KiB `authenticate` is refused by the schema exactly as it was before. What
 * grew is only what the protocol layer will *hold* while a decision is made, and
 * `MAX_SOCKET_PENDING_BYTES` is what keeps that from becoming a memory ceiling:
 * the product of the two is the bound that matters, and it is deliberately no
 * larger than the 8 KiB × `MAX_SOCKET_PENDING_FRAMES` it replaces.
 */
export const MAX_SOCKET_FRAME_BYTES = 96 * 1024

/**
 * The largest frame a *client* will read, in bytes.
 *
 * Larger than the incoming ceiling, and the asymmetry is the honest one. The
 * frame that needs the room is `collab:joined`, which carries the whole shared
 * document — up to `MAX_COLLAB_STATE_BYTES` of it — and a client that refused
 * to parse that frame could never join a session at all. There is no
 * corresponding client frame: a joiner announces what it has with a state
 * vector, which is a few bytes per peer, and the server answers with the
 * difference.
 *
 * It is bounded rather than absent because a client must never be asked to
 * parse unbounded text, whatever the origin claims to be; the server is trusted
 * about *authority*, not about size.
 *
 * It also has to stay *above* base64 of `MAX_COLLAB_STATE_BYTES`, because base64
 * costs a third: a 1 MiB document is a 1.34 MiB field, and a client whose ceiling
 * was smaller than that would refuse the join frame of a document the relay
 * considers perfectly ordinary. 768 KiB was smaller than that once the document
 * ceiling rose. `socket.test.ts` asserts the relationship, so the two cannot
 * drift apart again — the constants cannot be derived from one another here
 * because this one is read before the other is declared.
 */
export const MAX_SERVER_FRAME_BYTES = 1536 * 1024

/**
 * How many runs one socket may watch at once.
 *
 * A person watches one server run — the editor has one circuit open — and a
 * tab that reconnects re-subscribes to what it was watching rather than adding
 * to it. Eight leaves room for a client that opens several editors against one
 * socket and still bounds what a single connection can make this process hold:
 * each subscription is a Redis channel and a cached authorisation decision.
 */
export const MAX_SOCKET_SUBSCRIPTIONS = 8

/**
 * How many frames one socket may send in `SOCKET_FRAME_WINDOW_MS`.
 *
 * §11 asks for rate limiting per IP and per user, most aggressively on
 * authentication — and a socket is a request that never ends, so counting only
 * the upgrade counts a client's *first* frame and nothing after it. Every
 * `subscribe` is a database read on a pool of one and every `authenticate` is
 * an ES256 verification, so an unmetered frame is an unmetered piece of server
 * work that anybody who can open a socket may repeat as fast as they can write.
 *
 * Sixty in ten seconds is two orders of magnitude above what a real client
 * does. The busiest legitimate burst is a reconnection: one `authenticate`, up
 * to `MAX_SOCKET_SUBSCRIPTIONS` `subscribe` frames, and a `ping` — ten frames,
 * once. A client that exceeds this is not a client that got unlucky.
 */
export const MAX_SOCKET_FRAMES_PER_WINDOW = 60

/** The window `MAX_SOCKET_FRAMES_PER_WINDOW` is counted over. */
export const SOCKET_FRAME_WINDOW_MS = 10_000

/**
 * How many frames may be waiting to be handled before the socket is closed.
 *
 * Frames are handled one at a time (the API's `routes/ws.ts` chains them so
 * that `authenticate` cannot be overtaken by the `subscribe` that follows it),
 * which means a client that writes faster than the server drains builds a
 * backlog in the server's memory — 20 000 frames written in 63 ms is minutes of
 * queued database work from a burst that cost the sender nothing. The rate
 * budget above bounds arrival over a window; this bounds what may be *pending*
 * at any instant, which is the memory half of the same problem.
 */
export const MAX_SOCKET_PENDING_FRAMES = 32

/**
 * How many bytes of unhandled frames one socket may hold, in total.
 *
 * The count above bounds a queue of *small* frames and used to bound its memory
 * too, because every frame was under 8 KiB. `collab:update` broke that: with a
 * 96 KiB ceiling, thirty-two pending frames is three megabytes per connection
 * and five hundred connections is a gigabyte and a half — a bound in name only,
 * on a container that has a few hundred megabytes.
 *
 * So the queue is bounded twice, by count and by weight, and this number is
 * chosen so the *product* is what it always was: 8 KiB × 32 is 256 KiB, which
 * is what one socket could make this process hold before the ceiling moved and
 * is what it can make it hold now. A client that sends three full-sized
 * collaboration updates faster than the relay drains them is closed, and a
 * client that sends thirty-two ordinary frames is closed, and neither can do
 * both.
 */
export const MAX_SOCKET_PENDING_BYTES = 256 * 1024

const RunIdSchema = z
  .string()
  .min(1)
  .max(64)
  .regex(/^[A-Za-z0-9_-]+$/)

/**
 * A circuit's handle as this socket accepts it.
 *
 * The same shape as a run id — cuid2 and the `nanoid` slug both fit — and
 * bounded for the same reason: it is echoed back into a frame and used to name
 * a Redis channel, so it must not be able to carry a separator, a wildcard or a
 * path segment.
 */
const CircuitIdSchema = RunIdSchema

/* ───────────────────── the collaboration channel (§8, §3.4) ───────────── */

/**
 * §8's name for the channel: `circuit:<id>`.
 *
 * A function rather than a template written wherever it is needed, because the
 * name appears in three places that must agree — the log line, the Redis
 * channel a second replica listens on, and the specification. It is not part of
 * the frame: a frame names the circuit, and the channel is what the *relay*
 * calls the thing it fans out to.
 */
export function circuitChannel(circuitId: string): string {
  return `circuit:${circuitId}`
}

/**
 * The largest CRDT update this socket will accept, in bytes, decoded.
 *
 * ── Why a transport ceiling exists at all, below `MAX_UPDATE_BYTES` ───────
 *
 * `@qsim/collab` bounds an update at 256 KiB, which is what a *document* may
 * weigh (it matches the storage cap on a saved circuit). That is the right
 * number for the browser applying its own history and the wrong one for bytes
 * arriving from a stranger: 256 KiB per frame, at the frame rate a socket
 * allows, is a megabyte a second of `Y.applyUpdate` and reprojection on a
 * container that also has to answer the gallery.
 *
 * 64 KiB is sized against the largest edit a person makes in one gesture. An
 * incremental edit is around a hundred bytes; pasting a hundred-gate
 * subcircuit, which the store commits as one transaction and therefore travels
 * as one update, is around twelve kilobytes; seeding a session from a circuit
 * that has never been saved is the largest legitimate case and stays inside
 * this. A client with more than this to say says it in two frames — which the
 * CRDT permits, because the document is the merge of its updates and not a
 * snapshot — and a client that cannot is looking at a circuit too big for a
 * shared session anyway.
 */
export const MAX_COLLAB_UPDATE_BYTES = 64 * 1024

/**
 * The largest document the relay will serve or persist, in bytes.
 *
 * A document is its updates merged, including the tombstones of everything ever
 * deleted, so it grows with the *history* of a session and not only with the
 * circuit in it. This is the ceiling on the whole of it: past this the relay
 * refuses to open the session rather than serving a frame no client will read
 * (see `MAX_SERVER_FRAME_BYTES`) or writing a row that would grow without end.
 *
 * The figure has to be above what the *largest saveable circuit* encodes to,
 * and 512 KiB was not: a Yjs state runs about 2.3× the circuit's JSON, so a
 * 4,200-operation circuit — 229 KB of JSON, comfortably inside the 256 KiB a
 * version may occupy — encodes to 526 KB and `collab:join` answered
 * CIRCUIT_TOO_LARGE for a circuit every other feature in the product handles.
 * "Twice the JSON ceiling" was the right *reasoning* applied to the wrong
 * measurement.
 *
 * 1 MiB is a little over four times the JSON ceiling: room for the largest
 * circuit anybody can save (about 600 KB encoded) plus a session's worth of
 * edits and tombstones on top of it. `MAX_DOCUMENTS` came down to keep the
 * memory this admits where it was.
 */
export const MAX_COLLAB_STATE_BYTES = 1024 * 1024

/** The base64 length of `bytes` bytes — what a frame's field must admit. */
function base64Length(bytes: number): number {
  return Math.ceil(bytes / 3) * 4
}

/**
 * How many collaboration updates one socket may send in
 * `SOCKET_FRAME_WINDOW_MS`.
 *
 * A budget of its own rather than a share of `MAX_SOCKET_FRAMES_PER_WINDOW`,
 * and the reason is that the two bound different work. That budget is sixty in
 * ten seconds because every frame it counts is a database read on a pool of one
 * or an ES256 verification — six a second is already two orders of magnitude
 * more than a real client asks for. A collaboration update is neither: the
 * authorisation behind it is cached, and what it costs is one `Y.applyUpdate`
 * and one reprojection. Counting a drag against the same sixty would close the
 * socket of somebody moving a slider, which is not a threat model, it is a
 * feature working.
 *
 * Twelve a second is above what a coalescing client produces — the bridge
 * commits per gesture and the transport merges what accumulates between
 * flushes — and far below what a flood needs to be to matter, because the
 * companion byte budget binds first.
 */
export const MAX_COLLAB_UPDATES_PER_WINDOW = 120

/**
 * How many bytes of collaboration updates one socket may send in
 * `SOCKET_FRAME_WINDOW_MS`.
 *
 * The count above bounds frames; this bounds the part of the work that *is*
 * linear in the update — decoding and integrating it. Without it the ceiling is
 * 120 × 64 KiB = 7.5 MB per ten seconds per socket, which is not a bound anybody
 * would write down on purpose.
 *
 * One mebibyte is a hundred and fifty full-sized gestures a minute, or an
 * unbroken slider drag at the frame rate a screen refreshes. A client past it
 * is closed rather than throttled: there is nothing useful to say to a peer
 * whose document is going to diverge either way.
 *
 * It does **not** bound the reprojection, and the first version of this comment
 * claimed it did ("linear in bytes twice over"). Reprojecting is linear in the
 * *document*: a 129-byte delta costs 3.8 ms on a 200-operation document and
 * 26.9 ms on a 3,000-operation one, so a writer inside 1% of this budget could
 * spend a third of a core. That is what `MAX_COLLAB_WORK_PER_WINDOW` is for.
 */
export const MAX_COLLAB_BYTES_PER_WINDOW = 1024 * 1024

/**
 * How much *document* one socket may make the relay reproject in
 * `SOCKET_FRAME_WINDOW_MS`, counted in operations.
 *
 * The third dimension, and the one the other two cannot express. Every accepted
 * update is followed by a `projectCircuit` over the whole document — which is
 * what makes the projection the single definition of what the document says, and
 * what the relay validates before anything acts on it. The cost is therefore
 * proportional to the document and not to the update, so a peer sending
 * hundred-byte deltas into a large circuit costs the container far more than its
 * byte budget suggests: measured at about 6 µs per operation, 120 updates into a
 * 3,000-operation document is roughly three seconds of CPU per ten, for one and
 * a half kilobytes a second of traffic.
 *
 * 400,000 operations is about 2.5 s of that work per ten-second window — a
 * quarter of one core per socket — and it is deliberately loose enough that it
 * binds *after* the frame budget for anything under about 3,300 operations. A
 * person editing a circuit that large interactively is past what the editor is
 * for; a peer that keeps going is closed with OVERLOADED, and a rejoin is a
 * resync rather than a loss.
 */
export const MAX_COLLAB_WORK_PER_WINDOW = 400_000

/**
 * How many shared documents one socket may hold at once.
 *
 * Two, not eight. A person edits one circuit; the second slot is the definition
 * editor, which opens a document of its own beside it (`openDefinition`). Every
 * attachment is a Y.Doc reference, a cached authorisation decision and a place
 * in a fan-out list, and unlike a run subscription it is a *write* path — so the
 * ceiling that composes with `MAX_SOCKETS_PER_ADDRESS` into "what one caller can
 * make this process hold" wants to be small.
 */
export const MAX_COLLAB_DOCUMENTS_PER_SOCKET = 2

/**
 * A binary payload as a frame carries it: base64, bounded, and nothing else.
 *
 * The regex is not decoration. A field typed only as a string would let a
 * megabyte of `%`-escapes or a lone surrogate reach the decoder, and the
 * decoder's job is to answer with bytes rather than to be the place where
 * hostile text is first noticed. Padding is optional because both the canonical
 * form and the unpadded one decode to the same bytes, and refusing one of them
 * would be a compatibility trap for no gain.
 */
function base64Field(maxBytes: number) {
  return z
    .string()
    .max(base64Length(maxBytes))
    .regex(/^[A-Za-z0-9+/]*={0,2}$/)
}

/**
 * What a peer may be doing in a session.
 *
 *   `write`  it may send updates. Only somebody who may edit the circuit —
 *            §11's `canEditCircuit`, which is its owner and nobody else.
 *   `read`   it receives updates and may not send them. Anybody who may *read*
 *            the circuit, which for a PRIVATE circuit is its owner alone and for
 *            a PUBLIC or UNLISTED one is whoever holds the handle.
 *
 * The distinction is enforced on the server, per frame, and the client is told
 * which it has so that it can say so — but a client that draws the buttons
 * anyway changes nothing. That is the whole point of sending it: a read-only
 * peer that is not *told* it is read-only would edit locally, diverge from
 * everybody, and discover it when its work vanished.
 */
export const COLLAB_ACCESS = ['write', 'read'] as const

export type CollabAccess = (typeof COLLAB_ACCESS)[number]

/* ──────────────────── presence: who is here, and where (M5.3) ──────────── */

/**
 * ═══════════════════════════════════════════════════════════════════════
 * PRESENCE IS A TYPED FRAME AND NOT A RELAYED AWARENESS BLOB
 *
 * Yjs models exactly this with `y-protocols`' Awareness: ephemeral state that
 * is not part of the document — a cursor, a selection, a name, a colour —
 * carried as one opaque binary message per peer, with a clock per peer and a
 * heartbeat so a closed tab eventually disappears. That model is right and this
 * protocol keeps all of it. What it does *not* keep is the opacity, and the
 * reason is one sentence of §11: **presence carries identity**.
 *
 * An awareness update is a blob a peer composes. Relaying one means the display
 * name reaching every other browser is whatever the sender put in it — their
 * own email, somebody else's name, a kilobyte of markup — and a relay that
 * cannot read the field cannot refuse it. Decoding the blob to rewrite one
 * field would mean owning a second wire format's parser on the hot path, which
 * is the argument the workspace catalog already makes for not adopting
 * `y-protocols` at all.
 *
 * So the split is: **a peer asserts where it is looking, and the server states
 * who it is.** `PresencePositionSchema` is what a client may say — a cell, a
 * selection, a count of the edits it has committed — and the relay composes
 * `name` and `access` onto it from the identity this socket proved and the
 * authorisation it re-checks anyway. A peer cannot name itself, cannot claim
 * write access it does not have, and cannot be the reason an email leaves the
 * database: `name` is `displayName ?? username`, both of which are already
 * public, and `User.email` has no path into this frame.
 *
 * The two things Awareness gives for free and this has to state itself are
 * below: `PRESENCE_HEARTBEAT_MS` and `PRESENCE_TIMEOUT_MS`.
 * ═══════════════════════════════════════════════════════════════════════
 */

/**
 * How often a peer restates its presence even when nothing changed.
 *
 * A disconnection is not an event anything guarantees. A closed laptop, a phone
 * that changed network and a tab that was killed all produce no close frame,
 * and the socket layer only notices on its own ping cycle — up to a minute
 * (`routes/ws.ts`: 30 s × 2 missed pings). A cursor that lingered for that long
 * on a cell nobody is looking at is worse than no cursor: it is a claim about
 * where a person is that is simply false.
 *
 * So presence expires, and a live peer keeps it alive. Ten seconds is one frame
 * per peer per ten seconds — nothing against `MAX_COLLAB_PRESENCE_PER_WINDOW`,
 * and comfortably under a third of the timeout, so two lost heartbeats do not
 * make a present peer vanish.
 */
export const PRESENCE_HEARTBEAT_MS = 10_000

/**
 * How long a peer's presence survives without being restated.
 *
 * Thirty seconds: three heartbeats. It is the same number `y-protocols` uses
 * for `outdatedTimeout` and for the same reason — long enough that a garbage
 * collection pause or a slow network does not erase somebody who is sitting
 * there, short enough that a closed tab's cursor is gone before anybody acts on
 * it.
 *
 * Both ends apply it. The relay applies it so that the roster it hands a joiner
 * has no ghosts in it and so that its own memory is bounded; a client applies it
 * so that a peer whose *server* went away — a dropped Redis message, a replica
 * that died — does not stay on the grid forever. Neither end depends on the
 * other having done it.
 */
export const PRESENCE_TIMEOUT_MS = 30_000

/**
 * The longest display name this protocol will carry.
 *
 * Forty-eight characters, and it is a ceiling rather than a validation: the
 * relay truncates instead of refusing, because a name is not something a peer
 * chose in this frame — it comes out of the database — and refusing to show
 * somebody's presence because their display name is long would be a bug wearing
 * a policy's clothes.
 */
export const MAX_PRESENCE_NAME_LENGTH = 48

/**
 * How many operations a peer's selection may name in a presence frame.
 *
 * Eight, which is not the editor's ceiling on a selection — that is bounded only
 * by the circuit. What travels is what is *drawn*: an outline per selected gate
 * on somebody else's screen, so a peer who selects two hundred gates is
 * announcing "I am working over here", and eight outlines say that as well as
 * two hundred do while keeping this frame small enough to send at a drag's frame
 * rate. The client sends the first eight in the selection's own order and the
 * roster says how many there are in words, which is the part a person actually
 * reads.
 */
export const MAX_PRESENCE_SELECTION = 8

/**
 * How many presence frames one socket may send in `SOCKET_FRAME_WINDOW_MS`.
 *
 * A third budget, beside the frame budget and the update budget, because it
 * meters a third kind of work. A presence frame reaches no database (the
 * authorisation behind it is the attachment's, already cached) and touches no
 * document — it is a fan-out to at most `MAX_PEERS_PER_DOCUMENT` sockets and
 * nothing else. Counting it against the sixty-per-ten-seconds budget sized
 * against Postgres round trips would close the socket of somebody moving their
 * cursor, which is not a threat model.
 *
 * A hundred and fifty is above what a throttled client produces — one frame per
 * `PRESENCE_THROTTLE_MS` is a hundred per window, plus heartbeats — and far
 * below what would cost this process anything: the frames are a few hundred
 * bytes and their handling is a map write.
 */
export const MAX_COLLAB_PRESENCE_PER_WINDOW = 150

/**
 * How often a client may send its position, at most.
 *
 * A cursor moves with the arrow keys and a selection changes with every drag
 * frame, so the honest rate is "whenever it changed", which on a drag is per
 * animation frame. This is the coalescing interval that turns that into a frame
 * rate: 120 ms is inside the 100 ms window a person reads as immediate and is
 * eight frames a second rather than sixty.
 *
 * It lives in the contract rather than in the client because it is the number
 * `MAX_COLLAB_PRESENCE_PER_WINDOW` was chosen against, and two numbers that
 * only make sense together belong in one file.
 */
export const PRESENCE_THROTTLE_MS = 120

/**
 * A peer's identity inside one session.
 *
 * Minted by the server, per socket, and opaque: nothing about it is derived
 * from the user it belongs to. That is deliberate — a peer id is broadcast to
 * everybody in the session, so making it the user id would publish a durable
 * identifier for every anonymous watcher of a PUBLIC circuit, to anybody who
 * can open one. Two tabs of one person are two peers, which is also what the
 * cursors should show: there really are two carets.
 *
 * Shaped like every other id on this socket so it can be echoed into a frame
 * and used as a map key without being able to carry a separator.
 */
const PeerIdSchema = RunIdSchema

/**
 * The cell a peer is focused on.
 *
 * `qubit` admits `MAX_QUBITS` rather than `MAX_QUBITS - 1` because the canvas's
 * grid has one row the circuit does not: the classical register sits at the
 * virtual wire index `size.qubits` (`geometry.ts`'s `isRegisterRow`), and a
 * cursor is perfectly entitled to stand there. A client that receives a cell
 * outside the grid it is drawing simply does not draw it — the two peers may be
 * looking at circuits of different widths for as long as it takes an update to
 * arrive, and a presence frame is not the place to resolve that.
 */
export const PresenceCursorSchema = z.strictObject({
  qubit: z.int().min(0).max(MAX_QUBITS),
  column: z
    .int()
    .min(0)
    .max(MAX_COLUMNS - 1),
})

export type PresenceCursor = z.infer<typeof PresenceCursorSchema>

/**
 * What a peer says about itself: where it is looking, and how much it has done.
 *
 * Every field here is self-asserted and none of it is trusted for anything. A
 * cursor two columns off is a caret drawn in the wrong place; a `selection`
 * naming operations that do not exist draws nothing. That is the whole risk
 * surface, and it is why presence may be self-asserted at all while `name` and
 * `access` may not.
 *
 * `edits` is the one field that is not a position, and it exists so that a
 * screen reader can be told the one thing that matters without being told the
 * things that do not. A live region that announced every cursor movement would
 * be unusable; arrivals, departures and *edits* are the events worth
 * interrupting for. The document itself cannot say who made a change — a CRDT
 * update carries no author — so the peer counts its own committed gestures and
 * a client announces a peer whose count grew. It is cosmetic by construction:
 * the worst a lying peer achieves is a sentence about an edit that did not
 * happen, and the document is still the only authority on what is in it.
 */
export const PresencePositionSchema = z.strictObject({
  cursor: PresenceCursorSchema.nullable(),
  selection: z
    .array(storableText(z.string().min(1).max(64)))
    .max(MAX_PRESENCE_SELECTION),
  /** Gestures this peer has committed since it joined. Monotonic; cosmetic. */
  edits: z
    .int()
    .min(0)
    .max(2 ** 31 - 1),
})

export type PresencePosition = z.infer<typeof PresencePositionSchema>

/**
 * A peer as everybody else sees it: what it said, plus who the server says it
 * is.
 *
 * `name` is `null` for a peer that never authenticated — an anonymous watcher
 * of a PUBLIC or UNLISTED circuit, which §3.4 admits on purpose. The frame
 * carries the null rather than a word, because the word is a user-facing string
 * and D2 puts every one of those in three catalogs on the client; a server that
 * sent "Anonymous" would be sending English to a French reader.
 *
 * `access` is the relay's answer and not the peer's claim, so a roster can say
 * "watching" without a client having to guess. It is re-decided on the same
 * cadence every other authorisation on this socket is.
 */
export const PresenceStateSchema = PresencePositionSchema.extend({
  name: z.string().min(1).max(MAX_PRESENCE_NAME_LENGTH).nullable(),
  access: z.enum(COLLAB_ACCESS),
})

export type PresenceState = z.infer<typeof PresenceStateSchema>

/**
 * Why the relay ended an attachment the client did not leave.
 *
 *   `unauthorised`  the circuit stopped being this viewer's to read, or to
 *                   write — unpublished, made private, or the owner's grant
 *                   withdrawn. Re-checked while the session runs and not only
 *                   when it opened, for the reason `ws/session.ts` argues at
 *                   length about run subscriptions.
 *   `overloaded`    the relay could not deliver to this peer as fast as the
 *                   document was changing. It is ended rather than starved
 *                   because a peer that misses an update is a peer whose
 *                   document is now wrong, and silence would let it keep
 *                   editing a document nobody else has.
 *   `gone`          the relay let the document go — the process is shutting
 *                   down, or the document was dropped. Rejoining is correct and
 *                   the client's local state is still good: it will be merged.
 */
export const COLLAB_END_REASONS = [
  'unauthorised',
  'overloaded',
  'gone',
] as const

export type CollabEndReason = (typeof COLLAB_END_REASONS)[number]

/**
 * What a client may send.
 *
 * Eight frames. Four are §8's run feed and were the whole protocol through
 * Fase 4; four are the collaboration channel, and three of those are the first
 * frames in this protocol that *write* anything (the fourth, `collab:presence`,
 * writes nothing that outlives the connection — see its own note).
 *
 * That is a real change to the sentence this schema used to carry — "no frame
 * asks the server to do anything" — and it is worth stating what replaces it
 * rather than letting it lapse. A collaboration update writes to a document,
 * never to a table: the relay applies it, fans it out and eventually persists
 * the *document*, and nothing it does can create a version, publish a circuit,
 * spend a hardware allowance or start a run. Everything that changes a row a
 * reader can see still goes through the REST surface with its own admission
 * checks. What the socket gained is a shared scratchpad, bounded in size, in
 * rate and in who may write to it.
 */
export const ClientFrameSchema = z.discriminatedUnion('type', [
  /**
   * Prove an identity. Optional, and accepted once — see the API's session.
   *
   * The socket's lifetime is bounded by this token's `exp` once it is
   * presented, so a long-lived connection cannot outlive the credential it was
   * opened with. A client that is told its token expired reconnects with a
   * fresh one, which it already has to be able to do.
   */
  z.object({
    type: z.literal('authenticate'),
    token: z.string().min(1).max(MAX_SOCKET_TOKEN_LENGTH),
  }),
  z.object({ type: z.literal('subscribe'), runId: RunIdSchema }),
  z.object({ type: z.literal('unsubscribe'), runId: RunIdSchema }),
  /**
   * A liveness probe the *client* initiates.
   *
   * Not the same thing as the protocol-level ping the server sends: a browser's
   * `WebSocket` cannot send a control-frame ping and cannot observe one either,
   * so a tab that has been suspended and resumed has no way to tell a live
   * connection from a dead one whose close event never fired. This frame is how
   * it asks.
   */
  z.object({ type: z.literal('ping') }),
  /**
   * Attach to a circuit's shared document — §8's `circuit:<id>`.
   *
   * `since` is the joiner's Yjs state vector, base64: "here is what I already
   * have". The server answers with the difference rather than the whole
   * document, which is what makes a reconnect cheap and, more importantly, what
   * makes it *correct* — a client that had edited offline keeps its edits and
   * receives only what it missed. It is absent for a client with nothing, which
   * is the ordinary first join.
   *
   * A state vector is one clock per peer that has ever written, so it is bounded
   * by the number of writers rather than by the size of the circuit: two
   * kilobytes is hundreds of them.
   */
  z.object({
    type: z.literal('collab:join'),
    circuitId: CircuitIdSchema,
    since: base64Field(2048).optional(),
  }),
  /**
   * One CRDT update, base64.
   *
   * Opaque by construction — there is no field in it for the server to inspect —
   * so it is judged in the only three ways available: by its size before it is
   * decoded, by its rate, and by what the document *says* after it has been
   * applied. The third is the one that matters and the reason the relay shares
   * `@qsim/collab` with the browser: a well-formed update describing an illegal
   * circuit must not be able to make every other peer illegal.
   */
  z.object({
    type: z.literal('collab:update'),
    circuitId: CircuitIdSchema,
    update: base64Field(MAX_COLLAB_UPDATE_BYTES),
  }),
  /**
   * Where this peer is looking — M5.3.
   *
   * Sent on a change, coalesced to `PRESENCE_THROTTLE_MS`, and restated every
   * `PRESENCE_HEARTBEAT_MS` so that a peer which stops sending is a peer which
   * has gone. It carries no identity: see `PresencePositionSchema`.
   *
   * A read-only peer may send this. Presence is not a document write — nothing
   * it says survives the connection, reaches a row, or changes what anybody
   * else's circuit contains — and refusing it would make a watcher invisible in
   * a session they are allowed to be in, which is the opposite of what §3.4
   * admits watchers for. What it *is* subject to is the attachment: a peer whose
   * read access is withdrawn stops being relayed at all.
   */
  z.object({
    type: z.literal('collab:presence'),
    circuitId: CircuitIdSchema,
    state: PresencePositionSchema,
  }),
  z.object({
    type: z.literal('collab:leave'),
    circuitId: CircuitIdSchema,
  }),
])

export type ClientFrame = z.infer<typeof ClientFrameSchema>

/* ────────────────────────────── server frames ───────────────────────── */

/**
 * Why a subscription ended without the client asking.
 *
 *   `unauthorised`  the run stopped being readable by this viewer — the run's
 *                   circuit was unpublished, or made private, while the client
 *                   was watching. The subscription is dropped and the client is
 *                   told, rather than the events simply stopping, because a
 *                   stream that goes quiet is indistinguishable from a run that
 *                   is taking a long time.
 *   `finished`      the run reached a terminal status. The server releases the
 *                   channel rather than waiting for a client that may never
 *                   unsubscribe, and the client has everything it needs.
 */
export const SUBSCRIPTION_END_REASONS = ['unauthorised', 'finished'] as const

export type SubscriptionEndReason = (typeof SUBSCRIPTION_END_REASONS)[number]

/**
 * The error codes a frame may carry.
 *
 * A strict subset of `API_ERROR_CODES`, and deliberately not a vocabulary of
 * its own: `apps/web` already translates every one of these into three
 * catalogs, and a socket-only code would be a sentence nobody wrote. Each one
 * means here exactly what it means over HTTP —
 *
 *   `AUTH_INVALID_TOKEN`      the token in `authenticate` did not verify.
 *   `NOT_FOUND`               no such run, or not this viewer's to see. One
 *                             code for both, for the reason every read in this
 *                             API answers 404 rather than 403.
 *   `VALIDATION_FAILED`       the frame did not parse.
 *   `RATE_LIMITED`            this socket is already watching as many runs as
 *                             it may.
 *   `SIMULATION_UNAVAILABLE`  no queue is configured or reachable, so there is
 *                             nothing to subscribe to. The same 503 the REST
 *                             route answers, arriving the same way.
 *
 * The collaboration channel adds four, and each one is an existing HTTP code
 * used for the same thing it means there —
 *
 *   `FORBIDDEN`               403. This peer may read the circuit and may not
 *                             write it, and it sent an update. Deliberately not
 *                             `NOT_FOUND`: the peer was *told* it had read
 *                             access when it joined, so hiding the circuit's
 *                             existence now would be theatre, and a client that
 *                             cannot tell "not yours to edit" from "gone" cannot
 *                             say anything useful to the person reading.
 *   `PAYLOAD_TOO_LARGE`       413. The update is past
 *                             `MAX_COLLAB_UPDATE_BYTES`, or the socket is past
 *                             its byte budget for the window.
 *   `CIRCUIT_TOO_LARGE`       413. The shared document is past
 *                             `MAX_COLLAB_STATE_BYTES`, so it cannot be served
 *                             or persisted. About the document's weight, exactly
 *                             as the REST code is about a saved circuit's.
 *   `DATABASE_UNAVAILABLE`    503. The document could not be loaded or the
 *                             circuit could not be read. The socket stays open;
 *                             the client may retry the join.
 */
export const SOCKET_ERROR_CODES = [
  'AUTH_INVALID_TOKEN',
  'NOT_FOUND',
  'FORBIDDEN',
  'VALIDATION_FAILED',
  'PAYLOAD_TOO_LARGE',
  'CIRCUIT_TOO_LARGE',
  'RATE_LIMITED',
  'SIMULATION_UNAVAILABLE',
  'DATABASE_UNAVAILABLE',
] as const

export type SocketErrorCode = (typeof SOCKET_ERROR_CODES)[number]

/**
 * Close codes this server uses, in the private range the RFC reserves for
 * applications (4000–4999).
 *
 * A close code rather than an error frame wherever the connection cannot
 * continue, because an error frame on a socket the client is about to lose is a
 * message nobody reads. The client maps these to whether it should reconnect at
 * all: `EXPIRED` and `IDLE` are "reconnect, with a fresh token"; `PROTOCOL` is
 * "this build is wrong" and reconnecting would loop.
 */
export const SOCKET_CLOSE = {
  /** The presented token's `exp` passed. Reconnect with a fresh one. */
  EXPIRED: 4001,
  /** Nothing was subscribed within the opening window. See the API's session. */
  IDLE: 4002,
  /** A frame this protocol does not define, or too many bad ones. */
  PROTOCOL: 4003,
  /** The process is shutting down. Reconnect; another replica will answer. */
  GOING_AWAY: 4004,
  /**
   * This socket asked for more than §11 allows — too many frames in a window,
   * or too many frames pending at once, or too many connections from one
   * caller.
   *
   * Distinct from `PROTOCOL` because the frames were *valid*: this build is not
   * wrong, it was merely too fast, so reconnecting on the ordinary backoff is
   * the right response rather than a loop. Distinct from an `error` frame
   * because a socket that is over budget must stop costing this process
   * something, and answering it forever is the amplifier that would be.
   */
  OVERLOADED: 4005,
} as const

export type SocketCloseCode = (typeof SOCKET_CLOSE)[keyof typeof SOCKET_CLOSE]

/**
 * What the server may send.
 *
 * The three §8 names are here (`run:progress`, `run:complete`, `job:status`)
 * plus the four that make a socket usable: what happened when it opened, what
 * happened to a subscription, an error scoped to a run, and the answer to a
 * client ping.
 */
export const ServerFrameSchema = z.discriminatedUnion('type', [
  /**
   * Sent on open, and again after a successful `authenticate`.
   *
   * `viewer` is the id this socket proved, or null — echoed so a client can
   * tell "my token was accepted" from "my token was ignored", which are
   * indistinguishable from the outside and produce very different subscription
   * outcomes.
   */
  z.object({
    type: z.literal('ready'),
    viewer: z.string().nullable(),
    /** Epoch milliseconds at which this socket will be closed. Null if anonymous. */
    expiresAt: z.number().int().nullable(),
  }),
  /**
   * The subscription was accepted, with the run's status at that instant.
   *
   * The status is what closes the race between `POST /simulate` answering 202
   * and this frame arriving: a run that finished in between would otherwise
   * produce no further events, and the client would wait for something that has
   * already happened. Seeing a terminal status here, it reads the run instead.
   */
  z.object({
    type: z.literal('subscribed'),
    runId: RunIdSchema,
    /**
     * The union of both lifecycles, because one `subscribe` frame watches
     * either.
     *
     * A client subscribes to an *id*; what kind of thing that id names is
     * decided by the server when it authorises the subscription, and is then
     * evident from the status it comes back with — `SUBMITTED` and `CANCELLED`
     * exist only for hardware. A second frame type would have meant a second
     * `subscribe`, a second ceiling, a second authorisation path and a second
     * ordering guard, all to carry the same sentence: "you are now watching
     * this, and here is where it had got to".
     */
    status: z.union([RunStatusSchema, HardwareJobStatusSchema]),
  }),
  z.object({
    type: z.literal('unsubscribed'),
    runId: RunIdSchema,
    reason: z.enum(SUBSCRIPTION_END_REASONS),
  }),
  z.object({
    type: z.literal('run:progress'),
    runId: RunIdSchema,
    phase: z.enum(['validating', 'simulating', 'sampling', 'summarising']),
    /** Units finished in this phase, or null where the phase does not divide. */
    completed: z.number().int().min(0).nullable(),
    total: z.number().int().min(1).nullable(),
  }),
  z.object({
    type: z.literal('job:status'),
    runId: RunIdSchema,
    status: RunStatusSchema,
  }),
  /**
   * The run is finished. Read it with `GET /simulate/:runId`.
   *
   * Carries no result — see the header. What it does carry is enough for the UI
   * to stop waiting immediately rather than after a round trip: whether the run
   * succeeded, how long the engine spent, and the failure code if there was one.
   */
  z.object({
    type: z.literal('run:complete'),
    runId: RunIdSchema,
    status: z.enum(['DONE', 'FAILED']),
    durationMs: z.number().int().min(0).nullable(),
    error: z.string().max(64).nullable(),
  }),
  /**
   * A hardware job moved — §3.7, Phase 4.
   *
   * Separate from `job:status` rather than folded into it, and the reason is
   * that the two vocabularies are genuinely different: a hardware job has
   * SUBMITTED (the row exists, nothing has been sent) and CANCELLED (a person
   * stopped it), neither of which a simulation run can be. Widening
   * `job:status` would have made those two statuses reachable in a frame about
   * a run, where they mean nothing.
   *
   * `queuePosition` is where a job sits in the device's queue, when the
   * provider says — which, on the current Quantum API, it does not. The number
   * a person actually gets is the device's queue *length*, from
   * `GET /hardware/backends`, and it is shown beside every device before they
   * choose one rather than after.
   */
  z.object({
    type: z.literal('hardware:status'),
    runId: RunIdSchema,
    status: HardwareJobStatusSchema,
    queuePosition: z.number().int().min(0).nullable(),
  }),
  /**
   * A hardware job finished. Read it with `GET /hardware/jobs/:id`.
   *
   * Carries no result, for the same reason `run:complete` does not: the answer
   * lives in Postgres and the route that serves it re-applies §11 with no
   * cache, while this frame's authorisation was decided up to
   * `AUTHORISATION_TTL_MS` ago.
   *
   * Three statuses and not two. CANCELLED is a real third outcome: somebody who
   * stopped a job to protect their ten-minute allowance has not had a failure,
   * and reporting one would tell them something went wrong with their circuit.
   */
  z.object({
    type: z.literal('hardware:complete'),
    runId: RunIdSchema,
    status: z.enum(['DONE', 'FAILED', 'CANCELLED']),
    error: z.string().max(64).nullable(),
  }),
  z.object({
    type: z.literal('error'),
    code: z.enum(SOCKET_ERROR_CODES),
    /** The run the error is about, when it is about one. */
    runId: RunIdSchema.nullable(),
  }),
  z.object({ type: z.literal('pong') }),
  /**
   * The attachment was accepted — §3.4's shared session, opened.
   *
   * `update` is everything the joiner is missing, as one Yjs update: the whole
   * document for a fresh client, or only the difference from the `since` it
   * sent. Applying it is all a client has to do; the CRDT merges it with
   * whatever it already had.
   *
   * `access` says whether this peer may write, and `deferred` and `overflow` are
   * the two numbers the projection produces that a person needs told about — how
   * many operations the document holds that the circuit cannot carry (§6's
   * column conflict, resolved by deferral rather than by repair) and how many
   * slots past `MAX_DOCUMENT_OPERATIONS` are not read at all. They travel on the
   * join frame because a client that joins into a document with three deferred
   * gates has to show that immediately; afterwards it computes them itself, from
   * the same projection, on every update.
   *
   * `vector` is the relay's own state vector, and it is what closes the other
   * half of a reconnect. `since` tells the relay what the joiner lacks; nothing
   * told the joiner what the *session* lacks from it, so a peer that edited while
   * disconnected stayed diverged from everybody until it volunteered its entire
   * document — which is bounded by `MAX_COLLAB_UPDATE_BYTES`, not by the document
   * ceiling, so for a large document it could not volunteer it at all. With the
   * vector the client answers with a delta: `Y.encodeStateAsUpdate(doc, vector)`,
   * one frame, only the edits the relay has never seen.
   *
   * A state vector is small — a few bytes per client id that has ever written —
   * but it is bounded by the same field ceiling as the update rather than by a
   * figure of its own, because there is exactly one thing a client does with a
   * field it cannot parse and it is the same for both.
   */
  z.object({
    type: z.literal('collab:joined'),
    circuitId: CircuitIdSchema,
    access: z.enum(COLLAB_ACCESS),
    update: base64Field(MAX_COLLAB_STATE_BYTES),
    vector: base64Field(MAX_COLLAB_UPDATE_BYTES),
    deferred: z.number().int().min(0),
    overflow: z.number().int().min(0),
  }),
  /**
   * Somebody else's update, fanned out.
   *
   * Never echoed to its sender — the relay tracks which connection an update
   * arrived on and skips it — because a client that applied its own update back
   * would be applying a no-op at best and, through the bridge, would be told to
   * adopt a document it had just written.
   */
  z.object({
    type: z.literal('collab:update'),
    circuitId: CircuitIdSchema,
    update: base64Field(MAX_COLLAB_UPDATE_BYTES),
  }),
  /**
   * Somebody else's presence — M5.3.
   *
   * One frame per peer, and `state: null` means that peer is gone: it left, its
   * socket closed, or its heartbeats stopped and the relay expired it. One frame
   * with a nullable payload rather than two frame types, because a client keyed
   * by `peerId` does the same thing with both — set the entry or delete it — and
   * a second type would be a second thing to forget in the reducer.
   *
   * A joiner is sent the whole roster this way, one frame per peer already
   * present, immediately after its `collab:joined`. That is bounded by
   * `MAX_PEERS_PER_DOCUMENT` and needs no field on the join frame; it also means
   * there is exactly one code path in the client for "a peer exists", whether it
   * was here first or arrived later.
   *
   * Never echoed to the peer it describes. A client knows where its own cursor
   * is, and drawing a second caret on top of the real one is the classic
   * presence bug.
   */
  z.object({
    type: z.literal('collab:presence'),
    circuitId: CircuitIdSchema,
    peerId: PeerIdSchema,
    state: PresenceStateSchema.nullable(),
  }),
  z.object({
    type: z.literal('collab:left'),
    circuitId: CircuitIdSchema,
    reason: z.enum(COLLAB_END_REASONS),
  }),
  /**
   * Something went wrong with one attachment, and the socket survives it.
   *
   * Its own frame rather than a widened `error`, because the subject is
   * different: `error.runId` names a run, and a client keyed by run id would
   * have to guess whether a null meant "the whole socket" or "the circuit I just
   * asked about". Two frames, two subjects, no guessing.
   */
  z.object({
    type: z.literal('collab:error'),
    circuitId: CircuitIdSchema,
    code: z.enum(SOCKET_ERROR_CODES),
  }),
])

export type ServerFrame = z.infer<typeof ServerFrameSchema>

/**
 * A frame off the wire, or `null`.
 *
 * Both ends parse rather than cast, and both ends answer `null` instead of
 * throwing. On the server the reason is §11 — a frame is untrusted input from
 * whoever opened the socket. On the client it is deployment skew: an API
 * running ahead of this bundle can send a frame this build has no member for,
 * and dropping it must never be able to sever a connection that is otherwise
 * delivering a run perfectly.
 */
export function parseClientFrame(raw: string): ClientFrame | null {
  return parseFrame(raw, ClientFrameSchema, MAX_SOCKET_FRAME_BYTES)
}

export function parseServerFrame(raw: string): ServerFrame | null {
  return parseFrame(raw, ServerFrameSchema, MAX_SERVER_FRAME_BYTES)
}

function parseFrame<Schema extends z.ZodType>(
  raw: string,
  schema: Schema,
  ceiling: number
): z.infer<Schema> | null {
  if (raw.length > ceiling) return null
  let value: unknown
  try {
    value = JSON.parse(raw)
  } catch {
    return null
  }
  const parsed = schema.safeParse(value)
  return parsed.success ? parsed.data : null
}

export function encodeFrame(frame: ClientFrame | ServerFrame): string {
  return JSON.stringify(frame)
}

/* ─────────────────────────── binary in a text frame ─────────────────────── */

/**
 * Base64, written out here rather than delegated.
 *
 * A CRDT update is binary and this protocol is JSON, so the bytes have to be
 * text somewhere. The obvious two delegations are both wrong for this package:
 * `Buffer` is a Node builtin and the contract is imported by the browser bundle,
 * and `btoa`/`atob` are legacy globals whose input and output are byte-strings —
 * they work, and the day one of them meets a lone surrogate it does something
 * silent rather than something wrong. Twenty lines with no dependency is cheaper
 * than either, and it is exactly as fast: the encoder is one pass over the
 * bytes.
 *
 * The pair lives with the frames, not with `@qsim/collab`, and the boundary
 * rules say why it has to: the contract may not import the mapping and the
 * mapping may not import the contract, so a codec either side could reach would
 * have to be duplicated. This is a property of *the wire*, which is this file's
 * subject.
 */
const BASE64_ALPHABET =
  'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'

/** Character code → sextet, with `-1` for every byte that is not base64. */
const BASE64_VALUES: Int8Array = (() => {
  const table = new Int8Array(128).fill(-1)
  for (let index = 0; index < BASE64_ALPHABET.length; index += 1) {
    table[BASE64_ALPHABET.charCodeAt(index)] = index
  }
  return table
})()

/** One sextet as its character. `charAt` because an index may be undefined. */
function sextet(value: number): string {
  return BASE64_ALPHABET.charAt(value & 63)
}

export function encodeBinaryPayload(bytes: Uint8Array): string {
  let text = ''
  let index = 0
  for (; index + 2 < bytes.length; index += 3) {
    const triple =
      ((bytes[index] as number) << 16) |
      ((bytes[index + 1] as number) << 8) |
      (bytes[index + 2] as number)
    text +=
      sextet(triple >> 18) +
      sextet(triple >> 12) +
      sextet(triple >> 6) +
      sextet(triple)
  }
  const remaining = bytes.length - index
  if (remaining === 1) {
    const value = bytes[index] as number
    text += `${sextet(value >> 2)}${sextet(value << 4)}==`
  } else if (remaining === 2) {
    const value = ((bytes[index] as number) << 8) | (bytes[index + 1] as number)
    text += `${sextet(value >> 10)}${sextet(value >> 4)}${sextet(value << 2)}=`
  }
  return text
}

/**
 * Base64 back to bytes, or `null`.
 *
 * `null` and never a throw, and never a best effort over the characters it
 * understood: this is called on a frame a stranger sent, on a hot path, and a
 * decoder that skipped what it could not read would hand the CRDT a *truncated*
 * update — which decodes, integrates, and leaves the document holding half of
 * somebody's gesture. A refusal is recoverable; a silent partial apply is not.
 */
export function decodeBinaryPayload(text: string): Uint8Array | null {
  let end = text.length
  while (end > 0 && text.charCodeAt(end - 1) === 61 /* '=' */) end -= 1
  // A base64 group is four characters; a remainder of one cannot be produced by
  // any input and is therefore a value nobody encoded.
  if (end % 4 === 1) return null

  const bytes = new Uint8Array(Math.floor((end * 3) / 4))
  let written = 0
  let accumulator = 0
  let bits = 0
  for (let index = 0; index < end; index += 1) {
    const code = text.charCodeAt(index)
    const value = code < 128 ? (BASE64_VALUES[code] as number) : -1
    if (value < 0) return null
    accumulator = (accumulator << 6) | value
    bits += 6
    if (bits >= 8) {
      bits -= 8
      bytes[written] = (accumulator >> bits) & 0xff
      written += 1
    }
  }
  return written === bytes.length ? bytes : bytes.subarray(0, written)
}
