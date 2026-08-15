/**
 * Joining the session to the transport — the other half of `lib/api/
 * session.ts`.
 *
 * That module deliberately knows nothing about Supabase: it holds a function
 * that may produce a bearer token, looked up per request. This is the
 * function, and installing it is the whole of "the API client attaches the
 * token automatically".
 *
 * ── Why it reads the session instead of being handed a token ──────────────
 *
 * Because a token has an expiry and a copy does not know about it. supabase-js
 * refreshes on a timer and on tab focus, so the value inside it changes
 * without anybody being told; a token captured at sign-in and kept in a
 * variable is correct for an hour and then produces 401s that look like a
 * server problem. `getSession()` returns the stored session and refreshes it
 * first if it has expired, so reading through it per request is both current
 * and free — it is an in-memory read on every call but the one that renews.
 *
 * This is also why nothing here writes the token anywhere. The security rule
 * for this milestone is that supabase-js owns the credential: not
 * `localStorage` under a key of our own, not a cookie, not a query string,
 * not a log line. A provider that reads and returns is the only thing that
 * touches it, and what it returns goes straight into one `Authorization`
 * header inside `lib/api/client.ts`.
 *
 * ── Sign-out needs no uninstall ───────────────────────────────────────────
 *
 * `session.ts` anticipated being cleared on sign-out. It does not have to be:
 * once supabase-js has dropped the session, this provider returns `null` on
 * its own and requests go out anonymously — which is the documented mode, not
 * a degraded one, because a public circuit is read by an anonymous `GET`. One
 * fewer thing for a sign-out path to remember is one fewer way to keep
 * sending a dead token.
 */

import { setAccessTokenProvider } from '../api/session.js'

import type { SupabaseAuthPort } from './authPort.js'

/**
 * Points every API client built without an explicit provider at this session.
 *
 * Called once from the bootstrap, before the first render, so that a request
 * made by a route on its very first paint already carries the token.
 */
export function installSupabaseAccessToken(auth: SupabaseAuthPort): void {
  setAccessTokenProvider(async () => {
    const { data, error } = await auth.getSession()

    /*
     * Thrown rather than turned into `null`. `lib/api/client.ts` converts a
     * throwing provider into `SESSION_UNAVAILABLE`, which is a sentence the
     * user can act on; returning `null` would send the request anonymously
     * and show a signed-in user the public view of their own circuit — a
     * failure indistinguishable from a permissions bug, from a screenshot.
     */
    if (error !== null) throw error

    return data.session?.access_token ?? null
  })
}
