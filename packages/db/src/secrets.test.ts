import { randomBytes } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import {
  CredentialCipherError,
  IV_BYTES,
  KEY_BYTES,
  MAX_SECRET_BYTES,
  TAG_BYTES,
  createCredentialCipher,
  decodeEncryptionKey,
  isEncryptionKey,
} from './secrets.js'

const KEY = randomBytes(KEY_BYTES)
const OWNER = '11111111-1111-4111-8111-111111111111'
const OTHER = '22222222-2222-4222-8222-222222222222'
const SECRET = 'an-ibm-cloud-api-key-that-is-44-characters-x'

describe('decodeEncryptionKey', () => {
  it('accepts thirty-two bytes of canonical base64', () => {
    expect(decodeEncryptionKey(KEY.toString('base64'))).toHaveLength(KEY_BYTES)
  })

  it('refuses a key of the wrong length rather than padding it', () => {
    expect(() =>
      decodeEncryptionKey(randomBytes(16).toString('base64'))
    ).toThrow(CredentialCipherError)
  })

  /*
   * Node's base64 decoder ignores characters outside the alphabet, so a typo
   * silently becomes a *different, shorter* key. Every credential sealed under
   * it would be unopenable the moment the typo was noticed and fixed.
   */
  it('refuses a value that only decodes by accident', () => {
    const canonical = KEY.toString('base64')
    const withTypo = `${canonical.slice(0, -1)}!${canonical.slice(-1)}`
    expect(isEncryptionKey(withTypo)).toBe(false)
  })
})

describe('createCredentialCipher', () => {
  const cipher = createCredentialCipher(KEY)

  it('round-trips a secret', () => {
    const sealed = cipher.seal(SECRET, OWNER)
    expect(cipher.open(sealed, OWNER)).toBe(SECRET)
  })

  it('never stores the plaintext, in any encoding', () => {
    const sealed = cipher.seal(SECRET, OWNER)
    const stored = Buffer.from(sealed.encryptedToken)
    expect(stored.toString('utf8')).not.toContain(SECRET)
    expect(stored.toString('base64')).not.toContain(
      Buffer.from(SECRET).toString('base64').slice(0, 20)
    )
  })

  it('stores ciphertext and tag together, and a twelve-byte nonce', () => {
    const sealed = cipher.seal(SECRET, OWNER)
    expect(sealed.iv).toHaveLength(IV_BYTES)
    expect(sealed.encryptedToken.length).toBe(
      Buffer.byteLength(SECRET) + TAG_BYTES
    )
  })

  /*
   * GCM is a counter mode. Two records under one key and one IV give away the
   * XOR of the plaintexts and — much worse — let the tag itself be forged.
   */
  it('draws a fresh nonce for every seal, with no path that reuses one', () => {
    const nonces = new Set<string>()
    for (let index = 0; index < 200; index++) {
      nonces.add(Buffer.from(cipher.seal(SECRET, OWNER).iv).toString('hex'))
    }
    expect(nonces.size).toBe(200)
  })

  it('produces different ciphertext for the same secret each time', () => {
    const a = Buffer.from(cipher.seal(SECRET, OWNER).encryptedToken)
    const b = Buffer.from(cipher.seal(SECRET, OWNER).encryptedToken)
    expect(a.equals(b)).toBe(false)
  })

  /* The reason for GCM rather than CBC: this plaintext becomes a header. */
  it('refuses a ciphertext whose bits were flipped', () => {
    const sealed = cipher.seal(SECRET, OWNER)
    const tampered = Buffer.from(sealed.encryptedToken)
    tampered[0] = tampered[0]! ^ 0x01
    expect(() =>
      cipher.open({ encryptedToken: tampered, iv: sealed.iv }, OWNER)
    ).toThrow(CredentialCipherError)
  })

  it('refuses a ciphertext whose tag was replaced', () => {
    const sealed = cipher.seal(SECRET, OWNER)
    const tampered = Buffer.from(sealed.encryptedToken)
    tampered[tampered.length - 1] = tampered[tampered.length - 1]! ^ 0xff
    expect(() =>
      cipher.open({ encryptedToken: tampered, iv: sealed.iv }, OWNER)
    ).toThrow(CredentialCipherError)
  })

  /*
   * The AAD, and the attack it closes: a row copied from one user to another
   * would otherwise decrypt perfectly, and the copier's jobs would be billed to
   * the original owner's ten-minute allowance.
   */
  it('refuses to open one owner s credential as another s', () => {
    const sealed = cipher.seal(SECRET, OWNER)
    expect(() => cipher.open(sealed, OTHER)).toThrow(CredentialCipherError)
  })

  it('refuses a credential sealed under a different master key', () => {
    const sealed = cipher.seal(SECRET, OWNER)
    const other = createCredentialCipher(randomBytes(KEY_BYTES))
    expect(() => other.open(sealed, OWNER)).toThrow(CredentialCipherError)
  })

  it('refuses a truncated row before the primitive sees it', () => {
    expect(() =>
      cipher.open(
        {
          encryptedToken: new Uint8Array(TAG_BYTES),
          iv: randomBytes(IV_BYTES),
        },
        OWNER
      )
    ).toThrow(/truncated/)
  })

  it('refuses a nonce of the wrong length', () => {
    const sealed = cipher.seal(SECRET, OWNER)
    expect(() =>
      cipher.open({ ...sealed, iv: randomBytes(IV_BYTES + 1) }, OWNER)
    ).toThrow(/nonce/)
  })

  it('refuses an empty secret and one past the ceiling', () => {
    expect(() => cipher.seal('', OWNER)).toThrow(CredentialCipherError)
    expect(() => cipher.seal('x'.repeat(MAX_SECRET_BYTES + 1), OWNER)).toThrow(
      CredentialCipherError
    )
  })

  /* §11: a failure must not become an oracle about which half was wrong. */
  it('says only that it failed, never why or with what', () => {
    const sealed = cipher.seal(SECRET, OWNER)
    try {
      cipher.open(sealed, OTHER)
      expect.unreachable('expected a refusal')
    } catch (error) {
      const message = (error as Error).message
      expect(message).not.toContain(SECRET)
      expect(message).not.toContain(OWNER)
      expect(message).not.toContain(OTHER)
      expect(message).toContain('did not authenticate')
    }
  })
})
