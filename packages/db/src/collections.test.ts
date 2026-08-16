import { describe, expect, it } from 'vitest'
import { Visibility } from './generated/prisma/client.js'
import {
  canEditCollection,
  collectionHandleFilter,
  listableCollectionFilter,
} from './visibility.js'
import { MAX_COLLECTION_ITEMS } from './collections.js'

/**
 * The collection visibility fragments, asserted without a database.
 *
 * These are `where` objects, so what they mean is decidable by reading them —
 * which is the point of testing them here rather than only through a route:
 * Prisma connects as `postgres` and bypasses row-level security, so a
 * fragment that admits one row too many is a leak with no other guard behind
 * it, and a fragment is small enough to check exhaustively.
 *
 * The equivalents for circuits live in `visibility.test.ts`; this file is the
 * second model M1.9 added, and the one whose rule is new: the collection's own
 * visibility is the *only* thing these decide. What may be seen inside it is a
 * separate question, answered against `Circuit` by `readCollectionItems`, and
 * `apps/api/src/routes/collections.test.ts` is where that is proved from a
 * stranger's point of view.
 */

const VIEWER = 'viewer-uuid'
const OTHER = 'other-uuid'

describe('listableCollectionFilter', () => {
  it('admits only PUBLIC for an anonymous viewer', () => {
    expect(listableCollectionFilter(null)).toEqual({
      visibility: Visibility.PUBLIC,
    })
  })

  it('adds the viewer’s own and nothing else', () => {
    expect(listableCollectionFilter(VIEWER)).toEqual({
      OR: [{ visibility: Visibility.PUBLIC }, { ownerId: VIEWER }],
    })
  })

  it('never mentions UNLISTED, because a listing is discovery', () => {
    // The same rule as `listableCircuitFilter`. An unlisted collection is
    // reachable by whoever holds its address and appears in no index — so a
    // fragment naming UNLISTED here would be the bug.
    expect(JSON.stringify(listableCollectionFilter(VIEWER))).not.toContain(
      Visibility.UNLISTED
    )
    expect(JSON.stringify(listableCollectionFilter(null))).not.toContain(
      Visibility.UNLISTED
    )
  })
})

describe('collectionHandleFilter', () => {
  it('always constrains the id, so it can never be used alone', () => {
    const filter = collectionHandleFilter('col-1', null)
    // Prisma types `AND` as "one condition or a list of them", so the array
    // shape is narrowed here rather than indexed through a union.
    const conjuncts = Array.isArray(filter.AND) ? filter.AND : []
    expect(conjuncts[0]).toEqual({ id: 'col-1' })
  })

  it('reaches an unlisted collection, which its id is the only handle for', () => {
    /*
     * The decision argued in `visibility.ts`: unlike a circuit, a collection
     * has no slug, and no response in this API carries a collection id
     * belonging to a collection the reader may not list — so the id is the
     * credential, and UNLISTED would mean nothing without this.
     */
    const anonymous = JSON.stringify(collectionHandleFilter('col-1', null))
    expect(anonymous).toContain(Visibility.UNLISTED)
    expect(anonymous).toContain(Visibility.PUBLIC)
    expect(anonymous).not.toContain('ownerId')
  })

  it('adds the viewer’s own private collections and no one else’s', () => {
    const filter = JSON.stringify(collectionHandleFilter('col-1', VIEWER))
    expect(filter).toContain(VIEWER)
    expect(filter).not.toContain(OTHER)
  })
})

describe('canEditCollection', () => {
  it('is about ownership and never about visibility', () => {
    const collection = { ownerId: VIEWER }
    expect(canEditCollection(collection, VIEWER)).toBe(true)
    expect(canEditCollection(collection, OTHER)).toBe(false)
    // An anonymous caller owns nothing, and `null === null` must not be a way
    // to edit a row whose owner is somehow unset.
    expect(canEditCollection(collection, null)).toBe(false)
    expect(canEditCollection({ ownerId: '' }, null)).toBe(false)
  })
})

describe('MAX_COLLECTION_ITEMS', () => {
  it('is a bound the item query can rely on', () => {
    // The items are resolved with an `IN (…)` over their ids on a route an
    // anonymous reader can call, so this is what stops that being unbounded.
    expect(MAX_COLLECTION_ITEMS).toBeGreaterThan(0)
    expect(Number.isSafeInteger(MAX_COLLECTION_ITEMS)).toBe(true)
  })
})
