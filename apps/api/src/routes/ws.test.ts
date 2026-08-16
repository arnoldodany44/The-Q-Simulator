/**
 * `/ws` end to end, through a real socket.
 *
 * `session.test.ts` proves the state machine; this proves the *wiring*, which
 * is a different set of failures and one no pure test can reach: that the route
 * upgrades at all, that the upgrade runs the same hook chain as every other
 * route, that a frame off a real connection reaches the session, and — the one
 * worth the whole file — that an event published on the worker's side comes out
 * of a browser's socket as the frame §8 names.
 *
 * `app.injectWS` is the plugin's own test seam: it opens a genuine `ws`
 * connection against the Fastify instance with no port bound. Nothing about the
 * socket is faked; what is faked is Postgres and Redis, exactly as in
 * `simulate.test.ts`, and through the same doubles.
 */

import {
  MAX_SOCKET_SUBSCRIPTIONS,
  SOCKET_CLOSE,
  SOCKET_PATH,
  encodeFrame,
  parseServerFrame,
} from '@qsim/contract'
import type { ClientFrame, ServerFrame } from '@qsim/contract'
import type { RunEvent } from '@qsim/jobs'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { WebSocket } from 'ws'
import type { ApiInstance } from '../app.js'
import { createTestApp } from '../testing/app.js'
import {
  createMemoryEventBus,
  createMemoryRunStore,
} from '../testing/simulation.js'
import type { MemoryEventBus, MemoryRunStore } from '../testing/simulation.js'
import {
  createSigningKey,
  createTestJwksCache,
  signToken,
  stubJwksEndpoint,
} from '../testing/tokens.js'
import type { TestSigningKey } from '../testing/tokens.js'

const OWNER_ID = '11111111-1111-4111-8111-111111111111'
const STRANGER_ID = '22222222-2222-4222-8222-222222222222'

let app: ApiInstance
let runs: MemoryRunStore
let events: MemoryEventBus
let key: TestSigningKey
const sockets: WebSocket[] = []

/**
 * A socket wrapped in the two things every test here needs: a transcript, and
 * a way to wait for a specific frame rather than for a timer.
 */
interface Client {
  readonly socket: WebSocket
  readonly frames: ServerFrame[]
  send(frame: ClientFrame): void
  /** Resolves with the first frame of this type, or rejects on a timeout. */
  next(type: ServerFrame['type']): Promise<ServerFrame>
  closed(): Promise<number>
}

function wrap(socket: WebSocket): Client {
  const frames: ServerFrame[] = []
  const waiting: { type: string; resolve: (frame: ServerFrame) => void }[] = []
  let closeCode = -1
  const closeWaiters: ((code: number) => void)[] = []

  socket.on('message', (raw: Buffer) => {
    const frame = parseServerFrame(raw.toString('utf8'))
    // A frame that does not parse is a contract violation by the server, and
    // failing loudly here is the point: this is the only test that would see it.
    if (frame === null) throw new Error(`unparseable frame: ${raw.toString()}`)
    frames.push(frame)
    for (let index = waiting.length - 1; index >= 0; index--) {
      const waiter = waiting[index]
      if (waiter !== undefined && waiter.type === frame.type) {
        waiting.splice(index, 1)
        waiter.resolve(frame)
      }
    }
  })

  socket.on('close', (code: number) => {
    closeCode = code
    for (const resolve of closeWaiters.splice(0)) resolve(code)
  })

  return {
    socket,
    frames,
    send: (frame) => socket.send(encodeFrame(frame)),
    next: (type) =>
      new Promise((resolve, reject) => {
        const existing = frames.find((frame) => frame.type === type)
        if (existing !== undefined) {
          resolve(existing)
          return
        }
        const timer = setTimeout(() => {
          reject(
            new Error(
              `no ${type} frame arrived; saw ${frames
                .map((frame) => frame.type)
                .join(', ')}`
            )
          )
        }, 2_000)
        waiting.push({
          type,
          resolve: (frame) => {
            clearTimeout(timer)
            resolve(frame)
          },
        })
      }),
    closed: () =>
      closeCode >= 0
        ? Promise.resolve(closeCode)
        : new Promise((resolve) => closeWaiters.push(resolve)),
  }
}

/**
 * Opens a socket with its transcript already recording.
 *
 * The listener is attached through `onInit` — before the connection is even
 * established — rather than after the `injectWS` promise resolves, and that is
 * not fussiness. The server sends `ready` the instant the handler runs, which
 * is *before* the client's open event settles; a listener attached afterwards
 * misses it, and every test in this file then waits two seconds for a frame
 * that already went past.
 */
async function open(
  instance: ApiInstance,
  headers: Record<string, string> = {}
): Promise<Client> {
  let client: Client | undefined
  const socket = await instance.injectWS(
    SOCKET_PATH,
    { headers },
    { onInit: (ws) => (client = wrap(ws)) }
  )
  sockets.push(socket)
  if (client === undefined) throw new Error('injectWS never called onInit')
  await client.next('ready')
  return client
}

function connect(headers: Record<string, string> = {}): Promise<Client> {
  return open(app, headers)
}

/** Publishes as the worker would, once the API has actually subscribed. */
function publish(event: RunEvent): void {
  events.publish(event)
}

beforeEach(async () => {
  key = await createSigningKey('socket-key')
  runs = createMemoryRunStore()
  events = createMemoryEventBus()
  app = await createTestApp({
    runs: { repository: runs },
    events: { bus: events },
    jwks: createTestJwksCache(stubJwksEndpoint([key])),
  })
  await app.ready()
})

afterEach(async () => {
  for (const socket of sockets.splice(0)) socket.terminate()
  await app.close()
})

describe('the upgrade', () => {
  it('answers `ready`, anonymously, with no credential anywhere', async () => {
    const client = await connect()
    expect(client.frames[0]).toEqual({
      type: 'ready',
      viewer: null,
      expiresAt: null,
    })
  })

  it('runs the same auth hooks as every other route', async () => {
    /*
     * The whole reason `/ws` is a Fastify route rather than a WebSocket server
     * attached to `app.server`: a token that does not verify is a 401 at the
     * upgrade, not a silently anonymous socket. A bare `ws` server would never
     * see the header at all.
     */
    const response = await app.inject({
      method: 'GET',
      url: SOCKET_PATH,
      headers: { authorization: 'Bearer not-a-token' },
    })
    expect(response.statusCode).toBe(401)
  })

  it('accepts an identity the upgrade request proved', async () => {
    const token = await signToken(key, { subject: OWNER_ID })
    const client = await connect({ authorization: `Bearer ${token}` })
    expect(client.frames[0]).toMatchObject({ type: 'ready', viewer: OWNER_ID })
  })
})

describe('authorisation, from a stranger’s side', () => {
  it('refuses to subscribe a socket to somebody else’s run', async () => {
    runs.seed({ id: 'run_owned', userId: OWNER_ID, status: 'RUNNING' })

    const stranger = await connect()
    const token = await signToken(key, { subject: STRANGER_ID })
    stranger.send({ type: 'authenticate', token })
    await stranger.next('ready')

    stranger.send({ type: 'subscribe', runId: 'run_owned' })
    expect(await stranger.next('error')).toEqual({
      type: 'error',
      code: 'NOT_FOUND',
      runId: 'run_owned',
    })
    // Nothing was opened, so nothing can leak later either.
    expect(events.opened).toEqual([])
  })

  it('refuses an anonymous socket the same run, with the same code', async () => {
    // "No such run" and "not yours" must be indistinguishable — the same rule
    // `GET /simulate/:runId` follows, arriving over a different transport.
    runs.seed({ id: 'run_owned', userId: OWNER_ID, status: 'RUNNING' })
    const anonymous = await connect()
    anonymous.send({ type: 'subscribe', runId: 'run_owned' })
    const refusedExisting = await anonymous.next('error')

    anonymous.send({ type: 'subscribe', runId: 'run_nothere' })
    const refusedMissing = anonymous.frames.filter(
      (frame) => frame.type === 'error'
    )
    await new Promise((resolve) => setTimeout(resolve, 50))
    expect(refusedExisting).toMatchObject({ code: 'NOT_FOUND' })
    expect(refusedMissing.every((frame) => frame.code === 'NOT_FOUND')).toBe(
      true
    )
  })

  it('lets the owner subscribe once the socket proves who it is', async () => {
    runs.seed({ id: 'run_owned', userId: OWNER_ID, status: 'RUNNING' })
    const owner = await connect()

    owner.send({ type: 'subscribe', runId: 'run_owned' })
    expect(await owner.next('error')).toMatchObject({ code: 'NOT_FOUND' })

    const token = await signToken(key, { subject: OWNER_ID })
    owner.send({ type: 'authenticate', token })
    owner.send({ type: 'subscribe', runId: 'run_owned' })

    expect(await owner.next('subscribed')).toEqual({
      type: 'subscribed',
      runId: 'run_owned',
      status: 'RUNNING',
    })
  })

  it('stops delivering a run whose circuit is unpublished mid-stream', async () => {
    /*
     * The revocation case, end to end. An anonymous run over a circuit a
     * stranger can read: the run's id is its credential (§11), so the socket is
     * legitimately subscribed. The owner then unpublishes the circuit, and the
     * §11 filter stops matching — which must stop the stream, not merely stop
     * future subscriptions.
     */
    runs.seed({
      id: 'run_public',
      userId: null,
      circuitId: 'circ_1',
      status: 'RUNNING',
    })
    runs.readableCircuits.set('', new Set(['circ_1']))

    const watcher = await connect()
    watcher.send({ type: 'subscribe', runId: 'run_public' })
    await watcher.next('subscribed')

    publish({
      type: 'run:progress',
      runId: 'run_public',
      at: 1,
      progress: { phase: 'simulating', completed: 1, total: 4 },
    })
    expect(await watcher.next('run:progress')).toMatchObject({ completed: 1 })

    // The owner makes the circuit private. Nothing about the socket changed.
    runs.readableCircuits.set('', new Set())
    // Past the authorisation TTL, so the cached decision is re-asked.
    await new Promise((resolve) => setTimeout(resolve, 2_100))

    publish({
      type: 'run:complete',
      runId: 'run_public',
      at: 2,
      status: 'DONE',
      durationMs: 5,
      error: null,
    })

    expect(await watcher.next('unsubscribed')).toEqual({
      type: 'unsubscribed',
      runId: 'run_public',
      reason: 'unauthorised',
    })
    expect(watcher.frames.some((frame) => frame.type === 'run:complete')).toBe(
      false
    )
    expect(events.watched()).toEqual([])
  })
})

describe('delivery', () => {
  beforeEach(() => {
    runs.seed({ id: 'run_open', userId: null, status: 'RUNNING' })
  })

  it('carries the three events §8 names', async () => {
    const client = await connect()
    client.send({ type: 'subscribe', runId: 'run_open' })
    await client.next('subscribed')

    publish({
      type: 'job:status',
      runId: 'run_open',
      at: 1,
      status: 'RUNNING',
    })
    expect(await client.next('job:status')).toEqual({
      type: 'job:status',
      runId: 'run_open',
      status: 'RUNNING',
    })

    publish({
      type: 'run:progress',
      runId: 'run_open',
      at: 2,
      progress: { phase: 'sampling', completed: 512, total: 1024 },
    })
    expect(await client.next('run:progress')).toEqual({
      type: 'run:progress',
      runId: 'run_open',
      phase: 'sampling',
      completed: 512,
      total: 1024,
    })

    publish({
      type: 'run:complete',
      runId: 'run_open',
      at: 3,
      status: 'DONE',
      durationMs: 42,
      error: null,
    })
    expect(await client.next('run:complete')).toEqual({
      type: 'run:complete',
      runId: 'run_open',
      status: 'DONE',
      durationMs: 42,
      error: null,
    })
    // And the channel is given back without the client asking.
    await client.next('unsubscribed')
    expect(events.watched()).toEqual([])
  })

  it('delivers one run to one socket and not to another', async () => {
    runs.seed({ id: 'run_other', userId: null, status: 'RUNNING' })
    const first = await connect()
    const second = await connect()
    first.send({ type: 'subscribe', runId: 'run_open' })
    second.send({ type: 'subscribe', runId: 'run_other' })
    await first.next('subscribed')
    await second.next('subscribed')

    publish({
      type: 'run:progress',
      runId: 'run_open',
      at: 1,
      progress: { phase: 'simulating', completed: null, total: null },
    })
    await first.next('run:progress')
    await new Promise((resolve) => setTimeout(resolve, 50))
    expect(second.frames.some((frame) => frame.type === 'run:progress')).toBe(
      false
    )
  })

  it('answers a client ping so a resumed tab can tell it is still connected', async () => {
    const client = await connect()
    client.send({ type: 'ping' })
    expect(await client.next('pong')).toEqual({ type: 'pong' })
  })
})

describe('bounds', () => {
  it('refuses more subscriptions than a socket may hold', async () => {
    for (let index = 0; index <= MAX_SOCKET_SUBSCRIPTIONS; index++) {
      runs.seed({ id: `run_${String(index)}`, userId: null, status: 'RUNNING' })
    }
    const client = await connect()
    for (let index = 0; index <= MAX_SOCKET_SUBSCRIPTIONS; index++) {
      client.send({ type: 'subscribe', runId: `run_${String(index)}` })
    }
    expect(await client.next('error')).toEqual({
      type: 'error',
      code: 'RATE_LIMITED',
      runId: `run_${String(MAX_SOCKET_SUBSCRIPTIONS)}`,
    })
  })

  it('closes a socket that keeps sending frames this protocol does not define', async () => {
    const client = await connect()
    for (let index = 0; index < 6; index++) client.socket.send('garbage')
    expect(await client.closed()).toBe(SOCKET_CLOSE.PROTOCOL)
  })

  it('closes a socket that floods it with perfectly valid frames', async () => {
    /*
     * The frames below all parse, so the protocol-violation counter never sees
     * them; each one is a `findReadableRun` against a pool of one. Counting the
     * upgrade is not counting a socket, because a socket is a request that
     * never ends.
     */
    const client = await connect()
    for (let index = 0; index < 400; index++) {
      client.socket.send(
        encodeFrame({ type: 'subscribe', runId: `guess_${String(index)}` })
      )
    }
    expect(await client.closed()).toBe(SOCKET_CLOSE.OVERLOADED)
  })

  it('refuses an upgrade from an origin the allow-list does not name', async () => {
    /*
     * @fastify/cors does not reject a disallowed origin — it omits the header
     * and continues — and a browser applies no CORS check to a WebSocket
     * handshake at all. So the allow-list only protects this route if the route
     * applies it, which is what this pins.
     */
    const response = await app.inject({
      method: 'GET',
      url: SOCKET_PATH,
      headers: { origin: 'https://evil.example' },
    })
    expect(response.statusCode).toBe(403)
  })

  it('still upgrades for a client that sends no origin at all', async () => {
    // Every non-browser client: a script, curl, the tests. Those are exactly
    // the callers that can present an Authorization header on the upgrade.
    const client = await connect()
    expect(client.frames[0]).toMatchObject({ type: 'ready' })
  })

  it('says the queue is unavailable when no Redis is configured', async () => {
    // The REDIS_URL-absent state, which is a supported one: everything else in
    // the API works and this one route cannot answer.
    const store = createMemoryRunStore()
    store.seed({ id: 'run_open', userId: null, status: 'RUNNING' })
    const bare = await createTestApp({
      runs: { repository: store },
      jwks: createTestJwksCache(stubJwksEndpoint([key])),
    })
    await bare.ready()
    try {
      const client = await open(bare)
      client.send({ type: 'subscribe', runId: 'run_open' })
      expect(await client.next('error')).toEqual({
        type: 'error',
        code: 'SIMULATION_UNAVAILABLE',
        runId: 'run_open',
      })
    } finally {
      await bare.close()
    }
  })
})
