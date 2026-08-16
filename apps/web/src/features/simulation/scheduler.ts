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
 * simulation — the one after the user stops. With one exception, added in
 * M0.8: a request whose *only* difference is where the timeline scrubber is
 * parked goes out immediately, because a scrub step is a single deliberate
 * command rather than one frame of a gesture. See `onlyScrubMoved`.
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
 *
 * ────────────────────────────────────────────────────────────────────────
 * 4. TWO BACKENDS, ONE SEAM (§4). A circuit past `MAX_CLIENT_QUBITS` is not a
 * failure any more: it goes to the server. What makes that safe is that it
 * changes nothing above — a server run takes an id from the *same* monotonic
 * sequence, occupies the *same* single `inFlight` slot, and its answer passes
 * the *same* staleness line in `receive`. There is deliberately no second
 * scheduler, no second id space and no second notion of "current": a stale
 * server result is discarded by the identical comparison that discards a stale
 * worker result, and the test suite asserts it with the same shape of test.
 *
 * The routing rule is the whole of §4 and it is one line: the browser runs
 * everything it can, and only what it cannot goes over the network. A run sent
 * to the server that a tab could have done would be slower for the reader and
 * more expensive for the project at the same time.
 *
 * Where there is no server — no API configured, or the transport never
 * connected — the old behaviour stands exactly as it was: `too-many-qubits`,
 * with the register and the ceiling, on screen. A ceiling with nowhere to go is
 * still a ceiling.
 */

import type { ExecutionMode } from '@qsim/core'
import { MAX_COLUMNS, type Circuit } from '@qsim/schema'

import { earliestChangedColumn } from './invalidation'
import {
  MAX_CLIENT_QUBITS,
  clampShots,
  decodeResult,
  idealTrajectoriesFit,
  maxIdealTrajectoryShots,
  type NoiseSpec,
  type RequestId,
  type ServerRequest,
  type ServerRunView,
  type ServerSimulateRequest,
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
  /**
   * The server run in flight, or null when the answer on screen came from this
   * tab.
   *
   * The one piece of state whose whole purpose is to be *visible*: §4's split
   * is invisible from the outside — a run is a run — and a reader who cannot
   * tell that this particular answer took a network round trip has no way to
   * understand why it took eleven seconds when the last one took eight
   * milliseconds. Cleared the moment the run finishes or is superseded, so it
   * can never describe something that is no longer happening.
   */
  readonly serverRun: ServerRunView | null
}

export interface RunOptions {
  readonly mode?: ExecutionMode
  /**
   * Draw shots from the final state of an analytic run as well (§3.2).
   *
   * Off by default, and the default is the physics: an analytic run already
   * knows every probability exactly, so shot noise is something a reader asks
   * for in order to see what a device would have measured — never something a
   * simulator adds on its own (§5.3).
   *
   * Ignored in trajectories mode, where sampling is the run rather than a
   * reading taken afterwards.
   */
  readonly sample?: boolean
  readonly shots?: number
  readonly seed?: number
  /**
   * Where the timeline scrubber is parked (M0.8): stop after this column, with
   * `-1` meaning "before column 0", or `null`/absent for the whole circuit.
   *
   * Honoured in both modes, differently. Analytically it names the state to
   * answer with; in trajectories mode there is no single state at a column, so
   * it truncates the run instead and the tally describes the classical register
   * at that instant (`job.ts`, `protocol.ts`). What it must never mean is
   * nothing at all: a bar that announces a position the panel ignores is the
   * same silent falsehood as a stale intermediate state.
   */
  readonly throughColumn?: number | null
  /**
   * Run the circuit a second time under a noise model (§3.3), or `null`/absent
   * for the ideal run alone.
   *
   * Ignored in trajectories mode, and that is a statement about the physics
   * rather than a shortcut: §3.3's deliverable is the ideal distribution beside
   * the noisy one, and a circuit that measures before it ends has no single
   * ideal distribution to put beside anything (§5.3). The panel says so instead
   * of asking for half a comparison.
   */
  readonly noise?: NoiseSpec | null
}

export interface SchedulerOptions {
  readonly debounceMs?: number
  /** Whether the main thread can receive a `SharedArrayBuffer`. */
  readonly sharedMemory?: boolean
}

/** Where messages go. The scheduler's only side effect. */
export type Transport = (request: SimulationRequest) => void

/** The same, for the second backend of §4. See `ServerRequest`. */
export type ServerTransport = (request: ServerRequest) => void

/** A server run's state, as the backend reports it back. */
export interface ServerRunUpdate extends ServerRunView {
  readonly id: RequestId
}

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
   * Point the scheduler at the server backend, or at nothing.
   *
   * Separate from `connect` because the two have different lifetimes and
   * different owners: the worker is created and terminated by the hook, while
   * the server backend depends on an API client that comes from React context
   * and on a socket that outlives any one run. Nothing else about them differs
   * — a request dispatched with no server transport is dropped exactly as one
   * dispatched with no worker is.
   *
   * `null` is the ordinary state and not a degraded one: it is what a reader
   * with no API configured has, and it is why `schedule` still produces
   * `too-many-qubits` in that case rather than a request nothing will answer.
   */
  readonly connectServer: (transport: ServerTransport | null) => void

  /**
   * A server run said something about itself — it was accepted, a worker
   * claimed it, it reached a phase, the feed went offline.
   *
   * Goes through the scheduler rather than straight to the UI so that it meets
   * the *same* staleness guard as a result: a progress frame for a run the
   * reader has already superseded must not repaint the panel, and there is
   * exactly one line in this file that decides that. Returns false when it was
   * dropped, like `receive`.
   */
  readonly report: (update: ServerRunUpdate) => boolean

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
  serverRun: null,
}

export function createSimulationScheduler(
  options: SchedulerOptions = {}
): SimulationScheduler {
  const debounceMs = options.debounceMs ?? SIMULATION_DEBOUNCE_MS
  const sharedMemory = options.sharedMemory ?? false

  let send: Transport | null = null
  let sendToServer: ServerTransport | null = null
  const listeners = new Set<() => void>()
  let snapshot: SimulationSnapshot = IDLE

  let outcome: SimulationOutcome | null = null
  let failure: SimulationFailure | null = null
  let durationMs: number | null = null
  let transport: TransportKind | null = null
  let serverRun: ServerRunView | null = null

  let timer: ReturnType<typeof setTimeout> | null = null
  let pending: { circuit: Circuit; run: ResolvedRun } | null = null
  let inFlight: RequestId | null = null
  /**
   * Which backend owns `inFlight`, so a cancel reaches the right one.
   *
   * One slot, not two: exactly one request is in flight at a time whichever
   * backend is answering it, which is what keeps the staleness rule a single
   * comparison rather than a pair of them that can disagree.
   */
  let inFlightOn: 'worker' | 'server' | null = null
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
      serverRun,
    }
    if (
      next.status === snapshot.status &&
      next.outcome === snapshot.outcome &&
      next.failure === snapshot.failure &&
      next.durationMs === snapshot.durationMs &&
      next.transport === snapshot.transport &&
      next.serverRun === snapshot.serverRun
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
    /*
     * Sent to whichever backend holds it. The worker cannot always act on this
     * — see `simulation.worker.ts` — but it costs one message and saves copying
     * a 16 MB state back that nobody would look at. The server can act on even
     * less of it (§8 gives `/simulate` no delete), so there it means "stop
     * waiting", and the panel's own wording says exactly that.
     */
    if (inFlightOn === 'server') {
      sendToServer?.({ kind: 'cancel', id: inFlight })
    } else {
      send?.({ kind: 'cancel', id: inFlight })
    }
    inFlight = null
    inFlightOn = null
    serverRun = null
  }

  /** Whether this circuit is past what a tab can hold, and must go out (§4). */
  function needsServer(circuit: Circuit): boolean {
    return circuit.qubits > MAX_CLIENT_QUBITS
  }

  /**
   * A sampled run this tab cannot afford in time, or `null`.
   *
   * THE CEILING IS NOT ONLY A REGISTER. `needsServer` asks about memory, which
   * is the right question for the analytic path and only half of it for the
   * sampled one: trajectories re-run the whole circuit once per shot, so a
   * twenty-qubit circuit that merely carries a `measure` gate — inside the
   * register ceiling, so never routed anywhere — cost two and three quarter
   * minutes in a worker that cannot be interrupted. The server would have
   * refused the same work outright, and the shots control is deliberately
   * absent in this mode, so the reader could not have made it smaller either.
   *
   * Refused rather than routed: at these sizes the server's own admission check
   * says no as well, and a round trip to be told so is a slower way to arrive
   * at the same sentence.
   */
  function tooMuchSampling(
    circuit: Circuit,
    run: ResolvedRun
  ): SimulationFailure | null {
    if (run.mode !== 'trajectories') return null
    const operations = circuit.operations.length
    if (idealTrajectoriesFit(circuit.qubits, operations, run.shots)) return null
    return {
      code: 'sampling-too-large',
      qubits: circuit.qubits,
      operations,
      shots: run.shots,
      limit: maxIdealTrajectoryShots(circuit.qubits, operations),
      detail:
        `${String(run.shots)} shots of a ${String(circuit.qubits)}-qubit ` +
        `circuit with ${String(operations)} operations is past the sampled ` +
        `work budget.`,
    }
  }

  function dispatch(): void {
    clearTimer()
    if (pending === null) return

    const { circuit, run } = pending
    disown()
    lastId += 1
    inFlight = lastId
    pending = null
    // Reset the post-dispatch accumulator, not `dirtyFrom`: only a result
    // proves the worker's cache advanced. See the header, point 3.
    sinceDispatch = null

    if (needsServer(circuit)) {
      inFlightOn = 'server'
      /*
       * Seeded here rather than waiting for the backend's first report, so the
       * panel says "this one is going to the server" in the same frame the
       * request leaves. The alternative is a gap in which the reader sees a
       * spinner with no explanation, and that gap is a network round trip long.
       */
      serverRun = {
        stage: 'submitting',
        runId: null,
        phase: null,
        completed: null,
        total: null,
        estimatedDurationMs: null,
        submittedAt: Date.now(),
        live: false,
      }
      sendToServer?.(buildServerRequest(lastId, circuit, run))
      publish()
      return
    }

    inFlightOn = 'worker'
    send?.(
      buildRequest(
        lastId,
        circuit,
        dirtyFrom ?? NOTHING_INVALIDATED,
        run,
        sharedMemory
      )
    )
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

    connectServer(transportTo) {
      sendToServer = transportTo
    },

    schedule(circuit, run = {}) {
      const resolved = resolveRun(run)
      const previousRun = lastRun
      const changedColumn = earliestChangedColumn(lastScheduled, circuit)
      const changedRun = lastRun === undefined || !sameRun(lastRun, resolved)
      lastScheduled = circuit
      lastRun = resolved

      dirtyFrom = lowest(dirtyFrom, changedColumn)
      sinceDispatch = lowest(sinceDispatch, changedColumn)

      if (changedColumn === null && !changedRun) return

      const unaffordable = tooMuchSampling(circuit, resolved)
      if (unaffordable !== null) {
        // Refused here rather than in the worker so the tab never starts a loop
        // it cannot stop; the worker checks again anyway, because it is the one
        // that would spend the minutes.
        clearTimer()
        pending = null
        disown()
        outcome = null
        durationMs = null
        transport = null
        failure = unaffordable
        publish()
        return
      }

      if (needsServer(circuit) && sendToServer === null) {
        /*
         * Past what a tab can hold, and nowhere to send it. Refused here rather
         * than in the worker so the tab never allocates a state it cannot
         * afford; the worker checks again anyway, because it is the one that
         * would do the allocating.
         *
         * With a server connected this branch does not run at all — the request
         * goes out instead (see `dispatch`). That is §4's second level, and the
         * ceiling that used to be the end of the road is now a fork in it.
         */
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
      if (changedColumn === null && onlyScrubMoved(previousRun, resolved)) {
        // `dispatch` publishes on its way out.
        dispatch()
        return
      }
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
      inFlightOn = null
      // Whatever it was describing is finished or superseded. The panel's
      // server notice must never outlive the run it is about.
      serverRun = null

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
        /*
         * A server run reports the engine's own time, which is the same measure
         * the worker reports and is comparable with it — deliberately not the
         * time from submission. A run that waited four minutes behind other
         * work did not take four minutes, and printing that it did would make
         * the number useless for the one thing anybody uses it for, which is
         * comparing two circuits.
         */
        durationMs =
          response.mode === 'server'
            ? response.run.durationMs
            : response.durationMs
        transport =
          response.mode === 'analytic' ? response.state.transport : null
      }
      publish()
      return true
    },

    report(update) {
      // The same staleness line as `receive`, and that is the point: a progress
      // frame for a run the reader has already superseded is exactly as stale
      // as a result would be, and there is one place that decides it.
      if (update.id !== inFlight) return false
      const { id: _id, ...view } = update
      serverRun = view
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
      /*
       * Through `disown` and not by clearing the slot, because the backend that
       * owns the request has to be told. Clearing it directly left a server run
       * with nobody watching it: the poll chain kept issuing a GET every five
       * seconds until the component unmounted, and the answer, when it came,
       * was dropped by the staleness line that no longer had an id to match.
       * `fail` ends the same request the same way `cancel` does.
       */
      disown()
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
      inFlightOn = null
      serverRun = null
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
      inFlightOn = null
      serverRun = null
      listeners.clear()
    },
  }
}

interface ResolvedRun {
  readonly mode: ExecutionMode
  readonly sample: boolean
  readonly shots: number
  readonly seed: number
  readonly throughColumn: number | null
  readonly noise: NoiseSpec | null
}

function resolveRun(run: RunOptions): ResolvedRun {
  return {
    mode: run.mode ?? 'analytic',
    sample: run.sample ?? false,
    // Clamped here as well as in the worker: this is the value `sameRun`
    // compares, and an unclamped 200 000 and an unclamped 300 000 would look
    // like two different runs while producing the same 100 000 shots.
    shots: clampShots(run.shots ?? DEFAULT_SHOTS),
    seed: run.seed ?? DEFAULT_SEED,
    throughColumn: run.throughColumn ?? null,
    noise: run.noise ?? null,
  }
}

/**
 * Whether two noise specs ask the same question — compared field by field,
 * never by identity.
 *
 * A caller that rebuilds the object every render is the normal thing, and an
 * identity check would make every keystroke in the editor look like a change of
 * noise model and re-run a density-matrix simulation. The profile is eight
 * numbers and an id, all of them flat, so the comparison is exhaustive rather
 * than a heuristic — a field added to `NoiseProfile` and forgotten here would be
 * a slider the reader could drag with nothing happening, which is why the
 * destructuring below names every one of them.
 */
function sameNoise(left: NoiseSpec | null, right: NoiseSpec | null): boolean {
  if (left === null || right === null) return left === right
  if (left.method !== right.method) return false
  if (left.readout !== right.readout) return false
  // Shots and the seed are questions only for the sampled method: the density
  // method draws nothing, so re-running it because a shots slider moved would
  // recompute a 4ⁿ evolution to produce the identical matrix.
  if (left.method === 'trajectories') {
    if (left.shots !== right.shots || left.seed !== right.seed) return false
  }
  const a = left.profile
  const b = right.profile
  return (
    a.id === b.id &&
    a.t1Ns === b.t1Ns &&
    a.t2Ns === b.t2Ns &&
    a.oneQubitGateNs === b.oneQubitGateNs &&
    a.twoQubitGateNs === b.twoQubitGateNs &&
    a.oneQubitGateError === b.oneQubitGateError &&
    a.twoQubitGateError === b.twoQubitGateError &&
    a.readoutP0to1 === b.readoutP0to1 &&
    a.readoutP1to0 === b.readoutP1to0
  )
}

function sameRun(left: ResolvedRun, right: ResolvedRun): boolean {
  if (left.mode !== right.mode) return false
  // Compared before the mode split below, because a noise model is a question
  // about the circuit rather than about the sampling: switching profiles with
  // shot sampling switched off still has to dispatch.
  if (!sameNoise(left.noise, right.noise)) return false
  // A scrub step asks a different question of the same circuit, so it is a
  // different run — this comparison is what makes moving the timeline schedule
  // anything at all when nothing about the document changed. It is compared in
  // *both* modes: a trajectories run stops after the same column (`job.ts`),
  // and leaving it out of this comparison is what left the bar on a measuring
  // circuit moving, announcing a position, and dispatching nothing.
  if (left.throughColumn !== right.throughColumn) return false
  if (left.mode === 'analytic') {
    // Analytically, shots and seed are questions only when someone asked for a
    // sample. Comparing them unconditionally would re-run the whole circuit
    // every time a shots slider moved with sampling switched off.
    if (left.sample !== right.sample) return false
    if (!left.sample) return true
  }
  return left.shots === right.shots && left.seed === right.seed
}

/**
 * Whether the only thing that moved is the scrubber — and therefore whether
 * this request should skip the debounce.
 *
 * The 150 ms wait exists to coalesce an *edit storm*: a slider drag emits a
 * value per frame and only the last one is a question worth asking. A scrub
 * step is the opposite kind of event. It is one deliberate command, its whole
 * purpose is to put the state at that column on screen, and making the reader
 * wait 150 ms for each one turns stepping into something that feels broken —
 * while automatic playback faster than the debounce would show no intermediate
 * state at all, every tick being swallowed by the next.
 *
 * Holding an arrow key down is not a counter-example: dispatching cancels the
 * request in flight, and the worker keeps only the newest entry in its inbox
 * and drops the rest unrun (`simulation.worker.ts`). A burst of steps therefore
 * costs one run in flight plus one queued, whatever the key repeat rate is.
 *
 * In both modes. A step in trajectories mode re-runs the shots as far as the
 * bar rather than resuming a state (`job.ts`), which is more work — but it is
 * the same one deliberate command, and a reader stepping through the
 * teleportation preset is the reader §3.1 wrote the feature for.
 */
function onlyScrubMoved(
  previous: ResolvedRun | undefined,
  next: ResolvedRun
): boolean {
  if (previous === undefined) return false
  if (previous.throughColumn === next.throughColumn) return false
  return sameRun({ ...previous, throughColumn: next.throughColumn }, next)
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
    return {
      ...base,
      mode: 'trajectories',
      shots: run.shots,
      seed: run.seed,
      throughColumn: run.throughColumn,
    }
  }
  return {
    ...base,
    mode: 'analytic',
    throughColumn: run.throughColumn,
    sample: run.sample ? { shots: run.shots, seed: run.seed } : null,
    noise: run.noise,
  }
}

/**
 * The same run, addressed to the server.
 *
 * Two fields are dropped and the reasons are different, so both are written
 * down rather than left as omissions.
 *
 * `fromColumn` and `throughColumn` go nowhere, because there is no checkpoint
 * cache on the other side and there could not be one: the server evaluates a
 * submission and forgets it, which is what makes the same circuit and the same
 * seed give the same answer from any replica. Scrubbing a twenty-four-qubit
 * circuit column by column over the network would be one queued job per step,
 * which is a different feature and probably a bad one.
 *
 * `sample` is folded into `shots`. On the worker, sampling is a second reading
 * taken from a state that already exists; on the server there is no state to
 * take a second reading from — a register that size never comes back whole
 * (`result.ts` in `@qsim/jobs`) — so shots are the run or there are none.
 */
function buildServerRequest(
  id: RequestId,
  circuit: Circuit,
  run: ResolvedRun
): ServerSimulateRequest {
  return {
    kind: 'server-simulate',
    id,
    circuit,
    mode: run.mode,
    shots:
      run.mode === 'trajectories' || run.sample ? clampShots(run.shots) : null,
    seed: run.seed,
  }
}

function lowest(
  current: number | null,
  candidate: number | null
): number | null {
  if (candidate === null) return current
  if (current === null) return candidate
  return Math.min(current, candidate)
}
