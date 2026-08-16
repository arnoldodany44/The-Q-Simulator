/**
 * Independent verification — §3.3's ceiling, end to end.
 *
 * A density matrix is 4ⁿ complex numbers: 64 KB at four qubits, 256 MB at
 * twelve, 4 GB at fourteen. §3.3 tops the mode out around ten to twelve and
 * calls that fine, because it is a study mode rather than a scale mode. What is
 * *not* fine is any of the three ways a limit like that usually reaches a user:
 *
 *   - a tab that thinks for a while and then stops responding,
 *   - an allocation that throws from inside a typed-array constructor,
 *   - a control that is disabled with nothing on screen saying why.
 *
 * So the requirement is that the ceiling is a clear translated refusal naming
 * the limit and the alternative, and this file walks the whole path to prove
 * it: the panel refuses before a request is built, the worker refuses again on
 * its own account if one ever arrives, the refusal is words in all three
 * languages, and — the part that is easy to lose — **nothing else on the panel
 * is taken away to report it**. A thirteen-qubit circuit still has its
 * histogram, its amplitude table and its Q-sphere.
 */

import { run, type Statevector } from '@qsim/core'
import { parseCircuit, type Circuit } from '@qsim/schema'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { createInstance, type i18n as I18n } from 'i18next'
import { I18nextProvider, initReactI18next } from 'react-i18next'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { SimulationPanel } from '../../features/simulation/SimulationPanel'
import { runNoiseJob } from '../../features/simulation/noiseJob'
import {
  MAX_DENSITY_CLIENT_QUBITS,
  encodeState,
  type NoisePayload,
  type NoiseSpec,
  type SimulationRequest,
  type SimulationResponse,
} from '../../features/simulation/protocol'
import { SIMULATION_DEBOUNCE_MS } from '../../features/simulation/scheduler'
import type { SimulationWorkerLike } from '../../features/simulation/useSimulation'
import enAnalysis from '../../i18n/locales/en/analysis.json'
import esAnalysis from '../../i18n/locales/es/analysis.json'
import frAnalysis from '../../i18n/locales/fr/analysis.json'
import enSimulation from '../../i18n/locales/en/simulation.json'
import esSimulation from '../../i18n/locales/es/simulation.json'
import frSimulation from '../../i18n/locales/fr/simulation.json'

type Language = 'en' | 'es' | 'fr'

const ANALYSIS: Record<Language, typeof enAnalysis> = {
  en: enAnalysis,
  es: esAnalysis,
  fr: frAnalysis,
}
const SIMULATION: Record<Language, typeof enSimulation> = {
  en: enSimulation,
  es: esSimulation,
  fr: frSimulation,
}

/** The first register size §3.3 refuses to build a ρ for. */
const OVER = MAX_DENSITY_CLIENT_QUBITS + 1

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

/** One Hadamard on a wide register: two occupied states, 2ⁿ amplitudes. */
function wide(qubits: number): Circuit {
  return parseCircuit({
    schemaVersion: 1,
    qubits,
    operations: [{ id: 'a', gate: 'h', targets: [0], column: 0 }],
  })
}

function stateOf(circuit: Circuit): Statevector {
  const result = run(circuit)
  if (result.mode !== 'analytic') throw new Error('expected an analytic run')
  return result.state
}

/** Every run of whitespace as one space — French writes U+00A0 before a colon. */
function spaces(value: string): string {
  return value.replace(/\s+/gu, ' ').trim()
}

/**
 * The panel with the noise mode switched on, answering every request with a
 * real `runJob`-shaped response — including whatever `runNoiseJob` says about
 * the register, so a refusal on screen is a refusal the engine produced.
 */
function mount(
  circuit: Circuit,
  language: Language = 'en',
  /**
   * A noisy payload to answer with instead of the one this circuit would
   * really produce — the shape a stale client or a tightened engine budget
   * would send, which the panel has to render whether or not it predicted it.
   */
  noiseOverride?: NoisePayload
) {
  const worker = new FakeWorker()
  const view = render(
    <I18nextProvider i18n={i18nFor(language)}>
      <SimulationPanel circuit={circuit} createWorker={() => worker} />
    </I18nextProvider>
  )

  const respond = (noiseOverride?: NoisePayload): void => {
    act(() => {
      vi.advanceTimersByTime(SIMULATION_DEBOUNCE_MS)
    })
    const request = worker.simulations.at(-1)
    if (request === undefined || request.kind !== 'simulate') return
    if (request.mode !== 'analytic') return
    const state = stateOf(circuit)
    worker.reply({
      kind: 'result',
      id: request.id,
      mode: 'analytic',
      state: encodeState(state, false).payload,
      resumedFromColumn: 0,
      throughColumn: null,
      sampling: null,
      noise:
        noiseOverride ??
        (request.noise === null
          ? null
          : runNoiseJob(circuit, state, request.noise)),
      durationMs: 1,
    })
  }

  respond()
  act(() => {
    fireEvent.click(
      screen.getByRole('checkbox', { name: ANALYSIS[language].noise.enable })
    )
  })
  respond(noiseOverride)

  return { worker, view, respond }
}

beforeEach(() => {
  vi.useFakeTimers()
})

afterEach(() => {
  cleanup()
  vi.useRealTimers()
})

describe('the panel refuses before it asks', () => {
  it('sends no noisy run for a register past the ceiling', () => {
    /*
     * The check that has to happen *first*, because the alternative is a tab
     * that reserves a gigabyte before discovering it should not have. `specOf`
     * answers from one integer, so the refusal is on screen in the same frame
     * the reader ticks the box.
     */
    const { worker } = mount(wide(OVER))
    for (const request of worker.simulations) {
      if (request.kind !== 'simulate') continue
      if (request.mode !== 'analytic') continue
      expect(request.noise).toBeNull()
    }
  })

  it('does ask once the register fits', () => {
    /*
     * The negative above would pass trivially if the panel never asked at all.
     *
     * The claim is about the *request*, so the answer is stubbed rather than
     * computed: a real twelve-qubit density run is a 256 MB reservation and
     * seconds of arithmetic, and `every-route-refuses.test.ts` gives the reason
     * that does not belong in a correctness suite running beside three other
     * workspaces — it would be measuring the scheduler, and a suite that goes
     * red at random is one everyone learns to ignore. The engine's own answer
     * at this size is exercised without a clock in that file, at four qubits,
     * and with one in `@qsim/core`'s `noise.perf.test.ts`.
     */
    const { worker } = mount(wide(MAX_DENSITY_CLIENT_QUBITS), 'en', {
      ok: false,
      refusal: { code: 'noise-failed', detail: 'not the subject of this test' },
    })
    const asked = worker.simulations.some(
      (request) =>
        request.kind === 'simulate' &&
        request.mode === 'analytic' &&
        request.noise !== null
    )
    expect(asked).toBe(true)
  })

  it.each(['en', 'es', 'fr'] as const)(
    'says the register, the limit and the way out in %s',
    (language) => {
      mount(wide(OVER), language)
      const expected = ANALYSIS[language].noise.refusal.tooLarge
        .replace('{{qubits}}', String(OVER))
        .replace('{{limit}}', String(MAX_DENSITY_CLIENT_QUBITS))

      const refusal = document.querySelector('.noise__refusal-text')
      expect(spaces(refusal?.textContent ?? ''), language).toBe(
        spaces(expected)
      )
      // And the alternative is a control, not advice.
      expect(
        screen.getByRole('button', {
          name: ANALYSIS[language].noise.refusal.switch,
        })
      ).toBeTruthy()
    }
  )

  it('is a live region, because it appears in answer to what the reader did', () => {
    mount(wide(OVER))
    expect(
      document.querySelector('.noise__refusal')?.getAttribute('role')
    ).toBe('status')
  })

  it('starts asking as soon as the reader takes the way out', () => {
    /*
     * The refusal names sampled trajectories as the alternative, so the
     * alternative has to work — a sentence offering a way out that leads
     * nowhere is worse than no sentence.
     */
    const { worker, respond } = mount(wide(OVER))
    act(() => {
      fireEvent.click(
        screen.getByRole('button', {
          name: enAnalysis.noise.refusal.switch,
        })
      )
    })
    // Answered with a stub for the reason the test above is: the claim is that
    // a *request* goes out with the sampled method on it, and drawing two
    // thousand real trajectories on thirteen wires to prove it would put a
    // second of arithmetic in a correctness suite that runs beside three other
    // workspaces.
    respond({
      ok: false,
      refusal: { code: 'noise-failed', detail: 'not the subject of this test' },
    })

    const last = worker.simulations.at(-1)
    expect(last?.kind).toBe('simulate')
    if (last?.kind !== 'simulate' || last.mode !== 'analytic') {
      throw new Error('expected an analytic request')
    }
    expect(last.noise).not.toBeNull()
    expect(last.noise?.method).toBe('trajectories')
  })
})

describe('the worker refuses on its own account', () => {
  it('never allocates for a register past the ceiling', () => {
    // The second half of the double check (`job.ts` does the same for the qubit
    // ceiling): this is the side that would do the allocating, and it must
    // never be talked into it by a request built somewhere new.
    const circuit = wide(OVER)
    const spec: NoiseSpec = {
      profile: {
        id: 'teaching',
        t1Ns: 20_000,
        t2Ns: 15_000,
        oneQubitGateNs: 50,
        twoQubitGateNs: 400,
        oneQubitGateError: 0.01,
        twoQubitGateError: 0.05,
        readoutP0to1: 0.03,
        readoutP1to0: 0.05,
      },
      readout: true,
      method: 'density',
      shots: 1000,
      seed: 1,
    }

    const payload = runNoiseJob(circuit, stateOf(circuit), spec)
    expect(payload.ok).toBe(false)
    if (payload.ok) return
    expect(payload.refusal.code).toBe('density-too-large')
  })

  it.each(['en', 'es', 'fr'] as const)(
    'reaches the reader as a translated sentence in %s',
    (language) => {
      /*
       * A register the panel is happy to ask about, answered with a refusal it
       * did not predict — which is the shape a stale client, or an engine whose
       * budget was tightened after this tab loaded, would really produce. The
       * numbers in the payload are the ones the sentence has to interpolate,
       * not the ones this circuit would have implied.
       */
      mount(wide(3), language, {
        ok: false,
        refusal: {
          code: 'density-too-large',
          qubits: OVER,
          limit: MAX_DENSITY_CLIENT_QUBITS,
          detail: 'english prose for a console, never for a reader',
        },
      })

      const expected = SIMULATION[language].errors['density-too-large']
        .replace('{{qubits}}', String(OVER))
        .replace('{{limit}}', String(MAX_DENSITY_CLIENT_QUBITS))
      const shown = document.querySelector('.simulation-panel__noise-refusal')
      expect(spaces(shown?.textContent ?? ''), language).toBe(spaces(expected))
      // The engine's own English never reaches a reader.
      expect(document.body.textContent).not.toContain('english prose')
    }
  )

  it('costs the reader nothing but the noisy half', () => {
    /*
     * The point of carrying a refusal instead of throwing one. A thirteen-qubit
     * circuit has a perfectly good ideal answer, and taking the histogram, the
     * amplitude table and the Q-sphere away in order to report a ceiling on one
     * panel would be the "frozen tab" failure wearing the opposite mask.
     */
    const { view } = mount(wide(3), 'en', {
      ok: false,
      refusal: {
        code: 'density-too-large',
        qubits: OVER,
        limit: MAX_DENSITY_CLIENT_QUBITS,
        detail: 'refused',
      },
    })

    expect(view.container.querySelector('.histogram__plot')).not.toBeNull()
    expect(view.container.querySelector('.amplitudes')).not.toBeNull()
    expect(view.container.querySelector('.qsphere')).not.toBeNull()
    expect(view.container.querySelector('.bloch')).not.toBeNull()
    // And the panel is not in an error state: the simulation itself succeeded.
    expect(screen.getByText(SIMULATION.en.panel.state.ready)).toBeTruthy()
  })
})
