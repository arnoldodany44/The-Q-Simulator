/**
 * Moving a star through the caches that render one — milestone M1.5b.
 *
 * ── Why this is a pure module and not three lines inside a hook ───────────
 *
 * A star is drawn in at least three places at once: the card in the gallery,
 * the same card in the author's profile listing, and the control on the
 * circuit's own page. Optimistic updating means writing to all of them before
 * the server has answered, and *reconciling* means writing to all of them
 * again with the server's number — or putting all of them back when the
 * request fails. That is the part the brief calls out: a failed star must
 * visibly revert rather than leaving a lie on screen.
 *
 * Cache surgery done inline in a mutation callback is unreachable from a test,
 * and the interesting cases are all off the happy path — starring something
 * already starred, unstarring at a count of zero, a second click landing while
 * the first is in flight. So the surgery is a function of two values here, and
 * the hook is left holding only the sequencing.
 *
 * ── The two shapes a star lives in ────────────────────────────────────────
 *
 * A *count*, which is public and is what `sort=stars` orders by, and a
 * *membership*, which is this viewer's own and rides in the page envelope
 * (see `cursorPageResponse` in @qsim/contract for why it is not on the card).
 * Both have to move together or the button and the number beside it disagree.
 */

import type { CircuitCard, CircuitView } from '@qsim/contract'

/** What a listing looks like to this module: cards, and this viewer's stars. */
export interface StarrablePage {
  readonly items: CircuitCard[]
  readonly starred: string[]
}

export interface StarUpdate {
  readonly circuitId: string
  /** The state being moved to. */
  readonly starred: boolean
  /**
   * The server's count, once there is one.
   *
   * Absent while the answer is still in flight, and then the count is derived
   * — but only when the state actually changes. Starring something already
   * starred is idempotent on the server (`ON CONFLICT DO NOTHING`), so a
   * client that added one anyway would show a number no request produced, and
   * would keep showing it until something else refetched the page.
   */
  readonly starCount?: number
}

/** The count a card should show after this update, given what it shows now. */
function nextCount(current: number, was: boolean, update: StarUpdate): number {
  if (update.starCount !== undefined) return update.starCount
  if (was === update.starred) return current
  // Floored at zero for the same reason the server's `updateMany` is: too high
  // is a cosmetic error, negative is a number no interface knows how to draw.
  return update.starred ? current + 1 : Math.max(0, current - 1)
}

/**
 * One page of a listing with the star moved, or the very same object when
 * nothing on this page changed.
 *
 * Returning the original reference matters: React Query stores an infinite
 * listing as an array of pages, and rebuilding every page on every star would
 * give each of them a new identity and re-render the whole gallery to change
 * one number.
 */
export function applyStarToPage<T extends StarrablePage>(
  page: T,
  update: StarUpdate
): T {
  const index = page.items.findIndex((item) => item.id === update.circuitId)
  if (index === -1) return page

  const current = page.items[index]
  if (current === undefined) return page

  const was = page.starred.includes(update.circuitId)
  const items = [...page.items]
  items[index] = {
    ...current,
    starCount: nextCount(current.starCount, was, update),
  }

  const starred = update.starred
    ? was
      ? page.starred
      : [...page.starred, update.circuitId]
    : page.starred.filter((id) => id !== update.circuitId)

  return { ...page, items, starred }
}

/** The same, over the pages React Query holds for one infinite listing. */
export function applyStarToPages<T extends StarrablePage>(
  data: { pages: T[]; pageParams: unknown[] },
  update: StarUpdate
): { pages: T[]; pageParams: unknown[] } {
  return {
    ...data,
    pages: data.pages.map((page) => applyStarToPage(page, update)),
  }
}

/**
 * A circuit's own page, where the star is a boolean in the envelope and the
 * count is on the circuit.
 *
 * Guarded by the id rather than applied blindly: the detail cache is keyed by
 * *handle*, and the same circuit reached by slug and by id occupies two
 * entries, so a mutation walking the cache must check what it is looking at.
 */
export function applyStarToView(
  view: CircuitView,
  update: StarUpdate
): CircuitView {
  if (view.circuit.id !== update.circuitId) return view
  return {
    ...view,
    starred: update.starred,
    circuit: {
      ...view.circuit,
      starCount: nextCount(view.circuit.starCount, view.starred, update),
    },
  }
}
