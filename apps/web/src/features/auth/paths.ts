/**
 * Where the authentication routes live, and how a destination survives the
 * trip through them.
 *
 * The screens themselves arrive in M1.3b. The paths are declared here because
 * the guard already redirects to one and the Supabase client already has to
 * hand one to a mail server — a constant shared from the start is cheaper
 * than two string literals that agree until somebody renames a route.
 *
 * ── Why the intended destination is router state and not a query parameter ─
 *
 * `?next=/c/aVeryPrivateSlug` is the usual spelling and it leaks. An UNLISTED
 * circuit's slug *is* its access control (§11), and a query parameter is
 * copied into browser history, into the `Referer` header of every subsequent
 * request from that page, into a shared link, and into whatever analytics the
 * host adds later. Router state is held in the history entry, travels with
 * the navigation, and appears in no URL.
 *
 * The tradeoff is honest: state does not survive a manual reload of the
 * sign-in page, so a user who reloads lands on the default afterwards instead
 * of where they were going. Losing a redirect is a small annoyance; leaking a
 * private slug is a security defect.
 *
 * ── Why redirect targets are validated at all ─────────────────────────────
 *
 * The value is read back out of history state, and history state is
 * attacker-influenceable in the same way a URL is: a crafted link can push an
 * entry and hand the app any string. Navigating to it unchecked is an open
 * redirect — a phishing page reached from the real domain, after a real
 * sign-in. `isSafeRedirectPath` is what keeps that to a same-origin path.
 */

/** Sign-in. The one place `RequireSession` sends an anonymous visitor. */
export const SIGN_IN_PATH = '/sign-in'

/** Registration. */
export const SIGN_UP_PATH = '/sign-up'

/** Asking for a password-reset link. */
export const PASSWORD_RESET_PATH = '/reset-password'

/** Landing here from that link, holding a recovery session. */
export const PASSWORD_UPDATE_PATH = '/update-password'

/** Where a signed-in user goes when there is no better answer. */
export const DEFAULT_SIGNED_IN_PATH = '/'

/**
 * The signed-in user's own circuits.
 *
 * Not an authentication route, and it lives here for the same reason
 * `DEFAULT_SIGNED_IN_PATH` does: the account menu links to it, the guard
 * around it is in this directory, and a second string literal in a component
 * is how a rename leaves a dead link in a menu nobody re-reads.
 */
export const CIRCUITS_PATH = '/circuits'

/** The history-state key the guard writes and the sign-in screen reads. */
export const INTENDED_PATH_STATE_KEY = 'intendedPath'

/**
 * Whether a string is a path inside this app rather than somewhere else.
 *
 * The three rejected shapes are the three that actually get used:
 *
 *   - `https://evil.example` — an absolute URL, the obvious one.
 *   - `//evil.example` — protocol-relative, which is a *host* even though it
 *     starts with a slash. This is the one a naive `startsWith('/')` check
 *     lets straight through.
 *   - `/\evil.example` and `\\evil.example` — browsers normalise backslashes
 *     to forward slashes when resolving, so these become the previous case
 *     after the check has already passed. Rejecting every backslash is
 *     simpler than replicating the normalisation, and no legitimate path in
 *     this app contains one.
 */
export function isSafeRedirectPath(value: string): boolean {
  if (!value.startsWith('/')) return false
  if (value.includes('\\')) return false
  if (value.startsWith('//')) return false
  return true
}

/**
 * A same-origin path, or the default when the candidate is not one.
 *
 * Falling back rather than throwing: a bad value here means somebody tampered
 * with a history entry or a release renamed a route, and neither is worth
 * showing an error page for when "go to the home page" is a correct answer.
 */
export function safeRedirectPath(
  candidate: unknown,
  fallback: string = DEFAULT_SIGNED_IN_PATH
): string {
  if (typeof candidate !== 'string') return fallback
  return isSafeRedirectPath(candidate) ? candidate : fallback
}

/**
 * Reads the destination a guard recorded before redirecting here.
 *
 * Takes the `state` rather than the whole location so it can be called with
 * `useLocation().state` and, in a test, with a literal.
 */
export function intendedPathFrom(state: unknown): string {
  if (typeof state !== 'object' || state === null) {
    return DEFAULT_SIGNED_IN_PATH
  }
  return safeRedirectPath(
    (state as Record<string, unknown>)[INTENDED_PATH_STATE_KEY]
  )
}

/**
 * An absolute URL for a path in this app, for the two places Supabase needs
 * one it can put in an email or an OAuth `redirect_uri`.
 *
 * Built from the live origin rather than from a configured base URL so that a
 * Vercel preview deployment sends its links back to itself. The path is
 * validated first for the same reason `safeRedirectPath` exists: this string
 * ends up in a message a user clicks.
 */
export function absoluteAppUrl(path: string, origin: string): string {
  return `${origin}${safeRedirectPath(path)}`
}
