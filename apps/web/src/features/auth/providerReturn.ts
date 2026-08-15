/**
 * The other half of a third-party sign-in: what the provider sends back when
 * it does not send a session.
 *
 * ── Why this file exists ──────────────────────────────────────────────────
 *
 * `signInWithOAuth` is a top-level navigation. The browser leaves this app,
 * and whatever happens next is reported by *the address it comes back to* —
 * never by the promise that started the flow, which the page that awaited it
 * did not live long enough to read. Supabase appends
 *
 *     ?error=access_denied
 *     &error_code=provider_email_needs_verification
 *     &error_description=Error+getting+user+email+from+external+provider
 *
 * to `redirect_to`, which defaults to the app root — so a user who cancels on
 * GitHub's consent screen, or whose GitHub account releases no verified
 * address, lands on the marketing page, signed out, with the explanation
 * sitting unread in the address bar. Nothing in the app looked at it: the
 * click appeared to do nothing at all.
 *
 * ── Which parameter is authoritative ──────────────────────────────────────
 *
 * `error_code` first, `error` second. The pair is `access_denied` plus a
 * specific reason, and the specific one is the one worth a sentence:
 * `access_denied` alone covers cancelling, and paired with `otp_expired` it is
 * a recovery link that has already been used — two different next steps.
 *
 * Both the query and the fragment are read, and the query wins where they
 * disagree. Which of the two Supabase uses depends on the flow (PKCE puts it
 * on the query; the implicit flow puts it on the fragment), and a fragment
 * never reaches a server, so a page that only parsed the query would be silent
 * for exactly the deployments that use the other one.
 *
 * ── Nothing here decides anything ─────────────────────────────────────────
 *
 * A code out, a cleaned address out, and no React. The failure is rendered by
 * `ProviderReturnAlert` through the same `AuthErrorAlert` and the same three
 * catalogs every other auth failure uses (D2): this file's job is to notice.
 */

import { authFailureCode } from '../../lib/supabase/authErrors.js'
import type { AuthFailureCode } from '../../lib/supabase/authErrors.js'

/**
 * The parameters Supabase appends to a failed return, which are also the ones
 * stripped from the address afterwards.
 *
 * `error_description` is included for stripping and never for display: it is
 * English written by the auth server, it changes between releases, and
 * rendering it would put untranslated text in the French and Spanish
 * interfaces — the same rule `authErrors.ts` states for `AuthError.message`.
 */
export const PROVIDER_RETURN_PARAMS = [
  'error',
  'error_code',
  'error_description',
] as const

function paramsOf(fragment: string): URLSearchParams {
  return new URLSearchParams(fragment.replace(/^[#?]/u, ''))
}

/**
 * The failure a provider round trip came back with, or `null` for an ordinary
 * page load.
 */
export function readProviderReturn(
  search: string,
  hash: string
): AuthFailureCode | null {
  const query = paramsOf(search)
  const fragment = paramsOf(hash)

  const read = (name: string): string | null =>
    query.get(name) ?? fragment.get(name)

  const code = read('error_code') ?? read('error')
  if (code === null || code === '') return null

  // Through the same map as every other Supabase failure, so a code this
  // bundle predates becomes `UNKNOWN` and gets a sentence rather than silence.
  return authFailureCode({ code }) ?? 'UNKNOWN'
}

/**
 * The same address without those parameters.
 *
 * They are removed once they have been read, because they are the wreckage of
 * an attempt rather than a description of the page: left in place they survive
 * a copy of the link, a bookmark and a reload, and the reload would show the
 * same failure again for something the reader is no longer doing.
 */
export function hrefWithoutProviderReturn(href: string): string {
  const url = new URL(href)
  for (const name of PROVIDER_RETURN_PARAMS) url.searchParams.delete(name)

  const fragment = paramsOf(url.hash)
  let hadFragmentParam = false
  for (const name of PROVIDER_RETURN_PARAMS) {
    if (!fragment.has(name)) continue
    hadFragmentParam = true
    fragment.delete(name)
  }
  if (hadFragmentParam) {
    const rest = fragment.toString()
    url.hash = rest === '' ? '' : `#${rest}`
  }

  return url.toString()
}
