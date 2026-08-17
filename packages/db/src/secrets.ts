/**
 * AES-256-GCM, and the reason the cipher lives beside the column rather than
 * in the route that writes it.
 *
 * ══════════════════════════════════════════════════════════════════════════
 * §11: "Credenciales de hardware cifradas con AES-256-GCM; la llave maestra
 * vive en variable de entorno o KMS, nunca en la base."
 *
 * The key is `ENCRYPTION_KEY`, thirty-two bytes of base64 in the environment.
 * It is never written to a row, never logged and never returned, and neither
 * is anything derived from it.
 *
 * ══════════════════════════════════════════════════════════════════════════
 * WHY GCM AND NOT CBC, IN ONE SENTENCE THAT MATTERS HERE
 *
 * The thing being encrypted is a *credential that gets sent somewhere*. With
 * an unauthenticated mode, anybody who can write to the `HardwareCredential`
 * table can flip bits in the ciphertext and the process will decrypt it into
 * some other string and put that string in an `Authorization` header pointed at
 * whatever host the CRN names. GCM's tag makes that a decryption failure
 * instead. The tag is the whole point; the confidentiality is the easy half.
 *
 * ══════════════════════════════════════════════════════════════════════════
 * THE IV IS RANDOM AND PER-RECORD, AND THAT IS NOT NEGOTIABLE
 *
 * GCM is a counter mode. Two records encrypted with the same key and the same
 * IV give an attacker the XOR of the two plaintexts, and — much worse — repeat
 * use of the authentication subkey, which lets the tag itself be forged. §7
 * gives the IV its own column for exactly this reason: it is per-row, drawn
 * from `randomBytes`, and there is no code path here that can produce a fixed
 * one, not even a "test mode".
 *
 * ══════════════════════════════════════════════════════════════════════════
 * WHAT IS STORED, AND WHY THE TAG RIDES WITH THE CIPHERTEXT
 *
 * `encryptedToken` is `ciphertext || tag` and `iv` is the twelve-byte nonce.
 * §7 gives two columns and the tag needs a home; appending it is the standard
 * layout (it is what `libsodium` and the WebCrypto API both do) and it makes
 * the invariant checkable — a row whose `encryptedToken` is shorter than the
 * tag is corrupt, and is refused rather than fed to a cipher.
 *
 * ══════════════════════════════════════════════════════════════════════════
 * ADDITIONAL AUTHENTICATED DATA
 *
 * The user id is bound into the tag. It costs nothing and it closes a real
 * hole: without it, a row copied from one user to another decrypts perfectly,
 * and the copier's jobs are billed to the original owner's ten-minute
 * allowance. With it, the same bytes under a different `userId` are a
 * decryption failure — the ciphertext is not merely secret, it is *about* a
 * particular owner.
 */

import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto'

/** Bytes of key AES-256 requires. */
export const KEY_BYTES = 32

/**
 * Bytes of nonce.
 *
 * Twelve, which is the only size GCM does not internally re-derive: a
 * different length is hashed down through GHASH first, which is slower and,
 * more to the point, is a path far fewer implementations agree on.
 */
export const IV_BYTES = 12

/** Bytes of authentication tag. Sixteen is the full-strength tag. */
export const TAG_BYTES = 16

/**
 * The longest secret this will seal.
 *
 * An IBM Cloud API key is 44 characters and a CRN is about 120. Two kilobytes
 * is generous for a credential and refuses a payload whose only purpose is to
 * make a database column large.
 */
export const MAX_SECRET_BYTES = 2048

const ALGORITHM = 'aes-256-gcm'

/** A credential that could not be sealed or opened, named without detail. */
export class CredentialCipherError extends Error {
  readonly code = 'CREDENTIAL_CIPHER_FAILED'

  constructor(detail: string, options: { cause?: unknown } = {}) {
    /*
     * The detail never contains any part of a key, a plaintext or a
     * ciphertext. A decryption failure in particular says only that it failed:
     * distinguishing "wrong key" from "tampered tag" would be an oracle, and
     * neither answer changes what an operator does about it.
     */
    super(detail, options)
    this.name = 'CredentialCipherError'
  }
}

/** A sealed secret, as §7's two columns. */
export interface SealedSecret {
  /** `ciphertext || tag`. */
  readonly encryptedToken: Uint8Array
  readonly iv: Uint8Array
}

/**
 * The master key, decoded and checked.
 *
 * Base64 rather than hex because thirty-two bytes is 44 characters instead of
 * 64 and the value has to survive being pasted into a platform dashboard. The
 * round-trip check refuses a value that *decodes* to the right length by
 * accident: Node's base64 decoder ignores characters outside the alphabet, so
 * a key with a typo in it silently becomes a different, shorter key, and every
 * credential sealed under it would be unopenable after the typo was fixed.
 */
export function decodeEncryptionKey(configured: string): Uint8Array {
  const trimmed = configured.trim()
  const key = Buffer.from(trimmed, 'base64')
  if (key.length !== KEY_BYTES) {
    throw new CredentialCipherError(
      `ENCRYPTION_KEY must decode to ${String(KEY_BYTES)} bytes of base64; ` +
        `it decoded to ${String(key.length)}`
    )
  }
  if (key.toString('base64') !== trimmed) {
    throw new CredentialCipherError(
      'ENCRYPTION_KEY is not canonical base64. Node ignores characters ' +
        'outside the alphabet, so a typo becomes a different key silently.'
    )
  }
  return key
}

/** Whether a configured value is a usable key, without throwing. */
export function isEncryptionKey(value: string): boolean {
  try {
    decodeEncryptionKey(value)
    return true
  } catch {
    return false
  }
}

export interface CredentialCipher {
  /**
   * Seals a secret for one owner.
   *
   * `owner` is bound into the tag, so the result cannot be opened as anybody
   * else's — see the header.
   */
  seal(plaintext: string, owner: string): SealedSecret
  /** Opens a sealed secret, or throws. Never answers a partial plaintext. */
  open(sealed: SealedSecret, owner: string): string
}

/**
 * A cipher over one master key.
 *
 * Built once per process from the environment. The key is held in the closure
 * and there is no accessor for it: the only things this object can do are seal
 * and open, which is the whole surface anything in this system needs.
 */
export function createCredentialCipher(key: Uint8Array): CredentialCipher {
  if (key.length !== KEY_BYTES) {
    throw new CredentialCipherError(
      `an AES-256 key is ${String(KEY_BYTES)} bytes`
    )
  }

  return {
    seal(plaintext, owner) {
      const bytes = Buffer.from(plaintext, 'utf8')
      if (bytes.length === 0) {
        throw new CredentialCipherError('refusing to seal an empty secret')
      }
      if (bytes.length > MAX_SECRET_BYTES) {
        throw new CredentialCipherError(
          `a credential is at most ${String(MAX_SECRET_BYTES)} bytes`
        )
      }
      // Fresh every time. There is no branch here that can reuse one.
      const iv = randomBytes(IV_BYTES)
      const cipher = createCipheriv(ALGORITHM, key, iv)
      cipher.setAAD(Buffer.from(owner, 'utf8'))
      const ciphertext = Buffer.concat([cipher.update(bytes), cipher.final()])
      return {
        encryptedToken: Buffer.concat([ciphertext, cipher.getAuthTag()]),
        iv,
      }
    },

    open(sealed, owner) {
      const stored = Buffer.from(
        sealed.encryptedToken.buffer,
        sealed.encryptedToken.byteOffset,
        sealed.encryptedToken.byteLength
      )
      if (sealed.iv.length !== IV_BYTES) {
        throw new CredentialCipherError('the stored nonce is the wrong length')
      }
      if (stored.length <= TAG_BYTES) {
        // Shorter than a tag means the row is truncated. Refused before the
        // cipher sees it, because `setAuthTag` on a short buffer is a throw
        // with a message that names the primitive rather than the problem.
        throw new CredentialCipherError('the stored credential is truncated')
      }
      const ciphertext = stored.subarray(0, stored.length - TAG_BYTES)
      const tag = stored.subarray(stored.length - TAG_BYTES)
      const decipher = createDecipheriv(ALGORITHM, key, sealed.iv)
      decipher.setAAD(Buffer.from(owner, 'utf8'))
      decipher.setAuthTag(tag)
      try {
        return Buffer.concat([
          decipher.update(ciphertext),
          // `final()` is where the tag is verified. Everything before it is
          // keystream and means nothing on its own, which is why the plaintext
          // is assembled here rather than returned from `update`.
          decipher.final(),
        ]).toString('utf8')
      } catch (error) {
        throw new CredentialCipherError(
          'the stored credential did not authenticate',
          { cause: error }
        )
      }
    },
  }
}
