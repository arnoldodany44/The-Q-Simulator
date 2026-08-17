import { createHash } from 'node:crypto'
import {
  API_KEY_HINT_LENGTH,
  API_KEY_LENGTH,
  API_KEY_PATTERN,
  API_KEY_PREFIX,
  API_KEY_SECRET_BYTES,
} from '@qsim/contract'
import { describe, expect, it } from 'vitest'
import { hashApiKey, isApiKeyCredential, mintApiKey } from './secret.js'

/**
 * The format, the digest, and the one property the whole feature rests on.
 *
 * These are cheap assertions about a small file, and they are worth having
 * because every one of them fails *silently* in production if it stops being
 * true: a key that does not match the published pattern is rejected by the
 * pre-filter and never reaches a lookup, so the symptom is "my key does not
 * work" with a 401 and nothing in any log to explain it.
 */

describe('mintApiKey', () => {
  it('produces a key of the published shape', () => {
    for (let attempt = 0; attempt < 200; attempt += 1) {
      const minted = mintApiKey()
      /*
       * Two hundred draws rather than one, because base64url of 32 bytes is
       * fixed-length but the *alphabet* is not exercised by a single sample —
       * and a `+` or a `/` escaping into the format is exactly the bug that
       * would break one key in a few hundred and be impossible to reproduce.
       */
      expect(minted.key, minted.key).toMatch(API_KEY_PATTERN)
      expect(minted.key).toHaveLength(API_KEY_LENGTH)
      expect(minted.key.startsWith(API_KEY_PREFIX)).toBe(true)
    }
  })

  it('never repeats', () => {
    const seen = new Set<string>()
    for (let attempt = 0; attempt < 500; attempt += 1) {
      seen.add(mintApiKey().key)
    }
    expect(seen.size).toBe(500)
  })

  it('hashes the whole key, prefix included', () => {
    const minted = mintApiKey()
    /*
     * Computed here from the key rather than compared against `hashApiKey`,
     * so this asserts *what* is hashed and not merely that the two calls
     * agree. A minting path and a verifying path that disagreed about whether
     * the prefix is included would be a feature that never authenticates
     * anything, and two mutually consistent functions would not catch it.
     */
    expect(minted.keyHash).toBe(
      createHash('sha256').update(minted.key, 'utf8').digest('hex')
    )
    expect(minted.keyHash).toHaveLength(64)
  })

  it('derives the stored prefix from the key it just made', () => {
    const minted = mintApiKey()
    expect(minted.keyPrefix).toBe(minted.key.slice(0, API_KEY_HINT_LENGTH))
    // Short enough to be useless as a credential: what is left is the tail.
    expect(minted.keyPrefix.length).toBeLessThan(minted.key.length / 4)
  })

  it('draws the documented amount of entropy', () => {
    // base64url of 32 bytes is 43 characters, and the format depends on it.
    const secret = mintApiKey().key.slice(API_KEY_PREFIX.length)
    expect(Math.ceil((API_KEY_SECRET_BYTES * 4) / 3)).toBe(secret.length)
  })
})

describe('hashApiKey', () => {
  it('is a function of the string and nothing else', () => {
    const key = mintApiKey().key
    expect(hashApiKey(key)).toBe(hashApiKey(key))
  })

  it('separates keys that differ by one character', () => {
    const key = mintApiKey().key
    const nudged = `${key.slice(0, -1)}${key.endsWith('A') ? 'B' : 'A'}`
    expect(hashApiKey(nudged)).not.toBe(hashApiKey(key))
  })
})

describe('isApiKeyCredential', () => {
  it('recognises our own keys', () => {
    expect(isApiKeyCredential(mintApiKey().key)).toBe(true)
  })

  it('never claims a JWT', () => {
    /*
     * The whole reason both credentials can share one header. A compact JWS
     * begins `eyJ` — the base64url of `{"` — and a key begins `qsk_`, so no
     * string is both and no token is ever tried against both verifiers.
     */
    const jws = 'eyJhbGciOiJFUzI1NiJ9.eyJzdWIiOiJhZGEifQ.c2lnbmF0dXJl'
    expect(isApiKeyCredential(jws)).toBe(false)
  })

  it('refuses the near misses that would otherwise become queries', () => {
    const secret = mintApiKey().key.slice(API_KEY_PREFIX.length)
    for (const candidate of [
      '',
      API_KEY_PREFIX,
      `${API_KEY_PREFIX}${secret.slice(1)}`, // one short
      `${API_KEY_PREFIX}${secret}A`, // one long
      `${API_KEY_PREFIX}${secret.slice(0, -1)}+`, // outside the alphabet
      `qsk-${secret}`, // wrong separator
      ` ${API_KEY_PREFIX}${secret}`, // leading space
      `${API_KEY_PREFIX}${secret}\n`, // trailing newline
    ]) {
      expect(isApiKeyCredential(candidate), JSON.stringify(candidate)).toBe(
        false
      )
    }
  })

  it('is anchored, so a key inside a longer string is not one', () => {
    // `API_KEY_PATTERN` is published as a scanning rule *and* used as the
    // gate. Losing the anchors would make `Bearer qsk_…` itself match.
    const key = mintApiKey().key
    expect(isApiKeyCredential(`Bearer ${key}`)).toBe(false)
  })
})
