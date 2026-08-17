/**
 * The machine-readable description of the public API — §3.5.
 *
 * ══════════════════════════════════════════════════════════════════════════
 * WHY THE API SERVES ITS OWN DOCUMENTATION
 *
 * `docs/api.md` is in the repository and a stranger integrating against this
 * service may never see the repository. What they have is a base URL, and the
 * one thing a base URL should be able to hand back is an accurate description
 * of itself — one their generator can consume, so that a client library is a
 * command rather than an afternoon.
 *
 * It is generated from `@qsim/contract`'s Zod schemas at request time, which
 * means it cannot be stale: there is no build step to forget, no checked-in
 * artefact to regenerate, and a deployment describes exactly the schemas it
 * is running. The cost is a few milliseconds of JSON Schema conversion per
 * request, paid by a route nobody calls in a loop — and the alternative,
 * caching it, would trade that for a document that could disagree with the
 * process serving it after a hot reload.
 *
 * ══════════════════════════════════════════════════════════════════════════
 * `auth: 'public'`, AND WHY THAT IS NOT A DISCLOSURE
 *
 * The document lists paths, shapes and error codes. Every one of those is
 * already visible to anybody who opens the web client and its network tab,
 * and none of it is a secret: this API's security is authentication and the
 * §11 visibility filters, never the obscurity of its route table. Requiring a
 * credential would only mean that the first thing a new integrator meets is a
 * 401 — and would make the document unusable by exactly the tools it exists
 * for, which fetch a spec before they have anywhere to put a key.
 *
 * `public` also means the `Authorization` header is never read here, so a
 * caller with a stale token gets the spec rather than an authentication error
 * about a request that needed no authentication.
 */

import { API_PREFIX, buildOpenApiDocument } from '@qsim/contract'
import type { FastifyPluginCallback, FastifyRequest } from 'fastify'

/**
 * The version stamped on the document.
 *
 * The *API's* version and not the package's: it is `/api/v1`, and it changes
 * when the surface changes incompatibly rather than when a deploy happens. A
 * build number here would make every deployment look like a new API to a
 * generator that caches by version.
 */
const DOCUMENT_VERSION = '1'

/**
 * The origin this request arrived at, which is the one a caller can use.
 *
 * Read off the request rather than from configuration, and that is deliberate:
 * the alternative is an environment variable that is wrong on exactly the
 * deployments nobody remembers to set it on — a preview build, a local run,
 * a rename of the Railway service — and a `servers` entry pointing somewhere
 * else is worse than none at all, because a generator will believe it.
 *
 * `request.protocol` and `request.host` already honour `X-Forwarded-*` when
 * `trustProxy` says they may (see `env.ts`), so behind the platform's edge
 * this is the public https origin rather than the container's internal one.
 */
function originOf(request: FastifyRequest): string {
  return `${request.protocol}://${request.host}`
}

export const openApiRoutes: FastifyPluginCallback = (app, _options, done) => {
  app.get(
    '/openapi.json',
    {
      /*
       * No response schema, for the reason `/health` has none: the payload is
       * a JSON Schema document — deeply nested, deliberately open — and
       * running it through a serialiser that strips unknown keys is how a
       * schema arrives at a client with its constraints quietly removed.
       */
      config: { auth: 'public' },
    },
    (request, reply) => {
      /*
       * Cached by anything in front for five minutes. The document only
       * changes on deploy, and a stale one for five minutes is a description
       * of the version that was running five minutes ago — which is exactly
       * what a cache is for.
       */
      reply.header('cache-control', 'public, max-age=300')
      return buildOpenApiDocument({
        serverUrl: originOf(request),
        version: DOCUMENT_VERSION,
      })
    }
  )

  done()
}

/** Where it lives, so `app.ts` and the tests cannot disagree about it. */
export const OPENAPI_PATH = `${API_PREFIX}/openapi.json`
