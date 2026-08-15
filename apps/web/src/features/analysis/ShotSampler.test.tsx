import { createRng, run, sampleShots, type Statevector } from '@qsim/core'
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
import { afterEach, describe, expect, it, vi } from 'vitest'

import enAnalysis from '../../i18n/locales/en/analysis.json'
import esAnalysis from '../../i18n/locales/es/analysis.json'
import frAnalysis from '../../i18n/locales/fr/analysis.json'
import type { SamplePayload } from '../simulation/protocol'
import { ShotSampler, type SamplingSettings } from './ShotSampler'
import { SHOT_STOPS } from './sampling'

/**
 * The shots control — §3.2's comparison of an empirical sample against the
 * exact distribution.
 *
 * The counts here are drawn by the engine's own `sampleShots`, seeded, never
 * by the test: this component is being checked for what it *reads*, and a
 * hand-written tally would let a join that lost the labels pass.
 *
 * What is asserted is the teaching claim and the accessibility of the control
 * that demonstrates it: nothing is sampled until asked, the slider says what
 * it is worth in words rather than in stop indices, the comparison is
 * readable as a table and not only as a drawing, and every number in it is
 * written in the reader's language.
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

/** H then CNOT: (|00⟩ + |11⟩)/√2, so the exact answer is 50 % twice. */
const BELL: CircuitInput = {
  schemaVersion: 1,
  qubits: 2,
  operations: [
    { id: 'a', gate: 'h', targets: [0], column: 0 },
    { id: 'b', gate: 'cx', targets: [1], controls: [0], column: 1 },
  ],
}

const OFF: SamplingSettings = { enabled: false, shots: 1000, seed: 1 }
const ON: SamplingSettings = { enabled: true, shots: 1000, seed: 1 }

/** What the worker would answer, computed by the engine exactly as it does. */
function payload(
  state: Statevector,
  shots: number,
  seed: number
): SamplePayload {
  return { shots, seed, counts: sampleShots(state, shots, createRng(seed)) }
}

function draw(
  options: {
    language?: Language
    settings?: SamplingSettings
    sampling?: SamplePayload | null
    state?: Statevector
    onChange?: (settings: SamplingSettings) => void
  } = {}
) {
  const {
    language = 'en',
    settings = OFF,
    sampling = null,
    state = stateOf(BELL),
    onChange = () => undefined,
  } = options

  return render(
    <I18nextProvider i18n={i18nFor(language)}>
      <ShotSampler
        state={state}
        settings={settings}
        onChange={onChange}
        sampling={sampling}
      />
    </I18nextProvider>
  )
}

/** Data rows of the comparison, header excluded. */
function rows(): HTMLElement[] {
  return within(screen.getByRole('table')).getAllByRole('row').slice(1)
}

function cells(row: HTMLElement): string[] {
  return within(row)
    .getAllByRole('cell')
    .map((cell) => cell.textContent ?? '')
}

afterEach(cleanup)

describe('nothing is sampled until it is asked for', () => {
  it('offers the comparison and draws none of it', () => {
    draw()

    expect(screen.getByRole('checkbox')).toBeDefined()
    // §5.3: an analytic run knows every probability exactly, so shot noise is
    // something a reader requests, never something a simulator supplies.
    expect(screen.queryByRole('slider')).toBeNull()
    expect(screen.queryByRole('table')).toBeNull()
  })

  it('reports the request rather than acting on it', () => {
    // The settings belong to the panel, because the sampling happens on the
    // worker: this component can only say what was asked for.
    const onChange = vi.fn()
    draw({ onChange })

    fireEvent.click(screen.getByRole('checkbox'))

    expect(onChange).toHaveBeenCalledWith({ ...OFF, enabled: true })
  })

  it('waits for the first answer instead of drawing an empty comparison', () => {
    draw({ settings: ON })

    expect(screen.getByText(CATALOGS.en.sampling.waiting)).toBeDefined()
    expect(screen.queryByRole('table')).toBeNull()
  })
})

describe('the shots slider', () => {
  it('says what its position is worth, not what its index is', () => {
    // Without `aria-valuetext` a screen reader announces "9 of 15" — a number
    // the reader has never been shown and which means nothing.
    draw({ settings: ON })

    const slider = screen.getByRole('slider')
    expect(slider.getAttribute('aria-valuetext')).toBe('1,000')
    expect(slider.getAttribute('max')).toBe(String(SHOT_STOPS.length - 1))
  })

  it('maps a stop to the shot count it stands for', () => {
    const onChange = vi.fn()
    draw({ settings: ON, onChange })

    fireEvent.change(screen.getByRole('slider'), {
      target: { value: String(SHOT_STOPS.length - 1) },
    })

    // The last stop is the ceiling §3.2 sets, and the control is the only
    // thing that has to be able to reach it.
    expect(onChange).toHaveBeenCalledWith({ ...ON, shots: 100_000 })
  })

  it('writes the reading in the reader’s language', () => {
    const { container } = draw({ settings: ON, language: 'fr' })

    expect(
      container.querySelector('.shot-sampler__reading')?.textContent
    ).toMatch(/^1\s000$/u)
  })

  it('draws another sample of the same state on request', () => {
    // Same circuit, same shot count, new seed. That is what makes "sampling"
    // mean something rather than looking like a second exact answer.
    const onChange = vi.fn()
    draw({ settings: ON, onChange })

    fireEvent.click(
      screen.getByRole('button', { name: CATALOGS.en.sampling.resample })
    )

    expect(onChange).toHaveBeenCalledWith({ ...ON, seed: 2 })
  })
})

describe('the comparison', () => {
  it('puts the exact probability and the sampled one on the same row', () => {
    const state = stateOf(BELL)
    const sampling = payload(state, 1000, 4)
    draw({ settings: ON, sampling, state })

    const counts = [sampling.counts['00'] ?? 0, sampling.counts['11'] ?? 0]
    expect(counts[0]! + counts[1]!).toBe(1000)

    const first = rows()[0]!
    expect(within(first).getByRole('rowheader').textContent).toBe('|00⟩')
    const [exact, count, observed] = cells(first)
    expect(exact).toBe('50%')
    expect(count).toBe(String(counts[0]))
    expect(observed).toBe(
      new Intl.NumberFormat('en', {
        style: 'percent',
        maximumFractionDigits: 2,
      }).format(counts[0]! / 1000)
    )
  })

  it('signs the difference, so the direction of the miss is on screen', () => {
    const state = stateOf(BELL)
    draw({ settings: ON, sampling: payload(state, 1000, 4), state })

    const deltas = rows().map((row) => cells(row)[3] ?? '')
    // Two outcomes summing to one: whatever one row overshoots by, the other
    // undershoots by, so the two signs must differ.
    expect(deltas.some((delta) => delta.startsWith('+'))).toBe(true)
    expect(deltas.some((delta) => delta.startsWith('-'))).toBe(true)
  })

  it('draws the sample as a bar against the exact value as a mark', () => {
    const state = stateOf(BELL)
    const { container } = draw({
      settings: ON,
      sampling: payload(state, 100, 4),
      state,
    })

    // Shape, not colour: a bar overshooting a tick is legible with no colour
    // vision at all, and the numbers above are the same reading as text.
    expect(container.querySelectorAll('.shot-sampler__bar')).toHaveLength(2)
    expect(container.querySelectorAll('.shot-sampler__exact')).toHaveLength(2)
    expect(container.querySelector('svg')?.getAttribute('aria-hidden')).toBe(
      'true'
    )
  })

  it('places the exact mark at the probability and the bar at the sample', () => {
    const state = stateOf(BELL)
    const sampling = payload(state, 100, 4)
    const { container } = draw({ settings: ON, sampling, state })

    const track = container.querySelector('.shot-sampler__track')
    const trackX = Number(track?.getAttribute('x'))
    const trackWidth = Number(track?.getAttribute('width'))
    const bar = container.querySelector('.shot-sampler__bar')
    const mark = container.querySelector('.shot-sampler__exact')

    expect(Number(mark?.getAttribute('x1'))).toBeCloseTo(
      trackX + trackWidth / 2,
      6
    )
    expect(Number(bar?.getAttribute('width'))).toBeCloseTo(
      (trackWidth * (sampling.counts['00'] ?? 0)) / 100,
      6
    )
  })

  it('names the shot count and the error to expect at it', () => {
    const state = stateOf(BELL)
    const { container } = draw({
      settings: { ...ON, shots: 100 },
      sampling: payload(state, 100, 4),
      state,
    })

    // 1/(2√100) is 5 %, and printing it is what turns a table of near-misses
    // into a demonstration the reader can check on the next drag.
    const summary =
      container.querySelector('.shot-sampler__summary')?.textContent ?? ''
    expect(summary).toContain('100')
    expect(summary).toContain('5%')
  })

  it.each(['es', 'fr'] as const)('writes every figure in %s', (language) => {
    const state = stateOf(BELL)
    draw({ settings: ON, sampling: payload(state, 1000, 4), state, language })

    const [exact, , observed] = cells(rows()[0]!)
    expect(exact).toMatch(/^50\s%$/u)
    // The observed share is a decimal in every real sample: 49,7 % in French,
    // never 49.7 %.
    expect(observed).toMatch(/^\d+(,\d+)?\s%$/u)
  })
})

describe('the summary agrees with itself about number', () => {
  it.each(['en', 'es', 'fr'] as const)(
    'says "1 shot" in the singular in %s',
    (language) => {
      // `SHOT_STOPS[0]` is 1, a deliberate stop of §3.2's sixteen-step scale
      // and not an edge case. The count reached the catalog pre-formatted,
      // under a name i18next has no plural rule for, so every language read
      // "1 shots".
      const state = stateOf(BELL)
      const { container } = draw({
        settings: { ...ON, shots: SHOT_STOPS[0]! },
        sampling: payload(state, SHOT_STOPS[0]!, 4),
        state,
        language,
      })

      const summary =
        container.querySelector('.shot-sampler__summary')?.textContent ?? ''
      expect(summary.startsWith('1 shot.')).toBe(true)
      expect(CATALOGS[language].sampling.summary_one).not.toBe(
        CATALOGS[language].sampling.summary_other
      )
    }
  )
})
