/**
 * The second backend of §4: one server run, from submission to answer.
 *
 * The scheduler hands this a `ServerSimulateRequest` exactly as it hands the
 * worker a `SimulateRequest`, and this reports back through the same two
 * channels — `deliver` for an answer, `fail` for a transport failure — plus
 * `report` for the progress the panel renders. Nothing in here decides whether
 * a result is current; that is the scheduler's single staleness line, and every
 * call below carries the request id so it can apply it.
 *
 * ═══════════════════════════════════════════════════════════════════════
 * THE SOCKET IS AN OPTIMISATION OVER A CORRECT SYSTEM, NOT A DEPENDENCY
 *
 * This backend polls `GET /simulate/:runId` on a slow timer for as long as a
 * run is in flight, *and* subscribes to the socket. That is not redundancy for
 * its own sake — it is the shape that makes every failure mode ordinary:
 *
 *   - a socket that never connects (a proxy that strips upgrades, a CSP, an API
 *     with no Redis) costs a few seconds of latency and nothing else;
 *   - a socket that drops mid-run loses events, which pub/sub does not promise
 *     to redeliver, and the next poll finds the answer anyway;
 *   - a run that finishes while the tab is asleep is found by the resync the
 *     socket fires the moment it reconnects.
 *
 * Five seconds for the poll, which is chosen against the two things it trades
 * off. It is slow enough that a run nobody is watching costs a request every
 * five seconds against a route whose budget is three hundred a minute; it is
 * fast enough that a reader whose socket never came up sees the answer within a
 * beat of it existing. The socket is what makes the *normal* case immediate.
 *
 * ── Cancelling means stopping waiting ─────────────────────────────────────
 *
 * §8 gives `/simulate` no delete, and a run already executing in a killable
 * child is going to finish whatever this tab does. So cancelling here
 * unsubscribes, stops polling and releases the request — the run keeps its id
 * and stays readable. The panel says that in words rather than implying
 * something stronger, because a button labelled "cancel" that silently does not
 * cancel is worse than no button.
 */

import type {
  SimulateRequest as SimulateBody,
  SimulationRun,
} from '@qsim/contract'

import {
  type RequestId,
  type ServerRequest,
  type ServerRunView,
  type ServerSimulateRequest,
  type SimulationFailure,
  type SimulationResponse,
} from './protocol'
import type { RunSocket } from './runSocket'
import type { ServerRunUpdate, ServerTransport } from './scheduler'

/**
 * How often a run in flight is read from the API regardless of the socket.
 *
 * See the header: this is what makes the socket an optimisation rather than a
 * dependency. It is deliberately not tuned down — a faster poll would make the
 * socket pointless and the route expensive at the same time.
 */
export const RUN_POLL_INTERVAL_MS = 5_000

export interface ServerBackendPorts {
  /** `POST /simulate`. Rejects with an `ApiRequestError` on any refusal. */
  readonly submit: (
    body: SimulateBody,
    signal?: AbortSignal
  ) => Promise<SimulationRun>
  /** `GET /simulate/:runId`, the authoritative read. */
  readonly fetchRun: (
    runId: string,
    signal?: AbortSignal
  ) => Promise<SimulationRun>
  /** The shared socket, or null where none could be built. */
  readonly socket: RunSocket | null
  /** An answer for the scheduler. */
  readonly deliver: (response: SimulationResponse) => void
  /** A transport failure — no run exists, or none can be reached. */
  readonly fail: (id: RequestId, failure: SimulationFailure) => void
  /** Progress, through the scheduler's staleness guard. */
  readonly report: (update: ServerRunUpdate) => void
  /** Classifies a rejection into this app's vocabulary. Injected for tests. */
  readonly classify?: (error: unknown) => SimulationFailure
  readonly now?: () => number
  readonly schedule?: (run: () => void, delayMs: number) => () => void
}

export interface ServerBackend {
  /** What the scheduler connects with. */
  readonly dispatch: ServerTransport
  /**
   * Releases whatever is in flight — the subscription, the poll timer and the
   * in-flight request.
   *
   * Called when the component that owns this goes away. Without it, an editor
   * closed while a run was queued would leave a `setTimeout` chain reading
   * `GET /simulate/:runId` every five seconds for as long as the tab lived,
   * against a run nobody will ever look at. The scheduler's own reset does not
   * cover it: it clears what is *in flight* up there, and the timer lives here.
   */
  readonly dispose: () => void
}

/** One run's live state, so a report can be built without re-deriving it. */
interface Live {
  readonly id: RequestId
  view: ServerRunView
  runId: string | null
  cancelled: boolean
  unwatch: (() => void) | null
  stopPolling: (() => void) | null
  abort: AbortController
}

export function createServerBackend(ports: ServerBackendPorts): ServerBackend {
  const now = ports.now ?? Date.now
  const schedule = ports.schedule ?? defaultSchedule
  const classify = ports.classify ?? defaultClassify

  /**
   * The one run this backend is driving, or null.
   *
   * One, not a map, and it mirrors the scheduler exactly: there is a single
   * `inFlight` slot up there, so a second run would be one whose answer is
   * already guaranteed to be dropped. Starting it anyway would spend a queued
   * job of somebody else's tier to compute something nobody will look at.
   */
  let live: Live | null = null

  function release(): void {
    if (live === null) return
    live.cancelled = true
    live.unwatch?.()
    live.stopPolling?.()
    live.abort.abort()
    live = null
  }

  function push(run: Live, changes: Partial<ServerRunView>): void {
    /*
     * A released run reports nothing more. The scheduler would drop it anyway —
     * the id no longer matches what is in flight — but relying on that would
     * make this file correct only by accident, and a socket callback can
     * legitimately arrive after `unwatch` on a transport that had already
     * queued the frame.
     */
    if (run.cancelled) return
    run.view = { ...run.view, ...changes }
    ports.report({ id: run.id, ...run.view })
  }

  /** Reads the run and, if it is finished, answers with it. */
  async function settle(run: Live): Promise<boolean> {
    if (run.runId === null || run.cancelled) return false
    let fetched: SimulationRun
    try {
      fetched = await ports.fetchRun(run.runId, run.abort.signal)
    } catch (error) {
      if (run.cancelled) return false
      /*
       * A failed *read* of a run that exists is not a failed run. A blip, a
       * dropped connection, a 503 — the next poll tries again, and a socket
       * completion tries immediately, so the cost is a few seconds rather than
       * the answer. The one read that is terminal is the one that says the run
       * is not there: 404 covers "no such run" and "not yours" alike (§11), and
       * neither of those gets better by asking again.
       */
      if (!isGone(error)) return false
      release()
      ports.fail(run.id, classify(error))
      return true
    }
    if (run.cancelled) return false

    if (fetched.status === 'DONE' || fetched.status === 'FAILED') {
      const id = run.id
      release()
      ports.deliver({ kind: 'result', id, mode: 'server', run: fetched })
      return true
    }

    push(run, {
      stage: fetched.status === 'RUNNING' ? 'running' : 'queued',
      ...(fetched.progress === null
        ? {}
        : {
            phase: fetched.progress.phase,
            completed: fetched.progress.completed,
            total: fetched.progress.total,
          }),
    })
    return false
  }

  function poll(run: Live): void {
    const tick = (): void => {
      if (run.cancelled) return
      void settle(run).then((finished) => {
        if (finished || run.cancelled) return
        run.stopPolling = schedule(tick, RUN_POLL_INTERVAL_MS)
      })
    }
    run.stopPolling = schedule(tick, RUN_POLL_INTERVAL_MS)
  }

  function watch(run: Live, runId: string): void {
    const socket = ports.socket
    if (socket === null) return
    run.unwatch = socket.watch(runId, {
      onResync: () => {
        /*
         * Fired on every confirmed subscription, including the first and every
         * one after a reconnect. Reading the run here is the whole recovery
         * story: whatever was published while this client was away is already
         * in the row, so there is nothing to replay.
         */
        push(run, { live: true })
        void settle(run)
      },
      onStatus: (frame) => {
        push(run, {
          stage: frame.status === 'RUNNING' ? 'running' : 'queued',
        })
      },
      onProgress: (frame) => {
        push(run, {
          stage: 'running',
          phase: frame.phase,
          completed: frame.completed,
          total: frame.total,
        })
      },
      onComplete: () => {
        // The frame says the run is finished; it deliberately does not say what
        // the answer is (`@qsim/contract`'s socket.ts). This is the read.
        void settle(run)
      },
      onRefused: (code) => {
        /*
         * `NOT_FOUND` or `unauthorised` means this viewer may no longer read the
         * run — its circuit was unpublished, or the session changed. The polling
         * read would say the same thing, so the run is given up rather than
         * waited on.
         */
        const id = run.id
        release()
        ports.fail(id, {
          code:
            code === 'SIMULATION_UNAVAILABLE'
              ? 'server-unavailable'
              : 'server-refused',
          detail: `The progress feed refused this run: ${code}.`,
        })
      },
      onOffline: () => {
        // Not a failure. The poll is still running and the socket is coming
        // back; the panel says "reconnecting" instead of pretending nothing
        // happened, because a silent gap looks exactly like a stalled run.
        if (!run.cancelled) push(run, { live: false })
      },
    })
  }

  async function start(request: ServerSimulateRequest): Promise<void> {
    const run: Live = {
      id: request.id,
      view: {
        stage: 'submitting',
        runId: null,
        phase: null,
        completed: null,
        total: null,
        estimatedDurationMs: null,
        submittedAt: now(),
        live: false,
      },
      runId: null,
      cancelled: false,
      unwatch: null,
      stopPolling: null,
      abort: new AbortController(),
    }
    live = run

    let submitted: SimulationRun
    try {
      submitted = await ports.submit(
        {
          circuit: request.circuit,
          mode:
            request.mode === 'trajectories' ? 'TRAJECTORIES' : 'STATEVECTOR',
          ...(request.shots === null ? {} : { shots: request.shots }),
          seed: request.seed,
          readout: true,
        },
        run.abort.signal
      )
    } catch (error) {
      if (run.cancelled) return
      release()
      ports.fail(request.id, classify(error))
      return
    }
    if (run.cancelled) return

    run.runId = submitted.id

    if (submitted.status === 'DONE' || submitted.status === 'FAILED') {
      /*
       * Finished inside the synchronous window — the ordinary outcome for work
       * that is here for an authoritative answer rather than because it is big.
       * No socket, no poll, no run id ever shown: it is simply the answer.
       */
      release()
      ports.deliver({
        kind: 'result',
        id: request.id,
        mode: 'server',
        run: submitted,
      })
      return
    }

    push(run, {
      stage: submitted.status === 'RUNNING' ? 'running' : 'queued',
      runId: submitted.id,
      estimatedDurationMs: submitted.estimatedDurationMs,
    })
    watch(run, submitted.id)
    poll(run)
  }

  return {
    dispatch: (request: ServerRequest) => {
      if (request.kind === 'cancel') {
        // Only the run this cancel names. A cancel that arrived after the
        // answer did would otherwise tear down the *next* run, which the
        // scheduler has already started by then.
        if (live !== null && live.id === request.id) release()
        return
      }
      // Superseded: the scheduler dispatches one request at a time and has
      // already disowned whatever was in flight.
      release()
      void start(request)
    },

    dispose: release,
  }
}

function defaultSchedule(run: () => void, delayMs: number): () => void {
  const timer = setTimeout(run, delayMs)
  return () => clearTimeout(timer)
}

/** Whether a failed read means the run is not there, rather than not now. */
function isGone(error: unknown): boolean {
  const code = (error as { code?: unknown }).code
  const status = (error as { status?: unknown }).status
  return code === 'NOT_FOUND' || status === 404
}

/**
 * An API rejection, in this feature's vocabulary.
 *
 * Deliberately shape-based rather than message-based, like every other
 * classifier in this project: the `code` on an `ApiRequestError` is the token
 * the API sent, and a sentence would be English outside every catalog.
 */
function defaultClassify(error: unknown): SimulationFailure {
  const code = (error as { code?: unknown }).code
  const status = (error as { status?: unknown }).status
  const detail = error instanceof Error ? error.message : String(error)

  if (code === 'SIMULATION_TOO_LARGE') {
    return { code: 'server-too-large', detail }
  }
  if (
    code === 'SIMULATION_UNAVAILABLE' ||
    code === 'NETWORK_UNREACHABLE' ||
    status === 502 ||
    status === 503 ||
    status === 504
  ) {
    return { code: 'server-unavailable', detail }
  }
  return { code: 'server-refused', detail }
}
