/**
 * Adversarial verification — two people, one browser, one mounted route.
 *
 * ── The claim under test ──────────────────────────────────────────────────
 *
 * `SessionProvider` evicts the query cache when the signed-in user changes,
 * and its header states the guarantee it believes that buys:
 *
 *   "a mounted query renders nothing of the previous identity and the active
 *    ones refetch immediately under the new one"
 *
 * `QueryCache.clear()` does not buy it, which is what these tests were first
 * written to record: clearing removes and destroys the entries, but a
 * `QueryObserver` that is already subscribed keeps the result it last computed
 * and is never asked to fetch again — so a component mounted across the
 * identity change went on rendering the previous user's data indefinitely,
 * without a single request going out. `resetQueries()` is the fix, because it
 * notifies the observers it resets.
 *
 * On a guarded route none of this shows: `RequireSession` sends the anonymous
 * visitor away and the route unmounts, which is what empties the screen. The
 * editor at `/c/:slug` is deliberately **not** guarded — a PUBLIC circuit has
 * to be readable by anyone — so it stays mounted through the sign-out and
 * through the next sign-in, and that is where one user's private circuit
 * stayed on screen for the next one. Driven in a real browser, the header
 * showed the second user's email above the first user's PRIVATE circuit title,
 * with no request made in between.
 *
 * ── These assertions are the guarantee, not the behaviour ─────────────────
 *
 * They fail against `clear()` and pass against `resetQueries()`. Nothing below
 * may be weakened to accommodate an implementation: the second user seeing the
 * first user's private title is the defect this file exists to keep out.
 */

import { QueryClientProvider, useQuery } from '@tanstack/react-query'
import { cleanup, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ReactNode } from 'react'

import { SessionProvider } from '../../features/auth/SessionProvider.js'
import {
  TEST_SUPABASE_CONFIG,
  createFakeAuth,
  fakeSession,
} from '../../features/auth/testing.js'
import type { FakeAuthPort } from '../../features/auth/testing.js'
import { circuitKeys } from '../../lib/api/queryKeys.js'
import { createQueryClient } from '../../lib/api/queryClient.js'

afterEach(cleanup)

const PRIVATE_TITLE = 'A PRIVATE CIRCUIT'
/** What the API answers a second user for a circuit that is not theirs. */
const NOT_FOUND = new Error('CIRCUIT_NOT_FOUND')

/**
 * Stands in for the editor at `/c/:slug`: it reads one circuit through React
 * Query and — like the real route — is not behind `RequireSession`, so it is
 * never unmounted by a change of user.
 */
function UnguardedCircuitView({
  fetcher,
}: {
  readonly fetcher: () => Promise<string>
}) {
  const query = useQuery({
    queryKey: circuitKeys.detail('a-private-slug'),
    queryFn: fetcher,
    // Nothing about this defect is a retry story, and three of them would only
    // make the assertions below wait longer for the same answer.
    retry: false,
  })
  return <p>{query.data ?? 'no circuit'}</p>
}

function mount(auth: FakeAuthPort, fetcher: () => Promise<string>) {
  const queryClient = createQueryClient()
  const runtime = { auth, config: TEST_SUPABASE_CONFIG }

  function Tree({ children }: { readonly children: ReactNode }) {
    return (
      <QueryClientProvider client={queryClient}>
        <SessionProvider runtime={runtime} origin="https://app.test">
          {children}
        </SessionProvider>
      </QueryClientProvider>
    )
  }

  const view = render(<UnguardedCircuitView fetcher={fetcher} />, {
    wrapper: Tree,
  })
  return { view, queryClient, Tree }
}

describe('a second user signing in at the same browser', () => {
  it('takes the first user`s circuit off the screen, and asks the server again', async () => {
    const auth = createFakeAuth({ settled: fakeSession('user-a') })
    const fetcher = vi
      .fn<() => Promise<string>>()
      .mockResolvedValue(PRIVATE_TITLE)
    const { queryClient } = mount(auth, fetcher)

    await screen.findByText(PRIVATE_TITLE)
    expect(fetcher).toHaveBeenCalledTimes(1)

    // Whatever this key holds now belongs to somebody else, so the server
    // refuses it. Armed *before* the change, because the refetch the change
    // provokes goes out inside the same event.
    fetcher.mockRejectedValue(NOT_FOUND)

    // A leaves, B arrives — the transition `SessionProvider` evicts on, twice.
    auth.emit('SIGNED_OUT', null)
    auth.emit('SIGNED_IN', fakeSession('user-b'))

    // The cache is empty…
    await waitFor(() => {
      expect(
        queryClient.getQueryData(circuitKeys.detail('a-private-slug'))
      ).toBeUndefined()
    })

    // …and so is the screen, and the refetch went out under the new identity.
    await waitFor(() => {
      expect(screen.getByText('no circuit')).toBeDefined()
    })
    // At least once more. Two identities went past — A to anonymous, anonymous
    // to B — and each is a change this evicts on, so the exact count is a fact
    // about the transitions rather than about the guarantee.
    await waitFor(() => {
      expect(fetcher.mock.calls.length).toBeGreaterThan(1)
    })

    // Waiting is deliberate: the claim is not "not yet", it is "never again".
    await new Promise((resolve) => setTimeout(resolve, 100))
    expect(screen.queryByText(PRIVATE_TITLE)).toBeNull()
  })

  it('does not need an unmount to do it', async () => {
    const auth = createFakeAuth({ settled: fakeSession('user-a') })
    const fetcher = vi
      .fn<() => Promise<string>>()
      .mockResolvedValue(PRIVATE_TITLE)
    mount(auth, fetcher)

    await screen.findByText(PRIVATE_TITLE)

    fetcher.mockRejectedValue(NOT_FOUND)
    auth.emit('SIGNED_OUT', null)
    auth.emit('SIGNED_IN', fakeSession('user-b'))

    /*
     * What `RequireSession` does for the routes it covers is throw the subtree
     * away, and that used to be the only thing that emptied the screen. The
     * editor is not covered, so nothing here unmounts — and the title is gone
     * anyway.
     */
    await waitFor(() => {
      expect(screen.getByText('no circuit')).toBeDefined()
    })
  })

  it('leaves a single session alone', async () => {
    const auth = createFakeAuth({ settled: fakeSession('user-a') })
    const fetcher = vi
      .fn<() => Promise<string>>()
      .mockResolvedValue(PRIVATE_TITLE)
    mount(auth, fetcher)

    await screen.findByText(PRIVATE_TITLE)

    // A token refresh is not a change of user, and evicting on one would
    // refetch every query in the app every hour for nothing.
    auth.emit('TOKEN_REFRESHED', fakeSession('user-a'))

    await new Promise((resolve) => setTimeout(resolve, 50))
    expect(screen.getByText(PRIVATE_TITLE)).toBeDefined()
    expect(fetcher).toHaveBeenCalledTimes(1)
  })
})
