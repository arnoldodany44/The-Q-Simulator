/**
 * Two or three browsers in one circuit, addressed the way a person addresses it.
 *
 * Everything here reads the page: an accessible name on a grid cell, a sentence
 * in the roster, a caret's own label. Nothing reaches into the store, the Y.Doc
 * or a React internal — which is the whole point of running this suite at all.
 * `verification/convergence` already proves the algebra with the document in
 * hand; what only two browsers can prove is that the algebra reached the screen.
 *
 * ── Why the circuit is read as a list of cell descriptions ────────────────
 *
 * "Both peers show the same circuit" needs a reading that is complete, ordered
 * and comparable. The grid's accessible names are exactly that: one string per
 * cell, generated from the same `Circuit` the SVG is drawn from
 * (`CircuitCanvas.tsx`), naming the gate and — for a multi-qubit gate — its role
 * and its partner. Two lists that are `toEqual` is therefore two identical
 * circuits, wire for wire and moment for moment, as rendered.
 *
 * The alternative was comparing the summary line ("Qubits: 3. Columns: 2.
 * Operations: 2.") and it is not enough on its own: two peers can agree on the
 * *count* of operations while disagreeing about which cell one of them is in,
 * which is precisely the failure a conflicting placement produces. The summary
 * is asserted too, because it is cheap and it localises a failure — a count that
 * differs says "an update was lost", a count that agrees with a different layout
 * says "the projection disagreed".
 */

import {
  expect,
  type Browser,
  type BrowserContext,
  type Page,
} from '@playwright/test'

import { cellAt, circuitSummary, grid } from '../../support/editor'
import {
  pinLanguage,
  type LiveCircuit,
  type LiveIdentities,
  type Who,
} from './live'

/** One browser in a session, with the name its peers see it under. */
export interface Peer {
  readonly context: BrowserContext
  readonly page: Page
  /** What the relay composes into this peer's presence frames. */
  readonly name: string
  /** For the log line when an assertion fails, and for nothing else. */
  readonly label: string
}

/**
 * Opens a circuit in a fresh context signed in as `who`.
 *
 * A context per peer, never a second tab: two tabs in one context share
 * `localStorage`, and this app keeps its Supabase session there. They would also
 * share a service worker and a BroadcastChannel, so "two peers" would be two
 * views of one client — and the thing under test is two clients.
 *
 * `label` is what distinguishes two contexts holding the *same* identity, which
 * is the arrangement the two-writer scenarios need — see the spec's header.
 */
export async function openCircuit(
  browser: Browser,
  identities: LiveIdentities,
  who: Who,
  circuit: LiveCircuit,
  /** Two contexts can hold one identity, so the label is free text. */
  label: string = who
): Promise<Peer> {
  const account = identities[who]
  const context = await browser.newContext({
    storageState: account.storageState,
  })
  const page = await context.newPage()
  await pinLanguage(page)
  await page.goto(circuit.path)
  // A visible grid means the route resolved the circuit and the editor mounted.
  // It says nothing yet about the session; `expectJoined` is what says that.
  await expect(grid(page), `${label} never got an editor`).toBeVisible()
  return { context, page, name: account.displayName, label }
}

/**
 * Waits until each peer can see the other in the roster.
 *
 * This is the suite's join barrier, and it has to exist for a reason that is
 * easy to miss: **a gate placed before the join is a gate the join throws away.**
 * The relay serves the document built from the saved circuit, the client applies
 * it and only then bridges the store to it (`joinedWith`), so an edit made in
 * the window between "the editor painted" and "the session opened" is overwritten
 * by the document. Every scenario therefore waits here before it touches a key.
 *
 * The roster is the right signal because it is the one thing that only appears
 * once *both* ends have joined: the relay composes a presence frame from an
 * attachment it has authorised, and `channel.announce()` sends this peer's
 * position on the join rather than waiting for the ten-second heartbeat.
 */
export async function expectJoined(...peers: readonly Peer[]): Promise<void> {
  for (const peer of peers) {
    const others = peers.filter((other) => other !== peer)
    for (const other of others) {
      await expect(
        roster(peer.page),
        `${peer.label} never saw ${other.label} join`
      ).toContainText(other.name)
    }
  }
}

export function roster(page: Page) {
  return page.locator('.presence-roster')
}

/** A named caret: the tie between a name in the roster and a cell on the grid. */
export function caretFor(page: Page, name: string) {
  return page
    .locator('.presence-mark--cursor')
    .filter({ hasText: name })
    .first()
}

/** The panel that names what the document holds and the canvas does not. */
export function deferredPanel(page: Page) {
  return page.locator('.deferred-panel')
}

/* ------------------------------------------------------------------ *
 * Editing
 * ------------------------------------------------------------------ */

/**
 * Puts the grid cursor on a cell, and the keyboard with it.
 *
 * ── Neither `tabToGrid` nor a click, and both for a reason ────────────────
 *
 * The fast suite walks there with Tab and asserts `toBeFocused`, which is right
 * for a suite with one page: it proves §10's keyboard path as it goes. With two
 * or three contexts open, at most one browser window is the active one, so
 * `document.hasFocus()` is false for the others and `toBeFocused` reports
 * `inactive` for a cell that really *is* `document.activeElement`. Two scenarios
 * failed on that, and neither failure was about collaboration.
 *
 * A click was the next attempt and it is subtly unreliable here for a reason
 * worth writing down: this canvas is under two overlays that grow and shrink
 * while a session runs — the carets and the comment badges — and every arriving
 * update re-renders the grid. A click that lands the instant React replaces the
 * cell node leaves focus on `<body>`, and the *next* keystroke then goes
 * nowhere: one run moved no gate at all and failed on an empty cell three lines
 * later, which reads exactly like a lost update and is not one.
 *
 * So the cursor is placed by focusing the cell — `onFocusCell` is what
 * `useKeyboardGrid` moves the cursor with, so this is the editor's own mechanism
 * — and then *verified*, retrying until both facts hold: the editor calls this
 * cell the cursor, and the browser calls it the active element. What follows is a
 * keystroke, and a keystroke needs a target that is still there.
 *
 * Nothing here is a pointer, which also means this suite cannot be broken by an
 * overlay's hit target. The pointer paths are proved by `editor.spec.ts` on a
 * single page.
 */
export async function moveCursorTo(
  page: Page,
  qubit: number,
  column: number
): Promise<void> {
  await page.bringToFront()
  const target = cellAt(page, qubit, column)
  await expect(async () => {
    await target.focus()
    // The editor's reading: this cell is where the cursor is.
    await expect(target).toHaveClass(/circuit-canvas__cell--cursor/, {
      timeout: 2_000,
    })
    // And the browser's: a keystroke aimed here will arrive here.
    expect(
      await target.evaluate((node) => node === document.activeElement),
      `the cell at q${qubit} column ${column} would not hold focus`
    ).toBe(true)
  }).toPass({ timeout: 15_000 })
}

/**
 * Arms a gate and places it at the cursor. Two keystrokes, no pointer.
 *
 * Split from `moveCursorTo` on purpose: the same-cell scenario needs both peers
 * *armed and aimed* before either commits, so that the two Enters are as close
 * to simultaneous as two browsers can be made. A helper that moved and placed in
 * one call would put a dozen keystrokes of walking between them.
 */
export async function place(page: Page, gateKey: string): Promise<void> {
  await page.keyboard.press(gateKey)
  await page.keyboard.press('Enter')
  /*
   * Escape, because the palette *stays armed* after a placement — deliberately,
   * so that somebody laying down four Hadamards presses one key and then Enter
   * four times. The consequence for a test that walks the grid is sharp: with a
   * gate still armed, clicking the next cell does not merely move the cursor, it
   * places that gate there (`activate` places the armed gate). One scenario
   * placed an H it never asked for and then failed on the X that could not go
   * into an occupied cell.
   */
  await page.keyboard.press('Escape')
}

/**
 * Moves the operation at (qubit, column) one column to the right, by keyboard.
 *
 * Space picks a gate up for a keyboard drag, the arrows carry it, and Enter drops
 * it — the path `ShortcutsPanel` advertises. `moveOperation` keeps the
 * operation's id (see `useCircuitStore.ts`), which is what a comment's anchor is
 * attached to, and this helper exists to prove that end to end.
 *
 * ── WHY IT AIMS, DRAGS AND CHECKS INSIDE ONE RETRY ───────────────────────
 *
 * The first version took no coordinates and pressed three keys, and it failed
 * about once per full run: after `moveCursorTo` had confirmed the cell held
 * focus, an update arriving from the other peer re-rendered the grid, the node
 * the keystrokes were aimed at was replaced, dnd-kit's drag never started, and
 * the gate simply stayed where it was — the source cell still reading `free`
 * fifteen seconds later.
 *
 * That is the hazard `moveCursorTo` already documents and works around for a
 * *click*, and the drag that follows it needs the same treatment: the aim and the
 * three keystrokes are one gesture and have to be retried together. Escape first,
 * because a retry may be following an attempt that picked the gate up and never
 * dropped it — with a drag in flight dnd-kit owns the arrow keys.
 *
 * The check is the source cell becoming empty, which is a fact about the
 * document. Nothing here weakens what the spec asserts afterwards: a drag that
 * worked passes on the first attempt and a retry cannot double it, because a cell
 * that is already empty is not retried.
 */
export async function dragRightByKeyboard(
  page: Page,
  qubit: number,
  column: number
): Promise<void> {
  await expect(async () => {
    await page.keyboard.press('Escape')
    await moveCursorTo(page, qubit, column)
    await page.keyboard.press('Space')
    await page.keyboard.press('ArrowRight')
    await page.keyboard.press('Enter')
    await expect(cellAt(page, qubit, column)).toHaveAccessibleName('free', {
      timeout: 3_000,
    })
  }).toPass({ timeout: 45_000 })
}

/* ------------------------------------------------------------------ *
 * Reading the circuit off the page
 * ------------------------------------------------------------------ */

/**
 * The whole canvas as the accessibility tree renders it.
 *
 * `ariaSnapshot` rather than a hand-written DOM walk, and the difference is not
 * convenience: the *computed accessible name* of a cell is what this comparison
 * has to be about, and it comes from two different places depending on what is
 * in the cell — an occupied cell is named by its contents (the notation the SVG
 * draws, plus the role text a multi-qubit gate contributes), an empty one by an
 * `aria-label` the canvas adds precisely because it has no contents (see
 * `GridCell.tsx`). A walk reading one attribute would silently see half of it.
 *
 * `[selected]` is stripped, and it is the only thing stripped. Each peer selects
 * the gate *it* placed — selection is this tab's editing context and is
 * deliberately not shared (see `CircuitEditor.tsx`) — so leaving it in would
 * make two identical circuits read as different for the one reason that is not
 * a divergence.
 */
export async function readCircuit(page: Page): Promise<string> {
  const snapshot = await grid(page).ariaSnapshot()
  return snapshot.replace(/ \[selected\]/g, '')
}

/**
 * The strong form of "both peers ended up with the same circuit".
 *
 * Retried rather than read once, because convergence is asynchronous by
 * construction: an update leaves one browser, crosses the relay, and is applied
 * in another, and a single read taken between those two moments would be a race
 * this assertion loses at random. `toPass` polls both readings together, so what
 * it reports on failure is two circuits that stayed different.
 */
export async function expectSameCircuit(a: Peer, b: Peer): Promise<void> {
  await expect(async () => {
    const [left, right] = await Promise.all([
      readCircuit(a.page),
      readCircuit(b.page),
    ])
    expect(
      right,
      `${a.label} and ${b.label} disagree about the circuit`
    ).toEqual(left)
    // Both the drawn count and the layout. See the header for why one without
    // the other is not enough.
    const [summaryA, summaryB] = await Promise.all([
      circuitSummary(a.page).textContent(),
      circuitSummary(b.page).textContent(),
    ])
    expect(summaryB?.trim()).toEqual(summaryA?.trim())
  }).toPass({ timeout: 20_000 })
}

/** What one cell says on one page. The narrow assertion, for a named gate. */
export function cell(page: Page, qubit: number, column: number) {
  return cellAt(page, qubit, column)
}

/* ------------------------------------------------------------------ *
 * The server's refusal
 * ------------------------------------------------------------------ */

export interface RelayAnswer {
  readonly joined: string | null
  readonly access: string | null
  readonly refusal: string | null
  readonly error: string | null
}

/**
 * Joins the relay from inside the page and tries to write.
 *
 * This is how "the refusal comes from the server rather than from a hidden
 * button" is proved. A read-only peer's editor is disabled, so no keystroke can
 * produce an update to be refused — which means the only way to show that the
 * *relay* refuses is to send the frame the disabled interface would have sent.
 *
 * It runs in the page rather than in Node so that the socket is opened by the
 * browser, from the origin the app runs on, exactly as the transport opens it.
 * The token is passed in rather than lifted out of `localStorage`: what is being
 * tested is the relay's answer, and reading a dependency's private storage
 * format to get there would make this fail for an unrelated reason one day.
 *
 * `update` is deliberately not a real Yjs update. `ws/session.ts` checks access
 * *before* it decodes the payload, so bytes that decode to nothing are enough to
 * ask the question — and a well-formed update would risk proving the refusal by
 * accident if the order there ever changed.
 *
 * `handle` is the *slug*, because that is what the app joins with and what a
 * reader of an UNLISTED circuit is allowed to name (§11 keeps an id out of
 * anything a listing may not show). A probe that joined by id would be refused
 * with NOT_FOUND and would never reach the question it exists to ask.
 */
export async function askRelayToWrite(
  page: Page,
  input: {
    readonly socketUrl: string
    readonly token: string
    readonly handle: string
  }
): Promise<RelayAnswer> {
  return page.evaluate(async (options) => {
    const socket = new WebSocket(options.socketUrl)
    const answer: {
      joined: string | null
      access: string | null
      refusal: string | null
      error: string | null
    } = { joined: null, access: null, refusal: null, error: null }

    await new Promise<void>((resolve) => {
      // Bounded: a socket that says nothing is a failure to report, not a test
      // that hangs until the whole suite times out.
      const giveUp = setTimeout(() => {
        answer.error ??= 'the relay said nothing in ten seconds'
        socket.close()
        resolve()
      }, 10_000)

      const done = (): void => {
        clearTimeout(giveUp)
        socket.close()
        resolve()
      }

      socket.onopen = () => {
        socket.send(
          JSON.stringify({ type: 'authenticate', token: options.token })
        )
      }
      socket.onerror = () => {
        answer.error ??= 'the socket errored'
        done()
      }
      socket.onclose = (event) => {
        answer.error ??= `the relay closed the socket (${event.code})`
        clearTimeout(giveUp)
        resolve()
      }
      socket.onmessage = (event) => {
        const frame = JSON.parse(String(event.data)) as {
          type?: string
          viewer?: string | null
          access?: string
          circuitId?: string
          code?: string
        }
        if (frame.type === 'ready') {
          // The relay sends `ready` when the socket opens and again after a
          // successful `authenticate`; only the second one carries a viewer,
          // and joining on the first would ask about an anonymous reader.
          if (frame.viewer === null || frame.viewer === undefined) return
          socket.send(
            JSON.stringify({
              type: 'collab:join',
              circuitId: options.handle,
            })
          )
          return
        }
        if (frame.type === 'collab:joined') {
          answer.joined = frame.circuitId ?? null
          answer.access = frame.access ?? null
          socket.send(
            JSON.stringify({
              type: 'collab:update',
              circuitId: options.handle,
              // Base64 the schema accepts. Never decoded: access is checked
              // first, which is the ordering this probe depends on.
              update: 'AQID',
            })
          )
          return
        }
        if (frame.type === 'collab:error') {
          answer.refusal = frame.code ?? null
          done()
          return
        }
        if (frame.type === 'collab:left') {
          answer.error ??= `the attachment ended (${frame.code ?? 'unknown'})`
          done()
        }
      }
    })

    return answer
  }, input)
}

/** `ws://…/ws` from the API's origin, as `resolveSocketUrl` builds it. */
export function socketUrlOf(apiUrl: string): string {
  const base = apiUrl.endsWith('/') ? apiUrl.slice(0, -1) : apiUrl
  if (base.startsWith('https:')) return `wss:${base.slice('https:'.length)}/ws`
  if (base.startsWith('http:')) return `ws:${base.slice('http:'.length)}/ws`
  return `${base}/ws`
}
