/**
 * The circuit routes' schemas, as this process uses them — §8.
 *
 * The shapes themselves are not here. Every request body and every response
 * lives in `@qsim/contract`, which `apps/web` imports too, because a client's
 * idea of a response drifting from the server's is the one class of bug this
 * monorepo exists to prevent. What is left in this file is the part that is
 * genuinely server-only:
 *
 *   - the path parameters, which are validated against `@qsim/db`'s handle
 *     pattern — a package the browser may not import (§12.3) and does not
 *     need to, since it holds handles rather than parsing them;
 *   - `toPage`, which assembles a page from a repository result.
 *
 * The response schemas are re-exported from the *server* instantiation of the
 * contract, whose timestamps are `z.date()`: the handler passes the `Date`
 * Prisma returned and `JSON.stringify` renders it as ISO-8601. The browser
 * imports the wire instantiation, which takes that string back to a `Date`.
 * See `packages/contract/src/circuits.ts` for why one schema cannot be both.
 */

import { CIRCUIT_HANDLE_PATTERN } from '@qsim/db'
import { serverCircuitResponses } from '@qsim/contract'
import { z } from 'zod'

export {
  CreateCircuitBody,
  CreateVersionBody,
  ForkCircuitBody,
  PaginationQuery,
  UpdateCircuitBody,
} from '@qsim/contract'

export const {
  CircuitCardResponse,
  CircuitDetailResponse,
  CircuitEnvelope,
  CircuitPageResponse,
  CircuitViewResponse,
  CircuitWithVersionResponse,
  VersionEnvelope,
  VersionPageResponse,
  VersionResponse,
  VersionSummaryResponse,
} = serverCircuitResponses

/**
 * The path segment that identifies a circuit.
 *
 * The pattern is a cheap gate, not a decision about what exists: it stops a
 * kilobyte of path, or a `%00`, from becoming an indexed query.
 */
export const CircuitHandleParams = z.object({
  id: z.string().regex(CIRCUIT_HANDLE_PATTERN),
})

export const VersionParams = CircuitHandleParams.extend({
  /*
   * Path segments arrive as strings, so this needs `coerce`. The upper bound
   * is arbitrary but not decorative: without it, `?n=1e308` reaches Postgres
   * as a number no integer column can hold.
   */
  n: z.coerce.number().int().min(1).max(1_000_000),
})

/** Wraps a page of rows in the envelope the contract declares. */
export function toPage<T>(
  items: readonly T[],
  total: number,
  page: number,
  perPage: number
): {
  items: T[]
  page: number
  perPage: number
  total: number
  totalPages: number
} {
  return {
    items: [...items],
    page,
    perPage,
    total,
    // `max(1, …)` so an empty first page still reports one page rather than
    // zero, which every pager component in existence renders badly.
    totalPages: Math.max(1, Math.ceil(total / perPage)),
  }
}
