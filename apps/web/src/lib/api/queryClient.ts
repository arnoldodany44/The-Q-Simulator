/**
 * React Query's defaults, chosen against this API rather than accepted.
 *
 * Two of them are corrections rather than preferences:
 *
 * **Retries.** The library retries three times on any thrown error. Against
 * an API where 403 means "not yours" and 404 means "no such circuit, or not
 * yours to see", that turns every permission failure into four identical
 * requests and every mistyped slug into four 404s — slower to fail, and four
 * times the rate-limit budget §11 allocates per caller. `isRetryable` encodes
 * what can actually change on a second attempt: a 5xx, a 429, and a request
 * that never reached the server.
 *
 * **Mutations do not retry at all.** `POST /circuits` creates a row. A retry
 * after a response that was lost on the way back creates a second one, and
 * nothing in §8 offers an idempotency key to make that safe. Failing once and
 * letting the user press the button again is the honest behaviour.
 *
 * `staleTime` is 30 seconds because a circuit list changes when *this* user
 * changes it, and every mutation below already invalidates precisely what it
 * touched. Zero — the default — would refetch every list on every remount,
 * which on a tab switch is a request per navigation for data nobody changed.
 */

import { QueryClient } from '@tanstack/react-query'

import { isRetryable } from './errors.js'

/** How long a fetched result is served without a background refetch. */
export const DEFAULT_STALE_TIME_MS = 30_000

/** Attempts after the first, for the failures where a retry can help. */
export const MAX_QUERY_RETRIES = 2

export function shouldRetryQuery(
  failureCount: number,
  error: unknown
): boolean {
  return failureCount < MAX_QUERY_RETRIES && isRetryable(error)
}

export function createQueryClient(): QueryClient {
  return new QueryClient({
    defaultOptions: {
      queries: {
        staleTime: DEFAULT_STALE_TIME_MS,
        retry: shouldRetryQuery,
        /*
         * Refetching on window focus is the right default for a dashboard and
         * the wrong one here: the editor is a document the user is working
         * in, and a refetch triggered by alt-tabbing back is a request nobody
         * asked for. Invalidation after a mutation is how this app stays
         * fresh, and it is precise.
         */
        refetchOnWindowFocus: false,
      },
      mutations: {
        retry: false,
      },
    },
  })
}
