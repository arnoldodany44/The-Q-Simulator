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
 */

import {
  MAX_SOCKET_FRAMES_PER_WINDOW,
  MAX_SOCKET_SUBSCRIPTIONS,
  SOCKET_CLOSE,
  SOCKET_FRAME_WINDOW_MS,
  parseClientFrame,
} from '@qsim/contract'
import type {
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

export function createSocketSession(ports: SocketSessionPorts): SocketSession {
  const subscriptions = new Map<string, Subscription>()
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

  ports.send({ type: 'ready', viewer: viewerId, expiresAt })

  function fail(code: SocketErrorCode, runId: string | null): void {
    ports.send({ type: 'error', code, runId })
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

  return {
    async receive(raw) {
      if (closed) return
      lastActivityAt = ports.now()

      if (credentialExpired()) {
        // Before the frame is even parsed: a socket past its `exp` gets no more
        // work out of this process, whatever it is asking for.
        shut(SOCKET_CLOSE.EXPIRED)
        return
      }

      if (!withinFrameBudget()) {
        ports.log(
          'warn',
          { viewerId, frames: framesInWindow },
          'a socket exceeded its frame budget; closing'
        )
        shut(SOCKET_CLOSE.OVERLOADED)
        return
      }

      const frame = parseClientFrame(raw)
      if (frame === null) {
        violations += 1
        fail('VALIDATION_FAILED', null)
        if (violations >= MAX_PROTOCOL_VIOLATIONS) {
          shut(SOCKET_CLOSE.PROTOCOL)
        }
        return
      }

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
        default: {
          const subscription = subscriptions.get(frame.runId)
          if (subscription === undefined) return
          subscription.ended = true
          subscription.release()
          subscriptions.delete(frame.runId)
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
      if (subscriptions.size > 0) return
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
      // Drain the chains so a check in flight cannot resolve into a `send` on a
      // socket that is already gone.
      await Promise.all(pending.map((subscription) => subscription.chain))
    },

    viewerId: () => viewerId,
    subscriptionCount: () => subscriptions.size,
  }
}
