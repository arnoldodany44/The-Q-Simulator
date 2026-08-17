import { describe, expect, it, vi } from 'vitest'
import { IbmError } from './errors.js'
import {
  IAM_GRANT_TYPE,
  IAM_TOKEN_URL,
  REFRESH_MARGIN_MS,
  createTokenCache,
  exchangeApiKey,
} from './iam.js'
import { RECORDED, recordedTransport, scriptOf } from './testing/transport.js'

const OK = scriptOf({
  'POST /identity/token': { status: 200, body: RECORDED.iamToken },
})

describe('exchangeApiKey', () => {
  it('posts the documented grant to IAM with the key in the body', async () => {
    const recorder = recordedTransport(OK)
    await exchangeApiKey('a-real-looking-key', {
      transport: recorder.transport,
      now: () => 1_000,
    })

    const request = recorder.last()
    expect(request.method).toBe('POST')
    expect(request.url).toBe(IAM_TOKEN_URL)
    expect(request.headers['content-type']).toBe(
      'application/x-www-form-urlencoded'
    )
    const body = new URLSearchParams(request.body ?? '')
    expect(body.get('grant_type')).toBe(IAM_GRANT_TYPE)
    expect(body.get('apikey')).toBe('a-real-looking-key')
  })

  /*
   * The key must never reach the request line: a URL is the one part of a
   * request every proxy and access log records verbatim.
   */
  it('never puts the key in the URL', async () => {
    const recorder = recordedTransport(OK)
    await exchangeApiKey('a-real-looking-key', {
      transport: recorder.transport,
    })
    expect(recorder.last().url).not.toContain('a-real-looking-key')
  })

  it('turns expires_in into an absolute instant on this process clock', async () => {
    const recorder = recordedTransport(OK)
    const token = await exchangeApiKey('k', {
      transport: recorder.transport,
      now: () => 5_000,
    })
    expect(token.token).toBe('recorded.bearer.token')
    expect(token.expiresAt).toBe(5_000 + 3600 * 1000)
  })

  /* Measured: IAM answers 400, not 401, for a key it does not recognise. */
  it('classifies IAM 400 as an invalid credential rather than a bad request', async () => {
    const recorder = recordedTransport(
      scriptOf({
        'POST /identity/token': { status: 400, body: RECORDED.iamBadKey },
      })
    )
    await expect(
      exchangeApiKey('nope', { transport: recorder.transport })
    ).rejects.toMatchObject({ code: 'IBM_CREDENTIAL_INVALID' })
  })

  it('never echoes IAM prose, which could quote the key back', async () => {
    const recorder = recordedTransport(
      scriptOf({
        'POST /identity/token': {
          status: 400,
          body: JSON.stringify({ errorMessage: 'key nope was not found' }),
        },
      })
    )
    await expect(
      exchangeApiKey('nope', { transport: recorder.transport })
    ).rejects.toThrow(/token exchange was refused/)
  })

  it('names a 200 that is not a token as a malformed response', async () => {
    const recorder = recordedTransport(
      scriptOf({ 'POST /identity/token': { status: 200, body: '{}' } })
    )
    await expect(
      exchangeApiKey('k', { transport: recorder.transport })
    ).rejects.toMatchObject({ code: 'IBM_MALFORMED_RESPONSE' })
  })
})

describe('createTokenCache', () => {
  it('exchanges once and reuses the token', async () => {
    const recorder = recordedTransport(OK)
    const cache = createTokenCache({ transport: recorder.transport })
    const apiKey = vi.fn(() => Promise.resolve('k'))

    expect(await cache.tokenFor('cred-1', apiKey)).toBe('recorded.bearer.token')
    expect(await cache.tokenFor('cred-1', apiKey)).toBe('recorded.bearer.token')

    expect(recorder.requests).toHaveLength(1)
    // The plaintext key is read once, not once per call.
    expect(apiKey).toHaveBeenCalledTimes(1)
  })

  /*
   * Keyed by credential and not by user: one person may hold a personal key and
   * an employer's, and sharing a token between them is a 403 that reads as a
   * permissions problem and is a bookkeeping one.
   */
  it('holds one token per credential', async () => {
    const recorder = recordedTransport(OK)
    const cache = createTokenCache({ transport: recorder.transport })
    await cache.tokenFor('cred-1', () => Promise.resolve('k1'))
    await cache.tokenFor('cred-2', () => Promise.resolve('k2'))
    expect(recorder.requests).toHaveLength(2)
    expect(cache.size()).toBe(2)
  })

  it('refreshes before expiry rather than after it', async () => {
    let now = 0
    const recorder = recordedTransport(OK)
    const cache = createTokenCache({
      transport: recorder.transport,
      now: () => now,
    })
    await cache.tokenFor('cred-1', () => Promise.resolve('k'))

    // Still inside the margin: no second exchange.
    now = 3600 * 1000 - REFRESH_MARGIN_MS - 1
    await cache.tokenFor('cred-1', () => Promise.resolve('k'))
    expect(recorder.requests).toHaveLength(1)

    // Inside the margin, before the token actually dies.
    now = 3600 * 1000 - REFRESH_MARGIN_MS + 1
    await cache.tokenFor('cred-1', () => Promise.resolve('k'))
    expect(recorder.requests).toHaveLength(2)
  })

  /* Several polls of one user's jobs must not each start their own exchange. */
  it('collapses concurrent askers onto one exchange', async () => {
    const recorder = recordedTransport(OK)
    const cache = createTokenCache({ transport: recorder.transport })
    const apiKey = () => Promise.resolve('k')

    const tokens = await Promise.all([
      cache.tokenFor('cred-1', apiKey),
      cache.tokenFor('cred-1', apiKey),
      cache.tokenFor('cred-1', apiKey),
    ])

    expect(new Set(tokens).size).toBe(1)
    expect(recorder.requests).toHaveLength(1)
  })

  it('does not hand a failed exchange to every later caller', async () => {
    let failing = true
    const recorder = recordedTransport(() =>
      failing
        ? { status: 400, body: RECORDED.iamBadKey }
        : { status: 200, body: RECORDED.iamToken }
    )
    const cache = createTokenCache({ transport: recorder.transport })

    await expect(
      cache.tokenFor('cred-1', () => Promise.resolve('k'))
    ).rejects.toBeInstanceOf(IbmError)

    failing = false
    await expect(
      cache.tokenFor('cred-1', () => Promise.resolve('k'))
    ).resolves.toBe('recorded.bearer.token')
  })

  it('evicts rather than holding credentials for the life of the process', async () => {
    const recorder = recordedTransport(OK)
    const cache = createTokenCache({
      transport: recorder.transport,
      maxEntries: 2,
      now: (() => {
        let tick = 0
        return () => tick++
      })(),
    })
    await cache.tokenFor('a', () => Promise.resolve('k'))
    await cache.tokenFor('b', () => Promise.resolve('k'))
    await cache.tokenFor('c', () => Promise.resolve('k'))
    expect(cache.size()).toBe(2)
  })

  it('forgets one credential on invalidate', async () => {
    const recorder = recordedTransport(OK)
    const cache = createTokenCache({ transport: recorder.transport })
    await cache.tokenFor('cred-1', () => Promise.resolve('k'))
    cache.invalidate('cred-1')
    await cache.tokenFor('cred-1', () => Promise.resolve('k'))
    expect(recorder.requests).toHaveLength(2)
  })
})
