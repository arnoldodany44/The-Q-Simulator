/**
 * The language vocabulary of decision D2, on its own and importing nothing.
 *
 * It was extracted out of `i18n/index.ts` when the embed arrived (§3.4). That
 * module is the app's i18next bootstrap: it pulls in `i18next-browser-
 * languagedetector`, the detector configuration, the `<html lang>` and
 * Open-Graph synchronisation, and a glob over every catalog in the product.
 * The embed is a second document with its own entry point and needs none of
 * that — it does not detect a language at all, because the *teacher* chooses
 * one in the snippet they paste (`embed/paths.ts` argues why) — but it does
 * need to know which three languages exist and how to narrow `es-MX` to one.
 *
 * Three constants and a five-line function are what both documents share, so
 * three constants and a five-line function are what lives in a module with no
 * imports. `i18n/index.ts` re-exports all of it, so nothing that already
 * imported these from there had to change.
 */

export const SUPPORTED_LANGUAGES = ['en', 'es', 'fr'] as const
export type SupportedLanguage = (typeof SUPPORTED_LANGUAGES)[number]

export const FALLBACK_LANGUAGE: SupportedLanguage = 'en'

export const LANGUAGE_STORAGE_KEY = 'qsim.language'

function isSupported(value: string): value is SupportedLanguage {
  return (SUPPORTED_LANGUAGES as readonly string[]).includes(value)
}

/** Narrows a detected tag such as `es-MX` to a supported base language. */
export function resolveLanguage(tag: string | undefined): SupportedLanguage {
  if (!tag) return FALLBACK_LANGUAGE
  const base = tag.split('-')[0] ?? ''
  return isSupported(base) ? base : FALLBACK_LANGUAGE
}
