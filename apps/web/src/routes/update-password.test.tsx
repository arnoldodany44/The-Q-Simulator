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
import {
  TEST_SUPABASE_CONFIG,
  authError,
  createFakeAuth,
  fakeSession,
} from '../features/auth/testing.js'
import type { FakeAuthPort } from '../features/auth/testing.js'
import enAuth from '../i18n/locales/en/auth.json'
import enCommon from '../i18n/locales/en/common.json'
import { UpdatePasswordRoute } from './update-password'

/**
 * The end of the recovery flow, and the three states the link can leave the
 * page in.
 *
 * The one worth writing a test around is the middle one: while supabase-js is
 * exchanging the link's single-use code for a session, the page knows nothing
 * — and both of the things it could render are wrong. The form would invite a
 * password nobody can save yet, and the expired-link message would tell a user
 * whose link is perfectly good that it is broken. So the loading state renders
 * neither, and that is asserted negatively, which is the only way to catch a
 * two-state implementation that happens to pass everything else.
 */

afterEach(cleanup)

function i18n(): I18n {
  const instance = createInstance()
  void instance.use(initReactI18next).init({
    lng: 'en',
    fallbackLng: false,
    ns: ['auth', 'common'],
    defaultNS: 'auth',
    resources: { en: { auth: enAuth, common: enCommon } },
    interpolation: { escapeValue: false },
    react: { useSuspense: false },
  })
  return instance
}

function open(auth: FakeAuthPort) {
  return render(
    <I18nextProvider i18n={i18n()}>
      <QueryClientProvider client={new QueryClient()}>
        <SessionProvider
          runtime={{ auth, config: TEST_SUPABASE_CONFIG }}
          origin="https://qsim.test"
        >
          <MemoryRouter initialEntries={['/update-password']}>
            <UpdatePasswordRoute />
          </MemoryRouter>
        </SessionProvider>
      </QueryClientProvider>
    </I18nextProvider>
  )
}

/** The page with a recovery session already established. */
async function withRecoverySession(auth = createFakeAuth()) {
  open(auth)
  auth.settle(fakeSession('usr_1', 'ada@example.test'))
  await screen.findByLabelText('New password')
  return auth
}

function fill(label: string, value: string): void {
  fireEvent.change(screen.getByLabelText(label), { target: { value } })
}

function describedBy(field: HTMLElement): string {
  return (field.getAttribute('aria-describedby') ?? '')
    .split(/\s+/)
    .filter((id) => id !== '')
    .map((id) => document.getElementById(id)?.textContent ?? '')
    .join(' ')
}

describe('while the link is still being exchanged', () => {
  it('shows neither the form nor a claim that the link is dead', () => {
    // `createFakeAuth()` without `settled` holds the read open, which is the
    // window the PKCE code exchange occupies on a real load.
    open(createFakeAuth())

    expect(screen.queryByLabelText('New password')).toBeNull()
    expect(screen.queryByRole('alert')).toBeNull()
    // Something is on screen, and it announces itself.
    expect(screen.getByRole('status').textContent).toBe(enCommon.loading)
  })
})

describe('when the link did not establish a session', () => {
  it('explains that the link is spent and offers another', async () => {
    const auth = createFakeAuth()
    open(auth)
    auth.settle(null)

    expect((await screen.findByRole('alert')).textContent).toBe(
      enAuth.errors.LINK_EXPIRED
    )
    expect(screen.getByText(enAuth.update.expired)).toBeDefined()
    expect(
      screen
        .getByRole('link', { name: 'Ask for a new link' })
        .getAttribute('href')
    ).toBe('/reset-password')
    // No form: there is nothing this page can save without a session.
    expect(screen.queryByLabelText('New password')).toBeNull()
  })
})

describe('with a recovery session', () => {
  it('offers two fields a password manager will treat as a new password', async () => {
    await withRecoverySession()

    const password = screen.getByLabelText('New password')
    const repeat = screen.getByLabelText('Repeat the new password')

    expect(password.getAttribute('autocomplete')).toBe('new-password')
    expect(repeat.getAttribute('autocomplete')).toBe('new-password')
    // Two fields, two ids: one label pointing at the other's input is the
    // classic way a repeat field silently stops being labelled.
    expect(password.id).not.toBe(repeat.id)
    expect(describedBy(password)).toContain('6')
  })

  it('catches a mistyped repeat before it locks anybody out', async () => {
    const auth = await withRecoverySession()
    fill('New password', 'abcdef')
    fill('Repeat the new password', 'abcdeg')

    fireEvent.click(
      screen.getByRole('button', { name: 'Save the new password' })
    )

    const repeat = screen.getByLabelText('Repeat the new password')
    await waitFor(() => {
      expect(repeat.getAttribute('aria-invalid')).toBe('true')
    })
    expect(describedBy(repeat)).toBe(enAuth.validation.passwordMismatch)
    expect(document.activeElement).toBe(repeat)
    expect(auth.calls.updateUser).toHaveLength(0)
  })

  it('applies the project rule to the new password', async () => {
    const auth = await withRecoverySession()
    fill('New password', 'abcde')
    fill('Repeat the new password', 'abcde')

    fireEvent.click(
      screen.getByRole('button', { name: 'Save the new password' })
    )

    const password = screen.getByLabelText('New password')
    await waitFor(() => {
      expect(password.getAttribute('aria-invalid')).toBe('true')
    })
    expect(auth.calls.updateUser).toHaveLength(0)
  })

  it('saves, then says so and points somewhere useful', async () => {
    const auth = await withRecoverySession()
    fill('New password', 'a longer password')
    fill('Repeat the new password', 'a longer password')

    fireEvent.click(
      screen.getByRole('button', { name: 'Save the new password' })
    )

    await waitFor(() => {
      expect(auth.calls.updateUser).toEqual([{ password: 'a longer password' }])
    })
    expect(await screen.findByText(enAuth.update.done)).toBeDefined()
    expect(
      screen
        .getByRole('link', { name: 'Go to your circuits' })
        .getAttribute('href')
    ).toBe('/circuits')
    expect(screen.queryByLabelText('New password')).toBeNull()
  })

  it('renders the server sentence when the new password is the old one', async () => {
    const auth = await withRecoverySession()
    auth.script.updateUserError = authError('same_password', 422)
    fill('New password', 'abcdef')
    fill('Repeat the new password', 'abcdef')

    fireEvent.click(
      screen.getByRole('button', { name: 'Save the new password' })
    )

    expect((await screen.findByRole('alert')).textContent).toBe(
      enAuth.errors.SAME_PASSWORD
    )
    // Still on the form, because there is something to change.
    expect(screen.getByLabelText('New password')).toBeDefined()
  })
})
