/**
 * Profiles, settings and account deletion — §3.4, §8, §11, milestone M1.9.
 *
 * Three things are under test here and only one of them is a listing, which is
 * the trap:
 *
 *   1. **A profile page.** Its two counts are aggregates over the same rows a
 *      listing returns, so they are listings wearing a smaller shape. Every
 *      assertion about them is made from a stranger's point of view.
 *   2. **The email address.** `publicUserSelect` is the only projection of a
 *      user in the system and has no `email` in it. The fixture gives every
 *      user one so that "it never comes back" can be asserted rather than
 *      assumed — including from `GET /me`, where returning your own would be
 *      harmless and would still create a second projection somebody could
 *      later reach for by mistake.
 *   3. **Deletion.** It has to actually destroy things, and it has to leave no
 *      orphan in a row nobody has a foreign key to.
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
const ME = '/api/v1/me'

interface UserBody {
  id: string
  username: string
  displayName: string | null
  avatarUrl: string | null
  createdAt: string
}

interface ProfileBody {
  user: UserBody
  circuitCount: number
  collectionCount: number
}

interface AccountBody {
  user: UserBody
}

interface DeletionBody {
  deleted: {
    circuits: number
    collections: number
    stars: number
    orphanedCollectionItems: number
  }
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
  /** A token carrying an `avatar_url` claim, for the avatar source test. */
  ownerWithPicture: Record<string, string>
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
        // Deliberately no `avatar_url`: the default fixture carries one, and
        // the avatar tests below are about which *source* a value came from.
        userMetadata: { full_name: 'Ada Lovelace' },
      })}`,
    },
    stranger: {
      authorization: `Bearer ${await signToken(key, {
        subject: STRANGER_ID,
        email: 'grace@example.com',
        userMetadata: {},
      })}`,
    },
    ownerWithPicture: {
      authorization: `Bearer ${await signToken(key, {
        subject: OWNER_ID,
        email: 'ada@example.com',
        userMetadata: { avatar_url: 'https://example.com/ada.png' },
      })}`,
    },
  }
})

afterEach(async () => {
  await harness.app.close()
})

type Visibility = 'PRIVATE' | 'UNLISTED' | 'PUBLIC'

async function seedCircuit(
  options: { visibility?: Visibility; ownerId?: string; title?: string } = {}
): Promise<string> {
  const created = await harness.repository.create({
    ownerId: options.ownerId ?? OWNER_ID,
    title: options.title ?? 'A circuit',
    description: null,
    visibility: options.visibility ?? 'PUBLIC',
    data: bell(),
    message: null,
    forkedFromId: null,
  })
  return created.circuit.id
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

describe('GET /users/:username — a public profile', () => {
  beforeEach(async () => {
    await seedCircuit({ visibility: 'PUBLIC' })
    await seedCircuit({ visibility: 'UNLISTED' })
    await seedCircuit({ visibility: 'PRIVATE' })
    await harness.repository.createCollection({
      ownerId: OWNER_ID,
      title: 'Drafts',
      description: null,
      visibility: 'PRIVATE',
    })
    await harness.repository.createCollection({
      ownerId: OWNER_ID,
      title: 'Published',
      description: null,
      visibility: 'PUBLIC',
    })
  })

  it('counts only what the viewer could reach by paging the listings', async () => {
    for (const headers of [undefined, harness.stranger]) {
      const response = await inject('GET', '/api/v1/users/ada', {
        ...(headers === undefined ? {} : { headers }),
      })
      expect(response.statusCode).toBe(200)

      const body = response.json<ProfileBody>()
      // One PUBLIC circuit. The unlisted one is not discoverable and the
      // private one is not theirs — an aggregate is a listing.
      expect(body.circuitCount).toBe(1)
      expect(body.collectionCount).toBe(1)
    }
  })

  it('counts everything for the author reading their own profile', async () => {
    const body = (
      await inject('GET', '/api/v1/users/ada', { headers: harness.owner })
    ).json<ProfileBody>()
    expect(body.circuitCount).toBe(3)
    expect(body.collectionCount).toBe(2)
  })

  it('never carries the email address', async () => {
    const response = await inject('GET', '/api/v1/users/ada')
    expect(response.payload).not.toContain('@example.invalid')
    expect(response.payload).not.toContain('email')
    expect(Object.keys(response.json<ProfileBody>().user).sort()).toEqual([
      'avatarUrl',
      'createdAt',
      'displayName',
      'id',
      'username',
    ])
  })

  it('answers 404 for a username nobody holds', async () => {
    const response = await inject('GET', '/api/v1/users/nobody')
    expect(response.statusCode).toBe(404)
    expect(response.json<ErrorBody>().error.code).toBe('NOT_FOUND')
  })

  it('refuses a path segment that could never have been issued', async () => {
    // The pattern is a cheap gate, not a decision about who exists: it stops a
    // kilobyte of path from becoming an indexed lookup.
    const response = await inject('GET', '/api/v1/users/NOT-A-USERNAME')
    expect(response.statusCode).toBe(400)
  })
})

describe('GET /me', () => {
  it('refuses an anonymous caller', async () => {
    expect((await inject('GET', ME)).statusCode).toBe(401)
  })

  it('answers with the same shape a stranger would see, email included in neither', async () => {
    const response = await inject('GET', ME, { headers: harness.owner })
    expect(response.statusCode).toBe(200)
    expect(Object.keys(response.json<AccountBody>().user).sort()).toEqual([
      'avatarUrl',
      'createdAt',
      'displayName',
      'id',
      'username',
    ])
    expect(response.payload).not.toContain('ada@example.com')
  })

  /**
   * The one setting on this response, and the reason it is a sibling of `user`
   * rather than a field on it: `PublicUserResponse` is what every circuit
   * byline serialises through, so a preference living inside it would be
   * published to every stranger reading the gallery. Here it can only leave
   * the process on the three routes where the caller is the subject.
   */
  it('reports the leaderboard preference beside the user, not inside it', async () => {
    const response = await inject('GET', ME, { headers: harness.owner })
    const body = response.json<AccountBody & { leaderboardOptOut: boolean }>()

    // Nobody has expressed a preference, so the column default stands: listed.
    expect(body.leaderboardOptOut).toBe(false)
    expect(Object.keys(body.user)).not.toContain('leaderboardOptOut')
  })

  it('creates the row on first use', async () => {
    // Somebody who signed up and went straight to settings has no
    // `public.User` row yet — see `users.ts` in @qsim/db for why it is created
    // on a request rather than by a trigger.
    const newcomer = '33333333-3333-4333-8333-333333333333'
    const key = await createSigningKey('key-2')
    const app = await createTestApp({
      jwks: createTestJwksCache(stubJwksEndpoint([key])),
      circuits: { repository: harness.repository },
    })
    await app.ready()

    const response = await app.inject({
      method: 'GET',
      url: ME,
      headers: {
        authorization: `Bearer ${await signToken(key, {
          subject: newcomer,
          email: 'newcomer@example.com',
        })}`,
      },
    })
    expect(response.statusCode).toBe(200)
    expect(response.json<AccountBody>().user.id).toBe(newcomer)
    await app.close()
  })
})

describe('PATCH /me', () => {
  it('changes the display name', async () => {
    const response = await inject('PATCH', ME, {
      headers: harness.owner,
      body: { displayName: 'Ada Lovelace' },
    })
    expect(response.statusCode).toBe(200)
    expect(response.json<AccountBody>().user.displayName).toBe('Ada Lovelace')
  })

  it('records a refusal to be listed, and the change of mind after it', async () => {
    const out = await inject('PATCH', ME, {
      headers: harness.owner,
      body: { leaderboardOptOut: true },
    })
    expect(out.statusCode).toBe(200)
    expect(
      out.json<AccountBody & { leaderboardOptOut: boolean }>().leaderboardOptOut
    ).toBe(true)

    const back = await inject('PATCH', ME, {
      headers: harness.owner,
      body: { leaderboardOptOut: false },
    })
    expect(
      back.json<AccountBody & { leaderboardOptOut: boolean }>()
        .leaderboardOptOut
    ).toBe(false)
  })

  it('leaves the preference alone when the body does not mention it', async () => {
    await inject('PATCH', ME, {
      headers: harness.owner,
      body: { leaderboardOptOut: true },
    })
    // Absent means "leave it", exactly as it does for the display name. A
    // settings form that saved a name must not quietly republish somebody.
    const response = await inject('PATCH', ME, {
      headers: harness.owner,
      body: { displayName: 'Ada Lovelace' },
    })
    expect(
      response.json<AccountBody & { leaderboardOptOut: boolean }>()
        .leaderboardOptOut
    ).toBe(true)
  })

  it('refuses a username that belongs to somebody else', async () => {
    const response = await inject('PATCH', ME, {
      headers: harness.owner,
      body: { username: 'grace' },
    })
    // Decided by the unique index rather than by a prior lookup, and it says
    // exactly what a public profile already says about that handle.
    expect(response.statusCode).toBe(409)
    expect(response.json<ErrorBody>().error.code).toBe('USERNAME_TAKEN')
  })

  it('refuses a username that could never appear in a URL', async () => {
    const response = await inject('PATCH', ME, {
      headers: harness.owner,
      body: { username: 'Ada Lovelace' },
    })
    expect(response.statusCode).toBe(400)
    expect(response.json<ErrorBody>().error.code).toBe('VALIDATION_FAILED')
  })

  it('moves the public profile to the new handle', async () => {
    await inject('PATCH', ME, {
      headers: harness.owner,
      body: { username: 'ada-l' },
    })
    expect((await inject('GET', '/api/v1/users/ada-l')).statusCode).toBe(200)
    expect((await inject('GET', '/api/v1/users/ada')).statusCode).toBe(404)
  })

  it('refuses a body with nothing in it', async () => {
    const response = await inject('PATCH', ME, {
      headers: harness.owner,
      body: {},
    })
    expect(response.statusCode).toBe(400)
  })

  it('takes the avatar from the verified token and never from the body', async () => {
    const withUrl = await inject('PATCH', ME, {
      headers: harness.owner,
      // A URL in the body is not a field this endpoint has. Zod strips it, so
      // the picture must not change.
      body: { avatar: 'provider', avatarUrl: 'https://evil.example/track.png' },
    })
    expect(withUrl.statusCode).toBe(200)
    expect(withUrl.json<AccountBody>().user.avatarUrl).toBeNull()

    const fromToken = await inject('PATCH', ME, {
      headers: harness.ownerWithPicture,
      body: { avatar: 'provider' },
    })
    expect(fromToken.json<AccountBody>().user.avatarUrl).toBe(
      'https://example.com/ada.png'
    )
  })

  it('clears the picture when the generated one is chosen', async () => {
    await inject('PATCH', ME, {
      headers: harness.ownerWithPicture,
      body: { avatar: 'provider' },
    })
    const response = await inject('PATCH', ME, {
      headers: harness.owner,
      body: { avatar: 'generated' },
    })
    expect(response.json<AccountBody>().user.avatarUrl).toBeNull()
  })
})

describe('DELETE /me', () => {
  it('refuses without the caller’s own username as confirmation', async () => {
    const response = await inject('DELETE', ME, {
      headers: harness.owner,
      body: { confirm: 'grace' },
    })
    expect(response.statusCode).toBe(400)
    expect(response.json<ErrorBody>().error.details?.[0]?.code).toBe(
      'confirmation_mismatch'
    )
    // Nothing happened.
    expect(await harness.repository.findUserById(OWNER_ID)).not.toBeNull()
  })

  it('destroys the caller’s circuits and collections', async () => {
    await seedCircuit({ visibility: 'PUBLIC' })
    await seedCircuit({ visibility: 'PRIVATE' })
    await harness.repository.createCollection({
      ownerId: OWNER_ID,
      title: 'Mine',
      description: null,
      visibility: 'PUBLIC',
    })

    const response = await inject('DELETE', ME, {
      headers: harness.owner,
      body: { confirm: 'ada' },
    })
    expect(response.statusCode).toBe(200)
    expect(response.json<DeletionBody>().deleted.circuits).toBe(2)
    expect(response.json<DeletionBody>().deleted.collections).toBe(1)

    expect(harness.repository.allCircuits()).toEqual([])
    expect(harness.repository.allVersions()).toEqual([])
    expect(harness.repository.allCollections()).toEqual([])
    expect(await harness.repository.findUserById(OWNER_ID)).toBeNull()
    // And the public profile is gone with it.
    expect((await inject('GET', '/api/v1/users/ada')).statusCode).toBe(404)
  })

  it('touches nothing of anybody else’s', async () => {
    const theirs = await seedCircuit({
      ownerId: STRANGER_ID,
      visibility: 'PUBLIC',
    })
    await inject('DELETE', ME, {
      headers: harness.owner,
      body: { confirm: 'ada' },
    })
    expect(harness.repository.allCircuits().map((row) => row.id)).toEqual([
      theirs,
    ])
  })

  it('leaves no membership row in a stranger’s collection', async () => {
    /*
     * `CollectionItem.circuitId` is one of the four columns §7 leaves without
     * a foreign key. A row here would name a circuit that no longer exists and
     * would be counted as withheld for as long as the collection lives.
     */
    const mine = await seedCircuit({ visibility: 'PUBLIC' })
    const theirs = await harness.repository.createCollection({
      ownerId: STRANGER_ID,
      title: 'Favourites',
      description: null,
      visibility: 'PUBLIC',
    })
    await harness.repository.addCollectionItem({
      collectionId: theirs.id,
      ownerId: STRANGER_ID,
      circuitId: mine,
    })

    const response = await inject('DELETE', ME, {
      headers: harness.owner,
      body: { confirm: 'ada' },
    })
    expect(response.json<DeletionBody>().deleted.orphanedCollectionItems).toBe(
      1
    )
    expect(harness.repository.allCollectionItems(theirs.id)).toEqual([])
  })

  it('gives back the stars it took, so no count is left too high', async () => {
    /*
     * `Star` rows cascade away and nothing decrements the denormalised
     * `Circuit.starCount` — `unstar` already documents that this was coming.
     */
    const theirs = await seedCircuit({
      ownerId: STRANGER_ID,
      visibility: 'PUBLIC',
    })
    await harness.repository.star({ userId: OWNER_ID, circuitId: theirs })
    expect(
      harness.repository.allCircuits().find((row) => row.id === theirs)
        ?.starCount
    ).toBe(1)

    const response = await inject('DELETE', ME, {
      headers: harness.owner,
      body: { confirm: 'ada' },
    })
    expect(response.json<DeletionBody>().deleted.stars).toBe(1)
    expect(
      harness.repository.allCircuits().find((row) => row.id === theirs)
        ?.starCount
    ).toBe(0)
  })

  it('refuses an anonymous caller', async () => {
    const response = await inject('DELETE', ME, { body: { confirm: 'ada' } })
    expect(response.statusCode).toBe(401)
  })
})
