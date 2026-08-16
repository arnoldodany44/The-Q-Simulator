import { API_PREFIX } from '@qsim/contract'
import { describe, expect, it } from 'vitest'

import {
  deleteAccount,
  getAccount,
  getProfile,
  listUserCollections,
  updateProfile,
} from './account.js'
import {
  addCollectionItem,
  createCollection,
  deleteCollection,
  getCollection,
  listCollections,
  listCollectionsHolding,
  removeCollectionItem,
  updateCollection,
} from './collections.js'
import { createApiClient } from './client.js'
import {
  TEST_BASE_URL,
  circuitDetailPayload,
  jsonResponse,
  stubFetch,
} from './testing.js'

/**
 * The account and collection routes of M1.9 — one test per route, asserting
 * the two things a typed call can get wrong: the verb-and-path it produces,
 * and that what comes back is parsed rather than passed through.
 *
 * Two of them assert something more specific, because they are the two places
 * where a client could quietly widen what the API accepts:
 *
 *   - `updateProfile` must be unable to send an avatar URL. The contract has
 *     no field for one and `.parse()` strips it, which is what stops a
 *     third-party image URL from ever reaching a column and being rendered by
 *     every stranger who opens that profile.
 *   - `deleteAccount` must send the confirmation in the body, because the
 *     server compares it against the row it is about to destroy.
 */

function harness(responses: readonly unknown[]) {
  const transport = stubFetch(responses)
  const client = createApiClient({
    baseUrl: TEST_BASE_URL,
    fetch: transport.fetch,
    getAccessToken: () => 'token',
  })
  return { client, transport }
}

const url = (path: string) => `${TEST_BASE_URL}${API_PREFIX}${path}`

const CREATED_AT = '2024-05-01T10:00:00.000Z'

const userPayload = {
  id: 'usr_1',
  username: 'ada',
  displayName: 'Ada',
  avatarUrl: null,
  createdAt: CREATED_AT,
}

const collectionPayload = {
  id: 'col_1',
  title: 'Oracle algorithms',
  description: null,
  visibility: 'PUBLIC',
  itemCount: 1,
  createdAt: CREATED_AT,
  updatedAt: CREATED_AT,
  owner: { id: 'usr_1', username: 'ada', avatarUrl: null },
}

const collectionPage = {
  items: [collectionPayload],
  page: 1,
  perPage: 20,
  total: 1,
  totalPages: 1,
}

describe('the account routes', () => {
  it('GET /me', async () => {
    const { client, transport } = harness([jsonResponse({ user: userPayload })])

    const result = await getAccount(client)

    expect(transport.last().init?.method).toBe('GET')
    expect(transport.last().url).toBe(url('/me'))
    expect(result.user.createdAt).toBeInstanceOf(Date)
  })

  it('PATCH /me, and cannot carry an avatar URL', async () => {
    const { client, transport } = harness([jsonResponse({ user: userPayload })])

    await updateProfile(client, {
      displayName: 'Ada Lovelace',
      avatar: 'provider',
      // Not a field of `UpdateProfileBody`. If this ever survives the parse,
      // a caller can name any URL every reader of that profile will fetch.
      ...({ avatarUrl: 'https://evil.example/track.png' } as object),
    })

    expect(transport.last().init?.method).toBe('PATCH')
    expect(transport.last().url).toBe(url('/me'))
    expect(transport.lastBody()).toEqual({
      displayName: 'Ada Lovelace',
      avatar: 'provider',
    })
  })

  it('DELETE /me, with the confirmation in the body', async () => {
    const { client, transport } = harness([
      jsonResponse({
        deleted: {
          circuits: 2,
          collections: 1,
          comments: 0,
          stars: 3,
          simulationRuns: 0,
          hardwareJobs: 0,
          orphanedCollectionItems: 1,
        },
      }),
    ])

    const result = await deleteAccount(client, 'ada')

    expect(transport.last().init?.method).toBe('DELETE')
    expect(transport.last().url).toBe(url('/me'))
    expect(transport.lastBody()).toEqual({ confirm: 'ada' })
    expect(result.deleted.orphanedCollectionItems).toBe(1)
  })

  it('GET /users/:username', async () => {
    const { client, transport } = harness([
      jsonResponse({ user: userPayload, circuitCount: 4, collectionCount: 1 }),
    ])

    const result = await getProfile(client, 'ada')

    expect(transport.last().url).toBe(url('/users/ada'))
    expect(result.circuitCount).toBe(4)
  })

  it('GET /users/:username/collections', async () => {
    const { client, transport } = harness([jsonResponse(collectionPage)])

    const result = await listUserCollections(client, 'ada', { page: 2 })

    expect(transport.last().url).toBe(url('/users/ada/collections?page=2'))
    expect(result.items[0]?.updatedAt).toBeInstanceOf(Date)
  })
})

describe('the collection routes', () => {
  it('GET /collections', async () => {
    const { client, transport } = harness([jsonResponse(collectionPage)])

    await listCollections(client)

    expect(transport.last().url).toBe(url('/collections'))
  })

  it('GET /collections/:id, with the items already filtered by the server', async () => {
    const { client, transport } = harness([
      jsonResponse({
        collection: collectionPayload,
        items: [circuitDetailPayload],
        withheldItemCount: 2,
        starred: [],
      }),
    ])

    const result = await getCollection(client, 'col_1')

    expect(transport.last().url).toBe(url('/collections/col_1'))
    /*
     * The number that matters. It is the server's, and it is deliberately not
     * `itemCount - items.length` computed here — reconstructing it would mean
     * reimplementing §11 in a browser.
     */
    expect(result.withheldItemCount).toBe(2)
  })

  it('POST /collections', async () => {
    const { client, transport } = harness([
      jsonResponse({ collection: collectionPayload }, 201),
    ])

    await createCollection(client, { title: 'Oracle algorithms' })

    expect(transport.last().init?.method).toBe('POST')
    expect(transport.lastBody()).toEqual({
      title: 'Oracle algorithms',
      // The server's default, applied by the shared schema so the client and
      // the API cannot disagree about what an unspecified visibility means.
      visibility: 'PRIVATE',
    })
  })

  it('PATCH /collections/:id', async () => {
    const { client, transport } = harness([
      jsonResponse({ collection: collectionPayload }),
    ])

    await updateCollection(client, 'col_1', { visibility: 'PUBLIC' })

    expect(transport.last().init?.method).toBe('PATCH')
    expect(transport.last().url).toBe(url('/collections/col_1'))
  })

  it('DELETE /collections/:id parses no body', async () => {
    const { client, transport } = harness([new Response(null, { status: 204 })])

    await expect(deleteCollection(client, 'col_1')).resolves.toBeUndefined()
    expect(transport.last().init?.method).toBe('DELETE')
  })

  it('POST /collections/:id/items, addressed by handle', async () => {
    const { client, transport } = harness([
      jsonResponse({ collection: collectionPayload }),
    ])

    await addCollectionItem(client, 'col_1', { circuit: 'V1StGXR8Z5jdHi6Bm' })

    expect(transport.last().url).toBe(url('/collections/col_1/items'))
    expect(transport.lastBody()).toEqual({ circuit: 'V1StGXR8Z5jdHi6Bm' })
  })

  it('DELETE /collections/:id/items/:circuitId', async () => {
    const { client, transport } = harness([
      jsonResponse({ collection: collectionPayload }),
    ])

    await removeCollectionItem(client, 'col_1', 'cir_1')

    expect(transport.last().url).toBe(url('/collections/col_1/items/cir_1'))
  })

  it('GET /circuits/:id/collections', async () => {
    const { client, transport } = harness([
      jsonResponse({ collectionIds: ['col_1'] }),
    ])

    const result = await listCollectionsHolding(client, 'cir_1')

    expect(transport.last().url).toBe(url('/circuits/cir_1/collections'))
    expect(result.collectionIds).toEqual(['col_1'])
  })
})
