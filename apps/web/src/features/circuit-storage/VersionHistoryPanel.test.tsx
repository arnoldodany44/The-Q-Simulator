import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { createInstance, type i18n as I18n } from 'i18next'
import { I18nextProvider, initReactI18next } from 'react-i18next'
import { afterEach, describe, expect, it, vi } from 'vitest'

import enCircuits from '../../i18n/locales/en/circuits.json'
import enErrors from '../../i18n/locales/en/errors.json'
import { ApiProvider, createApiClient, createQueryClient } from '../../lib/api'
import {
  TEST_BASE_URL,
  errorResponse,
  jsonResponse,
  stubFetch,
} from '../../lib/api/testing.js'
import { VersionHistoryPanel } from './VersionHistoryPanel'
import { NO_VERSION_SELECTED, type VersionSelection } from './versionParams.js'

/**
 * The history list.
 *
 * Nothing here writes: every control is a selection, and the assertions are
 * about what the panel *asks for* rather than about what happens next. The
 * restore that actually appends a version lives in `VersionPreview`, one step
 * further in, and has its own suite.
 */

afterEach(cleanup)

const SLUG = 'V1StGXR8Z5jdHi6BmyT8a'

function i18nFor(): I18n {
  const instance = createInstance()
  void instance.use(initReactI18next).init({
    lng: 'en',
    fallbackLng: false,
    ns: ['circuits', 'errors'],
    defaultNS: 'circuits',
    resources: { en: { circuits: enCircuits, errors: enErrors } },
    interpolation: { escapeValue: false },
    react: { useSuspense: false },
  })
  return instance
}

interface VersionRow {
  readonly versionNum: number
  readonly message: string | null
  readonly createdAt: string
}

function versionPage(
  items: readonly VersionRow[],
  page = 1,
  perPage = 20,
  total = items.length
) {
  return {
    items: items.map((row) => ({
      id: `ver_${row.versionNum}`,
      versionNum: row.versionNum,
      message: row.message,
      createdAt: row.createdAt,
    })),
    page,
    perPage,
    total,
    totalPages: Math.max(1, Math.ceil(total / perPage)),
  }
}

const THREE_VERSIONS = versionPage([
  {
    versionNum: 3,
    message: 'Added the measurement',
    createdAt: '2024-05-03T09:15:00.000Z',
  },
  { versionNum: 2, message: null, createdAt: '2024-05-02T18:40:00.000Z' },
  {
    versionNum: 1,
    message: 'First save',
    createdAt: '2024-05-01T10:00:00.000Z',
  },
])

interface MountOptions {
  readonly responses?: readonly unknown[]
  readonly currentVersion?: number | null
  readonly selection?: VersionSelection
}

function mount({
  responses = [jsonResponse(THREE_VERSIONS)],
  currentVersion = 3,
  selection = NO_VERSION_SELECTED,
}: MountOptions = {}) {
  const transport = stubFetch(responses)
  const client = createApiClient({
    baseUrl: TEST_BASE_URL,
    fetch: transport.fetch,
    getAccessToken: () => 'token',
  })
  const onSelect = vi.fn<(next: VersionSelection) => void>()

  const rendered = render(
    <I18nextProvider i18n={i18nFor()}>
      <ApiProvider client={client} queryClient={createQueryClient()}>
        <VersionHistoryPanel
          handle={SLUG}
          currentVersion={currentVersion}
          selection={selection}
          onSelect={onSelect}
        />
      </ApiProvider>
    </I18nextProvider>
  )

  return { ...rendered, transport, onSelect }
}

/** Opens the disclosure and waits for the first page of history. */
async function openHistory(): Promise<void> {
  fireEvent.click(screen.getByRole('button', { name: enCircuits.history.open }))
  await screen.findAllByRole('button', { name: enCircuits.history.view })
}

describe('before the history is opened', () => {
  it('fetches nothing at all', () => {
    const { transport } = mount()
    // The editor is the one screen everybody loads. A history nobody asked to
    // see must not cost a round trip on every visit.
    expect(transport.calls).toHaveLength(0)
  })
})

describe('the listing', () => {
  it('shows every version newest first, with its note and its date', async () => {
    const { container } = mount()
    await openHistory()

    const rows = [...container.querySelectorAll('.history-item')]
    expect(
      rows.map((row) =>
        row.querySelector('.history-item__version')?.textContent?.trim()
      )
    ).toEqual(['Version 3the one you are editing', 'Version 2', 'Version 1'])

    expect(rows[0]?.textContent).toContain('Added the measurement')
    // A version saved without a note says so rather than showing a blank line
    // that reads as a rendering failure.
    expect(rows[1]?.textContent).toContain(enCircuits.history.noMessage)
  })

  it('formats the timestamps for the reader and keeps the machine value', async () => {
    const { container } = mount()
    await openHistory()

    const time = container.querySelector('time')
    const iso = '2024-05-03T09:15:00.000Z'
    expect(time?.getAttribute('datetime')).toBe(iso)
    expect(time?.textContent).toBe(
      new Intl.DateTimeFormat('en', {
        dateStyle: 'medium',
        timeStyle: 'short',
      }).format(new Date(iso))
    )
  })

  it('marks the version the open document descends from', async () => {
    const { container } = mount({ currentVersion: 2 })
    await openHistory()

    const badges = [...container.querySelectorAll('.history-item__badge')]
    expect(badges).toHaveLength(1)
    expect(badges[0]?.closest('.history-item')?.textContent).toContain(
      'Version 2'
    )
  })

  it('says which version the page is showing, in the accessibility tree', async () => {
    const { container } = mount({ selection: { version: 1, compare: null } })
    await openHistory()

    const current = container.querySelectorAll('[aria-current]')
    expect(current).toHaveLength(1)
    expect(current[0]?.textContent).toContain('Version 1')
  })

  it('reports a failure with the API code translated, and offers a retry', async () => {
    mount({ responses: [errorResponse('NOT_FOUND', 404)] })
    fireEvent.click(
      screen.getByRole('button', { name: enCircuits.history.open })
    )

    const alert = await screen.findByRole('alert')
    // The API sends a code and this app owns every word the reader sees.
    expect(alert.textContent).toBe(enErrors.NOT_FOUND)
    expect(alert.textContent).not.toContain('Developer-facing')
    expect(screen.getByRole('button', { name: enCircuits.retry })).toBeDefined()
  })
})

describe('choosing what to look at', () => {
  it('opens a version by putting it in the selection', async () => {
    const { onSelect } = mount()
    await openHistory()

    const rows = screen.getAllByRole('button', {
      name: enCircuits.history.view,
    })
    fireEvent.click(rows[1]!)
    expect(onSelect).toHaveBeenCalledWith({ version: 2, compare: null })
  })

  it('compares a version with the one before it', async () => {
    const { onSelect } = mount()
    await openHistory()

    const compare = screen.getAllByRole('button', {
      name: enCircuits.history.compareWithPrevious,
    })
    // Version 1 has nothing before it, so only two of the three rows offer it.
    expect(compare).toHaveLength(2)
    fireEvent.click(compare[0]!)
    expect(onSelect).toHaveBeenCalledWith({ version: 3, compare: 2 })
  })

  it('compares any two versions, oldest first whichever way they were picked', async () => {
    const { onSelect } = mount()
    await openHistory()

    // Deliberately backwards: the newer version chosen as the "from".
    fireEvent.change(screen.getByLabelText(enCircuits.history.compare.from), {
      target: { value: '3' },
    })
    fireEvent.change(screen.getByLabelText(enCircuits.history.compare.to), {
      target: { value: '1' },
    })
    fireEvent.click(
      screen.getByRole('button', { name: enCircuits.history.compare.submit })
    )

    // A diff runs from the older document to the newer one, and version
    // numbers are monotonic, so the smaller number is always the "from".
    expect(onSelect).toHaveBeenCalledWith({ version: 3, compare: 1 })
  })

  it('will not compare a version with itself', async () => {
    mount()
    await openHistory()

    fireEvent.change(screen.getByLabelText(enCircuits.history.compare.from), {
      target: { value: '2' },
    })
    fireEvent.change(screen.getByLabelText(enCircuits.history.compare.to), {
      target: { value: '2' },
    })
    expect(
      screen
        .getByRole('button', { name: enCircuits.history.compare.submit })
        .hasAttribute('disabled')
    ).toBe(true)
  })

  it('offers no comparison at all when there is only one version', async () => {
    mount({
      responses: [
        jsonResponse(
          versionPage([
            {
              versionNum: 1,
              message: null,
              createdAt: '2024-05-01T10:00:00.000Z',
            },
          ])
        ),
      ],
      currentVersion: 1,
    })
    await openHistory()

    expect(
      screen.queryByRole('button', { name: enCircuits.history.compare.submit })
    ).toBeNull()
  })
})
