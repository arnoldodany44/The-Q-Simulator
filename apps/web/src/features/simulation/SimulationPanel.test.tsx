import { run } from '@qsim/core'
import { parseCircuit, type Circuit } from '@qsim/schema'
import { act, cleanup, render, screen } from '@testing-library/react'
import { createInstance, type i18n as I18n } from 'i18next'
import { I18nextProvider, initReactI18next } from 'react-i18next'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import enSimulation from '../../i18n/locales/en/simulation.json'
import esSimulation from '../../i18n/locales/es/simulation.json'
import frSimulation from '../../i18n/locales/fr/simulation.json'
import { SimulationPanel } from './SimulationPanel'
import {
  encodeState,
  type SimulationRequest,
  type SimulationResponse,
} from './protocol'
import { SIMULATION_DEBOUNCE_MS } from './scheduler'
import type { SimulationWorkerLike } from './useSimulation'

/**
 * The one component that mounts `useSimulation`, and therefore the only
 * reason a worker is ever spawned in this app.
 *
 * Two things are worth proving here. First, that the panel is a window on a
 * real pipeline: a request goes out when the edits stop, and the answer that
 * comes back is described rather than swallowed. Second, that the >20 qubit
 * refusal §3.1 requires actually reaches a user, in all three languages —
 * before this panel existed the scheduler produced that refusal faithfully
 * and nothing on screen ever read it.
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
    ns: ['simulation'],
    defaultNS: 'simulation',
    resources: {
      en: { simulation: enSimulation },
      es: { simulation: esSimulation },
      fr: { simulation: frSimulation },
    },
    interpolation: { escapeValue: false },
    react: { useSuspense: false },
  })
  return instance
}

function mount(circuit: Circuit, language: Language = 'en') {
  const worker = new FakeWorker()
  const createWorker = () => worker
  const view = render(
    <I18nextProvider i18n={i18nFor(language)}>
      <SimulationPanel circuit={circuit} createWorker={createWorker} />
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

function emptyOf(qubits: number): Circuit {
  return parseCircuit({ schemaVersion: 1, qubits, operations: [] })
}

/** The answer the real worker would post for `circuit`, computed for real. */
function resultFor(id: number, circuit: Circuit): SimulationResponse {
  const result = run(circuit)
  if (result.mode !== 'analytic') throw new Error('expected an analytic run')
  return {
    kind: 'result',
    id,
    mode: 'analytic',
    state: encodeState(result.state, false).payload,
    resumedFromColumn: 0,
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

describe('the live pipeline', () => {
  it('asks for a simulation once the edits stop and describes the answer', () => {
    const circuit = bellOfThree()
    const { worker } = mount(circuit)

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
    expect(screen.getByText('3')).toBeDefined()
    expect(screen.getByText('2')).toBeDefined()
    expect(screen.getByText('2 ms')).toBeDefined()
  })

  it('says nothing is simulated until a worker answers', () => {
    mount(bellOfThree())

    // The live region exists from the first frame even with nothing to say —
    // one that appears together with its text is one some readers never hear.
    expect(screen.getByRole('status').textContent).toBe('')
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
