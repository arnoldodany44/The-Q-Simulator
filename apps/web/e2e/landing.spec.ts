/**
 * The landing page, in a real browser — work plan M0.9b, specification §2.
 *
 * §2's acceptance criterion is a person, not an assertion: someone who has
 * never seen a quantum circuit understands superposition and entanglement in
 * under a minute. No suite can test that. What a suite can do is hold the two
 * things whose failure would make it impossible, and both of them are invisible
 * in a screenshot:
 *
 *  1. **The demonstration really simulates.** Four static pictures of the right
 *     charts would look identical to four live ones. The bars are read out of
 *     the chart's described table — the same reading a screen reader gets —
 *     and counted: one, two, four, two.
 *  2. **The page fits.** Three languages at 1280px and at 380px with no
 *     horizontal page scroll (WCAG 2.2 SC 1.4.10). French is the long one:
 *     "entanglement" is "intrication", "Start from an example" is "Partir d'un
 *     exemple", and the work plan names exactly this as the risk.
 *
 * Autoplay is stopped first in every case that walks the stages. The
 * demonstration advances by itself, which is the point of it, and a test
 * racing that timer would be asserting on whichever stage happened to be up.
 */

import { expect, test, type Page } from '@playwright/test'

/** Mirrors `LANGUAGE_STORAGE_KEY`; see `support/editor.ts` for why not imported. */
const LANGUAGE_STORAGE_KEY = 'qsim.language'

type UiLanguage = 'en' | 'es' | 'fr'

/** The stage buttons, by their names in each catalog, in sequence order. */
const STAGE_NAMES: Record<UiLanguage, readonly string[]> = {
  en: ['Nothing yet', 'One gate', 'Two coins', 'One pair'],
  es: ['Todavía nada', 'Una compuerta', 'Dos monedas', 'Un par'],
  fr: ['Rien encore', 'Une porte', 'Deux pièces', 'Une paire'],
}

/** What each stage's chart must draw. The whole argument, as four integers. */
const BARS_PER_STAGE = [1, 2, 4, 2]

async function openLanding(
  page: Page,
  language: UiLanguage = 'en'
): Promise<void> {
  await page.addInitScript(
    ([key, value]: [string, string]) => {
      window.localStorage.setItem(key, value)
    },
    [LANGUAGE_STORAGE_KEY, language] as [string, string]
  )
  await page.goto('/')
  // The catalogs load before the first render, so a visible chart means the
  // page is mounted, translated, and has already run a circuit.
  await expect(bars(page).first()).toBeVisible()
}

/**
 * The chart's rows, out of the described table — the same reading a screen
 * reader gets. Always four: the landing draws a fixed basis so that the stage
 * 3 → 4 transition is two bars shrinking rather than a re-layout in which every
 * row moves. What changes between stages is how many carry any probability.
 */
function bars(page: Page) {
  return page.locator('.histogram__table tbody tr')
}

/** The rows whose probability is not zero — the bars a reader actually sees. */
async function occupiedBars(page: Page): Promise<number> {
  const shares = await page
    .locator('.histogram__table tbody tr td:first-of-type')
    .allTextContents()
  return shares.filter((share) => !/^0\s*%$/u.test(share.trim())).length
}

function stage(page: Page, name: string) {
  return page.getByRole('button', { name: new RegExp(name) })
}

/**
 * Stops the sequence where it is, then goes to the first stage. Pressing the
 * button labelled "pause" is also the check that WCAG 2.2.2's stop control is
 * really there and really works.
 */
async function halt(page: Page, language: UiLanguage): Promise<void> {
  const pause = page.locator('button.demo__play')
  await pause.click()
  await stage(page, STAGE_NAMES[language][0] ?? '').click()
}

test.describe('The landing page', () => {
  test('simulates every stage rather than drawing it', async ({ page }) => {
    await openLanding(page)
    await halt(page, 'en')

    for (const [index, expected] of BARS_PER_STAGE.entries()) {
      await stage(page, STAGE_NAMES.en[index] ?? '').click()
      // Every reading of the pair keeps its row at every stage…
      await expect(bars(page)).toHaveCount(4)
      // …and this is the number that changes: one, two, four, two.
      expect(await occupiedBars(page)).toBe(expected)
    }

    /*
     * The claim the page is built on, checked at the end where the reader is
     * left: each qubit alone is still a coin, and the pair is certain to agree.
     * Two independent qubits would read 50 % here, which is the comparison the
     * stage before this one puts on screen.
     */
    const readings = page.locator('.demo__reading dd')
    await expect(readings.nth(1)).toHaveText(/50/)
    await expect(readings.nth(2)).toHaveText(/50/)
    await expect(page.locator('.demo__reading--pair dd')).toHaveText(/100/)
  })

  test('the two ways onwards go to different places', async ({ page }) => {
    await openLanding(page)

    await expect(
      page.getByRole('link', { name: 'Open the editor' }).first()
    ).toHaveAttribute('href', '/new')

    // The example route lands in the editor holding the circuit the
    // demonstration ended on, and `useExample` spends the parameter on arrival.
    await page
      .getByRole('link', { name: 'Start from an example' })
      .first()
      .click()

    await expect(page.getByRole('grid')).toBeVisible()
    await expect(page.getByRole('gridcell').first()).toHaveAccessibleName('H')
    await expect(page).toHaveURL(/\/new(\?c=|$)/)
  })

  /*
   * The editor is a lazily imported chunk (M0.9b), so this is also the proof
   * that the split did not break the route: a reader who never clicks pays
   * nothing for it, and a reader who does still arrives.
   */
  test('reaches the blank editor through the primary action', async ({
    page,
  }) => {
    await openLanding(page)

    await page.getByRole('link', { name: 'Open the editor' }).first().click()

    await expect(page.getByRole('grid')).toBeVisible()
    await expect(page.getByRole('button', { name: 'CNOT' })).toBeVisible()
  })

  for (const language of ['en', 'es', 'fr'] as const) {
    for (const width of [1280, 380]) {
      test(`fits at ${String(width)}px in "${language}"`, async ({ page }) => {
        await page.setViewportSize({ width, height: 900 })
        await openLanding(page, language)
        await halt(page, language)

        // Every stage, because the chart is four rows tall at one of them and
        // the diagram gains a column at another.
        for (const name of STAGE_NAMES[language]) {
          await stage(page, name).click()

          const overflow = await page.evaluate(() => {
            const root = document.documentElement
            return { scroll: root.scrollWidth, client: root.clientWidth }
          })
          expect(overflow.scroll).toBeLessThanOrEqual(overflow.client)
        }
      })
    }
  }

  /*
   * D2 reaches the shipped HTML: `lang` selects a screen reader's speech
   * synthesiser, and the description is what a bookmark, a search result and a
   * shared link show — including the Open Graph and Twitter copies, which are
   * the same sentence and must not drift from it.
   */
  test('declares its language and describes itself in it', async ({ page }) => {
    await openLanding(page, 'fr')

    await expect(page.locator('html')).toHaveAttribute('lang', 'fr')

    const meta = await page.evaluate(() =>
      [
        'meta[name="description"]',
        'meta[property="og:description"]',
        'meta[name="twitter:description"]',
      ].map(
        (selector) =>
          document.querySelector(selector)?.getAttribute('content') ?? null
      )
    )

    expect(meta[0]).toContain('circuits quantiques')
    expect(meta[1]).toBe(meta[0])
    expect(meta[2]).toBe(meta[0])
    // `language_TERRITORY`, which is the format ogp.me defines — a bare `fr`
    // is not a value the protocol knows, and a consumer that does not
    // recognise one falls back to its default of `en_US`.
    await expect(page.locator('meta[property="og:locale"]')).toHaveAttribute(
      'content',
      'fr_FR'
    )
  })
})
