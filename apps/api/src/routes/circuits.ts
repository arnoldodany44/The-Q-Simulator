/**
 * Circuits and their immutable version history — §8, milestone M1.4.
 *
 * ── The shape every route here has ────────────────────────────────────────
 *
 *   1. resolve the circuit through `findReadable`, which applies §11 *in the
 *      query* and returns `null` for "no such circuit" and for "not yours to
 *      see" alike;
 *   2. `null` → 404, never 403, because 403 would confirm that a slug exists;
 *   3. for a write, check ownership and answer 403 — by then the caller has
 *      already proved they can see it, so admitting it exists costs nothing;
 *   4. do the work, scoping the write to `ownerId` a second time so that a
 *      future route that skips step 3 still cannot touch somebody else's row.
 *
 * Steps 1 and 2 are not decoration. Prisma connects as `postgres` and
 * bypasses row-level security, so a route that reads without the filter does
 * not fail a test — it leaks. `app.circuits` deliberately offers no read that
 * skips the viewer.
 *
 * ── Versions are appended, never rewritten ────────────────────────────────
 *
 * `PATCH /circuits/:id` changes the title, the description and the
 * visibility, and cannot touch the document. Changing the document is
 * `POST /circuits/:id/versions`, which appends. There is no update and no
 * delete for a version, which is what makes "restore version 3" a matter of
 * saving version 3's payload as version 8 rather than of rewriting history.
 *
 * ── Everything derived is derived here ────────────────────────────────────
 *
 * `qubitCount`, `gateCount` and `depth` never appear in a request schema.
 * They are computed from the circuit by `@qsim/db`'s `metricsOf`, which calls
 * @qsim/schema's helpers — the same functions the editor showed the user.
 */

import { CIRCUIT_ROUTES } from '@qsim/contract'
import {
  canEditCircuit,
  forkCircuit,
  MissingVersionError,
  type StoredVersion,
} from '@qsim/db'
import { CircuitValidationError, safeParseCircuit } from '@qsim/schema'
import type { Circuit } from '@qsim/schema'
import type {
  FastifyInstance,
  FastifyPluginCallback,
  FastifyRequest,
} from 'fastify'
import type { ApiEnv } from '../env.js'
import { ApiError } from '../errors.js'
import { requireViewerId, viewerIdOf } from '../plugins/auth.js'
import { strictRateLimit } from '../plugins/rate-limit.js'
import {
  MAX_ERROR_DETAILS,
  withTruncationMarker,
} from '../plugins/validation.js'
import type { ZodTypeProvider } from '../plugins/validation.js'
import {
  CircuitEnvelope,
  CircuitHandleParams,
  CircuitPageResponse,
  CircuitWithVersionResponse,
  CreateCircuitBody,
  CreateVersionBody,
  ForkCircuitBody,
  PaginationQuery,
  UpdateCircuitBody,
  VersionEnvelope,
  VersionPageResponse,
  VersionParams,
  toPage,
} from './circuits.schemas.js'

export interface CircuitRoutesOptions {
  readonly env: ApiEnv
}

/**
 * Validates an incoming circuit with @qsim/schema and nothing else.
 *
 * This runs even though the route schema already declared `CircuitSchema`,
 * and the redundancy is deliberate. `safeParseCircuit` is the *whole*
 * contract — shape plus the thirteen semantic rules a shape cannot express,
 * such as two gates fighting over one qubit in one column — and §11 requires
 * that no circuit reach the engine or the database without it. The route
 * schema exists for a different reason: it makes a 400 name the field that
 * was wrong. If somebody later simplifies the route schema away, nothing
 * here becomes unsafe, which is the failure mode worth designing for.
 *
 * The issues travel as codes, one per problem, keyed by the operation id the
 * editor can highlight. The wording stays on the client, which holds this
 * same schema and can say it in three languages (D2).
 *
 * Capped at `MAX_ERROR_DETAILS`, for the reason argued in full there: a 400
 * must not cost more to send than the request cost to receive, and a circuit
 * of five thousand broken operations produced ten thousand of these. The full
 * list still goes to the log, inside the `CircuitValidationError` below.
 */
function acceptCircuit(input: unknown): Circuit {
  const result = safeParseCircuit(input)
  if (result.ok) return result.circuit

  const details = result.issues.slice(0, MAX_ERROR_DETAILS).map((issue) => ({
    path:
      issue.operationId === undefined
        ? 'body.circuit'
        : `body.circuit.operations.${issue.operationId}`,
    code: issue.code,
  }))

  throw new ApiError('VALIDATION_FAILED', {
    details: withTruncationMarker(
      details,
      result.issues.length,
      'body.circuit'
    ),
    // Kept for the log only; `ApiError` never serialises a cause.
    cause: new CircuitValidationError(result.issues),
  })
}

/**
 * The `public.User` row the circuit's foreign key points at, created on the
 * caller's first write (see `users.ts` for why here and not in a trigger).
 *
 * Only the two routes that *create* a circuit call this. A caller who is
 * patching or saving a version already owns a circuit, so their row exists,
 * and doing a write on the read path of every request would be a cost paid
 * forever for a case that happens once per account.
 */
async function ensureOwnerId(
  app: FastifyInstance,
  request: FastifyRequest
): Promise<string> {
  const identity = request.auth
  // Unreachable on a route declaring `auth: 'required'`; throwing rather than
  // asserting keeps a policy mistake a 401 instead of a 500.
  if (identity === null) throw new ApiError('AUTH_REQUIRED')
  if (identity.email === null) throw new ApiError('USER_EMAIL_REQUIRED')

  const user = await app.circuits.ensureOwner({
    id: identity.userId,
    email: identity.email,
    displayName: identity.displayName,
    avatarUrl: identity.avatarUrl,
  })
  return user.id
}

/** The circuit this request names, or 404 — never 403, and never a leak. */
async function readableCircuit(
  app: FastifyInstance,
  request: FastifyRequest,
  handle: string
) {
  const circuit = await app.circuits.findReadable(handle, viewerIdOf(request))
  if (circuit === null) throw new ApiError('NOT_FOUND')
  return circuit
}

/** Rejects a write by anyone but the owner. Visibility is irrelevant here. */
function assertOwner(circuit: { ownerId: string }, viewerId: string): void {
  if (!canEditCircuit(circuit, viewerId)) throw new ApiError('FORBIDDEN')
}

/** Renames `data` to `circuit`, which is what the wire calls it. */
function toVersionResponse(version: StoredVersion) {
  return {
    id: version.id,
    versionNum: version.versionNum,
    message: version.message,
    createdAt: version.createdAt,
    circuit: version.data,
  }
}

const plugin: FastifyPluginCallback<CircuitRoutesOptions> = (
  instance,
  options,
  done
) => {
  const app = instance.withTypeProvider<ZodTypeProvider>()
  const { env } = options

  /*
   * The stricter budget of §11 goes on the two routes that create rows.
   * Appending a version is deliberately left on the ordinary budget: it can
   * only grow a circuit the caller already owns, whereas POST /circuits and
   * /fork are the routes an unattended script uses to fill a table.
   */
  const createLimit = strictRateLimit(env)

  app.get(
    CIRCUIT_ROUTES.collection,
    {
      config: { auth: 'required' },
      schema: {
        querystring: PaginationQuery,
        response: { 200: CircuitPageResponse },
      },
    },
    async (request) => {
      /*
       * "Mine", literally: scoped to the owner and not to
       * `listableCircuitFilter`, so this never becomes a way to discover
       * someone else's work. It is also the one listing where PRIVATE and
       * UNLISTED belong — they are the caller's own.
       */
      const ownerId = requireViewerId(request)
      const { page, perPage } = request.query
      const { items, total } = await app.circuits.listOwned({
        ownerId,
        skip: (page - 1) * perPage,
        take: perPage,
      })
      return toPage(items, total, page, perPage)
    }
  )

  app.post(
    CIRCUIT_ROUTES.collection,
    {
      config: { auth: 'required', rateLimit: createLimit },
      schema: {
        body: CreateCircuitBody,
        response: { 201: CircuitWithVersionResponse },
      },
    },
    async (request, reply) => {
      const circuit = acceptCircuit(request.body.circuit)
      const ownerId = await ensureOwnerId(app, request)

      const created = await app.circuits.create({
        ownerId,
        title: request.body.title,
        description: request.body.description ?? null,
        visibility: request.body.visibility,
        data: circuit,
        message: request.body.message ?? null,
        // Attribution is set by the fork route and by nothing a client sends:
        // a forged `forkedFromId` would credit an unrelated circuit.
        forkedFromId: null,
      })

      reply.status(201)
      return {
        circuit: created.circuit,
        version: toVersionResponse(created.version),
      }
    }
  )

  app.get(
    CIRCUIT_ROUTES.item,
    {
      // Anonymous is allowed: this is how a PUBLIC circuit is read and how an
      // UNLISTED link works at all. The viewer id — `null` or a verified
      // `sub` — is what decides which of the three it may be.
      config: { auth: 'optional' },
      schema: {
        params: CircuitHandleParams,
        response: { 200: CircuitWithVersionResponse },
      },
    },
    async (request) => {
      const circuit = await readableCircuit(app, request, request.params.id)
      const version = await app.circuits.latestVersion(circuit.id)
      /*
       * A circuit is created with version 1 in the same transaction, so a row
       * that persists in this state would mean the data is inconsistent. The
       * reachable way to get here is far more ordinary: the owner deleted the
       * circuit between the two statements above and the cascade took the
       * versions with it. `MissingVersionError` maps to 404 for that reason —
       * a reader who loads a PUBLIC circuit at the moment its owner removes
       * it must be told what the next request would tell them, not that the
       * server is broken.
       */
      if (version === null) throw new MissingVersionError(circuit.id)
      return { circuit, version: toVersionResponse(version) }
    }
  )

  app.patch(
    CIRCUIT_ROUTES.item,
    {
      config: { auth: 'required' },
      schema: {
        params: CircuitHandleParams,
        body: UpdateCircuitBody,
        response: { 200: CircuitEnvelope },
      },
    },
    async (request) => {
      const viewerId = requireViewerId(request)
      const circuit = await readableCircuit(app, request, request.params.id)
      assertOwner(circuit, viewerId)

      const updated = await app.circuits.update({
        id: circuit.id,
        ownerId: viewerId,
        ...request.body,
      })
      // Only reachable if the circuit was deleted between the read and the
      // write. 404 is then the truth.
      if (updated === null) throw new ApiError('NOT_FOUND')
      return { circuit: updated }
    }
  )

  app.delete(
    CIRCUIT_ROUTES.item,
    {
      config: { auth: 'required' },
      schema: { params: CircuitHandleParams },
    },
    async (request, reply) => {
      const viewerId = requireViewerId(request)
      const circuit = await readableCircuit(app, request, request.params.id)
      assertOwner(circuit, viewerId)

      // Versions go with it by `onDelete: Cascade`. Immutability is a promise
      // about editing history, not about keeping a circuit its owner deleted.
      const removed = await app.circuits.remove({
        id: circuit.id,
        ownerId: viewerId,
      })
      if (!removed) throw new ApiError('NOT_FOUND')
      return reply.status(204).send()
    }
  )

  app.post(
    CIRCUIT_ROUTES.fork,
    {
      config: { auth: 'required', rateLimit: createLimit },
      schema: {
        params: CircuitHandleParams,
        body: ForkCircuitBody,
        response: { 201: CircuitWithVersionResponse },
      },
    },
    async (request, reply) => {
      /*
       * The read happens first and through the same filter as every other
       * read, which is what makes "you cannot fork what you cannot see" true
       * rather than merely intended: a PRIVATE circuit belonging to somebody
       * else is a 404 here, exactly as it is on GET.
       */
      const source = await readableCircuit(app, request, request.params.id)
      const ownerId = await ensureOwnerId(app, request)

      const created = await forkCircuit(app.circuits, {
        source,
        ownerId,
        title: request.body?.title,
      })

      reply.status(201)
      return {
        circuit: created.circuit,
        version: toVersionResponse(created.version),
      }
    }
  )

  app.get(
    CIRCUIT_ROUTES.versions,
    {
      /*
       * The route it would be easiest to leave `required` or to forget the
       * filter on. History is as visible as the circuit it belongs to and no
       * more: `readableCircuit` decides, and it is the same call the page
       * itself makes.
       */
      config: { auth: 'optional' },
      schema: {
        params: CircuitHandleParams,
        querystring: PaginationQuery,
        response: { 200: VersionPageResponse },
      },
    },
    async (request) => {
      const circuit = await readableCircuit(app, request, request.params.id)
      const { page, perPage } = request.query
      const { items, total } = await app.circuits.listVersions({
        circuitId: circuit.id,
        skip: (page - 1) * perPage,
        take: perPage,
      })
      return toPage(items, total, page, perPage)
    }
  )

  app.post(
    CIRCUIT_ROUTES.versions,
    {
      config: { auth: 'required' },
      schema: {
        params: CircuitHandleParams,
        body: CreateVersionBody,
        response: { 201: VersionEnvelope },
      },
    },
    async (request, reply) => {
      const viewerId = requireViewerId(request)
      const circuit = await readableCircuit(app, request, request.params.id)
      assertOwner(circuit, viewerId)

      const data = acceptCircuit(request.body.circuit)
      const version = await app.circuits.appendVersion({
        circuitId: circuit.id,
        // Step 4: the write is scoped to the owner a second time, so that a
        // future route which skips `assertOwner` still cannot append to
        // somebody else's history — the one write in the repository that
        // could not express this until now.
        ownerId: viewerId,
        data,
        message: request.body.message ?? null,
      })

      reply.status(201)
      return { version: toVersionResponse(version) }
    }
  )

  app.get(
    CIRCUIT_ROUTES.version,
    {
      config: { auth: 'optional' },
      schema: {
        params: VersionParams,
        response: { 200: VersionEnvelope },
      },
    },
    async (request) => {
      const circuit = await readableCircuit(app, request, request.params.id)
      const version = await app.circuits.findVersion({
        circuitId: circuit.id,
        versionNum: request.params.n,
      })
      if (version === null) throw new ApiError('NOT_FOUND')
      return { version: toVersionResponse(version) }
    }
  )

  done()
}

export const circuitRoutes = plugin
