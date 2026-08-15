/**
 * The circuit routes, driven through `inject()` — §8 and §11, milestone M1.4.
 *
 * ── The rule this file is organised around ────────────────────────────────
 *
 * **"The owner can read it" proves nothing.** Every visibility rule is
 * asserted from a *second* user's perspective and from an anonymous one, and
 * for the two that must be indistinguishable — "no such circuit" and "not
 * yours to see" — the assertion is on the error code as well as the status,
 * because a 403 where a 404 belongs tells an enumerator that the slug exists.
 *
 * Nothing here is mocked except Postgres. The tokens are genuinely signed
 * ES256 by a key pair generated in-process and served through the real JWKS
 * cache; the app is the real app, with the real hooks, the real Zod
 * compilers and the real error handler. See `testing/circuit-repository.ts`
 * for why the database is the one substitution and what stops that
 * substitution from lying about the rule under test.
 */

import { CIRCUIT_SCHEMA_VERSION } from '@qsim/schema'
import type { CircuitInput } from '@qsim/schema'
import { MAX_CIRCUIT_JSON_BYTES } from '@qsim/db'
import { MAX_ERROR_DETAILS } from '../plugins/validation.js'
import { beforeEach, describe, expect, it } from 'vitest'
import { createTestApp } from '../testing/app.js'
import { createMemoryCircuitRepository } from '../testing/circuit-repository.js'
import type {
  MemoryCircuitRepository,
  MemoryRepositoryOptions,
} from '../testing/circuit-repository.js'
import {
  createSigningKey,
  createTestJwksCache,
  signToken,
  stubJwksEndpoint,
} from '../testing/tokens.js'
import type { ApiInstance } from '../app.js'

const OWNER_ID = '11111111-1111-4111-8111-111111111111'
const STRANGER_ID = '22222222-2222-4222-8222-222222222222'
const BASE = '/api/v1/circuits'

interface ErrorBody {
  error: { code: string; message: string; requestId: string; details?: unknown }
}

interface CardBody {
  id: string
  slug: string
  title: string
  visibility: string
  qubitCount: number
  gateCount: number
  depth: number
  description?: string | null
  owner: { id: string; username: string; avatarUrl: string | null }
}

interface VersionBody {
  id: string
  versionNum: number
  message: string | null
  createdAt: string
  circuit: CircuitInput
}

interface CircuitWithVersionBody {
  circuit: CardBody
  version: VersionBody
}

interface PageBody<T> {
  items: T[]
  page: number
  perPage: number
  total: number
  totalPages: number
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

/** A three-qubit GHZ, so a save is distinguishable from the one before it. */
function ghz(): CircuitInput {
  return {
    schemaVersion: CIRCUIT_SCHEMA_VERSION,
    qubits: 3,
    clbits: 0,
    operations: [
      { id: 'op-0', gate: 'h', targets: [0], column: 0 },
      { id: 'op-1', gate: 'cx', targets: [1], controls: [0], column: 1 },
      { id: 'op-2', gate: 'cx', targets: [2], controls: [1], column: 2 },
    ],
  }
}

interface Harness {
  app: ApiInstance
  repository: MemoryCircuitRepository
  owner: Record<string, string>
  stranger: Record<string, string>
}

async function harness(
  options: MemoryRepositoryOptions = {}
): Promise<Harness> {
  const key = await createSigningKey('key-1')
  const endpoint = stubJwksEndpoint([key])
  const repository = createMemoryCircuitRepository(options)
  const app = await createTestApp({
    jwks: createTestJwksCache(endpoint),
    circuits: { repository },
  })
  await app.ready()

  const ownerToken = await signToken(key, {
    subject: OWNER_ID,
    email: 'ada@example.com',
  })
  const strangerToken = await signToken(key, {
    subject: STRANGER_ID,
    email: 'grace@example.com',
  })

  return {
    app,
    repository,
    owner: { authorization: `Bearer ${ownerToken}` },
    stranger: { authorization: `Bearer ${strangerToken}` },
  }
}

async function createCircuit(
  h: Harness,
  overrides: {
    title?: string
    visibility?: 'PRIVATE' | 'UNLISTED' | 'PUBLIC'
    circuit?: CircuitInput
    description?: string
  } = {}
): Promise<CircuitWithVersionBody> {
  const response = await h.app.inject({
    method: 'POST',
    url: BASE,
    headers: h.owner,
    body: {
      title: overrides.title ?? 'Bell pair',
      visibility: overrides.visibility ?? 'PRIVATE',
      circuit: overrides.circuit ?? bell(),
      ...(overrides.description === undefined
        ? {}
        : { description: overrides.description }),
    },
  })
  expect(response.statusCode).toBe(201)
  return response.json<CircuitWithVersionBody>()
}

describe('POST /circuits', () => {
  it('creates a circuit and its first version', async () => {
    const h = await harness()

    const body = await createCircuit(h, { title: 'Bell pair' })

    expect(body.circuit.title).toBe('Bell pair')
    expect(body.circuit.visibility).toBe('PRIVATE')
    expect(body.version.versionNum).toBe(1)
    expect(body.version.circuit).toEqual(bell())
    await h.app.close()
  })

  it('derives the counters from the circuit and ignores what the client says', async () => {
    /*
     * The whole reason these columns are denormalised: the gallery sorts on
     * them without a join, and a Phase 3 leaderboard ranks on them. A client
     * that could set `gateCount` could rank itself first.
     */
    const h = await harness()

    const response = await h.app.inject({
      method: 'POST',
      url: BASE,
      headers: h.owner,
      body: {
        title: 'Liar',
        circuit: bell(),
        gateCount: 0,
        depth: 0,
        qubitCount: 28,
        starCount: 9999,
      },
    })

    expect(response.statusCode).toBe(201)
    const body = response.json<CircuitWithVersionBody>()
    expect(body.circuit.gateCount).toBe(2)
    expect(body.circuit.depth).toBe(2)
    expect(body.circuit.qubitCount).toBe(2)
    await h.app.close()
  })

  it('refuses an anonymous caller', async () => {
    const h = await harness()

    const response = await h.app.inject({
      method: 'POST',
      url: BASE,
      body: { title: 'Bell pair', circuit: bell() },
    })

    expect(response.statusCode).toBe(401)
    expect(response.json<ErrorBody>().error.code).toBe('AUTH_REQUIRED')
    expect(h.repository.allCircuits()).toHaveLength(0)
    await h.app.close()
  })

  it('rejects a circuit the shared contract refuses', async () => {
    const h = await harness()

    const response = await h.app.inject({
      method: 'POST',
      url: BASE,
      headers: h.owner,
      // 2^999 amplitudes. The contract caps qubits at 28.
      body: { title: 'Too big', circuit: { ...bell(), qubits: 999 } },
    })

    expect(response.statusCode).toBe(400)
    expect(response.json<ErrorBody>().error.code).toBe('VALIDATION_FAILED')
    expect(h.repository.allCircuits()).toHaveLength(0)
    await h.app.close()
  })

  it('rejects a circuit that is well-shaped and impossible', async () => {
    /*
     * The half a JSON schema cannot express, and the reason `parseCircuit`
     * runs in the handler even though the route already declared
     * `CircuitSchema`: two gates on the same qubit in the same column is a
     * shape Zod accepts and a circuit that cannot be executed.
     */
    const h = await harness()

    const response = await h.app.inject({
      method: 'POST',
      url: BASE,
      headers: h.owner,
      body: {
        title: 'Two gates, one moment',
        circuit: {
          ...bell(),
          operations: [
            { id: 'op-0', gate: 'h', targets: [0], column: 0 },
            { id: 'op-1', gate: 'x', targets: [0], column: 0 },
          ],
        },
      },
    })

    expect(response.statusCode).toBe(400)
    const body = response.json<ErrorBody>()
    expect(body.error.code).toBe('VALIDATION_FAILED')
    // The code travels, not a sentence: the client owns the wording in three
    // languages and can highlight the offending operation by its id.
    expect(body.error.details).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: 'column-conflict' }),
      ])
    )
    await h.app.close()
  })

  it('refuses a circuit too large to store', async () => {
    /*
     * The contract permits 4096 columns and nothing stops a client sending
     * all of them. A version is immutable, so a row written too large can
     * never be shrunk — only orphaned.
     */
    const h = await harness()
    const operations = []
    for (let column = 0; column < 3200; column += 1) {
      operations.push({
        id: `op-a-${String(column)}`,
        gate: 'h',
        targets: [0],
        column,
      })
      operations.push({
        id: `op-b-${String(column)}`,
        gate: 'h',
        targets: [1],
        column,
      })
    }
    const huge = { ...bell(), operations }
    expect(JSON.stringify(huge).length).toBeGreaterThan(MAX_CIRCUIT_JSON_BYTES)

    const response = await h.app.inject({
      method: 'POST',
      url: BASE,
      headers: h.owner,
      body: { title: 'Enormous', circuit: huge },
    })

    expect(response.statusCode).toBe(413)
    expect(response.json<ErrorBody>().error.code).toBe('CIRCUIT_TOO_LARGE')
    expect(h.repository.allCircuits()).toHaveLength(0)
    await h.app.close()
  })

  it('mints a distinct, high-entropy slug for every circuit', async () => {
    const h = await harness()

    const first = await createCircuit(h, { title: 'One' })
    const second = await createCircuit(h, { title: 'Two' })

    expect(first.circuit.slug).not.toBe(second.circuit.slug)
    // 21 characters of nanoid's 64-symbol alphabet — 126 bits. An UNLISTED
    // circuit has no other protection; see slugs.ts for the arithmetic.
    expect(first.circuit.slug).toMatch(/^[A-Za-z0-9_-]{21}$/)
    await h.app.close()
  })

  it('rejects a title of nothing but whitespace', async () => {
    const h = await harness()

    const response = await h.app.inject({
      method: 'POST',
      url: BASE,
      headers: h.owner,
      body: { title: '   ', circuit: bell() },
    })

    expect(response.statusCode).toBe(400)
    await h.app.close()
  })
})

describe('GET /circuits — the caller’s own', () => {
  it('lists the caller’s circuits, newest first', async () => {
    const h = await harness()
    await createCircuit(h, { title: 'First' })
    await createCircuit(h, { title: 'Second' })

    const response = await h.app.inject({
      method: 'GET',
      url: BASE,
      headers: h.owner,
    })

    expect(response.statusCode).toBe(200)
    const page = response.json<PageBody<CardBody>>()
    expect(page.total).toBe(2)
    expect(page.items.map((item) => item.title)).toEqual(['Second', 'First'])
    await h.app.close()
  })

  it('shows a stranger nothing of the owner’s, whatever its visibility', async () => {
    /*
     * "Mine, paginated" (§8) is scoped to the owner and not to the gallery
     * filter. A PUBLIC circuit is readable by its slug and still does not
     * belong in somebody else's list of their own work.
     */
    const h = await harness()
    await createCircuit(h, { title: 'Public', visibility: 'PUBLIC' })
    await createCircuit(h, { title: 'Unlisted', visibility: 'UNLISTED' })
    await createCircuit(h, { title: 'Private', visibility: 'PRIVATE' })

    const response = await h.app.inject({
      method: 'GET',
      url: BASE,
      headers: h.stranger,
    })

    expect(response.statusCode).toBe(200)
    expect(response.json<PageBody<CardBody>>().items).toEqual([])
    await h.app.close()
  })

  it('paginates', async () => {
    const h = await harness()
    await createCircuit(h, { title: 'One' })
    await createCircuit(h, { title: 'Two' })
    await createCircuit(h, { title: 'Three' })

    const response = await h.app.inject({
      method: 'GET',
      url: `${BASE}?page=2&perPage=2`,
      headers: h.owner,
    })

    const page = response.json<PageBody<CardBody>>()
    expect(page.page).toBe(2)
    expect(page.total).toBe(3)
    expect(page.totalPages).toBe(2)
    expect(page.items).toHaveLength(1)
    await h.app.close()
  })

  it('refuses an anonymous caller', async () => {
    const h = await harness()

    const response = await h.app.inject({ method: 'GET', url: BASE })

    expect(response.statusCode).toBe(401)
    await h.app.close()
  })
})

describe('GET /circuits/:slug — the §11 read rules', () => {
  it('lets the owner read their own PRIVATE circuit', async () => {
    const h = await harness()
    const created = await createCircuit(h, { visibility: 'PRIVATE' })

    const response = await h.app.inject({
      method: 'GET',
      url: `${BASE}/${created.circuit.slug}`,
      headers: h.owner,
    })

    expect(response.statusCode).toBe(200)
    await h.app.close()
  })

  it('hides a PRIVATE circuit from a signed-in stranger, as a 404', async () => {
    const h = await harness()
    const created = await createCircuit(h, { visibility: 'PRIVATE' })

    const response = await h.app.inject({
      method: 'GET',
      url: `${BASE}/${created.circuit.slug}`,
      headers: h.stranger,
    })

    expect(response.statusCode).toBe(404)
    // Not 403: that would confirm the slug names something real.
    expect(response.json<ErrorBody>().error.code).toBe('NOT_FOUND')
    await h.app.close()
  })

  it('hides a PRIVATE circuit from an anonymous caller', async () => {
    const h = await harness()
    const created = await createCircuit(h, { visibility: 'PRIVATE' })

    const response = await h.app.inject({
      method: 'GET',
      url: `${BASE}/${created.circuit.slug}`,
    })

    expect(response.statusCode).toBe(404)
    await h.app.close()
  })

  it('serves a PUBLIC circuit to anyone, signed in or not', async () => {
    const h = await harness()
    const created = await createCircuit(h, { visibility: 'PUBLIC' })

    const anonymous = await h.app.inject({
      method: 'GET',
      url: `${BASE}/${created.circuit.slug}`,
    })
    const stranger = await h.app.inject({
      method: 'GET',
      url: `${BASE}/${created.circuit.slug}`,
      headers: h.stranger,
    })

    expect(anonymous.statusCode).toBe(200)
    expect(stranger.statusCode).toBe(200)
    await h.app.close()
  })

  it('serves an UNLISTED circuit to whoever holds the slug', async () => {
    // That is what UNLISTED is: reachable, never discoverable. The slug is
    // the credential, which is why it carries 126 bits.
    const h = await harness()
    const created = await createCircuit(h, { visibility: 'UNLISTED' })

    const response = await h.app.inject({
      method: 'GET',
      url: `${BASE}/${created.circuit.slug}`,
    })

    expect(response.statusCode).toBe(200)
    await h.app.close()
  })

  it('answers with the latest version, not the first', async () => {
    const h = await harness()
    const created = await createCircuit(h)
    await h.app.inject({
      method: 'POST',
      url: `${BASE}/${created.circuit.id}/versions`,
      headers: h.owner,
      body: { circuit: ghz(), message: 'three qubits now' },
    })

    const response = await h.app.inject({
      method: 'GET',
      url: `${BASE}/${created.circuit.slug}`,
      headers: h.owner,
    })

    const body = response.json<CircuitWithVersionBody>()
    expect(body.version.versionNum).toBe(2)
    expect(body.version.circuit).toEqual(ghz())
    await h.app.close()
  })

  it('answers 404 for a slug nobody ever minted', async () => {
    const h = await harness()

    const response = await h.app.inject({
      method: 'GET',
      url: `${BASE}/aaaaaaaaaaaaaaaaaaaaa`,
    })

    expect(response.statusCode).toBe(404)
    await h.app.close()
  })

  it('rejects a handle that could not be one before querying', async () => {
    const h = await harness()

    const response = await h.app.inject({ method: 'GET', url: `${BASE}/ab` })

    expect(response.statusCode).toBe(400)
    expect(response.json<ErrorBody>().error.code).toBe('VALIDATION_FAILED')
    await h.app.close()
  })

  it('sends the byline and not the columns behind it', async () => {
    /*
     * `circuitDetailSelect` fetches `ownerId` because authorisation needs it,
     * and the owner row carries an email. The response schema mentions
     * neither, and serialising *through* the schema — rather than
     * stringifying what the handler returned — is what keeps them out of the
     * body. `owner.id` is deliberately present: it is what a profile link
     * needs, and it is not a secret.
     */
    const h = await harness()
    const created = await createCircuit(h, { visibility: 'PUBLIC' })

    const response = await h.app.inject({
      method: 'GET',
      url: `${BASE}/${created.circuit.slug}`,
    })

    expect(response.json()).not.toHaveProperty('circuit.ownerId')
    expect(response.json()).toHaveProperty('circuit.owner.id', OWNER_ID)
    expect(response.body).not.toContain('ada@example.com')
    await h.app.close()
  })
})

describe('an UNLISTED circuit is protected by its slug and by nothing else', () => {
  /*
   * The breach this block exists for, reproduced end to end.
   *
   * `forkedFromId` used to ride out in every card, and `findReadable` used to
   * accept a bare id as a full substitute for the slug. Together: fork a
   * circuit, publish the fork, and every anonymous reader of the fork was
   * handed a working, unrevocable handle to the UNLISTED circuit it came
   * from — its title, its description, its whole version history and its
   * payload. The owner could not see it, could not revoke it, and
   * un-publishing did not close it, because the fork kept pointing at it.
   *
   * Both halves are asserted, because either one alone still closes the door
   * and the next person to touch this should have to break both.
   */

  it('does not publish a handle to the circuit a fork came from', async () => {
    const h = await harness()
    const source = await createCircuit(h, {
      visibility: 'PUBLIC',
      title: 'draft that went out too early',
    })

    const forked = await h.app.inject({
      method: 'POST',
      url: `${BASE}/${source.circuit.id}/fork`,
      headers: h.stranger,
    })
    const fork = forked.json<CircuitWithVersionBody>()

    await h.app.inject({
      method: 'PATCH',
      url: `${BASE}/${fork.circuit.id}`,
      headers: h.stranger,
      body: { visibility: 'PUBLIC' },
    })
    // Alice changes her mind and un-publishes.
    await h.app.inject({
      method: 'PATCH',
      url: `${BASE}/${source.circuit.id}`,
      headers: h.owner,
      body: { visibility: 'UNLISTED' },
    })

    const anonymous = await h.app.inject({
      method: 'GET',
      url: `${BASE}/${fork.circuit.id}`,
    })

    expect(anonymous.statusCode).toBe(200)
    expect(anonymous.body).not.toContain(source.circuit.id)
    expect(anonymous.body).not.toContain('forkedFromId')
    await h.app.close()
  })

  it('refuses the id and accepts the slug, for everyone but the owner', async () => {
    const h = await harness()
    const created = await createCircuit(h, { visibility: 'UNLISTED' })

    for (const headers of [{}, h.stranger]) {
      const byId = await h.app.inject({
        method: 'GET',
        url: `${BASE}/${created.circuit.id}`,
        headers,
      })
      const bySlug = await h.app.inject({
        method: 'GET',
        url: `${BASE}/${created.circuit.slug}`,
        headers,
      })

      expect(byId.statusCode).toBe(404)
      expect(byId.json<ErrorBody>().error.code).toBe('NOT_FOUND')
      expect(bySlug.statusCode).toBe(200)
    }

    // The owner reaches their own circuit either way.
    const owner = await h.app.inject({
      method: 'GET',
      url: `${BASE}/${created.circuit.id}`,
      headers: h.owner,
    })
    expect(owner.statusCode).toBe(200)
    await h.app.close()
  })

  it('closes the history and the payload to the same caller', async () => {
    // The read is only half of it: a handle that opens the versions is a
    // handle that reads the circuit.
    const h = await harness()
    const created = await createCircuit(h, { visibility: 'UNLISTED' })

    for (const url of [
      `${BASE}/${created.circuit.id}/versions`,
      `${BASE}/${created.circuit.id}/versions/1`,
    ]) {
      const response = await h.app.inject({ method: 'GET', url })
      expect(response.statusCode, url).toBe(404)
    }
    await h.app.close()
  })

  it('still addresses a PUBLIC circuit by its id', async () => {
    // The id has to keep working somewhere, or `/circuits/:id/versions` stops
    // working for the gallery.
    const h = await harness()
    const created = await createCircuit(h, { visibility: 'PUBLIC' })

    const response = await h.app.inject({
      method: 'GET',
      url: `${BASE}/${created.circuit.id}`,
    })

    expect(response.statusCode).toBe(200)
    await h.app.close()
  })
})

describe('PATCH /circuits/:id', () => {
  it('lets the owner rename and republish', async () => {
    const h = await harness()
    const created = await createCircuit(h, { visibility: 'PRIVATE' })

    const response = await h.app.inject({
      method: 'PATCH',
      url: `${BASE}/${created.circuit.id}`,
      headers: h.owner,
      body: { title: 'Renamed', visibility: 'PUBLIC' },
    })

    expect(response.statusCode).toBe(200)
    const body = response.json<{ circuit: CardBody }>()
    expect(body.circuit.title).toBe('Renamed')
    expect(body.circuit.visibility).toBe('PUBLIC')
    await h.app.close()
  })

  it('refuses a stranger who can see the circuit, with 403', async () => {
    // PUBLIC means readable, not writable. Forking is how somebody else
    // builds on it.
    const h = await harness()
    const created = await createCircuit(h, { visibility: 'PUBLIC' })

    const response = await h.app.inject({
      method: 'PATCH',
      url: `${BASE}/${created.circuit.id}`,
      headers: h.stranger,
      body: { title: 'Mine now' },
    })

    expect(response.statusCode).toBe(403)
    expect(response.json<ErrorBody>().error.code).toBe('FORBIDDEN')
    expect(h.repository.allCircuits()[0]?.title).toBe('Bell pair')
    await h.app.close()
  })

  it('refuses a stranger who cannot see the circuit, with 404', async () => {
    /*
     * The distinction that matters: 403 on a PRIVATE circuit would tell an
     * enumerator that the id names something real. 403 on a PUBLIC one costs
     * nothing, because it is public.
     */
    const h = await harness()
    const created = await createCircuit(h, { visibility: 'PRIVATE' })

    const response = await h.app.inject({
      method: 'PATCH',
      url: `${BASE}/${created.circuit.id}`,
      headers: h.stranger,
      body: { title: 'Mine now' },
    })

    expect(response.statusCode).toBe(404)
    await h.app.close()
  })

  it('refuses an anonymous caller', async () => {
    const h = await harness()
    const created = await createCircuit(h, { visibility: 'PUBLIC' })

    const response = await h.app.inject({
      method: 'PATCH',
      url: `${BASE}/${created.circuit.id}`,
      body: { title: 'Mine now' },
    })

    expect(response.statusCode).toBe(401)
    await h.app.close()
  })

  it('cannot touch the document — that is what a version is for', async () => {
    const h = await harness()
    const created = await createCircuit(h)

    const response = await h.app.inject({
      method: 'PATCH',
      url: `${BASE}/${created.circuit.id}`,
      headers: h.owner,
      body: { title: 'Renamed', circuit: ghz() },
    })

    expect(response.statusCode).toBe(200)
    // One version still, and it is the one that was created with the circuit.
    const versions = h.repository.allVersions(created.circuit.id)
    expect(versions).toHaveLength(1)
    expect(versions[0]?.data).toEqual(bell())
    await h.app.close()
  })

  it('rejects a patch that changes nothing', async () => {
    const h = await harness()
    const created = await createCircuit(h)

    const response = await h.app.inject({
      method: 'PATCH',
      url: `${BASE}/${created.circuit.id}`,
      headers: h.owner,
      body: {},
    })

    expect(response.statusCode).toBe(400)
    await h.app.close()
  })
})

describe('DELETE /circuits/:id', () => {
  it('lets the owner delete, and the versions go with it', async () => {
    const h = await harness()
    const created = await createCircuit(h)

    const deleted = await h.app.inject({
      method: 'DELETE',
      url: `${BASE}/${created.circuit.id}`,
      headers: h.owner,
    })
    const after = await h.app.inject({
      method: 'GET',
      url: `${BASE}/${created.circuit.slug}`,
      headers: h.owner,
    })

    expect(deleted.statusCode).toBe(204)
    expect(after.statusCode).toBe(404)
    expect(h.repository.allVersions(created.circuit.id)).toHaveLength(0)
    await h.app.close()
  })

  it('refuses a stranger on a PUBLIC circuit, with 403', async () => {
    const h = await harness()
    const created = await createCircuit(h, { visibility: 'PUBLIC' })

    const response = await h.app.inject({
      method: 'DELETE',
      url: `${BASE}/${created.circuit.id}`,
      headers: h.stranger,
    })

    expect(response.statusCode).toBe(403)
    expect(h.repository.allCircuits()).toHaveLength(1)
    await h.app.close()
  })

  it('refuses a stranger on a PRIVATE circuit, with 404', async () => {
    const h = await harness()
    const created = await createCircuit(h, { visibility: 'PRIVATE' })

    const response = await h.app.inject({
      method: 'DELETE',
      url: `${BASE}/${created.circuit.id}`,
      headers: h.stranger,
    })

    expect(response.statusCode).toBe(404)
    expect(h.repository.allCircuits()).toHaveLength(1)
    await h.app.close()
  })

  it('refuses an anonymous caller', async () => {
    const h = await harness()
    const created = await createCircuit(h, { visibility: 'PUBLIC' })

    const response = await h.app.inject({
      method: 'DELETE',
      url: `${BASE}/${created.circuit.id}`,
    })

    expect(response.statusCode).toBe(401)
    expect(h.repository.allCircuits()).toHaveLength(1)
    await h.app.close()
  })
})

describe('POST /circuits/:id/fork', () => {
  it('copies a PUBLIC circuit into one the caller owns', async () => {
    const h = await harness()
    const source = await createCircuit(h, {
      visibility: 'PUBLIC',
      title: 'Bell pair',
    })

    const response = await h.app.inject({
      method: 'POST',
      url: `${BASE}/${source.circuit.id}/fork`,
      headers: h.stranger,
    })

    expect(response.statusCode).toBe(201)
    const fork = response.json<CircuitWithVersionBody>()
    expect(fork.circuit.id).not.toBe(source.circuit.id)
    expect(fork.circuit.owner.id).toBe(STRANGER_ID)
    /*
     * Attribution is recorded on the row and does not travel: it is a handle
     * to a circuit whose visibility has nothing to do with this one's, and
     * publishing it was how a PUBLIC fork handed anonymous readers a working
     * handle to the UNLISTED circuit it came from.
     */
    expect(response.body).not.toContain('forkedFromId')
    const stored = h.repository
      .allCircuits()
      .find((row) => row.id === fork.circuit.id)
    expect(stored?.forkedFromId).toBe(source.circuit.id)
    // A fork of a public circuit is not itself published.
    expect(fork.circuit.visibility).toBe('PRIVATE')
    expect(fork.version.versionNum).toBe(1)
    expect(fork.version.circuit).toEqual(bell())
    await h.app.close()
  })

  it('copies the current version, not the first one', async () => {
    const h = await harness()
    const source = await createCircuit(h, { visibility: 'PUBLIC' })
    await h.app.inject({
      method: 'POST',
      url: `${BASE}/${source.circuit.id}/versions`,
      headers: h.owner,
      body: { circuit: ghz() },
    })

    const response = await h.app.inject({
      method: 'POST',
      url: `${BASE}/${source.circuit.id}/fork`,
      headers: h.stranger,
    })

    expect(response.json<CircuitWithVersionBody>().version.circuit).toEqual(
      ghz()
    )
    await h.app.close()
  })

  it('refuses to fork what the caller cannot read', async () => {
    const h = await harness()
    const source = await createCircuit(h, { visibility: 'PRIVATE' })

    const response = await h.app.inject({
      method: 'POST',
      url: `${BASE}/${source.circuit.id}/fork`,
      headers: h.stranger,
    })

    expect(response.statusCode).toBe(404)
    expect(h.repository.allCircuits()).toHaveLength(1)
    await h.app.close()
  })

  it('forks an UNLISTED circuit for whoever holds its slug', async () => {
    const h = await harness()
    const source = await createCircuit(h, { visibility: 'UNLISTED' })

    const response = await h.app.inject({
      method: 'POST',
      url: `${BASE}/${source.circuit.slug}/fork`,
      headers: h.stranger,
    })

    expect(response.statusCode).toBe(201)
    await h.app.close()
  })

  it('leaves the source untouched', async () => {
    const h = await harness()
    const source = await createCircuit(h, { visibility: 'PUBLIC' })

    await h.app.inject({
      method: 'POST',
      url: `${BASE}/${source.circuit.id}/fork`,
      headers: h.stranger,
    })

    const after = await h.app.inject({
      method: 'GET',
      url: `${BASE}/${source.circuit.slug}`,
      headers: h.owner,
    })
    const body = after.json<CircuitWithVersionBody>()
    expect(body.circuit.owner.id).toBe(OWNER_ID)
    const stored = h.repository
      .allCircuits()
      .find((row) => row.id === source.circuit.id)
    expect(stored?.forkedFromId).toBeNull()
    expect(h.repository.allVersions(source.circuit.id)).toHaveLength(1)
    await h.app.close()
  })

  it('takes a title from the caller when one is offered', async () => {
    const h = await harness()
    const source = await createCircuit(h, { visibility: 'PUBLIC' })

    const response = await h.app.inject({
      method: 'POST',
      url: `${BASE}/${source.circuit.id}/fork`,
      headers: h.stranger,
      body: { title: 'Bell pair, my take' },
    })

    expect(response.json<CircuitWithVersionBody>().circuit.title).toBe(
      'Bell pair, my take'
    )
    await h.app.close()
  })

  it('refuses an anonymous caller', async () => {
    const h = await harness()
    const source = await createCircuit(h, { visibility: 'PUBLIC' })

    const response = await h.app.inject({
      method: 'POST',
      url: `${BASE}/${source.circuit.id}/fork`,
    })

    expect(response.statusCode).toBe(401)
    expect(h.repository.allCircuits()).toHaveLength(1)
    await h.app.close()
  })
})

describe('GET /circuits/:id/versions', () => {
  it('lists the history newest first', async () => {
    const h = await harness()
    const created = await createCircuit(h)
    await h.app.inject({
      method: 'POST',
      url: `${BASE}/${created.circuit.id}/versions`,
      headers: h.owner,
      body: { circuit: ghz(), message: 'grew a qubit' },
    })

    const response = await h.app.inject({
      method: 'GET',
      url: `${BASE}/${created.circuit.id}/versions`,
      headers: h.owner,
    })

    expect(response.statusCode).toBe(200)
    const page = response.json<PageBody<{ versionNum: number }>>()
    expect(page.items.map((item) => item.versionNum)).toEqual([2, 1])
    await h.app.close()
  })

  it('hides the history of a PRIVATE circuit from a stranger', async () => {
    /*
     * The route it is easiest to leave unfiltered: the circuit's own page has
     * an obvious check and this one is addressed by id and looks like
     * metadata. It is not — a version carries the whole document.
     */
    const h = await harness()
    const created = await createCircuit(h, { visibility: 'PRIVATE' })

    const stranger = await h.app.inject({
      method: 'GET',
      url: `${BASE}/${created.circuit.id}/versions`,
      headers: h.stranger,
    })
    const anonymous = await h.app.inject({
      method: 'GET',
      url: `${BASE}/${created.circuit.id}/versions`,
    })

    expect(stranger.statusCode).toBe(404)
    expect(anonymous.statusCode).toBe(404)
    await h.app.close()
  })

  it('shows the history of a PUBLIC circuit to anyone', async () => {
    const h = await harness()
    const created = await createCircuit(h, { visibility: 'PUBLIC' })

    const response = await h.app.inject({
      method: 'GET',
      url: `${BASE}/${created.circuit.id}/versions`,
    })

    expect(response.statusCode).toBe(200)
    expect(response.json<PageBody<unknown>>().total).toBe(1)
    await h.app.close()
  })

  it('does not put the payload in a listing', async () => {
    // A history sidebar of fifty entries does not need fifty circuits.
    const h = await harness()
    const created = await createCircuit(h, { visibility: 'PUBLIC' })

    const response = await h.app.inject({
      method: 'GET',
      url: `${BASE}/${created.circuit.id}/versions`,
    })

    expect(response.json<PageBody<VersionBody>>().items[0]).not.toHaveProperty(
      'circuit'
    )
    await h.app.close()
  })
})

describe('POST /circuits/:id/versions', () => {
  it('appends monotonically and never rewrites', async () => {
    const h = await harness()
    const created = await createCircuit(h)

    const second = await h.app.inject({
      method: 'POST',
      url: `${BASE}/${created.circuit.id}/versions`,
      headers: h.owner,
      body: { circuit: ghz(), message: 'grew a qubit' },
    })
    const third = await h.app.inject({
      method: 'POST',
      url: `${BASE}/${created.circuit.id}/versions`,
      headers: h.owner,
      body: { circuit: bell(), message: 'back to two' },
    })

    expect(second.statusCode).toBe(201)
    expect(second.json<{ version: VersionBody }>().version.versionNum).toBe(2)
    expect(third.json<{ version: VersionBody }>().version.versionNum).toBe(3)

    // Version 1 is exactly what it was, which is the promise the word
    // "immutable" makes.
    const first = await h.app.inject({
      method: 'GET',
      url: `${BASE}/${created.circuit.id}/versions/1`,
      headers: h.owner,
    })
    expect(first.json<{ version: VersionBody }>().version.circuit).toEqual(
      bell()
    )
    await h.app.close()
  })

  it('recomputes the circuit’s counters from the new version', async () => {
    const h = await harness()
    const created = await createCircuit(h)

    await h.app.inject({
      method: 'POST',
      url: `${BASE}/${created.circuit.id}/versions`,
      headers: h.owner,
      body: { circuit: ghz() },
    })

    const response = await h.app.inject({
      method: 'GET',
      url: `${BASE}/${created.circuit.slug}`,
      headers: h.owner,
    })
    const body = response.json<CircuitWithVersionBody>()
    expect(body.circuit.qubitCount).toBe(3)
    expect(body.circuit.gateCount).toBe(3)
    expect(body.circuit.depth).toBe(3)
    await h.app.close()
  })

  it('refuses a stranger on a PUBLIC circuit, with 403', async () => {
    const h = await harness()
    const created = await createCircuit(h, { visibility: 'PUBLIC' })

    const response = await h.app.inject({
      method: 'POST',
      url: `${BASE}/${created.circuit.id}/versions`,
      headers: h.stranger,
      body: { circuit: ghz() },
    })

    expect(response.statusCode).toBe(403)
    expect(h.repository.allVersions(created.circuit.id)).toHaveLength(1)
    await h.app.close()
  })

  it('refuses a stranger on a PRIVATE circuit, with 404', async () => {
    const h = await harness()
    const created = await createCircuit(h, { visibility: 'PRIVATE' })

    const response = await h.app.inject({
      method: 'POST',
      url: `${BASE}/${created.circuit.id}/versions`,
      headers: h.stranger,
      body: { circuit: ghz() },
    })

    expect(response.statusCode).toBe(404)
    await h.app.close()
  })

  it('refuses an anonymous caller', async () => {
    const h = await harness()
    const created = await createCircuit(h, { visibility: 'PUBLIC' })

    const response = await h.app.inject({
      method: 'POST',
      url: `${BASE}/${created.circuit.id}/versions`,
      body: { circuit: ghz() },
    })

    expect(response.statusCode).toBe(401)
    expect(h.repository.allVersions(created.circuit.id)).toHaveLength(1)
    await h.app.close()
  })

  it('validates the circuit before storing it', async () => {
    const h = await harness()
    const created = await createCircuit(h)

    const response = await h.app.inject({
      method: 'POST',
      url: `${BASE}/${created.circuit.id}/versions`,
      headers: h.owner,
      body: { circuit: { ...bell(), qubits: 0 } },
    })

    expect(response.statusCode).toBe(400)
    expect(h.repository.allVersions(created.circuit.id)).toHaveLength(1)
    await h.app.close()
  })

  it('answers 404, not 500, when the circuit is deleted mid-flight', async () => {
    /*
     * An ordinary lost race: the owner deletes the circuit in the window
     * between the read and the write. Postgres raises a foreign-key
     * violation, which was unmapped and fell through to 500 — logged at
     * error level, in the class clients and proxies retry, for a save aimed
     * at a circuit that will never exist again.
     *
     * The in-memory repository models the same constraint; it used to answer
     * 201 and leave an orphan version, which is why this had no failing test.
     */
    const h: Harness = await harness({
      beforeVersionWrite: async (circuitId) => {
        await h.app.inject({
          method: 'DELETE',
          url: `${BASE}/${circuitId}`,
          headers: h.owner,
        })
      },
    })
    const created = await createCircuit(h)

    const response = await h.app.inject({
      method: 'POST',
      url: `${BASE}/${created.circuit.id}/versions`,
      headers: h.owner,
      body: { circuit: ghz(), message: 'into the void' },
    })

    expect(response.statusCode).toBe(404)
    expect(response.json<ErrorBody>().error.code).toBe('NOT_FOUND')
    // And nothing was written: an orphan version belongs to a circuit that
    // no longer exists and nothing can ever reach it.
    expect(h.repository.allVersions(created.circuit.id)).toHaveLength(0)
    await h.app.close()
  })

  it('caps how many problems a 400 will enumerate', async () => {
    /*
     * A 400 must not cost more to send than the request cost to receive.
     * Uncapped, a body of 1,040,057 bytes — under the 1 MiB limit — produced
     * 650,000 `details` entries and a 42.6 MiB response, about 2.8 seconds of
     * blocked event loop, 300 times a minute per caller.
     */
    const h = await harness()
    const created = await createCircuit(h)
    const operations = Array.from({ length: 4000 }, () => ({ n: 1 }))

    const response = await h.app.inject({
      method: 'POST',
      url: `${BASE}/${created.circuit.id}/versions`,
      headers: h.owner,
      body: { circuit: { schemaVersion: 1, qubits: 1, operations } },
    })

    expect(response.statusCode).toBe(400)
    const details = response.json<ErrorBody>().error.details as {
      code: string
    }[]
    expect(details.length).toBeLessThanOrEqual(MAX_ERROR_DETAILS + 1)
    // …and says so, rather than implying there were exactly twenty.
    expect(details.at(-1)?.code).toBe('too_many_issues')
    expect(response.body.length).toBeLessThan(4000)
    await h.app.close()
  })

  it('refuses a NUL in any string PostgreSQL will be asked to store', async () => {
    /*
     * `Circuit.title` is `text` and `CircuitVersion.data` is `jsonb`; both
     * refuse U+0000, and the refusal arrived as a Prisma P2010 that nothing
     * mapped — so one character anybody can type was a 500. Verified against
     * the real database before the fix; the in-memory repository has no
     * encoding rules, which is why all 57 route tests passed through it.
     */
    const NUL = String.fromCharCode(0)
    const h = await harness()

    const bodies = [
      { title: `probe${NUL}nul`, circuit: bell() },
      { title: 'ok', description: `d${NUL}d`, circuit: bell() },
      { title: 'ok', message: `m${NUL}m`, circuit: bell() },
      {
        title: 'ok',
        circuit: {
          ...bell(),
          operations: [{ id: `a${NUL}b`, gate: 'h', targets: [0], column: 0 }],
        },
      },
      {
        title: 'ok',
        circuit: { ...bell(), qubitLabels: [`q${NUL}0`, 'q1'] },
      },
    ]

    for (const [index, body] of bodies.entries()) {
      const response = await h.app.inject({
        method: 'POST',
        url: BASE,
        headers: h.owner,
        body,
      })
      expect(response.statusCode, `body ${String(index)}`).toBe(400)
      expect(response.json<ErrorBody>().error.code).toBe('VALIDATION_FAILED')
    }

    expect(h.repository.allCircuits()).toHaveLength(0)
    await h.app.close()
  })
})

describe('version numbering under concurrent saves', () => {
  it('never lets two saves claim the same number', async () => {
    /*
     * The failure this guards is not hypothetical: allocating a version
     * number is read-then-write, and two saves that both read a maximum of 1
     * will both try to write 2. The unique index is what makes the second
     * write impossible; the retry is what turns "impossible" into an answer
     * the client can use.
     *
     * `beforeVersionWrite` is the window between the read and the write. The
     * hook below fires a second, complete save from inside it — through the
     * whole HTTP stack, not around it — so the outer save resumes holding a
     * version number that has just been taken.
     */
    let raced = false
    let inner: number | null = null

    const h: Harness = await harness({
      beforeVersionWrite: async (circuitId) => {
        if (raced) return
        raced = true
        const response = await h.app.inject({
          method: 'POST',
          url: `${BASE}/${circuitId}/versions`,
          headers: h.owner,
          body: { circuit: ghz(), message: 'the other tab' },
        })
        inner = response.json<{ version: VersionBody }>().version.versionNum
      },
    })

    const created = await createCircuit(h)
    const outer = await h.app.inject({
      method: 'POST',
      url: `${BASE}/${created.circuit.id}/versions`,
      headers: h.owner,
      body: { circuit: bell(), message: 'this tab' },
    })

    expect(raced).toBe(true)
    expect(inner).toBe(2)
    expect(outer.statusCode).toBe(201)
    // The loser of the race retried and took the next number, rather than
    // failing or — far worse — overwriting version 2.
    expect(outer.json<{ version: VersionBody }>().version.versionNum).toBe(3)

    const numbers = h.repository
      .allVersions(created.circuit.id)
      .map((row) => row.versionNum)
      .sort((a, b) => a - b)
    expect(numbers).toEqual([1, 2, 3])
    expect(new Set(numbers).size).toBe(numbers.length)
    await h.app.close()
  })

  it('answers 409 rather than 500 when the contention outlasts the retries', async () => {
    /*
     * The deliberate behaviour when the backstop keeps firing. A constraint
     * violation surfacing as a 500 tells the client nothing and invites a
     * retry storm; a 409 with a code says "reload the history and save
     * again", which is exactly what a second tab should do.
     */
    const h: Harness = await harness({
      // Somebody else takes the number this save was about to use, every
      // single time, for more attempts than the repository is willing to make.
      beforeVersionWrite: (circuitId) => {
        h.repository.stealNextVersion(circuitId)
      },
    })

    const created = await createCircuit(h)
    const response = await h.app.inject({
      method: 'POST',
      url: `${BASE}/${created.circuit.id}/versions`,
      headers: h.owner,
      body: { circuit: ghz() },
    })

    expect(response.statusCode).toBe(409)
    expect(response.json<ErrorBody>().error.code).toBe('VERSION_CONFLICT')
    await h.app.close()
  })
})

describe('GET /circuits/:id/versions/:n', () => {
  it('returns exactly the payload that was saved', async () => {
    const h = await harness()
    const created = await createCircuit(h)
    await h.app.inject({
      method: 'POST',
      url: `${BASE}/${created.circuit.id}/versions`,
      headers: h.owner,
      body: { circuit: ghz(), message: 'grew a qubit' },
    })

    const response = await h.app.inject({
      method: 'GET',
      url: `${BASE}/${created.circuit.id}/versions/2`,
      headers: h.owner,
    })

    expect(response.statusCode).toBe(200)
    const body = response.json<{ version: VersionBody }>()
    expect(body.version.circuit).toEqual(ghz())
    expect(body.version.message).toBe('grew a qubit')
    await h.app.close()
  })

  it('answers 404 for a version that was never written', async () => {
    const h = await harness()
    const created = await createCircuit(h)

    const response = await h.app.inject({
      method: 'GET',
      url: `${BASE}/${created.circuit.id}/versions/7`,
      headers: h.owner,
    })

    expect(response.statusCode).toBe(404)
    await h.app.close()
  })

  it('hides a PRIVATE circuit’s version from a stranger', async () => {
    const h = await harness()
    const created = await createCircuit(h, { visibility: 'PRIVATE' })

    const stranger = await h.app.inject({
      method: 'GET',
      url: `${BASE}/${created.circuit.id}/versions/1`,
      headers: h.stranger,
    })
    const anonymous = await h.app.inject({
      method: 'GET',
      url: `${BASE}/${created.circuit.id}/versions/1`,
    })

    expect(stranger.statusCode).toBe(404)
    expect(anonymous.statusCode).toBe(404)
    await h.app.close()
  })

  it('serves a PUBLIC circuit’s version to anyone', async () => {
    const h = await harness()
    const created = await createCircuit(h, { visibility: 'PUBLIC' })

    const response = await h.app.inject({
      method: 'GET',
      url: `${BASE}/${created.circuit.id}/versions/1`,
    })

    expect(response.statusCode).toBe(200)
    await h.app.close()
  })

  it('rejects a version number that is not one', async () => {
    const h = await harness()
    const created = await createCircuit(h)

    const zero = await h.app.inject({
      method: 'GET',
      url: `${BASE}/${created.circuit.id}/versions/0`,
      headers: h.owner,
    })
    const word = await h.app.inject({
      method: 'GET',
      url: `${BASE}/${created.circuit.id}/versions/latest`,
      headers: h.owner,
    })

    expect(zero.statusCode).toBe(400)
    expect(word.statusCode).toBe(400)
    await h.app.close()
  })
})

describe('the identity a write is attributed to', () => {
  let h: Harness

  beforeEach(async () => {
    h = await harness()
  })

  it('creates the public.User row on the first write and reuses it after', async () => {
    const first = await createCircuit(h, { title: 'One' })
    const second = await createCircuit(h, { title: 'Two' })

    expect(first.circuit.owner.id).toBe(OWNER_ID)
    expect(first.circuit.owner.username).toBe(second.circuit.owner.username)
    await h.app.close()
  })

  it('never trusts an owner id that arrived in the body', async () => {
    const response = await h.app.inject({
      method: 'POST',
      url: BASE,
      headers: h.owner,
      body: { title: 'Forged', circuit: bell(), ownerId: STRANGER_ID },
    })

    expect(response.statusCode).toBe(201)
    expect(response.json<CircuitWithVersionBody>().circuit.owner.id).toBe(
      OWNER_ID
    )
    await h.app.close()
  })
})
