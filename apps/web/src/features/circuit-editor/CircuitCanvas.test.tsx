import { parseCircuit, type Circuit, type CircuitInput } from '@qsim/schema'
import { cleanup, render, screen, within } from '@testing-library/react'
import { createInstance, type i18n as I18n } from 'i18next'
import { I18nextProvider, initReactI18next } from 'react-i18next'
import { afterEach, describe, expect, it } from 'vitest'

import enCommon from '../../i18n/locales/en/common.json'
import enEditor from '../../i18n/locales/en/editor.json'
import frEditor from '../../i18n/locales/fr/editor.json'
import { CircuitCanvas } from './CircuitCanvas'

/**
 * These tests read the canvas the way a screen reader does, through the ARIA
 * grid, and never through the SVG. That is deliberate and it is the point of
 * the design: the SVG is `aria-hidden`, so if a gate is reachable here it is
 * reachable to a user, and if it is not, no amount of correct drawing would
 * have helped. Asserting on shapes would pass a canvas that is beautiful and
 * mute.
 *
 * Since M0.5c the same grid is the editor's interactive surface, so a cell is
 * a `gridcell` rather than a table `cell` — one element that is at once the
 * description, the focus target and the drop target.
 */

afterEach(cleanup)

function i18nFor(language: 'en' | 'fr'): I18n {
  const instance = createInstance()
  void instance.use(initReactI18next).init({
    lng: language,
    fallbackLng: 'en',
    ns: ['common', 'editor'],
    defaultNS: 'common',
    resources: {
      en: { common: enCommon, editor: enEditor },
      fr: { editor: frEditor },
    },
    interpolation: { escapeValue: false },
    react: { useSuspense: false },
  })
  return instance
}

function draw(
  circuit: Circuit,
  props: Partial<Parameters<typeof CircuitCanvas>[0]> = {},
  language: 'en' | 'fr' = 'en'
) {
  return render(
    <I18nextProvider i18n={i18nFor(language)}>
      <CircuitCanvas circuit={circuit} {...props} />
    </I18nextProvider>
  )
}

function circuit(input: CircuitInput): Circuit {
  return parseCircuit(input)
}

/**
 * One circuit that exercises every shape the milestone owes: a box gate, a
 * CNOT, a negative control, a SWAP, a barrier, a parametrised rotation, a
 * measurement into the classical register, and an operation conditioned on
 * a classical bit.
 */
const SHOWCASE = circuit({
  schemaVersion: 1,
  qubits: 3,
  clbits: 2,
  operations: [
    { id: 'a', gate: 'h', targets: [0], column: 0 },
    { id: 'b', gate: 'cx', targets: [1], controls: [0], column: 1 },
    {
      id: 'c',
      gate: 'x',
      targets: [2],
      controls: [{ qubit: 1, state: 0 }],
      column: 2,
    },
    { id: 'd', gate: 'barrier', targets: [0, 1, 2], column: 3 },
    { id: 'e', gate: 'swap', targets: [0, 2], column: 4 },
    { id: 'f', gate: 'rz', targets: [1], params: [1.5707963], column: 5 },
    {
      id: 'g',
      gate: 'measure',
      targets: [0],
      clbitTargets: [0],
      column: 6,
    },
    {
      id: 'h',
      gate: 'z',
      targets: [2],
      condition: { clbit: 0, equals: 1 },
      column: 7,
    },
  ],
})

describe('the canvas as a whole', () => {
  it('is a labelled region', () => {
    draw(SHOWCASE)
    expect(
      screen.getByRole('region', { name: 'Quantum circuit diagram' })
    ).toBeDefined()
  })

  it('summarises the circuit for a reader arriving at the table', () => {
    draw(SHOWCASE)
    expect(
      screen.getByText(/Qubits: 3\. Columns: 8\. Operations: 8\./)
    ).toBeDefined()
  })

  it('gives every wire a row, the classical register included', () => {
    draw(SHOWCASE)
    for (const label of ['q0', 'q1', 'q2']) {
      expect(screen.getByRole('rowheader', { name: label })).toBeDefined()
    }
    expect(
      screen.getByRole('rowheader', { name: 'c classical register, 2 bits' })
    ).toBeDefined()
  })

  it('omits the classical wire from a circuit that has no register', () => {
    draw(circuit({ schemaVersion: 1, qubits: 2, operations: [] }))
    expect(screen.queryByRole('rowheader', { name: /classical/ })).toBeNull()
  })

  it('names every column of the grid it describes', () => {
    draw(SHOWCASE)
    expect(screen.getByRole('columnheader', { name: 'Column 0' })).toBeDefined()
    expect(screen.getByRole('columnheader', { name: 'Column 7' })).toBeDefined()
    // This circuit fills all eight columns the grid draws, so there is no
    // ninth. The next test covers the other case: a padded column is a
    // placement target and is named like any other.
    expect(screen.queryByRole('columnheader', { name: 'Column 8' })).toBeNull()
  })

  it('reaches every padded column, because each one is a placement target', () => {
    draw(circuit({ schemaVersion: 1, qubits: 1, operations: [] }), {
      minColumns: 4,
    })
    expect(screen.getAllByRole('gridcell')).toHaveLength(4)
    expect(screen.getAllByRole('gridcell', { name: 'free' })).toHaveLength(4)
  })
})

describe('what each cell says', () => {
  it('names a one-qubit gate by its catalog symbol', () => {
    draw(SHOWCASE)
    expect(screen.getByRole('gridcell', { name: 'H' })).toBeDefined()
  })

  it('tells the target of a CNOT from its control', () => {
    draw(SHOWCASE)
    expect(
      screen.getByRole('gridcell', { name: 'CNOT target controlled by q0' })
    ).toBeDefined()
    expect(screen.getByRole('gridcell', { name: 'CNOT control' })).toBeDefined()
  })

  it('says outright that a control is negative', () => {
    draw(SHOWCASE)
    expect(
      screen.getByRole('gridcell', {
        name: 'X negative control, fires on zero',
      })
    ).toBeDefined()
  })

  it('marks both ends of a SWAP', () => {
    draw(SHOWCASE)
    expect(screen.getAllByRole('gridcell', { name: 'SWAP' })).toHaveLength(2)
  })

  it('names a barrier without reciting its glyph', () => {
    draw(SHOWCASE)
    expect(screen.getAllByRole('gridcell', { name: 'barrier' })).toHaveLength(3)
  })

  it('reads the angle of a parametrised gate', () => {
    draw(SHOWCASE)
    expect(screen.getByRole('gridcell', { name: 'Rz θ = 1.571' })).toBeDefined()
  })

  it('says where a measurement is written, on both wires', () => {
    draw(SHOWCASE)
    expect(
      screen.getByRole('gridcell', { name: 'M measured into c0' })
    ).toBeDefined()
    expect(
      screen.getByRole('gridcell', {
        name: 'c0 receives the measurement of q0',
      })
    ).toBeDefined()
  })

  it('makes a classical dependency visible from both sides', () => {
    draw(SHOWCASE)
    expect(
      screen.getByRole('gridcell', { name: 'Z runs only if c0 equals 1' })
    ).toBeDefined()
    expect(
      screen.getByRole('gridcell', {
        name: 'read as a condition, c0 equals 1',
      })
    ).toBeDefined()
  })

  it('says an unoccupied cell is free rather than describing nothing', () => {
    const { container } = draw(SHOWCASE)
    const grid = container.querySelector('[role="grid"]')
    expect(grid).not.toBeNull()
    const empty = within(grid as HTMLElement)
      .getAllByRole('gridcell')
      .filter(
        (cell) =>
          cell.textContent?.trim() === '' &&
          cell.getAttribute('aria-readonly') === null
      )
    expect(empty.length).toBeGreaterThan(0)
    // Empty of content, but not nameless: a cursor lands here.
    expect(
      empty.every((cell) => cell.getAttribute('aria-label') === 'free')
    ).toBe(true)
  })

  it('uses the user’s own wire names when the circuit has them', () => {
    draw(
      circuit({
        schemaVersion: 1,
        qubits: 2,
        qubitLabels: ['alice', 'bob'],
        operations: [
          { id: 'a', gate: 'cx', targets: [1], controls: [0], column: 0 },
        ],
      })
    )
    expect(screen.getByRole('rowheader', { name: 'alice' })).toBeDefined()
    expect(
      screen.getByRole('gridcell', { name: 'CNOT target controlled by alice' })
    ).toBeDefined()
  })
})

describe('decision D2 reaches the accessible layer too', () => {
  it('describes cells in French while leaving the notation alone', () => {
    draw(SHOWCASE, {}, 'fr')
    expect(
      screen.getByRole('region', { name: 'Schéma de circuit quantique' })
    ).toBeDefined()
    expect(
      screen.getByRole('gridcell', { name: 'CNOT cible contrôlée par q0' })
    ).toBeDefined()
    // Intl formatting, not a hardcoded decimal point: fr writes 1,571.
    expect(screen.getByRole('gridcell', { name: 'Rz θ = 1,571' })).toBeDefined()
  })
})

describe('row controls', () => {
  it('offers one per wire when the editor is editable', () => {
    draw(SHOWCASE, {
      onRemoveQubit: () => undefined,
      onInsertQubitBelow: () => undefined,
    })
    expect(
      screen.getByRole('button', { name: 'Remove qubit q1' })
    ).toBeDefined()
    expect(
      screen.getByRole('button', { name: 'Insert a qubit below q1' })
    ).toBeDefined()
  })

  it('withholds them, and says why, when the canvas is read-only', () => {
    draw(SHOWCASE, {
      readOnly: true,
      onRemoveQubit: () => undefined,
      onInsertQubitBelow: () => undefined,
    })
    expect(screen.queryByRole('button', { name: /Remove qubit/ })).toBeNull()
    expect(screen.getByText(/Read-only on small screens/)).toBeDefined()
  })

  it('shows no controls at all when no handler was supplied', () => {
    draw(SHOWCASE)
    expect(screen.queryByRole('button')).toBeNull()
  })

  /*
   * The classical register gets the same pair. Without them a wire added
   * past the end of the register could never be measured, while the refusal
   * cheerfully advised adding a classical bit — a fix the UI did not offer.
   */
  it('offers the same pair for the classical register', () => {
    draw(SHOWCASE, {
      onAddClbit: () => undefined,
      onRemoveClbit: () => undefined,
    })
    expect(
      screen.getByRole('button', { name: 'Add a classical bit' })
    ).toBeDefined()
    expect(
      screen.getByRole('button', { name: 'Remove the last classical bit' })
    ).toBeDefined()
  })

  it('withholds the register controls when the canvas is read-only', () => {
    draw(SHOWCASE, {
      readOnly: true,
      onAddClbit: () => undefined,
      onRemoveClbit: () => undefined,
    })
    expect(screen.queryByRole('button', { name: /classical bit/ })).toBeNull()
  })

  /*
   * The gutter draws the classical row only while the register has width, so
   * the add control lives on the row the remove control would delete. One
   * bit is therefore the floor.
   */
  it('stops offering removal at the last classical bit', () => {
    draw(
      circuit({
        schemaVersion: 1,
        qubits: 2,
        clbits: 1,
        operations: [],
      }),
      { onAddClbit: () => undefined, onRemoveClbit: () => undefined }
    )
    expect(
      screen.getByRole('button', { name: 'Add a classical bit' })
    ).toBeDefined()
    expect(
      screen.queryByRole('button', { name: 'Remove the last classical bit' })
    ).toBeNull()
  })

  it('names the register controls in the active language', () => {
    draw(SHOWCASE, { onAddClbit: () => undefined }, 'fr')
    expect(
      screen.getByRole('button', { name: 'Ajouter un bit classique' })
    ).toBeDefined()
  })

  /*
   * Risk 6 and specification §10: below 768px the editor is read-only. The
   * breakpoint is asserted here rather than left to a manual browser resize
   * because it is the only place a viewport decides what the editor can do,
   * and a stray `min-` would silently invert it.
   */
  it('locks itself below the mobile breakpoint without being told to', () => {
    const original = Object.getOwnPropertyDescriptor(window, 'matchMedia')
    Object.defineProperty(window, 'matchMedia', {
      configurable: true,
      value: (query: string) => ({
        matches: query === '(max-width: 767px)',
        media: query,
        addEventListener: () => undefined,
        removeEventListener: () => undefined,
      }),
    })
    try {
      draw(SHOWCASE, { onRemoveQubit: () => undefined })
      expect(screen.queryByRole('button')).toBeNull()
      expect(screen.getByText(/Read-only on small screens/)).toBeDefined()
    } finally {
      if (original === undefined) delete (window as Partial<Window>).matchMedia
      else Object.defineProperty(window, 'matchMedia', original)
    }
  })
})

describe('scale', () => {
  it('still gives one row per wire at twenty qubits', () => {
    const wide = circuit({
      schemaVersion: 1,
      qubits: 20,
      operations: Array.from({ length: 20 }, (_, qubit) => ({
        id: `op_${qubit}`,
        gate: 'h',
        targets: [qubit],
        column: qubit,
      })),
    })
    draw(wide)
    expect(screen.getAllByRole('rowheader')).toHaveLength(20)
    expect(screen.getAllByRole('gridcell', { name: 'H' })).toHaveLength(20)
  })
})
