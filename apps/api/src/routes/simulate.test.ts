/**
 * `POST /simulate` and `GET /simulate/:runId`, driven through `inject()`.
 *
 * Organised around the same rule as the circuit routes: **"the owner can read
 * it" proves nothing.** Every visibility assertion is made from a second user's
 * perspective and from an anonymous one, and for the two that must be
 * indistinguishable — "no such run" and "not yours" — on the error code as well
 * as the status.
 *
 * The second theme is §8's two answers. Whether a submission comes back 201 or
 * 202 is decided from the circuit by `routeOf`, whose threshold is the
 * browser's own ceiling, and both branches are pinned here — including the one
 * that is easy to get wrong, where a small register with a hundred thousand
 * shots is queued rather than waited on.
 */

import { CIRCUIT_SCHEMA_VERSION } from '@qsim/schema'
import type { CircuitInput } from '@qsim/schema'
import {
  CLIENT_STATEVECTOR_QUBITS,
  MAX_QUEUE_DEPTH,
  MAX_SHOTS,
} from '@qsim/jobs'
import { beforeEach, describe, expect, it } from 'vitest'
import type { ApiInstance } from '../app.js'
import { createTestApp } from '../testing/app.js'
import { createMemoryCircuitRepository } from '../testing/circuit-repository.js'
import {
  createMemoryQueue,
  createMemoryRunStore,
} from '../testing/simulation.js'
import type { MemoryQueue, MemoryRunStore } from '../testing/simulation.js'
import {
  createSigningKey,
  createTestJwksCache,
  signToken,
  stubJwksEndpoint,
} from '../testing/tokens.js'
import type { TestSigningKey } from '../testing/tokens.js'

const OWNER_ID = '11111111-1111-4111-8111-111111111111'
const STRANGER_ID = '22222222-2222-4222-8222-222222222222'
const BASE = '/api/v1/simulate'

interface ErrorBody {
  error: { code: string; message: string; requestId: string; details?: unknown }
}

interface RunBody {
  run: {
    id: string
    status: string
    mode: string
    shots: number | null
    circuitId: string | null
    createdAt: string
    durationMs: number | null
    result: unknown
    error: string | null
    progress: unknown
  }
}

function bell(): CircuitInput {
  return {
    schemaVersion: CIRCUIT_SCHEMA_VERSION,
    qubits: 2,
    clbits: 0,
    operations: [
      { id: 'h0', gate: 'h', targets: [0], column: 0 },
      { id: 'cx', gate: 'cx', targets: [1], controls: [0], column: 1 },
    ],
  }
}

/** One Hadamard per wire — a register of a chosen size, one column deep. */
function wide(qubits: number): CircuitInput {
  return {
    schemaVersion: CIRCUIT_SCHEMA_VERSION,
    qubits,
    clbits: 0,
    operations: Array.from({ length: qubits }, (_unused, qubit) => ({
      id: `h${String(qubit)}`,
      gate: 'h',
      targets: [qubit],
      column: 0,
    })),
  }
}

let key: TestSigningKey
let app: ApiInstance
let runs: MemoryRunStore
let queue: MemoryQueue

interface Setup {
  readonly queue?: MemoryQueue
  /** Omitted entirely, which is the REDIS_URL-absent state. */
  readonly noQueue?: boolean
}

async function build(setup: Setup = {}): Promise<void> {
  runs = createMemoryRunStore()
  /*
   * The default queue models a worker that picks the job up immediately and
   * finishes it — which is what makes the 201 branch reachable at all. A test
   * that wants a slow worker, an unreachable one, or a failing job passes its
   * own.
   */
  queue =
    setup.queue ??
    createMemoryQueue({
      onEnqueue: (payload) => {
        void runs.claimRun(payload.runId)
        void runs.completeRun({
          id: payload.runId,
          result: {
            resultVersion: 1,
            mode: payload.mode,
            qubits: payload.circuit.qubits,
            shots: payload.shots,
            seed: payload.seed,
            noiseProfileId: payload.noiseProfileId,
            outcomes: [{ state: '00', probability: 1, count: null }],
            hiddenOutcomes: 0,
            hiddenWeight: 0,
            purity: null,
            durationMs: 3,
          },
          durationMs: 3,
        })
      },
    })
  app = await createTestApp({
    jwks: createTestJwksCache(stubJwksEndpoint([key])),
    circuits: { repository: createMemoryCircuitRepository() },
    runs: { repository: runs },
    ...(setup.noQueue === true ? {} : { queue: { queue } }),
  })
}

function auth(token: string): Record<string, string> {
  return { authorization: `Bearer ${token}` }
}

async function tokenFor(userId: string): Promise<string> {
  return signToken(key, {
    subject: userId,
    email: `${userId}@example.invalid`,
  })
}

beforeEach(async () => {
  key = await createSigningKey('simulate-test')
  await build()
})

describe('POST /simulate — the two answers of §8', () => {
  it('answers 201 with a finished run when the work is small', async () => {
    /*
     * Small means "a register the browser could have handled" — the §4
     * argument. Work that arrives here below that ceiling did not arrive
     * because it was too big, so making the caller poll would add two round
     * trips to something that takes less time than one.
     */
    const response = await app.inject({
      method: 'POST',
      url: BASE,
      payload: { circuit: bell() },
    })

    expect(response.statusCode).toBe(201)
    const body = response.json<RunBody>()
    expect(body.run.status).toBe('DONE')
    expect(queue.enqueued).toHaveLength(1)
  })

  it('answers 202 with a run id when the register is past the client ceiling', async () => {
    const response = await app.inject({
      method: 'POST',
      url: BASE,
      payload: { circuit: wide(CLIENT_STATEVECTOR_QUBITS + 1) },
    })

    expect(response.statusCode).toBe(202)
    const body = response.json<RunBody>()
    expect(body.run.status).toBe('QUEUED')
    expect(body.run.result).toBeNull()
    // Queued from the start, so nothing waited on it: the queue was never asked
    // whether it had finished.
    expect(queue.enqueued).toHaveLength(1)
  })

  it('queues a small register whose shot count makes it long', async () => {
    /*
     * The half of the threshold that is time rather than size. Eight qubits is
     * well inside what a browser handles, and a hundred thousand trajectories
     * of it is a couple of hundred million kernel passes — admitted by §11's
     * limits, and not something to hold an HTTP connection open for.
     */
    const response = await app.inject({
      method: 'POST',
      url: BASE,
      payload: {
        circuit: wide(8),
        mode: 'TRAJECTORIES',
        shots: MAX_SHOTS,
      },
    })
    expect(response.statusCode).toBe(202)
    expect(queue.enqueued).toHaveLength(1)
  })

  it('answers 202 when a small run does not finish inside the window', async () => {
    // Not a failure: the wait is bounded and the fallback is the queued answer,
    // so a busy worker degrades a synchronous call into an asynchronous one.
    await build({ queue: createMemoryQueue({ completes: false }) })
    const response = await app.inject({
      method: 'POST',
      url: BASE,
      payload: { circuit: bell() },
    })
    expect(response.statusCode).toBe(202)
    expect(response.json<RunBody>().run.status).toBe('QUEUED')
  })

  it('answers 201 for a run that finished FAILED', async () => {
    /*
     * The resource was created and this is its final state. Answering 500 would
     * put a user's bad circuit in this service's error budget, and answering
     * 202 would have the client poll something that will never change.
     */
    await build({
      queue: createMemoryQueue({
        onEnqueue: (payload) => {
          void runs.claimRun(payload.runId)
          void runs.failRun({
            id: payload.runId,
            code: 'ENGINE_FAILED',
            durationMs: 4,
          })
        },
      }),
    })

    const response = await app.inject({
      method: 'POST',
      url: BASE,
      payload: { circuit: bell() },
    })

    expect(response.statusCode).toBe(201)
    const body = response.json<RunBody>()
    expect(body.run.status).toBe('FAILED')
    // A code, never a sentence: the client translates it into three catalogs.
    expect(body.run.error).toBe('ENGINE_FAILED')
  })
})

describe('POST /simulate — what it refuses', () => {
  it('validates the circuit with the whole contract, not only its shape', async () => {
    // Two gates on one qubit in one column: Zod accepts it, the contract does
    // not, and it would otherwise produce a perfectly normalised state that
    // belongs to no circuit anybody wrote.
    const response = await app.inject({
      method: 'POST',
      url: BASE,
      payload: {
        circuit: {
          schemaVersion: CIRCUIT_SCHEMA_VERSION,
          qubits: 1,
          clbits: 0,
          operations: [
            { id: 'a', gate: 'h', targets: [0], column: 0 },
            { id: 'b', gate: 'x', targets: [0], column: 0 },
          ],
        },
      },
    })

    expect(response.statusCode).toBe(400)
    expect(response.json<ErrorBody>().error.code).toBe('VALIDATION_FAILED')
    expect(queue.enqueued).toHaveLength(0)
  })

  it('refuses a register past the server ceiling with its own code', async () => {
    /*
     * SIMULATION_TOO_LARGE and not CIRCUIT_TOO_LARGE. The distinction is what
     * the caller can do about it: this circuit is a few hundred bytes and would
     * store happily; what it cannot do is be simulated, because 2ⁿ has nothing
     * to do with how much text describes it.
     */
    const response = await app.inject({
      method: 'POST',
      url: BASE,
      payload: { circuit: wide(26) },
    })

    expect(response.statusCode).toBe(413)
    expect(response.json<ErrorBody>().error.code).toBe('SIMULATION_TOO_LARGE')
    expect(queue.enqueued).toHaveLength(0)
    // Refused before a row exists, so a rejected request leaves nothing behind.
    expect(runs.rows.size).toBe(0)
  })

  it('refuses a shot count on a mode that draws none', async () => {
    // Ignoring it would answer a question nobody asked, and the caller would go
    // on believing they had asked for something.
    const response = await app.inject({
      method: 'POST',
      url: BASE,
      payload: { circuit: bell(), mode: 'DENSITY_MATRIX', shots: 100 },
    })
    expect(response.statusCode).toBe(400)
    expect(response.json<ErrorBody>().error.code).toBe('VALIDATION_FAILED')
  })

  it('refuses a noise profile it has never heard of', async () => {
    // A NoiseProfile is eight numbers that become Kraus operators, so the wire
    // carries a choice from a closed set and the numbers stay on the server.
    const response = await app.inject({
      method: 'POST',
      url: BASE,
      payload: { circuit: bell(), noiseProfileId: 'my-own-device' },
    })
    expect(response.statusCode).toBe(400)
  })

  it('refuses a circuit attributed to something the caller cannot see', async () => {
    // Otherwise a run is a side channel onto a private circuit: the read filter
    // joins back through this column.
    const response = await app.inject({
      method: 'POST',
      url: BASE,
      payload: { circuit: bell(), circuitId: 'not-mine' },
    })
    expect(response.statusCode).toBe(404)
    expect(response.json<ErrorBody>().error.code).toBe('NOT_FOUND')
  })
})

describe('POST /simulate — Redis is not reachable', () => {
  it('answers 503 when no REDIS_URL was configured', async () => {
    /*
     * A supported state, not a broken one: §4 means most simulation happens in
     * the browser, so the API degrades to one route answering 503 rather than
     * refusing to boot and taking the gallery with it.
     */
    await build({ noQueue: true })
    const response = await app.inject({
      method: 'POST',
      url: BASE,
      payload: { circuit: bell() },
    })

    expect(response.statusCode).toBe(503)
    expect(response.json<ErrorBody>().error.code).toBe('SIMULATION_UNAVAILABLE')
  })

  it('answers 503 when the connection fails mid-request', async () => {
    // Identical behaviour to "not configured", deliberately: they are the same
    // fact to a client, which is that server simulation is unavailable.
    await build({ queue: createMemoryQueue({ unavailable: true }) })
    const response = await app.inject({
      method: 'POST',
      url: BASE,
      payload: { circuit: bell() },
    })
    expect(response.statusCode).toBe(503)
    expect(response.json<ErrorBody>().error.code).toBe('SIMULATION_UNAVAILABLE')
  })

  it('does not leave a run queued forever when the enqueue fails', async () => {
    /*
     * The row is created before the job, because the job names the row it
     * writes into. An enqueue that fails therefore has a row to answer for, and
     * a run that sits QUEUED forever is worse than one that failed: a client
     * polls it and nothing ever changes.
     */
    await build({ queue: createMemoryQueue({ enqueueFails: true }) })
    const response = await app.inject({
      method: 'POST',
      url: BASE,
      payload: { circuit: bell() },
    })

    expect(response.statusCode).toBe(503)
    const rows = [...runs.rows.values()]
    expect(rows).toHaveLength(1)
    expect(rows[0]?.status).toBe('FAILED')
    expect(rows[0]?.errorMessage).toBe('QUEUE_UNAVAILABLE')
  })

  it('does not leave a run queued forever when the claim fails', async () => {
    /*
     * One step earlier than the enqueue, and the same outage. The row was
     * already created, so a failure here used to leave it QUEUED for ever —
     * unreachable, because its id was never returned to anybody.
     */
    await build({ queue: createMemoryQueue({ unavailable: true }) })
    const response = await app.inject({
      method: 'POST',
      url: BASE,
      payload: { circuit: bell() },
    })

    expect(response.statusCode).toBe(503)
    const rows = [...runs.rows.values()]
    expect(rows).toHaveLength(1)
    expect(rows[0]?.status).toBe('FAILED')
    expect(rows[0]?.errorMessage).toBe('QUEUE_UNAVAILABLE')
  })

  it('answers 202 with the run id when the wait itself fails', async () => {
    /*
     * The job is enqueued and the row exists; only the *observation* failed.
     * Answering 503 threw away the one thing that makes the run collectable —
     * its id — while the worker went on spending a full job's CPU on it. The
     * route already treats "did not finish in the window" as an ordinary 202.
     */
    await build({
      queue: createMemoryQueue({ awaitFails: true, completes: false }),
    })
    const response = await app.inject({
      method: 'POST',
      url: BASE,
      payload: { circuit: bell() },
    })

    expect(response.statusCode).toBe(202)
    expect(response.json<RunBody>().run.id).toBeTruthy()
    expect(queue.enqueued).toHaveLength(1)
  })

  it('refuses a submission when the queue is already too deep', async () => {
    /*
     * 256 MB, `noeviction`, and every job carries a whole circuit document: a
     * queue nobody bounds does not slow down, it fills, and then every write in
     * the system fails at once — including the ones that would report it.
     */
    await build({ queue: createMemoryQueue({ depth: MAX_QUEUE_DEPTH }) })
    const response = await app.inject({
      method: 'POST',
      url: BASE,
      payload: { circuit: bell() },
    })

    expect(response.statusCode).toBe(429)
    expect(response.json<ErrorBody>().error.code).toBe('RATE_LIMITED')
    // Refused before a row exists, so nothing is left to clean up.
    expect(runs.rows.size).toBe(0)
    expect(queue.enqueued).toHaveLength(0)
  })

  it('still serves GET, which needs no queue at all', async () => {
    await build({ noQueue: true })
    runs.seed({ id: 'run-1', status: 'DONE' })
    const response = await app.inject({ method: 'GET', url: `${BASE}/run-1` })
    expect(response.statusCode).toBe(200)
    expect(response.json<RunBody>().run.progress).toBeNull()
  })
})

describe('POST /simulate — a duplicate submission', () => {
  it('answers with the run that already exists, and creates nothing', async () => {
    const payload = { circuit: bell(), seed: 99 }

    const first = await app.inject({ method: 'POST', url: BASE, payload })
    const second = await app.inject({ method: 'POST', url: BASE, payload })

    expect(first.statusCode).toBe(201)
    // 200 and not 201: nothing came into existence, which is the one thing a
    // caller cannot infer from the body.
    expect(second.statusCode).toBe(200)
    expect(second.json<RunBody>().run.id).toBe(first.json<RunBody>().run.id)

    expect(queue.enqueued).toHaveLength(1)
    // The losing row is discarded rather than left behind.
    expect(runs.rows.size).toBe(1)
  })

  it('lets an identical submission retry a run that failed', async () => {
    /*
     * The deduplication key survives the failure and carries no status, so the
     * retry was handed the same FAILED run and enqueued nothing — for the whole
     * five minutes of DEDUPLICATION_TTL_MS. It is reachable from the UI in one
     * click, because the panel's seed is a fixed default and the body is
     * therefore byte-identical. From the reader's side that is a button that
     * has stopped working.
     */
    await build({
      queue: createMemoryQueue({
        onEnqueue: (payload) => {
          void runs.claimRun(payload.runId)
          void runs.failRun({
            id: payload.runId,
            code: 'ENGINE_FAILED',
            durationMs: 1,
          })
        },
      }),
    })
    const payload = { circuit: bell(), seed: 42 }

    const first = await app.inject({ method: 'POST', url: BASE, payload })
    expect(first.statusCode).toBe(201)
    expect(first.json<RunBody>().run.status).toBe('FAILED')

    const second = await app.inject({ method: 'POST', url: BASE, payload })
    expect(second.statusCode).toBe(201)
    expect(second.json<RunBody>().run.id).not.toBe(first.json<RunBody>().run.id)
    expect(queue.enqueued).toHaveLength(2)
  })

  it('still collapses onto a run that is merely still going', async () => {
    // The other half of the rule: deduplication is about work in flight, and a
    // run that has not answered yet is exactly that.
    await build({ queue: createMemoryQueue({ completes: false }) })
    const payload = { circuit: bell(), seed: 43 }

    const first = await app.inject({ method: 'POST', url: BASE, payload })
    const second = await app.inject({ method: 'POST', url: BASE, payload })

    expect(second.statusCode).toBe(200)
    expect(second.json<RunBody>().run.id).toBe(first.json<RunBody>().run.id)
    expect(queue.enqueued).toHaveLength(1)
  })

  it('keeps 128 bits of the work digest in the deduplication key', async () => {
    /*
     * `payload.ts` calls this the one truncation in the codebase that is a
     * security parameter: a collision does not produce a wrong number, it hands
     * the second submitter the first one's run over a circuit that is not
     * theirs. Passing the *job id* — `sim-` plus 32 characters — through the
     * key's own 32-character slice left 28 hex characters, which is 112 bits.
     */
    await app.inject({
      method: 'POST',
      url: BASE,
      payload: { circuit: bell(), seed: 7 },
    })
    const keys = [...queue.claims.keys()]
    expect(keys).toHaveLength(1)
    const digest = (keys[0] ?? '').split(':dedupe:')[1] ?? ''
    expect(digest).toMatch(/^[0-9a-f]{32}$/)
  })

  it('treats a different seed as different work', async () => {
    // The seed decides the answer, so two seeds are two runs — otherwise a
    // "reproducible" run would be reproducing somebody else's draw.
    const one = await app.inject({
      method: 'POST',
      url: BASE,
      payload: { circuit: bell(), seed: 1 },
    })
    const two = await app.inject({
      method: 'POST',
      url: BASE,
      payload: { circuit: bell(), seed: 2 },
    })
    expect(one.json<RunBody>().run.id).not.toBe(two.json<RunBody>().run.id)
    expect(queue.enqueued).toHaveLength(2)
  })

  it('never shares a run between two callers', async () => {
    /*
     * The submitter is part of the work digest, so identical circuits from two
     * people are two rows. Collapsing them would hand the second caller a run
     * the first one owns — and `simulationRunFilter` would then refuse them
     * their own answer.
     */
    const ownerToken = await tokenFor(OWNER_ID)
    const strangerToken = await tokenFor(STRANGER_ID)
    const payload = { circuit: bell(), seed: 5 }

    const mine = await app.inject({
      method: 'POST',
      url: BASE,
      payload,
      headers: auth(ownerToken),
    })
    const theirs = await app.inject({
      method: 'POST',
      url: BASE,
      payload,
      headers: auth(strangerToken),
    })

    expect(mine.json<RunBody>().run.id).not.toBe(theirs.json<RunBody>().run.id)
    expect(queue.enqueued).toHaveLength(2)
  })
})

describe('GET /simulate/:runId — §11', () => {
  it('lets an anonymous caller collect the run their id names', async () => {
    // The only workable rule for an anonymous run: the id is the credential,
    // exactly as a slug is for an UNLISTED circuit.
    runs.seed({ id: 'run-anon', userId: null, status: 'DONE' })
    const response = await app.inject({
      method: 'GET',
      url: `${BASE}/run-anon`,
    })
    expect(response.statusCode).toBe(200)
    expect(response.json<RunBody>().run.id).toBe('run-anon')
  })

  it('lets the owner read their own run', async () => {
    runs.seed({ id: 'run-mine', userId: OWNER_ID, status: 'DONE' })
    const response = await app.inject({
      method: 'GET',
      url: `${BASE}/run-mine`,
      headers: auth(await tokenFor(OWNER_ID)),
    })
    expect(response.statusCode).toBe(200)
  })

  it('refuses a stranger, with the code that does not confirm it exists', async () => {
    runs.seed({ id: 'run-mine', userId: OWNER_ID, status: 'DONE' })
    const response = await app.inject({
      method: 'GET',
      url: `${BASE}/run-mine`,
      headers: auth(await tokenFor(STRANGER_ID)),
    })
    expect(response.statusCode).toBe(404)
    expect(response.json<ErrorBody>().error.code).toBe('NOT_FOUND')
  })

  it('refuses an anonymous caller a run that has an owner', async () => {
    // A run having an owner is itself the statement that its id is not a
    // credential.
    runs.seed({ id: 'run-mine', userId: OWNER_ID, status: 'DONE' })
    const response = await app.inject({
      method: 'GET',
      url: `${BASE}/run-mine`,
    })
    expect(response.statusCode).toBe(404)
  })

  it('answers the same 404 for a run that does not exist', async () => {
    // The two must be indistinguishable, or the difference is an oracle.
    const response = await app.inject({
      method: 'GET',
      url: `${BASE}/run-none`,
    })
    expect(response.statusCode).toBe(404)
    expect(response.json<ErrorBody>().error.code).toBe('NOT_FOUND')
  })

  it('refuses a run over a circuit the viewer may not read', async () => {
    /*
     * A run's result is a function of a circuit, so it is readable only if the
     * circuit is. Without this clause, a leaked run id would be a way to learn
     * the outcome of somebody's private work.
     */
    runs.seed({ id: 'run-private', userId: null, circuitId: 'circuit-private' })
    runs.readableCircuits.set('', new Set())

    const response = await app.inject({
      method: 'GET',
      url: `${BASE}/run-private`,
    })
    expect(response.statusCode).toBe(404)
  })

  it('allows a run over a circuit the viewer can read', async () => {
    runs.seed({
      id: 'run-public',
      userId: null,
      circuitId: 'circuit-public',
      status: 'DONE',
    })
    runs.readableCircuits.set('', new Set(['circuit-public']))

    const response = await app.inject({
      method: 'GET',
      url: `${BASE}/run-public`,
    })
    expect(response.statusCode).toBe(200)
  })
})

describe('GET /simulate/:runId — the shape', () => {
  it('carries the stored reading back', async () => {
    runs.seed({ id: 'run-1' })
    runs.finish('run-1', {
      resultVersion: 1,
      mode: 'STATEVECTOR',
      qubits: 2,
      shots: null,
      seed: 7,
      noiseProfileId: null,
      outcomes: [{ state: '00', probability: 0.5, count: null }],
      hiddenOutcomes: 0,
      hiddenWeight: 0,
      purity: null,
      durationMs: 3,
    })

    const response = await app.inject({ method: 'GET', url: `${BASE}/run-1` })
    expect(response.statusCode).toBe(200)
    expect(response.json<RunBody>().run.result).toMatchObject({
      resultVersion: 1,
      outcomes: [{ state: '00', probability: 0.5, count: null }],
    })
  })

  it('answers with no result rather than failing on a shape it cannot read', async () => {
    // The column outlives the code that wrote it. A stored value that no longer
    // parses must read as "no readable result", not as a serialisation error on
    // the response path.
    runs.seed({ id: 'run-1' })
    runs.finish('run-1', { resultVersion: 99, nonsense: true })
    const response = await app.inject({ method: 'GET', url: `${BASE}/run-1` })
    expect(response.statusCode).toBe(200)
    expect(response.json<RunBody>().run.result).toBeNull()
  })

  it('carries progress only while there is something to report', async () => {
    await build({
      queue: createMemoryQueue({
        progress: { phase: 'simulating', completed: 40, total: 100 },
      }),
    })
    runs.seed({ id: 'run-1', status: 'RUNNING' })
    runs.seed({ id: 'run-2', status: 'DONE' })

    const running = await app.inject({ method: 'GET', url: `${BASE}/run-1` })
    expect(running.json<RunBody>().run.progress).toEqual({
      phase: 'simulating',
      completed: 40,
      total: 100,
    })

    const finished = await app.inject({ method: 'GET', url: `${BASE}/run-2` })
    expect(finished.json<RunBody>().run.progress).toBeNull()
  })

  it('refuses a run id shaped like an attack on the index', async () => {
    const response = await app.inject({
      method: 'GET',
      url: `${BASE}/${'x'.repeat(200)}`,
    })
    expect(response.statusCode).toBeGreaterThanOrEqual(400)
    expect(response.statusCode).toBeLessThan(500)
  })
})
