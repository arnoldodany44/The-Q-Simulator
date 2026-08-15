/**
 * The timeline scrubber in a real browser (M0.8, §3.1).
 *
 * Two things can only be settled here.
 *
 * **The keys.** The bar is an `<input type="range">` precisely so that the
 * platform answers the arrows, Home and End — and jsdom does not implement
 * any of that, so the unit tests can only assert the bounds those keys move
 * within. This spec presses them.
 *
 * **The join.** Stepping the bar has to reach the worker, come back with the
 * state at *that* column, and repaint the analysis panel with it. Every link
 * is unit-tested and the whole chain is not: the position leaves React,
 * becomes a field on a request, becomes a call to `stateAfterColumn` against
 * a checkpoint cache in another thread, and returns as amplitudes. Only a
 * browser runs all of that.
 *
 * The assertion is the physics, and it is the lesson the feature exists to
 * teach. A Bell pair is H on q0 then CNOT from q0 to q1. Stop the circuit
 * after the H and the two basis states carrying probability are |000⟩ and
 * |001⟩ — one qubit in superposition and nothing entangled. Let the CNOT run
 * and they become |000⟩ and |011⟩. Same circuit, same panel, one step of the
 * bar apart, and no component that only pretended to scrub could produce the
 * first pair at all.
 *
 * Catalog sentences are written out rather than imported, following the rule
 * in `support/editor.ts`: a test that read the same file the app rendered
 * from would pass just as happily if every value in it were empty.
 */

import { expect, test } from '@playwright/test'

import {
  analysisMoment,
  buildBellPairByKeyboard,
  drawnStates,
  openEditor,
  timelineBar,
  timelinePlay,
} from './support/editor'

const START = 'Before the first column'
const END = 'End of the circuit'
const AFTER_FIRST = 'After column 0'

const PLAY = 'Play'
const PAUSE = 'Pause'

test('the bar walks the circuit and the panel follows it', async ({ page }) => {
  await openEditor(page)
  await buildBellPairByKeyboard(page)

  const bar = timelineBar(page)
  // Three stops for two columns: before column 0, after it, and the end.
  await expect(bar).toHaveAttribute('aria-valuetext', END)
  await expect(analysisMoment(page)).toHaveCount(0)
  await expect(drawnStates(page)).toHaveText(['|000⟩', '|011⟩'])

  await bar.focus()
  await page.keyboard.press('Home')

  // The ground state, which is a position the circuit really has: nothing has
  // run yet, so one basis state carries everything.
  await expect(bar).toHaveAttribute('aria-valuetext', START)
  await expect(drawnStates(page)).toHaveText(['|000⟩'])
  await expect(analysisMoment(page)).toHaveText(
    'The state before column 0 runs — where the circuit starts.'
  )

  await page.keyboard.press('ArrowRight')

  // After the Hadamard and before the CNOT. Qubit 0 is the least significant
  // bit (D1), so the superposition is |000⟩ and |001⟩ — and the *absence* of
  // |011⟩ here is the whole point: the entanglement has not happened yet.
  await expect(bar).toHaveAttribute('aria-valuetext', AFTER_FIRST)
  await expect(drawnStates(page)).toHaveText(['|000⟩', '|001⟩'])
  await expect(analysisMoment(page)).toHaveText(
    'The state after column 0, not at the end of the circuit.'
  )

  await page.keyboard.press('ArrowLeft')
  await expect(bar).toHaveAttribute('aria-valuetext', START)

  await page.keyboard.press('End')

  // Back to the end, which is the circuit's own answer: the panel says
  // nothing extra, because there is nothing extra to say.
  await expect(bar).toHaveAttribute('aria-valuetext', END)
  await expect(drawnStates(page)).toHaveText(['|000⟩', '|011⟩'])
  await expect(analysisMoment(page)).toHaveCount(0)
})

test('Space plays the timeline, and playback stops at the end', async ({
  page,
}) => {
  await openEditor(page)
  await buildBellPairByKeyboard(page)

  const bar = timelineBar(page)
  await bar.focus()
  await page.keyboard.press('Home')
  await expect(timelinePlay(page)).toHaveText(PLAY)

  // Space is the key the grid three inches above uses to pick a gate up, and
  // it means something else here. This press is what proves the two meanings
  // do not collide in a real browser: the editor's own handler ignores
  // everything originating inside an `input`.
  await page.keyboard.press(' ')
  await expect(timelinePlay(page)).toHaveText(PAUSE)

  // Polled rather than timed: what matters is that it walks on its own and
  // then *stops* — a loop would be a timer running for as long as the tab is
  // open, and the end of a circuit is a result rather than a lap marker.
  await expect(bar).toHaveAttribute('aria-valuetext', END, { timeout: 10_000 })
  await expect(timelinePlay(page)).toHaveText(PLAY)
  await expect(drawnStates(page)).toHaveText(['|000⟩', '|011⟩'])

  // And pressing play at the end rewinds rather than doing nothing.
  await page.keyboard.press(' ')
  await expect(bar).toHaveAttribute('aria-valuetext', START)
})
