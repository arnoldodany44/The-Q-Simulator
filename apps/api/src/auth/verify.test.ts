/**
 * Token verification at the unit level.
 *
 * The integration suite in `plugins/auth.test.ts` covers what a client sees.
 * This file covers the two things that are invisible from the outside: that
 * an algorithm we do not accept is rejected *before* a key is looked up, and
 * that the claims we hand to the rest of the system are the verified ones.
 */

import { describe, expect, it } from 'vitest'
import { SignJWT, UnsecuredJWT, generateSecret } from 'jose'
import { bearerToken, verifyAccessToken } from './verify.js'
import {
  TEST_AUDIENCE,
  TEST_ISSUER,
  TEST_USER_ID,
  createSigningKey,
  createTestJwksCache,
  signToken,
  stubJwksEndpoint,
} from '../testing/tokens.js'

async function fixture() {
  const key = await createSigningKey('key-1')
  const endpoint = stubJwksEndpoint([key])
  const keys = createTestJwksCache(endpoint)
  return {
    key,
    endpoint,
    verify: (token: string) =>
      verifyAccessToken(token, {
        keys,
        issuer: TEST_ISSUER,
        audience: TEST_AUDIENCE,
      }),
  }
}

describe('verifyAccessToken', () => {
  it('returns the verified identity', async () => {
    const { key, verify } = await fixture()

    const identity = await verify(await signToken(key))

    expect(identity).toEqual({
      userId: TEST_USER_ID,
      email: 'ada@example.com',
      displayName: 'Ada Lovelace',
      avatarUrl: 'https://example.com/ada.png',
      expiresAt: expect.any(Number) as number,
    })
  })

  it('reads a Google-shaped profile as well as a GitHub-shaped one', async () => {
    // GitHub fills `full_name`/`avatar_url`, Google fills `name`/`picture`,
    // an email signup fills nothing. All three have to work.
    const { key, verify } = await fixture()

    const google = await verify(
      await signToken(key, {
        userMetadata: { name: 'Ada', picture: 'https://example.com/g.png' },
      })
    )
    expect(google.displayName).toBe('Ada')
    expect(google.avatarUrl).toBe('https://example.com/g.png')

    const bare = await verify(await signToken(key, { userMetadata: {} }))
    expect(bare.displayName).toBeNull()
    expect(bare.avatarUrl).toBeNull()
  })

  it('rejects alg: none without looking up a key', async () => {
    /*
     * The oldest JWT attack there is. It must fail on the header alone —
     * checking after the key lookup would still be correct, but it would let
     * a stream of unsigned tokens drive JWKS lookups.
     */
    const { endpoint, verify } = await fixture()
    const token = new UnsecuredJWT({ sub: TEST_USER_ID })
      .setIssuer(TEST_ISSUER)
      .setAudience(TEST_AUDIENCE)
      .setIssuedAt()
      .setExpirationTime('1h')
      .encode()

    await expect(verify(token)).rejects.toMatchObject({
      code: 'AUTH_INVALID_TOKEN',
    })
    expect(endpoint.calls()).toBe(0)
  })

  it('rejects a symmetric algorithm without looking up a key', async () => {
    // Algorithm confusion: an HS256 token whose "secret" is the public key
    // the attacker also holds. Pinning ES256 in the header check is the
    // first of the two places this is refused.
    const { endpoint, verify } = await fixture()
    const secret = await generateSecret('HS256')
    const token = await new SignJWT({})
      .setProtectedHeader({ alg: 'HS256', kid: 'key-1' })
      .setSubject(TEST_USER_ID)
      .setIssuer(TEST_ISSUER)
      .setAudience(TEST_AUDIENCE)
      .setIssuedAt()
      .setExpirationTime('1h')
      .sign(secret)

    await expect(verify(token)).rejects.toMatchObject({
      code: 'AUTH_INVALID_TOKEN',
    })
    expect(endpoint.calls()).toBe(0)
  })

  it('rejects a token with no kid', async () => {
    const { key, verify } = await fixture()
    const token = await new SignJWT({})
      .setProtectedHeader({ alg: 'ES256' })
      .setSubject(TEST_USER_ID)
      .setIssuer(TEST_ISSUER)
      .setAudience(TEST_AUDIENCE)
      .setIssuedAt()
      .setExpirationTime('1h')
      .sign(key.privateKey)

    await expect(verify(token)).rejects.toMatchObject({
      code: 'AUTH_INVALID_TOKEN',
    })
  })

  it('rejects a token with no expiry', async () => {
    // A token with no `exp` is a token that never expires.
    const { key, verify } = await fixture()
    const token = await new SignJWT({})
      .setProtectedHeader({ alg: 'ES256', kid: key.kid })
      .setSubject(TEST_USER_ID)
      .setIssuer(TEST_ISSUER)
      .setAudience(TEST_AUDIENCE)
      .setIssuedAt()
      .sign(key.privateKey)

    await expect(verify(token)).rejects.toMatchObject({
      code: 'AUTH_INVALID_TOKEN',
    })
  })

  it('distinguishes expiry from every other rejection', async () => {
    const { key, verify } = await fixture()

    await expect(
      verify(await signToken(key, { expiresInSeconds: -1000 }))
    ).rejects.toMatchObject({ code: 'AUTH_TOKEN_EXPIRED' })
  })

  it('does not accept an expired token inside the clock tolerance', async () => {
    // Tolerance absorbs NTP jitter between two servers, nothing more.
    const { key, verify } = await fixture()

    await expect(
      verify(await signToken(key, { expiresInSeconds: -60 }))
    ).rejects.toMatchObject({ code: 'AUTH_TOKEN_EXPIRED' })
  })
})

describe('bearerToken', () => {
  it('extracts the token', () => {
    expect(bearerToken('Bearer abc.def.ghi')).toBe('abc.def.ghi')
  })

  it('returns null for an absent header', () => {
    expect(bearerToken(undefined)).toBeNull()
  })

  it('returns null for another scheme', () => {
    expect(bearerToken('Basic YWxpY2U6c2VjcmV0')).toBeNull()
  })

  it('is case-insensitive about the scheme, as RFC 7235 requires', () => {
    // §2.1: the auth-scheme token is case-insensitive. A client sending
    // `bearer` is spec-conformant, not buggy, and was being told its
    // perfectly good token could not be verified.
    expect(bearerToken('bearer abc')).toBe('abc')
    expect(bearerToken('BEARER abc')).toBe('abc')
    expect(bearerToken('BeArEr abc')).toBe('abc')
    // The scheme is still a whole word: this is not a prefix match.
    expect(bearerToken('Bearerabc')).toBeNull()
    expect(bearerToken('NotBearer abc')).toBeNull()
  })

  it('returns null for a bare token with no scheme', () => {
    expect(bearerToken('abc.def.ghi')).toBeNull()
  })
})
