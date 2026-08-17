import { CIRCUIT_SCHEMA_VERSION, parseCircuit } from '@qsim/schema'
import { cleanup, render, screen } from '@testing-library/react'
import { createInstance, type i18n as I18n } from 'i18next'
import { I18nextProvider, initReactI18next } from 'react-i18next'
import { afterEach, describe, expect, it } from 'vitest'

import enAnalysis from '../i18n/locales/en/analysis.json'
import enEmbed from '../i18n/locales/en/embed.json'
import esAnalysis from '../i18n/locales/es/analysis.json'
import esEmbed from '../i18n/locales/es/embed.json'
import frAnalysis from '../i18n/locales/fr/analysis.json'
import frEmbed from '../i18n/locales/fr/embed.json'
import { EmbedView } from './EmbedView'
import { documentFromLink } from './document'
import type { EmbedDocument } from './document'
import type { EmbedSimulation } from './useEmbedSimulation'

/**
 * What a frame puts inside somebody else's page.
 *
 * Two properties are asserted as properties rather than as examples, because
 * both are the kind of thing a later change breaks silently:
 *
 *   - EVERY LINK OPENS A NEW TAB. The frame must keep showing the frame; a
 *     link that navigated it would turn an embed into a way to wander this
 *     app inside a stranger's layout, which is what "no navigation out"
 *     forbids. Asserted over every anchor in the document rather than over
 *     the one that exists today.
 *   - NOTHING IN IT CAN BE PRESSED. No editor, no star, no fork, no sign-in.
 *     A control in a frame is a control on somebody else's page.
 */

afterEach(cleanup)

type Language = 'en' | 'es' | 'fr'

const CATALOGS = {
  en: { embed: enEmbed, analysis: enAnalysis },
  es: { embed: esEmbed, analysis: esAnalysis },
  fr: { embed: frEmbed, analysis: frAnalysis },
}

function i18nFor(language: Language): I18n {
  const instance = createInstance()
  void instance.use(initReactI18next).init({
    lng: language,
    fallbackLng: 'en',
    ns: ['embed', 'analysis'],
    defaultNS: 'embed',
    resources: CATALOGS,
    interpolation: { escapeValue: false },
    react: { useSuspense: false },
  })
  return instance
}

const BELL = parseCircuit({
  schemaVersion: CIRCUIT_SCHEMA_VERSION,
  qubits: 2,
  clbits: 0,
  operations: [
    { id: 'op-0', gate: 'h', targets: [0], column: 0 },
    { id: 'op-1', gate: 'cx', targets: [1], controls: [0], column: 1 },
  ],
})

function saved(): EmbedDocument {
  return {
    circuit: BELL,
    title: 'Bell pair',
    author: 'ada',
    slug: 'V1StGXR8Z5jdHi6B',
    qubitCount: 2,
    gateCount: 2,
    depth: 2,
  }
}

const RUNNING: EmbedSimulation = { status: 'running' }

function draw(
  document: EmbedDocument,
  simulation: EmbedSimulation = RUNNING,
  language: Language = 'en'
) {
  return render(
    <I18nextProvider i18n={i18nFor(language)}>
      <EmbedView
        document={document}
        simulation={simulation}
        origin="https://qsim.test"
      />
    </I18nextProvider>
  )
}

describe('what a frame shows', () => {
  it('names the circuit and credits its author', () => {
    draw(saved())

    expect(screen.getByRole('heading', { level: 1 }).textContent).toBe(
      'Bell pair'
    )
    expect(screen.getByText(/ada/).textContent).toContain('ada')
  })

  it('prints the counters the server computed', () => {
    // Real text beside the drawing: the accessible account of the circuit's
    // size, and what stays true when the analysis cannot be computed at all.
    draw(saved())

    for (const label of ['Qubits', 'Gates', 'Depth']) {
      expect(screen.getByText(label).nextElementSibling?.textContent).toBe('2')
    }
  })

  it('labels the drawing instead of hiding it', () => {
    /*
     * Unlike the editor's canvas and the gallery's thumbnail, this drawing is
     * complete and has no ARIA grid beside it — so it is named and described,
     * the way the exported SVG is, because an embed is read by screen readers
     * in a page this project does not control.
     */
    draw(saved())

    const diagram = screen.getByRole('img')
    expect(diagram.querySelector('title')?.textContent).toBe('Circuit diagram')
    expect(diagram.querySelector('desc')?.textContent).toContain('2 qubits')
    expect(diagram.getAttribute('aria-hidden')).toBeNull()
  })

  it('says something rather than nothing while the answer is on its way', () => {
    draw(saved(), { status: 'running' })
    expect(screen.getByRole('status').textContent).toMatch(/Simulating/)
  })

  it('keeps the drawing when the simulation refuses', () => {
    /*
     * The refusal is a sentence and the circuit is still on screen. An embed
     * that blanked here would be indistinguishable, in the middle of a slide,
     * from an embed that was never there.
     */
    draw(saved(), {
      status: 'failed',
      code: 'too-many-qubits',
      values: { qubits: 24, limit: 20 },
    })

    expect(screen.getByRole('img')).not.toBeNull()
    expect(screen.getByRole('status').textContent).toContain('24')
    expect(screen.getByRole('status').textContent).toContain('20')
  })

  it('words a failure code it has no sentence for', () => {
    // The engine's code list is longer than the reader-facing vocabulary, and
    // a code with no sentence must not render as the code.
    draw(saved(), {
      status: 'failed',
      code: 'server-refused',
      values: {},
    })

    expect(screen.getByRole('status').textContent ?? '').not.toMatch(
      /server-refused/
    )
  })
})

describe('a circuit that was never saved', () => {
  it('names itself without inventing an author', () => {
    // A `?c=` document has no row, so no title and nobody to credit. The
    // heading falls back to a translated noun rather than to an empty line.
    draw(documentFromLink(BELL))

    expect(screen.getByRole('heading', { level: 1 }).textContent).toBe(
      'Quantum circuit'
    )
    expect(screen.queryByText(/^by /)).toBeNull()
  })

  it('has no link at all, because there is no page to link to', () => {
    const { container } = draw(documentFromLink(BELL))
    expect(container.querySelectorAll('a')).toHaveLength(0)
  })

  it('derives its counters from the circuit itself', () => {
    const document = documentFromLink(BELL)
    expect(document.gateCount).toBe(2)
    expect(document.depth).toBe(2)
    expect(document.qubitCount).toBe(2)
  })
})

describe('no navigation, and nothing to press', () => {
  it('opens every link in a new tab, with no handle back to this one', () => {
    const { container } = draw(saved())

    const links = [...container.querySelectorAll('a')]
    expect(links.length).toBeGreaterThan(0)
    for (const link of links) {
      expect(link.getAttribute('target')).toBe('_blank')
      // `noopener` denies the new context a handle back; `noreferrer`
      // withholds the address, which for an UNLISTED circuit is the
      // credential §11 sized at 126 bits.
      expect(link.getAttribute('rel')).toContain('noopener')
      expect(link.getAttribute('rel')).toContain('noreferrer')
    }
  })

  it('renders no control of any kind', () => {
    const { container } = draw(saved(), {
      status: 'failed',
      code: 'worker-unavailable',
      values: {},
    })

    expect(container.querySelectorAll('button')).toHaveLength(0)
    expect(container.querySelectorAll('input')).toHaveLength(0)
    expect(container.querySelectorAll('form')).toHaveLength(0)
    expect(container.querySelectorAll('select')).toHaveLength(0)
  })
})

describe('the three languages (D2)', () => {
  it.each(['en', 'es', 'fr'] as const)(
    'renders %s without a raw key',
    (language) => {
      const { container } = draw(
        saved(),
        { status: 'failed', code: 'worker-unavailable', values: {} },
        language
      )

      /*
       * The same shape `e2e/no-raw-keys.spec.ts` asserts on a live page, made
       * here over a state that suite cannot reach: the frame only fails to
       * spawn a worker inside a sandbox no test server sets. Leaf nodes and an
       * anchored pattern, exactly as there — a walk over concatenated text
       * would match `qubit.q0` across an element boundary and report a defect
       * that is two strings sitting next to each other.
       */
      const leaves = [...container.querySelectorAll('*')]
        .filter((element) => element.children.length === 0)
        .map((element) => (element.textContent ?? '').trim())
      expect(
        leaves.filter((text) => /^[a-z][a-zA-Z]*(\.[a-zA-Z]+)+$/.test(text))
      ).toEqual([])
      expect((container.textContent ?? '').length).toBeGreaterThan(20)
    }
  )
})
