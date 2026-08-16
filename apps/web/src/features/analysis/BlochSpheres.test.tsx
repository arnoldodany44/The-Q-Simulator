/**
 * The Bloch spheres, as a reader who cannot see the canvas reads them.
 *
 * Every assertion here is against the table, and that is the design rather
 * than a limitation of jsdom: the WebGL scene is `aria-hidden`, so the table
 * is the rendering (see `BlochSpheres.tsx`). It is also why this suite can
 * assert the thing the milestone is actually about — that a Bell pair prints
 * zeros — without a GPU anywhere in sight.
 *
 * jsdom gives the second half for free as well. It has no WebGL, so the lazy
 * scene really does fail to get a context here, and the degradation path is
 * exercised on every run rather than being a branch nobody executes until a
 * reader on old hardware finds it.
 */

import { run, type Statevector } from '@qsim/core'
import { parseCircuit, type CircuitInput } from '@qsim/schema'
import { cleanup, render, screen, within } from '@testing-library/react'
import { createInstance, type i18n as I18n } from 'i18next'
import { I18nextProvider, initReactI18next } from 'react-i18next'
import { afterEach, describe, expect, it } from 'vitest'

import enAnalysis from '../../i18n/locales/en/analysis.json'
import esAnalysis from '../../i18n/locales/es/analysis.json'
import frAnalysis from '../../i18n/locales/fr/analysis.json'
import { BlochSpheres } from './BlochSpheres'

type Language = 'en' | 'es' | 'fr'

function i18nFor(language: Language): I18n {
  const instance = createInstance()
  void instance.use(initReactI18next).init({
    lng: language,
    fallbackLng: 'en',
    ns: ['analysis'],
    defaultNS: 'analysis',
    resources: {
      en: { analysis: enAnalysis },
      es: { analysis: esAnalysis },
      fr: { analysis: frAnalysis },
    },
    interpolation: { escapeValue: false },
    react: { useSuspense: false },
  })
  return instance
}

function stateOf(input: CircuitInput): Statevector {
  const result = run(parseCircuit(input))
  if (result.mode !== 'analytic') throw new Error('expected an analytic run')
  return result.state
}

function draw(state: Statevector, language: Language = 'en') {
  return render(
    <I18nextProvider i18n={i18nFor(language)}>
      <BlochSpheres state={state} />
    </I18nextProvider>
  )
}

/** Data rows, header excluded. */
function rows(): HTMLElement[] {
  return within(screen.getByRole('table')).getAllByRole('row').slice(1)
}

function cells(row: HTMLElement): string[] {
  return within(row)
    .getAllByRole('cell')
    .map((cell) => cell.textContent ?? '')
}

function wires(): string[] {
  return rows().map(
    (row) => within(row).getByRole('rowheader').textContent ?? ''
  )
}

/** H then CNOT: (|00⟩ + |11⟩)/√2 — each half maximally entangled. */
const BELL: CircuitInput = {
  schemaVersion: 1,
  qubits: 2,
  operations: [
    { id: 'a', gate: 'h', targets: [0], column: 0 },
    { id: 'b', gate: 'cx', targets: [1], controls: [0], column: 1 },
  ],
}

/** H on q0, X on q1: a product state, |+⟩ ⊗ |1⟩. */
const PRODUCT: CircuitInput = {
  schemaVersion: 1,
  qubits: 2,
  operations: [
    { id: 'a', gate: 'h', targets: [0], column: 0 },
    { id: 'b', gate: 'x', targets: [1], column: 0 },
  ],
}

/** Ry(π/3) then CNOT: partly entangled, |r| = cos(π/3) = ½ on both. */
const PARTIAL: CircuitInput = {
  schemaVersion: 1,
  qubits: 2,
  operations: [
    { id: 'a', gate: 'ry', targets: [0], column: 0, params: [Math.PI / 3] },
    { id: 'b', gate: 'cx', targets: [1], controls: [0], column: 1 },
  ],
}

/** A single qubit left in |0⟩. */
const GROUND: CircuitInput = {
  schemaVersion: 1,
  qubits: 1,
  operations: [],
}

afterEach(cleanup)

describe('a Bell pair — the milestone', () => {
  it('prints a zero vector for both halves', () => {
    draw(stateOf(BELL))

    for (const row of rows()) {
      const [x, y, z, length] = cells(row)
      expect(x).toBe('0.0000')
      expect(y).toBe('0.0000')
      expect(z).toBe('0.0000')
      expect(length).toBe('0.0000')
    }
  })

  it('says in words that neither qubit has a state of its own', () => {
    draw(stateOf(BELL))

    for (const row of rows()) {
      expect(cells(row).at(-1)).toBe(enAnalysis.bloch.reading.centre)
    }
  })

  it('never prints a negative zero', () => {
    /*
     * The components of an entangled qubit are differences of sums over 2ⁿ
     * terms, so they arrive as −0 or as −3e-17 as readily as as 0. Printed
     * through the amplitude rule that is `−0,0000`: a minus sign in front of
     * nothing, in the column whose whole message is that the number is
     * nothing.
     */
    draw(stateOf(BELL))

    for (const row of rows()) {
      for (const cell of cells(row).slice(0, 4)) {
        expect(cell).not.toContain('-')
        expect(cell).not.toContain('−')
      }
    }
  })

  it('reports the entanglement in its caption', () => {
    draw(stateOf(BELL))
    expect(
      screen.getByText(/2 qubits of 2 fall short of the surface/)
    ).toBeTruthy()
  })
})

describe('a product state', () => {
  it('gives each qubit its own unit vector', () => {
    draw(stateOf(PRODUCT))

    // |+⟩ is +x, |1⟩ is −z. Both reach the surface.
    expect(cells(rows()[0]!).slice(0, 4)).toEqual([
      '1.0000',
      '0.0000',
      '0.0000',
      '1.0000',
    ])
    expect(cells(rows()[1]!).slice(0, 4)).toEqual([
      '0.0000',
      '0.0000',
      '-1.0000',
      '1.0000',
    ])
  })

  it('calls every qubit pure, and says so in the caption', () => {
    draw(stateOf(PRODUCT))

    for (const row of rows()) {
      expect(cells(row).at(-1)).toBe(enAnalysis.bloch.reading.pure)
    }
    expect(
      screen.getByText(/All 2 qubits reach the surface of their spheres/)
    ).toBeTruthy()
  })

  it('puts |0⟩ at the north pole of its own sphere', () => {
    draw(stateOf(GROUND))
    expect(cells(rows()[0]!).slice(0, 4)).toEqual([
      '0.0000',
      '0.0000',
      '1.0000',
      '1.0000',
    ])
  })
})

describe('partial entanglement', () => {
  it('shortens the vector without collapsing it', () => {
    draw(stateOf(PARTIAL))

    for (const row of rows()) {
      const [x, y, z, length, , reading] = cells(row)
      expect(x).toBe('0.0000')
      expect(y).toBe('0.0000')
      expect(z).toBe('0.5000')
      expect(length).toBe('0.5000')
      expect(reading ?? cells(row).at(-1)).toBe(
        enAnalysis.bloch.reading.shortened
      )
    }
  })
})

describe('the register', () => {
  it('draws one row per qubit, named by its index', () => {
    draw(stateOf(PRODUCT))
    expect(wires()).toEqual(['q0', 'q1'])
  })

  it('describes its columns for a reader who cannot see the spheres', () => {
    draw(stateOf(BELL))
    const caption = within(screen.getByRole('table')).getByText(
      enAnalysis.bloch.table.caption
    )
    expect(caption).toBeTruthy()
  })

  it('hides the canvas from assistive technology', async () => {
    const { container } = draw(stateOf(BELL))
    // The scene arrives asynchronously; the table does not, and is already
    // asserted above. What matters here is that nothing it renders is ever
    // exposed — so both layers are checked once they exist.
    await screen.findByText(enAnalysis.bloch.unavailable)
    for (const element of container.querySelectorAll('canvas, svg')) {
      expect(element.getAttribute('aria-hidden')).toBe('true')
    }
  })
})

describe('when the browser cannot draw', () => {
  it('says so and keeps every number', async () => {
    // jsdom has no WebGL, so this is the real degradation path rather than a
    // simulated one: three.js loads, fails to obtain a context, and the panel
    // falls back to the rendering that was always carrying the meaning.
    draw(stateOf(BELL))

    expect(await screen.findByText(enAnalysis.bloch.unavailable)).toBeTruthy()
    expect(rows()).toHaveLength(2)
    expect(cells(rows()[0]!)[3]).toBe('0.0000')
  })
})

describe('every language', () => {
  it('writes the numbers the way the reader writes them', () => {
    draw(stateOf(PARTIAL), 'fr')
    // French writes a decimal comma. A hardcoded point would make 0,5000
    // read as five thousand for a third of this app's users (D2, §1.1).
    expect(cells(rows()[0]!)[3]).toBe('0,5000')
  })

  it('translates the reading into Spanish and French', () => {
    draw(stateOf(BELL), 'es')
    expect(cells(rows()[0]!).at(-1)).toBe(esAnalysis.bloch.reading.centre)
    cleanup()

    draw(stateOf(BELL), 'fr')
    expect(cells(rows()[0]!).at(-1)).toBe(frAnalysis.bloch.reading.centre)
  })

  it('translates the heading and the caption', () => {
    draw(stateOf(BELL), 'es')
    expect(screen.getByText(esAnalysis.bloch.heading)).toBeTruthy()
    expect(screen.getByText(esAnalysis.bloch.note)).toBeTruthy()
  })
})
