import { describe, expect, it } from 'vitest'
import {
  ApiKeyLimitError,
  MAX_ACTIVE_API_KEYS,
  prismaApiKeyRepository,
} from './api-keys.js'
import { apiKeyMetaSelect } from './projections.js'
import type { PrismaClient } from './generated/prisma/client.js'

/**
 * The API key repository, asserted on the statements it builds rather than on
 * what a database does with them.
 *
 * That is the right level for this file and not a compromise, because every
 * property worth guarding here is a property of the `where` clause:
 *
 *   - a revoked key must match no row, and the way that stays true is that the
 *     predicate is in the query rather than in a check somebody remembers;
 *   - a revocation must be scoped to its owner in the statement itself, so a
 *     future route that forgot its ownership check still cannot reach another
 *     account's key;
 *   - the `lastUsedAt` throttle must match a NULL, or a key that has never been
 *     used never records that it has — the one state the column is read for.
 *
 * None of those needs Postgres to be observable, and a suite that reached for
 * Postgres to observe them would be a suite nobody runs (this project has one
 * database, see `circuits.db.test.ts`). The Prisma double below records the
 * arguments and answers with whatever the test says; it is not a model of
 * Postgres and does not pretend to be.
 */

interface Call {
  readonly method: string
  readonly args: Record<string, unknown>
}

interface Double {
  readonly prisma: PrismaClient
  readonly calls: Call[]
}

/**
 * A recording stand-in for the two Prisma methods this repository uses, plus a
 * `$transaction` that simply runs its callback.
 *
 * `$transaction` is not simulated — there is no isolation here and no attempt
 * to pretend otherwise. What the atomicity of `createApiKey` actually rests on
 * is Postgres, and it is asserted in the same place `addCollectionItem`'s cap
 * is: by reading the code and by the transaction being there at all. What this
 * file asserts about it is the part a double *can* answer — that the count
 * happens before the insert, and that the insert does not happen at the cap.
 */
function double(answers: Record<string, unknown> = {}): Double {
  const calls: Call[] = []
  const record =
    (method: string) =>
    (args: Record<string, unknown> = {}): unknown => {
      calls.push({ method, args })
      return Promise.resolve(answers[method] ?? null)
    }

  const apiKey = {
    findMany: record('findMany'),
    findFirst: record('findFirst'),
    count: record('count'),
    create: record('create'),
    updateMany: record('updateMany'),
  }

  const prisma = {
    apiKey,
    $transaction: (run: (tx: unknown) => unknown) => run({ apiKey }),
  } as unknown as PrismaClient

  return { prisma, calls }
}

const HASH = 'a'.repeat(64)
const USER = '11111111-1111-4111-8111-111111111111'
const OTHER = '22222222-2222-4222-8222-222222222222'

describe('apiKeyMetaSelect', () => {
  /*
   * The structural half of "the API never returns a key". `keyHash` is not a
   * credential — it is a SHA-256 of 256 random bits and there is no inverse —
   * but a projection that could fetch it is a projection somebody would one day
   * spread into a response, and "the read cannot reach the secret material" is
   * worth being able to say without a qualifier.
   */
  it('cannot fetch the hash', () => {
    expect(apiKeyMetaSelect).not.toHaveProperty('keyHash')
  })

  it('does fetch the prefix, which is the one deliberate disclosure', () => {
    // Ten characters, so a person can tell two keys apart well enough to
    // revoke the right one. See @qsim/contract's api-keys.ts for why that is a
    // disclosure worth making.
    expect(apiKeyMetaSelect.keyPrefix).toBe(true)
  })
})

describe('findApiKeyByHash', () => {
  it('filters revoked keys inside the query, never afterwards', async () => {
    const { prisma, calls } = double()
    await prismaApiKeyRepository(prisma).findApiKeyByHash(HASH)

    expect(calls).toHaveLength(1)
    /*
     * This is the assertion the whole file exists for. `revokedAt: null` in
     * the `where` is what makes revocation take effect on the next request:
     * a revoked key matches no row, so there is no branch anywhere that could
     * be written the wrong way and no cache that could still be holding it.
     */
    expect(calls[0]?.args['where']).toEqual({ keyHash: HASH, revokedAt: null })
  })

  it('never selects the hash it was asked about', async () => {
    const { prisma, calls } = double()
    await prismaApiKeyRepository(prisma).findApiKeyByHash(HASH)

    const select = calls[0]?.args['select'] as Record<string, unknown>
    expect(select).not.toHaveProperty('keyHash')
    // Only what a decision needs: who, what they may do, and which key.
    expect(Object.keys(select).sort()).toEqual([
      'id',
      'lastUsedAt',
      'scopes',
      'userId',
    ])
  })
})

describe('createApiKey', () => {
  const input = {
    userId: USER,
    name: 'CI',
    keyHash: HASH,
    keyPrefix: 'qsk_abcdef',
    scopes: ['read'] as const,
  }

  it('counts only the live keys, and only this account’s', async () => {
    const { prisma, calls } = double({ count: 0, create: { id: 'k1' } })
    await prismaApiKeyRepository(prisma).createApiKey(input)

    expect(calls[0]?.method).toBe('count')
    expect(calls[0]?.args['where']).toEqual({ userId: USER, revokedAt: null })
    expect(calls[1]?.method).toBe('create')
  })

  it('refuses at the ceiling, before anything is written', async () => {
    const { prisma, calls } = double({ count: MAX_ACTIVE_API_KEYS })
    await expect(
      prismaApiKeyRepository(prisma).createApiKey(input)
    ).rejects.toBeInstanceOf(ApiKeyLimitError)

    // The insert must not have been attempted: the cap is a refusal, not a
    // cleanup.
    expect(calls.map((call) => call.method)).toEqual(['count'])
  })

  it('copies the scopes rather than storing the caller’s array', async () => {
    const scopes = ['read', 'write']
    const { prisma, calls } = double({ count: 0, create: { id: 'k1' } })
    await prismaApiKeyRepository(prisma).createApiKey({ ...input, scopes })
    scopes.push('simulate')

    const data = calls[1]?.args['data'] as { scopes: string[] }
    // Mutating the caller's array after the call must not change what was
    // stored — the row is a fact, not a view of somebody else's variable.
    expect(data.scopes).toEqual(['read', 'write'])
  })
})

describe('revokeApiKey', () => {
  it('scopes both statements to the owner', async () => {
    const at = new Date('2026-08-17T10:00:00Z')
    const { prisma, calls } = double({ findFirst: { id: 'k1' } })
    await prismaApiKeyRepository(prisma).revokeApiKey({
      id: 'k1',
      userId: USER,
      at,
    })

    expect(calls[0]?.method).toBe('updateMany')
    /*
     * `revokedAt: null` in the update's own `where` is what makes a second
     * revocation a no-op rather than an overwrite: the first timestamp is when
     * the key actually stopped working, and moving it would erase the one fact
     * somebody investigating an incident came for.
     */
    expect(calls[0]?.args['where']).toEqual({
      id: 'k1',
      userId: USER,
      revokedAt: null,
    })
    expect(calls[0]?.args['data']).toEqual({ revokedAt: at })

    expect(calls[1]?.method).toBe('findFirst')
    expect(calls[1]?.args['where']).toEqual({ id: 'k1', userId: USER })
  })

  it('answers null for a key that is not this caller’s', async () => {
    // The double answers `null` from findFirst by default, which is what a
    // scoped read of somebody else's key returns — the same answer as for an
    // id nobody minted, which is the point.
    const { prisma } = double()
    await expect(
      prismaApiKeyRepository(prisma).revokeApiKey({
        id: 'k1',
        userId: OTHER,
        at: new Date(),
      })
    ).resolves.toBeNull()
  })
})

describe('touchApiKey', () => {
  it('matches a key that has never been used', async () => {
    const at = new Date('2026-08-17T10:00:00Z')
    const notUsedSince = new Date('2026-08-17T09:55:00Z')
    const { prisma, calls } = double()
    await prismaApiKeyRepository(prisma).touchApiKey({
      id: 'k1',
      at,
      notUsedSince,
    })

    /*
     * The `OR` is not defensive. `lastUsedAt: { lt: … }` alone never matches a
     * NULL in SQL, so without the first arm a brand-new key would stay "never
     * used" for ever — and "never used" is precisely the state that tells its
     * owner it is safe to revoke.
     */
    expect(calls[0]?.args['where']).toEqual({
      id: 'k1',
      OR: [{ lastUsedAt: null }, { lastUsedAt: { lt: notUsedSince } }],
    })
    expect(calls[0]?.args['data']).toEqual({ lastUsedAt: at })
  })

  it('is not scoped to a user, because the id came from the key itself', async () => {
    /*
     * Worth pinning rather than leaving implicit. Every other write in this
     * file carries a `userId`, and this one deliberately does not: the id was
     * just resolved from the presented secret, so there is no caller-supplied
     * identifier to constrain — and adding one would only make the statement
     * look like it was defending against something it is not.
     */
    const { prisma, calls } = double()
    await prismaApiKeyRepository(prisma).touchApiKey({
      id: 'k1',
      at: new Date(),
      notUsedSince: new Date(),
    })
    expect(calls[0]?.args['where']).not.toHaveProperty('userId')
  })
})
