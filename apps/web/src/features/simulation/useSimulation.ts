/**
 * `useSimulation` — the editor's live answer, one hook wide (M0.6).
 *
 * Hand it the circuit from the store and it keeps a simulation of it up to
 * date: debounced, cancelled when superseded, resumed from the worker's
 * checkpoints, and never blocking the main thread. Everything the analysis
 * panel of M0.7 needs comes back as plain state — a statevector, or counts, or
 * a translated error.
 *
 * This file is deliberately thin. It owns three things and delegates the rest:
 *
 *  - the worker's lifetime (created on mount, terminated on unmount),
 *  - React's view of the scheduler, through `useSyncExternalStore`, so a
 *    result that lands between renders cannot be missed,
 *  - turning the worker's error *code* into a sentence in the user's language
 *    (D2). The worker has no i18next instance and no idea what locale the tab
 *    is in, so translation can only happen here.
 *
 * A NEW WORKER MEANS A NEW CACHE. Terminating the worker throws away the
 * checkpoints with it, so the cleanup also resets the scheduler — otherwise
 * the next request would name a `fromColumn` computed against a cache that no
 * longer exists, and the run would resume from a checkpoint that was never
 * taken.
 *
 * A BROWSER WITH NO WORKER IS A REPORTED FAILURE, NOT A PENDING ONE. When the
 * worker cannot spawn, nothing is scheduled: a request with no transport is
 * dropped, but the debounce would still march the status through `scheduled`
 * and `running` and leave the editor claiming to be simulating something no
 * thread will ever pick up. The failure is the news, so the failure stays on
 * screen.
 */

import type { Circuit } from '@qsim/schema'
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from 'react'
import { useTranslation } from 'react-i18next'

import {
  sharedMemoryAvailable,
  type SimulationErrorCode,
  type SimulationRequest,
  type SimulationResponse,
} from './protocol'
import {
  createSimulationScheduler,
  type RunOptions,
  type SimulationSnapshot,
} from './scheduler'

/**
 * The part of `Worker` this hook uses. Narrow on purpose: tests drive the hook
 * with a stand-in, and a real `Worker` satisfies it without an adapter.
 */
export interface SimulationWorkerLike {
  postMessage(message: SimulationRequest): void
  terminate(): void
  onmessage: ((event: MessageEvent<SimulationResponse>) => void) | null
  onerror: ((event: ErrorEvent) => void) | null
  /**
   * Optional so a test stand-in is not forced to implement it; a real
   * `Worker` has it. It fires when a reply arrives but cannot be
   * deserialised, which is the one failure that reaches neither `onmessage`
   * nor `onerror` — and therefore the one that would leave the editor
   * waiting on an answer that has already been thrown away.
   */
  onmessageerror?: ((event: MessageEvent) => void) | null
}

export interface UseSimulationOptions extends RunOptions {
  /** Off means "hold the last answer": nothing is scheduled while false. */
  readonly enabled?: boolean
  /** Read once, when the hook mounts. */
  readonly debounceMs?: number
  /**
   * How to obtain the worker. Must be stable across renders — a fresh
   * function every render would terminate and respawn the worker, and with it
   * the checkpoint cache. Production leaves it alone.
   */
  readonly createWorker?: () => SimulationWorkerLike
}

/** A failure the UI can render as it stands. */
export interface SimulationError {
  readonly code: SimulationErrorCode
  /** Translated, ready to show. */
  readonly message: string
  /** The gate to highlight on the canvas, when the engine named one. */
  readonly operationId?: string
  /** The engine's English prose. For the console, never for a user. */
  readonly detail: string
}

export interface SimulationView extends SimulationSnapshot {
  readonly error: SimulationError | null
  /** Simulate now instead of waiting out the debounce. */
  readonly run: () => void
}

export function useSimulation(
  circuit: Circuit,
  options: UseSimulationOptions = {}
): SimulationView {
  const {
    enabled = true,
    mode,
    shots,
    seed,
    debounceMs,
    createWorker,
  } = options
  const { t } = useTranslation('simulation')

  /** Built once and kept for the life of the component. */
  const [scheduler] = useState(() =>
    createSimulationScheduler({
      debounceMs,
      sharedMemory: sharedMemoryAvailable(),
    })
  )

  const spawn = createWorker ?? defaultWorker

  /**
   * Whether there is a worker on the other end of the scheduler right now.
   *
   * A ref rather than state because it is read by the effect below and never
   * rendered, and because React runs effects in declaration order: by the
   * time the scheduling effect runs, this one has already said whether the
   * worker exists. Scheduling into a disconnected scheduler would drop the
   * request and still flip the status to `scheduled` then `running` — hiding
   * the failure that is the actual news behind a run that can never answer.
   */
  const connected = useRef(false)

  useEffect(() => {
    let worker: SimulationWorkerLike
    try {
      worker = spawn()
    } catch (cause) {
      connected.current = false
      scheduler.fail({
        code: 'worker-unavailable',
        detail: cause instanceof Error ? cause.message : String(cause),
      })
      return
    }

    worker.onmessage = (event) => {
      scheduler.receive(event.data)
    }
    worker.onerror = (event) => {
      scheduler.fail({ code: 'worker-failed', detail: event.message })
    }
    // A reply that cannot be deserialised carries no `data`, so there is no
    // request id to match — `fail` clears the in-flight request without one,
    // which is the complete rescue for this half. The worker cannot help
    // here for the same reason: with no id it has nothing to answer.
    worker.onmessageerror = () => {
      scheduler.fail({
        code: 'worker-failed',
        detail: 'A reply from the simulator could not be deserialised.',
      })
    }
    scheduler.connect((request) => {
      worker.postMessage(request)
    })
    connected.current = true

    return () => {
      // Reset before disconnecting: the reset clears the pending debounce, so
      // no request is dispatched into a transport that is on its way out.
      connected.current = false
      scheduler.reset()
      scheduler.connect(null)
      worker.onmessage = null
      worker.onerror = null
      worker.onmessageerror = null
      worker.terminate()
    }
  }, [scheduler, spawn])

  const runOptions = useMemo<RunOptions>(
    () => ({ mode, shots, seed }),
    [mode, shots, seed]
  )

  useEffect(() => {
    if (!enabled || !connected.current) return
    scheduler.schedule(circuit, runOptions)
    // `spawn` is in the list although nothing here calls it: a respawned
    // worker starts with an empty checkpoint cache and the reset above wiped
    // the scheduler's memory of what was simulated, so the current circuit has
    // to be asked for again. React runs every cleanup before every setup, so
    // the reset is already done by the time this runs.
  }, [circuit, enabled, runOptions, scheduler, spawn])

  const snapshot = useSyncExternalStore(
    scheduler.subscribe,
    scheduler.getSnapshot
  )

  const failure = snapshot.failure
  const error = useMemo<SimulationError | null>(() => {
    if (failure === null) return null
    return {
      code: failure.code,
      operationId: failure.operationId,
      detail: failure.detail,
      message: t(`errors.${failure.code}`, {
        qubits: failure.qubits,
        limit: failure.limit,
      }),
    }
  }, [failure, t])

  const run = useCallback(() => {
    scheduler.flush()
  }, [scheduler])

  return { ...snapshot, error, run }
}

/**
 * Vite compiles this URL form into a bundled worker chunk; it is the only
 * spelling that survives both the dev server and the production build.
 */
function defaultWorker(): SimulationWorkerLike {
  return new Worker(new URL('./simulation.worker.ts', import.meta.url), {
    type: 'module',
  })
}
