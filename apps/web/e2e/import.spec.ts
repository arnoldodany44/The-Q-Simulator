/**
 * §3.5 in a real browser: a file somebody else wrote becomes a circuit on the
 * canvas.
 *
 * ── WHAT ONLY A BROWSER SETTLES ──────────────────────────────────────────
 *
 * `@qsim/qasm` proves the reading, `ImportPanel.test.tsx` proves the panel, and
 * both would pass for a milestone in which no imported circuit ever reached the
 * grid. What is joined only here is everything between: the `import` catalog
 * being in the editor route's namespace list at all (the exact defect
 * `no-raw-keys.spec.ts` exists for), the panel being mounted, the store's
 * `loadCircuit` repainting the canvas, and the worker re-simulating the
 * document that arrived.
 *
 * ── AND THE SURFACE NO WALK OF THE PAGE CAN REACH ────────────────────────
 *
 * A closed `<details>` keeps its children in the DOM, so `no-raw-keys.spec.ts`
 * already sees the panel's labels on `/new`. What it cannot see is the half of
 * this catalog that only exists *after a failure* — a dozen sentences naming a
 * line, a column and an OpenQASM keyword, which is precisely the surface nobody
 * opens while translating. So this file provokes one in French and asserts the
 * same shape-based property there.
 *
 * The catalog sentences are written out rather than imported, following the
 * rule in `support/editor.ts`: a test that read the same file the app rendered
 * from would pass just as happily if every value in it were empty.
 */

import { expect, test, type Page } from '@playwright/test'

import {
  cellAt,
  dragOnto,
  expectBellPairDrawn,
  gateChip,
  openEditor,
  type UiLanguage,
} from './support/editor'

/** A Bell pair written the way a hardware console emits one. */
const BELL = `OPENQASM 3.0;
include "stdgates.inc";
qubit[2] q;
h q[0];
cx q[0], q[1];
`

/** OpenQASM 2, from a Qiskit notebook, with a conditional and two registers. */
const TELEPORT_FRAGMENT = `OPENQASM 2.0;
include "qelib1.inc";
qreg q[3];
creg c[1];
h q[1];
cx q[1],q[2];
measure q[0] -> c[0];
if(c==1) x q[2];
`

/**
 * The two presses the import now takes, and the dialog they open.
 *
 * It used to be a `<details>` above the canvas and this helper clicked its
 * `<summary>`. It moved behind the toolbar's overflow in `dece047`, this helper
 * was not updated, and these four tests went red for twelve commits — the E2E
 * workflow is separate from CI and nobody, me included, looked at it. Every
 * assertion below is unchanged; only the way in is.
 *
 * The dialog is returned rather than the panel, because that is the scope the
 * controls now live in and it is what keeps `readButton` from finding the
 * overflow trigger.
 */
async function openImport(page: Page, language: UiLanguage = 'en') {
  await openEditor(page, language)
  await page.locator('.toolbar-overflow__trigger').click()
  await page.locator('.toolbar-overflow__menu [role="menuitem"]').click()
  const dialog = page.locator('dialog.modal')
  await expect(dialog.locator('textarea')).toBeVisible()
  return dialog
}

/**
 * The "read this circuit" button, by class rather than by role.
 *
 * A file input is also a button in Chromium's accessibility tree, so this panel
 * legitimately has two — and addressing this one by its accessible name would
 * mean writing the sentence out three times, once per language, for a control
 * whose identity is not its wording.
 */
function readButton(panel: ReturnType<Page['locator']>) {
  return panel.locator('button.import-panel__button')
}

async function paste(page: Page, source: string, language: UiLanguage = 'en') {
  const panel = await openImport(page, language)
  await panel.locator('textarea').fill(source)
  await readButton(panel).click()
  return panel
}

test('a pasted OpenQASM 3 program lands on the canvas', async ({ page }) => {
  const panel = await paste(page, BELL)

  await expect(panel.locator('.import-panel__status')).toContainText(
    'OpenQASM 3'
  )
  /*
   * The same assertion `bell-pair.spec.ts` makes about a Bell pair built by
   * hand: two operations, the Hadamard's label, and the control drawn on the
   * wire *above* its target. That last one is the endianness claim as a
   * picture — a mirrored reader would put the dot below the plus, and the file
   * would still be perfectly valid OpenQASM (D1, §16 risk 2).
   */
  await expectBellPairDrawn(page)
})

test('a pasted OpenQASM 2 program is read as OpenQASM 2', async ({ page }) => {
  const panel = await paste(page, TELEPORT_FRAGMENT)
  await expect(panel.locator('.import-panel__status')).toContainText(
    'OpenQASM 2'
  )
  await expect(cellAt(page, 1, 0)).toHaveAccessibleName('H')
})

test('a broken program says which line, and leaves the circuit alone', async ({
  page,
}) => {
  /*
   * The gate goes on the canvas BEFORE the dialog opens, and the order is not
   * incidental.
   *
   * A modal makes the rest of the document inert — that is what `showModal()`
   * is for — so a drag aimed at the canvas while it is open lands on nothing.
   * This test used to open the panel first, because the panel was a `<details>`
   * above the canvas and left it reachable. The assertion is unchanged: one
   * gate first, so "the circuit is untouched" is a claim with something in it.
   */
  await openEditor(page)
  await dragOnto(page, gateChip(page, 'x'), cellAt(page, 0, 0))
  await expect(cellAt(page, 0, 0)).toHaveAccessibleName('X')

  await page.locator('.toolbar-overflow__trigger').click()
  await page.locator('.toolbar-overflow__menu [role="menuitem"]').click()
  const panel = page.locator('dialog.modal')
  await expect(panel.locator('textarea')).toBeVisible()

  await panel.locator('textarea').fill('qubit[2] q;\nh q[0]\ncx q[0], q[1];')
  await readButton(panel).click()

  const status = panel.locator('.import-panel__status')
  await expect(status).toContainText('Line 3')
  await expect(status).toContainText('column 1')
  // Nothing was lost: a refused import leaves the document exactly as it was,
  // which is also why that line is a `status` and not an `alert`.
  await expect(cellAt(page, 0, 0)).toHaveAccessibleName('X')
})

test('an unsupported construct is named, in French, with no raw keys', async ({
  page,
}) => {
  const panel = await paste(
    page,
    'qubit[2] q;\nfor i in [0:2] { x q[0]; }',
    'fr'
  )

  const status = panel.locator('.import-panel__status')
  // The keyword itself is the language's word and stays untranslated (D2); the
  // sentence around it is French.
  await expect(status).toContainText('for')
  await expect(status).toContainText('ligne 2')

  /*
   * The same property `no-raw-keys.spec.ts` asserts route-wide, on the surface
   * that only exists after a failure. Shape-based rather than a list of
   * expected strings, so a key added later is caught without being told about
   * it.
   */
  const keys = await page.evaluate(() => {
    const shape = /^[a-z][a-zA-Z]*(\.[a-zA-Z]+)+$/
    const found = new Set<string>()
    for (const element of document.querySelectorAll('.import-panel *')) {
      if (element.children.length > 0) continue
      const text = (element.textContent ?? '').trim()
      if (text && shape.test(text)) found.add(text)
    }
    return [...found]
  })
  expect(keys).toEqual([])
})
