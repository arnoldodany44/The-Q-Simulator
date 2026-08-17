/**
 * Independent verification — where the minted API key actually lives.
 *
 * `useApiKeys.ts` states the rule this file checks: "the minted key does not go
 * in the cache … A credential should live exactly as long as the piece of UI
 * whose job is to hand it over, which is a `useState` in one component."
 *
 * `onSuccess` never called `setQueryData`, so the *query* cache was always
 * clean. The question this file asks is the one that claim did not distinguish:
 * React Query also keeps every mutation's result in the **MutationCache**,
 * which hangs off the same `QueryClient`, and the settings screen unmounts
 * `CreateKeyForm` the moment a key is minted. The secret was reachable from
 * `queryClient.getMutationCache()` for `gcTime` — five minutes by default —
 * after the component that showed it was gone.
 *
 * The fix is structural: the secret is handed to the caller from inside
 * `mutationFn` and is not what the mutation resolves with, so there is no cache
 * entry to expire. So the assertion below is made from outside the component
 * tree, against the client, immediately after the component that held the
 * secret is unmounted — no waiting for a collector, because nothing was ever
 * stored.
 */

import type { QueryClient } from '@tanstack/react-query'
import { act, render, waitFor } from '@testing-library/react'
import { useEffect } from 'react'
import { describe, expect, it } from 'vitest'

import { ApiProvider } from '../../lib/api/ApiProvider.js'
import { createApiClient } from '../../lib/api/client.js'
import { createQueryClient } from '../../lib/api/queryClient.js'
import { useCreateApiKey } from '../../lib/api/useApiKeys.js'
import { jsonResponse } from '../../lib/api/testing.js'

const MINTED = 'qsk_SENTINELsecretMintedKey00000000000000000'

function mintingClient() {
  return createApiClient({
    baseUrl: 'https://api.test',
    getAccessToken: () => Promise.resolve('session-token'),
    fetch: () =>
      Promise.resolve(
        jsonResponse(
          {
            apiKey: {
              id: 'key-1',
              name: 'probe',
              keyPrefix: MINTED.slice(0, 10),
              scopes: ['read'],
              createdAt: '2026-08-17T00:00:00.000Z',
              lastUsedAt: null,
              revokedAt: null,
            },
            key: MINTED,
          },
          201
        )
      ),
  })
}

/** Mints once on mount, then reports that it is done. */
function Minter({
  onDone,
  onKey,
}: {
  readonly onDone: () => void
  readonly onKey: (key: string) => void
}) {
  const create = useCreateApiKey((created) => {
    onKey(created.key)
  })
  useEffect(() => {
    create.mutate(
      { name: 'probe', scopes: ['read'] },
      { onSettled: () => onDone() }
    )
    // Once, on mount. The dependency list is deliberately empty.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])
  return null
}

/** Every string reachable from the client, however deep. */
function reachableStrings(root: unknown): string[] {
  const found: string[] = []
  const seen = new Set<unknown>()
  const walk = (value: unknown, depth: number) => {
    if (depth > 12 || value === null || value === undefined) return
    if (typeof value === 'string') {
      found.push(value)
      return
    }
    if (typeof value !== 'object') return
    if (seen.has(value)) return
    seen.add(value)
    for (const entry of Object.values(value as Record<string, unknown>)) {
      walk(entry, depth + 1)
    }
  }
  walk(root, 0)
  return found
}

describe('a minted key, after the component that showed it is gone', () => {
  it('is reachable from nowhere but the component state', async () => {
    const queryClient: QueryClient = createQueryClient()
    let settled = false
    let delivered: string | null = null

    const view = render(
      <ApiProvider client={mintingClient()} queryClient={queryClient}>
        <Minter
          onDone={() => {
            settled = true
          }}
          onKey={(key) => {
            delivered = key
          }}
        />
      </ApiProvider>
    )
    await waitFor(() => {
      expect(settled).toBe(true)
    })

    // The caller genuinely receives the secret — this is not a test that
    // passes because nothing was minted.
    expect(delivered).toBe(MINTED)

    // The settings screen replaces the form with the panel, so the component
    // holding the `useState` copy is unmounted at exactly this point.
    act(() => {
      view.unmount()
    })

    const mutations = queryClient.getMutationCache().getAll()
    const strings = reachableStrings(mutations.map((m) => m.state))

    // The *query* cache: `onSuccess` invalidates and never writes.
    expect(queryClient.getQueryCache().getAll()).toHaveLength(0)
    // The mutation cache: the secret is not what the mutation resolved with,
    // so it is not there — no `waitFor`, no garbage collection, nothing to
    // expire.
    expect(strings).not.toContain(MINTED)
    // And nowhere else on the client either.
    expect(reachableStrings(queryClient.getQueryCache())).not.toContain(MINTED)
  })
})
