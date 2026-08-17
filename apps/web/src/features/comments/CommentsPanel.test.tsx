import { CIRCUIT_SCHEMA_VERSION, type Circuit } from '@qsim/schema'
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from '@testing-library/react'
import { createInstance, type i18n as I18n } from 'i18next'
import { I18nextProvider, initReactI18next } from 'react-i18next'
import { MemoryRouter } from 'react-router'
import { afterEach, describe, expect, it } from 'vitest'

import enCollab from '../../i18n/locales/en/collab.json'
import enErrors from '../../i18n/locales/en/errors.json'
import esCollab from '../../i18n/locales/es/collab.json'
import frCollab from '../../i18n/locales/fr/collab.json'
import { SessionProvider } from '../auth'
import {
  TEST_SUPABASE_CONFIG,
  createFakeAuth,
  fakeSession,
} from '../auth/testing.js'
import { ApiProvider, createApiClient, createQueryClient } from '../../lib/api'
import {
  TEST_BASE_URL,
  jsonResponse,
  errorResponse,
  stubFetch,
  type RecordedCall,
} from '../../lib/api/testing.js'
import { createCircuitStore } from '../circuit-editor/useCircuitStore'
import { CommentsPanel } from './CommentsPanel'

/**
 * The panel is three things at once, and each of them is a claim worth testing.
 *
 *   1. **An index.** Every thread names the gate it is about in words, so a
 *      conversation is findable without hunting ninety columns of canvas — and so
 *      that a reader who cannot see the canvas has the same list, not a lesser one.
 *   2. **The place an orphan survives.** A thread whose gate has left the document
 *      is listed, labelled, and never silently re-pointed at a different gate.
 *      That is the milestone's central decision and the assertion below is its
 *      proof at the UI level; `anchors.test.ts` proves the same property against
 *      the real store, one layer down.
 *   3. **A write path.** Posting, replying, resolving and deleting, each with the
 *      request it claims to make — and none of them offered to somebody the server
 *      would refuse, because the response says who may do what.
 *
 * The last block renders the panel in all three languages and applies the
 * shape-based property `e2e/no-raw-keys.spec.ts` applies to routes. It has to be
 * here rather than there: this surface only exists once a listing has been fetched,
 * so no walk of a loaded page reaches it.
 */

afterEach(cleanup)

const HANDLE = 'V1StGXR8Z5jdHi6BmyT8a'
const VIEWER = 'usr_1'
const CREATED_AT = '2026-08-01T10:00:00.000Z'

const CATALOGS = { en: enCollab, es: esCollab, fr: frCollab }

/** Three gates on three wires, one per column. `op_1` is the commented one. */
function threeGates(): Circuit {
  return {
    schemaVersion: CIRCUIT_SCHEMA_VERSION,
    qubits: 3,
    clbits: 0,
    qubitLabels: ['alice', 'q1', 'q2'],
    operations: [
      { id: 'op_1', gate: 'h', targets: [0], column: 0 },
      { id: 'op_2', gate: 'x', targets: [1], column: 1 },
      { id: 'op_3', gate: 'y', targets: [2], column: 2 },
    ],
  }
}

/**
 * One recorded request's JSON body.
 *
 * By index rather than through `transport.lastBody()`, because a successful write
 * is immediately followed by the refetch it invalidated: the *last* call is that
 * GET, and its body is `undefined`.
 */
function bodyOf(call: RecordedCall | undefined): unknown {
  const body = call?.init?.body
  return typeof body === 'string' ? (JSON.parse(body) as unknown) : null
}

function author(overrides: Record<string, unknown> = {}) {
  return {
    id: 'usr_2',
    username: 'beto',
    displayName: 'Beto',
    avatarUrl: null,
    ...overrides,
  }
}

function comment(overrides: Record<string, unknown> = {}) {
  return {
    id: 'cmt_1',
    body: 'This `H` looks redundant.',
    anchorOpId: 'op_1',
    createdAt: CREATED_AT,
    author: author(),
    viewerCanDelete: true,
    ...overrides,
  }
}

function thread(overrides: Record<string, unknown> = {}) {
  return {
    root: comment(),
    replies: [],
    resolvedAt: null,
    resolvedBy: null,
    viewerCanResolve: true,
    viewerCanReply: true,
    ...overrides,
  }
}

function commentPage(overrides: Record<string, unknown> = {}) {
  return {
    threads: [thread()],
    page: 1,
    limit: 20,
    total: 1,
    openCount: 1,
    resolvedCount: 0,
    anchors: { op_1: { open: 1, resolved: 0 } },
    viewerCanComment: true,
    ...overrides,
  }
}

function i18nFor(language: keyof typeof CATALOGS): I18n {
  const instance = createInstance()
  void instance.use(initReactI18next).init({
    lng: language,
    fallbackLng: false,
    ns: ['collab', 'errors'],
    defaultNS: 'collab',
    resources: {
      [language]: { collab: CATALOGS[language], errors: enErrors },
    },
    interpolation: { escapeValue: false },
    react: { useSuspense: false },
  })
  return instance
}

interface MountOptions {
  readonly responses?: readonly unknown[]
  readonly circuit?: Circuit
  readonly language?: keyof typeof CATALOGS
  readonly session?: 'authenticated' | 'anonymous'
}

function mount({
  responses = [jsonResponse(commentPage())],
  circuit = threeGates(),
  language = 'en',
  session = 'authenticated',
}: MountOptions = {}) {
  const transport = stubFetch(responses)
  const client = createApiClient({
    baseUrl: TEST_BASE_URL,
    fetch: transport.fetch,
    getAccessToken: () => (session === 'authenticated' ? 'token' : null),
  })
  const store = createCircuitStore(circuit)
  const auth = createFakeAuth({
    settled: session === 'authenticated' ? fakeSession(VIEWER) : null,
  })

  const rendered = render(
    <I18nextProvider i18n={i18nFor(language)}>
      <ApiProvider client={client} queryClient={createQueryClient()}>
        <SessionProvider
          runtime={{ auth, config: TEST_SUPABASE_CONFIG }}
          origin="https://qsim.test"
        >
          <MemoryRouter initialEntries={[`/c/${HANDLE}`]}>
            <CommentsPanel handle={HANDLE} store={store} />
          </MemoryRouter>
        </SessionProvider>
      </ApiProvider>
    </I18nextProvider>
  )

  return { ...rendered, transport, store }
}

describe('the panel is the index', () => {
  it('names the gate a thread is about, in words', async () => {
    mount()

    // "About H on alice, column 0" — the wire's own label, not `q0`, because a
    // reader who renamed a wire is looking for the name they gave it. Scoped to
    // the thread's own header: the composer says what *it* will attach to, and
    // both sentences legitimately begin the same way.
    await screen.findByText(/looks redundant/)
    const header = document.querySelector('.comment-thread__header')
    const anchor = header?.querySelector('.comment-anchor')
    expect(anchor).not.toBeNull()
    if (anchor === null || anchor === undefined) throw new Error('no anchor')
    expect(anchor.textContent).toContain('H')
    expect(anchor.textContent).toContain('alice')
    expect(anchor.textContent).toContain('0')

    // The gate symbol and the wire name are notation and reach the DOM marked,
    // so a page translator cannot rewrite either (D2).
    const marked = [...anchor.querySelectorAll('[translate="no"]')].map(
      (node) => node.textContent
    )
    expect(marked).toEqual(['H', 'alice'])
  })

  it('carries both counts on the filter, whichever side is showing', async () => {
    mount({
      responses: [
        jsonResponse(commentPage({ openCount: 2, resolvedCount: 5, total: 2 })),
      ],
    })

    // A filter whose other side has no number on it is a filter nobody presses,
    // which is how a resolved thread becomes unfindable in practice.
    expect(await screen.findByLabelText(/Open \(2\)/)).toBeDefined()
    expect(screen.getByLabelText(/Resolved \(5\)/)).toBeDefined()
    expect(screen.getByLabelText(/All \(7\)/)).toBeDefined()
  })

  it('asks for resolved threads and starts again at page one', async () => {
    const { transport } = mount({
      responses: [
        jsonResponse(commentPage({ page: 3 })),
        jsonResponse(commentPage({ threads: [], resolvedCount: 0 })),
      ],
    })

    fireEvent.click(await screen.findByLabelText(/Resolved/))
    await screen.findByText(enCollab.comments.empty.resolved)

    const url = transport.last().url
    expect(url).toContain('state=resolved')
    expect(url).toContain('page=1')
  })

  it('selects the anchored gate when asked to show it', async () => {
    const { store } = mount()

    fireEvent.click(
      await screen.findByRole('button', {
        name: enCollab.comments.thread.reveal,
      })
    )

    // Selection is the "show me": the canvas already draws a ring around one,
    // and the composer then offers to comment on the same gate.
    expect(store.getState().selection).toEqual(['op_1'])
  })
})

describe('a thread whose gate is gone', () => {
  it('is listed, and says its subject is no longer in this document', async () => {
    mount({
      responses: [
        jsonResponse(
          commentPage({
            threads: [thread({ root: comment({ anchorOpId: 'op_missing' }) })],
            anchors: { op_missing: { open: 1, resolved: 0 } },
          })
        ),
      ],
    })

    // Kept and labelled — the third of the three answers, and the only one where
    // the reader is never misled.
    expect(
      await screen.findByText(enCollab.comments.anchor.orphaned)
    ).toBeDefined()
    // What was said is still readable. Hiding it would destroy the value of the
    // feature invisibly.
    expect(screen.getByText(/looks redundant/)).toBeDefined()
    // And the list says so once at the top, for a reader who is skimming.
    expect(
      screen.getByText(/no longer in this document\. It is kept/)
    ).toBeDefined()
  })

  it('offers no way to show a gate that is not there', async () => {
    mount({
      responses: [
        jsonResponse(
          commentPage({
            threads: [thread({ root: comment({ anchorOpId: 'op_missing' }) })],
          })
        ),
      ],
    })

    await screen.findByText(enCollab.comments.anchor.orphaned)
    // A control that scrolled to a neighbouring cell would be the coordinate
    // mistake wearing a button.
    expect(
      screen.queryByRole('button', { name: enCollab.comments.thread.reveal })
    ).toBeNull()
  })
})

describe('writing', () => {
  it('anchors a new comment to the one selected gate', async () => {
    const { transport, store } = mount({
      responses: [
        jsonResponse(commentPage()),
        jsonResponse({ comment: comment({ id: 'cmt_2' }) }),
        jsonResponse(commentPage()),
      ],
    })

    await screen.findByLabelText(enCollab.comments.compose.label)
    store.getState().setSelection(['op_2'])

    fireEvent.change(screen.getByLabelText(enCollab.comments.compose.label), {
      target: { value: 'Why an X here?' },
    })
    fireEvent.click(
      screen.getByRole('button', { name: enCollab.comments.compose.submit })
    )

    await waitFor(() => {
      expect(transport.calls.length).toBeGreaterThan(1)
    })
    const posted = transport.calls[1]
    expect(posted?.init?.method).toBe('POST')
    expect(bodyOf(posted)).toEqual({
      body: 'Why an X here?',
      anchorOpId: 'op_2',
    })
  })

  it('falls back to the circuit when a selection cannot name one gate', async () => {
    const { transport, store } = mount({
      responses: [
        jsonResponse(commentPage()),
        jsonResponse({ comment: comment({ id: 'cmt_2', anchorOpId: null }) }),
        jsonResponse(commentPage()),
      ],
    })

    await screen.findByLabelText(enCollab.comments.compose.label)
    // Two gates selected: a comment about two gates is not representable, and
    // taking the first of them would attach a sentence to a gate nobody meant.
    store.getState().setSelection(['op_1', 'op_2'])
    expect(
      screen.getAllByText(enCollab.comments.anchor.circuit).length
    ).toBeGreaterThan(0)

    fireEvent.change(screen.getByLabelText(enCollab.comments.compose.label), {
      target: { value: 'Nice circuit.' },
    })
    fireEvent.click(
      screen.getByRole('button', { name: enCollab.comments.compose.submit })
    )

    await waitFor(() => {
      expect(transport.calls.length).toBeGreaterThan(1)
    })
    expect(bodyOf(transport.calls[1])).toEqual({ body: 'Nice circuit.' })
  })

  it('sends a reply as a reply and never with an anchor of its own', async () => {
    const { transport } = mount({
      responses: [
        jsonResponse(commentPage()),
        jsonResponse({ comment: comment({ id: 'cmt_3' }) }),
        jsonResponse(commentPage()),
      ],
    })

    fireEvent.click(
      await screen.findByRole('button', {
        name: enCollab.comments.reply.open,
      })
    )
    fireEvent.change(screen.getByLabelText(enCollab.comments.reply.label), {
      target: { value: 'Agreed.' },
    })
    fireEvent.click(
      screen.getByRole('button', { name: enCollab.comments.reply.submit })
    )

    await waitFor(() => {
      expect(transport.calls.length).toBeGreaterThan(1)
    })
    // A reply inherits its root's anchor — that is what a thread is — and the
    // contract refuses a body carrying both.
    expect(bodyOf(transport.calls[1])).toEqual({
      body: 'Agreed.',
      parentId: 'cmt_1',
    })
  })

  it('resolves with PUT and reopens with DELETE', async () => {
    const { transport } = mount({
      responses: [
        jsonResponse(commentPage()),
        jsonResponse({ thread: thread({ resolvedAt: CREATED_AT }) }),
        jsonResponse(
          commentPage({
            threads: [thread({ resolvedAt: CREATED_AT, resolvedBy: author() })],
            openCount: 0,
            resolvedCount: 1,
          })
        ),
      ],
    })

    fireEvent.click(
      await screen.findByRole('button', {
        name: enCollab.comments.thread.resolve,
      })
    )

    await screen.findByText(enCollab.comments.thread.resolvedBadge, undefined, {
      timeout: 2000,
    })
    expect(transport.calls[1]?.init?.method).toBe('PUT')
    expect(transport.calls[1]?.url).toContain('/resolution')
    // Still listed, with a note saying who closed it: "we discussed this and
    // decided" is the value of the feature.
    expect(screen.getByText(/Resolved by Beto/)).toBeDefined()
  })

  it('asks before deleting, and says how many replies would go too', async () => {
    const { transport } = mount({
      responses: [
        jsonResponse(
          commentPage({
            threads: [
              thread({
                replies: [comment({ id: 'cmt_9', body: 'Agreed.' })],
              }),
            ],
          })
        ),
        new Response(null, { status: 204 }),
        jsonResponse(commentPage({ threads: [], openCount: 0, total: 0 })),
      ],
    })

    const [first] = await screen.findAllByRole('button', {
      name: enCollab.comments.comment.delete,
    })
    fireEvent.click(first!)

    // One press does not destroy a row; the second one names what it takes.
    expect(transport.calls).toHaveLength(1)
    const confirm = screen.getByRole('button', {
      name: /Delete this and its 1 reply/,
    })
    fireEvent.click(confirm)

    await screen.findByText(enCollab.comments.empty.open, undefined, {
      timeout: 2000,
    })
    expect(transport.calls[1]?.init?.method).toBe('DELETE')
  })

  it('reports a refused write against the thread it was about', async () => {
    mount({
      responses: [
        jsonResponse(
          commentPage({
            threads: [thread(), thread({ root: comment({ id: 'cmt_2' }) })],
            total: 2,
            openCount: 2,
          })
        ),
        errorResponse('FORBIDDEN', 403),
      ],
    })

    const [first] = await screen.findAllByRole('button', {
      name: enCollab.comments.thread.resolve,
    })
    fireEvent.click(first!)

    const alerts = await screen.findAllByRole('alert', undefined, {
      timeout: 2000,
    })
    // One alert, not one per thread: a shared mutation hook whose error was
    // rendered unconditionally would print the same refusal under all of them.
    expect(alerts).toHaveLength(1)
  })
})

describe('who is offered what', () => {
  it('offers a way in rather than a form that can only fail', async () => {
    mount({
      responses: [jsonResponse(commentPage({ viewerCanComment: false }))],
      session: 'anonymous',
    })

    const link = await screen.findByRole('link', {
      name: enCollab.comments.signIn,
    })
    expect(link.getAttribute('href')).toBe('/sign-in')
    expect(screen.queryByLabelText(enCollab.comments.compose.label)).toBeNull()
  })

  it('says why a signed-in reader still cannot start a thread', async () => {
    mount({
      responses: [jsonResponse(commentPage({ viewerCanComment: false }))],
    })

    // Signed in and refused leaves exactly one reason, and it is said with the
    // number in it: "you cannot comment" alone is indistinguishable from a bug.
    expect(await screen.findByText(/limit of 200 threads/)).toBeDefined()
    expect(screen.queryByLabelText(enCollab.comments.compose.label)).toBeNull()
  })

  it('draws no resolve or delete control the server would refuse', async () => {
    mount({
      responses: [
        jsonResponse(
          commentPage({
            threads: [
              thread({
                root: comment({ viewerCanDelete: false }),
                viewerCanResolve: false,
                viewerCanReply: false,
              }),
            ],
          })
        ),
      ],
    })

    await screen.findByText(/looks redundant/)
    for (const label of [
      enCollab.comments.thread.resolve,
      enCollab.comments.comment.delete,
      enCollab.comments.reply.open,
    ]) {
      expect(screen.queryByRole('button', { name: label })).toBeNull()
    }
  })
})

/**
 * The same property `e2e/no-raw-keys.spec.ts` asserts for every route, applied
 * where that suite cannot reach: a panel that only exists after a request.
 */
const KEY_SHAPE = /^[a-z][a-zA-Z]*(\.[a-zA-Z]+)+$/

describe('every state of the panel is translated', () => {
  it.each(['en', 'es', 'fr'] as const)(
    'renders no raw keys in %s',
    async (language) => {
      const view = mount({
        responses: [
          jsonResponse(
            commentPage({
              threads: [
                thread({
                  replies: [comment({ id: 'cmt_9', body: 'Agreed.' })],
                }),
                thread({
                  root: comment({ id: 'cmt_2', anchorOpId: 'op_missing' }),
                  resolvedAt: CREATED_AT,
                  resolvedBy: author(),
                }),
              ],
              total: 2,
              openCount: 1,
              resolvedCount: 1,
            })
          ),
        ],
        language,
      })

      await screen.findByText(/Agreed\./)

      const raw = [...view.container.querySelectorAll('*')]
        .filter((node) => node.children.length === 0)
        .map((node) => (node.textContent ?? '').trim())
        .filter((text) => text !== '' && KEY_SHAPE.test(text))
      expect(raw).toEqual([])
    }
  )
})
