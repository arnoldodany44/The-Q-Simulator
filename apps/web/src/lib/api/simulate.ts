/**
 * `POST /simulate` and `GET /simulate/:runId`, as two functions — §8, §4.
 *
 * Thin like every other module here: the path comes from `@qsim/contract`'s
 * builders, the request body is its schema's input type, and the response is
 * parsed with its wire schema. Nothing is declared in this file.
 *
 * ── There is no `wait` and no polling loop here ───────────────────────────
 *
 * `POST` answers 201, 202 or 200 and all three carry the same envelope, so a
 * caller reads `run.status` and never the status code — which is the whole
 * reason the contract shaped it that way. What happens next belongs to
 * `features/simulation`: the socket pushes progress, and this `GET` is what
 * reads the answer. Putting the loop here would make the transport a thing with
 * a lifecycle, and there would then be two places that decide when a run is
 * finished.
 *
 * ── And no React Query ────────────────────────────────────────────────────
 *
 * A run is not a cached resource. It is a one-shot piece of work whose identity
 * is a request id the scheduler minted, whose staleness rule is "is this still
 * the run we are waiting for" rather than a time, and whose result must be
 * discarded — not shown stale — the moment the circuit changes. That is exactly
 * the rule `features/simulation`'s scheduler already implements for the
 * in-browser worker, and a second cache with a second notion of staleness
 * beside it is how the two start disagreeing.
 */

import { simulatePath, wireSimulateResponses } from '@qsim/contract'
import type { SimulateRequest, SimulationRun } from '@qsim/contract'

import type { ApiClient } from './client.js'
import type { RequestContext } from './circuits.js'

/**
 * Ask the server to run a circuit.
 *
 * The returned run may already be finished — a small circuit submitted for an
 * authoritative answer comes back DONE inside the synchronous window — or it
 * may be QUEUED with nothing but an id. The caller branches on `run.status`.
 */
export async function submitSimulation(
  client: ApiClient,
  body: SimulateRequest,
  context: RequestContext = {}
): Promise<SimulationRun> {
  const envelope = await client.request({
    method: 'POST',
    path: simulatePath.collection(),
    body,
    schema: wireSimulateResponses.RunEnvelope,
    ...context,
  })
  return envelope.run
}

/**
 * Read a run.
 *
 * This is the authoritative answer and the only one: the socket carries
 * notifications, never results (`@qsim/contract`'s `socket.ts` argues why), so
 * every finished run is read through here — including one that finished while
 * the socket was disconnected, which is what makes reconnection recoverable
 * without replaying anything.
 */
export async function getSimulationRun(
  client: ApiClient,
  runId: string,
  context: RequestContext = {}
): Promise<SimulationRun> {
  const envelope = await client.request({
    method: 'GET',
    path: simulatePath.run(runId),
    schema: wireSimulateResponses.RunEnvelope,
    ...context,
  })
  return envelope.run
}
