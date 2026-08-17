/**
 * The API key routes' schemas, as this process uses them — §3.5.
 *
 * The same division every other `*.schemas.ts` in this directory makes: the
 * wire shapes live in `@qsim/contract` because `apps/web` holds the other end
 * of them, and what stays here is the server-only part — the path parameter,
 * bounded against the id format this system actually mints.
 */

import { serverApiKeyResponses } from '@qsim/contract'
import { z } from 'zod'

export { CreateApiKeyBody } from '@qsim/contract'

/**
 * The key's id in the path.
 *
 * A `cuid(2)` is 24 characters of lowercase alphanumerics. Bounded rather than
 * left as a free string for the reason every other id parameter here is: an
 * unbounded path segment reaches the database as a value, and the cheapest
 * place to refuse a kilobyte of it is the parser.
 */
export const ApiKeyIdParams = z.object({
  id: z.string().min(1).max(64),
})

export const { ApiKeyEnvelope, ApiKeyListEnvelope, ApiKeyCreatedEnvelope } =
  serverApiKeyResponses
