/**
 * Where the lessons live in this app's address space — Phase 3.
 *
 * Declared once and imported by the route table, the header link, the index
 * cards and the tests, for the reason `gallery/paths.ts` gives: a route
 * registered under one spelling and linked under another is a 404 no type
 * checker can see.
 *
 * This module imports nothing, because `App.tsx` reaches for the templates
 * here and lives in the entry chunk (M0.9b).
 */

/** The index: every lesson, in curriculum order. */
export const LESSONS_PATH = '/lessons'

/** One lesson. `:slug` is the lesson's own id, not a database key. */
export const LESSON_ROUTE_PATH = '/lessons/:slug'

/**
 * The address of one lesson.
 *
 * Encoded, though every slug in the catalog is lowercase and hyphenated: the
 * encoding costs nothing, and the day a slug grows a character the router
 * would read as a separator is not the day to discover this was
 * concatenation.
 */
export function lessonPath(slug: string): string {
  return `${LESSONS_PATH}/${encodeURIComponent(slug)}`
}
