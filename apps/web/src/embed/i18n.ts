/**
 * The embed's own i18next instance — D2, §3.4.
 *
 * ── Why it is not `initI18n` ─────────────────────────────────────────────
 *
 * The app's bootstrap does three things an embed must not do, and each one
 * would be a defect here rather than an inefficiency:
 *
 *   1. **It detects the reader's language.** An embed sits inside a page
 *      written in one language, and a French analysis panel in the middle of
 *      an English lecture slide is worse than either language on its own. The
 *      teacher chooses, once, in the snippet they paste (`?lang=`), and only
 *      when they have not chosen does the reader's browser decide.
 *   2. **It reads and writes `localStorage`**, through
 *      `i18next-browser-languagedetector` and its `caches` option. A frame
 *      served with `sandbox="allow-scripts"` has an opaque origin, where
 *      touching storage throws; and a frame *without* that sandbox shares
 *      storage with the app, so caching a language chosen by somebody else's
 *      blog post would change the language of the reader's own editor tab.
 *      Neither is acceptable, and not depending on a library's try/catch is
 *      how this stays true.
 *   3. **It globs every catalog in the product.** The embed names the two it
 *      renders, so its graph contains six JSON files rather than forty-eight.
 *
 * What it deliberately keeps is the *vocabulary*: the three tags, the
 * fallback, and the `es-MX → es` narrowing all come from `i18n/languages.ts`,
 * so an embed can never support a language the app does not.
 *
 * ── A catalog that fails to load must not blank the frame ────────────────
 *
 * Same rule `main.tsx` states for the app, and it matters more here: a blank
 * rectangle in the middle of somebody's slide says nothing at all. A namespace
 * that fails to arrive falls through to `fallbackLng`, and in the worst case
 * i18next prints the key — which `e2e/no-raw-keys.spec.ts` covers for the
 * embed's address like every other.
 */

import i18n from 'i18next'
import { initReactI18next } from 'react-i18next'

import {
  FALLBACK_LANGUAGE,
  resolveLanguage,
  type SupportedLanguage,
} from '../i18n/languages'

/**
 * Exactly the catalogs the frame renders: its own prose, and the analysis
 * vocabulary the histogram and the shot tally read their captions and table
 * headers from.
 *
 * `gates`, `editor` and `simulation` are absent and that is not an oversight:
 * `CircuitPlot` translates nothing — a gate symbol is notation (D2, §1.1) and
 * travels through `Notation`, not through a catalog — so the drawing is
 * complete without them. `errors` is absent because the embed has three
 * failures of its own and words them itself; it never renders an API error
 * code.
 */
export const EMBED_NAMESPACES = ['embed', 'analysis'] as const

/**
 * Named individually rather than as `*.json` so the graph carries six files
 * and not the whole product's catalogs. The brace pattern is resolved by Vite
 * at build time, which is why it must be a literal.
 */
const catalogs = import.meta.glob<{ default: Record<string, unknown> }>(
  '../i18n/locales/*/{embed,analysis}.json'
)

async function loadCatalogs(language: SupportedLanguage): Promise<void> {
  await Promise.all(
    EMBED_NAMESPACES.map(async (namespace) => {
      const loader = catalogs[`../i18n/locales/${language}/${namespace}.json`]
      if (!loader) return
      try {
        const module = await loader()
        i18n.addResourceBundle(language, namespace, module.default, true, true)
      } catch (cause) {
        console.error(`i18n: ${language}/${namespace} failed to load`, cause)
      }
    })
  )
}

/**
 * The language this frame speaks.
 *
 * `pinned` is the teacher's `?lang=`, already narrowed to a supported tag by
 * `readEmbedAddress` or `null`. With nothing pinned the reader's browser
 * decides, which is the same rule the app follows and the right default for a
 * teacher who did not think about it.
 *
 * `navigator` is read defensively: this module is also imported by a test
 * under jsdom, where `navigator.language` exists, and by nothing under Node —
 * but the guard costs one comparison and removes a whole class of "undefined
 * is not an object" from a document with no error boundary above it.
 */
export function embedLanguage(pinned: string | null): SupportedLanguage {
  if (pinned !== null) return resolveLanguage(pinned)
  const detected =
    typeof navigator === 'undefined' ? undefined : navigator.language
  return resolveLanguage(detected)
}

export async function initEmbedI18n(
  pinned: string | null
): Promise<SupportedLanguage> {
  const language = embedLanguage(pinned)

  await i18n.use(initReactI18next).init({
    lng: language,
    fallbackLng: FALLBACK_LANGUAGE,
    ns: [...EMBED_NAMESPACES],
    defaultNS: 'embed',
    resources: {},
    partialBundledLanguages: true,
    // React escapes for us; doing it twice mangles apostrophes, which matters
    // for French.
    interpolation: { escapeValue: false },
    react: { useSuspense: false },
  })

  /*
   * Both waves at once, for the reason `loadNamespaces` gives in the app: the
   * fallback is consulted per key after everything has arrived, so awaiting
   * one and then the other costs a second full round trip for two of the
   * three languages D2 mandates.
   */
  await Promise.all([
    loadCatalogs(language),
    language === FALLBACK_LANGUAGE
      ? Promise.resolve()
      : loadCatalogs(FALLBACK_LANGUAGE),
  ])

  /*
   * WCAG 3.1.1: the attribute is what selects a screen reader's speech
   * synthesiser, so a French frame declared as English is read aloud with
   * English phonetics. The embed has no language picker, so this is written
   * once and never again — unlike the app, which subscribes to
   * `languageChanged`.
   */
  if (typeof document !== 'undefined') {
    document.documentElement.lang = language
  }

  return language
}
