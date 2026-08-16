/**
 * Independent verification — does the noise panel print what the engine
 * computed?
 *
 * §3.3 is the milestone where a silent wrong answer is most likely, and not
 * because the arithmetic is hard: it is because **nobody has an intuition for
 * what a noisy distribution should look like**. A depolarising channel with the
 * wrong coefficient still returns a normalised probability distribution that
 * looks entirely plausible, and there is no shape on screen that would give it
 * away. The engine's own adversarial suite is what holds the physics to §5.4;
 * what this file holds is the half the engine cannot see — the journey from a
 * `NoiseReading` on the worker to a number under a reader's eye.
 *
 * So every expectation here is derived from the payload `runNoiseJob` produced
 * and then read back out of the DOM the panel rendered. Nothing is compared
 * against a constant this file chose, and nothing is recomputed: if a component
 * ever starts doing arithmetic of its own, the two stop matching.
 *
 * Four claims, each of which a plausible bug would break:
 *
 *  1. The "with noise" column is the engine's distribution, entry for entry,
 *     joined to the right basis state. A join that read a ket back to front
 *     would be invisible on a symmetric state and wrong on every other.
 *  2. The difference column is the subtraction, with its sign.
 *  3. The ideal bar is untouched: the overlay adds a mark, it does not
 *     rewrite the chart underneath.
 *  4. Every gain and every loss balance, because probability is conserved —
 *     which is what makes "which outcomes gained and which lost" a complete
 *     account rather than half of one.
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
  encodeState,
  type NoiseReading,
  type SimulationRequest,
  type SimulationResponse,
} from '../../features/simulation/protocol'
import { SIMULATION_DEBOUNCE_MS } from '../../features/simulation/scheduler'
import type { SimulationWorkerLike } from '../../features/simulation/useSimulation'
import enAnalysis from '../../i18n/locales/en/analysis.json'
import enSimulation from '../../i18n/locales/en/simulation.json'

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

function i18nFor(): I18n {
  const instance = createInstance()
  void instance.use(initReactI18next).init({
    lng: 'en',
    fallbackLng: 'en',
    ns: ['analysis', 'simulation'],
    defaultNS: 'simulation',
    resources: { en: { analysis: enAnalysis, simulation: enSimulation } },
    interpolation: { escapeValue: false },
    react: { useSuspense: false },
  })
  return instance
}

function stateOf(circuit: Circuit): Statevector {
  const result = run(circuit)
  if (result.mode !== 'analytic') throw new Error('expected an analytic run')
  return result.state
}

/**
 * A circuit whose ideal distribution is asymmetric on purpose.
 *
 * A Bell pair would hide a mirrored join: |00⟩ and |11⟩ carry the same
 * probability, so reading the register back to front changes nothing. Here |01⟩
 * and |10⟩ carry different amounts and |11⟩ carries none, so a join that
 * reversed the ket would print visibly wrong numbers.
 */
function asymmetric(): Circuit {
  return parseCircuit({
    schemaVersion: 1,
    qubits: 3,
    operations: [
      { id: 'a', gate: 'h', targets: [0], column: 0 },
      { id: 'b', gate: 'ry', targets: [1], params: [0.7], column: 0 },
      { id: 'c', gate: 'cx', targets: [2], controls: [0], column: 1 },
      { id: 'd', gate: 't', targets: [0], column: 2 },
    ],
  })
}

/** The panel, with the noise mode switched on the way a reader switches it. */
function mountWithNoise(circuit: Circuit): {
  worker: FakeWorker
  view: ReturnType<typeof render>
  reading: NoiseReading
} {
  const worker = new FakeWorker()
  const view = render(
    <I18nextProvider i18n={i18nFor()}>
      <SimulationPanel circuit={circuit} createWorker={() => worker} />
    </I18nextProvider>
  )

  const respond = (): void => {
    act(() => {
      vi.advanceTimersByTime(SIMULATION_DEBOUNCE_MS)
    })
    const request = worker.simulations.at(-1)
    if (request === undefined || request.kind !== 'simulate') {
      throw new Error('nothing was requested')
    }
    if (request.mode !== 'analytic') throw new Error('expected analytic mode')
    const state = stateOf(circuit)
    const noise =
      request.noise === null ? null : runNoiseJob(circuit, state, request.noise)
    worker.reply({
      kind: 'result',
      id: request.id,
      mode: 'analytic',
      state: encodeState(state, false).payload,
      resumedFromColumn: 0,
      throughColumn: null,
      sampling: null,
      noise,
      durationMs: 1,
    })
  }

  respond()
  act(() => {
    fireEvent.click(
      screen.getByRole('checkbox', { name: enAnalysis.noise.enable })
    )
  })
  respond()

  const request = worker.simulations.at(-1)
  if (request === undefined || request.kind !== 'simulate') {
    throw new Error('nothing was requested')
  }
  if (request.mode !== 'analytic' || request.noise === null) {
    throw new Error('the panel asked for no noisy run')
  }
  const payload = runNoiseJob(circuit, stateOf(circuit), request.noise)
  if (!payload.ok) throw new Error('the engine refused the reference run')
  return { worker, view, reading: payload.reading }
}

/** A row of the comparison table, as the DOM holds it. */
interface Printed {
  readonly state: string
  readonly ideal: string
  readonly noisy: string
  readonly difference: string
}

/**
 * Scoped to the comparison, never to the page.
 *
 * There are two histograms on screen: the analytic one §3.2 draws at the top of
 * the panel, and the one §3.3 reuses with an overlay. They are the same
 * component, so the same class selects both — and reading the first would be
 * reading a table that has no noisy column at all, which is how this file spent
 * its first run asserting that a phase reading was a probability.
 */
function printedRows(view: ReturnType<typeof render>): Printed[] {
  const table = view.container.querySelector(
    '.noise-comparison .histogram__table'
  )
  if (table === null) throw new Error('the comparison table is not on screen')
  return [...table.querySelectorAll('tbody tr')].map((row) => {
    const cells = row.querySelectorAll('td')
    return {
      state: row.querySelector('th')?.textContent ?? '',
      ideal: cells[0]?.textContent ?? '',
      noisy: cells[1]?.textContent ?? '',
      difference: cells[2]?.textContent ?? '',
    }
  })
}

/** `12.34%` → 0.1234. The panel prints percentages; the engine holds shares. */
function share(text: string): number {
  const digits = text.replace(/[^\d.,+-]/gu, '').replace(/,/gu, '')
  return Number(digits) / 100
}

/** How far a printed percentage can be from the truth: half its last digit. */
const PRINTED = 5e-5

beforeEach(() => {
  vi.useFakeTimers()
})

afterEach(() => {
  cleanup()
  vi.useRealTimers()
})

describe('the noise panel prints the engine’s answer', () => {
  it('reads every "with noise" cell off the distribution the engine returned', () => {
    const { view, reading } = mountWithNoise(asymmetric())
    const rows = printedRows(view)
    expect(rows.length).toBeGreaterThan(1)

    const state = stateOf(asymmetric())
    for (const row of rows) {
      // The remainder row stands for several states at once and is checked
      // separately, below.
      const label = row.state.replace(/[|⟩]/gu, '')
      if (!/^[01]+$/u.test(label)) continue

      // The ket back to an index, little-endian per D1: |q2q1q0⟩ is printed
      // highest qubit first, so this is the reading order reversed.
      const index = Number.parseInt(label, 2)
      expect(index).toBeLessThan(state.size)

      const engineNoisy = reading.distribution?.[index] ?? 0
      const engineIdeal =
        (state.re[index] ?? 0) ** 2 + (state.im[index] ?? 0) ** 2

      expect(share(row.noisy), `noisy ${row.state}`).toBeCloseTo(engineNoisy, 4)
      expect(share(row.ideal), `ideal ${row.state}`).toBeCloseTo(engineIdeal, 4)
    }
  })

  it('prints the difference as the subtraction, with its sign', () => {
    const { view } = mountWithNoise(asymmetric())
    for (const row of printedRows(view)) {
      const delta = share(row.noisy) - share(row.ideal)
      expect(share(row.difference), row.state).toBeCloseTo(delta, 3)
      if (delta > PRINTED) expect(row.difference).toMatch(/^\+/u)
      if (delta < -PRINTED) expect(row.difference).toMatch(/^[-−]/u)
    }
  })

  it('leaves the ideal bar exactly where it was', () => {
    /*
     * The overlay adds a mark; it does not rewrite the chart underneath. A
     * bar's width is `probability × trackWidth` exactly (`ProbabilityHistogram`
     * says so), so this is the one assertion that would catch a comparison that
     * quietly started drawing the noisy value as the bar.
     */
    const { view } = mountWithNoise(asymmetric())
    const state = stateOf(asymmetric())
    const track = view.container.querySelector(
      '.noise-comparison .histogram__track'
    )
    const trackWidth = Number(track?.getAttribute('width'))

    const chartRows = [
      ...view.container.querySelectorAll('.noise-comparison .histogram__row'),
    ]
    for (const row of chartRows) {
      if (row.classList.contains('histogram__row--remainder')) continue
      const label = (
        row.querySelector('.histogram__label')?.textContent ?? ''
      ).replace(/[|⟩]/gu, '')
      const index = Number.parseInt(label, 2)
      const probability =
        (state.re[index] ?? 0) ** 2 + (state.im[index] ?? 0) ** 2
      const fill = Number(
        row.querySelector('.histogram__fill')?.getAttribute('width')
      )
      expect(fill).toBeCloseTo(probability * trackWidth, 6)
    }
  })

  it('accounts for every unit of probability that moved', () => {
    /*
     * Probability is conserved, so the gains and the losses on screen have to
     * cancel — including the remainder row, which is where an outcome the noise
     * *created* lands. If they did not, the panel would be showing a
     * distribution leaking into somewhere it never names, and "which outcomes
     * gained and which lost" would be half an account.
     */
    const { view } = mountWithNoise(asymmetric())
    const total = printedRows(view).reduce(
      (sum, row) => sum + (share(row.noisy) - share(row.ideal)),
      0
    )
    expect(total).toBeCloseTo(0, 3)
  })

  it('says which method produced the numbers', () => {
    // A fidelity to four digits means something different after an exact
    // evaluation than after ten thousand sampled shots, so the panel never
    // leaves it to be assumed.
    mountWithNoise(asymmetric())
    expect(
      screen.getByText(enAnalysis.noise.comparison.ranDensity)
    ).toBeTruthy()
  })
})
