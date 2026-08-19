/**
 * The hardware routes of §8, as functions — §3.7, Phase 4.
 *
 * Same rules as `lessons.ts` beside it: the path comes from `@qsim/contract`'s
 * builders, the response is parsed with its wire schemas, and nothing is
 * declared here.
 *
 * ── WHAT IS AND IS NOT IN THIS FILE ──────────────────────────────────────
 *
 * §3.7 puts the token behind the backend — «el token se cifra en reposo y
 * **nunca** se expone al frontend; el backend actúa de proxy» — and the browser
 * therefore never speaks the provider's protocol, never holds a bearer token
 * and never sees a CRN. `.dependency-cruiser.cjs` enforces the strong half of
 * that: `apps/web` may not import `packages/ibm` at all.
 *
 * This file used to say "reads only", and that was true while §3.7 had no way
 * in. It has three writes now and the invariant is unchanged, because none of
 * them is the browser talking to IBM:
 *
 *  - `POST /hardware/credentials` hands an API key and a CRN to *our* API,
 *    once, over TLS, to be encrypted at rest. It travels **in** and never comes
 *    back: the credential a listing returns is `{id, provider, label,
 *    createdAt}` and there is no field in that shape for a secret.
 *  - `DELETE /hardware/credentials/:id` forgets one.
 *  - `POST /hardware/jobs` asks the API to submit. The browser names a circuit,
 *    a credential and a device; the API is what reaches the provider.
 *
 * What is still absent, and must stay absent, is any request to IBM from here.
 *
 * The comparison view is a reader of a *finished* job, and that is the whole
 * shape of it: one request, for one stored row, which renders without anything
 * being re-run. §3.7 wants results «guardados junto al circuito», and a page
 * that had to reach a device to draw them would be a page nobody could open
 * during a demonstration.
 */

import {
  CreateHardwareCredentialBody,
  CreateHardwareJobBody,
  HardwareBackendListEnvelope,
  hardwarePath,
  wireHardwareResponses,
} from '@qsim/contract'
import type {
  HardwareBackendResponse,
  HardwareCredential,
  HardwareJob,
} from '@qsim/contract'

import type { ApiClient } from './client.js'
import type { RequestContext } from './circuits.js'

/** `GET /hardware/jobs/:id` — one stored job, with its program and its result. */
export function getHardwareJob(
  client: ApiClient,
  id: string,
  context: RequestContext = {}
): Promise<HardwareJob> {
  return client
    .request({
      method: 'GET',
      path: hardwarePath.job(id),
      schema: wireHardwareResponses.HardwareJobEnvelope,
      ...context,
    })
    .then((envelope) => envelope.job)
}

/** `GET /hardware/credentials` — this caller's stored keys, as metadata. */
export function listHardwareCredentials(
  client: ApiClient,
  context: RequestContext = {}
): Promise<readonly HardwareCredential[]> {
  return client
    .request({
      method: 'GET',
      path: hardwarePath.credentials(),
      schema: wireHardwareResponses.HardwareCredentialListEnvelope,
      ...context,
    })
    .then((envelope) => envelope.credentials)
}

/**
 * `POST /hardware/credentials` — the one moment a key crosses this boundary.
 *
 * The body is parsed with the server's own schema before it is sent, so a key
 * that is obviously too short is a sentence beside the field rather than a 400
 * the reader has to interpret. What comes back is metadata: an id, a label and
 * a timestamp, and nothing that could be replayed.
 */
export function createHardwareCredential(
  client: ApiClient,
  request: CreateHardwareCredentialBody,
  context: RequestContext = {}
): Promise<HardwareCredential> {
  return client
    .request({
      method: 'POST',
      path: hardwarePath.credentials(),
      body: CreateHardwareCredentialBody.parse(request),
      schema: wireHardwareResponses.HardwareCredentialEnvelope,
      ...context,
    })
    .then((envelope) => envelope.credential)
}

/** `DELETE /hardware/credentials/:id` — forgets a key, permanently. */
export function deleteHardwareCredential(
  client: ApiClient,
  id: string,
  context: RequestContext = {}
): Promise<HardwareCredential> {
  return client
    .request({
      method: 'DELETE',
      path: hardwarePath.credential(id),
      schema: wireHardwareResponses.HardwareCredentialEnvelope,
      ...context,
    })
    .then((envelope) => envelope.credential)
}

/**
 * `GET /hardware/backends` — the devices one credential can see.
 *
 * The queue length is the field this exists for. §3.7's own note is that a
 * device queue is hours deep, and choosing between `ibm_marrakesh` with one job
 * waiting and `ibm_fez` with twenty-four thousand is the difference between a
 * demonstration and a promise to send the results later.
 */
export function listHardwareBackends(
  client: ApiClient,
  credentialId: string,
  context: RequestContext = {}
): Promise<readonly HardwareBackendResponse[]> {
  return client
    .request({
      method: 'GET',
      path: hardwarePath.backends(),
      query: { credentialId },
      schema: HardwareBackendListEnvelope,
      ...context,
    })
    .then((envelope) => envelope.backends)
}

/**
 * `POST /hardware/jobs` — submits, and answers with the row it wrote.
 *
 * The job comes back QUEUED, with no result: a device answers in minutes or
 * hours, so the row is the receipt and `useHardwareJob` is what watches it.
 * The caller's next move is the run page, which is why the id matters more here
 * than anything else in the response.
 */
export function createHardwareJob(
  client: ApiClient,
  request: CreateHardwareJobBody,
  context: RequestContext = {}
): Promise<HardwareJob> {
  return client
    .request({
      method: 'POST',
      path: hardwarePath.jobs(),
      body: CreateHardwareJobBody.parse(request),
      schema: wireHardwareResponses.HardwareJobEnvelope,
      ...context,
    })
    .then((envelope) => envelope.job)
}
