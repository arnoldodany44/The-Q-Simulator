/**
 * React Query hooks for the circuit routes — §9.
 *
 * ── The line this file does not cross ─────────────────────────────────────
 *
 * §9: "Zustand for circuit state, React Query for everything that comes from
 * the server. Do not mix the two." So no hook here writes into
 * `useCircuitStore`. Loading a saved circuit into the editor is a user action
 * with consequences — it replaces a document that may have unsaved edits and
 * it has to reset the undo history — and a `useEffect` that copies server
 * data into the store on arrival would perform that action by accident, on a
 * refetch, while the user is typing. The save flow (a later milestone) moves
 * data across this line explicitly, in an event handler, in one direction at
 * a time.
 *
 * What lives where, concretely:
 *   - the document being edited, its undo stack, the selection → Zustand
 *   - what the server holds, and whether it is stale → React Query
 *
 * ── Handles, and why queries are `enabled` ────────────────────────────────
 *
 * The editor route is `/c/:slug`, and on `/new` there is no slug at all. A
 * hook called with `null` therefore must not fetch, rather than fetch
 * `/circuits/null` and cache a 404 — hence the `enabled` guard on every hook
 * that takes a handle.
 */

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import type {
  QueryClient,
  UseMutationResult,
  UseQueryResult,
} from '@tanstack/react-query'
import type {
  CircuitEnvelope,
  CircuitPage,
  CircuitView,
  CircuitWithVersion,
  CreateCircuitRequest,
  CreateVersionRequest,
  ForkCircuitRequest,
  PaginationParams,
  UpdateCircuitRequest,
  VersionEnvelope,
  VersionPage,
} from '@qsim/contract'

import { useApiClient } from './ApiContext.js'
import {
  createCircuit,
  createVersion,
  deleteCircuit,
  forkCircuit,
  getCircuit,
  getVersion,
  listCircuits,
  listVersions,
  updateCircuit,
} from './circuits.js'
import { circuitKeys, galleryKeys } from './queryKeys.js'

/**
 * The public listings a write can change (M1.5b).
 *
 * Creating, renaming, retagging, publishing and deleting all move rows into or
 * out of the gallery and the author's profile page, and those listings live
 * under their own cache root — so a mutation that invalidated only
 * `circuitKeys.lists()` would leave a circuit visible in the gallery after its
 * owner made it private. Invalidation rather than surgery: the server owns the
 * ordering, and the cursor that resumes it.
 */
function invalidateListings(queryClient: QueryClient, handle?: string): void {
  void queryClient.invalidateQueries({ queryKey: circuitKeys.lists() })
  void queryClient.invalidateQueries({ queryKey: galleryKeys.all })
  if (handle !== undefined) {
    void queryClient.invalidateQueries({ queryKey: circuitKeys.detail(handle) })
  }
}

/** `GET /circuits` — the signed-in user's own circuits. */
export function useCircuits(
  params: PaginationParams = {}
): UseQueryResult<CircuitPage, unknown> {
  const client = useApiClient()
  return useQuery({
    queryKey: circuitKeys.list(params),
    // The signal is React Query's, and it is passed through so that a
    // superseded page request is actually cancelled rather than merely
    // ignored — which is the difference between one in-flight request and a
    // queue of them on a fast pager.
    queryFn: ({ signal }) => listCircuits(client, params, { signal }),
  })
}

/**
 * `GET /circuits/:id` — a circuit, the version to open in the editor, and
 * whether this viewer has starred it (M1.5b).
 */
export function useCircuit(
  handle: string | null
): UseQueryResult<CircuitView, unknown> {
  const client = useApiClient()
  return useQuery({
    queryKey: circuitKeys.detail(handle ?? ''),
    queryFn: ({ signal }) => getCircuit(client, handle!, { signal }),
    enabled: handle !== null,
  })
}

/** `GET /circuits/:id/versions` — metadata only; payloads are fetched singly. */
export function useCircuitVersions(
  handle: string | null,
  params: PaginationParams = {}
): UseQueryResult<VersionPage, unknown> {
  const client = useApiClient()
  return useQuery({
    queryKey: circuitKeys.versionList(handle ?? '', params),
    queryFn: ({ signal }) => listVersions(client, handle!, params, { signal }),
    enabled: handle !== null,
  })
}

/**
 * `GET /circuits/:id/versions/:n` — one historical document.
 *
 * A version is immutable, so once fetched it can never be wrong. `staleTime:
 * Infinity` says so, and saves a refetch every time the history sidebar is
 * reopened.
 */
export function useCircuitVersion(
  handle: string | null,
  versionNum: number | null
): UseQueryResult<VersionEnvelope, unknown> {
  const client = useApiClient()
  return useQuery({
    queryKey: circuitKeys.version(handle ?? '', versionNum ?? 0),
    queryFn: ({ signal }) =>
      getVersion(client, handle!, versionNum!, { signal }),
    enabled: handle !== null && versionNum !== null,
    staleTime: Infinity,
  })
}

/** `POST /circuits` — invalidates every listing, no detail. */
export function useCreateCircuit(): UseMutationResult<
  CircuitWithVersion,
  unknown,
  CreateCircuitRequest
> {
  const client = useApiClient()
  const queryClient = useQueryClient()

  return useMutation({
    mutationFn: (body: CreateCircuitRequest) => createCircuit(client, body),
    onSuccess: (created) => {
      /*
       * The response already contains the circuit, so seeding the detail
       * cache saves the redirect-to-editor an immediate round trip for data
       * this tab is holding. `invalidateQueries` on the lists rather than a
       * manual splice: the server decides ordering and totals, and inventing
       * them here is how a pager starts disagreeing with itself.
       *
       * `starred: false` is not a guess. `POST /circuits` answers with the
       * circuit and its first version and does not answer this question at
       * all — it has no reason to, since a circuit created a millisecond ago
       * has no stars and its creator has not pressed anything.
       */
      queryClient.setQueryData(circuitKeys.detail(created.circuit.slug), {
        ...created,
        starred: false,
      })
      invalidateListings(queryClient)
    },
  })
}

export interface UpdateCircuitVariables {
  readonly handle: string
  readonly body: UpdateCircuitRequest
}

/** `PATCH /circuits/:id` — title, description, visibility. Never the document. */
export function useUpdateCircuit(): UseMutationResult<
  CircuitEnvelope,
  unknown,
  UpdateCircuitVariables
> {
  const client = useApiClient()
  const queryClient = useQueryClient()

  return useMutation({
    mutationFn: ({ handle, body }: UpdateCircuitVariables) =>
      updateCircuit(client, handle, body),
    onSuccess: (_result, { handle }) => {
      invalidateListings(queryClient, handle)
    },
  })
}

/** `DELETE /circuits/:id` — the row and its versions go together. */
export function useDeleteCircuit(): UseMutationResult<void, unknown, string> {
  const client = useApiClient()
  const queryClient = useQueryClient()

  return useMutation({
    mutationFn: (handle: string) => deleteCircuit(client, handle),
    onSuccess: (_result, handle) => {
      /*
       * Removed rather than invalidated: invalidating would refetch a circuit
       * that is gone, producing a 404 and an error state for a deletion that
       * succeeded. `removeQueries` drops the branch — the detail and its
       * versions, since the versions key is nested under the detail.
       */
      queryClient.removeQueries({ queryKey: circuitKeys.detail(handle) })
      invalidateListings(queryClient)
    },
  })
}

export interface ForkCircuitVariables {
  readonly handle: string
  readonly body?: ForkCircuitRequest
}

/** `POST /circuits/:id/fork` — a private copy, with attribution recorded. */
export function useForkCircuit(): UseMutationResult<
  CircuitWithVersion,
  unknown,
  ForkCircuitVariables
> {
  const client = useApiClient()
  const queryClient = useQueryClient()

  return useMutation({
    mutationFn: ({ handle, body }: ForkCircuitVariables) =>
      forkCircuit(client, handle, body),
    onSuccess: (created) => {
      // A fork is a brand-new PRIVATE circuit owned by the caller, so it has
      // no stars and the caller has starred nothing on it. Seeding the cache
      // is what lets the editor open on it without a round trip.
      queryClient.setQueryData(circuitKeys.detail(created.circuit.slug), {
        ...created,
        starred: false,
      })
      invalidateListings(queryClient)
    },
  })
}

export interface SaveVersionVariables {
  readonly handle: string
  readonly body: CreateVersionRequest
}

/**
 * `POST /circuits/:id/versions` — the only way a stored document changes.
 *
 * Both the history and the circuit itself are invalidated: appending a
 * version moves `updatedAt` and the derived counts on the circuit row, so a
 * detail left untouched would show yesterday's gate count beside today's
 * document.
 */
export function useSaveVersion(): UseMutationResult<
  VersionEnvelope,
  unknown,
  SaveVersionVariables
> {
  const client = useApiClient()
  const queryClient = useQueryClient()

  return useMutation({
    mutationFn: ({ handle, body }: SaveVersionVariables) =>
      createVersion(client, handle, body),
    onSuccess: (_result, { handle }) => {
      // The gallery too, from M1.5b: a save redraws the card's thumbnail as
      // well as moving its counters, so a listing left alone would advertise
      // a diagram of the circuit as it used to be.
      invalidateListings(queryClient, handle)
    },
  })
}
