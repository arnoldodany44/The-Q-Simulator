/**
 * The public signing keys, cached, with a refetch that cannot be weaponised.
 *
 * ── Why there is no shared secret ─────────────────────────────────────────
 *
 * Specification §11 describes verifying user tokens against
 * `SUPABASE_JWT_SECRET`, a symmetric HS256 key held by both Supabase and this
 * API. That is the legacy scheme and this project no longer uses it. Supabase
 * signs with an asymmetric key — ES256 on the P-256 curve — and publishes the
 * *public* half, unauthenticated, at `SUPABASE_JWKS_URL`.
 *
 * The difference is not cosmetic. Under HS256 the key that verifies a token
 * is the key that mints one, so anyone who can read the API's environment —
 * a log of `process.env`, a leaked build artifact, a compromised dashboard
 * session — can forge a token for any user. Under ES256 the API holds
 * nothing that can sign. That is why the spec must not be "fixed" back.
 *
 * ── Why the refetch is bounded ────────────────────────────────────────────
 *
 * Key rotation means a token can legitimately arrive signed by a key this
 * process has never seen, identified by its `kid`. The obvious handling —
 * "unknown kid, fetch the JWKS" — turns any attacker into a traffic
 * amplifier: a request per second carrying a random `kid` becomes a request
 * per second to Supabase, and the endpoint that stops answering is the one
 * this API needs to authenticate anybody at all. So an unknown `kid` may
 * trigger *at most one* fetch per cooldown window, whether it arrives once or
 * ten thousand times, and concurrent misses share a single in-flight request
 * rather than starting one each.
 *
 * The failure modes are deliberately asymmetric:
 *
 *   - The JWKS endpoint is unreachable but we hold a cached key for this
 *     `kid` → verify with the cached key. A network blip must not log
 *     everyone out.
 *   - The endpoint is unreachable and we hold nothing usable → 503, not 401.
 *     Nothing is wrong with the caller's token; a 401 would tell the client
 *     to throw away a perfectly good session.
 *   - The endpoint answered and the `kid` is genuinely not in it → 401. This
 *     is a forged or a very old token.
 */

import { importJWK } from 'jose'
import { z } from 'zod'
import { ApiError } from '../errors.js'

/**
 * A key we are willing to verify with.
 *
 * Deliberately narrow. A JWKS is untrusted input over the network like any
 * other, and accepting whatever it contains is how algorithm confusion
 * starts: an `oct` (symmetric) entry smuggled into the document, combined
 * with a token whose header says `HS256`, verifies against a value the
 * attacker also knows. Pinning `EC` / `P-256` / `ES256` here — and pinning
 * the algorithm again at verification time — closes that door twice.
 */
const SigningKeySchema = z.looseObject({
  kty: z.literal('EC'),
  crv: z.literal('P-256'),
  x: z.string().min(1),
  y: z.string().min(1),
  kid: z.string().min(1),
  alg: z.literal('ES256').optional(),
  use: z.literal('sig').optional(),
})

const JwksSchema = z.looseObject({ keys: z.array(z.unknown()) })

export type SigningKey = z.infer<typeof SigningKeySchema>

export type FetchLike = (
  input: string,
  init?: { signal?: AbortSignal; headers?: Record<string, string> }
) => Promise<{ ok: boolean; status: number; json: () => Promise<unknown> }>

export interface JwksCacheOptions {
  readonly url: string
  /** Injected in tests; defaults to the platform `fetch`. */
  readonly fetchImpl?: FetchLike
  /** Injected in tests so cooldowns can be crossed without waiting. */
  readonly now?: () => number
  /** How long a fetched document is served before it is refreshed. */
  readonly cacheMaxAgeMs?: number
  /** Floor on the interval between two network attempts. The bound. */
  readonly minRefetchIntervalMs?: number
  readonly requestTimeoutMs?: number
}

const DEFAULT_CACHE_MAX_AGE_MS = 10 * 60_000
const DEFAULT_MIN_REFETCH_INTERVAL_MS = 30_000
const DEFAULT_REQUEST_TIMEOUT_MS = 5_000

export interface JwksStats {
  /** Network attempts made, successful or not. Asserted by the tests. */
  readonly fetches: number
  readonly keyCount: number
}

export class JwksCache {
  readonly #url: string
  readonly #fetchImpl: FetchLike
  readonly #now: () => number
  readonly #cacheMaxAgeMs: number
  readonly #minRefetchIntervalMs: number
  readonly #requestTimeoutMs: number

  #keys = new Map<string, CryptoKey>()
  #fetchedAt = Number.NEGATIVE_INFINITY
  #lastAttemptAt = Number.NEGATIVE_INFINITY
  #inFlight: Promise<void> | null = null
  #fetches = 0

  constructor(options: JwksCacheOptions) {
    this.#url = options.url
    this.#fetchImpl = options.fetchImpl ?? defaultFetch
    this.#now = options.now ?? Date.now
    this.#cacheMaxAgeMs = options.cacheMaxAgeMs ?? DEFAULT_CACHE_MAX_AGE_MS
    this.#minRefetchIntervalMs =
      options.minRefetchIntervalMs ?? DEFAULT_MIN_REFETCH_INTERVAL_MS
    this.#requestTimeoutMs =
      options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS
  }

  get stats(): JwksStats {
    return { fetches: this.#fetches, keyCount: this.#keys.size }
  }

  /**
   * The verification key for a `kid`.
   *
   * @throws {ApiError} `AUTH_INVALID_TOKEN` when the key does not exist,
   * `AUTH_KEY_UNAVAILABLE` when we could not find out.
   */
  async getKey(kid: string): Promise<CryptoKey> {
    const cached = this.#keys.get(kid)
    const fresh = this.#now() - this.#fetchedAt < this.#cacheMaxAgeMs
    if (cached !== undefined && fresh) return cached

    /*
     * A refresh already running is joined whatever the cooldown says: it is
     * about to answer this exact question and it costs no extra request.
     * Checking the cooldown first would reject every request that arrived
     * during the fetch it is waiting for — which is most of them, since a
     * rotation makes every in-flight request miss at the same instant.
     */
    if (this.#inFlight === null && !this.#mayAttemptFetch()) {
      // Inside the cooldown with nothing in flight. A stale key still
      // verifies — staleness is a property of the document, not of the
      // mathematics — and an unknown kid is rejected without touching the
      // network. This branch is the bound.
      if (cached !== undefined) return cached
      /*
       * Two very different situations end up here and they must not get the
       * same answer.
       *
       * If the cache holds keys, the last fetch succeeded, and this `kid` is
       * genuinely not among them: the token is forged or very old, and 401 is
       * the truth.
       *
       * If the cache holds nothing, no fetch has ever succeeded — the
       * cooldown is here because the last *attempt failed*. Answering 401
       * then tells every client in the window that its perfectly good session
       * is invalid, and `requiresAuthentication()` in apps/web signs the user
       * out on it. One outage at Supabase becomes a mass sign-out, and the
       * cooldown makes it 49 sign-outs for every one honest 503.
       */
      if (this.#keys.size === 0) throw new ApiError('AUTH_KEY_UNAVAILABLE')
      throw new ApiError('AUTH_INVALID_TOKEN')
    }

    try {
      await this.#refresh()
    } catch (error) {
      if (cached !== undefined) return cached
      throw new ApiError('AUTH_KEY_UNAVAILABLE', { cause: error })
    }

    const refreshed = this.#keys.get(kid)
    if (refreshed !== undefined) return refreshed
    throw new ApiError('AUTH_INVALID_TOKEN')
  }

  #mayAttemptFetch(): boolean {
    return this.#now() - this.#lastAttemptAt >= this.#minRefetchIntervalMs
  }

  /**
   * Coalesces concurrent refreshes into one request. Without this, a rotation
   * on a busy instance produces one fetch per in-flight request at the exact
   * moment the auth provider is least able to answer them.
   */
  #refresh(): Promise<void> {
    this.#inFlight ??= this.#fetchKeys().finally(() => {
      this.#inFlight = null
    })
    return this.#inFlight
  }

  async #fetchKeys(): Promise<void> {
    // Stamped before the request, so a *failing* endpoint is also rate
    // limited. Stamping on success would retry every single request while
    // the endpoint is down, which is when hammering it helps least.
    this.#lastAttemptAt = this.#now()
    this.#fetches += 1

    const response = await this.#fetchImpl(this.#url, {
      signal: AbortSignal.timeout(this.#requestTimeoutMs),
      headers: { accept: 'application/json' },
    })
    if (!response.ok) {
      throw new Error(`JWKS endpoint answered ${String(response.status)}`)
    }

    const document = JwksSchema.safeParse(await response.json())
    if (!document.success) throw new Error('JWKS document is not a key set')

    const imported = new Map<string, CryptoKey>()
    for (const entry of document.data.keys) {
      const key = SigningKeySchema.safeParse(entry)
      // An unusable entry is skipped rather than fatal: a project may publish
      // keys for algorithms this API does not accept, and refusing the whole
      // document over one of them would be an outage caused by a key we were
      // never going to use.
      if (!key.success) continue

      /*
       * The import is inside the try for the same reason the shape check is
       * skipped rather than fatal, and it was the half that was missing.
       * `SigningKeySchema` checks that `x` and `y` are non-empty strings; it
       * cannot check that they are a point on P-256, and `importJWK` throws
       * for one that is not. Unguarded, that rejection escapes the loop and
       * discards the whole map — including keys already imported on earlier
       * iterations, because the assignment below only happens once the loop
       * has finished. One junk entry beside the live signing key therefore
       * produced zero usable keys and a total authentication outage.
       */
      let material: Awaited<ReturnType<typeof importJWK>>
      try {
        material = await importJWK(key.data, 'ES256')
      } catch {
        continue
      }
      // `importJWK` returns bytes for symmetric keys. Reaching this branch
      // would mean the shape check above was fooled; refuse rather than
      // verify with something an attacker might also hold.
      if (!isCryptoKey(material)) continue
      imported.set(key.data.kid, material)
    }

    if (imported.size === 0) throw new Error('JWKS document has no usable keys')

    this.#keys = imported
    this.#fetchedAt = this.#now()
  }
}

function isCryptoKey(value: unknown): value is CryptoKey {
  return (
    typeof value === 'object' &&
    value !== null &&
    'type' in value &&
    'algorithm' in value
  )
}

const defaultFetch: FetchLike = (input, init) => fetch(input, init)
