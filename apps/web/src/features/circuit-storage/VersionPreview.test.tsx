import { emptyCircuit } from '@qsim/schema'
import type { Circuit, Operation } from '@qsim/schema'
import type { CircuitDetail } from '@qsim/contract'
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from '@testing-library/react'
import { createInstance, type i18n as I18n } from 'i18next'
import { I18nextProvider, initReactI18next } from 'react-i18next'
import { afterEach, describe, expect, it, vi } from 'vitest'

import enCircuits from '../../i18n/locales/en/circuits.json'
import enCommon from '../../i18n/locales/en/common.json'
import enEditor from '../../i18n/locales/en/editor.json'
import enErrors from '../../i18n/locales/en/errors.json'
import { SessionProvider } from '../auth'
import {
  TEST_SUPABASE_CONFIG,
  createFakeAuth,
  fakeSession,
} from '../auth/testing.js'
import { ApiProvider, createApiClient, createQueryClient } from '../../lib/api'
import {
  TEST_BASE_URL,
  circuitDetailPayload,
  errorResponse,
  jsonResponse,
  stubFetch,
  type RecordedCall,
} from '../../lib/api/testing.js'
import { useStore } from 'zustand'
import {
  createCircuitStore,
  sameCircuit,
} from '../circuit-editor/useCircuitStore'
import { VersionPreview } from './VersionPreview'
import { createDocumentBinding } from './documentBinding'
import type { DocumentBase } from './documentBinding'
import type { CircuitDocumentView } from './useCircuitDocument.js'
import type { VersionSelection } from './versionParams.js'

/**
 * A past version on screen, and the restore that brings it back.
 *
 * The two properties this suite exists for:
 *
 *   1. **Looking costs nothing.** Opening version 3 must not touch the
 *      document being edited — not its circuit, not its undo history — because
 *      the obvious implementation (`loadCircuit(version)`) silently discards
 *      unsaved work for a glance.
 *   2. **Restoring appends.** Version 3 restored from version 6 becomes
 *      version 7, and the interface says so with both numbers. A test that
 *      only checked "a POST happened" would pass just as well against an
 *      implementation that rewrote history, which is the thing §3.4 forbids.
 *
 * ── The `document` prop is derived, never pinned ──────────────────────────
 *
 * `mount` computes the view from the *live* binding and circuit stores, the
 * way `useCircuitDocument` does in the app. An earlier version of this file
 * handed `VersionPreview` a frozen `base` fixed at version 6, and that one
 * detail hid the defect these tests exist for: a successful restore rebinds
 * the base to the version it just wrote, which is what used to unmount the
 * restore form mid-save and cancel everything that completed it. A frozen prop
 * cannot rebind, so every assertion passed while the browser lost the restore.
 */

afterEach(cleanup)

const SLUG = 'V1StGXR8Z5jdHi6BmyT8a'
const OWNER = 'usr_1'
const STRANGER = 'usr_2'
const CREATED_AT = '2024-05-01T10:00:00.000Z'

function i18nFor(): I18n {
  const instance = createInstance()
  void instance.use(initReactI18next).init({
    lng: 'en',
    fallbackLng: false,
    ns: ['circuits', 'common', 'editor', 'errors'],
    defaultNS: 'circuits',
    resources: {
      en: {
        circuits: enCircuits,
        common: enCommon,
        editor: enEditor,
        errors: enErrors,
      },
    },
    interpolation: { escapeValue: false },
    react: { useSuspense: false },
  })
  return instance
}

function gate(
  id: string,
  name: string,
  targets: readonly number[],
  column: number
): Operation {
  return { id, gate: name, targets: [...targets], column }
}

function circuitOf(operations: readonly Operation[]): Circuit {
  return { ...emptyCircuit(2, 2), operations: [...operations] }
}

/** What version 3 held: one gate. */
const OLD_CIRCUIT = circuitOf([gate('op_1', 'h', [0], 0)])
/** What version 6 holds: that gate and another. */
const LIVE_CIRCUIT = circuitOf([
  gate('op_1', 'h', [0], 0),
  gate('op_2', 'x', [1], 1),
])

const detail: CircuitDetail = {
  ...circuitDetailPayload,
  visibility: 'PRIVATE',
  createdAt: new Date(CREATED_AT),
  updatedAt: new Date(CREATED_AT),
  owner: { id: OWNER, username: 'ada', avatarUrl: null },
  slug: SLUG,
}

function versionResponse(
  versionNum: number,
  circuit: Circuit,
  message: string | null = null
) {
  return {
    version: {
      id: `ver_${versionNum}`,
      versionNum,
      message,
      createdAt: CREATED_AT,
      circuit,
    },
  }
}

/** What the save flow's pre-flight `GET /circuits/:id` answers. */
function latestResponse(versionNum: number, circuit: Circuit) {
  return {
    circuit: { ...circuitDetailPayload, slug: SLUG, owner: detail.owner },
    version: versionResponse(versionNum, circuit).version,
  }
}

/** The version the editing session descends from before any restore. */
const INITIAL_BASE: DocumentBase = {
  circuitId: 'cir_1',
  slug: SLUG,
  versionNum: 6,
  circuit: LIVE_CIRCUIT,
}

/** Everything about the document that does not follow the two stores. */
function boundView(
  overrides: Partial<CircuitDocumentView> = {}
): CircuitDocumentView {
  return {
    slug: SLUG,
    status: 'open',
    paused: false,
    detail,
    base: INITIAL_BASE,
    dirty: false,
    error: null,
    openedWithDraft: false,
    ownedBy: (userId) => userId === OWNER,
    ...overrides,
  }
}

/** The JSON a recorded call carried, as the version route's body shape. */
function writtenBody(call: RecordedCall | undefined): {
  circuit?: Circuit
  message?: string
} {
  const body = call?.init?.body
  if (typeof body !== 'string') throw new Error('that call had no JSON body')
  return JSON.parse(body) as { circuit?: Circuit; message?: string }
}

interface MountOptions {
  readonly responses: readonly unknown[]
  readonly selection?: VersionSelection
  readonly document?: CircuitDocumentView
  readonly userId?: string
  readonly circuit?: Circuit
}

function mount({
  responses,
  selection = { version: 3, compare: null },
  document: doc = boundView(),
  userId = OWNER,
  circuit = LIVE_CIRCUIT,
}: MountOptions) {
  const transport = stubFetch(responses)
  const client = createApiClient({
    baseUrl: TEST_BASE_URL,
    fetch: transport.fetch,
    getAccessToken: () => 'token',
  })
  const store = createCircuitStore(circuit)
  const binding = createDocumentBinding()
  if (doc.base !== null) binding.getState().bind(doc.base)
  const auth = createFakeAuth({ settled: fakeSession(userId) })
  const onSelect = vi.fn<(next: VersionSelection) => void>()

  /**
   * The document view the app computes: `base` from the binding store and
   * `dirty` from comparing it against the circuit store, both live. See the
   * file header on why a frozen prop would make these tests lie.
   */
  function Live() {
    const live = useStore(binding, (state) => state.base)
    const open = useStore(store, (state) => state.circuit)
    const view: CircuitDocumentView = {
      ...doc,
      base: live,
      dirty:
        live === null
          ? open.operations.length > 0
          : !sameCircuit(live.circuit, open),
    }
    return (
      <VersionPreview
        handle={SLUG}
        selection={selection}
        document={view}
        onSelect={onSelect}
        store={store}
        binding={binding}
      />
    )
  }

  const rendered = render(
    <I18nextProvider i18n={i18nFor()}>
      <ApiProvider client={client} queryClient={createQueryClient()}>
        <SessionProvider
          runtime={{ auth, config: TEST_SUPABASE_CONFIG }}
          origin="https://qsim.test"
        >
          <Live />
        </SessionProvider>
      </ApiProvider>
    </I18nextProvider>
  )

  return { ...rendered, transport, store, binding, onSelect }
}

describe('looking at a past version', () => {
  it('says which version it is and that it is not the live document', async () => {
    mount({ responses: [jsonResponse(versionResponse(3, OLD_CIRCUIT))] })

    expect(
      await screen.findByText('You are looking at version 3')
    ).toBeDefined()
    expect(screen.getByText(enCircuits.history.notLive)).toBeDefined()
  })

  it('draws it read-only, with none of the editor’s controls', async () => {
    const { container } = mount({
      responses: [jsonResponse(versionResponse(3, OLD_CIRCUIT))],
    })
    await screen.findByText('You are looking at version 3')

    // Genuinely inert, not merely styled as such: the row controls and the
    // drop targets are absent, so a gate cannot be dropped on history even by
    // somebody who missed the banner.
    expect(container.querySelectorAll('[data-row-remove]')).toHaveLength(0)
    // And the canvas's own "read-only on small screens" line is suppressed:
    // it is about the viewport, and here the reason is entirely different.
    expect(screen.queryByText(enEditor.canvas.readOnly)).toBeNull()
  })

  it('leaves the document being edited exactly where it was', async () => {
    const { store } = mount({
      responses: [jsonResponse(versionResponse(3, OLD_CIRCUIT))],
    })
    await screen.findByText('You are looking at version 3')

    // THE POINT. `loadCircuit` would have replaced this and cleared the undo
    // history — an afternoon of unsaved work, for a glance at the past.
    expect(store.getState().circuit).toEqual(LIVE_CIRCUIT)
  })

  it('shows the version’s own note when it has one', async () => {
    mount({
      responses: [
        jsonResponse(versionResponse(3, OLD_CIRCUIT, 'Before the measurement')),
      ],
    })
    expect(await screen.findByText('Before the measurement')).toBeDefined()
  })

  it('reports a version that cannot be read, naming the version', async () => {
    mount({ responses: [errorResponse('NOT_FOUND', 404)] })

    const alert = await screen.findByRole('alert')
    /*
     * §11 conflates "no such version" with "not yours to see", and this keeps
     * that. What it does not keep is the *subject*: the shared `NOT_FOUND`
     * sentence is written about circuits, and printing it inside the editor for
     * a circuit that is open — its title in the heading, its history beside it
     * — told the reader something they could see was false.
     */
    expect(alert.textContent).toContain(enCircuits.history.versionUnavailable)
    expect(alert.textContent).not.toContain(enErrors.NOT_FOUND)
    expect(alert.textContent).not.toContain('Developer-facing')
  })

  it('still uses the shared sentence for a failure that is not a 404', async () => {
    mount({ responses: [errorResponse('FORBIDDEN', 403)] })

    const alert = await screen.findByRole('alert')
    expect(alert.textContent).toContain(enErrors.FORBIDDEN)
  })
})

describe('comparing two versions', () => {
  it('renders the diff from the older document to the newer one', async () => {
    mount({
      selection: { version: 6, compare: 3 },
      responses: [
        jsonResponse(versionResponse(6, LIVE_CIRCUIT)),
        jsonResponse(versionResponse(3, OLD_CIRCUIT)),
      ],
    })

    expect(
      await screen.findByRole('heading', {
        name: /between version 3 and version 6/u,
      })
    ).toBeDefined()
    // From 3 to 6 is one addition, not one removal: the direction is decided
    // by the version numbers, never by which one was clicked first.
    expect(await screen.findByText(/added on q1, moment 1/u)).toBeDefined()
  })

  it('says the comparison failed rather than showing an empty diff', async () => {
    mount({
      selection: { version: 6, compare: 3 },
      responses: [
        jsonResponse(versionResponse(6, LIVE_CIRCUIT)),
        errorResponse('NOT_FOUND', 404),
      ],
    })

    // Silence here would read as "these two versions are the same", which is
    // a different claim from "the other one could not be opened".
    expect(
      await screen.findByText(enCircuits.history.compareUnavailable)
    ).toBeDefined()
    expect(
      screen.queryByRole('heading', { name: /between version/u })
    ).toBeNull()
  })
})

describe('restoring', () => {
  it('appends a new version and says which number it landed on', async () => {
    const { transport, store } = mount({
      responses: [
        jsonResponse(versionResponse(3, OLD_CIRCUIT)),
        // The save flow's pre-flight: the server is still at version 6.
        jsonResponse(latestResponse(6, LIVE_CIRCUIT)),
        jsonResponse(
          versionResponse(7, OLD_CIRCUIT, 'Restored version 3'),
          201
        ),
        // The invalidation that follows a save refetches the version on
        // screen, which is immutable and answers the same thing.
        jsonResponse(versionResponse(3, OLD_CIRCUIT)),
      ],
    })

    fireEvent.click(
      await screen.findByRole('button', { name: 'Restore version 3' })
    )

    /*
     * THE SENTENCE THIS MILESTONE IS ABOUT: a user who restores version 3
     * ends up on version 7 and can tell that is what happened.
     */
    const done = await screen.findByText(/Version 3 is back/u)
    expect(done.textContent).toContain('version 7')
    expect(done.textContent).toContain('rewritten or removed')

    // The write is an append: a POST to the versions collection carrying the
    // old document. Nothing was updated and nothing was deleted.
    const write = transport.calls[2]
    expect(write?.init?.method).toBe('POST')
    expect(write?.url).toContain(`/circuits/${SLUG}/versions`)
    expect(
      transport.calls.every((call) => call.init?.method !== 'DELETE')
    ).toBe(true)
    expect(transport.calls.every((call) => call.init?.method !== 'PATCH')).toBe(
      true
    )

    // And the editor now holds what was restored, so the next save continues
    // from it rather than from the document that was on screen a moment ago.
    await waitFor(() => {
      expect(store.getState().circuit).toEqual(OLD_CIRCUIT)
    })
  })

  it('carries a note into the history, prefilled and editable', async () => {
    const { transport } = mount({
      responses: [
        jsonResponse(versionResponse(3, OLD_CIRCUIT)),
        jsonResponse(latestResponse(6, LIVE_CIRCUIT)),
        jsonResponse(versionResponse(7, OLD_CIRCUIT), 201),
        jsonResponse(versionResponse(3, OLD_CIRCUIT)),
      ],
    })

    const note = await screen.findByLabelText(
      enCircuits.history.restore.message.label
    )
    // The suggestion is in the language of whoever is restoring; what gets
    // stored is whatever they leave in the box, exactly like any other
    // version message.
    expect((note as HTMLInputElement).value).toBe('Restored version 3')
    fireEvent.change(note, { target: { value: 'Back to the simple one' } })
    fireEvent.click(screen.getByRole('button', { name: 'Restore version 3' }))

    await screen.findByText(/Version 3 is back/u)
    expect(writtenBody(transport.calls[2]).message).toBe(
      'Back to the simple one'
    )
  })

  it('sends the old version’s circuit, unchanged', async () => {
    const { transport } = mount({
      responses: [
        jsonResponse(versionResponse(3, OLD_CIRCUIT)),
        jsonResponse(latestResponse(6, LIVE_CIRCUIT)),
        jsonResponse(versionResponse(7, OLD_CIRCUIT), 201),
        jsonResponse(versionResponse(3, OLD_CIRCUIT)),
      ],
    })

    fireEvent.click(
      await screen.findByRole('button', { name: 'Restore version 3' })
    )
    await screen.findByText(/Version 3 is back/u)

    expect(writtenBody(transport.calls[2]).circuit).toEqual(OLD_CIRCUIT)
  })

  it('warns before replacing edits that were never saved', async () => {
    mount({
      // A document that is genuinely not its base rather than a flag that says
      // so: the panel has to reach the same conclusion the editor would.
      circuit: circuitOf([gate('op_9', 'y', [0], 2)]),
      responses: [jsonResponse(versionResponse(3, OLD_CIRCUIT))],
    })

    expect(
      await screen.findByText(enCircuits.history.restore.dirtyWarning)
    ).toBeDefined()
  })

  it('leaves the editor holding the restored version, and clean against it', async () => {
    /*
     * THE DEFECT THIS FILE MISSED FOR A WHOLE MILESTONE. The server's half was
     * always right — version 7 carries version 3's document — and the client's
     * half did nothing at all: the store kept the pre-restore circuit, the save
     * panel read "edited since version 7", and the next save appended the
     * document the user had just rolled back, as version 8.
     */
    const { store, binding } = mount({
      responses: [
        jsonResponse(versionResponse(3, OLD_CIRCUIT)),
        jsonResponse(latestResponse(6, LIVE_CIRCUIT)),
        jsonResponse(versionResponse(7, OLD_CIRCUIT), 201),
        jsonResponse(versionResponse(3, OLD_CIRCUIT)),
      ],
    })

    fireEvent.click(
      await screen.findByRole('button', { name: 'Restore version 3' })
    )
    await screen.findByText(/Version 3 is back/u)

    await waitFor(() => {
      expect(store.getState().circuit).toEqual(OLD_CIRCUIT)
    })
    const base = binding.getState().base
    expect(base?.versionNum).toBe(7)
    // Clean, not dirty: what the editor holds is what version 7 holds, so the
    // next save has nothing to undo the restore with.
    expect(sameCircuit(base!.circuit, store.getState().circuit)).toBe(true)
  })

  it('does not tell the reader there was nothing to bring back', async () => {
    /*
     * The rebind makes "this is already the circuit you have open" true by
     * construction. Rendering it is a flat contradiction of the button the
     * reader pressed a second earlier, and it used to be the only thing they
     * saw.
     */
    mount({
      responses: [
        jsonResponse(versionResponse(3, OLD_CIRCUIT)),
        jsonResponse(latestResponse(6, LIVE_CIRCUIT)),
        jsonResponse(versionResponse(7, OLD_CIRCUIT), 201),
        jsonResponse(versionResponse(3, OLD_CIRCUIT)),
      ],
    })

    fireEvent.click(
      await screen.findByRole('button', { name: 'Restore version 3' })
    )
    await screen.findByText(/Version 3 is back/u)

    expect(screen.queryByText(/already the circuit you have open/u)).toBeNull()
  })

  it('offers nothing to restore when this is already the open document', async () => {
    mount({
      responses: [jsonResponse(versionResponse(6, LIVE_CIRCUIT))],
      selection: { version: 6, compare: null },
    })

    expect(
      await screen.findByText(/already the circuit you have open/u)
    ).toBeDefined()
    expect(
      screen.queryByRole('button', { name: /^Restore version/u })
    ).toBeNull()
  })

  it('is not offered to somebody who does not own the circuit', async () => {
    mount({
      responses: [jsonResponse(versionResponse(3, OLD_CIRCUIT))],
      userId: STRANGER,
    })
    await screen.findByText('You are looking at version 3')

    /*
     * A convenience and never a check: `POST /circuits/:id/versions` answers
     * 403 for anyone but the owner (§11), and the only reason to hide the
     * button is that one which can only fail is worse than none.
     */
    expect(
      screen.queryByRole('button', { name: /^Restore version/u })
    ).toBeNull()
  })

  it('says so when somebody else saved while the history was open', async () => {
    const { transport } = mount({
      responses: [
        jsonResponse(versionResponse(3, OLD_CIRCUIT)),
        // The pre-flight finds version 9, which this tab has never seen.
        jsonResponse(latestResponse(9, LIVE_CIRCUIT)),
      ],
    })

    fireEvent.click(
      await screen.findByRole('button', { name: 'Restore version 3' })
    )

    const alert = await screen.findByRole('alert')
    expect(alert.textContent).toContain('version 9')
    // Nothing was written: the second call was the read, and there was no
    // third.
    expect(transport.calls).toHaveLength(2)
    expect(
      screen.getByRole('button', { name: enCircuits.history.restore.anyway })
    ).toBeDefined()
  })
})
