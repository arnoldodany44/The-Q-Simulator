/**
 * React Query hooks for API keys — §3.5, §9.
 *
 * ── The minted key does not go in the cache, and cannot ───────────────────
 *
 * React Query's `QueryClient` is a long-lived object holding every response the
 * app has seen. A key in it would mean the secret outliving the component that
 * showed it, surviving navigation, and sitting in memory for as long as the tab
 * is open — reachable from the devtools and from any other hook that shares the
 * client. A credential should live exactly as long as the piece of UI whose job
 * is to hand it over, which is a `useState` in one component.
 *
 * `onSuccess` never called `setQueryData`, so the *query* cache was always
 * clean — and that was not enough. **`useMutation` stores whatever
 * `mutationFn` resolves with in the MutationCache**, which hangs off the same
 * client, for `gcTime` after the last observer unmounts. `ApiKeysSection`
 * replaces the mint form with the panel the instant a key arrives, so the only
 * observer unmounts immediately and the secret then sat in a shared object for
 * the default five minutes with nothing rendering it.
 *
 * So the rule is now structural rather than a promise about call sites: **the
 * secret is not part of what this mutation resolves with.** `mutationFn` hands
 * it to the caller directly and returns the key's *metadata*, which is the row
 * the listing shows and carries no secret. There is no cache entry to expire,
 * no devtools panel that can show it, and no future hook that can read it back
 * — the same "make it unfetchable rather than unfetched" argument
 * `hardwareCredentialMetaSelect` makes on the server.
 */

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import type { UseMutationResult, UseQueryResult } from '@tanstack/react-query'
import type {
  ApiKey,
  ApiKeyCreated,
  ApiKeyList,
  CreateApiKeyRequest,
} from '@qsim/contract'

import { useApiClient } from './ApiContext.js'
import { createApiKey, listApiKeys, revokeApiKey } from './api-keys.js'
import { apiKeyKeys } from './queryKeys.js'

/**
 * `GET /api-keys`.
 *
 * `enabled` is the caller's, for the reason `useAccount` has one: the settings
 * screen is behind a session guard, and firing this before the stored session
 * has been read would send it anonymously and cache the 401 under the key the
 * signed-in view then reads.
 */
export function useApiKeys(
  enabled = true
): UseQueryResult<ApiKeyList, unknown> {
  const client = useApiClient()
  return useQuery({
    queryKey: apiKeyKeys.list(),
    queryFn: ({ signal }) => listApiKeys(client, { signal }),
    enabled,
  })
}

/**
 * `POST /api-keys`.
 *
 * `deliver` is where the secret goes, and it is the only place it goes. It is
 * called once, with the whole envelope, from inside `mutationFn` — before the
 * value this hook resolves with is decided — so the caller receives the key and
 * React Query receives the metadata. A caller that ignores `deliver` has thrown
 * the key away, which is the correct default for a value nothing may store.
 */
export function useCreateApiKey(
  deliver: (created: ApiKeyCreated) => void
): UseMutationResult<ApiKey, unknown, CreateApiKeyRequest> {
  const client = useApiClient()
  const queryClient = useQueryClient()

  return useMutation({
    mutationFn: async (request: CreateApiKeyRequest) => {
      const created = await createApiKey(client, request)
      /*
       * Handed over here, not returned. Returning the envelope would put the
       * secret in the MutationCache — see the header; that is the defect this
       * shape exists to make impossible rather than merely unlikely.
       */
      deliver(created)
      return created.apiKey
    },
    /*
     * Belt and braces on top of the shape above: with no observers the
     * mutation is dropped from the cache immediately rather than after the
     * default five minutes. Nothing secret is in it any more, but a mint
     * request's *name and scopes* are still somebody's account configuration
     * and there is no reason to keep them either.
     */
    gcTime: 0,
    onSuccess: () => {
      /*
       * Invalidated rather than appended. The row the server wrote carries a
       * `createdAt` and an id this app did not choose, and a hand-built
       * optimistic entry would be a second, subtly different idea of what a
       * key row looks like — on the one listing where an inaccurate row is a
       * revocation aimed at the wrong credential.
       *
       * The response's `key` is deliberately not stored anywhere here. See the
       * header.
       */
      void queryClient.invalidateQueries({ queryKey: apiKeyKeys.all })
    },
  })
}

export function useRevokeApiKey(): UseMutationResult<
  { apiKey: ApiKey },
  unknown,
  string
> {
  const client = useApiClient()
  const queryClient = useQueryClient()

  return useMutation({
    mutationFn: (id: string) => revokeApiKey(client, id),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: apiKeyKeys.all })
    },
  })
}
