/**
 * The panel that makes §4's split legible, in all three languages.
 *
 * What is asserted is not the layout — it is the three questions a reader in
 * front of a queued run actually has, and that each is answered with words
 * rather than with a spinner: where did this go, how long will it take, and can
 * I stop. Plus the two things the copy must never do: invent an estimate it was
 * not given, and imply that stopping cancels the run.
 */

import type { SimulationRun } from '@qsim/contract'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { createInstance, type i18n as I18n } from 'i18next'
import { I18nextProvider, initReactI18next } from 'react-i18next'
import { afterEach, describe, expect, it, vi } from 'vitest'

import enSimulation from '../../i18n/locales/en/simulation.json'
import esSimulation from '../../i18n/locales/es/simulation.json'
import frSimulation from '../../i18n/locales/fr/simulation.json'
import { ServerRunPanel } from './ServerRunPanel'
import type { ServerRunView } from './protocol'

type Language = 'en' | 'es' | 'fr'

const CATALOGS: Record<Language, typeof enSimulation> = {
  en: enSimulation,
  es: esSimulation,
  fr: frSimulation,
}

function i18nFor(language: Language): I18n {
  const instance = createInstance()
  void instance.use(initReactI18next).init({
    lng: language,
    fallbackLng: 'en',
    ns: ['simulation'],
    defaultNS: 'simulation',
    resources: {
      [language]: { simulation: CATALOGS[language] },
      en: { simulation: CATALOGS.en },
    },
    interpolation: { escapeValue: false },
    react: { useSuspense: false },
  })
  return instance
}

function view(overrides: Partial<ServerRunView> = {}): ServerRunView {
  return {
    stage: 'queued',
    runId: 'run_abc',
    phase: null,
    completed: null,
    total: null,
    estimatedDurationMs: null,
    submittedAt: 1_000_000,
    live: true,
    ...overrides,
  }
}

function finished(overrides: Partial<SimulationRun> = {}): SimulationRun {
  return {
    id: 'run_abc',
    status: 'DONE',
    mode: 'STATEVECTOR',
    shots: null,
    circuitId: null,
    createdAt: new Date(0),
    durationMs: 8_100,
    estimatedDurationMs: null,
    result: {
      resultVersion: 1,
      mode: 'STATEVECTOR',
      qubits: 22,
      shots: null,
      seed: 42,
      noiseProfileId: null,
      outcomes: [
        { state: '0'.repeat(22), probability: 0.5, count: null },
        { state: '1'.repeat(22), probability: 0.25, count: null },
      ],
      hiddenOutcomes: 3,
      hiddenWeight: 0.25,
      purity: null,
      durationMs: 8_100,
    },
    error: null,
    progress: null,
    ...overrides,
  }
}

function show(
  props: Partial<Parameters<typeof ServerRunPanel>[0]> = {},
  language: Language = 'en'
) {
  const onCancel = vi.fn()
  render(
    <I18nextProvider i18n={i18nFor(language)}>
      <ServerRunPanel
        serverRun={view()}
        qubits={22}
        clientLimit={20}
        onCancel={onCancel}
        now={() => 1_009_000}
        {...props}
      />
    </I18nextProvider>
  )
  return { onCancel }
}

afterEach(cleanup)

describe('what it says', () => {
  it('renders nothing when no run went to the server', () => {
    const { container } = render(
      <I18nextProvider i18n={i18nFor('en')}>
        <ServerRunPanel
          serverRun={null}
          qubits={4}
          clientLimit={20}
          onCancel={() => undefined}
        />
      </I18nextProvider>
    )
    // The overwhelmingly common case, and it must cost the panel nothing.
    expect(container.innerHTML).toBe('')
  })

  it('names the register and the ceiling it crossed', () => {
    // A label saying "server" would be a label. The interesting fact is the
    // threshold, because that is what a reader can act on.
    show()
    expect(screen.getByText(/22 qubits/)).toBeTruthy()
    expect(screen.getByText(/up to 20/)).toBeTruthy()
  })

  it('keeps explaining the ceiling when the submission failed outright', () => {
    /*
     * The path this used to get wrong. A `POST` that never produced a run
     * leaves nothing in flight and nothing finished, and the only thing left on
     * screen was the transport failure — with no answer at all to "why was a
     * server involved in a circuit I was just editing locally".
     */
    render(
      <I18nextProvider i18n={i18nFor('en')}>
        <ServerRunPanel
          serverRun={null}
          run={null}
          qubits={21}
          clientLimit={20}
          onCancel={() => undefined}
        />
      </I18nextProvider>
    )
    expect(screen.getByText(/21 qubits/)).toBeTruthy()
    expect(screen.getByText(/up to 20/)).toBeTruthy()
    // And nothing about a run, because there is not one.
    expect(screen.queryByRole('button')).toBeNull()
  })

  it('says it is waiting in the queue, then that it is running', () => {
    show()
    expect(screen.getByRole('status').textContent).toMatch(/queue/i)
    cleanup()
    show({ serverRun: view({ stage: 'running', phase: 'simulating' }) })
    expect(screen.getByRole('status').textContent).toMatch(/evolving the state/)
  })

  it('shows elapsed time, and the estimate only when it was given one', () => {
    show()
    // Nine seconds between `submittedAt` and the injected clock.
    expect(screen.getByText('9 s')).toBeTruthy()
    expect(screen.queryByText('Estimated run time')).toBeNull()

    cleanup()
    show({ serverRun: view({ estimatedDurationMs: 11_000 }) })
    expect(screen.getByText('Estimated run time')).toBeTruthy()
    expect(screen.getByText('11 s')).toBeTruthy()
  })

  it('shows a fraction only for a phase that actually divides', () => {
    // Two of the three modes have no honest subdivision, and a bar fed a
    // fabricated number teaches the reader that this app's bars lie.
    show({ serverRun: view({ stage: 'running', phase: 'simulating' }) })
    expect(screen.queryByText('Progress')).toBeNull()

    cleanup()
    show({
      serverRun: view({
        stage: 'running',
        phase: 'sampling',
        completed: 512,
        total: 1_024,
      }),
    })
    expect(screen.getByText('512 of 1,024')).toBeTruthy()
  })

  it('says the feed dropped rather than going quiet', () => {
    show({ serverRun: view({ live: false }) })
    expect(screen.getByText(/reconnecting/i)).toBeTruthy()
  })

  it('says nothing about reconnecting before a run id exists', () => {
    // There is nothing to be connected *to* during the POST, and saying
    // "reconnecting" would describe a state that does not exist.
    show({ serverRun: view({ stage: 'submitting', runId: null, live: false }) })
    expect(screen.queryByText(/reconnecting/i)).toBeNull()
  })
})

describe('stopping', () => {
  it('offers a control that says what it really does', () => {
    const { onCancel } = show()
    const button = screen.getByRole('button', { name: 'Stop waiting' })
    fireEvent.click(button)
    expect(onCancel).toHaveBeenCalledTimes(1)
    // §8 gives /simulate no delete, so the note has to be honest about it.
    // (The confirmation says the same thing, hence "all".)
    expect(
      screen.getAllByText(/keeps going on the server/).length
    ).toBeGreaterThan(0)
  })

  it('offers nothing to stop once the run has finished', () => {
    show({ serverRun: null, run: finished() })
    expect(screen.queryByRole('button')).toBeNull()
  })

  it('keeps the identifier it promised the run would keep', () => {
    /*
     * The note says "the run keeps going on the server and keeps its
     * identifier". That was true of the system and false of the interface: the
     * id, the counter, the button and the note all left the screen in the same
     * frame, and there is no run history and no listing to find it in again.
     */
    const { onCancel } = show()
    expect(screen.getByText('run_abc')).toBeTruthy()

    fireEvent.click(screen.getByRole('button', { name: 'Stop waiting' }))
    expect(onCancel).toHaveBeenCalledTimes(1)
    // The facts list goes when the scheduler clears the run in flight; the id
    // has to still be readable somewhere after it does.
    expect(screen.getAllByText(/run_abc/).length).toBeGreaterThan(0)
  })

  it('announces the stop, and lands focus somewhere that still exists', () => {
    /*
     * The status line was inside the branch the button lives in, so pressing
     * the button removed the live region — and removing a live region announces
     * nothing. A screen-reader user got silence and a keyboard user got
     * `document.body`.
     */
    show()
    const button = screen.getByRole('button', { name: 'Stop waiting' })
    button.focus()
    fireEvent.click(button)

    const spoken = screen
      .getAllByRole('status')
      .map((node) => node.textContent ?? '')
      .join(' ')
    expect(spoken).toMatch(/stopped waiting/i)
    expect(spoken).toMatch(/run_abc/)
    expect(document.activeElement).toBe(
      screen.getByRole('heading', { name: 'Run on the server' })
    )
  })
})

describe('the answer', () => {
  it('lists the bounded reading, and says what was left out', () => {
    // A truncated list presented as complete would teach the reader that the
    // remaining probability is zero, which at this register size is exactly
    // the wrong lesson.
    show({ serverRun: null, run: finished() })
    expect(screen.getByText('50%')).toBeTruthy()
    expect(screen.getByText(/3 further basis states/)).toBeTruthy()
    expect(screen.getByText(/25% of the probability/)).toBeTruthy()
  })

  it('translates a failure code rather than printing it', () => {
    show({
      serverRun: null,
      run: finished({ status: 'FAILED', result: null, error: 'TIMED_OUT' }),
    })
    const status = screen.getByRole('status')
    expect(status.textContent).toMatch(/time limit/)
    expect(status.textContent).not.toContain('TIMED_OUT')
  })

  it('falls back rather than rendering a code it has never heard of', () => {
    // An API deployed ahead of this bundle can fail a run for a reason this
    // catalog has no sentence for. An identifier on screen is worse than a
    // general sentence.
    show({
      serverRun: null,
      run: finished({
        status: 'FAILED',
        result: null,
        error: 'FROM_THE_FUTURE',
      }),
    })
    const status = screen.getByRole('status')
    expect(status.textContent).not.toContain('FROM_THE_FUTURE')
    expect(status.textContent?.length ?? 0).toBeGreaterThan(0)
  })
})

describe('D2', () => {
  for (const language of ['en', 'es', 'fr'] as const) {
    it(`renders words rather than keys in ${language}`, () => {
      show({ serverRun: view({ estimatedDurationMs: 3_000 }) }, language)
      const text = document.body.textContent ?? ''
      expect(text.length).toBeGreaterThan(0)
      // The shape `e2e/no-raw-keys.spec.ts` looks for, asserted here too
      // because this surface only exists once a run has crossed the ceiling
      // and a walk of the loaded DOM would never see it.
      expect(text).not.toMatch(/server\.[a-z]+/)
    })
  }
})
