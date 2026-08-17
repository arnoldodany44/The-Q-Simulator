/**
 * The API key surface, driven with no Postgres — §3.5.
 *
 * ── What is a double here, and what deliberately is not ───────────────────
 *
 * The repository is a `Map`. The **cipher is not stubbed, because there is no
 * cipher** — what protects a key is a SHA-256, and `mintApiKey`/`hashApiKey`
 * from `src/api-keys/secret.ts` are used exactly as production uses them. That
 * matters for the same reason `testing/hardware.ts` keeps the real AES: the
 * property under test is that the presented key never appears in storage, and a
 * suite that hashed with a stub would be asserting about the stub.
 *
 * So `rows` below holds what the database would hold — hash, prefix, scopes,
 * timestamps — and a test can look at it and assert that no value in it is a
 * key. That assertion is worth nothing against an in-memory `{ key }`.
 *
 * ── The verifier is real too ──────────────────────────────────────────────
 *
 * `memoryApiKeys` builds the production `createApiKeyVerifier` over the map, so
 * every test of the authentication path exercises the real negative cache, the
 * real `lastUsedAt` throttle and the real scope narrowing. The clock is
 * injectable, which is the one thing a test needs that production does not.
 */

import { MAX_ACTIVE_API_KEYS } from '@qsim/db'
import { ApiKeyLimitError } from '@qsim/db'
import type {
  ApiKeyIdentity,
  ApiKeyMeta,
  ApiKeyRepository,
  CreateApiKeyInput,
} from '@qsim/db'
import { createApiKeyVerifier } from '../api-keys/verify.js'
import type { ApiKeyVerifier } from '../api-keys/verify.js'
import { mintApiKey } from '../api-keys/secret.js'

/** A stored row, exactly the columns Postgres has. */
export interface ApiKeyRow {
  id: string
  userId: string
  name: string
  keyHash: string
  keyPrefix: string
  scopes: string[]
  lastUsedAt: Date | null
  revokedAt: Date | null
  createdAt: Date
}

export interface MemoryApiKeys {
  readonly repository: ApiKeyRepository
  readonly verifier: ApiKeyVerifier
  /** The raw rows, so a test can assert what was actually stored. */
  readonly rows: Map<string, ApiKeyRow>
  /**
   * Mints a key straight into the store, bypassing the route.
   *
   * For tests about *using* a key rather than about creating one — the whole
   * point of which is that they do not have to drive `POST /api-keys` first,
   * and therefore cannot accidentally depend on it.
   */
  issue(input: {
    userId: string
    scopes: readonly string[]
    name?: string
    revoked?: boolean
  }): { key: string; id: string }
  /** Drives the clock the verifier reads. Milliseconds since the epoch. */
  setNow(at: number): void
}

function metaOf(row: ApiKeyRow): ApiKeyMeta {
  return {
    id: row.id,
    name: row.name,
    keyPrefix: row.keyPrefix,
    scopes: [...row.scopes],
    createdAt: row.createdAt,
    lastUsedAt: row.lastUsedAt,
    revokedAt: row.revokedAt,
  }
}

export function memoryApiKeys(options: { now?: number } = {}): MemoryApiKeys {
  const rows = new Map<string, ApiKeyRow>()
  let clock = options.now ?? Date.parse('2026-08-17T12:00:00.000Z')
  let counter = 0

  const repository: ApiKeyRepository = {
    listApiKeys(userId) {
      const mine = [...rows.values()]
        .filter((row) => row.userId === userId)
        .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())
      return Promise.resolve(mine.map(metaOf))
    },

    createApiKey(input: CreateApiKeyInput) {
      const live = [...rows.values()].filter(
        (row) => row.userId === input.userId && row.revokedAt === null
      )
      if (live.length >= MAX_ACTIVE_API_KEYS) {
        return Promise.reject(new ApiKeyLimitError(input.userId))
      }
      counter += 1
      const row: ApiKeyRow = {
        id: `key-${String(counter)}`,
        userId: input.userId,
        name: input.name,
        keyHash: input.keyHash,
        keyPrefix: input.keyPrefix,
        scopes: [...input.scopes],
        lastUsedAt: null,
        revokedAt: null,
        createdAt: new Date(clock + counter),
      }
      rows.set(row.id, row)
      return Promise.resolve(metaOf(row))
    },

    findApiKeyByHash(keyHash) {
      /*
       * The `revokedAt === null` half is what the Prisma implementation puts in
       * its `where`, and repeating it here rather than filtering afterwards is
       * deliberate: a double whose revocation worked differently from the real
       * query would make the revocation tests prove something about this file.
       */
      const row = [...rows.values()].find(
        (candidate) =>
          candidate.keyHash === keyHash && candidate.revokedAt === null
      )
      if (row === undefined) return Promise.resolve(null)
      const identity: ApiKeyIdentity = {
        id: row.id,
        userId: row.userId,
        scopes: [...row.scopes],
        lastUsedAt: row.lastUsedAt,
      }
      return Promise.resolve(identity)
    },

    revokeApiKey({ id, userId, at }) {
      const row = rows.get(id)
      if (row === undefined || row.userId !== userId) {
        return Promise.resolve(null)
      }
      row.revokedAt ??= at
      return Promise.resolve(metaOf(row))
    },

    touchApiKey({ id, at, notUsedSince }) {
      const row = rows.get(id)
      if (row === undefined) return Promise.resolve()
      if (row.lastUsedAt === null || row.lastUsedAt < notUsedSince) {
        row.lastUsedAt = at
      }
      return Promise.resolve()
    },
  }

  const verifier = createApiKeyVerifier({
    repository,
    now: () => clock,
  })

  return {
    repository,
    verifier,
    rows,
    issue({ userId, scopes, name = 'test key', revoked = false }) {
      const minted = mintApiKey()
      counter += 1
      const row: ApiKeyRow = {
        id: `key-${String(counter)}`,
        userId,
        name,
        keyHash: minted.keyHash,
        keyPrefix: minted.keyPrefix,
        scopes: [...scopes],
        lastUsedAt: null,
        revokedAt: revoked ? new Date(clock) : null,
        createdAt: new Date(clock + counter),
      }
      rows.set(row.id, row)
      return { key: minted.key, id: row.id }
    },
    setNow(at) {
      clock = at
    },
  }
}
