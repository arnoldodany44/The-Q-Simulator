/**
 * `/lessons` — the index (§3.6, Phase 3).
 *
 * Anonymous by design, like the gallery: the lessons are the answer to §2's
 * job for this product, so putting them behind a session would put the
 * explanation behind the sign-up. Progress comes from `localStorage` for a
 * reader with no account and from the account for one with, and the card looks
 * the same either way — see `features/lessons/progress.ts` for why the local
 * store is not a degraded version of the remote one.
 *
 * The list is walked in catalog order rather than sorted. It is a curriculum:
 * superposition draws the picture entanglement is contrasted with, and
 * interference is the idea a probability histogram alone cannot show. Sorting
 * it by anything — title, progress, most recently read — would be sorting a
 * sequence.
 */

import { useTranslation } from 'react-i18next'
import { Link } from 'react-router'

import { LanguagePicker } from '../components/LanguagePicker'
import { AccountMenu } from '../features/auth'
import { Notation } from '../components/Notation'
import {
  LESSONS,
  LessonProse,
  lessonKey,
  lessonPath,
  progressFor,
  useLessonProgress,
} from '../features/lessons'

export function LessonsRoute() {
  const { t } = useTranslation(['lessons', 'common'])
  const { progress } = useLessonProgress()

  return (
    <main className="page">
      <header className="page__header">
        <h1>
          <Link to="/">{t('common:appName')}</Link>
        </h1>
        <div className="page__header-tools">
          <AccountMenu />
          <LanguagePicker />
        </div>
      </header>

      <h2 className="section-heading">{t('lessons:index.heading')}</h2>
      <p>{t('lessons:index.intro')}</p>

      <ol className="lesson-index">
        {LESSONS.map((lesson) => {
          const entry = progressFor(progress, lesson.slug)
          const started = entry.stepIndex > 0 || entry.completed
          return (
            <li className="lesson-card" key={lesson.slug}>
              <h3 className="lesson-card__title">
                <Link to={lessonPath(lesson.slug)}>
                  {/*
                   * A proper noun renders through `Notation` and is identical
                   * in all three languages (D2); an ordinary word comes from
                   * the catalog. Exactly the rule the presets follow.
                   */}
                  {lesson.properName === null ? (
                    t(lessonKey(lesson.slug, 'title'))
                  ) : (
                    <Notation value={lesson.properName} />
                  )}
                </Link>
              </h3>
              {/*
               * Through `LessonProse` and not a bare `t()`: a summary is a
               * lesson string like any other, and the phase estimation card
               * has notation in it. See `LessonProse.tsx`.
               */}
              <LessonProse
                className="lesson-card__summary"
                paragraph={t(lessonKey(lesson.slug, 'summary'))}
              />
              <p className="lesson-card__progress">
                {entry.completed
                  ? t('lessons:index.completed')
                  : started
                    ? t('lessons:index.atStep', {
                        step: entry.stepIndex + 1,
                        total: lesson.steps.length,
                      })
                    : t('lessons:index.steps', { total: lesson.steps.length })}
              </p>
              <p>
                <Link className="page__cta" to={lessonPath(lesson.slug)}>
                  {started
                    ? t('lessons:index.resume')
                    : t('lessons:index.start')}
                </Link>
              </p>
            </li>
          )
        })}
      </ol>

      {/*
       * All nine of §3.6's lessons are written, so the sentence that used to
       * say how many were missing has become the sentence that says what the
       * order is for. It sits below the list rather than above it because a
       * reader who has just seen nine cards is the one who needs telling that
       * the ninth assumes the first — and a reader who already knows that has
       * lost nothing by meeting it on the way out.
       */}
      <p className="lesson-index__note">{t('lessons:index.order')}</p>
    </main>
  )
}
