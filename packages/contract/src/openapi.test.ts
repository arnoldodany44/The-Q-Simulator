import { describe, expect, it } from 'vitest'
import { API_ERROR_CODES } from './errors.js'
import {
  PUBLIC_ROUTES,
  WORKED_EXAMPLE,
  buildOpenApiDocument,
  jsonSchemaOf,
  openApiPath,
  pathParamNames,
} from './openapi.js'
import type { JsonSchema } from './openapi.js'
import { renderApiReference } from './reference.js'

/**
 * The generated reference, and the properties that make generating it worth
 * anything.
 *
 * A generator is only better than prose if it *fails* when the thing it
 * describes changes. So this file asserts three separate things:
 *
 *   1. every schema in the table can actually be converted — a Zod feature
 *      with no JSON Schema spelling would otherwise produce a document with a
 *      silently empty body;
 *   2. every hand-written part of the document is checked against a schema —
 *      the worked example's requests are *parsed*, and its operation ids are
 *      resolved, so the one section a human wrote cannot go stale;
 *   3. the committed `docs/api.md` is exactly what this renders, through a
 *      file snapshot — which is what makes "the docs are generated" a fact
 *      about the repository rather than about somebody's habits.
 *
 * The fourth property — that this table is the *whole* public surface and no
 * more — cannot be asserted here: it needs the router, and the router is in
 * `apps/api`. It lives in `src/routes/api-surface.test.ts` there.
 */

/** Fixed, so the snapshot is a function of the schemas and nothing else. */
const SERVER_URL = 'https://the-q-simulator-production.up.railway.app'
const VERSION = '1'

describe('the public route table', () => {
  it('names every path parameter it declares, and no others', () => {
    for (const route of PUBLIC_ROUTES) {
      const inPath = pathParamNames(route.path).sort()
      const described = Object.keys(route.params ?? {}).sort()
      /*
       * Both directions. A parameter with no description renders an empty
       * cell, and a description for a parameter that no longer exists is the
       * sentence a reader trusts and the router has never heard of.
       */
      expect(described, `${route.method} ${route.path}`).toEqual(inPath)
    }
  })

  it('gives every route a distinct operation id', () => {
    const ids = PUBLIC_ROUTES.map((route) => route.operationId)
    // Duplicates would collide in the OpenAPI document and in the anchors the
    // reference links between, in both cases silently.
    expect(new Set(ids).size).toBe(ids.length)
  })

  it('gives every route a distinct method and path', () => {
    const keys = PUBLIC_ROUTES.map((route) => `${route.method} ${route.path}`)
    expect(new Set(keys).size).toBe(keys.length)
  })

  it('names only error codes the API can actually produce', () => {
    const known = new Set<string>(API_ERROR_CODES)
    for (const route of PUBLIC_ROUTES) {
      for (const code of route.errors ?? []) {
        expect(known.has(code), `${route.operationId}: ${code}`).toBe(true)
      }
    }
  })

  it('converts every schema it declares to JSON Schema', () => {
    for (const route of PUBLIC_ROUTES) {
      for (const schema of [
        route.body,
        route.query,
        ...route.responses.map((response) => response.schema),
      ]) {
        if (schema === undefined) continue
        const converted = jsonSchemaOf(schema)
        /*
         * Not merely "it did not throw". An empty object is what a failed
         * conversion degrades to, and it would render as a body with no
         * fields — documentation that says an endpoint takes nothing.
         */
        expect(Object.keys(converted).length).toBeGreaterThan(1)
      }
    }
  })

  it('never documents a body on a route that takes none', () => {
    for (const route of PUBLIC_ROUTES) {
      if (route.method !== 'GET') continue
      // A GET with a request body is a route no HTTP client will send
      // correctly, and a reference that showed one would be inviting it.
      expect(route.body, route.operationId).toBeUndefined()
    }
  })
})

describe('the worked example', () => {
  it('names routes that exist', () => {
    for (const step of WORKED_EXAMPLE) {
      const route = PUBLIC_ROUTES.find(
        (candidate) => candidate.operationId === step.operationId
      )
      expect(route, step.operationId).toBeDefined()
    }
  })

  /*
   * The assertion this section exists for. The worked example is the one
   * hand-written thing in the document, so it is the one thing that can be
   * wrong — and a request body that no longer parses is exactly the failure a
   * reader would hit first, having copied it.
   */
  it('sends request bodies the server would accept', () => {
    for (const step of WORKED_EXAMPLE) {
      if (step.request === undefined) continue
      const route = PUBLIC_ROUTES.find(
        (candidate) => candidate.operationId === step.operationId
      )
      const body = route?.body
      expect(body, `${step.operationId} has no body schema`).toBeDefined()
      const parsed = body?.safeParse(step.request)
      expect(
        parsed?.success,
        `${step.title}: ${JSON.stringify(parsed?.error?.issues ?? [])}`
      ).toBe(true)
    }
  })
})

describe('the OpenAPI document', () => {
  const document = buildOpenApiDocument({
    serverUrl: SERVER_URL,
    version: VERSION,
  })

  it('is 3.1, whose schema dialect is what Zod emits', () => {
    expect(document['openapi']).toBe('3.1.0')
  })

  it('has an operation for every route in the table', () => {
    const paths = document['paths'] as Record<string, JsonSchema>
    for (const route of PUBLIC_ROUTES) {
      const operations = paths[openApiPath(route.path)]
      expect(operations, openApiPath(route.path)).toBeDefined()
      expect(operations?.[route.method.toLowerCase()]).toBeDefined()
    }
  })

  it('writes path parameters in OpenAPI’s braces, not the router’s colons', () => {
    for (const path of Object.keys(document['paths'] as JsonSchema)) {
      expect(path).not.toContain(':')
    }
  })

  it('publishes the complete error vocabulary', () => {
    const components = document['components'] as JsonSchema
    const schemas = components['schemas'] as JsonSchema
    const error = schemas['Error'] as JsonSchema
    const codes = (
      (
        ((error['properties'] as JsonSchema)['error'] as JsonSchema)[
          'properties'
        ] as JsonSchema
      )['code'] as JsonSchema
    )['enum']
    expect(codes).toEqual([...API_ERROR_CODES])
  })

  it('offers anonymous access exactly where the route allows it', () => {
    const paths = document['paths'] as Record<string, JsonSchema>
    for (const route of PUBLIC_ROUTES) {
      const operation = paths[openApiPath(route.path)]?.[
        route.method.toLowerCase()
      ] as JsonSchema
      const security = operation['security'] as unknown[]
      /*
       * OpenAPI spells "no credentials are acceptable here" as an empty
       * requirement object. Getting this backwards would publish the gallery
       * as authenticated-only, or — far worse — publish a write as anonymous.
       */
      const hasAnonymous = security.some(
        (requirement) => Object.keys(requirement as JsonSchema).length === 0
      )
      expect(hasAnonymous, `${route.method} ${route.path}`).toBe(
        route.anonymous && route.scope !== null
      )
    }
  })
})

describe('docs/api.md', () => {
  /*
   * A file snapshot rather than a script, so the committed reference cannot
   * drift from the schemas: any change to a request shape, a response, a
   * bound or a route fails this test until somebody regenerates. Updating is
   * `pnpm --filter @qsim/contract test -u`, and the diff it produces is the
   * documentation review.
   *
   * The path is the repository's own `docs/`, because the audience is
   * somebody outside this package who found the repo, not somebody reading
   * this package's source.
   */
  it('is what the schemas render', async () => {
    const markdown = renderApiReference({
      serverUrl: SERVER_URL,
      version: VERSION,
    })
    await expect(markdown).toMatchFileSnapshot('../../../docs/api.md')
  })

  it('mentions no route the table does not have', () => {
    const markdown = renderApiReference({
      serverUrl: SERVER_URL,
      version: VERSION,
    })
    for (const route of PUBLIC_ROUTES) {
      expect(markdown).toContain(`${route.method} ${openApiPath(route.path)}`)
    }
  })

  it('says the thing a reader must not miss about a minted key', () => {
    const markdown = renderApiReference({
      serverUrl: SERVER_URL,
      version: VERSION,
    })
    // Not a style assertion. "Shown once" is the single fact whose absence
    // turns this feature into a support queue.
    expect(markdown).toContain('shown once')
    expect(markdown).toContain('Revocation is immediate')
    // And the endianness sentence, which is decision D1 and the thing most
    // likely to be got wrong against another toolchain.
    expect(markdown).toContain('least significant bit')
  })
})
