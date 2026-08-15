import { emptyCircuit } from '@qsim/schema'
import { QueryClient } from '@tanstack/react-query'
import { renderHook, waitFor } from '@testing-library/react'
import type { ReactNode } from 'react'
import { describe, expect, it } from 'vitest'

import { ApiProvider } from './ApiProvider.js'
import { createApiClient } from './client.js'
import {
  ApiRequestError,
  isForbidden,
  requiresAuthentication,
} from './errors.js'
import { createQueryClient } from './queryClient.js'
import { circuitKeys } from './queryKeys.js'
import {
  TEST_BASE_URL,
  circuitDetailPayload,
  circuitWithVersionPayload,
  errorResponse,
  jsonResponse,
  stubFetch,
} from './testing.js'
import {
  useCircuit,
  useCircuits,
  useCreateCircuit,
  useDeleteCircuit,
} from './useCircuits.js'

/**
 * The hooks, driven against a stub transport.
 *
 * What is worth asserting here is not "React Query works" but the three
 * decisions this layer makes on top of it: that a hook with nothing to fetch
 * does not fetch, that a mutation invalidates exactly what it touched, and
 * that a failure arrives at the component as an `ApiRequestError` the UI can
 * branch on — 401 to a sign-in prompt, 403 to neither.
 *
 * Every render gets its own `QueryClient`. A shared one would carry a cache
 * between tests and turn "did this fetch?" into a question about test order.
 */

function harness(
  responses: readonly unknown[],
  queryClient: QueryClient = createQueryClient()
) {
  const transport = stubFetch(responses)
  const client = createApiClient({
    baseUrl: TEST_BASE_URL,
    fetch: transport.fetch,
    getAccessToken: () => 'token',
  })

  function wrapper({ children }: { children: ReactNode }) {
    return (
      <ApiProvider client={client} queryClient={queryClient}>
        {children}
      </ApiProvider>
    )
  }

  return { transport, queryClient, wrapper }
}

const emptyPage = { items: [], page: 1, perPage: 20, total: 0, totalPages: 1 }

describe('useCircuits', () => {
  it('fetches the caller’s own circuits and parses them', async () => {
    const { wrapper } = harness([
      jsonResponse({ ...emptyPage, items: [circuitDetailPayload], total: 1 }),
    ])

    const { result } = renderHook(() => useCircuits(), { wrapper })

    await waitFor(() => expect(result.current.isSuccess).toBe(true))
    expect(result.current.data?.items[0]?.title).toBe('Bell pair')
    expect(result.current.data?.items[0]?.updatedAt).toBeInstanceOf(Date)
  })
})

describe('useCircuit', () => {
  it('does not fetch when there is no handle', async () => {
    // The editor route is `/new` before it is `/c/:slug`. Fetching
    // `/circuits/null` would cache a 404 for a circuit nobody asked for.
    const { transport, wrapper } = harness([])

    const { result } = renderHook(() => useCircuit(null), { wrapper })

    await waitFor(() => expect(result.current.fetchStatus).toBe('idle'))
    expect(transport.calls).toHaveLength(0)
  })

  it('fetches once there is one', async () => {
    const { transport, wrapper } = harness([
      jsonResponse(circuitWithVersionPayload),
    ])

    const { result } = renderHook(() => useCircuit('abc'), { wrapper })

    await waitFor(() => expect(result.current.isSuccess).toBe(true))
    expect(transport.calls).toHaveLength(1)
    expect(result.current.data?.version.circuit.qubits).toBe(2)
  })

  it('surfaces a 403 as an error the UI can tell from a 401', async () => {
    const { result } = renderHook(() => useCircuit('abc'), {
      wrapper: harness([errorResponse('FORBIDDEN', 403)]).wrapper,
    })

    await waitFor(() => expect(result.current.isError).toBe(true))

    const error = result.current.error as ApiRequestError
    expect(error).toBeInstanceOf(ApiRequestError)
    expect(isForbidden(error)).toBe(true)
    expect(requiresAuthentication(error)).toBe(false)
  })

  it('surfaces a 401 as "sign in", and does not retry it', async () => {
    const { transport, wrapper } = harness([
      errorResponse('AUTH_REQUIRED', 401),
    ])

    const { result } = renderHook(() => useCircuit('abc'), { wrapper })

    await waitFor(() => expect(result.current.isError).toBe(true))
    expect(requiresAuthentication(result.current.error)).toBe(true)
    // React Query's stock default would have made this four requests against
    // a rate-limited API for a failure that cannot change.
    expect(transport.calls).toHaveLength(1)
  })
})

describe('useCreateCircuit', () => {
  it('seeds the detail cache and invalidates every listing', async () => {
    const queryClient = createQueryClient()
    const { wrapper } = harness(
      [jsonResponse(circuitWithVersionPayload, 201)],
      queryClient
    )
    // A listing already in cache, as it would be after visiting the gallery.
    queryClient.setQueryData(circuitKeys.list(), emptyPage)

    const { result } = renderHook(() => useCreateCircuit(), { wrapper })
    result.current.mutate({ title: 'Bell pair', circuit: emptyCircuit(2) })

    await waitFor(() => expect(result.current.isSuccess).toBe(true))

    // The response already holds the circuit, so the redirect into the editor
    // does not need a second round trip for data this tab is holding.
    expect(
      queryClient.getQueryData(circuitKeys.detail(circuitDetailPayload.slug))
    ).toBeDefined()
    expect(queryClient.getQueryState(circuitKeys.list())?.isInvalidated).toBe(
      true
    )
  })
})

describe('useDeleteCircuit', () => {
  it('removes the circuit from the cache rather than refetching it', async () => {
    const queryClient = createQueryClient()
    const { wrapper } = harness(
      [new Response(null, { status: 204 })],
      queryClient
    )
    queryClient.setQueryData(
      circuitKeys.detail('abc'),
      circuitWithVersionPayload
    )
    queryClient.setQueryData(circuitKeys.versionList('abc'), emptyPage)

    const { result } = renderHook(() => useDeleteCircuit(), { wrapper })
    result.current.mutate('abc')

    await waitFor(() => expect(result.current.isSuccess).toBe(true))

    /*
     * Invalidating would refetch a circuit that is gone and paint an error
     * state for a deletion that succeeded. The versions go with it because
     * their key is nested under the detail.
     */
    expect(queryClient.getQueryData(circuitKeys.detail('abc'))).toBeUndefined()
    expect(
      queryClient.getQueryData(circuitKeys.versionList('abc'))
    ).toBeUndefined()
  })
})

describe('useApiClient', () => {
  it('says which provider is missing rather than failing at the network', () => {
    const queryClient = new QueryClient()

    expect(() =>
      renderHook(() => useCircuits(), {
        wrapper: ({ children }: { children: ReactNode }) => (
          <ApiProvider client={null as never} queryClient={queryClient}>
            {children}
          </ApiProvider>
        ),
      })
    ).toThrow('ApiProvider')
  })
})
