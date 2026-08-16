/**
 * Collections — §3.4, milestone M1.9.
 *
 * ── The rule, and where it is enforced ────────────────────────────────────
 *
 * A collection's visibility is the collection's. It says who may open the
 * page; it says nothing at all about what is on it.
 *
 * The implementation that gets this wrong is the obvious one: check the
 * viewer may see the collection, then return its circuits. Written that way, a
 * PUBLIC collection is a hole straight through §11 — put your own PRIVATE
 * circuit, or somebody else's UNLISTED one, into a public group and every
 * anonymous reader has it, with no way for the circuit's owner to notice and
 * no visibility setting of theirs that closes it.
 *
 * So `readCollectionItems` in `@qsim/db` applies `listableCircuitFilter` to
 * the *items*, with this viewer, and this file never assembles a list of
 * circuits itself. A collection is a listing: it arranges what the reader
 * could already have found. What was left out is reported as a number —
 * `withheldItemCount` — because a collection of five that silently returns two
 * is a lie about somebody's work, and a number discloses that something is
 * there without disclosing what.
 *
 * ── The shape of every route here ─────────────────────────────────────────
 *
 *   1. resolve the collection through `findReadableCollection`, which applies
 *      §11 in the query and answers `null` for "no such collection" and for
 *      "not yours to open" alike;
 *   2. `null` → 404, never 403;
 *   3. for a write, check ownership and answer 403 — by then the caller has
 *      proved they can see it, so admitting it exists costs nothing;
 *   4. scope the write to `ownerId` a second time inside the repository, so a
 *      future route that skips step 3 still cannot touch anybody else's row.
 *
 * The same four steps as `circuits.ts`, for the same reason: Prisma connects
 * as `postgres` and bypasses row-level security, so every one of these rules
 * is a `where` somebody has to remember.
 *
 * ── Adding a circuit is two authorisation questions, not one ──────────────
 *
 * You may add a circuit to a collection when you own the *collection* and you
 * may read the *circuit*. Both are checked, through the ordinary doors:
 * `findReadable` for the circuit — so somebody else's PRIVATE circuit is a 404
 * here exactly as it is on GET — and the owner scope for the collection. A
 * public circuit belonging to somebody else can be collected, which is the
 * point of a collection; it does not become yours and forking is still how you
 * build on it.
 */

import { COLLECTION_ROUTES } from '@qsim/contract'
import { canEditCollection } from '@qsim/db'
import type { FastifyInstance, FastifyPluginCallback } from 'fastify'
import type { FastifyRequest } from 'fastify'
import type { ApiEnv } from '../env.js'
import { ApiError } from '../errors.js'
import { requireViewerId, viewerIdOf } from '../plugins/auth.js'
import { strictRateLimit } from '../plugins/rate-limit.js'
import type { ZodTypeProvider } from '../plugins/validation.js'
import { CircuitHandleParams, toPage } from './circuits.schemas.js'
import {
  AddCollectionItemBody,
  CollectionEnvelope,
  CollectionIdParams,
  CollectionMemberParams,
  CollectionMembershipResponse,
  CollectionPageResponse,
  CollectionViewResponse,
  CreateCollectionBody,
  PaginationQuery,
  UpdateCollectionBody,
} from './collections.schemas.js'

export interface CollectionRoutesOptions {
  readonly env: ApiEnv
}

/** The collection this request names, or 404 — never 403, never a leak. */
async function readableCollection(
  app: FastifyInstance,
  request: FastifyRequest,
  id: string
) {
  const collection = await app.circuits.findReadableCollection(
    id,
    viewerIdOf(request)
  )
  if (collection === null) throw new ApiError('NOT_FOUND')
  return collection
}

/** Rejects a write by anyone but the owner. Visibility is irrelevant here. */
function assertOwner(collection: { ownerId: string }, viewerId: string): void {
  if (!canEditCollection(collection, viewerId)) {
    throw new ApiError('FORBIDDEN')
  }
}

const plugin: FastifyPluginCallback<CollectionRoutesOptions> = (
  instance,
  options,
  done
) => {
  const app = instance.withTypeProvider<ZodTypeProvider>()
  const { env } = options

  // The stricter budget on the one route that creates rows, exactly as
  // `POST /circuits` has it: this is what an unattended script would use to
  // fill a table.
  const createLimit = strictRateLimit(env)

  app.get(
    COLLECTION_ROUTES.collection,
    {
      config: { auth: 'required' },
      schema: {
        querystring: PaginationQuery,
        response: { 200: CollectionPageResponse },
      },
    },
    async (request) => {
      /*
       * "Mine", literally. Owner and viewer are the same id here, which is
       * what makes this the one listing where a PRIVATE collection belongs —
       * it is the caller's own. The same call with a different viewer is a
       * profile page, and that is the only difference between them.
       */
      const ownerId = requireViewerId(request)
      const { page, perPage } = request.query
      const { items, total } = await app.circuits.listCollections({
        ownerId,
        viewerId: ownerId,
        skip: (page - 1) * perPage,
        take: perPage,
      })
      return toPage(items, total, page, perPage)
    }
  )

  app.post(
    COLLECTION_ROUTES.collection,
    {
      config: { auth: 'required', rateLimit: createLimit },
      schema: {
        body: CreateCollectionBody,
        response: { 201: CollectionEnvelope },
      },
    },
    async (request, reply) => {
      /*
       * `Collection.ownerId` is a foreign key onto `public.User`, and a caller
       * who has never saved a circuit has no row there yet — curating
       * somebody else's work is a perfectly ordinary first thing to do with an
       * account.
       */
      const identity = request.auth
      if (identity === null) throw new ApiError('AUTH_REQUIRED')
      if (identity.email === null) throw new ApiError('USER_EMAIL_REQUIRED')
      const owner = await app.circuits.ensureOwner({
        id: identity.userId,
        email: identity.email,
        displayName: identity.displayName,
        avatarUrl: identity.avatarUrl,
      })

      const collection = await app.circuits.createCollection({
        ownerId: owner.id,
        title: request.body.title,
        description: request.body.description ?? null,
        visibility: request.body.visibility,
      })

      reply.status(201)
      return { collection }
    }
  )

  app.get(
    COLLECTION_ROUTES.item,
    {
      /*
       * Anonymous is the point: this is how a PUBLIC collection is read and
       * how a link to an UNLISTED one works at all. The viewer id decides
       * twice over — once whether the collection may be opened, and once,
       * inside `readCollectionItems`, which of its circuits may be shown.
       */
      config: { auth: 'optional' },
      schema: {
        params: CollectionIdParams,
        response: { 200: CollectionViewResponse },
      },
    },
    async (request) => {
      const collection = await readableCollection(
        app,
        request,
        request.params.id
      )
      const viewerId = viewerIdOf(request)
      const { items, withheld } = await app.circuits.readCollectionItems({
        collectionId: collection.id,
        // The same viewer, applied to the circuits this time. This is the line
        // the whole file is about.
        viewerId,
      })

      /*
       * The same star lookup a gallery page does, over the ids this listing
       * has *already returned* — so it has been through the visibility filter
       * and cannot report on a circuit the viewer may not see. Free and empty
       * for an anonymous reader, who has no star to have.
       */
      const starred =
        viewerId === null
          ? []
          : await app.circuits.starredAmong({
              userId: viewerId,
              circuitIds: items.map((item) => item.id),
            })

      return {
        collection,
        items: [...items],
        withheldItemCount: withheld,
        starred,
      }
    }
  )

  app.patch(
    COLLECTION_ROUTES.item,
    {
      config: { auth: 'required' },
      schema: {
        params: CollectionIdParams,
        body: UpdateCollectionBody,
        response: { 200: CollectionEnvelope },
      },
    },
    async (request) => {
      const viewerId = requireViewerId(request)
      const collection = await readableCollection(
        app,
        request,
        request.params.id
      )
      assertOwner(collection, viewerId)

      const updated = await app.circuits.updateCollection({
        id: collection.id,
        ownerId: viewerId,
        ...request.body,
      })
      // Only reachable if it was deleted between the read and the write.
      if (updated === null) throw new ApiError('NOT_FOUND')
      return { collection: updated }
    }
  )

  app.delete(
    COLLECTION_ROUTES.item,
    {
      config: { auth: 'required' },
      schema: { params: CollectionIdParams },
    },
    async (request, reply) => {
      const viewerId = requireViewerId(request)
      const collection = await readableCollection(
        app,
        request,
        request.params.id
      )
      assertOwner(collection, viewerId)

      /*
       * The items go with it by `onDelete: Cascade`, and no circuit does:
       * a collection holds references, so deleting one un-groups circuits
       * rather than destroying them. That asymmetry is worth stating because
       * the button says "delete" and a user could reasonably fear otherwise.
       */
      const removed = await app.circuits.removeCollection({
        id: collection.id,
        ownerId: viewerId,
      })
      if (!removed) throw new ApiError('NOT_FOUND')
      return reply.status(204).send()
    }
  )

  app.post(
    COLLECTION_ROUTES.items,
    {
      config: { auth: 'required' },
      schema: {
        params: CollectionIdParams,
        body: AddCollectionItemBody,
        response: { 200: CollectionEnvelope },
      },
    },
    async (request) => {
      const viewerId = requireViewerId(request)
      const collection = await readableCollection(
        app,
        request,
        request.params.id
      )
      assertOwner(collection, viewerId)

      /*
       * The second authorisation question, through the same door every other
       * read uses: you cannot collect what you cannot see. Somebody else's
       * PRIVATE circuit is a 404 here exactly as it is on GET, and an UNLISTED
       * one is reachable by its slug — which is what UNLISTED means, and is
       * why the body carries a handle rather than an id.
       */
      const circuit = await app.circuits.findReadable(
        request.body.circuit,
        viewerId
      )
      if (circuit === null) throw new ApiError('NOT_FOUND')

      const updated = await app.circuits.addCollectionItem({
        collectionId: collection.id,
        ownerId: viewerId,
        circuitId: circuit.id,
      })
      return { collection: updated }
    }
  )

  app.delete(
    COLLECTION_ROUTES.member,
    {
      config: { auth: 'required' },
      schema: {
        params: CollectionMemberParams,
        response: { 200: CollectionEnvelope },
      },
    },
    async (request) => {
      const viewerId = requireViewerId(request)
      const collection = await readableCollection(
        app,
        request,
        request.params.id
      )
      assertOwner(collection, viewerId)

      /*
       * No `findReadable` on the way out, and deliberately: removing a
       * membership must keep working after the circuit stopped being readable
       * — its owner made it private, or deleted it and left an orphan behind.
       * A curator who cannot tidy their own list because of somebody else's
       * setting is stuck forever.
       */
      await app.circuits.removeCollectionItem({
        collectionId: collection.id,
        ownerId: viewerId,
        circuitId: request.params.circuitId,
      })

      /*
       * Answers with the collection rather than 204 for the reason the star
       * routes answer with a state: `itemCount` is rendered wherever this
       * collection appears, and the alternative is a client that guesses.
       * Idempotent — removing something that was not in there is a 200 with
       * the count unchanged, not a 404, because the caller's intent is
       * satisfied either way.
       */
      const refreshed = await app.circuits.findReadableCollection(
        collection.id,
        viewerId
      )
      if (refreshed === null) throw new ApiError('NOT_FOUND')
      return { collection: refreshed }
    }
  )

  app.get(
    COLLECTION_ROUTES.membership,
    {
      config: { auth: 'required' },
      schema: {
        params: CircuitHandleParams,
        response: { 200: CollectionMembershipResponse },
      },
    },
    async (request) => {
      const viewerId = requireViewerId(request)
      /*
       * The circuit is resolved through the ordinary filter first, so this
       * cannot be used to ask questions about a circuit the caller may not
       * read — even though the answer only ever concerns their own
       * collections.
       */
      const circuit = await app.circuits.findReadable(
        request.params.id,
        viewerId
      )
      if (circuit === null) throw new ApiError('NOT_FOUND')

      const collectionIds = await app.circuits.collectionIdsHolding({
        ownerId: viewerId,
        circuitId: circuit.id,
      })
      return { collectionIds }
    }
  )

  done()
}

export const collectionRoutes = plugin
