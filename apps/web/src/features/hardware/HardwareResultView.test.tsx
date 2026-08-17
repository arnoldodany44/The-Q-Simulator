/**
 * §3.7's comparison, as a reader meets it.
 *
 * The properties this milestone turns on, each asserted on the rendered page
 * rather than on the model behind it:
 *
 *  1. **It is one chart.** Three histograms would show three sets of lengths
 *     and leave the reader subtracting across two gaps. The three readings are
 *     three columns of one table and three marks on one track.
 *  2. **The difference is legible.** Both signed differences are on screen as
 *     numbers, not implied by two bar lengths.
 *  3. **The transpiled circuit is shown.** Both gate counts, both gate lists,
 *     and the submitted source — because "you drew two and the device ran ten"
 *     is the explanation, not a footnote.
 *  4. **The device is named, with its queue, its hour and its calibration.**
 *  5. **It renders from storage.** Everything above comes out of one job row
 *     and one statevector this tab computed; nothing here can reach a provider.
 *  6. **All of it in three languages**, including the states where there is no
 *     comparison to draw — which is the surface nobody remembers to translate.
 */

import { run, type Statevector } from '@qsim/core'
import type { HardwareJob } from '@qsim/contract'
import { parseCircuit, type Circuit, type CircuitInput } from '@qsim/schema'
import { cleanup, render, screen, within } from '@testing-library/react'
import { createInstance, type i18n as I18n } from 'i18next'
import { I18nextProvider, initReactI18next } from 'react-i18next'
import { afterEach, describe, expect, it } from 'vitest'

import enAnalysis from '../../i18n/locales/en/analysis.json'
import esAnalysis from '../../i18n/locales/es/analysis.json'
import frAnalysis from '../../i18n/locales/fr/analysis.json'
import enHardware from '../../i18n/locales/en/hardware.json'
import esHardware from '../../i18n/locales/es/hardware.json'
import frHardware from '../../i18n/locales/fr/hardware.json'
import { buildNoiseComparison } from '../analysis/noiseComparison'
import type { NoiseReading } from '../simulation/protocol'
import { HardwareResultView } from './HardwareResultView'
import { idealCircuitOf } from './ideal'

type Language = 'en' | 'es' | 'fr'

const HARDWARE: Record<Language, typeof enHardware> = {
  en: enHardware,
  es: esHardware,
  fr: frHardware,
}
function i18nFor(language: Language): I18n {
  const instance = createInstance()
  void instance.use(initReactI18next).init({
    lng: language,
    fallbackLng: 'en',
    ns: ['hardware', 'analysis'],
    defaultNS: 'hardware',
    resources: {
      en: { hardware: enHardware, analysis: enAnalysis },
      es: { hardware: esHardware, analysis: esAnalysis },
      fr: { hardware: frHardware, analysis: frAnalysis },
    },
    interpolation: { escapeValue: false },
    react: { useSuspense: false },
  })
  return instance
}

/* ───────────────────────────── the fixtures ─────────────────────────── */

function circuitOf(input: Omit<CircuitInput, 'schemaVersion'>): Circuit {
  return parseCircuit({ schemaVersion: 1, ...input })
}

/** A Bell pair, measured straight through — the circuit of the demonstration. */
const BELL: Circuit = circuitOf({
  qubits: 2,
  clbits: 2,
  operations: [
    { id: 'op_1', gate: 'h', targets: [0], column: 0 },
    { id: 'op_2', gate: 'x', targets: [1], controls: [0], column: 1 },
    { id: 'op_3', gate: 'measure', targets: [0], clbitTargets: [0], column: 2 },
    { id: 'op_4', gate: 'measure', targets: [1], clbitTargets: [1], column: 2 },
  ],
})

function stateOf(circuit: Circuit): Statevector {
  const ideal = idealCircuitOf(circuit)
  if (!ideal.ok) throw new Error(`no ideal state: ${ideal.code}`)
  const result = run(ideal.circuit)
  if (result.mode !== 'analytic') throw new Error('expected an analytic run')
  return result.state
}

/** What a Heron actually runs for a Bell pair, over hardware qubits. */
const QASM = [
  'OPENQASM 3.0;',
  'include "stdgates.inc";',
  '',
  'bit[2] c;',
  'rz(pi/2) $53;',
  'sx $53;',
  'rz(pi/2) $53;',
  'cz $53, $54;',
  'rz(pi/2) $54;',
  'sx $54;',
  'rz(pi/2) $54;',
  'c[0] = measure $53;',
  'c[1] = measure $54;',
].join('\n')

function jobOf(overrides: Partial<HardwareJob> = {}): HardwareJob {
  return {
    id: 'job_1',
    circuitId: 'circ_1',
    provider: 'ibm_quantum',
    backend: 'ibm_marrakesh',
    providerJobId: 'd2k9v0abc',
    shots: 1024,
    status: 'DONE',
    queuePosition: null,
    program: { qasm: QASM, layout: [53, 54], register: 'c', clbits: 2 },
    result: {
      backend: 'ibm_marrakesh',
      shots: 1024,
      // A believable Heron answer: the two Bell outcomes, plus leakage into the
      // two the circuit never reaches.
      counts: { '00': 470, '11': 480, '01': 39, '10': 35 },
      layout: [53, 54],
      calibratedAt: '2026-08-15T04:00:00.000Z',
      quantumSeconds: 3.2,
    },
    error: null,
    submittedAt: new Date('2026-08-15T10:00:00.000Z'),
    completedAt: new Date('2026-08-15T10:04:30.000Z'),
    ...overrides,
  }
}

function noisyReading(distribution: number[]): NoiseReading {
  return {
    method: 'density',
    distribution: Float64Array.from(distribution),
    counts: null,
    shots: null,
    distributionFidelity: 0.982,
    totalVariation: 0.024,
    stateFidelity: 0.964,
    purity: 0.947,
    density: null,
  }
}

function draw(
  language: Language,
  options: {
    readonly job?: HardwareJob
    readonly circuit?: Circuit | null
    readonly withNoise?: boolean
  } = {}
) {
  const { job = jobOf(), circuit = BELL, withNoise = true } = options
  const state = circuit === null ? null : stateOf(circuit)
  const distribution = [0.488, 0.012, 0.012, 0.488]
  const reading = noisyReading(distribution)
  const noise =
    state !== null && withNoise ? buildNoiseComparison(state, reading) : null

  return render(
    <I18nextProvider i18n={i18nFor(language)}>
      <HardwareResultView
        job={job}
        circuit={circuit}
        state={state}
        noise={noise}
        noisyDistribution={withNoise ? Float64Array.from(distribution) : null}
      />
    </I18nextProvider>
  )
}

/** Every row of the comparison table, as text. */
function comparisonRows(container: HTMLElement): string[][] {
  const table = container.querySelector(
    '.hardware-comparison .histogram__table'
  )
  if (table === null) throw new Error('the comparison table is not on screen')
  return [...table.querySelectorAll('tbody tr')].map((row) => [
    row.querySelector('th')?.textContent ?? '',
    ...[...row.querySelectorAll('td')].map((cell) => cell.textContent ?? ''),
  ])
}

afterEach(cleanup)

/* ──────────────────────────── the three columns ─────────────────────── */

describe('the three readings, on one chart', () => {
  it('draws one histogram, never three', () => {
    const { container } = draw('en')

    // One `.histogram` inside the comparison. Three would be the failure this
    // whole arrangement exists to avoid.
    expect(
      container.querySelectorAll('.hardware-comparison .histogram')
    ).toHaveLength(1)
  })

  it('gives every drawn state an ideal, a modelled and a measured value', () => {
    const { container } = draw('en')
    const rows = comparisonRows(container)
    const bell = rows.find((row) => row[0]?.includes('00'))

    // state, ideal, model, model−ideal, device, device−ideal, phase.
    expect(bell).toHaveLength(7)
    expect(bell?.[1]).toContain('50')
    expect(bell?.[2]).toContain('48')
    // 470 of the 1024 shots that came back.
    expect(bell?.[4]).toContain('45.9')
  })

  /**
   * The difference has to be *stated*. Two adjacent bar lengths leave the
   * reader subtracting, which is the one thing §3.7's view exists not to make
   * them do.
   */
  it('prints both signed differences rather than implying them', () => {
    const { container } = draw('en')
    const bell = comparisonRows(container).find((row) => row[0]?.includes('00'))

    // Signed, with an explicit minus: both readings lost probability here.
    expect(bell?.[3]).toMatch(/[−-]/)
    expect(bell?.[5]).toMatch(/[−-]/)
  })

  it('draws two lanes of movement on the one track', () => {
    const { container } = draw('en')
    const firstRow = container.querySelector(
      '.hardware-comparison .histogram__row'
    )

    // One sliver and one tick per reading, on the bar the ideal probability
    // already occupies — the lanes `HistogramOverlay` argues for.
    expect(firstRow?.querySelectorAll('.histogram__move')).toHaveLength(2)
    expect(firstRow?.querySelectorAll('.histogram__second')).toHaveLength(2)
  })

  it('names the device in the column header, not the word "real"', () => {
    // Two runs of one circuit on two machines are two measurements, and a
    // reader who saved both needs to know which is which.
    draw('en')

    expect(
      screen.getAllByRole('columnheader', { name: 'ibm_marrakesh' }).length
    ).toBeGreaterThan(0)
  })

  it('shows the outcome the device created out of nothing', () => {
    const { container } = draw('en')
    const rows = comparisonRows(container)
    const remainder = rows[rows.length - 1]

    // |01⟩ and |10⟩ are not rows — the chart's rows are chosen by ideal
    // probability — so the 7.4 % the device put there is in the remainder, and
    // its difference is positive.
    expect(remainder?.[5]).toMatch(/\+/)
  })

  it('states the sampling error the third column carries', () => {
    draw('en')

    // At 1024 shots the standard error is about 1.6 %, which is the same size
    // as the effects on the chart. A figure read to four digits off that is
    // four digits of shot noise.
    expect(screen.getByText(/sampling error/i)).not.toBeNull()
  })

  it('reports how well the model predicted the machine', () => {
    draw('en')

    expect(
      screen.getByText(enHardware.comparison.figure.modelVsDevice)
    ).not.toBeNull()
  })

  it('says the model ran the drawn circuit, not the transpiled one', () => {
    // Without this the gap between the model and the device reads as the model
    // being wrong about the physics, when most of it is the extra gates.
    draw('en')

    expect(
      screen.getByText(enHardware.comparison.modelScopeNote)
    ).not.toBeNull()
  })

  it('falls back to two readings when no noise model was run', () => {
    const { container } = draw('en', { withNoise: false })
    const firstRow = container.querySelector(
      '.hardware-comparison .histogram__row'
    )

    // One lane, not a lane of zeros for a model nobody ran.
    expect(firstRow?.querySelectorAll('.histogram__move')).toHaveLength(1)
    expect(screen.getByText(enHardware.comparison.modelMissing)).not.toBeNull()
  })
})

/* ─────────────────────────── drawn against executed ─────────────────── */

describe('what was drawn, and what ran', () => {
  it('counts both sides and says how much bigger the program is', () => {
    const { container } = draw('en')
    const growth = container.querySelector('.executed-program__growth')

    // Two drawn gates became seven on the device — four rz, two sx and a cz.
    expect(growth?.textContent).toContain('2')
    expect(growth?.textContent).toContain('7')
    expect(growth?.textContent).toContain('3.5')
  })

  it('lists the gates each side is made of', () => {
    const { container } = draw('en')
    const sides = [...container.querySelectorAll('.executed-program__side')]
    const [drawn, executed] = sides.map((side) =>
      [...side.querySelectorAll('.executed-program__gate')].map(
        (gate) => gate.textContent
      )
    )

    expect(drawn).toEqual(['h', 'x'])
    // No H and no CNOT on the machine — the fact the whole section exists for.
    expect(executed).toEqual(['rz', 'sx', 'cz'])
  })

  it('groups the executed gates by what each one costs', () => {
    const { container } = draw('en')
    const costs = [
      ...container.querySelectorAll('.executed-program__cost'),
    ].map((cost) => cost.textContent ?? '')

    // Four of the seven are frame changes, which play no pulse and cost no
    // error — a count that did not say so would overstate the damage.
    expect(costs.some((cost) => cost.includes('Frame changes'))).toBe(true)
    expect(costs.some((cost) => cost.includes('Entangling'))).toBe(true)
  })

  it('shows the submitted program itself, over physical qubits', () => {
    const { container } = draw('en')
    const source = container.querySelector('.executed-program__source')

    expect(source?.textContent).toContain('cz $53, $54;')
    // Marked so a page translator cannot rewrite a keyword inside source code.
    expect(source?.getAttribute('translate')).toBe('no')
  })

  it('shows the transpiled program before the device has answered', () => {
    // Half of §3.7's lesson never needed a result: what the transpiler did is
    // knowable the moment the job is submitted.
    const { container } = draw('en', {
      job: jobOf({ status: 'QUEUED', result: null, completedAt: null }),
    })

    expect(container.querySelector('.executed-program')).not.toBeNull()
    expect(screen.getByText(/Waiting in ibm_marrakesh.s queue/)).not.toBeNull()
  })
})

/* ────────────────────────── where it came from ──────────────────────── */

describe('the device, the queue, the hour and the calibration', () => {
  it('names the chip and the provider s own job id', () => {
    const { container } = draw('en')
    const facts = container.querySelector('.device-provenance__facts')

    expect(facts?.textContent).toContain('ibm_marrakesh')
    expect(facts?.textContent).toContain('d2k9v0abc')
  })

  it('reports the wait as a duration measured from this run', () => {
    const { container } = draw('en')
    const facts = container.querySelector('.device-provenance__facts')

    // Four and a half minutes between submission and result.
    expect(facts?.textContent).toContain('4.5 minutes')
  })

  it('reports the calibration and how old it already was', () => {
    const { container } = draw('en')
    const facts = container.querySelector('.device-provenance__facts')

    expect(facts?.textContent).toContain('6 hours')
  })

  it('reports the quantum time the run cost', () => {
    const { container } = draw('en')
    const facts = container.querySelector('.device-provenance__facts')

    expect(facts?.textContent).toContain('3.2 seconds')
  })

  it('says a missing queue position is not reported, not zero', () => {
    const { container } = draw('en')
    const facts = container.querySelector('.device-provenance__facts')

    expect(facts?.textContent).toContain('not reported')
  })

  it('explains why today s queue length is not this run s queue', () => {
    draw('en')

    expect(screen.getByText(enHardware.device.queueNote)).not.toBeNull()
  })
})

/* ──────────────────────── when there is nothing to draw ─────────────── */

describe('the states with no comparison in them', () => {
  it('shows the counts by themselves when the circuit has no ideal state', () => {
    const conditioned = circuitOf({
      qubits: 2,
      clbits: 2,
      operations: [
        { id: 'op_1', gate: 'h', targets: [0], column: 0 },
        {
          id: 'op_2',
          gate: 'measure',
          targets: [0],
          clbitTargets: [0],
          column: 1,
        },
        {
          id: 'op_3',
          gate: 'x',
          targets: [1],
          column: 2,
          condition: { clbit: 0, equals: 1 },
        },
        {
          id: 'op_4',
          gate: 'measure',
          targets: [1],
          clbitTargets: [1],
          column: 3,
        },
      ],
    })

    render(
      <I18nextProvider i18n={i18nFor('en')}>
        <HardwareResultView
          job={jobOf()}
          circuit={conditioned}
          state={null}
          noise={null}
          noisyDistribution={null}
          idealRefusal="conditioned"
        />
      </I18nextProvider>
    )

    expect(
      screen.getByText(enHardware.comparison.refused.conditioned)
    ).not.toBeNull()
    // The counts are still shown: they are the one artefact on the page that
    // cost quantum time.
    const counts = screen.getByRole('table', {
      name: enHardware.comparison.deviceCounts.heading,
    })
    expect(within(counts).getByText('470')).not.toBeNull()
  })

  /**
   * A DONE job whose counts are empty. Rare and not impossible — the stored
   * schema accepts `{}` — and it used to take the page down: a distribution of
   * all zeros does not sum to one, `distributionFidelity` refuses it by design,
   * and the throw landed inside a render.
   *
   * It also has to say the *right* thing. Falling through the alignment would
   * blame the circuit for leaving a qubit unmeasured, which is a sentence about
   * the wrong half of the problem.
   */
  it('says so when the device returned no shots, instead of throwing', () => {
    const empty = jobOf({
      result: {
        backend: 'ibm_marrakesh',
        shots: 1024,
        counts: {},
        layout: [53, 54],
        calibratedAt: '2026-08-15T04:00:00.000Z',
        quantumSeconds: 3.2,
      },
    })

    expect(() => draw('en', { job: empty })).not.toThrow()
    expect(
      screen.getByText(enHardware.comparison.refused.noCounts)
    ).not.toBeNull()
  })

  it('renders a failure as a sentence, from the stored code', () => {
    render(
      <I18nextProvider i18n={i18nFor('en')}>
        <HardwareResultView
          job={jobOf({
            status: 'FAILED',
            result: null,
            error: 'QUOTA_EXHAUSTED',
          })}
          circuit={BELL}
          state={null}
          noise={null}
          noisyDistribution={null}
        />
      </I18nextProvider>
    )

    expect(screen.getByText(enHardware.failure.QUOTA_EXHAUSTED)).not.toBeNull()
  })

  it('carries an unknown failure code rather than swallowing it', () => {
    // A reader with nothing to search for is worse off than one holding the
    // word the provider's own console also uses.
    render(
      <I18nextProvider i18n={i18nFor('en')}>
        <HardwareResultView
          job={jobOf({ status: 'FAILED', result: null, error: 'NEW_CODE' })}
          circuit={BELL}
          state={null}
          noise={null}
          noisyDistribution={null}
        />
      </I18nextProvider>
    )

    expect(screen.getByText(/NEW_CODE/)).not.toBeNull()
  })

  it('keeps the provenance on screen when the run failed', () => {
    // "Which chip, when, under what calibration" is exactly as true of a failed
    // run as of a finished one.
    const { container } = render(
      <I18nextProvider i18n={i18nFor('en')}>
        <HardwareResultView
          job={jobOf({
            status: 'FAILED',
            result: null,
            error: 'POLL_ABANDONED',
          })}
          circuit={BELL}
          state={null}
          noise={null}
          noisyDistribution={null}
        />
      </I18nextProvider>
    )

    expect(container.querySelector('.device-provenance')).not.toBeNull()
  })
})

/* ──────────────────────────── three languages ───────────────────────── */

/**
 * The shape a raw i18next key has, borrowed from `e2e/no-raw-keys.spec.ts`.
 * That suite walks routes; this one reaches the surfaces a walk cannot — the
 * refusals and the failure states, which only exist for particular jobs.
 */
const KEY_SHAPE = /^[a-z][a-zA-Z]*(\.[a-zA-Z]+)+$/

function rawKeysIn(container: HTMLElement): string[] {
  const found = new Set<string>()
  for (const element of container.querySelectorAll('*')) {
    if (element.children.length > 0) continue
    const text = (element.textContent ?? '').trim()
    if (text && KEY_SHAPE.test(text)) found.add(text)
  }
  return [...found]
}

describe.each(['en', 'es', 'fr'] as const)('in %s', (language) => {
  it('renders the finished comparison in words, not keys', () => {
    const { container } = draw(language)

    expect(rawKeysIn(container)).toEqual([])
    expect(container.textContent).toContain(
      HARDWARE[language].comparison.heading
    )
    expect(container.textContent).toContain(HARDWARE[language].program.heading)
    expect(container.textContent).toContain(HARDWARE[language].device.heading)
  })

  it('renders a failed run in words, not keys', () => {
    const { container } = render(
      <I18nextProvider i18n={i18nFor(language)}>
        <HardwareResultView
          job={jobOf({
            status: 'FAILED',
            result: null,
            error: 'CREDENTIAL_INVALID',
          })}
          circuit={BELL}
          state={null}
          noise={null}
          noisyDistribution={null}
        />
      </I18nextProvider>
    )

    expect(rawKeysIn(container)).toEqual([])
    expect(container.textContent).toContain(
      HARDWARE[language].failure.CREDENTIAL_INVALID
    )
  })

  it('renders a queued run in words, not keys', () => {
    const { container } = render(
      <I18nextProvider i18n={i18nFor(language)}>
        <HardwareResultView
          job={jobOf({ status: 'QUEUED', result: null, completedAt: null })}
          circuit={BELL}
          state={null}
          noise={null}
          noisyDistribution={null}
        />
      </I18nextProvider>
    )

    expect(rawKeysIn(container)).toEqual([])
  })

  it('renders a refused join in words, not keys', () => {
    const { container } = render(
      <I18nextProvider i18n={i18nFor(language)}>
        <HardwareResultView
          job={jobOf()}
          circuit={BELL}
          state={null}
          noise={null}
          noisyDistribution={null}
          idealRefusal="mid-circuit-measurement"
        />
      </I18nextProvider>
    )

    expect(rawKeysIn(container)).toEqual([])
    expect(container.textContent).toContain(
      HARDWARE[language].comparison.refused['mid-circuit-measurement']
    )
  })
})

/* ─────────────────────────── nothing but the row ────────────────────── */

describe('rendering from storage', () => {
  /**
   * The property the demonstration depends on. Everything above was drawn from
   * one job object and one statevector computed in this process — no fetch, no
   * provider, no queue. This test states it rather than assuming it: a future
   * change that reached for a device would fail here and nowhere else, because
   * every other test would still pass with a network call in it.
   */
  it('draws the whole page with no network of any kind', () => {
    const fetchBefore = globalThis.fetch
    let called = false
    globalThis.fetch = () => {
      called = true
      throw new Error('the stored view must not fetch anything')
    }

    try {
      const { container } = draw('en')
      expect(container.querySelector('.hardware-comparison')).not.toBeNull()
      expect(container.querySelector('.executed-program')).not.toBeNull()
      expect(container.querySelector('.device-provenance')).not.toBeNull()
      expect(called).toBe(false)
    } finally {
      globalThis.fetch = fetchBefore
    }
  })
})
