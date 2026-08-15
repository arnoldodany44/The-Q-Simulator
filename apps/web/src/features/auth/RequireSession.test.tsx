import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { cleanup, render, screen, waitFor } from '@testing-library/react'
import { createInstance, type i18n as I18n } from 'i18next'
import { I18nextProvider, initReactI18next } from 'react-i18next'
import { MemoryRouter, Route, Routes, useLocation } from 'react-router'
import { afterEach, describe, expect, it } from 'vitest'

import enCommon from '../../i18n/locales/en/common.json'
import { RedirectWhenSignedIn, RequireSession } from './RequireSession.js'
import { SessionProvider } from './SessionProvider.js'
import {
  DEFAULT_SIGNED_IN_PATH,
  INTENDED_PATH_STATE_KEY,
  SIGN_IN_PATH,
} from './paths.js'
import { TEST_SUPABASE_CONFIG, createFakeAuth, fakeSession } from './testing.js'
import type { FakeAuthPort } from './testing.js'

/**
 * Both guards, and the two flashes they exist to prevent.
 *
 * The assertions that matter are the negative ones. "Redirects an anonymous
 * visitor" is easy and would pass on the broken implementation too; what
 * separates a correct guard from the common one is that during the loading
 * window it renders **neither** the protected content nor the login screen.
 * A guard that treats not-yet-known as signed-out passes every positive
 * assertion in this file and fails exactly two of them.
 */

afterEach(cleanup)

const PROTECTED = 'the private circuit'
const SIGN_IN_FORM = 'the sign-in form'

function i18n(): I18n {
  const instance = createInstance()
  void instance.use(initReactI18next).init({
    lng: 'en',
    fallbackLng: 'en',
    ns: ['common'],
    defaultNS: 'common',
    resources: { en: { common: enCommon } },
    interpolation: { escapeValue: false },
    react: { useSuspense: false },
  })
  return instance
}

/** Renders the current location so a redirect can be asserted precisely. */
function LocationProbe() {
  const location = useLocation()
  const state = location.state as Record<string, unknown> | null
  const intended = state?.[INTENDED_PATH_STATE_KEY]
  return (
    <div>
      <p data-testid="path">{`${location.pathname}${location.search}`}</p>
      {/* Only a string is rendered, so a wrong shape shows as empty rather
          than as "[object Object]" quietly passing an assertion. */}
      <p data-testid="intended">
        {typeof intended === 'string' ? intended : ''}
      </p>
      <p>{SIGN_IN_FORM}</p>
    </div>
  )
}

function renderAt(
  auth: FakeAuthPort,
  path: string,
  element: React.ReactNode = (
    <RequireSession>
      <p>{PROTECTED}</p>
    </RequireSession>
  )
) {
  return render(
    <I18nextProvider i18n={i18n()}>
      <QueryClientProvider client={new QueryClient()}>
        <SessionProvider
          runtime={{ auth, config: TEST_SUPABASE_CONFIG }}
          origin="https://qsim.test"
        >
          <MemoryRouter initialEntries={[path]}>
            <Routes>
              <Route path="/c/:slug" element={element} />
              <Route path="/new" element={element} />
              <Route path={SIGN_IN_PATH} element={<LocationProbe />} />
              <Route
                path={DEFAULT_SIGNED_IN_PATH}
                element={<LocationProbe />}
              />
            </Routes>
          </MemoryRouter>
        </SessionProvider>
      </QueryClientProvider>
    </I18nextProvider>
  )
}

describe('RequireSession', () => {
  it('renders neither the page nor a redirect while the session is unknown', () => {
    /*
     * The defect this pins: a guard that reads "not yet known" as "signed
     * out" bounces an authenticated user to the login screen for a frame on
     * every hard refresh. Here the read is still in flight, and the correct
     * behaviour is to commit to nothing.
     */
    const auth = createFakeAuth()
    renderAt(auth, '/c/bell')

    expect(screen.queryByText(PROTECTED)).toBeNull()
    expect(screen.queryByText(SIGN_IN_FORM)).toBeNull()
    // Something is on screen, and it announces itself.
    expect(screen.getByRole('status').textContent).toBe('Loading…')
  })

  it('renders the page once the session resolves to a user', async () => {
    const auth = createFakeAuth()
    renderAt(auth, '/c/bell')

    auth.settle(fakeSession('ada'))

    expect(await screen.findByText(PROTECTED)).toBeDefined()
    expect(screen.queryByText(SIGN_IN_FORM)).toBeNull()
  })

  it('redirects an anonymous visitor to sign-in', async () => {
    const auth = createFakeAuth()
    renderAt(auth, '/c/bell')

    auth.settle(null)

    await waitFor(() =>
      expect(screen.getByTestId('path').textContent).toBe(SIGN_IN_PATH)
    )
    expect(screen.queryByText(PROTECTED)).toBeNull()
  })

  it('remembers where the visitor was going, query string included', async () => {
    const auth = createFakeAuth()
    renderAt(auth, '/new?example=bell')

    auth.settle(null)

    await waitFor(() =>
      expect(screen.getByTestId('intended').textContent).toBe(
        '/new?example=bell'
      )
    )
  })

  it('keeps the destination out of the URL', async () => {
    /*
     * An UNLISTED circuit's slug is its access control (§11). A `?next=`
     * parameter would copy it into history, into the Referer header of every
     * request the sign-in page makes, and into anything the user pastes.
     */
    const auth = createFakeAuth()
    renderAt(auth, '/c/bell')

    auth.settle(null)

    await waitFor(() =>
      expect(screen.getByTestId('intended').textContent).toBe('/c/bell')
    )
    expect(screen.getByTestId('path').textContent).toBe(SIGN_IN_PATH)
    expect(screen.getByTestId('path').textContent).not.toContain('bell')
  })
})

describe('RedirectWhenSignedIn', () => {
  const form = (
    <RedirectWhenSignedIn>
      <p>{SIGN_IN_FORM}</p>
    </RedirectWhenSignedIn>
  )

  function renderSignIn(auth: FakeAuthPort) {
    return render(
      <I18nextProvider i18n={i18n()}>
        <QueryClientProvider client={new QueryClient()}>
          <SessionProvider
            runtime={{ auth, config: TEST_SUPABASE_CONFIG }}
            origin="https://qsim.test"
          >
            <MemoryRouter initialEntries={[SIGN_IN_PATH]}>
              <Routes>
                <Route path={SIGN_IN_PATH} element={form} />
                <Route
                  path={DEFAULT_SIGNED_IN_PATH}
                  element={<p>{PROTECTED}</p>}
                />
              </Routes>
            </MemoryRouter>
          </SessionProvider>
        </QueryClientProvider>
      </I18nextProvider>
    )
  }

  it('does not flash a login form at a user who is already signed in', async () => {
    /*
     * The mirror of the first defect, and slightly worse: the form is
     * focusable in that window, so a fast typist loses a keystroke into a
     * component that is about to unmount.
     */
    const auth = createFakeAuth()
    renderSignIn(auth)

    expect(screen.queryByText(SIGN_IN_FORM)).toBeNull()
    expect(screen.getByRole('status')).toBeDefined()

    auth.settle(fakeSession('ada'))

    expect(await screen.findByText(PROTECTED)).toBeDefined()
    expect(screen.queryByText(SIGN_IN_FORM)).toBeNull()
  })

  it('shows the form once the session resolves to nobody', async () => {
    const auth = createFakeAuth()
    renderSignIn(auth)

    auth.settle(null)

    expect(await screen.findByText(SIGN_IN_FORM)).toBeDefined()
  })
})
