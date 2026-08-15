import { run, type Statevector } from '@qsim/core'
import { parseCircuit, type CircuitInput } from '@qsim/schema'
import { cleanup, render, screen, within } from '@testing-library/react'
import { createInstance, type i18n as I18n } from 'i18next'
import { I18nextProvider, initReactI18next } from 'react-i18next'
import { afterEach, describe, expect, it } from 'vitest'

import enAnalysis from '../../i18n/locales/en/analysis.json'
import esAnalysis from '../../i18n/locales/es/analysis.json'
import frAnalysis from '../../i18n/locales/fr/analysis.json'
import { REDUCED_MOTION_QUERY } from '../../lib/usePrefersReducedMotion'
import { ProbabilityHistogram } from './ProbabilityHistogram'

/**
 * The signature element, read two ways.
 *
 * The SVG is `aria-hidden`, exactly as the circuit canvas is, so everything
 * a screen reader gets comes from the table underneath — and the table is
 * therefore where most of these assertions live. What is asserted on the
 * drawing itself is only what the table cannot carry: the *direction* of
 * each phasor, which is the primary encoding of phase (§10), and the length
 * of each bar, which is the probability.
 *
 * `prefers-reduced-motion` is driven through a real `matchMedia` stub rather
 * than through a test-only prop, because the hook reading that query is part
 * of what is being tested: §10 does not ask for the arrows to stop, it asks
 * for the numbers to appear in their place.
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
  options: {
    language?: Language
    barLimit?: number
    fullBasis?: boolean
    phasors?: boolean
  } = {}
) {
  const { language = 'en', barLimit, fullBasis, phasors } = options
  return render(
    <I18nextProvider i18n={i18nFor(language)}>
      <ProbabilityHistogram
        state={state}
        {...(barLimit === undefined ? {} : { barLimit })}
        {...(fullBasis === undefined ? {} : { fullBasis })}
        {...(phasors === undefined ? {} : { phasors })}
      />
    </I18nextProvider>
  )
}

/**
 * A `matchMedia` jsdom does not ship. Only the reduced-motion query answers
 * true, so a component asking a different question is not accidentally told
 * yes.
 */
function stubMotionPreference(reduce: boolean): void {
  Object.defineProperty(window, 'matchMedia', {
    writable: true,
    configurable: true,
    value: (query: string) => ({
      matches: reduce && query === REDUCED_MOTION_QUERY,
      media: query,
      onchange: null,
      addEventListener: () => undefined,
      removeEventListener: () => undefined,
      addListener: () => undefined,
      removeListener: () => undefined,
      dispatchEvent: () => false,
    }),
  })
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

/** The drawn bars, in the order the SVG lays them out. */
function fills(container: HTMLElement): SVGRectElement[] {
  return [...container.querySelectorAll<SVGRectElement>('.histogram__fill')]
}

function needles(container: HTMLElement): SVGGElement[] {
  return [...container.querySelectorAll<SVGGElement>('.phasor__needle')]
}

/** The rows that carry a phase — the remainder row is not one of them. */
function phaseRows(container: HTMLElement): SVGGElement[] {
  return [
    ...container.querySelectorAll<SVGGElement>(
      '.histogram__row:not(.histogram__row--remainder)'
    ),
  ]
}

function trackWidth(container: HTMLElement): number {
  const track = container.querySelector('.histogram__track')
  return Number(track?.getAttribute('width') ?? 0)
}

function rows(): HTMLElement[] {
  const table = screen.getByRole('table')
  return within(table).getAllByRole('row').slice(1)
}

afterEach(() => {
  cleanup()
  Reflect.deleteProperty(window, 'matchMedia')
})

describe('a Bell pair', () => {
  it('is exactly two bars at one half', () => {
    const { container } = draw(stateOf(BELL))

    const bars = fills(container)
    expect(bars).toHaveLength(2)

    // Half the track each: the bar *is* the probability, drawn to scale.
    const track = trackWidth(container)
    for (const bar of bars) {
      expect(Number(bar.getAttribute('width'))).toBeCloseTo(track / 2, 6)
    }

    const cells = rows().map((row) =>
      within(row)
        .getAllByRole('cell')
        .map((cell) => cell.textContent)
    )
    expect(cells).toEqual([
      ['50%', '0° · 0 rad'],
      ['50%', '0° · 0 rad'],
    ])
  })

  it('names its states in ket notation, highest qubit first', () => {
    draw(stateOf(BELL))

    const headers = rows().map(
      (row) => within(row).getByRole('rowheader').textContent
    )
    expect(headers).toEqual(['|00⟩', '|11⟩'])
  })

  it('hides the drawing from the accessibility tree', () => {
    const { container } = draw(stateOf(BELL))

    // The same split the circuit canvas makes: pixels for people who look,
    // a table for people who listen, one model behind both.
    expect(container.querySelector('svg')?.getAttribute('aria-hidden')).toBe(
      'true'
    )
    expect(screen.getByRole('table')).toBeDefined()
  })

  it('says that everything is drawn', () => {
    const { container } = draw(stateOf(BELL))

    expect(container.querySelector('.histogram__disclosure')?.textContent).toBe(
      CATALOGS.en.histogram.caption.complete_other
        .replace('{{occupied}}', '2')
        .replace('{{total}}', '4')
    )
  })
})

describe('phase', () => {
  it('points each phasor along the phase of its amplitude', () => {
    // H then S: |0⟩ at phase 0, |1⟩ at π/2. SVG turns clockwise and the
    // phase circle does not, so a quarter turn anticlockwise is rotate(270).
    const { container } = draw(
      stateOf({
        schemaVersion: 1,
        qubits: 1,
        operations: [
          { id: 'a', gate: 'h', targets: [0], column: 0 },
          { id: 'b', gate: 's', targets: [0], column: 1 },
        ],
      })
    )

    const [zero, quarter] = needles(container)
    expect(zero?.getAttribute('style')).toContain('rotate(0deg)')
    expect(quarter?.getAttribute('style')).toContain('rotate(270deg)')
  })

  it('paints the hue from the same angle as the arrow', () => {
    const { container } = draw(
      stateOf({
        schemaVersion: 1,
        qubits: 1,
        operations: [
          { id: 'a', gate: 'h', targets: [0], column: 0 },
          { id: 'b', gate: 's', targets: [0], column: 1 },
        ],
      })
    )

    // §10's identity: the hue in degrees *is* the phase in degrees, so one
    // number drives the arrow and the colour. Negated because the rotation
    // already flipped the sense of the turn for SVG — rotate(270) is a phase
    // of 90°, and hue −270 is hue 90.
    const [zero, quarter] = phaseRows(container)
    expect(zero?.getAttribute('style')).toContain('--row-hue: 0')
    expect(quarter?.getAttribute('style')).toContain('--row-hue: -270')
  })

  it('remembers the angle it last drew, so the arrow never unwinds', () => {
    // A phase creeping past zero moves the arrow twenty degrees. Rendering
    // the wrapped value would send it 340 the other way, which is the one
    // thing this animation must not do while a slider is being dragged.
    const withPhase = (phase: number) =>
      stateOf({
        schemaVersion: 1,
        qubits: 1,
        operations: [
          { id: 'a', gate: 'h', targets: [0], column: 0 },
          { id: 'b', gate: 'p', targets: [0], column: 1, params: [phase] },
        ],
      })

    const { container, rerender } = draw(withPhase(-Math.PI / 18))
    const first = phaseRows(container)[1]
    expect(first?.dataset.rotation).toBe('10')

    rerender(
      <I18nextProvider i18n={i18nFor('en')}>
        <ProbabilityHistogram state={withPhase(Math.PI / 18)} />
      </I18nextProvider>
    )

    // −10° then +10°: the arrow reads 350 the long way and −10 the short way.
    expect(phaseRows(container)[1]?.dataset.rotation).toBe('-10')
    expect(needles(container)[1]?.getAttribute('style')).toContain(
      'rotate(-10deg)'
    )
  })

  it('turns two opposite phasors where two paths cancel', () => {
    // H then Z: the two halves now differ by π, which is the configuration
    // a second H turns into complete cancellation.
    const { container } = draw(
      stateOf({
        schemaVersion: 1,
        qubits: 1,
        operations: [
          { id: 'a', gate: 'h', targets: [0], column: 0 },
          { id: 'b', gate: 'z', targets: [0], column: 1 },
        ],
      })
    )

    const [first, second] = needles(container)
    expect(first?.getAttribute('style')).toContain('rotate(0deg)')
    expect(second?.getAttribute('style')).toContain('rotate(180deg)')
  })

  it('reports the phase in degrees and radians in the table', () => {
    draw(
      stateOf({
        schemaVersion: 1,
        qubits: 1,
        operations: [
          { id: 'a', gate: 'h', targets: [0], column: 0 },
          { id: 'b', gate: 't', targets: [0], column: 1 },
        ],
      })
    )

    const phases = rows().map(
      (row) => within(row).getAllByRole('cell')[1]?.textContent
    )
    expect(phases).toEqual(['0° · 0 rad', '45° · 0.7854 rad'])
  })
})

describe('reduced motion', () => {
  it('prints the angle beside every frozen phasor', () => {
    stubMotionPreference(true)
    const { container } = draw(
      stateOf({
        schemaVersion: 1,
        qubits: 1,
        operations: [
          { id: 'a', gate: 'h', targets: [0], column: 0 },
          { id: 'b', gate: 's', targets: [0], column: 1 },
        ],
      })
    )

    const angles = [...container.querySelectorAll('.histogram__angle')].map(
      (node) => node.textContent
    )
    expect(angles).toEqual(['0°', '90°'])
  })

  it('leaves the arrows pointing where they pointed', () => {
    // §10: the phasors freeze, they do not disappear. The direction is the
    // information; the rotation was only the animation of a change.
    stubMotionPreference(true)
    const { container } = draw(
      stateOf({
        schemaVersion: 1,
        qubits: 1,
        operations: [
          { id: 'a', gate: 'h', targets: [0], column: 0 },
          { id: 'b', gate: 's', targets: [0], column: 1 },
        ],
      })
    )

    expect(needles(container)).toHaveLength(2)
    expect(needles(container)[1]?.getAttribute('style')).toContain(
      'rotate(270deg)'
    )
  })

  it('prints no angles when nobody asked for less motion', () => {
    stubMotionPreference(false)
    const { container } = draw(stateOf(BELL))

    expect(container.querySelectorAll('.histogram__angle')).toHaveLength(0)
    expect(needles(container)).toHaveLength(2)
  })
})

describe('the bar cap', () => {
  it('draws the remainder rather than dropping it', () => {
    const { container } = draw(stateOf(uniform(5)), { barLimit: 4 })

    // Four basis states plus one bar for everything else. The remainder has
    // no phasor, because the states behind it do not share a phase.
    expect(fills(container)).toHaveLength(5)
    expect(needles(container)).toHaveLength(4)
    expect(
      container.querySelectorAll('.histogram__fill--remainder')
    ).toHaveLength(1)

    // And it is drawn to scale like every other bar: 28 states of 32.
    const track = trackWidth(container)
    const remainder = container.querySelector('.histogram__fill--remainder')
    expect(Number(remainder?.getAttribute('width'))).toBeCloseTo(
      (track * 28) / 32,
      6
    )
  })

  it('announces the cap instead of applying it silently', () => {
    const { container } = draw(stateOf(uniform(5)), { barLimit: 4 })

    expect(container.querySelector('.histogram__disclosure')?.textContent).toBe(
      CATALOGS.en.histogram.caption.capped_other
        .replace('{{occupied}}', '32')
        .replace('{{total}}', '32')
        .replace('{{shown}}', '4')
        .replace('{{hidden}}', '28')
        .replace('{{share}}', '87.5%')
    )
  })

  it('gives the hidden states a row of their own in the table', () => {
    draw(stateOf(uniform(5)), { barLimit: 4 })

    const last = rows().at(-1)
    expect(last).toBeDefined()
    expect(within(last!).getByRole('rowheader').textContent).toBe(
      CATALOGS.en.histogram.table.remainder_other.replace('{{hidden}}', '28')
    )
    const cells = within(last!)
      .getAllByRole('cell')
      .map((cell) => cell.textContent)
    expect(cells).toEqual(['87.5%', CATALOGS.en.histogram.table.mixedPhase])
  })

  it('says nothing about a remainder when there is none', () => {
    const { container } = draw(stateOf(uniform(3)))

    expect(
      container.querySelectorAll('.histogram__fill--remainder')
    ).toHaveLength(0)
    expect(rows()).toHaveLength(8)
  })
})

describe('every number is locale-formatted', () => {
  it('writes French decimals with a comma', () => {
    // D2/§1.1: a hardcoded decimal point is a real defect for a third of
    // this app's users, and it hides in exactly this kind of readout.
    draw(stateOf(uniform(3)), { language: 'fr' })

    const first = rows()[0]
    expect(first).toBeDefined()
    const cells = within(first!)
      .getAllByRole('cell')
      .map((cell) => cell.textContent ?? '')
    expect(cells[0]).toMatch(/^12,5\s*%$/u)
  })

  it('writes Spanish angles with a comma too', () => {
    draw(
      stateOf({
        schemaVersion: 1,
        qubits: 1,
        operations: [
          { id: 'a', gate: 'h', targets: [0], column: 0 },
          { id: 'b', gate: 't', targets: [0], column: 1 },
        ],
      }),
      { language: 'es' }
    )

    const second = rows()[1]
    expect(second).toBeDefined()
    expect(within(second!).getAllByRole('cell')[1]?.textContent).toBe(
      '45° · 0,7854 rad'
    )
  })

  it('groups a large basis-state count', () => {
    const { container } = draw(stateOf(uniform(12)), { barLimit: 2 })
    const disclosure =
      container.querySelector('.histogram__disclosure')?.textContent ?? ''

    // 2¹² = 4096, and the caption is where a reader learns how much of the
    // distribution is not on screen.
    expect(disclosure).toContain('4,096')
    expect(disclosure).toContain('4,094')
  })
})

describe('the caption agrees with itself about number', () => {
  /*
   * Every count used to reach the catalogs already formatted, under a name
   * i18next has no plural rule for, so the singular form was never selected
   * and the first sentence a reader met on the empty editor — and on the
   * landing page's first stage — was ungrammatical in all three languages.
   */
  const GROUND: CircuitInput = { schemaVersion: 1, qubits: 3, operations: [] }

  it.each(['en', 'es', 'fr'] as const)(
    'says "one basis state" in the singular in %s',
    (language) => {
      const { container } = draw(stateOf(GROUND), { language })
      const disclosure =
        container.querySelector('.histogram__disclosure')?.textContent ?? ''

      expect(disclosure).toBe(
        CATALOGS[language].histogram.caption.complete_one
          .replace('{{occupied}}', '1')
          .replace('{{total}}', '8')
      )
      // And the plural form is genuinely a different sentence, so the
      // assertion above is not satisfied by the two being identical.
      expect(CATALOGS[language].histogram.caption.complete_one).not.toBe(
        CATALOGS[language].histogram.caption.complete_other
      )
    }
  )

  it.each(['en', 'es', 'fr'] as const)(
    'says "the other basis state" in the singular in %s',
    (language) => {
      // Exactly one state left out: 2 occupied, a cap of 1.
      draw(stateOf(BELL), { language, barLimit: 1 })

      const last = rows().at(-1)
      expect(last).toBeDefined()
      expect(within(last!).getByRole('rowheader').textContent).toBe(
        CATALOGS[language].histogram.table.remainder_one
      )
    }
  )
})

describe('a chart of a fixed basis', () => {
  it('keeps a row for a state that carries nothing', () => {
    // The landing page's argument is two bars disappearing, not the chart
    // changing shape: every row holds its position and its length goes to
    // zero. `histogram.ts` makes the case at length.
    const { container } = draw(stateOf(BELL), { fullBasis: true })
    const labels = [...container.querySelectorAll('.histogram__label')].map(
      (node) => node.textContent
    )

    expect(labels).toEqual(['|00⟩', '|01⟩', '|10⟩', '|11⟩'])
    // And it is still honest about how many of them carry anything.
    expect(container.querySelector('.histogram__disclosure')?.textContent).toBe(
      CATALOGS.en.histogram.caption.complete_other
        .replace('{{occupied}}', '2')
        .replace('{{total}}', '4')
    )
  })

  it('drops the phasors and their note when asked to', () => {
    const { container } = draw(stateOf(BELL), { phasors: false })

    expect(container.querySelector('.phasor')).toBeNull()
    expect(container.querySelector('.histogram__note')).toBeNull()
    // The described table follows the drawing: no arrows, no phase column.
    const headers = within(screen.getByRole('table'))
      .getAllByRole('columnheader')
      .map((cell) => cell.textContent)
    expect(headers).toEqual([
      CATALOGS.en.histogram.table.state,
      CATALOGS.en.histogram.table.probability,
    ])
  })

  it('lets a caller supply its own heading and sentence', () => {
    // The landing page has not earned the words "basis state" by the time this
    // chart appears, and it already names the same thing "outcome" an inch
    // below. One name per concept per screen.
    const { container } = render(
      <I18nextProvider i18n={i18nFor('en')}>
        <ProbabilityHistogram
          state={stateOf(BELL)}
          heading="Outcomes, and how often"
          summary="All 4 possible readings of the pair."
        />
      </I18nextProvider>
    )

    expect(container.querySelector('.histogram__title')?.textContent).toBe(
      'Outcomes, and how often'
    )
    expect(container.querySelector('.histogram__disclosure')?.textContent).toBe(
      'All 4 possible readings of the pair.'
    )
  })
})
