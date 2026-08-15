import { cleanup, render, screen } from '@testing-library/react'
import { createInstance, type i18n as I18n } from 'i18next'
import { I18nextProvider, initReactI18next } from 'react-i18next'
import { MemoryRouter } from 'react-router'
import { afterEach, describe, expect, it } from 'vitest'

import { AppRoutes } from './App'
import { SessionProvider } from './features/auth'
import enAnalysis from './i18n/locales/en/analysis.json'
import enCircuits from './i18n/locales/en/circuits.json'
import enCommon from './i18n/locales/en/common.json'
import enEditor from './i18n/locales/en/editor.json'
import enGates from './i18n/locales/en/gates.json'
import enLanding from './i18n/locales/en/landing.json'
import { ApiProvider, createApiClient, createQueryClient } from './lib/api'
import {
  TEST_BASE_URL,
  circuitWithVersionPayload,
  jsonResponse,
  stubFetch,
} from './lib/api/testing.js'

/**
 * The route table, and only the route table. Each page has its own tests;
 * what is left to prove is that the two paths reach the two pages — a
 * mistake that costs nothing to make and is invisible until someone opens
 * the app.
 *
 * The editor is behind `React.lazy` since M0.9b, so reaching it is an
 * asynchronous act now: `findBy*` is not a style choice here, it is the
 * difference between asserting on the page and asserting on the fallback. The
 * landing is deliberately *not* lazy — it is the entry point and may not wait
 * on a second round trip — which is why it is still found synchronously, and
 * that asymmetry is itself worth pinning.
 */

afterEach(cleanup)

function i18n(): I18n {
  const instance = createInstance()
  void instance.use(initReactI18next).init({
    lng: 'en',
    fallbackLng: 'en',
    ns: ['analysis', 'circuits', 'common', 'editor', 'gates', 'landing'],
    defaultNS: 'common',
    resources: {
      en: {
        analysis: enAnalysis,
        circuits: enCircuits,
        common: enCommon,
        editor: enEditor,
        gates: enGates,
        landing: enLanding,
      },
    },
    interpolation: { escapeValue: false },
    react: { useSuspense: false },
  })
  return instance
}

/**
 * The providers `main.tsx` mounts around the router. `runtime={null}` is the
 * deployment-without-accounts case, which is the right one here: these tests
 * are about the route table, and it keeps the account menu and the save
 * control — both of which read the session — out of the way of assertions
 * about the page.
 *
 * The API client answers from a queue rather than a network. `/c/:slug` fetches
 * on its first paint (M1.4a), so a route table test that mounted it without
 * one would be testing the transport's "no provider" error message.
 */
function at(path: string, responses: readonly unknown[] = []) {
  const client = createApiClient({
    baseUrl: TEST_BASE_URL,
    fetch: stubFetch(responses).fetch,
    getAccessToken: () => null,
  })

  return render(
    <I18nextProvider i18n={i18n()}>
      <ApiProvider client={client} queryClient={createQueryClient()}>
        <SessionProvider runtime={null} origin="https://qsim.test">
          <MemoryRouter initialEntries={[path]}>
            <AppRoutes />
          </MemoryRouter>
        </SessionProvider>
      </ApiProvider>
    </I18nextProvider>
  )
}

describe('routes', () => {
  it('shows the landing page at the root, without waiting for a chunk', () => {
    at('/')

    expect(
      screen.getByText('A quantum circuit laboratory in your browser')
    ).toBeDefined()
    // Two of each: the actions are offered before the demonstration and again
    // after it, deliberately with the same wording (`routes/landing.tsx`).
    expect(
      screen.getAllByRole('link', { name: 'Open the editor' })
    ).toHaveLength(2)
    // The landing runs a circuit but never mounts the editor: no palette.
    expect(screen.queryByRole('button', { name: 'CNOT' })).toBeNull()
  })

  it('offers a way into the examples as well as into a blank editor', () => {
    at('/')

    const blank = screen.getAllByRole('link', { name: 'Open the editor' })[0]
    const example = screen.getAllByRole('link', {
      name: 'Start from an example',
    })[0]

    expect(blank?.getAttribute('href')).toBe('/new')
    // `?example=` is read by `useExample` on the editor route: the reader
    // arrives holding the circuit the demonstration ended on.
    expect(example?.getAttribute('href')).toBe('/new?example=bell')
  })

  it('shows the editor at /new once its chunk arrives', async () => {
    at('/new')

    /*
     * The default `findBy*` budget is one second, and what is being waited on
     * here is a real dynamic `import()` of the editor chunk — Zustand, Zundo,
     * dnd-kit and the whole canvas — compiled on demand by Vite. That is not
     * a fixed cost: it is the machine's, and on a loaded CI runner (or under
     * `turbo` building three workspaces at once) it lands either side of the
     * second. The assertion is about routing, not about speed, so the budget
     * is raised rather than left to decide the outcome by coin flip.
     */
    expect(
      await screen.findByRole(
        'grid',
        { name: 'Circuit grid' },
        { timeout: 5_000 }
      )
    ).toBeDefined()
    expect(screen.getByRole('button', { name: 'CNOT' })).toBeDefined()
    expect(
      screen.getByRole('toolbar', { name: 'Circuit actions' })
    ).toBeDefined()
  })

  it('shows the same editor at /c/:slug, over the saved circuit', async () => {
    at('/c/V1StGXR8Z5jdHi6BmyT8a', [jsonResponse(circuitWithVersionPayload)])

    expect(
      await screen.findByRole(
        'grid',
        { name: 'Circuit grid' },
        { timeout: 5_000 }
      )
    ).toBeDefined()
    // The circuit's own title, which is the one thing this route shows that
    // `/new` does not — proof the document arrived rather than the frame.
    expect(await screen.findByText('Bell pair')).toBeDefined()
  })

  it('does not put a session guard in front of a shared circuit', async () => {
    /*
     * `GET /circuits/:id` is `auth: 'optional'` in `apps/api`, which is what
     * makes a PUBLIC circuit readable by anyone and an UNLISTED link work at
     * all. This session is anonymous (`runtime={null}`), so a guard would
     * redirect — and every link anybody ever shared would break.
     */
    at('/c/V1StGXR8Z5jdHi6BmyT8a', [jsonResponse(circuitWithVersionPayload)])

    expect(
      await screen.findByRole(
        'grid',
        { name: 'Circuit grid' },
        { timeout: 5_000 }
      )
    ).toBeDefined()
    expect(screen.queryByRole('button', { name: 'Sign in' })).toBeNull()
  })
})
