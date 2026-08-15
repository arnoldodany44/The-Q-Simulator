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

import { SessionProvider } from '../features/auth'
import enAuth from '../i18n/locales/en/auth.json'
import enCommon from '../i18n/locales/en/common.json'
import esAuth from '../i18n/locales/es/auth.json'
import esCommon from '../i18n/locales/es/common.json'
import frAuth from '../i18n/locales/fr/auth.json'
import frCommon from '../i18n/locales/fr/common.json'
import {
  TEST_SUPABASE_CONFIG,
  authError,
  createFakeAuth,
} from '../features/auth/testing.js'
import type { FakeAuthPort } from '../features/auth/testing.js'
import { SignInRoute } from './sign-in'

/**
 * The screen a user meets when something has already gone wrong.
 *
 * Three things are worth pinning here, and they are the three that make this
 * a form rather than two inputs and a button:
 *
 *   - the fields are *labelled*, and their errors are attached to them rather
 *     than merely printed underneath. A message a screen reader never
 *     associates with the field is a message that is not there.
 *   - `EMAIL_NOT_CONFIRMED` does not read as a wrong password. This project
 *     has email confirmation switched on, so it is what a brand-new account
 *     hits, and telling that user their password is wrong sends them to reset
 *     a password that is perfectly correct.
 *   - the provider buttons are whatever `GET /auth/v1/settings` reports.
 *     Both directions are asserted, because only asserting the enabled one is
 *     how a hardcoded button passes review.
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

/** The live document: email on, every third-party provider off. */
const ALL_PROVIDERS_OFF = {
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
  settings = ALL_PROVIDERS_OFF,
}: OpenOptions = {}) {
  // The settings document the provider buttons are built from. Replaced on
  // `globalThis` because `fetchAuthSettings` reaches for the ambient `fetch`
  // when React Query calls it — there is no seam to inject through here.
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
          <MemoryRouter initialEntries={['/sign-in']}>
            <SignInRoute />
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

/** The text a field actually announces, following `aria-describedby`. */
function describedBy(field: HTMLElement): string {
  const ids = (field.getAttribute('aria-describedby') ?? '').split(/\s+/)
  return ids
    .filter((id) => id !== '')
    .map((id) => document.getElementById(id)?.textContent ?? '')
    .join(' ')
}

function fill(label: string, value: string): HTMLElement {
  const field = screen.getByLabelText(label)
  fireEvent.change(field, { target: { value } })
  return field
}

describe('the form itself', () => {
  it('labels both fields and lets a password manager fill them', () => {
    const { restore } = open()

    const email = screen.getByLabelText('Email address')
    const password = screen.getByLabelText('Password')

    // `username` + `current-password` is the pair a password manager keys off.
    // Without them it offers nothing here and saves nothing on sign-up, and
    // the user's answer to that is a password they can remember (WCAG 1.3.5).
    expect(email.getAttribute('autocomplete')).toBe('username')
    expect(email.getAttribute('type')).toBe('email')
    expect(password.getAttribute('autocomplete')).toBe('current-password')
    expect(password.getAttribute('type')).toBe('password')
    restore()
  })

  it('submits from the form, so Enter in a field works', async () => {
    const { auth, restore } = open()
    fill('Email address', 'ada@example.test')
    fill('Password', 'correct horse')

    // Not a click on the button: the handler has to be on the form, which is
    // what makes Return from inside a text input submit it.
    fireEvent.submit(
      screen.getByRole('button', { name: 'Sign in' }).closest('form')!
    )

    await waitFor(() => {
      expect(auth.calls.signInWithPassword).toHaveLength(1)
    })
    expect(auth.calls.signInWithPassword[0]).toEqual({
      email: 'ada@example.test',
      password: 'correct horse',
    })
    restore()
  })

  it('is operable with nothing but a keyboard', () => {
    const { restore } = open()

    const controls = [
      ...document.querySelectorAll('input, button, a, select'),
    ] as HTMLElement[]

    expect(controls.length).toBeGreaterThan(0)
    for (const control of controls) {
      const tabIndex = control.getAttribute('tabindex')
      // Nothing is removed from the tab order, and nothing jumps the queue:
      // a positive tabindex reorders the whole document around this form.
      expect(tabIndex === null || Number(tabIndex) === 0).toBe(true)
      expect(control.hasAttribute('disabled')).toBe(false)
    }
    restore()
  })

  it('offers the way on to registration and to a reset link', () => {
    const { restore } = open()

    expect(
      screen
        .getByRole('link', { name: 'Forgotten your password?' })
        .getAttribute('href')
    ).toBe('/reset-password')
    expect(
      screen.getByRole('link', { name: 'Create one' }).getAttribute('href')
    ).toBe('/sign-up')
    restore()
  })
})

describe('what it does with an empty form', () => {
  it('attaches a message to each field and focuses the first', async () => {
    const { auth, restore } = open()

    fireEvent.click(screen.getByRole('button', { name: 'Sign in' }))

    const email = screen.getByLabelText('Email address')
    const password = screen.getByLabelText('Password')

    await waitFor(() => {
      expect(email.getAttribute('aria-invalid')).toBe('true')
    })
    expect(describedBy(email)).toContain(enAuth.validation.emailRequired)
    expect(password.getAttribute('aria-invalid')).toBe('true')
    expect(describedBy(password)).toContain(enAuth.validation.passwordRequired)
    // The caret follows the first message, rather than staying wherever it
    // was while a live region talks about a field the user cannot find.
    expect(document.activeElement).toBe(email)
    // And nothing was sent.
    expect(auth.calls.signInWithPassword).toHaveLength(0)
    restore()
  })

  it('never invents a password rule sign-in does not have', async () => {
    // A five-character password predates any policy change and the account
    // may still have it. Refusing to even try it locks out the one user who
    // cannot afford it. See `passwordPolicy.ts`.
    const { auth, restore } = open()
    fill('Email address', 'ada@example.test')
    fill('Password', 'short')

    fireEvent.click(screen.getByRole('button', { name: 'Sign in' }))

    await waitFor(() => {
      expect(auth.calls.signInWithPassword).toHaveLength(1)
    })
    restore()
  })
})

describe('when the server refuses', () => {
  async function failWith(code: string, language: Language = 'en') {
    const auth = createFakeAuth({ settled: null })
    auth.script.signInError = authError(code)
    const { restore } = open({ auth, language })

    // Found by their translated labels, which is itself the assertion that
    // the whole screen is in the reader's language and not only its errors.
    const catalog = CATALOGS[language].auth
    fill(catalog.fields.email, 'ada@example.test')
    fill(catalog.fields.password, 'whatever')
    fireEvent.click(screen.getByRole('button', { name: catalog.signIn.submit }))

    const alert = await screen.findByRole('alert')
    const text = alert.textContent ?? ''
    restore()
    return text
  }

  it.each(['en', 'es', 'fr'] as const)(
    'tells a wrong password from an unconfirmed address in "%s"',
    async (language) => {
      const wrongPassword = await failWith('invalid_credentials', language)
      cleanup()
      const unconfirmed = await failWith('email_not_confirmed', language)

      expect(wrongPassword).toBe(
        CATALOGS[language].auth.errors.INVALID_CREDENTIALS
      )
      expect(unconfirmed).toBe(
        CATALOGS[language].auth.errors.EMAIL_NOT_CONFIRMED
      )
      expect(wrongPassword).not.toBe(unconfirmed)
    }
  )

  it('says to wait, not to retype, when the limit is the problem', async () => {
    expect(await failWith('over_request_rate_limit')).toBe(
      enAuth.errors.RATE_LIMITED
    )
  })

  it('does not blame the reader for the project`s own mail quota', async () => {
    /*
     * `over_email_send_rate_limit` is the deployment's hourly allowance for
     * outgoing messages. It trips on a first attempt from a fresh browser and
     * clears on the hour, so "too many attempts, wait a moment" was wrong
     * about the cause and wrong about the wait.
     */
    const shown = await failWith('over_email_send_rate_limit')
    expect(shown).toBe(enAuth.errors.EMAIL_SEND_LIMITED)
    expect(shown).not.toBe(enAuth.errors.RATE_LIMITED)
  })

  it('never shows Supabase its own English', async () => {
    // `authError()` carries the developer-facing message on purpose: finding
    // it on screen means the code path bypassed `authErrorMessageKey`.
    expect(await failWith('invalid_credentials')).not.toContain(
      'Developer-facing text'
    )
  })
})

describe('while the request is in flight', () => {
  it('refuses a second submit, says what is happening, and keeps focus', async () => {
    const auth = createFakeAuth({ settled: null })
    let release = (): void => {}
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    /*
     * The fake port answers immediately, which is the wrong shape for this
     * one assertion: the window being tested is the one where the answer has
     * not arrived. Holding `signInWithPassword` open makes it a state the
     * test can look at rather than a frame it has to race.
     */
    const slow: FakeAuthPort = {
      ...auth,
      signInWithPassword: async (credentials) => {
        auth.calls.signInWithPassword.push(credentials)
        await gate
        return { error: authError('invalid_credentials') }
      },
    }
    const { restore } = open({ auth: slow })

    fill('Email address', 'ada@example.test')
    fill('Password', 'whatever')
    const pressed = screen.getByRole('button', { name: 'Sign in' })
    pressed.focus()
    fireEvent.click(pressed)

    const submit = screen.getByRole('button', { name: 'Sign in' })
    /*
     * `aria-disabled`, not `disabled`. A disabled element cannot hold focus,
     * so disabling the button somebody pressed Enter on handed the caret to
     * the document body — the focus ring gone, Tab restarting from the top of
     * the page, seven stops from the field that needed correcting.
     */
    expect(submit.getAttribute('aria-disabled')).toBe('true')
    expect(submit.hasAttribute('disabled')).toBe(false)
    expect(document.activeElement).toBe(submit)
    expect(screen.getByRole('status').textContent).toBe(enAuth.signIn.pending)

    // Inert all the same: a second press while the first is in flight sends
    // nothing.
    fireEvent.click(submit)
    expect(auth.calls.signInWithPassword).toHaveLength(1)

    release()

    // Available again once there is something to correct, and not before.
    await waitFor(() => {
      expect(
        screen
          .getByRole('button', { name: 'Sign in' })
          .getAttribute('aria-disabled')
      ).toBe('false')
    })
    expect(auth.calls.signInWithPassword).toHaveLength(1)
    expect(document.activeElement).toBe(
      screen.getByRole('button', { name: 'Sign in' })
    )
    restore()
  })
})

describe('the provider buttons', () => {
  it('appear when the project reports one enabled, with no code change', async () => {
    const { auth, restore } = open({
      settings: {
        ...ALL_PROVIDERS_OFF,
        external: { ...ALL_PROVIDERS_OFF.external, github: true },
      },
    })

    const button = await screen.findByRole('button', {
      name: 'Continue with GitHub',
    })
    fireEvent.click(button)

    await waitFor(() => {
      expect(auth.calls.signInWithOAuth).toHaveLength(1)
    })
    expect(auth.calls.signInWithOAuth[0]).toEqual({
      provider: 'github',
      // Back to where the guard was sending them — the app root here, since
      // this render carries no intended path.
      redirectTo: 'https://qsim.test/',
    })
    restore()
  })

  it('are absent when the project reports them off, which is today', async () => {
    const { restore } = open()

    await waitFor(() => {
      expect(screen.queryByRole('list')).toBeNull()
    })
    // Only the form's own submit remains.
    expect(screen.getAllByRole('button')).toHaveLength(1)
    restore()
  })
})

describe('an account that has not confirmed its address', () => {
  it('offers another link, which is the only thing that unblocks it', async () => {
    /*
     * The dead end this closes. With confirmation on, the account cannot sign
     * in, the screen says so correctly in three languages — and there was no
     * link, no button, and no sentence saying that submitting sign-up again
     * would send one. `auth.resend` was never called from anywhere in the app.
     */
    const auth = createFakeAuth({ settled: null })
    auth.script.signInError = authError('email_not_confirmed', 400)
    const { restore } = open({ auth })

    fill('Email address', 'ada@example.test')
    fill('Password', 'whatever')
    fireEvent.click(screen.getByRole('button', { name: 'Sign in' }))

    expect((await screen.findByRole('alert')).textContent).toBe(
      enAuth.errors.EMAIL_NOT_CONFIRMED
    )

    fireEvent.click(
      screen.getByRole('button', { name: enAuth.confirmation.resend })
    )

    await waitFor(() => expect(auth.calls.resend).toHaveLength(1))
    expect(auth.calls.resend[0]?.email).toBe('ada@example.test')
    expect(
      await screen.findByText(/Another link is on its way to ada@example.test/u)
    ).toBeDefined()
    restore()
  })

  it('is not offered for a wrong password, which another link cannot fix', async () => {
    const auth = createFakeAuth({ settled: null })
    auth.script.signInError = authError('invalid_credentials', 400)
    const { restore } = open({ auth })

    fill('Email address', 'ada@example.test')
    fill('Password', 'whatever')
    fireEvent.click(screen.getByRole('button', { name: 'Sign in' }))

    await screen.findByRole('alert')
    expect(
      screen.queryByRole('button', { name: enAuth.confirmation.resend })
    ).toBeNull()
    restore()
  })
})

describe('a project with the email provider switched off', () => {
  it('does not offer the form that can only fail', async () => {
    /*
     * `settings.emailEnabled` was computed and then read by no screen, so a
     * project answering `email: false` still rendered the form — and every
     * submit came back with a sentence telling the reader to use the email
     * address and password that had just been refused.
     */
    const { restore } = open({
      settings: {
        ...ALL_PROVIDERS_OFF,
        external: { ...ALL_PROVIDERS_OFF.external, email: false, github: true },
      },
    })

    expect(await screen.findByText(enAuth.signIn.emailDisabled)).toBeDefined()
    expect(screen.queryByLabelText('Email address')).toBeNull()
    expect(screen.queryByLabelText('Password')).toBeNull()
    // The methods that do work are still offered.
    expect(
      await screen.findByRole('button', { name: 'Continue with GitHub' })
    ).toBeDefined()
    restore()
  })
})
