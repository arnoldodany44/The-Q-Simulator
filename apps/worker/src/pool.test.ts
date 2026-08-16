/**
 * The pool, against a fake child.
 *
 * These are the tests the milestone's hardest sentence rests on: "a job that
 * exceeds its bound must be killed rather than allowed to hold the process".
 * Every assertion below is about the *mechanism* — dispatch, kill, replace —
 * and none about physics, which is `simulate.test.ts`'s job.
 */

import { fileURLToPath } from 'node:url'
import { SimulationFailure } from '@qsim/jobs'
import { afterEach, describe, expect, it } from 'vitest'
import { createPool } from './pool.js'
import type { SimulationPool } from './pool.js'
import { jobPayload } from './testing/payloads.js'

const CHILD = fileURLToPath(
  new URL('./testing/fake-child.mjs', import.meta.url)
)

const CEILINGS = { maxQubits: 24, timeoutMs: 60_000 }

let pool: SimulationPool | null = null

function makePool(overrides: Partial<Parameters<typeof createPool>[0]> = {}) {
  pool = createPool({
    size: 2,
    childPath: CHILD,
    timeoutMs: 2_000,
    ceilings: CEILINGS,
    ...overrides,
  })
  return pool
}

afterEach(async () => {
  // Not optional. A leaked child is a process that outlives the suite, and on
  // a machine running `pnpm verify` in a loop that is how a laptop ends up with
  // forty orphaned node processes.
  await pool?.close()
  pool = null
})

describe('running a job', () => {
  it('forks a child, runs the job and answers', async () => {
    const result = await makePool().run(jobPayload({ runId: 'ok:0' }))
    expect(result.resultVersion).toBe(1)
  })

  it('reuses the child rather than forking one per job', async () => {
    const worker = makePool()
    await worker.run(jobPayload({ runId: 'ok:0' }))
    await worker.run(jobPayload({ runId: 'ok:0' }))
    expect(worker.size()).toBe(1)
  })

  it('passes progress through to the caller', async () => {
    const seen: number[] = []
    await makePool().run(jobPayload({ runId: 'progress:3' }), {
      onProgress: (progress) => seen.push(progress.completed ?? -1),
    })
    expect(seen).toEqual([1, 2, 3])
  })

  it('surfaces a failure the child reported, with its code intact', async () => {
    await expect(
      makePool().run(jobPayload({ runId: 'fail:LIMIT_EXCEEDED' }))
    ).rejects.toMatchObject({ code: 'LIMIT_EXCEEDED' })
  })
})

describe('the wall-clock bound', () => {
  it('kills a child that will not stop, and says it timed out', async () => {
    /*
     * THE TEST THIS WHOLE DESIGN EXISTS FOR. The fake child is inside a
     * synchronous `for(;;)` loop: no timer fires in it, no promise resolves in
     * it, and a SIGTERM handler would never be reached. Only a signal the
     * kernel delivers stops it, which is why the simulation is in a child
     * process at all.
     */
    const worker = makePool({ timeoutMs: 200 })
    const failure = await worker
      .run(jobPayload({ runId: 'hang' }))
      .catch((error: unknown) => error)

    expect(failure).toBeInstanceOf(SimulationFailure)
    expect((failure as SimulationFailure).code).toBe('TIMED_OUT')
  })

  it('leaves the pool usable afterwards, on a replacement child', async () => {
    const worker = makePool({ timeoutMs: 200 })
    await worker.run(jobPayload({ runId: 'hang' })).catch(() => undefined)
    const result = await worker.run(jobPayload({ runId: 'ok:0' }))
    expect(result.resultVersion).toBe(1)
  })

  it('honours a per-job bound over the pool default', async () => {
    const worker = makePool({ timeoutMs: 30_000 })
    await expect(
      worker.run(jobPayload({ runId: 'hang' }), { timeoutMs: 150 })
    ).rejects.toMatchObject({ code: 'TIMED_OUT' })
  })
})

describe('a child that dies', () => {
  it('is reported as a crash rather than hanging forever', async () => {
    // A child that exits without a terminal message — an OOM kill, a segfault,
    // a platform eviction. Without the `exit` handler the promise would never
    // settle and the BullMQ job would sit active until its lock expired.
    await expect(
      makePool().run(jobPayload({ runId: 'crash' }))
    ).rejects.toMatchObject({ code: 'WORKER_CRASHED' })
  })

  it('does not take the pool down with it', async () => {
    const worker = makePool()
    await worker.run(jobPayload({ runId: 'crash' })).catch(() => undefined)
    await expect(
      worker.run(jobPayload({ runId: 'ok:0' }))
    ).resolves.toMatchObject({ resultVersion: 1 })
  })
})

describe('concurrency', () => {
  it('does not let a long job starve a short one', async () => {
    /*
     * The claim that a single process cannot make. The first job spins
     * *synchronously* for 800 ms — inside one process it would hold the event
     * loop for all of it — and the second must still finish first, because the
     * operating system is scheduling two processes rather than one event loop
     * taking turns with itself.
     */
    const worker = makePool({ size: 2 })
    const order: string[] = []

    const slow = worker
      .run(jobPayload({ runId: 'spin:800' }))
      .then(() => order.push('slow'))
    const quick = worker
      .run(jobPayload({ runId: 'ok:0' }))
      .then(() => order.push('quick'))

    await Promise.all([slow, quick])
    expect(order).toEqual(['quick', 'slow'])
  })

  it('never exceeds its size, queueing the rest', async () => {
    const worker = makePool({ size: 2 })
    const jobs = Array.from({ length: 5 }, () =>
      worker.run(jobPayload({ runId: 'ok:10' }))
    )
    await Promise.all(jobs)
    expect(worker.size()).toBeLessThanOrEqual(2)
  })

  it('dispatches queued jobs in the order they arrived', async () => {
    // FIFO, so a job that arrived first cannot be starved by a stream of later
    // ones — the failure a "pick any free slot" implementation produces under
    // load and never under test.
    const worker = makePool({ size: 1 })
    const finished: number[] = []
    await Promise.all(
      [0, 1, 2].map((index) =>
        worker
          .run(jobPayload({ runId: 'ok:0' }))
          .then(() => finished.push(index))
      )
    )
    expect(finished).toEqual([0, 1, 2])
  })
})

describe('child lifetime', () => {
  it('retires a child after enough jobs', async () => {
    /*
     * Not a leak workaround: a process that has held one large contiguous typed
     * array does not give that address space back promptly, and the next job's
     * allocation is the one that fails.
     */
    const worker = makePool({ size: 1, maxJobsPerChild: 2 })
    await worker.run(jobPayload({ runId: 'ok:0' }))
    await worker.run(jobPayload({ runId: 'ok:0' }))
    expect(worker.size()).toBe(0)

    await expect(
      worker.run(jobPayload({ runId: 'ok:0' }))
    ).resolves.toMatchObject({ resultVersion: 1 })
  })
})

describe('close', () => {
  it('kills every child', async () => {
    const worker = makePool()
    await worker.run(jobPayload({ runId: 'ok:0' }))
    expect(worker.size()).toBe(1)
    await worker.close()
    expect(worker.size()).toBe(0)
  })

  it('settles a job that was in flight rather than leaving it pending', async () => {
    // A shutdown that hangs on a promise nobody will settle is exactly the
    // failure this file exists to make impossible.
    const worker = makePool({ timeoutMs: 30_000 })
    const inFlight = worker.run(jobPayload({ runId: 'hang' }))
    await new Promise((resolve) => setTimeout(resolve, 100))
    await worker.close()
    await expect(inFlight).rejects.toMatchObject({ code: 'WORKER_CRASHED' })
  })

  it('refuses new work once closed', async () => {
    const worker = makePool()
    await worker.close()
    await expect(
      worker.run(jobPayload({ runId: 'ok:0' }))
    ).rejects.toMatchObject({ code: 'WORKER_CRASHED' })
  })

  it('is safe to call twice', async () => {
    const worker = makePool()
    await worker.close()
    await expect(worker.close()).resolves.toBeUndefined()
  })
})
