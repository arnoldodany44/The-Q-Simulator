/**
 * One job, from the queue to a terminal row.
 *
 * These are the failure modes the milestone brief lists, each with a test and
 * none of them needing Redis: a job that throws, a job past its limit, a worker
 * killed mid-job, a re-execution, a result too large to store.
 */

import { PROGRESS_MIN_INTERVAL_MS } from '@qsim/jobs'
import type { JobProgress, RunEvent } from '@qsim/jobs'
import { describe, expect, it, vi } from 'vitest'
import { RunStorageError, processSimulationJob } from './processor.js'
import type { ProcessorPorts } from './processor.js'
import { fakePool, fakeRunStore } from './testing/doubles.js'
import type { FakePool, FakeRunStore } from './testing/doubles.js'
import { jobPayload } from './testing/payloads.js'

interface Harness {
  readonly runs: FakeRunStore
  readonly pool: FakePool
  readonly ports: ProcessorPorts
  readonly signalled: string[]
  readonly progress: JobProgress[]
  readonly published: RunEvent[]
  readonly logs: { level: string; message: string }[]
}

function harness(
  overrides: Partial<ProcessorPorts> & { pool?: FakePool } = {}
): Harness {
  const runs = overrides.runs ?? fakeRunStore()
  const pool = overrides.pool ?? fakePool()
  const signalled: string[] = []
  const progress: JobProgress[] = []
  const published: RunEvent[] = []
  const logs: { level: string; message: string }[] = []

  const ports: ProcessorPorts = {
    runs,
    pool,
    reportProgress: (entry) => {
      progress.push(entry)
    },
    signalCompletion: (runId) => {
      signalled.push(runId)
      return Promise.resolve()
    },
    publish: (event) => published.push(event),
    log: (level, _fields, message) => logs.push({ level, message }),
    timeoutMs: 60_000,
    ...overrides,
  }

  return {
    runs: runs as FakeRunStore,
    pool,
    ports,
    signalled,
    progress,
    published,
    logs,
  }
}

/** The event types published, in order, for asserting a lifecycle. */
function announced(events: readonly RunEvent[]): string[] {
  return events.map((event) => event.type)
}

describe('the happy path', () => {
  it('claims, runs, stores and signals — in that order', async () => {
    const test = harness()
    test.runs.seed({ id: 'run-1' })

    const outcome = await processSimulationJob(
      jobPayload({ runId: 'run-1' }),
      test.ports
    )

    expect(outcome).toEqual({ kind: 'completed', durationMs: 12 })
    const row = test.runs.rows.get('run-1')
    expect(row?.status).toBe('DONE')
    expect(row?.durationMs).toBe(12)
    expect(row?.errorMessage).toBeNull()
    /*
     * Signalled *after* the write, never before: `POST /simulate` waits on this
     * and then reads the row, so signalling first would have it read a run that
     * is still RUNNING and answer 202 for work that was already done.
     */
    expect(test.signalled).toEqual(['run-1'])
  })

  it('stores the bounded reading and nothing else', async () => {
    const test = harness()
    test.runs.seed({ id: 'run-1' })
    await processSimulationJob(jobPayload({ runId: 'run-1' }), test.ports)
    expect(test.runs.rows.get('run-1')?.result).toMatchObject({
      resultVersion: 1,
      outcomes: [{ state: '00', probability: 1, count: null }],
    })
  })
})

describe('a job that throws', () => {
  it('is written FAILED with the code, and never retried into the same wall', async () => {
    const test = harness({ pool: fakePool({ failWith: 'ENGINE_FAILED' }) })
    test.runs.seed({ id: 'run-1' })

    const outcome = await processSimulationJob(
      jobPayload({ runId: 'run-1' }),
      test.ports
    )

    expect(outcome).toEqual({ kind: 'failed', code: 'ENGINE_FAILED' })
    expect(test.runs.rows.get('run-1')?.status).toBe('FAILED')
    // A code, never a sentence: the client translates it into three catalogs.
    expect(test.runs.rows.get('run-1')?.errorMessage).toBe('ENGINE_FAILED')
  })

  it('signals completion for a failure too, so a waiting caller stops waiting', async () => {
    const test = harness({ pool: fakePool({ failWith: 'INVALID_CIRCUIT' }) })
    test.runs.seed({ id: 'run-1' })
    await processSimulationJob(jobPayload({ runId: 'run-1' }), test.ports)
    expect(test.signalled).toEqual(['run-1'])
  })

  it('does not throw, because a deterministic failure is not worth a retry', async () => {
    // A processor that threw would make BullMQ mark the job failed and — with a
    // retry policy — run it again, spending a second minute of a killable child
    // to reach the identical exception.
    const test = harness({ pool: fakePool({ failWith: 'ENGINE_FAILED' }) })
    test.runs.seed({ id: 'run-1' })
    await expect(
      processSimulationJob(jobPayload({ runId: 'run-1' }), test.ports)
    ).resolves.toMatchObject({ kind: 'failed' })
  })
})

describe('a job past its bound', () => {
  it('records TIMED_OUT rather than a crash', async () => {
    // The pool kills the child with SIGKILL and reports the bound it broke;
    // "crashed" would be an accurate description of the process and a useless
    // one for whoever reads the run.
    const test = harness({ pool: fakePool({ failWith: 'TIMED_OUT' }) })
    test.runs.seed({ id: 'run-1' })
    await processSimulationJob(jobPayload({ runId: 'run-1' }), test.ports)
    expect(test.runs.rows.get('run-1')?.errorMessage).toBe('TIMED_OUT')
  })

  it('records LIMIT_EXCEEDED when the child refused before allocating', async () => {
    const test = harness({ pool: fakePool({ failWith: 'LIMIT_EXCEEDED' }) })
    test.runs.seed({ id: 'run-1' })
    await processSimulationJob(jobPayload({ runId: 'run-1' }), test.ports)
    expect(test.runs.rows.get('run-1')?.errorMessage).toBe('LIMIT_EXCEEDED')
  })
})

describe('a result too large to store', () => {
  it('fails the run rather than writing a truncated answer', async () => {
    // Raised by `assertResultFits` inside the child and arriving here as a code.
    // A truncated result is a row that reads as a successful run and is not one.
    const test = harness({ pool: fakePool({ failWith: 'RESULT_TOO_LARGE' }) })
    test.runs.seed({ id: 'run-1' })
    const outcome = await processSimulationJob(
      jobPayload({ runId: 'run-1' }),
      test.ports
    )
    expect(outcome).toEqual({ kind: 'failed', code: 'RESULT_TOO_LARGE' })
    expect(test.runs.rows.get('run-1')?.result).toBeNull()
  })
})

describe('a worker killed mid-job', () => {
  it('does not lose the job: a re-execution claims a run still QUEUED', async () => {
    /*
     * The first worker died before its claim landed, so the row is still
     * QUEUED. BullMQ declares the job stalled and hands it to a replacement,
     * which runs it and completes it — QUEUED → DONE, an edge the transition
     * table allows precisely for this.
     */
    const test = harness()
    test.runs.seed({ id: 'run-1', status: 'QUEUED' })
    const outcome = await processSimulationJob(
      jobPayload({ runId: 'run-1' }),
      test.ports
    )
    expect(outcome.kind).toBe('completed')
    expect(test.runs.rows.get('run-1')?.status).toBe('DONE')
  })

  it('does not run twice with visible effect: a second execution writes nothing', async () => {
    /*
     * The other half of the same sentence. The first execution finished and
     * wrote DONE; its worker then died before BullMQ could record the job as
     * complete, so the job is re-executed. The replacement cannot claim a
     * terminal row, stops, and touches nothing.
     */
    const test = harness()
    test.runs.seed({ id: 'run-1', status: 'DONE', durationMs: 12 })

    const outcome = await processSimulationJob(
      jobPayload({ runId: 'run-1' }),
      test.ports
    )

    expect(outcome).toEqual({ kind: 'skipped' })
    expect(test.pool.calls).toBe(0)
    expect(test.runs.rows.get('run-1')?.status).toBe('DONE')
    expect(test.signalled).toEqual([])
  })

  it('discards a result whose row went terminal while the job ran', async () => {
    /*
     * The narrow window the claim alone cannot cover: this execution claimed a
     * QUEUED row, and the row went terminal underneath it. Writing the answer
     * would resurrect a run somebody may already have read.
     */
    const pool = fakePool({ hold: true })
    const test = harness({ pool })
    test.runs.seed({ id: 'run-1' })

    const running = processSimulationJob(
      jobPayload({ runId: 'run-1' }),
      test.ports
    )
    await Promise.resolve()
    await test.runs.failRun({ id: 'run-1', code: 'TIMED_OUT', durationMs: 1 })
    pool.release()

    await expect(running).resolves.toEqual({ kind: 'skipped' })
    expect(test.runs.rows.get('run-1')?.status).toBe('FAILED')
    expect(test.runs.rows.get('run-1')?.errorMessage).toBe('TIMED_OUT')
  })

  it('stops when another *live* worker already holds the run', async () => {
    // A first delivery meeting a RUNNING row is a second worker, not a dead
    // one: BullMQ does not deliver one job twice unless it has stalled.
    const test = harness()
    test.runs.seed({ id: 'run-1', status: 'RUNNING' })
    await expect(
      processSimulationJob(jobPayload({ runId: 'run-1' }), test.ports)
    ).resolves.toEqual({ kind: 'skipped' })
    expect(test.pool.calls).toBe(0)
  })

  it('re-runs a job whose dead worker left the row RUNNING', async () => {
    /*
     * THE CASE THE STALL MECHANISM EXISTS FOR, and the one it did not cover.
     * The first worker claimed the run — the row says RUNNING — and was then
     * SIGKILLed, which is what a redeploy does to a job that outlives the
     * graceful window. Its lock expired, BullMQ re-delivered the job, and the
     * replacement's claim matched zero rows: the job was marked completed and
     * the run stayed RUNNING for ever, with the browser polling it every five
     * seconds for the life of the tab.
     */
    const test = harness({ recovery: true })
    test.runs.seed({ id: 'run-1', status: 'RUNNING' })

    const outcome = await processSimulationJob(
      jobPayload({ runId: 'run-1' }),
      test.ports
    )

    expect(outcome.kind).toBe('completed')
    expect(test.pool.calls).toBe(1)
    expect(test.runs.rows.get('run-1')?.status).toBe('DONE')
  })

  it('still refuses a terminal row on a recovery', async () => {
    // The guard that makes two executions harmless is unchanged: an answer that
    // is already written is never overwritten by a job that ran twice.
    const test = harness({ recovery: true })
    test.runs.seed({ id: 'run-1', status: 'DONE', durationMs: 12 })

    await expect(
      processSimulationJob(jobPayload({ runId: 'run-1' }), test.ports)
    ).resolves.toEqual({ kind: 'skipped' })
    expect(test.pool.calls).toBe(0)
  })
})

describe('a database that cannot be reached', () => {
  /*
   * A storage failure is not a failure of the work: the row was not written, so
   * the job has genuinely not been done. It is the one thing the processor
   * rethrows, because reporting it as done leaves a row QUEUED behind a job
   * Redis has already filed as finished — which nothing in the system revisits.
   */
  function brokenStore(method: 'claimRun' | 'completeRun' | 'failRun') {
    const runs = fakeRunStore()
    return {
      runs: {
        ...runs,
        [method]: () => Promise.reject(new Error('ECONNRESET')),
      },
      real: runs,
    }
  }

  it('rethrows a claim that could not be written', async () => {
    const { runs } = brokenStore('claimRun')
    const test = harness({ runs })
    await expect(
      processSimulationJob(jobPayload({ runId: 'run-1' }), test.ports)
    ).rejects.toThrow(RunStorageError)
    expect(test.pool.calls).toBe(0)
  })

  it('rethrows a completion that could not be written', async () => {
    /*
     * And does *not* record it as ENGINE_FAILED, which is what the old catch-all
     * did: a minute of engine time thrown away, and a run telling the reader
     * their circuit broke the engine during a database outage.
     */
    const { runs, real } = brokenStore('completeRun')
    real.seed({ id: 'run-1' })
    const test = harness({ runs })
    await expect(
      processSimulationJob(jobPayload({ runId: 'run-1' }), test.ports)
    ).rejects.toThrow(RunStorageError)
    expect(real.rows.get('run-1')?.errorMessage).not.toBe('ENGINE_FAILED')
  })

  it('rethrows a failure that could not be written', async () => {
    const { runs, real } = brokenStore('failRun')
    real.seed({ id: 'run-1' })
    const test = harness({
      runs,
      pool: fakePool({ failWith: 'ENGINE_FAILED' }),
    })
    await expect(
      processSimulationJob(jobPayload({ runId: 'run-1' }), test.ports)
    ).rejects.toThrow(RunStorageError)
  })
})

describe('a payload that does not parse', () => {
  it('names no run, so it fails nothing and is logged', async () => {
    const test = harness()
    const outcome = await processSimulationJob({ nonsense: true }, test.ports)
    expect(outcome).toEqual({ kind: 'skipped' })
    expect(test.runs.rows.size).toBe(0)
    expect(test.logs.some((entry) => entry.level === 'error')).toBe(true)
  })

  it('fails the run a malformed payload still names', async () => {
    /*
     * The payload does not parse and the run id in it is perfectly good — a
     * shot count past the schema's maximum, a circuit the contract refuses.
     * Skipping left that row QUEUED for ever under a log line claiming there
     * was no run to fail, which was untrue and unrecoverable: only a producer
     * other than this API can write such a job, and that is exactly the threat
     * model the second validation exists for.
     */
    const test = harness()
    test.runs.seed({ id: 'run-1' })
    const outcome = await processSimulationJob(
      { ...jobPayload({ runId: 'run-1' }), circuit: { qubits: 2 } },
      test.ports
    )
    expect(outcome).toEqual({ kind: 'failed', code: 'INVALID_CIRCUIT' })
    expect(test.runs.rows.get('run-1')).toMatchObject({
      status: 'FAILED',
      errorMessage: 'INVALID_CIRCUIT',
    })
  })
})

describe('progress', () => {
  it('reports once before any work, so a claimed job is never blank', async () => {
    const test = harness()
    test.runs.seed({ id: 'run-1' })
    await processSimulationJob(jobPayload({ runId: 'run-1' }), test.ports)
    expect(test.progress[0]).toEqual({
      phase: 'validating',
      completed: null,
      total: null,
    })
  })

  it('collapses a burst into a few writes rather than one per chunk', async () => {
    /*
     * A hundred-thousand-shot run emits 780 reports. Each write is a round trip
     * to a metered instance to say something a reader could not perceive.
     */
    const clock = vi.fn<() => number>()
    let time = 0
    clock.mockImplementation(() => time)

    const progress: JobProgress[] = Array.from({ length: 50 }, (_u, index) => ({
      phase: 'simulating' as const,
      completed: index,
      total: 50,
    }))
    const test = harness({ pool: fakePool({ progress }), now: clock })
    test.runs.seed({ id: 'run-1' })

    await processSimulationJob(jobPayload({ runId: 'run-1' }), test.ports)

    // The clock never advanced, so only the phase change earns a write on top
    // of the initial report.
    expect(test.progress).toHaveLength(2)

    time += PROGRESS_MIN_INTERVAL_MS
  })

  it('never lets a failed progress write fail the run', async () => {
    const test = harness({
      reportProgress: () => Promise.reject(new Error('redis is gone')),
    })
    test.runs.seed({ id: 'run-1' })
    await expect(
      processSimulationJob(jobPayload({ runId: 'run-1' }), test.ports)
    ).resolves.toMatchObject({ kind: 'completed' })
  })
})

describe('the completion signal', () => {
  it('never fails a run that is otherwise fine', async () => {
    const test = harness({
      signalCompletion: () => Promise.reject(new Error('redis is gone')),
    })
    test.runs.seed({ id: 'run-1' })
    await expect(
      processSimulationJob(jobPayload({ runId: 'run-1' }), test.ports)
    ).resolves.toMatchObject({ kind: 'completed' })
    expect(test.runs.rows.get('run-1')?.status).toBe('DONE')
    expect(test.logs.some((entry) => entry.level === 'warn')).toBe(true)
  })
})

describe('what the socket is told', () => {
  it('announces the claim, the progress and the completion, in that order', async () => {
    const test = harness()
    test.runs.seed({ id: 'run-1' })

    await processSimulationJob(jobPayload({ runId: 'run-1' }), test.ports)

    /*
     * `job:status` first, and it is the one a client cannot get any other way:
     * a job can sit QUEUED behind other work reporting nothing, because there
     * is nothing to report, and this is the moment the estimated duration
     * actually starts running.
     */
    expect(announced(test.published)).toEqual([
      'job:status',
      'run:progress',
      'run:complete',
    ])
    expect(test.published[0]).toMatchObject({ status: 'RUNNING' })
    expect(test.published.at(-1)).toMatchObject({
      type: 'run:complete',
      status: 'DONE',
      durationMs: 12,
      error: null,
    })
  })

  it('carries the failure code, never the engine’s prose', async () => {
    const test = harness({ pool: fakePool({ failWith: 'TIMED_OUT' }) })
    test.runs.seed({ id: 'run-1' })
    await processSimulationJob(jobPayload({ runId: 'run-1' }), test.ports)
    expect(test.published.at(-1)).toMatchObject({
      type: 'run:complete',
      status: 'FAILED',
      error: 'TIMED_OUT',
    })
  })

  it('publishes nothing at all for a job it could not claim', async () => {
    // A re-execution of a job whose first execution already finished. It writes
    // nothing, so it must announce nothing: a client that saw a second
    // completion would have it arrive after it had read the answer.
    const test = harness()
    test.runs.seed({ id: 'run-1', status: 'DONE', durationMs: 12 })
    await processSimulationJob(jobPayload({ runId: 'run-1' }), test.ports)
    expect(test.published).toEqual([])
  })

  it('announces no completion when the row went terminal underneath it', async () => {
    // The narrow window the claim alone cannot cover, seen from the socket's
    // side: the answer is discarded, so nothing may be announced about it
    // either — a `run:complete` here would tell a client the run succeeded when
    // the row says it timed out.
    const pool = fakePool({ hold: true })
    const test = harness({ pool })
    test.runs.seed({ id: 'run-1' })

    const running = processSimulationJob(
      jobPayload({ runId: 'run-1' }),
      test.ports
    )
    await Promise.resolve()
    await test.runs.failRun({ id: 'run-1', code: 'TIMED_OUT', durationMs: 1 })
    pool.release()
    await running

    expect(announced(test.published)).not.toContain('run:complete')
  })

  it('reports progress to both sinks on one schedule', async () => {
    /*
     * The BullMQ progress field and the socket are the same report delivered
     * two ways, not two schedules that happen to be similar — a client that
     * polls `GET /simulate/:runId` across a reconnect must not see a different
     * position from the one the socket last pushed.
     */
    const test = harness()
    test.runs.seed({ id: 'run-1' })
    await processSimulationJob(jobPayload({ runId: 'run-1' }), test.ports)

    const pushed = test.published
      .filter((event) => event.type === 'run:progress')
      .map((event) => event.progress)
    expect(pushed).toEqual(test.progress)
  })

  it('runs perfectly with nowhere to publish', async () => {
    // A worker whose publish port is absent is a worker that works: the client
    // falls back to polling, which is what it does across a reconnect anyway.
    const test = harness({ publish: undefined })
    test.runs.seed({ id: 'run-1' })
    const outcome = await processSimulationJob(
      jobPayload({ runId: 'run-1' }),
      test.ports
    )
    expect(outcome).toMatchObject({ kind: 'completed' })
  })
})
