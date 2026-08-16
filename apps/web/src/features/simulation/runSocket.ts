/**
 * The browser's end of §8's `/ws`: one connection, shared, that reconnects.
 *
 * ═══════════════════════════════════════════════════════════════════════
 * WHAT A DROPPED SOCKET COSTS, AND HOW IT IS RECOVERED
 *
 * Redis pub/sub delivers at most once, so a socket that drops loses every event
 * that was published while it was down — and it drops routinely: a laptop lid,
 * a phone changing network, a proxy's idle timeout, a redeploy of the API.
 *
 * **The chosen recovery is to poll `GET /simulate/:runId` on every
 * (re)subscription, and not to replay events.** The alternative would need the
 * server to retain a per-run event log, decide how long to keep it, give the
 * client a cursor, and reason about a client that reconnects to a *different*
 * replica — a small distributed-log problem, built to redeliver notifications
 * whose entire content is "there is something new to read". Polling the run is
 * one request against a route that already exists, already applies §11's
 * visibility filter, and is already the authoritative answer. It is also the
 * same code path the client uses when there is no socket at all, so the socket
 * is a latency optimisation over a system that is correct without it — which is
 * the only shape in which a socket is safe to depend on.
 *
 * The consequence is a rule this file honours everywhere: **nothing here is
 * ever the only way a fact arrives.** `onResync` fires on every successful
 * subscription, including the first, and the consumer reads the run.
 *
 * ── One socket, many runs ────────────────────────────────────────────────
 *
 * A connection is opened on the first `watch` and closed when the last watcher
 * goes away, so a reader who never sends anything to the server never opens
 * one. Everything watched is re-subscribed after a reconnect, from the same
 * table, which is why the desired set is kept separately from the confirmed
 * one: what the client *wants* to watch survives a disconnection, and what the
 * server has *confirmed* does not.
 *
 * ── The token goes in a frame, not in the URL ────────────────────────────
 *
 * Argued in `@qsim/contract`'s `socket.ts`: a query parameter would put a
 * bearer token in the request line, which every proxy and access log records
 * verbatim. It is fetched fresh on each connection rather than captured once,
 * because a reconnect an hour later must not present the token this socket was
 * opened with — and because the client may have signed in or out in between.
 */

import { SOCKET_CLOSE, encodeFrame, parseServerFrame } from '@qsim/contract'
import type { ClientFrame, ServerFrame, SocketErrorCode } from '@qsim/contract'

/**
 * The part of `WebSocket` this file uses.
 *
 * Narrow on purpose, exactly like `SimulationWorkerLike`: the tests drive the
 * real reconnection logic with a stand-in they can open, drop and reopen on
 * demand, and a real `WebSocket` satisfies this without an adapter. A timing
 * bug that needs a real network to reproduce is a timing bug with no test.
 */
export interface SocketLike {
  send(data: string): void
  close(code?: number, reason?: string): void
  onopen: ((event: unknown) => void) | null
  onmessage: ((event: { data: unknown }) => void) | null
  onclose: ((event: { code?: number }) => void) | null
  onerror: ((event: unknown) => void) | null
}

export interface RunWatcher {
  /** The subscription was (re)confirmed. Read the run: events may be missing. */
  readonly onResync: (status: ServerFrame & { type: 'subscribed' }) => void
  readonly onProgress: (frame: ServerFrame & { type: 'run:progress' }) => void
  readonly onStatus: (frame: ServerFrame & { type: 'job:status' }) => void
  readonly onComplete: (frame: ServerFrame & { type: 'run:complete' }) => void
  /**
   * The server refused or ended this subscription. `code` is `NOT_FOUND` when
   * the run stopped being readable, which a client must treat exactly as it
   * treats a 404 from the REST route.
   */
  readonly onRefused: (code: SocketErrorCode | 'unauthorised') => void
  /** The transport went away. Nothing is lost; a resync follows if it returns. */
  readonly onOffline?: () => void
}

export interface RunSocket {
  /** Starts watching a run. The returned function stops. */
  readonly watch: (runId: string, watcher: RunWatcher) => () => void
  /** For tests and for the UI's "live" indicator. */
  readonly connected: () => boolean
  readonly close: () => void
}

export interface RunSocketOptions {
  readonly url: string
  /** A bearer token, or null for an anonymous socket. Asked per connection. */
  readonly getToken?: () => Promise<string | null>
  readonly connect?: (url: string) => SocketLike
  /** Injected so the backoff can be exercised without waiting for a clock. */
  readonly schedule?: (run: () => void, delayMs: number) => () => void
  /** Injected so the jitter is deterministic in a test. */
  readonly random?: () => number
}

/**
 * How long to wait before each reconnection attempt, in milliseconds.
 *
 * Front-loaded and then flattening at fifteen seconds. The first entry is short
 * because the overwhelmingly common cause is momentary — a redeploy, a network
 * hand-off — and a reader watching a run should not see a gap they could
 * notice. The tail is long because the *other* cause is an API that is down,
 * and a tab left open against a dead host must not become a request per second
 * for the rest of the afternoon.
 */
export const RECONNECT_BACKOFF_MS = [
  500, 1_000, 2_000, 4_000, 8_000, 15_000,
] as const

/**
 * How much the delay is randomised, as a fraction.
 *
 * A quarter, and it exists for one specific event: an API redeploy drops every
 * socket at the same instant, and a fixed backoff would bring all of them back
 * at the same instant too — a thundering herd against a process that has just
 * started. Jitter is the whole defence, and it costs nothing.
 */
export const RECONNECT_JITTER = 0.25

interface Watched {
  readonly runId: string
  readonly watcher: RunWatcher
}

export function createRunSocket(options: RunSocketOptions): RunSocket {
  const open = options.connect ?? defaultConnect
  const schedule = options.schedule ?? defaultSchedule
  const random = options.random ?? Math.random
  const getToken = options.getToken ?? (() => Promise.resolve(null))

  /** What this client *wants* to watch. Survives every disconnection. */
  const wanted = new Map<string, Watched>()
  let socket: SocketLike | null = null
  let ready = false
  let attempt = 0
  let cancelRetry: (() => void) | null = null
  let closed = false
  /**
   * What has already been claimed on the *current* connection.
   *
   * Reset with every socket, because a subscription is a property of a
   * connection and not of this object. It is what makes `subscribeAll`
   * idempotent, which matters because there are three legitimate triggers for
   * it — the token resolving, the `ready` frame, a `watch` on a live socket —
   * and two of them can fire for the same run in either order.
   */
  let claimed = new Set<string>()
  /**
   * Whether a `ready` frame that reports no viewer should be ignored.
   *
   * The server sends `ready` the instant a socket opens and *again* after a
   * successful `authenticate`, so a client that has presented a token will see
   * two — and subscribing on the first would ask the server to authorise every
   * run against an anonymous viewer. It would answer 404 for runs the reader
   * can plainly see, and the consumer would report them as gone.
   */
  let awaitingAuthenticatedReady = false
  /**
   * Which connection a callback belongs to.
   *
   * A socket that has been replaced can still deliver a queued `onmessage` or a
   * late `onclose`, and acting on either would re-open a connection that
   * already exists or mark a live one dead. Comparing generations is the same
   * staleness guard the scheduler applies to a worker reply, for the same
   * reason.
   */
  let generation = 0

  function send(frame: ClientFrame): void {
    if (socket === null || !ready) return
    try {
      socket.send(encodeFrame(frame))
    } catch {
      // A send on a socket that died between the check and the call. The close
      // handler is already on its way and will reconnect.
    }
  }

  function subscribeAll(): void {
    for (const runId of wanted.keys()) {
      if (claimed.has(runId)) continue
      claimed.add(runId)
      send({ type: 'subscribe', runId })
    }
  }

  function handle(frame: ServerFrame): void {
    switch (frame.type) {
      case 'ready':
        // The pre-authentication one, on a socket that is about to present a
        // token. Subscribing here would authorise against an anonymous viewer.
        if (awaitingAuthenticatedReady && frame.viewer === null) return
        awaitingAuthenticatedReady = false
        // Everything wanted is claimed again — including on a first
        // connection, where "again" is "at all".
        subscribeAll()
        return
      case 'subscribed':
        wanted.get(frame.runId)?.watcher.onResync(frame)
        return
      case 'run:progress':
        wanted.get(frame.runId)?.watcher.onProgress(frame)
        return
      case 'job:status':
        wanted.get(frame.runId)?.watcher.onStatus(frame)
        return
      case 'run:complete':
        wanted.get(frame.runId)?.watcher.onComplete(frame)
        return
      case 'unsubscribed':
        // `finished` needs no action: the completion frame that preceded it is
        // what the consumer acted on. `unauthorised` is news, and it is the one
        // the §11 re-check produces.
        if (frame.reason === 'unauthorised') {
          wanted.get(frame.runId)?.watcher.onRefused('unauthorised')
        }
        return
      case 'error':
        if (frame.runId === null) {
          /*
           * Not about any run. The one that matters is a token that did not
           * verify: there will be no second `ready`, so the socket carries on
           * anonymously rather than waiting for a frame that is not coming.
           * An anonymous socket is a working socket for an anonymous run, and
           * anything else is refused per-run with NOT_FOUND, which the consumer
           * already handles.
           */
          if (frame.code === 'AUTH_INVALID_TOKEN') {
            awaitingAuthenticatedReady = false
            subscribeAll()
          }
          return
        }
        wanted.get(frame.runId)?.watcher.onRefused(frame.code)
        return
      default:
        // `pong`, or a frame from an API newer than this bundle.
        return
    }
  }

  function connect(): void {
    if (closed || socket !== null) return
    const mine = ++generation

    let candidate: SocketLike
    try {
      candidate = open(options.url)
    } catch {
      // A URL the browser refuses, or a page whose CSP forbids the connection.
      // Retried on the same backoff: it is indistinguishable from a host that
      // is down, and the reader's fallback (polling the run) is the same.
      retry()
      return
    }
    socket = candidate

    candidate.onopen = () => {
      if (mine !== generation) return
      ready = true
      attempt = 0
      claimed = new Set<string>()
      /*
       * The token is fetched per connection and the subscriptions wait for the
       * `ready` frame that answers it. Subscribing first would ask the server
       * to authorise a run against an anonymous viewer and be told 404 for
       * something the reader can plainly see — the exact bug the session's own
       * test pins from the other side.
       */
      void getToken()
        .then((token) => {
          if (mine !== generation) return
          if (token === null) {
            subscribeAll()
            return
          }
          awaitingAuthenticatedReady = true
          send({ type: 'authenticate', token })
        })
        .catch(() => {
          // No token available. An anonymous socket is a working socket for an
          // anonymous run, and for anything else the subscription is refused
          // with NOT_FOUND, which the consumer already handles.
          if (mine === generation) subscribeAll()
        })
    }

    candidate.onmessage = (event) => {
      if (mine !== generation) return
      if (typeof event.data !== 'string') return
      const frame = parseServerFrame(event.data)
      // A frame this bundle has no member for — an API deployed ahead of this
      // tab. Dropped, never fatal.
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
      claimed = new Set<string>()
      awaitingAuthenticatedReady = false
      for (const entry of wanted.values()) entry.watcher.onOffline?.()
      /*
       * `PROTOCOL` is the one close this client does not retry. It means the
       * server rejected frames this build produced, so reconnecting would
       * reproduce it immediately and forever. Everything else — expiry, idle,
       * a redeploy, a dropped TCP connection — is transient, and the expiry
       * case is precisely why the token is re-fetched on the way back.
       */
      if (event.code === SOCKET_CLOSE.PROTOCOL) return
      retry()
    }
  }

  function retry(): void {
    if (closed || wanted.size === 0 || cancelRetry !== null) return
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

  function teardown(): void {
    generation += 1
    cancelRetry?.()
    cancelRetry = null
    const current = socket
    socket = null
    ready = false
    claimed = new Set<string>()
    awaitingAuthenticatedReady = false
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

  return {
    watch(runId, watcher) {
      wanted.set(runId, { runId, watcher })
      if (socket === null) {
        // Reset the backoff: a new run is a fresh reason to try, and making the
        // reader wait fifteen seconds because an earlier attempt failed would
        // be punishing them for something that has since been fixed.
        attempt = 0
        cancelRetry?.()
        cancelRetry = null
        connect()
      } else if (ready && !awaitingAuthenticatedReady) {
        subscribeAll()
      }

      return () => {
        if (!wanted.delete(runId)) return
        claimed.delete(runId)
        send({ type: 'unsubscribe', runId })
        // The last watcher has gone. Holding an idle socket open would keep a
        // connection this reader is not using — and the server would close it
        // anyway.
        if (wanted.size === 0) teardown()
      }
    },

    connected: () => ready,

    close() {
      closed = true
      wanted.clear()
      teardown()
    },
  }
}

function defaultConnect(url: string): SocketLike {
  return new WebSocket(url) as unknown as SocketLike
}

function defaultSchedule(run: () => void, delayMs: number): () => void {
  const timer = setTimeout(run, delayMs)
  return () => clearTimeout(timer)
}
