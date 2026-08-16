/**
 * Collections — §3.4 and §11, milestone M1.9.
 *
 * ── What this file is for ─────────────────────────────────────────────────
 *
 * A collection is a *listing*, and a listing is where this project leaks. The
 * specific hazard here is new: a collection has a visibility of its own, so
 * there are two visibility questions per request — may this viewer open the
 * collection, and may they see each circuit inside it — and the implementation
 * that answers only the first is the one that looks obviously right. Written
 * that way, a PUBLIC collection is a door around every PRIVATE circuit its
 * owner puts in it, and around every UNLISTED circuit of anybody else's.
 *
 * So, exactly as in `gallery.test.ts`, every assertion below is made from a
 * STRANGER's or an anonymous point of view. That the owner sees their own
 * collection whole proves nothing.
 */

import { CIRCUIT_SCHEMA_VERSION } from '@qsim/schema'
import type { Circuit } from '@qsim/schema'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { ApiInstance } from '../app.js'
import { createTestApp } from '../testing/app.js'
import { createMemoryCircuitRepository } from '../testing/circuit-repository.js'
import type { MemoryCircuitRepository } from '../testing/circuit-repository.js'
import {
  createSigningKey,
  createTestJwksCache,
  signToken,
  stubJwksEndpoint,
} from '../testing/tokens.js'

const OWNER_ID = '11111111-1111-4111-8111-111111111111'
const STRANGER_ID = '22222222-2222-4222-8222-222222222222'
const COLLECTIONS = '/api/v1/collections'

interface CollectionBody {
  id: string
  title: string
  description: string | null
  visibility: string
  itemCount: number
  owner: { id: string; username: string; avatarUrl: string | null }
}

interface ViewBody {
  collection: CollectionBody
  items: { id: string; slug: string; title: string; visibility: string }[]
  withheldItemCount: number
}

interface EnvelopeBody {
  collection: CollectionBody
}

interface PageBody {
  items: CollectionBody[]
  page: number
  perPage: number
  total: number
  totalPages: number
}

interface ErrorBody {
  error: { code: string; details?: { path: string; code: string }[] }
}

function bell(): Circuit {
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
  stranger: Record<string, string>
}

let harness: Harness

beforeEach(async () => {
  const key = await createSigningKey('key-1')
  const repository = createMemoryCircuitRepository()
  const app = await createTestApp({
    jwks: createTestJwksCache(stubJwksEndpoint([key])),
    circuits: { repository },
  })
  await app.ready()

  repository.addUser({ id: OWNER_ID, username: 'ada', displayName: 'Ada' })
  repository.addUser({ id: STRANGER_ID, username: 'grace' })

  harness = {
    app,
    repository,
    owner: {
      authorization: `Bearer ${await signToken(key, {
        subject: OWNER_ID,
        email: 'ada@example.com',
      })}`,
    },
    stranger: {
      authorization: `Bearer ${await signToken(key, {
        subject: STRANGER_ID,
        email: 'grace@example.com',
      })}`,
    },
  }
})

afterEach(async () => {
  await harness.app.close()
})

type Visibility = 'PRIVATE' | 'UNLISTED' | 'PUBLIC'

/**
 * Writes a circuit straight through the repository.
 *
 * Not through `POST /circuits`, for the reason `gallery.test.ts` gives: this
 * file is about what a reader is shown, and going through the write route
 * would make every fixture depend on the write route's rules too.
 */
async function seedCircuit(
  options: {
    title?: string
    visibility?: Visibility
    ownerId?: string
  } = {}
): Promise<{ id: string; slug: string }> {
  const created = await harness.repository.create({
    ownerId: options.ownerId ?? OWNER_ID,
    title: options.title ?? 'A circuit',
    description: null,
    visibility: options.visibility ?? 'PUBLIC',
    data: bell(),
    message: null,
    forkedFromId: null,
  })
  return { id: created.circuit.id, slug: created.circuit.slug }
}

async function seedCollection(
  options: { visibility?: Visibility; ownerId?: string; title?: string } = {}
): Promise<string> {
  const created = await harness.repository.createCollection({
    ownerId: options.ownerId ?? OWNER_ID,
    title: options.title ?? 'Oracle algorithms',
    description: null,
    visibility: options.visibility ?? 'PUBLIC',
  })
  return created.id
}

async function addItem(collectionId: string, circuitId: string): Promise<void> {
  await harness.repository.addCollectionItem({
    collectionId,
    ownerId:
      harness.repository.allCollections().find((row) => row.id === collectionId)
        ?.ownerId ?? OWNER_ID,
    circuitId,
  })
}

/**
 * One shape for every request in this file.
 *
 * `headers` and `payload` are always passed rather than conditionally spread:
 * a spread of optional properties widens into a union Fastify's overloads
 * reject, and an empty header bag and an absent payload mean exactly what
 * omitting them would.
 */
async function inject(
  method: 'GET' | 'POST' | 'PATCH' | 'DELETE',
  url: string,
  options: { headers?: Record<string, string>; body?: object } = {}
) {
  return harness.app.inject({
    method,
    url,
    headers: options.headers ?? {},
    payload: options.body,
  })
}

describe('GET /collections/:id — the two visibility questions', () => {
  it('withholds a private circuit from a public collection', async () => {
    const collection = await seedCollection({ visibility: 'PUBLIC' })
    const open = await seedCircuit({ title: 'Grover', visibility: 'PUBLIC' })
    const secret = await seedCircuit({
      title: 'Confidential',
      visibility: 'PRIVATE',
    })
    await addItem(collection, open.id)
    await addItem(collection, secret.id)

    const response = await inject('GET', `${COLLECTIONS}/${collection}`)
    expect(response.statusCode).toBe(200)

    const body = response.json<ViewBody>()
    expect(body.items.map((item) => item.title)).toEqual(['Grover'])
    // The whole point: the collection says something is missing, and says
    // nothing about what.
    expect(body.withheldItemCount).toBe(1)
    expect(body.collection.itemCount).toBe(2)

    // Not the title, not the slug, not the id — nowhere in the payload.
    expect(response.payload).not.toContain('Confidential')
    expect(response.payload).not.toContain(secret.id)
    expect(response.payload).not.toContain(secret.slug)
  })

  it('withholds an unlisted circuit too, because a listing is discovery', async () => {
    const collection = await seedCollection({ visibility: 'PUBLIC' })
    const unlisted = await seedCircuit({
      title: 'Shared by link',
      visibility: 'UNLISTED',
    })
    await addItem(collection, unlisted.id)

    const response = await inject('GET', `${COLLECTIONS}/${collection}`)
    const body = response.json<ViewBody>()

    expect(body.items).toEqual([])
    expect(body.withheldItemCount).toBe(1)
    expect(response.payload).not.toContain(unlisted.slug)
  })

  it('withholds somebody else’s private circuit from its collector', async () => {
    /*
     * The case a naive implementation gets wrong in the other direction: the
     * *collection* belongs to the stranger and they may open it, but one of
     * the circuits in it stopped being theirs to see. Curating something does
     * not confer a view of it.
     */
    const collection = await seedCollection({
      ownerId: STRANGER_ID,
      visibility: 'PRIVATE',
    })
    const theirs = await seedCircuit({
      ownerId: OWNER_ID,
      visibility: 'PRIVATE',
      title: 'Confidential',
    })
    await harness.repository.addCollectionItem({
      collectionId: collection,
      ownerId: STRANGER_ID,
      circuitId: theirs.id,
    })

    const response = await inject('GET', `${COLLECTIONS}/${collection}`, {
      headers: harness.stranger,
    })
    expect(response.statusCode).toBe(200)
    expect(response.json<ViewBody>().items).toEqual([])
    expect(response.json<ViewBody>().withheldItemCount).toBe(1)
  })

  it('shows the owner their own collection whole', async () => {
    const collection = await seedCollection({ visibility: 'PUBLIC' })
    const secret = await seedCircuit({ visibility: 'PRIVATE' })
    await addItem(collection, secret.id)

    const response = await inject('GET', `${COLLECTIONS}/${collection}`, {
      headers: harness.owner,
    })
    const body = response.json<ViewBody>()
    expect(body.items).toHaveLength(1)
    expect(body.withheldItemCount).toBe(0)
  })

  it('keeps the curator’s order rather than the database’s', async () => {
    const collection = await seedCollection()
    const first = await seedCircuit({ title: 'One' })
    const second = await seedCircuit({ title: 'Two' })
    const third = await seedCircuit({ title: 'Three' })
    await addItem(collection, first.id)
    await addItem(collection, second.id)
    await addItem(collection, third.id)

    const body = (
      await inject('GET', `${COLLECTIONS}/${collection}`)
    ).json<ViewBody>()
    expect(body.items.map((item) => item.title)).toEqual([
      'One',
      'Two',
      'Three',
    ])
  })
})

describe('GET /collections/:id — who may open it at all', () => {
  it('answers 404 for a private collection to a stranger', async () => {
    const collection = await seedCollection({ visibility: 'PRIVATE' })

    for (const headers of [undefined, harness.stranger]) {
      const response = await inject('GET', `${COLLECTIONS}/${collection}`, {
        ...(headers === undefined ? {} : { headers }),
      })
      // 404 and never 403: a 403 would confirm the collection exists.
      expect(response.statusCode).toBe(404)
      expect(response.json<ErrorBody>().error.code).toBe('NOT_FOUND')
    }
  })

  it('opens an unlisted collection to whoever holds its id', async () => {
    // The decision argued in `visibility.ts`: a collection has no slug, so its
    // id is the only handle it has, and UNLISTED would mean nothing otherwise.
    const collection = await seedCollection({ visibility: 'UNLISTED' })
    const response = await inject('GET', `${COLLECTIONS}/${collection}`)
    expect(response.statusCode).toBe(200)
  })

  it('never lists an unlisted collection on its author’s profile', async () => {
    await seedCollection({ visibility: 'UNLISTED', title: 'By link only' })
    await seedCollection({ visibility: 'PUBLIC', title: 'Open' })

    const response = await inject('GET', '/api/v1/users/ada/collections')
    const body = response.json<PageBody>()
    expect(body.items.map((row) => row.title)).toEqual(['Open'])
  })
})

describe('GET /users/:username/collections — a stranger’s view', () => {
  beforeEach(async () => {
    await seedCollection({ visibility: 'PRIVATE', title: 'Drafts' })
    await seedCollection({ visibility: 'PUBLIC', title: 'Published' })
  })

  it('shows only the public ones, anonymously and to a stranger', async () => {
    for (const headers of [undefined, harness.stranger]) {
      const response = await inject('GET', '/api/v1/users/ada/collections', {
        ...(headers === undefined ? {} : { headers }),
      })
      expect(response.statusCode).toBe(200)
      const body = response.json<PageBody>()
      expect(body.items.map((row) => row.title)).toEqual(['Published'])
      // The total is a count, and a count is a listing.
      expect(body.total).toBe(1)
      expect(response.payload).not.toContain('Drafts')
    }
  })

  it('shows the author all of their own on their own profile', async () => {
    const response = await inject('GET', '/api/v1/users/ada/collections', {
      headers: harness.owner,
    })
    expect(response.json<PageBody>().total).toBe(2)
  })

  it('answers 404 for a username nobody holds', async () => {
    const response = await inject('GET', '/api/v1/users/nobody/collections')
    expect(response.statusCode).toBe(404)
  })
})

describe('GET /collections — the caller’s own index', () => {
  it('refuses an anonymous caller', async () => {
    const response = await inject('GET', COLLECTIONS)
    expect(response.statusCode).toBe(401)
  })

  it('shows only the caller’s own, whatever their visibility', async () => {
    await seedCollection({ visibility: 'PRIVATE', title: 'Mine' })
    await seedCollection({
      ownerId: STRANGER_ID,
      visibility: 'PUBLIC',
      title: 'Theirs',
    })

    const response = await inject('GET', COLLECTIONS, {
      headers: harness.owner,
    })
    const body = response.json<PageBody>()
    expect(body.items.map((row) => row.title)).toEqual(['Mine'])
    expect(response.payload).not.toContain('Theirs')
  })
})

describe('writing a collection', () => {
  it('creates one, private by default', async () => {
    const response = await inject('POST', COLLECTIONS, {
      headers: harness.owner,
      body: { title: 'Oracle algorithms' },
    })
    expect(response.statusCode).toBe(201)
    expect(response.json<EnvelopeBody>().collection.visibility).toBe('PRIVATE')
  })

  it('refuses a rename by anybody but the owner', async () => {
    const collection = await seedCollection({ visibility: 'PUBLIC' })
    const response = await inject('PATCH', `${COLLECTIONS}/${collection}`, {
      headers: harness.stranger,
      body: { title: 'Mine now' },
    })
    // 403 rather than 404 here: the stranger has already proved they can see
    // it, so admitting it exists costs nothing.
    expect(response.statusCode).toBe(403)
  })

  it('answers 404 rather than 403 when the collection was never visible', async () => {
    const collection = await seedCollection({ visibility: 'PRIVATE' })
    const response = await inject('PATCH', `${COLLECTIONS}/${collection}`, {
      headers: harness.stranger,
      body: { title: 'Mine now' },
    })
    expect(response.statusCode).toBe(404)
  })

  it('deletes the collection and none of the circuits in it', async () => {
    const collection = await seedCollection()
    const circuit = await seedCircuit()
    await addItem(collection, circuit.id)

    const response = await inject('DELETE', `${COLLECTIONS}/${collection}`, {
      headers: harness.owner,
    })
    expect(response.statusCode).toBe(204)
    expect(harness.repository.allCollections()).toEqual([])
    // Cascade takes the memberships; the circuit is a reference and survives.
    expect(harness.repository.allCollectionItems()).toEqual([])
    expect(harness.repository.allCircuits()).toHaveLength(1)
  })
})

describe('adding a circuit to a collection', () => {
  it('refuses a circuit the caller cannot read', async () => {
    const collection = await seedCollection({ ownerId: STRANGER_ID })
    const secret = await seedCircuit({
      ownerId: OWNER_ID,
      visibility: 'PRIVATE',
    })

    const response = await inject(
      'POST',
      `${COLLECTIONS}/${collection}/items`,
      { headers: harness.stranger, body: { circuit: secret.id } }
    )
    // The same answer GET gives for that circuit: you cannot collect what you
    // cannot see.
    expect(response.statusCode).toBe(404)
    expect(harness.repository.allCollectionItems(collection)).toEqual([])
  })

  it('accepts somebody else’s public circuit, by slug', async () => {
    const collection = await seedCollection({ ownerId: STRANGER_ID })
    const theirs = await seedCircuit({
      ownerId: OWNER_ID,
      visibility: 'PUBLIC',
    })

    const response = await inject(
      'POST',
      `${COLLECTIONS}/${collection}/items`,
      { headers: harness.stranger, body: { circuit: theirs.slug } }
    )
    expect(response.statusCode).toBe(200)
    expect(response.json<EnvelopeBody>().collection.itemCount).toBe(1)
  })

  it('is idempotent', async () => {
    const collection = await seedCollection()
    const circuit = await seedCircuit()
    const body = { circuit: circuit.id }

    await inject('POST', `${COLLECTIONS}/${collection}/items`, {
      headers: harness.owner,
      body,
    })
    const second = await inject('POST', `${COLLECTIONS}/${collection}/items`, {
      headers: harness.owner,
      body,
    })
    expect(second.statusCode).toBe(200)
    expect(second.json<EnvelopeBody>().collection.itemCount).toBe(1)
  })

  it('refuses to add to somebody else’s collection', async () => {
    const collection = await seedCollection({
      ownerId: STRANGER_ID,
      visibility: 'PUBLIC',
    })
    const circuit = await seedCircuit()

    const response = await inject(
      'POST',
      `${COLLECTIONS}/${collection}/items`,
      { headers: harness.owner, body: { circuit: circuit.id } }
    )
    expect(response.statusCode).toBe(403)
  })

  it('lets a curator remove an item that stopped being readable', async () => {
    /*
     * The owner of a collected circuit made it private afterwards. Requiring
     * the circuit to be readable on the way *out* would leave the curator
     * unable to tidy their own list because of somebody else's setting.
     */
    const collection = await seedCollection({ ownerId: STRANGER_ID })
    const circuit = await seedCircuit({
      ownerId: OWNER_ID,
      visibility: 'PUBLIC',
    })
    await harness.repository.addCollectionItem({
      collectionId: collection,
      ownerId: STRANGER_ID,
      circuitId: circuit.id,
    })
    await harness.repository.update({
      id: circuit.id,
      ownerId: OWNER_ID,
      visibility: 'PRIVATE',
    })

    const response = await inject(
      'DELETE',
      `${COLLECTIONS}/${collection}/items/${circuit.id}`,
      { headers: harness.stranger }
    )
    expect(response.statusCode).toBe(200)
    expect(response.json<EnvelopeBody>().collection.itemCount).toBe(0)
  })
})

describe('deleting a circuit that is in somebody else’s collection', () => {
  it('leaves no membership row behind', async () => {
    /*
     * `CollectionItem.circuitId` carries no foreign key (§7), so nothing in
     * Postgres removes this row — the application does. Left behind it would
     * be counted as withheld forever: a permanent "there is something here you
     * cannot see" about a circuit that no longer exists.
     */
    const collection = await seedCollection({ ownerId: STRANGER_ID })
    const circuit = await seedCircuit({
      ownerId: OWNER_ID,
      visibility: 'PUBLIC',
    })
    await harness.repository.addCollectionItem({
      collectionId: collection,
      ownerId: STRANGER_ID,
      circuitId: circuit.id,
    })

    const response = await inject('DELETE', `/api/v1/circuits/${circuit.id}`, {
      headers: harness.owner,
    })
    expect(response.statusCode).toBe(204)
    expect(harness.repository.allCollectionItems(collection)).toEqual([])

    const view = await inject('GET', `${COLLECTIONS}/${collection}`, {
      headers: harness.stranger,
    })
    expect(view.json<ViewBody>().withheldItemCount).toBe(0)
  })
})

describe('GET /circuits/:id/collections — which of mine hold it', () => {
  it('never reports somebody else’s collection', async () => {
    const circuit = await seedCircuit({ visibility: 'PUBLIC' })
    const theirs = await seedCollection({ ownerId: STRANGER_ID })
    await harness.repository.addCollectionItem({
      collectionId: theirs,
      ownerId: STRANGER_ID,
      circuitId: circuit.id,
    })
    const mine = await seedCollection({ ownerId: OWNER_ID })
    await addItem(mine, circuit.id)

    const response = await inject(
      'GET',
      `/api/v1/circuits/${circuit.id}/collections`,
      { headers: harness.owner }
    )
    expect(response.json<{ collectionIds: string[] }>().collectionIds).toEqual([
      mine,
    ])
  })
})
