/**
 * Where collections live in this app's address space — M1.9.
 *
 * Declared once and imported by the route table, the cards, the profile page
 * and the tests, for the reason `circuit-storage/paths.ts` gives about
 * `/c/:slug`: a route registered under one spelling and linked under another
 * is a 404 no type checker can see.
 *
 * This module imports nothing, because `App.tsx` reaches for the templates
 * here and lives in the entry chunk (M0.9b).
 */

/** The signed-in caller's own collections. */
export const COLLECTIONS_PATH = '/collections'

/** One collection. `:id` is `Collection.id`, which is its only handle. */
export const COLLECTION_ROUTE_PATH = '/collections/:id'

/**
 * The address of one collection.
 *
 * Encoded, though a `cuid(2)` contains nothing that needs it: the encoding
 * costs nothing, and the day an id grows a character the router would read as
 * a separator is not the day to discover this was concatenation.
 */
export function collectionPagePath(id: string): string {
  return `/collections/${encodeURIComponent(id)}`
}
