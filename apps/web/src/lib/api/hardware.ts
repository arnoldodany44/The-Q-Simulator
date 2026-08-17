/**
 * The hardware routes of §8, as functions — §3.7, Phase 4.
 *
 * Same rules as `lessons.ts` beside it: the path comes from `@qsim/contract`'s
 * builders, the response is parsed with its wire schemas, and nothing is
 * declared here.
 *
 * ── WHAT IS AND IS NOT IN THIS FILE ──────────────────────────────────────
 *
 * Reads only. §3.7 puts the token behind the backend — «el token se cifra en
 * reposo y **nunca** se expone al frontend; el backend actúa de proxy» — and
 * the browser therefore never speaks the provider's protocol, never holds a
 * bearer token and never sees a CRN. `.dependency-cruiser.cjs` enforces the
 * strong half of that (`apps/web` may not import `packages/ibm` at all); this
 * file is the weak half, which is simply that there is nothing here but a `GET`.
 *
 * The comparison view is a reader of a *finished* job, and that is the whole
 * shape of it: one request, for one stored row, which renders without anything
 * being re-run. §3.7 wants results «guardados junto al circuito», and a page
 * that had to reach a device to draw them would be a page nobody could open
 * during a demonstration.
 */

import { hardwarePath, wireHardwareResponses } from '@qsim/contract'
import type { HardwareJob } from '@qsim/contract'

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
