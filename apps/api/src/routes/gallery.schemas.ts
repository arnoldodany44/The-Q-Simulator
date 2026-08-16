/**
 * The gallery routes' schemas, as this process uses them — §8, M1.5.
 *
 * Same division as `circuits.schemas.ts`: the shapes live in `@qsim/contract`
 * because `apps/web` holds the other end of them, and what stays here is what
 * is genuinely server-only — the path parameter, validated against a pattern
 * from `@qsim/db`, a package the browser may not import (§12.3).
 */

import { serverCircuitResponses } from '@qsim/contract'
import { USERNAME_PATTERN } from '@qsim/db'
import { z } from 'zod'

export { GalleryQuerySchema, StarStateResponse } from '@qsim/contract'

export const { GalleryPageResponse, UserCircuitsResponse } =
  serverCircuitResponses

/**
 * The path segment that names an author.
 *
 * A cheap gate rather than a decision about who exists: it stops a kilobyte
 * of path, or a `%00`, from becoming an indexed lookup. The unique index on
 * `User.username` is what decides existence, and a username that does not
 * match this could never have been issued by `ensureUser`.
 */
export const UsernameParams = z.object({
  username: z.string().regex(USERNAME_PATTERN),
})
