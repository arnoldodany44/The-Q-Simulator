/**
 * One circuit, one run, one answer — the embed's whole simulation layer.
 *
 * ── Why this is not `useSimulation` ──────────────────────────────────────
 *
 * `features/simulation/useSimulation.ts` is the editor's hook and it is right
 * for the editor: it debounces a stream of edits, accumulates the invalidation
 * column so a run can resume from a checkpoint, cancels what has been
 * superseded, and dispatches past the browser's ceiling to the server over a
 * WebSocket. Every one of those exists because the circuit CHANGES.
 *
 * In an embed it never changes. There is one document, it arrives once, and
 * the answer to it is a constant. So none of that machinery has anything to
 * do, and all of it has a cost: `useSimulation` imports `lib/api` for the
 * server backend, which is the module that carries React Query, the session's
 * token provider and the socket — the exact three things an embed must not
 * ship (`fetchEmbed.ts` argues the token half). Reusing it would have meant
 * either dragging them in or adding a "no server, no debounce, no cancel"
 * mode to a hook that would then have two shapes and one test suite.
 *
 * What *is* shared is everything that decides an answer: the worker itself,
 * the protocol, the encode/decode pair, and the engine behind them. This file
 * adds no physics and no transport rules — it posts one message and reads one
 * reply.
 *
 * ── THE SHARED-MEMORY QUESTION IS ASKED, NOT ASSUMED ─────────────────────
 *
 * A framed document is never cross-origin isolated (`embed/headers.ts` argues
 * why, and why the embed therefore sends no COOP/COEP at all), so
 * `SharedArrayBuffer` is unavailable here — every time, not sometimes.
 * `sharedMemoryAvailable()` is what the request carries, exactly as in the
 * editor, so what runs is the documented transfer path in `encodeState`
 * rather than a second arrangement written for embeds. The one line that
 * would have been tempting — `sharedMemory: false`, hard-coded, since we know
 * — is the line that would make an embed opened top-level behave differently
 * from a framed one, and only the framed one has readers.
 *
 * ── A CIRCUIT PAST THE CEILING IS A SENTENCE, NOT A SERVER JOB ───────────
 *
 * The editor answers `MAX_CLIENT_QUBITS` by dispatching to `apps/api` (§4).
 * An embed must not: that would make an anonymous frame on an arbitrary
 * origin a way to spend this project's compute, at whatever rate the pages
 * embedding it are loaded. The worker refuses with `too-many-qubits` and the
 * view prints it — the diagram, the counters and the honest ceiling are still
 * the answer to "what is this circuit".
 *
 * ── A WORKER THAT CANNOT START IS REPORTED, NOT AWAITED ──────────────────
 *
 * Same rule as the editor's: constructing a `Worker` can throw — a policy that
 * forbids `worker-src`, a browser with workers disabled, a build whose chunk
 * did not ship — and a throw inside an effect is a blank frame with a stack
 * trace in a console nobody is reading. So it is a state: the drawing stays,
 * and one sentence says the analysis is not available.
 *
 * ── WHAT `sandbox="allow-scripts"` ALONE ACTUALLY DOES, WHICH IS NOTHING ──
 *
 * This comment used to name that configuration as the reason the state exists:
 * an opaque origin cannot construct a worker from a same-origin URL, so the
 * diagram would render and the analysis would not. That is wrong, and wrong in
 * the direction that tells a teacher a blank rectangle is expected behaviour.
 *
 * The failure happens far earlier than the worker. The built entry is
 * `<script type="module" crossorigin>`, and a module script is ALWAYS fetched
 * in CORS mode; from an opaque origin every request to the static host is
 * cross-origin, the host sends no `Access-Control-Allow-Origin` for
 * `/assets/*`, and every chunk fails — React, i18next, the entry, all of them.
 * `document.body.innerText` is the empty string. Nothing renders, so this
 * state is never reached and cannot be.
 *
 * Nor can it be fixed by adding CORS headers: the embed's own
 * `script-src 'self'` is evaluated against the document's origin, and an
 * opaque origin is "null", which matches no host. `allow-scripts
 * allow-same-origin` is the configuration that works and the one
 * `EmbedSnippet` and the three catalogs recommend — and they now say that
 * plainly instead of promising a degraded rendering that does not exist.
 */

import type { Statevector } from '@qsim/core'
import type { Circuit } from '@qsim/schema'
import { useEffect, useState } from 'react'

import { executionModeFor } from '../features/simulation/mode'
import {
  decodeState,
  sharedMemoryAvailable,
  type SimulationErrorCode,
  type SimulationRequest,
  type SimulationResponse,
} from '../features/simulation/protocol'
import type { ShotCounts } from '@qsim/core'

/**
 * Shots for a circuit that measures.
 *
 * Fixed, and fixed *low*: an embed has no control to change it, and a tally
 * nobody can re-roll should be cheap enough that six frames in one page cost
 * nothing worth measuring. Two thousand is enough that a Bell pair's two
 * outcomes land within about a percent of a half, which is the reading the
 * chart is for.
 */
export const EMBED_SHOTS = 2000

/**
 * The seed, so that the same address always draws the same tally.
 *
 * An embed is a figure in a document. A figure that changes every time the
 * page is refreshed is a figure a teacher cannot write a caption for, and one
 * whose difference from the caption looks like a bug rather than like
 * sampling.
 */
export const EMBED_SEED = 20260816

/** The state of the one run this hook makes. */
export type EmbedSimulation =
  | { readonly status: 'running' }
  | {
      readonly status: 'analytic'
      readonly state: Statevector
    }
  | {
      readonly status: 'sampled'
      readonly counts: ShotCounts
      readonly shots: number
    }
  | {
      readonly status: 'failed'
      readonly code: SimulationErrorCode
      /** Numbers the sentence interpolates: a ceiling, a register size. */
      readonly values: Readonly<Record<string, number>>
    }

/** How to obtain the worker. Production leaves it alone; tests pass a stub. */
export interface EmbedWorkerLike {
  postMessage(message: SimulationRequest): void
  terminate(): void
  onmessage: ((event: MessageEvent<SimulationResponse>) => void) | null
  onerror: ((event: ErrorEvent) => void) | null
}

export interface UseEmbedSimulationOptions {
  /**
   * How to obtain the worker. Production leaves it alone; tests pass a stub.
   *
   * Should be stable across renders, exactly as in `useSimulation`: a fresh
   * function each render terminates and respawns the worker on every paint.
   * It cannot *loop*, though, and that is worth knowing because the first
   * version of this hook did: nothing in the effect below sets state
   * synchronously, so spawning a worker never causes the render that would
   * spawn the next one. That property comes from deriving the answer rather
   * than resetting it — see below.
   */
  readonly createWorker?: () => EmbedWorkerLike
}

/**
 * The request id. An embed issues exactly one per worker, so this is a
 * constant rather than a counter — but the field is not dropped, because the
 * worker's staleness watermark reads it and a protocol with an optional id is
 * a protocol with two shapes.
 */
const ONLY_REQUEST = 1

function buildRequest(circuit: Circuit): SimulationRequest {
  const shared = sharedMemoryAvailable()
  const base = {
    kind: 'simulate',
    id: ONLY_REQUEST,
    circuit,
    // From the beginning: there is no previous answer to resume from, and
    // nothing will edit this document.
    fromColumn: 0,
    sharedMemory: shared,
  } as const

  if (executionModeFor(circuit) === 'trajectories') {
    return {
      ...base,
      mode: 'trajectories',
      shots: EMBED_SHOTS,
      seed: EMBED_SEED,
      throughColumn: null,
    }
  }

  return {
    ...base,
    mode: 'analytic',
    // The whole circuit, no shot noise nobody asked for (§5.3), no noise
    // model. An embed is the ideal reading; §3.3's comparison is a control
    // surface, and this document has none.
    throughColumn: null,
    sample: null,
    noise: null,
  }
}

/**
 * The numbers a failure sentence may interpolate, kept as a plain record so
 * the view can hand them straight to i18next without a per-code branch.
 */
function valuesOf(failure: {
  qubits?: number
  operations?: number
  shots?: number
  limit?: number
}): Record<string, number> {
  const values: Record<string, number> = {}
  if (failure.qubits !== undefined) values.qubits = failure.qubits
  if (failure.operations !== undefined) values.operations = failure.operations
  if (failure.shots !== undefined) values.shots = failure.shots
  if (failure.limit !== undefined) values.limit = failure.limit
  return values
}

/** Production's worker: the same module the editor runs, on its own chunk. */
function spawnWorker(): EmbedWorkerLike {
  return new Worker(
    new URL('../features/simulation/simulation.worker.ts', import.meta.url),
    { type: 'module' }
  )
}

/** What is on screen before an answer, and while a new circuit is running. */
const RUNNING: EmbedSimulation = { status: 'running' }

/**
 * THE ANSWER IS DERIVED, NOT RESET.
 *
 * The obvious shape — hold `EmbedSimulation` in state and set it back to
 * `running` at the top of the effect — has two defects, and the second is
 * severe. It renders one frame of the *previous* circuit's histogram under the
 * new circuit's diagram, because the reset only happens after that frame has
 * painted. And setting state synchronously in an effect body makes the effect
 * able to cause the render that re-runs it: with an unstable `createWorker`
 * that became an unbounded loop, which exhausts the heap rather than
 * flickering. It is how this hook was first written, and it took the test
 * process down with an out-of-memory rather than a failure.
 *
 * So the answer is stored *with the circuit it answers*, and `running` is what
 * comes out whenever those two disagree. The same move `ShareLink` makes for
 * its "copied" status, and for the same reason: a derived state cannot have a
 * frame in which it is false.
 *
 * @param circuit The document to run, or `null` while there is not one yet.
 *   Referential identity is the key, so it must be stable across renders;
 *   `EmbedApp` holds it in state, which makes that free.
 */
export function useEmbedSimulation(
  circuit: Circuit | null,
  options: UseEmbedSimulationOptions = {}
): EmbedSimulation {
  const createWorker = options.createWorker ?? spawnWorker
  const [answered, setAnswered] = useState<{
    readonly circuit: Circuit
    readonly value: EmbedSimulation
  } | null>(null)

  useEffect(() => {
    if (circuit === null) return

    const answer = (value: EmbedSimulation): void => {
      setAnswered({ circuit, value })
    }

    let worker: EmbedWorkerLike
    try {
      worker = createWorker()
    } catch (cause) {
      // See the header: a policy or a browser can refuse a worker. The drawing
      // is still an answer, so this is a state rather than a thrown error.
      console.error('the simulation worker could not start', cause)
      answer({ status: 'failed', code: 'worker-unavailable', values: {} })
      return
    }

    worker.onmessage = (event: MessageEvent<SimulationResponse>) => {
      const response = event.data
      if (response.kind === 'error') {
        answer({
          status: 'failed',
          code: response.failure.code,
          values: valuesOf(response.failure),
        })
        return
      }
      /*
       * `server` cannot arrive: this hook never dispatches a server run and
       * the worker has no way to produce one. Narrowed rather than asserted,
       * so that a protocol which grew a fourth shape is a compile error here
       * instead of a silent nothing on screen.
       */
      if (response.mode === 'analytic') {
        answer({ status: 'analytic', state: decodeState(response.state) })
        return
      }
      if (response.mode === 'trajectories') {
        answer({
          status: 'sampled',
          counts: response.counts,
          shots: response.shots,
        })
      }
    }

    worker.onerror = (event: ErrorEvent) => {
      console.error('the simulation worker failed', event.message)
      answer({ status: 'failed', code: 'worker-failed', values: {} })
    }

    worker.postMessage(buildRequest(circuit))

    return () => {
      worker.terminate()
    }
  }, [circuit, createWorker])

  // The answer, but only while it is an answer to the circuit on screen.
  return answered !== null && answered.circuit === circuit
    ? answered.value
    : RUNNING
}
