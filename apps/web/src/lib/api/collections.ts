/**
 * The collection routes of §8, as functions — milestone M1.9.
 *
 * ── What this client must not try to be clever about ──────────────────────
 *
 * A collection page arrives as `{ collection, items, withheldItemCount }`, and
 * `items` is already filtered: the server applied §11 to the *circuits*, not
 * only to the collection, so what comes back is exactly what this viewer may
 * see. There is nothing to filter here and nothing to reconstruct — in
 * particular `itemCount - items.length` is not the same number as
 * `withheldItemCount` once a listing is paged or a row is stale, so the server's
 * figure is the one that is rendered.
 */

import {
  AddCollectionItemBody,
  CreateCollectionBody,
  UpdateCollectionBody,
  collectionPath,
  wireCollectionResponses,
} from '@qsim/contract'
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

import type { ApiClient } from './client.js'
import type { RequestContext } from './circuits.js'

/** `GET /collections` — the caller's own, whatever their visibility. */
export function listCollections(
  client: ApiClient,
  params: PaginationParams = {},
  context: RequestContext = {}
): Promise<CollectionPage> {
  return client.request({
    method: 'GET',
    path: collectionPath.collection(),
    query: { page: params.page, perPage: params.perPage },
    schema: wireCollectionResponses.CollectionPageResponse,
    ...context,
  })
}

/** `GET /collections/:id` — one collection and what this viewer may see in it. */
export function getCollection(
  client: ApiClient,
  id: string,
  context: RequestContext = {}
): Promise<CollectionView> {
  return client.request({
    method: 'GET',
    path: collectionPath.item(id),
    schema: wireCollectionResponses.CollectionViewResponse,
    ...context,
  })
}

export function createCollection(
  client: ApiClient,
  input: CreateCollectionRequest,
  context: RequestContext = {}
): Promise<CollectionEnvelope> {
  return client.request({
    method: 'POST',
    path: collectionPath.collection(),
    body: CreateCollectionBody.parse(input),
    schema: wireCollectionResponses.CollectionEnvelope,
    ...context,
  })
}

export function updateCollection(
  client: ApiClient,
  id: string,
  changes: UpdateCollectionRequest,
  context: RequestContext = {}
): Promise<CollectionEnvelope> {
  return client.request({
    method: 'PATCH',
    path: collectionPath.item(id),
    body: UpdateCollectionBody.parse(changes),
    schema: wireCollectionResponses.CollectionEnvelope,
    ...context,
  })
}

/** `DELETE /collections/:id` — the group, and none of the circuits in it. */
export function deleteCollection(
  client: ApiClient,
  id: string,
  context: RequestContext = {}
): Promise<void> {
  return client.request({
    method: 'DELETE',
    path: collectionPath.item(id),
    // 204: there is no body to parse, and reading one would throw.
    schema: null,
    ...context,
  })
}

/**
 * `POST /collections/:id/items` — add a circuit by its *handle*.
 *
 * The slug rather than the id wherever the caller has one, for the reason
 * `StarVariables` gives: an id reaches only the circuits a listing may show,
 * while a slug also reaches an UNLISTED one — which is exactly the case where
 * somebody is looking at a circuit they were sent a link to.
 */
export function addCollectionItem(
  client: ApiClient,
  id: string,
  input: AddCollectionItemRequest,
  context: RequestContext = {}
): Promise<CollectionEnvelope> {
  return client.request({
    method: 'POST',
    path: collectionPath.items(id),
    body: AddCollectionItemBody.parse(input),
    schema: wireCollectionResponses.CollectionEnvelope,
    ...context,
  })
}

export function removeCollectionItem(
  client: ApiClient,
  id: string,
  circuitId: string,
  context: RequestContext = {}
): Promise<CollectionEnvelope> {
  return client.request({
    method: 'DELETE',
    path: collectionPath.member(id, circuitId),
    schema: wireCollectionResponses.CollectionEnvelope,
    ...context,
  })
}

/** `GET /circuits/:id/collections` — which of the caller's own hold it. */
export function listCollectionsHolding(
  client: ApiClient,
  handle: string,
  context: RequestContext = {}
): Promise<CollectionMembership> {
  return client.request({
    method: 'GET',
    path: collectionPath.membership(handle),
    schema: wireCollectionResponses.CollectionMembershipResponse,
    ...context,
  })
}
