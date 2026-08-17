import { expect, test, type Page } from '@playwright/test'

/**
 * No route, in any language, may render a raw i18n key.
 *
 * This exists because the landing shipped `histogram.table.caption`,
 * `histogram.table.state` and `histogram.table.probability` as visible text.
 * The key was present in all three catalogs and spelled correctly; its
 * namespace simply was not among the ones the landing route loads, so
 * i18next fell back to printing the identifier.
 *
 * Every other guard in the project was satisfied by that state:
 *
 *   - `i18next/no-literal-string` sees a `t()` call and asks no more.
 *   - `locale-parity.test.ts` compares catalogs against each other, and they
 *     agreed — the key was in en, es and fr alike.
 *   - the component tests import the catalogs directly, so they never
 *     exercise the loading path that was broken.
 *
 * What they have in common is that none of them opens the page. This one
 * does, which is the only place the defect was visible. It is deliberately
 * shape-based rather than a list of expected strings: it will catch the next
 * unloaded namespace, on a route that does not exist yet, without being told
 * about it.
 */

/**
 * `word.word` or deeper, all letters and dots, no spaces. Matches an i18next
 * key and, importantly, not much else a UI legitimately shows.
 *
 * Filenames, version numbers and domains would also match a naive dotted
 * pattern, so the shape requires a lowercase first segment and rejects digits
 * — `analysis.json`, `1.4.11` and `qsim.dev` all fall out. Ket notation and
 * gate symbols never match: they carry no dot.
 */
const KEY_SHAPE = /^[a-z][a-zA-Z]*(\.[a-zA-Z]+)+$/

async function rawKeysOn(page: Page): Promise<string[]> {
  return page.evaluate((source) => {
    const shape = new RegExp(source)
    const found = new Set<string>()
    for (const element of document.querySelectorAll('body *')) {
      // Leaf nodes only: a parent's textContent concatenates its children and
      // would never match the shape anyway, but checking it wastes the walk.
      if (element.children.length > 0) continue
      const text = (element.textContent ?? '').trim()
      if (text && shape.test(text)) found.add(text)
    }
    return [...found]
  }, KEY_SHAPE.source)
}

/*
 * Every route reachable without a session. The four account screens (M1.3b)
 * are here because they are the ones whose catalog is code-split away from
 * the shell — exactly the arrangement that produced the defect this file
 * exists for. `/update-password` renders its expired-link explanation when
 * there is no recovery session, which is still a page made entirely of
 * translated strings. `/circuits` is behind a session and redirects here.
 *
 * The two public listings (M1.5b) are here for the same code-splitting reason
 * and answer anonymously by design. This suite runs Vite alone, with no API
 * behind it, so both settle into their failure state — which is the point:
 * a listing that cannot load is still a page made entirely of translated
 * strings, and it is the state hardest to remember to translate. `/u/:username`
 * is exercised with a handle nobody holds, whose "no such account" sentence is
 * itself part of the surface.
 *
 * M1.9 adds four. `/users/:username` is the long spelling of a profile, which
 * renders the same route rather than redirecting, so it is worth opening
 * separately — a route table entry pointing at the wrong element would look
 * fine until somebody pasted an API link. `/collections/:id` is anonymous like
 * the gallery and settles into its "no such collection" sentence, which is
 * itself part of the surface. `/collections`, `/circuits` and `/settings` are
 * behind `RequireSession`, so what they render here is the guard's own screen;
 * they are in the list anyway, because the thing being asserted is that *every
 * address in the route table* renders words in every language, and a guard
 * that rendered a key would be exactly as broken as a page that did.
 *
 * `/c/:slug` is the most namespace-dense address in the product and was the one
 * missing from this list. It is **not** interchangeable with `/new`: only the
 * slug form loads a saved document, and only it renders the version-history
 * panel, the save-conflict copy, the fork attribution notice, the star control
 * and the Bloch table — the surfaces carrying `circuits`, `gallery` and
 * `export`, every one of which is code-split away from the shell. That is
 * exactly the arrangement this file exists to catch. With no API behind this
 * suite it settles into its failure state, which is the state hardest to
 * remember to translate.
 *
 * M2.2 adds no address to this list, and that is worth writing down rather than
 * leaving as an omission. The Q-sphere, the entanglement metrics and §3.3's
 * noise mode all live inside the analysis panel of `/new` and `/c/:slug`, both
 * of which are already here — so the two panels that render unconditionally are
 * covered by this file as they stand. What this file *cannot* reach is the
 * surface behind a control: the noise panel's fields, the comparison and the
 * density heat map only exist once a checkbox is ticked, and a walk of the DOM
 * as loaded will never see them. That is precisely the surface nobody opens
 * while translating, so it has a suite of its own — `noise-mode.spec.ts` opens
 * it in French and asserts the same shape-based property there.
 *
 * Phase 3 adds two, and `/lessons/:slug` is the densest address in the product
 * — denser than `/c/:slug`, which held that title. The player mounts the *real*
 * `CircuitEditor` and the *real* `SimulationPanel`, so every word of the
 * palette, the gate names, the scrubber, the histogram and the Bloch table is
 * on the page beside the lesson's own prose. Its chunk loads `lessons` plus all
 * six editor namespaces, and a route that fetched only its own catalog would
 * render beautiful prose beside an editor labelled in raw keys. `/lessons` is
 * the opposite case and worth having for it: the index loads `lessons` *alone*,
 * so it is the one address that would catch the reverse mistake of adding a
 * namespace to a page that does not fetch it. `/lessons/nobody12345` is not
 * listed, because a missing lesson is decided in this bundle rather than by a
 * request — `lesson.tsx` renders two translated sentences for it, and they are
 * covered by the component tests rather than by a route that cannot fail
 * differently in different languages.
 *
 * The eight lessons that complete §3.6 add exactly one address between them,
 * and the restraint is the point: `/lessons/:slug` is one route rendering one
 * component, so nine lessons exercise the same namespaces through the same
 * code, and listing them all would buy twenty-four more page loads of an
 * assertion already made. `/lessons/qpe` earns its place for a reason about the
 * *editor* rather than about the lesson — at four wires it is the widest
 * register any lesson opens, so it is the only address here that renders the
 * Q-sphere, the entanglement metrics and a multi-qubit Bloch table on first
 * paint, all of them `analysis` strings that a one- or two-wire page never
 * reaches. A tenth lesson belongs in this list only if it renders a surface
 * none of these already does.
 *
 * M2.3 adds no address either, and for a sharper version of the same reason.
 * The server-run notice (§4's two-level split, made visible) lives inside the
 * analysis panel of `/new`, which is already here — but it only exists once a
 * circuit crosses the browser's twenty-qubit ceiling *and* an API answers, so
 * no walk of any page this suite can load will ever render it. Its trilingual
 * surface is asserted where it can be: `ServerRunPanel.test.tsx` renders every
 * state of it in en, es and fr and applies the same shape-based property this
 * file does. A route added for server runs later belongs in the list below.
 *
 * The embed (§3.4) adds one address and it is the odd one in this list, for a
 * reason worth stating: it is a DIFFERENT DOCUMENT. `/embed/c/:slug` is served
 * by `embed.html` with its own entry point, its own i18next instance and its
 * own two-namespace catalog set — so none of the loading path the rest of this
 * file exercises applies to it, and a mistake there would be invisible to
 * every other address here. With no API behind this suite it settles into its
 * "not available to embed" sentence, which is the state hardest to remember to
 * translate and is also the one §11 requires to be identical for a private
 * circuit and for a slug nobody minted.
 *
 * The `?c=` form is deliberately not listed. It renders the same component
 * through the same catalogs and would buy three more page loads of an
 * assertion already made; what it does differently is decoding, which
 * `features/../embed/EmbedApp.test.tsx` covers where a payload can be handed
 * in without a server.
 *
 * Challenge mode adds two, and they earn their places for opposite reasons.
 * `/challenges` is a listing that *needs the API* — unlike the lessons index,
 * whose catalog is in this bundle — so with no API behind this suite it settles
 * into its failure state, which is the state hardest to remember to translate.
 * `/challenges/nobody12345` settles into the same state and is what proves the
 * route table points the second template at the right component; the brief and
 * the verdict, which only exist once a challenge has been fetched, are asserted
 * in all three languages by `features/challenges/challenges.test.tsx`, where
 * one can be handed in without a server.
 */
const ROUTES = [
  '/',
  '/new',
  '/c/nobody12345',
  '/gallery',
  '/u/nobody',
  '/users/nobody',
  '/circuits',
  '/collections',
  '/collections/nobody12345',
  '/lessons',
  '/lessons/superposition',
  '/lessons/qpe',
  '/challenges',
  '/challenges/nobody12345',
  '/embed/c/nobody12345',
  '/settings',
  '/sign-in',
  '/sign-up',
  '/reset-password',
  '/update-password',
]
const LANGUAGES = ['en', 'es', 'fr'] as const

for (const route of ROUTES) {
  for (const language of LANGUAGES) {
    test(`${route} renders no raw i18n keys in ${language}`, async ({
      page,
    }) => {
      // Set the persisted preference before the app boots, so this exercises
      // the first-paint loading path rather than the language-switch one.
      // They load different namespace sets, and the bug was in the first.
      await page.addInitScript((lng) => {
        window.localStorage.setItem('qsim.language', lng)
      }, language)

      await page.goto(route)
      await expect(page.locator('#root')).not.toBeEmpty()

      /*
       * Polled rather than asserted once after `networkidle`.
       *
       * `networkidle` never fires on /new: the editor owns a Web Worker, and
       * in dev the HMR socket is open too, so waiting for the network to go
       * quiet waits for something that will not happen and the test times
       * out at 30 s having proved nothing about i18n.
       *
       * Polling is also the honest shape for what is being asserted. Catalogs
       * arrive asynchronously by design, so "no raw keys" is a state the page
       * settles into rather than one it starts in, and retrying until the
       * timeout distinguishes "renders a key forever" — the defect — from
       * "renders a key for one frame while its chunk is in flight".
       */
      await expect
        .poll(() => rawKeysOn(page), {
          message: `${route} in ${language} rendered i18n keys instead of translations`,
          timeout: 10_000,
        })
        .toEqual([])
    })
  }
}

/*
 * The lesson catalogs mark invariant notation with backticks (D2, and
 * `features/lessons/prose.ts`), and `LessonProse` is what turns a marked span
 * into the mono `Notation` element. A lesson string rendered by anything else
 * shows the reader the backticks themselves.
 *
 * That is a different defect from the one above and invisible to it: a backtick
 * is not a dotted key, and every other guard in the project sees the catalog
 * rather than the page. It shipped once — the index rendered `summary` with a
 * bare `t()`, which was harmless while no summary contained notation and
 * printed "`QPE`" on the phase estimation card the moment one did.
 *
 * Both addresses, because they render different string kinds: the index renders
 * the summary, the player renders the goal, the body, the notice, the task and
 * the hint.
 */
for (const route of ['/lessons', '/lessons/qpe']) {
  for (const language of LANGUAGES) {
    test(`${route} renders lesson notation, not backticks, in ${language}`, async ({
      page,
    }) => {
      await page.addInitScript((lng) => {
        window.localStorage.setItem('qsim.language', lng)
      }, language)

      await page.goto(route)
      await expect(page.locator('#root')).not.toBeEmpty()

      await expect
        .poll(() => page.locator('body').innerText(), {
          message: `${route} in ${language} printed a catalog backtick`,
          timeout: 10_000,
        })
        .not.toContain('`')
    })
  }
}

test('the landing shows its histogram table translated, not keyed', async ({
  page,
}) => {
  // The specific regression, pinned by meaning rather than by shape: the
  // accessible table is how a screen-reader user reads the page's argument,
  // so it is not enough that it renders something — it has to render words.
  await page.goto('/')
  const caption = page.locator('table caption').first()
  await expect(caption).toBeVisible()

  const text = (await caption.textContent())?.trim() ?? ''
  expect(text).not.toMatch(KEY_SHAPE)
  expect(text.length).toBeGreaterThan(0)
})
