/**
 * Where the challenges live in this app's address space — Phase 3.
 *
 * Declared once and imported by the route table, the index cards and the tests,
 * for the reason `lessons/paths.ts` and `gallery/paths.ts` both give: a route
 * registered under one spelling and linked under another is a 404 no type
 * checker can see.
 *
 * This module imports nothing, because `App.tsx` reaches for the templates here
 * and lives in the entry chunk (M0.9b).
 */

/** The index: the whole ladder, in difficulty order. */
export const CHALLENGES_PATH = '/challenges'

/** One challenge. `:slug` is the row's own slug, which is also its address. */
export const CHALLENGE_ROUTE_PATH = '/challenges/:slug'

/**
 * The address of one challenge.
 *
 * Encoded, though every slug in the vocabulary is lowercase and hyphenated: the
 * encoding costs nothing, and the day a slug grows a character the router would
 * read as a separator is not the day to discover this was concatenation.
 */
export function challengePagePath(slug: string): string {
  return `${CHALLENGES_PATH}/${encodeURIComponent(slug)}`
}
