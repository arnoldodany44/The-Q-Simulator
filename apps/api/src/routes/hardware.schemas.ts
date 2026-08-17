/**
 * The hardware routes' schemas, as this process uses them — §8, Phase 4.
 *
 * The same division as `lessons.schemas.ts`: everything both ends must agree on
 * lives in `@qsim/contract`, and what stays here is the server-side
 * serialisation half — Fastify serialises through `serverHardwareResponses`,
 * whose timestamps are the `Date`s a handler holds, while the browser parses
 * through the wire twin, whose timestamps are the ISO-8601 strings that arrive.
 *
 * The params and query schemas are local because they are about *this* router:
 * a client builds a path with `hardwarePath`, it never sends a `:id` anywhere.
 * Both are bounded and character-classed, which is the same gate every other
 * route in this API puts in front of a path parameter — an id off the wire that
 * reaches a Prisma `where` must not be able to be a kilobyte.
 */

import { serverHardwareResponses } from '@qsim/contract'
import { z } from 'zod'

export {
  CreateHardwareCredentialBody,
  CreateHardwareJobBody,
  HardwareBackendListEnvelope,
  MAX_HARDWARE_JOB_PAGE,
} from '@qsim/contract'

export const {
  HardwareCredentialEnvelope,
  HardwareCredentialListEnvelope,
  HardwareJobEnvelope,
  HardwareJobListEnvelope,
} = serverHardwareResponses

/** A cuid2 is 24 characters; 64 is a cheap ceiling and not a format claim. */
const IdSchema = z
  .string()
  .min(1)
  .max(64)
  .regex(/^[A-Za-z0-9_-]+$/)

export const HardwareIdParams = z.object({ id: IdSchema })

/**
 * Which credential a backend listing is read with.
 *
 * Required, and not defaulted to "the caller's only one". §3.7 has each person
 * bring their own token so that the cost of a run lands on the right allowance,
 * and a person may hold two — a personal key and an employer's. Guessing which
 * one to ask with would be guessing whose ten minutes to spend, and the guess
 * would be invisible in the answer.
 */
export const HardwareBackendsQuery = z.object({ credentialId: IdSchema })

/** `?circuit=` narrows the job list to one circuit. Optional. */
export const HardwareJobsQuery = z.object({
  circuit: IdSchema.optional(),
})
