/**
 * Adversarial verification — a session the app believes in and the server does
 * not.
 *
 * ── The state this exists to make impossible ──────────────────────────────
 *
 * supabase-js only checks a stored session's *expiry*. A token whose signature
 * no longer verifies — the project's JWT key was rotated, the user was deleted
 * server-side — is therefore served happily to every request, while the API
 * answers `AUTH_INVALID_TOKEN` to all of them. Driven in the browser by
 * breaking the third JWT segment in `localStorage`: the header went on showing
 * the account menu with the user's email, `/circuits` showed "Your session is
 * no longer valid. Sign in again." beside a Try again button that failed
 * identically every time, and there was no sign-in control anywhere on the
 * page. The only way out was guessing that "Sign out" is what fixes "Sign in
 * again".
 *
 * `lib/api/errors.ts` has carried `requiresAuthentication` for exactly this
 * case since M1.3 and no screen called it.
 *
 * ── Why this is one subscription and not a check per screen ───────────────
 *
 * Any query can be the one that discovers the token is dead, and a rule that
 * has to be repeated on every screen is a rule some screen will miss. It is
 * also keyed on the *API's* answer rather than on anything the client guesses:
 * `accessToken.ts` reads through `getSession()`, which refreshes an expired
 * token before handing it over, so a 401 that survives that is a credential
 * the server will not accept at all.
 */

import { QueryClientProvider, useQuery } from '@tanstack/react-query'
import { cleanup, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import type { ReactNode } from 'react'

import { SessionProvider } from '../../features/auth/SessionProvider.js'
import {
  TEST_SUPABASE_CONFIG,
  createFakeAuth,
  fakeSession,
} from '../../features/auth/testing.js'
import type { FakeAuthPort } from '../../features/auth/testing.js'
import { ApiRequestError } from '../../lib/api/errors.js'
import { circuitKeys } from '../../lib/api/queryKeys.js'
import { createQueryClient } from '../../lib/api/queryClient.js'

afterEach(cleanup)

function mount(auth: FakeAuthPort, fetcher: () => Promise<string>) {
  const queryClient = createQueryClient()

  function Listing() {
    const query = useQuery({
      queryKey: circuitKeys.list({ page: 1 }),
      queryFn: fetcher,
      retry: false,
    })
    return <p>{query.isError ? 'refused' : (query.data ?? 'loading')}</p>
  }

  function Tree({ children }: { readonly children: ReactNode }) {
    return (
      <QueryClientProvider client={queryClient}>
        <SessionProvider
          runtime={{ auth, config: TEST_SUPABASE_CONFIG }}
          origin="https://app.test"
        >
          {children}
        </SessionProvider>
      </QueryClientProvider>
    )
  }

  return render(<Listing />, { wrapper: Tree })
}

describe('a token the API refuses', () => {
  it('ends the client session instead of leaving it looking signed in', async () => {
    const auth = createFakeAuth({ settled: fakeSession('user-a') })
    const fetcher = () =>
      Promise.reject(new ApiRequestError('AUTH_INVALID_TOKEN', { status: 401 }))

    mount(auth, fetcher)

    await screen.findByText('refused')
    await waitFor(() => {
      expect(auth.calls.signOut).toBe(1)
    })
  })

  it('leaves a 403 alone, because signing out cannot help it', async () => {
    /*
     * "We know exactly who you are and this is not yours." Bouncing that user
     * to a sign-in screen is the failure `lib/api/errors.ts` keeps 401 and 403
     * apart to prevent.
     */
    const auth = createFakeAuth({ settled: fakeSession('user-a') })
    const fetcher = () =>
      Promise.reject(new ApiRequestError('FORBIDDEN', { status: 403 }))

    mount(auth, fetcher)

    await screen.findByText('refused')
    await new Promise((resolve) => setTimeout(resolve, 50))
    expect(auth.calls.signOut).toBe(0)
  })

  it('does not sign out an anonymous reader who was refused', async () => {
    // `GET /circuits` answers 401 to a visitor with no session at all, which
    // is not news about a credential and not something to react to.
    const auth = createFakeAuth({ settled: null })
    const fetcher = () =>
      Promise.reject(new ApiRequestError('AUTH_REQUIRED', { status: 401 }))

    mount(auth, fetcher)

    await screen.findByText('refused')
    await new Promise((resolve) => setTimeout(resolve, 50))
    expect(auth.calls.signOut).toBe(0)
  })
})
