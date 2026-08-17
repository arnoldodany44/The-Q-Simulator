/**
 * The reading column of the player: what this step says, what to notice, and
 * where the reader is in the sequence.
 *
 * Separate from `LessonPlayer` because it is the half with no circuit in it.
 * Everything here is text and buttons; everything there is the document, the
 * store and the engine. That split is what lets this component be rendered in
 * three languages in a test without a worker anywhere near it.
 *
 * ── Two live regions, and what each one is for ────────────────────────────
 *
 * **The objective's verdict.** It is the one thing on this column that changes
 * *without the reader having moved anything here* — they are editing a circuit
 * in the other column and this sentence answers it — so it is news.
 *
 * **Where the reader is, and what the step is called.** This one was missing,
 * and its absence made the feature unusable rather than merely quiet: pressing
 * "Next" replaces the position line, the heading and every paragraph while
 * focus stays exactly where it was. Activating a `<button>` does not move
 * focus — the earlier note here claimed it did — so a screen-reader user
 * pressing Next through a nine-lesson curriculum heard nothing at all and had
 * no way to know the step had changed. Wrapping the position and the heading
 * (and nothing else: the body would be a paragraph read over the button) makes
 * the move audible as "Step 2 of 7, <title>", which is exactly what a sighted
 * reader sees change.
 *
 * Both paragraphs are always in the DOM, empty when there is nothing to say,
 * for the reason the simulation panel gives: a live region that appears at the
 * same moment as its text is one some readers never hear.
 *
 * ── The navigation buttons are never `disabled` ───────────────────────────
 *
 * They were, at each end, and disabling the control a reader has just pressed
 * removes it from the focus order — the browser resets the active element to
 * `<body>`, so finishing a lesson by keyboard loses the caret at the exact
 * moment the lesson ends. `aria-disabled` says the same thing to assistive
 * technology, keeps the element focusable, and the handler simply does
 * nothing, which is what `goTo` already did for an out-of-range index.
 */

import { useMemo } from 'react'
import { useTranslation } from 'react-i18next'

import { LessonProse } from './LessonProse'
import { stepKey, type Lesson, type LessonStep } from './format'
import type { ObjectiveReading } from './objectives'

export interface LessonStepPaneProps {
  readonly lesson: Lesson
  readonly step: LessonStep
  readonly index: number
  readonly reading: ObjectiveReading | null
  /** Scrolls the panel this step points at into view and outlines it. */
  readonly onShowMe: () => void
  /** Puts the lesson's own answer on the canvas. Build steps only. */
  readonly onReveal: () => void
  readonly onPrevious: () => void
  readonly onNext: () => void
}

export function LessonStepPane({
  lesson,
  step,
  index,
  reading,
  onShowMe,
  onReveal,
  onPrevious,
  onNext,
}: LessonStepPaneProps) {
  const { t, i18n } = useTranslation('lessons')
  const total = lesson.steps.length
  const build = step.objective.kind === 'build'

  /*
   * Per-locale digits (D2/§1.1): French writes 0,998 where English writes
   * 0.998, and this figure sits beside an analysis panel that already formats
   * its own numbers that way. Three decimals because the default fidelity
   * floor is 0.999, and a reading rounded to "1.00" beside "not yet" would
   * look like a defect in the checker.
   */
  const numbers = useMemo(
    () =>
      new Intl.NumberFormat(i18n.language, {
        minimumFractionDigits: 3,
        maximumFractionDigits: 3,
      }),
    [i18n.language]
  )

  /*
   * `returnObjects` because a body is an array of paragraphs rather than one
   * string with blank lines in it — see `format.ts`, decision 5. The guard is
   * not defensive noise: a catalog that has not finished loading answers with
   * the key, and mapping over a string would render one letter per element.
   */
  const body = t(stepKey(lesson.slug, step.id, 'body'), {
    returnObjects: true,
  })
  const paragraphs = Array.isArray(body) ? (body as string[]) : []

  return (
    <div className="lesson-step">
      {/*
       * The region is this wrapper, present from the first render; only its
       * two children change. See the header for why announcing the move is
       * the difference between a usable lesson and a silent one.
       */}
      <div className="lesson-step__where" aria-live="polite">
        <p className="lesson-step__position">
          {t('player.stepOf', { step: index + 1, total })}
        </p>

        <h3 className="lesson-step__heading">
          {t(stepKey(lesson.slug, step.id, 'title'))}
        </h3>
      </div>

      {paragraphs.map((paragraph, position) => (
        <LessonProse key={position} paragraph={paragraph} />
      ))}

      {step.focus === undefined ? null : (
        <div className="lesson-step__notice">
          <LessonProse paragraph={t(stepKey(lesson.slug, step.id, 'notice'))} />
          <button className="lesson-button" type="button" onClick={onShowMe}>
            {t('player.showMe')}
          </button>
        </div>
      )}

      {build ? (
        <div className="lesson-step__task">
          <h4 className="lesson-step__task-heading">{t('player.yourTurn')}</h4>
          <LessonProse paragraph={t(stepKey(lesson.slug, step.id, 'task'))} />

          {/*
           * The verdict, and the number behind it. Both, because "not yet" on
           * its own is a locked door: the reading is what tells a reader
           * whether they are close, and it is the same number the panel beside
           * them is drawing.
           */}
          <p className="lesson-step__verdict" role="status">
            {reading === null ? '' : t(`player.objective.${reading.status}`)}
          </p>
          {reading === null || reading.value === null ? null : (
            <p className="lesson-step__reading">
              {t(`player.reading.${step.objective.check.kind}`, {
                value: numbers.format(reading.value),
              })}
            </p>
          )}

          <details className="lesson-step__hint">
            <summary>{t('player.hint')}</summary>
            <LessonProse paragraph={t(stepKey(lesson.slug, step.id, 'hint'))} />
          </details>

          <button className="lesson-button" type="button" onClick={onReveal}>
            {t('player.reveal')}
          </button>
        </div>
      ) : null}

      <nav className="lesson-step__nav" aria-label={t('player.navLabel')}>
        {/*
         * `aria-disabled` and not `disabled`, at both ends. See the header:
         * disabling the button the reader is standing on drops focus to
         * `<body>` at the exact moment the lesson ends. The press is a no-op
         * instead, which is what it already was — `goTo` clamps.
         */}
        <button
          className="lesson-button"
          type="button"
          onClick={onPrevious}
          aria-disabled={index === 0}
        >
          {t('player.previous')}
        </button>
        {/*
         * Never *unavailable* on any step, whatever the objective says. A
         * lesson that refuses to advance strands the reader whose equivalent
         * construction the checker does not recognise, and turns an
         * explanation into an exam — see `format.ts`, decision 4. The place
         * where passing matters is the challenge mode of §3.6, and there the
         * server decides.
         */}
        <button
          className="lesson-button lesson-button--primary"
          type="button"
          onClick={onNext}
          aria-disabled={index === total - 1}
        >
          {t('player.next')}
        </button>
      </nav>
    </div>
  )
}
