import { countsFromSamples } from '@qsim/transpile'
import { describe, expect, it, vi } from 'vitest'
import { IBM_API_VERSION, createIbmClient } from './client.js'
import { createTokenCache } from './iam.js'
import { PUB_VERSION, SAMPLER_PROGRAM_ID } from './jobs.js'
import {
  RECORDED,
  TEST_CRN,
  TEST_CRN_EU,
  recordedTransport,
  resultsOf,
  scriptOf,
} from './testing/transport.js'
import type { Script } from './testing/transport.js'
import type { HttpTransport } from './transport.js'

const AUTH = {
  'POST /identity/token': { status: 200, body: RECORDED.iamToken },
}

function clientOn(script: Script, crn = TEST_CRN) {
  const recorder = recordedTransport(script)
  const tokens = createTokenCache({ transport: recorder.transport })
  const apiKey = vi.fn(() => Promise.resolve('a-real-looking-key'))
  const client = createIbmClient({
    crn,
    credentialId: 'cred-1',
    apiKey,
    transport: recorder.transport,
    tokens,
  })
  return { client, recorder, apiKey, tokens }
}

describe('the three headers', () => {
  it('carries the bearer token, the CRN and a pinned API version', async () => {
    const { client, recorder } = clientOn(
      scriptOf({
        ...AUTH,
        'GET /backends': { status: 200, body: RECORDED.backends },
      })
    )
    await client.backends()

    const request = recorder.last()
    expect(request.headers['authorization']).toBe(
      'Bearer recorded.bearer.token'
    )
    expect(request.headers['service-crn']).toBe(TEST_CRN)
    expect(request.headers['ibm-api-version']).toBe(IBM_API_VERSION)
  })

  it('sends the token and never the API key', async () => {
    const { client, recorder } = clientOn(
      scriptOf({
        ...AUTH,
        'GET /backends': { status: 200, body: RECORDED.backends },
      })
    )
    await client.backends()
    const serialised = JSON.stringify(recorder.last())
    expect(serialised).not.toContain('a-real-looking-key')
  })

  it('addresses a eu-de instance at its own host', async () => {
    const { client, recorder } = clientOn(
      scriptOf({
        ...AUTH,
        'GET /backends': { status: 200, body: RECORDED.backends },
      }),
      TEST_CRN_EU
    )
    await client.backends()
    expect(recorder.last().url).toBe(
      'https://eu-de.quantum.cloud.ibm.com/api/v1/backends'
    )
  })
})

describe('backends', () => {
  it('reports the queue length beside every device', async () => {
    const { client } = clientOn(
      scriptOf({
        ...AUTH,
        'GET /backends': { status: 200, body: RECORDED.backends },
      })
    )
    const devices = await client.backends()
    const byName = new Map(devices.map((device) => [device.name, device]))
    expect(byName.get('ibm_fez')?.queueLength).toBe(24835)
    expect(byName.get('ibm_marrakesh')?.queueLength).toBe(15)
    expect(byName.get('ibm_kingston')?.queueLength).toBe(121)
  })

  it('puts an operational device with a long queue above a paused empty one', async () => {
    const { client } = clientOn(
      scriptOf({
        ...AUTH,
        'GET /backends': { status: 200, body: RECORDED.backends },
      })
    )
    const devices = await client.backends()
    // ibm_marrakesh has 15 waiting and is paused for maintenance; a job sent
    // there does not start, so it must not rank first on queue length alone.
    expect(devices[0]?.name).toBe('ibm_kingston')
    expect(devices.at(-1)?.name).toBe('ibm_marrakesh')
  })

  /*
   * THE MEASURED TRAP. A version header the service does not understand still
   * answers 200, with a list of strings and no queue length anywhere.
   */
  it('refuses the pre-2025 shape instead of reporting every queue as unknown', async () => {
    const { client } = clientOn(
      scriptOf({
        ...AUTH,
        'GET /backends': { status: 200, body: RECORDED.backendsLegacy },
      })
    )
    await expect(client.backends()).rejects.toMatchObject({
      code: 'IBM_MALFORMED_RESPONSE',
    })
  })

  it('classifies a 401 as a credential failure after one retry', async () => {
    const { client, recorder, tokens } = clientOn(
      scriptOf({
        ...AUTH,
        'GET /backends': { status: 401, body: RECORDED.badToken },
      })
    )
    await expect(client.backends()).rejects.toMatchObject({
      code: 'IBM_CREDENTIAL_INVALID',
    })
    // Two attempts at the listing, with a fresh exchange between them.
    expect(recorder.countOf('/backends')).toBe(2)
    expect(recorder.countOf('/identity/token')).toBe(2)
    expect(tokens.size()).toBe(1)
  })

  it('retries a stale token exactly once and then succeeds', async () => {
    let served = 0
    const recorder = recordedTransport((request) => {
      if (request.url.endsWith('/identity/token')) {
        return { status: 200, body: RECORDED.iamToken }
      }
      served += 1
      return served === 1
        ? { status: 401, body: RECORDED.badToken }
        : { status: 200, body: RECORDED.backends }
    })
    const client = createIbmClient({
      crn: TEST_CRN,
      credentialId: 'cred-1',
      apiKey: () => Promise.resolve('k'),
      transport: recorder.transport,
      tokens: createTokenCache({ transport: recorder.transport }),
    })
    await expect(client.backends()).resolves.toHaveLength(3)
  })

  it('reports a 429 as retryable and honours Retry-After', async () => {
    const { client } = clientOn(
      scriptOf({
        ...AUTH,
        'GET /backends': {
          status: 429,
          body: '{}',
          headers: { 'retry-after': '42' },
        },
      })
    )
    await expect(client.backends()).rejects.toMatchObject({
      code: 'IBM_RATE_LIMITED',
      retryAfterSeconds: 42,
      retryable: true,
    })
  })

  it('separates "out of QPU seconds" from "not allowed"', async () => {
    const { client } = clientOn(
      scriptOf({ ...AUTH, 'GET /backends': { status: 402, body: '{}' } })
    )
    await expect(client.backends()).rejects.toMatchObject({
      code: 'IBM_QUOTA_EXHAUSTED',
    })
  })
})

describe('deviceTarget', () => {
  const script = scriptOf({
    ...AUTH,
    'GET /configuration': { status: 200, body: RECORDED.configuration },
    'GET /properties': { status: 200, body: RECORDED.properties },
    'GET /status': { status: 200, body: RECORDED.backendStatus },
  })

  it('composes a target the transpiler can place on', async () => {
    const { client } = clientOn(script)
    const target = await client.deviceTarget('ibm_marrakesh')

    expect(target.name).toBe('ibm_marrakesh')
    expect(target.qubits).toBe(4)
    // The native set: no H, no CNOT. The reason the transpiler exists.
    expect(target.basisGates).toEqual([
      'cz',
      'id',
      'rx',
      'rz',
      'rzz',
      'sx',
      'x',
    ])
    // Six directed pairs collapse to three undirected edges.
    expect(target.coupling).toHaveLength(3)
    expect(target.calibratedAt).toBe('2026-08-14T12:44:02Z')
    expect(target.queueLength).toBe(15)
  })

  it('still answers a target when the calibration cannot be read', async () => {
    const { client } = clientOn(
      scriptOf({
        ...AUTH,
        'GET /configuration': { status: 200, body: RECORDED.configuration },
        'GET /properties': { status: 503, body: '{}' },
        'GET /status': { status: 200, body: RECORDED.backendStatus },
      })
    )
    const target = await client.deviceTarget('ibm_marrakesh')
    expect(target.qubits).toBe(4)
    // No invented zeros: the pairs carry no error rather than a perfect one.
    expect(target.coupling.every((pair) => pair.error === undefined)).toBe(true)
    expect(target.qubitProperties).toBeUndefined()
  })
})

describe('submitJob', () => {
  it('sends the pub the live service records, with the shots spelled out', async () => {
    const { client, recorder } = clientOn(
      scriptOf({
        ...AUTH,
        'POST /jobs': { status: 200, body: JSON.stringify({ id: 'abc123' }) },
      })
    )

    const id = await client.submitJob({
      backend: 'ibm_marrakesh',
      qasm: 'OPENQASM 3.0;\nbit[2] c;\nx $154;\n',
      shots: 500,
    })

    expect(id).toBe('abc123')
    const body: unknown = JSON.parse(recorder.last().body ?? '')
    expect(body).toEqual({
      program_id: SAMPLER_PROGRAM_ID,
      backend: 'ibm_marrakesh',
      params: {
        pubs: [['OPENQASM 3.0;\nbit[2] c;\nx $154;\n', null, 500]],
        version: PUB_VERSION,
        // `true` would bring the results home as a pickled Qiskit object.
        support_qiskit: false,
      },
    })
  })
})

describe('readJob', () => {
  it('maps IBM statuses onto this system s vocabulary', async () => {
    for (const [body, expected] of [
      [RECORDED.jobQueued, 'QUEUED'],
      [RECORDED.jobRunning, 'RUNNING'],
      [RECORDED.jobCompleted, 'DONE'],
      [RECORDED.jobFailed, 'FAILED'],
    ] as const) {
      const { client } = clientOn(
        scriptOf({
          ...AUTH,
          'GET /jobs/da16cgu3kjvs7386btng': { status: 200, body },
        })
      )
      const reading = await client.readJob('da16cgu3kjvs7386btng')
      expect(reading.status).toBe(expected)
    }
  })

  it('reports no queue position, because the job document carries none', async () => {
    const { client } = clientOn(
      scriptOf({
        ...AUTH,
        'GET /jobs/da16cgu3kjvs7386btng': {
          status: 200,
          body: RECORDED.jobQueued,
        },
      })
    )
    expect(
      (await client.readJob('da16cgu3kjvs7386btng')).queuePosition
    ).toBeNull()
  })

  it('names a job the service has never heard of', async () => {
    const { client } = clientOn(
      scriptOf({
        ...AUTH,
        'GET /jobs/nope': { status: 404, body: RECORDED.jobNotFound },
      })
    )
    await expect(client.readJob('nope')).rejects.toMatchObject({
      code: 'IBM_NOT_FOUND',
    })
  })
})

describe('readResults', () => {
  /* Measured: a results read on a queued job answers 400 with code 1234. */
  it('treats the 400/1234 answer as "not yet" rather than a failure', async () => {
    const { client } = clientOn(
      scriptOf({
        ...AUTH,
        'GET /results': { status: 400, body: RECORDED.resultsNotReady },
      })
    )
    await expect(client.readResults('job-1', 'c')).resolves.toBeNull()
  })

  it('treats the documented 204 the same way', async () => {
    const { client } = clientOn(
      scriptOf({ ...AUTH, 'GET /results': { status: 204 } })
    )
    await expect(client.readResults('job-1', 'c')).resolves.toBeNull()
  })

  it('hands back the hexadecimal samples untouched', async () => {
    const { client } = clientOn(
      scriptOf({
        ...AUTH,
        'GET /results': {
          status: 200,
          body: resultsOf(['0x1', '0x1', '0x0']),
        },
      })
    )
    const reading = await client.readResults('job-1', 'c')
    expect(reading?.samples).toEqual(['0x1', '0x1', '0x0'])
    expect(reading?.numBits).toBe(2)
  })

  /*
   * The whole path, end to end, on an ASYMMETRIC distribution. `0x1` is
   * c[0]=1, c[1]=0 — which reads as "01" highest bit first. A conversion that
   * reversed the register would answer "10" and a Bell pair could not tell.
   */
  it('converts to counts the engine can be compared against', async () => {
    const { client } = clientOn(
      scriptOf({
        ...AUTH,
        'GET /results': {
          status: 200,
          body: resultsOf(['0x1', '0x1', '0x1', '0x0']),
        },
      })
    )
    const reading = await client.readResults('job-1', 'c')
    expect(countsFromSamples(reading?.samples ?? [], 2)).toEqual({
      '01': 3,
      '00': 1,
    })
  })

  it('refuses a document whose register it was not asked for', async () => {
    const { client } = clientOn(
      scriptOf({
        ...AUTH,
        'GET /results': { status: 200, body: resultsOf(['0x1'], 'meas') },
      })
    )
    await expect(client.readResults('job-1', 'c')).rejects.toThrow(/meas/)
  })
})

describe('cancelJob', () => {
  it('treats a job the service has already reaped as cancelled', async () => {
    const { client } = clientOn(
      scriptOf({
        ...AUTH,
        'POST /cancel': { status: 404, body: RECORDED.jobNotFound },
      })
    )
    await expect(client.cancelJob('job-1')).resolves.toBeUndefined()
  })

  it('reports a refusal that is not a 404', async () => {
    const { client } = clientOn(
      scriptOf({ ...AUTH, 'POST /cancel': { status: 409, body: '{}' } })
    )
    await expect(client.cancelJob('job-1')).rejects.toMatchObject({
      code: 'IBM_REFUSED',
    })
  })
})

describe('the transport contract', () => {
  it('turns a network failure into a retryable unavailability', async () => {
    const failing: HttpTransport = () => Promise.reject(new Error('ECONNRESET'))
    const client = createIbmClient({
      crn: TEST_CRN,
      credentialId: 'cred-1',
      apiKey: () => Promise.resolve('k'),
      transport: failing,
      tokens: createTokenCache({ transport: failing }),
    })
    await expect(client.backends()).rejects.toThrow('ECONNRESET')
  })
})
