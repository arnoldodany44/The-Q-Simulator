/**
 * M0.5's definition of done: build a Bell pair in the editor and prove the
 * canvas shows one.
 *
 * The work plan writes the milestone as "drag an H to (q0, c0), a CNOT from
 * q0 to q1, and the resulting circuit is a Bell pair". Both routes to that
 * circuit are tested here, and they are equals rather than a route and its
 * fallback:
 *
 *  - the pointer, because a drag is the gesture the editor was designed
 *    around and the only one that exercises dnd-kit end to end;
 *  - the keyboard, because §10 requires the whole editor to be operable with
 *    no pointer at all, and that is the requirement most likely to regress
 *    without anyone noticing — nothing about a broken keyboard path looks
 *    broken in a screenshot.
 *
 * Neither test reads the store. The claim being made is that a user who
 * performs these gestures ends up looking at a Bell pair, and the store is
 * one layer short of that.
 *
 * The circuit built is H on q0 followed by a CNOT with q0 controlling q1:
 * (|00⟩ + |11⟩)/√2 under decision D1, where q0 is the least significant bit.
 */

import { expect, test } from '@playwright/test'

import {
  cellAt,
  dragOnto,
  expectBellPair,
  expectBellPairDrawn,
  gateChip,
  openEditor,
  pointerInputSeen,
  statusLine,
  tabToGrid,
  watchPointerInput,
} from './support/editor'

test.describe('Building a Bell pair', () => {
  test('by dragging the gates onto the canvas', async ({ page }) => {
    await openEditor(page)

    await dragOnto(page, gateChip(page, 'h'), cellAt(page, 0, 0))
    await expect(cellAt(page, 0, 0)).toHaveAccessibleName('H')

    /*
     * A CNOT touches two wires and is placed in two steps (placement.ts):
     * the drop fixes the ⊕ — the glyph that appears under the cursor is the
     * one on the chip the user dragged — and the editor then asks for the
     * control. Dropping on q1 and answering q0 is "a CNOT from q0 to q1".
     */
    await dragOnto(page, gateChip(page, 'cx'), cellAt(page, 1, 1))
    await expect(statusLine(page)).toContainText(
      'CNOT needs its control qubit in this column.'
    )

    await cellAt(page, 0, 1).click()

    await expectBellPair(page)
    await expectBellPairDrawn(page)
  })

  test('with the keyboard alone', async ({ page }) => {
    await watchPointerInput(page)
    await openEditor(page)

    // Tab is the only way in, and the cell that receives focus has to say so
    // visibly: a keyboard cursor nobody can see is not a cursor (§10).
    await tabToGrid(page)
    await expect(cellAt(page, 0, 0)).toHaveClass(/circuit-canvas__cell--cursor/)

    await page.keyboard.press('h')
    await expect(gateChip(page, 'h')).toHaveAttribute('aria-pressed', 'true')
    await page.keyboard.press('Enter')
    await expect(cellAt(page, 0, 0)).toHaveAccessibleName('H')

    // Arm the CNOT, walk to q1 in the next moment, and drop its target there.
    await page.keyboard.press('c')
    await page.keyboard.press('ArrowDown')
    await page.keyboard.press('ArrowRight')
    await expect(cellAt(page, 1, 1)).toBeFocused()
    await page.keyboard.press('Enter')

    // The half-placed gate asks for its second wire out loud, which is the
    // whole reason a keyboard user can finish a two-qubit gate at all.
    await expect(statusLine(page)).toContainText(
      'CNOT needs its control qubit in this column.'
    )

    await page.keyboard.press('ArrowUp')
    await page.keyboard.press('Enter')

    await expectBellPair(page)
    await expectBellPairDrawn(page)

    // The point of the test, asserted rather than assumed: the page never
    // saw a pointer. A `click()` added here later fails this line.
    expect(await pointerInputSeen(page)).toEqual([])
  })
})
