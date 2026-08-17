/**
 * Fase 5's acceptance: two browsers, one relay, one database.
 *
 * ═══════════════════════════════════════════════════════════════════════
 * WHAT THIS SUITE IS FOR
 *
 * Everything else about collaboration is proved with something standing in for
 * something: `src/features/collab/*.test.ts` drives the transport against a
 * scripted socket, `src/verification/convergence` drives two bridges against each
 * other in one process, `e2e/collaboration.spec.ts` drives the real page against
 * a mocked relay. Each is the right tool for what it proves, and none of them can
 * fail the way Fase 5 actually failed — a complete, tested feature that no user
 * action reached.
 *
 * So this suite asserts, in a real browser and against the real API: a gate
 * placed in one browser appears in another; two peers that wrote concurrently
 * agree afterwards; two peers that wrote to the *same cell* agree afterwards, on
 * whatever the projection chose; undo takes back its own author's work and
 * nobody else's; each peer sees where the others are looking; a comment follows
 * its gate on both screens; the document survives everybody leaving; and a
 * reader who may not write is refused **by the relay**.
 *
 * ═══════════════════════════════════════════════════════════════════════
 * TWO WRITERS ARE TWO BROWSERS, NOT TWO ACCOUNTS — AND THAT IS THE PRODUCT
 *
 * The brief for this suite names the two peers Ana and Beto and asks for both to
 * edit. **Two accounts cannot both write to one circuit today, by design.**
 * `canEditCircuit` (packages/db/src/visibility.ts) is `ownerId === viewerId`,
 * `routes/ws.ts` hands the socket `access: canEditCircuit(…) ? 'write' : 'read'`,
 * and there is no collaborator grant anywhere in the schema. §11 says so in as
 * many words — "a PUBLIC circuit is readable by everyone and editable by its
 * owner alone. Forking is how somebody else builds on it" — and §3.4's shared
 * cursors are specified for the owner plus watchers.
 *
 * A test asserting that Beto can write would therefore not be a red acceptance
 * test; it would be a test of a feature nobody has specified, failing on the
 * server's deliberate refusal. What *is* reachable, and is exactly the property
 * the CRDT exists for, is **one identity in two browsers**: two sockets, two peer
 * ids, two Y.Docs, two independent event loops, both granted `write`. That is a
 * real case — the same person on a laptop and a desktop, or two tabs of a
 * demonstration — and convergence cannot tell the difference between it and two
 * people, because a CRDT merges by client id and not by account.
 *
 * The two-writer scenarios below therefore run Ana twice, labelled `ana` and
 * `ana-elsewhere`, and the second account is what it can actually be: the
 * watcher, whose refusal scenario 8 proves rather than assumes. The gap is
 * reported as a product finding rather than papered over here.
 *
 * ═══════════════════════════════════════════════════════════════════════
 * ONE CIRCUIT PER TEST, AND WHY IT MATTERS MORE THAN IT LOOKS
 *
 * The relay keeps a document in memory after its last peer leaves, and persists
 * it to `CircuitSession`. A circuit shared between tests would carry the previous
 * test's gates into the next one — and the failure would not look like
 * contamination, it would look like a convergence bug. So every test owns a
 * circuit it created through the API, and the teardown project deletes the
 * account, which cascades all of them.
 */

import { expect, test } from '@playwright/test'

import { circuitSummary, toolbarButton } from '../support/editor'
import {
  createCircuit,
  liveEnv,
  passwordToken,
  readIdentities,
  type LiveCircuit,
  type LiveIdentities,
  type Who,
} from './support/live'
import {
  askRelayToWrite,
  caretFor,
  cell,
  deferredPanel,
  dragRightByKeyboard,
  expectJoined,
  expectSameCircuit,
  moveCursorTo,
  openCircuit,
  place,
  readCircuit,
  roster,
  socketUrlOf,
  type Peer,
} from './support/peers'

const env = liveEnv()

/**
 * The accounts the setup project minted.
 *
 * Read on first use rather than at import time, because Playwright *collects*
 * every spec before it runs the setup project — a module-level read would look
 * for a file that does not exist yet and fail the whole run at collection.
 */
let accounts: LiveIdentities | null = null
function identities(): LiveIdentities {
  accounts ??= readIdentities()
  return accounts
}

/** Joins this test's circuit as somebody. Every context is closed afterwards. */
type Join = (who: Who, label?: string) => Promise<Peer>

/*
 * `provide` and not `use`, which is what Playwright's own examples call it: the
 * React hooks lint rule reads any call to something named `use` as a hook call,
 * and a fixture is not a component. The name of the parameter is this file's to
 * choose; the position is Playwright's.
 */
const live = test.extend<{ circuit: LiveCircuit; join: Join }>({
  /*
   * Playwright reads a fixture's dependencies out of its first parameter's
   * destructuring pattern and refuses a plain one, so a fixture that depends on
   * nothing is spelled `{}` by contract.
   */
  // eslint-disable-next-line no-empty-pattern
  circuit: async ({}, provide, testInfo) => {
    // Named after the scenario, so a row that somehow survived a teardown would
    // say which test left it. The slice is a bound, not a fit.
    const title = testInfo.title.slice(0, 90)
    await provide(await createCircuit(env, identities().ana, title))
  },

  join: async ({ browser, circuit }, provide) => {
    const opened: Peer[] = []
    await provide(async (who, label) => {
      const peer = await openCircuit(browser, identities(), who, circuit, label)
      opened.push(peer)
      return peer
    })
    /*
     * A leaked context is a leaked socket, and a leaked socket is a peer the
     * relay holds for `PRESENCE_TIMEOUT_MS` while keeping its document alive.
     * Closing a context twice is a no-op, which is what lets scenario 7 close
     * its own peers early and still be covered here.
     */
    for (const peer of opened) await peer.context.close()
  },
})

/* ══════════════════════════════════════════════════════════════════════ *
 * 1. A gate placed in one browser arrives in the other
 * ══════════════════════════════════════════════════════════════════════ */

live(
  'a gate Ana places appears on Beto’s screen with no reload',
  async ({ join }) => {
    const ana = await join('ana')
    const beto = await join('beto')
    await expectJoined(ana, beto)

    // Nothing has been placed yet: the circuit was created empty, and both peers
    // adopted the relay's document rather than each publishing their own.
    await expect(circuitSummary(beto.page)).toContainText('Operations: 0')

    await moveCursorTo(ana.page, 0, 0)
    await place(ana.page, 'h')
    await expect(cell(ana.page, 0, 0)).toHaveAccessibleName('H')

    /*
     * The assertion this whole suite exists for. No reload, no refetch, no
     * navigation — the same page, told by a socket. If the client transport were
     * ever unmounted again, which is how Fase 5 shipped, this is the line that
     * goes red.
     */
    await expect(cell(beto.page, 0, 0)).toHaveAccessibleName('H')
    await expect(circuitSummary(beto.page)).toContainText('Operations: 1')
    await expectSameCircuit(ana, beto)
  }
)

/* ══════════════════════════════════════════════════════════════════════ *
 * 2. Concurrent edits in different cells
 * ══════════════════════════════════════════════════════════════════════ */

live(
  'two writers editing different cells at once end up with one circuit',
  async ({ join }) => {
    const ana = await join('ana')
    const elsewhere = await join('ana', 'ana-elsewhere')
    await expectJoined(ana, elsewhere)

    // Aimed and armed before either commits, so the two placements really are
    // concurrent rather than one being a response to the other.
    await moveCursorTo(ana.page, 0, 0)
    await moveCursorTo(elsewhere.page, 1, 1)
    await Promise.all([place(ana.page, 'h'), place(elsewhere.page, 'x')])

    /*
     * Both gates, on both screens, before the whole-canvas comparison. Stated
     * separately because the comparison alone cannot distinguish "both peers
     * converged on the merge" from "both peers lost the same update".
     */
    await expect(cell(ana.page, 0, 0)).toHaveAccessibleName('H')
    await expect(cell(ana.page, 1, 1)).toHaveAccessibleName('X')
    await expect(cell(elsewhere.page, 0, 0)).toHaveAccessibleName('H')
    await expect(cell(elsewhere.page, 1, 1)).toHaveAccessibleName('X')

    await expectSameCircuit(ana, elsewhere)
  }
)

/* ══════════════════════════════════════════════════════════════════════ *
 * 3. Concurrent edits in the SAME cell — the scenario the design turns on
 * ══════════════════════════════════════════════════════════════════════ */

live(
  'two writers placing a gate in the same cell agree on the outcome',
  async ({ join }) => {
    const ana = await join('ana')
    const elsewhere = await join('ana', 'ana-elsewhere')
    await expectJoined(ana, elsewhere)

    await moveCursorTo(ana.page, 0, 0)
    await moveCursorTo(elsewhere.page, 0, 0)
    // Two different gates, one cell, both Enters in the same millisecond as far as
    // either browser is concerned.
    await Promise.all([place(ana.page, 'h'), place(elsewhere.page, 'x')])

    /*
     * ── What is asserted, and what deliberately is not ──────────────────────
     *
     * NOT "H wins" and not "X wins". `projectCircuit` resolves a contested slot by
     * the older Lamport claim; which of these two that is depends on which frame
     * the relay integrated first, and a test that pinned it would be asserting a
     * race. What the design promises is the two things below:
     *
     *   - **both peers show the same thing**, and
     *   - **one gate holds the cell** — the projection never draws two.
     *
     * The third possibility, that the placements were not concurrent after all
     * (one arrived before the other was made, so the editor refused it locally as
     * an occupied cell), satisfies exactly the same two properties. That is not a
     * weaker test: whichever happened, this is the promise the reader was given.
     */
    await expectSameCircuit(ana, elsewhere)

    const contested = cell(ana.page, 0, 0)
    const label = `${(await contested.getAttribute('aria-label')) ?? ''}${
      (await contested.textContent()) ?? ''
    }`
    expect(label, 'the contested cell shows neither of the two gates').toMatch(
      /H|X/
    )

    /*
     * And if the merge kept both claims, the one that lost is *named* rather than
     * silently dropped — on both screens, from the same projection. Asserted as an
     * agreement rather than as a presence: a run in which the two placements were
     * sequenced has nothing deferred, which is a legitimate outcome of the same
     * code path, and what must never happen is one peer holding an operation back
     * while the other does not.
     */
    const [here, there] = await Promise.all([
      deferredPanel(ana.page).count(),
      deferredPanel(elsewhere.page).count(),
    ])
    expect(
      there,
      'one peer is holding an operation back and the other is not'
    ).toBe(here)
    if (here > 0) {
      const reason = 'Another gate already holds that cell.'
      await expect(deferredPanel(ana.page)).toContainText(reason)
      await expect(deferredPanel(elsewhere.page)).toContainText(reason)
    }
  }
)

/* ══════════════════════════════════════════════════════════════════════ *
 * 4. Undo takes back its own author's work and nobody else's
 * ══════════════════════════════════════════════════════════════════════ */

live(
  'undo reverts the peer that pressed it and leaves the other’s gate',
  async ({ join }) => {
    const ana = await join('ana')
    const elsewhere = await join('ana', 'ana-elsewhere')
    await expectJoined(ana, elsewhere)

    await moveCursorTo(ana.page, 0, 0)
    await place(ana.page, 'h')
    await moveCursorTo(elsewhere.page, 1, 1)
    await place(elsewhere.page, 'x')

    // Both peers hold both gates before either undoes anything; otherwise an undo
    // would be racing an update and the test would prove nothing.
    await expect(cell(ana.page, 1, 1)).toHaveAccessibleName('X')
    await expect(cell(elsewhere.page, 0, 0)).toHaveAccessibleName('H')

    /*
     * Ana's undo. `sharedUndo.ts` scopes a `Y.UndoManager` to this client's own
     * origin, so its stack holds this peer's transactions and nothing else. That
     * is the whole of that file, and it is untestable without two real peers: one
     * process cannot have two origins that arrived over a wire.
     */
    await toolbarButton(ana.page, 'Undo').click()

    await expect(cell(ana.page, 0, 0)).toHaveAccessibleName('free')
    await expect(cell(elsewhere.page, 0, 0)).toHaveAccessibleName('free')
    // And the other peer's gate is untouched on both screens. The editor's own
    // whole-document history — which is what a solo session still uses, and must
    // keep using — would have taken this with it.
    await expect(cell(ana.page, 1, 1)).toHaveAccessibleName('X')
    await expect(cell(elsewhere.page, 1, 1)).toHaveAccessibleName('X')
    await expectSameCircuit(ana, elsewhere)

    // Now the other peer undoes, and reverts its own work rather than Ana's
    // already-undone gate.
    await toolbarButton(elsewhere.page, 'Undo').click()
    await expect(cell(elsewhere.page, 1, 1)).toHaveAccessibleName('free')
    await expect(cell(ana.page, 1, 1)).toHaveAccessibleName('free')
    await expect(circuitSummary(ana.page)).toContainText('Operations: 0')
    await expectSameCircuit(ana, elsewhere)
  }
)

/* ══════════════════════════════════════════════════════════════════════ *
 * 5. Cursors and the roster
 * ══════════════════════════════════════════════════════════════════════ */

live(
  'each peer sees the others’ cursors and the roster names them',
  async ({ join }) => {
    // Three peers so that one roster has to name two different people. With two
    // contexts the strongest available reading of "the roster names both" is only
    // "each names the other".
    const ana = await join('ana')
    const elsewhere = await join('ana', 'ana-elsewhere')
    const beto = await join('beto')
    await expectJoined(ana, beto)

    await moveCursorTo(ana.page, 0, 0)
    await moveCursorTo(elsewhere.page, 1, 2)
    await moveCursorTo(beto.page, 2, 1)

    /*
     * Ana's roster: the other writer and the watcher, each with what they are
     * doing. `editing` and `watching` are the words `access` becomes, and access
     * is the relay's to decide — a peer cannot claim to be a writer, because §11
     * has the server compose the frame — so this is also an assertion about that.
     */
    await expect(roster(ana.page)).toContainText('2 other people are here')
    await expect(roster(ana.page)).toContainText('Ana')
    await expect(roster(ana.page)).toContainText('Beto')
    await expect(roster(ana.page)).toContainText('editing')
    await expect(roster(ana.page)).toContainText('watching')
    /*
     * Where they are, in words. This is the accessibility half of presence and it
     * is not decoration: the caret layer is `aria-hidden`, because a coloured
     * marker over a canvas reaches nobody, so the roster's sentence is the only
     * form in which a screen-reader user learns that somebody is on q2.
     */
    await expect(roster(ana.page)).toContainText('at qubit 2, column 1')

    // And the carets, drawn, named, and really on screen at a real pixel.
    await expect(caretFor(ana.page, 'Beto')).toBeVisible()
    const box = await caretFor(ana.page, 'Beto').boundingBox()
    expect(box?.width ?? 0, 'Beto’s caret has no box').toBeGreaterThan(0)

    await expect(roster(beto.page)).toContainText('Ana')
    await expect(caretFor(beto.page, 'Ana')).toBeVisible()

    /*
     * The live region says arrivals out loud and does not chatter. A peer moving a
     * cursor is not news — `presence.ts` keeps movement out of the event log for
     * exactly this reason — so the region holds arrivals and edits and no cursor
     * traffic. A dragged slider producing eight utterances a second is the failure
     * this asserts against.
     */
    /*
     * The roster's own live region, scoped to the panel. The page carries several
     * `role="status"` nodes on purpose — the comment panel has one, the editor has
     * one, dnd-kit mounts one — and that is correct behaviour rather than something
     * to work around: a listener hears all of them, and a test has to say which one
     * it means.
     */
    const spoken = ana.page.locator('.collab-panel > p[role="status"]')
    await expect(spoken).toContainText('is now in this circuit')
    await expect(spoken).not.toContainText('at qubit')
  }
)

/* ══════════════════════════════════════════════════════════════════════ *
 * 6. A comment follows its gate
 * ══════════════════════════════════════════════════════════════════════ */

live(
  'a comment on a gate reaches the other peer and follows the gate',
  async ({ join }) => {
    const ana = await join('ana')
    const beto = await join('beto')
    await expectJoined(ana, beto)

    await moveCursorTo(ana.page, 0, 0)
    await place(ana.page, 'h')
    await expect(cell(beto.page, 0, 0)).toHaveAccessibleName('H')

    /*
     * Placing a gate selects it, and the compose form's target is the selection.
     * The anchor sentence is asserted before the comment is written, because it is
     * the promise the form makes about what it is attaching itself to.
     */
    await expect(ana.page.locator('.comment-form__target')).toContainText(
      'About H on q0, column 0'
    )
    await ana.page.getByLabel('New comment').fill('Is this the wire you meant?')
    await ana.page.getByRole('button', { name: 'Post comment' }).click()
    await expect(ana.page.locator('.comment-threads')).toContainText(
      'Is this the wire you meant?'
    )

    /*
     * Beto reloads, and that is a statement about the product rather than a
     * convenience. Threads are rows and travel over REST (§3.4's comments are not
     * frames), and `queryClient.ts` sets `refetchOnWindowFocus: false` — so a peer
     * learns of a *new* thread on its next load. The anchor, below, is the half
     * that is live: it is resolved against the shared document in the browser, so
     * it moves with the gate over the socket.
     */
    await beto.page.reload()
    await expect(beto.page.locator('.comment-threads')).toContainText(
      'Is this the wire you meant?'
    )
    /*
     * The *thread's* anchor, scoped to the list. The compose form below carries a
     * `.comment-anchor` too — Beto may comment, because §11 lets anybody who can
     * read a circuit talk about it — and its target is "About the circuit", so an
     * unscoped locator matches two sentences that mean different things.
     */
    await expect(
      beto.page.locator('.comment-threads .comment-anchor')
    ).toContainText('About H on q0, column 0')

    /*
     * Ana moves the gate. `moveOperation` keeps the operation's id, which is what
     * the anchor is attached to.
     *
     * The helper aims and drags inside one retry: this scenario has a second
     * browser attached to the same document, so a keystroke can land in the
     * instant an arriving update replaces the node it was aimed at — see
     * `dragRightByKeyboard`.
     */
    await dragRightByKeyboard(ana.page, 0, 0)
    await expect(cell(ana.page, 0, 1)).toHaveAccessibleName('H')

    // The comment follows it on the screen that made the edit…
    await expect(
      ana.page.locator('.comment-threads .comment-anchor')
    ).toContainText('About H on q0, column 1')
    // …and on the screen that only watched, with no reload of its own: the move
    // arrived over the socket and the anchor was recomputed from the document.
    await expect(cell(beto.page, 0, 1)).toHaveAccessibleName('H')
    await expect(
      beto.page.locator('.comment-threads .comment-anchor')
    ).toContainText('About H on q0, column 1')
    // And it is not orphaned on either screen, which is what a move that
    // renumbered ids would produce.
    await expect(
      beto.page.getByText(
        'The gate this was about is no longer in this document'
      )
    ).toHaveCount(0)
  }
)

/* ══════════════════════════════════════════════════════════════════════ *
 * 7. The document survives everybody leaving
 * ══════════════════════════════════════════════════════════════════════ */

live(
  'the document is what the peers left after both close and one returns',
  async ({ join }) => {
    const ana = await join('ana')
    const beto = await join('beto')
    await expectJoined(ana, beto)

    await moveCursorTo(ana.page, 0, 0)
    await place(ana.page, 'h')
    await moveCursorTo(ana.page, 1, 1)
    await place(ana.page, 'x')
    await expect(cell(beto.page, 1, 1)).toHaveAccessibleName('X')
    const left = await readCircuit(ana.page)

    /*
     * Both leave. The last peer detaching flushes `CircuitSession` immediately
     * rather than waiting out `PERSIST_QUIET_MS`, which is the case that row
     * exists for. Nothing here saved a *version*: this is unsaved shared work, and
     * the promise is that closing the tab does not lose it.
     */
    await ana.context.close()
    await beto.context.close()

    const returning = await join('ana', 'ana-returning')
    /*
     * And the document is what it was — the whole canvas, compared against the
     * reading taken before the close, rather than the two gates a narrower test
     * would name: a session restored one gate short would pass that and fail this.
     *
     * Retried, because a returning peer's editor paints the saved version first
     * and adopts the session's document a beat later, when the join lands. Note
     * what that also proves: neither gate is in any saved version, so a page
     * showing them can only have got them from the shared session.
     */
    await expect(async () => {
      expect(await readCircuit(returning.page)).toEqual(left)
    }).toPass({ timeout: 30_000 })
  }
)

/* ══════════════════════════════════════════════════════════════════════ *
 * 8. A watcher may watch and may not write, and the refusal is the server's
 * ══════════════════════════════════════════════════════════════════════ */

live(
  'a read-only peer may watch, and the relay refuses its writes',
  async ({ join, circuit }) => {
    const ana = await join('ana')
    const beto = await join('beto')
    await expectJoined(ana, beto)

    /*
     * What the watcher is told, and what the watcher's editor does. Both come from
     * `access: 'read'`, which is the relay's answer and arrives *after* the page
     * has already drawn an ordinary editor — the interface has to be able to
     * change its mind, and this is that state.
     */
    await expect(
      beto.page.getByText(
        'You are watching this session. Only the owner may edit.'
      )
    ).toBeVisible()
    await expect(toolbarButton(beto.page, 'Undo')).toBeDisabled()

    // And it really is watching: Ana's gate arrives on the disabled editor.
    await moveCursorTo(ana.page, 0, 0)
    await place(ana.page, 'h')
    await expect(cell(beto.page, 0, 0)).toHaveAccessibleName('H')

    /*
     * ── The refusal is the server's ─────────────────────────────────────────
     *
     * A disabled button proves the interface declines to ask. It says nothing
     * about what happens when something asks anyway — a script, a stale tab whose
     * access was withdrawn, a curious reader with a console open. So the frame the
     * disabled editor would have sent is sent from Beto's own page, over a socket
     * the browser opens, with Beto's own credential; and the relay answers
     * FORBIDDEN.
     *
     * `ws/session.ts` is emphatic about why this is the assertion that matters:
     * "Read-only is enforced here, on the frame, and not by declining to draw a
     * button… the difference between an interface that discourages something and a
     * server that does not permit it."
     */
    const token = await passwordToken(
      env,
      identities().beto.email,
      identities().beto.password
    )
    const answer = await askRelayToWrite(beto.page, {
      socketUrl: socketUrlOf(env.apiUrl),
      token,
      // The slug, which is what the app joins with and the only handle a reader
      // of an UNLISTED circuit may name. See `askRelayToWrite`.
      handle: circuit.slug,
    })

    expect(answer.error, 'the probe never reached the relay').toBeNull()
    // Admitted as a reader — §3.4's decision 3, and the reason a watcher has a
    // session at all. The answer quotes the handle that was asked about.
    expect(answer.joined).toBe(circuit.slug)
    expect(answer.access).toBe('read')
    // And refused as a writer, by the relay, on the frame.
    expect(answer.refusal).toBe('FORBIDDEN')

    // The document is untouched: a refusal is a refusal, not a partial write.
    await expect(circuitSummary(ana.page)).toContainText('Operations: 1')
    await expectSameCircuit(ana, beto)
  }
)
