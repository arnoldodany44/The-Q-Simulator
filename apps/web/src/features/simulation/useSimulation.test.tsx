import { alloc } from '@qsim/core'
import { parseCircuit, type Circuit } from '@qsim/schema'
import { act, cleanup, renderHook } from '@testing-library/react'
import { createInstance, type i18n as I18n } from 'i18next'
import type { ReactNode } from 'react'
import { I18nextProvider, initReactI18next } from 'react-i18next'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import enSimulation from '../../i18n/locales/en/simulation.json'
import frSimulation from '../../i18n/locales/fr/simulation.json'
import {
  encodeState,
  type SimulationRequest,
  type SimulationResponse,
} from './protocol'
import { SIMULATION_DEBOUNCE_MS } from './scheduler'
import { useSimulation, type SimulationWorkerLike } from './useSimulation'

/**
 * The hook, driven by a worker that is not one.
 *
 * jsdom has no `Worker`, and a real one would make these tests asynchronous
 * and flaky for no gain: what is being checked here is the wiring — that the
 * hook subscribes, translates and cleans up — not the simulation, which
 * `job.test.ts` runs against the real engine.
 */

class FakeWorker implements SimulationWorkerLike {
  readonly sent: SimulationRequest[] = []
  terminated = false
  onmessage: ((event: MessageEvent<SimulationResponse>) => void) | null = null
  onerror: ((event: ErrorEvent) => void) | null = null
  onmessageerror: ((event: MessageEvent) => void) | null = null

  postMessage(message: SimulationRequest): void {
    this.sent.push(message)
  }

  terminate(): void {
    this.terminated = true
  }

  reply(response: SimulationResponse): void {
    this.onmessage?.(new MessageEvent('message', { data: response }))
  }

  get simulations(): SimulationRequest[] {
    return this.sent.filter((message) => message.kind === 'simulate')
  }
}

function i18nFor(language: 'en' | 'fr'): I18n {
  const instance = createInstance()
  void instance.use(initReactI18next).init({
    lng: language,
    fallbackLng: 'en',
    ns: ['simulation'],
    defaultNS: 'simulation',
    resources: {
      en: { simulation: enSimulation },
      fr: { simulation: frSimulation },
    },
    interpolation: { escapeValue: false },
    react: { useSuspense: false },
  })
  return instance
}

function withGates(columns: readonly number[]): Circuit {
  return parseCircuit({
    schemaVersion: 1,
    qubits: 2,
    operations: columns.map((column) => ({
      id: `g${column}`,
      gate: 'h',
      targets: [0],
      column,
    })),
  })
}

function resultFor(id: number): SimulationResponse {
  const { payload } = encodeState(alloc(2), false)
  return {
    kind: 'result',
    id,
    mode: 'analytic',
    state: payload,
    resumedFromColumn: 0,
    durationMs: 2,
  }
}

/** Renders the hook against a worker the test drives by hand. */
function mount(circuit: Circuit, language: 'en' | 'fr' = 'en') {
  const worker = new FakeWorker()
  const createWorker = () => worker
  const instance = i18nFor(language)
  const view = renderHook(
    (props: { circuit: Circuit }) =>
      useSimulation(props.circuit, { createWorker }),
    {
      initialProps: { circuit },
      wrapper: ({ children }: { children: ReactNode }) => (
        <I18nextProvider i18n={instance}>{children}</I18nextProvider>
      ),
    }
  )
  return { worker, view }
}

function tick(): void {
  act(() => {
    vi.advanceTimersByTime(SIMULATION_DEBOUNCE_MS)
  })
}

beforeEach(() => {
  vi.useFakeTimers()
})

afterEach(() => {
  cleanup()
  vi.useRealTimers()
})

describe('the live simulation', () => {
  it('simulates the circuit once the edits stop', () => {
    const { worker, view } = mount(withGates([0]))

    expect(view.result.current.status).toBe('scheduled')
    tick()
    expect(worker.simulations).toHaveLength(1)
    expect(view.result.current.status).toBe('running')

    act(() => {
      worker.reply(resultFor(worker.simulations[0]!.id))
    })

    expect(view.result.current.status).toBe('ready')
    expect(view.result.current.outcome?.mode).toBe('analytic')
    expect(view.result.current.durationMs).toBe(2)
    expect(view.result.current.error).toBeNull()
  })

  it('turns ten rapid edits into one simulation', () => {
    const { worker, view } = mount(withGates([0]))
    tick()
    act(() => {
      worker.reply(resultFor(worker.simulations[0]!.id))
    })
    worker.sent.length = 0

    for (let index = 1; index <= 10; index++) {
      const columns = Array.from({ length: index + 1 }, (_, n) => n)
      view.rerender({ circuit: withGates(columns) })
      act(() => {
        vi.advanceTimersByTime(10)
      })
    }
    tick()

    expect(worker.simulations).toHaveLength(1)
  })

  it('ignores an answer to a question the user has already changed', () => {
    const { worker, view } = mount(withGates([0]))
    tick()
    const current = worker.simulations[0]!.id

    act(() => {
      worker.reply(resultFor(current + 99))
    })

    expect(view.result.current.outcome).toBeNull()
    expect(view.result.current.status).toBe('running')
  })

  it('stops scheduling when it is disabled', () => {
    const worker = new FakeWorker()
    const createWorker = () => worker
    renderHook(() =>
      useSimulation(withGates([0]), { enabled: false, createWorker })
    )

    act(() => {
      vi.advanceTimersByTime(SIMULATION_DEBOUNCE_MS)
    })

    expect(worker.sent).toHaveLength(0)
  })
})

describe('failures the user can read', () => {
  it('refuses a circuit too large for the browser, in French', () => {
    const huge = parseCircuit({ schemaVersion: 1, qubits: 21, operations: [] })
    const { worker, view } = mount(huge, 'fr')
    tick()

    expect(worker.sent).toHaveLength(0)
    expect(view.result.current.error?.code).toBe('too-many-qubits')
    expect(view.result.current.error?.message).toBe(
      frSimulation.errors['too-many-qubits']
        .replace('{{qubits}}', '21')
        .replace('{{limit}}', '20')
    )
  })

  it('renders an engine failure in the active language', () => {
    const { worker, view } = mount(withGates([0]))
    tick()

    act(() => {
      worker.reply({
        kind: 'error',
        id: worker.simulations[0]!.id,
        failure: {
          code: 'unsupported-operation',
          operationId: 'op_7',
          detail: 'engine prose, not for the UI',
        },
      })
    })

    expect(view.result.current.status).toBe('error')
    expect(view.result.current.error?.message).toBe(
      enSimulation.errors['unsupported-operation']
    )
    // The canvas needs the id to highlight the offending gate.
    expect(view.result.current.error?.operationId).toBe('op_7')
  })

  /*
   * The one reply that reaches neither `onmessage` nor `onerror`. Without a
   * handler for it the request stays in flight forever and the editor keeps
   * saying `running` — the same wedge the worker's own drain catch prevents
   * from the other side.
   */
  it('rescues a reply that could not be deserialised', () => {
    const { worker, view } = mount(withGates([0]))
    tick()
    expect(view.result.current.status).toBe('running')

    act(() => {
      worker.onmessageerror?.(new MessageEvent('messageerror'))
    })

    expect(view.result.current.status).toBe('error')
    expect(view.result.current.error?.code).toBe('worker-failed')
  })

  it('survives a browser that cannot start a worker at all', () => {
    const { result } = renderHook(
      () =>
        useSimulation(withGates([0]), {
          createWorker: () => {
            throw new Error('Worker is not defined')
          },
        }),
      {
        wrapper: ({ children }: { children: ReactNode }) => (
          <I18nextProvider i18n={i18nFor('en')}>{children}</I18nextProvider>
        ),
      }
    )

    expect(result.current.error?.code).toBe('worker-unavailable')
    expect(result.current.error?.message).toBe(
      enSimulation.errors['worker-unavailable']
    )
  })
})

describe('the worker lifetime', () => {
  it('terminates the worker when the editor goes away', () => {
    const { worker, view } = mount(withGates([0]))
    tick()

    view.unmount()

    expect(worker.terminated).toBe(true)
    expect(worker.onmessage).toBeNull()
  })

  it('cancels the pending debounce on unmount', () => {
    const { worker, view } = mount(withGates([0]))

    view.unmount()
    act(() => {
      vi.advanceTimersByTime(SIMULATION_DEBOUNCE_MS * 4)
    })

    expect(worker.sent).toHaveLength(0)
  })
})
