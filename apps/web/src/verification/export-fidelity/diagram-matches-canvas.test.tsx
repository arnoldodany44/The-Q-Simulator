import { parseCircuit, type Circuit, type CircuitInput } from '@qsim/schema'
import { cleanup, render } from '@testing-library/react'
import { createInstance, type i18n as I18n } from 'i18next'
import { renderToStaticMarkup } from 'react-dom/server'
import { I18nextProvider, initReactI18next } from 'react-i18next'
import { afterEach, describe, expect, it } from 'vitest'

import enCommon from '../../i18n/locales/en/common.json'
import enEditor from '../../i18n/locales/en/editor.json'
import { CircuitCanvas } from '../../features/circuit-editor/CircuitCanvas'
import { circuitToSvg } from '../../features/export/diagram'

/**
 * THE DOWNLOADED DIAGRAM IS THE ONE ON SCREEN.
 *
 * The brief for M1.7 asks the export to reuse the canvas rendering rather than
 * drawing the circuit a third way, and the reason is not tidiness: two
 * renderers drift, and the one that drifts is the one nobody looks at. A gate
 * whose glyph changed in the editor and not in the export would go unnoticed
 * until somebody put a wrong picture in a paper.
 *
 * `CircuitPlot` is the shared component that makes them one drawing. This file
 * is the check that they *stay* one: it renders the canvas into the DOM,
 * renders the export into a string, and compares the census of shapes — every
 * element, by tag and by class — inside the operations layer. A
 * re-implementation would have to reproduce that census exactly to pass, which
 * is another way of saying it would have to be the same drawing.
 *
 * What is deliberately not compared: the wires layer (the export draws its
 * plot at its own width, so the line coordinates differ by design) and the
 * editor's overlays — the ARIA grid, the selection halo, the scrubber's
 * playhead — which are states of the editor rather than parts of the circuit.
 */

afterEach(cleanup)

const CIRCUITS: readonly [string, CircuitInput][] = [
  [
    'every glyph the canvas can draw',
    {
      schemaVersion: 1,
      qubits: 4,
      clbits: 2,
      operations: [
        { id: 'op_1', gate: 'h', targets: [0], column: 0 },
        { id: 'op_2', gate: 'cx', targets: [1], controls: [0], column: 1 },
        { id: 'op_3', gate: 'swap', targets: [1, 2], column: 2 },
        {
          id: 'op_4',
          gate: 'x',
          targets: [3],
          controls: [{ qubit: 0, state: 0 }],
          column: 3,
        },
        { id: 'op_5', gate: 'barrier', targets: [0, 1, 2, 3], column: 4 },
        { id: 'op_6', gate: 'rz', targets: [2], params: [0.5], column: 5 },
        {
          id: 'op_7',
          gate: 'measure',
          targets: [0],
          clbitTargets: [0],
          column: 6,
        },
        {
          id: 'op_8',
          gate: 'z',
          targets: [3],
          column: 7,
          condition: { clbit: 0, equals: 1 },
        },
      ],
    },
  ],
  [
    'a circuit with no classical register',
    {
      schemaVersion: 1,
      qubits: 2,
      operations: [
        { id: 'op_1', gate: 'h', targets: [0], column: 0 },
        { id: 'op_2', gate: 'cx', targets: [1], controls: [0], column: 1 },
      ],
    },
  ],
]

describe.each(CIRCUITS)('%s', (_name, input) => {
  const circuit = parseCircuit(input)

  it('is drawn identically in the canvas and in the exported SVG', () => {
    expect(exportCensus(circuit)).toEqual(canvasCensus(circuit))
  })
})

/** Every shape the editor's own SVG puts in its operations layer. */
function canvasCensus(circuit: Circuit): string[] {
  const { container } = render(
    <I18nextProvider i18n={english()}>
      <CircuitCanvas circuit={circuit} />
    </I18nextProvider>
  )
  const operations = container.querySelector('.qsim-operations')
  expect(operations).not.toBeNull()
  return census(operations as Element)
}

/** Every shape the exported file puts in the same layer. */
function exportCensus(circuit: Circuit): string[] {
  const { svg } = circuitToSvg(circuit, renderToStaticMarkup, {
    title: 'Quantum circuit',
    description: 'A circuit.',
  })
  const document_ = new DOMParser().parseFromString(svg, 'image/svg+xml')
  const operations = document_.querySelector('.qsim-operations')
  expect(operations).not.toBeNull()
  return census(operations as Element)
}

/**
 * Tag and class of every descendant, in document order. Coordinates are left
 * out on purpose: the export lays the plot out at its own width and starts it
 * after the wire-name gutter, so the numbers legitimately differ while the
 * drawing does not.
 */
function census(root: Element): string[] {
  return [...root.querySelectorAll('*')].map(
    (element) => `${element.tagName}.${element.getAttribute('class') ?? ''}`
  )
}

function english(): I18n {
  const instance = createInstance()
  void instance.use(initReactI18next).init({
    lng: 'en',
    fallbackLng: 'en',
    ns: ['common', 'editor'],
    defaultNS: 'common',
    resources: { en: { common: enCommon, editor: enEditor } },
    interpolation: { escapeValue: false },
    react: { useSuspense: false },
  })
  return instance
}
