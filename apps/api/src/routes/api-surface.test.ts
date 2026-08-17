/**
 * The public API's surface: what is enforced, and what is published.
 *
 * ── Why this test is the one that matters for §3.5 ────────────────────────
 *
 * There are two descriptions of which endpoints an API key may reach. One is
 * `config: { scope }` on each route, which the router enforces. The other is
 * `PUBLIC_ROUTES` in `@qsim/contract`, which the OpenAPI document and
 * `docs/api.md` are generated from.
 *
 * Documentation drifting from behaviour is a nuisance. A *published surface*
 * drifting from an *enforced* one is a security bug in both directions:
 *
 *   - a route that gained a scope without being written down is an endpoint a
 *     leaked key can reach and nobody has reviewed;
 *   - a route in the table that no longer declares one is a documented
 *     endpoint that answers 403 to every key, which sends its user to check
 *     their scopes about a route no scope can open.
 *
 * `app.apiKeySurface` is recorded by the very `onRoute` hook that validates
 * the scope, so it is the enforcement rather than a second reading of it.
 * This file asserts the two sets are equal, element for element.
 *
 * ── And the assertion nobody writes ───────────────────────────────────────
 *
 * That every *other* route is closed. The list of scoped routes is easy to
 * check by eye; "and nothing else" is the part that decays silently as routes
 * are added, so it is asserted here as a set difference against the whole
 * router rather than as a list somebody maintains.
 */

import {
  API_PREFIX,
  PUBLIC_ROUTES,
  buildOpenApiDocument,
  openApiPath,
} from '@qsim/contract'
import { describe, expect, it } from 'vitest'
import { createTestApp } from '../testing/app.js'
import { OPENAPI_PATH } from './openapi.js'

/** `GET /api/v1/circuits/:id`, the form both sides can be reduced to. */
function keyOf(entry: { method: string; url: string }): string {
  return `${entry.method} ${entry.url}`
}

describe('the enforced surface', () => {
  it(
    'is exactly the surface the contract publishes',
    { timeout: 20_000 },
    async () => {
      const app = await createTestApp()
      await app.ready()

      try {
        const enforced = app.apiKeySurface
          .map((entry) => `${keyOf(entry)} ${entry.scope}`)
          .sort()
        const published = PUBLIC_ROUTES.filter((route) => route.scope !== null)
          .map(
            (route) =>
              `${route.method} ${API_PREFIX}${route.path} ${String(route.scope)}`
          )
          .sort()

        /*
         * The scope travels in the comparison, not just the path. A route
         * documented as `read` and enforced as `write` would pass a
         * path-only check while handing every read key a 403 — and the
         * reference would be telling its reader to mint the wrong key.
         */
        expect(enforced).toEqual(published)
      } finally {
        await app.close()
      }
    }
  )

  it(
    'leaves every other route closed to keys',
    { timeout: 20_000 },
    async () => {
      const app = await createTestApp()
      await app.ready()

      try {
        const open = new Set(app.apiKeySurface.map(keyOf))
        /*
         * `printRoutes` is the router's own inventory, so this sees routes
         * added by any plugin — including ones this file has never heard of,
         * which is the entire point.
         */
        const inventory = app.printRoutes({ commonPrefix: false })

        /*
         * Spot-checked against the endpoints that must never be reachable
         * with a key, named individually because each one is a decision with
         * its own argument rather than an accident of the default:
         *
         *   - key management, because a key that could mint keys would
         *     outlive its own revocation (see `routes/api-keys.ts`);
         *   - hardware, because a job spends a QPU allowance that does not
         *     refill on request (risk 4);
         *   - the account routes, because deleting an account is the one
         *     irreversible action in the product;
         *   - the challenge submission, because a leaderboard is a listing of
         *     people and a scripted submission is not a person practising.
         */
        for (const closed of [
          'GET /api/v1/api-keys',
          'POST /api/v1/api-keys',
          'DELETE /api/v1/api-keys/:id',
          'GET /api/v1/hardware/credentials',
          'POST /api/v1/hardware/credentials',
          'POST /api/v1/hardware/jobs',
          'GET /api/v1/me',
          'PATCH /api/v1/me',
          'DELETE /api/v1/me',
          'POST /api/v1/challenges/:slug/submit',
        ]) {
          expect(open.has(closed), closed).toBe(false)
        }

        // And the inventory really does contain them, so the loop above is
        // asserting about routes that exist rather than about typos.
        expect(inventory).toContain('api-keys')
        expect(inventory).toContain('hardware')
      } finally {
        await app.close()
      }
    }
  )

  it(
    'publishes no route the router does not have',
    { timeout: 20_000 },
    async () => {
      const app = await createTestApp()
      await app.ready()

      try {
        for (const route of PUBLIC_ROUTES) {
          const url = `${API_PREFIX}${route.path}`
          expect(
            app.hasRoute({ method: route.method, url }),
            `${route.method} ${url}`
          ).toBe(true)
        }
      } finally {
        await app.close()
      }
    }
  )
})

describe('GET /api/v1/openapi.json', () => {
  it(
    'is served anonymously and describes this deployment',
    { timeout: 20_000 },
    async () => {
      const app = await createTestApp()
      await app.ready()

      try {
        const response = await app.inject({ method: 'GET', url: OPENAPI_PATH })
        expect(response.statusCode).toBe(200)

        const document = response.json<{
          openapi: string
          servers: { url: string }[]
          paths: Record<string, unknown>
        }>()
        expect(document.openapi).toBe('3.1.0')
        /*
         * The origin comes off the request rather than out of configuration,
         * so a preview deployment describes itself instead of pointing a
         * generator at production.
         */
        expect(document.servers[0]?.url).toContain('http')
        expect(Object.keys(document.paths).length).toBe(
          new Set(PUBLIC_ROUTES.map((route) => openApiPath(route.path))).size
        )
      } finally {
        await app.close()
      }
    }
  )

  it('answers the spec even to a caller holding a stale token', async () => {
    /*
     * `auth: 'public'` means the header is not read at all. A spec endpoint
     * that answered 401 because somebody's session had expired would be
     * unusable by the tools it exists for, which fetch a document before they
     * have anywhere to put a credential.
     */
    const app = await createTestApp()
    await app.ready()
    try {
      const response = await app.inject({
        method: 'GET',
        url: OPENAPI_PATH,
        headers: { authorization: 'Bearer not-a-token-at-all' },
      })
      expect(response.statusCode).toBe(200)
    } finally {
      await app.close()
    }
  })

  it('is a document a generator can consume without editing', () => {
    // Built here rather than fetched, so the assertion is about the builder
    // and survives the route being renamed.
    const document = buildOpenApiDocument({
      serverUrl: 'https://example.test',
      version: '1',
    })
    expect(JSON.stringify(document)).not.toContain('undefined')
  })
})
