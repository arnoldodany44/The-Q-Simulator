/**
 * `GET /embed/:handle`, driven through `inject()` — §3.4, §11.
 *
 * The route has one job and three refusals, and the refusals are what this
 * file is organised around:
 *
 *   1. PRIVATE is not embeddable, **including for its own owner**. This is the
 *      assertion that separates this route from `GET /circuits/:id`, which is
 *      supposed to answer an owner. It is asserted by sending a genuinely
 *      valid owner token and getting a 404 anyway — because the route declares
 *      `auth: 'public'`, so the header is never read.
 *   2. The refusal is indistinguishable from "no such circuit": same status,
 *      same error code, same shape. A 403 would tell an enumerator that the
 *      slug names something, which is the whole of what an UNLISTED slug
 *      protects.
 *   3. The response carries only what `packages/contract/src/embed.ts` lists.
 *      That file argues each omission; this asserts them against the real
 *      serialiser, because a field can be dropped from a schema and still
 *      leave a handler that hands it over.
 *
 * Nothing is mocked but Postgres, exactly as in `circuits.test.ts`: the tokens
 * are genuinely signed ES256 and verified through the real JWKS cache, and the
 * app is the real app with the real hooks and the real error handler.
 */

import { CIRCUIT_SCHEMA_VERSION } from '@qsim/schema'
import type { CircuitInput } from '@qsim/schema'
import { describe, expect, it } from 'vitest'
import { createTestApp } from '../testing/app.js'
import { createMemoryCircuitRepository } from '../testing/circuit-repository.js'
import type { MemoryCircuitRepository } from '../testing/circuit-repository.js'
import {
  createSigningKey,
  createTestJwksCache,
  signToken,
  stubJwksEndpoint,
} from '../testing/tokens.js'
import type { ApiInstance } from '../app.js'

const OWNER_ID = '11111111-1111-4111-8111-111111111111'
const CIRCUITS = '/api/v1/circuits'
const EMBED = '/api/v1/embed'

type Visibility = 'PRIVATE' | 'UNLISTED' | 'PUBLIC'

interface ErrorBody {
  error: { code: string; message: string; requestId: string }
}

interface EmbedBody {
  embed: {
    slug: string
    title: string
    qubitCount: number
    gateCount: number
    depth: number
    author: { username: string }
    circuit: CircuitInput
  }
}

interface CreatedBody {
  circuit: { id: string; slug: string }
}

/** A Bell pair: two gates, two columns, two qubits. */
function bell(): CircuitInput {
  return {
    schemaVersion: CIRCUIT_SCHEMA_VERSION,
    qubits: 2,
    clbits: 0,
    operations: [
      { id: 'op-0', gate: 'h', targets: [0], column: 0 },
      { id: 'op-1', gate: 'cx', targets: [1], controls: [0], column: 1 },
    ],
  }
}

interface Harness {
  app: ApiInstance
  repository: MemoryCircuitRepository
  owner: Record<string, string>
}

async function harness(): Promise<Harness> {
  const key = await createSigningKey('key-1')
  const endpoint = stubJwksEndpoint([key])
  const repository = createMemoryCircuitRepository()
  const app = await createTestApp({
    jwks: createTestJwksCache(endpoint),
    circuits: { repository },
  })
  await app.ready()

  const ownerToken = await signToken(key, {
    subject: OWNER_ID,
    email: 'ada@example.com',
  })

  return { app, repository, owner: { authorization: `Bearer ${ownerToken}` } }
}

async function createCircuit(
  h: Harness,
  visibility: Visibility,
  title = 'Bell pair'
): Promise<CreatedBody['circuit']> {
  const response = await h.app.inject({
    method: 'POST',
    url: CIRCUITS,
    headers: h.owner,
    body: { title, visibility, circuit: bell(), description: 'a secret note' },
  })
  expect(response.statusCode).toBe(201)
  return response.json<CreatedBody>().circuit
}

describe('GET /embed/:handle', () => {
  it('serves a PUBLIC circuit to a caller with no credentials at all', async () => {
    const h = await harness()
    const created = await createCircuit(h, 'PUBLIC')

    const response = await h.app.inject({
      method: 'GET',
      url: `${EMBED}/${created.slug}`,
    })

    expect(response.statusCode).toBe(200)
    const body = response.json<EmbedBody>()
    expect(body.embed.slug).toBe(created.slug)
    expect(body.embed.title).toBe('Bell pair')
    expect(body.embed.circuit).toEqual(bell())
    await h.app.close()
  })

  it('serves an UNLISTED circuit, which is what a shared link is for', async () => {
    const h = await harness()
    const created = await createCircuit(h, 'UNLISTED')

    const response = await h.app.inject({
      method: 'GET',
      url: `${EMBED}/${created.slug}`,
    })

    expect(response.statusCode).toBe(200)
    expect(response.json<EmbedBody>().embed.slug).toBe(created.slug)
    await h.app.close()
  })

  it('reports the counters the server computed, not the client', async () => {
    const h = await harness()
    const created = await createCircuit(h, 'PUBLIC')

    const body = (
      await h.app.inject({ method: 'GET', url: `${EMBED}/${created.slug}` })
    ).json<EmbedBody>()

    // A Bell pair: two qubits, two gates, depth two. These are the
    // denormalised columns `@qsim/db` derives on write with @qsim/schema's
    // helpers, over the expanded circuit (§3.1, decision 3).
    expect(body.embed.qubitCount).toBe(2)
    expect(body.embed.gateCount).toBe(2)
    expect(body.embed.depth).toBe(2)
    await h.app.close()
  })

  it('refuses a PRIVATE circuit', async () => {
    const h = await harness()
    const created = await createCircuit(h, 'PRIVATE')

    const response = await h.app.inject({
      method: 'GET',
      url: `${EMBED}/${created.slug}`,
    })

    expect(response.statusCode).toBe(404)
    expect(response.json<ErrorBody>().error.code).toBe('NOT_FOUND')
    await h.app.close()
  })

  it('refuses a PRIVATE circuit to its own owner, token and all', async () => {
    /*
     * THE ASSERTION THIS ROUTE EXISTS FOR.
     *
     * `GET /circuits/:id` answers this same request with a 200, and should:
     * an owner may read their own private work. If the embed did too, an
     * author previewing their own embed would see it render and publish a
     * page that shows a 404 to everybody else — and any later change that
     * made the frame credentialed would publish the circuit itself.
     *
     * The token below is genuinely valid; the route simply never looks.
     */
    const h = await harness()
    const created = await createCircuit(h, 'PRIVATE')

    const readable = await h.app.inject({
      method: 'GET',
      url: `${CIRCUITS}/${created.slug}`,
      headers: h.owner,
    })
    expect(readable.statusCode).toBe(200)

    const embedded = await h.app.inject({
      method: 'GET',
      url: `${EMBED}/${created.slug}`,
      headers: h.owner,
    })

    expect(embedded.statusCode).toBe(404)
    expect(embedded.json<ErrorBody>().error.code).toBe('NOT_FOUND')
    await h.app.close()
  })

  it('answers a private circuit exactly as it answers one that never existed', async () => {
    const h = await harness()
    const created = await createCircuit(h, 'PRIVATE')

    const hidden = await h.app.inject({
      method: 'GET',
      url: `${EMBED}/${created.slug}`,
    })
    const absent = await h.app.inject({
      method: 'GET',
      url: `${EMBED}/aaaaaaaaaaaaaaaaaaaaa`,
    })

    expect(hidden.statusCode).toBe(absent.statusCode)
    expect(hidden.json<ErrorBody>().error.code).toBe(
      absent.json<ErrorBody>().error.code
    )
    /*
     * The bodies differ only in `requestId`, which is generated per request
     * and says nothing about the circuit. Anything else differing would be a
     * side channel: response length is observable.
     */
    const strip = (body: ErrorBody): unknown => ({
      ...body.error,
      requestId: '',
    })
    expect(strip(hidden.json<ErrorBody>())).toEqual(
      strip(absent.json<ErrorBody>())
    )
    await h.app.close()
  })

  it('refuses to reach an UNLISTED circuit by its id', async () => {
    /*
     * `idAddressableCircuitFilter` is narrower than the slug filter, and the
     * embed inherits that rather than restating it: the slug is the credential
     * §11 sized at 126 bits, and the id is not.
     */
    const h = await harness()
    const created = await createCircuit(h, 'UNLISTED')

    const bySlug = await h.app.inject({
      method: 'GET',
      url: `${EMBED}/${created.slug}`,
    })
    const byId = await h.app.inject({
      method: 'GET',
      url: `${EMBED}/${created.id}`,
    })

    expect(bySlug.statusCode).toBe(200)
    expect(byId.statusCode).toBe(404)
    await h.app.close()
  })

  it('sends only the fields the contract lists', async () => {
    const h = await harness()
    const created = await createCircuit(h, 'PUBLIC')

    const body = (
      await h.app.inject({ method: 'GET', url: `${EMBED}/${created.slug}` })
    ).json<Record<string, unknown>>()

    expect(Object.keys(body)).toEqual(['embed'])
    const embed = body.embed as Record<string, unknown>
    expect(Object.keys(embed).sort()).toEqual(
      [
        'author',
        'circuit',
        'depth',
        'gateCount',
        'qubitCount',
        'slug',
        'title',
      ].sort()
    )
    expect(Object.keys(embed.author as Record<string, unknown>)).toEqual([
      'username',
    ])

    // Named individually as well as by the key list, because these are the
    // ones whose absence is a decision rather than an accident.
    const serialised = JSON.stringify(body)
    expect(serialised).not.toContain('a secret note')
    expect(serialised).not.toContain('PUBLIC')
    expect(serialised).not.toContain(created.id)
    await h.app.close()
  })

  it('forbids caching, so un-publishing takes effect', async () => {
    const h = await harness()
    const created = await createCircuit(h, 'PUBLIC')

    const response = await h.app.inject({
      method: 'GET',
      url: `${EMBED}/${created.slug}`,
    })

    expect(response.headers['cache-control']).toBe('no-store')
    await h.app.close()
  })

  /**
   * And the mirror, which was missing: publishing has to take effect too.
   *
   * RFC 9111 §4.2.2 lists 404 among the heuristically cacheable statuses, so a
   * refusal left without `no-store` may be kept by a shared cache — and a
   * reader whose cache holds it goes on seeing "this circuit is not available
   * to embed" after the author has made it public. The header was set after
   * the `throw` and so was on the answer alone.
   */
  it('forbids caching the refusal too, so publishing takes effect', async () => {
    const h = await harness()
    const priv = await createCircuit(h, 'PRIVATE')

    const refused = await h.app.inject({
      method: 'GET',
      url: `${EMBED}/${priv.slug}`,
    })
    expect(refused.statusCode).toBe(404)
    expect(refused.headers['cache-control']).toBe('no-store')

    const missing = await h.app.inject({
      method: 'GET',
      url: `${EMBED}/nobody-ever-minted-this`,
    })
    expect(missing.statusCode).toBe(404)
    expect(missing.headers['cache-control']).toBe('no-store')
    await h.app.close()
  })

  it('refuses to be framed, like every other response this API sends', async () => {
    const h = await harness()
    const created = await createCircuit(h, 'PUBLIC')

    const response = await h.app.inject({
      method: 'GET',
      url: `${EMBED}/${created.slug}`,
    })

    /*
     * The *data* behind an embed is still an API response and still must not
     * be framed. What gets framed is the page in `apps/web` that renders it,
     * whose headers are the opposite and are asserted in
     * `apps/web/src/embed/headers.test.ts`.
     */
    expect(response.headers['x-frame-options']).toBe('DENY')
    await h.app.close()
  })

  it('rejects a handle the router should never have to look up', async () => {
    const h = await harness()

    const response = await h.app.inject({
      method: 'GET',
      url: `${EMBED}/${'x'.repeat(80)}`,
    })

    expect(response.statusCode).toBe(400)
    await h.app.close()
  })
})
