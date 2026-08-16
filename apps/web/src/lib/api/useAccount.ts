/**
 * React Query hooks for the account and for public profiles — §9, M1.9.
 *
 * ── Renaming yourself invalidates almost everything ───────────────────────
 *
 * `username` is not a private field. It is the byline on every card in the
 * gallery, the address of your profile, and the link every one of your
 * circuits carries — so a successful rename makes a large part of the cache
 * wrong at once, in a way no surgical patch can fix: the old profile key still
 * holds a page that now 404s, and the gallery holds cards pointing at a handle
 * nobody has.
 *
 * So `useUpdateProfile` invalidates the account, the gallery and the
 * collections roots together. That is deliberately blunt. The alternative —
 * walking the cache rewriting owner refs — is a second implementation of the
 * server's own projection, and it would be wrong the first time a field is
 * added to it.
 *
 * ── Deletion evicts rather than invalidates ───────────────────────────────
 *
 * After `DELETE /me` there is nothing left to refetch: every query in the
 * cache describes rows that no longer exist, and refetching them would fire a
 * burst of requests carrying a token whose user is gone. `clear()` throws the
 * lot away, and the sign-out that follows is what returns the app to its
 * anonymous state.
 */

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import type { UseMutationResult, UseQueryResult } from '@tanstack/react-query'
import type {
  Account,
  AccountDeletion,
  CollectionPage,
  PaginationParams,
  Profile,
  UpdateProfileRequest,
} from '@qsim/contract'

import { useApiClient } from './ApiContext.js'
import {
  deleteAccount,
  getAccount,
  getProfile,
  listUserCollections,
  updateProfile,
} from './account.js'
import { accountKeys, collectionKeys, galleryKeys } from './queryKeys.js'

/**
 * `GET /me` — the caller's own row.
 *
 * `enabled` is the caller's, because the settings screen is behind a session
 * guard and the hook must not fire before the stored session has been read:
 * an anonymous request here is a 401 cached under a key the signed-in view
 * will then read.
 */
export function useAccount(enabled = true): UseQueryResult<Account, unknown> {
  const client = useApiClient()
  return useQuery({
    queryKey: accountKeys.me(),
    queryFn: ({ signal }) => getAccount(client, { signal }),
    enabled,
  })
}

/** `GET /users/:username` — a public profile, anonymous callers included. */
export function useProfile(
  username: string | null
): UseQueryResult<Profile, unknown> {
  const client = useApiClient()
  return useQuery({
    queryKey: accountKeys.profile(username ?? ''),
    queryFn: ({ signal }) => getProfile(client, username!, { signal }),
    enabled: username !== null,
  })
}

/** `GET /users/:username/collections` — that author's, as this viewer sees. */
export function useUserCollections(
  username: string | null,
  params: PaginationParams = {}
): UseQueryResult<CollectionPage, unknown> {
  const client = useApiClient()
  return useQuery({
    queryKey: collectionKeys.user(username ?? '', params),
    queryFn: ({ signal }) =>
      listUserCollections(client, username!, params, { signal }),
    enabled: username !== null,
  })
}

export function useUpdateProfile(): UseMutationResult<
  Account,
  unknown,
  UpdateProfileRequest
> {
  const client = useApiClient()
  const queryClient = useQueryClient()

  return useMutation({
    mutationFn: (changes: UpdateProfileRequest) =>
      updateProfile(client, changes),
    onSuccess: (account) => {
      queryClient.setQueryData(accountKeys.me(), account)
      /*
       * A rename moves the profile to a new address and rewrites the byline on
       * every card. See the header for why this is blunt rather than surgical.
       */
      void queryClient.invalidateQueries({ queryKey: accountKeys.all })
      void queryClient.invalidateQueries({ queryKey: galleryKeys.all })
      void queryClient.invalidateQueries({ queryKey: collectionKeys.all })
    },
  })
}

export function useDeleteAccount(): UseMutationResult<
  AccountDeletion,
  unknown,
  string
> {
  const client = useApiClient()
  const queryClient = useQueryClient()

  return useMutation({
    mutationFn: (confirm: string) => deleteAccount(client, confirm),
    onSuccess: () => {
      // Nothing in the cache describes a row that still exists. Refetching
      // would be a burst of requests for an account that is gone.
      queryClient.clear()
    },
  })
}
