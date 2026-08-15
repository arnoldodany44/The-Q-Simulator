/**
 * Real ES256 key pairs and real tokens, for tests that refuse to mock.
 *
 * The rule this file exists to serve: **the verifier is never mocked.** A
 * test that stubs `verifyAccessToken` and asserts the route said 401 proves
 * that the stub returned an error. It proves nothing about signatures,
 * issuers, audiences or expiry — which is precisely where authentication
 * bugs live, and precisely why they survive suites that look thorough.
 *
 * So every token below is genuinely signed, with a genuinely generated
 * P-256 key, and the invalid ones are invalid in one specific way each: a
 * different key, an expiry in the past, another project's issuer, another
 * audience. The only thing faked is the network hop to the JWKS endpoint,
 * and that is faked by handing the cache a `fetch` that returns the key set
 * from memory — the parsing, the `kid` matching, the import and the
 * cooldown are all the production code paths.
 *
 * Excluded from the build (`tsconfig.build.json`): this mints tokens, and it
 * has no business inside a deployed image.
 */

import { SignJWT, exportJWK, generateKeyPair } from 'jose'
import type { JWK } from 'jose'
import { JwksCache } from '../auth/jwks.js'
import type { FetchLike } from '../auth/jwks.js'

export const TEST_ISSUER = 'https://project-ref.supabase.co/auth/v1'
export const TEST_AUDIENCE = 'authenticated'
export const TEST_JWKS_URL =
  'https://project-ref.supabase.co/auth/v1/.well-known/jwks.json'
export const TEST_USER_ID = '4f6c0f4e-6f1c-4c3d-9c17-2a4a3f1b5f21'

export interface TestSigningKey {
  readonly kid: string
  readonly privateKey: CryptoKey
  readonly publicJwk: JWK
}

/** A fresh P-256 key pair, exported the way a JWKS endpoint would publish it. */
export async function createSigningKey(kid: string): Promise<TestSigningKey> {
  const { privateKey, publicKey } = await generateKeyPair('ES256', {
    extractable: true,
  })
  const publicJwk = await exportJWK(publicKey)
  return {
    kid,
    privateKey,
    publicJwk: { ...publicJwk, kid, alg: 'ES256', use: 'sig' },
  }
}

export interface TokenOverrides {
  readonly issuer?: string
  readonly audience?: string
  readonly subject?: string
  readonly email?: string
  readonly userMetadata?: Record<string, unknown>
  /** Seconds from now. Negative mints an already-expired token. */
  readonly expiresInSeconds?: number
  /** Seconds from now. Defaults to the same offset as the expiry. */
  readonly issuedAtOffsetSeconds?: number
  /** Written into the protected header instead of the key's own `kid`. */
  readonly kid?: string
}

/** Signs a token that is valid unless an override makes it otherwise. */
export async function signToken(
  key: TestSigningKey,
  overrides: TokenOverrides = {}
): Promise<string> {
  const nowSeconds = Math.floor(Date.now() / 1000)
  const expiresIn = overrides.expiresInSeconds ?? 3600
  const issuedAt =
    overrides.issuedAtOffsetSeconds ?? Math.min(0, expiresIn - 3600)

  const payload: Record<string, unknown> = {
    email: overrides.email ?? 'ada@example.com',
    role: 'authenticated',
    user_metadata: overrides.userMetadata ?? {
      full_name: 'Ada Lovelace',
      avatar_url: 'https://example.com/ada.png',
    },
  }

  return new SignJWT(payload)
    .setProtectedHeader({ alg: 'ES256', kid: overrides.kid ?? key.kid })
    .setSubject(overrides.subject ?? TEST_USER_ID)
    .setIssuer(overrides.issuer ?? TEST_ISSUER)
    .setAudience(overrides.audience ?? TEST_AUDIENCE)
    .setIssuedAt(nowSeconds + issuedAt)
    .setExpirationTime(nowSeconds + expiresIn)
    .sign(key.privateKey)
}

export interface StubJwksEndpoint {
  readonly fetchImpl: FetchLike
  /** Network attempts the cache actually made. */
  readonly calls: () => number
  /** Swaps the published key set, the way a rotation would. */
  readonly publish: (keys: readonly TestSigningKey[]) => void
  /** Makes the next attempts fail, the way an outage would. */
  readonly setFailure: (failure: 'network' | 'status' | null) => void
}

/**
 * A stand-in for the JWKS endpoint that counts how often it was asked.
 *
 * The counter is the assertion that matters for the bounded-refetch
 * requirement: a thousand tokens with an unknown `kid` must produce one
 * fetch, not a thousand.
 */
export function stubJwksEndpoint(
  initial: readonly TestSigningKey[]
): StubJwksEndpoint {
  let published = [...initial]
  let calls = 0
  let failure: 'network' | 'status' | null = null

  const fetchImpl: FetchLike = (_input, _init) => {
    calls += 1
    if (failure === 'network') {
      return Promise.reject(new Error('connect ECONNREFUSED'))
    }
    if (failure === 'status') {
      return Promise.resolve({
        ok: false,
        status: 503,
        json: () => Promise.resolve({}),
      })
    }
    const body = { keys: published.map((key) => key.publicJwk) }
    return Promise.resolve({
      ok: true,
      status: 200,
      json: () => Promise.resolve(body),
    })
  }

  return {
    fetchImpl,
    calls: () => calls,
    publish: (keys) => {
      published = [...keys]
    },
    setFailure: (next) => {
      failure = next
    },
  }
}

export interface TestJwksOptions {
  readonly now?: () => number
  readonly cacheMaxAgeMs?: number
  readonly minRefetchIntervalMs?: number
}

export function createTestJwksCache(
  endpoint: StubJwksEndpoint,
  options: TestJwksOptions = {}
): JwksCache {
  return new JwksCache({
    url: TEST_JWKS_URL,
    fetchImpl: endpoint.fetchImpl,
    ...options,
  })
}
