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
 */

export const SUPPORTED_LANGUAGES = ['en', 'es', 'fr'] as const
export type SupportedLanguage = (typeof SUPPORTED_LANGUAGES)[number]

export const FALLBACK_LANGUAGE: SupportedLanguage = 'en'

/**
 * Namespaces are added alongside the feature that needs them — `editor`,
 * `gates`, `analysis` and `lessons` arrive with M0.5, M0.7 and Phase 3.
 * Keeping one catalog per feature stops any single file from growing into
 * something nobody can review.
 */
export const NAMESPACES = ['common', 'landing'] as const

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

async function loadCatalogs(language: SupportedLanguage): Promise<void> {
  await Promise.all(
    NAMESPACES.map(async (namespace) => {
      const loader = catalogs[`./locales/${language}/${namespace}.json`]
      if (!loader) return
      const module = await loader()
      i18n.addResourceBundle(language, namespace, module.default, true, true)
    })
  )
}

export async function initI18n(): Promise<typeof i18n> {
  await i18n
    .use(LanguageDetector)
    .use(initReactI18next)
    .init({
      supportedLngs: SUPPORTED_LANGUAGES,
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
