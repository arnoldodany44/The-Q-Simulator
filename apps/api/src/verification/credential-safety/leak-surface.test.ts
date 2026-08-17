/**
 * Independent verification — credential safety.
 *
 * Three secrets are handled by this API and every one of them has a natural
 * path into a string a person can read: the IBM Cloud API key a user brings,
 * the instance CRN that names their account, the IAM bearer token derived from
 * both — and, separately, this product's own `qsk_` API keys.
 *
 * The method here is deliberately not "assert the handler returns metadata".
 * Every secret is a distinctive sentinel string, the whole hardware lifecycle
 * and the whole key lifecycle are driven through the real router with the real
 * pino configuration writing to a buffer, and afterwards *every byte* the
 * process emitted — every response body, every header, every log line — is
 * searched for every sentinel. A leak through a route nobody thought to assert
 * on is caught by the same sweep as a leak through the one they did.
 */

import { API_PREFIX, API_KEY_ROUTES, HARDWARE_ROUTES } from '@qsim/contract'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { RECORDED, scriptOf } from '@qsim/ibm/testing'
import { buildLoggerOptions } from '../../logging.js'
import { createTestApp, testEnv } from '../../testing/app.js'
import { memoryApiKeys } from '../../testing/api-keys.js'
import { memoryHardware, memoryHardwareQueue } from '../../testing/hardware.js'
import { createMemoryCircuitRepository } from '../../testing/circuit-repository.js'
import {
  TEST_USER_ID,
  createSigningKey,
  createTestJwksCache,
  signToken,
  stubJwksEndpoint,
} from '../../testing/tokens.js'
import type { TestSigningKey } from '../../testing/tokens.js'

/* ───────────────────────────── the sentinels ─────────────────────────── */

/** An IBM Cloud API key is 44 characters. This one is 44 and unmistakable. */
const IBM_API_KEY = 'SENTINELibmCloudApiKey000000000000000000AAAA'
const IBM_CRN =
  'crn:v1:bluemix:public:quantum-computing:us-east:a/SENTINELaccount0000000000000000:SENTINEL-inst-0000-0000-000000000000::'
/** What IAM hands back. An hour of live credential, held in memory. */
const IAM_BEARER = 'SENTINELiamBearerToken.abcdefghijklmnop.qrstuvwxyz'

const SCRIPT = scriptOf({
  'POST /identity/token': {
    status: 200,
    body: JSON.stringify({
      access_token: IAM_BEARER,
      token_type: 'Bearer',
      expires_in: 3600,
    }),
  },
  'GET /backends': { status: 200, body: RECORDED.backends },
  'GET /configuration': { status: 200, body: RECORDED.configuration },
  'GET /properties': { status: 200, body: RECORDED.properties },
  'GET /status': { status: 200, body: RECORDED.backendStatus },
  'POST /jobs': { status: 200, body: JSON.stringify({ id: 'ibm-job-1' }) },
})

/* ─────────────────────────────── the harness ─────────────────────────── */

let emitted: string[] = []
let signingKey: TestSigningKey

beforeEach(async () => {
  emitted = []
  signingKey = await createSigningKey('key-1')
})

afterEach(() => {
  emitted = []
})

function captureLogger() {
  const env = testEnv()
  return {
    ...buildLoggerOptions(env),
    level: 'trace',
    stream: {
      write(chunk: string) {
        emitted.push(chunk)
      },
    },
  }
}

async function session(subject = TEST_USER_ID): Promise<string> {
  return `Bearer ${await signToken(signingKey, { subject })}`
}

async function harness() {
  const hardware = memoryHardware(SCRIPT)
  const apiKeys = memoryApiKeys()
  const circuits = createMemoryCircuitRepository()
  const app = await createTestApp({
    jwks: createTestJwksCache(stubJwksEndpoint([signingKey])),
    logger: captureLogger(),
    hardware: { port: hardware.port },
    hardwareQueue: { queue: memoryHardwareQueue() },
    apiKeys: { repository: apiKeys.repository, verifier: apiKeys.verifier },
    circuits: { repository: circuits },
  })
  return { app, hardware, apiKeys, circuits }
}

/** Everything the process said, as one searchable string. */
function transcript(responses: readonly { body: string; headers: unknown }[]) {
  return [
    ...emitted,
    ...responses.map(
      (response) => `${response.body}\n${JSON.stringify(response.headers)}`
    ),
  ].join('\n')
}

describe('the hardware credential never comes back out', () => {
  it('leaks no sentinel through any response, header or log line', async () => {
    const { app, hardware } = await harness()
    const auth = await session()
    const responses: { body: string; headers: unknown }[] = []
    function record<T extends { body: string; headers: unknown }>(r: T): T {
      responses.push({ body: r.body, headers: r.headers })
      return r
    }

    const created = record(
      await app.inject({
        method: 'POST',
        url: `${API_PREFIX}${HARDWARE_ROUTES.credentials}`,
        headers: { authorization: auth },
        payload: {
          provider: 'ibm_quantum',
          apiKey: IBM_API_KEY,
          instance: IBM_CRN,
          label: 'probe',
        },
      })
    )
    expect(created.statusCode).toBe(201)
    const credentialId = created.json<{ credential: { id: string } }>()
      .credential.id

    // Every read of the credential, from the owner's own session.
    record(
      await app.inject({
        method: 'GET',
        url: `${API_PREFIX}${HARDWARE_ROUTES.credentials}`,
        headers: { authorization: auth },
      })
    )
    record(
      await app.inject({
        method: 'GET',
        url: `${API_PREFIX}/hardware/credentials/${credentialId}`,
        headers: { authorization: auth },
      })
    )
    // The device listing, which is the call that actually uses the token.
    record(
      await app.inject({
        method: 'GET',
        url: `${API_PREFIX}${HARDWARE_ROUTES.backends}?credentialId=${credentialId}`,
        headers: { authorization: auth },
      })
    )
    // A job list and a job read.
    record(
      await app.inject({
        method: 'GET',
        url: `${API_PREFIX}${HARDWARE_ROUTES.jobs}`,
        headers: { authorization: auth },
      })
    )
    // A read of a credential that is not this caller's, and a bad id.
    record(
      await app.inject({
        method: 'GET',
        url: `${API_PREFIX}/hardware/credentials/does-not-exist`,
        headers: { authorization: auth },
      })
    )
    // Deleting it, which forgets the cached bearer token.
    record(
      await app.inject({
        method: 'DELETE',
        url: `${API_PREFIX}/hardware/credentials/${credentialId}`,
        headers: { authorization: auth },
      })
    )

    // The port really did talk to IBM with the token: otherwise this whole
    // test would be asserting that nothing happened.
    const authHeaders = hardware.requests
      .map((request) => request.headers['authorization'])
      .filter((value): value is string => value !== undefined)
    expect(authHeaders.some((value) => value.includes(IAM_BEARER))).toBe(true)

    const text = transcript(responses)
    expect(text.includes(IBM_API_KEY), 'the IBM API key').toBe(false)
    expect(text.includes(IAM_BEARER), 'the derived IAM bearer token').toBe(
      false
    )
    expect(text.includes(IBM_CRN), 'the instance CRN').toBe(false)
    expect(text.includes('SENTINEL'), 'any sentinel fragment').toBe(false)

    await app.close()
  })

  it('leaks no sentinel when the provider refuses the key', async () => {
    const refusing = scriptOf({
      'POST /identity/token': { status: 400, body: RECORDED.iamBadKey },
    })
    const hardware = memoryHardware(refusing)
    const app = await createTestApp({
      jwks: createTestJwksCache(stubJwksEndpoint([signingKey])),
      logger: captureLogger(),
      hardware: { port: hardware.port },
    })
    const auth = await session()

    const refused = await app.inject({
      method: 'POST',
      url: `${API_PREFIX}${HARDWARE_ROUTES.credentials}`,
      headers: { authorization: auth },
      payload: {
        provider: 'ibm_quantum',
        apiKey: IBM_API_KEY,
        instance: IBM_CRN,
      },
    })
    expect(refused.statusCode).toBe(502)

    // And the shape a mistyped key actually has: too short for the schema.
    const invalid = await app.inject({
      method: 'POST',
      url: `${API_PREFIX}${HARDWARE_ROUTES.credentials}`,
      headers: { authorization: auth },
      payload: { provider: 'ibm_quantum', apiKey: 'SENTINELx', instance: 'x' },
    })
    expect(invalid.statusCode).toBe(400)

    const text = transcript([
      { body: refused.body, headers: refused.headers },
      { body: invalid.body, headers: invalid.headers },
    ])
    expect(text.includes(IBM_API_KEY), 'the key, on a refusal').toBe(false)
    expect(text.includes(IBM_CRN), 'the CRN, on a refusal').toBe(false)
    expect(text.includes('SENTINEL'), 'any sentinel fragment').toBe(false)

    await app.close()
  })
})

describe('this product’s own API keys', () => {
  it('shows the secret exactly once and never again', async () => {
    const { app } = await harness()
    const auth = await session()

    const minted = await app.inject({
      method: 'POST',
      url: `${API_PREFIX}${API_KEY_ROUTES.collection}`,
      headers: { authorization: auth },
      payload: { name: 'probe', scopes: ['read'] },
    })
    expect(minted.statusCode).toBe(201)
    const key = minted.json<{ key: string }>().key
    expect(key.startsWith('qsk_')).toBe(true)

    const listed = await app.inject({
      method: 'GET',
      url: `${API_PREFIX}${API_KEY_ROUTES.collection}`,
      headers: { authorization: auth },
    })
    expect(listed.body.includes(key)).toBe(false)
    // The hint is the first ten characters and nothing more.
    expect(listed.body.includes(key.slice(0, 10))).toBe(true)
    expect(listed.body.includes(key.slice(0, 11))).toBe(false)

    // The log of the very request that minted it must not carry it.
    expect(emitted.join('\n').includes(key)).toBe(false)

    await app.close()
  })

  it('stops authenticating on the very next request after revocation', async () => {
    const { app, apiKeys } = await harness()
    const issued = apiKeys.issue({ userId: TEST_USER_ID, scopes: ['read'] })

    const before = await app.inject({
      method: 'GET',
      url: `${API_PREFIX}/circuits`,
      headers: { authorization: `Bearer ${issued.key}` },
    })
    expect(before.statusCode).toBe(200)

    const revoked = await app.inject({
      method: 'DELETE',
      url: `${API_PREFIX}/api-keys/${issued.id}`,
      headers: { authorization: await session() },
    })
    expect(revoked.statusCode).toBe(200)

    const after = await app.inject({
      method: 'GET',
      url: `${API_PREFIX}/circuits`,
      headers: { authorization: `Bearer ${issued.key}` },
    })
    expect(after.statusCode).toBe(401)
    // Unknown and revoked must be the same answer.
    const unknown = await app.inject({
      method: 'GET',
      url: `${API_PREFIX}/circuits`,
      headers: { authorization: `Bearer qsk_${'A'.repeat(43)}` },
    })
    expect(unknown.statusCode).toBe(401)
    const codeOf = (raw: string) =>
      (JSON.parse(raw) as { error: { code: string; message: string } }).error
    expect(codeOf(after.body).code).toBe(codeOf(unknown.body).code)
    expect(codeOf(after.body).message).toBe(codeOf(unknown.body).message)

    await app.close()
  })

  it('cannot reach key management or hardware, however it is scoped', async () => {
    const { app, apiKeys } = await harness()
    const every = apiKeys.issue({
      userId: TEST_USER_ID,
      scopes: ['read', 'write', 'simulate'],
    })
    const headers = { authorization: `Bearer ${every.key}` }

    for (const url of [
      `${API_PREFIX}/api-keys`,
      `${API_PREFIX}/hardware/credentials`,
      `${API_PREFIX}/hardware/jobs`,
      `${API_PREFIX}/hardware/backends?credentialId=x`,
    ]) {
      const response = await app.inject({ method: 'GET', url, headers })
      expect(response.statusCode, url).toBe(403)
      expect(response.json<{ error: { code: string } }>().error.code).toBe(
        'API_KEY_NOT_ACCEPTED'
      )
    }

    await app.close()
  })

  it('is refused on a route whose scope it does not carry', async () => {
    const { app, apiKeys } = await harness()
    const readOnly = apiKeys.issue({ userId: TEST_USER_ID, scopes: ['read'] })

    const write = await app.inject({
      method: 'POST',
      url: `${API_PREFIX}/circuits`,
      headers: { authorization: `Bearer ${readOnly.key}` },
      payload: {
        title: 'should not be written',
        visibility: 'PRIVATE',
        circuit: {
          schemaVersion: 1,
          qubits: 1,
          clbits: 0,
          operations: [{ id: 'g1', gate: 'h', targets: [0], column: 0 }],
        },
      },
    })
    expect(write.statusCode).toBe(403)
    expect(write.json<{ error: { code: string } }>().error.code).toBe(
      'API_KEY_SCOPE_REQUIRED'
    )

    // And the surface the router recorded names no hardware and no key route.
    for (const entry of app.apiKeySurface) {
      expect(entry.url.startsWith(`${API_PREFIX}/hardware`)).toBe(false)
      expect(entry.url.startsWith(`${API_PREFIX}/api-keys`)).toBe(false)
    }

    await app.close()
  })

  it('sees exactly what its user sees and nothing more', async () => {
    const { app, apiKeys, circuits } = await harness()
    const OTHER = '9a1d0f2c-1111-4c3d-9c17-2a4a3f1b5f21'

    const circuitOf = (ownerId: string, title: string) =>
      circuits.create({
        ownerId,
        title,
        description: null,
        visibility: 'PRIVATE',
        data: {
          schemaVersion: 1,
          qubits: 1,
          clbits: 0,
          operations: [{ id: 'g1', gate: 'h', targets: [0], column: 0 }],
        },
        message: null,
        forkedFromId: null,
        tags: [],
      })

    // A private circuit belonging to somebody else.
    const other = await circuitOf(OTHER, 'somebody else’s private work')

    const key = apiKeys.issue({ userId: TEST_USER_ID, scopes: ['read'] })
    const headers = { authorization: `Bearer ${key.key}` }

    for (const handle of [other.circuit.id, other.circuit.slug]) {
      const response = await app.inject({
        method: 'GET',
        url: `${API_PREFIX}/circuits/${handle}`,
        headers,
      })
      expect(response.statusCode, handle).toBe(404)
    }

    // And the same key sees its own owner's private circuit.
    const mine = await circuitOf(TEST_USER_ID, 'mine')
    const readable = await app.inject({
      method: 'GET',
      url: `${API_PREFIX}/circuits/${mine.circuit.id}`,
      headers,
    })
    expect(readable.statusCode).toBe(200)

    await app.close()
  })
})
