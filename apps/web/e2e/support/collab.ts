/**
 * A circuit that resolves, and a relay that answers — with no server running.
 *
 * ═══════════════════════════════════════════════════════════════════════
 * WHY THIS FIXTURE HAS TO EXIST FOR THE GUARDRAIL TO REACH THE STRINGS
 *
 * `no-raw-keys.spec.ts` sweeps every address in the route table in all three
 * languages and asserts that none of them paints an i18next key. It runs Vite
 * alone with no API behind it, which is deliberate — a page that cannot load is
 * still a page made entirely of translated strings, and that is the state
 * hardest to remember to translate.
 *
 * The cost of that arrangement is that `/c/:slug` settles into its "no such
 * circuit" sentence, so about seventy strings never painted on any swept address:
 * the whole `collab` namespace, which is the presence roster, the read-only
 * notice, the deferral panel, and every word of the comment panel — all of which
 * exist only once a saved circuit is on screen and, for half of them, only once a
 * session has joined.
 *
 * ── WHAT THIS FIXTURE REACHES, MEASURED, AND WHAT IT DOES NOT ─────────────
 *
 * Forty of the namespace's ninety-three keys, and the honest statement of that
 * matters more than the number: a guardrail whose docstring overstates its reach is
 * how the next person stops looking. Two families are out of reach here and each
 * is covered elsewhere by a component test that mounts all three languages:
 *
 *   - **The session's endings, and the reconnecting and invalid notices.** They
 *     need the transport driven into a state a relay does not volunteer — an
 *     ejection, a refusal, a dropped socket. `CollabPanel.test.tsx` drives all of
 *     them from a `CollabSessionView` literal.
 *   - **The comment compose and reply forms.** They are drawn only for a signed-in
 *     viewer, and this suite has no Supabase behind it: faking a session token in
 *     `localStorage` would tie the guardrail to a project ref out of an `.env`.
 *     `CommentsPanel.test.tsx` mounts them with `session: 'authenticated'`.
 *
 * What is left is exactly what only a *page* can prove: that the route's chunk
 * fetches the `collab` namespace at all, and that the roster, the anchors, the
 * deferral list and the read-only sentence render translated on a real render of
 * the real editor.
 *
 * So this fixture answers three things a real deployment answers, at the network
 * boundary and nowhere else:
 *
 *   - `GET /circuits/:handle` — the document, so the editor opens a saved circuit
 *     rather than the unavailable notice.
 *   - `GET /circuits/:handle/comments` — a listing with a thread in it, an
 *     anchored one, a resolved one and a second page, because the panel's words
 *     are spread across exactly those states.
 *   - `ws://…/ws` — §8's socket, mocked frame for frame, so the join lands and
 *     the roster, the caret layer and the read-only sentence have something to
 *     say.
 *
 * ═══════════════════════════════════════════════════════════════════════
 * WHY IT IS ROUTE INTERCEPTION AND NOT A SERVER
 *
 * Because the property under test is about the *bundle*: which namespaces a
 * route's chunk fetches, and whether every string it renders is in them. A real
 * API would prove the same thing about i18n while adding a database, a Redis and
 * a migration to a suite that currently needs `pnpm exec vite`. It would also
 * make the assertion flaky for reasons that have nothing to do with translation.
 *
 * What a mocked relay cannot prove is convergence, and it does not try to: two
 * peers agreeing on a merged document is asserted by `verification/convergence`
 * against the real bridge, and end to end it needs the real relay. THE NEXT
 * PHASE'S TWO-BROWSER PROOF SHARES THE CIRCUIT HALF OF THIS FILE — the payload
 * and its slug, exported separately for exactly that reason — and replaces the
 * socket half with the running API.
 */

import type { Page, WebSocketRoute } from '@playwright/test'
import {
  META_QUBITS,
  circuitRoots,
  projectCircuit,
  writeCircuit,
} from '@qsim/collab'
import * as Y from 'yjs'

import type { UiLanguage } from './editor'

/** Mirrors `LANGUAGE_STORAGE_KEY` in `src/i18n/index.ts`. See `editor.ts`. */
const LANGUAGE_STORAGE_KEY = 'qsim.language'

/**
 * The circuit the fixture serves, in the shape the API sends it.
 *
 * Two wires, H then CNOT — the Bell pair, which is the circuit every other
 * fixture in this project uses, so a failure here is never about an unusual
 * document. The slug is a real 21-character nanoid shape rather than a word,
 * because `circuitPath` addresses a handle and a slug that could not have been
 * minted would be testing a path the product does not have.
 */
export const SHARED_CIRCUIT = {
  id: 'cir_shared_fixture',
  slug: 'V1StGXR8Z5jdHi6BmyT8a',
  title: 'Bell pair',
  visibility: 'PUBLIC',
  qubitCount: 2,
  gateCount: 2,
  depth: 2,
  starCount: 3,
  viewCount: 12,
  createdAt: '2024-05-01T10:00:00.000Z',
  updatedAt: '2024-05-01T10:00:00.000Z',
  owner: { id: 'usr_ada', username: 'ada', avatarUrl: null },
  description: null,
  tags: [],
  preview: {
    qubits: 2,
    columns: 2,
    truncated: false,
    operations: [
      { gate: 'h', column: 0, targets: [0], controls: [] },
      { gate: 'cx', column: 1, targets: [1], controls: [0] },
    ],
  },
} as const

/** The address the fixture serves. One place, so the sweep names it once. */
export const SHARED_CIRCUIT_ROUTE = `/c/${SHARED_CIRCUIT.slug}`

const CIRCUIT_VERSION = {
  id: 'ver_shared_fixture',
  versionNum: 4,
  message: 'Add the CNOT',
  createdAt: '2024-05-01T10:00:00.000Z',
  circuit: {
    schemaVersion: 1,
    qubits: 2,
    clbits: 0,
    operations: [
      { id: 'op_1', gate: 'h', targets: [0], column: 0 },
      { id: 'op_2', gate: 'cx', targets: [1], controls: [0], column: 1 },
    ],
  },
}

const AUTHOR = {
  id: 'usr_beto',
  username: 'beto',
  displayName: 'Beto',
  avatarUrl: null,
}

/**
 * A listing that exercises the panel's whole vocabulary.
 *
 * One thread anchored to a gate that *is* in the circuit, so `anchor.gate`
 * paints; one anchored to a gate that is not, so `anchor.orphaned` and the
 * orphan notice paint; one about the circuit as a whole, resolved, so
 * `anchor.circuit`, the resolved badge and "resolved by" paint. `total` is past
 * one page so the pager paints, and `viewerCanComment` is true so the compose
 * form does.
 */
const COMMENT_PAGE = {
  threads: [
    {
      root: {
        id: 'cmt_1',
        body: 'Should this be `H` on both wires?',
        /*
         * `op_2`, and it has to be an operation the *projection* keeps.
         *
         * It was `op_1` and that painted the orphan sentence instead of
         * `anchor.gate`: `op_1` is one of the two gates the conflicted document
         * below has fighting over (q0, column 0), and the loser of that fight is
         * deferred — in the document, out of the circuit, and therefore not a
         * gate any anchor can resolve against. `op_2` is uncontested, so this
         * thread paints the sentence the fixture is here to paint.
         */
        anchorOpId: 'op_2',
        createdAt: '2024-05-02T10:00:00.000Z',
        author: AUTHOR,
        viewerCanDelete: true,
      },
      replies: [
        {
          id: 'cmt_2',
          body: 'Only the first — the CNOT spreads it.',
          anchorOpId: null,
          createdAt: '2024-05-02T11:00:00.000Z',
          author: AUTHOR,
          viewerCanDelete: true,
        },
      ],
      resolvedAt: null,
      resolvedBy: null,
      viewerCanResolve: true,
      viewerCanReply: true,
    },
    {
      root: {
        id: 'cmt_3',
        body: 'This gate is gone now.',
        // Nothing in the circuit carries this id, which is the orphan case.
        anchorOpId: 'op_404',
        createdAt: '2024-05-02T12:00:00.000Z',
        author: AUTHOR,
        viewerCanDelete: false,
      },
      replies: [],
      resolvedAt: null,
      resolvedBy: null,
      viewerCanResolve: false,
      viewerCanReply: true,
    },
    {
      root: {
        id: 'cmt_4',
        body: 'Nice and small.',
        anchorOpId: null,
        createdAt: '2024-05-02T13:00:00.000Z',
        author: AUTHOR,
        viewerCanDelete: false,
      },
      replies: [],
      resolvedAt: '2024-05-03T09:00:00.000Z',
      resolvedBy: AUTHOR,
      viewerCanResolve: true,
      viewerCanReply: false,
    },
  ],
  page: 1,
  limit: 3,
  total: 7,
  openCount: 2,
  resolvedCount: 1,
  anchors: { op_2: { open: 1, resolved: 0 } },
  viewerCanComment: true,
}

/** What the peers in the roster look like. */
const PEERS = [
  {
    peerId: 'peer_ana',
    state: {
      name: 'Ana',
      access: 'write',
      cursor: { qubit: 0, column: 1 },
      selection: ['op_1'],
      edits: 2,
    },
  },
  {
    peerId: 'peer_watcher',
    state: {
      // A peer that never signed in. The word for that is the client's, in
      // three languages, which is exactly what this address is sweeping.
      name: null,
      access: 'read',
      cursor: { qubit: 1, column: 0 },
      selection: [],
      edits: 0,
    },
  },
]

/**
 * A document the projection has to defer three different ways, in base64.
 *
 * Three, because `DeferralReason` is five situations rather than one and each has
 * its own sentence — a fixture with a single conflict would sweep a fifth of the
 * panel's vocabulary and leave the rest exactly as unswept as it was.
 *
 *   - **column-conflict.** Two peers write (q0, column 0) while apart, the merge
 *     holds both, and `projectCircuit` keeps the older claim. Distinct client ids
 *     are what make the two writes concurrent rather than sequential.
 *   - **out-of-register.** A gate on q5 in a document whose register says two
 *     wires: one peer narrowed the register while another used the wide part,
 *     which `readRegister` deliberately trusts rather than silently undoing.
 *   - **malformed.** A slot holding no operation at all. Only a hostile or a
 *     future peer produces one, and the panel's answer to it — nothing an edit
 *     can do — is a sentence that has to be translated too.
 *
 * `@qsim/collab` is imported rather than a blob being pasted in, and that is the
 * point: the field names, the Lamport stamp and the slot keys are that package's
 * business, and a fixture that restated them would be a second definition of the
 * document format — living in a test, drifting silently, and taking the deferral
 * panel's whole trilingual surface out of this guardrail on the day it drifted.
 */
function conflictedState(): ServedDocument {
  const merged = new Y.Doc()
  Y.applyUpdate(
    merged,
    Y.encodeStateAsUpdate(
      documentWith(1001, [
        { id: 'op_1', gate: 'h', targets: [0], column: 0 },
        /*
         * Uncontested, and that is its job: `anchor.gate` and `thread.reveal` only
         * paint for a thread whose gate the projection *kept*, and both gates in
         * the contested cell are candidates to be the one that is deferred. This
         * is the gate the comment fixture anchors to.
         */
        { id: 'op_2', gate: 'cx', targets: [1], column: 1 },
        // On a wire the register below withdraws.
        { id: 'op_5', gate: 'x', targets: [5], column: 2 },
      ])
    )
  )
  Y.applyUpdate(
    merged,
    Y.encodeStateAsUpdate(
      documentWith(2002, [{ id: 'op_9', gate: 'x', targets: [0], column: 0 }])
    )
  )

  const roots = circuitRoots(merged)
  merged.transact(() => {
    // Two wires, under a gate that stands on the sixth. Written after the merge
    // so that it is the register's last word rather than a value a peer's own
    // write would supersede.
    roots.meta.set(META_QUBITS, 2)
    // A slot with no fields. `readOperation` cannot make an operation of it, so
    // the projection reports it and never reads it again.
    roots.operations.set('slot_from_the_future', new Y.Map())
  })
  return {
    update: base64Of(Y.encodeStateAsUpdate(merged)),
    vector: base64Of(Y.encodeStateVector(merged)),
  }
}

/** What `collab:joined` carries: the document, and what the relay already has. */
interface ServedDocument {
  readonly update: string
  readonly vector: string
}

/**
 * A session nobody has written to yet, as the relay would describe it.
 *
 * The vector of an empty document is one byte, not zero — which is the whole
 * point of building it rather than writing `''`. See `mockRelay`.
 */
function emptyState(): ServedDocument {
  const doc = new Y.Doc()
  return {
    update: base64Of(Y.encodeStateAsUpdate(doc)),
    vector: base64Of(Y.encodeStateVector(doc)),
  }
}

interface FixtureOperation {
  readonly id: string
  readonly gate: string
  /** Mutable, because that is what `Circuit` declares — see `writeCircuit`. */
  readonly targets: number[]
  readonly column: number
}

function documentWith(
  clientID: number,
  operations: readonly FixtureOperation[]
): Y.Doc {
  const doc = new Y.Doc()
  doc.clientID = clientID
  writeCircuit(
    doc,
    {
      schemaVersion: 1,
      // Wide enough to hold everything being written; narrowed afterwards.
      qubits: 6,
      clbits: 0,
      operations: operations.map((operation) => ({ ...operation })),
    },
    { origin: null, baseline: projectCircuit(doc) }
  )
  return doc
}

/**
 * `Buffer` rather than `encodeBinaryPayload`, and only because this half runs in
 * Node: the contract's helper is written for a browser's `btoa`, and importing it
 * here would pull the whole contract package into the test runner for one line.
 */
function base64Of(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString('base64')
}

export interface SharedCircuitOptions {
  readonly language?: UiLanguage
  /**
   * What the relay grants. `read` paints the watching sentence and puts the
   * editor in read-only; `write` is the owner's session.
   */
  readonly access?: 'read' | 'write'
  /** Whether to mock the socket at all. Off leaves the session connecting. */
  readonly session?: boolean
  /**
   * Whether the served document holds a gate the projection defers.
   *
   * On by default for the sweep, because the deferral panel is the surface whose
   * words exist nowhere else. A run that wants an ordinary join passes false and
   * gets an empty document, which is what a first join really looks like.
   */
  readonly conflicted?: boolean
}

/**
 * Installs the fixture and opens the circuit.
 *
 * Everything is registered before `goto`, because a route installed afterwards
 * races the request it is meant to answer.
 */
export async function openSharedCircuit(
  page: Page,
  options: SharedCircuitOptions = {}
): Promise<void> {
  const {
    language = 'en',
    access = 'read',
    session = true,
    conflicted = true,
  } = options

  await page.addInitScript(
    ([key, value]: [string, string]) => {
      window.localStorage.setItem(key, value)
    },
    [LANGUAGE_STORAGE_KEY, language] as [string, string]
  )

  /*
   * One handler for the whole API rather than one per path, and matched on the
   * *path* rather than on the host: the origin comes from `VITE_API_URL`, which
   * a developer's `.env` may point anywhere, and a fixture that only worked on
   * `localhost:8080` would pass on CI and fail on the machine it was written on.
   */
  await page.route('**/api/v1/**', async (route) => {
    const path = new URL(route.request().url()).pathname
    if (path.endsWith('/comments')) {
      await route.fulfill({ json: COMMENT_PAGE })
      return
    }
    if (path.endsWith(`/circuits/${SHARED_CIRCUIT.slug}`)) {
      await route.fulfill({
        json: {
          circuit: SHARED_CIRCUIT,
          version: CIRCUIT_VERSION,
          starred: false,
        },
      })
      return
    }
    // Anything the fixture does not serve answers the way the API would for a
    // handle nobody minted. §11 conflates "no such thing" with "not yours".
    await route.fulfill({
      status: 404,
      json: {
        error: {
          code: 'NOT_FOUND',
          message: 'Developer-facing text the client must never display.',
          requestId: 'req-fixture',
        },
      },
    })
  })

  if (session) {
    await mockRelay(page, access, conflicted ? conflictedState() : emptyState())
  }

  await page.goto(SHARED_CIRCUIT_ROUTE)
}

/**
 * §8's socket, answered from the browser side.
 *
 * `routeWebSocket` without `connectToServer` is a mock: nothing is forwarded,
 * and this handler *is* the relay. The order is the relay's own — `ready` when
 * the socket opens, `collab:joined` in answer to a `collab:join`, then the
 * roster — because the client is the real client and a frame out of order is a
 * frame it correctly ignores.
 *
 * `state` is what the relay serves in `collab:joined`: an empty document means "a
 * session nobody has written to yet", which the transport answers by publishing
 * what this tab has open; a conflicted document is what makes the deferral panel
 * paint.
 */
async function mockRelay(
  page: Page,
  access: 'read' | 'write',
  state: ServedDocument
): Promise<void> {
  await page.routeWebSocket(/\/ws$/, (ws: WebSocketRoute) => {
    const send = (frame: unknown): void => {
      ws.send(JSON.stringify(frame))
    }

    ws.onMessage((message) => {
      const text = typeof message === 'string' ? message : message.toString()
      const frame = parsedFrame(text)
      if (frame?.type !== 'collab:join') return

      /*
       * Every answer quotes the handle the client asked about, which is the
       * relay's own rule (`ws/session.ts`) and is read out of the frame rather
       * than written down here. That is not tidiness: the editor joins by *slug*
       * — the only handle that addresses an UNLISTED circuit — while a mock that
       * hardcoded the id would send frames the real transport correctly drops,
       * and the whole session would go quiet for a reason that has nothing to do
       * with the page under test. It happened; this is the repair.
       */
      const handle = frame.circuitId ?? SHARED_CIRCUIT.slug

      send({
        type: 'collab:joined',
        circuitId: handle,
        access,
        update: state.update,
        /*
         * The served document's *real* state vector.
         *
         * It was `''`, on the reasoning that a mock with nowhere to put an update
         * should ask for nothing — and the client does not read it that way. An
         * empty string decodes to zero bytes, which is not a state vector, so
         * `Y.encodeStateAsUpdate` threw and the transport reported the one thing
         * it cannot repair: «Some of your changes were too large to send…», on a
         * session that had sent nothing. Every write-access sweep therefore
         * painted a divergence notice as the normal state of a shared session, and
         * anyone screenshotting this page for a design or translation review read
         * a false alarm. The real relay always sends `attached.vector()`, which is
         * at least one byte, so the state was not even reachable in production.
         *
         * The delta the client sends back is ignored, which is fine and is what a
         * mock is for. What matters is that the frame is one the relay could
         * actually have sent.
         */
        vector: state.vector,
        deferred: 0,
        overflow: 0,
      })
      for (const peer of PEERS) {
        send({
          type: 'collab:presence',
          circuitId: handle,
          peerId: peer.peerId,
          state: peer.state,
        })
      }
    })

    // The relay sends this as soon as the socket opens, and again after a
    // successful `authenticate`. This fixture is anonymous, so once.
    send({ type: 'ready', viewer: null, expiresAt: null })
  })
}

/**
 * One client frame, or nothing at all.
 *
 * Anything on this socket may be malformed as far as a mock is concerned — the
 * client is the real client and its frames are well formed, but a parse that
 * throws inside a route handler fails the whole test with a stack that names
 * Playwright rather than the frame.
 */
function parsedFrame(
  text: string
): { type?: string; circuitId?: string } | undefined {
  try {
    return JSON.parse(text) as { type?: string; circuitId?: string }
  } catch {
    return undefined
  }
}
