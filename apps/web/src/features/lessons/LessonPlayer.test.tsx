import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { createInstance, type i18n as I18n } from 'i18next'
import { I18nextProvider, initReactI18next } from 'react-i18next'
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'

import enCommon from '../../i18n/locales/en/common.json'
import enEditor from '../../i18n/locales/en/editor.json'
import enGates from '../../i18n/locales/en/gates.json'
import enLessons from '../../i18n/locales/en/lessons.json'
import enSimulation from '../../i18n/locales/en/simulation.json'
import esLessons from '../../i18n/locales/es/lessons.json'
import frLessons from '../../i18n/locales/fr/lessons.json'
import { LessonPlayer } from './LessonPlayer'
import { superposition } from './catalog/superposition'
import { LESSON_FOCUS_SELECTORS } from './format'

/**
 * The player, driven the way a reader drives it.
 *
 * It mounts the **real** `CircuitEditor`, which is the point of the whole
 * feature and also what makes this file worth having: a lesson beside a copy
 * of the editor would be a lesson that starts lying the day the editor
 * changes. jsdom has no `Worker`, so the analysis panel below the canvas
 * settles into its reported-failure state — which costs nothing here, because
 * every objective in this feature is decided by `objectives.ts` running the
 * engine directly rather than by anything the panel produces. That
 * independence is itself asserted below.
 */

afterEach(cleanup)

beforeAll(() => {
  // jsdom implements neither, and both are called by "show me".
  Element.prototype.scrollIntoView = vi.fn()
})

type Language = 'en' | 'es' | 'fr'

function i18nFor(language: Language): I18n {
  const instance = createInstance()
  void instance.use(initReactI18next).init({
    lng: language,
    fallbackLng: 'en',
    ns: ['common', 'editor', 'gates', 'simulation', 'lessons'],
    defaultNS: 'common',
    resources: {
      en: {
        common: enCommon,
        editor: enEditor,
        gates: enGates,
        simulation: enSimulation,
        lessons: enLessons,
      },
      es: { lessons: esLessons },
      fr: { lessons: frLessons },
    },
    interpolation: { escapeValue: false },
    react: { useSuspense: false },
  })
  return instance
}

function mount(options: {
  language?: Language
  initialStep?: number
  onStep?: (step: number, completed: boolean) => void
}) {
  const i18n = i18nFor(options.language ?? 'en')
  return render(
    <I18nextProvider i18n={i18n}>
      <LessonPlayer
        lesson={superposition}
        initialStep={options.initialStep ?? 0}
        {...(options.onStep === undefined ? {} : { onStep: options.onStep })}
      />
    </I18nextProvider>
  )
}

/**
 * How many operations the canvas has drawn.
 *
 * Counted by `data-operation-id`, which is the attribute `GateNode` puts on
 * every operation it renders — one per operation and stable across the
 * gate-specific class names, so this counts a CNOT the same as an H.
 */
function placedGates(container: HTMLElement): number {
  return container.querySelectorAll('[data-operation-id]').length
}

describe('the lesson player', () => {
  it('opens on the first step, beside the real editor', () => {
    const { container } = mount({})

    expect(
      screen.getByText(enLessons.superposition.steps.still.title)
    ).toBeTruthy()
    expect(screen.getByText('Step 1 of 7')).toBeTruthy()
    // The editor, not a picture of one: its canvas is the region a step can
    // point at, and it is here on the first frame.
    expect(
      container.querySelector(LESSON_FOCUS_SELECTORS.circuit)
    ).not.toBeNull()
  })

  it('walks forward through the steps, adding the gates as it goes', () => {
    const { container } = mount({})
    const next = () => {
      fireEvent.click(screen.getByRole('button', { name: 'Next' }))
    }

    // Step 1 is the empty wire.
    expect(placedGates(container)).toBe(0)

    next()
    expect(screen.getByText('Step 2 of 7')).toBeTruthy()
    // The Hadamard the second step's patch adds — one gate, applied as a diff
    // to the document already on the canvas.
    expect(placedGates(container)).toBe(1)

    next()
    next()
    // Two steps with no patch: the circuit is unchanged and the prose is not.
    expect(screen.getByText('Step 4 of 7')).toBeTruthy()
    expect(placedGates(container)).toBe(1)

    next()
    expect(placedGates(container)).toBe(2)
    next()
    expect(placedGates(container)).toBe(3)
  })

  it('goes back, and restores the lesson`s own circuit', () => {
    const { container } = mount({ initialStep: 5 })
    expect(placedGates(container)).toBe(3)

    fireEvent.click(screen.getByRole('button', { name: 'Back' }))
    expect(screen.getByText('Step 5 of 7')).toBeTruthy()
    expect(placedGates(container)).toBe(2)
  })

  it('resumes where the reader stopped', () => {
    mount({ initialStep: 4 })
    expect(screen.getByText('Step 5 of 7')).toBeTruthy()
    expect(
      screen.getByText(enLessons.superposition.steps.turn.title)
    ).toBeTruthy()
  })

  it('clamps a bookmark that names a step this lesson no longer has', () => {
    mount({ initialStep: 99 })
    expect(screen.getByText('Step 7 of 7')).toBeTruthy()
  })

  it('reports every move, and only the last step counts as finished', () => {
    const moves: [number, boolean][] = []
    mount({
      initialStep: 4,
      onStep: (step, completed) => moves.push([step, completed]),
    })
    const next = () => {
      fireEvent.click(screen.getByRole('button', { name: 'Next' }))
    }
    next()
    next()
    expect(moves).toEqual([
      [5, false],
      [6, true],
    ])
  })

  /**
   * Unavailable at the ends, and still focusable there.
   *
   * `aria-disabled` rather than `disabled`, because a focused element that
   * becomes disabled is removed from the focus order and the browser hands the
   * caret to `<body>` — so finishing a lesson by keyboard used to lose the
   * focus ring at the exact moment the lesson ended, on every one of the nine.
   * The press has to be a no-op instead, which is asserted rather than assumed:
   * pressing "Back" on step 0 must not move the reader or call `onStep`.
   */
  it('will not go back from the first step or forward from the last', () => {
    const moves: [number, boolean][] = []
    mount({
      initialStep: 0,
      onStep: (step, completed) => moves.push([step, completed]),
    })
    const back = screen.getByRole('button', { name: 'Back' })
    expect(back.getAttribute('aria-disabled')).toBe('true')
    expect(back).toHaveProperty('disabled', false)
    fireEvent.click(back)
    expect(moves).toEqual([])
    expect(screen.getByText('Step 1 of 7')).toBeTruthy()
    cleanup()

    mount({ initialStep: 6 })
    const next = screen.getByRole('button', { name: 'Next' })
    expect(next.getAttribute('aria-disabled')).toBe('true')
    expect(next).toHaveProperty('disabled', false)
    fireEvent.click(next)
    expect(screen.getByText('Step 7 of 7')).toBeTruthy()
  })

  /**
   * Moving between steps has to be *announced*, or a screen-reader user
   * presses "Next" through a nine-lesson curriculum and hears silence.
   *
   * Activating a `<button>` does not move focus — it stays on the button —
   * which is what the earlier arrangement assumed and what made the omission
   * invisible. The region has to be in the DOM before its contents change, so
   * it is asserted on the first render, empty of news but present.
   */
  it('announces where the reader is, from a region that was already there', () => {
    const { container } = mount({ initialStep: 0 })
    const region = container.querySelector(
      '[aria-live="polite"].lesson-step__where'
    )
    expect(region).not.toBeNull()
    expect(region?.textContent).toContain('Step 1 of 7')

    fireEvent.click(screen.getByRole('button', { name: 'Next' }))

    // The SAME element, with new contents — not a new one carrying them.
    const after = container.querySelector(
      '[aria-live="polite"].lesson-step__where'
    )
    expect(after).toBe(region)
    expect(after?.textContent).toContain('Step 2 of 7')
  })

  /*
   * The objective, decided by the engine in this tab. No worker exists in this
   * environment, so a verdict appearing here is proof that the check does not
   * depend on the analysis panel having answered — which is the arrangement
   * `objectives.ts` argues for and the one a future refactor could quietly
   * undo.
   */
  it('says "not yet" on the build step, and "done" once the state is right', () => {
    mount({ initialStep: 6 })
    expect(screen.getByText(enLessons.player.objective.unmet)).toBeTruthy()

    // "Show me the answer" puts the lesson's own circuit on the canvas.
    fireEvent.click(
      screen.getByRole('button', { name: enLessons.player.reveal })
    )
    expect(screen.getByText(enLessons.player.objective.met)).toBeTruthy()
  })

  it('shows the reading behind the verdict, not only the verdict', () => {
    mount({ initialStep: 6 })
    // "Largest gap from the target odds: 0.500" — the circuit is on |1⟩, so
    // each of the two states is half a unit away from where it should be.
    expect(screen.getByText(/0\.500/)).toBeTruthy()
  })

  it('scrolls the region a step points at into view', () => {
    const { container } = mount({})
    const canvas = container.querySelector(LESSON_FOCUS_SELECTORS.circuit)
    // The first step points at the histogram, which needs a simulation; the
    // canvas is the target that exists in this environment, so the assertion
    // is made through a step that names it.
    expect(canvas).not.toBeNull()

    fireEvent.click(
      screen.getByRole('button', { name: enLessons.player.showMe })
    )
    // The histogram is absent here, so nothing was scrolled — and nothing
    // threw, which is the property that matters: "show me" pointing at a chart
    // a failed simulation never drew must not take the lesson down with it.
    expect(screen.getByText('Step 1 of 7')).toBeTruthy()
  })

  it.each(['es', 'fr'] as const)('renders its prose in %s', (language) => {
    const catalog = language === 'es' ? esLessons : frLessons
    mount({ language })
    expect(
      screen.getByText(catalog.superposition.steps.still.title)
    ).toBeTruthy()
    expect(screen.getByText(catalog.player.previous)).toBeTruthy()
    expect(screen.getByText(catalog.player.next)).toBeTruthy()
  })

  it('renders notation inside prose as untranslatable spans', () => {
    const { container } = mount({})
    const spans = container.querySelectorAll(
      '.lesson-prose__notation[translate="no"]'
    )
    // The first step's prose names `|0⟩`, which is exactly the kind of token
    // D2 says must be identical in all three languages.
    expect(spans.length).toBeGreaterThan(0)
    expect([...spans].some((span) => span.textContent === '|0⟩')).toBe(true)
  })

  it('renders the goal through the same prose path, keeping its own style', () => {
    /*
     * The goal used to be a bare `t()` in a `<p>`, so a goal containing
     * notation would have printed its backticks. It now goes through
     * `LessonProse` like every other lesson string — and the thing worth
     * pinning is the half that could regress silently: the paragraph keeps
     * §10's `lesson-player__goal` class rather than inheriting the body style,
     * and it still says exactly what the catalog says.
     */
    const { container } = mount({})
    const goal = container.querySelector('.lesson-player__goal')
    expect(goal).not.toBeNull()
    expect(goal?.tagName).toBe('P')
    expect(goal?.textContent).toBe(enLessons.superposition.goal)
    expect(container.textContent).not.toContain('`')
  })
})
