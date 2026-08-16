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

import enCircuits from '../i18n/locales/en/circuits.json'
import enCommon from '../i18n/locales/en/common.json'
import enErrors from '../i18n/locales/en/errors.json'
import enGallery from '../i18n/locales/en/gallery.json'
import { SessionProvider } from '../features/auth'
import {
  TEST_SUPABASE_CONFIG,
  createFakeAuth,
} from '../features/auth/testing.js'
import { ApiProvider, createApiClient, createQueryClient } from '../lib/api'
import {
  TEST_BASE_URL,
  circuitDetailPayload,
  errorResponse,
  jsonResponse,
  stubFetch,
} from '../lib/api/testing.js'
import { GalleryRoute } from './gallery'

/**
 * The gallery as a reader meets it.
 *
 * What is asserted here is the part that is *not* the happy path, because the
 * happy path is a list of cards and the rest is where a listing goes wrong:
 *
 *   - an empty gallery on a new deployment must invite the first circuit
 *     rather than looking broken, and must not say "no results" about a
 *     database with nothing in it;
 *   - an empty *search* is a different sentence with a different way out;
 *   - a failure must say something and offer a retry;
 *   - "show more" must append rather than replace, and must announce that it
 *     did — a listing that grows in silence is a listing a screen-reader user
 *     cannot follow.
 *
 * The reader here is anonymous, which is the gallery's ordinary case: it is
 * `auth: 'optional'` on the server precisely so the front door works before
 * anybody has signed up.
 */

afterEach(cleanup)

function i18nFor(): I18n {
  const instance = createInstance()
  void instance.use(initReactI18next).init({
    lng: 'en',
    fallbackLng: false,
    ns: ['gallery', 'circuits', 'common', 'errors'],
    defaultNS: 'gallery',
    resources: {
      en: {
        gallery: enGallery,
        circuits: enCircuits,
        common: enCommon,
        errors: enErrors,
      },
    },
    interpolation: { escapeValue: false },
    react: { useSuspense: false },
  })
  return instance
}

function cardPayload(overrides: Record<string, unknown> = {}) {
  return { ...circuitDetailPayload, ...overrides }
}

function pagePayload(
  items: Record<string, unknown>[],
  nextCursor: string | null = null
) {
  return { items, nextCursor, limit: 20, starred: [] }
}

function mount(responses: readonly unknown[], entry = '/gallery') {
  const transport = stubFetch(responses)
  const client = createApiClient({
    baseUrl: TEST_BASE_URL,
    fetch: transport.fetch,
    getAccessToken: () => null,
  })

  const rendered = render(
    <I18nextProvider i18n={i18nFor()}>
      <ApiProvider client={client} queryClient={createQueryClient()}>
        <SessionProvider
          runtime={{
            auth: createFakeAuth({ settled: null }),
            config: TEST_SUPABASE_CONFIG,
          }}
          origin="https://qsim.test"
        >
          <MemoryRouter initialEntries={[entry]}>
            <GalleryRoute />
          </MemoryRouter>
        </SessionProvider>
      </ApiProvider>
    </I18nextProvider>
  )

  return { ...rendered, transport }
}

describe('the gallery', () => {
  it('lists a circuit with its counts and its drawing', async () => {
    const { container } = mount([
      jsonResponse(pagePayload([cardPayload({ title: 'Bell pair' })])),
    ])

    expect(await screen.findByText('Bell pair')).toBeTruthy()
    // The thumbnail comes from the listing's own response — no second request
    // per card, which is what the preview column exists to make true.
    expect(container.querySelector('.circuit-thumbnail')).not.toBeNull()
  })

  it('makes one request for the page, whatever is on it', async () => {
    const { transport } = mount([
      jsonResponse(
        pagePayload([
          cardPayload({ id: 'cir_1', slug: 'aaaaaaaaaaaaaaaaaaaaa' }),
          cardPayload({ id: 'cir_2', slug: 'bbbbbbbbbbbbbbbbbbbbb' }),
          cardPayload({ id: 'cir_3', slug: 'ccccccccccccccccccccc' }),
        ])
      ),
    ])

    await screen.findAllByRole('listitem')
    expect(transport.calls).toHaveLength(1)
  })

  it('invites the first circuit when nothing has been published', async () => {
    // The state a new deployment is in. "No results" here would tell the one
    // person who could fix it exactly nothing.
    mount([jsonResponse(pagePayload([]))])

    expect(
      await screen.findByText(enGallery.empty.gallery.heading)
    ).toBeTruthy()
    const action = screen.getByRole('link', {
      name: enGallery.empty.gallery.action,
    })
    expect(action.getAttribute('href')).toBe('/new')
  })

  it('says something different when a search found nothing', async () => {
    mount([jsonResponse(pagePayload([]))], '/gallery?q=teleport')

    expect(
      await screen.findByText(enGallery.empty.filtered.bySearch)
    ).toBeTruthy()
    // And offers the way out of the filter, not the way into the editor.
    expect(
      screen.getByRole('button', { name: enGallery.empty.filtered.clear })
    ).toBeTruthy()
  })

  it('says something different again for an unused tag', async () => {
    mount([jsonResponse(pagePayload([]))], '/gallery?tag=grover')

    expect(await screen.findByText(enGallery.empty.filtered.byTag)).toBeTruthy()
  })

  it('carries the selection from the address into the request', async () => {
    const { transport } = mount(
      [jsonResponse(pagePayload([]))],
      '/gallery?sort=stars&tag=grover&q=teleport'
    )

    await screen.findByText(enGallery.empty.filtered.heading)
    const url = transport.last().url
    expect(url).toContain('sort=stars')
    expect(url).toContain('tag=grover')
    expect(url).toContain('q=teleport')
  })

  it('does not send a search term the server is bound to refuse', async () => {
    /*
     * `@qsim/contract` requires three characters, because a term with no
     * trigrams in it cannot use the index on an unauthenticated route. Sending
     * it anyway would be a 400 on the way to every real query.
     */
    const { transport } = mount(
      [jsonResponse(pagePayload([]))],
      '/gallery?q=te'
    )

    await screen.findByText(enGallery.empty.filtered.heading)
    expect(transport.last().url).not.toContain('q=te')
  })

  it('says what went wrong and offers to try again', async () => {
    // A 4xx rather than a 5xx: `shouldRetryQuery` retries a 500 twice, and a
    // test that queued one response would be asserting against the *retry*
    // running out of stubbed answers rather than against the failure it meant.
    mount([errorResponse('VALIDATION_FAILED', 400)])

    expect(await screen.findByRole('alert')).toBeTruthy()
    expect(
      screen.getByRole('button', { name: enGallery.listing.retry })
    ).toBeTruthy()
  })

  it('appends the next page and announces the new total', async () => {
    /*
     * The accessible half of "infinite scroll": a real button, and a live
     * region that says what pressing it did. A listing that grows in silence
     * gives a screen-reader user nothing to notice.
     */
    mount([
      jsonResponse(pagePayload([cardPayload({ title: 'First' })], 'cursor-2')),
      jsonResponse(
        pagePayload([
          cardPayload({
            id: 'cir_2',
            slug: 'bbbbbbbbbbbbbbbbbbbbb',
            title: 'Second',
          }),
        ])
      ),
    ])

    const more = await screen.findByRole('button', {
      name: enGallery.listing.more,
    })
    fireEvent.click(more)

    expect(await screen.findByText('Second')).toBeTruthy()
    // Appended, not replaced.
    expect(screen.getByText('First')).toBeTruthy()
    await waitFor(() => {
      expect(screen.getByRole('status').textContent).toContain('2')
    })
  })

  it('stops offering more when the server says that was the last page', async () => {
    mount([jsonResponse(pagePayload([cardPayload({})]))])

    await screen.findByText(circuitDetailPayload.title)
    expect(
      screen.queryByRole('button', { name: enGallery.listing.more })
    ).toBeNull()
    expect(screen.getByRole('status').textContent).toContain(
      enGallery.listing.end
    )
  })

  it('keeps the cards on screen when a later page fails', async () => {
    // The cards already read are still true; throwing the listing away to
    // report that *more* of it did not arrive is the worse answer.
    mount([
      jsonResponse(pagePayload([cardPayload({ title: 'First' })], 'cursor-2')),
      // Non-retryable, for the reason above.
      errorResponse('VALIDATION_FAILED', 400),
    ])

    fireEvent.click(
      await screen.findByRole('button', { name: enGallery.listing.more })
    )

    expect(await screen.findByRole('alert')).toBeTruthy()
    expect(screen.getByText('First')).toBeTruthy()
  })

  it('puts a chosen tag in the address so the listing is a place', async () => {
    mount([
      jsonResponse(pagePayload([cardPayload({ tags: ['grover'] })])),
      jsonResponse(pagePayload([cardPayload({ tags: ['grover'] })])),
    ])

    fireEvent.click(await screen.findByRole('button', { name: 'grover' }))

    await waitFor(() => {
      expect(screen.getByText(enGallery.filters.tag.active)).toBeTruthy()
    })
  })
})
