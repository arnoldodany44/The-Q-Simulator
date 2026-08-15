/**
 * Reading a page number out of a query string — M1.4a.
 *
 * A module of its own rather than two exports beside a component, because a
 * file that exports both a component and a helper loses fast refresh (the
 * `react-refresh/only-export-components` rule says so), and because this is
 * the half worth testing without rendering anything.
 */

/** The query parameter naming a page. 1-based, like the API's own. */
export const PAGE_PARAM = 'page'

/**
 * The page a query string asks for, or 1.
 *
 * Digits only, and deliberately not `Number()`: its grammar is the whole of
 * JavaScript's numeric literal syntax plus surrounding whitespace, so
 * `?page=0x10` would be page 16 and `?page=1e15` a page number with fifteen
 * zeroes in it. `@qsim/contract`'s `pageNumber` refuses exactly those on the
 * server, with exactly this reasoning; a client that sent one would be
 * building a request it already knows to be a 400.
 *
 * Anything unreadable falls back to the first page rather than throwing. A
 * mangled page number means a hand-edited address or a stale link, and "show
 * the first page" is a better answer to both than an error screen.
 */
export function pageFromSearch(search: URLSearchParams): number {
  const raw = search.get(PAGE_PARAM)
  if (raw === null || !/^\d+$/.test(raw)) return 1
  const page = Number(raw)
  return page < 1 ? 1 : page
}
