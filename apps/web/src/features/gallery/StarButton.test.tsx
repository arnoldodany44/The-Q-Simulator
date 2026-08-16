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

import enCircuits from '../../i18n/locales/en/circuits.json'
import enCommon from '../../i18n/locales/en/common.json'
import enErrors from '../../i18n/locales/en/errors.json'
import enGallery from '../../i18n/locales/en/gallery.json'
import { SessionProvider } from '../auth'
import {
  TEST_SUPABASE_CONFIG,
  createFakeAuth,
  fakeSession,
} from '../auth/testing.js'
import {
  ApiProvider,
  createApiClient,
  createQueryClient,
  useGallery,
} from '../../lib/api'
import {
  TEST_BASE_URL,
  circuitDetailPayload,
  errorResponse,
  jsonResponse,
  stubFetch,
} from '../../lib/api/testing.js'
import { StarButton } from './StarButton'

/**
 * The requirement in the brief, spelled out: *a failed star must visibly
 * revert rather than leaving a lie on screen.*
 *
 * That is one assertion and it is the reason this file exists. An optimistic
 * update is easy; an optimistic update that is never corrected is worse than
 * no optimism at all — the reader is told they starred something they did not,
 * the number beside it is wrong, and nothing on screen ever contradicts either
 * claim.
 *
 * The button is mounted over a *real* `useGallery` rather than fed literal
 * props, because that is how the app drives it: `useStarCircuit` writes into
 * every listing cache that draws the circuit and the button renders whatever
 * is there. A test that passed `starred` as a literal would be testing a
 * component that cannot revert, since nothing could change its mind.
 */

afterEach(cleanup)

const OWNER = 'usr_1'
const SLUG = circuitDetailPayload.slug
const ID = circuitDetailPayload.id

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

/** One page of gallery, exactly as the API serialises it. */
function galleryPage(starCount: number, starred: boolean) {
  return {
    items: [{ ...circuitDetailPayload, starCount }],
    nextCursor: null,
    limit: 20,
    starred: starred ? [ID] : [],
  }
}

/** The button, wired to the listing that holds its state. */
function Listing() {
  const query = useGallery({})
  const page = query.data?.pages[0]
  const item = page?.items[0]
  if (page === undefined || item === undefined) return null
  return (
    <StarButton
      slug={item.slug}
      circuitId={item.id}
      starred={page.starred.includes(item.id)}
      starCount={item.starCount}
    />
  )
}

interface MountOptions {
  readonly after?: readonly unknown[]
  readonly starCount?: number
  readonly starred?: boolean
  readonly session?: 'authenticated' | 'anonymous'
}

function mount({
  after = [],
  starCount = 4,
  starred = false,
  session = 'authenticated',
}: MountOptions = {}) {
  const transport = stubFetch([
    jsonResponse(galleryPage(starCount, starred)),
    ...after,
  ])
  const client = createApiClient({
    baseUrl: TEST_BASE_URL,
    fetch: transport.fetch,
    getAccessToken: () => (session === 'authenticated' ? 'token' : null),
  })

  const auth = createFakeAuth({
    settled: session === 'authenticated' ? fakeSession(OWNER) : null,
  })

  const rendered = render(
    <I18nextProvider i18n={i18nFor()}>
      <ApiProvider client={client} queryClient={createQueryClient()}>
        <SessionProvider
          runtime={{ auth, config: TEST_SUPABASE_CONFIG }}
          origin="https://qsim.test"
        >
          <MemoryRouter initialEntries={['/gallery']}>
            <Listing />
          </MemoryRouter>
        </SessionProvider>
      </ApiProvider>
    </I18nextProvider>
  )

  return { ...rendered, transport }
}

function starControl(): HTMLElement {
  return screen.getByRole('button', { name: /star/i })
}

describe('StarButton', () => {
  it('offers a way in rather than a button that can only fail', async () => {
    // `POST /circuits/:id/star` is `auth: 'required'`, so an anonymous click
    // has exactly one useful outcome — and this is that outcome without the
    // round trip.
    const { transport } = mount({ session: 'anonymous' })

    const link = await screen.findByRole('link', { name: /sign in/i })
    expect(link.getAttribute('href')).toBe('/sign-in')
    // The listing's own request, and nothing else.
    expect(transport.calls).toHaveLength(1)
  })

  it('draws the star before the server answers', async () => {
    const { transport } = mount({
      after: [jsonResponse({ starred: true, starCount: 5 })],
    })

    fireEvent.click(await screen.findByRole('button', { name: /star/i }))

    await waitFor(() => {
      expect(starControl().getAttribute('aria-pressed')).toBe('true')
    })
    await waitFor(() => {
      expect(transport.calls).toHaveLength(2)
    })
    expect(transport.last().init?.method).toBe('POST')
  })

  it('takes the server’s count over its own guess', async () => {
    // Two tabs and a hundred other readers move this number too, so the
    // response is the only place the client can learn what it became.
    mount({
      starCount: 4,
      after: [jsonResponse({ starred: true, starCount: 12 })],
    })

    fireEvent.click(await screen.findByRole('button', { name: /star/i }))

    await waitFor(() => {
      expect(starControl().textContent).toContain('12')
    })
  })

  it('visibly reverts a star the server refused, and says so', async () => {
    /*
     * The whole point of the file. Without the rollback the optimistic write
     * stays: a filled star and a count of 5 on a circuit nobody starred, with
     * nothing on screen to contradict either.
     */
    mount({ starCount: 4, after: [errorResponse('RATE_LIMITED', 429)] })

    fireEvent.click(await screen.findByRole('button', { name: /star/i }))

    await waitFor(() => {
      expect(screen.getByRole('alert')).toBeTruthy()
    })
    expect(starControl().getAttribute('aria-pressed')).toBe('false')
    expect(starControl().textContent).toContain('4')
  })

  it('unstars, and puts the star back when that is refused too', async () => {
    mount({
      starred: true,
      starCount: 9,
      after: [errorResponse('SERVER_ERROR', 500)],
    })

    const button = await screen.findByRole('button', { name: /star/i })
    expect(button.getAttribute('aria-pressed')).toBe('true')
    fireEvent.click(button)

    await waitFor(() => {
      expect(screen.getByRole('alert')).toBeTruthy()
    })
    expect(starControl().getAttribute('aria-pressed')).toBe('true')
    expect(starControl().textContent).toContain('9')
  })

  it('addresses the circuit by slug, never by id', async () => {
    /*
     * An id reaches only what a listing may show; a slug also reaches an
     * UNLISTED circuit, which is exactly the case where somebody was sent a
     * link and wants to star what they were sent.
     */
    const { transport } = mount({
      after: [jsonResponse({ starred: true, starCount: 5 })],
    })

    fireEvent.click(await screen.findByRole('button', { name: /star/i }))

    await waitFor(() => {
      expect(transport.calls).toHaveLength(2)
    })
    expect(transport.last().url).toContain(`/circuits/${SLUG}/star`)
  })
})
