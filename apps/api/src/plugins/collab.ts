/**
 * The collaboration relay, decorated onto the instance as `app.collab`.
 *
 * Two things live here and nothing else: the document registry, and the
 * cross-replica bus it fans out over. The decisions are all in
 * `ws/documents.ts`; this is the wiring, the Redis, and the argument for one
 * shape choice — that `null` is a supported state.
 *
 * ── Why it may be null ───────────────────────────────────────────────────
 *
 * Collaboration needs a database and nothing else, so `app.collab` is built
 * whenever `app.circuits` exists, which is always. It is `null` in exactly one
 * case: a deployment that has switched it off. The socket then answers
 * `SIMULATION_UNAVAILABLE` to a `collab:join`, which is the same shape the run
 * feed uses when no REDIS_URL is configured — a first-class state that leaves
 * every other part of the socket working, rather than a missing decorator that
 * throws somewhere inside a frame handler.
 *
 * ── Why Redis is optional and the relay is not ───────────────────────────
 *
 * A single-replica deployment needs no bus at all: every peer of a circuit is in
 * this process, and the registry's own fan-out reaches all of them. So a missing
 * REDIS_URL degrades the relay to single-instance rather than disabling it, and
 * the log line at boot says so. What breaks without it, precisely: two peers on
 * two replicas do not see each other, and each replica persists its own
 * document — the later write wins, and the edits only in the earlier one are
 * lost. That is a correctness failure, not a degradation, which is why the
 * warning is a warning and not a note.
 *
 * ── The publisher and the subscriber are two connections ─────────────────
 *
 * ioredis puts a connection into subscriber mode when it subscribes, after which
 * it may issue nothing but (un)subscribe commands. `plugins/events.ts` already
 * carries that argument for the run feed; the same applies here, with one
 * addition: this bus *publishes* as well as subscribes, so it needs both — and
 * neither may be the client `plugins/queue.ts` uses for BullMQ, because a
 * subscriber-mode connection cannot enqueue a job.
 *
 * Both are opened on the first subscription and given back when the last one
 * goes away, exactly as the run feed's is: an API replica with nobody
 * collaborating holds no connection and costs the tier nothing.
 *
 * There is deliberately no `close()` on the bus, and that is not an omission:
 * the registry's own `close()` drops every document, dropping a document
 * releases its channel, and releasing the last channel is already what hands
 * both connections back. A second teardown path would be a second thing to get
 * wrong, and the interesting failure — a document that leaked and so never
 * released — would leave the connection open under either design.
 *
 * ── Binary on the wire, and its framing ──────────────────────────────────
 *
 * A CRDT update is bytes, so this publishes bytes: ioredis carries them
 * end-to-end through `publish` with a Buffer and the `messageBuffer` event.
 * Base64 would have added a third for nothing — there is no human reading this
 * channel.
 *
 * The framing is three fields, and each one is there for a reason a test found:
 *
 *   [kind: 1 byte][originLength: 1 byte][origin: ascii][body: bytes]
 *
 * `kind` because four messages share the channel — three carrying Yjs bytes and,
 * since M5.3, one carrying a presence as JSON. `origin` because Redis
 * delivers a publish back to the publisher over its own subscriber connection,
 * so a replica has to be able to recognise its own bytes — applying them again
 * is harmless in a CRDT and republishing them is a loop. A length prefix rather
 * than a separator because an origin is opaque text and a separator is a byte
 * somebody's id can contain.
 */

import { randomUUID } from 'node:crypto'
import { PresenceStateSchema } from '@qsim/contract'
import { parseCircuit } from '@qsim/schema'
import fp from 'fastify-plugin'
import { z } from 'zod'
import type { FastifyInstance } from 'fastify'
import { Redis } from 'ioredis'
import type { ApiEnv } from '../env.js'
import {
  createDocumentRegistry,
  type CollabBus,
  type CollabMessage,
  type DocumentRegistry,
} from '../ws/documents.js'

declare module 'fastify' {
  interface FastifyInstance {
    /** `null` when collaboration is switched off for this deployment. */
    readonly collab: DocumentRegistry | null
  }
}

export interface CollabPluginOptions {
  readonly env: ApiEnv
  /** Injected by tests, and by nothing else. */
  readonly registry?: DocumentRegistry
  /** Injected by tests that need two replicas over one bus. */
  readonly bus?: CollabBus
  /** `false` switches the relay off entirely. Defaults to on. */
  readonly enabled?: boolean
}

/** The one-byte tag that says which message this is. */
const KIND_UPDATE = 1
const KIND_SYNC_REQUEST = 2
const KIND_SYNC_STATE = 3
const KIND_PRESENCE = 4
/** "A version was written; give up your copy of the document." */
const KIND_SETTLED = 5

/**
 * A presence, as this channel carries one: UTF-8 JSON in the body.
 *
 * The other three messages are Yjs bytes and this one is a small record, so it is
 * the one message on this channel with a *shape* — which means it is also the one
 * that has to be **parsed on the way in rather than cast**. Anything holding the
 * Redis connection string can publish here, and the object that comes out of this
 * function is handed to `PresenceState`-typed code that goes on to compose a
 * frame every peer in the session will render. So the schema the socket uses for
 * the same payload is the schema used here; there is no second, laxer reading of
 * a presence anywhere in the process.
 *
 * `peerId` travels beside the state rather than inside it because it is the
 * relay's key, not the peer's claim — the publishing replica minted it, and a
 * record whose id came out of the payload would let one replica overwrite
 * another's peer.
 */
const PresenceMessageSchema = z.strictObject({
  peerId: z
    .string()
    .min(1)
    .max(64)
    .regex(/^[A-Za-z0-9_-]+$/),
  state: PresenceStateSchema.nullable(),
})

/**
 * The longest origin id this framing can carry.
 *
 * A `randomUUID` is 36 characters. The length lives in one byte, so 255 is the
 * hard ceiling and this is the bound that keeps `encode` from silently
 * truncating one.
 */
const MAX_ORIGIN_LENGTH = 64

export function encodeCollabMessage(message: CollabMessage): Buffer {
  const origin = Buffer.from(message.origin, 'ascii')
  if (origin.byteLength > MAX_ORIGIN_LENGTH) {
    throw new Error('a collaboration origin id is too long to publish')
  }
  const kind = KINDS[message.kind]
  const body =
    message.kind === 'sync-request' || message.kind === 'settled'
      ? Buffer.alloc(0)
      : message.kind === 'presence'
        ? Buffer.from(
            JSON.stringify({ peerId: message.peerId, state: message.state }),
            'utf8'
          )
        : Buffer.from(
            message.bytes.buffer,
            message.bytes.byteOffset,
            message.bytes.byteLength
          )
  return Buffer.concat([Buffer.from([kind, origin.byteLength]), origin, body])
}

const KINDS: Record<CollabMessage['kind'], number> = {
  update: KIND_UPDATE,
  'sync-request': KIND_SYNC_REQUEST,
  'sync-state': KIND_SYNC_STATE,
  presence: KIND_PRESENCE,
  settled: KIND_SETTLED,
}

/**
 * A published message, or `null`.
 *
 * `null` and never a throw: this is called from a Redis `message` listener, where
 * a throw is an unhandled rejection on an EventEmitter and takes the process
 * down. Anything holding the connection string can publish here, so the payload
 * is untrusted input on a hot path — the same argument `parseRunEvent` makes.
 */
export function decodeCollabMessage(payload: Buffer): CollabMessage | null {
  if (payload.byteLength < 2) return null
  const kind = payload[0] as number
  const originLength = payload[1] as number
  if (originLength === 0 || originLength > MAX_ORIGIN_LENGTH) return null
  if (payload.byteLength < 2 + originLength) return null
  const origin = payload.toString('ascii', 2, 2 + originLength)
  const body = payload.subarray(2 + originLength)
  // Copied out of the driver's buffer: a Yjs decoder reads through byteOffset
  // and byteLength, and this view belongs to a pooled buffer ioredis reuses.
  const bytes = Uint8Array.from(body)

  switch (kind) {
    case KIND_UPDATE:
      return bytes.byteLength === 0 ? null : { kind: 'update', origin, bytes }
    case KIND_SYNC_REQUEST:
      return { kind: 'sync-request', origin }
    case KIND_SETTLED:
      return { kind: 'settled', origin }
    case KIND_SYNC_STATE:
      return bytes.byteLength === 0
        ? null
        : { kind: 'sync-state', origin, bytes }
    case KIND_PRESENCE: {
      /*
       * Parsed, never cast — see `PresenceMessageSchema`. A `null` here is a
       * message dropped, which for a presence costs a cursor on another replica
       * ten seconds of staleness: the peer's own heartbeat restates it.
       */
      let payload: unknown
      try {
        payload = JSON.parse(body.toString('utf8'))
      } catch {
        return null
      }
      const parsed = PresenceMessageSchema.safeParse(payload)
      return parsed.success
        ? {
            kind: 'presence',
            origin,
            peerId: parsed.data.peerId,
            state: parsed.data.state,
          }
        : null
    }
    default:
      return null
  }
}

/**
 * The channel the registry asked for, under this deployment's prefix.
 *
 * The registry says `circuit:<id>` because that is what §8 calls it, and knows
 * nothing about a prefix — it is a file with no environment in it. The prefix is
 * what keeps a development session from reaching a production one on the Redis
 * instance they share, for the reason `queue.ts` gives at length.
 */
export function namespacedChannel(prefix: string, channel: string): string {
  return `${prefix}:${channel}`
}

function createConnection(url: string): Redis {
  /*
   * Configured to persist rather than to fail fast, like the run event
   * subscriber and for the same reason: this is holding a session somebody is
   * editing in, so a blip is something to survive. ioredis re-issues its
   * subscriptions on reconnect, which is what makes the session keep working
   * without the peers noticing.
   */
  return new Redis(url, {
    maxRetriesPerRequest: null,
    connectTimeout: 5_000,
    lazyConnect: true,
    retryStrategy: (attempt) => Math.min(attempt * 300, 3_000),
  })
}

export function redisCollabBus(env: ApiEnv): CollabBus {
  const configured = env.queue.redisUrl
  if (configured === null) throw new Error('REDIS_URL is not configured')
  const url: string = configured

  const channels = new Map<string, Set<(message: CollabMessage) => void>>()
  let subscriber: Redis | null = null
  let publisher: Redis | null = null

  function connect(): Redis {
    if (subscriber !== null) return subscriber
    const client = createConnection(url)
    // Not optional: every reconnect against an unreachable instance emits
    // `error`, and an unhandled one on an EventEmitter exits the process.
    client.on('error', () => undefined)
    client.on('messageBuffer', (channel: Buffer, payload: Buffer) => {
      const listeners = channels.get(channel.toString('utf8'))
      if (listeners === undefined) return
      const message = decodeCollabMessage(payload)
      if (message === null) return
      for (const listener of listeners) {
        try {
          listener(message)
        } catch {
          /* one document's failure must not deafen the others */
        }
      }
    })
    subscriber = client
    return client
  }

  function writer(): Redis {
    if (publisher !== null) return publisher
    const client = createConnection(url)
    client.on('error', () => undefined)
    publisher = client
    return client
  }

  async function release(
    channel: string,
    listener: (message: CollabMessage) => void
  ): Promise<void> {
    const listeners = channels.get(channel)
    if (listeners === undefined) return
    listeners.delete(listener)
    if (listeners.size > 0) return
    channels.delete(channel)
    const client = subscriber
    if (client !== null) {
      try {
        await client.unsubscribe(channel)
      } catch {
        /* nobody is listening; the message handler already drops it */
      }
    }
    if (channels.size > 0) return
    /*
     * The last document on this replica has gone, so both connections go back.
     * This is the half that makes "costs nothing when nobody is collaborating"
     * true rather than merely true at boot.
     */
    subscriber = null
    const outgoing = publisher
    publisher = null
    if (client !== null) void client.quit().catch(() => client.disconnect())
    if (outgoing !== null) {
      void outgoing.quit().catch(() => outgoing.disconnect())
    }
  }

  return {
    async publish(channel, message) {
      await writer().publish(channel, encodeCollabMessage(message))
    },

    async subscribe(channel, listener) {
      const client = connect()
      const existing = channels.get(channel)
      if (existing !== undefined) {
        existing.add(listener)
        return () => void release(channel, listener)
      }
      const listeners = new Set([listener])
      channels.set(channel, listeners)
      try {
        await client.subscribe(channel)
      } catch (error) {
        channels.delete(channel)
        throw error
      }
      return () => void release(channel, listener)
    },
  }
}

function collabPlugin(
  app: FastifyInstance,
  options: CollabPluginOptions,
  done: (error?: Error) => void
): void {
  const injected = options.registry
  const enabled = options.enabled ?? true
  let owned: DocumentRegistry | null = null
  let built = false

  /**
   * The identity of this replica, for the bus's own-message filter.
   *
   * A random id per process rather than a platform variable, because the property
   * needed is "different from every other live replica" and a `RAILWAY_REPLICA_ID`
   * is stable across a restart — so two generations of the same replica would
   * share it, and a message published by the old one could be ignored by the new.
   */
  const replicaId = randomUUID()

  app.decorate('collab', {
    getter: (): DocumentRegistry | null => {
      if (injected !== undefined) return injected
      if (!enabled) return null
      if (!built) {
        built = true
        const prefix = options.env.queue.prefix
        const bus =
          options.bus ??
          (options.env.queue.redisUrl === null
            ? null
            : redisCollabBus(options.env))
        owned = createDocumentRegistry(
          {
            latestCircuit: async (circuitId) => {
              const version = await app.circuits.latestVersion(circuitId)
              if (version === null) return null
              /*
               * Re-parsed on the way out even though `latestVersion` already
               * types it as a Circuit: a row written by an older schema version
               * is exactly the case that must not reach a shared document, where
               * every peer would then be told it is the truth.
               */
              const parsed = parseCircuit(version.data)
              return parsed
            },
            loadSession: (circuitId) => app.circuits.loadSession(circuitId),
            saveSession: async (circuitId, state) => {
              await app.circuits.saveSession({ circuitId, state })
            },
            dropSession: async (circuitId) => {
              await app.circuits.dropSession(circuitId)
            },
            /*
             * The registry names its channels with §8's name; the prefix is this
             * deployment's and belongs here rather than in a package that cannot
             * see the environment.
             */
            bus:
              bus === null
                ? null
                : {
                    publish: (channel, message) =>
                      bus.publish(namespacedChannel(prefix, channel), message),
                    subscribe: (channel, listener) =>
                      bus.subscribe(
                        namespacedChannel(prefix, channel),
                        listener
                      ),
                  },
            now: () => Date.now(),
            schedule: (run, ms) => {
              const handle = setTimeout(run, ms)
              // `unref` so a pending persist timer cannot hold the process open
              // past a shutdown; the close hook flushes what is outstanding.
              handle.unref()
              return () => {
                clearTimeout(handle)
              }
            },
            log: (level, fields, message) => {
              app.log[level](fields, message)
            },
          },
          replicaId
        )
      }
      return owned
    },
  })

  app.addHook('onClose', async () => {
    // Only what this process built. An injected registry belongs to its test.
    if (owned !== null) await owned.close()
  })

  done()
}

export default fp(collabPlugin, {
  name: 'qsim-collab',
  dependencies: ['qsim-circuits'],
})
