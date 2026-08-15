/**
 * The simulation worker — §5.6.1, M0.6.
 *
 * Phase 1 of the performance strategy is "pure TypeScript in a Web Worker",
 * and this is the worker. It owns the engine, it owns the checkpoint cache,
 * and it owns nothing else: the decisions about *when* to simulate live on the
 * main thread in `scheduler.ts`, and the work itself lives in `job.ts`. What
 * is left here is the message loop, which is the only part that needs a real
 * worker to run at all.
 *
 * ────────────────────────────────────────────────────────────────────────
 * WHAT CANCELLATION CAN AND CANNOT DO, HONESTLY.
 *
 * A worker is single-threaded. While a run is executing, messages queue up
 * behind it and no `cancel` can interrupt it — stopping a run mid-flight would
 * need an abort flag polled by the kernel loop, which is a Phase 2 concern
 * along with the Rust/WASM core. What this loop does instead is everything
 * that does not require pre-empting the kernel:
 *
 *  - **Superseded jobs never start.** The inbox keeps only the newest request;
 *    anything queued behind it during a long run is dropped unrun. Ten edits
 *    while a 20-qubit circuit is simulating cost one further simulation, not
 *    ten.
 *  - **A cancelled job never answers.** After finishing, the loop hands the
 *    event loop back for one task before posting. Any `cancel` that arrived
 *    during the run is processed in that gap, so a superseded result is
 *    dropped here rather than copied across the thread boundary for the
 *    scheduler to discard.
 *
 * Dropping a queued job unrun is only safe because of how the scheduler
 * accounts for invalidation: `fromColumn` accumulates a minimum that is
 * cleared only by a *result*, so an edit whose job was dropped is still
 * covered by the next request. See point 3 of the scheduler's header.
 *
 * ────────────────────────────────────────────────────────────────────────
 * EVERY SIMULATE REQUEST TERMINATES IN EXACTLY ONE POSTED RESPONSE.
 *
 * A result, a coded failure, or — for anything `runJob` did not foresee — a
 * `worker-failed` error posted by the drain loop's own catch. Nothing may
 * escape as a rejected promise: a worker's unhandled rejection does not fire
 * `worker.onerror`, so it reaches the main thread as silence, and silence is
 * indistinguishable from a very long simulation. The editor would wait
 * forever.
 *
 * There is deliberately no `onmessageerror` on this side. A `messageerror`
 * event carries no `data`, so there is no request id to answer with and the
 * reply would be dropped by the scheduler's staleness guard anyway; the
 * matching handler in `useSimulation` is where that case is rescued, because
 * the main thread is the one that knows what it was waiting for.
 *
 * ────────────────────────────────────────────────────────────────────────
 * WHY A WATERMARK AND NOT A SET OF CANCELLED IDS. Ids only ever go up, and a
 * `cancel` can only name a request that was already issued — so every id at or
 * below the highest cancelled one is dead, and one number replaces a set that
 * would otherwise grow for as long as the tab is open.
 */

import { createCheckpoints } from '@qsim/core'

import { runJob } from './job'
import {
  sharedMemoryAvailable,
  type SimulateRequest,
  type SimulationRequest,
  type SimulationResponse,
} from './protocol'

/**
 * The worker's global. `globalThis` is not typed as one here because the app's
 * `lib` list carries both DOM and WebWorker declarations, and the DOM's `self`
 * wins; the cast picks the half this file actually runs in.
 */
const scope = globalThis as unknown as DedicatedWorkerGlobalScope

/**
 * The incremental cache of §5.6.3, one per worker and therefore one per
 * document being edited. It is deliberately never sent anywhere: at 20 qubits
 * its states are 16 MB each, so shipping it to the main thread would cost more
 * than the re-simulation it exists to avoid.
 */
const checkpoints = createCheckpoints()

/** Decided once: the isolation of the page cannot change while it is loaded. */
const sharedMemory = sharedMemoryAvailable()

/**
 * A `SharedArrayBuffer` may be sent only when *both* scopes can handle one.
 *
 * The worker's own scope is not evidence about the main thread's: a
 * deployment that sets COOP/COEP for the document but serves this chunk
 * without them (or a worker made from a blob) makes the two disagree, and
 * posting a buffer the receiver cannot accept throws `DataCloneError` inside
 * `answer` and answers `worker-failed` — a broken editor where §5.6 promises
 * only a slower one. `request.sharedMemory` is what the main thread said
 * about itself, which is the half this side cannot observe.
 */
function transportFor(request: SimulateRequest): boolean {
  return sharedMemory && request.sharedMemory
}

/** At most one entry matters — the newest. See the header. */
const inbox: SimulateRequest[] = []
let cancelledThrough = 0
let draining = false

scope.onmessage = (event: MessageEvent<SimulationRequest>) => {
  const request = event.data
  if (request.kind === 'cancel') {
    cancelledThrough = Math.max(cancelledThrough, request.id)
    return
  }
  inbox.push(request)
  void drain()
}

async function drain(): Promise<void> {
  if (draining) return
  draining = true
  try {
    while (inbox.length > 0) {
      const request = inbox[inbox.length - 1]
      inbox.length = 0
      if (request === undefined || request.id <= cancelledThrough) continue

      /*
       * THE INVARIANT: every `simulate` request terminates in exactly one
       * posted response, whatever happens. `runJob` classifies every failure
       * it expects, so anything arriving here is a bug in this app — but a
       * bug that escaped as a rejected promise would reach nobody at all. An
       * unhandled rejection inside a worker does not fire `worker.onerror`,
       * so the main thread would see no error, no result and no way to ask
       * again: the editor would say `running` until the tab is closed.
       *
       * The `try` is inside the `while`, not around it, so a request that
       * throws does not take the ones queued behind it down with it.
       */
      try {
        const job = runJob(checkpoints, request, transportFor(request))

        // Hand the event loop back before answering. Everything that arrived
        // while the run blocked it — newer edits, the cancel for this very
        // job — is queued ahead of this task and is processed in the gap.
        await yieldToInbox()
        if (request.id <= cancelledThrough) continue

        answer(job.response, [...job.transfer])
      } catch (cause) {
        // Posted without re-checking `cancelledThrough`: if the job really
        // was cancelled the scheduler drops this on its id check, which is
        // harmless, whereas skipping the post would wedge the editor for a
        // throw that happened before the watermark check above.
        answer(
          {
            kind: 'error',
            id: request.id,
            failure: {
              code: 'worker-failed',
              detail: cause instanceof Error ? cause.message : String(cause),
            },
          },
          []
        )
      }
    }
  } finally {
    draining = false
  }
}

/**
 * The one function in this file with a total no-throw guarantee.
 *
 * It is what `drain`'s catch calls, so if it could throw it would reproduce
 * the very unhandled rejection that catch exists to prevent — one level up,
 * and this time with nothing left to catch it.
 */
function answer(response: SimulationResponse, transfer: Transferable[]): void {
  try {
    scope.postMessage(response, transfer)
  } catch (cause) {
    // Posting can still fail on the transport itself — a detached buffer, or a
    // `SharedArrayBuffer` the page turns out not to be allowed to send. The
    // reply below carries no buffers, so it cannot fail the same way, and the
    // editor gets an error state instead of a request that never answers.
    try {
      scope.postMessage(
        {
          kind: 'error',
          id: response.id,
          failure: {
            code: 'worker-failed',
            detail: cause instanceof Error ? cause.message : String(cause),
          },
        } satisfies SimulationResponse,
        []
      )
    } catch (fallbackCause) {
      // Nothing can be reported to the main thread from here — the channel
      // itself is gone. Swallowing keeps the drain loop alive for the next
      // request; the scheduler's own `worker.onerror` and the user's next
      // edit are what recover from a channel this broken.
      console.error(fallbackCause)
    }
  }
}

function yieldToInbox(): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, 0)
  })
}
