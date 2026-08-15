/**
 * Independent verification — does the analysis panel tell the truth?
 *
 * A chart that renders beautifully and reports the wrong number is worse than
 * no chart, so every expectation below is derived twice: once from the slow
 * dense-matrix simulator in `reference.ts`, which shares no code with
 * `@qsim/core`, and once from the DOM the components actually produce. The
 * engine's own suite is not consulted — it shares the engine's blind spots.
 *
 * What is checked, for Bell, GHZ, a deliberate relative phase, an
 * interference circuit whose two paths cancel, and a state that lands on all
 * four of §10's cardinal phases at once:
 *
 *   - the amplitude a row prints is the amplitude the mathematics gives it
 *   - magnitude, probability and both angle units agree with each other
 *   - the ket label on a row matches the statevector index it came from,
 *     little-endian (D1) and not reversed somewhere in the rendering
 *   - the phasor's direction and hue are `phase · 180/π`, §10's mapping
 *   - the bar length is exactly proportional to the probability
 *   - all of the above in French, where the decimal separator is a comma
 */

import { run, type Statevector } from '@qsim/core'
import { parseCircuit, type CircuitInput } from '@qsim/schema'
import { cleanup, render, screen, within } from '@testing-library/react'
import { createInstance, type i18n as I18n } from 'i18next'
import { I18nextProvider, initReactI18next } from 'react-i18next'
import { afterEach, describe, expect, it } from 'vitest'

import { AmplitudeTable } from '../../features/analysis/AmplitudeTable'
import { ProbabilityHistogram } from '../../features/analysis/ProbabilityHistogram'
import enAnalysis from '../../i18n/locales/en/analysis.json'
import esAnalysis from '../../i18n/locales/es/analysis.json'
import frAnalysis from '../../i18n/locales/fr/analysis.json'
import {
  GATE_H,
  GATE_S,
  GATE_T,
  GATE_X,
  GATE_Z,
  gateRz,
  ketLabel,
  phaseOf,
  probabilityOf,
  referenceState,
  type Cx,
  type RefStep,
} from './reference'

afterEach(cleanup)

/* ── the circuits, each written twice ───────────────────────────────────── */

interface Case {
  readonly name: string
  readonly qubits: number
  readonly circuit: CircuitInput
  readonly steps: readonly RefStep[]
}

function op(
  id: string,
  gate: string,
  targets: number[],
  column: number,
  controls?: number[]
) {
  return controls === undefined
    ? { id, gate, targets, column }
    : { id, gate, targets, column, controls }
}

const CASES: readonly Case[] = [
  {
    name: 'Bell pair',
    qubits: 2,
    circuit: {
      schemaVersion: 1,
      qubits: 2,
      operations: [op('a', 'h', [0], 0), op('b', 'cx', [1], 1, [0])],
    },
    steps: [
      { gate: GATE_H, target: 0 },
      { gate: GATE_X, target: 1, controls: [0] },
    ],
  },
  {
    name: 'GHZ over three qubits',
    qubits: 3,
    circuit: {
      schemaVersion: 1,
      qubits: 3,
      operations: [
        op('a', 'h', [0], 0),
        op('b', 'cx', [1], 1, [0]),
        op('c', 'cx', [2], 2, [1]),
      ],
    },
    steps: [
      { gate: GATE_H, target: 0 },
      { gate: GATE_X, target: 1, controls: [0] },
      { gate: GATE_X, target: 2, controls: [1] },
    ],
  },
  {
    name: 'a deliberate relative phase of π/4',
    qubits: 1,
    circuit: {
      schemaVersion: 1,
      qubits: 1,
      operations: [op('a', 'h', [0], 0), op('b', 't', [0], 1)],
    },
    steps: [
      { gate: GATE_H, target: 0 },
      { gate: GATE_T, target: 0 },
    ],
  },
  {
    name: 'two paths cancelling',
    qubits: 1,
    circuit: {
      schemaVersion: 1,
      qubits: 1,
      operations: [
        op('a', 'h', [0], 0),
        op('b', 'z', [0], 1),
        op('c', 'h', [0], 2),
      ],
    },
    steps: [
      { gate: GATE_H, target: 0 },
      { gate: GATE_Z, target: 0 },
      { gate: GATE_H, target: 0 },
    ],
  },
  {
    // The four cardinal phases of §10 in one state: 0, π/2, π, 3π/2 on
    // |00⟩, |01⟩, |10⟩ and |11⟩ respectively.
    name: 'all four cardinal phases at once',
    qubits: 2,
    circuit: {
      schemaVersion: 1,
      qubits: 2,
      operations: [
        op('a', 'h', [0], 0),
        op('b', 'h', [1], 0),
        op('c', 's', [0], 1),
        op('d', 'z', [1], 2),
      ],
    },
    steps: [
      { gate: GATE_H, target: 0 },
      { gate: GATE_H, target: 1 },
      { gate: GATE_S, target: 0 },
      { gate: GATE_Z, target: 1 },
    ],
  },
  {
    // Endianness, unmistakably: only qubit 2 is flipped, so the one occupied
    // index is 4 and the one label is |100⟩. A reversed rendering says |001⟩.
    name: 'X on the highest qubit only',
    qubits: 3,
    circuit: {
      schemaVersion: 1,
      qubits: 3,
      operations: [op('a', 'x', [2], 0)],
    },
    steps: [{ gate: GATE_X, target: 2 }],
  },
  {
    // Same shape, other end of the register: only qubit 0 is flipped.
    name: 'X on the lowest qubit only',
    qubits: 3,
    circuit: {
      schemaVersion: 1,
      qubits: 3,
      operations: [op('a', 'x', [0], 0)],
    },
    steps: [{ gate: GATE_X, target: 0 }],
  },
  {
    // Rz carries a global phase (Qiskit's convention), so both amplitudes
    // wear an angle: −π/8 and +π/8, i.e. 337,5° and 22,5°.
    name: 'Rz(π/4) after H, global phase and all',
    qubits: 1,
    circuit: {
      schemaVersion: 1,
      qubits: 1,
      operations: [
        op('a', 'h', [0], 0),
        { id: 'b', gate: 'rz', targets: [0], column: 1, params: [Math.PI / 4] },
      ],
    },
    steps: [
      { gate: GATE_H, target: 0 },
      { gate: gateRz(Math.PI / 4), target: 0 },
    ],
  },
]

/* ── plumbing ───────────────────────────────────────────────────────────── */

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

function engineState(circuit: CircuitInput): Statevector {
  const result = run(parseCircuit(circuit))
  if (result.mode !== 'analytic') throw new Error('expected an analytic run')
  return result.state
}

/**
 * The inverse of `Intl.NumberFormat`, built from the locale's own parts so the
 * test never assumes which character is the decimal separator. Every kind of
 * space is stripped, which covers French's narrow no-break group separator and
 * the no-break space before a percent sign.
 */
function parseNumber(text: string, locale: string): number {
  const parts = new Intl.NumberFormat(locale).formatToParts(-12345.6)
  const decimal = parts.find((part) => part.type === 'decimal')?.value ?? '.'
  const minus = parts.find((part) => part.type === 'minusSign')?.value ?? '-'
  const cleaned = text
    // `\s` already covers U+00A0 and U+202F, the spaces French uses as a
    // group separator and before a percent sign.
    .replace(/[\s%°]/g, '')
    .replace(/rad$/, '')
    .split(minus)
    .join('-')
    .split(decimal)
    .join('.')
    // Whatever is left that is not part of a number is a group separator.
    .replace(/[^\d.\-+eE]/g, '')
  return Number(cleaned)
}

/** `a + bi` / `a − bi` back into a pair of numbers. */
function parseAmplitude(text: string, locale: string): Cx {
  const minus =
    new Intl.NumberFormat(locale)
      .formatToParts(-1)
      .find((part) => part.type === 'minusSign')?.value ?? '-'
  const separator = text.includes(` ${minus} `) ? ` ${minus} ` : ' + '
  const [left, right] = text.split(separator)
  const re = parseNumber(left ?? '', locale)
  const im = parseNumber((right ?? '').replace(/i$/, ''), locale)
  return { re, im: separator === ' + ' ? im : -im }
}

/** Rows of the amplitude table, as the reader sees them. */
interface RenderedRow {
  readonly ket: string
  readonly amplitude: Cx
  readonly magnitude: number
  readonly probability: number
  readonly radians: number
  readonly degrees: number
}

function readTable(language: Language): RenderedRow[] {
  const table = screen.getByRole('table')
  const body = table.querySelectorAll('tbody tr')
  return [...body].map((row) => {
    const header = row.querySelector('th')!
    const cells = [...row.querySelectorAll('td')].map(
      (cell) => cell.textContent ?? ''
    )
    return {
      ket: header.textContent ?? '',
      amplitude: parseAmplitude(cells[0] ?? '', language),
      magnitude: parseNumber(cells[1] ?? '', language),
      // A percentage: the formatter divides by 100 on the way out.
      probability: parseNumber(cells[2] ?? '', language) / 100,
      radians: parseNumber(cells[3] ?? '', language),
      degrees: parseNumber(cells[4] ?? '', language),
    }
  })
}

/** Amplitudes above the floor the panel itself uses, in index order. */
function occupied(vector: readonly Cx[]): { index: number; amplitude: Cx }[] {
  return vector
    .map((amplitude, index) => ({ index, amplitude }))
    .filter(({ amplitude }) => probabilityOf(amplitude) > 1e-12)
}

/* ── the engine, against arithmetic that is not the engine's ────────────── */

describe('the state the panel is handed', () => {
  it.each(CASES)('$name matches a dense-matrix simulation', (testCase) => {
    const state = engineState(testCase.circuit)
    const expected = referenceState(testCase.qubits, testCase.steps)

    expect(state.size).toBe(1 << testCase.qubits)
    for (let index = 0; index < state.size; index++) {
      expect(state.re[index]).toBeCloseTo(expected[index]!.re, 10)
      expect(state.im[index]).toBeCloseTo(expected[index]!.im, 10)
    }
  })
})

/* ── the amplitude table ────────────────────────────────────────────────── */

describe.each<Language>(['en', 'es', 'fr'])(
  'the amplitude table in %s',
  (language) => {
    it.each(CASES)('prints the true amplitudes of $name', (testCase) => {
      const state = engineState(testCase.circuit)
      const expected = occupied(referenceState(testCase.qubits, testCase.steps))

      render(
        <I18nextProvider i18n={i18nFor(language)}>
          <AmplitudeTable state={state} />
        </I18nextProvider>
      )

      const rows = readTable(language)
      expect(rows).toHaveLength(expected.length)

      rows.forEach((row, position) => {
        const { index, amplitude } = expected[position]!

        // D1: the label is the index, highest qubit first.
        expect(row.ket).toBe(`|${ketLabel(index, testCase.qubits)}⟩`)

        // Four printed decimals, so half of the last place is 5e-5.
        expect(row.amplitude.re).toBeCloseTo(amplitude.re, 4)
        expect(row.amplitude.im).toBeCloseTo(amplitude.im, 4)
        expect(row.magnitude).toBeCloseTo(
          Math.hypot(amplitude.re, amplitude.im),
          4
        )
        expect(row.probability).toBeCloseTo(probabilityOf(amplitude), 4)
        expect(row.radians).toBeCloseTo(phaseOf(amplitude), 3)
        expect(row.degrees).toBeCloseTo((phaseOf(amplitude) * 180) / Math.PI, 2)

        // The columns must also agree with each other, not merely with the
        // reference: a reader compares them side by side.
        expect(row.magnitude ** 2).toBeCloseTo(row.probability, 3)
        expect(row.degrees).toBeCloseTo((row.radians * 180) / Math.PI, 1)
      })
    })
  }
)

/* ── the histogram ──────────────────────────────────────────────────────── */

describe.each<Language>(['en', 'fr'])('the histogram in %s', (language) => {
  it.each(CASES)('draws $name truthfully', (testCase) => {
    const state = engineState(testCase.circuit)
    const expected = occupied(referenceState(testCase.qubits, testCase.steps))

    const { container } = render(
      <I18nextProvider i18n={i18nFor(language)}>
        <ProbabilityHistogram state={state} />
      </I18nextProvider>
    )

    const rows = [...container.querySelectorAll('g.histogram__row')]
    expect(rows).toHaveLength(expected.length)

    rows.forEach((row, position) => {
      const { index, amplitude } = expected[position]!
      const phase = phaseOf(amplitude)
      const degrees = (phase * 180) / Math.PI

      // The ket on the bar, little-endian (D1).
      expect(row.querySelector('.histogram__label')?.textContent).toBe(
        `|${ketLabel(index, testCase.qubits)}⟩`
      )

      // The printed percentage beside the bar.
      const printed = parseNumber(
        row.querySelector('.histogram__value')?.textContent ?? '',
        language
      )
      expect(printed / 100).toBeCloseTo(probabilityOf(amplitude), 4)

      // The bar itself: exactly proportional to the probability.
      const fill = row.querySelector('.histogram__fill')!
      const track = row.querySelector('.histogram__track')!
      const ratio =
        Number(fill.getAttribute('width')) / Number(track.getAttribute('width'))
      expect(ratio).toBeCloseTo(probabilityOf(amplitude), 6)

      // §10: the phasor points at the phase, and the hue is that same angle.
      // The rendered rotation is SVG's clockwise turn, so it is 360 − phase.
      const rotation = Number((row as HTMLElement).dataset.rotation)
      const pointing = (((360 - rotation) % 360) + 360) % 360
      expect(Math.abs(pointing - degrees) % 360).toBeLessThan(0.01)
    })

    // The accessible rendering of the same chart must not disagree with it.
    const table = within(container).getByRole('table')
    const described = [...table.querySelectorAll('tbody tr')].map(
      (row) => row.querySelector('th')?.textContent ?? ''
    )
    expect(described).toEqual(
      expected.map(({ index }) => `|${ketLabel(index, testCase.qubits)}⟩`)
    )
  })
})
