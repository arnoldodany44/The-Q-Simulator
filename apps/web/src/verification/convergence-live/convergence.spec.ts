/**
 * Convergence through the real transport — the network in between, not two
 * Y.Docs in one process.
 *
 * ═══════════════════════════════════════════════════════════════════════
 * WHAT IS BEING CLAIMED, AND WHY THE DOM IS WHERE IT IS CHECKED
 *
 * §3.4 promises that two people editing one circuit end up looking at the same
 * circuit, and §6 says how: the document keeps everything, every peer computes
 * the same projection from it, and whatever the projection cannot place is
 * *deferred* rather than dropped. `src/verification/convergence` proves that
 * algebra with the documents in hand, in one process. It cannot see a socket, a
 * relay, an authorisation, two event loops, or a browser that was offline for
 * four seconds.
 *
 * So every assertion here reads the **rendered grid** of two or three real
 * browsers and compares those readings. Equality of what the two people see is
 * the claim; equality of two documents is a weaker statement that can hold while
 * one of the two screens is wrong.
 *
 * ═══════════════════════════════════════════════════════════════════════
 * THE SITUATIONS, AND WHY EACH ONE IS HERE
 *
 *   1. **One cell, two writers.** The scenario the whole design turns on. Twice:
 *      simultaneously, and — because "simultaneously" on one machine often is
 *      not — with one peer genuinely partitioned, which is the only way to make
 *      two concurrent claims on one cell certain rather than likely.
 *   2. **Offline, then back.** The half a mock cannot reach: `since` tells the
 *      relay what this peer lacks, the relay's `vector` tells this peer what the
 *      session lacks, and both directions have to close or somebody's work lives
 *      in one tab forever.
 *   3. **A reload in the middle of somebody else's edit.** A reloaded peer paints
 *      the *saved* version first and adopts the session's document when the join
 *      lands, so this is where a lost update would hide.
 *   4. **Three at once**, because two peers can agree by accident — each simply
 *      echoing the other — in a way three cannot.
 *   5. **A watcher**, whose screen is a second reading of the same circuit made
 *      by a client that never writes.
 *   6. **Work carried in the address bar**, met by a session that has not seen
 *      it. §3.4's degradation path and `useCircuitUrl`'s precedence rule are both
 *      about not losing an edit, and this is where the two rules meet.
 *
 * And one promise that is not a situation: a deferred operation must be
 * **visible to the person whose gate was deferred**, and resolving it must be an
 * ordinary edit that reaches everybody. `project.ts` refuses to repair a merged
 * document precisely so that nobody does it twice, which leaves that promise as
 * the only thing owed to the reader.
 *
 * ═══════════════════════════════════════════════════════════════════════
 * A CIRCUIT PER TEST, AND WHY
 *
 * The relay keeps a document alive for minutes after its last peer leaves and
 * persists it to `CircuitSession`. A circuit shared between tests would carry
 * one test's gates into the next, and the failure would not look like
 * contamination — it would look like a convergence bug.
 */

import { expect, test } from '@playwright/test'

import {
  createCircuit,
  liveEnv,
  type LiveCircuit,
} from '../../../e2e/live/support/live'
import {
  expectJoined,
  expectSameCircuit,
  moveCursorTo,
  place,
  readCircuit,
  roster,
  type Peer,
} from '../../../e2e/live/support/peers'
import { cellAt, circuitSummary, grid } from '../../../e2e/support/editor'
import {
  cellName,
  closeAll,
  deferredPanel,
  openPartitionablePeer,
  openPeer,
  readIdentities,
  settledUrl,
  type PartitionablePeer,
  type Who,
} from './support'

/** Opens one more browser in this test's circuit. Closed for you. */
type Open = (who: Who, label: string) => Promise<Peer>

/** The same, through a proxy this test can cut — see `openPartitionablePeer`. */
type OpenCuttable = (who: Who, label: string) => Promise<PartitionablePeer>

const live = test.extend<{
  circuit: LiveCircuit
  opened: Peer[]
  open: Open
  openCuttable: OpenCuttable
}>({
  /*
   * `provide` rather than Playwright's documented `use`, and the parameter's name
   * is this file's to choose while its position is Playwright's: `react-hooks`
   * reads any call to a function named `use` as a React hook, and a fixture is not
   * a component. The sibling suite in `e2e/live` renames it for the same reason.
   *
   * The `{}` is Playwright's contract too — it reads a fixture's dependencies out
   * of the first parameter's destructuring pattern and refuses a plain one — so a
   * fixture that depends on nothing has to be spelled with an empty pattern.
   */
  // eslint-disable-next-line no-empty-pattern
  circuit: async ({}, provide, testInfo) => {
    const env = liveEnv()
    const identities = readIdentities()
    // The test's own title, so a row left behind by a crash says which test
    // left it. The slice is a bound, not a fit.
    const circuit = await createCircuit(
      env,
      identities.owner,
      `convergence-live: ${testInfo.title}`.slice(0, 90),
      3
    )
    await provide(circuit)
    /*
     * Nothing to delete here. Every circuit, version and `CircuitSession` row
     * cascades from its owner, and the teardown project removes both accounts
     * through the product's own `DELETE /api/v1/me` — which is the only path
     * that takes the session rows with them.
     */
  },

  /**
   * Every context a test opened, closed after it.
   *
   * A fixture of its own so that the two ways of opening a peer share one list:
   * Playwright tears a fixture down after everything that depends on it, so this
   * runs last whichever of the two a test used.
   */
  // eslint-disable-next-line no-empty-pattern
  opened: async ({}, provide) => {
    const peers: Peer[] = []
    await provide(peers)
    await closeAll(peers)
  },

  open: async ({ browser, circuit, opened }, provide) => {
    const identities = readIdentities()
    await provide(async (who, label) => {
      const peer = await openPeer(browser, identities[who], circuit, label)
      opened.push(peer)
      return peer
    })
  },

  openCuttable: async ({ browser, circuit, opened }, provide) => {
    const identities = readIdentities()
    await provide(async (who, label) => {
      const partitionable = await openPartitionablePeer(
        browser,
        identities[who],
        circuit,
        label
      )
      opened.push(partitionable.peer)
      return partitionable
    })
  },
})

/** The reason the panel gives for a contested cell, in English. */
const CONTESTED = 'Another gate already holds that cell.'

/* ══════════════════════════════════════════════════════════════════════ *
 * 1. One cell, two writers, at the same instant
 * ══════════════════════════════════════════════════════════════════════ */

live(
  'two writers reaching for one cell at once end on one circuit',
  async ({ open }) => {
    const a = await open('owner', 'writer-a')
    const b = await open('owner', 'writer-b')
    await expectJoined(a, b)

    // Aimed and armed before either commits, so the two Enters are as close to
    // simultaneous as two browsers can be made.
    await moveCursorTo(a.page, 0, 0)
    await moveCursorTo(b.page, 0, 0)
    await Promise.all([place(a.page, 'h'), place(b.page, 'x')])

    await expectSameCircuit(a, b)

    /*
     * One gate holds the cell, and it is the same one on both screens. NOT "H
     * wins": which claim is older depends on which frame the relay integrated
     * first, and pinning it would be asserting a race. What the design promises
     * is agreement, and that the projection never draws two gates in one cell.
     */
    const [here, there] = await Promise.all([
      cellName(a.page, 0, 0),
      cellName(b.page, 0, 0),
    ])
    expect(there, 'the two writers disagree about the contested cell').toBe(
      here
    )
    expect(here, 'the contested cell shows neither gate').toMatch(/H|X/)
  }
)

/* ══════════════════════════════════════════════════════════════════════ *
 * 2. One cell, two writers, one of them partitioned — and the deferral
 * ══════════════════════════════════════════════════════════════════════ */

live(
  'a partitioned writer’s contested gate is deferred, named to its author, and resolved by an ordinary edit',
  async ({ open, openCuttable }) => {
    const a = await open('owner', 'writer-a')
    const cuttable = await openCuttable('owner', 'writer-b')
    const b = cuttable.peer
    await expectJoined(a, b)

    /*
     * The partition is what makes the two claims certainly concurrent. With both
     * peers online the editor usually refuses the second placement locally — the
     * cell is already occupied by the update that arrived — which satisfies every
     * convergence assertion while never producing the merge §6 is about.
     */
    await cuttable.cut()
    await moveCursorTo(b.page, 0, 0)
    await place(b.page, 'x')
    await moveCursorTo(a.page, 0, 0)
    await place(a.page, 'h')

    // Each holds its own gate while they are apart. Stated so that a failure
    // after the reunion cannot be blamed on a placement that never happened.
    expect(await cellName(b.page, 0, 0)).toMatch(/X/)
    expect(await cellName(a.page, 0, 0)).toMatch(/H/)

    await cuttable.heal()

    // Both screens, one circuit.
    await expectSameCircuit(a, b)
    const winner = await cellName(a.page, 0, 0)
    expect(
      await cellName(b.page, 0, 0),
      'the reunited peers disagree about the contested cell'
    ).toBe(winner)
    expect(winner, 'the contested cell shows neither gate').toMatch(/H|X/)

    /*
     * The gate that lost is *named*, on both screens, from the same projection —
     * and in particular on the screen of the person who placed it. That is the
     * one thing `project.ts` says is owed to a reader once it has decided not to
     * repair the document.
     */
    const held = winner.includes('H') ? 'X' : 'H'
    const author = held === 'X' ? b : a
    for (const peer of [a, b]) {
      const entry = deferredPanel(peer.page).locator('.deferred-panel__what')
      await expect(
        entry,
        `${peer.label} does not say which operation is held back`
      ).toContainText('wanted qubit 0, column 0')
      await expect(
        entry,
        `${peer.label} does not name the gate that was held back`
      ).toContainText(held)
      await expect(
        deferredPanel(peer.page),
        `${peer.label} does not say why it is held back`
      ).toContainText(CONTESTED)
    }

    /*
     * An unrelated edit must not take the held operation with it. The store only
     * ever holds the *projected* circuit, so a write derived from it could
     * plausibly delete the slot nothing placed — `writeCircuit` deletes only what
     * the baseline placed and the circuit no longer has, which is the line
     * between a conflict and data loss caused by handling one.
     */
    await moveCursorTo(a.page, 2, 2)
    await place(a.page, 'z')
    await expect(cellAt(b.page, 2, 2)).toHaveAccessibleName('Z')
    for (const peer of [a, b]) {
      await expect(
        deferredPanel(peer.page).locator('.deferred-panel__what'),
        `${peer.label} lost the held operation when an unrelated edit was made`
      ).toContainText('wanted qubit 0, column 0')
    }

    /*
     * And resolving it is an ordinary edit: `deferredResolution.ts` moves the
     * blocker through the *store*, so it is validated, undoable and broadcast
     * exactly like a drag. Pressed by the author of the deferred gate, which is
     * the person who would press it.
     */
    await author.page
      .getByRole('button', { name: 'Make room for it' })
      .first()
      .click()

    /*
     * Both gates, on both screens: the one that was held back takes the cell it
     * wanted and the blocker has moved one column right. Compared as whole
     * canvases too — an ordinary edit that reached only its author would satisfy
     * the cell assertions on that author's page alone.
     */
    for (const peer of [a, b]) {
      await expect(
        cellAt(peer.page, 0, 0),
        `${peer.label} does not show the released gate in the cell it wanted`
      ).toHaveAccessibleName(held)
      await expect(
        cellAt(peer.page, 0, 1),
        `${peer.label} does not show the blocker one column right`
      ).toHaveAccessibleName(held === 'X' ? 'H' : 'X')
    }
    await expectSameCircuit(a, b)

    // And nothing is held back any more, on either screen.
    for (const peer of [a, b]) {
      await expect(
        deferredPanel(peer.page).filter({ hasText: 'wanted qubit' }),
        `${peer.label} still reports an operation as held back`
      ).toHaveCount(0)
    }
  }
)

/* ══════════════════════════════════════════════════════════════════════ *
 * 3. Offline, then back: the reconciliation has to close both ways
 * ══════════════════════════════════════════════════════════════════════ */

live(
  'a peer that edited while offline sends and receives when it returns',
  async ({ open, openCuttable }) => {
    const a = await open('owner', 'online')
    const cuttable = await openCuttable('owner', 'partitioned')
    const b = cuttable.peer
    await expectJoined(a, b)

    await cuttable.cut()

    // One edit on each side of the partition, in cells that do not contest, so
    // that the only thing this test can fail on is a lost update.
    await moveCursorTo(b.page, 1, 1)
    await place(b.page, 'x')
    await moveCursorTo(a.page, 0, 0)
    await place(a.page, 'h')

    // Neither has the other's, which is what makes the reunion meaningful.
    expect(await cellName(b.page, 0, 0)).not.toMatch(/H/)
    expect(await cellName(a.page, 1, 1)).not.toMatch(/X/)

    await cuttable.heal()

    /*
     * Both directions. `since` asked the relay for what this peer lacked (the H)
     * and the relay's `vector` asked this peer for what the session lacked (the
     * X) — and the second is the one nothing else in the system would notice the
     * absence of.
     */
    await expect(
      cellAt(b.page, 0, 0),
      'the returning peer never received what happened while it was away'
    ).toHaveAccessibleName('H')
    await expect(
      cellAt(a.page, 1, 1),
      'the offline edit never reached the session'
    ).toHaveAccessibleName('X')
    await expectSameCircuit(a, b)
  }
)

/* ══════════════════════════════════════════════════════════════════════ *
 * 4. A reload in the middle of somebody else's edit
 * ══════════════════════════════════════════════════════════════════════ */

live(
  'a peer that reloads while the other edits comes back to the same circuit',
  async ({ open }) => {
    const a = await open('owner', 'editing')
    const b = await open('owner', 'reloading')
    await expectJoined(a, b)

    await moveCursorTo(a.page, 0, 0)
    await place(a.page, 'h')
    await expect(cellAt(b.page, 0, 0)).toHaveAccessibleName('H')

    /*
     * The reload and the edit overlap on purpose. A reloaded peer paints the
     * *saved* version — which for this circuit is empty — and adopts the
     * session's document only when the join lands, so this window is where a lost
     * update, or a peer republishing an empty circuit over everybody's work,
     * would hide.
     */
    const reloading = b.page.reload()
    await moveCursorTo(a.page, 1, 1)
    await place(a.page, 'x')
    await reloading
    await expect(grid(b.page)).toBeVisible()

    await expect(
      cellAt(b.page, 0, 0),
      'the reloaded peer lost the gate that was there before it reloaded'
    ).toHaveAccessibleName('H')
    await expect(
      cellAt(b.page, 1, 1),
      'the reloaded peer never received the edit made while it was reloading'
    ).toHaveAccessibleName('X')
    // And the editing peer still has both: a returning peer must not have
    // published an empty circuit over them.
    await expect(cellAt(a.page, 0, 0)).toHaveAccessibleName('H')
    await expect(cellAt(a.page, 1, 1)).toHaveAccessibleName('X')
    await expectSameCircuit(a, b)
  }
)

/* ══════════════════════════════════════════════════════════════════════ *
 * 5. Three peers at once
 * ══════════════════════════════════════════════════════════════════════ */

live('three writers editing at once end on one circuit', async ({ open }) => {
  const a = await open('owner', 'first')
  const b = await open('owner', 'second')
  const c = await open('owner', 'third')

  /*
   * Two other people in every roster, counted rather than named: all three
   * contexts hold one identity, so "the roster contains Cyra" is satisfied by one
   * entry and would let a two-peer session pass for a three-peer one.
   */
  for (const peer of [a, b, c]) {
    await expect(
      roster(peer.page).locator('li'),
      `${peer.label} never saw the other two join`
    ).toHaveCount(2, { timeout: 30_000 })
  }

  await moveCursorTo(a.page, 0, 0)
  await moveCursorTo(b.page, 1, 1)
  await moveCursorTo(c.page, 2, 2)
  await Promise.all([
    place(a.page, 'h'),
    place(b.page, 'x'),
    place(c.page, 'z'),
  ])

  for (const peer of [a, b, c]) {
    await expect(
      cellAt(peer.page, 0, 0),
      `${peer.label} is missing the first peer's gate`
    ).toHaveAccessibleName('H')
    await expect(
      cellAt(peer.page, 1, 1),
      `${peer.label} is missing the second peer's gate`
    ).toHaveAccessibleName('X')
    await expect(
      cellAt(peer.page, 2, 2),
      `${peer.label} is missing the third peer's gate`
    ).toHaveAccessibleName('Z')
  }
  // Pairwise, which for three readings is the same as all three agreeing.
  await expectSameCircuit(a, b)
  await expectSameCircuit(b, c)
})

/* ══════════════════════════════════════════════════════════════════════ *
 * 6. A watcher's screen is the same circuit
 * ══════════════════════════════════════════════════════════════════════ */

live('a read-only peer sees exactly what the writer sees', async ({ open }) => {
  const a = await open('owner', 'writer')
  const watcher = await open('watcher', 'watcher')
  await expectJoined(a, watcher)

  await expect(
    watcher.page.getByText(
      'You are watching this session. Only the owner may edit.'
    ),
    'the watcher was never told it may not write'
  ).toBeVisible()

  await moveCursorTo(a.page, 0, 0)
  await place(a.page, 'h')
  await moveCursorTo(a.page, 1, 1)
  await place(a.page, 'x')

  /*
   * Cell by cell and then the summary, rather than the whole aria snapshot: a
   * read-only canvas is not drawn identically — a cell that cannot be dragged
   * carries no drag description — and a difference there would be a difference in
   * the chrome, not in the circuit.
   */
  await expect(
    cellAt(watcher.page, 0, 0),
    'the watcher does not see what the writer placed'
  ).toHaveAccessibleName('H')
  await expect(cellAt(watcher.page, 1, 1)).toHaveAccessibleName('X')
  await expect(async () => {
    const [mine, theirs] = await Promise.all([
      circuitSummary(a.page).textContent(),
      circuitSummary(watcher.page).textContent(),
    ])
    expect(theirs?.trim()).toEqual(mine?.trim())
  }).toPass({ timeout: 20_000 })
})

/* ══════════════════════════════════════════════════════════════════════ *
 * 7. Unsaved work carried in the address bar, met by a session that has
 *    never seen it
 * ══════════════════════════════════════════════════════════════════════ */

live(
  'work carried in the address bar survives the first join',
  async ({ open, openCuttable, browser }) => {
    const a = await open('owner', 'writer')
    const cuttable = await openCuttable('owner', 'partitioned')
    const b = cuttable.peer
    await expectJoined(a, b)

    await moveCursorTo(a.page, 0, 0)
    await place(a.page, 'h')
    await expect(cellAt(b.page, 0, 0)).toHaveAccessibleName('H')

    /*
     * An edit made with no way to send it. `useCircuitUrl` exists so that such an
     * edit is not lost — the circuit is mirrored into `?c=`, and that module states
     * the rule plainly: the address bar's document "always wins, including over
     * the version stored under the slug: it is the newer of the two documents, and
     * showing the older one instead is the one outcome that loses work".
     *
     * Both addresses are captured *settled*. `?c=` already carries the H that
     * arrived over the session and the mirror is debounced, so a value read the
     * moment a gate appears on the canvas is the address from before it — and the
     * assertion between the two captures is what says the second really is the
     * newer document.
     */
    const carriedBefore = await settledUrl(b.page)
    await cuttable.cut()
    await moveCursorTo(b.page, 1, 1)
    await place(b.page, 'x')
    await expect(cellAt(b.page, 1, 1)).toHaveAccessibleName('X')
    const carried = await settledUrl(b.page)
    expect(
      carried,
      'the offline edit was never carried into the address bar'
    ).not.toBe(carriedBefore)
    expect(new URL(carried).searchParams.get('c')).not.toBeNull()

    // The tab is closed while it is still offline, so the relay never learns of
    // the X and the only copy of it is in that address.
    await b.context.close()

    const identities = readIdentities()

    /*
     * ── THE CONTROL, AND IT HAS TO BE A SEPARATE TAB ────────────────────
     *
     * The same address, opened with the relay socket black-holed: the route
     * handler accepts the connection and never calls `connectToServer`, so the
     * client believes it is connected, hears nothing, and never joins. That is
     * the editor of §3.4's degradation path, and what it paints is the answer to
     * "does that address really carry the offline edit".
     *
     * It cannot be the same tab as the claim below, because the join lands in
     * under two seconds: a reading taken in one tab before the join is a race
     * against it, and a `toHaveAccessibleName` that polls for fifteen seconds
     * cannot tell "never painted" from "painted, then replaced".
     */
    const control = await browser.newContext({
      storageState: identities.owner.storageState,
    })
    try {
      const page = await control.newPage()
      await page.routeWebSocket(/\/ws$/, () => {
        // Deliberately empty: accepted, and connected to nothing.
      })
      await page.goto(carried)
      await expect(grid(page)).toBeVisible()
      // Both halves, because they fail differently: no H means the address
      // carried nothing, and H without X means it carried the session's edit and
      // not this peer's.
      await expect(
        cellAt(page, 0, 0),
        'the address bar carried no document at all'
      ).toHaveAccessibleName('H')
      await expect(
        cellAt(page, 1, 1),
        'the address bar did not carry the edit made while cut off'
      ).toHaveAccessibleName('X')
    } finally {
      await control.close()
    }

    /*
     * And now the same address with a working session, which is the ordinary way
     * a person comes back to unsaved work.
     */
    const returning = await browser.newContext({
      storageState: identities.owner.storageState,
    })
    try {
      const page = await returning.newPage()
      await page.goto(carried)
      await expect(grid(page)).toBeVisible()

      /*
       * The join has landed once this tab can see the peer that stayed: the relay
       * sends the peers it already holds in answer to a `collab:join`, so a
       * roster with somebody in it is proof that `collab:joined` was applied.
       */
      await expect(
        roster(page).locator('li'),
        'the returning tab never joined the session'
      ).toHaveCount(1, { timeout: 30_000 })

      /*
       * The claim: joining a session must not delete work the session has not
       * seen. The relay serves this circuit's document, which holds the H and has
       * never heard of the X, and the bridge adopts what it serves — so if the
       * join wins, the reader watches an edit they made disappear with nothing
       * said about it.
       */
      await expect(
        cellAt(page, 1, 1),
        `the shared session deleted work the address bar was carrying (the tab is now at ${page.url()})`
      ).toHaveAccessibleName('X')
      // And the peer that stayed should now have it, since this tab could send.
      await expect(
        cellAt(a.page, 1, 1),
        'the recovered work never reached the session'
      ).toHaveAccessibleName('X')
      expect(await readCircuit(a.page)).toEqual(await readCircuit(page))
    } finally {
      await returning.close()
    }
  }
)
