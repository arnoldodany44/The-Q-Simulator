/**
 * `/lessons/:slug` — one lesson, played (§3.6, Phase 3).
 *
 * The route is thin on purpose, exactly like `/new`: it is a page frame around
 * `LessonPlayer`, which owns the position, the store and the objective. What
 * lives here is the two things a *page* owns — the address that names which
 * lesson, and the bookmark, which belongs to the reader rather than to any one
 * lesson.
 *
 * The page is wide, for the reason the editor page is: the lesson is prose
 * beside a circuit, and a circuit is a wide thing.
 *
 * ── A slug nobody holds is a sentence, not a 404 screen ───────────────────
 *
 * The catalog is in this bundle, so "no such lesson" is known immediately and
 * with certainty — there is no request that could still succeed. It renders as
 * a line and a way back to the index, which is what a stale bookmark or a
 * renamed lesson deserves.
 */

import { useTranslation } from 'react-i18next'
import { Link, useParams } from 'react-router'

import { LanguagePicker } from '../components/LanguagePicker'
import { Notation } from '../components/Notation'
import { AccountMenu } from '../features/auth'
import {
  LESSONS_PATH,
  LessonPlayer,
  lessonBySlug,
  lessonKey,
  progressFor,
  useLessonProgress,
} from '../features/lessons'

export function LessonRoute() {
  const { t } = useTranslation(['lessons', 'common'])
  const { slug } = useParams<{ slug: string }>()
  const lesson = lessonBySlug(slug)
  const { progress, ready, record } = useLessonProgress()

  return (
    <main className="page page--wide">
      <header className="page__header">
        <h1>
          <Link to="/">{t('common:appName')}</Link>
        </h1>
        <div className="page__header-tools">
          <AccountMenu />
          <LanguagePicker />
        </div>
      </header>

      <p className="lesson-page__back">
        <Link to={LESSONS_PATH}>{t('lessons:player.backToIndex')}</Link>
      </p>

      {lesson === null ? (
        <div className="notice" role="alert">
          <p>{t('lessons:player.notFound')}</p>
          <p>
            <Link className="page__cta" to={LESSONS_PATH}>
              {t('lessons:player.notFoundAction')}
            </Link>
          </p>
        </div>
      ) : (
        <>
          <h2 className="section-heading">
            {lesson.properName === null ? (
              t(lessonKey(lesson.slug, 'title'))
            ) : (
              <Notation value={lesson.properName} />
            )}
          </h2>
          {ready ? (
            <LessonPlayer
              /*
               * Keyed by slug so that walking from one lesson to the next
               * builds a fresh player — and therefore a fresh circuit store
               * and a fresh position — rather than carrying step 5 of the last
               * lesson into a lesson that has four.
               */
              key={lesson.slug}
              lesson={lesson}
              initialStep={progressFor(progress, lesson.slug).stepIndex}
              onStep={(stepIndex, completed) => {
                record(lesson.slug, stepIndex, completed)
              }}
            />
          ) : (
            /*
             * Not a blank frame and not a player at step one. The player reads
             * its position once, at mount, so mounting it before the account's
             * bookmark has arrived would put a resuming reader back at the
             * beginning of a lesson they were halfway through.
             */
            <p className="page__loading" role="status">
              {t('lessons:player.loading')}
            </p>
          )}
        </>
      )}
    </main>
  )
}
