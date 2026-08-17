/**
 * `/challenges` — the ladder (§3.6, Phase 3).
 *
 * Anonymous by design, like the gallery and the lessons: §2 makes the learning
 * surfaces the product's reason to exist, so a puzzle behind a sign-up is a
 * puzzle nobody sees. What signing in adds is the solved marks and the ability
 * to submit, both of which are properties of an account rather than of the
 * ladder.
 *
 * The list is rendered in the order the server sent it and never re-sorted. It
 * is a curriculum: one wire before two, a state before an operation, an
 * operation before a truth table. Sorting it by difficulty, by title or by
 * what the reader has finished would be sorting a sequence.
 *
 * ── Unlike the lessons index, this page needs the API ─────────────────────
 *
 * A lesson is a file in this bundle. A challenge is a row — its target, its
 * gate budget and its threshold live on the server, which is the whole of risk
 * 5 — so a deployment with no API origin has nothing to list, and this page
 * says so rather than showing an empty ladder that looks like a bug.
 */

import { useTranslation } from 'react-i18next'
import { Link } from 'react-router'

import { LanguagePicker } from '../components/LanguagePicker'
import { AccountMenu } from '../features/auth'
import {
  challengeKey,
  challengePagePath,
  renderable,
} from '../features/challenges'
import { ChallengeProse } from '../features/challenges'
import { useApiErrorMessage, useChallenges } from '../lib/api'

export function ChallengesRoute() {
  const { t } = useTranslation(['challenges', 'common'])
  const describeError = useApiErrorMessage()
  const query = useChallenges()

  const items = renderable(query.data?.items ?? [])
  const solved = new Set(query.data?.solved ?? [])

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

      <h2 className="section-heading">{t('challenges:index.heading')}</h2>
      <p>{t('challenges:index.intro')}</p>

      {query.isPending ? (
        <p className="page__loading">{t('challenges:index.loading')}</p>
      ) : query.isError ? (
        <p className="page__error" role="alert">
          {describeError(query.error)}
        </p>
      ) : items.length === 0 ? (
        <p className="page__empty">{t('challenges:index.empty')}</p>
      ) : (
        <ol className="challenge-index">
          {items.map((challenge) => (
            <li className="challenge-card" key={challenge.slug}>
              <h3 className="challenge-card__title">
                <Link to={challengePagePath(challenge.slug)}>
                  {t(challengeKey(challenge.slug, 'title'))}
                </Link>
              </h3>
              {/*
               * The prompt is the summary. A challenge has one piece of prose
               * and repeating it in shorter form would be a second thing to
               * translate and a second thing to keep true.
               */}
              <ChallengeProse
                className="challenge-card__prompt"
                paragraph={t(challengeKey(challenge.slug, 'prompt'))}
              />
              <p className="challenge-card__meta">
                {/*
                 * Difficulty as a number and a word, never as stars alone:
                 * §10 forbids colour — and, by the same argument, shape — being
                 * the only carrier of meaning.
                 */}
                {t('challenges:index.difficulty', {
                  level: challenge.difficulty,
                })}
                {' · '}
                {t('challenges:index.qubits', {
                  qubits: challenge.qubitCount,
                })}
              </p>
              <p className="challenge-card__state">
                {solved.has(challenge.slug)
                  ? t('challenges:index.solved')
                  : t('challenges:index.unsolved')}
              </p>
              <p>
                <Link
                  className="page__cta"
                  to={challengePagePath(challenge.slug)}
                >
                  {solved.has(challenge.slug)
                    ? t('challenges:index.improve')
                    : t('challenges:index.start')}
                </Link>
              </p>
            </li>
          ))}
        </ol>
      )}

      <p className="challenge-index__note">{t('challenges:index.order')}</p>
    </main>
  )
}
