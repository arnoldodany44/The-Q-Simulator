import i18n from 'i18next'
import LanguageDetector from 'i18next-browser-languagedetector'
import { initReactI18next } from 'react-i18next'

import {
  FALLBACK_LANGUAGE,
  LANGUAGE_STORAGE_KEY,
  SUPPORTED_LANGUAGES,
  resolveLanguage,
  type SupportedLanguage,
} from './languages'

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
 * too (`syncDocumentLanguage`), and so does every piece of metadata that
 * carries a sentence: the `description`, its Open Graph and Twitter copies,
 * and `og:locale`. The first is not decoration: that attribute is what selects
 * a screen reader's speech synthesiser, so a French interface left declared as
 * English is read aloud with English phonetics — unintelligible rather than
 * merely untidy (WCAG 3.1.1). The rest is D2 applied to the user-facing
 * strings in the shipped HTML: they are what a bookmark, a search result and a
 * shared link show.
 *
 * A catalog that fails to load must not blank the page. Catalogs are one
 * chunk per language, so a stale deploy or a dropped request is a real
 * network failure mode rather than a theoretical one, and the answer is to
 * fall back rather than to reject: `loadCatalogs` reports and continues, and
 * `main.tsx` renders whatever i18next has.
 */

/*
 * The language vocabulary itself lives in `languages.ts`, a module that
 * imports nothing, and is re-exported here so that every existing importer is
 * unaffected. The split exists because `embed.html` is a second document with
 * its own entry point (§3.4): it needs the three language tags and the
 * narrowing rule, and must not acquire the detector, the catalog glob or the
 * metadata synchronisation below to get them.
 */
export {
  FALLBACK_LANGUAGE,
  LANGUAGE_STORAGE_KEY,
  SUPPORTED_LANGUAGES,
  resolveLanguage,
} from './languages'
export type { SupportedLanguage } from './languages'

/**
 * Namespaces are added alongside the feature that needs them — `editor`
 * arrives with the circuit store in M0.5, `gates` with the palette,
 * `simulation` with the worker in M0.6, `analysis` with M0.7, `errors` with
 * the API client in M1.3, `auth` with the session layer in M1.3a, and
 * `lessons` in Phase 3. Keeping one catalog per feature stops any single file
 * from growing into something nobody can review.
 *
 * `errors` is the one catalog whose keys are not chosen here: they are the
 * error codes `@qsim/contract` publishes, because the API sends a code and
 * this app owns every word the reader sees (§11, D2). `lib/api/messages.
 * test.ts` asserts the catalog and the code list are the same set, so a new
 * code cannot ship without three translations.
 *
 * `auth` is a second catalog of that kind — its `errors` block is keyed by
 * Supabase's failure codes rather than by anything a designer invented, and
 * `features/auth/authCatalog.test.ts` holds it to the same standard.
 */
export const NAMESPACES = [
  'analysis',
  'auth',
  'challenges',
  'circuits',
  'collab',
  'collections',
  'common',
  'editor',
  'embed',
  'errors',
  'export',
  'gallery',
  'gates',
  'hardware',
  'import',
  'landing',
  'lessons',
  'settings',
  'simulation',
] as const

const catalogs = import.meta.glob<{ default: Record<string, unknown> }>(
  './locales/*/*.json'
)

/**
 * The meta tags whose content is the page description, by the attribute that
 * identifies each one.
 *
 * Three tags carry the same sentence to three different readers — a search
 * result, an Open Graph card, a Twitter card — and Open Graph is addressed by
 * `property` while the other two use `name`, which is the only reason this is
 * a list of selectors rather than one.
 */
const DESCRIPTION_SELECTORS = [
  'meta[name="description"]',
  'meta[property="og:description"]',
  'meta[name="twitter:description"]',
]

/**
 * `og:locale`, which is a different specification from `<html lang>` and takes
 * a different value.
 *
 * ogp.me defines it as "of the format language_TERRITORY. Default is en_US", so
 * a bare `fr` is not a value the protocol knows — and a consumer that does not
 * recognise one falls back to that default, which announces a French card as
 * English. `<html lang>` is BCP 47, where the bare subtag is exactly right;
 * writing the same string into both conflated the two, and the one place it
 * shows is the link preview the work plan calls the product's most visible
 * text.
 *
 * The territories are the neutral choices for a UI that is not regionalised:
 * the catalogs are written in international French, Spanish and English, and
 * these say which language rather than which country.
 */
const OPEN_GRAPH_LOCALES: Record<SupportedLanguage, string> = {
  en: 'en_US',
  es: 'es_ES',
  fr: 'fr_FR',
}

/**
 * Points `<html lang>` — and the shipped metadata — at the language actually
 * on screen.
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
  const language = resolveLanguage(tag)
  document.documentElement.lang = language

  // The description is the one user-facing sentence in `index.html`, and D2
  // does not stop at the strings inside the app: a bookmark, a search result
  // and a shared link all show it. Rewritten here rather than in a component
  // because it belongs to the document rather than to a route, and this is
  // already the one place that knows the language changed. M0.9b added the two
  // social copies, which are the same sentence and must not drift from it.
  const description = i18n.t('common:meta.description')
  for (const selector of DESCRIPTION_SELECTORS) {
    document.querySelector(selector)?.setAttribute('content', description)
  }

  // The card's own declaration of what language it is in. `og:title` is the
  // product's name and is identical in all three (D2), so it is left alone.
  document
    .querySelector('meta[property="og:locale"]')
    ?.setAttribute('content', OPEN_GRAPH_LOCALES[language])
}

/**
 * The namespaces every route needs before it can paint a word.
 *
 * `common` is the shell — the product name, the language picker, the loading
 * line — and `landing` is the entry route, which stays in the entry chunk
 * because it is the door (M0.9b).
 *
 * `analysis` is here for a reason that is easy to undo by accident: the landing
 * EMBEDS `ProbabilityHistogram`. That component is the page's whole argument —
 * it is what turns one bar into two and then into a correlated pair — and it
 * reads its table caption, its column headers and its remainder line from the
 * `analysis` catalog. The landing passes its own `heading` and `summary` as
 * props, which is what made this easy to miss: most of the visible copy is
 * overridden, so only the accessible table and the caption fell through, and
 * they fell through as the literal strings `histogram.table.caption`,
 * `histogram.table.state` and `histogram.table.probability` rendered on the
 * most visible page in the product.
 *
 * Nothing catches that automatically. `i18next/no-literal-string` sees a `t()`
 * call and is satisfied; locale parity compares the catalogs against each
 * other and they agreed perfectly — the key existed in all three, it simply
 * was not loaded. The component tests import the catalogs directly and so
 * never exercise the loading path at all. Only opening the page finds it,
 * which is why `e2e/no-raw-keys.spec.ts` now does exactly that on every route.
 *
 * The cost is ~5 kB of JSON per language on first paint. The optimisation this
 * slightly walks back was mostly about `editor`, which is twice that and is
 * still deferred along with `gates` and `simulation`.
 *
 * `errors` is here for a different reason than the others: it is not tied to
 * a route at all. Any screen that touches the API can produce one of these
 * sentences — a session that expired while the tab was open, a request that
 * left before the network came back — so deferring it would mean the one
 * moment the user most needs a sentence is the moment the catalog has not
 * arrived. It is ~1.5 kB per language and it is a fixed list, not a growing
 * one.
 */
export const SHELL_NAMESPACES = [
  'common',
  'landing',
  'analysis',
  'errors',
] as const

/**
 * What the editor route needs, fetched alongside its own chunk (`App.tsx`).
 *
 * M0.9b's boundary is that the landing does not pay for the editor, and the
 * catalogs were the half of that nobody checked: the bootstrap awaited all six
 * namespaces before the first paint, of which `editor` alone was more than half
 * the bytes — for a route the reader may never open. In Spanish and French it
 * was twice over, because the active language and the English fallback were
 * awaited one after the other rather than together.
 */
export const EDITOR_NAMESPACES = [
  'editor',
  'gates',
  'simulation',
  /*
   * `hardware` from §3.7's submission panel, which the editor page mounts.
   *
   * It is listed here and in `SETTINGS_NAMESPACES` because §3.7 has two halves
   * on two screens — the key belongs to the account, the run belongs to a
   * circuit — and both read this one vocabulary.
   *
   * Leaving it off either list is invisible to the compiler and to every unit
   * test: the components render their key names as text and nothing throws. It
   * shipped that way, and it was found by opening the page.
   *
   * `e2e/no-raw-keys.spec.ts` did NOT catch it and could not have. `/settings`
   * is in that sweep's route list, but the sweep runs signed out and `/settings`
   * is behind `RequireSession`, so what it reads there is the guard's own screen
   * — as that file's own header says. The guard for this is
   * `verification/i18n-coverage/`, which checks the keys these components ask
   * for against the namespaces their route declares.
   */
  'hardware',
  /*
   * `collab` from M5.3. Its own namespace rather than a block inside `editor`
   * because it is a vocabulary about *people* — who is here, what they are doing,
   * where they are looking, and the three sentences a screen reader is told out
   * loud — while `editor` is about a circuit and the commands that change one. It
   * also travels further than the canvas will: Fase 5's comments are the same
   * subject and belong beside these strings rather than inside a catalog that is
   * already the largest in the product.
   *
   * It is in the editor's set rather than the shell's for the reason every other
   * deferred namespace is: a reader who never opens a circuit never downloads it.
   * And it is *needed* here even though a solo session renders none of it — the
   * presence layer and the roster mount inside the editor's page, so a session that
   * gains a second person must not have to fetch a catalog before it can say so.
   */
  'collab',
  /*
   * `circuits` is here from M1.4a because the save control lives in the
   * editor, and every word it says — the visibility choices, the conflict
   * sentence, the note about where an unsaved edit is being kept — is in that
   * catalog. Sharing it with the listing rather than opening a fifth namespace
   * is deliberate: they are one vocabulary about one thing, a circuit as a
   * saved document, and splitting it would mean deciding twice per string
   * which half it belongs to.
   */
  'circuits',
  /*
   * `gallery` from M1.5b, for the two controls the editor shares with a
   * gallery card: the star and the fork. They are one implementation on
   * purpose — the brief asks for a fork from a card *and* from an open
   * circuit, and two would be two behaviours wearing one word — so their
   * words travel with them rather than being copied into `editor`.
   */
  'gallery',
  /*
   * `export` from M1.7. Its own namespace rather than a block inside `editor`
   * because it is a vocabulary about *files* — five format names, what each
   * one is good for, what the browser was handed — and it travels with the
   * export panel wherever that goes next (a gallery card, an embed). It also
   * carries the two strings that end up *inside* a downloaded SVG, its
   * `<title>` and `<desc>`, which is the one place in this app where a catalog
   * string leaves the page it was rendered on.
   */
  'export',
  /*
   * `import` from M2.4, beside `export` and not inside it. They are two
   * vocabularies, not one: an export names five formats and says what each is
   * good for, while an import is almost entirely a list of ways a stranger's
   * file can be refused — a line, a column and the name of an OpenQASM feature
   * this contract has no shape for. Sharing a namespace would put a dozen
   * failure sentences next to five format descriptions and make both harder to
   * translate.
   */
  'import',
  /*
   * `embed` from §3.4, and only its `snippet` block is rendered here: the
   * copy-this-frame control lives on the circuit page while the rest of the
   * catalog belongs to `embed.html`, a document with its own entry point and
   * its own i18next instance (`src/embed/i18n.ts`).
   *
   * One catalog rather than two, because they are one vocabulary about one
   * thing — a circuit inside somebody else's page — and splitting it would
   * mean deciding twice per string which half it belongs to, with the sandbox
   * advice and the frame it advises about ending up in different files.
   */
  'embed',
] as const

/**
 * What the authentication screens need, fetched alongside their own chunk.
 *
 * Deferred rather than added to the shell for the same reason `editor` is:
 * most visits never open a sign-in form, and the catalog carries a sentence
 * per failure code. The one string the session layer renders *outside* those
 * screens — the status line a route guard shows while the stored session is
 * still being read — comes from `common`, which is already loaded, so a guard
 * never waits on this.
 */
export const AUTH_NAMESPACES = ['auth'] as const

/**
 * What the circuit listing needs, fetched alongside its own chunk.
 *
 * Deferred for the same reason as the account screens: the page is behind a
 * session, and a first-time reader who never signs in never downloads it. The
 * failures it can show are already covered by `errors`, which the shell
 * carries, so the only thing waiting on this chunk is the page's own copy.
 */
export const CIRCUITS_NAMESPACES = ['circuits'] as const

/**
 * What the public listings need, fetched alongside their own chunk (M1.5b).
 *
 * Two namespaces rather than one: `gallery` is this feature's own vocabulary —
 * browsing, starring, forking, the empty states — and `circuits` is the one
 * every card borrows for the words that describe a *saved circuit* as such: the
 * qubit, gate and depth labels, and the three visibility names. Duplicating
 * those into a second catalog would mean deciding twice per string which half
 * it belongs to, and would let the same figure be labelled two ways on two
 * screens.
 *
 * Deferred rather than added to the shell for the same reason the editor's are:
 * the landing page is the door, and a reader who bounces off it never
 * downloads a gallery they did not open.
 */
export const GALLERY_NAMESPACES = ['gallery', 'circuits'] as const

/**
 * What the collection screens need, fetched alongside their own chunks
 * (M1.9).
 *
 * `circuits` travels with it for the same reason it travels with `gallery`:
 * the three visibility names and the qubit/gate/depth labels describe a saved
 * circuit as such, and a collection page draws gallery cards made of exactly
 * those words. Copying them into a third catalog would mean deciding twice per
 * string which half it belongs to, and would let one figure be labelled two
 * ways on two screens.
 */
export const COLLECTIONS_NAMESPACES = ['collections', 'circuits'] as const

/**
 * What the settings screen needs (M1.9).
 *
 * Deferred like every other account screen: most visits never open it. The
 * failures it can show are already covered by `errors`, which the shell
 * carries, so nothing waits on this chunk but the page's own copy.
 */
export const SETTINGS_NAMESPACES = ['settings', 'hardware'] as const

/**
 * What a lesson needs, fetched alongside its own chunk (Phase 3).
 *
 * `lessons` is the prose — nine lessons of it, eventually, which is the
 * largest body of translated text in the product and by some way the largest
 * catalog. Deferring it is not an optimisation but the whole reason
 * namespaces are split per feature: a reader who never opens a lesson must
 * not download one.
 *
 * The editor's namespaces travel with it, and that is the interesting half:
 * the player mounts the **real** `CircuitEditor` and the **real**
 * `SimulationPanel`, so every word of the palette, the gate names, the
 * histogram and the Bloch table is on this page. A lesson route that loaded
 * only `lessons` would render its prose beautifully beside an editor labelled
 * in raw keys — which is exactly the defect `e2e/no-raw-keys.spec.ts` exists
 * for, and why both lesson routes are in its list.
 *
 * `circuits`, `gallery`, `export` and `import` come along inside
 * `EDITOR_NAMESPACES` and are not all needed here; splitting that constant
 * into "the canvas" and "the document commands" would let a lesson skip them,
 * and is not worth doing until a second consumer of the editor exists to
 * disagree about the split.
 */
export const LESSON_NAMESPACES = ['lessons', ...EDITOR_NAMESPACES] as const

/**
 * What a challenge needs, fetched alongside its own chunk (Phase 3).
 *
 * `challenges` carries the ladder's own prose — nine titles and nine prompts —
 * plus the sentence for every diagnosis the validator can return. That last
 * block is a catalog of the same kind as `errors`: its keys are not invented
 * here but published by `@qsim/contract` as `CHALLENGE_FEEDBACK_CODES`, because
 * the API sends a code and this app owns every word (§11, D2).
 *
 * The editor's namespaces travel with it for exactly the reason a lesson's do:
 * the player mounts the **real** `CircuitEditor` and the **real**
 * `SimulationPanel`, so the palette, the gate names, the histogram and the
 * Bloch table are all on this page. A route that loaded only `challenges` would
 * render a prompt beautifully beside an editor labelled in raw keys.
 *
 * The index needs `challenges` alone: it lists titles and prompts and mounts no
 * editor, which is why `App.tsx` asks for the two sets separately.
 */
export const CHALLENGE_NAMESPACES = [
  'challenges',
  ...EDITOR_NAMESPACES,
] as const

/**
 * The stored hardware run (§3.7), and the one namespace list on this page that
 * is worth reading twice.
 *
 * `hardware` is its own prose. `analysis` is the interesting one and is not
 * optional: the comparison view mounts the **real** `ProbabilityHistogram` and
 * the **real** `NoisePanel`, so the chart's caption, its accessible table, the
 * phasor note and every one of the noise controls' eight datasheet fields are
 * on this page in `analysis`'s words. A route that fetched only its own catalog
 * would render three paragraphs of careful prose beside a chart labelled in raw
 * keys — the exact defect `e2e/no-raw-keys.spec.ts` exists for.
 *
 * `simulation` comes with it because the worker's failures are rendered through
 * that catalog, `circuits` because the link back to the document uses it, and
 * `errors` because an API failure on this page is described by
 * `useApiErrorMessage`. The editor's own namespaces are deliberately absent:
 * this page draws no canvas and no palette.
 */
export const HARDWARE_NAMESPACES = [
  'hardware',
  'analysis',
  'simulation',
  'circuits',
  'errors',
] as const

/**
 * Adds catalogs for one language, reporting rather than rejecting.
 *
 * Each language is its own chunk (see the header), so a single missing chunk
 * would otherwise reject the whole bootstrap and leave `#root` empty forever
 * — a blank page with nothing on screen to say whether the app is broken or
 * merely slow. A namespace that fails to arrive falls back to `en` through
 * i18next's own `fallbackLng`, which is a readable interface in the wrong
 * language rather than no interface at all.
 */
async function loadCatalogs(
  language: SupportedLanguage,
  namespaces: readonly string[] = NAMESPACES
): Promise<void> {
  await Promise.all(
    namespaces.map(async (namespace) => {
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

/**
 * Loads a set of namespaces in the active language and in the fallback, and
 * answers when both are in.
 *
 * The two waves go out together. Awaiting one and then the other cost a second
 * full round trip — measured at some 520 ms on a 300 ms link — for two of the
 * three languages D2 mandates, and they have no dependency on each other: the
 * fallback is consulted per key, after everything has arrived.
 */
export async function loadNamespaces(
  namespaces: readonly string[]
): Promise<void> {
  const active = resolveLanguage(i18n.language)
  await Promise.all([
    loadCatalogs(active, namespaces),
    active === FALLBACK_LANGUAGE
      ? Promise.resolve()
      : loadCatalogs(FALLBACK_LANGUAGE, namespaces),
  ])
}

/**
 * The interpolation the whole app runs with, exported so a test can share it.
 *
 * A component test builds its own i18next instance — that is what lets it render
 * three languages in one file without a network — and an instance configured
 * differently from the app's is a test asserting something the reader never sees.
 *
 * ── WHY §10's FIGURES ARE NOT SOLVED HERE ────────────────────────────────
 *
 * The tempting answer to «every figure through `Intl.NumberFormat`» is
 * `alwaysFormat` with a `format` of our own. It does not work: i18next 21 and
 * later install their own `Formatter` service and overwrite
 * `interpolation.format` with it unconditionally, and that formatter returns the
 * value untouched unless the catalog tagged the placeholder (`{{val, number}}`).
 * Replacing the module wholesale to get one behaviour would take the built-in
 * date, list and relative-time formatters down with it.
 *
 * So the convention stays what `TimelineScrubber`, `CircuitCanvas`,
 * `SaveCircuitPanel` and `CommentsPanel` already do: the *call site* formats, and
 * a figure that can reach four digits is interpolated as an already-formatted
 * string. A plural key keeps `count` as a number, because that is what selects the
 * form, and carries the formatted figure beside it.
 */
export const INTERPOLATION = {
  // React escapes for us; doing it twice mangles apostrophes, which matters for
  // French.
  escapeValue: false,
} as const

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
      interpolation: { ...INTERPOLATION },
      detection: {
        order: ['localStorage', 'navigator'],
        lookupLocalStorage: LANGUAGE_STORAGE_KEY,
        caches: ['localStorage'],
      },
      react: { useSuspense: false },
    })

  const active = resolveLanguage(i18n.language)
  // Only what the shell and the entry route render. The editor's four
  // namespaces travel with the editor's own chunk — see `EDITOR_NAMESPACES`.
  await loadNamespaces(SHELL_NAMESPACES)

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

/**
 * Loads the target catalogs before switching, so no frame renders raw keys.
 *
 * Every namespace, not only the shell's: the picker is reachable from the
 * editor, where the four editor namespaces are already on screen and would
 * otherwise be left in the language the reader just left.
 */
export async function changeLanguage(
  language: SupportedLanguage
): Promise<void> {
  await loadCatalogs(language)
  await i18n.changeLanguage(language)
}

export default i18n
