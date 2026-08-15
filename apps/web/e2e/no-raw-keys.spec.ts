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
 */
const ROUTES = [
  '/',
  '/new',
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
