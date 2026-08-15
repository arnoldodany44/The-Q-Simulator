/**
 * The key cache: rotation must work, and it must not be usable as a weapon.
 *
 * The counter on the stub endpoint is what these tests are really about. A
 * cache that refetches on every unknown `kid` passes any correctness test
 * you can write and still turns a single attacker into a denial of service
 * against the auth provider — which takes the whole API down with it,
 * because nothing can be verified while the JWKS endpoint is saturated.
 */

import { describe, expect, it } from 'vitest'
import { JwksCache } from './jwks.js'
import { ApiError } from '../errors.js'
import {
  TEST_JWKS_URL,
  createSigningKey,
  stubJwksEndpoint,
} from '../testing/tokens.js'

/** A clock the test moves by hand, so cooldowns cost no wall time. */
function fakeClock(startMs = 1_000_000) {
  let current = startMs
  return {
    now: () => current,
    advance: (ms: number) => {
      current += ms
    },
  }
}

describe('JwksCache', () => {
  it('fetches once and serves the cached key afterwards', async () => {
    const key = await createSigningKey('key-1')
    const endpoint = stubJwksEndpoint([key])
    const cache = new JwksCache({
      url: TEST_JWKS_URL,
      fetchImpl: endpoint.fetchImpl,
    })

    await cache.getKey('key-1')
    await cache.getKey('key-1')
    await cache.getKey('key-1')

    expect(endpoint.calls()).toBe(1)
  })

  it('coalesces concurrent misses into a single request', async () => {
    // A rotation on a busy instance is exactly when every in-flight request
    // misses at once. One fetch, not one per request.
    const key = await createSigningKey('key-1')
    const endpoint = stubJwksEndpoint([key])
    const cache = new JwksCache({
      url: TEST_JWKS_URL,
      fetchImpl: endpoint.fetchImpl,
    })

    await Promise.all(Array.from({ length: 20 }, () => cache.getKey('key-1')))

    expect(endpoint.calls()).toBe(1)
  })

  it('picks up a rotated key by kid', async () => {
    const oldKey = await createSigningKey('key-1')
    const newKey = await createSigningKey('key-2')
    const endpoint = stubJwksEndpoint([oldKey])
    const clock = fakeClock()
    const cache = new JwksCache({
      url: TEST_JWKS_URL,
      fetchImpl: endpoint.fetchImpl,
      now: clock.now,
      minRefetchIntervalMs: 30_000,
    })

    await cache.getKey('key-1')
    endpoint.publish([oldKey, newKey])

    // Still inside the cooldown, so the new kid is rejected without a fetch.
    await expect(cache.getKey('key-2')).rejects.toBeInstanceOf(ApiError)
    expect(endpoint.calls()).toBe(1)

    clock.advance(30_000)
    await expect(cache.getKey('key-2')).resolves.toBeDefined()
    expect(endpoint.calls()).toBe(2)
  })

  it('does not refetch per request while a kid stays unknown', async () => {
    const key = await createSigningKey('key-1')
    const endpoint = stubJwksEndpoint([key])
    const clock = fakeClock()
    const cache = new JwksCache({
      url: TEST_JWKS_URL,
      fetchImpl: endpoint.fetchImpl,
      now: clock.now,
      minRefetchIntervalMs: 30_000,
    })

    for (let attempt = 0; attempt < 500; attempt += 1) {
      await expect(cache.getKey('forged-kid')).rejects.toBeInstanceOf(ApiError)
    }

    // Five hundred forged tokens, one request to Supabase.
    expect(endpoint.calls()).toBe(1)
  })

  it('rate limits a failing endpoint too', async () => {
    // Stamping the attempt only on success would retry on every request
    // while the endpoint is down — hammering it precisely when that helps
    // least.
    const key = await createSigningKey('key-1')
    const endpoint = stubJwksEndpoint([key])
    endpoint.setFailure('network')
    const clock = fakeClock()
    const cache = new JwksCache({
      url: TEST_JWKS_URL,
      fetchImpl: endpoint.fetchImpl,
      now: clock.now,
      minRefetchIntervalMs: 30_000,
    })

    for (let attempt = 0; attempt < 50; attempt += 1) {
      await expect(cache.getKey('key-1')).rejects.toBeInstanceOf(ApiError)
    }

    expect(endpoint.calls()).toBe(1)
  })

  it('reports every attempt during a cold outage as 503, not just the first', async () => {
    /*
     * The regression the assertion above could not see. `toBeInstanceOf`
     * passes for both codes, and what actually happened was one 503 followed
     * by forty-nine 401s: the cooldown branch could not tell "the last fetch
     * succeeded and this kid is genuinely absent" from "the last fetch failed
     * and we hold nothing". Downstream, `requiresAuthentication()` in
     * apps/web is true for any 401 and `isRetryable()` is false for it — so a
     * Supabase outage signed every user out instead of asking them to wait.
     */
    const key = await createSigningKey('key-1')
    const endpoint = stubJwksEndpoint([key])
    endpoint.setFailure('network')
    const clock = fakeClock()
    const cache = new JwksCache({
      url: TEST_JWKS_URL,
      fetchImpl: endpoint.fetchImpl,
      now: clock.now,
      minRefetchIntervalMs: 30_000,
    })

    const codes = new Set<string>()
    for (let attempt = 0; attempt < 50; attempt += 1) {
      await cache.getKey('key-1').catch((error: unknown) => {
        codes.add((error as ApiError).code)
      })
      clock.advance(100)
    }

    expect([...codes]).toEqual(['AUTH_KEY_UNAVAILABLE'])
    expect(cache.stats).toEqual({ fetches: 1, keyCount: 0 })
  })

  it('still answers 401 for an unknown kid once a fetch has succeeded', async () => {
    // The other half of the same branch: with keys in hand, the cooldown
    // rejecting an unknown kid is the honest 401 it was written to be.
    const key = await createSigningKey('key-1')
    const endpoint = stubJwksEndpoint([key])
    const clock = fakeClock()
    const cache = new JwksCache({
      url: TEST_JWKS_URL,
      fetchImpl: endpoint.fetchImpl,
      now: clock.now,
      minRefetchIntervalMs: 30_000,
    })

    await cache.getKey('key-1')

    await expect(cache.getKey('forged-kid')).rejects.toMatchObject({
      code: 'AUTH_INVALID_TOKEN',
      statusCode: 401,
    })
  })

  it('keeps the usable keys when one entry cannot be imported', async () => {
    /*
     * `SigningKeySchema` checks that `x` and `y` are non-empty strings; it
     * cannot check that they are a point on P-256, and `importJWK` throws for
     * one that is not. Unguarded, that rejection escaped the loop and
     * discarded the whole map — including keys already imported — because the
     * assignment happens only after the loop finishes. One junk entry beside
     * the live signing key was a total authentication outage.
     */
    const good = await createSigningKey('key-good')
    const offCurve = {
      kty: 'EC',
      crv: 'P-256',
      // 32 zero bytes: the right shape, and not a point on the curve.
      x: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
      y: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
      kid: 'key-offcurve',
      alg: 'ES256',
      use: 'sig',
    }
    const cache = new JwksCache({
      url: TEST_JWKS_URL,
      fetchImpl: () =>
        Promise.resolve({
          ok: true,
          status: 200,
          // Good key first: order must not matter, because the discard
          // happened after the loop rather than during it.
          json: () => Promise.resolve({ keys: [good.publicJwk, offCurve] }),
        }),
    })

    await expect(cache.getKey('key-good')).resolves.toBeDefined()
    expect(cache.stats.keyCount).toBe(1)
    await expect(cache.getKey('key-offcurve')).rejects.toMatchObject({
      code: 'AUTH_INVALID_TOKEN',
    })
  })

  it('reports an unreachable endpoint as 503, not 401', async () => {
    const endpoint = stubJwksEndpoint([])
    endpoint.setFailure('network')
    const cache = new JwksCache({
      url: TEST_JWKS_URL,
      fetchImpl: endpoint.fetchImpl,
    })

    // Nothing is wrong with the caller's token, so a 401 would tell a client
    // to throw away a perfectly good session.
    await expect(cache.getKey('key-1')).rejects.toMatchObject({
      code: 'AUTH_KEY_UNAVAILABLE',
      statusCode: 503,
    })
  })

  it('keeps verifying with a cached key while the endpoint is down', async () => {
    const key = await createSigningKey('key-1')
    const endpoint = stubJwksEndpoint([key])
    const clock = fakeClock()
    const cache = new JwksCache({
      url: TEST_JWKS_URL,
      fetchImpl: endpoint.fetchImpl,
      now: clock.now,
      cacheMaxAgeMs: 60_000,
      minRefetchIntervalMs: 1_000,
    })

    await cache.getKey('key-1')
    endpoint.setFailure('network')
    clock.advance(120_000)

    // The document is stale and cannot be refreshed, but the mathematics of
    // a signature does not go stale. An outage at Supabase must not log
    // every user out.
    await expect(cache.getKey('key-1')).resolves.toBeDefined()
  })

  it('rejects a token whose kid was removed from a fetched key set', async () => {
    const oldKey = await createSigningKey('key-1')
    const newKey = await createSigningKey('key-2')
    const endpoint = stubJwksEndpoint([oldKey])
    const clock = fakeClock()
    const cache = new JwksCache({
      url: TEST_JWKS_URL,
      fetchImpl: endpoint.fetchImpl,
      now: clock.now,
      cacheMaxAgeMs: 10_000,
      minRefetchIntervalMs: 1_000,
    })

    await cache.getKey('key-1')
    endpoint.publish([newKey])
    clock.advance(20_000)

    // A retired key must stop verifying once we have actually been told so.
    await expect(cache.getKey('key-1')).rejects.toMatchObject({
      code: 'AUTH_INVALID_TOKEN',
    })
  })

  it('ignores key types it will not verify with', async () => {
    /*
     * The algorithm-confusion defence. A JWKS carrying a symmetric `oct`
     * entry, combined with a token whose header says HS256, verifies against
     * a value the attacker also holds — so an unusable entry is skipped and
     * the usable one still works.
     */
    const key = await createSigningKey('key-1')
    const endpoint = {
      fetchImpl: () =>
        Promise.resolve({
          ok: true,
          status: 200,
          json: () =>
            Promise.resolve({
              keys: [
                { kty: 'oct', kid: 'symmetric', k: 'c2VjcmV0' },
                { kty: 'RSA', kid: 'rsa', n: 'abc', e: 'AQAB' },
                key.publicJwk,
              ],
            }),
        }),
    }
    const cache = new JwksCache({
      url: TEST_JWKS_URL,
      fetchImpl: endpoint.fetchImpl,
    })

    await expect(cache.getKey('key-1')).resolves.toBeDefined()
    await expect(cache.getKey('symmetric')).rejects.toMatchObject({
      code: 'AUTH_INVALID_TOKEN',
    })
  })

  it('treats a key set with nothing usable as an outage', async () => {
    const cache = new JwksCache({
      url: TEST_JWKS_URL,
      fetchImpl: () =>
        Promise.resolve({
          ok: true,
          status: 200,
          json: () => Promise.resolve({ keys: [] }),
        }),
    })

    await expect(cache.getKey('key-1')).rejects.toMatchObject({
      code: 'AUTH_KEY_UNAVAILABLE',
    })
  })

  it('rejects a response that is not a key set', async () => {
    // An HTML error page from a proxy is the realistic version of this.
    const cache = new JwksCache({
      url: TEST_JWKS_URL,
      fetchImpl: () =>
        Promise.resolve({
          ok: true,
          status: 200,
          json: () => Promise.resolve({ message: 'not found' }),
        }),
    })

    await expect(cache.getKey('key-1')).rejects.toMatchObject({
      code: 'AUTH_KEY_UNAVAILABLE',
    })
  })

  it('treats a non-2xx response as an outage', async () => {
    const endpoint = stubJwksEndpoint([])
    endpoint.setFailure('status')
    const cache = new JwksCache({
      url: TEST_JWKS_URL,
      fetchImpl: endpoint.fetchImpl,
    })

    await expect(cache.getKey('key-1')).rejects.toMatchObject({
      code: 'AUTH_KEY_UNAVAILABLE',
    })
  })
})
