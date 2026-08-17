import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from '@testing-library/react'
import { createInstance, type i18n as I18n } from 'i18next'
import { I18nextProvider, initReactI18next } from 'react-i18next'
import { afterEach, describe, expect, it } from 'vitest'

import enErrors from '../../i18n/locales/en/errors.json'
import enSettings from '../../i18n/locales/en/settings.json'
import esSettings from '../../i18n/locales/es/settings.json'
import frSettings from '../../i18n/locales/fr/settings.json'
import { ApiProvider, createApiClient, createQueryClient } from '../../lib/api'
import {
  TEST_BASE_URL,
  errorResponse,
  jsonResponse,
  stubFetch,
} from '../../lib/api/testing.js'
import { ApiKeysSection } from './ApiKeysSection'

/**
 * The one-time display, and the two ways it can go wrong.
 *
 * This component exists because a key is shown once and never again. So the
 * assertions here are about that moment and about what surrounds it:
 *
 *   - the key is on screen after minting, and it is *selectable* rather than
 *     only copyable, because a blocked clipboard must not be a dead end;
 *   - it is gone once dismissed, and nothing brings it back — no refetch, no
 *     re-render, no second listing;
 *   - the listing never contains it, not even a fragment past the prefix the
 *     server publishes;
 *   - revoking asks first, and the confirmation names the key.
 *
 * The last block renders the whole section in all three languages and asserts
 * the shape-based property `e2e/no-raw-keys.spec.ts` asserts for routes: this
 * surface only exists after a request, so no walk of a loaded page reaches it.
 */

afterEach(cleanup)

const CREATED_AT = '2026-08-01T10:00:00.000Z'

const CATALOGS = { en: enSettings, es: esSettings, fr: frSettings }

function i18nFor(language: keyof typeof CATALOGS): I18n {
  const instance = createInstance()
  void instance.use(initReactI18next).init({
    lng: language,
    fallbackLng: false,
    ns: ['settings', 'errors'],
    defaultNS: 'settings',
    resources: {
      [language]: { settings: CATALOGS[language], errors: enErrors },
    },
    interpolation: { escapeValue: false },
    react: { useSuspense: false },
  })
  return instance
}

function keyPayload(overrides: Record<string, unknown> = {}) {
  return {
    id: 'key_1',
    name: 'CI',
    keyPrefix: 'qsk_ab12cd',
    scopes: ['read'],
    createdAt: CREATED_AT,
    lastUsedAt: null,
    revokedAt: null,
    ...overrides,
  }
}

/** A key of exactly the published shape, so assertions are about a real one. */
const MINTED = `qsk_${'a1B2c3D4e5F6g7H8i9J0k1L2m3N4o5P6q7R8s9T'.slice(0, 43)}`

function mount(
  responses: readonly unknown[],
  language: keyof typeof CATALOGS = 'en'
) {
  const transport = stubFetch(responses)
  const client = createApiClient({
    baseUrl: TEST_BASE_URL,
    fetch: transport.fetch,
    getAccessToken: () => 'token',
  })

  const rendered = render(
    <I18nextProvider i18n={i18nFor(language)}>
      <ApiProvider client={client} queryClient={createQueryClient()}>
        <ApiKeysSection enabled />
      </ApiProvider>
    </I18nextProvider>
  )
  return { ...rendered, transport }
}

async function mintOne(): Promise<ReturnType<typeof mount>> {
  const harness = mount([
    jsonResponse({ apiKeys: [] }),
    jsonResponse({ apiKey: keyPayload(), key: MINTED }),
    jsonResponse({ apiKeys: [keyPayload()] }),
  ])

  await screen.findByText(enSettings.apiKeys.empty)
  fireEvent.change(screen.getByLabelText(enSettings.apiKeys.nameLabel), {
    target: { value: 'CI' },
  })
  fireEvent.click(
    screen.getByRole('button', { name: enSettings.apiKeys.create })
  )
  await screen.findByText(enSettings.apiKeys.created.heading)
  return harness
}

describe('the minted key', () => {
  it('is on screen exactly once, in a field a reader can select', async () => {
    await mintOne()

    const field = screen.getByLabelText<HTMLInputElement>(
      enSettings.apiKeys.created.label
    )
    expect(field.value).toBe(MINTED)
    /*
     * Read-only rather than disabled, and an input rather than a `<code>`:
     * both are what let somebody select and copy it by hand when the
     * clipboard API is unavailable — an insecure origin, a denied permission,
     * a locked-down browser. A dead end here means a credential nobody can
     * ever recover.
     */
    expect(field.readOnly).toBe(true)
    expect(field.hasAttribute('disabled')).toBe(false)
    // A password manager saving this into the wrong field is a way it leaves.
    expect(field.getAttribute('autocomplete')).toBe('off')
  })

  it('says plainly that it will not be shown again', async () => {
    await mintOne()
    // Without this sentence the feature is a support queue.
    expect(screen.getByText(enSettings.apiKeys.created.warning)).toBeTruthy()
  })

  it('cannot be minted over: the form is replaced while it is showing', async () => {
    await mintOne()
    /*
     * The specific way people lose the first key: mint a second on top of it.
     * The form is gone until the panel is dismissed.
     */
    expect(screen.queryByLabelText(enSettings.apiKeys.nameLabel)).toBeNull()
  })

  it('is gone once dismissed, and nothing brings it back', async () => {
    await mintOne()

    fireEvent.click(
      screen.getByRole('button', {
        name: enSettings.apiKeys.created.dismiss,
      })
    )

    await waitFor(() => {
      expect(
        screen.queryByLabelText(enSettings.apiKeys.created.label)
      ).toBeNull()
    })
    // The whole document, not just the field: no toast, no aria-live remnant,
    // no hidden input holding it for a later paste.
    expect(document.body.innerHTML).not.toContain(MINTED)
    // And the form is back, so the next key can be made.
    expect(screen.getByLabelText(enSettings.apiKeys.nameLabel)).toBeTruthy()
  })

  it('is never in the listing that replaces it', async () => {
    await mintOne()
    fireEvent.click(
      screen.getByRole('button', {
        name: enSettings.apiKeys.created.dismiss,
      })
    )

    await screen.findByText('CI')
    // The published head is fine and is what makes two rows distinguishable.
    expect(screen.getByText('qsk_ab12cd…')).toBeTruthy()
    // Anything past it is the credential.
    expect(document.body.innerHTML).not.toContain(MINTED.slice(12))
  })
})

describe('the listing', () => {
  it('says when a key has never been used, which is when it is safe to revoke', async () => {
    mount([jsonResponse({ apiKeys: [keyPayload()] })])
    expect(await screen.findByText(/never used/)).toBeTruthy()
  })

  it('keeps a revoked key visible and marks it as spent', async () => {
    mount([
      jsonResponse({
        apiKeys: [keyPayload({ revokedAt: '2026-08-10T09:00:00.000Z' })],
      }),
    ])

    await screen.findByText('CI')
    // "Which key did I turn off, and when" is asked after an incident, so the
    // row survives — and it offers no revoke control, because it is done.
    expect(
      screen.queryByRole('button', { name: enSettings.apiKeys.row.revoke })
    ).toBeNull()
  })
})

describe('revoking', () => {
  it('asks first, names the key, and only then sends', async () => {
    const { transport } = mount([
      jsonResponse({ apiKeys: [keyPayload()] }),
      jsonResponse({
        apiKey: keyPayload({ revokedAt: '2026-08-17T12:00:00.000Z' }),
      }),
      jsonResponse({
        apiKeys: [keyPayload({ revokedAt: '2026-08-17T12:00:00.000Z' })],
      }),
    ])

    await screen.findByText('CI')
    fireEvent.click(
      screen.getByRole('button', { name: enSettings.apiKeys.row.revoke })
    )

    /*
     * An inline confirmation and not `window.confirm`: that dialog's text is
     * in no catalog (D2), cannot be read by the same screen-reader flow as the
     * page, and some browsers suppress it outright.
     */
    expect(screen.getByText(/Revoking “CI”/)).toBeTruthy()
    expect(transport.calls).toHaveLength(1)

    fireEvent.click(
      screen.getByRole('button', { name: enSettings.apiKeys.row.confirm })
    )
    await waitFor(() => {
      expect(
        transport.calls.some((call) => call.init?.method === 'DELETE')
      ).toBe(true)
    })
  })

  it('can be changed one’s mind about, without a request', async () => {
    const { transport } = mount([jsonResponse({ apiKeys: [keyPayload()] })])

    await screen.findByText('CI')
    fireEvent.click(
      screen.getByRole('button', { name: enSettings.apiKeys.row.revoke })
    )
    fireEvent.click(
      screen.getByRole('button', { name: enSettings.apiKeys.row.cancel })
    )

    expect(
      screen.getByRole('button', { name: enSettings.apiKeys.row.revoke })
    ).toBeTruthy()
    expect(transport.calls).toHaveLength(1)
  })
})

describe('failures', () => {
  it('translates the ceiling rather than showing a status code', async () => {
    mount([
      jsonResponse({ apiKeys: [] }),
      errorResponse('API_KEY_LIMIT_REACHED', 409),
    ])

    await screen.findByText(enSettings.apiKeys.empty)
    fireEvent.change(screen.getByLabelText(enSettings.apiKeys.nameLabel), {
      target: { value: 'one too many' },
    })
    fireEvent.click(
      screen.getByRole('button', { name: enSettings.apiKeys.create })
    )

    // The API sends a code; every word the reader sees is this app's (§11, D2).
    expect(await screen.findByText(enErrors.API_KEY_LIMIT_REACHED)).toBeTruthy()
  })
})

/**
 * The trilingual assertion this surface cannot get from `no-raw-keys.spec.ts`.
 *
 * That suite walks routes as they load, and none of this exists until a
 * request has answered — so the section, its scope hints and its confirmation
 * copy are invisible to it. Same shape-based property, applied here.
 */
const KEY_SHAPE = /^[a-z][a-zA-Z]*(\.[a-zA-Z]+)+$/

describe.each(['en', 'es', 'fr'] as const)('in %s', (language) => {
  it('renders words rather than catalog keys', async () => {
    mount(
      [
        jsonResponse({
          apiKeys: [
            keyPayload(),
            keyPayload({
              id: 'key_2',
              name: 'notebook',
              scopes: ['read', 'write', 'simulate'],
              lastUsedAt: '2026-08-16T08:00:00.000Z',
              revokedAt: '2026-08-16T09:00:00.000Z',
            }),
          ],
        }),
      ],
      language
    )

    await screen.findByText('CI')

    const leaves = [...document.querySelectorAll('body *')]
      .filter((element) => element.children.length === 0)
      .map((element) => (element.textContent ?? '').trim())
      .filter((text) => text.length > 0 && KEY_SHAPE.test(text))

    expect(leaves).toEqual([])
  })
})
