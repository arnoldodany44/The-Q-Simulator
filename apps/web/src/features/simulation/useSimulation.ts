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
 *
 * THE SERVER IS A SECOND TRANSPORT, CONNECTED THE SAME WAY (§4). A circuit past
 * the browser's ceiling is dispatched to `apps/api` instead of to the worker,
 * and this hook owns that connection for the same reason it owns the worker's:
 * something has to tie a lifetime to a component. It is connected only when an
 * API client is actually available, because the alternative — a transport that
 * silently drops requests — would replace an honest "past what a tab can hold"
 * with a spinner that never resolves.
 *
 * The socket is built once per hook and shared by every run it dispatches; it
 * opens on the first watched run and closes when the last one goes away, so a
 * reader who never crosses the ceiling never opens a connection at all.
 */

import type { Circuit } from '@qsim/schema'
import {
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from 'react'
import { useTranslation } from 'react-i18next'

import {
  ApiContext,
  getSimulationRun,
  resolveSocketUrl,
  submitSimulation,
} from '../../lib/api'
import { currentAccessTokenProvider } from '../../lib/api/session'
import {
  sharedMemoryAvailable,
  type SimulationErrorCode,
  type SimulationRequest,
  type SimulationResponse,
} from './protocol'
import { createRunSocket } from './runSocket'
import type { RunSocket } from './runSocket'
import {
  createSimulationScheduler,
  type RunOptions,
  type SimulationSnapshot,
} from './scheduler'
import { createServerBackend } from './serverRun'

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
  /**
   * How to obtain the progress socket, for the same reason and with the same
   * requirement: stable across renders, because a fresh one would tear the
   * connection down and re-subscribe on every keystroke.
   *
   * A test passes a stand-in it can open, drop and reopen on demand; production
   * leaves it alone and gets one pointed at the API's own origin. Returning
   * `null` is legitimate and is what a client with no socket looks like — the
   * server backend then falls back to polling, which it does anyway.
   */
  readonly createSocket?: () => RunSocket | null
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
  /**
   * Stop waiting for whatever is in flight.
   *
   * Means different things to the two backends and the panel says which. On the
   * worker it drops a request that has not started and withholds the answer to
   * one that has; on the server it unsubscribes and stops polling, because §8
   * gives `/simulate` no delete and a job already inside a killable child is
   * going to finish. The run keeps its id and stays readable either way.
   */
  readonly cancel: () => void
}

export function useSimulation(
  circuit: Circuit,
  options: UseSimulationOptions = {}
): SimulationView {
  const {
    enabled = true,
    mode,
    sample,
    shots,
    seed,
    throughColumn,
    noise,
    debounceMs,
    createWorker,
    createSocket,
  } = options
  const { t } = useTranslation('simulation')
  /*
   * `useContext` rather than `useApiClient`, and the difference is the whole
   * point: this hook must work with no provider at all. The editor renders in
   * tests and on a page that has not booted the API layer, and a throw there
   * would take down the panel over a backend the reader may never need.
   * `null` is the "no server" state, and the scheduler already has honest
   * behaviour for it — §4's ceiling, on screen, exactly as before.
   */
  const client = useContext(ApiContext)

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

  /*
   * The server backend of §4, connected for as long as there is an API client
   * to reach. Its own effect rather than a branch inside the worker's, because
   * the two have different lifetimes: a worker is respawned when `spawn`
   * changes and takes its checkpoint cache with it, while this depends on the
   * client from context and on nothing else.
   */
  useEffect(() => {
    /*
     * Two ways to have no server, and they mean the same thing here. `client
     * === null` is no provider mounted; a null `baseUrl` is a build compiled
     * with no `VITE_API_URL`, which is the deployment the landing page and the
     * editor are perfectly happy in.
     *
     * Not a failure either way. A reader with no API is a reader for whom the
     * browser's ceiling really is the ceiling, which is what the scheduler
     * then says.
     */
    if (client === null || client.baseUrl === null) {
      scheduler.connectServer(null)
      return
    }

    const socketOrigin = client.baseUrl

    const socket =
      createSocket === undefined
        ? createRunSocket({
            url: resolveSocketUrl(socketOrigin),
            // Read per connection, never captured: a reconnect an hour later
            // must not present the token this socket was opened with, and the
            // reader may have signed in or out in between.
            getToken: async () =>
              (await currentAccessTokenProvider()()) ?? null,
          })
        : createSocket()

    const backend = createServerBackend({
      submit: (body, signal) =>
        submitSimulation(client, body, signal === undefined ? {} : { signal }),
      fetchRun: (runId, signal) =>
        getSimulationRun(client, runId, signal === undefined ? {} : { signal }),
      socket,
      deliver: (response) => {
        scheduler.receive(response)
      },
      // Through `receive` rather than `fail`, so a failure that belongs to a
      // superseded request is dropped by the same line that drops its result.
      fail: (id, failure) => {
        scheduler.receive({ kind: 'error', id, failure })
      },
      report: (update) => {
        scheduler.report(update)
      },
    })
    scheduler.connectServer(backend.dispatch)

    return () => {
      scheduler.connectServer(null)
      // Released before the socket goes, so the backend's own teardown can
      // still unsubscribe cleanly rather than leaving a channel behind — and
      // so its poll timer stops rather than reading a run nobody is watching
      // for as long as the tab lives.
      backend.dispose()
      socket?.close()
    }
  }, [client, createSocket, scheduler])

  /*
   * `noise` is a fresh object on most renders — the panel rebuilds it from its
   * own state — so this memo is not what stops the re-dispatch. The scheduler's
   * `sameNoise` compares field by field and drops the request when nothing
   * moved; this list only decides how often it is asked.
   */
  const runOptions = useMemo<RunOptions>(
    () => ({ mode, sample, shots, seed, throughColumn, noise }),
    [mode, sample, shots, seed, throughColumn, noise]
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

  const cancel = useCallback(() => {
    scheduler.cancel()
  }, [scheduler])

  return { ...snapshot, error, run, cancel }
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
