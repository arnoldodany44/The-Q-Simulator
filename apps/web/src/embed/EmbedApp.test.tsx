import { CIRCUIT_SCHEMA_VERSION, parseCircuit } from '@qsim/schema'
import { cleanup, render, screen } from '@testing-library/react'
import { createInstance, type i18n as I18n } from 'i18next'
import { I18nextProvider, initReactI18next } from 'react-i18next'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { encode } from '../lib/circuit-url'
import enAnalysis from '../i18n/locales/en/analysis.json'
import enEmbed from '../i18n/locales/en/embed.json'
import { EmbedApp } from './EmbedApp'

/**
 * Address in, circuit out — the frame's whole state machine.
 *
 * The assertion that matters most is the last one: a circuit that is PRIVATE
 * and a slug that names nothing must produce the SAME sentence. The server
 * answers both with the same 404 on purpose (§11), and a client that worded
 * them differently would put the distinction back — in a blog post, where
 * anybody can read it.
 *
 * The simulation is not exercised here. `useEmbedSimulation` spawns a real
 * `Worker` when nothing is injected, which jsdom does not have; what this
 * suite asserts is what is on screen *before* an answer, which is the state a
 * reader with a slow connection sees and the state most easily left blank.
 */

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

const BELL = parseCircuit({
  schemaVersion: CIRCUIT_SCHEMA_VERSION,
  qubits: 2,
  clbits: 0,
  operations: [
    { id: 'op-0', gate: 'h', targets: [0], column: 0 },
    { id: 'op-1', gate: 'cx', targets: [1], controls: [0], column: 1 },
  ],
})

function i18n(): I18n {
  const instance = createInstance()
  void instance.use(initReactI18next).init({
    lng: 'en',
    fallbackLng: 'en',
    ns: ['embed', 'analysis'],
    defaultNS: 'embed',
    resources: { en: { embed: enEmbed, analysis: enAnalysis } },
    interpolation: { escapeValue: false },
    react: { useSuspense: false },
  })
  return instance
}

/**
 * A `Worker` that does nothing, so the hook's production path can run under
 * jsdom without reaching for a constructor that is not there. The simulation
 * itself is covered by `useEmbedSimulation.test.ts`.
 */
function stubWorkerConstructor(): void {
  vi.stubGlobal(
    'Worker',
    class {
      postMessage(): void {}
      terminate(): void {}
      onmessage: unknown = null
      onerror: unknown = null
    }
  )
}

function draw(pathname: string, search = '') {
  stubWorkerConstructor()
  return render(
    <I18nextProvider i18n={i18n()}>
      <EmbedApp
        pathname={pathname}
        search={search}
        origin="https://qsim.test"
      />
    </I18nextProvider>
  )
}

function answering(status: number, payload: unknown): void {
  vi.stubGlobal(
    'fetch',
    vi.fn(() =>
      Promise.resolve({
        ok: status >= 200 && status < 300,
        status,
        json: () => Promise.resolve(payload),
      } as unknown as Response)
    )
  )
}

describe('a circuit carried in its own link', () => {
  it('renders without asking any server', () => {
    // Decision D4: the link *is* the document. This is what makes an embed
    // work on a deployment with no API at all — the state Phase 0 shipped in.
    const fetchSpy = vi.fn()
    vi.stubGlobal('fetch', fetchSpy)

    draw('/embed', `?c=${encode(BELL)}`)

    expect(screen.getByRole('heading', { level: 1 }).textContent).toBe(
      'Quantum circuit'
    )
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it('says so when the payload will not decode', () => {
    draw('/embed', '?c=not-a-real-payload')
    expect(screen.getByRole('status').textContent).toMatch(/could not be read/)
  })
})

describe('an address that is not one', () => {
  it('says what is wrong instead of rendering nothing', () => {
    // A blank rectangle in the middle of a lecture slide is indistinguishable
    // from an embed that was never there.
    draw('/embed/c/../../etc')
    expect(screen.getByRole('status').textContent).toMatch(
      /not given a circuit/
    )
  })
})

describe('a saved circuit', () => {
  it('shows a loading line before the answer arrives', () => {
    answering(200, {
      embed: {
        slug: 'V1StGXR8Z5jdHi6B',
        title: 'Bell pair',
        qubitCount: 2,
        gateCount: 2,
        depth: 2,
        author: { username: 'ada' },
        circuit: BELL,
      },
    })

    draw('/embed/c/V1StGXR8Z5jdHi6B')

    expect(screen.getByRole('status').textContent).toMatch(/Loading/)
  })

  it('worries the reader with nothing more than "not available"', async () => {
    /*
     * THE ASSERTION THIS FILE EXISTS FOR. The server answers a PRIVATE
     * circuit and a slug nobody minted with the same 404, so the frame has to
     * answer both with the same sentence — and that sentence must name
     * neither possibility, or the distinction is back and readable by anyone
     * who loads the page.
     */
    answering(404, { error: { code: 'NOT_FOUND' } })

    draw('/embed/c/V1StGXR8Z5jdHi6B')

    const notice = await screen.findByText(/not available to embed/)
    expect(notice.textContent).not.toMatch(/private|does not exist|deleted/i)
  })
})
