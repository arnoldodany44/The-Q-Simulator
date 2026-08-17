/**
 * The two surfaces a shared session adds that a person operates, from a keyboard
 * and with no pointer at all — §10, and §3.4's decision that a deferral must be
 * surfaced rather than counted.
 *
 * ═══════════════════════════════════════════════════════════════════════
 * WHAT THIS LENS CLAIMS
 *
 *   1. **A control that points from a panel to the canvas must do something
 *      perceivable without a pointer.** "Show this gate on the canvas" and "Show
 *      what is holding it" both work by *selecting* — and a ring drawn around a
 *      cell of an `aria-hidden` SVG is not feedback. Something has to be said.
 *   2. **Pressing any of these must not cost the reader their place.** A button
 *      that unmounts as a result of its own press returns focus to
 *      `document.body`, and a keyboard user is then at the top of a page with a
 *      dozen document controls before the canvas. The codebase already knows
 *      this — `CommentThreadView` uses `aria-disabled` rather than `disabled`
 *      precisely so a busy button keeps focus — so it is a rule this lens can
 *      hold every one of these controls to.
 *
 * ═══════════════════════════════════════════════════════════════════════
 * HOW A DEFERRAL IS PRODUCED
 *
 * Two writers, one cell, and a partition. Only the owner may write, so both
 * writers are contexts of the owner's identity; one has its socket proxied and
 * cut, both place a gate on (0, 0), and healing merges two claims on one cell.
 * `projectCircuit` then places one and defers the other on *both* peers, which is
 * the situation `DeferredOperations` exists for and the only honest way to reach
 * it — a hand-built entries array would test the component and not the product.
 */

import { expect, test, type Page } from '@playwright/test'

import { cellAt } from '../../../e2e/support/editor'
import { createCircuit, liveEnv } from '../../../e2e/live/support/live'
import {
  commentsSaid,
  deferredSaid,
  openPartitionablePeer,
  openPeer,
  readIdentities,
  spoken,
} from './support'

/** What has focus now, as a sentence a failure can be read from. */
async function focused(page: Page): Promise<string> {
  return page.evaluate(() => {
    const active = document.activeElement
    if (active === null) return 'nothing'
    if (active === document.body) return 'document.body'
    const label = (active.textContent ?? '').replace(/\s+/g, ' ').trim()
    return `${active.tagName.toLowerCase()}[${active.getAttribute('class') ?? ''}] ${label.slice(0, 60)}`
  })
}

test.describe('the session surfaces, from a keyboard', () => {
  test('a comment thread is operable by keyboard, and its reveal says something', async ({
    browser,
  }) => {
    const identities = readIdentities()
    const env = liveEnv()
    const circuit = await createCircuit(
      env,
      identities.owner,
      'presence-a11y comments'
    )

    const ana = await openPeer(browser, {
      storageState: identities.owner.storageState,
      path: circuit.path,
    })
    const page = ana.page

    /*
     * A gate to anchor a comment to, and it stays selected after placing.
     *
     * Placed *after* the session has had time to open, and that wait is not
     * politeness: a gate placed in the first second is removed when the join
     * seeds the document, so a thread anchored to it renders as an orphan and
     * this scenario would be measuring the wrong screen. The defect itself is
     * `presence.spec.ts`'s "a gate placed before the session opens".
     */
    await page.waitForTimeout(3_000)
    await cellAt(page, 0, 0).focus()
    await page.keyboard.press('h')
    await page.keyboard.press('Enter')
    await expect(
      page.locator('p.circuit-canvas__summary'),
      'the gate did not survive long enough to be commented on'
    ).toContainText('Operations: 1')

    /* The thread, written through the form the way a reader would. */
    const composer = page.getByLabel('New comment')
    await expect(composer).toBeVisible()
    await composer.focus()
    await page.keyboard.type('does this H belong here')
    /*
     * Tab and Enter rather than `click()`. The composer's submit is the first
     * stop after the field, and reaching it with a keypress is the difference
     * between "the button works" and "the button can be got to".
     */
    await page.keyboard.press('Tab')
    await expect(
      page.getByRole('button', { name: 'Post comment' })
    ).toBeFocused()
    await page.keyboard.press('Enter')

    const panel = page.locator('.comments-panel')
    await expect(
      panel.locator('.comment-thread'),
      'the comment was never posted'
    ).toHaveCount(1)
    // eslint-disable-next-line no-console -- what the thread claims to be about
    console.log(
      'thread header:',
      JSON.stringify(
        await panel.locator('.comment-thread__header').first().innerText()
      )
    )

    const reveal = page.getByRole('button', {
      name: 'Show this gate on the canvas',
    })
    await expect(
      reveal,
      'the thread carries no control pointing back at the canvas'
    ).toBeVisible()

    /* ── 1. the reveal, reached and pressed with the keyboard ── */
    await ana.clearTranscript()
    await reveal.focus()
    await page.keyboard.press('Enter')

    const afterReveal = commentsSaid(await ana.transcript()).map(
      (entry) => entry.text
    )
    // eslint-disable-next-line no-console -- the transcript is the evidence
    console.log('reveal said:', JSON.stringify(afterReveal, null, 1))
    expect(
      afterReveal.join(' '),
      'pressing "show this gate" said nothing, and the ring it draws is on an aria-hidden canvas'
    ).toContain('Selected the gate on q0, column 0.')
    expect(
      await focused(page),
      'the reveal button lost focus when it was pressed'
    ).toContain('Show this gate on the canvas')

    /* ── 2. resolve, from the keyboard ── */
    await ana.clearTranscript()
    const resolve = page.getByRole('button', { name: 'Resolve', exact: true })
    await resolve.focus()
    await page.keyboard.press('Enter')

    /*
     * The listing reloads. A fixed settle rather than a wait on one outcome,
     * because both outcomes are interesting: the thread may stay with its control
     * flipped to `Reopen`, or it may leave the listing and take the pressed button
     * with it. What the scenario asserts is the part that is a defect either way —
     * whether the press was said out loud, and where the reader is afterwards.
     */
    await page.waitForTimeout(8_000)
    const afterResolve = commentsSaid(await ana.transcript()).map(
      (entry) => entry.text
    )
    const focusAfterResolve = await focused(page)
    // eslint-disable-next-line no-console -- every reading here is the evidence
    console.log(
      'resolve:',
      JSON.stringify(
        {
          said: afterResolve,
          focus: focusAfterResolve,
          threads: await page.locator('.comment-thread').count(),
          badge: await page.locator('.comment-thread__badge').count(),
          // Whether the request that the region already claimed had succeeded
          // actually failed, which is the difference between latency and a lie.
          alerts: await page.locator('[role=alert]').allInnerTexts(),
          panel: (await panel.innerText()).replace(/\s+/g, ' ').slice(0, 400),
        },
        null,
        1
      )
    )
    expect(afterResolve.join(' '), 'resolving a thread said nothing').toContain(
      'Thread resolved.'
    )
    expect(
      focusAfterResolve,
      'resolving a thread sent focus to the body, a dozen document controls above where the reader was'
    ).not.toBe('document.body')

    await ana.context.close()
  })

  test('a deferred operation is announced, keyboard operable, and does not drop focus', async ({
    browser,
  }) => {
    const identities = readIdentities()
    const env = liveEnv()
    const circuit = await createCircuit(
      env,
      identities.owner,
      'presence-a11y deferral'
    )

    const online = await openPeer(browser, {
      storageState: identities.owner.storageState,
      path: circuit.path,
    })
    const partitioned = await openPartitionablePeer(browser, {
      storageState: identities.owner.storageState,
      path: circuit.path,
    })

    // Both peers must be in the session before either is cut, or the cut one
    // never had a session to be partitioned from.
    await expect(online.page.locator('.presence-roster__peer')).toHaveCount(1)

    await partitioned.cut()

    // The same cell, from both sides of the partition. Different gates so the
    // panel's own description says which one was held back.
    await cellAt(partitioned.page, 0, 0).focus()
    await partitioned.page.keyboard.press('h')
    await partitioned.page.keyboard.press('Enter')

    await cellAt(online.page, 0, 0).focus()
    await online.page.keyboard.press('x')
    await online.page.keyboard.press('Enter')

    await partitioned.clearTranscript()
    await partitioned.heal()

    const panel = partitioned.page.locator('.deferred-panel')
    await expect(
      panel,
      'two writers contested one cell and no deferral was surfaced on either screen'
    ).toBeVisible()

    const said = deferredSaid(await partitioned.transcript())
    // eslint-disable-next-line no-console -- the transcript is the evidence
    console.log('deferral region:', JSON.stringify(said, null, 1))
    /*
     * `spoken` and not the whole transcript: an entry marked `born` is a region
     * that entered the DOM already holding its sentence, which is the case
     * `PresenceRoster`'s own header calls "frequently not announced at all". If
     * the only entry here is `born`, the panel appeared and the reader whose gate
     * was held back was told nothing.
     */
    expect
      .soft(
        spoken(said).length,
        'the deferral panel and its live region mounted together, so the sentence that says a gate was held back is never announced'
      )
      .toBeGreaterThan(0)

    /* ── the reveal, from the keyboard ── */
    const reveal = partitioned.page.getByRole('button', {
      name: 'Show what is holding it',
    })
    await expect(reveal).toBeVisible()
    await partitioned.clearTranscript()
    await reveal.focus()
    await partitioned.page.keyboard.press('Enter')

    const afterReveal = deferredSaid(await partitioned.transcript()).map(
      (entry) => entry.text
    )
    // eslint-disable-next-line no-console -- the transcript is the evidence
    console.log('deferral reveal said:', JSON.stringify(afterReveal, null, 1))
    expect(
      afterReveal.join(' '),
      'pressing "show what is holding it" said nothing perceivable without a pointer'
    ).toContain('Selected')
    expect(
      await focused(partitioned.page),
      'the reveal button lost focus when it was pressed'
    ).toContain('Show what is holding it')

    /* ── the repair, from the keyboard ── */
    const repair = partitioned.page
      .getByRole('button', { name: 'Make room for it' })
      .or(partitioned.page.getByRole('button', { name: 'Widen the register' }))
    await expect(
      repair,
      'no repair was offered to the author of the held-back gate'
    ).toBeVisible()
    await partitioned.clearTranscript()
    await repair.focus()
    await partitioned.page.keyboard.press('Enter')

    const afterRepair = deferredSaid(await partitioned.transcript()).map(
      (entry) => entry.text
    )
    const focusAfterRepair = await focused(partitioned.page)
    // eslint-disable-next-line no-console -- both readings are the evidence
    console.log(
      'repair:',
      JSON.stringify({ said: afterRepair, focus: focusAfterRepair }, null, 1)
    )
    expect(
      afterRepair.join(' '),
      'the repair said nothing about what it did'
    ).not.toBe('')
    /*
     * The claim: a successful repair empties the list, the row unmounts, and the
     * button the reader was standing on goes with it. The component keeps the
     * region alive for exactly this reason — so the sentence is heard — but says
     * nothing about where the reader now is.
     */
    expect(
      focusAfterRepair,
      'the repair button unmounted under the reader: focus is on the body, a dozen document controls above the canvas'
    ).not.toBe('document.body')

    await partitioned.context.close()
    await online.context.close()
  })
})
