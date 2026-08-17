import { expect, test } from '@playwright/test'

import { openSharedCircuit } from './support/collab'

/**
 * The shared session, in a real browser, on the address a person types.
 *
 * The unit suites prove each layer and `src/routes/editor.test.tsx` proves the
 * route mounts them. What only a browser can prove is the pair of properties this
 * milestone actually rests on, because both are about *pixels and sockets* rather
 * than about React:
 *
 *   1. **A session that cannot open leaves the editor exactly as it shipped.**
 *      With no relay behind this suite the socket really fails to connect, on a
 *      real backoff, and the page has to stay the page. That is the degradation
 *      promise, and jsdom cannot fail it convincingly — there is no connection
 *      there to lose.
 *   2. **A session that opens is visible.** The roster paints, a caret is drawn
 *      over the canvas at a real coordinate, and a watcher is told they are
 *      watching. This is the assertion that would have caught Fase 5 shipping a
 *      channel nothing opened.
 *
 * The relay is mocked frame for frame by `support/collab.ts`, which also explains
 * why: the property under test here is the mounting, and convergence between two
 * peers is proved against the real bridge in `src/verification/convergence`. The
 * next phase's two-browser proof replaces the socket half of that fixture with the
 * running API and keeps the circuit half.
 */

test('a saved circuit with no relay is the editor that shipped', async ({
  page,
}) => {
  await openSharedCircuit(page, { session: false })

  await expect(page.getByRole('grid')).toBeVisible()
  /*
   * Not one word about a session. `status: 'connecting'` is deliberately silent —
   * a reader whose editor is working does not need to be told that a feature they
   * have not used is still handshaking — and `access` stays null, so nothing is
   * read-only and nothing is disabled.
   */
  await expect(page.locator('.presence-roster')).toHaveCount(0)
  await expect(page.locator('.collab-panel__notice')).toHaveCount(0)
  /*
   * The deferral panel's *chrome* is absent; its live region is not, and that is a
   * requirement rather than an oversight. A `role="status"` inserted into the DOM
   * together with its first content is frequently never announced, so the one
   * sentence a reader most needs — "your gate was held back" — was the one
   * sentence nobody heard. So the region is mounted empty from the first render
   * and only its child changes; what must be absent here is anything it says.
   */
  await expect(page.locator('.deferred-panel__heading')).toHaveCount(0)
  await expect(page.locator('.deferred-panel__list')).toHaveCount(0)
  await expect(page.locator('.deferred-panel__status')).toHaveText('')
  await expect(page.getByRole('button', { name: 'Undo' })).toBeEnabled()
  await expect(page.getByRole('button', { name: 'Redo' })).toBeEnabled()
})

test('a watcher sees who is here and is told they may not write', async ({
  page,
}) => {
  await openSharedCircuit(page, { access: 'read' })

  const roster = page.locator('.presence-roster')
  await expect(roster).toBeVisible()
  await expect(roster).toContainText('Ana')
  // The peer that never signed in. The relay sends `null` rather than a word,
  // because the word is a user-facing string and belongs in three catalogs.
  await expect(roster).toContainText('Someone')
  await expect(roster).toContainText('watching')

  // A caret really drawn, at a real pixel, over the canvas.
  const caret = page.locator('.presence-mark--cursor').first()
  await expect(caret).toBeVisible()
  const box = await caret.boundingBox()
  expect(box?.width).toBeGreaterThan(0)

  await expect(
    page.getByText('You are watching this session. Only the owner may edit.')
  ).toBeVisible()
  await expect(page.getByRole('button', { name: 'Undo' })).toBeDisabled()
})

test('a deferred gate is named, and a writer is offered the repair', async ({
  page,
}) => {
  await openSharedCircuit(page, { access: 'write' })

  const panel = page.locator('.deferred-panel')
  await expect(panel).toBeVisible()
  // Nothing was lost, and that is the first thing it says.
  await expect(panel).toContainText('Nothing was lost')
  await expect(panel).toContainText('Another gate already holds that cell.')
  await expect(
    panel.getByRole('button', { name: 'Make room for it' })
  ).toBeVisible()

  /*
   * The repair is an ordinary edit, so pressing it changes the document and the
   * projection un-defers the gate by itself. What is asserted is the visible
   * consequence: the reason that was on screen is no longer on screen.
   */
  await panel.getByRole('button', { name: 'Make room for it' }).first().click()
  await expect(
    panel.getByText('Another gate already holds that cell.')
  ).toHaveCount(0)
})
