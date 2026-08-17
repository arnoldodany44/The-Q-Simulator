/**
 * The embed route's schemas, as this process uses them — §3.4, §11.
 *
 * Same division as every other `*.schemas.ts` here: what both ends must agree
 * on lives in `@qsim/contract`, and what stays behind is the part that is
 * genuinely server-only — the path parameter, validated against `@qsim/db`'s
 * handle pattern, a package the browser may not import (§12.3).
 *
 * Nothing in the response is a timestamp, so unlike the circuit and lesson
 * schemas there is no server/wire pair to pick from: one object serialises
 * here and parses there.
 */

import { EmbedCircuitResponse } from '@qsim/contract'
import { CIRCUIT_HANDLE_PATTERN } from '@qsim/db'
import { z } from 'zod'

export { EmbedCircuitResponse }

/**
 * The handle this embed names.
 *
 * Called `handle` rather than `id` — the one route in this API that spells it
 * that way — because only a *slug* reaches an UNLISTED circuit, so the name
 * says which of the two handles is the useful one here. The pattern is the
 * same cheap gate `CircuitHandleParams` applies: it stops a kilobyte of path,
 * or a `%00`, from reaching an indexed query.
 */
export const EmbedHandleParams = z.object({
  handle: z.string().regex(CIRCUIT_HANDLE_PATTERN),
})
