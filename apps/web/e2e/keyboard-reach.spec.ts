/**
 * Everything in the editor that a keyboard must be able to reach.
 *
 * M0.5's definition of done says the circuit has to be buildable "solo con
 * teclado", and §10 asks for an editor operable with no pointer at all.
 * `bell-pair.spec.ts` proves the *building* half of that. This suite proves
 * the other half — the controls around the canvas — because the editor's key
 * handler is bound to the whole editor and once answered every Enter, Space,
 * arrow and Delete in it as if focus were on the grid. The consequence was
 * not a subtle one: no button in the editor could be activated by keyboard,
 * the shortcuts disclosure could not be opened, and Delete on the Redo
 * button silently deleted the gate under the grid cursor.
 *
 * Every assertion here is a case that failed before that split existed, so
 * the suite is a regression net rather than a description.
 *
 * ## Why `focus()` rather than counted presses of Tab
 *
 * Tab-ing to a named control means hard-coding how many stops lie before it,
 * which breaks the day the page grows a link. `focus()` puts the caret where
 * a Tab would have left it and moves nothing else — and the pointer witness
 * runs alongside, so a `click()` slipped in later fails the test rather than
 * quietly turning it into a mouse test.
 */

import { expect, test, type Locator, type Page } from '@playwright/test'

import {
  cellAt,
  circuitSummary,
  gateChip,
  grid,
  openEditor,
  QUBITS,
  pointerInputSeen,
  statusLine,
  tabToGrid,
  toolbarButton,
  watchPointerInput,
  wireHeader,
} from './support/editor'

/** The disclosure that documents the keyboard map — itself pointer-only once. */
function shortcuts(page: Page): Locator {
  return page.locator('details.shortcuts')
}

function rowButton(page: Page, name: string): Locator {
  return page.getByRole('button', { name })
}

/** Places one Hadamard on q0 in the first moment, keyboard only. */
async function placeHadamard(page: Page): Promise<void> {
  await tabToGrid(page)
  await page.keyboard.press('h')
  await page.keyboard.press('Enter')
  await expect(cellAt(page, 0, 0)).toHaveAccessibleName('H')
}

test.describe('the controls around the canvas answer the keyboard', () => {
  test('Enter and Space activate the toolbar', async ({ page }) => {
    await watchPointerInput(page)
    await openEditor(page)
    await placeHadamard(page)

    const undo = toolbarButton(page, 'Undo')
    await undo.focus()
    await page.keyboard.press('Enter')
    await expect(circuitSummary(page)).toContainText('Operations: 0.')

    // Space is the other activation key of a button, and it has to work on
    // the toolbar even though the palette gives it to dnd-kit.
    const redo = toolbarButton(page, 'Redo')
    await redo.focus()
    await page.keyboard.press(' ')
    await expect(circuitSummary(page)).toContainText('Operations: 1.')

    await undo.focus()
    await page.keyboard.press(' ')
    await expect(circuitSummary(page)).toContainText('Operations: 0.')

    expect(await pointerInputSeen(page)).toEqual([])
  })

  test('Enter arms a palette chip, and Space still picks it up', async ({
    page,
  }) => {
    await watchPointerInput(page)
    await openEditor(page)

    const cnot = gateChip(page, 'cx')
    await cnot.focus()
    await page.keyboard.press('Enter')
    await expect(cnot).toHaveAttribute('aria-pressed', 'true')

    // Space belongs to dnd-kit's keyboard sensor and must be untouched by
    // the split: it starts a drag rather than arming.
    await page.keyboard.press(' ')
    await expect(page.locator('.circuit-editor__drag-chip')).toHaveCount(1)
    await page.keyboard.press('Escape')
    await expect(page.locator('.circuit-editor__drag-chip')).toHaveCount(0)

    expect(await pointerInputSeen(page)).toEqual([])
  })

  test('Enter and Space work the wire controls', async ({ page }) => {
    await watchPointerInput(page)
    await openEditor(page)
    await expect(wireHeader(page, 'q2')).toBeVisible()

    await rowButton(page, 'Insert a qubit below q0').focus()
    await page.keyboard.press('Enter')
    await expect(wireHeader(page, 'q3')).toBeVisible()

    await rowButton(page, 'Remove qubit q3').focus()
    await page.keyboard.press(' ')
    await expect(wireHeader(page, 'q3')).toHaveCount(0)

    expect(await pointerInputSeen(page)).toEqual([])
  })

  /*
   * The classical register's controls, which did not exist: the editor could
   * grow the quantum register and offered no way to grow the classical one,
   * so a wire added past the register was permanently unmeasurable and the
   * refusal advised a fix the UI did not have.
   */
  test('Enter and Space work the classical register controls', async ({
    page,
  }) => {
    await watchPointerInput(page)
    await openEditor(page)

    const register = page.getByRole('rowheader', { name: /classical register/ })
    await expect(register).toContainText('3 bits')

    await rowButton(page, 'Add a classical bit').focus()
    await page.keyboard.press('Enter')
    await expect(register).toContainText('4 bits')

    await rowButton(page, 'Remove the last classical bit').focus()
    await page.keyboard.press(' ')
    await expect(register).toContainText('3 bits')

    expect(await pointerInputSeen(page)).toEqual([])
  })

  test('a wire added past the register can still be measured', async ({
    page,
  }) => {
    await watchPointerInput(page)
    await openEditor(page)

    await rowButton(page, 'Insert a qubit below q2').focus()
    await page.keyboard.press('Enter')
    await expect(wireHeader(page, 'q3')).toBeVisible()

    await tabToGrid(page)
    for (let step = 0; step < 3; step += 1) {
      await page.keyboard.press('ArrowDown')
    }
    await page.keyboard.press('m')
    await page.keyboard.press('Enter')

    await expect(cellAt(page, 3, 0)).toHaveAccessibleName('M measured into c3')
    // Placed rather than refused, and said out loud: the refusal this test
    // was written for used to be the only thing this line ever carried.
    await expect(statusLine(page)).toHaveText('M placed on q3, column 0.')

    expect(await pointerInputSeen(page)).toEqual([])
  })

  test('the shortcuts panel opens without a pointer', async ({ page }) => {
    await watchPointerInput(page)
    await openEditor(page)

    const panel = shortcuts(page)
    await expect(panel).not.toHaveAttribute('open', /.*/)

    await panel.locator('summary').focus()
    await page.keyboard.press('Enter')
    await expect(panel).toHaveAttribute('open', /.*/)

    // A shortcut nobody can find is a shortcut nobody has: the map itself has
    // to be readable once the disclosure is open.
    await expect(panel).toContainText('Undo')

    await page.keyboard.press('Enter')
    await expect(panel).not.toHaveAttribute('open', /.*/)

    expect(await pointerInputSeen(page)).toEqual([])
  })
})

/*
 * Space was bound twice — dnd-kit's sensor and the grid's own `activate()` —
 * so one press picked a gate up *and* attempted a placement. On an occupied
 * cell the phantom placement was refused, and the refusal went to a live
 * region right after dnd-kit's "Gate picked up."; on an empty one it
 * succeeded, which is not what the shortcuts panel on the same page says
 * Space does. Only a browser can prove the pick-up still happens, which is
 * why this pair lives here rather than in jsdom.
 */
test.describe('Space picks a gate up and does nothing else', () => {
  test('a pick-up says nothing about placement', async ({ page }) => {
    await watchPointerInput(page)
    await openEditor(page)
    await placeHadamard(page)

    // Arming survives a placement, so the gate is still armed here — the
    // state that used to turn a pick-up into a refused placement.
    await expect(gateChip(page, 'h')).toHaveAttribute('aria-pressed', 'true')
    await expect(statusLine(page)).toHaveText('H placed on q0, column 0.')

    await page.keyboard.press(' ')
    await expect(page.locator('.circuit-editor__drag-chip')).toHaveCount(1)
    // The line the placement left is still the last thing that happened.
    await expect(statusLine(page)).toHaveText('H placed on q0, column 0.')

    await page.keyboard.press('Escape')
    await expect(page.locator('.circuit-editor__drag-chip')).toHaveCount(0)
    await expect(circuitSummary(page)).toContainText('Operations: 1.')

    expect(await pointerInputSeen(page)).toEqual([])
  })

  test('Space on an empty cell places nothing', async ({ page }) => {
    await watchPointerInput(page)
    await openEditor(page)
    await tabToGrid(page)

    await page.keyboard.press('h')
    await page.keyboard.press(' ')

    await expect(cellAt(page, 0, 0)).toHaveAccessibleName('free')
    await expect(circuitSummary(page)).toContainText('Operations: 0.')

    // Enter is still the placing key the panel advertises.
    await page.keyboard.press('Enter')
    await expect(cellAt(page, 0, 0)).toHaveAccessibleName('H')

    expect(await pointerInputSeen(page)).toEqual([])
  })
})

test.describe('grid keys do not act from outside the grid', () => {
  test('Delete on a toolbar button deletes nothing', async ({ page }) => {
    await watchPointerInput(page)
    await openEditor(page)
    await placeHadamard(page)

    const redo = toolbarButton(page, 'Redo')
    await redo.focus()
    await page.keyboard.press('Delete')
    await page.keyboard.press('Backspace')

    await expect(cellAt(page, 0, 0)).toHaveAccessibleName('H')
    await expect(circuitSummary(page)).toContainText('Operations: 1.')
    await expect(redo).toBeFocused()

    expect(await pointerInputSeen(page)).toEqual([])
  })

  test('an arrow key on a control moves neither focus nor the cursor', async ({
    page,
  }) => {
    await watchPointerInput(page)
    await openEditor(page)
    await tabToGrid(page)
    await page.keyboard.press('ArrowRight')
    await expect(cellAt(page, 0, 1)).toBeFocused()

    const arrows = ['ArrowRight', 'ArrowLeft', 'ArrowDown', 'Home', 'End']

    const undo = toolbarButton(page, 'Undo')
    await undo.focus()
    for (const key of arrows) {
      await page.keyboard.press(key)
      await expect(undo).toBeFocused()
    }

    // The wire controls live in the gutter, outside the grid, and were just
    // as exposed: an arrow key on one of them used to eject the user into
    // the canvas several hundred pixels away.
    const insert = rowButton(page, 'Insert a qubit below q0')
    await insert.focus()
    for (const key of arrows) {
      await page.keyboard.press(key)
      await expect(insert).toBeFocused()
    }

    // The cursor stayed exactly where the grid left it.
    await expect(cellAt(page, 0, 1)).toHaveClass(/circuit-canvas__cell--cursor/)

    expect(await pointerInputSeen(page)).toEqual([])
  })

  /*
   * The cold-page case, which a fix that only suppressed the *movement*
   * would leave broken: with the cursor already at column 0 an ArrowLeft
   * moves it nowhere, and yet it used to pull DOM focus into the grid all
   * the same, because reaching the cursor's own cell still set the flag that
   * makes the cell claim focus.
   */
  test('an arrow key on a control is inert on a grid nobody has touched', async ({
    page,
  }) => {
    await watchPointerInput(page)
    await openEditor(page)

    const undo = toolbarButton(page, 'Undo')
    await undo.focus()
    await page.keyboard.press('ArrowLeft')
    await page.keyboard.press('ArrowUp')

    await expect(undo).toBeFocused()
    expect(await pointerInputSeen(page)).toEqual([])
  })

  test('a gate key pressed on the toolbar arms nothing', async ({ page }) => {
    await watchPointerInput(page)
    await openEditor(page)
    // Placing a gate selects it, which is what makes Copy enabled — and a
    // disabled button cannot take focus, so the test would otherwise be
    // pressing `c` at the document and proving nothing.
    await placeHadamard(page)

    const copy = toolbarButton(page, 'Copy')
    await copy.focus()
    await expect(copy).toBeFocused()

    // `c` is CNOT's key and the initial of the button being aimed at — the
    // exact collision WCAG 2.1.4 is about.
    await page.keyboard.press('c')
    await expect(gateChip(page, 'cx')).toHaveAttribute('aria-pressed', 'false')

    // …while the same key is still live on the grid and in the palette,
    // which is where it belongs.
    await tabToGrid(page)
    await page.keyboard.press('c')
    await expect(gateChip(page, 'cx')).toHaveAttribute('aria-pressed', 'true')

    expect(await pointerInputSeen(page)).toEqual([])
  })
})

test.describe('the cursor stays visible', () => {
  /*
   * The wire gutter is `position: sticky` and opaque, so it paints over the
   * left edge of the scroller. A cursor cell scrolled into that band is "in
   * view" as far as the browser is concerned and invisible as far as the
   * user is concerned — WCAG 2.2 SC 2.4.11, and the focus ring §10 asks for.
   */
  test('never parks behind the sticky wire gutter', async ({ page }) => {
    await openEditor(page)
    await tabToGrid(page)

    // Twenty barriers, one per column: enough to overflow the canvas at any
    // sane window width, and a barrier needs no partner wire.
    await page.keyboard.press('b')
    for (let column = 0; column < 20; column += 1) {
      await page.keyboard.press('Enter')
      await page.keyboard.press('ArrowRight')
    }

    const viewport = page.locator('.circuit-canvas__viewport')
    expect(
      await viewport.evaluate((node) => node.scrollWidth > node.clientWidth),
      'the canvas has to actually overflow for this to test anything'
    ).toBe(true)

    const gutter = page.locator('.circuit-canvas__gutter')
    for (let step = 0; step < 21; step += 1) {
      const focused = grid(page).locator('.circuit-canvas__cell--cursor')
      const cell = await focused.boundingBox()
      const shade = await gutter.boundingBox()
      expect(cell, 'the cursor cell has a box').not.toBeNull()
      expect(shade, 'the gutter has a box').not.toBeNull()
      if (cell === null || shade === null) return

      expect(
        cell.x,
        `at step ${String(step)} the cursor is under the gutter`
      ).toBeGreaterThanOrEqual(shade.x + shade.width - 1)
      await page.keyboard.press('ArrowLeft')
    }
  })
})

/*
 * The classical register is a row of the ARIA grid, and the grid pattern
 * navigates every row of one. It was the single row the arrow keys could not
 * reach: `stepCell` clamped the cursor to the qubits, so the row that records
 * where a measurement landed existed only for a reader browsing the page in
 * virtual mode, and its empty cells had no name at all.
 */
test.describe('the classical register row', () => {
  test('takes the cursor and answers rather than doing nothing', async ({
    page,
  }) => {
    await watchPointerInput(page)
    await openEditor(page)
    await tabToGrid(page)

    await page.keyboard.press('m')
    await page.keyboard.press('Enter')

    // q0 → q1 → q2 → the register, one row past the last wire.
    for (let step = 0; step < QUBITS; step += 1) {
      await page.keyboard.press('ArrowDown')
    }

    // Scoped to the grid like every other row locator here: the analysis
    // panel's Bloch table is on the same page and names its rows the same way.
    const register = grid(page)
      .getByRole('row')
      .filter({
        has: page.getByRole('rowheader', { name: /classical register/ }),
      })
    const recorded = register.getByRole('gridcell').first()
    await expect(recorded).toBeFocused()
    await expect(recorded).toHaveAccessibleName(
      'c0 receives the measurement of q0'
    )

    // An empty slot is named too: a nameless gridcell is announced as
    // nothing at all, which is silence for as many columns as the grid has.
    await expect(register.getByRole('gridcell').nth(1)).toHaveAccessibleName(
      'free'
    )

    // Reachable and still never editable — said out loud, because a key that
    // is silent on one row and live on every other reads as a fault.
    await page.keyboard.press('Enter')
    await expect(statusLine(page)).toContainText(
      'The classical register is read-only'
    )

    expect(await pointerInputSeen(page)).toEqual([])
  })
})

/*
 * A keyboard drag used to survive Tab: focus walked off to the shortcuts
 * disclosure while the drag chip stayed on the canvas, the arrow keys no
 * longer reached it, and the editor's own key handler stayed switched off
 * for the whole time — recoverable only with an Escape the drag instructions
 * were no longer talking about.
 */
test('Tab ends a keyboard drag instead of leaving it running', async ({
  page,
}) => {
  await watchPointerInput(page)
  await openEditor(page)
  await placeHadamard(page)

  const chip = page.locator('.circuit-editor__drag-chip')
  await page.keyboard.press(' ')
  await expect(chip).toHaveCount(1)

  await page.keyboard.press('Tab')

  await expect(chip).toHaveCount(0)
  // The gate lands where the chip was visibly sitting, and focus stays on
  // the cell it belongs to rather than on a gesture nobody is performing.
  await expect(cellAt(page, 0, 0)).toBeFocused()
  await expect(cellAt(page, 0, 0)).toHaveAccessibleName('H')

  expect(await pointerInputSeen(page)).toEqual([])
})
