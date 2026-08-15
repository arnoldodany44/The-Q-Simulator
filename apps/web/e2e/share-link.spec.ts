/**
 * M0.9's definition of done, in a real browser: "copy the URL, open it in a
 * private window, get an identical circuit".
 *
 * Every layer of decision D4 is unit-tested — the codec against randomised
 * circuits, the hook against a jsdom history — and none of that can answer the
 * question this file asks, which is whether the address bar of a real browser
 * ends up carrying a circuit a *different browser session* can open. So the
 * second half of each test uses a fresh context: no shared storage, no shared
 * session, nothing in common with the first page but the string that was
 * copied out of it. That is the private window the work plan names.
 *
 * The Back button is here for the same reason. `replaceState` versus
 * `pushState` is one word in the source and the difference is invisible in
 * every unit test that does not count history entries; what it costs when it
 * is wrong is a reader who cannot leave the page.
 */

import { expect, test, type Page } from '@playwright/test'

import { cellAt, circuitSummary, grid, openEditor } from './support/editor'

/** The example strip's button for the Bell pair. */
function presetButton(page: Page, name: string) {
  return page.getByRole('button', { name: new RegExp(`^${name}`) })
}

function shareField(page: Page) {
  return page.getByRole('textbox', { name: 'Link to this circuit' })
}

/**
 * The two-wire Bell pair of the preset, as the canvas presents it.
 *
 * Deliberately not the suite's `expectBellPair`: that one describes the *three*
 * wire document a fresh editor starts with, and the whole point of loading a
 * preset is that the register comes from the link rather than from the default.
 */
async function expectBellPreset(page: Page): Promise<void> {
  await expect(circuitSummary(page)).toContainText(
    'Qubits: 2. Columns: 2. Operations: 2.'
  )
  await expect(cellAt(page, 0, 0)).toHaveAccessibleName('H')
  await expect(cellAt(page, 0, 1)).toHaveAccessibleName('CNOT control')
  await expect(cellAt(page, 1, 1)).toHaveAccessibleName(
    'CNOT target controlled by q0'
  )
  await expect(page.locator('.qsim-operations .qsim-op')).toHaveCount(2)
}

test.describe('Sharing a circuit through the URL', () => {
  test('travels to a fresh browser session intact', async ({
    page,
    browser,
  }) => {
    await openEditor(page)
    await presetButton(page, 'Bell').click()
    await expectBellPreset(page)

    // The address bar catches up after the debounce, and the field beside the
    // copy button is built from the circuit rather than from the URL — so both
    // are checked, and they have to agree.
    await expect.poll(() => page.url()).toContain('?c=')
    const link = await shareField(page).inputValue()
    expect(link).toBe(page.url())

    // A brand new context: its own storage, its own session. This is the
    // "private window" of the work plan's acceptance test, and the only thing
    // it shares with the page above is the string.
    const stranger = await browser.newContext()
    const opened = await stranger.newPage()
    await opened.goto(link)
    await expect(grid(opened)).toBeVisible()

    await expectBellPreset(opened)
    await stranger.close()
  })

  test('keeps a Bell pair well inside the 120-character budget', async ({
    page,
  }) => {
    await openEditor(page)
    await presetButton(page, 'Bell').click()
    await expect.poll(() => page.url()).toContain('?c=')

    const payload = new URL(page.url()).searchParams.get('c') ?? ''
    expect(payload.length).toBeLessThan(120)
  })

  test('leaves the page when Back is pressed, however much was edited', async ({
    page,
  }) => {
    // Arrive from somewhere, so there is a previous entry to go back to.
    // The landing offers this action twice, above and below the demonstration
    // (M0.9b); either one is the same destination, so the first will do.
    await page.goto('/')
    await page.getByRole('link', { name: 'Open the editor' }).first().click()
    await expect(grid(page)).toBeVisible()

    // Four separate documents, each one written to the address bar. With
    // `pushState` this would be four history entries between the reader and
    // the door.
    for (const name of ['Bell', 'GHZ', 'Interference', 'Superposition']) {
      await presetButton(page, name).click()
      await expect.poll(() => page.url()).toContain('?c=')
    }

    await page.goBack()
    await expect(page).toHaveURL('/')
  })

  test('says so, rather than breaking, when the link is damaged', async ({
    page,
  }) => {
    await page.goto('/new?c=zzzz')
    await expect(grid(page)).toBeVisible()

    await expect(page.getByRole('alert')).toContainText('could not be unpacked')
    // The editor is still an editor: a refused payload costs the reader the
    // circuit they were sent and nothing else.
    await expect(cellAt(page, 0, 0)).toHaveAccessibleName('free')
    // And the payload is still in the address bar, so a reload retries the
    // same link instead of quietly erasing the evidence.
    expect(new URL(page.url()).searchParams.get('c')).toBe('zzzz')
  })
})
