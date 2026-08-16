/**
 * Collections, as the wire carries them — §3.4, milestone M1.9.
 *
 * ── The field that is the whole point: `withheldItemCount` ────────────────
 *
 * A collection's visibility governs the collection. It never governs what is
 * inside it: the items come back through `listableCircuitFilter` like every
 * other listing, so a PUBLIC collection holding a PRIVATE circuit shows the
 * reader nothing they could not already have found. The argument is written
 * out in `@qsim/db`'s `collections.ts`, which is where it is enforced.
 *
 * What lives *here* is the consequence for the response shape. A collection of
 * five that returns two items is indistinguishable from a collection of two,
 * and a reader who followed a link to somebody's "Oracle algorithms" would be
 * told, wrongly, that it is nearly empty. So the envelope carries the number
 * of items that were withheld, and an interface can say so.
 *
 * That number is a deliberate disclosure and it is bounded to exactly what it
 * says: a count. No id, no slug, no title — nothing that could be turned into
 * a request. "This collection contains things you cannot see" is already
 * implied by somebody having curated it; "it contains *this* circuit" is not,
 * and is never said.
 *
 * `itemCount` beside it is the stored total, which the owner sees as the
 * length of their own list and a stranger sees as the length of a list they
 * are only shown part of. Both numbers travel because the difference between
 * them is the fact worth rendering.
 */

import { storableProse, storableText } from '@qsim/schema'
import { z } from 'zod'
import {
  serverCircuitResponses,
  serverTimestamp,
  wireCircuitResponses,
  wireTimestamp,
} from './circuits.js'
import { VisibilitySchema, Visibility } from './visibility.js'

export const MAX_COLLECTION_TITLE_LENGTH = 120
export const MAX_COLLECTION_DESCRIPTION_LENGTH = 1000

/**
 * Most circuits one collection may hold. Mirrors `MAX_COLLECTION_ITEMS` in
 * `@qsim/db`, which is the authority; `apps/api` asserts the two agree.
 *
 * It is not a taste limit. The items of a collection are resolved with an
 * `IN (…)` over their ids on a route an anonymous reader can call, and the
 * response carries a full card — thumbnail included — for each one.
 */
export const MAX_COLLECTION_ITEMS = 200

const CollectionTitleSchema = storableText(
  z.string().trim().min(1).max(MAX_COLLECTION_TITLE_LENGTH)
)

const CollectionDescriptionSchema = storableProse(
  z.string().trim().max(MAX_COLLECTION_DESCRIPTION_LENGTH)
).nullable()

export const CreateCollectionBody = z.object({
  title: CollectionTitleSchema,
  description: CollectionDescriptionSchema.optional(),
  /*
   * PRIVATE by default, like a circuit. The safe default is the one that
   * publishes nothing when a client forgets to say.
   */
  visibility: VisibilitySchema.default(Visibility.PRIVATE),
})

export const UpdateCollectionBody = z
  .object({
    title: CollectionTitleSchema.optional(),
    description: CollectionDescriptionSchema.optional(),
    visibility: VisibilitySchema.optional(),
  })
  .refine((body) => Object.keys(body).length > 0, {
    error: 'at least one field must be present',
  })

/**
 * Adding a circuit to a collection.
 *
 * The circuit travels as a *handle* — its slug or its id, exactly as
 * `GET /circuits/:id` accepts either — because the server resolves it through
 * the same `findReadable` every other route uses. That is what makes "you
 * cannot collect what you cannot see" true in the query rather than merely
 * intended: somebody else's PRIVATE circuit is a 404 here, as it is on GET.
 */
export const AddCollectionItemBody = z.object({ circuit: z.string() })

export type CreateCollectionRequest = z.input<typeof CreateCollectionBody>
export type UpdateCollectionRequest = z.input<typeof UpdateCollectionBody>
export type AddCollectionItemRequest = z.input<typeof AddCollectionItemBody>

function buildCollectionResponses<
  Timestamp extends z.ZodType,
  Owner extends z.ZodType,
  Card extends z.ZodType,
>(timestamp: Timestamp, owner: Owner, circuitCard: Card) {
  /** A collection as a listing shows it: no items, just what it is. */
  const CollectionCardResponse = z.object({
    id: z.string(),
    title: z.string(),
    description: z.string().nullable(),
    visibility: VisibilitySchema,
    /** How many circuits it holds, including ones this viewer cannot see. */
    itemCount: z.int(),
    createdAt: timestamp,
    updatedAt: timestamp,
    owner,
  })

  /**
   * One collection's page: what it is, what is in it that this viewer may
   * see, and how much was withheld.
   *
   * The items ride in the envelope rather than on the card for the same
   * reason `starred` does in a gallery page: they are not a property of the
   * collection, they are the answer to "what may *this viewer* see in it", and
   * putting them on the resource would oblige every route that returns a
   * collection — create, patch, the owner's index — to answer a question it
   * has no reason to ask.
   */
  const CollectionViewResponse = z.object({
    collection: CollectionCardResponse,
    items: z.array(circuitCard),
    /** See the header. A count, and never a handle. */
    withheldItemCount: z.int(),
    /**
     * The ids on this page this viewer has starred, exactly as a gallery page
     * carries them and for the same reason: a star is a property of the pair
     * (circuit, viewer), not of the circuit, and the cards here are the same
     * cards with the same star button on them. Without it every card in a
     * collection would draw an empty star for a circuit the reader starred
     * yesterday. Empty for an anonymous caller, who has none to have.
     */
    starred: z.array(z.string()),
  })

  return {
    CollectionCardResponse,
    CollectionViewResponse,
    CollectionEnvelope: z.object({ collection: CollectionCardResponse }),
    CollectionPageResponse: z.object({
      items: z.array(CollectionCardResponse),
      page: z.int(),
      perPage: z.int(),
      total: z.int(),
      totalPages: z.int(),
    }),
    /**
     * Which of the caller's *own* collections already hold a given circuit —
     * what an "add to collection" control needs so it does not offer an
     * option that would do nothing.
     *
     * Only ever the caller's own, which is why it is a bare list of ids and
     * needs no visibility story: every id in it names a collection the caller
     * owns.
     */
    CollectionMembershipResponse: z.object({
      collectionIds: z.array(z.string()),
    }),
  }
}

export const serverCollectionResponses = buildCollectionResponses(
  serverTimestamp,
  serverCircuitResponses.OwnerRef,
  serverCircuitResponses.CircuitCardResponse
)

export const wireCollectionResponses = buildCollectionResponses(
  wireTimestamp,
  wireCircuitResponses.OwnerRef,
  wireCircuitResponses.CircuitCardResponse
)

export type CollectionCard = z.infer<
  typeof wireCollectionResponses.CollectionCardResponse
>
export type CollectionView = z.infer<
  typeof wireCollectionResponses.CollectionViewResponse
>
export type CollectionEnvelope = z.infer<
  typeof wireCollectionResponses.CollectionEnvelope
>
export type CollectionPage = z.infer<
  typeof wireCollectionResponses.CollectionPageResponse
>
export type CollectionMembership = z.infer<
  typeof wireCollectionResponses.CollectionMembershipResponse
>
