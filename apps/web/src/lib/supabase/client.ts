/**
 * The one Supabase client this tab has — §11.
 *
 * Constructed once, by the bootstrap in `main.tsx`, and handed to the session
 * provider. A module-level singleton would be shorter and would make every
 * test that touches auth share one instance of a client that owns a storage
 * key, a refresh timer and a `visibilitychange` listener.
 *
 * ── The options are the security decisions ────────────────────────────────
 *
 * `flowType: 'pkce'`. The implicit flow returns the access token in the URL
 * *fragment*, which means the credential is briefly in `location.href`, in
 * the back/forward history entry, and in anything that reads the URL. PKCE
 * returns a single-use `?code=` instead, exchanged for the session over a
 * POST. It is also the only flow that works when the session is established
 * on a different origin than the one that started it, which is what makes the
 * password-recovery link work.
 *
 * `detectSessionInUrl: true` is what performs that exchange on load. Without
 * it the OAuth round trip and the recovery link both end on a page that has a
 * code in the address bar and no session.
 *
 * `persistSession` and `autoRefreshToken` are the reason the access token is
 * never copied anywhere by this codebase: supabase-js owns storage and owns
 * expiry, and `lib/supabase/accessToken.ts` reads through it per request
 * rather than keeping a copy that can go stale.
 *
 * The storage key is namespaced so that two apps served from the same origin
 * — a preview deployment and the real one, on `*.vercel.app` — cannot read
 * each other's session out of `localStorage`.
 */

import { createClient } from '@supabase/supabase-js'

import type { SupabaseConfig } from './config.js'

/** Namespaced so a neighbouring app on the same origin cannot collide. */
export const SESSION_STORAGE_KEY = 'qsim.auth'

/**
 * The return type is inferred rather than written as `SupabaseClient`.
 * `createClient` is generic over a database schema this app does not have —
 * `apps/web` never speaks to Postgres (§12.3) — so naming the type would mean
 * naming five type arguments whose defaults have already changed once, for a
 * value whose only use is to be narrowed to `SupabaseAuthPort` on the next
 * line of the caller.
 */
export function createBrowserSupabaseClient(config: SupabaseConfig) {
  return createClient(config.url, config.publishableKey, {
    auth: {
      persistSession: true,
      autoRefreshToken: true,
      detectSessionInUrl: true,
      flowType: 'pkce',
      storageKey: SESSION_STORAGE_KEY,
    },
  })
}
