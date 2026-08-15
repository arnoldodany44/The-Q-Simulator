import { API_PREFIX, wireCircuitResponses } from '@qsim/contract'
import { describe, expect, it, vi } from 'vitest'

import { createApiClient } from './client.js'
import type { ResponseSchema } from './client.js'
import {
  ApiRequestError,
  isForbidden,
  requiresAuthentication,
} from './errors.js'
import {
  TEST_BASE_URL,
  circuitWithVersionPayload,
  errorResponse,
  jsonResponse,
  stubFetch,
} from './testing.js'

/** Accepts anything and returns it — for asserting transport, not shapes. */
const passthrough: ResponseSchema<unknown> = {
  safeParse: (value) => ({ success: true, data: value }),
}

function clientOver(
  responses: (Response | Error)[],
  options: Parameters<typeof createApiClient>[0] = {}
) {
  const transport = stubFetch(responses)
  const client = createApiClient({
    baseUrl: TEST_BASE_URL,
    fetch: transport.fetch,
    ...options,
  })
  return { client, transport }
}

describe('request shape', () => {
  it('builds the URL from the base, the contract prefix and the path', async () => {
    const { client, transport } = clientOver([jsonResponse({ ok: true })])

    await client.request({
      method: 'GET',
      path: '/circuits/abc',
      schema: passthrough,
    })

    expect(transport.last().url).toBe(
      `${TEST_BASE_URL}${API_PREFIX}/circuits/abc`
    )
    expect(transport.last().init?.method).toBe('GET')
  })

  it('sends a JSON body with a content type, and nothing without one', async () => {
    const { client, transport } = clientOver([
      jsonResponse({}),
      jsonResponse({}),
    ])

    await client.request({
      method: 'POST',
      path: '/circuits',
      body: { title: 'Bell pair' },
      schema: passthrough,
    })
    expect(transport.lastBody()).toEqual({ title: 'Bell pair' })
    expect(transport.lastHeaders()['content-type']).toBe('application/json')

    await client.request({
      method: 'GET',
      path: '/circuits',
      schema: passthrough,
    })
    // A GET with a content type is a request some proxies and some CORS
    // preflights treat differently. It is set only when there is a body.
    expect(transport.lastHeaders()['content-type']).toBeUndefined()
    expect(transport.last().init?.body).toBeUndefined()
  })

  it('renders a query string and omits parameters that were not given', async () => {
    const { client, transport } = clientOver([jsonResponse({})])

    await client.request({
      method: 'GET',
      path: '/circuits',
      query: { page: 2, perPage: undefined },
      schema: passthrough,
    })

    // `perPage=undefined` reaching the server would be a 400 from a value
    // nobody typed.
    expect(transport.last().url).toBe(
      `${TEST_BASE_URL}${API_PREFIX}/circuits?page=2`
    )
  })

  it('passes the abort signal through', async () => {
    const { client, transport } = clientOver([jsonResponse({})])
    const controller = new AbortController()

    await client.request({
      method: 'GET',
      path: '/circuits',
      schema: passthrough,
      signal: controller.signal,
    })

    expect(transport.last().init?.signal).toBe(controller.signal)
  })
})

describe('token attachment', () => {
  it('sends a bearer token when the session has one', async () => {
    const { client, transport } = clientOver([jsonResponse({})], {
      getAccessToken: () => 'header.payload.signature',
    })

    await client.request({
      method: 'GET',
      path: '/circuits',
      schema: passthrough,
    })

    expect(transport.lastHeaders().authorization).toBe(
      'Bearer header.payload.signature'
    )
  })

  it('awaits an async provider, which is what reading a session costs', async () => {
    const { client, transport } = clientOver([jsonResponse({})], {
      getAccessToken: () => Promise.resolve('refreshed-token'),
    })

    await client.request({
      method: 'GET',
      path: '/circuits',
      schema: passthrough,
    })

    expect(transport.lastHeaders().authorization).toBe('Bearer refreshed-token')
  })

  it('sends no Authorization header at all when there is no session', async () => {
    const { client, transport } = clientOver([jsonResponse({})], {
      getAccessToken: () => null,
    })

    await client.request({
      method: 'GET',
      path: '/circuits',
      schema: passthrough,
    })

    /*
     * Not an empty string and not `Bearer null`: the API's auth hook treats
     * *any* Authorization header as a claim to verify, so a malformed one
     * turns an anonymous read of a PUBLIC circuit into a 401.
     */
    expect(transport.lastHeaders().authorization).toBeUndefined()
    expect(transport.lastHeaders().accept).toBe('application/json')
  })

  it('asks the provider once per request, so an expiry mid-session is picked up', async () => {
    const tokens = ['first-token', 'second-token']
    const getAccessToken = vi.fn(() => tokens.shift() ?? null)
    const { client, transport } = clientOver(
      [jsonResponse({}), jsonResponse({})],
      { getAccessToken }
    )

    await client.request({
      method: 'GET',
      path: '/circuits',
      schema: passthrough,
    })
    await client.request({
      method: 'GET',
      path: '/circuits',
      schema: passthrough,
    })

    expect(getAccessToken).toHaveBeenCalledTimes(2)
    expect(transport.calls).toHaveLength(2)
    expect(transport.lastHeaders().authorization).toBe('Bearer second-token')
  })

  it('fails loudly when the session cannot produce a token', async () => {
    const { client, transport } = clientOver([jsonResponse({})], {
      getAccessToken: () => {
        throw new Error('refresh failed')
      },
    })

    const error = await client
      .request({ method: 'GET', path: '/circuits', schema: passthrough })
      .catch((thrown: unknown) => thrown)

    // Downgrading to anonymous here would show a signed-in user the public
    // view and look exactly like a permissions bug.
    expect(error).toBeInstanceOf(ApiRequestError)
    expect((error as ApiRequestError).code).toBe('SESSION_UNAVAILABLE')
    expect(transport.calls).toHaveLength(0)
  })
})

describe('response parsing', () => {
  it('parses through the contract schema, ISO strings becoming Dates', async () => {
    const { client } = clientOver([jsonResponse(circuitWithVersionPayload)])

    const result = await client.request({
      method: 'GET',
      path: '/circuits/abc',
      schema: wireCircuitResponses.CircuitWithVersionResponse,
    })

    expect(result.circuit.title).toBe('Bell pair')
    expect(result.circuit.createdAt).toBeInstanceOf(Date)
    expect(result.circuit.createdAt.toISOString()).toBe(
      '2024-05-01T10:00:00.000Z'
    )
    expect(result.version.circuit.qubits).toBe(2)
  })

  it('rejects a 200 whose body is not what the contract promises', async () => {
    const broken = {
      ...circuitWithVersionPayload,
      circuit: { ...circuitWithVersionPayload.circuit, qubitCount: 'two' },
    }
    const { client } = clientOver([jsonResponse(broken)])

    const error = await client
      .request({
        method: 'GET',
        path: '/circuits/abc',
        schema: wireCircuitResponses.CircuitWithVersionResponse,
      })
      .catch((thrown: unknown) => thrown)

    expect(error).toBeInstanceOf(ApiRequestError)
    expect((error as ApiRequestError).code).toBe('RESPONSE_MALFORMED')
    expect((error as ApiRequestError).status).toBe(200)
  })

  it('reads no body from a route that promises none', async () => {
    const { client } = clientOver([new Response(null, { status: 204 })])

    await expect(
      client.request({ method: 'DELETE', path: '/circuits/abc', schema: null })
    ).resolves.toBeUndefined()
  })

  it('reports a body that is not JSON at all', async () => {
    const { client } = clientOver([
      new Response('<!doctype html><title>Not the API</title>', {
        status: 200,
      }),
    ])

    const error = await client
      .request({ method: 'GET', path: '/circuits', schema: passthrough })
      .catch((thrown: unknown) => thrown)

    expect((error as ApiRequestError).code).toBe('RESPONSE_MALFORMED')
  })
})

describe('error mapping', () => {
  it('carries the code, status, request id and details from the API', async () => {
    const { client } = clientOver([
      errorResponse('VALIDATION_FAILED', 400, {
        requestId: 'req-42',
        details: [{ path: 'body.title', code: 'too_small' }],
      }),
    ])

    const error = (await client
      .request({ method: 'POST', path: '/circuits', schema: passthrough })
      .catch((thrown: unknown) => thrown)) as ApiRequestError

    expect(error.code).toBe('VALIDATION_FAILED')
    expect(error.status).toBe(400)
    expect(error.requestId).toBe('req-42')
    expect(error.details).toEqual([{ path: 'body.title', code: 'too_small' }])
  })

  it('never carries the API developer message into anything displayable', async () => {
    const { client } = clientOver([errorResponse('INTERNAL_ERROR', 500)])

    const error = (await client
      .request({ method: 'GET', path: '/circuits', schema: passthrough })
      .catch((thrown: unknown) => thrown)) as ApiRequestError

    // The Error's own message is the code, so a stray `String(error)` in the
    // UI shows an identifier rather than untranslated English prose.
    expect(error.message).toBe('INTERNAL_ERROR')
  })

  /*
   * The distinction the UI is built on: 401 offers a sign-in prompt, 403 must
   * not — the user is already signed in and the button would do nothing.
   */
  it('distinguishes 401 from 403', async () => {
    const { client } = clientOver([
      errorResponse('AUTH_REQUIRED', 401),
      errorResponse('FORBIDDEN', 403),
    ])

    const unauthenticated = (await client
      .request({ method: 'GET', path: '/circuits', schema: passthrough })
      .catch((thrown: unknown) => thrown)) as ApiRequestError
    const unauthorised = (await client
      .request({ method: 'PATCH', path: '/circuits/abc', schema: passthrough })
      .catch((thrown: unknown) => thrown)) as ApiRequestError

    expect(unauthenticated.status).toBe(401)
    expect(requiresAuthentication(unauthenticated)).toBe(true)
    expect(isForbidden(unauthenticated)).toBe(false)

    expect(unauthorised.status).toBe(403)
    expect(isForbidden(unauthorised)).toBe(true)
    expect(requiresAuthentication(unauthorised)).toBe(false)
  })

  it('keeps 401 and 403 apart even when a proxy ate the error body', async () => {
    const { client } = clientOver([
      new Response('<html>401</html>', { status: 401 }),
      new Response('', { status: 403 }),
    ])

    const first = (await client
      .request({ method: 'GET', path: '/circuits', schema: passthrough })
      .catch((thrown: unknown) => thrown)) as ApiRequestError
    const second = (await client
      .request({ method: 'GET', path: '/circuits', schema: passthrough })
      .catch((thrown: unknown) => thrown)) as ApiRequestError

    expect(first.code).toBe('AUTH_REQUIRED')
    expect(requiresAuthentication(first)).toBe(true)
    expect(second.code).toBe('FORBIDDEN')
    expect(isForbidden(second)).toBe(true)
  })

  it('falls back to the status for a code this bundle does not know', async () => {
    const { client } = clientOver([errorResponse('QUOTA_EXCEEDED', 403)])

    const error = (await client
      .request({ method: 'POST', path: '/circuits', schema: passthrough })
      .catch((thrown: unknown) => thrown)) as ApiRequestError

    // An API deployed ahead of this tab. The message stays sensible and the
    // real code survives for a bug report.
    expect(error.code).toBe('FORBIDDEN')
    expect(error.serverCode).toBe('QUOTA_EXCEEDED')
  })

  it('reports a request that never reached the server', async () => {
    const { client } = clientOver([new TypeError('Failed to fetch')])

    const error = (await client
      .request({ method: 'GET', path: '/circuits', schema: passthrough })
      .catch((thrown: unknown) => thrown)) as ApiRequestError

    expect(error.code).toBe('NETWORK_UNREACHABLE')
    expect(error.status).toBeNull()
  })

  it('lets an abort stay an abort', async () => {
    const abort = new DOMException('The operation was aborted.', 'AbortError')
    const { client } = clientOver([abort])

    const error = await client
      .request({ method: 'GET', path: '/circuits', schema: passthrough })
      .catch((thrown: unknown) => thrown)

    // React Query cancels superseded requests constantly. Reporting those as
    // network failures would put a banner on screen for working software.
    expect(error).toBe(abort)
  })
})
