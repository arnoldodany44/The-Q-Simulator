/**
 * The public API, described once — §3.5.
 *
 * ══════════════════════════════════════════════════════════════════════════
 * WHY THIS IS GENERATED AND NOT WRITTEN
 *
 * Hand-written API documentation is wrong within a month, and the way it goes
 * wrong is invisible: a field gains a bound, a response gains a key, a query
 * parameter is renamed, and the prose that described them keeps compiling
 * because prose does not compile. The person who finds out is a stranger, in
 * their own codebase, from a 400 whose cause the documentation actively
 * contradicts.
 *
 * So every shape below is *the Zod schema the server validates with*. There is
 * no second description of a field anywhere in this file: `z.toJSONSchema`
 * turns `CreateCircuitBody` into the JSON Schema published at
 * `GET /api/v1/openapi.json`, and the same object renders the field tables in
 * `docs/api.md`. Renaming a field in the contract renames it in the reference
 * on the same commit, and a schema this file cannot convert is a failing test
 * rather than a paragraph nobody updated.
 *
 * What *is* written by hand is what a schema cannot say: what an endpoint is
 * for, and which of them a person needs in what order. Those live in the
 * `summary` and `description` fields below and in `WORKED_EXAMPLE`, which is
 * itself checked — every example request in it is parsed through the very
 * schema its route declares, so an example that stopped being valid fails the
 * suite instead of misleading a reader.
 *
 * ══════════════════════════════════════════════════════════════════════════
 * THE TABLE IS THE SURFACE, AND THE SURFACE IS CHECKED
 *
 * `PUBLIC_ROUTES` is not a description of the API: it is a *claim* about it,
 * and `apps/api` refutes it. The router records every route that declares a
 * scope into `app.apiKeySurface`, and a test asserts that recording is exactly
 * this list. A route that quietly joins the public API without being written
 * down here fails the build, and so does an entry here for a route that does
 * not exist.
 *
 * That is the property worth having. Documentation drifting from behaviour is
 * a nuisance; a *published surface* drifting from an *enforced* one is a
 * security bug, because the two disagree about which endpoints a leaked key
 * can reach.
 */

import { z } from 'zod'
import type { ApiKeyScope } from './api-keys.js'
import { CreateApiKeyBody, serverApiKeyResponses } from './api-keys.js'
import { API_ERROR_CODES } from './errors.js'
import type { ApiErrorCode } from './errors.js'
import {
  CreateCircuitBody,
  CreateVersionBody,
  ForkCircuitBody,
  PaginationQuery,
  UpdateCircuitBody,
  wireCircuitResponses,
} from './circuits.js'
import {
  AddCollectionItemBody,
  CreateCollectionBody,
  UpdateCollectionBody,
  wireCollectionResponses,
} from './collections.js'
import { GalleryQuerySchema, StarStateResponse } from './gallery.js'
import { SimulateBody, wireSimulateResponses } from './simulate.js'
import { wireUserResponses } from './users.js'
import {
  API_KEY_ROUTES,
  API_PREFIX,
  CIRCUIT_ROUTES,
  COLLECTION_ROUTES,
  GALLERY_ROUTES,
  SIMULATE_ROUTES,
  USER_ROUTES,
} from './paths.js'

export type HttpMethod = 'GET' | 'POST' | 'PATCH' | 'DELETE'

/** One documented response. */
export interface RouteResponse {
  readonly status: number
  readonly description: string
  /** Absent for a 204, which has no body by definition. */
  readonly schema?: z.ZodType
}

/**
 * One endpoint of the public API.
 *
 * `scope` is `null` for the three key-management routes, which are documented
 * because a reader needs to know they exist and are **not** reachable with a
 * key — see `api-keys.ts` for why that is permanent.
 */
export interface PublicRoute {
  readonly operationId: string
  readonly method: HttpMethod
  /** The template, relative to `API_PREFIX`, exactly as the router has it. */
  readonly path: string
  readonly scope: ApiKeyScope | null
  /** Whether an anonymous caller gets an answer at all. */
  readonly anonymous: boolean
  readonly summary: string
  readonly description: string
  /** Keyed by the `:name` in `path`; every one of them must be described. */
  readonly params?: Readonly<Record<string, string>>
  readonly query?: z.ZodType
  readonly body?: z.ZodType
  readonly responses: readonly RouteResponse[]
  /** Failures worth naming beyond the universal ones. */
  readonly errors?: readonly ApiErrorCode[]
}

const circuits = wireCircuitResponses
const collections = wireCollectionResponses
const runs = wireSimulateResponses
const users = wireUserResponses
const apiKeys = serverApiKeyResponses

/** The handle in a path: a slug for a public address, or an id. */
const HANDLE_PARAM =
  'The circuit’s `slug` or its `id`. Both are unique; a slug is the ' +
  'shareable form and is the only handle that reaches an UNLISTED circuit.'

export const PUBLIC_ROUTES: readonly PublicRoute[] = [
  /* ─────────────────────────────── circuits ─────────────────────────── */
  {
    operationId: 'listCircuits',
    method: 'GET',
    path: CIRCUIT_ROUTES.collection,
    scope: 'read',
    anonymous: false,
    summary: 'List your own circuits',
    description:
      'Every circuit the authenticated account owns, newest first, whatever ' +
      'its visibility. This is the one listing that includes PRIVATE work, ' +
      'because it is the caller’s own.',
    query: PaginationQuery,
    responses: [
      {
        status: 200,
        description: 'A page of circuit cards.',
        schema: circuits.CircuitPageResponse,
      },
    ],
  },
  {
    operationId: 'createCircuit',
    method: 'POST',
    path: CIRCUIT_ROUTES.collection,
    scope: 'write',
    anonymous: false,
    summary: 'Create a circuit',
    description:
      'Stores the document as version 1. `qubitCount`, `gateCount` and ' +
      '`depth` are derived from the circuit by the server and are not accepted ' +
      'in the body — sending them changes nothing. Visibility defaults to ' +
      'PRIVATE.',
    body: CreateCircuitBody,
    responses: [
      {
        status: 201,
        description: 'The circuit and its first version.',
        schema: circuits.CircuitWithVersionResponse,
      },
    ],
    errors: ['CIRCUIT_TOO_LARGE'],
  },
  {
    operationId: 'getCircuit',
    method: 'GET',
    path: CIRCUIT_ROUTES.item,
    scope: 'read',
    anonymous: true,
    summary: 'Read one circuit and its latest version',
    description:
      'Answers for a PUBLIC circuit to anybody, for an UNLISTED one to ' +
      'whoever holds its slug, and for a PRIVATE one only to its owner. A ' +
      'circuit you may not see answers 404, never 403 — the two must not be ' +
      'distinguishable.',
    params: { id: HANDLE_PARAM },
    responses: [
      {
        status: 200,
        description:
          'The circuit, its latest version, and whether you have starred it.',
        schema: circuits.CircuitViewResponse,
      },
    ],
  },
  {
    operationId: 'updateCircuit',
    method: 'PATCH',
    path: CIRCUIT_ROUTES.item,
    scope: 'write',
    anonymous: false,
    summary: 'Change a circuit’s title, description, visibility or tags',
    description:
      'Cannot touch the document: changing the circuit itself is a new ' +
      'version. At least one field must be present.',
    params: { id: HANDLE_PARAM },
    body: UpdateCircuitBody,
    responses: [
      {
        status: 200,
        description: 'The updated circuit.',
        schema: circuits.CircuitEnvelope,
      },
    ],
    errors: ['FORBIDDEN'],
  },
  {
    operationId: 'deleteCircuit',
    method: 'DELETE',
    path: CIRCUIT_ROUTES.item,
    scope: 'write',
    anonymous: false,
    summary: 'Delete a circuit and every version of it',
    description: 'Irreversible. The versions go with it, by cascade.',
    params: { id: HANDLE_PARAM },
    responses: [{ status: 204, description: 'Deleted.' }],
    errors: ['FORBIDDEN'],
  },
  {
    operationId: 'forkCircuit',
    method: 'POST',
    path: CIRCUIT_ROUTES.fork,
    scope: 'write',
    anonymous: false,
    summary: 'Fork a circuit you can read',
    description:
      'Copies the latest version into a new circuit owned by you, PRIVATE by ' +
      'default, with `forkedFromId` set. Attribution is set by the server and ' +
      'never by a request body.',
    params: { id: HANDLE_PARAM },
    body: ForkCircuitBody,
    responses: [
      {
        status: 201,
        description: 'The new circuit and its first version.',
        schema: circuits.CircuitWithVersionResponse,
      },
    ],
  },
  {
    operationId: 'starCircuit',
    method: 'POST',
    path: CIRCUIT_ROUTES.star,
    scope: 'write',
    anonymous: false,
    summary: 'Star a circuit',
    description: 'Idempotent: starring twice is one star.',
    params: { id: HANDLE_PARAM },
    responses: [
      {
        status: 200,
        description: 'The new star count and your own state.',
        schema: StarStateResponse,
      },
    ],
  },
  {
    operationId: 'unstarCircuit',
    method: 'DELETE',
    path: CIRCUIT_ROUTES.star,
    scope: 'write',
    anonymous: false,
    summary: 'Remove your star',
    description: 'Idempotent: unstarring twice is not a negative count.',
    params: { id: HANDLE_PARAM },
    responses: [
      {
        status: 200,
        description: 'The new star count and your own state.',
        schema: StarStateResponse,
      },
    ],
  },
  {
    operationId: 'listVersions',
    method: 'GET',
    path: CIRCUIT_ROUTES.versions,
    scope: 'read',
    anonymous: true,
    summary: 'List a circuit’s versions',
    description:
      'Metadata only. The document of one version is fetched separately, ' +
      'because a version payload can be hundreds of kilobytes.',
    params: { id: HANDLE_PARAM },
    query: PaginationQuery,
    responses: [
      {
        status: 200,
        description: 'A page of version summaries, newest first.',
        schema: circuits.VersionPageResponse,
      },
    ],
  },
  {
    operationId: 'createVersion',
    method: 'POST',
    path: CIRCUIT_ROUTES.versions,
    scope: 'write',
    anonymous: false,
    summary: 'Save a new version',
    description:
      'Appends. Versions are immutable and numbered per circuit, so there is ' +
      'no update and no delete — restoring version 3 means saving its payload ' +
      'as version 8.',
    params: { id: HANDLE_PARAM },
    body: CreateVersionBody,
    responses: [
      {
        status: 201,
        description: 'The stored version.',
        schema: circuits.VersionEnvelope,
      },
    ],
    errors: ['VERSION_CONFLICT', 'CIRCUIT_TOO_LARGE', 'FORBIDDEN'],
  },
  {
    operationId: 'getVersion',
    method: 'GET',
    path: CIRCUIT_ROUTES.version,
    scope: 'read',
    anonymous: true,
    summary: 'Read one version’s document',
    description: 'The full circuit as it was saved.',
    params: { id: HANDLE_PARAM, n: 'The version number, counting from 1.' },
    responses: [
      {
        status: 200,
        description: 'The version and its circuit.',
        schema: circuits.VersionEnvelope,
      },
    ],
  },

  /* ──────────────────────────────── gallery ─────────────────────────── */
  {
    operationId: 'listGallery',
    method: 'GET',
    path: GALLERY_ROUTES.gallery,
    scope: 'read',
    anonymous: true,
    summary: 'Browse published circuits',
    description:
      'Only PUBLIC circuits, plus your own if you are authenticated. Paged ' +
      'with a cursor rather than an offset: the default ordering is a column ' +
      'other people change while you read, and an OFFSET over a moving order ' +
      'repeats or skips rows silently. Pass the `nextCursor` you were given.',
    query: GalleryQuerySchema,
    responses: [
      {
        status: 200,
        description: 'A cursor page of circuit cards.',
        schema: circuits.GalleryPageResponse,
      },
    ],
  },
  {
    operationId: 'listUserCircuits',
    method: 'GET',
    path: GALLERY_ROUTES.userCircuits,
    scope: 'read',
    anonymous: true,
    summary: 'Browse one author’s published circuits',
    description:
      'The gallery query narrowed to one account. What you see is what that ' +
      'account has published to you, so an owner reading their own sees more.',
    params: { username: 'The author’s public handle.' },
    query: GalleryQuerySchema,
    responses: [
      {
        status: 200,
        description: 'A cursor page, plus the author.',
        schema: circuits.UserCircuitsResponse,
      },
    ],
  },
  {
    operationId: 'getProfile',
    method: 'GET',
    path: USER_ROUTES.profile,
    scope: 'read',
    anonymous: true,
    summary: 'Read one account’s public profile',
    description:
      'A name, a picture and two counts. Both counts go through the same ' +
      'visibility filters the listings do, so the number is the number of ' +
      'cards you would get by paging to the end.',
    params: { username: 'The account’s public handle.' },
    responses: [
      {
        status: 200,
        description: 'The profile.',
        schema: users.ProfileResponse,
      },
    ],
  },

  /* ─────────────────────────────── simulation ───────────────────────── */
  {
    operationId: 'simulate',
    method: 'POST',
    path: SIMULATE_ROUTES.collection,
    scope: 'simulate',
    anonymous: true,
    summary: 'Run a simulation',
    description:
      'Small circuits are answered synchronously with a finished run; larger ' +
      'ones are queued and answered 202 with a run you poll. Either way the ' +
      'response is the same shape, so a client that reads `status` needs no ' +
      'second code path. Qubit 0 is the least significant bit of every ' +
      'bitstring in the result.',
    body: SimulateBody,
    responses: [
      {
        status: 200,
        description: 'A finished run, computed during the request.',
        schema: runs.RunEnvelope,
      },
      {
        status: 201,
        description: 'A finished run that was stored against a circuit.',
        schema: runs.RunEnvelope,
      },
      {
        status: 202,
        description: 'A queued run. Poll it with the id.',
        schema: runs.RunEnvelope,
      },
    ],
    errors: ['SIMULATION_TOO_LARGE', 'SIMULATION_UNAVAILABLE'],
  },
  {
    operationId: 'getRun',
    method: 'GET',
    path: SIMULATE_ROUTES.run,
    scope: 'read',
    anonymous: true,
    summary: 'Read a run',
    description:
      'A run belongs to whoever asked for it, not to the circuit — several ' +
      'runs of one circuit may differ only by seed. Poll this until `status` ' +
      'is `DONE` or `FAILED`.',
    params: { runId: 'The id from the run you were given.' },
    responses: [
      {
        status: 200,
        description: 'The run, with its result once it has one.',
        schema: runs.RunEnvelope,
      },
    ],
  },

  /* ────────────────────────────── collections ───────────────────────── */
  {
    operationId: 'listCollections',
    method: 'GET',
    path: COLLECTION_ROUTES.collection,
    scope: 'read',
    anonymous: false,
    summary: 'List your own collections',
    description: 'Yours, whatever their visibility.',
    query: PaginationQuery,
    responses: [
      {
        status: 200,
        description: 'A page of collection cards.',
        schema: collections.CollectionPageResponse,
      },
    ],
  },
  {
    operationId: 'createCollection',
    method: 'POST',
    path: COLLECTION_ROUTES.collection,
    scope: 'write',
    anonymous: false,
    summary: 'Create a collection',
    description: 'PRIVATE by default, like a circuit.',
    body: CreateCollectionBody,
    responses: [
      {
        status: 201,
        description: 'The new collection.',
        schema: collections.CollectionEnvelope,
      },
    ],
  },
  {
    operationId: 'getCollection',
    method: 'GET',
    path: COLLECTION_ROUTES.item,
    scope: 'read',
    anonymous: true,
    summary: 'Read a collection and what you may see inside it',
    description:
      'A collection’s visibility governs the collection and never its ' +
      'contents: a PUBLIC collection holding a PRIVATE circuit does not ' +
      'publish it. `withheldItemCount` says how many items were hidden from ' +
      'you — a number, never an identifier.',
    params: { id: 'The collection’s id.' },
    responses: [
      {
        status: 200,
        description: 'The collection and its visible items.',
        schema: collections.CollectionViewResponse,
      },
    ],
  },
  {
    operationId: 'updateCollection',
    method: 'PATCH',
    path: COLLECTION_ROUTES.item,
    scope: 'write',
    anonymous: false,
    summary: 'Change a collection’s title, description or visibility',
    description: 'At least one field must be present.',
    params: { id: 'The collection’s id.' },
    body: UpdateCollectionBody,
    responses: [
      {
        status: 200,
        description: 'The updated collection.',
        schema: collections.CollectionEnvelope,
      },
    ],
    errors: ['FORBIDDEN'],
  },
  {
    operationId: 'deleteCollection',
    method: 'DELETE',
    path: COLLECTION_ROUTES.item,
    scope: 'write',
    anonymous: false,
    summary: 'Delete a collection',
    description:
      'The circuits in it are untouched: a collection holds references, and ' +
      'deleting the shelf does not burn the books.',
    params: { id: 'The collection’s id.' },
    responses: [{ status: 204, description: 'Deleted.' }],
    errors: ['FORBIDDEN'],
  },
  {
    operationId: 'addCollectionItem',
    method: 'POST',
    path: COLLECTION_ROUTES.items,
    scope: 'write',
    anonymous: false,
    summary: 'Add a circuit to a collection',
    description:
      'Two authorisations, both checked: you own the collection, and you may ' +
      'read the circuit. Idempotent.',
    params: { id: 'The collection’s id.' },
    body: AddCollectionItemBody,
    responses: [
      {
        status: 200,
        description: 'The collection, with its new item count.',
        schema: collections.CollectionEnvelope,
      },
    ],
    errors: ['COLLECTION_FULL', 'FORBIDDEN'],
  },
  {
    operationId: 'removeCollectionItem',
    method: 'DELETE',
    path: COLLECTION_ROUTES.member,
    scope: 'write',
    anonymous: false,
    summary: 'Remove a circuit from a collection',
    description: 'Idempotent.',
    params: {
      id: 'The collection’s id.',
      circuitId: 'The circuit’s id, as the collection lists it.',
    },
    responses: [
      {
        status: 200,
        description: 'The collection.',
        schema: collections.CollectionEnvelope,
      },
    ],
    errors: ['FORBIDDEN'],
  },
  {
    operationId: 'listCircuitCollections',
    method: 'GET',
    path: COLLECTION_ROUTES.membership,
    scope: 'read',
    anonymous: false,
    summary: 'Which of your collections already hold a circuit',
    description:
      'Scoped to your own collections. "Who has collected this" is a ' +
      'different question about other people’s curation, and this API does ' +
      'not answer it.',
    params: { id: HANDLE_PARAM },
    responses: [
      {
        status: 200,
        description: 'The ids of your collections holding it.',
        schema: collections.CollectionMembershipResponse,
      },
    ],
  },
  {
    operationId: 'listUserCollections',
    method: 'GET',
    path: USER_ROUTES.collections,
    scope: 'read',
    anonymous: true,
    summary: 'Browse one account’s collections',
    description: 'What that account has published to you.',
    params: { username: 'The account’s public handle.' },
    query: PaginationQuery,
    responses: [
      {
        status: 200,
        description: 'A page of collection cards.',
        schema: collections.CollectionPageResponse,
      },
    ],
  },

  /* ───────────────────────── keys, session only ─────────────────────── */
  {
    operationId: 'listApiKeys',
    method: 'GET',
    path: API_KEY_ROUTES.collection,
    scope: null,
    anonymous: false,
    summary: 'List your API keys',
    description:
      'Metadata only. No endpoint returns a key, including this one and ' +
      'including to the account that owns it — the server stores a SHA-256 ' +
      'and cannot reproduce the original.',
    responses: [
      {
        status: 200,
        description: 'Your keys, revoked ones included.',
        schema: apiKeys.ApiKeyListEnvelope,
      },
    ],
  },
  {
    operationId: 'createApiKey',
    method: 'POST',
    path: API_KEY_ROUTES.collection,
    scope: null,
    anonymous: false,
    summary: 'Mint an API key',
    description:
      'The only response in this API that contains a key. Store it now: it ' +
      'is not recoverable, and the remedy for losing it is to revoke this key ' +
      'and mint another.',
    body: CreateApiKeyBody,
    responses: [
      {
        status: 201,
        description: 'The key, once, and its metadata.',
        schema: apiKeys.ApiKeyCreatedEnvelope,
      },
    ],
    errors: ['API_KEY_LIMIT_REACHED'],
  },
  {
    operationId: 'revokeApiKey',
    method: 'DELETE',
    path: API_KEY_ROUTES.item,
    scope: null,
    anonymous: false,
    summary: 'Revoke an API key',
    description:
      'Immediate and permanent. The next request carrying that key fails; ' +
      'there is no cache to wait out and no way to undo it. The row survives ' +
      'with a `revokedAt`, so the record of what was turned off and when is ' +
      'still there afterwards.',
    params: { id: 'The key’s id, from the listing.' },
    responses: [
      {
        status: 200,
        description: 'The revoked key.',
        schema: apiKeys.ApiKeyEnvelope,
      },
    ],
  },
]

/**
 * Failures every route can produce, so they are stated once rather than
 * repeated twenty-eight times.
 *
 * A per-route list would be longer, would look more precise, and would be the
 * first thing to rot: these come out of hooks that run before any handler, so
 * no route can opt out of them and none of them is a fact about a particular
 * endpoint.
 */
export const UNIVERSAL_ERRORS: readonly ApiErrorCode[] = [
  'AUTH_REQUIRED',
  'AUTH_INVALID_TOKEN',
  'API_KEY_SCOPE_REQUIRED',
  'RATE_LIMITED',
  'VALIDATION_FAILED',
  'NOT_FOUND',
  'INTERNAL_ERROR',
]

/** One step of the end-to-end walkthrough in the reference. */
export interface WorkedStep {
  readonly title: string
  readonly note: string
  readonly operationId: string
  /** Parsed through the route's own body schema by the test. */
  readonly request?: unknown
  /** Illustrative, and trimmed: a real response carries more. */
  readonly response?: unknown
}

/**
 * The walkthrough a stranger actually follows: make a circuit, run it, read
 * the counts.
 *
 * Every `request` here is parsed through its route's declared body schema in
 * `openapi.test.ts`, which is what stops the one part of this file that is not
 * generated from becoming the one part that is wrong. The responses are
 * abbreviated on purpose and say so — a complete one would be a screenful of
 * amplitudes and would bury the two fields the step is about.
 */
export const WORKED_EXAMPLE: readonly WorkedStep[] = [
  {
    title: 'Create a Bell pair',
    note: 'Qubit 0 is the least significant bit, here and everywhere else.',
    operationId: 'createCircuit',
    request: {
      title: 'Bell pair',
      visibility: 'PRIVATE',
      circuit: {
        schemaVersion: 1,
        qubits: 2,
        clbits: 2,
        operations: [
          { id: 'op-0', gate: 'h', targets: [0], column: 0 },
          { id: 'op-1', gate: 'cx', targets: [1], controls: [0], column: 1 },
        ],
      },
    },
    response: {
      circuit: {
        id: 'c8k2r9v4m1x7p3q6t0w5y8z2',
        slug: 'V1StGXR8Z5jdHi6BmyT',
        title: 'Bell pair',
        visibility: 'PRIVATE',
        qubitCount: 2,
        gateCount: 2,
        depth: 2,
      },
      version: { versionNum: 1 },
    },
  },
  {
    title: 'Run it',
    note:
      'The document travels in full even when `circuitId` names a stored ' +
      'circuit: a run has to describe the circuit as it was at submission, or ' +
      'a version appended while the job waited would change what the job ' +
      'computed. `circuitId` is attribution — it is what lets the run be read ' +
      'back later under the same visibility rules. A two-qubit circuit is ' +
      'answered during the request; something larger comes back 202 with ' +
      '`status: "QUEUED"`, and the next step is how you finish it.',
    operationId: 'simulate',
    request: {
      circuitId: 'c8k2r9v4m1x7p3q6t0w5y8z2',
      shots: 1024,
      seed: 7,
      circuit: {
        schemaVersion: 1,
        qubits: 2,
        clbits: 2,
        operations: [
          { id: 'op-0', gate: 'h', targets: [0], column: 0 },
          { id: 'op-1', gate: 'cx', targets: [1], controls: [0], column: 1 },
        ],
      },
    },
    response: {
      run: {
        id: 'r4t7y1u3i9o2p5a8s0d6f2g4',
        status: 'DONE',
        shots: 1024,
        result: {
          resultVersion: 1,
          qubits: 2,
          shots: 1024,
          seed: 7,
          outcomes: [
            { state: '00', probability: 0.5, count: 508 },
            { state: '11', probability: 0.5, count: 516 },
          ],
          hiddenOutcomes: 0,
          hiddenWeight: 0,
        },
      },
    },
  },
  {
    title: 'Poll, if it was queued',
    note:
      'Until `status` is `DONE` or `FAILED`. A queued run also emits ' +
      '`run:progress` frames on the WebSocket, which is cheaper than polling ' +
      'if you are staying connected.',
    operationId: 'getRun',
    response: {
      run: { id: 'r4t7y1u3i9o2p5a8s0d6f2g4', status: 'DONE', durationMs: 41 },
    },
  },
]

/* ───────────────────────── the OpenAPI document ─────────────────────── */

/**
 * How a Zod schema becomes JSON Schema here.
 *
 * `io: 'input'` throughout, and that is the choice that makes the document
 * true rather than merely well-formed. The response schemas in this package
 * are instantiated twice — once over `z.date()` for the server and once over
 * an ISO-8601 string for the browser — and the reference describes *the
 * bytes on the wire*, which is the browser instantiation's **input** side. Its
 * output side is a `Date`, a thing JSON has never had.
 *
 * `unrepresentable: 'any'` because a few checks genuinely have no JSON Schema
 * spelling — a cross-field `refine`, for instance. Failing the conversion for
 * them would mean no document at all; describing the field as unconstrained
 * and stating the rule in prose is the honest degradation.
 *
 * `cycles: 'ref'` because a circuit document nests.
 */
const TO_JSON_SCHEMA = {
  io: 'input',
  unrepresentable: 'any',
  cycles: 'ref',
} as const

/** A JSON Schema object, as far as anything here needs to know. */
export type JsonSchema = Record<string, unknown>

export function jsonSchemaOf(schema: z.ZodType): JsonSchema {
  return z.toJSONSchema(schema, TO_JSON_SCHEMA)
}

/** The `:name` placeholders of a path template, in order. */
export function pathParamNames(path: string): string[] {
  return [...path.matchAll(/:([A-Za-z_][A-Za-z0-9_]*)/g)].map(
    (match) => match[1] as string
  )
}

/** OpenAPI wants `{name}` where the router wants `:name`. */
export function openApiPath(path: string): string {
  return `${API_PREFIX}${path.replace(/:([A-Za-z_][A-Za-z0-9_]*)/g, '{$1}')}`
}

export interface OpenApiOptions {
  /** The deployed origin, so the document is usable without editing. */
  readonly serverUrl: string
  readonly version: string
}

/**
 * The OpenAPI 3.1 document served at `GET /api/v1/openapi.json`.
 *
 * 3.1 rather than 3.0 for one concrete reason: its schema dialect *is* JSON
 * Schema 2020-12, which is what `z.toJSONSchema` emits. Targeting 3.0 would
 * mean translating — rewriting `examples` into `example`, turning
 * `type: ['string','null']` into `nullable: true` — and every one of those
 * rewrites is a place the document could stop describing the server.
 */
export function buildOpenApiDocument(options: OpenApiOptions): JsonSchema {
  const paths: Record<string, Record<string, unknown>> = {}

  for (const route of PUBLIC_ROUTES) {
    const url = openApiPath(route.path)
    const parameters: JsonSchema[] = []

    for (const name of pathParamNames(route.path)) {
      parameters.push({
        name,
        in: 'path',
        required: true,
        description: route.params?.[name] ?? '',
        schema: { type: 'string' },
      })
    }

    if (route.query !== undefined) {
      const query = jsonSchemaOf(route.query)
      const properties = (query['properties'] ?? {}) as Record<string, unknown>
      const required = new Set((query['required'] ?? []) as string[])
      for (const [name, schema] of Object.entries(properties)) {
        parameters.push({
          name,
          in: 'query',
          required: required.has(name),
          schema,
        })
      }
    }

    const responses: Record<string, unknown> = {}
    for (const response of route.responses) {
      responses[String(response.status)] = {
        description: response.description,
        ...(response.schema === undefined
          ? {}
          : {
              content: {
                'application/json': { schema: jsonSchemaOf(response.schema) },
              },
            }),
      }
    }
    /*
     * The error envelope, attached to every operation from one schema. Naming
     * it per route would be twenty-eight copies of one shape and twenty-eight
     * chances for one of them to be the stale one.
     */
    responses['4XX'] = {
      description: 'A refusal. `error.code` is the machine-readable reason.',
      content: {
        'application/json': { schema: { $ref: '#/components/schemas/Error' } },
      },
    }

    paths[url] ??= {}
    paths[url][route.method.toLowerCase()] = {
      operationId: route.operationId,
      summary: route.summary,
      description: route.description,
      tags: [route.scope === null ? 'api-keys' : 'public'],
      security:
        route.scope === null
          ? [{ session: [] }]
          : route.anonymous
            ? [{}, { apiKey: [route.scope] }, { session: [] }]
            : [{ apiKey: [route.scope] }, { session: [] }],
      ...(parameters.length > 0 ? { parameters } : {}),
      ...(route.body === undefined
        ? {}
        : {
            requestBody: {
              required: true,
              content: {
                'application/json': { schema: jsonSchemaOf(route.body) },
              },
            },
          }),
      responses,
    }
  }

  return {
    openapi: '3.1.0',
    info: {
      title: 'The Q Simulator — public API',
      version: options.version,
      description:
        'Create circuits, run simulations and read results from outside the ' +
        'application. Authenticate with an API key in the Authorization ' +
        'header. A key acts as the account that minted it and can do no more ' +
        'than that account can.',
    },
    servers: [{ url: options.serverUrl }],
    components: {
      securitySchemes: {
        apiKey: {
          type: 'http',
          scheme: 'bearer',
          description:
            'An API key: `Authorization: Bearer qsk_…`. Scoped; see each ' +
            'operation.',
        },
        session: {
          type: 'http',
          scheme: 'bearer',
          bearerFormat: 'JWT',
          description: 'A Supabase access token, as the web client sends.',
        },
      },
      schemas: {
        Error: {
          type: 'object',
          required: ['error'],
          properties: {
            error: {
              type: 'object',
              required: ['code', 'message', 'requestId'],
              properties: {
                code: { type: 'string', enum: [...API_ERROR_CODES] },
                message: {
                  type: 'string',
                  description:
                    'Developer-facing and fixed. Never display it; switch on ' +
                    '`code` instead.',
                },
                requestId: {
                  type: 'string',
                  description:
                    'Also returned as `x-request-id`. Quote it in a bug ' +
                    'report — it is what joins this response to the server ' +
                    'log line for the same request.',
                },
                details: {
                  type: 'array',
                  items: {
                    type: 'object',
                    required: ['path', 'code'],
                    properties: {
                      path: { type: 'string' },
                      code: { type: 'string' },
                    },
                  },
                },
              },
            },
          },
        },
      },
    },
    paths,
  }
}
