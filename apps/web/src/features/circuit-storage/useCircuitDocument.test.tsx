import { emptyCircuit } from '@qsim/schema'
import { cleanup, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { Circuit } from '@qsim/schema'

import { encode } from '../../lib/circuit-url'
import { ApiProvider, createApiClient, createQueryClient } from '../../lib/api'
import {
  TEST_BASE_URL,
  circuitDetailPayload,
  errorResponse,
  jsonResponse,
  stubFetch,
  versionPayload,
} from '../../lib/api/testing.js'
import { SessionProvider } from '../auth'
import {
  TEST_SUPABASE_CONFIG,
  createFakeAuth,
  fakeSession,
} from '../auth/testing.js'
import type { FakeAuthPort } from '../auth/testing.js'
import { createCircuitStore } from '../circuit-editor/useCircuitStore'
import { createDocumentBinding } from './documentBinding'
import { useCircuitDocument } from './useCircuitDocument'

/**
 * Opening `/c/:slug`, which is the one place data crosses §9's line from
 * React Query into Zustand.
 *
 * Everything asserted here is about *when* that crossing happens, because the
 * ways it can go wrong are all silent: seeding on a refetch throws away an undo
 * history nobody asked it to, seeding over a `?c=` draft replaces the newer
 * document with the older one, not releasing the binding on `/new` makes the
 * next save append a blank canvas to somebody else's circuit, and not
 * releasing it when the *user* changes leaves one person's private circuit on
 * the canvas for the next person at the same machine.
 */

afterEach(cleanup)

const SLUG = 'V1StGXR8Z5jdHi6BmyT8a'

/** A circuit distinguishable from the store's default by its qubit count. */
function saved(qubits: number): Circuit {
  return emptyCircuit(qubits)
}

function payload(circuit: Circuit, versionNum = 1) {
  return {
    circuit: circuitDetailPayload,
    version: { ...versionPayload, versionNum, circuit },
    // `GET /circuits/:id` answers the viewer's own star beside the document
    // from M1.5b. Nothing in this file reads it; the response would not parse
    // without it.
    starred: false,
  }
}

interface Harness {
  readonly store: ReturnType<typeof createCircuitStore>
  readonly binding: ReturnType<typeof createDocumentBinding>
  readonly transport: ReturnType<typeof stubFetch>
  readonly queryClient: ReturnType<typeof createQueryClient>
  readonly auth: FakeAuthPort
}

function open(
  slug: string | null,
  responses: readonly unknown[],
  harness?: Partial<Harness>
) {
  const store = harness?.store ?? createCircuitStore()
  const binding = harness?.binding ?? createDocumentBinding()
  const transport = harness?.transport ?? stubFetch(responses)
  const queryClient = harness?.queryClient ?? createQueryClient()
  const auth =
    harness?.auth ?? createFakeAuth({ settled: fakeSession('user-a') })
  const client = createApiClient({
    baseUrl: TEST_BASE_URL,
    fetch: transport.fetch,
    getAccessToken: () => 'token',
  })

  function Probe() {
    const view = useCircuitDocument({ slug, store, binding })
    return (
      <dl>
        <dt>status</dt>
        <dd data-testid="status">{view.status}</dd>
        <dt>dirty</dt>
        <dd data-testid="dirty">{String(view.dirty)}</dd>
        <dt>version</dt>
        <dd data-testid="version">{String(view.base?.versionNum ?? 'none')}</dd>
        <dt>qubits</dt>
        <dd data-testid="qubits">{String(view.base?.circuit.qubits ?? 0)}</dd>
      </dl>
    )
  }

  const rendered = render(
    <ApiProvider client={client} queryClient={queryClient}>
      <SessionProvider
        runtime={{ auth, config: TEST_SUPABASE_CONFIG }}
        origin="https://qsim.test"
      >
        <Probe />
      </SessionProvider>
    </ApiProvider>
  )

  return { ...rendered, store, binding, transport, queryClient, auth }
}

const statusIs = async (value: string): Promise<void> => {
  await waitFor(() => {
    expect(screen.getByTestId('status').textContent).toBe(value)
  })
}

beforeEach(() => {
  window.history.replaceState(null, '', '/')
})

describe('opening a saved circuit', () => {
  it('loads the stored version into the editor, once', async () => {
    const harness = open(SLUG, [jsonResponse(payload(saved(5)))])

    await statusIs('open')
    expect(harness.store.getState().circuit.qubits).toBe(5)
    expect(screen.getByTestId('version').textContent).toBe('1')
    expect(screen.getByTestId('dirty').textContent).toBe('false')
  })

  it('says it is still loading rather than painting the wrong document', () => {
    // Nothing queued resolves synchronously, so this is the first frame.
    open(SLUG, [jsonResponse(payload(saved(5)))])

    expect(screen.getByTestId('status').textContent).toBe('loading')
  })

  it('leaves the editor alone when the same circuit arrives again', async () => {
    /*
     * The defect this exists for: a save invalidates the detail, React Query
     * refetches, and a hook that copied server data into the store on arrival
     * would call `loadCircuit` — which clears the undo history. The user
     * presses Save and loses every step they could have undone.
     */
    const harness = open(SLUG, [
      jsonResponse(payload(saved(5))),
      jsonResponse(payload(saved(5))),
    ])
    await statusIs('open')

    harness.store.getState().placeGate('h', [0], 0)
    const edited = harness.store.getState().circuit
    expect(harness.store.getState().undo().ok).toBe(true)
    harness.store.getState().redo()

    await harness.queryClient.refetchQueries()

    expect(harness.store.getState().circuit).toEqual(edited)
    // Still one step to undo: the refetch did not clear the history.
    expect(harness.store.getState().undo().ok).toBe(true)
  })

  it('counts an edit against the version it was seeded from', async () => {
    const harness = open(SLUG, [jsonResponse(payload(saved(5)))])
    await statusIs('open')

    harness.store.getState().placeGate('h', [0], 0)

    await waitFor(() => {
      expect(screen.getByTestId('dirty').textContent).toBe('true')
    })
    // The base does not move with the edit — that is what makes a stale save
    // detectable at all.
    expect(screen.getByTestId('version').textContent).toBe('1')
  })

  it('answers a slug it may not read with one state, not two', async () => {
    // §11 conflates "no such circuit" with "not yours to see" on purpose, and
    // the client must not try to tell them apart.
    open(SLUG, [errorResponse('NOT_FOUND', 404)])

    await statusIs('unavailable')
  })
})

describe('an unsaved edit in the address bar', () => {
  it('outranks the stored version rather than being replaced by it', async () => {
    /*
     * What a reload in the middle of editing looks like: `/c/abc?c=…` where the
     * parameter is newer than anything the server has. Seeding over it would
     * throw away the newer of the two documents to show the older.
     */
    const draft = saved(7)
    window.history.replaceState(null, '', `/c/${SLUG}?c=${encode(draft)}`)

    const store = createCircuitStore(draft)
    const harness = open(SLUG, [jsonResponse(payload(saved(5)))], { store })

    await statusIs('open')
    expect(harness.store.getState().circuit.qubits).toBe(7)
    // The server's version still becomes the base, so the editor knows both
    // that it is dirty and which version it descends from.
    expect(screen.getByTestId('qubits').textContent).toBe('5')
    expect(screen.getByTestId('dirty').textContent).toBe('true')
  })
})

describe('a background refetch that fails', () => {
  it('leaves an open document open rather than calling it unavailable', async () => {
    /*
     * A save succeeds, the invalidation that follows it does not — and the
     * document is still open, still saved, still exactly what the save panel
     * says it is. Reading the error before the binding put a red "that circuit
     * cannot be opened, start a new one" alert above a working editor.
     */
    const harness = open(SLUG, [
      jsonResponse(payload(saved(5))),
      errorResponse('NOT_FOUND', 404),
    ])
    await statusIs('open')

    await harness.queryClient.refetchQueries()

    expect(screen.getByTestId('status').textContent).toBe('open')
    expect(harness.store.getState().circuit.qubits).toBe(5)
  })
})

describe('a second user at the same machine', () => {
  it('takes the previous user`s bound circuit off the canvas', async () => {
    const auth = createFakeAuth({ settled: fakeSession('user-a') })
    const harness = open(SLUG, [jsonResponse(payload(saved(5)))], { auth })
    await statusIs('open')
    expect(harness.store.getState().circuit.qubits).toBe(5)

    // A leaves, B arrives. The editor is not behind a guard, so nothing here
    // unmounts and nothing else would empty it.
    auth.emit('SIGNED_OUT', null)
    auth.emit('SIGNED_IN', fakeSession('user-b'))

    await waitFor(() => {
      expect(harness.binding.getState().base).toBeNull()
    })
    expect(harness.store.getState().circuit.qubits).not.toBe(5)
  })

  it('keeps an unsaved draft, which is the reader`s own work', async () => {
    const auth = createFakeAuth({ settled: null })
    const draft = saved(7)
    const store = createCircuitStore(draft)
    const harness = open(null, [], { auth, store })

    // The anonymous "sign in to save this" flow: no binding, so the document
    // on screen came from nobody's account and losing it would lose the work
    // the sign-in was for.
    auth.emit('SIGNED_IN', fakeSession('user-b'))

    await waitFor(() => {
      expect(screen.getByTestId('status').textContent).toBe('blank')
    })
    expect(harness.store.getState().circuit.qubits).toBe(7)
  })

  it('does not fire on the first resolution of a page load', async () => {
    const auth = createFakeAuth()
    const store = createCircuitStore(saved(7))
    const harness = open(null, [], { auth, store })

    // `loading` → `authenticated` is this tab finding out who is signed in,
    // not a change of user, and treating it as one would empty the canvas on
    // every hard refresh.
    auth.settle(fakeSession('user-a'))
    await waitFor(() => {
      expect(screen.getByTestId('status').textContent).toBe('blank')
    })
    expect(harness.store.getState().circuit.qubits).toBe(7)
  })
})

describe('leaving for a new document', () => {
  it('releases the binding and clears the canvas', async () => {
    const store = createCircuitStore()
    const binding = createDocumentBinding()
    const first = open(SLUG, [jsonResponse(payload(saved(5)))], {
      store,
      binding,
    })
    await statusIs('open')
    expect(binding.getState().base).not.toBeNull()

    first.unmount()
    open(null, [], { store, binding })

    /*
     * Both halves matter. Without the release, the first save from `/new`
     * would append this blank canvas to the circuit the user just left.
     * Without the reset, `/new` would show that circuit and offer to save it
     * again, as a duplicate.
     */
    expect(binding.getState().base).toBeNull()
    expect(store.getState().circuit.qubits).not.toBe(5)
    expect(screen.getByTestId('status').textContent).toBe('blank')
  })
})
