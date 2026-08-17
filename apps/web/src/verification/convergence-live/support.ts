/**
 * Two browsers, one relay, and a network that can be taken away.
 *
 * ═══════════════════════════════════════════════════════════════════════
 * WHY THIS SITS BESIDE `e2e/live` INSTEAD OF INSIDE IT
 *
 * `e2e/live/collaboration.spec.ts` is the implementation's own acceptance
 * suite. This one is an independent reading of the same claim, derived from
 * §3.4 and §8 rather than from that spec, and it is deliberately kept in its
 * own directory with its own accounts and its own artifact folder so that the
 * two can run without either one's teardown deleting the other's identities —
 * several verifiers share this tree and this database.
 *
 * What it adds is the four situations that suite does not reach: a peer that
 * edits while it is **offline**, a peer that **reloads** in the middle of
 * somebody else's edit, **three** peers at once, and a **deferred** operation
 * followed all the way to being resolved as an ordinary edit. Every one of them
 * ends the same way — the circuit is read out of *both* DOMs and compared,
 * because equality of what the two people see is the claim, and it is stronger
 * than equality of two documents.
 *
 * ═══════════════════════════════════════════════════════════════════════
 * THE DATABASE IS THE OWNER'S ONLY ONE
 *
 * Everything created here hangs off two accounts, and both are deleted by the
 * teardown project through `DELETE /api/v1/me` — which cascades the circuits,
 * versions, `CircuitSession` rows and comments they own — and then through
 * Supabase's own admin API. The API's half goes first: it can only be reached
 * with a token the auth half issues, so deleting the auth user first would
 * strand a `public.User` row with no way left to authenticate as its owner.
 *
 * Nothing here writes to Redis and nothing here submits a hardware run.
 */

import {
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  expect,
  type Browser,
  type Locator,
  type Page,
  type WebSocketRoute,
} from '@playwright/test'

import {
  pinLanguage,
  type LiveAccount,
  type LiveCircuit,
} from '../../../e2e/live/support/live'
import type { Peer } from '../../../e2e/live/support/peers'
import { cellAt, grid } from '../../../e2e/support/editor'

/**
 * Where this suite's accounts are kept. Namespaced under `.playwright/`, which
 * is gitignored, and named after this lens so that a concurrent run of
 * `e2e/live` cannot delete it — that suite's teardown removes
 * `.playwright/live`.
 */
const ARTIFACT_DIR = resolve(
  dirname(fileURLToPath(import.meta.url)),
  '../../../.playwright/convergence-live'
)

const IDENTITIES_FILE = resolve(ARTIFACT_DIR, 'identities.json')

/**
 * The two people here.
 *
 * `owner` is the only one the relay grants `write` to — `canEditCircuit` admits
 * the owner and nobody else today — so every scenario that needs two *writers*
 * opens two contexts holding that one identity. Two contexts are two clients,
 * two Y.Docs and two sockets, which is what convergence is about; one identity
 * is what makes both of them able to write. `watcher` is a second account, and
 * it is what shows that a read-only peer's screen converges too.
 */
export type Who = 'owner' | 'watcher'

export interface Identities {
  readonly apiUrl: string
  readonly owner: LiveAccount
  readonly watcher: LiveAccount
}

export function writeIdentities(identities: Identities): void {
  mkdirSync(ARTIFACT_DIR, { recursive: true })
  writeFileSync(IDENTITIES_FILE, `${JSON.stringify(identities, null, 2)}\n`)
}

export function readIdentities(): Identities {
  if (!existsSync(IDENTITIES_FILE)) {
    throw new Error(
      `no identities at ${IDENTITIES_FILE}. They are created by this suite's ` +
        '`accounts` setup project; run the whole config rather than pointing ' +
        'Playwright at the spec.'
    )
  }
  return JSON.parse(readFileSync(IDENTITIES_FILE, 'utf8')) as Identities
}

export function storageStateFile(who: Who): string {
  return resolve(ARTIFACT_DIR, `${who}.json`)
}

/** The run's artifacts, which hold two passwords and two live tokens. */
export function forgetArtifacts(): void {
  rmSync(ARTIFACT_DIR, { recursive: true, force: true })
}

/* ------------------------------------------------------------------ *
 * Peers
 * ------------------------------------------------------------------ */

/**
 * Opens the circuit in a context of its own.
 *
 * A context and never a second tab: this app keeps its Supabase session in
 * `localStorage`, so two tabs of one context are two views of one client, and
 * the thing under test is two clients.
 */
export async function openPeer(
  browser: Browser,
  account: LiveAccount,
  circuit: LiveCircuit,
  label: string
): Promise<Peer> {
  const context = await browser.newContext({
    storageState: account.storageState,
  })
  const page = await context.newPage()
  await pinLanguage(page)
  await page.goto(circuit.path)
  await expect(grid(page), `${label} never got an editor`).toBeVisible()
  return { context, page, name: account.displayName, label }
}

/** Every context a scenario opened, closed whether it passed or not. */
export async function closeAll(peers: readonly Peer[]): Promise<void> {
  for (const peer of peers) await peer.context.close()
}

/* ------------------------------------------------------------------ *
 * Taking the network away
 * ------------------------------------------------------------------ */

/** The sentence the panel paints while the socket is gone. */
const RECONNECTING = 'Reconnecting to the shared session'

function reconnectingNotice(page: Page): Locator {
  return page.locator('.collab-panel__notice').filter({ hasText: RECONNECTING })
}

/** A peer whose connection to the relay can be cut and given back. */
export interface PartitionablePeer {
  readonly peer: Peer
  /** Cuts it off, and returns once its own interface says so. */
  readonly cut: () => Promise<void>
  /** Gives the connection back, and returns once the session is open again. */
  readonly heal: () => Promise<void>
}

/**
 * Opens a peer whose socket runs through a proxy this test can cut.
 *
 * ── WHY NOT `context.setOffline(true)`, WHICH IS THE OBVIOUS ANSWER ────────
 *
 * Because in Chromium it does not close an established WebSocket. Measured, not
 * assumed: with a session joined, `setOffline(true)` produced no `close` event on
 * the relay socket and no `reconnecting` state in the client for twenty seconds,
 * across three runs. Network emulation gates new connections; a socket already up
 * on loopback keeps carrying frames. So a scenario built on it does not partition
 * anything — it edits over a working connection and then asserts convergence,
 * which is the shape of a test that passes without testing.
 *
 * `routeWebSocket` with `connectToServer` is a proxy rather than a mock: every
 * frame is forwarded verbatim in both directions, so the client is the real
 * client, the relay is the real relay, and the only thing this file adds is a
 * pair of scissors. Cutting sets the flag *and* closes the client socket, which
 * is what a dropped connection looks like from inside the browser
 * (`onclose` → `reconnecting` → the backoff). While cut, the transport's next
 * connection succeeds at the TCP level and hears nothing back, so it stays in
 * `reconnecting` — a black hole, which is exactly the state a phone in a lift is
 * in. Healing clears the flag and closes that socket, so the next attempt lands
 * on a proxy that forwards again and the ordinary rejoin runs: `since` out,
 * `collab:joined` back, and the delta this peer owes the session after it.
 */
export async function openPartitionablePeer(
  browser: Browser,
  account: LiveAccount,
  circuit: LiveCircuit,
  label: string
): Promise<PartitionablePeer> {
  const context = await browser.newContext({
    storageState: account.storageState,
  })
  const page = await context.newPage()
  await pinLanguage(page)

  let cut = false
  /** Every client socket the proxy has seen; the last one is the live one. */
  const sockets: WebSocketRoute[] = []
  // `/ws` and not every socket: Vite's own HMR connection is on the page too,
  // and proxying that would put this file between the dev server and its client.
  await page.routeWebSocket(/\/ws$/, (socket) => {
    const relay = socket.connectToServer()
    sockets.push(socket)
    socket.onMessage((message) => {
      if (!cut) relay.send(message)
    })
    relay.onMessage((message) => {
      if (!cut) socket.send(message)
    })
  })

  await page.goto(circuit.path)
  await expect(grid(page), `${label} never got an editor`).toBeVisible()
  const peer: Peer = {
    context,
    page,
    name: account.displayName,
    label,
  }

  return {
    peer,
    cut: async () => {
      cut = true
      // 1006 rather than a clean close: an abnormal closure is what a lost
      // connection produces, and the transport's `onclose` must not care.
      await sockets.at(-1)?.close({ code: 1006 })
      await expect(
        reconnectingNotice(page),
        `${label} never noticed it had been cut off`
      ).toBeVisible({ timeout: 30_000 })
    },
    heal: async () => {
      cut = false
      // The socket that was talking to nobody. Closing it is what makes the
      // transport try again now rather than at the end of its backoff.
      await sockets.at(-1)?.close({ code: 1006 })
      await expect(
        reconnectingNotice(page),
        `${label} never rejoined after the connection came back`
      ).toHaveCount(0, { timeout: 60_000 })
    },
  }
}

/* ------------------------------------------------------------------ *
 * Reading the page
 * ------------------------------------------------------------------ */

/**
 * What one cell says, as a person's assistive technology would hear it.
 *
 * The accessible name of an occupied cell comes from its contents and of an
 * empty one from an `aria-label` the canvas adds precisely because it has none
 * (`GridCell.tsx`), so both readings are taken and joined.
 */
export async function cellName(
  page: Page,
  qubit: number,
  column: number
): Promise<string> {
  const cell = cellAt(page, qubit, column)
  const label = (await cell.getAttribute('aria-label')) ?? ''
  const text = (await cell.textContent()) ?? ''
  return `${label}${text}`
}

/** The panel naming what the document holds and the canvas does not. */
export function deferredPanel(page: Page): Locator {
  return page.locator('.deferred-panel')
}

/**
 * The address, once it has stopped changing.
 *
 * `useCircuitUrl` mirrors the document into `?c=` behind a debounce, so the URL
 * read the instant a gate appears on the canvas is the URL from *before* that
 * gate. A scenario that captures an address and reopens it later has to wait for
 * the mirror to catch up, or it reopens a snapshot one edit behind and proves
 * something about the wrong document — which is exactly what happened until this
 * existed.
 */
export async function settledUrl(page: Page): Promise<string> {
  let last = page.url()
  for (let attempt = 0; attempt < 20; attempt += 1) {
    await page.waitForTimeout(500)
    const next = page.url()
    if (next === last) return next
    last = next
  }
  throw new Error(`the address bar never stopped changing (${last})`)
}
