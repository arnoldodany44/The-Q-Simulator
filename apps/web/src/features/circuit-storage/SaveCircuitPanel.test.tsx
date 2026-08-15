import { emptyCircuit } from '@qsim/schema'
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from '@testing-library/react'
import { createInstance, type i18n as I18n } from 'i18next'
import { I18nextProvider, initReactI18next } from 'react-i18next'
import { MemoryRouter, useLocation } from 'react-router'
import { afterEach, describe, expect, it } from 'vitest'
import type { CircuitDetail } from '@qsim/contract'
import type { Circuit } from '@qsim/schema'

import { SessionProvider } from '../auth'
import {
  TEST_SUPABASE_CONFIG,
  createFakeAuth,
  fakeSession,
} from '../auth/testing.js'
import enCircuits from '../../i18n/locales/en/circuits.json'
import enCommon from '../../i18n/locales/en/common.json'
import enErrors from '../../i18n/locales/en/errors.json'
import { ApiProvider, createApiClient, createQueryClient } from '../../lib/api'
import {
  TEST_BASE_URL,
  circuitDetailPayload,
  errorResponse,
  jsonResponse,
  stubFetch,
  versionPayload,
} from '../../lib/api/testing.js'
import { createCircuitStore } from '../circuit-editor/useCircuitStore'
import { SaveCircuitPanel } from './SaveCircuitPanel'
import { createDocumentBinding } from './documentBinding'
import type { CircuitDocumentView } from './useCircuitDocument'

/**
 * The save control, from the four places a reader can be standing.
 *
 * The view is handed in as a literal rather than driven through
 * `useCircuitDocument`, which has its own suite: what is under test here is
 * what the control *does* with a document state, and building the state
 * directly is what lets a stale save and a 403 be a two-line setup instead of
 * a choreography of responses.
 */

afterEach(cleanup)

const SLUG = 'V1StGXR8Z5jdHi6BmyT8a'
const OWNER = 'usr_1'

const CATALOGS = {
  en: { circuits: enCircuits, common: enCommon, errors: enErrors },
} as const

function i18nFor(): I18n {
  const instance = createInstance()
  void instance.use(initReactI18next).init({
    lng: 'en',
    fallbackLng: false,
    ns: ['circuits', 'common', 'errors'],
    defaultNS: 'circuits',
    resources: CATALOGS,
    interpolation: { escapeValue: false },
    react: { useSuspense: false },
  })
  return instance
}

const detail: CircuitDetail = {
  ...circuitDetailPayload,
  visibility: 'PRIVATE',
  createdAt: new Date(circuitDetailPayload.createdAt),
  updatedAt: new Date(circuitDetailPayload.updatedAt),
  owner: { id: OWNER, username: 'ada', avatarUrl: null },
  slug: SLUG,
}

/** A `CircuitDocumentView`, defaulting to an unsaved document with content. */
function view(
  overrides: Partial<CircuitDocumentView> = {}
): CircuitDocumentView {
  return {
    slug: null,
    status: 'blank',
    paused: false,
    detail: null,
    base: null,
    dirty: true,
    error: null,
    openedWithDraft: false,
    ownedBy: () => false,
    ...overrides,
  }
}

/** The same view, bound to a saved circuit this viewer owns. */
function boundView(
  base: Circuit,
  versionNum = 1,
  overrides: Partial<CircuitDocumentView> = {}
): CircuitDocumentView {
  return view({
    slug: SLUG,
    status: 'open',
    detail,
    base: { circuitId: 'cir_1', slug: SLUG, versionNum, circuit: base },
    ownedBy: (userId) => userId === OWNER,
    ...overrides,
  })
}

function LocationProbe() {
  const location = useLocation()
  return <p data-testid="path">{location.pathname}</p>
}

interface MountOptions {
  readonly document: CircuitDocumentView
  readonly responses?: readonly unknown[]
  readonly circuit?: Circuit
  readonly session?: 'authenticated' | 'anonymous' | 'loading'
  readonly carried?: boolean
}

function mount({
  document: doc,
  responses = [],
  circuit = emptyCircuit(3),
  session = 'authenticated',
  carried = true,
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

  const auth = createFakeAuth(
    session === 'loading'
      ? {}
      : { settled: session === 'authenticated' ? fakeSession(OWNER) : null }
  )

  const rendered = render(
    <I18nextProvider i18n={i18nFor()}>
      <ApiProvider client={client} queryClient={createQueryClient()}>
        <SessionProvider
          runtime={{ auth, config: TEST_SUPABASE_CONFIG }}
          origin="https://qsim.test"
        >
          <MemoryRouter initialEntries={['/new']}>
            <LocationProbe />
            <SaveCircuitPanel
              document={doc}
              carried={carried}
              store={store}
              binding={binding}
            />
          </MemoryRouter>
        </SessionProvider>
      </ApiProvider>
    </I18nextProvider>
  )

  return { ...rendered, transport, store, binding }
}

/** Opens the disclosure and fills the title, which every save needs. */
async function openForm(title: string): Promise<void> {
  const toggle = await screen.findByRole('button', {
    name: new RegExp('Save', 'u'),
  })
  fireEvent.click(toggle)
  fireEvent.change(await screen.findByLabelText(enCircuits.save.title.label), {
    target: { value: title },
  })
}

describe('a visitor with no account', () => {
  it('is invited to sign in rather than handed a button that can only fail', async () => {
    const { transport } = mount({ document: view(), session: 'anonymous' })

    const link = await screen.findByRole('link', {
      name: enCircuits.save.signIn,
    })
    expect(link.getAttribute('href')).toBe('/sign-in')
    // Phase 0, exactly: nothing was uploaded and nothing was attempted.
    expect(transport.calls).toHaveLength(0)
    expect(screen.getByText(enCircuits.save.status.anonymous)).toBeDefined()
  })

  it('carries the destination in history state, never in the query string', async () => {
    /*
     * §11: an UNLISTED circuit's slug *is* its access control, and `?next=`
     * would copy it into history, into `Referer` and into anything pasted.
     */
    mount({
      document: boundView(emptyCircuit(2)),
      session: 'anonymous',
    })

    const link = await screen.findByRole('link', {
      name: enCircuits.save.signIn,
    })
    expect(link.getAttribute('href')).not.toContain('?')
    expect(link.getAttribute('href')).not.toContain(SLUG)
  })
})

describe('while the session is still being read', () => {
  it('shows neither shape, so nothing wrong flashes on a slow refresh', () => {
    mount({ document: view(), session: 'loading' })

    expect(
      screen.queryByRole('link', { name: enCircuits.save.signIn })
    ).toBeNull()
    expect(screen.queryByRole('button')).toBeNull()
  })
})

describe('saving a circuit for the first time', () => {
  it('creates it, then makes /c/:slug the address', async () => {
    const { transport } = mount({
      document: view(),
      responses: [
        jsonResponse(
          {
            circuit: { ...circuitDetailPayload, slug: SLUG },
            version: versionPayload,
          },
          201
        ),
      ],
    })

    await openForm('Bell pair')
    fireEvent.click(
      screen.getByRole('button', { name: enCircuits.save.submitNew })
    )

    await waitFor(() => {
      expect(screen.getByTestId('path').textContent).toBe(`/c/${SLUG}`)
    })

    expect(transport.calls).toHaveLength(1)
    expect(transport.last().url).toBe(`${TEST_BASE_URL}/api/v1/circuits`)
    expect(transport.lastBody()).toEqual({
      title: 'Bell pair',
      description: null,
      visibility: 'PRIVATE',
      circuit: emptyCircuit(3),
    })
  })

  it('sends the visibility the user chose', async () => {
    const { transport } = mount({
      document: view(),
      responses: [
        jsonResponse(
          { circuit: circuitDetailPayload, version: versionPayload },
          201
        ),
      ],
    })

    await openForm('Bell pair')
    fireEvent.click(screen.getByLabelText(enCircuits.visibility.PUBLIC))
    fireEvent.click(
      screen.getByRole('button', { name: enCircuits.save.submitNew })
    )

    await waitFor(() => {
      expect(transport.calls).toHaveLength(1)
    })
    expect(transport.lastBody()).toMatchObject({ visibility: 'PUBLIC' })
  })

  it('refuses a blank title here rather than letting the API refuse it', async () => {
    const { transport } = mount({ document: view() })

    await openForm('   ')
    fireEvent.click(
      screen.getByRole('button', { name: enCircuits.save.submitNew })
    )

    expect(
      screen.getByText(enCircuits.save.problem['title-required'])
    ).toBeDefined()
    expect(transport.calls).toHaveLength(0)
    // The message is attached to the field, not merely near it (WCAG 3.3.1).
    const field = screen.getByLabelText(enCircuits.save.title.label)
    expect(field.getAttribute('aria-invalid')).toBe('true')
    expect(field.getAttribute('aria-describedby')).not.toBeNull()
  })

  it('never offers a tags field, because the API has nowhere to put one', async () => {
    /*
     * `CreateCircuitBody` declares no `tags`, and a Zod object strips what it
     * does not declare — so a tags input would be typed into, sent, dropped in
     * silence and reported as saved. Tags arrive with the gallery in M1.5.
     */
    mount({ document: view() })
    await openForm('Bell pair')

    expect(screen.queryByLabelText(/tag/iu)).toBeNull()
  })
})

describe('saving a second version', () => {
  it('checks the server is where it was, then appends', async () => {
    const base = emptyCircuit(2)
    const { transport, binding } = mount({
      document: boundView(base, 1),
      circuit: emptyCircuit(4),
      responses: [
        // The pre-flight: still version 1, so the save is safe to send.
        jsonResponse({
          circuit: { ...circuitDetailPayload, slug: SLUG },
          version: { ...versionPayload, versionNum: 1, circuit: base },
        }),
        jsonResponse(
          {
            version: {
              ...versionPayload,
              id: 'ver_2',
              versionNum: 2,
              message: 'grew a qubit',
              circuit: emptyCircuit(4),
            },
          },
          201
        ),
      ],
    })

    await openForm('Bell pair')
    fireEvent.change(screen.getByLabelText(enCircuits.save.message.label), {
      target: { value: 'grew a qubit' },
    })
    fireEvent.click(
      screen.getByRole('button', { name: enCircuits.save.submitVersion })
    )

    await waitFor(() => {
      expect(transport.calls).toHaveLength(2)
    })

    expect(transport.calls[0]?.url).toBe(
      `${TEST_BASE_URL}/api/v1/circuits/${SLUG}`
    )
    expect(transport.calls[1]?.url).toBe(
      `${TEST_BASE_URL}/api/v1/circuits/${SLUG}/versions`
    )
    expect(transport.lastBody()).toEqual({
      circuit: emptyCircuit(4),
      message: 'grew a qubit',
    })

    // The document now descends from what it just wrote, so the next save is
    // measured against version 2 rather than against version 1 forever.
    await waitFor(() => {
      expect(binding.getState().base?.versionNum).toBe(2)
    })
  })

  it('does not append a version when only the title changed', async () => {
    const base = emptyCircuit(2)
    const { transport } = mount({
      document: boundView(base, 1, { dirty: false }),
      circuit: base,
      responses: [
        jsonResponse({
          circuit: { ...circuitDetailPayload, slug: SLUG },
          version: { ...versionPayload, versionNum: 1, circuit: base },
        }),
        jsonResponse({
          circuit: { ...circuitDetailPayload, title: 'Renamed' },
        }),
      ],
    })

    await openForm('Renamed')
    fireEvent.click(
      screen.getByRole('button', { name: enCircuits.save.submitVersion })
    )

    await waitFor(() => {
      expect(transport.calls).toHaveLength(2)
    })
    // The pre-flight, then a PATCH. History is for documents; a rename is not
    // one, which is why `PATCH /circuits/:id` cannot touch the circuit at all.
    expect(transport.last().init?.method).toBe('PATCH')
    expect(transport.lastBody()).toEqual({ title: 'Renamed' })
  })

  it('says so when there is nothing to save', async () => {
    const base = emptyCircuit(2)
    const { transport } = mount({
      document: boundView(base, 1, { dirty: false }),
      circuit: base,
    })

    await openForm(detail.title)
    fireEvent.click(
      screen.getByRole('button', { name: enCircuits.save.submitVersion })
    )

    expect(screen.getByText(enCircuits.save.nothingToSave)).toBeDefined()
    expect(transport.calls).toHaveLength(0)
  })
})

describe('when somebody else saved first', () => {
  const staleSetup = () => {
    const base = emptyCircuit(2)
    return mount({
      document: boundView(base, 1),
      circuit: emptyCircuit(4),
      responses: [
        // The pre-flight finds version 3. This tab started from version 1.
        jsonResponse({
          circuit: { ...circuitDetailPayload, slug: SLUG },
          version: {
            ...versionPayload,
            versionNum: 3,
            circuit: emptyCircuit(9),
          },
        }),
        jsonResponse(
          {
            version: {
              ...versionPayload,
              versionNum: 4,
              circuit: emptyCircuit(4),
            },
          },
          201
        ),
      ],
    })
  }

  it('surfaces the conflict and writes nothing', async () => {
    /*
     * The server would have accepted this save: `POST /circuits/:id/versions`
     * takes no base version and would have made it version 4, on top of a
     * version 3 this tab has never read. Detecting that is the client's job
     * because the browser is the only party that knows where the editor
     * started.
     */
    const { transport } = staleSetup()

    await openForm('Bell pair')
    fireEvent.click(
      screen.getByRole('button', { name: enCircuits.save.submitVersion })
    )

    const alert = await screen.findByRole('alert')
    expect(alert.textContent).toContain('version 1')
    expect(alert.textContent).toContain('version 3')
    // One call, and it was the read. Nothing was appended.
    expect(transport.calls).toHaveLength(1)
    expect(transport.last().init?.method).toBe('GET')
  })

  it('appends on top only when the user says so, keeping both', async () => {
    const { transport, binding } = staleSetup()

    await openForm('Bell pair')
    fireEvent.change(screen.getByLabelText(enCircuits.save.message.label), {
      target: { value: 'mine' },
    })
    fireEvent.click(
      screen.getByRole('button', { name: enCircuits.save.submitVersion })
    )
    await screen.findByRole('alert')

    fireEvent.click(
      screen.getByRole('button', { name: enCircuits.conflict.saveAnyway })
    )

    await waitFor(() => {
      expect(transport.calls).toHaveLength(2)
    })
    expect(transport.last().init?.method).toBe('POST')
    // The note the user typed before the refusal is the one that is sent: a
    // second, stripped-down save would drop it in silence.
    expect(transport.lastBody()).toMatchObject({ message: 'mine' })
    await waitFor(() => {
      expect(binding.getState().base?.versionNum).toBe(4)
    })
  })

  it('can open theirs instead, and says that it discards yours', async () => {
    const { transport, store, binding } = staleSetup()

    await openForm('Bell pair')
    fireEvent.click(
      screen.getByRole('button', { name: enCircuits.save.submitVersion })
    )
    await screen.findByRole('alert')

    fireEvent.click(screen.getByRole('button', { name: /Discard my changes/u }))

    await waitFor(() => {
      expect(store.getState().circuit.qubits).toBe(9)
    })
    // Rebased, so the next save is clean rather than stale all over again.
    expect(binding.getState().base?.versionNum).toBe(3)
    expect(transport.calls).toHaveLength(1)
  })
})

describe('a race the pre-flight could not close', () => {
  it('reports the save that landed on a number it was not promised', async () => {
    const base = emptyCircuit(2)
    mount({
      document: boundView(base, 1),
      circuit: emptyCircuit(4),
      responses: [
        jsonResponse({
          circuit: { ...circuitDetailPayload, slug: SLUG },
          version: { ...versionPayload, versionNum: 1, circuit: base },
        }),
        // Somebody wrote version 2 in the milliseconds after the read, so this
        // save became version 3 rather than version 2.
        jsonResponse(
          {
            version: {
              ...versionPayload,
              versionNum: 3,
              circuit: emptyCircuit(4),
            },
          },
          201
        ),
      ],
    })

    await openForm('Bell pair')
    fireEvent.click(
      screen.getByRole('button', { name: enCircuits.save.submitVersion })
    )

    const alert = await screen.findByRole('alert')
    // The save happened and is not undone — history is append-only. What the
    // user is owed is the fact, not a reversal.
    expect(alert.textContent).toContain('version 3')
    expect(alert.textContent).toContain('Version 2')
  })
})

describe('when the answer changes between the paint and the click', () => {
  it('turns a 403 into the one recovery that works', async () => {
    const base = emptyCircuit(2)
    mount({
      document: boundView(base, 1),
      circuit: emptyCircuit(4),
      responses: [
        jsonResponse({
          circuit: { ...circuitDetailPayload, slug: SLUG },
          version: { ...versionPayload, versionNum: 1, circuit: base },
        }),
        errorResponse('FORBIDDEN', 403),
      ],
    })

    await openForm('Bell pair')
    fireEvent.click(
      screen.getByRole('button', { name: enCircuits.save.submitVersion })
    )

    expect((await screen.findByRole('alert')).textContent).toBe(
      enErrors.FORBIDDEN
    )
    expect(screen.getByText(enCircuits.save.ownershipLost)).toBeDefined()
    // The control now offers the action that can still succeed: a circuit of
    // this account's own.
    expect(
      screen.getByRole('button', { name: enCircuits.save.submitNew })
    ).toBeDefined()
  })

  it('never renders the API developer-facing English', async () => {
    mount({
      document: view(),
      responses: [errorResponse('RATE_LIMITED', 429)],
    })

    await openForm('Bell pair')
    fireEvent.click(
      screen.getByRole('button', { name: enCircuits.save.submitNew })
    )

    const alert = await screen.findByRole('alert')
    expect(alert.textContent).toBe(enErrors.RATE_LIMITED)
    expect(alert.textContent).not.toContain('Developer-facing text')
  })
})

describe('a viewer who does not own the circuit', () => {
  it('is not offered a version append that would be answered with 403', async () => {
    mount({
      document: boundView(emptyCircuit(2), 1, { ownedBy: () => false }),
    })

    // The control offers a circuit of their own instead. Hiding the other one
    // is a convenience (§11): the API is what refuses, and the 403 path above
    // covers the case where the answer changed after this render.
    expect(
      await screen.findByRole('button', { name: enCircuits.save.openNew })
    ).toBeDefined()
    expect(
      screen.queryByRole('button', { name: enCircuits.save.openVersion })
    ).toBeNull()
  })
})

describe('what the status line says about unsaved work', () => {
  const said = (template: string): Promise<HTMLElement> =>
    screen.findByText(template.replace('{{version}}', '4'))

  it('names the version an edit departed from', async () => {
    mount({ document: boundView(emptyCircuit(2), 4) })

    expect(await said(enCircuits.save.status.dirty)).toBeDefined()
  })

  it('warns only when the address bar cannot carry the edit', async () => {
    /*
     * The one case where closing the tab really does lose the work: a circuit
     * past the URL budget gets no `?c=` at all, so the edit exists nowhere but
     * in this tab. See `useUnsavedWork.ts` for why that is the only case.
     */
    mount({ document: boundView(emptyCircuit(2), 4), carried: false })

    expect(await said(enCircuits.save.status.uncarried)).toBeDefined()
  })

  it('is silent about risk once the document matches what is stored', async () => {
    mount({ document: boundView(emptyCircuit(2), 4, { dirty: false }) })

    expect(await said(enCircuits.save.status.clean)).toBeDefined()
  })
})

/**
 * A rejected submit has to reach somebody who cannot see the form.
 *
 * Focus used to follow only a *title* problem, so a description or a note that
 * was too long moved nothing and announced nothing: the red paragraph under
 * the control is text a screen reader never reaches on its own, and the button
 * appeared to do nothing at all. Measured with `document.activeElement` still
 * on "Save circuit" after the submit, and no live region anywhere above the
 * message.
 */
describe('what a rejected field does about focus', () => {
  it('puts the caret on the description when that is what was refused', async () => {
    mount({ document: view({ dirty: true }) })

    await openForm('A fine circuit')
    const description = screen.getByLabelText(enCircuits.save.description.label)
    fireEvent.change(description, { target: { value: 'x'.repeat(4200) } })

    const submit = screen.getByRole('button', {
      name: enCircuits.save.submitNew,
    })
    submit.focus()
    fireEvent.click(submit)

    expect(document.activeElement).toBe(description)
    expect(description.getAttribute('aria-invalid')).toBe('true')
  })

  it('announces the message even when focus cannot move to it', async () => {
    /*
     * The commonest shape of this: the reader is already in the field they got
     * wrong, so `focus()` is a no-op and nothing about the focused element
     * changes at a moment anything is listening. The live region is the
     * backstop.
     */
    mount({ document: view({ dirty: true }) })

    await openForm('')
    screen.getByLabelText(enCircuits.save.title.label).focus()
    fireEvent.click(
      screen.getByRole('button', { name: enCircuits.save.submitNew })
    )

    const alerts = screen
      .getAllByRole('alert')
      .map((node) => node.textContent ?? '')
    expect(alerts).toContain(enCircuits.save.problem['title-required'])
  })
})
