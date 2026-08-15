/**
 * The circuit routes of §8, as functions.
 *
 * Each one is a thin, typed call: the path comes from `@qsim/contract`'s
 * builders, the body type from its request schemas, and the response is
 * parsed with its wire schemas. Nothing is declared here — if a shape appears
 * to be missing, it belongs in the contract package where the API can see it
 * too, never in this file.
 *
 * ── Envelopes are not unwrapped ───────────────────────────────────────────
 *
 * `PATCH` answers `{ circuit }` and this returns `{ circuit }`. Unwrapping
 * would read a little nicer and would silently discard whatever the API adds
 * beside the resource later — an ETag, a fork count, the star state — which
 * is the same class of quiet divergence the shared package exists to prevent.
 * Callers destructure at the point of use.
 *
 * ── These take the client rather than reaching for one ────────────────────
 *
 * So a test can drive them with a client built over a stub `fetch`, and so
 * the hooks in `useCircuits.ts` can pass the client from context. A module
 * singleton captured here would make every one of them untestable together.
 */

import { circuitPath, wireCircuitResponses } from '@qsim/contract'
import type {
  CircuitEnvelope,
  CircuitPage,
  CircuitWithVersion,
  CreateCircuitRequest,
  CreateVersionRequest,
  ForkCircuitRequest,
  PaginationParams,
  UpdateCircuitRequest,
  VersionEnvelope,
  VersionPage,
} from '@qsim/contract'

import type { ApiClient, QueryParams } from './client.js'

/** Extra arguments every call accepts; React Query supplies the signal. */
export interface RequestContext {
  readonly signal?: AbortSignal
}

function paginationQuery(params: PaginationParams | undefined): QueryParams {
  return { page: params?.page, perPage: params?.perPage }
}

/** `GET /circuits` — the caller's own, whatever their visibility. */
export function listCircuits(
  client: ApiClient,
  params?: PaginationParams,
  context: RequestContext = {}
): Promise<CircuitPage> {
  return client.request({
    method: 'GET',
    path: circuitPath.collection(),
    query: paginationQuery(params),
    schema: wireCircuitResponses.CircuitPageResponse,
    ...context,
  })
}

/** `POST /circuits` — a new circuit and its first version, in one write. */
export function createCircuit(
  client: ApiClient,
  body: CreateCircuitRequest,
  context: RequestContext = {}
): Promise<CircuitWithVersion> {
  return client.request({
    method: 'POST',
    path: circuitPath.collection(),
    body,
    schema: wireCircuitResponses.CircuitWithVersionResponse,
    ...context,
  })
}

/**
 * `GET /circuits/:id` — by slug or by id, and readable anonymously when the
 * circuit is PUBLIC or the caller holds an UNLISTED slug.
 */
export function getCircuit(
  client: ApiClient,
  handle: string,
  context: RequestContext = {}
): Promise<CircuitWithVersion> {
  return client.request({
    method: 'GET',
    path: circuitPath.item(handle),
    schema: wireCircuitResponses.CircuitWithVersionResponse,
    ...context,
  })
}

/** `PATCH /circuits/:id` — metadata only; the document is never patched. */
export function updateCircuit(
  client: ApiClient,
  handle: string,
  body: UpdateCircuitRequest,
  context: RequestContext = {}
): Promise<CircuitEnvelope> {
  return client.request({
    method: 'PATCH',
    path: circuitPath.item(handle),
    body,
    schema: wireCircuitResponses.CircuitEnvelope,
    ...context,
  })
}

/** `DELETE /circuits/:id` — 204, so there is no body to parse. */
export function deleteCircuit(
  client: ApiClient,
  handle: string,
  context: RequestContext = {}
): Promise<void> {
  return client.request({
    method: 'DELETE',
    path: circuitPath.item(handle),
    schema: null,
    ...context,
  })
}

/**
 * `POST /circuits/:id/fork` — copies the current version into a circuit the
 * caller owns, PRIVATE regardless of the source's visibility.
 *
 * With no title, no body is sent at all rather than a JSON `null`. Both are
 * accepted by the route (its schema is `.nullable()` precisely because
 * Fastify hands the validator `null` for an absent body), and sending nothing
 * is the path the API's own tests exercise.
 */
export function forkCircuit(
  client: ApiClient,
  handle: string,
  body?: ForkCircuitRequest,
  context: RequestContext = {}
): Promise<CircuitWithVersion> {
  return client.request({
    method: 'POST',
    path: circuitPath.fork(handle),
    ...(body == null ? {} : { body }),
    schema: wireCircuitResponses.CircuitWithVersionResponse,
    ...context,
  })
}

/** `GET /circuits/:id/versions` — as visible as the circuit itself, no more. */
export function listVersions(
  client: ApiClient,
  handle: string,
  params?: PaginationParams,
  context: RequestContext = {}
): Promise<VersionPage> {
  return client.request({
    method: 'GET',
    path: circuitPath.versions(handle),
    query: paginationQuery(params),
    schema: wireCircuitResponses.VersionPageResponse,
    ...context,
  })
}

/**
 * `POST /circuits/:id/versions` — the only way to change a stored document.
 * History is appended, never rewritten, which is what makes "restore version
 * 3" a matter of saving version 3's payload as version 8.
 */
export function createVersion(
  client: ApiClient,
  handle: string,
  body: CreateVersionRequest,
  context: RequestContext = {}
): Promise<VersionEnvelope> {
  return client.request({
    method: 'POST',
    path: circuitPath.versions(handle),
    body,
    schema: wireCircuitResponses.VersionEnvelope,
    ...context,
  })
}

/** `GET /circuits/:id/versions/:n` — one version with its payload. */
export function getVersion(
  client: ApiClient,
  handle: string,
  versionNum: number,
  context: RequestContext = {}
): Promise<VersionEnvelope> {
  return client.request({
    method: 'GET',
    path: circuitPath.version(handle, versionNum),
    schema: wireCircuitResponses.VersionEnvelope,
    ...context,
  })
}
