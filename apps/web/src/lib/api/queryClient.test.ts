import { describe, expect, it } from 'vitest'

import { ApiRequestError } from './errors.js'
import {
  DEFAULT_STALE_TIME_MS,
  MAX_QUERY_RETRIES,
  createQueryClient,
  shouldRetryQuery,
} from './queryClient.js'
import { circuitKeys } from './queryKeys.js'

describe('shouldRetryQuery', () => {
  it('never retries what cannot change on a second attempt', () => {
    const forbidden = new ApiRequestError('FORBIDDEN', { status: 403 })
    const missing = new ApiRequestError('NOT_FOUND', { status: 404 })

    // React Query's own default is three retries on everything, which turns
    // one mistyped slug into four 404s against a rate-limited API.
    expect(shouldRetryQuery(0, forbidden)).toBe(false)
    expect(shouldRetryQuery(0, missing)).toBe(false)
  })

  it('retries a server fault, up to the cap', () => {
    const unavailable = new ApiRequestError('DATABASE_UNAVAILABLE', {
      status: 503,
    })

    expect(shouldRetryQuery(0, unavailable)).toBe(true)
    expect(shouldRetryQuery(MAX_QUERY_RETRIES - 1, unavailable)).toBe(true)
    expect(shouldRetryQuery(MAX_QUERY_RETRIES, unavailable)).toBe(false)
  })
})

describe('createQueryClient', () => {
  it('applies the defaults this API needs', () => {
    const defaults = createQueryClient().getDefaultOptions()

    expect(defaults.queries?.staleTime).toBe(DEFAULT_STALE_TIME_MS)
    expect(defaults.queries?.refetchOnWindowFocus).toBe(false)
    /*
     * Mutations never retry: `POST /circuits` creates a row, §8 offers no
     * idempotency key, and a retry after a lost response creates a second
     * circuit.
     */
    expect(defaults.mutations?.retry).toBe(false)
  })
})

describe('circuitKeys', () => {
  it('nests so that a mutation can invalidate exactly what it touched', () => {
    // Prefix matching is how invalidation works, so the nesting *is* the
    // invalidation policy.
    expect(circuitKeys.list({ page: 2 })[0]).toBe('circuits')
    expect(circuitKeys.detail('abc').slice(0, 2)).toEqual([
      'circuits',
      'detail',
    ])
    expect(circuitKeys.versionList('abc').slice(0, 3)).toEqual([
      'circuits',
      'detail',
      'abc',
    ])
    expect(circuitKeys.version('abc', 3).slice(0, 4)).toEqual([
      'circuits',
      'detail',
      'abc',
      'versions',
    ])
  })

  it('separates a listing from a detail, so one cannot invalidate the other', () => {
    expect(circuitKeys.lists()).not.toEqual(circuitKeys.details())
  })

  it('gives the same page the same key whether or not defaults were spelled out', () => {
    expect(circuitKeys.list({ page: undefined })).toEqual(circuitKeys.list())
  })
})
