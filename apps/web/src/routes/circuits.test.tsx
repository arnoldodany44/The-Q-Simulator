import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { createInstance, type i18n as I18n } from 'i18next'
import { I18nextProvider, initReactI18next } from 'react-i18next'
import { MemoryRouter } from 'react-router'
import { afterEach, describe, expect, it } from 'vitest'

import { SessionProvider } from '../features/auth'
import {
  TEST_SUPABASE_CONFIG,
  createFakeAuth,
  fakeSession,
} from '../features/auth/testing.js'
import enCircuits from '../i18n/locales/en/circuits.json'
import enCommon from '../i18n/locales/en/common.json'
import enErrors from '../i18n/locales/en/errors.json'
import frCircuits from '../i18n/locales/fr/circuits.json'
import frCommon from '../i18n/locales/fr/common.json'
import frErrors from '../i18n/locales/fr/errors.json'
import { ApiProvider, createApiClient, createQueryClient } from '../lib/api'
import {
  TEST_BASE_URL,
  circuitDetailPayload,
  errorResponse,
  jsonResponse,
  stubFetch,
} from '../lib/api/testing.js'
import { CircuitsRoute } from './circuits'

/**
 * The page the account menu opens.
 *
 * Still not a gallery — that is M1.5, over a different route with a different
 * authorisation story — so what is asserted is what the page owes today: it
 * says which state it is in, it never renders the API's own English, every
 * card opens the editor at `/c/:slug`, and the pager reaches past the first
 * twenty without inventing an ordering the server did not give it.
 */

afterEach(cleanup)

const CATALOGS = {
  en: { circuits: enCircuits, common: enCommon, errors: enErrors },
  fr: { circuits: frCircuits, common: frCommon, errors: frErrors },
} as const
type Language = keyof typeof CATALOGS

function i18nFor(language: Language): I18n {
  const instance = createInstance()
  void instance.use(initReactI18next).init({
    lng: language,
    fallbackLng: false,
    ns: ['circuits', 'common', 'errors'],
    defaultNS: 'circuits',
    resources: CATALOGS,
    interpolation: { escapeValue: false },
    react: { useSuspense: false },
  })
  return instance
}

function page(items: unknown[], total = items.length, number = 1) {
  return {
    items,
    page: number,
    perPage: 20,
    total,
    totalPages: Math.max(1, Math.ceil(total / 20)),
  }
}

function open(
  responses: readonly unknown[],
  language: Language = 'en',
  path = '/circuits'
) {
  const transport = stubFetch(responses)
  const client = createApiClient({
    baseUrl: TEST_BASE_URL,
    fetch: transport.fetch,
    getAccessToken: () => 'token',
  })
  const auth = createFakeAuth({ settled: fakeSession('usr_1') })

  /*
   * One query client, and it is this app's rather than React Query's default.
   * A second `QueryClientProvider` nested inside would silently take over the
   * hooks and restore the library's three blind retries — which is how a test
   * of a 401 becomes a test of a backoff timer.
   */
  const view = render(
    <I18nextProvider i18n={i18nFor(language)}>
      <ApiProvider client={client} queryClient={createQueryClient()}>
        <SessionProvider
          runtime={{ auth, config: TEST_SUPABASE_CONFIG }}
          origin="https://qsim.test"
        >
          <MemoryRouter initialEntries={[path]}>
            <CircuitsRoute />
          </MemoryRouter>
        </SessionProvider>
      </ApiProvider>
    </I18nextProvider>
  )

  return { ...view, transport }
}

describe('the listing', () => {
  it('says it is working before the answer arrives', () => {
    open([jsonResponse(page([]))])

    expect(screen.getByRole('status').textContent).toBe(enCircuits.loading)
  })

  it('shows each saved circuit with what it is made of', async () => {
    open([
      jsonResponse(
        page([
          circuitDetailPayload,
          { ...circuitDetailPayload, id: 'cir_2', title: 'GHZ', slug: 'ghz' },
        ])
      ),
    ])

    expect(await screen.findByText('Bell pair')).toBeDefined()
    expect(screen.getByText('GHZ')).toBeDefined()
    expect(screen.getAllByRole('listitem')).toHaveLength(2)
    // The enum is the wire's; the word beside it is this app's, in three
    // languages, exactly as it is for every other code the server sends.
    expect(screen.getAllByText('Public')).toHaveLength(2)
    expect(screen.getAllByRole('term')).not.toHaveLength(0)
  })

  it('translates the visibility, which is an enum and not a sentence', async () => {
    open([jsonResponse(page([circuitDetailPayload]))], 'fr')

    expect(await screen.findByText('Bell pair')).toBeDefined()
    expect(screen.getByText(frCircuits.visibility.PUBLIC)).toBeDefined()
  })

  it('offers a way to make the first one when there are none', async () => {
    open([jsonResponse(page([]))])

    expect(await screen.findByText(enCircuits.empty.heading)).toBeDefined()
    expect(
      screen
        .getByRole('link', { name: enCircuits.empty.action })
        .getAttribute('href')
    ).toBe('/new')
  })

  it('opens each circuit in the editor at its own address', async () => {
    open([jsonResponse(page([circuitDetailPayload]))])

    const link = await screen.findByRole('link', { name: 'Bell pair' })
    // The title is the link, so the accessible name of the target is the name
    // the reader was looking for rather than a generic "open".
    expect(link.getAttribute('href')).toBe(`/c/${circuitDetailPayload.slug}`)
  })
})

describe('paging', () => {
  it('says where in the listing the reader is', async () => {
    open([jsonResponse(page([circuitDetailPayload], 42))])

    await screen.findByText('Bell pair')
    const position = screen.getByRole('status')
    expect(position.textContent).toContain('42')
    expect(position.textContent).toContain('1')
  })

  it('asks the API for the next page and records it in the address', async () => {
    const { transport } = open([
      jsonResponse(page([circuitDetailPayload], 42, 1)),
      jsonResponse(
        page([{ ...circuitDetailPayload, id: 'cir_2', title: 'GHZ' }], 42, 2)
      ),
    ])
    await screen.findByText('Bell pair')

    fireEvent.click(screen.getByRole('button', { name: enCircuits.pager.next }))

    expect(await screen.findByText('GHZ')).toBeDefined()
    // The page number travels in the query string, because a page of a listing
    // is a place: Back returns to it and a link to it works.
    expect(transport.last().url).toContain('page=2')
  })

  it('offers no pager when everything fits on one page', async () => {
    open([jsonResponse(page([circuitDetailPayload]))])

    await screen.findByText('Bell pair')
    expect(
      screen.queryByRole('button', { name: enCircuits.pager.next })
    ).toBeNull()
  })

  it('does not offer to go back from the first page', async () => {
    open([jsonResponse(page([circuitDetailPayload], 42))])

    await screen.findByText('Bell pair')
    const previous = screen.getByRole('button', {
      name: enCircuits.pager.previous,
    })
    /*
     * `aria-disabled`, not `disabled`, and the distinction is the defect this
     * pins: a disabled button cannot hold focus, so the keyboard user who
     * pressed Next onto the last page was returned to the document body.
     * Announced as unavailable, still reachable, and inert.
     */
    expect(previous.getAttribute('aria-disabled')).toBe('true')
    expect(previous.hasAttribute('disabled')).toBe(false)
  })

  it('reads the page from the address rather than starting over', async () => {
    const { transport } = open(
      [jsonResponse(page([circuitDetailPayload], 42, 3))],
      'en',
      '/circuits?page=3'
    )

    await screen.findByText('Bell pair')
    expect(transport.last().url).toContain('page=3')
  })

  it('sends a hand-edited page number nowhere near the API', async () => {
    /*
     * `?page=0x10` is page 16 to `Number()` and a 400 to the contract's
     * `pageNumber`, which accepts decimal digits and nothing else. The client
     * falls back to the first page rather than building a request it knows
     * will be refused.
     */
    const { transport } = open(
      [jsonResponse(page([circuitDetailPayload]))],
      'en',
      '/circuits?page=0x10'
    )

    await screen.findByText('Bell pair')
    expect(transport.last().url).toContain('page=1')
  })

  it('offers the way back when a page number outran the listing', async () => {
    // A stale link, or a deletion since. "Open the editor" would be a non
    // sequitur here — the account has circuits, just not on this page.
    open([jsonResponse(page([], 42, 9))], 'en', '/circuits?page=9')

    expect(await screen.findByText(enCircuits.empty.pastTheEnd)).toBeDefined()
    expect(
      screen
        .getByRole('link', { name: enCircuits.empty.firstPage })
        .getAttribute('href')
    ).toBe('/circuits')
  })
})

describe('when the request fails', () => {
  it('renders this app sentence for the code, and offers a retry', async () => {
    open([errorResponse('AUTH_TOKEN_EXPIRED', 401)])

    const alert = await screen.findByRole('alert')

    expect(alert.textContent).toBe(enErrors.AUTH_TOKEN_EXPIRED)
    // The API's own English is developer-facing and must never reach a user.
    expect(alert.textContent).not.toContain('Developer-facing text')
    expect(screen.getByRole('button', { name: enCircuits.retry })).toBeDefined()
  })

  it('asks again when the retry is pressed', async () => {
    /*
     * A 401 rather than a 5xx: `shouldRetryQuery` retries the retryable ones
     * on a backoff of its own, which would make this a test of a timer. What
     * is being asserted is that the button re-runs the query at all.
     */
    const { transport } = open([
      errorResponse('AUTH_TOKEN_EXPIRED', 401),
      jsonResponse(page([circuitDetailPayload])),
    ])

    await screen.findByRole('alert')
    const before = transport.calls.length

    fireEvent.click(screen.getByRole('button', { name: enCircuits.retry }))

    expect(await screen.findByText('Bell pair')).toBeDefined()
    expect(transport.calls.length).toBeGreaterThan(before)
  })
})
