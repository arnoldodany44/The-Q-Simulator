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

import { useQuery } from '@tanstack/react-query'
import type { UseQueryResult } from '@tanstack/react-query'
import { HardwareJobStatus } from '@qsim/contract'
import type { HardwareJob, HardwareJobStatus as Status } from '@qsim/contract'

import { useApiClient } from './ApiContext.js'
import { getHardwareJob } from './hardware.js'
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
