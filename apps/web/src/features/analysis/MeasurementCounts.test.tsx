import { createRng, runTrajectory, formatRegister } from '@qsim/core'
import { cleanup, render, screen, within } from '@testing-library/react'
import { createInstance, type i18n as I18n } from 'i18next'
import { I18nextProvider, initReactI18next } from 'react-i18next'
import { afterEach, describe, expect, it } from 'vitest'

import { findPreset } from '../circuit-editor/presets'
import enAnalysis from '../../i18n/locales/en/analysis.json'
import esAnalysis from '../../i18n/locales/es/analysis.json'
import frAnalysis from '../../i18n/locales/fr/analysis.json'
import { MeasurementCounts } from './MeasurementCounts'
import { formatCount } from './format'

/**
 * The tally a measuring circuit answers with.
 *
 * The interesting assertions are the two that are easy to get wrong and
 * invisible when they are: that the shares are written in the reader's own
 * language — French uses a decimal comma and a non-breaking space before the
 * percent sign, and a hardcoded dot is a real defect for a third of the users
 * (D2/§1.1) — and that a capped table still accounts for every run.
 */

afterEach(cleanup)

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

function draw(
  counts: Record<string, number>,
  options: { language?: Language; rowLimit?: number } = {}
) {
  const { language = 'en', rowLimit } = options
  return render(
    <I18nextProvider i18n={i18nFor(language)}>
      <MeasurementCounts
        counts={counts}
        {...(rowLimit === undefined ? {} : { rowLimit })}
      />
    </I18nextProvider>
  )
}

/** The row whose header cell reads `label`. */
function rowFor(label: string): HTMLElement {
  const cell = screen.getByRole('rowheader', { name: label })
  const row = cell.closest('tr')
  if (row === null) throw new Error(`no row for ${label}`)
  return row
}

describe('the tally', () => {
  it('lists every reading with its count and share', () => {
    draw({ '00': 512, '11': 512 })

    for (const label of ['00', '11']) {
      const cells = within(rowFor(label)).getAllByRole('cell')
      expect(cells[0]?.textContent).toBe('512')
      expect(cells[1]?.textContent).toContain('50%')
    }
  })

  it('says how many runs and how many distinct readings', () => {
    draw({ '00': 500, '01': 12, '10': 12, '11': 500 })
    expect(screen.getByText(/1,024 times/)).toBeDefined()
    expect(screen.getByText(/4 different values/)).toBeDefined()
  })

  it.each(['en', 'es', 'fr'] as const)(
    'puts a single reading in the singular in %s',
    (language) => {
      // The most obvious first experiment there is: measure one qubit that has
      // had nothing done to it. Every run reads 0, so there is one reading —
      // and the sentence used to say "read 1 different values" in all three.
      const { container } = draw({ '0': 1000 }, { language })
      const intro =
        container.querySelector('.measurement-counts__intro')?.textContent ?? ''

      expect(intro).toBe(
        CATALOGS[language].counts.intro_one.replace(
          '{{shots}}',
          formatCount(1000, language)
        )
      )
      expect(CATALOGS[language].counts.intro_one).not.toBe(
        CATALOGS[language].counts.intro_other
      )
    }
  )

  it('draws readings in register order, not in count order', () => {
    draw({ '11': 900, '00': 100, '10': 24 })
    const headers = screen
      .getAllByRole('rowheader')
      .map((cell) => cell.textContent)
    expect(headers).toEqual(['00', '10', '11'])
  })

  it('accounts for the runs the cap leaves out', () => {
    const counts = Object.fromEntries(
      Array.from({ length: 6 }, (_, index) => [
        index.toString(2).padStart(3, '0'),
        (index + 1) * 10,
      ])
    )
    draw(counts, { rowLimit: 2 })

    const remainder = screen.getByRole('rowheader', {
      name: /The other 4 readings, together/,
    })
    const cells = within(remainder.closest('tr')!).getAllByRole('cell')
    // 10 + 20 + 30 + 40 of a total of 210 — nothing is silently dropped.
    expect(cells[0]?.textContent).toBe('100')
  })

  it('has something to say about an empty tally', () => {
    draw({})
    expect(screen.getByText('No run produced a reading.')).toBeDefined()
    expect(screen.queryByRole('table')).toBeNull()
  })
})

describe('numbers are written in the reader’s language (D2)', () => {
  it('uses a decimal comma and a grouped count in French', () => {
    draw({ '00': 1500, '01': 500 }, { language: 'fr' })

    // Whitespace is compared class by class rather than character by
    // character on purpose: the separator French `Intl` puts before a percent
    // sign and inside a group is a narrow no-break space, not U+0020, and a
    // test demanding a plain space would be asserting the opposite of what
    // §1.1 asks for.
    const spaced = (text: string | null): string =>
      (text ?? '').replace(/\s/gu, ' ')

    const cells = within(rowFor('01')).getAllByRole('cell')
    // 500 of 2000 is 25 %, with the space before the sign that no
    // concatenation of ours could have produced.
    expect(spaced(cells[1]?.textContent ?? '')).toContain('25 %')
    expect(
      spaced(screen.getByText(/valeurs différentes/).textContent)
    ).toContain('2 000 fois')
  })

  it('uses a decimal comma where the share is not a round number', () => {
    draw({ '0': 1, '1': 7 }, { language: 'fr' })
    const cells = within(rowFor('0')).getAllByRole('cell')
    // 1 of 8 is 12,5 % — the comma is the whole point.
    expect(cells[1]?.textContent).toContain('12,5')
  })

  it('translates the headings', () => {
    draw({ '0': 1 }, { language: 'es' })
    expect(
      screen.getByRole('columnheader', { name: 'Ejecuciones' })
    ).toBeDefined()
  })

  it('never translates a register reading', () => {
    draw({ '01': 1 }, { language: 'fr' })
    const cell = screen.getByRole('rowheader', { name: '01' })
    expect(cell.querySelector('[translate="no"]')?.textContent).toBe('01')
  })
})

describe('against a real run', () => {
  it('describes the teleportation preset the engine actually produced', () => {
    // End to end on the one preset this component exists for: the labels in
    // the table are the register strings the engine wrote, not strings this
    // test invented.
    const preset = findPreset('teleportation')
    const counts: Record<string, number> = {}
    const shots = 600
    for (let seed = 1; seed <= shots; seed += 1) {
      const { register } = runTrajectory(preset!.circuit, createRng(seed))
      const label = formatRegister(register)
      counts[label] = (counts[label] ?? 0) + 1
    }

    draw(counts)

    // Three bits, highest first: c2 is the qubit the message arrived on, and
    // c1c0 are the two Alice sent. Every one of the eight readings occurs.
    const headers = screen
      .getAllByRole('rowheader')
      .map((cell) => cell.textContent)
    expect(headers).toEqual([
      '000',
      '001',
      '010',
      '011',
      '100',
      '101',
      '110',
      '111',
    ])

    /*
     * And the table shows what the preset exists to show. The four readings
     * beginning with 1 are the runs where Bob's qubit read 1, which is the
     * message's own 75/25 split arriving on a wire nothing touched — the whole
     * point of `MESSAGE_ANGLE` being lopsided, and the thing this panel could
     * not put on screen while the circuit stopped at two classical bits.
     */
    const arrived = Object.entries(counts)
      .filter(([label]) => label.startsWith('1'))
      .reduce((sum, [, count]) => sum + count, 0)
    // √(p(1−p)/n) is 1,77 % at p = ¼ over 600 runs; 6 % is three of those.
    expect(Math.abs(arrived / shots - 0.25)).toBeLessThan(0.06)
  })
})
