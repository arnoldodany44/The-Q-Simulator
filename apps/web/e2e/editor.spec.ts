/**
 * Properties of the editor that would fail quietly rather than loudly, and
 * that are worth settling against a real browser end to end.
 *
 *  - **Switching language mid-edit.** D2 makes es/en/fr first-class, and the
 *    failure mode is not a crash: it is a French user losing the circuit they
 *    were building because the switch went through a reload, or an English
 *    sentence surviving in a French interface. Neither shows up in a unit
 *    test of the picker.
 *  - **Undo after a drag.** The store's own tests prove undo over the store's
 *    API. What they cannot prove is that the drag which just happened
 *    recorded exactly one history step — and a drag that records two, or
 *    none, is only visible from the outside.
 *  - **Where a pasted measurement writes.** The store's tests pin the JSON;
 *    this pins what the user is told, which is the only place the mistake
 *    was ever visible.
 *  - **That the live region really speaks twice.** jsdom can be asked
 *    whether a node was replaced, but only a browser settles that the
 *    replacement happens inside a `role="status"` element as rendered — and
 *    a second identical sentence that produces no mutation is announced by
 *    nobody, which is the exact failure this suite exists to catch.
 */

import { expect, test, type Page } from '@playwright/test'

import {
  buildBellPairByKeyboard,
  cellAt,
  circuitSummary,
  dragOnto,
  expectBellPair,
  gateChip,
  languagePicker,
  openEditor,
  statusLine,
  storedLanguage,
  tabToGrid,
  toolbarButton,
} from './support/editor'

test('switching language mid-edit translates the interface and leaves the circuit alone', async ({
  page,
}) => {
  await openEditor(page)
  await buildBellPairByKeyboard(page)
  await expectBellPair(page, 'en')

  await languagePicker(page).selectOption('fr')

  await expect(
    page.getByRole('heading', { name: 'Nouveau circuit' })
  ).toBeVisible()
  await expect(toolbarButton(page, 'Annuler')).toBeVisible()

  /*
   * The same circuit, now described in French. This is also what proves the
   * switch did not go through a reload: the document lives in memory, so a
   * reload would have left an empty canvas here rather than a Bell pair.
   *
   * `H` and `CNOT` stay as they are in every language — they are notation,
   * and translating them would break the correspondence with Qiskit and with
   * every textbook a user might read alongside this app (D2).
   */
  await expectBellPair(page, 'fr')
  expect(await storedLanguage(page)).toBe('fr')

  await languagePicker(page).selectOption('es')
  await expect(toolbarButton(page, 'Deshacer')).toBeVisible()
  await expectBellPair(page, 'es')
})

test('undo after a drag restores the previous circuit', async ({ page }) => {
  await openEditor(page)

  await dragOnto(page, gateChip(page, 'h'), cellAt(page, 0, 0))
  await expect(cellAt(page, 0, 0)).toHaveAccessibleName('H')
  await expect(circuitSummary(page)).toContainText('Operations: 1.')
  // The pointer path reports through the same line as the keyboard one, and
  // says what landed where — which is why dnd-kit's own generic "Gate
  // dropped." was retired rather than left to arrive first.
  await expect(statusLine(page)).toHaveText('H placed on q0, column 0.')

  await toolbarButton(page, 'Undo').click()

  await expect(cellAt(page, 0, 0)).toHaveAccessibleName('free')
  await expect(circuitSummary(page)).toContainText('Operations: 0.')

  // One drag, one step: redo brings back exactly what undo took away. A drag
  // that had recorded two steps would need two presses to come back.
  await toolbarButton(page, 'Redo').click()
  await expect(cellAt(page, 0, 0)).toHaveAccessibleName('H')
  await expect(circuitSummary(page)).toContainText('Operations: 1.')
})

/*
 * A pasted measurement used to keep the classical bit it was copied from, so
 * two measurements in one column wrote the same bit. The contract accepts
 * that shape and the engine takes a column's operations in no particular
 * order, so the circuit's answer depended on the order of an array — a
 * silent nondeterminism with nothing on screen to hint at it.
 */
test('a pasted measurement writes into the bit of the wire it lands on', async ({
  page,
}) => {
  await openEditor(page)
  await tabToGrid(page)

  await page.keyboard.press('m')
  await page.keyboard.press('Enter')
  await expect(cellAt(page, 0, 0)).toHaveAccessibleName('M measured into c0')

  await page.keyboard.press('Control+c')
  await page.keyboard.press('ArrowDown')
  await page.keyboard.press('Control+v')

  await expect(cellAt(page, 1, 0)).toHaveAccessibleName('M measured into c1')
  // The register row says the same thing from the other side: two writers,
  // two bits.
  await expect(circuitSummary(page)).toContainText('Operations: 2.')
})

/*
 * The live region used to speak only to refuse. Everything that worked was
 * silent, so a screen-reader user pressing Enter, Delete or Ctrl+Z had no
 * confirmation that anything had happened — and undo is the case with no
 * fallback at all, because an undo that fired and an undo that found an
 * empty stack leave an identical canvas behind.
 */
test('the editor says what it just did, undo included', async ({ page }) => {
  await openEditor(page)
  await tabToGrid(page)

  await page.keyboard.press('h')
  await page.keyboard.press('Enter')
  await expect(statusLine(page)).toHaveText('H placed on q0, column 0.')

  // Navigation is not news: the region empties rather than narrating the
  // cursor, which would bury every report that matters.
  await page.keyboard.press('ArrowRight')
  await expect(statusLine(page)).toHaveText('')

  // Back onto the gate and delete it. The sentence names what went and
  // where it was, rather than leaving the user to find out by walking the
  // grid cell by cell.
  await page.keyboard.press('ArrowLeft')
  await page.keyboard.press('Delete')
  await expect(statusLine(page)).toHaveText('H removed from q0, column 0.')
  await expect(cellAt(page, 0, 0)).toHaveAccessibleName('free')

  await page.keyboard.press('Control+z')
  await expect(statusLine(page)).toHaveText('Undone.')
  await expect(cellAt(page, 0, 0)).toHaveAccessibleName('H')

  await page.keyboard.press('Control+z')
  await page.keyboard.press('Control+z')
  await expect(statusLine(page)).toHaveText('There is nothing left to undo.')
})

/*
 * Trap 4.1 of the repair: a report identical to the one before it renders
 * the same string, React leaves the text node alone, no mutation record is
 * produced — and a live region that does not change announces nothing. Two
 * undos in a row are the everyday way to hit it.
 */
test('a repeated report is announced again rather than swallowed', async ({
  page,
}) => {
  await openEditor(page)
  await tabToGrid(page)

  await page.keyboard.press('h')
  await page.keyboard.press('Enter')
  await page.keyboard.press('ArrowRight')
  await page.keyboard.press('x')
  await page.keyboard.press('Enter')

  await watchStatusRegion(page)

  await page.keyboard.press('Control+z')
  await expect(statusLine(page)).toHaveText('Undone.')
  await page.keyboard.press('Control+z')
  await expect(statusLine(page)).toHaveText('Undone.')

  // Two undos, two sentences, two mutations of the region — the second one
  // says the same words as the first and still has to reach the reader.
  expect(await statusMutations(page)).toBeGreaterThanOrEqual(2)
})

interface StatusWitness {
  __qsimStatusMutations?: number
}

/** Counts every mutation of the editor's live region from now on. */
async function watchStatusRegion(page: Page): Promise<void> {
  await page.evaluate(() => {
    const region = document.querySelector('p.circuit-editor__status')
    if (region === null) throw new Error('the status region is not on the page')
    const witness = window as unknown as StatusWitness
    witness.__qsimStatusMutations = 0
    new MutationObserver((records) => {
      witness.__qsimStatusMutations =
        (witness.__qsimStatusMutations ?? 0) + records.length
    }).observe(region, {
      childList: true,
      subtree: true,
      characterData: true,
    })
  })
}

function statusMutations(page: Page): Promise<number> {
  return page.evaluate(
    () => (window as unknown as StatusWitness).__qsimStatusMutations ?? 0
  )
}

/*
 * WCAG 2.2 SC 1.4.10 Reflow: no horizontal page scrolling at 320 CSS px. The
 * shortcuts panel broke it in Spanish and French only, which is why it needs
 * a browser and all three languages: its two-column grid handed the key
 * column whatever its widest `nowrap` key demanded, and translated key names
 * ("Tecla de compuerta", Ctrl+Maj+Z) are longer than the English ones. The
 * description column collapsed to fifteen pixels in every language, and in
 * es and fr the overflow reached past the edge of the page.
 */
for (const language of ['en', 'es', 'fr'] as const) {
  test(`the page never scrolls sideways at 320px in ${language}`, async ({
    page,
  }) => {
    await page.setViewportSize({ width: 320, height: 800 })
    await openEditor(page, language)

    const panel = page.locator('details.shortcuts')
    await panel.locator('summary').click()
    await expect(panel).toHaveAttribute('open', /.*/)

    const overflow = await page.evaluate(() => {
      const root = document.documentElement
      const widths = [
        ...document.querySelectorAll<HTMLElement>('.shortcuts__description'),
      ].map((node) => node.clientWidth)
      return {
        scrollWidth: root.scrollWidth,
        clientWidth: root.clientWidth,
        narrowestDescription: Math.min(...widths),
      }
    })

    expect(overflow.scrollWidth).toBeLessThanOrEqual(overflow.clientWidth)
    // …and readable rather than merely contained: a description column of
    // fifteen pixels is a panel nobody can use, in any language.
    expect(overflow.narrowestDescription).toBeGreaterThan(150)
  })
}
