/**
 * Turning a presented API key into an identity, or into nothing — §3.5, §11.
 *
 * ══════════════════════════════════════════════════════════════════════════
 * A SUCCESSFUL VERIFICATION IS NEVER CACHED. THAT IS THE WHOLE REVOCATION
 * DESIGN.
 *
 * The requirement is that a revoked key fails on the **next request**, not at
 * the next cache expiry. There are two ways to get that: cache hits and
 * invalidate the cache on revocation, or do not cache hits at all.
 *
 * The first is the one that looks cheaper and is not. Invalidation has to
 * reach every process that might hold the entry, and this service is deployed
 * as a container that can be scaled to two — at which point revoking a key on
 * the instance that served the settings request leaves it working on the other
 * one for the length of the TTL. That failure is invisible in development,
 * invisible in tests, and appears exactly once: in production, on the day
 * somebody is revoking a key because it leaked.
 *
 * So verification is one indexed read per authenticated request, and there is
 * nothing anywhere holding a "this key is valid" answer. The read is a
 * `findFirst` on a unique column with `revokedAt IS NULL` — see `@qsim/db`'s
 * `api-keys.ts`, where the filter is in the query rather than in a check —
 * so revocation is enforced by the same statement that resolves the key and
 * cannot be skipped by any code path.
 *
 * ══════════════════════════════════════════════════════════════════════════
 * A FAILED VERIFICATION *IS* CACHED, BRIEFLY, AND THAT IS SOUND
 *
 * The cost of the decision above is that an unauthenticated flood of
 * well-formed-but-invented keys is one database query per request, on a
 * Supabase pooler whose connection budget is one — and it lands *before* the
 * rate limiter, because the limiter is keyed on the identity this file
 * resolves (see the hook ordering argument in `plugins/auth.ts`).
 *
 * A short negative cache closes that without touching revocation. The
 * reasoning is one-directional and worth stating plainly:
 *
 *   - Caching "this hash matched no live row" can only ever make the API
 *     *refuse* something. It cannot let a revoked key through, because a
 *     revoked key is not in the cache as valid — nothing is.
 *   - The one thing it could get wrong is refusing a key that has just become
 *     valid. That requires the exact 47-character string to have been
 *     presented to this process before the key existed, which requires having
 *     guessed 256 bits of `randomBytes` output ahead of time. A person who
 *     mistypes their key and then fixes it types a different string, and the
 *     different string was never cached.
 *
 * The cache is bounded in both directions — a hard entry cap and a few
 * seconds of TTL — so it cannot itself become the memory leak that an
 * unbounded map of attacker-supplied strings would be.
 *
 * ══════════════════════════════════════════════════════════════════════════
 * WHY `lastUsedAt` IS STAMPED HERE AND THROTTLED
 *
 * "Which of these six keys can I safely revoke" is the question a settings
 * screen exists to answer, and it is unanswerable from names and dates alone.
 * The column that answers it has to be written on the authentication path,
 * because that is the only place that knows a key was used.
 *
 * Written naively it turns the busiest read path in the public API into a
 * write. So the stamp is throttled by `touchIntervalMs`: the row already
 * carries its previous `lastUsedAt`, this process compares, and the update is
 * skipped when it would say nearly the same thing. The database repeats the
 * comparison in its own `where`, so two instances racing cannot produce two
 * writes either.
 *
 * The throttle is also the privacy answer. Coarse is what the question needs;
 * a precise timestamp would turn this table into a log of when its owner works.
 */

import { isApiKeyScope } from '@qsim/contract'
import type { ApiKeyScope } from '@qsim/contract'
import type { ApiKeyRepository } from '@qsim/db'
import { hashApiKey, isApiKeyCredential } from './secret.js'

/** What a verified key authorises. Everything a route or a limiter may know. */
export interface VerifiedApiKey {
  /** `ApiKey.id`. The rate-limit key, and what a revocation would name. */
  readonly keyId: string
  /** The account this key acts as. Never more than that account can do. */
  readonly userId: string
  /**
   * The scopes this build recognises, in the order the row held them.
   *
   * Filtered through `isApiKeyScope`, so a value written by a future build —
   * or by anything else with write access to a `TEXT[]` — is dropped rather
   * than carried. Dropping is the safe direction: an unknown scope grants
   * nothing, where a passed-through one would be compared by string equality
   * against a route's declaration and could match by accident.
   */
  readonly scopes: readonly ApiKeyScope[]
}

export interface ApiKeyVerifier {
  /**
   * Verifies a bearer token that has already been recognised as a key.
   *
   * `null` means "no live key has this value", which covers unknown and
   * revoked alike — the caller must not be able to tell them apart.
   */
  verify(token: string): Promise<VerifiedApiKey | null>
}

export interface ApiKeyVerifierOptions {
  readonly repository: ApiKeyRepository
  /** Injected by tests. Milliseconds since the epoch. */
  readonly now?: () => number
  /** How long a "no such key" answer is remembered. */
  readonly missTtlMs?: number
  /** How many misses are remembered at once. */
  readonly missCapacity?: number
  /** How stale `lastUsedAt` must be before it is rewritten. */
  readonly touchIntervalMs?: number
  /** Where a failed `lastUsedAt` write is reported. Never to the caller. */
  readonly onTouchError?: (error: unknown) => void
}

/**
 * A few seconds. Long enough that a burst of one invented key costs one query
 * rather than thousands; short enough that it is not a window anybody could
 * plan around, and short enough that the memory it can hold is bounded by the
 * cap below long before it is bounded by time.
 */
const DEFAULT_MISS_TTL_MS = 10_000

/**
 * The cap, and it is the load-bearing bound rather than the TTL.
 *
 * Ten thousand hex digests is well under a megabyte and is far more distinct
 * invented keys than a single window will see from anything but a deliberate
 * flood — which is the case this exists for, and which the cap turns into a
 * fixed cost instead of a growing one.
 */
const DEFAULT_MISS_CAPACITY = 10_000

/**
 * Five minutes. The resolution the question needs — "is this key in use at
 * all" — and no finer, because finer would be an access log nobody asked for.
 */
const DEFAULT_TOUCH_INTERVAL_MS = 5 * 60_000

/** The recognised scopes of a stored row, in order, with the rest dropped. */
function knownScopes(scopes: readonly string[]): ApiKeyScope[] {
  return scopes.filter(isApiKeyScope)
}

export function createApiKeyVerifier(
  options: ApiKeyVerifierOptions
): ApiKeyVerifier {
  const {
    repository,
    now = () => Date.now(),
    missTtlMs = DEFAULT_MISS_TTL_MS,
    missCapacity = DEFAULT_MISS_CAPACITY,
    touchIntervalMs = DEFAULT_TOUCH_INTERVAL_MS,
    onTouchError,
  } = options

  /*
   * Hash → the moment the entry stops being believed.
   *
   * A `Map` rather than anything cleverer because insertion order is exactly
   * the eviction order wanted here: the oldest miss is the least likely to be
   * part of the burst currently in flight, and `Map` gives that in one
   * `keys().next()` with no bookkeeping to get wrong.
   *
   * The keys are digests, never the presented tokens. A cache of live API keys
   * in process memory would be the thing this whole file is arranged to avoid,
   * and it would be one refactor away if the key were the map key.
   */
  const misses = new Map<string, number>()

  function rememberMiss(keyHash: string, at: number): void {
    if (misses.size >= missCapacity) {
      const oldest = misses.keys().next()
      if (!oldest.done) misses.delete(oldest.value)
    }
    misses.set(keyHash, at + missTtlMs)
  }

  function isRememberedMiss(keyHash: string, at: number): boolean {
    const expires = misses.get(keyHash)
    if (expires === undefined) return false
    if (expires > at) return true
    // Expired entries are dropped as they are met, which keeps the map from
    // holding a long tail of dead keys between bursts without a timer.
    misses.delete(keyHash)
    return false
  }

  return {
    async verify(token) {
      /*
       * The format gate, repeated here even though the caller has already
       * applied it. This function is the seam a future caller will reach for,
       * and the property "a made-up token never becomes a query" must belong
       * to the verifier rather than to whoever remembered to check first.
       */
      if (!isApiKeyCredential(token)) return null

      const keyHash = hashApiKey(token)
      const at = now()
      if (isRememberedMiss(keyHash, at)) return null

      const row = await repository.findApiKeyByHash(keyHash)
      if (row === null) {
        rememberMiss(keyHash, at)
        return null
      }

      /*
       * The stamp, throttled against what the row already says. Awaited rather
       * than left floating: an un-awaited write on a pool of one connection is
       * a write that queues behind the next request instead of this one, and a
       * rejected floating promise is an unhandled rejection in a process that
       * treats those as fatal. The cost is one update per key per five
       * minutes, on a request that has already done a query.
       */
      if (
        row.lastUsedAt === null ||
        row.lastUsedAt.getTime() <= at - touchIntervalMs
      ) {
        try {
          await repository.touchApiKey({
            id: row.id,
            at: new Date(at),
            notUsedSince: new Date(at - touchIntervalMs),
          })
        } catch (error) {
          /*
           * Bookkeeping about a request that is already authorised. Failing
           * the request because a timestamp could not be written would turn a
           * transient database hiccup into "your key stopped working", which
           * is the most alarming possible way to report a non-problem.
           */
          onTouchError?.(error)
        }
      }

      return {
        keyId: row.id,
        userId: row.userId,
        scopes: knownScopes(row.scopes),
      }
    },
  }
}
