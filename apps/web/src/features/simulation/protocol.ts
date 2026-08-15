/**
 * The wire between the editor and the simulation worker — M0.6, §5.6.
 *
 * Both sides import this file and nothing else of each other's, so the
 * protocol is a compile error away from drifting. It carries three things
 * that are worth reading before anything else in this folder:
 *
 * ────────────────────────────────────────────────────────────────────────
 * EVERY MESSAGE CARRIES A REQUEST ID, AND IDS ONLY GO UP.
 *
 * A simulation takes long enough that a user can edit twice before the first
 * answer comes back. Without an id, the second answer and the first are
 * indistinguishable, and the editor eventually paints the result of a circuit
 * the user has already changed — the defect that makes an editor feel haunted,
 * and one that is invisible until someone edits fast. With a monotonic id, a
 * stale answer is arithmetic: `response.id !== inFlight` means drop it. The
 * scheduler does exactly that, and its test pins it.
 *
 * The monotonicity is load-bearing on the worker side too: a `cancel` can only
 * ever name a request that was already issued, so the worker collapses the set
 * of cancelled ids into a single watermark.
 *
 * ────────────────────────────────────────────────────────────────────────
 * THE STATE TRAVELS AS RAW BUFFERS, TWO WAYS.
 *
 * A 20-qubit state is 16 MB. Structured-cloning that on every edit would copy
 * it twice — once out of the worker and once into the main thread — so the
 * state moves either through a `SharedArrayBuffer` (no copy at all, when the
 * page is cross-origin isolated) or through transferred `ArrayBuffer`s (no
 * copy either, but the worker loses its own view of them). §5.1 chose two
 * parallel `Float64Array` over an array of objects precisely so this is
 * possible.
 *
 * The fallback is not a nicety. COOP/COEP are set for the dev server and must
 * be set on the deployment too, but a deployment that forgets them has to
 * degrade in speed, never break — which is why `encodeState` takes the
 * capability as an argument instead of reading the global, and why both paths
 * are tested.
 *
 * ────────────────────────────────────────────────────────────────────────
 * ERRORS ARE CODES, NOT SENTENCES.
 *
 * Same rule as the circuit store: a worker cannot translate, it has no
 * i18next instance and no idea what language the tab is in. It reports a code
 * plus the numbers a message might interpolate, and `useSimulation` renders it
 * through the `simulation` catalog in all three languages (D2). `detail` is
 * the engine's own English prose — for the console, never for a user.
 */

import { MAX_QUBITS, type ShotCounts, type Statevector } from '@qsim/core'
import type { Circuit } from '@qsim/schema'

/** Monotonically increasing, minted by the scheduler. Never reused. */
export type RequestId = number

/**
 * Largest register the browser will simulate.
 *
 * 20 qubits is 16 MB of amplitudes, plus as much again for every checkpoint
 * the cache keeps — comfortable in a tab, and the point where §3.1 hands the
 * job to the server. `MAX_QUBITS` is the engine's own ceiling (28, where a
 * state is 4 GB); taking the minimum means this limit can only ever get
 * stricter than the engine's, never looser than it, whatever either side is
 * tuned to later.
 */
export const MAX_CLIENT_QUBITS = Math.min(20, MAX_QUBITS)

/* ─────────────────────────────── requests ───────────────────────────── */

interface SimulateBase {
  readonly kind: 'simulate'
  readonly id: RequestId
  readonly circuit: Circuit
  /**
   * The earliest column the edits since the worker's last answer touched —
   * what `invalidateFrom` needs so the run resumes instead of restarting.
   *
   * Getting this too high is silent wrong physics: the runner resumes from a
   * checkpoint the edit already contradicted and returns a perfectly
   * normalised state that belongs to no circuit. Too low only costs time. The
   * scheduler therefore accumulates a minimum and only clears it when an
   * analytic result proves the worker's cache caught up.
   *
   * MEANINGFUL ONLY FOR AN `AnalyticRequest`. A trajectories run never reads
   * the checkpoint cache — it starts from |0…0⟩ every shot, deliberately — so
   * `runJob` ignores this field there and a trajectories request carrying it
   * is evidence of nothing about what the cache holds.
   */
  readonly fromColumn: number
  /**
   * Whether the main thread can accept a `SharedArrayBuffer` in reply.
   *
   * Honoured by the worker rather than assumed: it answers with a shared
   * buffer only when this flag *and* its own scope allow one, so a deployment
   * whose document and worker chunk are isolated differently degrades to the
   * transfer path instead of failing the request.
   */
  readonly sharedMemory: boolean
}

/** One run, one final statevector. Refused if the circuit measures (§5.3). */
export interface AnalyticRequest extends SimulateBase {
  readonly mode: 'analytic'
}

/** `shots` independent runs, tallied into counts. Seeded, so it repeats. */
export interface TrajectoriesRequest extends SimulateBase {
  readonly mode: 'trajectories'
  readonly shots: number
  readonly seed: number
}

export type SimulateRequest = AnalyticRequest | TrajectoriesRequest

/**
 * Give up on a request. The worker drops it if it has not started, and
 * withholds the answer if it has — see `simulation.worker.ts` for what this
 * can and cannot interrupt.
 */
export interface CancelRequest {
  readonly kind: 'cancel'
  readonly id: RequestId
}

export type SimulationRequest = SimulateRequest | CancelRequest

/* ────────────────────────────── responses ───────────────────────────── */

/** How the amplitudes crossed the thread boundary. Diagnostic, not a choice. */
export type TransportKind = 'shared' | 'transfer'

/**
 * A statevector in transit. Structurally one `Statevector` short of its
 * methods — `decodeState` is the only sanctioned way back, so no consumer
 * hand-rolls the reconstruction.
 */
export interface StatePayload {
  readonly qubits: number
  readonly size: number
  readonly re: Float64Array
  readonly im: Float64Array
  readonly transport: TransportKind
}

export interface AnalyticResponse {
  readonly kind: 'result'
  readonly id: RequestId
  readonly mode: 'analytic'
  readonly state: StatePayload
  /**
   * The column the run resumed from, 0 for a run that started at |0…0⟩. The
   * incremental cache of §5.6.3 is invisible from the outside otherwise, and
   * a cache that silently stopped working would only show up as a slow
   * editor.
   */
  readonly resumedFromColumn: number
  readonly durationMs: number
}

export interface TrajectoriesResponse {
  readonly kind: 'result'
  readonly id: RequestId
  readonly mode: 'trajectories'
  readonly shots: number
  readonly counts: ShotCounts
  readonly durationMs: number
}

export interface ErrorResponse {
  readonly kind: 'error'
  readonly id: RequestId
  readonly failure: SimulationFailure
}

export type SimulationResponse =
  AnalyticResponse | TrajectoriesResponse | ErrorResponse

/* ─────────────────────────────── failures ───────────────────────────── */

/**
 * Every way a simulation can fail to produce an answer.
 *
 * These are the UI's vocabulary, so they are deliberately about what the user
 * did rather than about where the exception came from: `too-many-qubits` is a
 * circuit that needs the server, `unsupported-operation` is a gate the engine
 * cannot run yet, `worker-failed` is a bug in this app.
 */
export const SIMULATION_ERROR_CODES = [
  'too-many-qubits',
  'invalid-circuit',
  'measurement-in-analytic-mode',
  'no-classical-bits',
  'unsupported-operation',
  'worker-unavailable',
  'worker-failed',
] as const

export type SimulationErrorCode = (typeof SIMULATION_ERROR_CODES)[number]

export interface SimulationFailure {
  readonly code: SimulationErrorCode
  /** Register size that was refused. Interpolated into the message. */
  readonly qubits?: number
  /** The ceiling it was refused against. Interpolated into the message. */
  readonly limit?: number
  /** The gate to highlight on the canvas, when the engine named one. */
  readonly operationId?: string
  /** The engine's own English message. For the console, never for a user. */
  readonly detail: string
}

/* ──────────────────────────── state transport ───────────────────────── */

/** The capability check, taking its scope as an argument so tests can lie. */
export interface SharedMemoryScope {
  readonly crossOriginIsolated?: boolean
  readonly SharedArrayBuffer?: unknown
}

/**
 * Whether this context can pass a `SharedArrayBuffer` between threads.
 *
 * Both halves matter: the constructor can exist while the page is not
 * cross-origin isolated, in which case posting one throws. COOP/COEP are set
 * in `vite.config.ts` for the dev server and must be set on the deployment
 * too; where they are missing this returns false and the transfer path takes
 * over, one copy slower and otherwise identical.
 */
export function sharedMemoryAvailable(
  scope: SharedMemoryScope = globalThis
): boolean {
  return (
    scope.SharedArrayBuffer !== undefined && scope.crossOriginIsolated === true
  )
}

export interface EncodedState {
  readonly payload: StatePayload
  /** Buffers to hand to `postMessage`. Empty on the shared path. */
  readonly transfer: readonly Transferable[]
}

/**
 * Pack a state for the trip out of the worker.
 *
 * SHARED PATH: a fresh pair of buffers per result, never a pool. The main
 * thread may still be reading the previous answer when the next run lands, and
 * a reused buffer would rewrite the histogram under it — a data race with no
 * lock in sight, on the one structure in this app large enough to make pooling
 * tempting.
 *
 * TRANSFER PATH: the engine's own buffers are handed over rather than copied,
 * which detaches them inside the worker. That is safe because the runner's
 * checkpoint cache stores `clone()`s, so no cached state aliases the one being
 * returned; the worker keeps nothing that points at these bytes.
 */
export function encodeState(state: Statevector, shared: boolean): EncodedState {
  if (shared) {
    return {
      payload: {
        qubits: state.qubits,
        size: state.size,
        re: sharedCopy(state.re),
        im: sharedCopy(state.im),
        transport: 'shared',
      },
      transfer: [],
    }
  }

  return {
    payload: {
      qubits: state.qubits,
      size: state.size,
      re: state.re,
      im: state.im,
      transport: 'transfer',
    },
    // The engine allocates plain `ArrayBuffer`s, so this cast narrows a union
    // that only ever holds one of its members here.
    transfer: [state.re.buffer as ArrayBuffer, state.im.buffer as ArrayBuffer],
  }
}

/** The received payload as a `Statevector` the engine's readers accept. */
export function decodeState(payload: StatePayload): Statevector {
  return {
    qubits: payload.qubits,
    size: payload.size,
    re: payload.re,
    im: payload.im,
  }
}

/* ───────────────────────────── decoded result ───────────────────────── */

/** A finished simulation, as the UI consumes it. */
export type SimulationOutcome =
  | {
      readonly mode: 'analytic'
      readonly state: Statevector
      readonly resumedFromColumn: number
    }
  | {
      readonly mode: 'trajectories'
      readonly shots: number
      readonly counts: ShotCounts
    }

/** Turns a successful response into the shape the analysis panel reads. */
export function decodeResult(
  response: AnalyticResponse | TrajectoriesResponse
): SimulationOutcome {
  if (response.mode === 'analytic') {
    return {
      mode: 'analytic',
      state: decodeState(response.state),
      resumedFromColumn: response.resumedFromColumn,
    }
  }
  return {
    mode: 'trajectories',
    shots: response.shots,
    counts: response.counts,
  }
}

function sharedCopy(values: Float64Array): Float64Array {
  const copy = new Float64Array(new SharedArrayBuffer(values.byteLength))
  copy.set(values)
  return copy
}
