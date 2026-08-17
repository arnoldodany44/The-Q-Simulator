/**
 * The read behind an `<iframe>` — §3.4, §11.
 *
 * One route, one verb, and every interesting decision is about what it
 * refuses rather than about what it does.
 *
 * ────────────────────────────────────────────────────────────────────────
 * IT IS `auth: 'public'`, AND THAT IS THE POINT OF THE ROUTE EXISTING.
 *
 * `GET /circuits/:id` is `auth: 'optional'`: it reads the `Authorization`
 * header and hands the verified `sub` to `findReadable`, which is exactly
 * right — that is what lets an owner open their own PRIVATE circuit.
 *
 * An embed must never be able to do that. A page whose content depends on
 * whether its reader happens to hold a token is a page whose author cannot
 * know what it shows: the owner previews their private circuit in a blog post,
 * sees it render, publishes — and every other reader sees a 404 where the
 * diagram was. Worse, the same mechanism run the other way is a *leak with a
 * delay*: any change that later made the frame credentialed would publish
 * private work into a third-party page with no code change anywhere near this
 * file.
 *
 * `public` is the policy `plugins/auth.ts` defines as "the identity is
 * irrelevant, and so is a broken one — the `Authorization` header is not
 * consulted at all". That is the property this route needs, so the viewer
 * passed to `findReadable` below is the literal `null` rather than
 * `viewerIdOf(request)`: there is no header to read, and no expression here
 * that could ever evaluate to a user id.
 *
 * ────────────────────────────────────────────────────────────────────────
 * PRIVATE REFUSES, AND THE REFUSAL SAYS NOTHING.
 *
 * `findReadable(handle, null)` composes §11 *inside the query*
 * (`circuitHandleFilter` in `@qsim/db`): a slug reaches PUBLIC and UNLISTED,
 * an id reaches PUBLIC alone, and everything else comes back `null` — which
 * is the same `null` a slug nobody has ever minted comes back as. This
 * handler cannot tell the two apart and therefore cannot say which it was:
 * one `NOT_FOUND`, one status, one body. A 403 here would confirm that the
 * handle names something, which is the whole of what an UNLISTED slug is
 * protecting.
 *
 * That is also why the embeddable set is not a check written in this file.
 * "Only PUBLIC and UNLISTED are embeddable" is not an `if` — it is the shape
 * of the filter, applied by the query, with no branch to forget.
 *
 * ────────────────────────────────────────────────────────────────────────
 * IT IS NOT CACHED, AND THAT IS A DELIBERATE COST.
 *
 * A short `max-age` would be the obvious kindness to a blog post with six
 * frames in it. It would also mean that un-publishing a circuit — the one
 * control an author has over an embed already loose in the world — takes
 * effect everywhere except in the caches, for as long as the header said. §11
 * makes visibility a live decision verified on the server, and a cache is a
 * copy of an old decision. The bytes at stake are one small JSON document per
 * frame; the JavaScript, which is the part that is actually large, is
 * fingerprinted and cached by the CDN in front of `apps/web`.
 */

import { EMBED_ROUTES } from '@qsim/contract'
import { MissingVersionError } from '@qsim/db'
import type { FastifyPluginCallback } from 'fastify'

import { ApiError } from '../errors.js'
import type { ZodTypeProvider } from '../plugins/validation.js'
import { EmbedCircuitResponse, EmbedHandleParams } from './embed.schemas.js'

const plugin: FastifyPluginCallback = (instance, _options, done) => {
  const app = instance.withTypeProvider<ZodTypeProvider>()

  app.get(
    EMBED_ROUTES.item,
    {
      config: { auth: 'public' },
      schema: {
        params: EmbedHandleParams,
        response: { 200: EmbedCircuitResponse },
      },
    },
    async (request, reply) => {
      /*
       * Set FIRST, so it is on the refusal as well as on the answer.
       *
       * See the header: revoking visibility has to mean revoking it. The
       * mirror holds and was missing — publishing a circuit has to mean
       * publishing it. RFC 9111 §4.2.2 lists 404 among the heuristically
       * cacheable statuses, so a refusal left without this can be kept by a
       * shared cache and a reader goes on seeing "not available to embed"
       * after the author has made the circuit public. Placed before the first
       * `throw` rather than after the last one, which is the only arrangement
       * that covers both.
       */
      reply.header('cache-control', 'no-store')

      /*
       * `null`, spelled out, and never `viewerIdOf(request)`. On an
       * `auth: 'public'` route the latter is always `null` too — but it is
       * `null` because a hook did not run, which is a fact about the wiring
       * rather than about this route, and a future policy change would turn
       * it into a user id silently. This literal cannot.
       */
      const circuit = await app.circuits.findReadable(
        request.params.handle,
        null
      )
      if (circuit === null) throw new ApiError('NOT_FOUND')

      const version = await app.circuits.latestVersion(circuit.id)
      /*
       * Same reasoning as `GET /circuits/:id`: a circuit is created with
       * version 1 in one transaction, so the reachable way to get here is the
       * owner deleting the row between these two statements. `NOT_FOUND` is
       * what the next request would answer, and that is what a reader should
       * be told rather than that the server is broken.
       */
      if (version === null) throw new MissingVersionError(circuit.id)

      /*
       * Assembled field by field rather than spread, and that is the leak
       * defence rather than a style choice. `CircuitDetail` carries
       * `ownerId`, `visibility`, `description`, the counters and the
       * timestamps; the response schema would strip them on the way out, but
       * a spread makes the next field a row grows arrive here by default and
       * leave by an omission somebody has to notice. `packages/contract/src/
       * embed.ts` argues each exclusion.
       */
      return {
        embed: {
          slug: circuit.slug,
          title: circuit.title,
          qubitCount: circuit.qubitCount,
          gateCount: circuit.gateCount,
          depth: circuit.depth,
          author: { username: circuit.owner.username },
          circuit: version.data,
        },
      }
    }
  )

  done()
}

export const embedRoutes = plugin
