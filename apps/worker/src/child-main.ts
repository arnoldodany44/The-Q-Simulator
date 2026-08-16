/**
 * The message handling a forked simulation child does, and nothing else.
 *
 * Deliberately almost empty. Everything interesting is in `simulate.ts`, which
 * is a plain function and is tested as one; this is the wiring around it, and it
 * is kept this thin because a bug *here* is a bug in a process with no logger,
 * no error reporting and no test runner attached.
 *
 * Separate from `simulate.child.ts` — which is three lines that call
 * `childMain(process)` — so that the protocol can be exercised against a
 * stand-in host. Importing an entry point to test it would install handlers on
 * the test runner's own process.
 *
 * ── It holds nothing between jobs ─────────────────────────────────────────
 *
 * No cache, no memo, no module-level state of any kind. Children are reused
 * across jobs (forking is not free), so anything retained would be state one
 * stranger's job could observe from another's — and would also be state that
 * survives into the next allocation, which is the one thing a process that has
 * held a 256 MB typed array cannot afford.
 *
 * ── It never exits on its own ─────────────────────────────────────────────
 *
 * Not after a job, not after a failure. The pool owns this process's lifetime:
 * it kills a child that timed out, retires one that has run enough jobs, and
 * kills the rest at shutdown. A child that exited by itself would be
 * indistinguishable from one that crashed, and `WORKER_CRASHED` would stop
 * meaning anything.
 */

import { failureCodeOf } from '@qsim/jobs'
import type { JobProgress } from '@qsim/jobs'
import { isChildMessage } from './child-protocol.js'
import type { ChildMessage, RunCommand } from './child-protocol.js'
import { runSimulationJob } from './simulate.js'

/** The half of a `process` this module uses, so a test can pass a stand-in. */
export interface ChildHost {
  send?: (message: ChildMessage) => unknown
  on: (event: 'message', listener: (value: unknown) => void) => unknown
}

function isRunCommand(value: unknown): value is RunCommand {
  return (
    typeof value === 'object' &&
    value !== null &&
    (value as { type?: unknown }).type === 'run' &&
    // `isChildMessage` narrows the other direction; a run command is not one.
    !isChildMessage(value)
  )
}

/** Wires a host to the simulation, answering exactly once per command. */
export function childMain(host: ChildHost): void {
  host.on('message', (value: unknown) => {
    if (!isRunCommand(value)) return

    const report = (progress: JobProgress): void => {
      host.send?.({ type: 'progress', progress })
    }

    try {
      const result = runSimulationJob(value.payload, report, value.ceilings)
      host.send?.({ type: 'done', result })
    } catch (error) {
      /*
       * Every failure becomes a message, never an uncaught throw. An uncaught
       * throw here would kill the child and the pool would report
       * WORKER_CRASHED — losing the one thing that was known about the failure,
       * which is what it was.
       */
      host.send?.({
        type: 'failed',
        code: failureCodeOf(error),
        detail: error instanceof Error ? error.message : String(error),
      })
    }
  })

  host.send?.({ type: 'ready' })
}
