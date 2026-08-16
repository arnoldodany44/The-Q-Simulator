/**
 * Independent verification (lens: ui-truth-a11y) — the noise panel in French,
 * at a laptop width and at a phone width, and reachable from the keyboard.
 *
 * §10's quality constraints are two sentences and both are measurable in a real
 * browser and nowhere else: "responsivo hasta móvil" and "foco de teclado
 * visible". French is the width case that matters, because every label in this
 * panel is longer in French than in English — "Durée d'une porte à deux qubits"
 * against "Two-qubit gate time" — and the fields are a grid with a fixed
 * minimum on the first column.
 *
 * WHAT COUNTS AS FAILING. WCAG 2.2 SC 1.4.10 asks that content not require
 * scrolling in two directions, so the check is on the *document*: a panel whose
 * own table scrolls sideways inside its viewport is fine and is what
 * `.noise-comparison`, `.qsphere__viewport` and `.density__viewport` are for; a
 * document that scrolls sideways is not. Everything here is opened first — the
 * custom-profile form, the density heat map, the trajectories slider — because
 * the widest thing on the panel is behind a control, which is exactly the
 * surface a translator and a reviewer both skip.
 *
 * Named for the lens so it cannot collide with another verifier's spec.
 */

import { expect, test, type Page } from '@playwright/test'

import { openEditor, simulationState } from './support/editor'

const READY_FR = 'Ceci décrit le circuit affiché.'

/** How wide the document wants to be against how wide it is. */
async function documentOverflow(
  page: Page
): Promise<{ scroll: number; client: number }> {
  return page.evaluate(() => {
    const root = document.documentElement
    return { scroll: root.scrollWidth, client: root.clientWidth }
  })
}

/** Opens every part of the noise mode that is behind a control. */
async function openEverything(page: Page): Promise<void> {
  await page
    .getByRole('checkbox', {
      name: 'Exécuter ce circuit avec un modèle de bruit',
    })
    .check()
  // The custom profile: eight number fields, each with a French sentence.
  await page.getByLabel('Appareil').selectOption('custom')
  await expect(page.getByText('Chiffres de l’appareil')).toBeVisible()
  // The heat map: two SVG grids and a five-column table.
  await page
    .getByRole('checkbox', {
      name: 'Afficher la matrice de densité (avancé)',
    })
    .check()
  await expect(page.locator('.density__grid-table')).toBeVisible({
    timeout: 15_000,
  })
}

for (const width of [1280, 380]) {
  test(`the whole noise mode fits at ${String(width)}px in French`, async ({
    page,
  }) => {
    await page.setViewportSize({ width, height: 900 })
    await openEditor(page, 'fr')
    await expect(simulationState(page)).toHaveText(READY_FR)

    await openEverything(page)

    const exact = await documentOverflow(page)
    expect(
      exact.scroll,
      'the document scrolls sideways with the exact method open'
    ).toBeLessThanOrEqual(exact.client)

    // And again with the sampled method, whose row adds a slider, a reading
    // and a button to one line.
    await page
      .getByRole('radio', { name: 'Échantillonné (trajectoires)' })
      .check()
    await expect(page.getByRole('slider')).toBeVisible()

    const sampled = await documentOverflow(page)
    expect(
      sampled.scroll,
      'the document scrolls sideways with the sampled method open'
    ).toBeLessThanOrEqual(sampled.client)
  })

  test(`the refused ceiling fits at ${String(width)}px in French`, async ({
    page,
  }) => {
    /*
     * The register is grown at a desktop width and the window is narrowed
     * afterwards, because below 768px the editor is deliberately read-only
     * (§10, risk 6) and has no wire controls at all. What is being measured is
     * the refusal block — a French paragraph and a button on one line, the
     * widest single thing this panel can show — at the width it has to survive.
     */
    await page.setViewportSize({ width: 1280, height: 900 })
    await openEditor(page, 'fr')
    await expect(simulationState(page)).toHaveText(READY_FR)

    const insert = page.getByRole('button', {
      name: 'Insérer un qubit sous q0',
    })
    for (let index = 0; index < 10; index++) await insert.click()
    await page
      .getByRole('checkbox', {
        name: 'Exécuter ce circuit avec un modèle de bruit',
      })
      .check()
    await expect(page.locator('.noise__refusal-text')).toBeVisible()

    await page.setViewportSize({ width, height: 900 })
    await expect(page.locator('.noise__refusal-text')).toBeVisible()

    const refused = await documentOverflow(page)
    expect(
      refused.scroll,
      'the document scrolls sideways while the ceiling is refused'
    ).toBeLessThanOrEqual(refused.client)

    // The refusal names both numbers in French digits, and the way out is a
    // control rather than advice.
    await expect(page.locator('.noise__refusal-text')).toContainText('13')
    await expect(page.locator('.noise__refusal-text')).toContainText('12')
    await expect(
      page.getByRole('button', {
        name: 'Utiliser les trajectoires échantillonnées',
      })
    ).toBeVisible()
  })
}

test('every noise control is reachable and visibly focused by keyboard', async ({
  page,
}) => {
  await page.setViewportSize({ width: 1280, height: 900 })
  await openEditor(page, 'fr')
  await openEverything(page)

  /*
   * Tab from the top until each control has been focused, and check the focus
   * ring is really painted. `:focus-visible` is what §10 asks for, and a
   * stylesheet that removed the outline without replacing it is invisible to
   * every assertion that only checks `document.activeElement`.
   */
  const wanted = [
    '.noise__select',
    '.noise__input',
    '.noise__methods input[type="radio"]',
    '.noise__toggle input[type="checkbox"]',
  ]

  const reached = new Set<string>()
  for (let step = 0; step < 400 && reached.size < wanted.length; step++) {
    await page.keyboard.press('Tab')
    const matched = await page.evaluate((selectors) => {
      const active = document.activeElement
      if (active === null) return null
      const hit = selectors.find((selector) => active.matches(selector))
      if (hit === undefined) return null
      const style = getComputedStyle(active)
      return {
        hit,
        outline: style.outlineStyle,
        outlineWidth: style.outlineWidth,
        boxShadow: style.boxShadow,
      }
    }, wanted)
    if (matched === null) continue
    reached.add(matched.hit)
    const ringed =
      (matched.outline !== 'none' && matched.outlineWidth !== '0px') ||
      matched.boxShadow !== 'none'
    expect(ringed, `${matched.hit} has no visible focus indicator`).toBe(true)
  }

  expect([...reached].sort(), 'not every control was reachable by Tab').toEqual(
    [...wanted].sort()
  )
})

test('the analysis panel keeps its numbers when motion is reduced', async ({
  page,
}) => {
  // §10: the phasors freeze and print their angle. The Q-sphere stops turning,
  // and the numbers beside it do not change — the picture's rotation carries no
  // information (§3.2), so taking it away must take nothing with it.
  await page.emulateMedia({ reducedMotion: 'reduce' })
  await page.setViewportSize({ width: 1280, height: 900 })
  await openEditor(page, 'fr')
  await expect(simulationState(page)).toHaveText(READY_FR)

  await page
    .getByRole('checkbox', {
      name: 'Exécuter ce circuit avec un modèle de bruit',
    })
    .check()
  await expect(page.locator('.noise-comparison')).toBeVisible({
    timeout: 15_000,
  })

  // The numeric angle column §10 substitutes for the motion.
  await expect(page.locator('.histogram__angle').first()).toBeVisible()
  // The Q-sphere's table is untouched by the preference.
  await expect(page.locator('.qsphere__grid tbody tr').first()).toBeVisible()
})
