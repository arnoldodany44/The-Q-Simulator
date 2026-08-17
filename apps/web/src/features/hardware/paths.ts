/**
 * Where a stored hardware run lives in this app's address space — §3.7.
 *
 * Declared once and imported by the route table, the link from the editor and
 * the tests, for the reason `gallery/paths.ts` gives: a route registered under
 * one spelling and linked under another is a 404 no type checker can see.
 *
 * This module imports nothing, because `App.tsx` reaches for the template here
 * and lives in the entry chunk (M0.9b).
 *
 * `/runs/:jobId` rather than `/jobs/:jobId`: "job" is already this system's word
 * for a queue tick and for a simulation run, and the address a person shares
 * during a demonstration should say what they will see. It is deliberately not
 * nested under the circuit — one run is a fact about a moment on a machine, and
 * an address that changed when the circuit was renamed would break every link
 * to a measurement that has not changed at all.
 */

/** One stored hardware run. `:jobId` is this system's id, not the provider's. */
export const HARDWARE_RUN_ROUTE_PATH = '/runs/:jobId'

/**
 * The address of one run.
 *
 * Encoded, though every id is a cuid2 and carries nothing a router would read
 * as a separator: the encoding costs nothing, and the day an id format changes
 * is not the day to discover this was concatenation.
 */
export function hardwareRunPath(jobId: string): string {
  return `/runs/${encodeURIComponent(jobId)}`
}
