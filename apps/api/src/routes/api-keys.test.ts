/**
 * The public API's credentials, driven through the real app — §3.5, §11.
 *
 * ── The four things this file exists to prove ─────────────────────────────
 *
 * 1. **The key is shown once.** It appears in the 201 and in no other
 *    response, including to its owner, and the stored row does not contain it.
 * 2. **Revocation is immediate.** The request *after* a revocation fails —
 *    not the request after some cache expires.
 * 3. **A key acts as its user and never as anybody else.** The test that
 *    matters is a key trying to read a stranger's PRIVATE circuit, because
 *    that is the mistake that turns a convenience into a breach.
 * 4. **Scopes bind.** A read key cannot write, and no key at all can manage
 *    keys — however it is scoped.
 *
 * Everything is asserted from outside, through `inject`, against the real
 * hooks, the real Zod compilers and the real error handler. The only doubles
 * are Postgres and the JWKS endpoint; the hashing, the minting, the negative
 * cache and the scope narrowing are all production code.
 */

import { MAX_ACTIVE_API_KEYS } from '@qsim/db'
import { API_KEY_LENGTH, API_KEY_PATTERN, API_KEY_PREFIX } from '@qsim/contract'
import { CIRCUIT_SCHEMA_VERSION } from '@qsim/schema'
import type { Circuit } from '@qsim/schema'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { ApiInstance } from '../app.js'
import { hashApiKey } from '../api-keys/secret.js'
import { createTestApp } from '../testing/app.js'
import { memoryApiKeys } from '../testing/api-keys.js'
import type { MemoryApiKeys } from '../testing/api-keys.js'
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
const KEYS = '/api/v1/api-keys'

interface KeyBody {
  id: string
  name: string
  keyPrefix: string
  scopes: string[]
  createdAt: string
  lastUsedAt: string | null
  revokedAt: string | null
}

interface CreatedBody {
  apiKey: KeyBody
  key: string
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
  keys: MemoryApiKeys
  circuits: MemoryCircuitRepository
  owner: Record<string, string>
  stranger: Record<string, string>
}

let harness: Harness

beforeEach(async () => {
  const signing = await createSigningKey('key-1')
  const keys = memoryApiKeys()
  const circuits = createMemoryCircuitRepository()
  const app = await createTestApp({
    jwks: createTestJwksCache(stubJwksEndpoint([signing])),
    circuits: { repository: circuits },
    apiKeys: { repository: keys.repository, verifier: keys.verifier },
  })
  await app.ready()

  circuits.addUser({ id: OWNER_ID, username: 'ada', displayName: 'Ada' })
  circuits.addUser({ id: STRANGER_ID, username: 'grace' })

  harness = {
    app,
    keys,
    circuits,
    owner: {
      authorization: `Bearer ${await signToken(signing, {
        subject: OWNER_ID,
        email: 'ada@example.com',
      })}`,
    },
    stranger: {
      authorization: `Bearer ${await signToken(signing, {
        subject: STRANGER_ID,
        email: 'grace@example.com',
      })}`,
    },
  }
})

afterEach(async () => {
  await harness.app.close()
})

/** `Authorization` headers for a key, the way any HTTP client would send it. */
function bearing(key: string): Record<string, string> {
  return { authorization: `Bearer ${key}` }
}

async function mint(
  scopes: readonly string[],
  name = 'CI'
): Promise<CreatedBody> {
  const response = await harness.app.inject({
    method: 'POST',
    url: KEYS,
    headers: harness.owner,
    payload: { name, scopes },
  })
  expect(response.statusCode).toBe(201)
  return response.json<CreatedBody>()
}

describe('POST /api-keys', () => {
  it('answers the key exactly once, in the shape a scanner can find', async () => {
    const created = await mint(['read'])

    expect(created.key).toMatch(API_KEY_PATTERN)
    expect(created.key).toHaveLength(API_KEY_LENGTH)
    expect(created.key.startsWith(API_KEY_PREFIX)).toBe(true)
    // The listing shows the head and no more.
    expect(created.apiKey.keyPrefix).toBe(created.key.slice(0, 10))
    expect(created.apiKey.scopes).toEqual(['read'])
    expect(created.apiKey.lastUsedAt).toBeNull()
    expect(created.apiKey.revokedAt).toBeNull()
  })

  it('stores a hash and never the key', async () => {
    const created = await mint(['read'])
    const stored = [...harness.keys.rows.values()]

    expect(stored).toHaveLength(1)
    const row = stored[0]
    expect(row?.keyHash).toBe(hashApiKey(created.key))
    /*
     * The property, stated over the whole row rather than over the column
     * somebody remembered to check: nothing anywhere in what was written is
     * the key. `keyPrefix` is ten characters of it and is the one deliberate
     * exception, so the search is for the secret's tail.
     */
    expect(JSON.stringify(row)).not.toContain(created.key)
    expect(JSON.stringify(row)).not.toContain(created.key.slice(20))
  })

  it('never shows the key again, not even to the owner who made it', async () => {
    const created = await mint(['read'])

    const listed = await harness.app.inject({
      method: 'GET',
      url: KEYS,
      headers: harness.owner,
    })
    expect(listed.statusCode).toBe(200)
    /*
     * Asserted against the *whole body* rather than against the absence of a
     * field, because the failure this guards against is a field nobody
     * predicted — a debug echo, a spread of the row, a future `preview`.
     */
    expect(listed.body).not.toContain(created.key)
    expect(listed.json<{ apiKeys: KeyBody[] }>().apiKeys).toHaveLength(1)
  })

  it('refuses a key with no scopes', async () => {
    const response = await harness.app.inject({
      method: 'POST',
      url: KEYS,
      headers: harness.owner,
      payload: { name: 'CI', scopes: [] },
    })
    expect(response.statusCode).toBe(400)
    expect(response.json<ErrorBody>().error.code).toBe('VALIDATION_FAILED')
  })

  it('refuses a key with no name', async () => {
    // A list of six keys called nothing is a list nobody can revoke safely.
    const response = await harness.app.inject({
      method: 'POST',
      url: KEYS,
      headers: harness.owner,
      payload: { name: '   ', scopes: ['read'] },
    })
    expect(response.statusCode).toBe(400)
  })

  it('deduplicates the scopes it was sent', async () => {
    const created = await mint(['read', 'read', 'write'])
    expect(created.apiKey.scopes).toEqual(['read', 'write'])
  })

  it('mints keys that differ', async () => {
    const first = await mint(['read'], 'one')
    const second = await mint(['read'], 'two')
    expect(first.key).not.toBe(second.key)
  })

  it('refuses past the ceiling, and says which kind of refusal it is', async () => {
    /*
     * Seeded through the store rather than through twenty POSTs, because
     * twenty POSTs is what the *rate limiter* refuses — §11 gives this route
     * the strict budget — and the answer would then be a 429 that says
     * nothing about the ceiling. Two limits, two tests; this one is about the
     * ceiling.
     */
    for (let index = 0; index < MAX_ACTIVE_API_KEYS; index += 1) {
      harness.keys.issue({
        userId: OWNER_ID,
        scopes: ['read'],
        name: `key ${String(index)}`,
      })
    }
    const response = await harness.app.inject({
      method: 'POST',
      url: KEYS,
      headers: harness.owner,
      payload: { name: 'one too many', scopes: ['read'] },
    })
    expect(response.statusCode).toBe(409)
    expect(response.json<ErrorBody>().error.code).toBe('API_KEY_LIMIT_REACHED')
  })

  it('is anonymous callers’ business not at all', async () => {
    const response = await harness.app.inject({
      method: 'POST',
      url: KEYS,
      payload: { name: 'CI', scopes: ['read'] },
    })
    expect(response.statusCode).toBe(401)
  })
})

describe('GET /api-keys', () => {
  it('lists only the caller’s own keys', async () => {
    await mint(['read'], 'ada')
    harness.keys.issue({ userId: STRANGER_ID, scopes: ['read'], name: 'grace' })

    const response = await harness.app.inject({
      method: 'GET',
      url: KEYS,
      headers: harness.owner,
    })
    const listed = response.json<{ apiKeys: KeyBody[] }>().apiKeys
    expect(listed.map((key) => key.name)).toEqual(['ada'])
  })

  it('keeps revoked keys visible, because that is when they matter', async () => {
    const created = await mint(['read'])
    await harness.app.inject({
      method: 'DELETE',
      url: `${KEYS}/${created.apiKey.id}`,
      headers: harness.owner,
    })

    const response = await harness.app.inject({
      method: 'GET',
      url: KEYS,
      headers: harness.owner,
    })
    const listed = response.json<{ apiKeys: KeyBody[] }>().apiKeys
    expect(listed).toHaveLength(1)
    // "Which key did I turn off, and when" is answerable an hour later.
    expect(listed[0]?.revokedAt).not.toBeNull()
  })
})

describe('DELETE /api-keys/:id', () => {
  it('revokes, and the very next request with that key fails', async () => {
    const created = await mint(['read'])
    const usable = await harness.app.inject({
      method: 'GET',
      url: '/api/v1/circuits',
      headers: bearing(created.key),
    })
    expect(usable.statusCode).toBe(200)

    const revoked = await harness.app.inject({
      method: 'DELETE',
      url: `${KEYS}/${created.apiKey.id}`,
      headers: harness.owner,
    })
    expect(revoked.statusCode).toBe(200)
    expect(revoked.json<{ apiKey: KeyBody }>().apiKey.revokedAt).not.toBeNull()

    /*
     * The assertion the requirement is written in. No clock is advanced, no
     * cache is flushed, nothing is restarted: the next request simply fails,
     * because the lookup filters on `revokedAt IS NULL` and nothing anywhere
     * remembers that this key was ever good.
     */
    const after = await harness.app.inject({
      method: 'GET',
      url: '/api/v1/circuits',
      headers: bearing(created.key),
    })
    expect(after.statusCode).toBe(401)
    expect(after.json<ErrorBody>().error.code).toBe('AUTH_INVALID_TOKEN')
  })

  it('is idempotent, and keeps the first timestamp', async () => {
    const created = await mint(['read'])
    const first = await harness.app.inject({
      method: 'DELETE',
      url: `${KEYS}/${created.apiKey.id}`,
      headers: harness.owner,
    })
    const second = await harness.app.inject({
      method: 'DELETE',
      url: `${KEYS}/${created.apiKey.id}`,
      headers: harness.owner,
    })

    expect(second.statusCode).toBe(200)
    // Moving it would erase the moment the key actually stopped working.
    expect(second.json<{ apiKey: KeyBody }>().apiKey.revokedAt).toBe(
      first.json<{ apiKey: KeyBody }>().apiKey.revokedAt
    )
  })

  it('answers 404 for somebody else’s key, exactly as for one that never was', async () => {
    const created = await mint(['read'])

    const byStranger = await harness.app.inject({
      method: 'DELETE',
      url: `${KEYS}/${created.apiKey.id}`,
      headers: harness.stranger,
    })
    const invented = await harness.app.inject({
      method: 'DELETE',
      url: `${KEYS}/key-does-not-exist`,
      headers: harness.stranger,
    })

    expect(byStranger.statusCode).toBe(404)
    expect(invented.statusCode).toBe(404)
    // Identical, so the pair is not an oracle over the table.
    expect(byStranger.json<ErrorBody>().error.code).toBe(
      invented.json<ErrorBody>().error.code
    )

    // And it really is still alive for its owner.
    const stillWorks = await harness.app.inject({
      method: 'GET',
      url: '/api/v1/circuits',
      headers: bearing(created.key),
    })
    expect(stillWorks.statusCode).toBe(200)
  })
})

describe('a key authenticating a request', () => {
  it('travels in the ordinary Authorization header', async () => {
    const created = await mint(['read'])
    const response = await harness.app.inject({
      method: 'GET',
      url: '/api/v1/circuits',
      headers: bearing(created.key),
    })
    expect(response.statusCode).toBe(200)
  })

  it('is refused when it is a plausible string nobody minted', async () => {
    const invented = `${API_KEY_PREFIX}${'A'.repeat(43)}`
    const response = await harness.app.inject({
      method: 'GET',
      url: '/api/v1/circuits',
      headers: bearing(invented),
    })
    expect(response.statusCode).toBe(401)
    /*
     * The same code an unknown key and a revoked one get. Distinguishing them
     * would tell whoever holds a string that it used to be a credential.
     */
    expect(response.json<ErrorBody>().error.code).toBe('AUTH_INVALID_TOKEN')
  })

  it('is refused when it is the right shape but the wrong length', async () => {
    const response = await harness.app.inject({
      method: 'GET',
      url: '/api/v1/circuits',
      headers: bearing(`${API_KEY_PREFIX}tooshort`),
    })
    // Rejected as an unverifiable token, never as a database lookup.
    expect(response.statusCode).toBe(401)
  })

  it('records that it was used, coarsely', async () => {
    const created = await mint(['read'])
    await harness.app.inject({
      method: 'GET',
      url: '/api/v1/circuits',
      headers: bearing(created.key),
    })

    const listed = await harness.app.inject({
      method: 'GET',
      url: KEYS,
      headers: harness.owner,
    })
    const [key] = listed.json<{ apiKeys: KeyBody[] }>().apiKeys
    // The one field that makes "which of these can I safely revoke" answerable.
    expect(key?.lastUsedAt).not.toBeNull()
  })
})

/**
 * The section this milestone is really about.
 *
 * "A key acts as its user and can do NO MORE than that user can" is easy to
 * believe and easy to get wrong, and the way it goes wrong is that the key
 * path grows a second read that skips the visibility filter. Every assertion
 * below is made from a key belonging to ONE account against data belonging to
 * ANOTHER — that a key can read its own owner's circuits proves nothing.
 */
describe('a key is its user and nothing more', () => {
  it('cannot read another account’s PRIVATE circuit', async () => {
    const secret = await harness.circuits.create({
      ownerId: STRANGER_ID,
      title: 'Grace’s private work',
      description: null,
      visibility: 'PRIVATE',
      data: bell(),
      message: null,
      forkedFromId: null,
    })

    const created = await mint(['read'])
    const bySlug = await harness.app.inject({
      method: 'GET',
      url: `/api/v1/circuits/${secret.circuit.slug}`,
      headers: bearing(created.key),
    })
    const byId = await harness.app.inject({
      method: 'GET',
      url: `/api/v1/circuits/${secret.circuit.id}`,
      headers: bearing(created.key),
    })

    // 404 and not 403: the same answer as for a slug nobody minted (§11).
    expect(bySlug.statusCode).toBe(404)
    expect(byId.statusCode).toBe(404)
    expect(bySlug.body).not.toContain('Grace')
  })

  it('does not show another account’s private circuits in a listing', async () => {
    await harness.circuits.create({
      ownerId: STRANGER_ID,
      title: 'Grace’s private work',
      description: null,
      visibility: 'PRIVATE',
      data: bell(),
      message: null,
      forkedFromId: null,
    })

    const created = await mint(['read'])
    const mine = await harness.app.inject({
      method: 'GET',
      url: '/api/v1/circuits',
      headers: bearing(created.key),
    })
    expect(mine.json<{ items: unknown[] }>().items).toEqual([])
  })

  it('cannot delete another account’s circuit', async () => {
    const theirs = await harness.circuits.create({
      ownerId: STRANGER_ID,
      title: 'Grace’s public work',
      description: null,
      visibility: 'PUBLIC',
      data: bell(),
      message: null,
      forkedFromId: null,
    })

    const created = await mint(['write'])
    const response = await harness.app.inject({
      method: 'DELETE',
      url: `/api/v1/circuits/${theirs.circuit.id}`,
      headers: bearing(created.key),
    })
    // Readable, so admitting it exists costs nothing — and still not writable.
    expect(response.statusCode).toBe(403)
  })

  it('writes circuits that belong to the key’s owner', async () => {
    const created = await mint(['write', 'read'])
    const written = await harness.app.inject({
      method: 'POST',
      url: '/api/v1/circuits',
      headers: bearing(created.key),
      payload: { title: 'From a script', circuit: bell() },
    })
    expect(written.statusCode).toBe(201)

    /*
     * The row is the owner's, not a new account's. A key carries no email
     * claim, so the path that creates a `public.User` row on first write must
     * not run for it — see `establishedOwnerId`.
     */
    const listed = await harness.app.inject({
      method: 'GET',
      url: '/api/v1/circuits',
      headers: harness.owner,
    })
    const items = listed.json<{ items: { title: string }[] }>().items
    expect(items.map((item) => item.title)).toEqual(['From a script'])
  })
})

describe('scopes', () => {
  it('let a read key read and not write', async () => {
    const created = await mint(['read'])

    const read = await harness.app.inject({
      method: 'GET',
      url: '/api/v1/circuits',
      headers: bearing(created.key),
    })
    const write = await harness.app.inject({
      method: 'POST',
      url: '/api/v1/circuits',
      headers: bearing(created.key),
      payload: { title: 'Nope', circuit: bell() },
    })

    expect(read.statusCode).toBe(200)
    expect(write.statusCode).toBe(403)
    const body = write.json<ErrorBody>()
    expect(body.error.code).toBe('API_KEY_SCOPE_REQUIRED')
    // The missing scope names the checkbox to tick when minting a replacement.
    expect(body.error.details).toEqual([{ path: 'scope', code: 'write' }])
  })

  it('keep simulation apart from writing', async () => {
    const writer = await mint(['write'], 'writer')
    const response = await harness.app.inject({
      method: 'POST',
      url: '/api/v1/simulate',
      headers: bearing(writer.key),
      payload: { circuit: bell(), shots: 128 },
    })
    expect(response.statusCode).toBe(403)
    expect(response.json<ErrorBody>().error.code).toBe('API_KEY_SCOPE_REQUIRED')
  })

  it('refuse a key on key management however it is scoped', async () => {
    const created = await mint(['read', 'write', 'simulate'])

    for (const request of [
      { method: 'GET' as const, url: KEYS },
      { method: 'POST' as const, url: KEYS },
      { method: 'DELETE' as const, url: `${KEYS}/${created.apiKey.id}` },
    ]) {
      const response = await harness.app.inject({
        ...request,
        headers: bearing(created.key),
        ...(request.method === 'POST'
          ? { payload: { name: 'child', scopes: ['read'] } }
          : {}),
      })
      /*
       * The escalation this closes: a leaked key that could mint keys would
       * renew itself, so revoking the leaked one would close nothing.
       */
      expect(response.statusCode, `${request.method} ${request.url}`).toBe(403)
      expect(response.json<ErrorBody>().error.code).toBe('API_KEY_NOT_ACCEPTED')
    }
  })

  it('refuse a key on hardware however it is scoped', async () => {
    const created = await mint(['read', 'write', 'simulate'])
    const response = await harness.app.inject({
      method: 'GET',
      url: '/api/v1/hardware/credentials',
      headers: bearing(created.key),
    })
    /*
     * Not because hardware is off in this test app — that would answer 503 —
     * but because no key may reach it at all. The Open Plan grants ten minutes
     * per twenty-eight days and does not refill (risk 4).
     */
    expect(response.statusCode).toBe(403)
    expect(response.json<ErrorBody>().error.code).toBe('API_KEY_NOT_ACCEPTED')
  })

  it('refuse a key on the account routes', async () => {
    const created = await mint(['read', 'write', 'simulate'])
    const response = await harness.app.inject({
      method: 'GET',
      url: '/api/v1/me',
      headers: bearing(created.key),
    })
    expect(response.statusCode).toBe(403)
    expect(response.json<ErrorBody>().error.code).toBe('API_KEY_NOT_ACCEPTED')
  })

  it('are dropped when the row holds one this build does not know', async () => {
    // A `TEXT[]` can hold anything. An unrecognised value must grant nothing
    // and must not be advertised as if it did.
    const issued = harness.keys.issue({
      userId: OWNER_ID,
      scopes: ['read', 'administrator'],
    })

    const listed = await harness.app.inject({
      method: 'GET',
      url: KEYS,
      headers: harness.owner,
    })
    const [key] = listed.json<{ apiKeys: KeyBody[] }>().apiKeys
    expect(key?.scopes).toEqual(['read'])

    const write = await harness.app.inject({
      method: 'POST',
      url: '/api/v1/circuits',
      headers: bearing(issued.key),
      payload: { title: 'Nope', circuit: bell() },
    })
    expect(write.statusCode).toBe(403)
  })
})

describe('the rate limiter', () => {
  it('counts a key against itself rather than against its owner', async () => {
    const key = await mint(['read'])
    const before = await harness.app.inject({
      method: 'GET',
      url: '/api/v1/circuits',
      headers: bearing(key.key),
    })
    const session = await harness.app.inject({
      method: 'GET',
      url: '/api/v1/circuits',
      headers: harness.owner,
    })

    /*
     * Two budgets, one per identity. The observable form of that is the
     * remaining counter: the session's is untouched by what the key spent,
     * which is what stops a looping script from locking its author out of
     * their own browser.
     */
    expect(before.headers['x-ratelimit-remaining']).toBeDefined()
    expect(session.headers['x-ratelimit-remaining']).toBe(
      before.headers['x-ratelimit-remaining']
    )
  })
})
