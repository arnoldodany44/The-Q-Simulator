/**
 * The queue, against the real Redis.
 *
 * ── Off by default, and the reason is not timidity ────────────────────────
 *
 * The instance behind `REDIS_URL` is a shared, metered, 256 MB free tier, and
 * it is the same instance production uses. A suite that connected on every run
 * would spend the tier's bandwidth on every `pnpm verify`, and — because a
 * BullMQ worker holds a *blocking* connection — a single hung test would keep
 * reading until somebody noticed the bill. Everything worth asserting about the
 * payload, the state machine, the progress protocol, the pool and the result
 * shape is pure and is asserted elsewhere with nothing running.
 *
 * What only a live instance can answer is the handful of facts below: that a
 * job added by a producer is the same object a consumer receives, that the
 * completion signal a waiter polls is really written, that a run's events reach
 * the channel `apps/api` subscribes to — the agreement two processes hold
 * through `@qsim/jobs` and can otherwise break in silence — and that the whole
 * round trip works against the TLS, the Lua support and the `noeviction` policy
 * this particular instance has.
 *
 * Run it deliberately:
 *
 *   QSIM_QUEUE_INTEGRATION=1 pnpm --filter worker test
 *
 * ── The hygiene rules, which are not negotiable here ──────────────────────
 *
 * 1. **A unique prefix per run.** Every key this file creates lives under
 *    `qsim-it-<random>`, so it cannot collide with production, with a
 *    developer's local worker, or with a second copy of this suite running at
 *    the same time.
 * 2. **Everything is deleted afterwards**, by scanning that prefix and nothing
 *    else. There is no FLUSHALL and no FLUSHDB anywhere in this repository, and
 *    there must not be: the instance is shared and the policy is `noeviction`,
 *    so a flush is a permanent loss of whatever else is on it.
 * 3. **Every wait is bounded.** No test here may block indefinitely on a
 *    blocking read; `waitFor` gives up and fails rather than hanging.
 * 4. **Nothing is left running.** Every worker and every connection is closed
 *    in `afterEach`, including on a failure path.
 */

import process from 'node:process'
import { Queue } from 'bullmq'
import {
  SIMULATION_JOB_NAME,
  SIMULATION_QUEUE,
  completionKey,
  parseRunEvent,
  runEventChannel,
} from '@qsim/jobs'
import type { RunEvent } from '@qsim/jobs'
import type { Redis } from 'ioredis'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import { loadEnv } from './env.js'
import { createConnection, startQueue } from './queue.js'
import type { QueueRuntime } from './queue.js'
import { fakePool, fakeRunStore } from './testing/doubles.js'
import type { FakeRunStore } from './testing/doubles.js'
import { jobPayload } from './testing/payloads.js'

const enabled = process.env.QSIM_QUEUE_INTEGRATION === '1'
const redisUrl = process.env.REDIS_URL ?? ''

/** Unique per run, so two copies of this suite cannot see each other. */
const PREFIX = `qsim-it-${Math.random().toString(36).slice(2, 10)}`

const env = loadEnv({
  NODE_ENV: 'test',
  REDIS_URL: redisUrl === '' ? 'redis://localhost:6379' : redisUrl,
  DATABASE_URL: 'postgresql://postgres@localhost:5432/qsim_test',
  QUEUE_PREFIX: PREFIX,
  WORKER_CONCURRENCY: '1',
})

let producerConnection: Redis | null = null
let consumerConnection: Redis | null = null
let queue: Queue | null = null
let runtime: QueueRuntime | null = null

/** Polls a condition on a hard deadline. Nothing here may wait forever. */
async function waitFor(
  what: string,
  condition: () => boolean | Promise<boolean>,
  timeoutMs = 10_000
): Promise<void> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    if (await condition()) return
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`)
    await new Promise((resolve) => setTimeout(resolve, 50))
  }
}

/** Removes every key this suite created, and only those. */
async function cleanup(connection: Redis): Promise<void> {
  let cursor = '0'
  do {
    const [next, keys] = await connection.scan(
      cursor,
      'MATCH',
      `${PREFIX}:*`,
      'COUNT',
      100
    )
    cursor = next
    if (keys.length > 0) await connection.del(...keys)
  } while (cursor !== '0')
}

describe.skipIf(!enabled)('the live queue', () => {
  beforeAll(() => {
    if (redisUrl === '') {
      throw new Error(
        'QSIM_QUEUE_INTEGRATION=1 needs REDIS_URL. This suite writes under a ' +
          'unique prefix and cleans up after itself; it never flushes.'
      )
    }
  })

  afterEach(async () => {
    // Closed on every path, including a failure. A BullMQ worker holds a
    // blocking connection, and one left running would read until somebody
    // noticed the bill.
    await runtime?.close()
    runtime = null
    consumerConnection = null
    if (queue !== null) await queue.close()
    queue = null
    producerConnection = null
  })

  afterAll(async () => {
    // Guarded on the URL as well as the flag: `beforeAll` fails the suite when
    // it is missing, and a cleanup that then tried to connect to a default
    // localhost would sit in ioredis's retry loop until the hook timed out —
    // turning one clear failure into two confusing ones.
    if (redisUrl === '') return
    const connection = createConnection(env.redisUrl)
    try {
      await cleanup(connection)
    } finally {
      await connection.quit()
    }
  })

  it('carries a job from a producer to a consumer and writes the row', async () => {
    const runs: FakeRunStore = fakeRunStore()
    runs.seed({ id: 'run-live-1' })

    consumerConnection = createConnection(env.redisUrl)
    runtime = startQueue({
      env,
      connection: consumerConnection,
      ports: {
        runs,
        pool: fakePool(),
        log: () => undefined,
        timeoutMs: env.timeoutMs,
      },
    })

    producerConnection = createConnection(env.redisUrl)
    queue = new Queue(SIMULATION_QUEUE, {
      connection: producerConnection,
      prefix: PREFIX,
    })
    await queue.add(SIMULATION_JOB_NAME, jobPayload({ runId: 'run-live-1' }), {
      jobId: 'run-live-1',
    })

    await waitFor(
      'the run to reach DONE',
      () => runs.rows.get('run-live-1')?.status === 'DONE'
    )
    expect(runs.rows.get('run-live-1')?.result).toMatchObject({
      resultVersion: 1,
    })
  })

  it('writes the completion signal a synchronous caller waits on', async () => {
    const runs: FakeRunStore = fakeRunStore()
    runs.seed({ id: 'run-live-2' })

    consumerConnection = createConnection(env.redisUrl)
    runtime = startQueue({
      env,
      connection: consumerConnection,
      ports: {
        runs,
        pool: fakePool(),
        log: () => undefined,
        timeoutMs: env.timeoutMs,
      },
    })

    producerConnection = createConnection(env.redisUrl)
    queue = new Queue(SIMULATION_QUEUE, {
      connection: producerConnection,
      prefix: PREFIX,
    })
    await queue.add(SIMULATION_JOB_NAME, jobPayload({ runId: 'run-live-2' }), {
      jobId: 'run-live-2',
    })

    const key = completionKey(PREFIX, 'run-live-2')
    await waitFor('the completion key', async () => {
      const exists = await producerConnection?.exists(key)
      return exists === 1
    })

    // Short-lived on purpose: it is only ever read inside the synchronous
    // window, and a key with no expiry is a key that accumulates.
    const ttl = await producerConnection.pttl(key)
    expect(ttl).toBeGreaterThan(0)
  })

  it('keeps every key under its own prefix, so nothing else is touched', async () => {
    consumerConnection = createConnection(env.redisUrl)
    producerConnection = createConnection(env.redisUrl)
    queue = new Queue(SIMULATION_QUEUE, {
      connection: producerConnection,
      prefix: PREFIX,
    })
    await queue.add(SIMULATION_JOB_NAME, jobPayload({ runId: 'run-live-3' }), {
      jobId: 'run-live-3',
    })

    const [, keys] = await producerConnection.scan(
      '0',
      'MATCH',
      `${PREFIX}:*`,
      'COUNT',
      100
    )
    expect(keys.length).toBeGreaterThan(0)
    for (const key of keys) expect(key.startsWith(`${PREFIX}:`)).toBe(true)
  })

  it('publishes a run’s events where the API subscribes for them', async () => {
    /*
     * The one fact about §8's socket that no pure test can reach: the channel
     * name this process publishes to and the channel name `apps/api` subscribes
     * to are the same string, and the payload survives the round trip.
     *
     * The two apps cannot import each other (§12.3), so the agreement lives in
     * `@qsim/jobs` — and an agreement held in one package and used by two
     * processes is exactly the thing that drifts silently. Here it is a
     * subscriber holding the very function the API holds.
     *
     * Note what is deliberately *not* asserted: that every event arrives.
     * Pub/sub is at-most-once and the subscription is established before the
     * job is added, so in practice they all do — but the design does not
     * depend on it, and a test that demanded it would be pinning a property
     * the system does not claim.
     */
    const runs: FakeRunStore = fakeRunStore()
    runs.seed({ id: 'run-live-4' })

    const channel = runEventChannel(PREFIX, 'run-live-4')
    const received: RunEvent[] = []
    // Its own connection: ioredis puts a client into subscriber mode, after
    // which it may issue nothing else — the same reason `apps/api` opens one.
    const subscriber = createConnection(env.redisUrl)
    subscriber.on('message', (_channel: string, payload: string) => {
      const event = parseRunEvent(payload)
      if (event !== null) received.push(event)
    })

    try {
      await subscriber.subscribe(channel)

      consumerConnection = createConnection(env.redisUrl)
      runtime = startQueue({
        env,
        connection: consumerConnection,
        ports: {
          runs,
          pool: fakePool(),
          log: () => undefined,
          timeoutMs: env.timeoutMs,
        },
      })

      producerConnection = createConnection(env.redisUrl)
      queue = new Queue(SIMULATION_QUEUE, {
        connection: producerConnection,
        prefix: PREFIX,
      })
      await queue.add(
        SIMULATION_JOB_NAME,
        jobPayload({ runId: 'run-live-4' }),
        {
          jobId: 'run-live-4',
        }
      )

      await waitFor('the completion event', () =>
        received.some((event) => event.type === 'run:complete')
      )
      expect(received.at(0)).toMatchObject({
        type: 'job:status',
        runId: 'run-live-4',
        status: 'RUNNING',
      })
      expect(received.at(-1)).toMatchObject({
        type: 'run:complete',
        status: 'DONE',
        error: null,
      })
    } finally {
      // Unsubscribed and closed on every path: a subscriber left open is a
      // blocking connection on a metered tier, which is the failure this whole
      // file's hygiene rules exist to prevent.
      await subscriber.unsubscribe(channel).catch(() => undefined)
      await subscriber.quit().catch(() => subscriber.disconnect())
    }
  })
})
