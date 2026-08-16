/**
 * The sweep, and the two ways it can be wrong.
 *
 * It exists because three separate failures leave a run non-terminal with
 * nothing left to move it (see `reaper.ts`), and the client watching that run
 * polls it every five seconds for the life of the tab. So the property under
 * test is one sentence: **a run this old is failed, and a run that is merely
 * waiting is not.** Getting the second wrong would take an answer away from
 * somebody who was going to get one, which is worse than the bug.
 */

import { describe, expect, it } from 'vitest'
import { STALE_RUN_AGE_MS, reapStaleRuns } from './reaper.js'
import { fakeRunStore } from './testing/doubles.js'

const NOW = 1_800_000_000_000

function at(msAgo: number): Date {
  return new Date(NOW - msAgo)
}

function ports(runs: ReturnType<typeof fakeRunStore>) {
  const logs: { level: string; message: string }[] = []
  return {
    runs,
    log: (level: 'info' | 'warn' | 'error', _f: unknown, message: string) => {
      logs.push({ level, message })
    },
    now: () => NOW,
    logs,
  }
}

describe('the stale-run sweep', () => {
  it('fails a run nothing will ever move again', async () => {
    const runs = fakeRunStore()
    runs.seed({
      id: 'lost',
      status: 'RUNNING',
      createdAt: at(STALE_RUN_AGE_MS + 60_000),
    })

    const test = ports(runs)
    await expect(reapStaleRuns(test)).resolves.toBe(1)

    const row = runs.rows.get('lost')
    expect(row?.status).toBe('FAILED')
    // The vocabulary already has the code for "the process running this went
    // away without answering".
    expect(row?.errorMessage).toBe('WORKER_CRASHED')
  })

  it('fails a run that was never picked up either', async () => {
    // The API killed between `createRun` and `enqueue`: a row describing a job
    // that does not exist.
    const runs = fakeRunStore()
    runs.seed({
      id: 'orphan',
      status: 'QUEUED',
      createdAt: at(STALE_RUN_AGE_MS + 1),
    })
    await expect(reapStaleRuns(ports(runs))).resolves.toBe(1)
    expect(runs.rows.get('orphan')?.status).toBe('FAILED')
  })

  it('leaves a run that is merely waiting alone', async () => {
    const runs = fakeRunStore()
    runs.seed({ id: 'waiting', status: 'QUEUED', createdAt: at(60_000) })
    runs.seed({ id: 'running', status: 'RUNNING', createdAt: at(120_000) })

    await expect(reapStaleRuns(ports(runs))).resolves.toBe(0)
    expect(runs.rows.get('waiting')?.status).toBe('QUEUED')
    expect(runs.rows.get('running')?.status).toBe('RUNNING')
  })

  it('never touches a run that already has an answer', async () => {
    const runs = fakeRunStore()
    runs.seed({
      id: 'done',
      status: 'DONE',
      durationMs: 12,
      createdAt: at(STALE_RUN_AGE_MS * 10),
    })
    await expect(reapStaleRuns(ports(runs))).resolves.toBe(0)
    expect(runs.rows.get('done')?.status).toBe('DONE')
  })

  it('survives a database that is down, because it runs again in five minutes', async () => {
    /*
     * The one place in this worker where swallowing is right: a rejection out of
     * a timer with nothing awaiting it reaches `unhandledRejection`, which takes
     * down a process that is otherwise running jobs perfectly well.
     */
    const runs = fakeRunStore()
    const broken = {
      ...runs,
      failStaleRuns: () => Promise.reject(new Error('ECONNRESET')),
    }
    const test = ports(broken)
    await expect(reapStaleRuns(test)).resolves.toBe(0)
    expect(test.logs.some((entry) => entry.level === 'error')).toBe(true)
  })
})
