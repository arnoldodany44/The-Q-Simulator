/**
 * The last line of defence: a run nothing will ever move is failed rather than
 * left describing work that stopped.
 *
 * ── WHY A SWEEPER EXISTS AT ALL, HAVING ARGUED AGAINST ONE ────────────────
 *
 * `POST /simulate` says, in as many words, that the window between "the row
 * exists" and "the job exists" is not worth a sweeper because a SIGKILL has to
 * land inside it. That was true of *that* window and false of the system: there
 * are three ways a run ends up non-terminal with nothing left to move it, and
 * none of them needs a coincidence.
 *
 *   - The API is killed between `createRun` and `enqueue` (the window above).
 *   - The worker's database is unreachable for the whole of `JOB_ATTEMPTS`, so
 *     the job is exhausted while the row still reads QUEUED. Retrying is the
 *     right first answer and it can still run out.
 *   - A job is stalled more than `MAX_STALLED_COUNT` times, which BullMQ
 *     answers by failing the job outright — deliberately, so one pathological
 *     circuit cannot evict every worker it touches. The row is left RUNNING.
 *
 * In all three the client is watching: `serverRun.ts` polls
 * `GET /simulate/:runId` every five seconds and delivers only on DONE or
 * FAILED, so a row that never moves is a spinner that never stops and a poll
 * loop that runs for the life of the tab. A failure the reader can see beats a
 * run that is silently gone, which is the whole of §4's honesty requirement
 * applied to the case where the server has lost the work.
 *
 * ── WHY THE AGE IS SO GENEROUS ────────────────────────────────────────────
 *
 * Because the cost of being wrong is asymmetric in the other direction: failing
 * a run that is merely waiting would take an answer away from somebody who was
 * going to get one. The bound below is longer than the deepest legal queue can
 * take to drain — `MAX_QUEUE_DEPTH` jobs at `DEFAULT_JOB_TIMEOUT_MS` each,
 * divided by the worker's concurrency — with a wide margin on top, so a run
 * this sweep touches is one no schedule can explain.
 *
 * It runs in the worker rather than in the API because the worker is the
 * process that already owns writing to these rows, and because there is exactly
 * one of it: two API replicas would run two sweeps.
 */

import { DEFAULT_JOB_TIMEOUT_MS, MAX_QUEUE_DEPTH } from '@qsim/jobs'
import type { SimulationRunRepository } from '@qsim/db'

/**
 * How long a run may be non-terminal before it is presumed lost.
 *
 * Thirty minutes. The deepest legal backlog is `MAX_QUEUE_DEPTH` jobs of at
 * most `DEFAULT_JOB_TIMEOUT_MS`, which at one worker of concurrency two is
 * twelve minutes; thirty is that with the margin a slow container and a
 * redeploy in the middle deserve.
 */
export const STALE_RUN_AGE_MS = Math.max(
  30 * 60_000,
  (MAX_QUEUE_DEPTH * DEFAULT_JOB_TIMEOUT_MS) / 2
)

/** How often the sweep runs. */
export const REAPER_INTERVAL_MS = 5 * 60_000

/**
 * Most rows one sweep may move.
 *
 * The database is shared and its pooler's whole budget is one connection, so a
 * sweep that touched every stale row in one statement would hold that
 * connection while the API waited behind it. A hundred a sweep drains any
 * plausible backlog within an hour and costs one bounded query.
 */
export const REAPER_BATCH = 100

export interface ReaperPorts {
  readonly runs: SimulationRunRepository
  readonly log: (
    level: 'info' | 'warn' | 'error',
    fields: Record<string, unknown>,
    message: string
  ) => void
  readonly now?: () => number
}

export interface Reaper {
  /** One sweep. Answers how many rows were failed. Never rejects. */
  readonly sweep: () => Promise<number>
  readonly stop: () => void
}

/** Fails every run older than `STALE_RUN_AGE_MS` that never reached an end. */
export async function reapStaleRuns(ports: ReaperPorts): Promise<number> {
  const now = ports.now ?? Date.now
  try {
    const moved = await ports.runs.failStaleRuns({
      before: new Date(now() - STALE_RUN_AGE_MS),
      // The code the vocabulary already has for "the process that was running
      // this went away without answering" (`run.ts`).
      code: 'WORKER_CRASHED',
      limit: REAPER_BATCH,
    })
    if (moved > 0) {
      ports.log(
        'warn',
        { moved },
        'failed runs that were never finished by any worker'
      )
    }
    return moved
  } catch (error) {
    /*
     * Swallowed, and this is the one place in the worker where that is right: a
     * sweep is maintenance, it runs again in five minutes, and a rejection from
     * a timer with nothing awaiting it would take the process down through
     * `unhandledRejection` — killing a worker that is otherwise running jobs
     * perfectly well.
     */
    ports.log('error', { err: error }, 'the stale-run sweep failed')
    return 0
  }
}

/** Starts the sweep on a timer. The first one runs after the first interval. */
export function startReaper(ports: ReaperPorts): Reaper {
  const timer = setInterval(() => {
    void reapStaleRuns(ports)
  }, REAPER_INTERVAL_MS)
  // Nothing should be held open by this: a process whose only remaining
  // business is a maintenance timer has no business remaining.
  timer.unref()

  return {
    sweep: () => reapStaleRuns(ports),
    stop: () => {
      clearInterval(timer)
    },
  }
}
