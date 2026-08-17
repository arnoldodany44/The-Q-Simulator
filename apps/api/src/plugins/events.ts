/**
 * The run-event bus, decorated onto the instance as `app.runEvents`.
 *
 * ── What it is ───────────────────────────────────────────────────────────
 *
 * The receiving half of the gap `@qsim/jobs`' `events.ts` argues about: the
 * worker publishes a run's progress to a Redis channel, and this is what a
 * socket in *this* process subscribes to. Read that file first — the choice of
 * pub/sub over BullMQ's own event stream is made there, and the consequence
 * this file has to honour is that delivery is at-most-once and therefore that
 * every frame it carries is a notification rather than an answer.
 *
 * ── One connection, reference-counted channels ───────────────────────────
 *
 * ioredis puts a connection into *subscriber mode* when it subscribes: from
 * then on it may issue nothing but (un)subscribe commands. So this cannot share
 * the client `plugins/queue.ts` uses to `SET`, `GET` and enqueue, and it opens
 * one of its own.
 *
 * It opens it **on the first subscription and not at boot**, and closes it
 * again when the last one goes away. That is the whole point of the design: an
 * API replica with no socket watching anything holds no connection, issues no
 * commands and costs the tier nothing. The alternative — one standing
 * connection per replica, forever, whether or not anybody is watching — is
 * exactly the standing cost that made `QueueEvents` the wrong answer, and it
 * would be strange to refuse it there and accept it here.
 *
 * Channels are reference-counted because two sockets may watch one run: two
 * tabs, or one tab reconnecting before the old subscription has been released.
 * `SUBSCRIBE` is idempotent in Redis but `UNSUBSCRIBE` is not scoped to a
 * listener, so the first release would silently deafen the second watcher.
 *
 * ── Failures degrade, they do not propagate ──────────────────────────────
 *
 * A subscription that cannot be established is reported to its caller, which
 * answers the client `SIMULATION_UNAVAILABLE` and leaves the socket open — a
 * client can still poll `GET /simulate/:runId`, which is what it does across a
 * reconnect anyway. Nothing here can fail a request, and nothing here can take
 * the process down: the `error` listener on the connection is not optional
 * (an unhandled `error` event on an EventEmitter exits the process), and a
 * malformed payload is dropped rather than thrown.
 */

import {
  hardwareEventChannel,
  parseRunEvent,
  runEventChannel,
} from '@qsim/jobs'
import type { RunEvent } from '@qsim/jobs'
import fp from 'fastify-plugin'
import type { FastifyInstance } from 'fastify'
import { Redis } from 'ioredis'
import type { ApiEnv } from '../env.js'

/** What a socket does with an event. Never throws; the bus swallows if it does. */
export type RunEventListener = (event: RunEvent) => void

/**
 * Which channel namespace an id belongs to.
 *
 * Two namespaces rather than one keyed by a different id, even though both ids
 * are cuid2 and a collision is not a practical worry. The reason is what a
 * collision would *do*: the session's delivery guard compares ids, so two
 * different things sharing one channel would pass that check and a subscriber
 * would receive frames about somebody else's job under its own id. Namespacing
 * makes that unreachable rather than unlikely.
 */
export type EventKind = 'run' | 'hardware'

export interface RunEventBus {
  /**
   * Starts delivering one watchable's events to `listener`.
   *
   * Resolves with the release function. Rejects only when the subscription
   * could not be established at all, which the caller turns into
   * `SIMULATION_UNAVAILABLE` on the socket rather than into a closed
   * connection.
   */
  subscribe(
    id: string,
    kind: EventKind,
    listener: RunEventListener
  ): Promise<() => void>
  close(): Promise<void>
}

declare module 'fastify' {
  interface FastifyInstance {
    /** `null` when no REDIS_URL was configured — see `plugins/queue.ts`. */
    readonly runEvents: RunEventBus | null
  }
}

export interface EventsPluginOptions {
  /** Injected by tests, and by nothing else. */
  readonly bus?: RunEventBus
  readonly env: ApiEnv
}

/**
 * The subscriber connection.
 *
 * Configured to persist rather than to fail fast, which is the opposite of the
 * queue client in `plugins/queue.ts` and is right for the opposite reason. That
 * client is answering an HTTP request somebody is waiting on, so an unreachable
 * Redis has to become a 503 in seconds. This one is holding a subscription for
 * a socket that is already open: a blip is something to survive, and ioredis
 * re-issues the subscriptions itself on reconnect, so surviving it is also what
 * makes the socket keep working without the client noticing.
 */
function createSubscriber(url: string): Redis {
  return new Redis(url, {
    maxRetriesPerRequest: null,
    connectTimeout: 5_000,
    lazyConnect: true,
    retryStrategy: (attempt) => Math.min(attempt * 300, 3_000),
  })
}

export function redisRunEventBus(env: ApiEnv): RunEventBus {
  const configured = env.queue.redisUrl
  if (configured === null) {
    throw new Error('REDIS_URL is not configured')
  }
  // Bound to a `string` rather than relied on through narrowing: `connect`
  // below is a closure, and a narrowing that has to survive one is a narrowing
  // that stops surviving the day somebody adds a reassignment above it.
  const url: string = configured

  /** Listeners per channel. The size of a set is that channel's refcount. */
  const channels = new Map<string, Set<RunEventListener>>()
  let connection: Redis | null = null
  let closed = false

  function connect(): Redis {
    if (connection !== null) return connection
    const client = createSubscriber(url)
    /*
     * Not optional. Every reconnect attempt against an unreachable instance
     * emits `error`, and an unhandled one on an EventEmitter exits the process
     * — an API that died because a progress feed blinked would be §4's whole
     * argument inverted.
     */
    client.on('error', () => {
      /* survived per subscription; see the header */
    })
    client.on('message', (channel: string, payload: string) => {
      const listeners = channels.get(channel)
      if (listeners === undefined) return
      const event = parseRunEvent(payload)
      // A payload that does not parse is one nobody can act on. Dropping it is
      // the only safe answer: anything holding the connection string can
      // publish, so this is untrusted input arriving on a hot path.
      if (event === null) return
      for (const listener of listeners) {
        try {
          listener(event)
        } catch {
          /* one socket's failure must not deafen the others on this channel */
        }
      }
    })
    connection = client
    return client
  }

  async function release(channel: string, listener: RunEventListener) {
    const listeners = channels.get(channel)
    if (listeners === undefined) return
    listeners.delete(listener)
    if (listeners.size > 0) return
    channels.delete(channel)
    const client = connection
    if (client === null) return
    try {
      await client.unsubscribe(channel)
    } catch {
      /*
       * An unsubscribe that failed costs this replica the delivery of events
       * nobody is listening to, which the `message` handler already drops. It
       * is not worth reporting to a caller who is tearing down.
       */
    }
    /*
     * The last watcher on this replica has gone, so give the connection back.
     * This is the half that makes "costs nothing when nobody is watching" true
     * rather than merely true at boot.
     */
    if (channels.size === 0 && !closed) {
      connection = null
      void client.quit().catch(() => client.disconnect())
    }
  }

  return {
    async subscribe(id, kind, listener) {
      if (closed) throw new Error('the run event bus is closed')
      const channel =
        kind === 'hardware'
          ? hardwareEventChannel(env.queue.prefix, id)
          : runEventChannel(env.queue.prefix, id)
      const client = connect()
      const existing = channels.get(channel)

      if (existing !== undefined) {
        existing.add(listener)
        return () => void release(channel, listener)
      }

      const listeners = new Set<RunEventListener>([listener])
      channels.set(channel, listeners)
      try {
        await client.subscribe(channel)
      } catch (error) {
        channels.delete(channel)
        throw error
      }
      return () => void release(channel, listener)
    },

    async close() {
      closed = true
      channels.clear()
      const client = connection
      connection = null
      if (client === null) return
      try {
        await client.quit()
      } catch {
        client.disconnect()
      }
    },
  }
}

function eventsPlugin(
  app: FastifyInstance,
  options: EventsPluginOptions,
  done: (error?: Error) => void
): void {
  const injected = options.bus
  let owned: RunEventBus | null = null
  let built = false

  app.decorate('runEvents', {
    getter: (): RunEventBus | null => {
      if (injected !== undefined) return injected
      if (options.env.queue.redisUrl === null) return null
      if (!built) {
        built = true
        owned = redisRunEventBus(options.env)
      }
      return owned
    },
  })

  app.addHook('onClose', async () => {
    // Only what this process built. An injected bus belongs to its test.
    if (owned !== null) await owned.close()
  })

  done()
}

export default fp(eventsPlugin, { name: 'qsim-run-events' })
