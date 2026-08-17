/**
 * Presence for somebody who cannot see it: the instrument, not the claim.
 *
 * ═══════════════════════════════════════════════════════════════════════
 * WHY THIS LENS NEEDS A DIFFERENT INSTRUMENT FROM EVERY OTHER SUITE HERE
 *
 * Every other collaboration test in this repository asserts on *content*: a gate
 * reached the other browser, a roster names Beto, a notice says the session
 * ended. None of that can answer the question this lens exists for, which is not
 * "is the sentence in the DOM" but **"how many times was it said"**. A live
 * region that holds the right words and mutates eight times a second is not a
 * working accessibility feature; it is a screen reader somebody switches off.
 *
 * So the instrument is a `MutationObserver` installed before the app boots,
 * which records one entry per observer callback per live region — the same
 * granularity the browser reports to the platform accessibility API, because a
 * MutationObserver callback and a live-region change notification are both
 * delivered at the microtask checkpoint after a batch of DOM writes. What the
 * recorder produces is therefore a *transcript*: what would be spoken, in order,
 * with timestamps. Counting is then the assertion.
 *
 * The transcript is deliberately NOT de-duplicated by text. This code base
 * relies on replacing a keyed node to make a repeated sentence audible again
 * (`presence.ts`'s `seq`, `DeferredOperations`'s `outcome.seq`) — so a repeat
 * with a new key is a real utterance and must be counted as one. Where the text
 * was unchanged the entry records that, and the reader of a finding can apply
 * whichever reading of assistive-technology behaviour they believe.
 *
 * ═══════════════════════════════════════════════════════════════════════
 * THE DATABASE IS THE OWNER'S ONLY ONE
 *
 * Two accounts, minted here and deleted by the teardown project through
 * `DELETE /api/v1/me` — which cascades the circuits, versions, `CircuitSession`
 * rows and comments they own — and then through Supabase's own admin API, in
 * that order, because the API's half can only be reached with a token the auth
 * half issues. Nothing here writes to Redis and nothing submits a hardware run.
 *
 * The artifact directory is namespaced to this lens (`.playwright/presence-a11y`)
 * so that a concurrent run of `e2e/live` or of another verifier's suite cannot
 * delete this one's identities, and this one cannot delete theirs.
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

import type {
  Browser,
  BrowserContext,
  Page,
  WebSocketRoute,
} from '@playwright/test'

import { pinLanguage, type LiveAccount } from '../../../e2e/live/support/live'

/** Where this lens keeps its accounts. Gitignored, and its own. */
const ARTIFACT_DIR = resolve(
  dirname(fileURLToPath(import.meta.url)),
  '../../../.playwright/presence-a11y'
)

const IDENTITIES_FILE = resolve(ARTIFACT_DIR, 'identities.json')

/**
 * The two people.
 *
 * `owner` is the only identity the relay grants `write` to — `canEditCircuit`
 * admits the owner and nobody else today — so a scenario that needs a second
 * *writer* opens a second context holding the owner's own storage state. Two
 * contexts are two sockets, two Y.Docs and two peer ids, which is all presence
 * is about. `watcher` is a second account and is what puts a read-only peer in
 * somebody else's roster.
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
      `no identities at ${IDENTITIES_FILE}. They are minted by this lens's ` +
        '`accounts` setup project; run the whole config rather than pointing ' +
        'Playwright at a spec.'
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
 * The transcript
 * ------------------------------------------------------------------ */

/** One thing a screen reader would have been handed to say. */
export interface Utterance {
  /** Milliseconds since the recorder was installed. */
  readonly at: number
  /**
   * Which region spoke: its `role` and its class list, which is enough to tell
   * the roster's region from the deferral panel's and from dnd-kit's.
   */
  readonly region: string
  /** The region's whole text after the mutation — `aria-atomic` is implied by
   * `role="status"`, so this is what would be read, not just the delta. */
  readonly text: string
  /** Whether the text is the same as this region's previous entry. */
  readonly repeat: boolean
  /**
   * Whether the region *entered the DOM carrying this text*.
   *
   * The distinction the whole instrument turns on. A change inside a region that
   * was already there is what a screen reader announces; a region inserted
   * together with its first content is what it frequently does not, because
   * there is nothing for the assistive technology to have compared against. This
   * project states that rule itself, twice — `PresenceRoster` mounts its region
   * empty from the first render for exactly this reason — so a `born` entry is
   * evidence of silence, not of speech.
   */
  readonly born: boolean
}

/**
 * A page with a transcript of everything its live regions have said.
 *
 * The recorder is installed as an init script, so it is running before React
 * mounts: an arrival announced in the first commit after the join is caught,
 * which is exactly the announcement a recorder attached after `goto` would miss.
 */
export interface Peer {
  readonly context: BrowserContext
  readonly page: Page
  /** Everything said so far, oldest first. */
  readonly transcript: () => Promise<readonly Utterance[]>
  /** Forgets the transcript, so a scenario can measure one gesture. */
  readonly clearTranscript: () => Promise<void>
}

/**
 * Installs the recorder. Must run before any application script.
 *
 * `document` is the observation root rather than `document.body`, because at the
 * time an init script runs there is no body yet — and re-attaching on
 * `DOMContentLoaded` would miss anything React did in between.
 */
async function installRecorder(page: Page): Promise<void> {
  await page.addInitScript(() => {
    interface Recorded {
      at: number
      region: string
      text: string
      repeat: boolean
      born: boolean
    }
    const started = Date.now()
    const log: Recorded[] = []
    const lastText = new Map<string, string>()
    ;(window as unknown as { __utterances: Recorded[] }).__utterances = log
    ;(
      window as unknown as { __clearUtterances: () => void }
    ).__clearUtterances = () => {
      log.length = 0
      lastText.clear()
    }

    /** The nearest live region above a mutated node, or null. */
    const regionOf = (node: Node): Element | null => {
      let element: Element | null =
        node instanceof Element ? node : (node.parentElement ?? null)
      while (element !== null) {
        // A region inside an aria-hidden subtree reaches nobody, so it is not a
        // region: recording it would credit the page with an utterance no
        // screen reader ever receives.
        if (element.getAttribute('aria-hidden') === 'true') return null
        const role = element.getAttribute('role')
        const live = element.getAttribute('aria-live')
        if (
          role === 'status' ||
          role === 'alert' ||
          role === 'log' ||
          (live !== null && live !== 'off')
        ) {
          return element
        }
        element = element.parentElement
      }
      return null
    }

    /*
     * The parent's class as well as the region's own, because two of the regions
     * on this page are spelled identically — the roster's and the comment
     * panel's are both `<p class="visually-hidden" role="status">` — and a key
     * that could not tell them apart would credit one with the other's
     * utterances.
     */
    const keyOf = (element: Element): string => {
      const role =
        element.getAttribute('role') ??
        element.getAttribute('aria-live') ??
        'live'
      const classes = element.getAttribute('class') ?? ''
      const parent = element.parentElement?.getAttribute('class') ?? ''
      return `${parent}>${role}|${classes}`
    }

    const observer = new MutationObserver((records) => {
      /*
       * One entry per region per callback, and that is the whole modelling
       * decision: a browser coalesces the DOM writes of one commit and reports
       * one live-region change per region, so counting records instead of
       * callbacks would invent utterances React never caused.
       */
      const touched = new Set<Element>()
      /** Regions that arrived *inside* an added subtree — see `Utterance.born`. */
      const arrived = new Set<Element>()
      for (const record of records) {
        /*
         * `target` and not the added or removed nodes: for a `childList`
         * mutation the target is the parent that changed, which is the element
         * still in the tree and therefore the one whose region can be found. A
         * removed node has no parent left to walk.
         */
        const region = regionOf(record.target)
        if (region !== null) touched.add(region)
        /*
         * And downwards, for the case walking up cannot see: a whole panel
         * mounting at once, carrying a live region that already holds its first
         * sentence. The parent it was attached to is not a region, so the upward
         * walk finds nothing and the insertion would be recorded as silence with
         * no evidence of why.
         */
        for (const added of record.addedNodes) {
          if (!(added instanceof Element)) continue
          const inside = [
            ...(added.matches(
              '[role=status],[role=alert],[role=log],[aria-live]'
            )
              ? [added]
              : []),
            ...added.querySelectorAll(
              '[role=status],[role=alert],[role=log],[aria-live]'
            ),
          ]
          for (const element of inside) {
            if (element.closest('[aria-hidden="true"]') !== null) continue
            arrived.add(element)
            touched.add(element)
          }
        }
      }
      for (const region of touched) {
        const key = keyOf(region)
        const text = (region.textContent ?? '').replace(/\s+/g, ' ').trim()
        // Nothing at all is not an utterance: an emptied region is silence.
        if (text === '') {
          lastText.set(key, text)
          continue
        }
        const repeat = lastText.get(key) === text
        lastText.set(key, text)
        log.push({
          at: Date.now() - started,
          region: key,
          text,
          repeat,
          born: arrived.has(region),
        })
      }
    })
    observer.observe(document, {
      subtree: true,
      childList: true,
      characterData: true,
      attributes: true,
    })
  })
}

/**
 * A signed-in browser on a circuit, with its transcript running.
 *
 * The language is pinned for the reason `e2e/live/support/live.ts` gives: every
 * assertion here reads an English sentence out of the catalog, and i18next
 * detects from `navigator.language` when storage is empty.
 */
export async function openPeer(
  browser: Browser,
  options: {
    readonly storageState: string
    readonly path: string
    /** Wait for this before returning. Defaults to the circuit grid. */
    readonly settled?: (page: Page) => Promise<void>
  }
): Promise<Peer> {
  const context = await browser.newContext({
    storageState: options.storageState,
  })
  const page = await context.newPage()
  await pinLanguage(page)
  await installRecorder(page)
  await page.goto(options.path)
  if (options.settled === undefined) {
    await page.getByRole('grid').first().waitFor({ state: 'visible' })
  } else {
    await options.settled(page)
  }
  return {
    context,
    page,
    transcript: () => transcriptOf(page),
    clearTranscript: async () => {
      await page.evaluate(() => {
        const clear = (window as unknown as { __clearUtterances?: () => void })
          .__clearUtterances
        clear?.()
      })
    },
  }
}

/** A peer whose socket runs through a proxy this test can cut. */
export interface PartitionablePeer extends Peer {
  /** Drops the connection, and returns once the client has noticed. */
  readonly cut: () => Promise<void>
  /** Gives it back, and returns once the session is open again. */
  readonly heal: () => Promise<void>
}

/**
 * A peer that can be partitioned, which is the only way to make two writers
 * contest one cell on purpose.
 *
 * `routeWebSocket` with `connectToServer` rather than `context.setOffline`: in
 * Chromium, network emulation gates *new* connections and leaves an established
 * WebSocket on loopback carrying frames, so a scenario built on it edits over a
 * working connection and then asserts convergence — a test that passes without
 * testing. The proxy forwards every frame verbatim in both directions and adds
 * nothing but a pair of scissors.
 */
export async function openPartitionablePeer(
  browser: Browser,
  options: { readonly storageState: string; readonly path: string }
): Promise<PartitionablePeer> {
  const context = await browser.newContext({
    storageState: options.storageState,
  })
  const page = await context.newPage()
  await pinLanguage(page)
  await installRecorder(page)

  let cut = false
  const sockets: WebSocketRoute[] = []
  // `/ws` only: Vite's own HMR socket is on this page too, and proxying it would
  // put this file between the dev server and its client.
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

  await page.goto(options.path)
  await page.getByRole('grid').first().waitFor({ state: 'visible' })

  const reconnecting = page.getByText('Reconnecting to the shared session')
  return {
    context,
    page,
    transcript: () => transcriptOf(page),
    clearTranscript: async () => {
      await page.evaluate(() => {
        const clear = (window as unknown as { __clearUtterances?: () => void })
          .__clearUtterances
        clear?.()
      })
    },
    cut: async () => {
      cut = true
      // 1006 and not a clean close: an abnormal closure is what a lost
      // connection produces.
      await sockets.at(-1)?.close({ code: 1006 })
      await reconnecting.waitFor({ state: 'visible', timeout: 30_000 })
    },
    heal: async () => {
      cut = false
      // The socket that was talking to nobody. Closing it makes the transport
      // try again now rather than at the end of its backoff.
      await sockets.at(-1)?.close({ code: 1006 })
      await reconnecting.waitFor({ state: 'detached', timeout: 60_000 })
    },
  }
}

/** The transcript of any page the recorder was installed on. */
export async function transcriptOf(page: Page): Promise<readonly Utterance[]> {
  return page.evaluate(
    () =>
      (window as unknown as { __utterances?: Utterance[] }).__utterances ?? []
  )
}

/**
 * The subset a screen reader would actually speak.
 *
 * A `born` entry is a region that entered the DOM already holding its sentence,
 * which is the case this project's own `PresenceRoster` header says is
 * "frequently not announced at all". Filtering it out is what turns a transcript
 * of DOM changes into a transcript of speech.
 */
export function spoken(transcript: readonly Utterance[]): readonly Utterance[] {
  return transcript.filter((entry) => !entry.born)
}

/** Everything the roster's own live region said, and nothing else's. */
export function rosterSaid(
  transcript: readonly Utterance[]
): readonly Utterance[] {
  return transcript.filter(
    (entry) => entry.region === 'collab-panel>status|visually-hidden'
  )
}

/** Everything the comment panel's live region said. */
export function commentsSaid(
  transcript: readonly Utterance[]
): readonly Utterance[] {
  return transcript.filter((entry) =>
    entry.region.startsWith('comments-panel>status')
  )
}

/** Everything the deferral panel's live region said. */
export function deferredSaid(
  transcript: readonly Utterance[]
): readonly Utterance[] {
  return transcript.filter((entry) =>
    entry.region.includes('deferred-panel__status')
  )
}

/* ------------------------------------------------------------------ *
 * The accessibility tree, from the browser rather than from the DOM
 * ------------------------------------------------------------------ */

/** One node of Chromium's own accessibility tree. */
export interface AxNode {
  readonly id: string
  readonly childIds: readonly string[]
  readonly role: string
  readonly name: string
  readonly ignored: boolean
}

/**
 * The page's accessibility tree as Chromium computes it.
 *
 * Through CDP rather than by reading the DOM, and that distinction is the whole
 * point of this lens: `aria-hidden` on an ancestor, a `display: none`, a
 * `role="grid"` that discards a paragraph child — every one of those leaves the
 * element in the DOM and takes it out of the tree a screen reader walks. Reading
 * the DOM is how the last run concluded that presence worked.
 */
export async function axTree(page: Page): Promise<readonly AxNode[]> {
  const cdp = await page.context().newCDPSession(page)
  try {
    const { nodes } = (await cdp.send('Accessibility.getFullAXTree')) as {
      nodes: readonly {
        nodeId?: string
        childIds?: readonly string[]
        ignored?: boolean
        role?: { value?: unknown }
        name?: { value?: unknown }
      }[]
    }
    return nodes.map((node) => ({
      id: node.nodeId ?? '',
      childIds: node.childIds ?? [],
      role: typeof node.role?.value === 'string' ? node.role.value : '',
      name: typeof node.name?.value === 'string' ? node.name.value : '',
      ignored: node.ignored === true,
    }))
  } finally {
    await cdp.detach()
  }
}

/**
 * Everything a screen reader would read inside the first node of `role`.
 *
 * Walked rather than read off the node itself, because a live region is not one
 * of the roles that take their accessible name from their contents: `role=status`
 * has an empty name unless it was labelled, and the sentence lives in the
 * `StaticText` children below it. Asking the node for its name is how a
 * reachable region looks unreachable.
 */
export function axTextUnder(
  tree: readonly AxNode[],
  role: string
): string | null {
  const byId = new Map(tree.map((node) => [node.id, node]))
  const root = tree.find((node) => node.role === role && !node.ignored)
  if (root === undefined) return null
  const words: string[] = []
  const walk = (node: AxNode): void => {
    if (node.name !== '' && node.childIds.length === 0) words.push(node.name)
    for (const childId of node.childIds) {
      const child = byId.get(childId)
      if (child !== undefined) walk(child)
    }
  }
  walk(root)
  return words.join(' ')
}

/** Whether the tree holds a node of this role whose name contains `text`. */
export function axHas(
  tree: readonly AxNode[],
  role: string,
  text: string
): boolean {
  return tree.some(
    (node) => !node.ignored && node.role === role && node.name.includes(text)
  )
}

/** Every unignored live region in the tree, with what is inside it. */
export function axLiveRegions(
  tree: readonly AxNode[]
): readonly { readonly role: string; readonly text: string }[] {
  const byId = new Map(tree.map((node) => [node.id, node]))
  const textOf = (root: AxNode): string => {
    const words: string[] = []
    const walk = (node: AxNode): void => {
      if (node.name !== '' && node.childIds.length === 0) words.push(node.name)
      for (const childId of node.childIds) {
        const child = byId.get(childId)
        if (child !== undefined) walk(child)
      }
    }
    walk(root)
    return words.join(' ')
  }
  return tree
    .filter(
      (node) =>
        !node.ignored &&
        (node.role === 'status' || node.role === 'alert' || node.role === 'log')
    )
    .map((node) => ({ role: node.role, text: textOf(node) }))
}
