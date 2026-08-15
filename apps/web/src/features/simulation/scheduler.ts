/**
 * The orchestration half of M0.6: when to simulate, what to invalidate, and
 * which answers to believe.
 *
 * There is no worker in this file and no React either. Everything that decides
 * whether the editor feels alive or haunted is here, as a plain object with a
 * `post` callback — because the two failure modes this milestone exists to
 * prevent are both timing bugs, and a timing bug that can only be reproduced
 * through a real `Worker` is a timing bug that never gets a regression test.
 *
 * ────────────────────────────────────────────────────────────────────────
 * 1. DEBOUNCE (150 ms, §5.6.4). Dragging a slider emits an edit per frame.
 * Each one restarts the timer, so a continuous drag costs exactly one
 * simulation — the one after the user stops.
 *
 * 2. STALENESS. Ids only go up, and exactly one request is in flight at a
 * time. `receive` compares against that id and drops anything else on the
 * floor. This is the guard that keeps a superseded result from repainting the
 * analysis panel, and it is unconditional: there is no path through this file
 * where an answer to an old question reaches the UI.
 *
 * 3. INVALIDATION THAT SURVIVES CANCELLATION. This is the subtle one. The
 * worker resumes from a checkpoint, so every request carries the earliest
 * column that changed since the worker's cache was last known to be correct —
 * which is *not* the same as the earliest column of the latest edit. If an
 * edit at column 5 is superseded before its job ever runs, and the next
 * request only mentions column 20, the worker would resume from a checkpoint
 * that predates the column-5 edit and return a state belonging to no circuit.
 * So `dirtyFrom` accumulates a minimum and is only cleared by an *analytic
 * result*, which is the one event proving the worker's cache caught up. A
 * cancelled or dropped job clears nothing, an error clears nothing, and a
 * trajectories result clears nothing either: sampling runs from scratch and
 * never touches the checkpoint cache (`job.ts` — a cached mid-circuit state
 * would freeze one roll of the dice), so its answer is evidence about the
 * histogram and about nothing else.
 *
 * The cost of being wrong is asymmetric — too early replays a few columns, too
 * late is silently false physics — so every uncertainty here resolves towards
 * invalidating more.
 */

import type { ExecutionMode } from '@qsim/core'
import { MAX_COLUMNS, type Circuit } from '@qsim/schema'

import { earliestChangedColumn } from './invalidation'
import {
  MAX_CLIENT_QUBITS,
  decodeResult,
  type RequestId,
  type SimulateRequest,
  type SimulationFailure,
  type SimulationOutcome,
  type SimulationRequest,
  type SimulationResponse,
  type TransportKind,
} from './protocol'

/** §5.6.4. Long enough to swallow a slider drag, short enough to feel live. */
export const SIMULATION_DEBOUNCE_MS = 150

/**
 * Shots for a trajectories run when the caller does not say. 1024 is the
 * Qiskit default, which makes a histogram here comparable to one from a
 * notebook without anyone converting anything.
 */
export const DEFAULT_SHOTS = 1024

/**
 * Seed for a trajectories run when the caller does not say. Fixed rather than
 * random: an editor that returns a different histogram every time you touch an
 * unrelated gate looks broken, and shot noise the user did not ask for is
 * exactly what §5.3 warns about. Pass a seed to shuffle deliberately.
 */
export const DEFAULT_SEED = 1

/**
 * A column no circuit can reach — the contract caps `column` at
 * `MAX_COLUMNS - 1`. Sent as `fromColumn` when a re-run is needed but nothing
 * about the circuit changed (the caller switched modes, say), where it means
 * "invalidate nothing, resume from the last checkpoint".
 */
const NOTHING_INVALIDATED = MAX_COLUMNS

export type SimulationStatus =
  'idle' | 'scheduled' | 'running' | 'ready' | 'error'

/**
 * What the UI renders. The previous outcome survives a new request on purpose:
 * a histogram that blanks for 150 ms on every keystroke is worse than one that
 * is briefly one edit behind, and `status` says which it is.
 */
export interface SimulationSnapshot {
  readonly status: SimulationStatus
  readonly outcome: SimulationOutcome | null
  readonly failure: SimulationFailure | null
  /** Worker time of the last completed run, in milliseconds. */
  readonly durationMs: number | null
  /** How the last state crossed the thread boundary; null for counts. */
  readonly transport: TransportKind | null
}

export interface RunOptions {
  readonly mode?: ExecutionMode
  readonly shots?: number
  readonly seed?: number
}

export interface SchedulerOptions {
  readonly debounceMs?: number
  /** Whether the main thread can receive a `SharedArrayBuffer`. */
  readonly sharedMemory?: boolean
}

/** Where messages go. The scheduler's only side effect. */
export type Transport = (request: SimulationRequest) => void

/**
 * Every member is a property holding a closure rather than a method, and that
 * is deliberate: a scheduler has no `this`, and `subscribe` and `getSnapshot`
 * are handed to `useSyncExternalStore` detached from the object they came
 * from. Declaring them as methods would make that an unbound-method lint error
 * at the one call site that matters.
 */
export interface SimulationScheduler {
  /** For `useSyncExternalStore`. */
  readonly subscribe: (listener: () => void) => () => void
  readonly getSnapshot: () => SimulationSnapshot

  /**
   * Point the scheduler at a worker, or at nothing. The transport lives inside
   * the scheduler rather than being captured at construction because the
   * worker outlives neither the scheduler nor React's idea of when it may be
   * replaced, and a scheduler that owns its own connection is the only version
   * of this that does not have a component mutating a value it holds.
   *
   * A request dispatched while nothing is connected is dropped; the hook
   * connects on mount and resets before it disconnects, so the only window is
   * a worker that never spawned, whose failure is already on screen.
   */
  readonly connect: (transport: Transport | null) => void

  /**
   * Ask for `circuit` to be simulated. Debounced, coalesced, and a no-op when
   * the circuit is unchanged in every way the engine can see.
   */
  readonly schedule: (circuit: Circuit, options?: RunOptions) => void
  /** Dispatch the pending request now, skipping the debounce. */
  readonly flush: () => void
  /** A message from the worker. Returns false when it was stale and dropped. */
  readonly receive: (response: SimulationResponse) => boolean
  /** A failure with no request behind it — the worker itself broke. */
  readonly fail: (failure: SimulationFailure) => void
  /** Drop the pending request and disown whatever is in flight. */
  readonly cancel: () => void
  /** Forget everything, including what the worker's cache is assumed to hold. */
  readonly reset: () => void
  readonly dispose: () => void
}

const IDLE: SimulationSnapshot = {
  status: 'idle',
  outcome: null,
  failure: null,
  durationMs: null,
  transport: null,
}

export function createSimulationScheduler(
  options: SchedulerOptions = {}
): SimulationScheduler {
  const debounceMs = options.debounceMs ?? SIMULATION_DEBOUNCE_MS
  const sharedMemory = options.sharedMemory ?? false

  let send: Transport | null = null
  const listeners = new Set<() => void>()
  let snapshot: SimulationSnapshot = IDLE

  let outcome: SimulationOutcome | null = null
  let failure: SimulationFailure | null = null
  let durationMs: number | null = null
  let transport: TransportKind | null = null

  let timer: ReturnType<typeof setTimeout> | null = null
  let pending: { circuit: Circuit; run: ResolvedRun } | null = null
  let inFlight: RequestId | null = null
  let lastId = 0

  /** The circuit the last `schedule` call saw, for the next diff. */
  let lastScheduled: Circuit | undefined
  let lastRun: ResolvedRun | undefined
  /** Earliest column not yet reflected in the worker's checkpoint cache. */
  let dirtyFrom: number | null = null
  /** The same, restricted to edits that arrived after the last dispatch. */
  let sinceDispatch: number | null = null

  function statusOf(): SimulationStatus {
    if (pending !== null) return 'scheduled'
    if (inFlight !== null) return 'running'
    if (failure !== null) return 'error'
    if (outcome !== null) return 'ready'
    return 'idle'
  }

  function publish(): void {
    const next: SimulationSnapshot = {
      status: statusOf(),
      outcome,
      failure,
      durationMs,
      transport,
    }
    if (
      next.status === snapshot.status &&
      next.outcome === snapshot.outcome &&
      next.failure === snapshot.failure &&
      next.durationMs === snapshot.durationMs &&
      next.transport === snapshot.transport
    ) {
      // Same object out means `useSyncExternalStore` sees no change, which is
      // what keeps a re-render from being scheduled for nothing.
      return
    }
    snapshot = next
    for (const listener of listeners) listener()
  }

  function clearTimer(): void {
    if (timer === null) return
    clearTimeout(timer)
    timer = null
  }

  function disown(): void {
    if (inFlight === null) return
    // The worker cannot always act on this — see `simulation.worker.ts` — but
    // it costs one message and saves copying a 16 MB state back that nobody
    // would look at.
    send?.({ kind: 'cancel', id: inFlight })
    inFlight = null
  }

  function dispatch(): void {
    clearTimer()
    if (pending === null) return

    disown()
    lastId += 1
    inFlight = lastId

    const request = buildRequest(
      lastId,
      pending.circuit,
      dirtyFrom ?? NOTHING_INVALIDATED,
      pending.run,
      sharedMemory
    )
    pending = null
    // Reset the post-dispatch accumulator, not `dirtyFrom`: only a result
    // proves the worker's cache advanced. See the header, point 3.
    sinceDispatch = null
    send?.(request)
    publish()
  }

  return {
    subscribe(listener) {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },

    getSnapshot() {
      return snapshot
    },

    connect(transportTo) {
      send = transportTo
    },

    schedule(circuit, run = {}) {
      const resolved = resolveRun(run)
      const changedColumn = earliestChangedColumn(lastScheduled, circuit)
      const changedRun = lastRun === undefined || !sameRun(lastRun, resolved)
      lastScheduled = circuit
      lastRun = resolved

      dirtyFrom = lowest(dirtyFrom, changedColumn)
      sinceDispatch = lowest(sinceDispatch, changedColumn)

      if (changedColumn === null && !changedRun) return

      if (circuit.qubits > MAX_CLIENT_QUBITS) {
        // Refused here rather than in the worker so the tab never allocates a
        // state it cannot afford. The worker checks again anyway: it is the
        // one that would do the allocating.
        clearTimer()
        pending = null
        disown()
        outcome = null
        durationMs = null
        transport = null
        failure = {
          code: 'too-many-qubits',
          qubits: circuit.qubits,
          limit: MAX_CLIENT_QUBITS,
          detail:
            `A ${circuit.qubits}-qubit state is ${2 ** (circuit.qubits - 16)} ` +
            `MB of amplitudes, past what a browser tab can hold.`,
        }
        publish()
        return
      }

      pending = { circuit, run: resolved }
      clearTimer()
      timer = setTimeout(dispatch, debounceMs)
      publish()
    },

    flush() {
      dispatch()
    },

    receive(response) {
      // The staleness guard. Everything above it exists to make this line
      // sufficient.
      if (response.id !== inFlight) return false
      inFlight = null

      if (response.kind === 'error') {
        failure = response.failure
        outcome = null
        durationMs = null
        transport = null
        // `dirtyFrom` survives: a run that threw says nothing about how far
        // the worker's cache got before it did.
      } else {
        if (response.mode === 'analytic') {
          // `dirtyFrom` tracks the worker's *analytic checkpoint cache* and
          // nothing else, so only an analytic result may clear it. A
          // trajectories run bypasses that cache entirely, so it proves
          // nothing about how far it caught up; clearing here would make the
          // next analytic request say "invalidate nothing" and let the worker
          // resume from a checkpoint that predates the user's edit — a
          // perfectly normalised statevector belonging to no circuit.
          //
          // Leaving `sinceDispatch` alone is exact, not merely conservative:
          // `schedule` feeds both accumulators the same minimum and only a
          // dispatch resets `sinceDispatch`, so dirtyFrom <= sinceDispatch
          // whenever both exist. Keeping both is `lowest(dirtyFrom,
          // sinceDispatch)` with no over-invalidation, and it costs nothing
          // when the circuit did not change: dirtyFrom is already null there.
          dirtyFrom = sinceDispatch
          sinceDispatch = null
        }
        outcome = decodeResult(response)
        failure = null
        durationMs = response.durationMs
        transport =
          response.mode === 'analytic' ? response.state.transport : null
      }
      publish()
      return true
    },

    fail(nextFailure) {
      if (
        inFlight === null &&
        failure !== null &&
        failure.code === nextFailure.code &&
        failure.detail === nextFailure.detail
      ) {
        // The same failure twice is not news. Publishing it again would hand
        // `useSyncExternalStore` a new snapshot object, re-render, and — if
        // the failure is a worker that refuses to spawn — arrive right back
        // here on the next render.
        return
      }
      // No id to match: the answer to whatever was in flight is never coming.
      inFlight = null
      failure = nextFailure
      outcome = null
      durationMs = null
      transport = null
      publish()
    },

    cancel() {
      clearTimer()
      pending = null
      disown()
      publish()
    },

    reset() {
      clearTimer()
      pending = null
      inFlight = null
      lastScheduled = undefined
      lastRun = undefined
      dirtyFrom = null
      sinceDispatch = null
      publish()
    },

    dispose() {
      clearTimer()
      pending = null
      inFlight = null
      listeners.clear()
    },
  }
}

interface ResolvedRun {
  readonly mode: ExecutionMode
  readonly shots: number
  readonly seed: number
}

function resolveRun(run: RunOptions): ResolvedRun {
  return {
    mode: run.mode ?? 'analytic',
    shots: run.shots ?? DEFAULT_SHOTS,
    seed: run.seed ?? DEFAULT_SEED,
  }
}

function sameRun(left: ResolvedRun, right: ResolvedRun): boolean {
  if (left.mode !== right.mode) return false
  // Shots and seed are only questions in trajectories mode; changing them
  // while analytic must not cost a re-run.
  if (left.mode === 'analytic') return true
  return left.shots === right.shots && left.seed === right.seed
}

function buildRequest(
  id: RequestId,
  circuit: Circuit,
  fromColumn: number,
  run: ResolvedRun,
  sharedMemory: boolean
): SimulateRequest {
  const base = {
    kind: 'simulate',
    id,
    circuit,
    fromColumn,
    sharedMemory,
  } as const
  if (run.mode === 'trajectories') {
    return { ...base, mode: 'trajectories', shots: run.shots, seed: run.seed }
  }
  return { ...base, mode: 'analytic' }
}

function lowest(
  current: number | null,
  candidate: number | null
): number | null {
  if (candidate === null) return current
  if (current === null) return candidate
  return Math.min(current, candidate)
}
