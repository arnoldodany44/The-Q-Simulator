import i18n from 'i18next'
import LanguageDetector from 'i18next-browser-languagedetector'
import { initReactI18next } from 'react-i18next'

/**
 * Internationalisation — decision D2.
 *
 * Spanish, English and French are all first-class from day one. Catalogs are
 * loaded per language on demand rather than bundled together, so the initial
 * payload carries one locale instead of three.
 *
 * Two guardrails keep the three catalogs honest, and both fail the build:
 *   - `i18next/no-literal-string` (packages/config/eslint/react.js) rejects
 *     user-facing text that never reached a catalog.
 *   - `locale-parity.test.ts` rejects a key that exists in one language but
 *     not the others.
 *
 * NOT TRANSLATED, in any language: gate names and symbols (H, CNOT, Rz(θ),
 * √X), state notation (|000⟩, a + bi), and proper nouns (Bloch, GHZ, Bell,
 * Grover). Translating those would break the correspondence with Qiskit and
 * with every textbook the user might read alongside this app.
 *
 * The document's own `lang` attribute tracks the active language from here
 * too (`syncDocumentLanguage`), and so does the `description` meta tag. The
 * first is not decoration: that attribute is what selects a screen reader's
 * speech synthesiser, so a French interface left declared as English is read
 * aloud with English phonetics — unintelligible rather than merely untidy
 * (WCAG 3.1.1). The second is D2 applied to the last user-facing string in
 * the shipped HTML: a description is what a bookmark and a link preview show.
 *
 * A catalog that fails to load must not blank the page. Catalogs are one
 * chunk per language, so a stale deploy or a dropped request is a real
 * network failure mode rather than a theoretical one, and the answer is to
 * fall back rather than to reject: `loadCatalogs` reports and continues, and
 * `main.tsx` renders whatever i18next has.
 */

export const SUPPORTED_LANGUAGES = ['en', 'es', 'fr'] as const
export type SupportedLanguage = (typeof SUPPORTED_LANGUAGES)[number]

export const FALLBACK_LANGUAGE: SupportedLanguage = 'en'

/**
 * Namespaces are added alongside the feature that needs them — `editor`
 * arrives with the circuit store in M0.5, `gates` with the palette,
 * `simulation` with the worker in M0.6, `analysis` with M0.7 and `lessons` in
 * Phase 3. Keeping one catalog per feature stops any single file from growing
 * into something nobody can review.
 */
export const NAMESPACES = [
  'common',
  'editor',
  'gates',
  'landing',
  'simulation',
] as const

export const LANGUAGE_STORAGE_KEY = 'qsim.language'

const catalogs = import.meta.glob<{ default: Record<string, unknown> }>(
  './locales/*/*.json'
)

function isSupported(value: string): value is SupportedLanguage {
  return (SUPPORTED_LANGUAGES as readonly string[]).includes(value)
}

/** Narrows a detected tag such as `es-MX` to a supported base language. */
export function resolveLanguage(tag: string | undefined): SupportedLanguage {
  if (!tag) return FALLBACK_LANGUAGE
  const base = tag.split('-')[0] ?? ''
  return isSupported(base) ? base : FALLBACK_LANGUAGE
}

/**
 * Points `<html lang>` at the language actually on screen.
 *
 * The *narrowed* tag is written, never the raw detected one: a browser
 * reporting `es-MX` is served the `es` catalog, so `es` is what the page
 * says. Declaring `es-MX` would name a locale whose strings are not the ones
 * rendered.
 *
 * The `document` guard is the same one the vendored language detector uses:
 * this module is imported outside a DOM as well — `locale-parity.test.ts`
 * reads its constants under the node environment.
 */
function syncDocumentLanguage(tag: string | undefined): void {
  if (typeof document === 'undefined') return
  document.documentElement.lang = resolveLanguage(tag)
  // The `description` is the one user-facing string in `index.html`, and D2
  // does not stop at the strings inside the app. Rewritten here rather than
  // in a component: it belongs to the document, not to a route, and this is
  // already the one place that knows the language changed.
  const description = document.querySelector('meta[name="description"]')
  if (description !== null) {
    description.setAttribute('content', i18n.t('common:meta.description'))
  }
}

/**
 * Adds one language's catalogs, reporting rather than rejecting.
 *
 * Each language is its own chunk (see the header), so a single missing chunk
 * would otherwise reject the whole bootstrap and leave `#root` empty forever
 * — a blank page with nothing on screen to say whether the app is broken or
 * merely slow. A namespace that fails to arrive falls back to `en` through
 * i18next's own `fallbackLng`, which is a readable interface in the wrong
 * language rather than no interface at all.
 */
async function loadCatalogs(language: SupportedLanguage): Promise<void> {
  await Promise.all(
    NAMESPACES.map(async (namespace) => {
      const loader = catalogs[`./locales/${language}/${namespace}.json`]
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

export async function initI18n(): Promise<typeof i18n> {
  await i18n
    .use(LanguageDetector)
    .use(initReactI18next)
    .init({
      supportedLngs: SUPPORTED_LANGUAGES,
      // `es-MX` is a Spanish speaker. Without this flag i18next matches the
      // detected tag against `supportedLngs` whole, so every regional tag —
      // which is what a real browser reports — falls straight through to
      // English, and the narrowing `resolveLanguage` exists to do never gets
      // a chance to run. With it, `es-MX` resolves to the `es` catalog and
      // `<html lang>` can then honestly say `es`.
      nonExplicitSupportedLngs: true,
      fallbackLng: FALLBACK_LANGUAGE,
      ns: NAMESPACES,
      defaultNS: 'common',
      resources: {},
      // Resources arrive after init, one language at a time.
      partialBundledLanguages: true,
      interpolation: {
        // React escapes for us; doing it twice mangles apostrophes, which
        // matters for French.
        escapeValue: false,
      },
      detection: {
        order: ['localStorage', 'navigator'],
        lookupLocalStorage: LANGUAGE_STORAGE_KEY,
        caches: ['localStorage'],
      },
      react: { useSuspense: false },
    })

  const active = resolveLanguage(i18n.language)
  await loadCatalogs(active)
  if (active !== FALLBACK_LANGUAGE) await loadCatalogs(FALLBACK_LANGUAGE)

  // After the catalogs, not before: the attribute must never describe a
  // frame that has not been rendered yet. `main.tsx` awaits this call before
  // the first `render`, so the `en` in index.html is only ever the pre-boot
  // value — correct, since it is also `FALLBACK_LANGUAGE` and the shell has
  // no text of its own.
  syncDocumentLanguage(active)
  // Exactly one subscription, registered here rather than at module scope so
  // that importing this module without initialising it (the parity test does)
  // has no side effect. Every switch goes through `languageChanged` — the
  // wrapper below, the picker, any direct `i18n.changeLanguage` added later —
  // so no caller has to remember to do this itself.
  i18n.on('languageChanged', syncDocumentLanguage)

  return i18n
}

/** Loads the target catalogs before switching, so no frame renders raw keys. */
export async function changeLanguage(
  language: SupportedLanguage
): Promise<void> {
  await loadCatalogs(language)
  await i18n.changeLanguage(language)
}

export default i18n
