/**
 * Authentication, end to end, against a real Fastify instance.
 *
 * Every token here is really signed and really verified. The six cases the
 * milestone names — absent, malformed, wrong key, expired, wrong issuer,
 * valid — are each produced by changing exactly one thing about an otherwise
 * good token, which is what makes a pass meaningful: if the verifier stopped
 * checking audiences, only the audience test would go red.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { FastifyInstance } from 'fastify'
import { createTestApp } from '../testing/app.js'
import {
  TEST_USER_ID,
  createSigningKey,
  createTestJwksCache,
  signToken,
  stubJwksEndpoint,
} from '../testing/tokens.js'
import type { TestSigningKey } from '../testing/tokens.js'

let app: FastifyInstance
let key: TestSigningKey
let otherKey: TestSigningKey

async function buildAppWithRoutes(): Promise<FastifyInstance> {
  const signing = await createSigningKey('key-1')
  key = signing
  otherKey = await createSigningKey('key-2')

  const endpoint = stubJwksEndpoint([signing])
  const instance = await createTestApp({
    jwks: createTestJwksCache(endpoint),
  })

  // Three probes, one per policy. Registered here rather than in `app.ts`
  // because the policies are what is under test, not any real route.
  instance.get(
    '/test/required',
    { config: { auth: 'required' } },
    (request) => ({ userId: request.auth?.userId ?? null })
  )
  instance.get(
    '/test/optional',
    { config: { auth: 'optional' } },
    (request) => ({ userId: request.auth?.userId ?? null })
  )
  instance.get('/test/public', { config: { auth: 'public' } }, () => ({
    ok: true,
  }))

  await instance.ready()
  return instance
}

beforeAll(async () => {
  app = await buildAppWithRoutes()
})

afterAll(async () => {
  await app.close()
})

function bearer(token: string): Record<string, string> {
  return { authorization: `Bearer ${token}` }
}

describe('a route that requires a user', () => {
  it('rejects a request with no token', async () => {
    const response = await app.inject({ method: 'GET', url: '/test/required' })

    expect(response.statusCode).toBe(401)
    expect(response.json<{ error: { code: string } }>().error.code).toBe(
      'AUTH_REQUIRED'
    )
    // The scheme has to be advertised, or a client cannot tell "no
    // credentials" from "bad credentials" at the protocol level.
    expect(response.headers['www-authenticate']).toBe('Bearer')
  })

  it('rejects a malformed token', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/test/required',
      headers: bearer('not.a.jwt'),
    })

    expect(response.statusCode).toBe(401)
    expect(response.json<{ error: { code: string } }>().error.code).toBe(
      'AUTH_INVALID_TOKEN'
    )
  })

  it('rejects an Authorization header that is not a bearer token', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/test/required',
      headers: { authorization: 'Basic YWxpY2U6c2VjcmV0' },
    })

    expect(response.statusCode).toBe(401)
    expect(response.json<{ error: { code: string } }>().error.code).toBe(
      'AUTH_INVALID_TOKEN'
    )
  })

  it('rejects a token signed by a key the JWKS does not publish', async () => {
    // Correct shape, correct claims, correct algorithm — signed by a key
    // that was never published. This is the forged-token case.
    const token = await signToken(otherKey)

    const response = await app.inject({
      method: 'GET',
      url: '/test/required',
      headers: bearer(token),
    })

    expect(response.statusCode).toBe(401)
    expect(response.json<{ error: { code: string } }>().error.code).toBe(
      'AUTH_INVALID_TOKEN'
    )
  })

  it('rejects a token whose signature does not match a published key', async () => {
    /*
     * Sharper than the previous case: the header claims the *published*
     * `kid`, so the key lookup succeeds and only the signature check can
     * reject it. Without this, a verifier that trusted `kid` alone would
     * still pass the test above.
     */
    const token = await signToken(otherKey, { kid: key.kid })

    const response = await app.inject({
      method: 'GET',
      url: '/test/required',
      headers: bearer(token),
    })

    expect(response.statusCode).toBe(401)
    expect(response.json<{ error: { code: string } }>().error.code).toBe(
      'AUTH_INVALID_TOKEN'
    )
  })

  it('rejects an expired token, and says so', async () => {
    const token = await signToken(key, { expiresInSeconds: -3600 })

    const response = await app.inject({
      method: 'GET',
      url: '/test/required',
      headers: bearer(token),
    })

    expect(response.statusCode).toBe(401)
    // Its own code, because it is the one 401 the client can fix by
    // refreshing rather than by signing in again.
    expect(response.json<{ error: { code: string } }>().error.code).toBe(
      'AUTH_TOKEN_EXPIRED'
    )
  })

  it('rejects a token issued for another Supabase project', async () => {
    const token = await signToken(key, {
      issuer: 'https://someone-else.supabase.co/auth/v1',
    })

    const response = await app.inject({
      method: 'GET',
      url: '/test/required',
      headers: bearer(token),
    })

    expect(response.statusCode).toBe(401)
    expect(response.json<{ error: { code: string } }>().error.code).toBe(
      'AUTH_INVALID_TOKEN'
    )
  })

  it('rejects a token minted for another audience', async () => {
    const token = await signToken(key, { audience: 'some-other-service' })

    const response = await app.inject({
      method: 'GET',
      url: '/test/required',
      headers: bearer(token),
    })

    expect(response.statusCode).toBe(401)
  })

  it('rejects a token whose sub is not a UUID', async () => {
    // `User.id` is `@db.Uuid` (§7). Letting this through would push the
    // failure into a query and turn a 401 into a 500.
    const token = await signToken(key, { subject: 'not-a-uuid' })

    const response = await app.inject({
      method: 'GET',
      url: '/test/required',
      headers: bearer(token),
    })

    expect(response.statusCode).toBe(401)
    expect(response.json<{ error: { code: string } }>().error.code).toBe(
      'AUTH_INVALID_TOKEN'
    )
  })

  it('accepts a valid token and exposes the verified sub', async () => {
    const token = await signToken(key)

    const response = await app.inject({
      method: 'GET',
      url: '/test/required',
      headers: bearer(token),
    })

    expect(response.statusCode).toBe(200)
    expect(response.json<{ userId: string }>().userId).toBe(TEST_USER_ID)
  })
})

describe('a route where the user is optional', () => {
  it('serves an anonymous reader', async () => {
    const response = await app.inject({ method: 'GET', url: '/test/optional' })

    expect(response.statusCode).toBe(200)
    // `null` rather than absent: this is the viewer id §11's filters take,
    // and the gallery serving anonymous readers depends on it.
    expect(response.json<{ userId: string | null }>().userId).toBeNull()
  })

  it('identifies a signed-in reader', async () => {
    const token = await signToken(key)

    const response = await app.inject({
      method: 'GET',
      url: '/test/optional',
      headers: bearer(token),
    })

    expect(response.statusCode).toBe(200)
    expect(response.json<{ userId: string }>().userId).toBe(TEST_USER_ID)
  })

  it('still rejects a token that does not verify', async () => {
    /*
     * "Optional" is about the absence of credentials, not about bad ones.
     * Treating a rejected token as anonymous would leave a client with a
     * stale session silently on the public view, and would make a broken
     * verifier indistinguishable from a successful anonymous request.
     */
    const token = await signToken(key, { expiresInSeconds: -60 })

    const response = await app.inject({
      method: 'GET',
      url: '/test/optional',
      headers: bearer(token),
    })

    expect(response.statusCode).toBe(401)
  })
})

describe('a route where the identity is irrelevant', () => {
  it('ignores a malformed Authorization header entirely', async () => {
    /*
     * The whole reason `public` exists as a third policy. The enforcement
     * hook used to throw the held failure before it looked at the policy at
     * all, so a liveness probe answered 401 because some caller had attached
     * a stale token — a healthy instance reporting itself dead, on the signal
     * a platform restarts on. A client-side token problem must not become a
     * restart loop.
     */
    const response = await app.inject({
      method: 'GET',
      url: '/test/public',
      headers: { authorization: 'Bearer garbage' },
    })

    expect(response.statusCode).toBe(200)
  })

  it('ignores an expired token too', async () => {
    const token = await signToken(key, { expiresInSeconds: -60 })

    const response = await app.inject({
      method: 'GET',
      url: '/test/public',
      headers: bearer(token),
    })

    expect(response.statusCode).toBe(200)
  })

  it('answers the health endpoints whatever the caller attached', async () => {
    // The two routes the policy was written for, rather than a probe route
    // that happens to declare it.
    for (const url of ['/health/live', '/health']) {
      const response = await app.inject({
        method: 'GET',
        url,
        headers: { authorization: 'Bearer garbage' },
      })
      expect([200, 503], url).toContain(response.statusCode)
    }
  })
})

describe('route policy declaration', () => {
  it('refuses to register a route with no declared policy', async () => {
    const instance = await createTestApp()

    expect(() => {
      instance.get('/test/forgot', () => ({ ok: true }))
    }).toThrow(/does not declare an auth policy/)

    await instance.close()
  })
})

describe('the not-found handler', () => {
  it('answers 404 rather than 401 for an unknown path', async () => {
    // A route that does not exist must not be hidden behind an
    // authentication error; that turns every typo into a support ticket.
    const response = await app.inject({ method: 'GET', url: '/test/nope' })

    expect(response.statusCode).toBe(404)
    expect(response.json<{ error: { code: string } }>().error.code).toBe(
      'NOT_FOUND'
    )
  })
})
