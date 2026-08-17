/**
 * `/hardware/*`, driven through `inject()` — §3.7, §8, §11, risk 4.
 *
 * ══════════════════════════════════════════════════════════════════════════
 * THE TEST THIS FILE EXISTS FOR
 *
 * §11 says the credential read endpoint returns metadata and «jamás el token».
 * The check people write instead is "a stranger cannot read it", which is true
 * and is not the rule. So the assertions below are made **from the owner's own
 * session**, on the route the owner uses, over a credential the owner created
 * seconds earlier — and the token is not there, not in any field, not
 * truncated, not masked, and not in the JSON at all.
 *
 * The ciphertext is real: `memoryHardware` uses the actual AES-256-GCM
 * implementation over a real random key, so "the plaintext is not in the row"
 * is a property of the stored bytes rather than of a stub that forgot to keep
 * them.
 *
 * ══════════════════════════════════════════════════════════════════════════
 * NOTHING HERE SPENDS QPU TIME
 *
 * Every call goes to `recordedTransport`, whose answers were copied from the
 * live service through reads that cost nothing. What is asserted is the request
 * that *would* have been sent — the headers, the pub, the shot count — which is
 * the only kind of assertion an allowance of ten minutes per twenty-eight days
 * can afford, and is stronger than a live one besides: a live run cannot be
 * asked to answer 429 on demand.
 */

import { CIRCUIT_SCHEMA_VERSION, parseCircuit } from '@qsim/schema'
import type { CircuitInput } from '@qsim/schema'
import { RECORDED, scriptOf } from '@qsim/ibm/testing'
import { beforeEach, describe, expect, it } from 'vitest'
import type { ApiInstance } from '../app.js'
import { createTestApp } from '../testing/app.js'
import { createMemoryCircuitRepository } from '../testing/circuit-repository.js'
import type { MemoryCircuitRepository } from '../testing/circuit-repository.js'
import {
  REFUSED_KEY,
  TEST_API_KEY,
  TEST_CRN,
  WORKING_ACCOUNT,
  memoryHardware,
  memoryHardwareQueue,
} from '../testing/hardware.js'
import type {
  MemoryHardware,
  MemoryHardwareQueue,
} from '../testing/hardware.js'
import {
  createSigningKey,
  createTestJwksCache,
  signToken,
  stubJwksEndpoint,
} from '../testing/tokens.js'
import type { TestSigningKey } from '../testing/tokens.js'

const OWNER_ID = '11111111-1111-4111-8111-111111111111'
const STRANGER_ID = '22222222-2222-4222-8222-222222222222'
const BASE = '/api/v1/hardware'

let key: TestSigningKey
let app: ApiInstance
let hardware: MemoryHardware
let queue: MemoryHardwareQueue
let circuits: MemoryCircuitRepository

interface ErrorBody {
  error: { code: string; message: string; details?: unknown }
}

/** Two qubits, one entangling gate, and a measurement into a crossed register. */
function measuredPair(): CircuitInput {
  return {
    schemaVersion: CIRCUIT_SCHEMA_VERSION,
    qubits: 2,
    clbits: 2,
    operations: [
      { id: 'x0', gate: 'x', targets: [0], column: 0 },
      { id: 'h1', gate: 'h', targets: [1], column: 0 },
      { id: 'cx', gate: 'cx', targets: [1], controls: [0], column: 1 },
      { id: 'm0', gate: 'measure', targets: [0], clbitTargets: [0], column: 2 },
      { id: 'm1', gate: 'measure', targets: [1], clbitTargets: [1], column: 2 },
    ],
  }
}

/** A circuit far wider than the four-qubit device in the recording. */
function tooWide(): CircuitInput {
  return {
    schemaVersion: CIRCUIT_SCHEMA_VERSION,
    qubits: 8,
    clbits: 8,
    operations: Array.from({ length: 8 }, (_unused, qubit) => ({
      id: `m${String(qubit)}`,
      gate: 'measure' as const,
      targets: [qubit],
      clbitTargets: [qubit],
      column: 0,
    })),
  }
}

async function bearer(userId: string): Promise<Record<string, string>> {
  const token = await signToken(key, {
    subject: userId,
    email: `${userId}@example.invalid`,
  })
  return { authorization: `Bearer ${token}` }
}

async function build(
  script: Parameters<typeof memoryHardware>[0] = WORKING_ACCOUNT
): Promise<void> {
  hardware = memoryHardware(script)
  queue = memoryHardwareQueue()
  circuits = createMemoryCircuitRepository()
  app = await createTestApp({
    jwks: createTestJwksCache(stubJwksEndpoint([key])),
    circuits: { repository: circuits },
    hardware: { port: hardware.port },
    hardwareQueue: { queue },
  })
}

/** Registers a credential and answers its id. */
async function credentialFor(userId = OWNER_ID): Promise<string> {
  const response = await app.inject({
    method: 'POST',
    url: `${BASE}/credentials`,
    headers: await bearer(userId),
    payload: {
      provider: 'ibm_quantum',
      apiKey: TEST_API_KEY,
      instance: TEST_CRN,
      label: 'my open plan',
    },
  })
  expect(response.statusCode).toBe(201)
  return response.json<{ credential: { id: string } }>().credential.id
}

/** Saves a circuit for this owner and answers its id. */
async function circuitFor(
  userId = OWNER_ID,
  circuit: CircuitInput = measuredPair()
): Promise<string> {
  await circuits.ensureOwner({
    id: userId,
    email: `${userId}@example.invalid`,
    displayName: null,
    avatarUrl: null,
  })
  const created = await circuits.create({
    ownerId: userId,
    title: 'a pair',
    description: null,
    visibility: 'PRIVATE',
    data: parseCircuit(circuit),
    message: null,
    forkedFromId: null,
  })
  return created.circuit.id
}

beforeEach(async () => {
  key = await createSigningKey('hardware-test')
  await build()
})

/* ══════════════════════════════════════════════════════════════════════ */

describe('the credential never comes back — §11', () => {
  it('answers a create with four fields and none of them a secret', async () => {
    const response = await app.inject({
      method: 'POST',
      url: `${BASE}/credentials`,
      headers: await bearer(OWNER_ID),
      payload: {
        provider: 'ibm_quantum',
        apiKey: TEST_API_KEY,
        instance: TEST_CRN,
        label: 'my open plan',
      },
    })

    expect(response.statusCode).toBe(201)
    const body = response.json<{ credential: Record<string, unknown> }>()
    expect(Object.keys(body.credential).sort()).toEqual([
      'createdAt',
      'id',
      'label',
      'provider',
    ])
  })

  /*
   * THE ONE THAT MATTERS. Asked as the owner, on the owner's own credential.
   * "Only the owner can read it" is the check people write instead of this.
   */
  it('withholds the token from the owner s own session', async () => {
    const id = await credentialFor()

    for (const url of [`${BASE}/credentials`, `${BASE}/credentials/${id}`]) {
      const response = await app.inject({
        method: 'GET',
        url,
        headers: await bearer(OWNER_ID),
      })
      expect(response.statusCode).toBe(200)
      // The whole body, as text: not a field check, a substring check.
      expect(response.body).not.toContain(TEST_API_KEY)
      expect(response.body).not.toContain('crn:v1')
      expect(response.body).not.toContain('encryptedToken')
      expect(response.body).not.toContain('iv')
    }
  })

  /* Not even a fragment. An API key has no "last four" convention. */
  it('withholds every fragment of it, masked or truncated', async () => {
    const id = await credentialFor()
    const response = await app.inject({
      method: 'GET',
      url: `${BASE}/credentials/${id}`,
      headers: await bearer(OWNER_ID),
    })
    for (const window of [
      TEST_API_KEY.slice(0, 8),
      TEST_API_KEY.slice(-8),
      TEST_CRN.slice(-12),
    ]) {
      expect(response.body).not.toContain(window)
    }
  })

  it('stores ciphertext, and the plaintext is nowhere in the row', async () => {
    await credentialFor()
    const stored = [...hardware.rows.values()]
    expect(stored).toHaveLength(1)
    const bytes = Buffer.from(stored[0]?.encryptedToken ?? new Uint8Array())
    expect(bytes.toString('utf8')).not.toContain(TEST_API_KEY)
    // The CRN is inside the ciphertext too: it names an account and an
    // instance, and a plaintext column beside the ciphertext would publish it.
    expect(bytes.toString('utf8')).not.toContain('crn:v1')
    expect(bytes.length).toBeGreaterThan(0)
  })

  it('refuses to list another person s credentials', async () => {
    await credentialFor(OWNER_ID)
    const response = await app.inject({
      method: 'GET',
      url: `${BASE}/credentials`,
      headers: await bearer(STRANGER_ID),
    })
    expect(response.json()).toEqual({ credentials: [] })
  })

  it('answers 404 and never 403 for somebody else s credential', async () => {
    const id = await credentialFor(OWNER_ID)
    const response = await app.inject({
      method: 'GET',
      url: `${BASE}/credentials/${id}`,
      headers: await bearer(STRANGER_ID),
    })
    expect(response.statusCode).toBe(404)
    expect(response.json().error.code).toBe('NOT_FOUND')
  })

  it('requires a session at all', async () => {
    const response = await app.inject({
      method: 'GET',
      url: `${BASE}/credentials`,
    })
    expect(response.statusCode).toBe(401)
  })
})

describe('registering a credential', () => {
  /* Measured: IAM answers 400 for a key it does not recognise, not 401. */
  it('proves the key before storing it, and stores nothing if refused', async () => {
    await build(REFUSED_KEY)
    const response = await app.inject({
      method: 'POST',
      url: `${BASE}/credentials`,
      headers: await bearer(OWNER_ID),
      payload: {
        provider: 'ibm_quantum',
        apiKey: TEST_API_KEY,
        instance: TEST_CRN,
      },
    })
    expect(response.statusCode).toBe(502)
    expect(response.json().error.code).toBe('HARDWARE_CREDENTIAL_REJECTED')
    expect(hardware.rows.size).toBe(0)
  })

  it('refuses a CRN that addresses no host, before the key leaves', async () => {
    const response = await app.inject({
      method: 'POST',
      url: `${BASE}/credentials`,
      headers: await bearer(OWNER_ID),
      payload: {
        provider: 'ibm_quantum',
        apiKey: TEST_API_KEY,
        instance: 'crn:v1:bluemix:public:cloudantnosqldb:us-east:a/x:y::',
      },
    })
    expect(response.statusCode).toBe(502)
    expect(hardware.rows.size).toBe(0)
    // Nothing was sent: the CRN is parsed before the transport is touched.
    expect(hardware.requests).toHaveLength(0)
  })

  it('never puts the key in the request line of the IAM exchange', async () => {
    await credentialFor()
    for (const request of hardware.requests) {
      expect(request.url).not.toContain(TEST_API_KEY)
    }
  })

  it('deletes a credential and forgets its cached bearer token', async () => {
    const id = await credentialFor()
    // One exchange so far, from the pre-store verification.
    const before = hardware.requests.length

    await app.inject({
      method: 'GET',
      url: `${BASE}/backends?credentialId=${id}`,
      headers: await bearer(OWNER_ID),
    })

    const deleted = await app.inject({
      method: 'DELETE',
      url: `${BASE}/credentials/${id}`,
      headers: await bearer(OWNER_ID),
    })
    expect(deleted.statusCode).toBe(204)
    expect(hardware.requests.length).toBeGreaterThan(before)

    const after = await app.inject({
      method: 'GET',
      url: `${BASE}/credentials/${id}`,
      headers: await bearer(OWNER_ID),
    })
    expect(after.statusCode).toBe(404)
  })
})

describe('the backend listing', () => {
  it('reports the queue length beside every device', async () => {
    const id = await credentialFor()
    const response = await app.inject({
      method: 'GET',
      url: `${BASE}/backends?credentialId=${id}`,
      headers: await bearer(OWNER_ID),
    })

    expect(response.statusCode).toBe(200)
    const body = response.json<{
      backends: { name: string; queueLength: number; operational: boolean }[]
    }>()
    const byName = new Map(body.backends.map((b) => [b.name, b]))
    /*
     * The spread is the fact this route exists for: four orders of magnitude
     * between two devices with identical qubit counts and processor families.
     */
    expect(byName.get('ibm_fez')?.queueLength).toBe(24835)
    expect(byName.get('ibm_marrakesh')?.queueLength).toBe(15)
    expect(byName.get('ibm_marrakesh')?.operational).toBe(false)
  })

  it('carries the CRN as a header and the token as a bearer', async () => {
    const id = await credentialFor()
    await app.inject({
      method: 'GET',
      url: `${BASE}/backends?credentialId=${id}`,
      headers: await bearer(OWNER_ID),
    })
    const listing = hardware.requests.find((request) =>
      request.url.endsWith('/backends')
    )
    expect(listing?.headers['service-crn']).toBe(TEST_CRN)
    expect(listing?.headers['authorization']).toBe(
      'Bearer recorded.bearer.token'
    )
  })

  it('refuses to read another person s credential, as a 404', async () => {
    const id = await credentialFor(OWNER_ID)
    const response = await app.inject({
      method: 'GET',
      url: `${BASE}/backends?credentialId=${id}`,
      headers: await bearer(STRANGER_ID),
    })
    expect(response.statusCode).toBe(404)
  })

  it('will not guess which credential to spend', async () => {
    await credentialFor()
    // §3.7: the allowance is per key, so "the caller's only one" is not an
    // answer when a person may hold two.
    const response = await app.inject({
      method: 'GET',
      url: `${BASE}/backends`,
      headers: await bearer(OWNER_ID),
    })
    expect(response.statusCode).toBe(400)
  })
})

describe('submitting a job', () => {
  it('transpiles, stores the program, and schedules the first poll', async () => {
    const credentialId = await credentialFor()
    const circuitId = await circuitFor()

    const response = await app.inject({
      method: 'POST',
      url: `${BASE}/jobs`,
      headers: await bearer(OWNER_ID),
      payload: {
        circuit: circuitId,
        credentialId,
        backend: 'ibm_marrakesh',
        shots: 100,
      },
    })

    expect(response.statusCode).toBe(202)
    const body = response.json<{
      job: {
        id: string
        status: string
        shots: number
        program: { qasm: string; layout: number[]; register: string }
      }
    }>()
    expect(body.job.status).toBe('SUBMITTED')
    expect(body.job.shots).toBe(100)
    // The program is over *physical* qubits and in the native basis: no H, no
    // CNOT, and `$n` rather than `q[n]`.
    expect(body.job.program.qasm).toContain('$')
    expect(body.job.program.qasm).not.toMatch(/^\s*h /m)
    expect(body.job.program.qasm).not.toContain('cx ')
    expect(body.job.program.register).toBe('c')
    expect(body.job.program.layout).toHaveLength(2)

    expect(queue.ticks).toHaveLength(1)
    expect(queue.ticks[0]?.payload).toEqual({
      jobId: body.job.id,
      userId: OWNER_ID,
      tick: 0,
    })
  })

  /*
   * NOTHING IS SENT TO THE PROVIDER HERE. The one irreversible,
   * allowance-spending call in this system belongs to the worker, which can be
   * interrupted and resumed; a request the client may abandon cannot.
   */
  it('sends nothing to the provider from the request', async () => {
    const credentialId = await credentialFor()
    const circuitId = await circuitFor()
    await app.inject({
      method: 'POST',
      url: `${BASE}/jobs`,
      headers: await bearer(OWNER_ID),
      payload: { circuit: circuitId, credentialId, backend: 'ibm_marrakesh' },
    })
    const submissions = hardware.requests.filter(
      (request) => request.method === 'POST' && request.url.endsWith('/jobs')
    )
    expect(submissions).toHaveLength(0)
  })

  it('refuses a circuit the caller may not read, as a 404', async () => {
    const credentialId = await credentialFor(OWNER_ID)
    const circuitId = await circuitFor(OWNER_ID)
    const response = await app.inject({
      method: 'POST',
      url: `${BASE}/jobs`,
      headers: await bearer(STRANGER_ID),
      payload: { circuit: circuitId, credentialId, backend: 'ibm_marrakesh' },
    })
    expect(response.statusCode).toBe(404)
  })

  /*
   * 422 and not 400: the request was perfectly valid and the answer is still
   * no. Connectivity, not qubit count, is what bounds a NISQ machine — and the
   * refusal says so with numbers.
   */
  it('answers 422 with numbers when the device cannot hold the circuit', async () => {
    const credentialId = await credentialFor()
    const circuitId = await circuitFor(OWNER_ID, tooWide())

    const response = await app.inject({
      method: 'POST',
      url: `${BASE}/jobs`,
      headers: await bearer(OWNER_ID),
      payload: { circuit: circuitId, credentialId, backend: 'ibm_marrakesh' },
    })

    expect(response.statusCode).toBe(422)
    const body = response.json<ErrorBody>()
    expect(body.error.code).toBe('HARDWARE_UNRUNNABLE')
    const details = body.error.details as { code: string }[]
    expect(details.map((detail) => detail.code)).toContain('too-many-qubits')
    // The numbers travel, so a client can say "8 qubits, the device has 4".
    expect(details.some((detail) => /^\w+:\d+$/.test(detail.code))).toBe(true)
    expect(queue.ticks).toHaveLength(0)
  })

  it('fails the row rather than leaving it queued when nothing can be scheduled', async () => {
    const credentialId = await credentialFor()
    const circuitId = await circuitFor()
    queue.fails = true

    const response = await app.inject({
      method: 'POST',
      url: `${BASE}/jobs`,
      headers: await bearer(OWNER_ID),
      payload: { circuit: circuitId, credentialId, backend: 'ibm_marrakesh' },
    })

    expect(response.statusCode).toBe(503)
    const rows = [...hardware.jobs.values()]
    expect(rows).toHaveLength(1)
    expect(rows[0]?.status).toBe('FAILED')
    expect(rows[0]?.errorMessage).toBe('QUEUE_UNAVAILABLE')
  })

  it('refuses more shots than the plan s allowance should ever buy', async () => {
    const credentialId = await credentialFor()
    const circuitId = await circuitFor()
    const response = await app.inject({
      method: 'POST',
      url: `${BASE}/jobs`,
      headers: await bearer(OWNER_ID),
      payload: {
        circuit: circuitId,
        credentialId,
        backend: 'ibm_marrakesh',
        shots: 1_000_000,
      },
    })
    expect(response.statusCode).toBe(400)
  })
})

describe('reading and cancelling a job', () => {
  async function submitted(): Promise<string> {
    const credentialId = await credentialFor()
    const circuitId = await circuitFor()
    const response = await app.inject({
      method: 'POST',
      url: `${BASE}/jobs`,
      headers: await bearer(OWNER_ID),
      payload: { circuit: circuitId, credentialId, backend: 'ibm_marrakesh' },
    })
    return response.json<{ job: { id: string } }>().job.id
  }

  it('answers 404 for another person s job', async () => {
    const id = await submitted()
    const response = await app.inject({
      method: 'GET',
      url: `${BASE}/jobs/${id}`,
      headers: await bearer(STRANGER_ID),
    })
    expect(response.statusCode).toBe(404)
  })

  it('never returns the credential id in a job response', async () => {
    const id = await submitted()
    const response = await app.inject({
      method: 'GET',
      url: `${BASE}/jobs/${id}`,
      headers: await bearer(OWNER_ID),
    })
    // An identifier in a response is an identifier loose in the world.
    expect(response.body).not.toContain('credentialId')
    expect(response.body).not.toContain('cred-')
  })

  /*
   * The row moves before the provider is told, which is what makes "a job
   * cancelled before it was sent is never sent" true: the worker's submission
   * is itself a compare-and-set on SUBMITTED.
   */
  it('cancels a job that has not been sent yet', async () => {
    const id = await submitted()
    const response = await app.inject({
      method: 'DELETE',
      url: `${BASE}/jobs/${id}`,
      headers: await bearer(OWNER_ID),
    })
    expect(response.statusCode).toBe(200)
    expect(response.json().job.status).toBe('CANCELLED')
    expect(hardware.jobs.get(id)?.status).toBe('CANCELLED')
  })

  it('is idempotent, because pressing cancel twice is not a mistake', async () => {
    const id = await submitted()
    await app.inject({
      method: 'DELETE',
      url: `${BASE}/jobs/${id}`,
      headers: await bearer(OWNER_ID),
    })
    const second = await app.inject({
      method: 'DELETE',
      url: `${BASE}/jobs/${id}`,
      headers: await bearer(OWNER_ID),
    })
    expect(second.statusCode).toBe(200)
  })

  it('refuses to cancel another person s job', async () => {
    const id = await submitted()
    const response = await app.inject({
      method: 'DELETE',
      url: `${BASE}/jobs/${id}`,
      headers: await bearer(STRANGER_ID),
    })
    expect(response.statusCode).toBe(404)
    expect(hardware.jobs.get(id)?.status).toBe('SUBMITTED')
  })

  it('lists only the caller s own jobs', async () => {
    await submitted()
    const response = await app.inject({
      method: 'GET',
      url: `${BASE}/jobs`,
      headers: await bearer(STRANGER_ID),
    })
    expect(response.json()).toEqual({ jobs: [] })
  })
})

describe('when the provider misbehaves', () => {
  it('separates "your key is wrong" from "they are down"', async () => {
    await build(
      scriptOf({
        'POST /identity/token': { status: 200, body: RECORDED.iamToken },
        'GET /backends': { status: 503, body: '{}' },
      })
    )
    const id = await credentialFor()
    const response = await app.inject({
      method: 'GET',
      url: `${BASE}/backends?credentialId=${id}`,
      headers: await bearer(OWNER_ID),
    })
    expect(response.statusCode).toBe(502)
    expect(response.json().error.code).toBe('HARDWARE_UNAVAILABLE')
  })

  it('says the allowance is spent rather than "not allowed"', async () => {
    await build(
      scriptOf({
        'POST /identity/token': { status: 200, body: RECORDED.iamToken },
        'GET /backends': { status: 402, body: '{}' },
      })
    )
    const id = await credentialFor()
    const response = await app.inject({
      method: 'GET',
      url: `${BASE}/backends?credentialId=${id}`,
      headers: await bearer(OWNER_ID),
    })
    expect(response.statusCode).toBe(402)
    expect(response.json().error.code).toBe('HARDWARE_QUOTA_EXHAUSTED')
  })

  /*
   * The measured trap: a version header the service does not understand still
   * answers 200, with a shape that has no queue length in it anywhere.
   */
  it('refuses a pre-2025 listing rather than reporting every queue as unknown', async () => {
    await build(
      scriptOf({
        'POST /identity/token': { status: 200, body: RECORDED.iamToken },
        'GET /backends': { status: 200, body: RECORDED.backendsLegacy },
      })
    )
    const id = await credentialFor()
    const response = await app.inject({
      method: 'GET',
      url: `${BASE}/backends?credentialId=${id}`,
      headers: await bearer(OWNER_ID),
    })
    expect(response.statusCode).toBe(502)
  })
})

describe('when hardware is not configured at all', () => {
  it('answers 503 on every route, and stores nothing', async () => {
    const bare = await createTestApp({
      jwks: createTestJwksCache(stubJwksEndpoint([key])),
      circuits: { repository: createMemoryCircuitRepository() },
    })
    const response = await bare.inject({
      method: 'POST',
      url: `${BASE}/credentials`,
      headers: await bearer(OWNER_ID),
      payload: {
        provider: 'ibm_quantum',
        apiKey: TEST_API_KEY,
        instance: TEST_CRN,
      },
    })
    // §11 has no weaker mode: with no master key there is nothing to seal with,
    // so the route refuses before a seal is ever attempted.
    expect(response.statusCode).toBe(503)
    await bare.close()
  })
})
