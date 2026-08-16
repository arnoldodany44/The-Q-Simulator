/**
 * Where the public listings live in this app's address space — M1.5b.
 *
 * Declared once and imported by the route table, the header link, the author
 * byline on every card and the tests, for the reason
 * `circuit-storage/paths.ts` gives about `/c/:slug`: a route registered under
 * one spelling and linked under another is a 404 no type checker can see.
 *
 * This module imports nothing, because `App.tsx` reaches for the templates
 * here and lives in the entry chunk (M0.9b).
 */

/** The gallery itself. */
export const GALLERY_PATH = '/gallery'

/** One author's public circuits. `:username` is `User.username`. */
export const PROFILE_ROUTE_PATH = '/u/:username'

/**
 * The address of one author's listing.
 *
 * Encoded, though `USERNAME_PATTERN` on the server admits nothing that needs
 * it: the encoding costs nothing and the day a handle grows a character the
 * router would read as a separator is not the day to discover this was
 * concatenation.
 */
export function profilePath(username: string): string {
  return `/u/${encodeURIComponent(username)}`
}
