import { afterEach, describe, expect, it } from 'vitest'

import { createApiClient } from './client.js'
import {
  anonymousAccessToken,
  currentAccessTokenProvider,
  setAccessTokenProvider,
} from './session.js'
import { TEST_BASE_URL, jsonResponse, stubFetch } from './testing.js'

afterEach(() => {
  setAccessTokenProvider(null)
})

const passthrough = {
  safeParse: (value: unknown) => ({ success: true as const, data: value }),
}

describe('the installed access token provider', () => {
  it('is anonymous until something installs one', () => {
    expect(currentAccessTokenProvider()).toBe(anonymousAccessToken)
  })

  it('is cleared back to anonymous by passing null', () => {
    setAccessTokenProvider(() => 'token')
    setAccessTokenProvider(null)

    // Sign-out has to stop sending the old token immediately rather than
    // waiting for it to expire.
    expect(currentAccessTokenProvider()()).toBeNull()
  })

  /*
   * The reason the default is read per request instead of captured in the
   * closure: the client is built at module load, and the session does not
   * exist until the auth bootstrap has run.
   */
  it('is picked up by a client that already existed', async () => {
    const transport = stubFetch([jsonResponse({}), jsonResponse({})])
    const client = createApiClient({
      baseUrl: TEST_BASE_URL,
      fetch: transport.fetch,
    })

    await client.request({
      method: 'GET',
      path: '/circuits',
      schema: passthrough,
    })
    expect(transport.lastHeaders().authorization).toBeUndefined()

    setAccessTokenProvider(() => 'signed-in-now')

    await client.request({
      method: 'GET',
      path: '/circuits',
      schema: passthrough,
    })
    expect(transport.lastHeaders().authorization).toBe('Bearer signed-in-now')
  })

  it('is ignored by a client that was given its own provider', async () => {
    setAccessTokenProvider(() => 'ambient-token')
    const transport = stubFetch([jsonResponse({})])
    const client = createApiClient({
      baseUrl: TEST_BASE_URL,
      fetch: transport.fetch,
      getAccessToken: () => 'explicit-token',
    })

    await client.request({
      method: 'GET',
      path: '/circuits',
      schema: passthrough,
    })

    // What keeps every test in this directory order-independent.
    expect(transport.lastHeaders().authorization).toBe('Bearer explicit-token')
  })
})
