// @vitest-environment node
import { describe, expect, it } from 'vitest'

import { fakeSession } from './testing.js'
import {
  ANONYMOUS_SESSION,
  LOADING_SESSION,
  isUserChange,
  resolvedSessionState,
} from './sessionState.js'
import type { SessionState } from './sessionState.js'

/**
 * The three states as data, before any React is involved.
 *
 * `isUserChange` is the whole of the cache-eviction policy, and it is the
 * kind of predicate that is easy to get subtly wrong in a `useEffect` where
 * it cannot be tested. Here every transition is one line.
 */

const signedIn = (id: string): SessionState => ({
  status: 'authenticated',
  user: { id, email: `${id}@example.test` },
})

describe('resolvedSessionState', () => {
  it('reads a session into an authenticated state', () => {
    expect(resolvedSessionState(fakeSession('user-1'))).toEqual({
      status: 'authenticated',
      user: { id: 'user-1', email: 'user-1@example.test' },
    })
  })

  it('treats a null session as a resolved answer, never as loading', () => {
    expect(resolvedSessionState(null)).toEqual(ANONYMOUS_SESSION)
  })

  it('keeps only the id and the email out of the Supabase user', () => {
    /*
     * Supabase's `User` also carries app_metadata, identities and every
     * provider token response. None of that belongs in a context a hundred
     * components can read; the displayable profile is a row the API owns.
     */
    const state = resolvedSessionState(fakeSession('user-1'))
    expect(Object.keys(state.user!).sort()).toEqual(['email', 'id'])
  })
})

describe('isUserChange', () => {
  it('is true when one user replaces another', () => {
    // Two people, one laptop. This is what the eviction exists for.
    expect(isUserChange(signedIn('a'), signedIn('b'))).toBe(true)
  })

  it('is true on sign-out and on sign-in', () => {
    expect(isUserChange(signedIn('a'), ANONYMOUS_SESSION)).toBe(true)
    expect(isUserChange(ANONYMOUS_SESSION, signedIn('b'))).toBe(true)
  })

  it('is false when the same user’s token is refreshed', () => {
    // TOKEN_REFRESHED fires roughly hourly in every open tab. Clearing the
    // cache on it would refetch everything on screen, for nothing.
    expect(isUserChange(signedIn('a'), signedIn('a'))).toBe(false)
  })

  it('is false on the first resolution of a page load', () => {
    /*
     * The query cache is built fresh in main.tsx and nothing persists into it
     * across visits, so at this moment there is no other user's data to
     * discard — and evicting here would cancel the queries a route fired on
     * its first paint, on every single load.
     */
    expect(isUserChange(LOADING_SESSION, signedIn('a'))).toBe(false)
    expect(isUserChange(LOADING_SESSION, ANONYMOUS_SESSION)).toBe(false)
  })

  it('is false for a move back into loading', () => {
    // The machine does not go backwards, but if it did, "we stopped knowing"
    // is not a change of user.
    expect(isUserChange(signedIn('a'), LOADING_SESSION)).toBe(false)
  })
})
