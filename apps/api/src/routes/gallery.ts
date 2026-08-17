/**
 * The gallery and the profile listing — §3.4 and §8, milestone M1.5.
 *
 * ── The highest-risk route in the project ─────────────────────────────────
 *
 * `GET /gallery` is unauthenticated, it is a *list*, and the table it lists
 * also holds every PRIVATE circuit in the database. Prisma connects as
 * `postgres`, which owns those tables and carries `rolbypassrls`, so Postgres
 * enforces nothing: the whole of the rule is a `where` somebody has to
 * remember. Forgetting it once does not fail a test — it publishes the entire
 * table in one response.
 *
 * So neither handler below writes a filter. Both call
 * `app.circuits.listPublished`, whose only door is `galleryWhere` in
 * `@qsim/db`, which starts from `listableCircuitFilter` and can afterwards
 * only narrow: every knob a caller has — tag, search, cursor, author — is an
 * `AND` on top of §11, and a conjunction cannot widen a result set no matter
 * what is conjoined. The tests for this file are written from a stranger's
 * point of view for the same reason: that an owner can see their own circuit
 * proves nothing at all.
 *
 * ── Two routes, one query ────────────────────────────────────────────────
 *
 * `/gallery` and `/users/:username/circuits` differ by one `AND ownerId = …`.
 * They are deliberately not two implementations: a profile page is a listing
 * too, and the second implementation is where the filter goes missing. The
 * consequence is worth stating, because it is the rule and not an accident:
 * a stranger's profile shows their PUBLIC circuits, your own profile shows
 * all of yours, and nobody's UNLISTED circuits appear anywhere — that is what
 * UNLISTED means, and a listing is discovery.
 *
 * ── Cursors, not page numbers ────────────────────────────────────────────
 *
 * §8 spells the gallery `?page=`. It is a cursor here, and the argument is in
 * `GalleryCursor` in `@qsim/db`: the default ordering is by a column other
 * people change while a reader is reading, and an offset into a shifting
 * ordering silently repeats or skips rows. A keyset asks a stable question.
 */

import { GALLERY_ROUTES } from '@qsim/contract'
import { decodeGalleryCursor, normalizeTagName } from '@qsim/db'
import type {
  CircuitCard,
  GalleryCursor,
  GallerySort,
  ViewerId,
} from '@qsim/db'
import type { FastifyInstance, FastifyPluginCallback } from 'fastify'
import { ApiError } from '../errors.js'
import { viewerIdOf } from '../plugins/auth.js'
import type { ZodTypeProvider } from '../plugins/validation.js'
import {
  GalleryPageResponse,
  GalleryQuerySchema,
  UserCircuitsResponse,
  UsernameParams,
} from './gallery.schemas.js'

/**
 * Reads the cursor a client sent back, or refuses the request.
 *
 * A cursor that does not decode is answered with 400 rather than ignored.
 * Ignoring it would silently serve page 1 to a client that asked for page 4,
 * which looks to a reader like a gallery that lost half its contents — and
 * looks to whoever wrote the client like nothing at all.
 *
 * The decoder is also given the request's `sort`, because a cursor minted
 * under one ordering describes a position that does not exist under the
 * other: the keyset comparison would still run and would return an arbitrary
 * window of rows.
 */
function readCursor(
  raw: string | undefined,
  sort: GallerySort
): GalleryCursor | null {
  if (raw === undefined) return null

  const cursor = decodeGalleryCursor(raw, sort)
  if (cursor === null) {
    throw new ApiError('VALIDATION_FAILED', {
      details: [{ path: 'querystring.cursor', code: 'invalid_cursor' }],
    })
  }
  return cursor
}

/**
 * The canonical spelling of a `?tag=` filter, or a 400.
 *
 * The same function that decided the spelling when the tag was written, so a
 * facet cannot be filed under one form and looked up under another. A tag
 * that normalises to nothing is refused rather than dropped: dropping it
 * would answer a different question — "every circuit you may see" — which is
 * precisely the answer this route must never produce by accident.
 */
function readTag(raw: string | undefined): string | null {
  if (raw === undefined) return null

  const tag = normalizeTagName(raw)
  if (tag === null) {
    throw new ApiError('VALIDATION_FAILED', {
      details: [{ path: 'querystring.tag', code: 'invalid_tag' }],
    })
  }
  return tag
}

/**
 * Which circuits on this page the caller has already starred (M1.5b).
 *
 * Empty and free for an anonymous reader, which is most of this route's
 * traffic: there is no star to have without an account, so the extra read is
 * not merely skipped as an optimisation — it has no answer to look for.
 *
 * The ids handed over are the ones the listing has already returned, so they
 * have been through `galleryWhere` and this cannot report on a circuit the
 * viewer may not see. The `Star` read is scoped to their own user id besides.
 */
async function starredOnPage(
  app: FastifyInstance,
  viewerId: ViewerId,
  items: readonly CircuitCard[]
): Promise<string[]> {
  if (viewerId === null) return []
  return app.circuits.starredAmong({
    userId: viewerId,
    circuitIds: items.map((item) => item.id),
  })
}

const plugin: FastifyPluginCallback = (instance, _options, done) => {
  const app = instance.withTypeProvider<ZodTypeProvider>()

  app.get(
    GALLERY_ROUTES.gallery,
    {
      /*
       * Anonymous is the point: this is the front page. The viewer id — null,
       * or a `sub` this process verified — is what selects which circuits the
       * filter admits, and it is never read from anything a caller sent.
       */
      config: { auth: 'optional', scope: 'read' },
      schema: {
        querystring: GalleryQuerySchema,
        response: { 200: GalleryPageResponse },
      },
    },
    async (request) => {
      const { sort, tag, q, cursor, limit } = request.query
      const viewerId = viewerIdOf(request)

      const page = await app.circuits.listPublished({
        viewerId,
        sort,
        tag: readTag(tag),
        search: q ?? null,
        cursor: readCursor(cursor, sort),
        take: limit,
      })

      return {
        items: [...page.items],
        nextCursor: page.nextCursor,
        limit,
        starred: await starredOnPage(app, viewerId, page.items),
      }
    }
  )

  app.get(
    GALLERY_ROUTES.userCircuits,
    {
      config: { auth: 'optional', scope: 'read' },
      schema: {
        params: UsernameParams,
        querystring: GalleryQuerySchema,
        response: { 200: UserCircuitsResponse },
      },
    },
    async (request) => {
      /*
       * The user is resolved through `publicUserSelect`, which has no
       * `email`. That is the projection's job and not this handler's, and it
       * is why the lookup does not go through a bare `findUnique` here.
       */
      const user = await app.circuits.findUserByUsername(
        request.params.username
      )
      if (user === null) throw new ApiError('NOT_FOUND')

      const { sort, tag, q, cursor, limit } = request.query
      const viewerId = viewerIdOf(request)
      const page = await app.circuits.listPublished({
        viewerId,
        // The only difference from the gallery — and it narrows, like every
        // other filter on this query.
        ownerId: user.id,
        sort,
        tag: readTag(tag),
        search: q ?? null,
        cursor: readCursor(cursor, sort),
        take: limit,
      })

      return {
        user,
        items: [...page.items],
        nextCursor: page.nextCursor,
        limit,
        starred: await starredOnPage(app, viewerId, page.items),
      }
    }
  )

  done()
}

export const galleryRoutes = plugin
