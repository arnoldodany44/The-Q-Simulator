/**
 * The messages between the worker process and the child that runs a
 * simulation.
 *
 * Both sides import this file and nothing else of each other's, so the protocol
 * is a compile error away from drifting — the same arrangement, and the same
 * argument, as `protocol.ts` between the browser's editor and its Web Worker.
 *
 * ── One job per message, and no request id ────────────────────────────────
 *
 * Unlike the browser's protocol there is no correlation id here, because a
 * child runs exactly one job at a time by construction: the pool hands a child
 * a job, waits for a terminal message, and only then makes it available again.
 * An id would be ceremony around an invariant the pool already enforces, and it
 * would suggest a concurrency the child does not have — a child with two jobs
 * in flight would be two synchronous kernel loops interleaved on one event
 * loop, which is to say one of them starved.
 *
 * ── Nothing large crosses this boundary ───────────────────────────────────
 *
 * The child sends back a `SimulationRunResult`, which is bounded to a few
 * kilobytes by construction (`boundOutcomes`), never a statevector. `fork`'s
 * IPC channel serialises with JSON, so a 256 MB Float64Array would be
 * stringified, copied and parsed — turning an in-memory result into minutes of
 * garbage collection. The reduction happens inside the child, where the state
 * already is.
 */

import type {
  JobProgress,
  SimulationFailureCode,
  SimulationJobPayload,
  SimulationRunResult,
} from '@qsim/jobs'

/** Parent → child. The only instruction a child ever receives. */
export interface RunCommand {
  readonly type: 'run'
  readonly payload: SimulationJobPayload
  /**
   * The ceilings this child must apply, passed in rather than read from the
   * environment.
   *
   * A child inherits `process.env`, so it *could* parse its own — and then a
   * pool and its children could disagree about the qubit ceiling with nothing
   * to reveal it. One source, handed down.
   */
  readonly ceilings: { readonly maxQubits: number; readonly timeoutMs: number }
}

/** Child → parent. */
export type ChildMessage =
  /** Sent once, on startup, before any job. The pool waits for it. */
  | { readonly type: 'ready' }
  | { readonly type: 'progress'; readonly progress: JobProgress }
  | { readonly type: 'done'; readonly result: SimulationRunResult }
  | {
      readonly type: 'failed'
      readonly code: SimulationFailureCode
      /** The engine's own English text. For the worker's log, never stored. */
      readonly detail: string
    }

/** Narrows a value that arrived over IPC, which is by definition untrusted. */
export function isChildMessage(value: unknown): value is ChildMessage {
  if (typeof value !== 'object' || value === null) return false
  const type = (value as { type?: unknown }).type
  return (
    type === 'ready' ||
    type === 'progress' ||
    type === 'done' ||
    type === 'failed'
  )
}
