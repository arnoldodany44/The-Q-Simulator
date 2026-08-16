import { createRng, run, sampleShots, trajectoriesMode } from '@qsim/core'
import { parseCircuit, type Circuit } from '@qsim/schema'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { createInstance, type i18n as I18n } from 'i18next'
import { I18nextProvider, initReactI18next } from 'react-i18next'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import enAnalysis from '../../i18n/locales/en/analysis.json'
import esAnalysis from '../../i18n/locales/es/analysis.json'
import frAnalysis from '../../i18n/locales/fr/analysis.json'
import enSimulation from '../../i18n/locales/en/simulation.json'
import esSimulation from '../../i18n/locales/es/simulation.json'
import frSimulation from '../../i18n/locales/fr/simulation.json'
import { SimulationPanel } from './SimulationPanel'
import {
  encodeState,
  type SampleSpec,
  type SimulationRequest,
  type SimulationResponse,
} from './protocol'
import { SIMULATION_DEBOUNCE_MS } from './scheduler'
import type { SimulationWorkerLike } from './useSimulation'

/**
 * The one component that mounts `useSimulation`, and therefore the only
 * reason a worker is ever spawned in this app.
 *
 * Three things are worth proving here. First, that the panel is a window on
 * a real pipeline: a request goes out when the edits stop, and the answer
 * that comes back is described rather than swallowed. Second, that the >20
 * qubit refusal §3.1 requires actually reaches a user, in all three
 * languages — before this panel existed the scheduler produced that refusal
 * faithfully and nothing on screen ever read it. Third, since M0.7b, that
 * the statevector reaches the histogram: the chart is tested on its own in
 * `features/analysis`, so what is asserted here is only the join.
 *
 * jsdom has no `Worker`, so the panel is given one it does not have to spawn.
 * The real one is exercised end to end in `apps/web/e2e/simulation.spec.ts`.
 */

type Language = 'en' | 'es' | 'fr'

const CATALOGS: Record<Language, typeof enSimulation> = {
  en: enSimulation,
  es: esSimulation,
  fr: frSimulation,
}

const CATALOGS_ANALYSIS: Record<Language, typeof enAnalysis> = {
  en: enAnalysis,
  es: esAnalysis,
  fr: frAnalysis,
}

class FakeWorker implements SimulationWorkerLike {
  readonly sent: SimulationRequest[] = []
  onmessage: ((event: MessageEvent<SimulationResponse>) => void) | null = null
  onerror: ((event: ErrorEvent) => void) | null = null
  onmessageerror: ((event: MessageEvent) => void) | null = null

  postMessage(message: SimulationRequest): void {
    this.sent.push(message)
  }

  terminate(): void {
    this.onmessage = null
  }

  reply(response: SimulationResponse): void {
    act(() => {
      this.onmessage?.(new MessageEvent('message', { data: response }))
    })
  }

  get simulations(): SimulationRequest[] {
    return this.sent.filter((message) => message.kind === 'simulate')
  }
}

function i18nFor(language: Language): I18n {
  const instance = createInstance()
  void instance.use(initReactI18next).init({
    lng: language,
    fallbackLng: 'en',
    ns: ['analysis', 'simulation'],
    defaultNS: 'simulation',
    resources: {
      en: { analysis: enAnalysis, simulation: enSimulation },
      es: { analysis: esAnalysis, simulation: esSimulation },
      fr: { analysis: frAnalysis, simulation: frSimulation },
    },
    interpolation: { escapeValue: false },
    react: { useSuspense: false },
  })
  return instance
}

function mount(
  circuit: Circuit,
  language: Language = 'en',
  throughColumn: number | null = null
) {
  const worker = new FakeWorker()
  const createWorker = () => worker
  const view = render(
    <I18nextProvider i18n={i18nFor(language)}>
      <SimulationPanel
        circuit={circuit}
        throughColumn={throughColumn}
        createWorker={createWorker}
      />
    </I18nextProvider>
  )
  return { worker, view }
}

function tick(): void {
  act(() => {
    vi.advanceTimersByTime(SIMULATION_DEBOUNCE_MS)
  })
}

/** A Bell pair on the first two of three wires: two amplitudes out of eight. */
function bellOfThree(): Circuit {
  return parseCircuit({
    schemaVersion: 1,
    qubits: 3,
    operations: [
      { id: 'a', gate: 'h', targets: [0], column: 0 },
      { id: 'b', gate: 'cx', targets: [1], controls: [0], column: 1 },
    ],
  })
}

/** A single qubit put in superposition and then read into a classical bit. */
function measuring(): Circuit {
  return parseCircuit({
    schemaVersion: 1,
    qubits: 1,
    clbits: 1,
    operations: [
      { id: 'a', gate: 'h', targets: [0], column: 0 },
      { id: 'b', gate: 'measure', targets: [0], clbitTargets: [0], column: 1 },
    ],
  })
}

function emptyOf(qubits: number): Circuit {
  return parseCircuit({ schemaVersion: 1, qubits, operations: [] })
}

/**
 * The answer the real worker would post for `circuit`, computed for real —
 * including the shots, when the request asked for any, drawn by the engine's
 * own sampler exactly as `runJob` would.
 */
function resultFor(
  id: number,
  circuit: Circuit,
  sample: SampleSpec | null = null,
  throughColumn: number | null = null
): SimulationResponse {
  const result = run(circuit)
  if (result.mode !== 'analytic') throw new Error('expected an analytic run')
  return {
    kind: 'result',
    id,
    mode: 'analytic',
    state: encodeState(result.state, false).payload,
    resumedFromColumn: 0,
    throughColumn,
    sampling:
      sample === null
        ? null
        : {
            ...sample,
            counts: sampleShots(
              result.state,
              sample.shots,
              createRng(sample.seed)
            ),
          },
    noise: null,
    durationMs: 2,
  }
}

function refusal(language: Language, qubits: number): string {
  return CATALOGS[language].errors['too-many-qubits']
    .replace('{{qubits}}', String(qubits))
    .replace('{{limit}}', '20')
}

beforeEach(() => {
  vi.useFakeTimers()
})

afterEach(() => {
  cleanup()
  vi.useRealTimers()
})

/**
 * The shots control's own checkbox, addressed by its label.
 *
 * By name rather than by role: since M2.2 the panel also carries the noise
 * mode's switch, and `getByRole('checkbox')` finding two of them is the whole
 * of what this helper exists to prevent — a test that clicked whichever came
 * first in the DOM would silently start exercising the wrong feature the next
 * time a control is added above it.
 */
function enableSampling(): HTMLElement {
  return screen.getByRole('checkbox', {
    name: CATALOGS_ANALYSIS.en.sampling.enable,
  })
}

/** The value of a fact, addressed by the term it is filed under. */
function fact(view: ReturnType<typeof mount>['view'], term: string): string {
  const facts = [...view.container.querySelectorAll('.simulation-panel__fact')]
  const match = facts.find(
    (node) => node.querySelector('dt')?.textContent === term
  )
  return match?.querySelector('dd')?.textContent ?? ''
}

describe('the live pipeline', () => {
  it('asks for a simulation once the edits stop and describes the answer', () => {
    const circuit = bellOfThree()
    const { worker, view } = mount(circuit)

    expect(screen.getByText(enSimulation.panel.state.scheduled)).toBeDefined()
    expect(worker.simulations).toHaveLength(0)

    tick()
    expect(worker.simulations).toHaveLength(1)
    expect(screen.getByText(enSimulation.panel.state.running)).toBeDefined()

    worker.reply(resultFor(worker.simulations[0]!.id, circuit))

    expect(screen.getByText(enSimulation.panel.state.ready)).toBeDefined()
    // Three wires, two basis states with any probability on them, and a
    // duration that came back from the run: none of these three numbers can
    // be produced without the whole pipeline having worked.
    expect(fact(view, enSimulation.panel.qubits)).toBe('3')
    expect(fact(view, enSimulation.panel.support)).toBe('2')
    expect(fact(view, enSimulation.panel.duration)).toBe('2 ms')
  })

  it('draws the state it was given', () => {
    const circuit = bellOfThree()
    const { worker, view } = mount(circuit)
    tick()
    worker.reply(resultFor(worker.simulations[0]!.id, circuit))

    // The join M0.7b added: the amplitudes that crossed the thread boundary
    // are the ones the histogram is drawing. A Bell pair on three wires is
    // two bars out of eight basis states, named the way `formatKet` prints
    // them. Everything else about the chart is `analysis`'s own business.
    expect(view.container.querySelectorAll('.histogram__fill')).toHaveLength(2)
    const kets = [
      ...view.container.querySelectorAll('.histogram__table th[scope="row"]'),
    ].map((node) => node.textContent)
    expect(kets).toEqual(['|000⟩', '|011⟩'])
  })

  it('tabulates the same amplitudes underneath', () => {
    // The join M0.7c added. The table is the panel's exact reading, and it is
    // reading the same state the chart above it drew — two rows of 1/√2.
    const circuit = bellOfThree()
    const { worker, view } = mount(circuit)
    tick()
    worker.reply(resultFor(worker.simulations[0]!.id, circuit))

    const table = view.container.querySelector('.amplitudes__grid')
    const first = table?.querySelectorAll('tbody tr td')
    expect(first?.[0]?.textContent).toBe('0.7071 + 0.0000i')
  })

  it('says nothing is simulated until a worker answers', () => {
    const { view } = mount(bellOfThree())

    // The live region exists from the first frame even with nothing to say —
    // one that appears together with its text is one some readers never hear.
    expect(screen.getByRole('status').textContent).toBe('')
    // And nothing is drawn: an empty chart would be a claim about a circuit
    // no worker has answered for yet.
    expect(view.container.querySelector('.histogram')).toBeNull()
  })
})

describe('the shots control', () => {
  /** The sample spec of the last request the worker was given. */
  function lastSample(worker: FakeWorker): SampleSpec | null | undefined {
    const last = worker.simulations.at(-1)
    return last?.kind === 'simulate' && last.mode === 'analytic'
      ? last.sample
      : undefined
  }

  it('asks for nothing until the reader asks for it', () => {
    const circuit = bellOfThree()
    const { worker } = mount(circuit)
    tick()

    // §5.3: the exact distribution is already on screen, and shot noise
    // nobody requested is noise. The request says so rather than omitting it.
    expect(lastSample(worker)).toBeNull()
  })

  it('sends the shot count and the seed to the worker, not to the main thread', () => {
    const circuit = bellOfThree()
    const { worker } = mount(circuit)
    tick()
    worker.reply(resultFor(worker.simulations[0]!.id, circuit))

    act(() => {
      fireEvent.click(enableSampling())
    })
    tick()

    // 100 000 draws over a million amplitudes is not something the main
    // thread can do between two frames, so the control's whole job is to put
    // the request on the wire the state already travels on.
    expect(worker.simulations).toHaveLength(2)
    expect(lastSample(worker)).toEqual({ shots: 1000, seed: 1 })
  })

  it('shows the counts beside the exact distribution they were drawn from', () => {
    const circuit = bellOfThree()
    const { worker, view } = mount(circuit)
    tick()
    worker.reply(resultFor(worker.simulations[0]!.id, circuit))

    act(() => {
      fireEvent.click(enableSampling())
    })
    tick()
    const request = worker.simulations.at(-1)!
    worker.reply(resultFor(request.id, circuit, { shots: 1000, seed: 1 }))

    // Two states, a thousand shots between them, and both readings of each on
    // one row. The counts came from the same message as the state, which is
    // what makes the comparison a comparison rather than two claims.
    const rows = view.container.querySelectorAll('.shot-sampler__grid tbody tr')
    expect(rows).toHaveLength(2)
    const counted = [...rows].map((row) =>
      Number(row.querySelectorAll('td')[1]?.textContent?.replace(/\D/gu, ''))
    )
    expect(counted[0]! + counted[1]!).toBe(1000)
  })
})

describe('the timeline (M0.8)', () => {
  /** The scrub position of the last request the worker was given. */
  function lastPosition(worker: FakeWorker): number | null | undefined {
    const last = worker.simulations.at(-1)
    return last?.kind === 'simulate' ? last.throughColumn : undefined
  }

  function caption(view: ReturnType<typeof mount>['view']): string | null {
    return (
      view.container.querySelector('.simulation-panel__moment')?.textContent ??
      null
    )
  }

  it('asks for the whole circuit while nobody is scrubbing', () => {
    const { worker, view } = mount(bellOfThree())
    tick()
    worker.reply(resultFor(worker.simulations[0]!.id, bellOfThree()))

    expect(lastPosition(worker)).toBeNull()
    // And says nothing: an unscrubbed panel describes the circuit's answer,
    // which is what the heading above it already promises.
    expect(caption(view)).toBeNull()
  })

  it('carries the position into the request', () => {
    const { worker } = mount(bellOfThree(), 'en', 1)
    tick()

    expect(lastPosition(worker)).toBe(1)
  })

  it('says outright that the charts are an intermediate state', () => {
    // A histogram of column 1 presented as the circuit's answer is a lie told
    // in a chart, and it is the one failure of this feature a reader has no
    // way of catching.
    const circuit = bellOfThree()
    const { worker, view } = mount(circuit, 'en', 1)
    tick()
    worker.reply(resultFor(worker.simulations[0]!.id, circuit, null, 1))

    expect(caption(view)).toBe(
      enSimulation.panel.moment.column.replace('{{column}}', '1')
    )
  })

  it('names the position before the first column by name, not by number', () => {
    const circuit = bellOfThree()
    const { worker, view } = mount(circuit, 'en', -1)
    tick()
    worker.reply(resultFor(worker.simulations[0]!.id, circuit, null, -1))

    expect(caption(view)).toBe(enSimulation.panel.moment.start)
  })

  it('captions the state it is showing, not the bar it is chasing', () => {
    /*
     * The bar moves on the main thread and the worker answers a few
     * milliseconds later. Between the two, the panel is drawing the previous
     * position — so the caption is read off the *response*, and a panel that
     * read it off its own prop would spend that gap naming a column the
     * picture underneath it does not belong to.
     */
    const circuit = bellOfThree()
    const { worker, view } = mount(circuit, 'en', 1)
    tick()
    worker.reply(resultFor(worker.simulations[0]!.id, circuit, null, 0))

    expect(caption(view)).toBe(
      enSimulation.panel.moment.column.replace('{{column}}', '0')
    )
  })
})

describe('the browser ceiling', () => {
  it.each(['en', 'es', 'fr'] as const)(
    'refuses a 21-qubit register in %s',
    (language) => {
      const { worker } = mount(emptyOf(21), language)
      tick()

      // Refused on the main thread: the tab never allocates what it cannot
      // hold, and the sentence explaining why is now on screen.
      expect(worker.simulations).toHaveLength(0)
      expect(screen.getByRole('status').textContent).toBe(refusal(language, 21))
      expect(
        screen.getByText(CATALOGS[language].panel.state.error)
      ).toBeDefined()
    }
  )

  it('simulates a 20-qubit register without complaining', () => {
    const { worker } = mount(emptyOf(20))
    tick()

    expect(worker.simulations).toHaveLength(1)
    expect(screen.getByRole('status').textContent).toBe('')
  })
})

/**
 * A circuit that measures before it ends has no single final state (§5.3), so
 * the panel has to ask a different question of the engine and draw a different
 * answer. Before M0.9 it asked the same question for every circuit and showed
 * the engine's refusal where the answer belongs, which is what made the
 * teleportation preset unshippable.
 */
describe('a circuit that measures', () => {
  it('is requested in trajectories mode, not analytic', () => {
    const { worker } = mount(measuring())
    tick()

    const [request] = worker.simulations
    expect(request?.kind).toBe('simulate')
    expect(request).toMatchObject({ mode: 'trajectories' })
  })

  it('is drawn as a tally of the classical register', () => {
    const circuit = measuring()
    const { worker } = mount(circuit)
    tick()

    const request = worker.simulations[0]
    if (request?.kind !== 'simulate' || request.mode !== 'trajectories') {
      throw new Error('expected a trajectories request')
    }
    // The counts the real worker would produce, from the real engine.
    const result = run(circuit, trajectoriesMode(request.shots, createRng(1)))
    if (result.mode !== 'trajectories') throw new Error('expected a tally')
    worker.reply({
      kind: 'result',
      id: request.id,
      mode: 'trajectories',
      shots: result.shots,
      counts: result.counts,
      throughColumn: null,
      durationMs: 3,
    })

    expect(screen.getByText(enAnalysis.counts.heading)).toBeDefined()
    // Both readings of a measured |+⟩, and no histogram beside them: there is
    // no statevector to draw one from.
    const readings = screen
      .getAllByRole('rowheader')
      .map((cell) => cell.textContent)
    expect(readings).toEqual(['0', '1'])
    expect(screen.queryByText(enAnalysis.histogram.heading)).toBeNull()
  })

  it('goes back to analytic mode when the measurement is deleted', () => {
    const circuit = measuring()
    const { worker, view } = mount(circuit)
    tick()
    expect(worker.simulations[0]).toMatchObject({ mode: 'trajectories' })

    const unitary = parseCircuit({
      ...circuit,
      operations: circuit.operations.filter(
        (operation) => operation.gate !== 'measure'
      ),
    })
    view.rerender(
      <I18nextProvider i18n={i18nFor('en')}>
        <SimulationPanel
          circuit={unitary}
          throughColumn={null}
          createWorker={() => worker}
        />
      </I18nextProvider>
    )
    tick()

    expect(worker.simulations[1]).toMatchObject({ mode: 'analytic' })
  })
})

/**
 * The bar on a circuit that measures (M0.9c).
 *
 * It used to be a control wired to nothing here: it moved, it announced a
 * position, the canvas painted a playhead at it, and the panel went on
 * describing the whole circuit under a status line saying "this describes the
 * circuit on screen". A measuring circuit has no single state at a column, but
 * its classical register at that column is a perfectly well defined thing —
 * and it is exactly what this panel draws.
 */
describe('the timeline on a circuit that measures', () => {
  function caption(view: ReturnType<typeof mount>['view']): string | null {
    return (
      view.container.querySelector('.simulation-panel__moment')?.textContent ??
      null
    )
  }

  it('carries the position into the trajectories request', () => {
    const { worker } = mount(measuring(), 'en', 0)
    tick()

    const request = worker.simulations.at(-1)
    expect(request).toMatchObject({ mode: 'trajectories', throughColumn: 0 })
  })

  it('captions the tally with the instant it answers for', () => {
    const circuit = measuring()
    const { worker, view } = mount(circuit, 'en', 0)
    tick()

    const request = worker.simulations[0]
    if (request?.kind !== 'simulate' || request.mode !== 'trajectories') {
      throw new Error('expected a trajectories request')
    }
    worker.reply({
      kind: 'result',
      id: request.id,
      mode: 'trajectories',
      shots: 8,
      counts: { '0': 8 },
      throughColumn: 0,
      durationMs: 1,
    })

    expect(caption(view)).toBe(
      enSimulation.panel.moment.column.replace('{{column}}', '0')
    )
    // Before the measurement runs, every shot reads 0 — and the panel says
    // which instant that is rather than presenting it as the answer.
    const readings = screen
      .getAllByRole('rowheader')
      .map((cell) => cell.textContent)
    expect(readings).toEqual(['0'])
  })
})
