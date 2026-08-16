/**
 * Collections (§3.4, M1.9) — a barrel, imported by the three routes that show
 * them.
 *
 * `App.tsx` deliberately does not come through here: it takes the path
 * templates from `./paths`, which imports nothing, so the entry chunk does not
 * acquire React Query and the forms for the sake of two strings (M0.9b).
 */

export { AddCircuitToCollection } from './AddCircuitToCollection.js'
export type { AddCircuitToCollectionProps } from './AddCircuitToCollection.js'

export { CollectionCard } from './CollectionCard.js'
export type { CollectionCardProps } from './CollectionCard.js'

export { CollectionForm } from './CollectionForm.js'
export type { CollectionDraft, CollectionFormProps } from './CollectionForm.js'

export {
  COLLECTIONS_PATH,
  COLLECTION_ROUTE_PATH,
  collectionPagePath,
} from './paths.js'
