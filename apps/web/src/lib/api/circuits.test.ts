import { API_PREFIX } from '@qsim/contract'
import { emptyCircuit } from '@qsim/schema'
import { describe, expect, it } from 'vitest'

import { createApiClient } from './client.js'
import {
  createCircuit,
  createVersion,
  deleteCircuit,
  forkCircuit,
  getCircuit,
  getVersion,
  listCircuits,
  listVersions,
  updateCircuit,
} from './circuits.js'
import type { ApiRequestError } from './errors.js'
import {
  TEST_BASE_URL,
  circuitDetailPayload,
  circuitViewPayload,
  circuitWithVersionPayload,
  errorResponse,
  jsonResponse,
  stubFetch,
  versionPayload,
} from './testing.js'

/**
 * One test per route, asserting the two things a typed call can get wrong:
 * the verb-and-path it produces, and that what comes back is parsed rather
 * than passed through. The shapes themselves are the contract package's
 * problem, and it asserts them against the server's own instantiation.
 */

function harness(responses: readonly unknown[]) {
  const transport = stubFetch(responses)
  const client = createApiClient({
    baseUrl: TEST_BASE_URL,
    fetch: transport.fetch,
    getAccessToken: () => 'token',
  })
  return { client, transport }
}

const url = (path: string) => `${TEST_BASE_URL}${API_PREFIX}${path}`

const page = <T>(items: T[]) => ({
  items,
  page: 1,
  perPage: 20,
  total: items.length,
  totalPages: 1,
})

describe('circuit routes', () => {
  it('GET /circuits, with pagination in the query string', async () => {
    const { client, transport } = harness([
      jsonResponse(page([circuitDetailPayload])),
    ])

    const result = await listCircuits(client, { page: 2, perPage: 5 })

    expect(transport.last().init?.method).toBe('GET')
    expect(transport.last().url).toBe(url('/circuits?page=2&perPage=5'))
    expect(result.items[0]?.createdAt).toBeInstanceOf(Date)
  })

  it('POST /circuits', async () => {
    const { client, transport } = harness([
      jsonResponse(circuitWithVersionPayload, 201),
    ])

    const result = await createCircuit(client, {
      title: 'Bell pair',
      circuit: emptyCircuit(2),
    })

    expect(transport.last().init?.method).toBe('POST')
    expect(transport.last().url).toBe(url('/circuits'))
    expect(transport.lastBody()).toEqual({
      title: 'Bell pair',
      circuit: emptyCircuit(2),
    })
    expect(result.circuit.slug).toBe(circuitDetailPayload.slug)
  })

  it('GET /circuits/:id, by slug or by id alike', async () => {
    const { client, transport } = harness([jsonResponse(circuitViewPayload)])

    await getCircuit(client, circuitDetailPayload.slug)

    expect(transport.last().url).toBe(
      url(`/circuits/${circuitDetailPayload.slug}`)
    )
  })

  it('PATCH /circuits/:id, and keeps the envelope', async () => {
    const { client, transport } = harness([
      jsonResponse({ circuit: circuitDetailPayload }),
    ])

    const result = await updateCircuit(client, 'abc', { title: 'Renamed' })

    expect(transport.last().init?.method).toBe('PATCH')
    expect(transport.lastBody()).toEqual({ title: 'Renamed' })
    // Not unwrapped: whatever the API adds beside `circuit` later still
    // arrives instead of being silently dropped here.
    expect(result).toHaveProperty('circuit')
  })

  it('DELETE /circuits/:id, expecting no body', async () => {
    const { client, transport } = harness([new Response(null, { status: 204 })])

    await expect(deleteCircuit(client, 'abc')).resolves.toBeUndefined()
    expect(transport.last().init?.method).toBe('DELETE')
  })

  it('POST /circuits/:id/fork sends no body when there is no title', async () => {
    const { client, transport } = harness([
      jsonResponse(circuitWithVersionPayload, 201),
    ])

    await forkCircuit(client, 'abc')

    expect(transport.last().url).toBe(url('/circuits/abc/fork'))
    // The route's body schema is `.nullable()` for exactly this: Fastify
    // hands the validator `null` for an absent body.
    expect(transport.last().init?.body).toBeUndefined()
  })

  it('POST /circuits/:id/fork sends the title when there is one', async () => {
    const { client, transport } = harness([
      jsonResponse(circuitWithVersionPayload, 201),
    ])

    await forkCircuit(client, 'abc', { title: 'My copy' })

    expect(transport.lastBody()).toEqual({ title: 'My copy' })
  })

  it('GET /circuits/:id/versions', async () => {
    const { client, transport } = harness([
      jsonResponse(page([versionPayload])),
    ])

    const result = await listVersions(client, 'abc', { page: 3 })

    expect(transport.last().url).toBe(url('/circuits/abc/versions?page=3'))
    expect(result.items[0]?.versionNum).toBe(1)
  })

  it('POST /circuits/:id/versions', async () => {
    const { client, transport } = harness([
      jsonResponse({ version: versionPayload }, 201),
    ])

    await createVersion(client, 'abc', {
      circuit: emptyCircuit(2),
      message: 'Add a Hadamard',
    })

    expect(transport.last().init?.method).toBe('POST')
    expect(transport.last().url).toBe(url('/circuits/abc/versions'))
    expect(transport.lastBody()).toMatchObject({ message: 'Add a Hadamard' })
  })

  it('GET /circuits/:id/versions/:n', async () => {
    const { client, transport } = harness([
      jsonResponse({ version: versionPayload }),
    ])

    const result = await getVersion(client, 'abc', 7)

    expect(transport.last().url).toBe(url('/circuits/abc/versions/7'))
    expect(result.version.circuit.qubits).toBe(2)
  })

  it('encodes a handle that would otherwise change the path', async () => {
    const { client, transport } = harness([jsonResponse(circuitViewPayload)])

    await getCircuit(client, 'a/../b')

    // The API rejects this handle anyway; the point is that the client cannot
    // be talked into requesting a different route than it thinks it is.
    expect(transport.last().url).toBe(url('/circuits/a%2F..%2Fb'))
  })

  /*
   * §11 conflates "no such circuit" with "exists and is not yours", so the
   * client sees a 404 for a stranger's PRIVATE circuit. There is nothing to
   * do about that and nothing to work around — this asserts the client does
   * not try to.
   */
  it("reports a stranger's private circuit as simply not found", async () => {
    const { client } = harness([errorResponse('NOT_FOUND', 404)])

    const error = (await getCircuit(client, 'somebody-elses').catch(
      (thrown: unknown) => thrown
    )) as ApiRequestError

    expect(error.status).toBe(404)
    expect(error.code).toBe('NOT_FOUND')
  })
})
