/**
 * Which past version the page is showing, in the address — M1.4b.
 *
 * `/c/:slug?v=3` is version 3, read-only. `/c/:slug?v=3&vs=1` is the same
 * version with the visual diff from version 1 to it. Both are in the query
 * rather than in component state for the reason `/circuits?page=` is: a
 * version you are looking at is a *place*. Back should return to it, a reload
 * should stay on it, and a link to it should open it — which matters more here
 * than for a pager, because "look at what version 3 said" is the thing one
 * person sends another.
 *
 * It is also safe to expose, which not every parameter here would be: a
 * version number is not access control. §11 makes the slug of an UNLISTED
 * circuit its only protection — that is why the sign-in flow carries its
 * destination in history state instead of `?next=` — and a version number adds
 * nothing an attacker who already has the slug does not have. `GET
 * /circuits/:id/versions/:n` applies the same visibility filter as the circuit
 * itself, so the address can say anything and the server still decides.
 *
 * ── Reading and writing use different sources, deliberately ───────────────
 *
 * READ from React Router's location, so a component re-renders when the
 * selection changes. WRITE by taking the *live* `window.location.search` and
 * changing only these two parameters.
 *
 * The asymmetry is not tidiness, it is a defect fix waiting to happen.
 * `useCircuitUrl` writes the open document into `?c=` with
 * `history.replaceState`, deliberately behind React Router's back (its header
 * explains why). React Router's `useLocation` is therefore one edit behind on
 * `c` at all times, and a navigation built from it — which is exactly what
 * `useSearchParams`' setter does — would rebuild the query without the `?c=`
 * that is holding the reader's unsaved work. Opening the history would quietly
 * empty the address bar. Reading the live query string instead keeps every
 * parameter this module does not own, whoever wrote it and however.
 */

/** The version being viewed. */
export const VERSION_PARAM = 'v'

/** The older version the diff is measured from. Only read alongside `v`. */
export const COMPARE_PARAM = 'vs'

/**
 * The largest version number the API will look up (`VersionParams.n`).
 * Refusing a bigger one here means a hand-edited address produces "no such
 * version" rather than a request the server was always going to reject.
 */
export const MAX_VERSION_NUMBER = 1_000_000

export interface VersionSelection {
  /** The version on screen, or `null` for the live document. */
  readonly version: number | null
  /** The version it is compared against, or `null` for no comparison. */
  readonly compare: number | null
}

export const NO_VERSION_SELECTED: VersionSelection = {
  version: null,
  compare: null,
}

/**
 * The selection a query string asks for.
 *
 * Digits only, and deliberately not `Number()`, for the reason `pageFromSearch`
 * gives at length: `Number`'s grammar is the whole of JavaScript's numeric
 * literal syntax, so `?v=0x10` would be version 16 and `?v=1e15` a version
 * number with fifteen zeroes in it. Neither is something a person typed.
 *
 * Anything unreadable falls back to "no selection" rather than throwing. A
 * mangled version number means a hand-edited address or a stale link, and
 * showing the live document is a better answer to both than an error screen.
 */
export function versionSelection(
  search: string | URLSearchParams
): VersionSelection {
  const params =
    typeof search === 'string' ? new URLSearchParams(search) : search
  const version = versionNumber(params.get(VERSION_PARAM))
  if (version === null) return NO_VERSION_SELECTED

  const compare = versionNumber(params.get(COMPARE_PARAM))
  return {
    version,
    // Comparing a version with itself is not a comparison, and a diff of a
    // document against itself would render an empty answer to a question
    // nobody asked. Dropped here so no caller has to remember it.
    compare: compare === version ? null : compare,
  }
}

/**
 * The query string that selects `next`, keeping every other parameter of
 * `search` exactly as it is — `?c=` above all, which is the unsaved document.
 *
 * Returns the search *without* a leading `?` when it is empty, and with one
 * otherwise, which is what `navigate({ search })` wants either way.
 */
export function versionSearch(search: string, next: VersionSelection): string {
  const params = new URLSearchParams(search)

  if (next.version === null) {
    params.delete(VERSION_PARAM)
    // A comparison base with nothing to compare it to is not a state the
    // interface has, so leaving it behind would only produce an address that
    // means less than it says.
    params.delete(COMPARE_PARAM)
  } else {
    params.set(VERSION_PARAM, String(next.version))
    if (next.compare === null || next.compare === next.version) {
      params.delete(COMPARE_PARAM)
    } else {
      params.set(COMPARE_PARAM, String(next.compare))
    }
  }

  const query = params.toString()
  return query === '' ? '' : `?${query}`
}

function versionNumber(raw: string | null): number | null {
  if (raw === null || !/^\d+$/.test(raw)) return null
  const value = Number(raw)
  if (value < 1 || value > MAX_VERSION_NUMBER) return null
  return value
}
