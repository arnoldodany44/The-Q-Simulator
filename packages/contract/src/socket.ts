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

import { z } from 'zod'
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
 * Every client frame is a type and either a run id or a token, so a legitimate
 * one is well under half of this. It is passed to the WebSocket server as
 * `maxPayload`, which means an oversized frame is refused by the protocol layer
 * and the connection is closed — the message is never buffered, which is the
 * property that matters: a socket is a stream, and a server that accumulated
 * frames before deciding they were too big would be a memory ceiling anybody
 * could raise.
 */
export const MAX_SOCKET_FRAME_BYTES = 8 * 1024

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

const RunIdSchema = z
  .string()
  .min(1)
  .max(64)
  .regex(/^[A-Za-z0-9_-]+$/)

/**
 * What a client may send.
 *
 * Four frames, and no frame that asks the server to *do* anything: a socket
 * cannot submit a run, cancel one, or change any state. Everything that writes
 * goes through the REST surface, where the rate limiter, the body limit and the
 * §11 admission checks already live — a second write path with its own
 * authorisation would be a second place for them to be forgotten.
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
 */
export const SOCKET_ERROR_CODES = [
  'AUTH_INVALID_TOKEN',
  'NOT_FOUND',
  'VALIDATION_FAILED',
  'RATE_LIMITED',
  'SIMULATION_UNAVAILABLE',
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
    status: RunStatusSchema,
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
  z.object({
    type: z.literal('error'),
    code: z.enum(SOCKET_ERROR_CODES),
    /** The run the error is about, when it is about one. */
    runId: RunIdSchema.nullable(),
  }),
  z.object({ type: z.literal('pong') }),
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
  return parseFrame(raw, ClientFrameSchema)
}

export function parseServerFrame(raw: string): ServerFrame | null {
  return parseFrame(raw, ServerFrameSchema)
}

function parseFrame<Schema extends z.ZodType>(
  raw: string,
  schema: Schema
): z.infer<Schema> | null {
  if (raw.length > MAX_SOCKET_FRAME_BYTES) return null
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
