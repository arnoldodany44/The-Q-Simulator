/**
 * Presence, read out loud — an independent reading of §3.4 and §10.
 *
 * ═══════════════════════════════════════════════════════════════════════
 * WHAT THIS LENS CLAIMS, DERIVED BEFORE READING THE IMPLEMENTATION
 *
 * A caret drawn on an `aria-hidden` canvas reaches nobody. So for presence to be
 * a feature rather than a decoration, four things have to be true of a page a
 * real browser has rendered:
 *
 *   1. **The roster is in the accessibility tree.** Not in the DOM — in the tree
 *      Chromium hands the platform. This is the exact claim the previous run got
 *      wrong: everything was written, tested and unreachable, and reading the
 *      source could not tell the difference.
 *   2. **Arrivals, departures and edits are announced.** Those three and not
 *      motion, because motion is dozens of frames a second.
 *   3. **A drag does not chatter.** One continuous gesture is one piece of news.
 *      A region that repeats the same sentence while somebody holds a slider is
 *      a region a listener turns off, after which none of the rest of this works.
 *   4. **Two departures at once are two departures announced.** One dropped
 *      network takes several peers with it, and a listener told about one of them
 *      is a listener who believes somebody is still in the document.
 *
 * ═══════════════════════════════════════════════════════════════════════
 * HOW IT IS MEASURED
 *
 * `support.ts` installs a `MutationObserver` before the app boots and records
 * one entry per observer callback per live region. That is the granularity the
 * browser reports to the platform accessibility API, so the record is a
 * transcript of what would be spoken, in order, with timestamps. Counting is the
 * assertion; the words are checked too, but the words were never the risk.
 *
 * Two contexts of the *owner's* identity are how a second writer is obtained:
 * `canEditCircuit` grants write to the owner and nobody else today, and two
 * contexts are two sockets, two Y.Docs and two peer ids, which is everything
 * presence is about. The watcher is a second account, and is what puts a
 * read-only peer in somebody else's roster.
 */

import { expect, test } from '@playwright/test'

import { cellAt, circuitSummary } from '../../../e2e/support/editor'
import { createCircuit, liveEnv } from '../../../e2e/live/support/live'
import {
  axLiveRegions,
  axTree,
  openPeer,
  readIdentities,
  rosterSaid,
  type Peer,
} from './support'

/** The sentences the catalog promises, spelled here so a change is visible. */
const SAID = {
  joined: (name: string) => `${name} is now in this circuit.`,
  left: (name: string) => `${name} has left this circuit.`,
  editedAt: (name: string, qubit: number, column: number) =>
    `${name} edited at qubit ${qubit}, column ${column}.`,
} as const

/**
 * A gate placed with the keyboard, from a focused grid.
 *
 * `focus()` on the cursor cell rather than tabbing in: the saved-circuit route
 * carries a dozen document controls before the grid, and a lens about
 * announcements should not fail because the page grew a button. The keyboard
 * paths that *are* the claim are driven by real `Tab` presses in
 * `keyboard.spec.ts`.
 */
async function placeGate(peer: Peer, key: string, cell: [number, number]) {
  const target = cellAt(peer.page, cell[0], cell[1])
  await target.focus()
  await peer.page.keyboard.press(key)
  await peer.page.keyboard.press('Enter')
}

test.describe('presence, for somebody who cannot see it', () => {
  test('the roster and its live region are in a real accessibility tree, and an arrival is announced', async ({
    browser,
  }) => {
    const identities = readIdentities()
    const env = liveEnv()
    const circuit = await createCircuit(
      env,
      identities.owner,
      'presence-a11y roster'
    )

    const ana = await openPeer(browser, {
      storageState: identities.owner.storageState,
      path: circuit.path,
    })
    // A solo editor first: the region has to exist *before* it has something to
    // say, or the first announcement lands in a node that was inserted with it
    // and is frequently not spoken at all.
    const region = ana.page.locator('.collab-panel > p[role="status"]')
    await expect(
      region,
      'the live region must be mounted before there is anybody to announce'
    ).toBeAttached()
    await expect(region).toHaveText('')

    await ana.clearTranscript()

    const beto = await openPeer(browser, {
      storageState: identities.watcher.storageState,
      path: circuit.path,
    })

    /* ── 1. the roster is drawn, and says who and what in words ── */
    const peer = ana.page.locator('.presence-roster__peer')
    await expect(peer).toHaveCount(1)
    await expect(peer).toContainText('Beto')
    await expect(
      peer,
      'a watcher must be described in words, not only by a ring instead of a disc'
    ).toContainText('watching')

    /*
     * ── 2. it is in the tree Chromium hands the platform ──
     *
     * The name is looked for on *any* unignored node rather than on the
     * `listitem`: a list item is not one of the roles that take their name from
     * their contents, so the words live in its `StaticText` children. What the
     * assertion is about is whether they are reachable at all — a roster inside
     * an `aria-hidden` subtree, or under a `display: none`, is in the DOM and
     * nowhere in this tree, which is exactly the mistake source-reading makes.
     */
    const tree = await axTree(ana.page)
    expect(
      tree.some((node) => !node.ignored && node.name.includes('Beto')),
      'nothing in the accessibility tree names Beto'
    ).toBe(true)
    expect(
      tree.some((node) => !node.ignored && node.role === 'listitem'),
      'the roster list item is not in the accessibility tree'
    ).toBe(true)
    const regions = axLiveRegions(tree)
    // eslint-disable-next-line no-console -- the tree is the evidence
    console.log('live regions in the tree:', JSON.stringify(regions, null, 1))
    expect(
      regions.some((entry) => entry.text.includes(SAID.joined('Beto'))),
      'the arrival is not the accessible content of any live region'
    ).toBe(true)

    /* ── 3. the arrival was announced, once ── */
    const said = rosterSaid(await ana.transcript())
    expect(
      said.map((entry) => entry.text),
      'the arrival was not announced by the roster region'
    ).toContain(SAID.joined('Beto'))
    expect(
      said.filter((entry) => entry.text === SAID.joined('Beto')).length,
      'one arrival must be one utterance'
    ).toBe(1)

    await beto.context.close()
    await ana.context.close()
  })

  test('an edit is announced, and holding a slider does not repeat it', async ({
    browser,
  }) => {
    const identities = readIdentities()
    const env = liveEnv()
    const circuit = await createCircuit(
      env,
      identities.owner,
      'presence-a11y chatter'
    )

    const listener = await openPeer(browser, {
      storageState: identities.owner.storageState,
      path: circuit.path,
    })
    const editor = await openPeer(browser, {
      storageState: identities.owner.storageState,
      path: circuit.path,
    })
    await expect(listener.page.locator('.presence-roster__peer')).toHaveCount(1)

    /* ── an edit, announced with its place ── */
    await listener.clearTranscript()
    await placeGate(editor, '6', [0, 0])

    // The gate itself reaching the other document is the transport's claim, and
    // it is what makes the rest of this scenario about announcements rather than
    // about delivery.
    await expect
      .poll(
        async () =>
          listener.page.locator('.presence-roster__peer').first().innerText(),
        { message: 'the peer never showed up as editing' }
      )
      .toContain('editing')

    const roster = await listener.page
      .locator('.presence-roster__peer')
      .first()
      .innerText()
    const afterPlacing = rosterSaid(await listener.transcript()).map(
      (entry) => entry.text
    )
    // eslint-disable-next-line no-console -- the two readings are the finding
    console.log(
      'after a gate was placed at (0,0):',
      JSON.stringify({ roster, said: afterPlacing }, null, 1)
    )

    /*
     * `presence.ts` states the requirement itself: "An edit is reported *with its
     * place* when the peer had a cursor, because that is the sentence a listener
     * can act on — 'somebody changed something somewhere' is an interruption that
     * costs attention and returns nothing." Soft, so the chatter measurement
     * below still runs and this scenario reports both facts at once.
     */
    expect
      .soft(
        afterPlacing,
        'the edit was announced without the cell it happened in'
      )
      .toContain(SAID.editedAt('Ana', 0, 0))
    expect
      .soft(
        roster,
        'the roster claims a peer who just placed a gate is nowhere'
      )
      .toContain('at qubit 0, column 0')

    /* ── the slider: one gesture, held ── */
    await listener.clearTranscript()

    const slider = editor.page.getByRole('slider', { name: 'Angle slider' })
    await expect(
      slider,
      'no angle slider — the Rz was not placed or not selected'
    ).toBeVisible()

    // eslint-disable-next-line no-console -- rules out a disabled control
    console.log(
      'slider disabled attribute:',
      JSON.stringify(await slider.getAttribute('disabled'))
    )

    /*
     * The gesture, driven from the keyboard.
     *
     * A keyboard sweep rather than a pointer drag, for two reasons and neither is
     * convenience. It is the gesture *this lens* is about — somebody who cannot
     * see the canvas is the person most likely to be changing an angle with the
     * arrow keys — and it commits on exactly the same path a drag does: one
     * `input` event per press, one store commit, one Y.Doc update, one increment
     * of the count that travels in the presence frame. Forty presses over six
     * seconds is the same order of magnitude as the eight-a-second the design
     * says it rations.
     */
    const before = await slider.getAttribute('aria-valuetext')
    await slider.focus()
    const started = Date.now()
    for (let step = 0; step < 40; step += 1) {
      await editor.page.keyboard.press('ArrowRight')
      await editor.page.waitForTimeout(150)
    }
    const heldMs = Date.now() - started
    const after = await slider.getAttribute('aria-valuetext')

    // A beat for the last throttled frame to arrive and be rendered.
    await listener.page.waitForTimeout(1_500)

    const during = rosterSaid(await listener.transcript())
    const utterances = during.map((entry) => entry.text)
    // eslint-disable-next-line no-console -- the measurement is the finding
    console.log(
      `slider held ${heldMs} ms, angle ${String(before)} → ${String(after)}: ${String(utterances.length)} roster utterances`,
      JSON.stringify(utterances, null, 1)
    )
    /*
     * Proof the gesture happened, without which "no chatter" would be a
     * measurement of nothing at all — the single most likely way this scenario
     * could report a pass it had not earned.
     */
    expect(
      after,
      'the drag did not move the angle, so nothing was measured'
    ).not.toBe(before)

    /*
     * The claim, stated as a rate a listener can live with. One continuous
     * gesture is one piece of news; three sentences would already be a listener
     * being told the same thing again while they try to read something else.
     */
    expect
      .soft(
        utterances.length,
        `holding one slider for ${String(heldMs)} ms produced ${String(utterances.length)} announcements`
      )
      .toBeLessThanOrEqual(2)

    /*
     * ── THE CONTROL ────────────────────────────────────────────────────────
     *
     * Eight deliberate gate placements, roughly 400 ms apart. This is the
     * measurement that makes the slider result mean something: if a burst of
     * *separate* edits produces several announcements, then edits do reach the
     * region and the drag was rationed rather than lost; if it produces none, the
     * instrument or the path is broken and no conclusion about chatter is
     * available at all.
     */
    await listener.clearTranscript()
    const burstStarted = Date.now()
    for (let column = 1; column <= 8; column += 1) {
      await placeGate(editor, 'x', [1, column])
      await editor.page.waitForTimeout(400)
    }
    await listener.page.waitForTimeout(1_500)
    const burst = rosterSaid(await listener.transcript()).map(
      (entry) => entry.text
    )
    // eslint-disable-next-line no-console -- the control is part of the finding
    console.log(
      `eight edits over ${String(Date.now() - burstStarted)} ms: ${String(burst.length)} roster utterances`,
      JSON.stringify(burst, null, 1)
    )
    expect(
      burst.length,
      'a burst of eight separate edits announced nothing at all — the edit path, not the rationing, is what this scenario measured'
    ).toBeGreaterThan(0)

    /*
     * The same peer, after *moving the grid cursor*. This is what separates
     * "presence is broken" from "the first position is lost": if a caret and a
     * place appear only once somebody moves, then the position the grid held at
     * mount was reported to a session that had not opened yet, and nothing ever
     * restated it — the heartbeat resends `local`, which is still the null it was
     * initialised with.
     */
    const cell = cellAt(editor.page, 0, 0)
    await cell.focus()
    await editor.page.keyboard.press('ArrowRight')
    await expect
      .poll(
        async () =>
          listener.page.locator('.presence-roster__peer').first().innerText(),
        { message: 'a cursor movement did not reach the other browser either' }
      )
      .toContain('at qubit 0, column 1')

    await editor.context.close()
    await listener.context.close()
  })

  test('two peers leaving at the same moment are both announced', async ({
    browser,
  }) => {
    const identities = readIdentities()
    const env = liveEnv()
    const circuit = await createCircuit(
      env,
      identities.owner,
      'presence-a11y departures'
    )

    const listener = await openPeer(browser, {
      storageState: identities.owner.storageState,
      path: circuit.path,
    })
    const second = await openPeer(browser, {
      storageState: identities.owner.storageState,
      path: circuit.path,
    })
    const beto = await openPeer(browser, {
      storageState: identities.watcher.storageState,
      path: circuit.path,
    })

    await expect(listener.page.locator('.presence-roster__peer')).toHaveCount(2)
    await listener.clearTranscript()

    // One dropped network, as two tabs going away in the same instant.
    await Promise.all([second.context.close(), beto.context.close()])

    await expect(listener.page.locator('.presence-roster__peer')).toHaveCount(0)
    await listener.page.waitForTimeout(500)

    const said = rosterSaid(await listener.transcript())
    // eslint-disable-next-line no-console -- the transcript is the finding
    console.log(
      'departures transcript:',
      JSON.stringify(
        said.map((entry) => ({ at: entry.at, text: entry.text })),
        null,
        1
      )
    )

    /*
     * The test is not "both sentences appeared somewhere in the transcript" —
     * that is trivially true of two successive single-slot replacements. It is
     * that **some utterance carried the second departure while the first was
     * still in the region**, because a polite region that is replaced twice in
     * a few milliseconds is read once, and the reading is the last content.
     */
    const both = said.filter(
      (entry) =>
        entry.text.includes(SAID.left('Ana')) &&
        entry.text.includes(SAID.left('Beto'))
    )
    const finalUtterance = said.at(-1)?.text ?? ''
    expect(
      both.length > 0 ||
        (finalUtterance.includes('Ana') && finalUtterance.includes('Beto')),
      `neither departure utterance named both peers; the last thing said was ${JSON.stringify(finalUtterance)}`
    ).toBe(true)

    await listener.context.close()
  })

  /**
   * The one thing on this page that is worse than not being told: being told the
   * opposite.
   *
   * A gate placed in the first second after the editor paints is *removed* when
   * the session opens — the join seeds the document from what the server holds,
   * and the store is rewritten from the projection. Sighted or not, that is lost
   * work; for a reader who cannot see the canvas it is lost work they were
   * explicitly told they had done, because the editor's own status line announced
   * the placement and nothing announces the removal. The circuit summary, which
   * *is* the accessible reading of the canvas, silently goes back to zero.
   */
  test('a gate placed before the session opens survives, or its removal is announced', async ({
    browser,
  }) => {
    const identities = readIdentities()
    const env = liveEnv()
    const circuit = await createCircuit(
      env,
      identities.owner,
      'presence-a11y seeding'
    )

    const ana = await openPeer(browser, {
      storageState: identities.owner.storageState,
      path: circuit.path,
    })

    // The instant the grid is there, which is the instant a reader can act.
    await cellAt(ana.page, 0, 0).focus()
    await ana.page.keyboard.press('h')
    await ana.page.keyboard.press('Enter')

    const summary = circuitSummary(ana.page)
    await expect(
      summary,
      'the keystrokes did not place a gate at all'
    ).toContainText('Operations: 1')

    const readings: string[] = []
    for (let tick = 0; tick < 16; tick += 1) {
      await ana.page.waitForTimeout(500)
      readings.push(
        `${String((tick + 1) * 500)}ms ${(await summary.innerText()).replace(/\s+/g, ' ').replace(/^.*Qubits/, 'Qubits')}`
      )
    }
    const transcript = await ana.transcript()
    // eslint-disable-next-line no-console -- both readings are the finding
    console.log(
      'the summary over eight seconds:\n',
      readings.join('\n '),
      '\nlive regions in that window:',
      JSON.stringify(
        transcript.map((entry) => ({ at: entry.at, text: entry.text })),
        null,
        1
      )
    )

    await expect(
      summary,
      'the gate this reader placed was removed when the session opened'
    ).toContainText('Operations: 1')

    await ana.context.close()
  })

  test('two collaborators are told apart without colour', async ({
    browser,
  }) => {
    const identities = readIdentities()
    const env = liveEnv()
    const circuit = await createCircuit(
      env,
      identities.owner,
      'presence-a11y identity'
    )

    const listener = await openPeer(browser, {
      storageState: identities.owner.storageState,
      path: circuit.path,
    })
    /*
     * Two peers with the same display name. Not a contrivance: `displayName` is
     * `user_metadata.full_name` and is not unique, and one person in two tabs is
     * the commonest way this arises. It is also the only way to get two *writers*
     * today, so it is the arrangement §3.4's own scenario produces.
     */
    const one = await openPeer(browser, {
      storageState: identities.owner.storageState,
      path: circuit.path,
    })
    const two = await openPeer(browser, {
      storageState: identities.owner.storageState,
      path: circuit.path,
    })
    void one
    void two

    const peers = listener.page.locator('.presence-roster__peer')
    await expect(peers).toHaveCount(2)

    // The swatch is `aria-hidden`, so its hue is not a fact a listener has.
    await expect(
      listener.page.locator('.presence-roster__swatch[aria-hidden="true"]')
    ).toHaveCount(2)

    const texts = await peers.allInnerTexts()
    // eslint-disable-next-line no-console -- the two readings are the finding
    console.log('roster entries:', JSON.stringify(texts, null, 1))

    expect(
      new Set(texts.map((text) => text.replace(/\s+/g, ' ').trim())).size,
      `two collaborators read identically: ${JSON.stringify(texts)} — the only thing separating them is a hue on an aria-hidden swatch`
    ).toBe(2)

    await two.context.close()
    await one.context.close()
    await listener.context.close()
  })
})
