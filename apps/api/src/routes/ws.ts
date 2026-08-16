/**
 * `/ws` — §8's socket, bound to `ws/session.ts`.
 *
 * Everything interesting is in the session; this file owns what only a real
 * connection can own — the upgrade, the timers, and turning a socket's events
 * into the six ports the session takes.
 *
 * ── Why it is a route and not a server bolted onto `app.server` ───────────
 *
 * Because a socket is not exempt from §11 (or from anything else). Registering
 * it through `@fastify/websocket` means the *upgrade request* runs the whole
 * `onRequest` chain every other route runs: CORS, `resolveIdentity`, the rate
 * limiter — so opening sockets in a loop is counted against the same budget as
 * any other request — and the `onRoute` hook that refuses to boot when a route
 * does not declare an auth policy. A `WebSocketServer` attached to the HTTP
 * server directly would bypass all four, silently.
 *
 * ── Three of those four hold, and the fourth is done here ─────────────────
 *
 * CORS is the one that does not. `@fastify/cors` does not *refuse* a disallowed
 * origin — it omits the header and lets the request through — and a browser
 * applies no CORS check to a WebSocket handshake in the first place. So a
 * socket that means to inherit the origin allow-list has to compare
 * `Origin` itself, which `originAllowed` below does. What that buys is bounded
 * and worth stating: identity arrives in a frame rather than in a cookie, so a
 * foreign page could never impersonate a reader; what it could do is open and
 * hold sockets from every visitor's browser, spending that visitor's rate
 * budget and this process's memory, which is the resource half of §11.
 *
 * ── What one caller may hold at once ──────────────────────────────────────
 *
 * The rate limiter bounds how fast sockets are opened, not how many are held:
 * at the default budget one address could add three hundred permanent
 * connections a minute, each with up to `MAX_SOCKET_SUBSCRIPTIONS` cached
 * authorisation decisions and Redis channels, for as long as it keeps pinging.
 * The per-socket ceiling composes into nothing without a ceiling on sockets, so
 * there are two here: one per remote address, and one for the process.
 *
 * ── The policy is `optional`, and the token does not arrive here ──────────
 *
 * A browser's `WebSocket` constructor cannot set an `Authorization` header, so
 * in practice the upgrade is anonymous and the identity arrives in the first
 * frame (`@qsim/contract`'s `socket.ts` argues why that is better than a query
 * parameter). `optional` is still the right declaration rather than `public`:
 * a non-browser client *can* set the header, and if it does, a token that fails
 * to verify must be a 401 at the upgrade rather than a silently anonymous
 * socket. An identity resolved here is handed straight to the session as its
 * starting viewer.
 *
 * ── Two timers, and they answer different questions ───────────────────────
 *
 * `sweep` is the session's own: has the token expired, has this socket sat
 * doing nothing. `ping` is the protocol's: is the peer still there at all. They
 * are separate because a half-open TCP connection — a laptop closed, a phone
 * that changed network — produces no close event and no frames, so nothing the
 * session can see distinguishes it from a quiet client. Only an unanswered
 * control-frame ping does.
 */

import {
  MAX_SOCKET_PENDING_FRAMES,
  SOCKET_CLOSE,
  SOCKET_PATH,
  encodeFrame,
} from '@qsim/contract'
import type { FastifyInstance, FastifyPluginCallback } from 'fastify'
import type { WebSocket } from 'ws'
import type { ApiEnv } from '../env.js'
import type { JwksCache } from '../auth/jwks.js'
import { verifyAccessToken } from '../auth/verify.js'
import { ApiError } from '../errors.js'
import { createSocketSession } from '../ws/session.js'

export interface WebSocketRoutesOptions {
  readonly env: ApiEnv
}

/** How often the session is asked about expiry and idleness. */
const SWEEP_INTERVAL_MS = 15_000

/**
 * How many sockets one remote address may hold open at once.
 *
 * A reader has one tab watching one run, and `runSocket.ts` shares a single
 * connection across every watcher in a page. Sixteen is generous for a
 * household or an office behind one address and still turns the per-socket
 * ceilings into a real bound on what one caller can make this process hold.
 */
const MAX_SOCKETS_PER_ADDRESS = 16

/**
 * How many sockets this process will hold at all.
 *
 * The last line rather than the first: a distributed flood spends the rate
 * limiter's budget from many addresses and would never meet the per-address
 * cap. Five hundred sessions is a few megabytes of this process's memory and
 * far more concurrent readers than a milestone-2 deployment expects; past it,
 * refusing the upgrade is what keeps the API answering everything else.
 */
const MAX_SOCKETS_PER_PROCESS = 500

/**
 * How often a control-frame ping goes out, and how long an unanswered one is
 * tolerated.
 *
 * Thirty seconds is below the idle timeout of every proxy this service sits
 * behind, so the ping is also what keeps an intermediary from closing a healthy
 * but quiet connection. A peer that misses two in a row is gone: that is a
 * minute of silence on a connection that is pinged twice a minute, which no
 * live client produces.
 */
const PING_INTERVAL_MS = 30_000
const MISSED_PINGS_BEFORE_CLOSE = 2

const plugin: FastifyPluginCallback<WebSocketRoutesOptions> = (
  instance,
  options,
  done
) => {
  const app: FastifyInstance = instance
  const { env } = options

  /** Live sockets per remote address, and the total. See the constants above. */
  const perAddress = new Map<string, number>()
  let live = 0

  /**
   * Whether a browser on this origin may open a socket.
   *
   * A missing `Origin` is allowed: it is what every non-browser client sends —
   * a script, `curl`, the tests — and those are exactly the callers that can
   * present an `Authorization` header on the upgrade. A *present* origin is
   * compared against the same allow-list CORS uses, because a browser will not
   * do it for a WebSocket and the route's own header claims that protection.
   */
  function originAllowed(origin: string | undefined): boolean {
    if (origin === undefined) return true
    return env.webOrigins.includes(origin)
  }

  app.get(
    SOCKET_PATH,
    {
      websocket: true,
      preValidation: (request, _reply, done) => {
        const origin = request.headers.origin
        if (!originAllowed(origin)) {
          request.log.warn(
            { origin },
            'refused a socket upgrade from a disallowed origin'
          )
          done(new ApiError('FORBIDDEN'))
          return
        }
        const address = request.ip
        if (
          live >= MAX_SOCKETS_PER_PROCESS ||
          (perAddress.get(address) ?? 0) >= MAX_SOCKETS_PER_ADDRESS
        ) {
          request.log.warn(
            { live },
            'refused a socket upgrade: too many connections held'
          )
          done(new ApiError('RATE_LIMITED'))
          return
        }
        done()
      },
      /*
       * See the header. `optional` rather than `public`: a presented token that
       * does not verify is a 401 at the upgrade, and an anonymous upgrade is
       * perfectly ordinary — §4 puts the editor in front of people who have not
       * signed in, and their runs are readable by whoever holds the id.
       */
      config: { auth: 'optional' },
    },
    (socket: WebSocket, request) => {
      const log = request.log
      const address = request.ip
      live += 1
      perAddress.set(address, (perAddress.get(address) ?? 0) + 1)
      /*
       * A JWKS cache is a network resource with its own rate limiting, so the
       * socket uses the instance's rather than building one. `app.jwks` is
       * decorated by the auth plugin for exactly this kind of consumer.
       */
      const keys: JwksCache = app.jwks

      const session = createSocketSession({
        /*
         * An identity from the upgrade request, when there was one. A browser
         * cannot produce this; a script with an `Authorization` header can, and
         * it should not have to send a frame to say what it already said.
         */
        identity:
          request.auth === null
            ? null
            : {
                userId: request.auth.userId,
                expiresAt: request.auth.expiresAt,
              },
        send: (frame) => {
          // `readyState` is checked rather than trusted: a frame produced by a
          // check that resolved after the peer went away would otherwise throw
          // out of a timer, where nothing is catching.
          if (socket.readyState !== socket.OPEN) return
          try {
            socket.send(encodeFrame(frame))
          } catch (error) {
            log.warn({ err: error }, 'could not write to a socket')
          }
        },
        close: (code) => {
          socket.close(code)
        },
        verify: async (token) => {
          const identity = await verifyAccessToken(token, {
            keys,
            issuer: env.jwtIssuer,
            audience: env.jwtAudience,
          })
          return {
            userId: identity.userId,
            expiresAt: identity.expiresAt,
          }
        },
        readRun: (runId, viewerId) => app.runs.findReadableRun(runId, viewerId),
        subscribe:
          app.runEvents === null
            ? null
            : (runId, listener) => {
                // Narrowed inside the closure rather than captured above: the
                // decorator builds its bus lazily, so reading it per call is
                // what keeps the first socket from being the thing that opens a
                // Redis connection at boot.
                const bus = app.runEvents
                if (bus === null) {
                  return Promise.reject(
                    new Error('the run event bus went away')
                  )
                }
                return bus.subscribe(runId, listener)
              },
        now: () => Date.now(),
        log: (level, fields, message) => {
          log[level](fields, message)
        },
      })

      /** Frames are handled one at a time — see the `message` listener. */
      let queue: Promise<void> = Promise.resolve()
      /** How many of them are waiting for their turn right now. */
      let pending = 0
      let missedPings = 0
      const ping = setInterval(() => {
        if (missedPings >= MISSED_PINGS_BEFORE_CLOSE) {
          log.info('socket stopped answering pings; terminating')
          // `terminate` and not `close`: the point of getting here is that the
          // peer is not answering, so waiting for a close handshake waits for
          // something that is not coming.
          socket.terminate()
          return
        }
        missedPings += 1
        try {
          socket.ping()
        } catch {
          socket.terminate()
        }
      }, PING_INTERVAL_MS)

      const sweep = setInterval(() => {
        session.sweep()
      }, SWEEP_INTERVAL_MS)

      socket.on('pong', () => {
        missedPings = 0
      })

      socket.on('message', (raw: Buffer) => {
        /*
         * Frames are handled one at a time even though `receive` is
         * asynchronous: `ws` delivers messages in order and this keeps them in
         * order, which matters for the one sequence that is not commutative —
         * `authenticate` followed immediately by `subscribe`. Without the
         * chain, the subscription would be authorised against an anonymous
         * viewer and answer 404 for a run the client can plainly see.
         *
         * BOUNDED, because a chain is a queue and a queue with no depth limit
         * is memory a stranger controls. A client that writes faster than this
         * process drains — trivially achieved, since a frame costs it nothing
         * and costs the server a database round trip — would otherwise build a
         * backlog measured in minutes of queued work from a burst measured in
         * milliseconds. The session's own frame budget bounds the *rate*; this
         * bounds what may be outstanding at any instant, and the socket is
         * closed rather than throttled because there is nothing useful to say
         * to a peer that is not listening.
         */
        if (pending >= MAX_SOCKET_PENDING_FRAMES) {
          log.warn({ pending }, 'a socket outran its frame queue; closing')
          socket.close(SOCKET_CLOSE.OVERLOADED)
          return
        }
        pending += 1
        queue = queue
          .then(() => session.receive(raw.toString('utf8')))
          .catch((error: unknown) => {
            log.error({ err: error }, 'a socket frame was not handled')
            socket.close(SOCKET_CLOSE.PROTOCOL)
          })
          .finally(() => {
            pending -= 1
          })
      })

      socket.on('close', () => {
        clearInterval(ping)
        clearInterval(sweep)
        live -= 1
        const held = (perAddress.get(address) ?? 1) - 1
        if (held <= 0) perAddress.delete(address)
        else perAddress.set(address, held)
        void session.close()
      })

      socket.on('error', (error: Error) => {
        // Logged rather than fatal: a socket error is one client's connection,
        // and an unhandled 'error' event on an EventEmitter exits the process.
        log.warn({ err: error }, 'socket error')
      })
    }
  )

  done()
}

export const webSocketRoutes = plugin
