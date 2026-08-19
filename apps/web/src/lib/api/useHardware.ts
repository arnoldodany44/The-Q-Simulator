/**
 * React Query hooks for hardware jobs — §9, §3.7.
 *
 * ── A FINISHED JOB IS IMMUTABLE, AND THE CACHE POLICY SAYS SO ────────────
 *
 * §3.7's comparison view exists to be *opened*, including during a
 * demonstration, from a result that was submitted hours earlier. Once a job is
 * DONE nothing about it can change again: a device measured what it measured,
 * and no later edit to the circuit, no recalibration and no second run rewrites
 * that row. So a terminal job is never refetched — `staleTime: Infinity` — and
 * the page draws from the cache instantly on every revisit.
 *
 * A job still in flight is the opposite case and is polled, on the same
 * front-loaded-then-flat idea `@qsim/jobs`' `pollDelayMs` argues for on the
 * server, with a far coarser schedule: the browser is one more reader and the
 * worker is the thing actually driving the job. Ten seconds is fast enough that
 * a person watching sees the status change and slow enough that a tab left open
 * overnight is not a request every second for eight hours.
 */

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import type { UseMutationResult, UseQueryResult } from '@tanstack/react-query'
import { HardwareJobStatus } from '@qsim/contract'
import type {
  CreateHardwareCredentialBody,
  CreateHardwareJobBody,
  HardwareBackendResponse,
  HardwareCredential,
  HardwareJob,
  HardwareJobStatus as Status,
} from '@qsim/contract'

import { useApiClient } from './ApiContext.js'
import {
  createHardwareCredential,
  createHardwareJob,
  deleteHardwareCredential,
  getHardwareJob,
  listHardwareBackends,
  listHardwareCredentials,
} from './hardware.js'
import { hardwareKeys } from './queryKeys.js'

/** How often an unfinished job is asked about. See the header. */
export const HARDWARE_POLL_MS = 10_000

/** DONE, FAILED and CANCELLED — the statuses nothing can move away from. */
export function isTerminal(status: Status): boolean {
  return (
    status === HardwareJobStatus.DONE ||
    status === HardwareJobStatus.FAILED ||
    status === HardwareJobStatus.CANCELLED
  )
}

/** `GET /hardware/jobs/:id` — one stored job, with its program and its result. */
export function useHardwareJob(
  id: string,
  enabled = true
): UseQueryResult<HardwareJob, unknown> {
  const client = useApiClient()

  return useQuery({
    queryKey: hardwareKeys.job(id),
    queryFn: ({ signal }) => getHardwareJob(client, id, { signal }),
    enabled: enabled && id !== '',
    /*
     * Both of these read the job already in the cache, which is what lets the
     * polling stop by itself the moment a result lands rather than needing a
     * component to notice and re-render with a different option.
     */
    staleTime: (query) =>
      query.state.data !== undefined && isTerminal(query.state.data.status)
        ? Infinity
        : 0,
    refetchInterval: (query) =>
      query.state.data !== undefined && isTerminal(query.state.data.status)
        ? false
        : HARDWARE_POLL_MS,
  })
}

/** `GET /hardware/credentials` — the keys this account has stored. */
export function useHardwareCredentials(
  enabled = true
): UseQueryResult<readonly HardwareCredential[], unknown> {
  const client = useApiClient()
  return useQuery({
    queryKey: hardwareKeys.credentials(),
    queryFn: ({ signal }) => listHardwareCredentials(client, { signal }),
    enabled,
  })
}

/**
 * `POST /hardware/credentials`.
 *
 * Only the credential list is invalidated. The per-credential device lists are
 * deliberately left alone: a key that was just added has no entry to be stale,
 * and the entries that exist belong to other keys pointed at other instances —
 * see `hardwareKeys.backends`.
 */
export function useCreateHardwareCredential(): UseMutationResult<
  HardwareCredential,
  unknown,
  CreateHardwareCredentialBody
> {
  const client = useApiClient()
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (request: CreateHardwareCredentialBody) =>
      createHardwareCredential(client, request),
    onSuccess: () => {
      void queryClient.invalidateQueries({
        queryKey: hardwareKeys.credentials(),
      })
    },
  })
}

/**
 * `DELETE /hardware/credentials/:id`.
 *
 * This one *does* drop the device lists, all of them: the removed key's entry
 * is now unreachable, and leaving it in the cache would let a picker offer
 * devices bought with a credential that no longer exists.
 */
export function useDeleteHardwareCredential(): UseMutationResult<
  HardwareCredential,
  unknown,
  string
> {
  const client = useApiClient()
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (id: string) => deleteHardwareCredential(client, id),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: hardwareKeys.all })
    },
  })
}

/**
 * `GET /hardware/backends` — the devices, with their queues.
 *
 * Reaches the provider through our API, so it is slow and it is metered by
 * somebody's rate limit rather than free. `staleTime` is a minute: a queue
 * moves, but not between two renders of a form, and a picker that refetched on
 * every focus change would spend a person's allowance drawing the same list.
 */
export function useHardwareBackends(
  credentialId: string | null
): UseQueryResult<readonly HardwareBackendResponse[], unknown> {
  const client = useApiClient()
  return useQuery({
    queryKey: hardwareKeys.backends(credentialId ?? ''),
    queryFn: ({ signal }) =>
      listHardwareBackends(client, credentialId ?? '', { signal }),
    enabled: credentialId !== null && credentialId !== '',
    staleTime: 60_000,
  })
}

/**
 * `POST /hardware/jobs`.
 *
 * Seeds the job cache with the row the server returned, so the run page it
 * navigates to renders immediately and then starts polling, rather than showing
 * a spinner for a job whose receipt is already in hand.
 */
export function useSubmitHardwareJob(): UseMutationResult<
  HardwareJob,
  unknown,
  CreateHardwareJobBody
> {
  const client = useApiClient()
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (request: CreateHardwareJobBody) =>
      createHardwareJob(client, request),
    onSuccess: (job) => {
      queryClient.setQueryData(hardwareKeys.job(job.id), job)
    },
  })
}
