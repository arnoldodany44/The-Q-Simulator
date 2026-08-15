/**
 * Where Supabase Auth lives, and whether this deployment has any (§11, §12.5).
 *
 * Both variables are `VITE_`-prefixed, so both are compiled into the bundle
 * and readable by anyone who opens the network tab. That is by design and not
 * a leak: the publishable key identifies the project and is rate-limited and
 * row-level-security-bound on the server side. The key that must never appear
 * here is `SUPABASE_SECRET_KEY`, which lives only in `apps/api`'s environment.
 *
 * ── Absent is a state; half-configured is a bug ────────────────────────────
 *
 * `resolveApiBaseUrl` throws when its origin is missing, because every screen
 * needs the API. Auth is different: Phase 0 shipped a landing page and an
 * editor that work with no account at all, and they still must. So a
 * deployment with *neither* variable set is a deployment without accounts —
 * this returns `null`, the session resolves to signed-out for good, and the
 * public half of the app keeps working.
 *
 * Setting exactly one of the two is never a decision anybody makes on
 * purpose. It is a typo in a dashboard, and it produces a client that fails on
 * the first sign-in attempt with something unhelpful, so it throws here
 * instead — naming the variable, never a value.
 *
 * ── Why the scheme is checked ─────────────────────────────────────────────
 *
 * Every request supabase-js makes carries the session's refresh token to this
 * origin, and the response carries a fresh access token back. Over plain HTTP
 * an on-path observer gets both. `apps/api` already refuses to boot when its
 * JWKS URL is not https for the same reason (see `.env.example`); this is the
 * browser half of that rule. Loopback is exempt so that a local
 * `supabase start` works, and only loopback — a LAN address is somebody
 * else's network.
 */

export interface SupabaseEnvSource {
  readonly VITE_SUPABASE_URL?: string | undefined
  readonly VITE_SUPABASE_PUBLISHABLE_KEY?: string | undefined
}

export interface SupabaseConfig {
  /** Project origin, with no trailing slash. */
  readonly url: string
  /** The `sb_publishable_…` key. Public by design. */
  readonly publishableKey: string
}

/** Hosts where plain HTTP is a local dev server rather than an exposure. */
const LOOPBACK_HOSTNAMES: ReadonlySet<string> = new Set([
  'localhost',
  '127.0.0.1',
  '[::1]',
  '::1',
])

function stripTrailingSlash(value: string): string {
  return value.replace(/\/+$/, '')
}

function assertTransportIsEncrypted(url: string): void {
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    throw new Error(
      'VITE_SUPABASE_URL is not a URL. It should be the project origin, ' +
        'for example https://<ref>.supabase.co — see .env.example.'
    )
  }

  if (parsed.protocol === 'https:') return
  if (parsed.protocol === 'http:' && LOOPBACK_HOSTNAMES.has(parsed.hostname)) {
    return
  }

  throw new Error(
    'VITE_SUPABASE_URL must be https, or http on a loopback host for a ' +
      'local Supabase. Refresh tokens travel to this origin on every ' +
      'session refresh.'
  )
}

/**
 * The configuration, or `null` when this deployment has no Supabase project.
 *
 * @throws if exactly one of the two variables is set, or the URL is unusable.
 */
export function resolveSupabaseConfig(
  env: SupabaseEnvSource = import.meta.env
): SupabaseConfig | null {
  const url = env.VITE_SUPABASE_URL?.trim() ?? ''
  const publishableKey = env.VITE_SUPABASE_PUBLISHABLE_KEY?.trim() ?? ''

  if (url === '' && publishableKey === '') return null

  if (url === '') {
    throw new Error(
      'VITE_SUPABASE_PUBLISHABLE_KEY is set but VITE_SUPABASE_URL is not. ' +
        'Set both, or neither to run without accounts.'
    )
  }
  if (publishableKey === '') {
    throw new Error(
      'VITE_SUPABASE_URL is set but VITE_SUPABASE_PUBLISHABLE_KEY is not. ' +
        'Set both, or neither to run without accounts.'
    )
  }

  assertTransportIsEncrypted(url)

  return { url: stripTrailingSlash(url), publishableKey }
}
