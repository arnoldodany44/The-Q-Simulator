/**
 * Which sign-in methods this Supabase project actually has, asked at runtime.
 *
 * ── Why this is discovered and not written down ───────────────────────────
 *
 * §3.4 promises GitHub and Google alongside email. Right now the project has
 * only the email provider enabled — the OAuth applications belong to the
 * owner's employer and cannot be created until the accounts exist (blocker B7
 * in the work plan). The tempting shortcut is to hardcode a GitHub button and
 * let it fail, or to comment it out and remember to uncomment it. Both are
 * wrong in the same way: the sign-in screen would be a claim about the
 * project's configuration rather than a reading of it, and the two would
 * disagree the moment somebody flips a switch in a dashboard nobody here
 * watches.
 *
 * `GET <project>/auth/v1/settings` is that reading. It is unauthenticated, it
 * is a small static document, and its `external` map is exactly "which
 * providers are on". A provider enabled next week appears on the sign-in
 * screen with no deploy, and a provider turned off stops being offered
 * instead of producing a button that leads to an error page.
 *
 * ── The failure mode that matters ─────────────────────────────────────────
 *
 * This request is made *on the sign-in screen*, by a user who is trying to
 * get in. If it fails — offline, a captive portal, a Supabase incident, a
 * response that is not JSON — the screen must still offer email and password,
 * because that path may well still work. So every failure resolves to
 * `EMAIL_ONLY_SETTINGS` and nothing here ever throws at a component. Degrading
 * to fewer options is recoverable; degrading to a blank page is not.
 *
 * ── What Zod is doing here ────────────────────────────────────────────────
 *
 * Distinguishing "the auth server answered" from "something answered". A
 * captive portal returns 200 and HTML; a proxy returns a JSON error object.
 * Both would sail through `response.json()` and produce `undefined` reads
 * downstream. Every field is optional with a defined fallback, deliberately:
 * a Supabase release that renames `mailer_autoconfirm` should cost one flag,
 * not the provider list. And `external`'s values are parsed as `unknown` and
 * filtered to `=== true`, so one non-boolean entry added upstream cannot
 * invalidate the whole document.
 */

import { z } from 'zod'

import type { SupabaseConfig } from './config.js'

/** Unauthenticated, and documented as such. Relative to the project origin. */
export const AUTH_SETTINGS_PATH = '/auth/v1/settings'

/** A settings fetch that has not answered by now is not going to help. */
export const SETTINGS_TIMEOUT_MS = 5_000

/**
 * Keys of `external` that are not third-party providers.
 *
 * The map mixes them in — `email` and `phone` are the built-in credential
 * flows, `anonymous_users` is a Supabase feature toggle — and rendering a
 * "Continue with email" OAuth button beside the email form is the exact bug
 * that naming this set prevents.
 */
const NON_OAUTH_EXTERNAL_KEYS: ReadonlySet<string> = new Set([
  'email',
  'phone',
  'anonymous_users',
])

const SettingsSchema = z.object({
  external: z.record(z.string(), z.unknown()).optional(),
  disable_signup: z.boolean().optional(),
  mailer_autoconfirm: z.boolean().optional(),
})

export interface AuthSettings {
  /** Enabled third-party providers, sorted, in Supabase's own spelling. */
  readonly providers: readonly string[]
  /** Whether email and password sign-in is offered at all. */
  readonly emailEnabled: boolean
  /** Whether registration is open. */
  readonly signUpEnabled: boolean
  /**
   * Whether a new account must confirm its email address before it can sign
   * in. Currently true on this project, which is why the sign-up screen has
   * to say "check your inbox" instead of dropping the user at a login form
   * that will reject them with no explanation.
   */
  readonly emailConfirmationRequired: boolean
}

/**
 * What is offered when the project could not be asked.
 *
 * Email-only, because that is the one method whose availability does not
 * depend on the answer, and `emailConfirmationRequired: true` because the
 * costly mistake is the other way round: telling somebody to check an inbox
 * they did not need to check is a wasted glance, while silently omitting that
 * sentence leaves a new account at a login form that rejects it. The sign-up
 * response is authoritative anyway — it reports whether a session came back —
 * so this flag only shapes the copy shown *before* the attempt.
 */
export const EMAIL_ONLY_SETTINGS: AuthSettings = {
  providers: [],
  emailEnabled: true,
  signUpEnabled: true,
  emailConfirmationRequired: true,
}

/** Reads the `external` map, keeping only third-party providers that are on. */
function enabledProviders(external: Record<string, unknown>): string[] {
  return Object.entries(external)
    .filter(([name, on]) => on === true && !NON_OAUTH_EXTERNAL_KEYS.has(name))
    .map(([name]) => name)
    .sort()
}

/** Interprets a parsed settings document. Exported for the tests. */
export function toAuthSettings(payload: unknown): AuthSettings {
  const parsed = SettingsSchema.safeParse(payload)
  if (!parsed.success) return EMAIL_ONLY_SETTINGS

  const external = parsed.data.external ?? {}
  return {
    providers: enabledProviders(external),
    // Absent means the key was not reported; email is the flow that exists
    // on every project, so its absence is not evidence that it is off.
    emailEnabled: external.email !== false,
    signUpEnabled: parsed.data.disable_signup !== true,
    emailConfirmationRequired: parsed.data.mailer_autoconfirm !== true,
  }
}

/** Only the part of `fetch` this module uses, so a test can be one function. */
export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>

export interface FetchAuthSettingsOptions {
  readonly fetch?: FetchLike
  /** React Query's, when this runs inside a query. */
  readonly signal?: AbortSignal
}

/**
 * Combines the caller's cancellation with a deadline of our own.
 *
 * Without the deadline a request that hangs — a captive portal that accepts
 * the connection and never answers is the common one — leaves the sign-in
 * screen waiting forever on a document it can do without. `AbortSignal.any`
 * is guarded because it is newer than the rest of what this bundle needs, and
 * losing the deadline is a better outcome than a `TypeError` on load.
 */
function deadline(signal: AbortSignal | undefined): AbortSignal {
  const timeout = AbortSignal.timeout(SETTINGS_TIMEOUT_MS)
  if (signal === undefined) return timeout
  return typeof AbortSignal.any === 'function'
    ? AbortSignal.any([signal, timeout])
    : signal
}

/**
 * Asks the project what it offers. Never rejects: a failure is email-only.
 */
export async function fetchAuthSettings(
  config: SupabaseConfig,
  options: FetchAuthSettingsOptions = {}
): Promise<AuthSettings> {
  const doFetch = options.fetch ?? ((input, init) => fetch(input, init))

  try {
    const response = await doFetch(`${config.url}${AUTH_SETTINGS_PATH}`, {
      headers: {
        Accept: 'application/json',
        /*
         * Supabase's gateway wants the project key on every route, including
         * the unauthenticated ones. It is the publishable key — public by
         * design — and it goes in a header rather than a query string so it
         * stays out of logs, referrers and history.
         */
        apikey: config.publishableKey,
      },
      signal: deadline(options.signal),
    })

    if (!response.ok) return EMAIL_ONLY_SETTINGS
    return toAuthSettings(await response.json())
  } catch {
    /*
     * Swallowed rather than reported. The caller has a usable answer, this is
     * a sign-in screen rather than a diagnostic surface, and the one thing a
     * thrown error would add is a broken page.
     */
    return EMAIL_ONLY_SETTINGS
  }
}
