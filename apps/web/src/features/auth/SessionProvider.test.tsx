import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from '@testing-library/react'
import type { ReactNode } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { SessionProvider } from './SessionProvider.js'
import { useSession, useSessionActions } from './SessionContext.js'
import { TEST_SUPABASE_CONFIG, createFakeAuth, fakeSession } from './testing.js'
import type { FakeAuthPort } from './testing.js'
import type { AuthRuntime } from './runtime.js'

/**
 * The three states, their transitions, and the cache that must not survive a
 * change of user.
 *
 * The fake port holds `getSession()` open until the test says otherwise,
 * which is what makes `loading` an assertable state rather than a frame to
 * race. That window is where the whole class of bugs this milestone is about
 * lives: on a hard refresh it is real, it is measured in milliseconds, and
 * everything rendered inside it is rendered without knowing who the user is.
 */

afterEach(cleanup)

const ORIGIN = 'https://qsim.test'

function runtimeFor(auth: FakeAuthPort): AuthRuntime {
  return { auth, config: TEST_SUPABASE_CONFIG }
}

/** Prints the state the provider is in, so an assertion can read it. */
function Probe() {
  const session = useSession()
  return (
    <p data-testid="state">
      {session.status}
      {session.user === null ? '' : `:${session.user.id}`}
    </p>
  )
}

function setup(
  auth: FakeAuthPort,
  { queryClient = new QueryClient() }: { queryClient?: QueryClient } = {},
  children: ReactNode = <Probe />
) {
  const view = render(
    <QueryClientProvider client={queryClient}>
      <SessionProvider runtime={runtimeFor(auth)} origin={ORIGIN}>
        {children}
      </SessionProvider>
    </QueryClientProvider>
  )
  return { ...view, queryClient }
}

function state(): string {
  return screen.getByTestId('state').textContent ?? ''
}

/** Lets every queued microtask and timer callback run, inside `act`. */
async function flush(): Promise<void> {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0))
  })
}

describe('the three states', () => {
  it('starts in loading, which is neither signed in nor signed out', async () => {
    const auth = createFakeAuth()
    setup(auth)

    expect(state()).toBe('loading')

    // And stays there. Nothing has answered, and the provider must not guess.
    await flush()
    expect(state()).toBe('loading')
  })

  it('resolves to anonymous when there is no stored session', async () => {
    const auth = createFakeAuth()
    setup(auth)

    auth.settle(null)

    await waitFor(() => expect(state()).toBe('anonymous'))
  })

  it('resolves to authenticated when a session was stored', async () => {
    const auth = createFakeAuth()
    setup(auth)

    auth.settle(fakeSession('ada'))

    await waitFor(() => expect(state()).toBe('authenticated:ada'))
  })

  it('resolves through the auth listener too, without waiting for the read', async () => {
    // `INITIAL_SESSION` is supabase-js's own signal that storage has been
    // read. It is the documented path; `getSession` is only the floor.
    const auth = createFakeAuth()
    setup(auth)

    await act(async () => {
      auth.emit('INITIAL_SESSION', fakeSession('ada'))
      await Promise.resolve()
    })

    expect(state()).toBe('authenticated:ada')
  })

  it('resolves to anonymous rather than hanging when the session is unreadable', async () => {
    /*
     * Sitting in `loading` forever would freeze every guarded route behind a
     * status line that never resolves. Signed-out is the state a user can act
     * on: the sign-in screen is reachable and signing in overwrites whatever
     * was broken.
     */
    const reported = vi.spyOn(console, 'error').mockImplementation(() => {})
    const auth = createFakeAuth()
    auth.script.getSessionThrows = new Error('localStorage is unavailable')
    setup(auth)

    auth.settle(null)

    await waitFor(() => expect(state()).toBe('anonymous'))
    expect(reported).toHaveBeenCalled()
    reported.mockRestore()
  })

  it('is resolved from the first frame when no project is configured', () => {
    // A deployment without accounts has nothing to wait for, so a guard must
    // not show "checking…" for a frame before deciding.
    render(
      <QueryClientProvider client={new QueryClient()}>
        <SessionProvider runtime={null} origin={ORIGIN}>
          <Probe />
        </SessionProvider>
      </QueryClientProvider>
    )

    expect(state()).toBe('anonymous')
  })
})

describe('transitions', () => {
  it('follows a sign-in and a sign-out', async () => {
    const auth = createFakeAuth({ settled: null })
    setup(auth)

    await waitFor(() => expect(state()).toBe('anonymous'))

    await act(async () => {
      auth.emit('SIGNED_IN', fakeSession('ada'))
      await Promise.resolve()
    })
    expect(state()).toBe('authenticated:ada')

    await act(async () => {
      auth.emit('SIGNED_OUT', null)
      await Promise.resolve()
    })
    expect(state()).toBe('anonymous')
  })

  it('does not let a late session read overwrite a newer event', async () => {
    /*
     * Both resolution paths are wired, so their answers can arrive out of
     * order. The stale one must lose — otherwise a sign-in completed during
     * the initial read would be undone a moment later, and the user would
     * watch themselves be signed out for no reason.
     */
    const auth = createFakeAuth()
    setup(auth)

    await act(async () => {
      auth.emit('SIGNED_IN', fakeSession('ada'))
      await Promise.resolve()
    })
    expect(state()).toBe('authenticated:ada')

    // The initial `getSession()` finally answers, with what storage held
    // before the sign-in.
    auth.settle(null)
    await flush()

    expect(state()).toBe('authenticated:ada')
  })

  it('stops listening when it unmounts', async () => {
    const auth = createFakeAuth({ settled: null })
    const { unmount } = setup(auth)

    await waitFor(() => expect(state()).toBe('anonymous'))
    expect(auth.listenerCount()).toBe(1)

    unmount()
    expect(auth.listenerCount()).toBe(0)
  })
})

describe('the previous user’s cache', () => {
  const KEY = ['circuits', 'list']
  const PRIVATE = { items: ['a circuit only Ada may read'] }

  it('is discarded when a different user signs in', async () => {
    /*
     * Two people share a browser. Without this the second sees the first's
     * private circuit list, out of cache, instantly, before any request goes
     * out — a real leak that looks like a rendering bug.
     */
    const auth = createFakeAuth({ settled: fakeSession('ada') })
    const { queryClient } = setup(auth)

    await waitFor(() => expect(state()).toBe('authenticated:ada'))
    queryClient.setQueryData(KEY, PRIVATE)

    await act(async () => {
      auth.emit('SIGNED_IN', fakeSession('grace'))
      await Promise.resolve()
    })

    expect(queryClient.getQueryData(KEY)).toBeUndefined()
  })

  it('is discarded on sign-out, not merely marked stale', async () => {
    // `invalidateQueries` would keep serving the old data while refetching,
    // which is the same leak with a shorter life.
    const auth = createFakeAuth({ settled: fakeSession('ada') })
    const { queryClient } = setup(auth)

    await waitFor(() => expect(state()).toBe('authenticated:ada'))
    queryClient.setQueryData(KEY, PRIVATE)

    await act(async () => {
      auth.emit('SIGNED_OUT', null)
      await Promise.resolve()
    })

    expect(queryClient.getQueryData(KEY)).toBeUndefined()
  })

  it('survives a token refresh for the same user', async () => {
    // Hourly, in every open tab. Clearing here would refetch the screen for
    // nothing and interrupt whatever the user was reading.
    const auth = createFakeAuth({ settled: fakeSession('ada') })
    const { queryClient } = setup(auth)

    await waitFor(() => expect(state()).toBe('authenticated:ada'))
    queryClient.setQueryData(KEY, PRIVATE)

    await act(async () => {
      auth.emit('TOKEN_REFRESHED', fakeSession('ada'))
      await Promise.resolve()
    })

    expect(queryClient.getQueryData(KEY)).toEqual(PRIVATE)
  })

  it('survives the first resolution of a page load', async () => {
    // Nothing persists into a fresh cache from an earlier visit, and evicting
    // here would cancel whatever a route fetched on its first paint.
    const auth = createFakeAuth()
    const { queryClient } = setup(auth)

    queryClient.setQueryData(KEY, PRIVATE)
    auth.settle(fakeSession('ada'))

    await waitFor(() => expect(state()).toBe('authenticated:ada'))
    expect(queryClient.getQueryData(KEY)).toEqual(PRIVATE)
  })
})

describe('the actions', () => {
  function SignOutButton() {
    const actions = useSessionActions()
    return (
      <button
        type="button"
        onClick={() => {
          void actions.signOut()
        }}
      >
        {'sign out'}
      </button>
    )
  }

  it('reach any component under the provider', async () => {
    const auth = createFakeAuth({ settled: fakeSession('ada') })
    setup(auth, {}, <SignOutButton />)

    fireEvent.click(screen.getByRole('button'))

    await waitFor(() => expect(auth.calls.signOut).toBe(1))
  })
})
