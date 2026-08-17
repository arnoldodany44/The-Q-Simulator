/**
 * React Query hooks for challenges — §9, Phase 3.
 *
 * ── Why a submission invalidates three things ─────────────────────────────
 *
 * A pass changes the ladder (a solved mark), the challenge page (this reader's
 * best attempt) and the leaderboard (a new row, possibly at the top). None of
 * the three can be reconstructed on this side: only the server knows whether
 * the attempt passed, only the server ranks, and only the server knows whether
 * somebody else submitted in the meantime. So the verdict is returned to the
 * caller for display and the caches are refetched, rather than patched from a
 * response that cannot carry all three answers.
 *
 * The verdict itself is deliberately *not* cached. It is the answer to one
 * question asked once — "is this circuit right?" — and a cached verdict would
 * be shown beside a circuit the reader has since changed, which is the one
 * thing a challenge screen must never do.
 */

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import type { UseMutationResult, UseQueryResult } from '@tanstack/react-query'
import type {
  ChallengeList,
  ChallengeSubmissionResult,
  ChallengeView,
  Leaderboard,
} from '@qsim/contract'
import type { Circuit } from '@qsim/schema'

import { useApiClient } from './ApiContext.js'
import {
  getChallenge,
  getLeaderboard,
  listChallenges,
  submitChallenge,
} from './challenges.js'
import { challengeKeys } from './queryKeys.js'

/** `GET /challenges` — the ladder. Anonymous callers get an empty `solved`. */
export function useChallenges(
  enabled = true
): UseQueryResult<ChallengeList, unknown> {
  const client = useApiClient()
  return useQuery({
    queryKey: challengeKeys.list(),
    queryFn: ({ signal }) => listChallenges(client, { signal }),
    enabled,
  })
}

/** `GET /challenges/:slug` — the rules, and this caller's best attempt. */
export function useChallenge(
  slug: string,
  enabled = true
): UseQueryResult<ChallengeView, unknown> {
  const client = useApiClient()
  return useQuery({
    queryKey: challengeKeys.detail(slug),
    queryFn: ({ signal }) => getChallenge(client, slug, { signal }),
    enabled,
  })
}

/** `GET /challenges/:slug/leaderboard`. */
export function useLeaderboard(
  slug: string,
  limit?: number,
  enabled = true
): UseQueryResult<Leaderboard, unknown> {
  const client = useApiClient()
  return useQuery({
    queryKey: challengeKeys.leaderboard(slug, limit),
    queryFn: ({ signal }) => getLeaderboard(client, slug, limit, { signal }),
    enabled,
  })
}

/**
 * `POST /challenges/:slug/submit`.
 *
 * The mutation returns the server's verdict; the component renders it. Nothing
 * here decides whether the attempt passed, and nothing here could: the target
 * never reaches this process.
 */
export function useSubmitChallenge(
  slug: string
): UseMutationResult<ChallengeSubmissionResult, unknown, Circuit> {
  const client = useApiClient()
  const queryClient = useQueryClient()

  return useMutation({
    mutationFn: (circuit: Circuit) => submitChallenge(client, slug, circuit),
    onSuccess: (result) => {
      /*
       * Only a pass can have moved anything. A failed attempt is stored — it
       * is a row, and the leaderboard's denominator — but it changes no
       * listing, so refetching three queries after every wrong answer would be
       * three round trips per keystroke-driven retry.
       */
      if (!result.submission.passed) return
      void queryClient.invalidateQueries({ queryKey: challengeKeys.list() })
      void queryClient.invalidateQueries({
        queryKey: challengeKeys.detail(slug),
      })
      void queryClient.invalidateQueries({
        queryKey: challengeKeys.leaderboards(slug),
      })
    },
  })
}
