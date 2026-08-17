import type { ApiKeyIdentity, ApiKeyRepository } from '@qsim/db'
import { describe, expect, it } from 'vitest'
import { hashApiKey, mintApiKey } from './secret.js'
import { createApiKeyVerifier } from './verify.js'

/**
 * The two caching decisions, asserted as behaviour rather than as structure.
 *
 * The verifier's design is one sentence — *hits are never cached, misses are
 * cached briefly* — and both halves have a failure mode that only shows up in
 * production:
 *
 *   - caching a hit means a revoked key keeps working until a TTL expires, on
 *     whichever instance served the revocation and not the others;
 *   - not caching a miss means an unauthenticated flood of invented keys is
 *     one database query per request, before the rate limiter, on a pooler
 *     whose connection budget is one.
 *
 * So the assertions below count queries. A test that checked for the presence
 * of a `Map` would pass a rewrite that cached the wrong thing.
 */

const USER = '11111111-1111-4111-8111-111111111111'

interface Recorder {
  readonly repository: ApiKeyRepository
  readonly lookups: () => number
  readonly touches: () => { id: string; at: Date; notUsedSince: Date }[]
  readonly setRow: (row: ApiKeyIdentity | null) => void
}

function recorder(initial: ApiKeyIdentity | null): Recorder {
  let row = initial
  let lookups = 0
  const touches: { id: string; at: Date; notUsedSince: Date }[] = []

  const repository = {
    listApiKeys: () => Promise.resolve([]),
    createApiKey: () => Promise.reject(new Error('not used')),
    findApiKeyByHash: () => {
      lookups += 1
      return Promise.resolve(row)
    },
    revokeApiKey: () => Promise.resolve(null),
    touchApiKey: (input: { id: string; at: Date; notUsedSince: Date }) => {
      touches.push(input)
      return Promise.resolve()
    },
  } as unknown as ApiKeyRepository

  return {
    repository,
    lookups: () => lookups,
    touches: () => touches,
    setRow: (next) => {
      row = next
    },
  }
}

function identity(overrides: Partial<ApiKeyIdentity> = {}): ApiKeyIdentity {
  return {
    id: 'key-1',
    userId: USER,
    scopes: ['read'],
    lastUsedAt: new Date('2026-08-17T12:00:00.000Z'),
    ...overrides,
  }
}

describe('a key that verifies', () => {
  it('is looked up on every single request', async () => {
    const store = recorder(identity())
    let clock = Date.parse('2026-08-17T12:00:00.000Z')
    const verifier = createApiKeyVerifier({
      repository: store.repository,
      now: () => clock,
    })
    const key = mintApiKey().key

    for (let request = 0; request < 5; request += 1) {
      expect(await verifier.verify(key)).not.toBeNull()
      clock += 1000
    }

    /*
     * Five requests, five queries. This is the assertion that makes
     * revocation immediate: there is nothing holding a "valid" answer, so
     * there is nothing to invalidate — on this instance or on any other.
     */
    expect(store.lookups()).toBe(5)
  })

  it('stops verifying the moment the row stops matching', async () => {
    const store = recorder(identity())
    const verifier = createApiKeyVerifier({ repository: store.repository })
    const key = mintApiKey().key

    expect(await verifier.verify(key)).not.toBeNull()
    // What a revocation looks like from here: the filtered lookup finds
    // nothing. No clock is advanced and no cache is cleared.
    store.setRow(null)
    expect(await verifier.verify(key)).toBeNull()
  })

  it('drops scopes this build does not recognise', async () => {
    const store = recorder(identity({ scopes: ['read', 'root', 'write'] }))
    const verifier = createApiKeyVerifier({ repository: store.repository })

    const verified = await verifier.verify(mintApiKey().key)
    // An unknown value in a `TEXT[]` must grant nothing rather than be carried
    // through to a string comparison against a route's declaration.
    expect(verified?.scopes).toEqual(['read', 'write'])
  })
})

describe('a key that does not verify', () => {
  it('costs one query per distinct string, not one per request', async () => {
    const store = recorder(null)
    const verifier = createApiKeyVerifier({
      repository: store.repository,
      now: () => 1_000,
    })
    const key = mintApiKey().key

    for (let request = 0; request < 50; request += 1) {
      expect(await verifier.verify(key)).toBeNull()
    }

    /*
     * The flood case. Fifty requests carrying one invented key reach the
     * database once — which matters because this runs *before* the rate
     * limiter, on a pooler with one connection.
     */
    expect(store.lookups()).toBe(1)
  })

  it('forgets the refusal once the window passes', async () => {
    const store = recorder(null)
    let clock = 1_000
    const verifier = createApiKeyVerifier({
      repository: store.repository,
      now: () => clock,
      missTtlMs: 5_000,
    })
    const key = mintApiKey().key

    await verifier.verify(key)
    clock += 6_000
    await verifier.verify(key)
    expect(store.lookups()).toBe(2)
  })

  it('cannot grow without bound', async () => {
    const store = recorder(null)
    const verifier = createApiKeyVerifier({
      repository: store.repository,
      now: () => 1_000,
      missCapacity: 4,
    })

    const keys = Array.from({ length: 8 }, () => mintApiKey().key)
    for (const key of keys) await verifier.verify(key)
    // The first four have been evicted, so asking again queries again — which
    // is the price of the bound and the reason the bound is what protects
    // memory rather than the TTL.
    for (const key of keys) await verifier.verify(key)
    expect(store.lookups()).toBeGreaterThan(8)
  })

  it('never reaches the database for a string of the wrong shape', async () => {
    const store = recorder(identity())
    const verifier = createApiKeyVerifier({ repository: store.repository })

    for (const candidate of ['', 'qsk_short', 'eyJhbGciOiJFUzI1NiJ9.a.b']) {
      expect(await verifier.verify(candidate)).toBeNull()
    }
    expect(store.lookups()).toBe(0)
  })
})

describe('the lastUsedAt stamp', () => {
  it('is written for a key that has never been used', async () => {
    const store = recorder(identity({ lastUsedAt: null }))
    const at = Date.parse('2026-08-17T12:00:00.000Z')
    const verifier = createApiKeyVerifier({
      repository: store.repository,
      now: () => at,
    })

    await verifier.verify(mintApiKey().key)
    expect(store.touches()).toHaveLength(1)
    expect(store.touches()[0]?.at.getTime()).toBe(at)
  })

  it('is skipped while the stored one is still recent', async () => {
    const at = Date.parse('2026-08-17T12:00:00.000Z')
    const store = recorder(identity({ lastUsedAt: new Date(at - 1000) }))
    const verifier = createApiKeyVerifier({
      repository: store.repository,
      now: () => at,
      touchIntervalMs: 60_000,
    })

    await verifier.verify(mintApiKey().key)
    await verifier.verify(mintApiKey().key)
    /*
     * Zero writes. Without the throttle this column would turn the busiest
     * read path in the public API into a write, on a connection budget of one.
     */
    expect(store.touches()).toHaveLength(0)
  })

  it('is written again once the interval has passed', async () => {
    const at = Date.parse('2026-08-17T12:00:00.000Z')
    const store = recorder(identity({ lastUsedAt: new Date(at - 600_000) }))
    const verifier = createApiKeyVerifier({
      repository: store.repository,
      now: () => at,
      touchIntervalMs: 60_000,
    })

    await verifier.verify(mintApiKey().key)
    expect(store.touches()).toHaveLength(1)
    // The database repeats the comparison in its own `where`, so two
    // instances racing still produce one write.
    expect(store.touches()[0]?.notUsedSince.getTime()).toBe(at - 60_000)
  })

  it('never fails a request that was already authorised', async () => {
    const store = recorder(identity({ lastUsedAt: null }))
    const reported: unknown[] = []
    const failing = {
      ...store.repository,
      touchApiKey: () => Promise.reject(new Error('pool exhausted')),
    } as unknown as ApiKeyRepository

    const verifier = createApiKeyVerifier({
      repository: failing,
      onTouchError: (error) => reported.push(error),
    })

    /*
     * Bookkeeping about a request that has already been authorised. Turning a
     * transient write failure into "your key stopped working" is the most
     * alarming possible way to report a non-problem.
     */
    const verified = await verifier.verify(mintApiKey().key)
    expect(verified).not.toBeNull()
    expect(reported).toHaveLength(1)
  })
})

describe('the lookup value', () => {
  it('is the digest of the presented key and never the key', async () => {
    let seen: string | null = null
    const repository = {
      findApiKeyByHash: (keyHash: string) => {
        seen = keyHash
        return Promise.resolve(null)
      },
      touchApiKey: () => Promise.resolve(),
    } as unknown as ApiKeyRepository

    const key = mintApiKey().key
    await createApiKeyVerifier({ repository }).verify(key)

    expect(seen).toBe(hashApiKey(key))
    expect(seen).not.toBe(key)
  })
})
