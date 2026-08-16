/**
 * The simulation routes' schemas, as this process uses them — §8.
 *
 * The shapes live in `@qsim/contract`, which `apps/web` imports too; what is
 * left here is the server-only part — the path parameter, and the projection
 * from a stored row onto the wire shape.
 *
 * The response schemas come from the *server* instantiation of the contract,
 * whose timestamps are `z.date()`: the handler passes the `Date` Prisma
 * returned and `JSON.stringify` renders it as ISO-8601. See
 * `packages/contract/src/circuits.ts` for why one schema cannot be both.
 */

import { serverSimulateResponses } from '@qsim/contract'
import type { StoredRun } from '@qsim/db'
import { parseStoredResult } from '@qsim/jobs'
import type { JobProgress } from '@qsim/jobs'
import { z } from 'zod'

export { SimulateBody } from '@qsim/contract'

export const { RunResponse, RunEnvelope } = serverSimulateResponses

/**
 * The path segment that identifies a run.
 *
 * A cuid2 is 24 characters of `[a-z0-9]`; the bound and the character class are
 * a cheap gate that stops a kilobyte of "run id" from becoming an indexed
 * query, exactly as `CircuitHandleParams` does for a circuit.
 */
export const RunParams = z.object({
  runId: z
    .string()
    .min(1)
    .max(64)
    .regex(/^[A-Za-z0-9_-]+$/),
})

/**
 * A stored row as the wire describes it.
 *
 * `result` goes through `parseStoredResult` rather than being cast, for the
 * reason every read of a JSON column in this project does: the column holds
 * whatever some past version of this code wrote, and a shape that no longer
 * parses must surface as "no readable result" instead of as a serialisation
 * error on the response path — the worst place to discover one.
 *
 * `errorMessage` travels as `error` and carries a `SimulationFailureCode`, not
 * a sentence. The client translates it into three catalogs (D2).
 */
export interface RunProjectionExtras {
  readonly progress?: JobProgress | null
  /**
   * The cost model's answer for this run, in milliseconds, or null.
   *
   * Only `POST /simulate` can supply it: the estimate is computed from the
   * circuit, and the stored row does not keep one (§7). See the field's own
   * note in `@qsim/contract` for why that is a statement about what each call
   * holds rather than an omission.
   */
  readonly estimatedDurationMs?: number | null
}

export function toRunResponse(
  run: StoredRun,
  extras: RunProjectionExtras = {}
): z.input<typeof RunResponse> {
  return {
    id: run.id,
    status: run.status,
    mode: run.mode,
    shots: run.shots,
    circuitId: run.circuitId,
    createdAt: run.createdAt,
    durationMs: run.durationMs,
    estimatedDurationMs: extras.estimatedDurationMs ?? null,
    result: parseStoredResult(run.result),
    error: run.errorMessage,
    progress: extras.progress ?? null,
  }
}
