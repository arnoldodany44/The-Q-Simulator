import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from '@testing-library/react'
import { createInstance, type i18n as I18n } from 'i18next'
import { I18nextProvider, initReactI18next } from 'react-i18next'
import { MemoryRouter, Route, Routes } from 'react-router'
import { afterEach, describe, expect, it } from 'vitest'

import enCircuits from '../i18n/locales/en/circuits.json'
import enCollections from '../i18n/locales/en/collections.json'
import enCommon from '../i18n/locales/en/common.json'
import enErrors from '../i18n/locales/en/errors.json'
import enGallery from '../i18n/locales/en/gallery.json'
import { SessionProvider } from '../features/auth'
import {
  TEST_SUPABASE_CONFIG,
  createFakeAuth,
  fakeSession,
} from '../features/auth/testing.js'
import { ApiProvider, createApiClient, createQueryClient } from '../lib/api'
import {
  TEST_BASE_URL,
  circuitDetailPayload,
  errorResponse,
  jsonResponse,
  stubFetch,
} from '../lib/api/testing.js'
import { CollectionRoute } from './collection'

/**
 * A collection page, and the one sentence it exists to say.
 *
 * The server returns the circuits this viewer may see plus a count of the ones
 * it withheld — the filtering happens there, against `listableCircuitFilter`,
 * and nothing on this side may attempt it. What this page owes the reader is
 * to *say* that something was withheld: a collection of five that silently
 * renders two tells them somebody's curation is nearly empty, which is a lie
 * about that person's work. The count discloses that something is there and
 * never what, which is exactly the trade the response shape makes.
 *
 * The owner's controls are asserted as *drawing* decisions only. Every write is
 * authorised on the server against the verified token (§11), so a reader who
 * forges a button reaches a 403 — these tests are about what a page shows, not
 * about what it permits.
 */

afterEach(cleanup)

const CREATED_AT = '2024-05-01T10:00:00.000Z'
const OWNER_ID = '11111111-1111-4111-8111-111111111111'
const STRANGER_ID = '22222222-2222-4222-8222-222222222222'

function i18nFor(): I18n {
  const instance = createInstance()
  void instance.use(initReactI18next).init({
    lng: 'en',
    fallbackLng: false,
    ns: ['collections', 'circuits', 'gallery', 'common', 'errors'],
    defaultNS: 'collections',
    resources: {
      en: {
        collections: enCollections,
        circuits: enCircuits,
        gallery: enGallery,
        common: enCommon,
        errors: enErrors,
      },
    },
    interpolation: { escapeValue: false },
    react: { useSuspense: false },
  })
  return instance
}

function collectionPayload(overrides: Record<string, unknown> = {}) {
  return {
    id: 'col_1',
    title: 'Oracle algorithms',
    description: null,
    visibility: 'PUBLIC',
    itemCount: 3,
    createdAt: CREATED_AT,
    updatedAt: CREATED_AT,
    owner: { id: OWNER_ID, username: 'ada', avatarUrl: null },
    ...overrides,
  }
}

function viewPayload(overrides: Record<string, unknown> = {}) {
  return {
    collection: collectionPayload(),
    items: [circuitDetailPayload],
    withheldItemCount: 2,
    starred: [],
    ...overrides,
  }
}

function mount(responses: readonly unknown[], viewer: string | null = null) {
  const transport = stubFetch(responses)
  const client = createApiClient({
    baseUrl: TEST_BASE_URL,
    fetch: transport.fetch,
    getAccessToken: () => (viewer === null ? null : 'token'),
  })

  const rendered = render(
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
          <MemoryRouter initialEntries={['/collections/col_1']}>
            <Routes>
              <Route path="/collections/:id" element={<CollectionRoute />} />
            </Routes>
          </MemoryRouter>
        </SessionProvider>
      </ApiProvider>
    </I18nextProvider>
  )

  return { ...rendered, transport }
}

describe('a collection page', () => {
  it('shows the circuits the server returned', async () => {
    mount([jsonResponse(viewPayload())])
    expect(await screen.findByText('Bell pair')).toBeTruthy()
  })

  it('says how many items were withheld, and names none of them', async () => {
    const { container } = mount([jsonResponse(viewPayload())])

    await screen.findByText('Bell pair')
    // Rendered as a live region, because the number changes when an owner
    // removes an item and nothing else on screen announces that.
    const summary = container.querySelector('.collection-page__summary')
    expect(summary?.textContent).toContain('Showing 1 of 3 circuits.')
    expect(summary?.textContent).toContain('2 are not visible to you.')
  })

  it('agrees in number with the counts it reports', async () => {
    /*
     * THE DEFECT. Both sentences were single keys with no plural forms in any
     * of the three catalogs, and the `count` option was handed the *formatted*
     * figure — a string, which turns i18next's plural machinery off outright.
     * A collection holding two circuits of which one is visible rendered
     * "Showing 1 of 2 circuits. 1 are not visible to you." in en, and the
     * matching nonsense in es and fr.
     */
    const { container } = mount([
      jsonResponse(
        viewPayload({
          collection: collectionPayload({ itemCount: 1 }),
          withheldItemCount: 1,
          items: [],
        })
      ),
    ])

    await screen.findByText(enCollections.page.empty)
    const summary = container.querySelector('.collection-page__summary')
    expect(summary?.textContent).toContain('Showing 0 of 1 circuit.')
    expect(summary?.textContent).toContain('1 is not visible to you.')
    expect(container.textContent).not.toContain('1 are not visible')
  })

  it('says nothing about withholding when nothing was withheld', async () => {
    const { container } = mount([
      jsonResponse(
        viewPayload({
          collection: collectionPayload({ itemCount: 1 }),
          withheldItemCount: 0,
        })
      ),
    ])

    await screen.findByText('Bell pair')
    const summary = container.querySelector('.collection-page__summary')
    expect(summary?.textContent).not.toContain('not visible')
  })

  it('draws no owner controls for a stranger', async () => {
    mount([jsonResponse(viewPayload())], STRANGER_ID)

    await screen.findByText('Bell pair')
    expect(
      screen.queryByRole('button', { name: enCollections.edit.open })
    ).toBeNull()
    expect(screen.queryByLabelText(enCollections.add.label)).toBeNull()
  })

  it('draws them for the owner', async () => {
    mount(
      [
        jsonResponse(viewPayload()),
        // The picker's own request for the owner's circuits.
        jsonResponse({
          items: [],
          page: 1,
          perPage: 100,
          total: 0,
          totalPages: 1,
        }),
      ],
      OWNER_ID
    )

    expect(
      await screen.findByRole('button', { name: enCollections.edit.open })
    ).toBeTruthy()
  })

  it('does not distinguish a missing collection from a private one', async () => {
    mount([errorResponse('NOT_FOUND', 404)])

    // One sentence for both, because two would confirm that a private
    // collection exists at that address.
    expect(await screen.findByText(enCollections.unknown)).toBeTruthy()
  })

  it('shows the visibility only when it is news', async () => {
    const { container } = mount([
      jsonResponse(
        viewPayload({ collection: collectionPayload({ visibility: 'PUBLIC' }) })
      ),
    ])
    await screen.findByText('Bell pair')
    expect(container.querySelector('.collection-card__visibility')).toBeNull()

    cleanup()

    const unlisted = mount([
      jsonResponse(
        viewPayload({
          collection: collectionPayload({ visibility: 'UNLISTED' }),
        })
      ),
    ])
    await screen.findByText('Bell pair')
    expect(
      unlisted.container.querySelector('.collection-card__visibility')
        ?.textContent
    ).toBe(enCircuits.visibility.UNLISTED)
  })

  it('removes an item through the collection, not the circuit', async () => {
    const { transport } = mount(
      [
        jsonResponse(viewPayload()),
        jsonResponse({
          items: [],
          page: 1,
          perPage: 100,
          total: 0,
          totalPages: 1,
        }),
        jsonResponse({ collection: collectionPayload({ itemCount: 2 }) }),
      ],
      OWNER_ID
    )

    const remove = await screen.findByRole('button', {
      name: 'Remove Bell pair from this collection',
    })
    fireEvent.click(remove)

    await waitFor(() => {
      const call = transport.calls.find(
        (entry) => entry.init?.method === 'DELETE'
      )
      expect(call?.url).toContain('/collections/col_1/items/cir_1')
    })
  })
})
