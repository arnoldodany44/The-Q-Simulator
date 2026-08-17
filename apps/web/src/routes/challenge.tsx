/**
 * `/challenges/:slug` — one challenge (§3.6, Phase 3).
 *
 * Anonymous like the index, and for the same reason. Submitting needs a
 * session — `ChallengeSubmission.userId` is a foreign key, so an attempt that
 * belongs to nobody could not be ranked or shown back to its author — and the
 * player says so with a link rather than the page turning anyone away at the
 * door.
 *
 * The page is a thin shell: it resolves the slug, reports the three states a
 * fetch has, and hands the challenge to the player. Everything that decides
 * anything is either in the player or on the server.
 */

import { useTranslation } from 'react-i18next'
import { Link, useParams } from 'react-router'

import { LanguagePicker } from '../components/LanguagePicker'
import { AccountMenu, useSession } from '../features/auth'
import {
  CHALLENGES_PATH,
  ChallengeLeaderboard,
  ChallengePlayer,
  challengeKey,
} from '../features/challenges'
import {
  isNotFound,
  useApiErrorMessage,
  useChallenge,
  useLeaderboard,
} from '../lib/api'

export function ChallengeRoute() {
  const { t } = useTranslation(['challenges', 'common'])
  const { slug = '' } = useParams<{ slug: string }>()
  const describeError = useApiErrorMessage()
  const session = useSession()

  const query = useChallenge(slug, slug !== '')
  const board = useLeaderboard(slug, undefined, slug !== '')

  const view = query.data ?? null

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

      <p className="page__breadcrumb">
        <Link to={CHALLENGES_PATH}>{t('challenges:player.backToIndex')}</Link>
      </p>

      {query.isPending ? (
        <p className="page__loading">{t('challenges:index.loading')}</p>
      ) : view === null ? (
        <>
          <h2 className="section-heading">
            {isNotFound(query.error)
              ? t('challenges:player.notFound')
              : t('challenges:player.unavailable')}
          </h2>
          <p role="alert">
            {isNotFound(query.error)
              ? t('challenges:player.notFoundHint')
              : describeError(query.error)}
          </p>
          <p>
            <Link className="page__cta" to={CHALLENGES_PATH}>
              {t('challenges:player.backToIndex')}
            </Link>
          </p>
        </>
      ) : (
        <>
          <h2 className="section-heading">
            {t(challengeKey(view.challenge.slug, 'title'))}
          </h2>

          {/*
           * The reader's own best, above the puzzle rather than below it: it is
           * the number they are trying to beat, and a leaderboard row of their
           * own is what makes the ranking mean something personal.
           */}
          <p className="challenge-page__best">
            {view.best === null
              ? t('challenges:player.bestNone')
              : t('challenges:player.best', {
                  gates: view.best.gateCount,
                  depth: view.best.depth,
                })}
          </p>

          <ChallengePlayer challenge={view.challenge} />

          {/*
           * The reader's own rank travels with the board and not with the
           * challenge, because a rank changes when *other people* submit while
           * `best` above changes only when this reader does — so the two have
           * to be invalidated by different events, and they are.
           */}
          <ChallengeLeaderboard
            entries={board.data?.entries ?? []}
            standing={board.data?.standing ?? null}
            signedIn={session.status === 'authenticated'}
            loading={board.isPending}
          />
        </>
      )}
    </main>
  )
}
