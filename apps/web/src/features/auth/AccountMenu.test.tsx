import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import {
  act,
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

import enCommon from '../../i18n/locales/en/common.json'
import esCommon from '../../i18n/locales/es/common.json'
import frCommon from '../../i18n/locales/fr/common.json'
import { AccountMenu } from './AccountMenu.js'
import { SessionProvider } from './SessionProvider.js'
import { TEST_SUPABASE_CONFIG, createFakeAuth, fakeSession } from './testing.js'
import type { FakeAuthPort } from './testing.js'

/**
 * The header control, and the flash it must not produce.
 *
 * The assertion that separates a correct menu from the usual one is negative:
 * while the stored session is still being read, the header shows **neither**
 * shape. A menu written against `user: User | null` renders "Sign in" for the
 * frame or two that read takes, on every hard refresh, to a user who is
 * signed in — and on a slow refresh that is long enough to click, which
 * navigates them to a sign-in screen that immediately bounces them back.
 *
 * Everything else here is ordinary: the identity is on screen, the two
 * destinations exist, and the popup behaves like a popup for somebody with no
 * mouse.
 */

afterEach(cleanup)

type Language = 'en' | 'es' | 'fr'

function i18nFor(language: Language): I18n {
  const instance = createInstance()
  void instance.use(initReactI18next).init({
    lng: language,
    fallbackLng: false,
    ns: ['common'],
    defaultNS: 'common',
    resources: {
      en: { common: enCommon },
      es: { common: esCommon },
      fr: { common: frCommon },
    },
    interpolation: { escapeValue: false },
    react: { useSuspense: false },
  })
  return instance
}

function mount(auth: FakeAuthPort | null, language: Language = 'en') {
  return render(
    <I18nextProvider i18n={i18nFor(language)}>
      <QueryClientProvider client={new QueryClient()}>
        <SessionProvider
          runtime={
            auth === null ? null : { auth, config: TEST_SUPABASE_CONFIG }
          }
          origin="https://qsim.test"
        >
          <MemoryRouter initialEntries={['/']}>
            <AccountMenu />
          </MemoryRouter>
        </SessionProvider>
      </QueryClientProvider>
    </I18nextProvider>
  )
}

describe('while the session is unknown', () => {
  it('offers neither a sign-in link nor an account button', () => {
    // `createFakeAuth()` without `settled` holds `getSession()` open, which is
    // exactly the window supabase-js spends reading localStorage.
    mount(createFakeAuth())

    expect(screen.queryByRole('link')).toBeNull()
    expect(screen.queryByRole('button')).toBeNull()
  })
})

describe('when nobody is signed in', () => {
  it('offers a way in', async () => {
    const auth = createFakeAuth({ settled: null })
    mount(auth)

    const link = await screen.findByRole('link', { name: 'Sign in' })
    expect(link.getAttribute('href')).toBe('/sign-in')
  })
})

describe('when somebody is signed in', () => {
  async function open(language: Language = 'en') {
    const auth = createFakeAuth({
      settled: fakeSession('usr_1', 'ada@example.test'),
    })
    mount(auth, language)
    const toggle = await screen.findByRole('button', {
      name: /ada@example\.test/,
    })
    return { auth, toggle }
  }

  it('says who you are before the menu is even opened', async () => {
    const { toggle } = await open()

    // The visible label is the identity; the accessible name adds what the
    // control does, and contains the visible text (WCAG 2.5.3).
    expect(toggle.textContent).toContain('ada@example.test')
    expect(toggle.getAttribute('aria-expanded')).toBe('false')
    // Nothing behind it is in the document until it is opened.
    expect(screen.queryByRole('link', { name: 'Your circuits' })).toBeNull()
  })

  it('reveals the identity, the circuits and the way out', async () => {
    const { toggle } = await open()

    fireEvent.click(toggle)

    expect(toggle.getAttribute('aria-expanded')).toBe('true')
    expect(screen.getByText('Signed in as ada@example.test')).toBeDefined()
    expect(
      screen.getByRole('link', { name: 'Your circuits' }).getAttribute('href')
    ).toBe('/circuits')
    expect(screen.getByRole('button', { name: 'Sign out' })).toBeDefined()
  })

  it('names the panel it controls', async () => {
    const { toggle } = await open()
    fireEvent.click(toggle)

    const controls = toggle.getAttribute('aria-controls')
    expect(controls).toBeTruthy()
    expect(document.getElementById(controls!)).not.toBeNull()
  })

  it('closes on Escape and gives the keyboard back to the button', async () => {
    const { toggle } = await open()
    fireEvent.click(toggle)

    fireEvent.keyDown(document, { key: 'Escape' })

    expect(toggle.getAttribute('aria-expanded')).toBe('false')
    // Focus left on a removed element drops a keyboard user at the top of the
    // document, which is the usual way a popup breaks tab order.
    expect(document.activeElement).toBe(toggle)
  })

  it('closes when the pointer goes down somewhere else', async () => {
    const { toggle } = await open()
    fireEvent.click(toggle)

    fireEvent.pointerDown(document.body)

    expect(toggle.getAttribute('aria-expanded')).toBe('false')
  })

  it('signs out through the session layer, and never touches a token', async () => {
    const { auth, toggle } = await open()
    fireEvent.click(toggle)

    fireEvent.click(screen.getByRole('button', { name: 'Sign out' }))

    await waitFor(() => {
      expect(auth.calls.signOut).toBe(1)
    })

    // supabase-js is what drops the session; the menu follows the state.
    act(() => {
      auth.emit('SIGNED_OUT', null)
    })
    expect(await screen.findByRole('link', { name: 'Sign in' })).toBeDefined()
  })

  it('says so when signing out did not work', async () => {
    const { auth, toggle } = await open()
    auth.script.signOutError = { name: 'AuthRetryableFetchError' }
    fireEvent.click(toggle)

    fireEvent.click(screen.getByRole('button', { name: 'Sign out' }))

    /*
     * Silence here would leave somebody walking away from a shared machine
     * believing they had signed out, which is the one failure on this control
     * with a consequence beyond the screen.
     */
    expect((await screen.findByRole('alert')).textContent).toBe(
      enCommon.account.signOutFailed
    )
  })

  it('is translated, menu and identity alike', async () => {
    await open('fr')

    expect(
      await screen.findByRole('button', { name: /menu du compte/ })
    ).toBeDefined()
  })

  it('falls back to a name when the provider released no address', async () => {
    const auth = createFakeAuth({ settled: fakeSession('usr_2', null) })
    mount(auth)

    const toggle = await screen.findByRole('button', { name: /Your account/ })
    fireEvent.click(toggle)

    // "Signed in as {{email}}" with nothing to interpolate would read as a
    // sentence with a hole in it, so there is a second sentence for this.
    expect(screen.getByText('You are signed in.')).toBeDefined()
    expect(screen.getByRole('button', { name: 'Sign out' })).toBeDefined()
  })
})

describe('on a deployment with no Supabase project', () => {
  it('renders nothing at all', () => {
    // Phase 0's deployment. A sign-in link here would lead to a form whose
    // every action can only answer AUTH_UNAVAILABLE.
    const { container } = mount(null)
    expect(container.textContent).toBe('')
  })
})
