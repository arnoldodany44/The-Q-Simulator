/**
 * React Query hooks for collections — §9, M1.9.
 *
 * ── Why every mutation invalidates the detail as well as the list ─────────
 *
 * A collection carries `itemCount`, and `itemCount` is rendered on the card in
 * the index *and* on the collection's own page. Adding or removing a circuit
 * moves it in both places, and the response carries the fresh card — so the
 * card is written straight into the cache and the *page* is invalidated,
 * because only the server can say which items the viewer may now see and in
 * what order.
 *
 * That asymmetry is the rule worth stating: what the response returns is
 * written, and what only the server can compute is refetched. Reconstructing
 * `withheldItemCount` on this side would mean reimplementing §11 in a browser,
 * which is the one thing this app must never do.
 */

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import type {
  QueryClient,
  UseMutationResult,
  UseQueryResult,
} from '@tanstack/react-query'
import type {
  AddCollectionItemRequest,
  CollectionEnvelope,
  CollectionMembership,
  CollectionPage,
  CollectionView,
  CreateCollectionRequest,
  PaginationParams,
  UpdateCollectionRequest,
} from '@qsim/contract'

import { useApiClient } from './ApiContext.js'
import {
  addCollectionItem,
  createCollection,
  deleteCollection,
  getCollection,
  listCollections,
  listCollectionsHolding,
  removeCollectionItem,
  updateCollection,
} from './collections.js'
import { collectionKeys } from './queryKeys.js'

/** Everything a write to one collection can have made stale. */
function invalidateCollection(queryClient: QueryClient, id?: string): void {
  void queryClient.invalidateQueries({ queryKey: collectionKeys.lists() })
  void queryClient.invalidateQueries({ queryKey: collectionKeys.users() })
  if (id !== undefined) {
    void queryClient.invalidateQueries({ queryKey: collectionKeys.detail(id) })
  }
}

/** `GET /collections` — the caller's own index. */
export function useCollections(
  params: PaginationParams = {},
  enabled = true
): UseQueryResult<CollectionPage, unknown> {
  const client = useApiClient()
  return useQuery({
    queryKey: collectionKeys.list(params),
    queryFn: ({ signal }) => listCollections(client, params, { signal }),
    enabled,
  })
}

/** `GET /collections/:id` — one collection, and what this viewer may see. */
export function useCollection(
  id: string | null
): UseQueryResult<CollectionView, unknown> {
  const client = useApiClient()
  return useQuery({
    queryKey: collectionKeys.detail(id ?? ''),
    queryFn: ({ signal }) => getCollection(client, id!, { signal }),
    enabled: id !== null,
  })
}

/**
 * `GET /circuits/:id/collections` — which of the caller's own hold it.
 *
 * Only ever asked when somebody is signed in: an anonymous caller has no
 * collections, so the request has no answer to look for rather than an empty
 * one, and firing it would be a 401 cached under a key the signed-in view
 * reads.
 */
export function useCollectionsHolding(
  handle: string | null,
  enabled = true
): UseQueryResult<CollectionMembership, unknown> {
  const client = useApiClient()
  return useQuery({
    queryKey: collectionKeys.holding(handle ?? ''),
    queryFn: ({ signal }) =>
      listCollectionsHolding(client, handle!, { signal }),
    enabled: enabled && handle !== null,
  })
}

export function useCreateCollection(): UseMutationResult<
  CollectionEnvelope,
  unknown,
  CreateCollectionRequest
> {
  const client = useApiClient()
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (input: CreateCollectionRequest) =>
      createCollection(client, input),
    onSuccess: () => {
      invalidateCollection(queryClient)
    },
  })
}

export interface UpdateCollectionVariables {
  readonly id: string
  readonly changes: UpdateCollectionRequest
}

export function useUpdateCollection(): UseMutationResult<
  CollectionEnvelope,
  unknown,
  UpdateCollectionVariables
> {
  const client = useApiClient()
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: ({ id, changes }: UpdateCollectionVariables) =>
      updateCollection(client, id, changes),
    onSuccess: (_result, { id }) => {
      /*
       * The detail is invalidated rather than patched even though the response
       * carries the card: changing a collection's *visibility* changes which
       * of its items a viewer may see, and only the server can answer that.
       */
      invalidateCollection(queryClient, id)
    },
  })
}

export function useDeleteCollection(): UseMutationResult<
  void,
  unknown,
  string
> {
  const client = useApiClient()
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (id: string) => deleteCollection(client, id),
    onSuccess: (_result, id) => {
      queryClient.removeQueries({ queryKey: collectionKeys.detail(id) })
      invalidateCollection(queryClient)
    },
  })
}

export interface CollectionItemVariables {
  readonly id: string
  readonly circuit: AddCollectionItemRequest['circuit']
  /** The circuit's id, which is what a membership is keyed by on removal. */
  readonly circuitId?: string
}

export function useAddCollectionItem(): UseMutationResult<
  CollectionEnvelope,
  unknown,
  CollectionItemVariables
> {
  const client = useApiClient()
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: ({ id, circuit }: CollectionItemVariables) =>
      addCollectionItem(client, id, { circuit }),
    onSuccess: (result, { id, circuit }) => {
      queryClient.setQueryData(collectionKeys.detail(id), (previous) =>
        previous === undefined
          ? previous
          : { ...(previous as CollectionView), collection: result.collection }
      )
      invalidateCollection(queryClient, id)
      // The "add to a collection" control on the circuit's own page reads this.
      void queryClient.invalidateQueries({
        queryKey: collectionKeys.holding(circuit),
      })
    },
  })
}

export function useRemoveCollectionItem(): UseMutationResult<
  CollectionEnvelope,
  unknown,
  Required<CollectionItemVariables>
> {
  const client = useApiClient()
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: ({ id, circuitId }: Required<CollectionItemVariables>) =>
      removeCollectionItem(client, id, circuitId),
    onSuccess: (_result, { id, circuit }) => {
      invalidateCollection(queryClient, id)
      void queryClient.invalidateQueries({
        queryKey: collectionKeys.holding(circuit),
      })
    },
  })
}
