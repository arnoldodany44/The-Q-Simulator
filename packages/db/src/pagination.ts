/**
 * The two page shapes this package answers with.
 *
 * They live in a module of their own rather than beside the circuit
 * repository because M1.9 gave collections their own listings, and a
 * repository importing a type from a sibling repository that imports it back
 * is a cycle — which `.dependency-cruiser.cjs` fails the build over, rightly,
 * even when the cycle is only between types.
 */

/** A page of rows plus the total, which is what a numbered pager needs. */
export interface Page<T> {
  readonly items: readonly T[]
  readonly total: number
}

/**
 * A page of a keyset listing: the rows, and where to resume.
 *
 * There is deliberately no `total`. Counting the gallery means running the
 * filter a second time — including the trigram search — on every page
 * request, for a number that is stale before it is rendered and that a keyset
 * pager does not need. `nextCursor` is `null` exactly when this was the last
 * page, which is the only fact a "load more" button depends on.
 */
export interface CursorPage<T> {
  readonly items: readonly T[]
  readonly nextCursor: string | null
}
