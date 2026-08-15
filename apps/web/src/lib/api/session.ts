/**
 * Where the access token comes from — the seam between this transport layer
 * and Supabase Auth (M1.3).
 *
 * This milestone builds the transport and no screens, so nothing here knows
 * what Supabase is. It knows only that *something* may be able to produce a
 * bearer token, and that when nothing can, the request goes out anonymously —
 * which is not a degraded mode but the documented one: `GET /circuits/:id` is
 * how a PUBLIC circuit is read and how an UNLISTED link works at all.
 *
 * ── Why the provider is looked up per request ─────────────────────────────
 *
 * The obvious shape — pass a token into `createApiClient` — is wrong twice
 * over: the token expires, and the session does not exist yet when the client
 * is constructed at module load. Passing a *function* fixes the first. Having
 * the default read this holder at call time rather than capture it at
 * construction fixes the second: `main.tsx` can install the Supabase provider
 * after the client already exists, and requests already in flight are
 * unaffected while the next one picks it up.
 *
 * ── Why a module-level holder and not a context ───────────────────────────
 *
 * Because the client is not a React thing. It is called from React Query's
 * `queryFn`, from a router loader, and from tests, and threading a context
 * through those would mean the transport could only be used from inside a
 * tree. Tests never touch this holder anyway — they pass `getAccessToken`
 * explicitly, which is why every test in this directory is order-independent.
 */

/**
 * Produces a bearer token, or `null` for "no session". May be async: reading
 * a Supabase session can involve a refresh.
 */
export type AccessTokenProvider = () => string | null | Promise<string | null>

/** The provider before anyone signs in, and after they sign out. */
export const anonymousAccessToken: AccessTokenProvider = () => null

let provider: AccessTokenProvider = anonymousAccessToken

/**
 * Installs the provider every client built without an explicit one will use.
 *
 * Called once from the auth bootstrap in M1.3, and with `null` on sign-out —
 * clearing it is what makes "log out" stop sending the old token, rather than
 * relying on the token's own expiry.
 */
export function setAccessTokenProvider(next: AccessTokenProvider | null): void {
  provider = next ?? anonymousAccessToken
}

/** The provider installed right now. Read per request, never cached. */
export function currentAccessTokenProvider(): AccessTokenProvider {
  return provider
}
