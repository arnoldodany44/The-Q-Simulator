/**
 * The public API's credentials — §3.5, §7's `ApiKey`, §11.
 *
 * ══════════════════════════════════════════════════════════════════════════
 * THE PLAINTEXT NEVER REACHES THIS FILE, AND NEITHER DOES THE HASHING
 *
 * Every function here takes a `keyHash` that somebody else computed. There is
 * no `createHash` import, no salt, no comparison of secrets — the minting and
 * the digest live in `apps/api/src/api-keys/secret.ts`, and this module only
 * ever sees a 64-character hex string it treats as an opaque lookup value.
 *
 * That split is the same one `hardware.ts` draws next door and it is drawn for
 * the same reason: a package imported for its query builders must not be a
 * place where a credential can be handled, so that "where does the secret get
 * touched" has a one-file answer. The difference is that a hardware token is
 * *sealed* and can come back out, and this one cannot: there is no `open`
 * here, no inverse anywhere in the system, and the column is a digest rather
 * than a ciphertext precisely so that no key can exist to leak.
 *
 * ══════════════════════════════════════════════════════════════════════════
 * REVOCATION IS ENFORCED BY THE `where`, NOT BY A CHECK AFTERWARDS
 *
 * `findByHash` filters on `revokedAt: null` **inside the query**. A revoked key
 * therefore matches no row at all, rather than matching a row somebody has to
 * remember to inspect. The consequences are worth spelling out because they
 * are the whole requirement:
 *
 *   - Revocation takes effect on the **next request**, not at the expiry of
 *     any cache, because there is no cache of successful lookups anywhere in
 *     this system (`apps/api/src/api-keys/verify.ts` states why, and what it
 *     does cache instead).
 *   - "Revoked" and "never existed" are the *same answer* to a caller, which
 *     is deliberate: distinguishing them would tell whoever holds a string
 *     that it was once a real credential, which is a fact worth something only
 *     to somebody who should not have it.
 *   - A future route that forgot the check cannot exist, because there is no
 *     unfiltered lookup by hash to call.
 *
 * ══════════════════════════════════════════════════════════════════════════
 * WHY `lastUsedAt` IS WRITTEN COARSELY AND ON PURPOSE
 *
 * A key that stamped a timestamp on every request would turn the busiest read
 * path in the public API into a write, on a Supabase pooler whose budget is
 * one connection (`client.ts`). `touchApiKey` therefore takes a `notUsedSince`
 * and updates nothing when the stored value is newer — one write per key per
 * window instead of one per request.
 *
 * The coarseness is also the privacy answer. The column exists to answer "can
 * I safely revoke this one", which needs a resolution of hours; a precise
 * timestamp would make this table an access log of when its owner works, kept
 * for ever, for a question nobody asked.
 */

import type { PrismaClient } from './generated/prisma/client.js'
import { apiKeyMetaSelect } from './projections.js'
import type { ApiKeyMeta } from './projections.js'

export type { ApiKeyMeta } from './projections.js'

/**
 * How many unrevoked keys one account may hold.
 *
 * The authority for the number, mirrored by `MAX_ACTIVE_API_KEYS` in
 * `@qsim/contract` because `apps/web` may not import this package (§12.3,
 * rule 3) — and `apps/api` asserts the two agree, the same arrangement
 * `MAX_COLLECTION_ITEMS` and `USERNAME_PATTERN` already have. It is the
 * authority rather than the copy because this is the side that can actually
 * refuse: the contract's bound rejects a request, and this one rejects an
 * insert that raced past it.
 *
 * Twenty is a ceiling and not a business rule. Every live key is a separate
 * copy of somebody's authority, and an account holding two hundred has stopped
 * knowing which job holds what — at which point the honest response to a leak
 * stops being "revoke that one". Revoking is what makes room, which is the
 * behaviour the limit is trying to produce.
 */
export const MAX_ACTIVE_API_KEYS = 20

/**
 * What a verified key authorises, as the row says it.
 *
 * Deliberately *not* `ApiKeyMeta`: this is the projection the authentication
 * path reads on every request, and it carries only what a decision needs — who
 * the caller is, what the key may do, and which key it was so a rate limiter
 * and a `lastUsedAt` write can name it. No name, no dates, nothing a response
 * would render. A hot path that fetched display text would be a hot path
 * somebody would later be tempted to answer a listing from.
 *
 * `scopes` is `string[]` and not a union, because it is whatever the `TEXT[]`
 * column holds. Narrowing it is `isApiKeyScope`'s job at the point of use, and
 * putting the narrowing here would mean this module deciding that a value it
 * does not recognise is *absent* rather than *unrecognised*.
 */
export interface ApiKeyIdentity {
  readonly id: string
  readonly userId: string
  readonly scopes: readonly string[]
  /** The last stamp, so the caller can decide whether a write is due. */
  readonly lastUsedAt: Date | null
}

const apiKeyIdentitySelect = {
  id: true,
  userId: true,
  scopes: true,
  lastUsedAt: true,
} as const

export interface CreateApiKeyInput {
  readonly userId: string
  readonly name: string
  /** Hex SHA-256 of the whole presented key. Computed by `apps/api`. */
  readonly keyHash: string
  /** The displayable head, `qsk_` plus six. Derived from the same key. */
  readonly keyPrefix: string
  readonly scopes: readonly string[]
}

/** Raised when an account already holds `MAX_ACTIVE_API_KEYS` live keys. */
export class ApiKeyLimitError extends Error {
  readonly code = 'API_KEY_LIMIT_REACHED'

  constructor(readonly userId: string) {
    super(
      `This account already holds ${String(MAX_ACTIVE_API_KEYS)} active API keys`
    )
    this.name = 'ApiKeyLimitError'
  }
}

export interface ApiKeyRepository {
  /**
   * The caller's keys, newest first, revoked ones included.
   *
   * Revoked rows are listed rather than hidden, because "which key did I turn
   * off, and when" is a question asked *after* an incident, and a listing that
   * dropped the row would answer it with silence. They are visibly distinct in
   * the response — `revokedAt` is not null — and they authenticate nothing.
   */
  listApiKeys(userId: string): Promise<ApiKeyMeta[]>

  /**
   * Stores a minted key.
   *
   * @throws {ApiKeyLimitError} when the account already holds the maximum
   * number of unrevoked keys. Counted inside the transaction that inserts, so
   * two simultaneous mints cannot both see one below the ceiling.
   */
  createApiKey(input: CreateApiKeyInput): Promise<ApiKeyMeta>

  /**
   * The identity behind a presented key, or `null`.
   *
   * `null` covers "no such key" and "revoked" alike, and the caller must not
   * be able to tell which — see the header. The lookup is one indexed read on
   * `ApiKey_keyHash_key`.
   */
  findApiKeyByHash(keyHash: string): Promise<ApiKeyIdentity | null>

  /**
   * Revokes a key, idempotently.
   *
   * `null` means no such key belongs to this user — which is the same answer
   * for somebody else's key and for an id nobody minted, exactly as every
   * other read in this system does it. A key that was already revoked comes
   * back unchanged rather than as an error: pressing revoke twice is not a
   * mistake, and the second press is telling the truth about the outcome.
   */
  revokeApiKey(input: {
    id: string
    userId: string
    at: Date
  }): Promise<ApiKeyMeta | null>

  /**
   * Records that a key was used, at most once per window.
   *
   * Writes nothing when the stored `lastUsedAt` is at or after `notUsedSince`.
   * Never throws for the caller's benefit: this is bookkeeping on a request
   * that has already been authorised, and a failed stamp must not fail the
   * request it describes.
   */
  touchApiKey(input: {
    id: string
    at: Date
    notUsedSince: Date
  }): Promise<void>
}

export function prismaApiKeyRepository(prisma: PrismaClient): ApiKeyRepository {
  return {
    async listApiKeys(userId) {
      return prisma.apiKey.findMany({
        where: { userId },
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        select: apiKeyMetaSelect,
        /*
         * Bounded even though `createApiKey` refuses past the cap, for the
         * reason `readCollectionItems` bounds its own read: the ceiling counts
         * *live* keys, so an account that has revoked keys for years can hold
         * far more rows than the cap — and this is a listing, which must not be
         * able to grow without limit. Twice the cap plus room for history.
         */
        take: MAX_ACTIVE_API_KEYS * 5,
      })
    },

    async createApiKey({ userId, name, keyHash, keyPrefix, scopes }) {
      return prisma.$transaction(async (tx) => {
        const live = await tx.apiKey.count({
          where: { userId, revokedAt: null },
        })
        if (live >= MAX_ACTIVE_API_KEYS) {
          /*
           * Checked before the insert and inside the transaction, so two
           * concurrent mints cannot both see one below the ceiling and both
           * write. Postgres cannot express "at most twenty rows matching a
           * partial predicate" as a constraint, so the transaction is what
           * enforces it — the same arrangement `addCollectionItem` uses.
           */
          throw new ApiKeyLimitError(userId)
        }
        return tx.apiKey.create({
          data: { userId, name, keyHash, keyPrefix, scopes: [...scopes] },
          select: apiKeyMetaSelect,
        })
      })
    },

    async findApiKeyByHash(keyHash) {
      /*
       * `findFirst` and not `findUnique`, because the filter is not only the
       * unique column: `revokedAt: null` is part of the question rather than a
       * check applied to the answer. Postgres still serves it from
       * `ApiKey_keyHash_key` — the equality on the unique column selects at
       * most one row and the second predicate is evaluated on it.
       */
      return prisma.apiKey.findFirst({
        where: { keyHash, revokedAt: null },
        select: apiKeyIdentitySelect,
      })
    },

    async revokeApiKey({ id, userId, at }) {
      return prisma.$transaction(async (tx) => {
        /*
         * A compare-and-set on `revokedAt IS NULL`, scoped to the owner. The
         * owner scope is in the statement rather than only in the route, so a
         * future route that forgot its check still cannot revoke somebody
         * else's key — the same second guard `updateCollection` keeps.
         */
        await tx.apiKey.updateMany({
          where: { id, userId, revokedAt: null },
          data: { revokedAt: at },
        })
        /*
         * Read back whatever is there now, scoped to the owner again. A row
         * that was already revoked comes back with its original `revokedAt`,
         * which is the honest answer: the first revocation is the one that
         * counts, and overwriting the timestamp would erase when the key
         * actually stopped working.
         */
        return tx.apiKey.findFirst({
          where: { id, userId },
          select: apiKeyMetaSelect,
        })
      })
    },

    async touchApiKey({ id, at, notUsedSince }) {
      /*
       * `updateMany` with the throttle in the `where`, so the decision is made
       * by the database rather than by a read this process would have to do
       * first. Zero rows matched is the ordinary outcome and is not an error.
       *
       * The `OR` is required: `lastUsedAt: { lt: … }` alone never matches a
       * NULL, so a key that had never been used would never record that it
       * had been — the single most useful state this column reports.
       */
      await prisma.apiKey.updateMany({
        where: {
          id,
          OR: [{ lastUsedAt: null }, { lastUsedAt: { lt: notUsedSince } }],
        },
        data: { lastUsedAt: at },
      })
    },
  }
}
