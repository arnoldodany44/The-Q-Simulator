/**
 * THE EDITOR ROUTE IS THE ONLY THING THAT OPENS A SHARED SESSION.
 *
 * ═══════════════════════════════════════════════════════════════════════
 * WHY THIS FILE EXISTS, AND WHY IT LOOKS LIKE THIS
 *
 * Fase 5 shipped a complete, tested, unreachable feature. The relay was real,
 * `collabSession.ts` spoke its protocol, the roster and the caret layer were
 * written and each had a suite — and nothing in the product imported any of it,
 * so no user action could open a channel and no `CircuitSession` row could ever
 * be written. Every one of those suites was green the whole time, because every
 * one of them drives its own layer directly.
 *
 * That has happened once before in this project: Phase 1 shipped `useSimulation`
 * with no importer, so the editor simulated nothing, and it was found by opening
 * the page. The answer then was the block at the bottom of
 * `CircuitEditor.test.tsx` — "the editor is the only thing that mounts the
 * simulation… so the join is asserted here, where the mounting actually happens"
 * — and this file is the same answer for the session, at the level the session is
 * mounted: the route.
 *
 * So the test renders the *route*, with a stubbed `fetch` that resolves a real
 * circuit and a stubbed `WebSocket` that speaks §8's real frames, and then looks
 * for the five things a person is owed. **Deleting `useCollabSession` from
 * `editor.tsx`, or any one of the four mounts it feeds, turns tests below red.**
 * That is the whole point of it, and it is worth more than any assertion about
 * the layers, which already have their own.
 *
 * ═══════════════════════════════════════════════════════════════════════
 * WHY THE SOCKET IS A GLOBAL STUB AND NOT AN INJECTED PORT
 *
 * `useCollabSession` takes a `createSocket` port, and the temptation is to thread
 * it down from the route so a test can hand one in. That would be a test-only
 * prop on a page, and — worse — it would let the mount pass while the *real* path
 * to a socket was broken: the URL derivation, the `ApiContext` lookup, the
 * `doc.base` condition. Replacing the global constructor exercises all three, and
 * the seam is honest for the same reason `runSocket.ts`'s tests use it.
 */

import { projectCircuit, writeCircuit } from '@qsim/collab'
import { encodeBinaryPayload, encodeFrame } from '@qsim/contract'
import type { ClientFrame, PresenceState, ServerFrame } from '@qsim/contract'
import { act, cleanup, render, screen, within } from '@testing-library/react'
import { createInstance, type i18n as I18n } from 'i18next'
import { I18nextProvider, initReactI18next } from 'react-i18next'
import { MemoryRouter, Route, Routes } from 'react-router'
import { afterEach, describe, expect, it, vi } from 'vitest'
import * as Y from 'yjs'

import enAnalysis from '../i18n/locales/en/analysis.json'
import enCircuits from '../i18n/locales/en/circuits.json'
import enCollab from '../i18n/locales/en/collab.json'
import enCommon from '../i18n/locales/en/common.json'
import enEditor from '../i18n/locales/en/editor.json'
import enErrors from '../i18n/locales/en/errors.json'
import enGallery from '../i18n/locales/en/gallery.json'
import enGates from '../i18n/locales/en/gates.json'
import enSimulation from '../i18n/locales/en/simulation.json'
import { SessionProvider } from '../features/auth'
import {
  TEST_SUPABASE_CONFIG,
  createFakeAuth,
  fakeSession,
} from '../features/auth/testing.js'
import { useCircuitStore } from '../features/circuit-editor/useCircuitStore'
import { useDocumentBinding } from '../features/circuit-storage'
import { ApiProvider, createApiClient, createQueryClient } from '../lib/api'
import {
  TEST_BASE_URL,
  circuitViewPayload,
  jsonResponse,
} from '../lib/api/testing.js'
import { EditorRoute } from './editor'

/** The owner of the fixture circuit, as `circuitDetailPayload` names them. */
const OWNER_ID = 'usr_1'
/**
 * What the session is addressed by.
 *
 * The slug and not the id: §11 leaves UNLISTED out of what an id may reach, so
 * the slug is the only handle that addresses every circuit a viewer can read.
 * The reasoning is at the call site in `editor.tsx`, and the relay resolves
 * either handle to the same document.
 */
const SLUG = circuitViewPayload.circuit.slug

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
  // The store and the binding are module singletons that the route writes to,
  // so a test that left a bound document behind would hand it to the next one.
  useDocumentBinding.getState().release()
  useCircuitStore.getState().reset()
})

/* ── the socket ──────────────────────────────────────────────────────── */

interface FakeSocket {
  readonly url: string
  readonly sent: ClientFrame[]
  onopen: ((event: unknown) => void) | null
  onmessage: ((event: { data: unknown }) => void) | null
  onclose: ((event: { code?: number }) => void) | null
  onerror: ((event: unknown) => void) | null
  close(code?: number): void
  send(data: string): void
}

/**
 * Replaces `globalThis.WebSocket` and hands back every socket the page opened.
 *
 * Nothing here is asynchronous by itself: `open`, `ready` and `joined` are
 * delivered by the test, in the order the relay would, so a sequencing mistake in
 * the page shows up as a missing element rather than as a flake.
 */
function stubSocket(): { readonly opened: FakeSocket[] } {
  const opened: FakeSocket[] = []
  class Stub {
    readonly url: string
    readonly sent: ClientFrame[] = []
    onopen: ((event: unknown) => void) | null = null
    onmessage: ((event: { data: unknown }) => void) | null = null
    onclose: ((event: { code?: number }) => void) | null = null
    onerror: ((event: unknown) => void) | null = null
    constructor(url: string) {
      this.url = url
      opened.push(this)
    }
    send(data: string): void {
      this.sent.push(JSON.parse(data) as ClientFrame)
    }
    close(): void {
      /* the page is going away; nothing to answer */
    }
  }
  vi.stubGlobal('WebSocket', Stub)
  return { opened }
}

/** Walks the socket to `open`, which is where the join handshake starts. */
async function connect(socket: FakeSocket): Promise<void> {
  await act(async () => {
    socket.onopen?.({})
    // The token is fetched per connection, and it is a promise even when the
    // answer is "there is none". Without this the join has not been sent yet.
    await Promise.resolve()
  })
}

function deliver(socket: FakeSocket, frame: ServerFrame): void {
  act(() => {
    socket.onmessage?.({ data: encodeFrame(frame) })
  })
}

const READY: ServerFrame = { type: 'ready', viewer: null, expiresAt: null }

/** A document as the relay would serve one, and the frame that serves it. */
function joinedFrame(
  relay: Y.Doc,
  access: 'read' | 'write' = 'write'
): ServerFrame {
  const projection = projectCircuit(relay)
  return {
    type: 'collab:joined',
    circuitId: SLUG,
    access,
    update: encodeBinaryPayload(Y.encodeStateAsUpdate(relay)),
    vector: encodeBinaryPayload(Y.encodeStateVector(relay)),
    deferred: projection.deferred.length,
    overflow: projection.overflow,
  }
}

function presenceFrame(
  peerId: string,
  state: PresenceState | null
): ServerFrame {
  return { type: 'collab:presence', circuitId: SLUG, peerId, state }
}

function peer(overrides: Partial<PresenceState> = {}): PresenceState {
  return {
    name: 'Ana',
    access: 'write',
    cursor: { qubit: 0, column: 1 },
    selection: [],
    edits: 0,
    ...overrides,
  }
}

/* ── the document the relay serves ───────────────────────────────────── */

/**
 * A document holding two gates that both want (q0, column 0).
 *
 * Built the way it happens: two peers write the same cell while apart, and the
 * merge holds both. `project.ts` then keeps the older claim and defers the other,
 * which is the state the deferral panel exists to show. Distinct client ids are
 * what make the two writes concurrent rather than sequential.
 */
function conflictedDocument(): Y.Doc {
  const first = new Y.Doc()
  first.clientID = 1001
  writeCircuit(
    first,
    {
      schemaVersion: 1,
      qubits: 2,
      clbits: 0,
      operations: [{ id: 'op_1', gate: 'h', targets: [0], column: 0 }],
    },
    { origin: null, baseline: projectCircuit(first) }
  )

  const second = new Y.Doc()
  second.clientID = 2002
  writeCircuit(
    second,
    {
      schemaVersion: 1,
      qubits: 2,
      clbits: 0,
      operations: [{ id: 'op_9', gate: 'x', targets: [0], column: 0 }],
    },
    { origin: null, baseline: projectCircuit(second) }
  )

  const merged = new Y.Doc()
  Y.applyUpdate(merged, Y.encodeStateAsUpdate(first))
  Y.applyUpdate(merged, Y.encodeStateAsUpdate(second))
  return merged
}

/* ── the page ────────────────────────────────────────────────────────── */

function i18nFor(): I18n {
  const instance = createInstance()
  void instance.use(initReactI18next).init({
    lng: 'en',
    fallbackLng: false,
    ns: [
      'common',
      'editor',
      'gates',
      'simulation',
      'analysis',
      'circuits',
      'collab',
      'errors',
      'gallery',
    ],
    defaultNS: 'common',
    resources: {
      en: {
        common: enCommon,
        editor: enEditor,
        gates: enGates,
        simulation: enSimulation,
        analysis: enAnalysis,
        circuits: enCircuits,
        collab: enCollab,
        errors: enErrors,
        gallery: enGallery,
      },
    },
    interpolation: { escapeValue: false },
    react: { useSuspense: false },
  })
  return instance
}

const EMPTY_COMMENTS = {
  threads: [],
  page: 1,
  limit: 20,
  total: 0,
  openCount: 0,
  resolvedCount: 0,
  anchors: {},
  viewerCanComment: false,
}

/**
 * A `fetch` routed by URL rather than by a queue.
 *
 * The editor route is the densest page in the product — the document, its
 * comments, and whatever a panel asks for when it is opened — and their order is
 * React Query's business, not this file's. A queue would make the test depend on
 * it; matching on the path does not.
 */
function routedFetch(): typeof globalThis.fetch {
  return ((url: string) => {
    if (url.includes('/comments')) {
      return Promise.resolve(jsonResponse(EMPTY_COMMENTS))
    }
    if (url.includes(`/circuits/${SLUG}`)) {
      return Promise.resolve(jsonResponse(circuitViewPayload))
    }
    // Anything else is a panel nobody opened. A 404 is what the API would answer
    // for a handle it does not know, and it keeps an unexpected request visible
    // in the failure state rather than silently satisfied.
    return Promise.resolve(jsonResponse({ error: { code: 'NOT_FOUND' } }, 404))
  }) as typeof globalThis.fetch
}

function mount(viewer: string | null = OWNER_ID) {
  const client = createApiClient({
    baseUrl: TEST_BASE_URL,
    fetch: routedFetch(),
    getAccessToken: () => (viewer === null ? null : 'token'),
  })

  return render(
    <I18nextProvider i18n={i18nFor()}>
      <ApiProvider client={client} queryClient={createQueryClient()}>
        <SessionProvider
          runtime={{
            auth: createFakeAuth({
              settled: viewer === null ? null : fakeSession(viewer),
            }),
            config: TEST_SUPABASE_CONFIG,
          }}
          origin="https://qsim.test"
        >
          <MemoryRouter initialEntries={[`/c/${SLUG}`]}>
            <Routes>
              <Route path="/c/:slug" element={<EditorRoute />} />
            </Routes>
          </MemoryRouter>
        </SessionProvider>
      </ApiProvider>
    </I18nextProvider>
  )
}

/** The page with a resolved circuit and a socket that has joined. */
async function joined(
  relay: Y.Doc = new Y.Doc(),
  access: 'read' | 'write' = 'write'
) {
  const sockets = stubSocket()
  const view = mount()
  // The circuit has to have arrived before there is a session to open: it is
  // `doc.base` — what the server answered — that names the channel.
  await screen.findByText(circuitViewPayload.circuit.title)

  const socket = sockets.opened[0]
  expect(
    socket,
    'the editor route opened no socket for a saved circuit'
  ).toBeDefined()
  await connect(socket as FakeSocket)
  deliver(socket as FakeSocket, READY)
  deliver(socket as FakeSocket, joinedFrame(relay, access))
  return { view, socket: socket as FakeSocket }
}

/**
 * One toolbar button, as an element whose `disabled` can be read.
 *
 * `jest-dom`'s matchers are not installed in this project, so the property is
 * read directly rather than asserted through `toBeDisabled`.
 */
function toolbarButton(container: HTMLElement, name: string): HTMLElement {
  return within(container).getByRole('button', { name })
}

/* ══════════════════════════════════════════════════════════════════════ */

describe('the shared session is reachable from the editor route', () => {
  it('opens the channel for the circuit the server answered with', async () => {
    const { socket } = await joined()

    // The URL is derived from the API origin rather than configured separately,
    // and `wss:` for an `https:` API is not cosmetic — a page served over TLS
    // may not open an insecure socket.
    expect(socket.url).toBe('wss://api.example.test/ws')
    expect(socket.sent[0]).toEqual({
      type: 'collab:join',
      /*
       * The slug, not the id. Both resolve to one document on the relay, but only
       * the slug *reaches* an UNLISTED circuit — an id reaches what a listing may
       * show — so joining by id refused a session to exactly the reader §3.4's
       * watchers exist for. See the call site.
       */
      circuitId: SLUG,
    })
  })

  it('opens no channel at all for an unsaved document', async () => {
    const sockets = stubSocket()
    render(
      <I18nextProvider i18n={i18nFor()}>
        <ApiProvider
          client={createApiClient({
            baseUrl: TEST_BASE_URL,
            fetch: routedFetch(),
            getAccessToken: () => null,
          })}
          queryClient={createQueryClient()}
        >
          <SessionProvider
            runtime={{
              auth: createFakeAuth({ settled: null }),
              config: TEST_SUPABASE_CONFIG,
            }}
            origin="https://qsim.test"
          >
            <MemoryRouter initialEntries={['/new']}>
              <Routes>
                <Route path="/new" element={<EditorRoute />} />
              </Routes>
            </MemoryRouter>
          </SessionProvider>
        </ApiProvider>
      </I18nextProvider>
    )

    await screen.findByRole('grid')
    /*
     * The whole degradation promise, asserted where it is decided: `/new` has no
     * id to join, so there is no session, no Y.Doc, no presence heartbeat and no
     * `attachHistory` — the editor is the one that shipped in Phase 0.
     */
    expect(sockets.opened).toEqual([])
  })
})

describe('the presence surface is mounted', () => {
  it('shows who is here, in words, once a peer arrives', async () => {
    const { view, socket } = await joined()
    deliver(socket, presenceFrame('peer_ana', peer()))

    // `PresenceRoster`. Deleting it from `CollabPanel` — or deleting the panel
    // from the route — fails here.
    const roster = view.container.querySelector('.presence-roster')
    expect(roster).not.toBeNull()
    const list = within(roster as HTMLElement)
    expect(
      list.getByText(enCollab.presence.heading_one.replace('{{count}}', '1'))
    ).toBeDefined()
    // Scoped to the roster on purpose: the same name is on the caret over the
    // canvas, and the accessible half of the pair is this one.
    expect(list.getByText('Ana')).toBeDefined()
    expect(
      list.getByText(
        `${enCollab.presence.editing} · ${enCollab.presence.atCell
          .replace('{{qubit}}', '0')
          .replace('{{column}}', '1')}`
      )
    ).toBeDefined()
  })

  it('announces the arrival in a live region that exists before it', async () => {
    const { view, socket } = await joined()

    /*
     * Mounted empty, and that is the requirement: a live region inserted into
     * the DOM together with its first content is frequently never announced.
     */
    expect(
      view.container.querySelector('.collab-panel [role="status"]')
    ).not.toBeNull()

    deliver(socket, presenceFrame('peer_ana', peer()))
    expect(
      within(view.container).getByText(
        enCollab.presence.announce.joined.replace('{{name}}', 'Ana')
      )
    ).toBeDefined()

    deliver(socket, presenceFrame('peer_ana', null))
    expect(
      within(view.container).getByText(
        enCollab.presence.announce.left.replace('{{name}}', 'Ana')
      )
    ).toBeDefined()
  })

  it('draws the caret over the canvas, and nothing when nobody is here', async () => {
    const { view, socket } = await joined()

    // `PresenceCursors` renders no element at all in a solo session, which is
    // the common case and must cost nothing.
    expect(view.container.querySelector('.presence-layer')).toBeNull()

    deliver(socket, presenceFrame('peer_ana', peer()))

    const layer = view.container.querySelector('.presence-layer')
    expect(layer).not.toBeNull()
    // Inside the canvas, in the canvas's own coordinates — the overlay slot.
    expect(layer?.closest('.circuit-canvas')).not.toBeNull()
    expect(
      view.container.querySelector('.presence-mark--cursor')
    ).not.toBeNull()
  })

  /**
   * THE MOUNT THAT NO GATE USED TO PIN.
   *
   * `onCursorMove={collab.setCursor}` was the one of the seven collaboration
   * mounts that could be deleted with every suite in `pnpm verify` still green:
   * the assertion here was `presence.length > 0`, which `channel.announce()`'s own
   * join frame satisfies with no cursor wiring at all, and the fast e2e fixture
   * only pushes frames *into* the page and never reads what it sends. The single
   * test that would have caught it lives in `e2e/live`, which CI excludes.
   *
   * So what is asserted is the *content*: the frame names the cell this reader's
   * grid cursor is actually on. Delete the prop and it is `null`.
   *
   * It also pins the repair to the reporting effect. The position is reported on
   * mount, into whatever callback existed then — and the session does not exist
   * then, because it is opened in an effect after the circuit arrives. The effect
   * therefore re-reports when the callback changes; without that the frame below
   * carries `cursor: null` even with the prop in place, which is what the roster
   * was found saying («not on the grid», about a peer who was editing).
   */
  it('tells the session which cell this reader is looking at', async () => {
    const { socket } = await joined()

    const presence = socket.sent.filter(
      (frame) => frame.type === 'collab:presence'
    )
    /*
     * The outbound half. `channel.announce()` states where this client is as soon
     * as the join lands — a peer that waited for its first movement would be
     * invisible to everybody for up to ten seconds — so one frame is owed here
     * without anybody touching the grid.
     */
    expect(presence.length).toBeGreaterThan(0)
    expect(presence.at(-1)?.state?.cursor).toEqual({ qubit: 0, column: 0 })
  })
})

describe('a watcher may look and not write', () => {
  it('says so, and hides the controls that write', async () => {
    const { view } = await joined(new Y.Doc(), 'read')

    expect(screen.getByText(enCollab.session.readOnly)).toBeDefined()
    /*
     * A drawing decision and never a permission: §11 puts authorisation on the
     * relay, which refuses a `collab:update` from a read-only peer whatever this
     * page drew. What is asserted is that the reader is not invited to make an
     * edit that will be dropped.
     */
    expect(toolbarButton(view.container, enEditor.toolbar.undo)).toHaveProperty(
      'disabled',
      true
    )
    expect(
      toolbarButton(view.container, enEditor.toolbar.compact)
    ).toHaveProperty('disabled', true)
    // And the palette with it, which is where a gate comes from at all.
    expect(
      view.container.querySelectorAll('.gate-palette button[disabled]')
    ).not.toHaveLength(0)
  })

  it('leaves the editor alone while no session has answered', async () => {
    const sockets = stubSocket()
    const view = mount()
    await screen.findByText(circuitViewPayload.circuit.title)
    await connect(sockets.opened[0] as FakeSocket)

    // Connected, not joined: `access` is null, and a socket that is merely slow
    // may not take the editor away from the person using it.
    expect(screen.queryByText(enCollab.session.readOnly)).toBeNull()
    expect(toolbarButton(view.container, enEditor.toolbar.undo)).toHaveProperty(
      'disabled',
      false
    )
  })
})

describe('the deferred operations are shown, and can be resolved', () => {
  it('names what the document holds and the canvas does not', async () => {
    const { view } = await joined(conflictedDocument())

    // The heading, not the live region: both carry the count, and the region is
    // asserted by the sentence it speaks rather than by the one it holds.
    expect(
      view.container.querySelector('.deferred-panel__heading')?.textContent
    ).toBe(enCollab.deferred.heading_one.replace('{{formatted}}', '1'))
    // Nothing was lost, and that is the first thing the panel says.
    expect(
      within(view.container).getByText(enCollab.deferred.hint)
    ).toBeDefined()
    expect(
      within(view.container).getByText(
        enCollab.deferred.reason['column-conflict']
      )
    ).toBeDefined()
  })

  it('offers the repair to a writer, and only the reveal to a watcher', async () => {
    const conflicted = conflictedDocument()
    const writer = await joined(conflicted, 'write')
    expect(
      within(writer.view.container).getByRole('button', {
        name: enCollab.deferred.makeRoom,
      })
    ).toBeDefined()
    cleanup()
    useDocumentBinding.getState().release()
    useCircuitStore.getState().reset()

    const watcher = await joined(conflictedDocument(), 'read')
    expect(
      within(watcher.view.container).queryByRole('button', {
        name: enCollab.deferred.makeRoom,
      })
    ).toBeNull()
    expect(
      within(watcher.view.container).getByRole('button', {
        name: enCollab.deferred.reveal,
      })
    ).toBeDefined()
  })

  it('selects what is in the way, and says that it did', async () => {
    const { view } = await joined(conflictedDocument())

    act(() => {
      within(view.container)
        .getByRole('button', { name: enCollab.deferred.reveal })
        .click()
    })

    /*
     * The blockers are placed operations, so they are on the canvas — and
     * selecting them is invisible to anybody not looking at the pixels, which is
     * why the sentence is owed. The same pair a comment's "show this gate" makes.
     *
     * Compared against whatever survived the merge rather than against a
     * particular id: which of two genuinely concurrent writes keeps the cell is
     * decided by the slot key, which `project.ts` says is arbitrary on purpose,
     * and a test that named one would be asserting one draw of it.
     */
    const placed = useCircuitStore
      .getState()
      .circuit.operations.map((operation) => operation.id)
    expect(placed).toHaveLength(1)
    expect(useCircuitStore.getState().selection).toEqual(placed)
    expect(
      view.container.querySelector('.deferred-panel__status')?.textContent
    ).toBe(enCollab.deferred.announce.revealed_one)
  })

  it('places the held gate once room is made for it', async () => {
    const { view } = await joined(conflictedDocument())

    const before = useCircuitStore.getState().circuit.operations.length
    expect(before).toBe(1)

    act(() => {
      within(view.container)
        .getByRole('button', { name: enCollab.deferred.makeRoom })
        .click()
    })

    /*
     * The point of the whole surface: a repair is an *ordinary edit* through the
     * store (`deferredResolution.ts`), and the projection un-defers the operation
     * by itself because the cell it wanted is now free. Both gates are on the
     * canvas, and the panel has nothing left to list.
     */
    const after = useCircuitStore.getState().circuit
    expect(after.operations.length).toBe(2)
    expect(
      within(view.container).queryByRole('button', {
        name: enCollab.deferred.makeRoom,
      })
    ).toBeNull()

    /*
     * And it still says what happened. This is the one thing a panel that
     * unmounted itself on success would get wrong: the commit that empties the
     * list is the same commit that has something to announce, so a region that
     * left with the list would tell the reader who pressed the button nothing at
     * all.
     */
    expect(
      view.container.querySelector('.deferred-panel__status')?.textContent
    ).toBe(enCollab.deferred.announce.madeRoom)
  })
})

/**
 * Every ending leaves a working editor, which is why none of them is an `alert`:
 * nothing is broken, something is merely no longer shared. What each owes the
 * reader is a sentence — the transport reaches five distinct endings and a session
 * that stopped without saying so is indistinguishable from one that never was.
 */
describe('an ending is said out loud', () => {
  it('says collaboration is switched off when the join is refused for good', async () => {
    const { socket } = await joined()

    deliver(socket, {
      type: 'collab:error',
      circuitId: SLUG,
      // Collaboration switched off on this deployment. Trying again would ask
      // the same question and get the same answer.
      code: 'SIMULATION_UNAVAILABLE',
    })

    /*
     * The *specific* sentence, not the generic one. `session.unavailable` covered
     * four different refusals until `CollabPanel` was taught to read
     * `snapshot.error`: a deployment with collaboration switched off read exactly
     * like a circuit that does not exist, and one of those two says "nothing here
     * will ever be shared" while the other says "not this".
     */
    expect(screen.getByText(enCollab.session.disabled)).toBeDefined()
    expect(screen.queryByText(enCollab.session.unavailable)).toBeNull()
    // And the editor is untouched, which is the whole degradation promise.
    expect(
      screen.getByRole('button', { name: enEditor.toolbar.undo })
    ).toBeDefined()
  })

  it('says a document too large to serve is a document too large to serve', async () => {
    const { socket } = await joined()

    deliver(socket, {
      type: 'collab:error',
      circuitId: SLUG,
      code: 'CIRCUIT_TOO_LARGE',
    })

    expect(screen.getByText(enCollab.session.tooLarge)).toBeDefined()
  })

  it('keeps NOT_FOUND and “not yours to see” indistinguishable, as §11 requires', async () => {
    const { socket } = await joined()

    deliver(socket, {
      type: 'collab:error',
      circuitId: SLUG,
      code: 'NOT_FOUND',
    })

    // The one distinction that must *not* be drawn: §11 conflates "no such
    // circuit" with "not yours", and so does the sentence.
    expect(screen.getByText(enCollab.session.unavailable)).toBeDefined()
  })

  it('says the circuit stopped being this reader’s to open', async () => {
    const { socket } = await joined()

    deliver(socket, {
      type: 'collab:left',
      circuitId: SLUG,
      reason: 'unauthorised',
    })

    expect(screen.getByText(enCollab.session.ended.unauthorised)).toBeDefined()
  })
})
