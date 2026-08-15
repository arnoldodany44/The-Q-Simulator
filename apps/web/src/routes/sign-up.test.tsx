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
import { MemoryRouter } from 'react-router'
import { afterEach, describe, expect, it } from 'vitest'

import { MIN_PASSWORD_LENGTH, SessionProvider } from '../features/auth'
import {
  TEST_SUPABASE_CONFIG,
  authError,
  createFakeAuth,
  fakeSession,
} from '../features/auth/testing.js'
import type { FakeAuthPort } from '../features/auth/testing.js'
import enAuth from '../i18n/locales/en/auth.json'
import enCommon from '../i18n/locales/en/common.json'
import esAuth from '../i18n/locales/es/auth.json'
import esCommon from '../i18n/locales/es/common.json'
import frAuth from '../i18n/locales/fr/auth.json'
import frCommon from '../i18n/locales/fr/common.json'
import { SignUpRoute } from './sign-up'

/**
 * The screen this project's configuration makes load-bearing.
 *
 * `mailer_autoconfirm` is false, so registering does not sign anybody in.
 * A screen that does not say so hands a new user a login form that rejects
 * their brand-new, correct password — and the honest conclusion from there is
 * that the app is broken. So the notice is asserted twice: before the attempt,
 * where it changes what the user does next, and after it, naming the address.
 *
 * The other assertion worth its weight is the negative one about the password
 * rule. Six characters is what the project enforces, measured against the
 * live auth server; a form that demanded eight would refuse a password the
 * account would have accepted, and would teach a rule nobody applies.
 */

afterEach(cleanup)

type Language = 'en' | 'es' | 'fr'

const CATALOGS = {
  en: { auth: enAuth, common: enCommon },
  es: { auth: esAuth, common: esCommon },
  fr: { auth: frAuth, common: frCommon },
} as const

function i18nFor(language: Language): I18n {
  const instance = createInstance()
  void instance.use(initReactI18next).init({
    lng: language,
    fallbackLng: false,
    ns: ['auth', 'common'],
    defaultNS: 'auth',
    resources: CATALOGS,
    interpolation: { escapeValue: false },
    react: { useSuspense: false },
  })
  return instance
}

/** The live document: email on, confirmation on, registration open. */
const LIVE_SETTINGS = {
  external: { email: true, phone: false, github: false, google: false },
  disable_signup: false,
  mailer_autoconfirm: false,
}

interface OpenOptions {
  readonly auth?: FakeAuthPort
  readonly language?: Language
  readonly settings?: unknown
}

function open({
  auth = createFakeAuth({ settled: null }),
  language = 'en',
  settings = LIVE_SETTINGS,
}: OpenOptions = {}) {
  // What the project reports about itself — whether registration is open and
  // whether a confirmation email is coming. Both drive this screen's copy.
  const originalFetch = globalThis.fetch
  globalThis.fetch = () =>
    Promise.resolve(
      new Response(JSON.stringify(settings), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      })
    )

  const view = render(
    <I18nextProvider i18n={i18nFor(language)}>
      <QueryClientProvider client={new QueryClient()}>
        <SessionProvider
          runtime={{ auth, config: TEST_SUPABASE_CONFIG }}
          origin="https://qsim.test"
        >
          <MemoryRouter initialEntries={['/sign-up']}>
            <SignUpRoute />
          </MemoryRouter>
        </SessionProvider>
      </QueryClientProvider>
    </I18nextProvider>
  )

  return {
    ...view,
    auth,
    restore: () => {
      globalThis.fetch = originalFetch
    },
  }
}

function describedBy(field: HTMLElement): string {
  return (field.getAttribute('aria-describedby') ?? '')
    .split(/\s+/)
    .filter((id) => id !== '')
    .map((id) => document.getElementById(id)?.textContent ?? '')
    .join(' ')
}

function fill(label: string, value: string): void {
  fireEvent.change(screen.getByLabelText(label), { target: { value } })
}

describe('before anything is submitted', () => {
  it('warns that a confirmation link is coming and that sign-in will not work yet', async () => {
    const { restore } = open()

    // Present from the first paint: it is what the reader is deciding on,
    // not a response to something they did.
    expect(
      await screen.findByText(enAuth.signUp.confirmationWarning)
    ).toBeDefined()
    restore()
  })

  it('does not warn when the project confirms addresses automatically', async () => {
    const { restore } = open({
      settings: { ...LIVE_SETTINGS, mailer_autoconfirm: true },
    })

    await waitFor(() => {
      expect(screen.queryByText(enAuth.signUp.confirmationWarning)).toBeNull()
    })
    restore()
  })

  it('states the password rule, attached to the password field', () => {
    const { restore } = open()

    const password = screen.getByLabelText('Password')
    expect(password.getAttribute('autocomplete')).toBe('new-password')
    // Announced with the field rather than merely printed near it.
    expect(describedBy(password)).toContain(String(MIN_PASSWORD_LENGTH))
    restore()
  })

  it('says so and offers no form when registration is closed', async () => {
    const { auth, restore } = open({
      settings: { ...LIVE_SETTINGS, disable_signup: true },
    })

    expect(await screen.findByText(enAuth.signUp.closed)).toBeDefined()
    expect(screen.queryByLabelText('Email address')).toBeNull()
    expect(auth.calls.signUp).toHaveLength(0)
    restore()
  })
})

describe('the password rule', () => {
  it('rejects one character short of the project minimum, without asking the server', async () => {
    const { auth, restore } = open()
    fill('Email address', 'ada@example.test')
    fill('Password', 'abcde')

    fireEvent.click(screen.getByRole('button', { name: 'Create account' }))

    const password = screen.getByLabelText('Password')
    await waitFor(() => {
      expect(password.getAttribute('aria-invalid')).toBe('true')
    })
    expect(describedBy(password)).toContain('6')
    expect(document.activeElement).toBe(password)
    expect(auth.calls.signUp).toHaveLength(0)
    restore()
  })

  it('accepts exactly the minimum, because that is what the server accepts', async () => {
    const { auth, restore } = open()
    fill('Email address', 'ada@example.test')
    fill('Password', 'abcdef')

    fireEvent.click(screen.getByRole('button', { name: 'Create account' }))

    await waitFor(() => {
      expect(auth.calls.signUp).toHaveLength(1)
    })
    expect(auth.calls.signUp[0]?.password).toBe('abcdef')
    // The link Supabase mails comes back to this deployment's own origin.
    expect(auth.calls.signUp[0]?.emailRedirectTo).toBe('https://qsim.test')
    restore()
  })
})

describe('after a successful registration', () => {
  it.each(['en', 'es', 'fr'] as const)(
    'says a link is on its way, and to whom, in "%s"',
    async (language) => {
      const catalog = CATALOGS[language].auth
      const { restore } = open({ language })

      fill(catalog.fields.email, 'ada@example.test')
      fill(catalog.fields.password, 'abcdef')
      fireEvent.click(
        screen.getByRole('button', { name: catalog.signUp.submit })
      )

      /*
       * Found through its own sentence rather than by role: the in-flight
       * line is also a status region, and picking "the first status" would
       * make this assertion a race between two correct pieces of the screen.
       */
      const notice = (await screen.findByText(catalog.signUp.nextStep))
        .parentElement

      expect(notice?.getAttribute('role')).toBe('status')
      expect(notice?.textContent).toContain('ada@example.test')
      // The form is gone: there is nothing more to do here until the inbox
      // has been opened.
      expect(screen.queryByLabelText(catalog.fields.password)).toBeNull()
      restore()
    }
  )

  it('leaves the redirect to the session when a session actually came back', async () => {
    /*
     * A project with confirmation off answers sign-up with a session. The
     * guard around this route then moves the user, so the screen must NOT
     * also claim an email is coming — it is not.
     */
    const auth = createFakeAuth({ settled: null })
    auth.script.signUpSession = fakeSession('usr_1', 'ada@example.test')
    const { restore } = open({ auth })

    fill('Email address', 'ada@example.test')
    fill('Password', 'abcdef')
    fireEvent.click(screen.getByRole('button', { name: 'Create account' }))

    await waitFor(() => {
      expect(auth.calls.signUp).toHaveLength(1)
    })
    expect(screen.queryByRole('status')).toBeNull()
    restore()
  })

  it('answers an address that is already registered exactly the same way', async () => {
    /*
     * Supabase, with confirmation on, replies to a sign-up for a known
     * address with a user and no session — indistinguishable from a new
     * registration. Preserved here on purpose: "that email is taken" turns a
     * public form into a membership oracle.
     */
    const { restore } = open()
    fill('Email address', 'already@example.test')
    fill('Password', 'abcdef')
    fireEvent.click(screen.getByRole('button', { name: 'Create account' }))

    const notice = (await screen.findByText(enAuth.signUp.nextStep))
      .parentElement
    expect(notice?.textContent).toContain('already@example.test')
    expect(notice?.textContent).not.toContain('exists')
    restore()
  })
})

describe('when the server refuses', () => {
  it('renders the sentence for the code, not the code', async () => {
    const auth = createFakeAuth({ settled: null })
    auth.script.signUpError = authError('user_already_exists', 422)
    const { restore } = open({ auth })

    fill('Email address', 'ada@example.test')
    fill('Password', 'abcdef')
    fireEvent.click(screen.getByRole('button', { name: 'Create account' }))

    const alert = await screen.findByRole('alert')
    expect(alert.textContent).toBe(enAuth.errors.EMAIL_ALREADY_REGISTERED)
    // The form is still there, because there is something to change.
    expect(screen.getByLabelText('Email address')).toBeDefined()
    restore()
  })

  it('maps the server saying the password is weak to its own sentence', async () => {
    // The client's rule and the server's can disagree — a policy raised in
    // the dashboard tomorrow arrives this way — and the server always wins.
    const auth = createFakeAuth({ settled: null })
    auth.script.signUpError = authError('weak_password', 422)
    const { restore } = open({ auth })

    fill('Email address', 'ada@example.test')
    fill('Password', 'abcdef')
    fireEvent.click(screen.getByRole('button', { name: 'Create account' }))

    expect((await screen.findByRole('alert')).textContent).toBe(
      enAuth.errors.WEAK_PASSWORD
    )
    restore()
  })
})
