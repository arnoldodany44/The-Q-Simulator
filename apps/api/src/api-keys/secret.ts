/**
 * Minting a key, and turning a presented one into the value stored in the
 * database — §3.5, §11.
 *
 * This is the only file in the system that holds an API key in plaintext for
 * longer than the length of a comparison. `@qsim/db` receives a hex digest and
 * a ten-character prefix and never sees the rest; the route hands the key
 * straight into the 201 body and drops it. There is no field, no cache and no
 * log line anywhere between them that holds one.
 *
 * ══════════════════════════════════════════════════════════════════════════
 * WHY A PLAIN SHA-256 AND NOT ARGON2, BCRYPT OR A SALT
 *
 * This looks like the mistake everybody is taught not to make, so it is worth
 * being precise about why it is the right primitive *here* and the wrong one
 * for a password.
 *
 * A password hash is slow because the input is weak: people pick from a space
 * of maybe 2²² plausible passwords, so an attacker holding the table guesses
 * offline, and the only defence is to make each guess expensive. Per-user
 * salts exist for the same reason — to stop one precomputed table covering
 * every row at once.
 *
 * An API key from this file is 32 bytes out of `randomBytes`. There is no
 * plausible-guess distribution to search: a machine doing 10¹² SHA-256 per
 * second gets through 2⁸⁰ candidates in about 38 million years, and 2⁸⁰ is
 * one part in 2¹⁷⁶ of the space. Slowing the hash down defends a flank that
 * does not exist. A salt is likewise pointless — there is nothing to
 * precompute a table *of* — and it would cost the one property this design
 * depends on: with an unsalted digest, verification is a single indexed read
 * on `ApiKey_keyHash_key`, and with a per-row salt it becomes "hash the
 * presented key once per stored row", which is a full scan of the table on
 * every request. The schema comment in §7 anticipated exactly this ("it is
 * unique so a lookup by presented key is a single indexed read").
 *
 * The rule this follows: **hash the input's weakness, not its length.** A
 * password is weak and gets argon2. A 256-bit random token is not, and gets
 * the fastest sound digest available.
 *
 * ══════════════════════════════════════════════════════════════════════════
 * WHY THERE IS NO CONSTANT-TIME COMPARISON HERE
 *
 * The comparison happens in Postgres, on an index, and is emphatically not
 * constant time. That is fine, and the reason is what is being compared: the
 * stored value is a *digest*, and a timing signal about how many leading
 * characters of a digest matched is only useful to somebody who can then turn
 * a digest prefix back into a key. That requires inverting SHA-256.
 *
 * The version of this design where timing matters is the one where the column
 * holds the key itself, or a reversible transform of it. This one does not,
 * which is the same reason the digest can safely be the lookup value at all.
 */

import { createHash, randomBytes } from 'node:crypto'
import {
  API_KEY_PREFIX,
  API_KEY_SECRET_BYTES,
  API_KEY_SECRET_LENGTH,
  apiKeyHint,
  isApiKeyFormat,
} from '@qsim/contract'

/** A freshly minted key: the secret, and the two things stored beside it. */
export interface MintedApiKey {
  /**
   * The key itself, in the only form it will ever exist in.
   *
   * The caller must put this in the response and then let it go. Nothing else
   * in this process may keep it, and nothing in the database can reproduce it.
   */
  readonly key: string
  /** Hex SHA-256 of `key`. What the unique column holds. */
  readonly keyHash: string
  /** The first ten characters of `key`. What a listing shows. */
  readonly keyPrefix: string
}

/**
 * Hashes a presented key.
 *
 * Takes the *whole* key including the `qsk_` prefix rather than only the
 * random tail. It costs nothing and it means the stored digest is a function
 * of the exact string a client sends, so there is no "which part do we hash"
 * decision for two pieces of code to answer differently — the classic way this
 * kind of scheme breaks is a minting path and a verifying path that disagree
 * about a separator.
 *
 * Hex rather than base64: the column is compared by equality on an index, and
 * hex has exactly one spelling per digest. Base64 has padding, two alphabets
 * and a case convention, which is three ways for two encoders to produce
 * different strings for the same bytes.
 */
export function hashApiKey(key: string): string {
  return createHash('sha256').update(key, 'utf8').digest('hex')
}

/**
 * Mints a key.
 *
 * `randomBytes` and not `randomUUID`, and not anything seeded: this is the one
 * value in the system whose unpredictability is the entire security of the
 * feature. Node's `randomBytes` is the platform CSPRNG.
 *
 * base64url with no padding, produced by Node's own `base64url` encoding, so
 * the alphabet question is answered by the standard library rather than by a
 * hand-written replace chain — the place a stray `+` would come from.
 */
export function mintApiKey(): MintedApiKey {
  const secret = randomBytes(API_KEY_SECRET_BYTES).toString('base64url')
  /*
   * A belt-and-braces check on an invariant the encoding already guarantees:
   * base64url of 32 bytes is 43 characters. If it were ever not, every minted
   * key would be silently unmatched by `API_KEY_PATTERN` — a feature that
   * fails on the *next* request rather than on this one, which is the worst
   * shape a bug can have in a credential path.
   */
  if (secret.length !== API_KEY_SECRET_LENGTH) {
    throw new Error(
      `Minted a secret of ${String(secret.length)} characters; the format ` +
        `is ${String(API_KEY_SECRET_LENGTH)}`
    )
  }

  const key = `${API_KEY_PREFIX}${secret}`
  return { key, keyHash: hashApiKey(key), keyPrefix: apiKeyHint(key) }
}

/**
 * Whether a bearer token is one of *our* keys rather than a Supabase JWT.
 *
 * The two credential types share the `Authorization: Bearer` header, which is
 * what makes every existing HTTP client work unchanged — and they are
 * distinguishable without ambiguity, because a compact JWS always begins
 * `eyJ` (the base64url of `{"`) and a key always begins `qsk_`. There is no
 * string that is both, so no request is ever tried against both verifiers.
 *
 * The check is the full anchored format and not merely the prefix, so a
 * made-up token is rejected here — before it can become a database query on a
 * pooler whose connection budget is one.
 */
export function isApiKeyCredential(token: string): boolean {
  return isApiKeyFormat(token)
}
