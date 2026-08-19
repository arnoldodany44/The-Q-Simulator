import {
  act,
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

import enCommon from '../i18n/locales/en/common.json'
import enErrors from '../i18n/locales/en/errors.json'
import enSettings from '../i18n/locales/en/settings.json'
import { SessionProvider } from '../features/auth'
import {
  TEST_SUPABASE_CONFIG,
  createFakeAuth,
  fakeSession,
} from '../features/auth/testing.js'
import { ApiProvider, createApiClient, createQueryClient } from '../lib/api'
import {
  TEST_BASE_URL,
  errorResponse,
  jsonResponse,
  stubFetch,
} from '../lib/api/testing.js'
import { SettingsRoute } from './settings'

/**
 * The settings screen, from the point of view of the two things on it that can
 * go badly wrong.
 *
 * **The handle.** It is a public address and it is unique, so the only honest
 * feedback before saving is about its *shape*; whether it is taken is the
 * server's answer, decided by the unique index, and it arrives as a refusal on
 * save. There is no availability check in this app and there is no endpoint
 * for one — that would be a cheap, scriptable oracle over every handle in the
 * database (`accounts.ts` in @qsim/db).
 *
 * **The deletion.** It is the one irreversible action in the product, so the
 * control is behind a disclosure and declines until the person has typed their
 * own handle. The server checks the same thing again; this asserts the client
 * does not send it early.
 */

afterEach(cleanup)

const CREATED_AT = '2024-05-01T10:00:00.000Z'
const USER_ID = '11111111-1111-4111-8111-111111111111'

function i18nFor(): I18n {
  const instance = createInstance()
  void instance.use(initReactI18next).init({
    lng: 'en',
    fallbackLng: false,
    ns: ['settings', 'common', 'errors'],
    defaultNS: 'settings',
    resources: {
      en: { settings: enSettings, common: enCommon, errors: enErrors },
    },
    interpolation: { escapeValue: false },
    react: { useSuspense: false },
  })
  return instance
}

/** A deletion report, with the counters this screen does not name zeroed. */
function deletion(counts: { circuits: number; collections: number }) {
  return {
    ...counts,
    comments: 0,
    stars: 5,
    simulationRuns: 0,
    hardwareJobs: 0,
    orphanedCollectionItems: 3,
  }
}

function accountPayload(overrides: Record<string, unknown> = {}) {
  const { leaderboardOptOut = false, ...user } = overrides
  return {
    user: {
      id: USER_ID,
      username: 'ada',
      displayName: 'Ada',
      avatarUrl: null,
      createdAt: CREATED_AT,
      ...user,
    },
    /*
     * A sibling of `user` and not a field on it: the user shape is what this
     * API prints beside somebody's work, and a preference is not that. See
     * `AccountResponse` in @qsim/contract.
     */
    leaderboardOptOut,
  }
}

/**
 * Requests this file is not about, filtered out of the ledger.
 *
 * The screen also lists the account's API keys (§3.5) and its stored hardware
 * credentials (§3.7), each a further request on mount that would otherwise
 * shift every positional assertion below — and, worse, would make "one
 * request, and it is the one that loaded the account" quietly mean something
 * else. Filtering by URL keeps each assertion about the thing its test names.
 */
function accountCalls<Call extends { url: string }>(transport: {
  calls: readonly Call[]
}): readonly Call[] {
  return transport.calls.filter(
    (call) =>
      !call.url.includes('/api-keys') && !call.url.includes('/hardware/')
  )
}

/**
 * `responses` is the queue for the *account* requests, in order.
 *
 * The two empty listings are spliced in behind the first entry because that is
 * where they land: `ApiKeysSection` and `HardwareCredentialsSection` both mount
 * once `GET /me` has resolved, in the order the route renders them, so the
 * sequence is deterministic and every test can go on describing the requests it
 * actually cares about.
 */
function mount(responses: readonly unknown[]) {
  const [account, ...rest] = responses
  const transport = stubFetch([
    account,
    jsonResponse({ apiKeys: [] }),
    jsonResponse({ credentials: [] }),
    ...rest,
  ])
  const client = createApiClient({
    baseUrl: TEST_BASE_URL,
    fetch: transport.fetch,
    getAccessToken: () => 'token',
  })
  const auth = createFakeAuth({ settled: fakeSession(USER_ID) })

  const rendered = render(
    <I18nextProvider i18n={i18nFor()}>
      <ApiProvider client={client} queryClient={createQueryClient()}>
        <SessionProvider
          runtime={{ auth, config: TEST_SUPABASE_CONFIG }}
          origin="https://qsim.test"
        >
          <MemoryRouter initialEntries={['/settings']}>
            <SettingsRoute />
          </MemoryRouter>
        </SessionProvider>
      </ApiProvider>
    </I18nextProvider>
  )

  return { ...rendered, transport, auth }
}

describe('the settings screen', () => {
  it('shows the account it loaded', async () => {
    mount([jsonResponse(accountPayload())])

    const handle = await screen.findByLabelText(enSettings.profile.username)
    expect((handle as HTMLInputElement).value).toBe('ada')
  })

  it('says what is wrong with a handle that could never be an address', async () => {
    mount([jsonResponse(accountPayload())])

    const handle = await screen.findByLabelText(enSettings.profile.username)
    fireEvent.change(handle, { target: { value: 'Ada Lovelace' } })

    expect(screen.getByText(enSettings.profile.usernameShape)).toBeTruthy()
    expect(handle.getAttribute('aria-invalid')).toBe('true')
    // Declined rather than disabled: a disabled control cannot hold focus, so
    // the keyboard user who just typed would be dropped to the document body.
    const save = screen.getByRole('button', { name: enSettings.profile.save })
    expect(save.getAttribute('aria-disabled')).toBe('true')
  })

  it('never asks the server whether a handle is free', async () => {
    const { transport } = mount([jsonResponse(accountPayload())])

    const handle = await screen.findByLabelText(enSettings.profile.username)
    fireEvent.change(handle, { target: { value: 'grace' } })
    fireEvent.change(handle, { target: { value: 'grace-2' } })

    // One request, and it is the one that loaded the account. Typing must not
    // become a lookup — see the header.
    await waitFor(() => {
      expect(accountCalls(transport)).toHaveLength(1)
    })
  })

  it('translates the refusal when the handle belongs to somebody else', async () => {
    mount([
      jsonResponse(accountPayload()),
      errorResponse('USERNAME_TAKEN', 409),
    ])

    const handle = await screen.findByLabelText(enSettings.profile.username)
    fireEvent.change(handle, { target: { value: 'grace' } })
    fireEvent.click(
      screen.getByRole('button', { name: enSettings.profile.save })
    )

    // The API sends a code; every word the reader sees is this app's (§11, D2).
    expect(await screen.findByText(enErrors.USERNAME_TAKEN)).toBeTruthy()
  })

  it('offers the generated picture as the choice it is', async () => {
    mount([jsonResponse(accountPayload())])

    const generated = await screen.findByLabelText(
      enSettings.profile.avatarGenerated
    )
    expect((generated as HTMLInputElement).checked).toBe(true)
  })

  /**
   * The leaderboard control (§3.6).
   *
   * The checkbox is phrased positively and the stored column is the refusal,
   * so the two are inverses — which is exactly the kind of thing that ships
   * backwards and looks fine. Both directions are asserted against the body
   * that actually leaves the browser.
   */
  it('shows the leaderboard listing as on when nobody has opted out', async () => {
    mount([jsonResponse(accountPayload())])

    const box = await screen.findByLabelText(enSettings.privacy.listMe)
    expect((box as HTMLInputElement).checked).toBe(true)
  })

  it('shows it as off for somebody who withdrew their name', async () => {
    mount([jsonResponse(accountPayload({ leaderboardOptOut: true }))])

    const box = await screen.findByLabelText(enSettings.privacy.listMe)
    expect((box as HTMLInputElement).checked).toBe(false)
  })

  it('sends the refusal, and the change of mind, the right way round', async () => {
    const { transport } = mount([
      jsonResponse(accountPayload()),
      jsonResponse(accountPayload({ leaderboardOptOut: true })),
      jsonResponse(accountPayload({ leaderboardOptOut: true })),
      jsonResponse(accountPayload()),
      jsonResponse(accountPayload()),
    ])

    /*
     * The *writes*, and not simply the last request: a successful save
     * invalidates the account, so the newest call at assert time is the
     * refetch behind it rather than the PATCH under test.
     */
    const writes = (): unknown[] =>
      transport.calls
        .filter((call) => call.init?.method === 'PATCH')
        .map((call) =>
          typeof call.init?.body === 'string'
            ? (JSON.parse(call.init.body) as unknown)
            : call.init?.body
        )

    const box = await screen.findByLabelText(enSettings.privacy.listMe)
    // Unchecking "show my name" is opting out.
    fireEvent.click(box)
    await waitFor(() => {
      expect(writes()).toEqual([{ leaderboardOptOut: true }])
    })

    // The screen now shows the stored state, and checking it again is the
    // change of mind — which has to send the opposite value and not the same
    // one twice.
    await waitFor(() => {
      const again = screen.getByLabelText(enSettings.privacy.listMe)
      expect((again as HTMLInputElement).checked).toBe(false)
    })
    fireEvent.click(screen.getByLabelText(enSettings.privacy.listMe))
    await waitFor(() => {
      expect(writes()).toEqual([
        { leaderboardOptOut: true },
        { leaderboardOptOut: false },
      ])
    })
  })

  /*
   * Saying that opting out deletes a result would make the honest choice look
   * expensive, and it is not what the server does: the rank is assigned before
   * anybody is withheld.
   */
  it('says that hiding a name does not withdraw a result', async () => {
    mount([jsonResponse(accountPayload())])
    expect(await screen.findByText(enSettings.privacy.note)).toBeTruthy()
  })

  it('keeps the delete control behind a disclosure', async () => {
    mount([jsonResponse(accountPayload())])

    await screen.findByLabelText(enSettings.profile.username)
    expect(screen.queryByLabelText(/Type ada to confirm/)).toBeNull()

    fireEvent.click(
      screen.getByRole('button', { name: enSettings.danger.reveal })
    )
    expect(screen.getByLabelText('Type ada to confirm')).toBeTruthy()
  })

  it('declines to delete until the handle matches, and never sends early', async () => {
    const { transport } = mount([jsonResponse(accountPayload())])

    await screen.findByLabelText(enSettings.profile.username)
    fireEvent.click(
      screen.getByRole('button', { name: enSettings.danger.reveal })
    )

    const confirm = screen.getByLabelText('Type ada to confirm')
    fireEvent.change(confirm, { target: { value: 'ad' } })

    const destroy = screen.getByRole('button', {
      name: enSettings.danger.confirm,
    })
    expect(destroy.getAttribute('aria-disabled')).toBe('true')
    fireEvent.click(destroy)

    await waitFor(() => {
      expect(accountCalls(transport)).toHaveLength(1)
    })
    expect(accountCalls(transport)[0]?.init?.method).toBe('GET')
  })

  it('reports what a deletion actually destroyed', async () => {
    const { transport } = mount([
      jsonResponse(accountPayload()),
      jsonResponse({
        deleted: {
          circuits: 12,
          collections: 2,
          comments: 0,
          stars: 5,
          simulationRuns: 0,
          hardwareJobs: 0,
          orphanedCollectionItems: 3,
        },
      }),
    ])

    await screen.findByLabelText(enSettings.profile.username)
    fireEvent.click(
      screen.getByRole('button', { name: enSettings.danger.reveal })
    )
    fireEvent.change(screen.getByLabelText('Type ada to confirm'), {
      target: { value: 'ada' },
    })
    fireEvent.click(
      screen.getByRole('button', { name: enSettings.danger.confirm })
    )

    // The counts, rendered rather than swallowed: somebody who has just
    // destroyed twelve circuits deserves to be told it was twelve.
    expect(
      await screen.findByText('Removed 12 circuits and 2 collections.')
    ).toBeTruthy()
    expect(accountCalls(transport)[1]?.init?.method).toBe('DELETE')
  })

  it('keeps the confirmation on screen after the sign-out it causes', async () => {
    /*
     * THE DEFECT. The report used to live inside the subtree `RequireSession`
     * guards. Deleting the account signed the user out, the guard flipped, and
     * it redirected to /sign-in — the confirmation was measured on screen for
     * about 130 ms, two samples out of a hundred and twenty, which is not long
     * enough for a `role="status"` region to be announced before its subtree is
     * removed. Three translated keys were dead copy in all three languages.
     *
     * So the session going away is simulated here, after the deletion, and the
     * report has to still be standing — with the one exit the screen offers.
     */
    const { auth } = mount([
      jsonResponse(accountPayload()),
      jsonResponse({ deleted: deletion({ circuits: 12, collections: 2 }) }),
    ])

    await screen.findByLabelText(enSettings.profile.username)
    fireEvent.click(
      screen.getByRole('button', { name: enSettings.danger.reveal })
    )
    fireEvent.change(screen.getByLabelText('Type ada to confirm'), {
      target: { value: 'ada' },
    })
    fireEvent.click(
      screen.getByRole('button', { name: enSettings.danger.confirm })
    )
    await screen.findByText('Removed 12 circuits and 2 collections.')

    // Supabase tells every tab the session is gone; this app's provider is
    // listening, and the guard is what used to react to it.
    await act(async () => {
      auth.emit('SIGNED_OUT', null)
      await Promise.resolve()
    })

    expect(auth.calls.signOut).toBeGreaterThan(0)
    expect(
      screen.getByText('Removed 12 circuits and 2 collections.')
    ).toBeTruthy()
    expect(screen.getByRole('status').textContent).toContain('12')
    expect(
      screen.getByRole('link', { name: enSettings.danger.doneHome })
    ).toBeTruthy()
  })

  it('guards itself, so the guard is not what tears the report down', async () => {
    /*
     * The other half of the arrangement above, and the half a refactor would
     * undo first. `RequireSession` lives *inside* this route rather than around
     * it in `App.tsx`, which is what lets the report render for somebody who no
     * longer has a session. This asserts the guard is still here: an anonymous
     * visitor gets no settings form and no danger zone.
     */
    const transport = stubFetch([jsonResponse(accountPayload())])
    render(
      <I18nextProvider i18n={i18nFor()}>
        <ApiProvider
          client={createApiClient({
            baseUrl: TEST_BASE_URL,
            fetch: transport.fetch,
            getAccessToken: () => null,
          })}
          queryClient={createQueryClient()}
        >
          <SessionProvider
            runtime={{
              auth: createFakeAuth({ settled: null }),
              config: TEST_SUPABASE_CONFIG,
            }}
            origin="https://qsim.test"
          >
            <MemoryRouter initialEntries={['/settings']}>
              <Routes>
                <Route path="/settings" element={<SettingsRoute />} />
                <Route path="/sign-in" element={<p>sign in</p>} />
              </Routes>
            </MemoryRouter>
          </SessionProvider>
        </ApiProvider>
      </I18nextProvider>
    )

    expect(await screen.findByText('sign in')).toBeTruthy()
    expect(
      screen.queryByRole('button', { name: enSettings.danger.reveal })
    ).toBeNull()
  })

  it('agrees in number with what it destroyed', async () => {
    // "Removed 1 circuits and 0 collections." is what one key with two raw
    // numbers in it produces, in all three languages. i18next resolves a plural
    // against a single `count`, so the sentence is composed from two counted
    // phrases — the arrangement `ExportPanel` already uses.
    mount([
      jsonResponse(accountPayload()),
      jsonResponse({ deleted: deletion({ circuits: 1, collections: 0 }) }),
    ])

    await screen.findByLabelText(enSettings.profile.username)
    fireEvent.click(
      screen.getByRole('button', { name: enSettings.danger.reveal })
    )
    fireEvent.change(screen.getByLabelText('Type ada to confirm'), {
      target: { value: 'ada' },
    })
    fireEvent.click(
      screen.getByRole('button', { name: enSettings.danger.confirm })
    )

    expect(
      await screen.findByText('Removed 1 circuit and 0 collections.')
    ).toBeTruthy()
  })

  it('writes the figures the way the language writes numbers', async () => {
    // Every other figure in the product goes through `Intl.NumberFormat`; two
    // raw JS numbers `String()`-ed into a sentence were the exception.
    mount([
      jsonResponse(accountPayload()),
      jsonResponse({ deleted: deletion({ circuits: 1234, collections: 2 }) }),
    ])

    await screen.findByLabelText(enSettings.profile.username)
    fireEvent.click(
      screen.getByRole('button', { name: enSettings.danger.reveal })
    )
    fireEvent.change(screen.getByLabelText('Type ada to confirm'), {
      target: { value: 'ada' },
    })
    fireEvent.click(
      screen.getByRole('button', { name: enSettings.danger.confirm })
    )

    expect(
      await screen.findByText('Removed 1,234 circuits and 2 collections.')
    ).toBeTruthy()
  })
})
