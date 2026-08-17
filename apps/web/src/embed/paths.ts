/**
 * The embed's addresses — §3.4.
 *
 * This module imports nothing, on purpose and by the same rule every
 * `paths.ts` under `features/` follows: the *editor* has to be able to build
 * an embed URL for its copy-this-snippet control without acquiring anything
 * from the embed's own graph. A path template is a string.
 *
 * ── Two addresses, because a circuit has two kinds of home ───────────────
 *
 * `/embed/c/:slug` is a **saved** circuit, resolved by the API. It is the one
 * a teacher gets from the circuit page, and the one where §11 is decided: only
 * PUBLIC and UNLISTED resolve, and a PRIVATE one 404s exactly as a slug that
 * was never minted does (`apps/api/src/routes/embed.ts`).
 *
 * `/embed?c=…` is a circuit carried **inside its own link** (decision D4) —
 * the same payload `ShareLink` produces. It is here because it costs nothing
 * and it is what makes an embed work on a deployment with no API at all, which
 * is the state Phase 0 shipped in and the state `lib/api/config.ts` still
 * treats as supported. There is no visibility question to answer: a document
 * nobody saved has no owner and no row.
 *
 * ── `lang`, and why an embed does not detect the reader's ────────────────
 *
 * Everywhere else in the product, i18next detects the browser's language
 * (D2). An embed must not: the frame sits inside a page written in one
 * language, and a French circuit panel in the middle of an English lecture
 * slide is worse than either language alone. So the *teacher* chooses, once,
 * in the snippet they paste — and `?lang=` is how they say so. With no `lang`
 * the embed falls back to the browser after all, because a missing parameter
 * should not mean "English by decree".
 */

/** The route the built `embed.html` answers for a saved circuit. */
export const EMBED_CIRCUIT_ROUTE = '/embed/c/'

/** The route it answers for a circuit carried in its own link (D4). */
export const EMBED_INLINE_ROUTE = '/embed'

/** The query parameter a teacher pins the frame's language with. */
export const EMBED_LANGUAGE_PARAM = 'lang'

/** Where a saved circuit's frame lives, relative to the app's origin. */
export function embedCircuitPath(slug: string): string {
  return `${EMBED_CIRCUIT_ROUTE}${encodeURIComponent(slug)}`
}

/**
 * The absolute address to put in an `<iframe src>`.
 *
 * `origin` is passed in rather than read from `window` so the builder is a
 * pure function a test can call, and so the editor's snippet control can name
 * the origin the reader is actually on — which on a preview deployment is not
 * the production one.
 */
export function embedCircuitUrl(
  origin: string,
  slug: string,
  language?: string
): string {
  const suffix =
    language === undefined
      ? ''
      : `?${EMBED_LANGUAGE_PARAM}=${encodeURIComponent(language)}`
  return `${origin.replace(/\/+$/, '')}${embedCircuitPath(slug)}${suffix}`
}
