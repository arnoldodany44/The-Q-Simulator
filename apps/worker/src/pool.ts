/**
 * A pool of child processes, each of which runs one simulation at a time.
 *
 * ══════════════════════════════════════════════════════════════════════════
 * THIS FILE IS THE MILESTONE. Everything else here is plumbing around it.
 * ══════════════════════════════════════════════════════════════════════════
 *
 * ── The problem, stated exactly ───────────────────────────────────────────
 *
 * A simulation is a synchronous loop. `run()` in `@qsim/core` walks a circuit
 * applying gates in place, and a twenty-four-qubit gate is a single pass over
 * sixteen million amplitudes with no `await` anywhere in it — deliberately, and
 * correctly, because that is what makes it fast (§5.2).
 *
 * JavaScript has exactly one way to stop such a loop, and it is to not be
 * inside it. A `setTimeout` does not fire while the loop runs; it fires after,
 * which is the one moment its firing is useless. `AbortController` is
 * cooperative and there is nothing to cooperate. `worker_threads` can be
 * terminated mid-execution, and that is a genuine option — but a thread shares
 * the process's heap, so a job that reserves four gigabytes takes the whole
 * worker down with it, including the seven other jobs that were behaving.
 *
 * So the simulation runs in a **child process**, and the bound is enforced with
 * a signal. `SIGKILL` is not cooperative, not interceptable and not subject to
 * the child's event loop; it works precisely as well against a tight numeric
 * loop as against an idle process. That is the only mechanism in this runtime
 * that actually satisfies §11's "ejecución en un worker aislado que se puede
 * matar", and every other property below falls out of the same decision:
 *
 *   - **Memory is isolated.** A child that reserves more than the container
 *     allows is killed by the OS or by V8, and the pool sees an exit code
 *     rather than a dead worker. `WORKER_CRASHED` is that case, and it is
 *     distinct from `ENGINE_FAILED` because there is no exception to read.
 *
 *   - **Concurrency is real.** Two jobs in two processes are scheduled by the
 *     operating system, so a sixty-second job cannot starve a fifty-millisecond
 *     one. Inside a single process, "concurrency: 2" over synchronous work is
 *     not concurrency at all — it is two jobs taking turns, in whatever order
 *     the first one's loop happens to end.
 *
 *   - **And the one that is easy to miss: BullMQ's lock keeps being renewed.**
 *     A worker renews its hold on a job from its *own event loop*, every few
 *     seconds. If the simulation ran inline, a thirty-second kernel loop would
 *     block every renewal, the lock would expire, the job would be declared
 *     stalled, and a second worker would pick it up — while the first was still
 *     running it, and would go on to write its result. Two executions, both
 *     visible, from nothing worse than a slow circuit. Moving the arithmetic
 *     out of the event loop is what makes `LOCK_DURATION_MS` mean anything.
 *
 * ── What this costs, honestly ─────────────────────────────────────────────
 *
 * A fork is tens of milliseconds and a fresh V8 heap, so children are reused
 * rather than created per job — and retired after `maxJobsPerChild`, because a
 * process that has held a 256 MB typed array once has a heap that will not give
 * that address space back cheaply, and the next job's allocation is the one
 * that fails. Reuse also means a job cannot see the previous job's data: the
 * child holds no state between jobs by construction (see `simulate.child.ts`),
 * and anything it did allocate is unreachable the moment the job returns.
 */

import { fork } from 'node:child_process'
import type { ChildProcess } from 'node:child_process'
import { SimulationFailure } from '@qsim/jobs'
import type {
  JobProgress,
  SimulationJobPayload,
  SimulationRunResult,
} from '@qsim/jobs'
import { isChildMessage } from './child-protocol.js'
import type { RunCommand } from './child-protocol.js'

export interface PoolOptions {
  /** How many children may exist, and therefore how many jobs may run at once. */
  readonly size: number
  /** The module a child runs. Bundled beside `worker.js`; overridden by tests. */
  readonly childPath: string
  /** The wall-clock bound, enforced with SIGKILL. */
  readonly timeoutMs: number
  /** Ceilings the child re-applies before it allocates anything. */
  readonly ceilings: { readonly maxQubits: number; readonly timeoutMs: number }
  /**
   * Jobs a child may run before it is retired.
   *
   * Not a leak workaround. A simulation's peak allocation is a single
   * contiguous typed array, and V8 does not return that address space to the
   * OS promptly — so the fifth large job in one child can fail an allocation
   * the first one made comfortably. Retiring is cheaper than diagnosing that.
   */
  readonly maxJobsPerChild?: number
  /** How long a child gets to say `ready` before it is written off. */
  readonly startupTimeoutMs?: number
}

export interface RunOptions {
  readonly onProgress?: (progress: JobProgress) => void
  /** Overrides the pool default, for a job with its own bound. */
  readonly timeoutMs?: number
}

export interface SimulationPool {
  /**
   * Runs one job, resolving with its bounded result.
   *
   * Rejects with a `SimulationFailure` carrying the code the run row should
   * record: `TIMED_OUT` for the bound, `WORKER_CRASHED` for a child that died
   * without answering, and whatever the child itself reported otherwise.
   */
  run(
    payload: SimulationJobPayload,
    options?: RunOptions
  ): Promise<SimulationRunResult>
  /** Children currently alive. For the tests and for a log line at shutdown. */
  size(): number
  /** Kills every child. Safe to call twice. */
  close(): Promise<void>
}

const DEFAULT_MAX_JOBS_PER_CHILD = 32
const DEFAULT_STARTUP_TIMEOUT_MS = 10_000

interface Slot {
  readonly child: ChildProcess
  jobsRun: number
  busy: boolean
  /** Set while a job is in flight, so `exit` can reject the right promise. */
  settle: ((outcome: Settlement) => void) | null
}

type Settlement =
  | { readonly ok: true; readonly result: SimulationRunResult }
  | { readonly ok: false; readonly failure: SimulationFailure }

export function createPool(options: PoolOptions): SimulationPool {
  const maxJobs = options.maxJobsPerChild ?? DEFAULT_MAX_JOBS_PER_CHILD
  const startupTimeoutMs =
    options.startupTimeoutMs ?? DEFAULT_STARTUP_TIMEOUT_MS

  const slots: Slot[] = []
  /** FIFO, so a job that arrived first is dispatched first and cannot starve. */
  const waiting: ((slot: Slot | null) => void)[] = []
  /**
   * Children being forked right now.
   *
   * Counted separately from `slots` because a child only joins `slots` once it
   * has said `ready`, which is tens of milliseconds after `fork` returns.
   * Without this, a burst of jobs arriving in one tick each sees an empty pool
   * and each starts its own child: five jobs against a pool of two forked five
   * processes, and the size limit — which is a memory limit, since every child
   * may hold a 256 MB typed array — silently was not one.
   */
  let pending = 0
  let closed = false

  function spawn(): Promise<Slot> {
    const child = fork(options.childPath, [], {
      /*
       * `ipc` is what `process.send` needs; stdout and stderr are inherited so
       * a child that dies before it can speak the protocol still leaves its
       * stack in the worker's own logs, which is the only place it would ever
       * appear.
       */
      stdio: ['ignore', 'inherit', 'inherit', 'ipc'],
      /*
       * A child never needs the parent's arguments and must not inherit an
       * inspector port: forking with `--inspect` in `execArgv` makes every
       * child fail to bind the same port, which presents as "the pool stopped
       * working" only when somebody happens to be debugging.
       */
      execArgv: [],
    })

    const slot: Slot = { child, jobsRun: 0, busy: false, settle: null }

    child.on('message', (message: unknown) => {
      if (!isChildMessage(message)) return
      if (message.type === 'ready') return
      const settle = slot.settle
      if (settle === null) return
      if (message.type === 'done') {
        settle({ ok: true, result: message.result })
      } else if (message.type === 'failed') {
        settle({
          ok: false,
          failure: new SimulationFailure(message.code, message.detail),
        })
      }
      // 'progress' is handled by the per-job listener installed in `run`.
    })

    child.on('exit', () => {
      /*
       * The one place a job can be lost without this. A child that segfaults,
       * is OOM-killed, or is killed by the timeout below never sends a terminal
       * message, so the promise would hang forever and the BullMQ job would sit
       * active until its lock expired. Settling here turns "silence" into a
       * failure with a code.
       */
      slot.settle?.({
        ok: false,
        failure: new SimulationFailure(
          'WORKER_CRASHED',
          'the simulation child exited without answering'
        ),
      })
      retire(slot)
    })

    return new Promise<Slot>((resolve, reject) => {
      const timer = setTimeout(() => {
        child.kill('SIGKILL')
        reject(
          new SimulationFailure(
            'WORKER_CRASHED',
            `a simulation child did not start within ${String(startupTimeoutMs)} ms`
          )
        )
      }, startupTimeoutMs)

      child.once('message', (message: unknown) => {
        if (!isChildMessage(message) || message.type !== 'ready') return
        clearTimeout(timer)
        slots.push(slot)
        resolve(slot)
      })

      child.once('error', (error) => {
        clearTimeout(timer)
        reject(
          new SimulationFailure(
            'WORKER_CRASHED',
            'a simulation child could not be started',
            { cause: error }
          )
        )
      })
    })
  }

  function retire(slot: Slot): void {
    const index = slots.indexOf(slot)
    if (index >= 0) slots.splice(index, 1)
    slot.busy = false
    slot.settle = null
    if (!slot.child.killed) slot.child.kill('SIGKILL')
    // A waiter must not be left holding a dead slot, so retiring never hands
    // this one on — the next `acquire` forks a replacement instead.
    void pump()
  }

  /** Gives the next waiter a free child, forking one if the pool has room. */
  async function pump(): Promise<void> {
    if (closed) return
    if (waiting.length === 0) return

    const free = slots.find((slot) => !slot.busy)
    if (free !== undefined) {
      const next = waiting.shift()
      if (next === undefined) return
      free.busy = true
      next(free)
      return
    }

    if (slots.length + pending >= options.size) return
    pending++
    try {
      const slot = await spawn()
      if (closed) {
        slot.child.kill('SIGKILL')
        return
      }
      const next = waiting.shift()
      if (next === undefined) return
      slot.busy = true
      next(slot)
    } catch {
      /*
       * A child that cannot be started must not hang every queued job. One
       * waiter is released as a failure — the one that asked for this child —
       * and the rest stay in line for whichever child does start.
       */
      waiting.shift()?.(null)
    } finally {
      pending--
    }
  }

  function acquire(): Promise<Slot> {
    return new Promise<Slot>((resolve, reject) => {
      waiting.push((slot) => {
        if (slot === null) {
          reject(
            new SimulationFailure(
              'WORKER_CRASHED',
              'no simulation child could be started'
            )
          )
          return
        }
        resolve(slot)
      })
      void pump()
    })
  }

  function release(slot: Slot): void {
    slot.busy = false
    slot.settle = null
    slot.jobsRun++
    if (slot.jobsRun >= maxJobs) {
      retire(slot)
      return
    }
    void pump()
  }

  return {
    async run(payload, runOptions = {}) {
      if (closed) {
        throw new SimulationFailure(
          'WORKER_CRASHED',
          'the simulation pool is closed'
        )
      }

      const slot = await acquire()
      const timeoutMs = runOptions.timeoutMs ?? options.timeoutMs

      const onProgress = runOptions.onProgress
      const progressListener = (message: unknown): void => {
        if (!isChildMessage(message) || message.type !== 'progress') return
        onProgress?.(message.progress)
      }
      slot.child.on('message', progressListener)

      let timer: NodeJS.Timeout | undefined
      try {
        const settlement = await new Promise<Settlement>((resolve) => {
          let settled = false
          slot.settle = (outcome) => {
            if (settled) return
            settled = true
            resolve(outcome)
          }

          timer = setTimeout(() => {
            /*
             * THE KILL. Not `child.kill()` (SIGTERM), which a child inside a
             * synchronous loop would never get round to handling, and not a
             * cooperative flag, which nothing is checking. SIGKILL is delivered
             * by the kernel and the process stops mid-instruction.
             *
             * The rejection is raised here rather than left to the `exit`
             * handler so the code is TIMED_OUT — "we admitted this and were
             * wrong about how long it would take" — instead of WORKER_CRASHED,
             * which would be an accurate description of a process that was
             * killed and a useless one for whoever is reading the run.
             */
            slot.child.kill('SIGKILL')
            slot.settle?.({
              ok: false,
              failure: new SimulationFailure(
                'TIMED_OUT',
                `the simulation exceeded its ${String(timeoutMs)} ms bound and was killed`
              ),
            })
          }, timeoutMs)

          const command: RunCommand = {
            type: 'run',
            payload,
            ceilings: options.ceilings,
          }
          slot.child.send(command, (error) => {
            if (error === null) return
            slot.settle?.({
              ok: false,
              failure: new SimulationFailure(
                'WORKER_CRASHED',
                'the simulation child could not be reached',
                { cause: error }
              ),
            })
          })
        })

        if (!settlement.ok) throw settlement.failure
        return settlement.result
      } finally {
        clearTimeout(timer)
        slot.child.off('message', progressListener)
        // A killed child is already out of `slots` via its `exit` handler;
        // `release` on a retired slot is a no-op that only counts a job.
        if (!slot.child.killed) release(slot)
      }
    },

    size() {
      return slots.length
    },

    async close() {
      closed = true
      for (const slot of [...slots]) {
        slot.settle?.({
          ok: false,
          failure: new SimulationFailure(
            'WORKER_CRASHED',
            'the simulation pool was closed while this job was running'
          ),
        })
        slot.child.kill('SIGKILL')
      }
      slots.length = 0
      // Waiters are released as failures rather than left pending: a shutdown
      // that hangs on a promise nobody will settle is the failure this whole
      // file exists to make impossible.
      while (waiting.length > 0) {
        waiting.shift()?.(null)
      }
      await Promise.resolve()
    },
  }
}
