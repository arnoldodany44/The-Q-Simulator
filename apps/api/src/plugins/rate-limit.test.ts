import { describe, expect, it } from 'vitest'
import { createTestApp, testEnv } from '../testing/app.js'
import { strictRateLimit } from './rate-limit.js'
import {
  createSigningKey,
  createTestJwksCache,
  signToken,
  stubJwksEndpoint,
} from '../testing/tokens.js'

describe('strictRateLimit', () => {
  it('is tighter than the global budget', () => {
    // §11 asks for a more aggressive limit on authentication and /simulate.
    // A "strict" limit that is not strictly smaller is a comment, not a rule.
    const env = testEnv()

    expect(strictRateLimit(env).max).toBeLessThan(env.rateLimit.max)
  })

  it('applies to a route that opts in', async () => {
    const env = testEnv({ RATE_LIMIT_MAX: '100', RATE_LIMIT_STRICT_MAX: '1' })
    const app = await createTestApp({ env })
    app.post(
      '/test/simulate',
      { config: { auth: 'public', rateLimit: strictRateLimit(env) } },
      () => ({ ok: true })
    )
    await app.ready()

    const first = await app.inject({ method: 'POST', url: '/test/simulate' })
    const second = await app.inject({ method: 'POST', url: '/test/simulate' })

    expect(first.statusCode).toBe(200)
    // The global budget of 100 is nowhere near spent; this is the route's own.
    expect(second.statusCode).toBe(429)
    await app.close()
  })

  it('leaves other routes on the global budget', async () => {
    const env = testEnv({ RATE_LIMIT_MAX: '100', RATE_LIMIT_STRICT_MAX: '1' })
    const app = await createTestApp({ env })
    app.post(
      '/test/simulate',
      { config: { auth: 'public', rateLimit: strictRateLimit(env) } },
      () => ({ ok: true })
    )
    app.get('/test/ping', { config: { auth: 'public' } }, () => ({ ok: true }))
    await app.ready()

    await app.inject({ method: 'POST', url: '/test/simulate' })
    await app.inject({ method: 'POST', url: '/test/simulate' })

    const ping = await app.inject({ method: 'GET', url: '/test/ping' })

    expect(ping.statusCode).toBe(200)
    await app.close()
  })

  it('keys an authenticated caller on their user id, not their address', async () => {
    /*
     * Asserted directly, because the consequence is easy to get backwards: a
     * signed-in user must carry their budget across networks rather than
     * inherit whatever the address they are currently on has already spent.
     */
    const key = await createSigningKey('key-1')
    const endpoint = stubJwksEndpoint([key])
    const app = await createTestApp({
      envOverrides: { RATE_LIMIT_MAX: '1' },
      jwks: createTestJwksCache(endpoint),
    })
    app.get('/test/ping', { config: { auth: 'optional' } }, () => ({
      ok: true,
    }))
    await app.ready()

    const token = await signToken(key)
    const authenticated = {
      method: 'GET' as const,
      url: '/test/ping',
      headers: { authorization: `Bearer ${token}` },
    }

    // The anonymous budget for this IP is spent first.
    expect(
      (await app.inject({ method: 'GET', url: '/test/ping' })).statusCode
    ).toBe(200)
    expect(
      (await app.inject({ method: 'GET', url: '/test/ping' })).statusCode
    ).toBe(429)

    // Same address, different key: the signed-in caller still has a budget.
    expect((await app.inject(authenticated)).statusCode).toBe(200)
    await app.close()
  })
})
