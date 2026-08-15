// @vitest-environment node
import { describe, expect, it } from 'vitest'

import {
  EMAIL_ONLY_SETTINGS,
  fetchAuthSettings,
  toAuthSettings,
} from './settings.js'
import type { FetchLike } from './settings.js'
import type { SupabaseConfig } from './config.js'

/**
 * Provider discovery, tested in both directions — which is the point.
 *
 * The project this ships against reports every external provider as `false`
 * today, because the OAuth applications cannot be created until the accounts
 * exist. So there are two things to prove, and proving only the first is how
 * a hardcoded GitHub button survives review: that a settings document saying
 * `github: true` produces a github provider, and that today's document
 * produces none. The second is the one that is true right now; the first is
 * the one that has to be true next week, without an edit.
 *
 * The third property is the one that keeps a sign-in screen usable: every
 * failure resolves to email-only rather than rejecting.
 */

const CONFIG: SupabaseConfig = {
  url: 'https://project.supabase.test',
  publishableKey: 'sb_publishable_test',
}

/** The live document, copied from `GET /auth/v1/settings` on 2026-08-15. */
const LIVE_DOCUMENT = {
  external: {
    anonymous_users: false,
    apple: false,
    azure: false,
    bitbucket: false,
    discord: false,
    facebook: false,
    figma: false,
    github: false,
    gitlab: false,
    google: false,
    email: true,
    phone: false,
    zoom: false,
  },
  disable_signup: false,
  mailer_autoconfirm: false,
  phone_autoconfirm: false,
  sms_provider: 'twilio',
  saml_enabled: false,
  passkeys_enabled: false,
}

function respondWith(body: unknown, status = 200): FetchLike {
  return () =>
    Promise.resolve(
      new Response(typeof body === 'string' ? body : JSON.stringify(body), {
        status,
        headers: { 'Content-Type': 'application/json' },
      })
    )
}

describe('toAuthSettings', () => {
  it('offers github when the project says github is on', async () => {
    const settings = await fetchAuthSettings(CONFIG, {
      fetch: respondWith({
        external: { ...LIVE_DOCUMENT.external, github: true },
        mailer_autoconfirm: false,
      }),
    })

    expect(settings.providers).toEqual(['github'])
  })

  it('offers no provider when the project says github is off', async () => {
    // Today's real answer. A button here would lead to an error page.
    const settings = await fetchAuthSettings(CONFIG, {
      fetch: respondWith(LIVE_DOCUMENT),
    })

    expect(settings.providers).toEqual([])
    expect(settings.emailEnabled).toBe(true)
  })

  it('picks up a provider this bundle has never heard of', () => {
    /*
     * The whole reason discovery exists: a provider enabled after this code
     * was written must appear without an edit. Nothing here has a list of
     * known providers to filter against, and that is deliberate.
     */
    const settings = toAuthSettings({
      external: { email: true, some_new_idp: true },
    })

    expect(settings.providers).toEqual(['some_new_idp'])
  })

  it('never treats email, phone or anonymous_users as OAuth providers', () => {
    // They share the `external` map with the real providers, and rendering a
    // "Continue with email" button beside the email form is the bug.
    const settings = toAuthSettings({
      external: {
        email: true,
        phone: true,
        anonymous_users: true,
        github: true,
      },
    })

    expect(settings.providers).toEqual(['github'])
  })

  it('sorts providers so the buttons do not reorder between loads', () => {
    const settings = toAuthSettings({
      external: { google: true, github: true, gitlab: true },
    })

    expect(settings.providers).toEqual(['github', 'gitlab', 'google'])
  })

  it('reports that a new account must confirm its email', () => {
    // `mailer_autoconfirm: false` is the live setting, and it is why sign-up
    // has to say "check your inbox" rather than dropping the user at a login.
    expect(toAuthSettings(LIVE_DOCUMENT).emailConfirmationRequired).toBe(true)
    expect(
      toAuthSettings({ ...LIVE_DOCUMENT, mailer_autoconfirm: true })
        .emailConfirmationRequired
    ).toBe(false)
  })

  it('reports registration being closed', () => {
    expect(toAuthSettings(LIVE_DOCUMENT).signUpEnabled).toBe(true)
    expect(
      toAuthSettings({ ...LIVE_DOCUMENT, disable_signup: true }).signUpEnabled
    ).toBe(false)
  })

  it('survives a non-boolean value appearing under external', () => {
    /*
     * A stricter schema would reject the whole document over one field
     * Supabase added, losing every provider — a total failure caused by a
     * field nobody reads.
     */
    const settings = toAuthSettings({
      external: { github: true, something: { nested: 'object' } },
    })

    expect(settings.providers).toEqual(['github'])
  })

  it('degrades to email-only when the payload is not a settings document', () => {
    expect(toAuthSettings('<html>captive portal</html>')).toEqual(
      EMAIL_ONLY_SETTINGS
    )
    expect(toAuthSettings(null)).toEqual(EMAIL_ONLY_SETTINGS)
  })
})

describe('fetchAuthSettings', () => {
  it('sends the publishable key as a header, never in the query string', async () => {
    const calls: { url: string; init: RequestInit | undefined }[] = []
    const recording: FetchLike = (url, init) => {
      calls.push({ url, init })
      return respondWith(LIVE_DOCUMENT)(url, init)
    }

    await fetchAuthSettings(CONFIG, { fetch: recording })

    const call = calls[0]!
    expect(call.url).toBe(`${CONFIG.url}/auth/v1/settings`)
    expect(call.url).not.toContain('?')
    expect((call.init?.headers as Record<string, string>).apikey).toBe(
      CONFIG.publishableKey
    )
  })

  it('degrades to email-only on a failed status', async () => {
    expect(
      await fetchAuthSettings(CONFIG, { fetch: respondWith({}, 503) })
    ).toEqual(EMAIL_ONLY_SETTINGS)
  })

  it('degrades to email-only when the body is not JSON', async () => {
    const html: FetchLike = () =>
      Promise.resolve(new Response('<!doctype html><title>Wi-Fi</title>'))

    expect(await fetchAuthSettings(CONFIG, { fetch: html })).toEqual(
      EMAIL_ONLY_SETTINGS
    )
  })

  it('degrades to email-only when the request never lands', async () => {
    // The one that matters: a user is at the sign-in screen with no network
    // to the settings endpoint, and email and password may still work.
    const offline: FetchLike = () => Promise.reject(new TypeError('fetch fail'))

    expect(await fetchAuthSettings(CONFIG, { fetch: offline })).toEqual(
      EMAIL_ONLY_SETTINGS
    )
  })

  it('never rejects, whatever happens', async () => {
    const exploding: FetchLike = () => {
      throw new Error('synchronous throw')
    }

    await expect(
      fetchAuthSettings(CONFIG, { fetch: exploding })
    ).resolves.toEqual(EMAIL_ONLY_SETTINGS)
  })
})
