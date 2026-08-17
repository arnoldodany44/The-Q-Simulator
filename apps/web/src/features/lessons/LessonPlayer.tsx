/**
 * The lesson player — §3.6, Phase 3.
 *
 * Text in one column, the real editor and the real analysis panel in the
 * other. Not a copy of either: `CircuitEditor` is the component `/new` mounts,
 * with its palette, its keyboard grid, its scrubber and `SimulationPanel`
 * underneath it. A lesson that illustrated the product with a picture of the
 * product would teach the picture, and would start lying the day the product
 * changed.
 *
 * That is possible at all because the editor takes its store as a prop — a
 * decision M0.5 made for exactly this ("a future preview or diff view will
 * want two editors on one page"). The player builds its own store, so a
 * lesson never touches the document somebody has open in another tab and
 * nothing the reader does here reaches `/new`.
 *
 * ────────────────────────────────────────────────────────────────────────
 * ONE POSITION, THREE THINGS READ IT.
 *
 * `index` is the whole of the player's state. The text column renders it, the
 * store is loaded from it (`navigation.ts` decides with what), and the
 * bookmark is written from it. Everything else — the objective's verdict, the
 * "show me" target, whether "previous" is available — is derived, which is
 * what stops the screen from being able to disagree with itself.
 *
 * ────────────────────────────────────────────────────────────────────────
 * "SHOW ME" MOVES THE PAGE, NOT THE PROSE.
 *
 * A step names a region of the analysis panel (`format.ts`, decision 2) and
 * the sentence beside the button says what about it. The button scrolls that
 * region into view and outlines it for a moment. It reaches into the panel by
 * class name, which is a coupling worth seeing in one place —
 * `LESSON_FOCUS_SELECTORS` — and the query is scoped to this component's own
 * subtree so it can never find a chart on some other part of the page.
 *
 * The outline is a dashed border and not a colour change: §10 requires that
 * colour is never the only carrier of meaning, and "this is the thing I mean"
 * is meaning. Under `prefers-reduced-motion` the scroll is instant rather than
 * smooth — the destination is the point and the travel is decoration.
 */

import type { Circuit } from '@qsim/schema'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useStore } from 'zustand'

import { usePrefersReducedMotion } from '../../lib/usePrefersReducedMotion'
import { CircuitEditor } from '../circuit-editor/CircuitEditor'
import { createCircuitStore } from '../circuit-editor/useCircuitStore'
import { LessonProse } from './LessonProse'
import { LessonStepPane } from './LessonStepPane'
import {
  LESSON_FOCUS_SELECTORS,
  baseCircuitOf,
  lessonKey,
  type Lesson,
} from './format'
import { circuitForNavigation, solutionCircuit } from './navigation'
import { checkObjective, type ObjectiveReading } from './objectives'

/** How long the outline stays on the panel "show me" pointed at. */
const FOCUS_HIGHLIGHT_MS = 2400

export interface LessonPlayerProps {
  readonly lesson: Lesson
  /** Where this reader left off, clamped by the caller to a real step. */
  readonly initialStep?: number
  /**
   * Called whenever the reader moves. The player does not know or care
   * whether that reaches `localStorage`, an account, or neither — see
   * `useLessonProgress`.
   */
  readonly onStep?: (stepIndex: number, completed: boolean) => void
}

export function LessonPlayer({
  lesson,
  initialStep = 0,
  onStep,
}: LessonPlayerProps) {
  const { t } = useTranslation('lessons')
  const reducedMotion = usePrefersReducedMotion()
  const container = useRef<HTMLDivElement>(null)

  /*
   * One store per lesson, built once, starting on the lesson's own register.
   * Keyed on the lesson rather than on the step: a step is a change to this
   * document, not a different document, and rebuilding the store per step
   * would throw away the reader's undo history on every press of "next".
   */
  const store = useMemo(
    () => createCircuitStore(baseCircuitOf(lesson)),
    [lesson]
  )
  const circuit = useStore(store, (state) => state.circuit)

  const [index, setIndex] = useState(() => clamp(initialStep, lesson))
  const step = lesson.steps[index]

  /*
   * Called rather than held. `store.getState().loadCircuit` is a method on the
   * state object, and pulling it out as a value is the unbound-method mistake
   * — it happens to work here because the store's actions close over `set`,
   * and it stops working the day one of them reads `this`.
   */
  const load = useCallback(
    (next: Circuit) => {
      store.getState().loadCircuit(next)
    },
    [store]
  )

  /*
   * The opening document, put on the canvas once. In an effect rather than in
   * the store's initialiser because a reader resuming at step 4 has to arrive
   * at step 4's circuit rather than at an empty register that is corrected a
   * frame later.
   */
  const opened = useRef(false)
  useEffect(() => {
    if (opened.current) return
    opened.current = true
    load(circuitForNavigation(lesson, circuit, -1, index))
    // Deliberately once per mount: every later move goes through `goTo`.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const goTo = useCallback(
    (next: number) => {
      const target = clamp(next, lesson)
      if (target === index) return
      const from = index
      setIndex(target)
      load(circuitForNavigation(lesson, store.getState().circuit, from, target))
      onStep?.(target, target === lesson.steps.length - 1)
    },
    [index, lesson, load, onStep, store]
  )

  /**
   * The lesson's own answer for this step, on demand.
   *
   * Offered on every build step rather than hidden behind three wrong
   * attempts: a reader who is stuck is a reader who has stopped learning, and
   * the answer to a lesson exercise is not worth guarding. It is also the only
   * repair for a build step the checker cannot recognise.
   */
  const reveal = useCallback(() => {
    const solution = solutionCircuit(lesson, index)
    if (solution !== null) load(solution)
  }, [lesson, index, load])

  /*
   * The objective, recomputed whenever the reader's circuit changes.
   *
   * `null` on a read step, which is what makes the verdict line empty there
   * rather than reporting on a question nobody asked. The run itself is
   * synchronous and cheap — `objectives.ts` explains why that is safe, and
   * why it does not go near the worker the panel beside it is using.
   */
  const reading = useMemo<ObjectiveReading | null>(() => {
    if (step === undefined || step.objective.kind !== 'build') return null
    return checkObjective(
      step.objective.check,
      circuit,
      solutionCircuit(lesson, index)
    )
  }, [step, circuit, lesson, index])

  const showMe = useCallback(() => {
    const target = step?.focus
    const root = container.current
    if (target === undefined || root === null) return
    const element = root.querySelector(LESSON_FOCUS_SELECTORS[target])
    if (element === null) return

    element.scrollIntoView({
      behavior: reducedMotion ? 'auto' : 'smooth',
      block: 'center',
    })
    element.classList.add('lesson-focus')
    window.setTimeout(() => {
      element.classList.remove('lesson-focus')
    }, FOCUS_HIGHLIGHT_MS)
  }, [step, reducedMotion])

  if (step === undefined) return null

  return (
    <div className="lesson-player" ref={container}>
      <section
        className="lesson-player__reading"
        aria-label={t('player.readingLabel')}
      >
        {/* A goal is prose, so it goes through the one thing that renders
            prose — see `LessonProse.tsx` for why that is not obvious. */}
        <LessonProse
          className="lesson-player__goal"
          paragraph={t(lessonKey(lesson.slug, 'goal'))}
        />
        <LessonStepPane
          lesson={lesson}
          step={step}
          index={index}
          reading={reading}
          onShowMe={showMe}
          onReveal={reveal}
          onPrevious={() => {
            goTo(index - 1)
          }}
          onNext={() => {
            goTo(index + 1)
          }}
        />
      </section>

      <section className="lesson-player__lab" aria-label={t('player.labLabel')}>
        {/*
         * The real editor, over the player's own store. Everything below the
         * canvas — the histogram, the amplitude table, the Bloch spheres, the
         * scrubber — comes with it, which is the point: the analysis panel is
         * what does the explaining, and the prose only says where to look.
         */}
        <CircuitEditor store={store} />
      </section>
    </div>
  )
}

/** A step index that exists, for a bookmark written by an older catalog. */
function clamp(index: number, lesson: Lesson): number {
  if (!Number.isInteger(index) || index < 0) return 0
  return Math.min(index, lesson.steps.length - 1)
}
