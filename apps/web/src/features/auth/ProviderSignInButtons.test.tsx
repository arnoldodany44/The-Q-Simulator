import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from '@testing-library/react'
import { createInstance, type i18n as I18n } from 'i18next'
import { I18nextProvider, initReactI18next } from 'react-i18next'
import { afterEach, describe, expect, it } from 'vitest'

import enAuth from '../../i18n/locales/en/auth.json'
import esAuth from '../../i18n/locales/es/auth.json'
import { AUTH_SETTINGS_PATH } from '../../lib/supabase/index.js'
import { ProviderSignInButtons } from './ProviderSignInButtons.js'
import { SessionProvider } from './SessionProvider.js'
import { TEST_SUPABASE_CONFIG, createFakeAuth } from './testing.js'
import type { FakeAuthPort } from './testing.js'

/**
 * The requirement, rendered: a settings document that says `github: true`
 * produces a working GitHub button, and one that says `github: false`
 * produces none.
 *
 * Both directions are asserted because only asserting the first is how a
 * hardcoded button survives review — it would pass. Today the real project
 * answers `false` for every external provider, so the second test is the one
 * describing what is on screen right now, and the first is the one that has
 * to keep being true when somebody flips a switch in a dashboard next week.
 * Neither test names GitHub anywhere except in the fixture response.
 */

afterEach(cleanup)

function i18n(language = 'en'): I18n {
  const instance = createInstance()
  void instance.use(initReactI18next).init({
    lng: language,
    fallbackLng: 'en',
    ns: ['auth'],
    defaultNS: 'auth',
    resources: { en: { auth: enAuth }, es: { auth: esAuth } },
    interpolation: { escapeValue: false },
    react: { useSuspense: false },
  })
  return instance
}

/**
 * A settings endpoint that answers with one document per call, and records
 * the URLs. The last document is repeated once the list runs out, so a test
 * that does not care about the re-read before an OAuth redirect need not
 * supply one.
 */
function settingsEndpoint(...documents: unknown[]) {
  return respondingWith(200, documents)
}

/** The same, for the case where the project answers with a failure status. */
function failingSettingsEndpoint(status: number) {
  return respondingWith(status, [{ error: 'nope' }])
}

function respondingWith(status: number, bodies: readonly unknown[]) {
  const urls: string[] = []
  const fetchImpl = (input: string) => {
    urls.push(input)
    const body = bodies[Math.min(urls.length - 1, bodies.length - 1)]
    return Promise.resolve(
      new Response(JSON.stringify(body), {
        status,
        headers: { 'Content-Type': 'application/json' },
      })
    )
  }
  return { urls, fetchImpl }
}

function renderButtons(
  auth: FakeAuthPort,
  fetchImpl: typeof globalThis.fetch,
  language?: string
) {
  const original = globalThis.fetch
  globalThis.fetch = fetchImpl
  const view = render(
    <I18nextProvider i18n={i18n(language)}>
      <QueryClientProvider client={new QueryClient()}>
        <SessionProvider
          runtime={{ auth, config: TEST_SUPABASE_CONFIG }}
          origin="https://qsim.test"
        >
          <ProviderSignInButtons redirectPath="/new" />
        </SessionProvider>
      </QueryClientProvider>
    </I18nextProvider>
  )
  return { ...view, restore: () => (globalThis.fetch = original) }
}

/** The live document, with every external provider off. */
const ALL_OFF = {
  external: { email: true, phone: false, github: false, google: false },
  disable_signup: false,
  mailer_autoconfirm: false,
}

describe('with github enabled', () => {
  it('renders a button that starts the GitHub flow', async () => {
    const { fetchImpl, urls } = settingsEndpoint({
      ...ALL_OFF,
      external: { ...ALL_OFF.external, github: true },
    })
    const auth = createFakeAuth({ settled: null })
    const { restore } = renderButtons(
      auth,
      fetchImpl as typeof globalThis.fetch
    )

    const button = await screen.findByRole('button', {
      name: 'Continue with GitHub',
    })

    fireEvent.click(button)

    await waitFor(() => expect(auth.calls.signInWithOAuth).toHaveLength(1))
    expect(auth.calls.signInWithOAuth[0]).toEqual({
      provider: 'github',
      redirectTo: 'https://qsim.test/new',
    })
    // Asked the project, at the documented unauthenticated path.
    expect(urls[0]).toBe(`${TEST_SUPABASE_CONFIG.url}${AUTH_SETTINGS_PATH}`)
    restore()
  })

  it('translates the frame around the brand name', async () => {
    // "Continue with" is a sentence and belongs in a catalog; "GitHub" is a
    // proper noun and is identical in all three (D2).
    const { fetchImpl } = settingsEndpoint({
      ...ALL_OFF,
      external: { ...ALL_OFF.external, github: true },
    })
    const { restore } = renderButtons(
      createFakeAuth({ settled: null }),
      fetchImpl as typeof globalThis.fetch,
      'es'
    )

    expect(
      await screen.findByRole('button', { name: 'Continuar con GitHub' })
    ).toBeDefined()
    restore()
  })

  it('groups the buttons under a labelled list', async () => {
    const { fetchImpl } = settingsEndpoint({
      ...ALL_OFF,
      external: { ...ALL_OFF.external, github: true, google: true },
    })
    const { restore } = renderButtons(
      createFakeAuth({ settled: null }),
      fetchImpl as typeof globalThis.fetch
    )

    const group = await screen.findByRole('list', {
      name: 'Other ways to sign in',
    })

    expect(group).toBeDefined()
    expect(screen.getAllByRole('button')).toHaveLength(2)
    restore()
  })
})

describe('with github disabled', () => {
  it('renders nothing at all', async () => {
    // Today's answer. A button here would lead to an error page, and a
    // hardcoded one would still be here after the provider was turned off.
    const { fetchImpl } = settingsEndpoint(ALL_OFF)
    const { restore } = renderButtons(
      createFakeAuth({ settled: null }),
      fetchImpl as typeof globalThis.fetch
    )

    await waitFor(() => expect(screen.queryByRole('list')).toBeNull())
    expect(screen.queryAllByRole('button')).toHaveLength(0)
    restore()
  })

  it('renders nothing when the settings request fails, rather than breaking', async () => {
    /*
     * The user is at a sign-in screen trying to get in. Whatever went wrong
     * fetching a *configuration* document, the email form very likely still
     * works — so this degrades to email-only and never to an error page.
     */
    const { fetchImpl } = failingSettingsEndpoint(503)
    const { restore } = renderButtons(
      createFakeAuth({ settled: null }),
      fetchImpl as typeof globalThis.fetch
    )

    await waitFor(() => expect(screen.queryByRole('list')).toBeNull())
    restore()
  })
})

/**
 * The settings document is cached for the life of the tab, and
 * `signInWithOAuth` replaces the whole window. Between those two facts sits
 * the failure this describes: a provider switched off after the cache was
 * filled sent the reader to Supabase's raw JSON —
 *
 *   {"code":400,"error_code":"validation_failed",
 *    "msg":"Unsupported provider: provider is not enabled"}
 *
 * — with no alert, no form and no link back, and `errors.PROVIDER_DISABLED`
 * could never be shown for the browser flow at all.
 */
describe('a provider that was switched off after the page loaded', () => {
  it('is caught before the window is handed over, and reported here', async () => {
    const withGithub = {
      ...ALL_OFF,
      external: { ...ALL_OFF.external, github: true },
    }
    const { fetchImpl, urls } = settingsEndpoint(withGithub, ALL_OFF)
    const auth = createFakeAuth({ settled: null })
    const failures: string[] = []

    const original = globalThis.fetch
    globalThis.fetch = fetchImpl as typeof globalThis.fetch
    render(
      <I18nextProvider i18n={i18n()}>
        <QueryClientProvider client={new QueryClient()}>
          <SessionProvider
            runtime={{ auth, config: TEST_SUPABASE_CONFIG }}
            origin="https://qsim.test"
          >
            <ProviderSignInButtons
              redirectPath="/new"
              onFailure={(code) => failures.push(code)}
            />
          </SessionProvider>
        </QueryClientProvider>
      </I18nextProvider>
    )

    fireEvent.click(
      await screen.findByRole('button', { name: 'Continue with GitHub' })
    )

    await waitFor(() => expect(failures).toEqual(['PROVIDER_DISABLED']))
    // The redirect never started, so there is still a page to say it on.
    expect(auth.calls.signInWithOAuth).toHaveLength(0)
    expect(urls).toHaveLength(2)
    // And the button goes away, because the answer it was built from changed.
    await waitFor(() => expect(screen.queryByRole('list')).toBeNull())
    globalThis.fetch = original
  })

  it('keeps focus on the button it started from', async () => {
    const withGithub = {
      ...ALL_OFF,
      external: { ...ALL_OFF.external, github: true },
    }
    const { fetchImpl } = settingsEndpoint(withGithub)
    const auth = createFakeAuth({ settled: null })
    const { restore } = renderButtons(
      auth,
      fetchImpl as typeof globalThis.fetch
    )

    const button = await screen.findByRole('button', {
      name: 'Continue with GitHub',
    })
    button.focus()
    fireEvent.click(button)

    /*
     * `aria-disabled` while the redirect is being prepared, never `disabled`:
     * a disabled element cannot hold focus, and this is the button a keyboard
     * user pressed Enter on.
     */
    await waitFor(() =>
      expect(button.getAttribute('aria-disabled')).toBe('true')
    )
    expect(button.hasAttribute('disabled')).toBe(false)
    expect(document.activeElement).toBe(button)
    await waitFor(() => expect(auth.calls.signInWithOAuth).toHaveLength(1))
    restore()
  })
})
