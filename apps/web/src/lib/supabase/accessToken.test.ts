// @vitest-environment node
import { afterEach, describe, expect, it } from 'vitest'

import { createApiClient } from '../api/client.js'
import { isApiRequestError } from '../api/errors.js'
import {
  currentAccessTokenProvider,
  setAccessTokenProvider,
} from '../api/session.js'
import { TEST_BASE_URL, jsonResponse, stubFetch } from '../api/testing.js'
import { createFakeAuth, fakeSession } from '../../features/auth/testing.js'
import { installSupabaseAccessToken } from './accessToken.js'

/**
 * The seam between the session and the transport, asserted end to end rather
 * than by inspecting the provider: what matters is that a real request comes
 * out carrying `Authorization: Bearer …`, and that the same request goes out
 * *without* one when nobody is signed in — because an anonymous `GET` is how
 * a PUBLIC circuit is read and how an UNLISTED link works at all (§11).
 *
 * The provider is module-global by design (see `lib/api/session.ts`), so each
 * test puts it back afterwards. Without that, a test that signs in would
 * quietly authenticate every test that runs after it.
 */

afterEach(() => {
  setAccessTokenProvider(null)
})

const OK = { id: 'x' }
const schema = {
  safeParse: (value: unknown) => ({ success: true as const, data: value }),
}

function request(fetchImpl: ReturnType<typeof stubFetch>) {
  const client = createApiClient({
    baseUrl: TEST_BASE_URL,
    fetch: fetchImpl.fetch,
    // No `getAccessToken`: the point is that the *installed* provider is used.
  })
  return client.request({ method: 'GET', path: '/circuits', schema })
}

describe('installSupabaseAccessToken', () => {
  it('attaches the session token to an API request', async () => {
    const auth = createFakeAuth({ settled: fakeSession('user-1') })
    installSupabaseAccessToken(auth)

    const transport = stubFetch([jsonResponse(OK)])
    await request(transport)

    expect(transport.lastHeaders().authorization).toBe(
      'Bearer token-for-user-1'
    )
  })

  it('sends no Authorization header when nobody is signed in', async () => {
    const auth = createFakeAuth({ settled: null })
    installSupabaseAccessToken(auth)

    const transport = stubFetch([jsonResponse(OK)])
    await request(transport)

    expect(transport.lastHeaders().authorization).toBeUndefined()
  })

  it('re-reads the session per request rather than capturing a token', async () => {
    /*
     * The bug this prevents: a token captured once is correct for an hour and
     * then produces 401s that look like a server problem. supabase-js
     * refreshes on its own schedule, so the provider has to read through.
     */
    const auth = createFakeAuth({ settled: fakeSession('user-1') })
    installSupabaseAccessToken(auth)

    const first = stubFetch([jsonResponse(OK)])
    await request(first)

    auth.emit('TOKEN_REFRESHED', fakeSession('user-1-refreshed'))

    const second = stubFetch([jsonResponse(OK)])
    await request(second)

    expect(first.lastHeaders().authorization).toBe('Bearer token-for-user-1')
    expect(second.lastHeaders().authorization).toBe(
      'Bearer token-for-user-1-refreshed'
    )
  })

  it('reports an unreadable session instead of downgrading to anonymous', async () => {
    /*
     * Returning null here would send the request anonymously and show a
     * signed-in user the public view of their own circuit — indistinguishable
     * from a permissions bug, from a screenshot. `lib/api/client.ts` turns the
     * throw into SESSION_UNAVAILABLE, which is a sentence in three languages.
     */
    const auth = createFakeAuth({ settled: fakeSession('user-1') })
    auth.script.getSessionThrows = new Error('storage is unavailable')
    installSupabaseAccessToken(auth)

    const transport = stubFetch([jsonResponse(OK)])
    const error = await request(transport).catch((cause: unknown) => cause)

    expect(isApiRequestError(error)).toBe(true)
    expect((error as { code: string }).code).toBe('SESSION_UNAVAILABLE')
    // And the request never left, so nothing was sent unauthenticated.
    expect(transport.calls).toHaveLength(0)
  })

  it('installs a provider that outlives the call that made it', () => {
    const auth = createFakeAuth({ settled: null })
    installSupabaseAccessToken(auth)

    expect(currentAccessTokenProvider()).not.toBe(undefined)
  })
})
