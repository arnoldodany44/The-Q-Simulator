/**
 * Turning a bearer token into a user id, or into a 401.
 *
 * Four things are checked, and all four have to hold. Three of them are the
 * obvious ones — the signature, the expiry, the issuer — and the fourth is
 * the one that is usually forgotten:
 *
 *   **The audience.** A token signed by the right key, unexpired, from the
 *   right issuer, can still have been minted for a different application in
 *   the same project. Supabase stamps `aud: 'authenticated'` on user tokens;
 *   a service-role key or a token from another audience must not open a user
 *   session here.
 *
 * And a fifth check that is not about the token at all: `sub` must be a
 * UUID, because `User.id` is `@db.Uuid` (§7). A token whose `sub` is not one
 * cannot possibly correspond to a row, and letting it through would push the
 * failure down into a query, where it becomes a 500 instead of a 401.
 *
 * The `alg` header is pinned twice on purpose — once before the key lookup,
 * once in the `jwtVerify` call. Algorithm confusion is the attack this class
 * of code exists to fail: a token that says `alg: none`, or `alg: HS256`
 * with the public EC key used as an HMAC secret, verifies happily against a
 * library that takes the header's word for it.
 */

import { errors as joseErrors, decodeProtectedHeader, jwtVerify } from 'jose'
import { z } from 'zod'
import { ApiError, isApiError } from '../errors.js'
import type { JwksCache } from './jwks.js'

/** The verified identity, and the only thing a route may trust about a caller. */
export interface VerifiedIdentity {
  /** The `sub` claim. Becomes `User.id` through `ensureUser`. */
  readonly userId: string
  readonly email: string | null
  readonly displayName: string | null
  readonly avatarUrl: string | null
  /** `exp`, in seconds since the epoch. */
  readonly expiresAt: number
}

export interface TokenVerifierOptions {
  readonly keys: JwksCache
  readonly issuer: string
  readonly audience: string
  /**
   * Both clocks here are servers': Supabase stamps `exp`, this process
   * compares it. Tokens live an hour, so there is no reason to accept an
   * expired one; a few seconds absorbs NTP jitter and nothing more.
   */
  readonly clockToleranceSeconds?: number
}

const DEFAULT_CLOCK_TOLERANCE_SECONDS = 5

/**
 * Longest e-mail address accepted, from RFC 5321: 64 for the local part, 255
 * for the domain, one `@`. `User.email` is unique and NOT NULL, so a value
 * that cannot be an address is a token this API cannot serve anyway.
 */
const MAX_EMAIL_LENGTH = 320
/** Longest display name stored. Longer than any name and shorter than a page. */
const MAX_DISPLAY_NAME_LENGTH = 200
/** Longest avatar URL stored, which is already generous for a data-less URL. */
const MAX_AVATAR_URL_LENGTH = 2048

/**
 * Supabase puts profile data under `user_metadata`, and which field carries
 * the name depends on the provider: GitHub fills `full_name` and `name`,
 * Google fills `name` and `picture`, an email signup fills nothing. All of
 * it is optional, and none of it is trusted for anything but display.
 *
 * ── Why the bounds are here and not "later" ───────────────────────────────
 *
 * `user_metadata` is not provider-controlled, it is *user*-controlled: any
 * signed-in user can write whatever they like into it with
 * `auth.updateUser({ data })`, straight from a browser, without this API
 * being involved. So these are attacker-supplied strings that arrive
 * pre-verified by a signature, which is the most misleading shape untrusted
 * input can have. `ensureOwner` writes them into `User.displayName` and
 * `User.avatarUrl`, both unbounded Postgres `text`, and the byline goes out
 * in every circuit response — so without a bound, one account is roughly
 * 12 KB of arbitrary text per claim (Node's default 16 KB header limit is the
 * only ceiling) served to every other client.
 *
 * A rejected token is the honest answer for an oversized value: it is not
 * something a provider produces, and the account can fix it from the same
 * place it set it. The avatar's *scheme* is handled differently — see
 * `displayableUrl` — because a provider genuinely might hand out a `data:`
 * avatar, and refusing to authenticate somebody over their profile picture
 * would be absurd.
 */
const ClaimsSchema = z.looseObject({
  sub: z
    .uuid()
    /*
     * Normalised to the canonical lowercase form Postgres stores. The `uuid`
     * type is case-insensitive, so `{ ownerId: viewerId }` in a Prisma filter
     * matches either spelling — but `circuit.ownerId === viewerId` in
     * `isOwner` and `assertOwner` is a JavaScript string comparison and does
     * not. Left unnormalised, the same identity in two spellings is an owner
     * whose circuit the query returns and whose ownership check then fails.
     * Supabase issues lowercase today, so this is a hardening step rather
     * than a live fix; it costs one call and removes the whole class.
     */
    .transform((value) => value.toLowerCase()),
  exp: z.number().int(),
  email: z.string().max(MAX_EMAIL_LENGTH).optional(),
  user_metadata: z
    .looseObject({
      full_name: z.string().max(MAX_DISPLAY_NAME_LENGTH).optional(),
      name: z.string().max(MAX_DISPLAY_NAME_LENGTH).optional(),
      avatar_url: z.string().max(MAX_AVATAR_URL_LENGTH).optional(),
      picture: z.string().max(MAX_AVATAR_URL_LENGTH).optional(),
    })
    .optional(),
})

/**
 * An avatar URL that is safe to hand to another user's browser, or `null`.
 *
 * The scheme is the whole point. `avatar_url` is user-writable, it is served
 * verbatim to every other client in `OwnerRef`, and `javascript:alert(...)`
 * is a perfectly valid string — so the day a component renders it in an
 * `href` rather than a `src`, a stored value becomes a stored XSS. Restricting
 * to http and https here means the dangerous value never reaches the row, and
 * therefore never reaches a client whatever a future component does with it.
 *
 * Dropped rather than rejected: a token is a session, an avatar is a
 * decoration, and refusing to sign somebody in over their profile picture is
 * not a trade anybody would choose.
 */
function displayableUrl(value: string | undefined): string | null {
  if (value === undefined) return null
  let parsed: URL
  try {
    parsed = new URL(value)
  } catch {
    return null
  }
  return parsed.protocol === 'https:' || parsed.protocol === 'http:'
    ? value
    : null
}

/**
 * Verifies a compact JWS and returns the identity it carries.
 *
 * @throws {ApiError} `AUTH_TOKEN_EXPIRED` when only the expiry failed,
 * `AUTH_INVALID_TOKEN` for every other rejection, `AUTH_KEY_UNAVAILABLE`
 * when the signing keys could not be fetched.
 */
export async function verifyAccessToken(
  token: string,
  options: TokenVerifierOptions
): Promise<VerifiedIdentity> {
  const kid = protectedKeyId(token)
  const key = await options.keys.getKey(kid)

  let payload: unknown
  try {
    const result = await jwtVerify(token, key, {
      algorithms: ['ES256'],
      issuer: options.issuer,
      audience: options.audience,
      clockTolerance:
        options.clockToleranceSeconds ?? DEFAULT_CLOCK_TOLERANCE_SECONDS,
      // Absent claims must fail rather than default. A token with no `exp`
      // would otherwise be a token that never expires.
      requiredClaims: ['sub', 'exp', 'iat'],
    })
    payload = result.payload
  } catch (error) {
    if (isApiError(error)) throw error
    if (error instanceof joseErrors.JWTExpired) {
      throw new ApiError('AUTH_TOKEN_EXPIRED', { cause: error })
    }
    // Everything else — bad signature, wrong issuer, wrong audience, missing
    // claim — collapses to one code. The client's reaction is identical and
    // the distinction is only useful to somebody probing.
    throw new ApiError('AUTH_INVALID_TOKEN', { cause: error })
  }

  const claims = ClaimsSchema.safeParse(payload)
  if (!claims.success) throw new ApiError('AUTH_INVALID_TOKEN')

  const metadata = claims.data.user_metadata
  return {
    userId: claims.data.sub,
    email: claims.data.email ?? null,
    displayName: metadata?.full_name ?? metadata?.name ?? null,
    avatarUrl: displayableUrl(metadata?.avatar_url ?? metadata?.picture),
    expiresAt: claims.data.exp,
  }
}

/**
 * Reads `kid` out of the protected header, refusing anything that is not an
 * ES256 token before a key is even looked up.
 *
 * This runs before `getKey`, which matters: a token declaring an algorithm
 * we do not accept must never reach the cache, or a stream of them becomes a
 * stream of unknown-`kid` lookups.
 */
function protectedKeyId(token: string): string {
  let header: { alg?: string; kid?: string }
  try {
    header = decodeProtectedHeader(token)
  } catch (error) {
    // Not three base64url segments, or the header is not JSON.
    throw new ApiError('AUTH_INVALID_TOKEN', { cause: error })
  }

  if (header.alg !== 'ES256') throw new ApiError('AUTH_INVALID_TOKEN')
  if (typeof header.kid !== 'string' || header.kid === '') {
    throw new ApiError('AUTH_INVALID_TOKEN')
  }
  return header.kid
}

/**
 * Extracts the token from an `Authorization` header.
 *
 * Returns `null` for a header that is present but not a bearer token, which
 * the caller reports as an invalid token rather than as an absent one — a
 * client that sent `Authorization: <raw jwt>` has a bug, and answering
 * "authentication required" would send it looking in the wrong place.
 *
 * The scheme is matched case-insensitively because RFC 7235 §2.1 says the
 * auth-scheme token is case-insensitive: `bearer`, `Bearer` and `BEARER` are
 * the same credential, and a client that sends the first of those does not
 * have a bug to be pointed at. supabase-js and apps/web both send `Bearer`,
 * so this only ever bit a curl user, a third-party client, or a proxy that
 * normalises header casing — which is precisely the set of callers least able
 * to work out why their perfectly good token was refused.
 */
export function bearerToken(header: string | undefined): string | null {
  if (header === undefined) return null
  const match = /^Bearer[ \t]+(.+)$/i.exec(header.trim())
  return match?.[1]?.trim() ?? null
}
