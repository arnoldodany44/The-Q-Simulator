/**
 * The second credential.
 *
 * ── The flow, which is not the one the older documentation describes ─────
 *
 * The legacy `quantum-computing.ibm.com` token is gone. What a user has now is
 * an **IBM Cloud API key**, and that key is not a bearer token: it is exchanged
 * at IAM for one.
 *
 *     POST https://iam.cloud.ibm.com/identity/token
 *     Content-Type: application/x-www-form-urlencoded
 *     grant_type=urn:ibm:params:oauth:grant-type:apikey&apikey=<key>
 *
 * The answer carries `access_token`, `expires_in` (3600) and `expiration` (an
 * absolute epoch second). Every Quantum API call then carries that token as
 * `Authorization: Bearer`, plus `Service-CRN` and `IBM-API-Version`.
 *
 * ── So there are two secrets, not one, and the second one is worse ───────
 *
 * The API key is stored encrypted and is read once per exchange. The bearer
 * token is *derived*, lives an hour, and is held in memory — which makes it the
 * one that ends up in a log, because it is the one that is a request header on
 * every single call. It is never written to a row, never returned by a route,
 * never put in an error message: `IbmError` scrubs its own detail, and the
 * cache below stores it in a closure that has no accessor other than the one
 * that mints requests.
 *
 * ── The cache, and the two numbers in it ─────────────────────────────────
 *
 * Keyed by credential, not by user: a person may hold one key for a personal
 * instance and another for one their employer pays for, and a cache keyed by
 * user would hand the second instance's calls the first instance's token — a
 * 403 that looks like a permissions problem and is a bookkeeping one.
 *
 * `REFRESH_MARGIN_MS` is what stops the other failure: a token that is valid
 * when the request is built and expired when it arrives. A hardware job's poll
 * can sit behind a slow response, so the margin is generous — sixty seconds
 * against a 3600-second life is under two per cent of the exchanges and removes
 * the whole class.
 *
 * `MAX_ENTRIES` is a bound on what a shared process will hold. Each entry is a
 * kilobyte of JWT, so this is not about memory: it is that a cache with no
 * ceiling is a place where a credential lives for as long as the process does,
 * and the eviction is what makes "held in memory briefly" true.
 */

import { z } from 'zod'
import { IbmError, failureCodeForStatus } from './errors.js'
import type { HttpTransport } from './transport.js'
import { DEFAULT_TIMEOUT_MS, retryAfterSeconds } from './transport.js'

/** Where an API key is exchanged for a bearer token. */
export const IAM_TOKEN_URL = 'https://iam.cloud.ibm.com/identity/token'

/** The grant type IBM Cloud defines for an API key. */
export const IAM_GRANT_TYPE = 'urn:ibm:params:oauth:grant-type:apikey'

/**
 * How long before a token's expiry it is treated as already expired.
 *
 * See the header. Sixty seconds is far longer than any request this package
 * makes and far shorter than the hour a token lives.
 */
export const REFRESH_MARGIN_MS = 60_000

/** How many tokens one process will hold at once. See the header. */
export const MAX_ENTRIES = 256

/**
 * The answer to a successful exchange.
 *
 * `expires_in` is a duration and `expiration` an absolute second; both are
 * present on the live service and the duration is preferred, because it is
 * relative to *this* process's clock. An absolute expiry from a service whose
 * clock is minutes ahead would be trusted for minutes too long, and a token
 * that is trusted past its expiry produces a 401 in the middle of a poll rather
 * than a refresh before it.
 */
const TokenResponseSchema = z.object({
  access_token: z.string().min(1),
  token_type: z.string().optional(),
  expires_in: z.number().int().positive().optional(),
  expiration: z.number().int().positive().optional(),
})

/** How long a token is assumed to last when the answer does not say. */
const ASSUMED_LIFETIME_S = 3600

export interface IamToken {
  readonly token: string
  /** Epoch milliseconds, in this process's clock. */
  readonly expiresAt: number
}

export interface ExchangeOptions {
  readonly transport: HttpTransport
  readonly now?: () => number
  readonly timeoutMs?: number
}

/**
 * One API key, exchanged for one bearer token.
 *
 * The key is form-encoded into the body and appears nowhere else — not in the
 * URL, where it would be recorded verbatim by every proxy between here and IBM,
 * and not in a log line, because nothing here formats the request.
 */
export async function exchangeApiKey(
  apiKey: string,
  options: ExchangeOptions
): Promise<IamToken> {
  const now = options.now ?? Date.now
  const body = new URLSearchParams({
    grant_type: IAM_GRANT_TYPE,
    apikey: apiKey,
  }).toString()

  const response = await options.transport({
    method: 'POST',
    url: IAM_TOKEN_URL,
    headers: {
      'content-type': 'application/x-www-form-urlencoded',
      accept: 'application/json',
    },
    body,
    timeoutMs: options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
  })

  if (response.status !== 200) {
    /*
     * IAM answers **400** for a key it does not recognise, not 401 — measured
     * against the live service, whose body is
     * `{"errorCode":"BXNIM0415E","errorMessage":"Provided API key could not be
     * found."}`. Mapping that 400 through `failureCodeForStatus` would call it
     * IBM_REFUSED, which reads as "the request was wrong" when the truth is
     * "your key is wrong" — the one failure the person who typed the key can
     * actually fix. So the two client-side statuses are named here.
     *
     * Nothing from the body is read. `errorMessage` is English prose from a
     * third party and could quote the key back; the status is the only field
     * this branch needs.
     */
    const code =
      response.status === 400 || response.status === 401
        ? 'IBM_CREDENTIAL_INVALID'
        : failureCodeForStatus(response.status)
    throw new IbmError(code, 'the IAM token exchange was refused', {
      status: response.status,
      retryAfterSeconds: retryAfterSeconds(response.headers),
    })
  }

  let parsed: unknown
  try {
    parsed = JSON.parse(response.body)
  } catch (error) {
    throw new IbmError(
      'IBM_MALFORMED_RESPONSE',
      'the IAM token exchange answered 200 with a body that is not JSON',
      { status: response.status, cause: error }
    )
  }

  const result = TokenResponseSchema.safeParse(parsed)
  if (!result.success) {
    throw new IbmError(
      'IBM_MALFORMED_RESPONSE',
      'the IAM token exchange answered 200 without an access_token',
      { status: response.status }
    )
  }

  const lifetime = result.data.expires_in ?? ASSUMED_LIFETIME_S
  return { token: result.data.access_token, expiresAt: now() + lifetime * 1000 }
}

export interface TokenCache {
  /**
   * A live token for this credential, exchanging one only if necessary.
   *
   * `key` is the credential's identity — its row id — and never the API key
   * itself: a cache keyed by secret is a map with a secret in its keys, which
   * is one heap dump away from being the leak this whole file is about.
   */
  tokenFor(key: string, apiKey: () => Promise<string>): Promise<string>
  /** Forgets one credential's token. Called when the service answers 401. */
  invalidate(key: string): void
  /** Forgets everything. For shutdown, and for tests. */
  clear(): void
  /** How many tokens are held. For a test and for a gauge, never a decision. */
  size(): number
}

interface Entry {
  readonly token: string
  readonly expiresAt: number
  /** Insertion order for the eviction below. */
  readonly storedAt: number
}

export interface TokenCacheOptions {
  readonly transport: HttpTransport
  readonly now?: () => number
  readonly maxEntries?: number
  readonly timeoutMs?: number
}

/**
 * A per-credential bearer token cache.
 *
 * ── The in-flight map is not an optimisation ─────────────────────────────
 *
 * A worker polling several of one user's jobs will ask for the same token from
 * several ticks at once. Without `inFlight`, each one starts its own exchange:
 * n requests to IAM for one token, and — worse — n-1 of them land after the
 * first has already been cached, so the cache is overwritten with tokens
 * nobody asked for. Sharing the promise makes concurrent askers share one
 * exchange, which is both cheaper and the only version that is deterministic.
 */
export function createTokenCache(options: TokenCacheOptions): TokenCache {
  const now = options.now ?? Date.now
  const maxEntries = options.maxEntries ?? MAX_ENTRIES
  const entries = new Map<string, Entry>()
  const inFlight = new Map<string, Promise<string>>()

  function live(entry: Entry | undefined): entry is Entry {
    return entry !== undefined && entry.expiresAt - REFRESH_MARGIN_MS > now()
  }

  function store(key: string, token: IamToken): void {
    entries.set(key, {
      token: token.token,
      expiresAt: token.expiresAt,
      storedAt: now(),
    })
    if (entries.size <= maxEntries) return
    /*
     * Oldest-stored first, not least-recently-used. A token has a fixed
     * lifetime, so "stored longest ago" is also "closest to expiry", which
     * makes the cheap policy the correct one here — evicting an entry that is
     * about to be re-exchanged anyway costs nothing.
     */
    let oldestKey: string | null = null
    let oldestAt = Number.POSITIVE_INFINITY
    for (const [candidate, entry] of entries) {
      if (entry.storedAt < oldestAt) {
        oldestAt = entry.storedAt
        oldestKey = candidate
      }
    }
    if (oldestKey !== null) entries.delete(oldestKey)
  }

  return {
    async tokenFor(key, apiKey) {
      const cached = entries.get(key)
      if (live(cached)) return cached.token

      const pending = inFlight.get(key)
      if (pending !== undefined) return pending

      const exchange = (async () => {
        const secret = await apiKey()
        const token = await exchangeApiKey(secret, {
          transport: options.transport,
          now,
          ...(options.timeoutMs === undefined
            ? {}
            : { timeoutMs: options.timeoutMs }),
        })
        store(key, token)
        return token.token
      })()

      inFlight.set(key, exchange)
      try {
        return await exchange
      } finally {
        // Removed whether it resolved or rejected: a failed exchange must not
        // become a rejected promise every later caller awaits for ever.
        inFlight.delete(key)
      }
    },

    invalidate(key) {
      entries.delete(key)
    },

    clear() {
      entries.clear()
      inFlight.clear()
    },

    size() {
      return entries.size
    },
  }
}
