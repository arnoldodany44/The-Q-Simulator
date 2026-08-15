/**
 * Where a saved circuit lives in this app's address space — §9, M1.4a.
 *
 * Declared once and imported by the four places that would otherwise each
 * write `/c/` themselves: the route table, the listing's links, the save flow's
 * redirect after a first save, and the tests. The template and the builder sit
 * together for the same reason `@qsim/contract`'s `circuitPath` does — a route
 * registered under one spelling and linked under another is a 404 that no type
 * checker can see.
 *
 * This module deliberately imports nothing. `App.tsx` is in the entry chunk
 * and reaches for the template here, so anything this file pulled in would be
 * downloaded by a reader who never opens the editor (M0.9b).
 */

/** The editor over a blank document. */
export const NEW_CIRCUIT_PATH = '/new'

/** The editor over a saved one. `:slug` also accepts the circuit's id. */
export const CIRCUIT_ROUTE_PATH = '/c/:slug'

/**
 * The address of one saved circuit.
 *
 * Encoded, though today's slugs are 21 characters of nanoid's URL-safe
 * alphabet and need no encoding at all: the same parameter accepts an `id`,
 * and the day a handle contains something interesting is not the day to
 * discover this was concatenation.
 */
export function circuitPagePath(handle: string): string {
  return `/c/${encodeURIComponent(handle)}`
}
