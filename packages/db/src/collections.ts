import type {
  Prisma,
  PrismaClient,
  Visibility,
} from './generated/prisma/client.js'
import type { Page } from './pagination.js'
import {
  circuitCardSelect,
  collectionCardSelect,
  toCircuitCard,
  toCollectionCard,
} from './projections.js'
import type { CircuitCard, CollectionCard } from './projections.js'
import {
  collectionHandleFilter,
  listableCircuitFilter,
  listableCollectionFilter,
} from './visibility.js'
import type { ViewerId } from './visibility.js'

/**
 * Collections — specification §3.4, milestone M1.9.
 *
 * ── The one rule this file exists to enforce ──────────────────────────────
 *
 * A collection has a visibility of its own, and it governs the *collection*.
 * It does not, and must never, govern what is inside it.
 *
 * The tempting implementation is the one that reads: fetch the collection,
 * check the viewer may see it, then fetch its circuits and render them. That
 * is a leak, and it is the leak this milestone is most likely to ship,
 * because it is also the implementation that looks obviously correct. Adding
 * somebody else's UNLISTED circuit — or one's own PRIVATE one — to a PUBLIC
 * collection would publish it to every anonymous reader, through a door the
 * circuit's own visibility says is shut, and the circuit's owner would have no
 * way to see it had happened.
 *
 * So the items are read through `listableCircuitFilter`, the same fragment the
 * gallery starts from, with the same viewer. A collection is a *listing*: it
 * shows what the viewer could already have found, arranged. Nothing more ever
 * comes out of it.
 *
 * ── What happens to an item that cannot be shown ──────────────────────────
 *
 * It is omitted, and it is counted. `readCollectionItems` answers with the
 * circuits the viewer may see plus a `withheld` number, and the two together
 * are what let an interface be honest: a collection of five that shows two is
 * otherwise indistinguishable from a collection of two, and a reader who
 * followed a link to somebody's "Oracle algorithms" would be told, wrongly,
 * that it is nearly empty.
 *
 * The count is a deliberate disclosure and it is bounded to exactly that: a
 * number. No id, no slug, no title, no owner, nothing that could be turned
 * into a request. "This collection contains things you cannot see" is already
 * implied by the collection existing and having been curated; "this collection
 * contains *this* circuit" is not, and is never said.
 *
 * The consequence for an owner is worth stating because it is a real one and
 * it is not a bug: putting an UNLISTED circuit in a PUBLIC collection does not
 * share it. UNLISTED means "reachable by whoever holds the link", and a
 * listing is discovery — so to show a circuit in a public collection, publish
 * the circuit.
 */

/**
 * Most circuits one collection may hold.
 *
 * The bound is load-bearing rather than tidy: `readCollectionItems` resolves
 * the items with an `IN (…)` over the ids, so an unbounded collection is an
 * unbounded query on a route an anonymous reader can call. It also bounds the
 * response, which carries a full card — thumbnail included — per item.
 */
export const MAX_COLLECTION_ITEMS = 200

/** The items of one collection, as one viewer may see them. */
export interface CollectionItems {
  /** In `orderIndex` order, filtered by §11. */
  readonly items: readonly CircuitCard[]
  /**
   * How many of the collection's rows this viewer may not see. A count and
   * never a handle — see the header.
   */
  readonly withheld: number
}

export interface CreateCollectionInput {
  readonly ownerId: string
  readonly title: string
  readonly description: string | null
  readonly visibility: Visibility
}

export interface UpdateCollectionInput {
  readonly id: string
  /**
   * Scopes the write to the owner's own row, exactly as `UpdateCircuitInput`
   * does. The route has already checked ownership; this makes the statement
   * itself unable to touch anybody else's collection, so a future route that
   * forgets the check still cannot.
   */
  readonly ownerId: string
  readonly title?: string
  readonly description?: string | null
  readonly visibility?: Visibility
}

export interface CollectionMembership {
  readonly collectionId: string
  readonly circuitId: string
  /** The owner, so the write can be scoped to their row a second time. */
  readonly ownerId: string
}

/** Raised when a collection already holds `MAX_COLLECTION_ITEMS`. */
export class CollectionFullError extends Error {
  readonly code = 'COLLECTION_FULL'

  constructor(readonly collectionId: string) {
    super(
      `Collection ${collectionId} already holds ` +
        `${String(MAX_COLLECTION_ITEMS)} circuits`
    )
    this.name = 'CollectionFullError'
  }
}

/**
 * Raised when an item is added to a collection that is not the caller's, or
 * that no longer exists.
 *
 * Unreachable through the HTTP surface, which resolves the collection through
 * `findReadableCollection` and checks ownership first — which is exactly why
 * it exists, in the same spirit as `CircuitNotWritableError`: the guard worth
 * having is the one that still holds when the caller forgot.
 */
export class CollectionNotWritableError extends Error {
  readonly code = 'COLLECTION_NOT_WRITABLE'

  constructor(readonly collectionId: string) {
    super(`Collection ${collectionId} is not writable by this owner`)
    this.name = 'CollectionNotWritableError'
  }
}

export interface CollectionRepository {
  /**
   * One author's collections, as this viewer may list them.
   *
   * `ownerId` says whose, `viewerId` says which of those — the owner's own
   * request passes the same value for both and sees everything; a stranger
   * sees the PUBLIC ones. There is no variant without a `viewerId`, for the
   * reason `listPublished` has none: a listing that could be called without a
   * viewer is a listing that will be.
   */
  listCollections(input: {
    ownerId: string
    viewerId: ViewerId
    skip: number
    take: number
  }): Promise<Page<CollectionCard>>

  /**
   * How many collections of this author this viewer may list.
   *
   * A count is a listing: it is derived from the same rows and it answers a
   * question about them, so it goes through the same filter. A count that
   * skipped it would report on a stranger's private curation in a single
   * integer, which is smaller than a leak and is still one.
   */
  countCollections(input: {
    ownerId: string
    viewerId: ViewerId
  }): Promise<number>

  /**
   * One collection by id, with §11 applied in the query. `null` means "does
   * not exist, or exists and is not yours to open" — the caller must not
   * distinguish the two.
   */
  findReadableCollection(
    id: string,
    viewerId: ViewerId
  ): Promise<CollectionCard | null>

  /**
   * The circuits inside a collection the viewer has already been allowed to
   * open, filtered again — by the *circuits'* own visibility this time.
   */
  readCollectionItems(input: {
    collectionId: string
    viewerId: ViewerId
  }): Promise<CollectionItems>

  createCollection(input: CreateCollectionInput): Promise<CollectionCard>

  /** `null` when no row matched — which includes "not the owner's". */
  updateCollection(input: UpdateCollectionInput): Promise<CollectionCard | null>

  /** `false` when no row matched. Items go with it, by cascade. */
  removeCollection(input: { id: string; ownerId: string }): Promise<boolean>

  /**
   * Adds a circuit, idempotently. The caller must already have established
   * that this viewer may *read* the circuit — pass an id that came back from
   * `findReadable`.
   *
   * @throws {CollectionFullError} at `MAX_COLLECTION_ITEMS`.
   * @throws {CollectionNotWritableError} when the collection is not this
   * owner's, or is gone.
   */
  addCollectionItem(input: CollectionMembership): Promise<CollectionCard>

  /** Removes a circuit, idempotently. `false` when it was not in there. */
  removeCollectionItem(input: CollectionMembership): Promise<boolean>

  /**
   * Which of this owner's collections hold this circuit — what the "add to a
   * collection" control needs in order not to offer an option that does
   * nothing.
   *
   * Scoped to one owner, because it is only ever asked about the caller's own
   * collections: "which of *your* collections contain this" is answerable from
   * rows the caller already owns, while "who has collected this circuit" is a
   * different question about other people's curation and is not one this API
   * answers.
   */
  collectionIdsHolding(input: {
    ownerId: string
    circuitId: string
  }): Promise<string[]>
}

/**
 * The ordering of a collection listing: most recently touched first, tied
 * broken by the primary key.
 *
 * The tie-break is not decoration — without a total order, two requests for
 * the same offset can disagree about which rows are on it, which is the exact
 * failure `galleryOrderBy` documents at length.
 */
const collectionOrderBy: Prisma.CollectionOrderByWithRelationInput[] = [
  { updatedAt: 'desc' },
  { id: 'desc' },
]

/**
 * The `where` for "this author's collections, as this viewer may list them".
 *
 * Built by conjunction, like every other listing filter in this package:
 * §11 first and never conditionally, the author second. Adding a term cannot
 * widen the result, whatever the term is.
 */
function collectionListingWhere(input: {
  ownerId: string
  viewerId: ViewerId
}): Prisma.CollectionWhereInput {
  return {
    AND: [listableCollectionFilter(input.viewerId), { ownerId: input.ownerId }],
  }
}

export function prismaCollectionRepository(
  prisma: PrismaClient
): CollectionRepository {
  return {
    async listCollections({ ownerId, viewerId, skip, take }) {
      const where = collectionListingWhere({ ownerId, viewerId })
      const [rows, total] = await prisma.$transaction([
        prisma.collection.findMany({
          where,
          orderBy: collectionOrderBy,
          skip,
          take,
          select: collectionCardSelect,
        }),
        prisma.collection.count({ where }),
      ])
      return { items: rows.map(toCollectionCard), total }
    },

    countCollections({ ownerId, viewerId }) {
      return prisma.collection.count({
        where: collectionListingWhere({ ownerId, viewerId }),
      })
    },

    async findReadableCollection(id, viewerId) {
      const row = await prisma.collection.findFirst({
        where: collectionHandleFilter(id, viewerId),
        select: collectionCardSelect,
      })
      return row === null ? null : toCollectionCard(row)
    },

    async readCollectionItems({ collectionId, viewerId }) {
      /*
       * Two queries and not a join, because `CollectionItem.circuitId` carries
       * no foreign key (§7) and Prisma therefore has no relation to traverse.
       * That is not a hardship here — it is what forces the second query to
       * state its own filter, which is the filter that matters.
       */
      const memberships = await prisma.collectionItem.findMany({
        where: { collectionId },
        orderBy: [{ orderIndex: 'asc' }, { circuitId: 'asc' }],
        select: { circuitId: true },
        // Bounded even though `addCollectionItem` already refuses past the
        // cap: a row written by an older build, or by hand, must not turn this
        // into an unbounded `IN`.
        take: MAX_COLLECTION_ITEMS,
      })
      if (memberships.length === 0) return { items: [], withheld: 0 }

      const ids = memberships.map((row) => row.circuitId)
      /*
       * §11, applied to the *circuits* rather than to the collection that
       * names them. A PUBLIC collection is a listing like any other, and this
       * is the line that keeps it from becoming a way around a circuit's own
       * visibility.
       */
      const rows = await prisma.circuit.findMany({
        where: { AND: [listableCircuitFilter(viewerId), { id: { in: ids } }] },
        select: circuitCardSelect,
      })

      const byId = new Map(rows.map((row) => [row.id, toCircuitCard(row)]))
      // The curator's order, not the database's: `orderIndex` is the whole
      // point of a collection over a search.
      const items = ids
        .map((id) => byId.get(id))
        .filter((card): card is CircuitCard => card !== undefined)

      return { items, withheld: memberships.length - items.length }
    },

    async createCollection(input) {
      const row = await prisma.collection.create({
        data: {
          ownerId: input.ownerId,
          title: input.title,
          description: input.description,
          visibility: input.visibility,
        },
        select: collectionCardSelect,
      })
      return toCollectionCard(row)
    },

    async updateCollection({ id, ownerId, ...changes }) {
      return prisma.$transaction(async (tx) => {
        const { count } = await tx.collection.updateMany({
          where: { id, ownerId },
          data: changes,
        })
        if (count === 0) return null
        const row = await tx.collection.findUnique({
          where: { id },
          select: collectionCardSelect,
        })
        return row === null ? null : toCollectionCard(row)
      })
    },

    async removeCollection({ id, ownerId }) {
      const { count } = await prisma.collection.deleteMany({
        where: { id, ownerId },
      })
      return count > 0
    },

    async addCollectionItem({ collectionId, ownerId, circuitId }) {
      return prisma.$transaction(async (tx) => {
        /*
         * Inside the transaction and scoped to the owner: this is the second
         * guard, the one that holds when a future route forgets the first.
         * Reading it here rather than trusting the caller's earlier lookup
         * also closes the window in which the collection was deleted in
         * between.
         */
        const collection = await tx.collection.findFirst({
          where: { id: collectionId, ownerId },
          select: { id: true },
        })
        if (collection === null) {
          throw new CollectionNotWritableError(collectionId)
        }

        const held = await tx.collectionItem.count({ where: { collectionId } })
        if (held >= MAX_COLLECTION_ITEMS) {
          /*
           * Checked before the insert rather than after, and inside the
           * transaction, so two concurrent adds cannot both see 199 and both
           * write. Postgres cannot express this bound as a constraint, so the
           * transaction is what enforces it.
           */
          throw new CollectionFullError(collectionId)
        }

        /*
         * `ON CONFLICT DO NOTHING` against the composite primary key, so
         * adding a circuit twice is not an error and does not move
         * `orderIndex`. The alternative — read, then insert if absent — has a
         * window two clicks fit inside.
         */
        await tx.collectionItem.createMany({
          data: [{ collectionId, circuitId, orderIndex: held }],
          skipDuplicates: true,
        })

        // Touched so the owner's listing sorts on something true: adding a
        // circuit is a change to the collection even though no column of it
        // moved.
        const row = await tx.collection.update({
          where: { id: collectionId },
          data: { updatedAt: new Date() },
          select: collectionCardSelect,
        })
        return toCollectionCard(row)
      })
    },

    async removeCollectionItem({ collectionId, ownerId, circuitId }) {
      return prisma.$transaction(async (tx) => {
        const collection = await tx.collection.findFirst({
          where: { id: collectionId, ownerId },
          select: { id: true },
        })
        if (collection === null) return false

        const { count } = await tx.collectionItem.deleteMany({
          where: { collectionId, circuitId },
        })
        if (count === 0) return false

        await tx.collection.update({
          where: { id: collectionId },
          data: { updatedAt: new Date() },
          select: { id: true },
        })
        return true
      })
    },

    async collectionIdsHolding({ ownerId, circuitId }) {
      const rows = await prisma.collectionItem.findMany({
        // The owner scope travels through the relation, so this cannot report
        // on somebody else's collection even if the circuit is in one.
        where: { circuitId, collection: { ownerId } },
        select: { collectionId: true },
      })
      return rows.map((row) => row.collectionId)
    },
  }
}
