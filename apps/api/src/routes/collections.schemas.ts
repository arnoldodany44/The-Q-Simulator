/**
 * The collection routes' schemas, as this process uses them — §3.4, M1.9.
 *
 * The shapes are in `@qsim/contract`; the path parameters are here, validated
 * against `@qsim/db`'s handle patterns, which the browser may not import
 * (§12.3) and does not need to.
 */

import { serverCollectionResponses } from '@qsim/contract'
import { CIRCUIT_HANDLE_PATTERN } from '@qsim/db'
import { z } from 'zod'

export {
  AddCollectionItemBody,
  CreateCollectionBody,
  PaginationQuery,
  UpdateCollectionBody,
} from '@qsim/contract'

export const {
  CollectionCardResponse,
  CollectionEnvelope,
  CollectionMembershipResponse,
  CollectionPageResponse,
  CollectionViewResponse,
} = serverCollectionResponses

/**
 * The path segment that names a collection.
 *
 * A collection's id is a `cuid(2)`, which is the same alphabet and roughly the
 * same length as the circuit handles `CIRCUIT_HANDLE_PATTERN` already
 * describes — so the pattern is reused rather than a second, subtly different
 * one being written beside it. It is a cheap gate and not a decision about
 * what exists: it stops a kilobyte of path, or a `%00`, from becoming an
 * indexed lookup, and the unique index is what decides existence.
 */
export const CollectionIdParams = z.object({
  id: z.string().regex(CIRCUIT_HANDLE_PATTERN),
})

/** A collection and one circuit inside it — `DELETE .../items/:circuitId`. */
export const CollectionMemberParams = CollectionIdParams.extend({
  circuitId: z.string().regex(CIRCUIT_HANDLE_PATTERN),
})
