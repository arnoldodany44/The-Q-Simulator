import { run, type Statevector } from '@qsim/core'
import { parseCircuit, type CircuitInput } from '@qsim/schema'
import {
  cleanup,
  fireEvent,
  render,
  screen,
  within,
} from '@testing-library/react'
import { createInstance, type i18n as I18n } from 'i18next'
import { I18nextProvider, initReactI18next } from 'react-i18next'
import { afterEach, describe, expect, it } from 'vitest'

import enAnalysis from '../../i18n/locales/en/analysis.json'
import esAnalysis from '../../i18n/locales/es/analysis.json'
import frAnalysis from '../../i18n/locales/fr/analysis.json'
import { AmplitudeTable } from './AmplitudeTable'

/**
 * The exact reading of the state — §3.2's amplitude table.
 *
 * Unlike the histogram this has no drawing and no second rendering: a table
 * of numbers already *is* the accessible form, so every assertion below is
 * against the cells a reader sees.
 *
 * Three things are worth proving here. That a known state produces the known
 * amplitudes and phases — the table is the panel's ground truth and a sign
 * error in it would be believed. That the numbers are written in the reader's
 * language, in all three of them, because a hardcoded decimal point is a real
 * defect for two thirds of the locales this app ships (D2/§1.1). And that
 * sorting reorders rows without changing what any of them says.
 */

type Language = 'en' | 'es' | 'fr'

const CATALOGS: Record<Language, typeof enAnalysis> = {
  en: enAnalysis,
  es: esAnalysis,
  fr: frAnalysis,
}

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

function draw(
  state: Statevector,
  options: { language?: Language; rowLimit?: number } = {}
) {
  const { language = 'en', rowLimit } = options
  return render(
    <I18nextProvider i18n={i18nFor(language)}>
      <AmplitudeTable
        state={state}
        {...(rowLimit === undefined ? {} : { rowLimit })}
      />
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

function kets(): string[] {
  return rows().map(
    (row) => within(row).getByRole('rowheader').textContent ?? ''
  )
}

/** H then CNOT: (|00⟩ + |11⟩)/√2. */
const BELL: CircuitInput = {
  schemaVersion: 1,
  qubits: 2,
  operations: [
    { id: 'a', gate: 'h', targets: [0], column: 0 },
    { id: 'b', gate: 'cx', targets: [1], controls: [0], column: 1 },
  ],
}

/** H then S: (|0⟩ + i|1⟩)/√2. */
const IMAGINARY: CircuitInput = {
  schemaVersion: 1,
  qubits: 1,
  operations: [
    { id: 'a', gate: 'h', targets: [0], column: 0 },
    { id: 'b', gate: 's', targets: [0], column: 1 },
  ],
}

/** Ry(2·atan 2): |0⟩ at 20 %, |1⟩ at 80 % — the two orders disagree. */
const LOPSIDED: CircuitInput = {
  schemaVersion: 1,
  qubits: 1,
  operations: [
    {
      id: 'a',
      gate: 'ry',
      targets: [0],
      column: 0,
      params: [2 * Math.atan(2)],
    },
  ],
}

function uniform(qubits: number): CircuitInput {
  return {
    schemaVersion: 1,
    qubits,
    operations: Array.from({ length: qubits }, (_, qubit) => ({
      id: `h${qubit}`,
      gate: 'h',
      targets: [qubit],
      column: 0,
    })),
  }
}

afterEach(cleanup)

describe('a known state', () => {
  it('prints the amplitude, magnitude, probability and both phases', () => {
    draw(stateOf(BELL))

    expect(kets()).toEqual(['|00⟩', '|11⟩'])
    // 1/√2 as a real amplitude, its own magnitude, half the probability, and
    // no phase at all. Every one of those is a different column.
    expect(cells(rows()[0]!)).toEqual([
      '0.7071 + 0.0000i',
      '0.7071',
      '50%',
      '0',
      '0°',
    ])
  })

  it('reports an imaginary amplitude as a quarter turn of phase', () => {
    draw(stateOf(IMAGINARY))

    expect(cells(rows()[1]!)).toEqual([
      '0.0000 + 0.7071i',
      '0.7071',
      '50%',
      '1.5708',
      '90°',
    ])
  })

  it('says nothing about the basis states the circuit cannot reach', () => {
    // Two rows out of four. |01⟩ and |10⟩ have no amplitude, and a row of
    // zeros for them would be four times the table for none of the state.
    draw(stateOf(BELL))

    expect(rows()).toHaveLength(2)
  })
})

describe('every number is locale-formatted', () => {
  it.each(['es', 'fr'] as const)('writes the %s decimal comma', (language) => {
    draw(stateOf(BELL), { language })

    const [amplitude, magnitude, probability, radians] = cells(rows()[0]!)
    expect(amplitude).toBe('0,7071 + 0,0000i')
    expect(magnitude).toBe('0,7071')
    expect(probability).toMatch(/^50\s%$/u)
    expect(radians).toBe('0')
  })

  it('writes a French phase in radians with a comma', () => {
    draw(stateOf(IMAGINARY), { language: 'fr' })

    expect(cells(rows()[1]!)[3]).toBe('1,5708')
  })

  it('translates the column headings', () => {
    draw(stateOf(BELL), { language: 'fr' })

    const headers = within(screen.getByRole('table'))
      .getAllByRole('columnheader')
      .map((header) => header.textContent)
    expect(headers).toEqual([
      CATALOGS.fr.amplitudes.columns.state,
      CATALOGS.fr.amplitudes.columns.amplitude,
      CATALOGS.fr.amplitudes.columns.magnitude,
      CATALOGS.fr.amplitudes.columns.probability,
      CATALOGS.fr.amplitudes.columns.radians,
      CATALOGS.fr.amplitudes.columns.degrees,
    ])
  })
})

describe('sorting', () => {
  it('starts in basis-state order', () => {
    draw(stateOf(LOPSIDED))

    expect(kets()).toEqual(['|0⟩', '|1⟩'])
    expect(
      screen
        .getByRole('columnheader', {
          name: CATALOGS.en.amplitudes.columns.state,
        })
        .getAttribute('aria-sort')
    ).toBe('ascending')
  })

  it('puts the most probable state first when asked', () => {
    draw(stateOf(LOPSIDED))

    fireEvent.click(
      screen.getByRole('button', {
        name: CATALOGS.en.amplitudes.columns.probability,
      })
    )

    expect(kets()).toEqual(['|1⟩', '|0⟩'])
    // `aria-sort` on the header is how assistive technology learns this, and
    // it moves off the column that is no longer the sort.
    const headers = within(screen.getByRole('table')).getAllByRole(
      'columnheader'
    )
    expect(headers[3]?.getAttribute('aria-sort')).toBe('descending')
    expect(headers[0]?.getAttribute('aria-sort')).toBe('none')
  })

  it('reorders the rows without changing what any of them says', () => {
    draw(stateOf(LOPSIDED))
    const before = rows().map(cells)

    fireEvent.click(
      screen.getByRole('button', {
        name: CATALOGS.en.amplitudes.columns.probability,
      })
    )

    expect(rows().map(cells)).toEqual([before[1], before[0]])
  })

  it('goes back to basis-state order', () => {
    draw(stateOf(LOPSIDED))
    const byProbability = screen.getByRole('button', {
      name: CATALOGS.en.amplitudes.columns.probability,
    })
    const byState = screen.getByRole('button', {
      name: CATALOGS.en.amplitudes.columns.state,
    })

    fireEvent.click(byProbability)
    fireEvent.click(byState)

    expect(kets()).toEqual(['|0⟩', '|1⟩'])
  })
})

describe('the cap', () => {
  it('lists the remainder rather than dropping it', () => {
    draw(stateOf(uniform(5)), { rowLimit: 4 })

    // Four states plus one row standing for the other twenty-eight.
    expect(rows()).toHaveLength(5)
    const last = rows().at(-1)!
    expect(within(last).getByRole('rowheader').textContent).toBe(
      CATALOGS.en.amplitudes.table.remainder_other.replace('{{hidden}}', '28')
    )
    // No amplitude and no phase — those do not aggregate — but the
    // probability does, and it is the one figure the row prints.
    expect(cells(last)).toEqual([
      CATALOGS.en.amplitudes.table.noAmplitude,
      '87.5%',
      CATALOGS.en.amplitudes.table.mixedPhase,
    ])
  })

  it('announces the cap instead of applying it silently', () => {
    const { container } = draw(stateOf(uniform(5)), { rowLimit: 4 })

    expect(
      container.querySelector('.amplitudes__disclosure')?.textContent
    ).toBe(
      CATALOGS.en.amplitudes.caption.capped_other
        .replace('{{occupied}}', '32')
        .replace('{{total}}', '32')
        .replace('{{shown}}', '4')
        .replace('{{hidden}}', '28')
        .replace('{{share}}', '87.5%')
    )
  })

  it('keeps the remainder last however the table is sorted', () => {
    draw(stateOf(uniform(5)), { rowLimit: 4 })

    fireEvent.click(
      screen.getByRole('button', {
        name: CATALOGS.en.amplitudes.columns.probability,
      })
    )

    // It is not a basis state and has no probability of its own to rank by;
    // sorting it into the middle would make it read as one.
    expect(within(rows().at(-1)!).getByRole('rowheader').textContent).toContain(
      '28'
    )
  })

  it('says everything is listed when nothing was left out', () => {
    const { container } = draw(stateOf(BELL))

    expect(
      container.querySelector('.amplitudes__disclosure')?.textContent
    ).toBe(
      CATALOGS.en.amplitudes.caption.complete_other
        .replace('{{occupied}}', '2')
        .replace('{{total}}', '4')
    )
  })
})
