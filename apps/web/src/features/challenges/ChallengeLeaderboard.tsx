/**
 * §3.6's table of positions: fewest gates, then least depth.
 *
 * A table and not a list, because it is tabular: three comparable columns per
 * row, which a screen reader announces with their headers only if the markup
 * says so.
 *
 * ════════════════════════════════════════════════════════════════════════
 * WHAT IS DELIBERATELY ABSENT: THE WINNING CIRCUIT.
 *
 * Publishing it would publish the answer — the same leak the target is
 * protected from, arriving one attempt later and from the person who solved
 * the puzzle best. So a row is a name and two numbers, and there is nothing in
 * the response to render even if this component wanted to.
 *
 * ════════════════════════════════════════════════════════════════════════
 * WHY A RANK CAN SKIP A NUMBER, AND WHY IT IS PRINTED ANYWAY.
 *
 * The server ranks everybody who solved the challenge and then withholds the
 * readers who asked not to be listed, so `1, 2, 4` is a correct table with a
 * gap where somebody chose privacy. Renumbering here would be the wrong
 * repair twice over: it would let anyone gain a place by persuading the person
 * above them to hide, and it would make this table disagree with the standing
 * printed under it — which is the one number the reader actually came for.
 *
 * ════════════════════════════════════════════════════════════════════════
 * THE READER'S OWN LINE.
 *
 * A table of ten answers "who is winning" and never "how am I doing". The
 * standing arrives in the same response, computed from the same ranked set, so
 * the highlighted row and the sentence beneath cannot disagree; and it is
 * present whether the reader is first, ninetieth, or withheld from the listing
 * entirely. The row is matched by rank rather than by comparing names, because
 * rank is what the server just told us and a name comparison would need a
 * second request to know the reader's handle — and would find nothing at all
 * for a reader who has opted out, which is precisely when the line matters
 * most.
 *
 * `aria-current="true"` and not colour alone (§10): the highlighted row is
 * announced as the current one, and it also carries a visible marker in text.
 */

import { useTranslation } from 'react-i18next'
import type { LeaderboardEntry, LeaderboardStanding } from '@qsim/contract'

export interface ChallengeLeaderboardProps {
  readonly entries: readonly LeaderboardEntry[]
  readonly standing: LeaderboardStanding | null
  /**
   * Whether there is a reader to have a standing at all.
   *
   * A prop rather than a `useSession()` call inside, so this component stays a
   * function of its arguments and can be rendered in a test without a
   * provider. It matters because `standing === null` means two different
   * things: "you have not solved this yet" for a signed-in reader, and
   * "nobody is asking" for an anonymous one — and only the first is a sentence
   * worth printing.
   */
  readonly signedIn: boolean
  readonly loading: boolean
}

export function ChallengeLeaderboard({
  entries,
  standing,
  signedIn,
  loading,
}: ChallengeLeaderboardProps) {
  const { t } = useTranslation('challenges')

  return (
    <section className="challenge-board">
      <h3 className="challenge-board__heading">{t('board.heading')}</h3>
      {loading ? (
        <p className="challenge-board__empty">{t('board.loading')}</p>
      ) : entries.length === 0 && standing === null ? (
        <p className="challenge-board__empty">{t('board.empty')}</p>
      ) : (
        <>
          {entries.length === 0 ? (
            /*
             * Reachable and not a contradiction: the only solver so far has
             * asked not to be listed, and is reading their own page. Saying
             * "nobody has solved this" to the person who solved it would be a
             * lie, so the standing below does the talking.
             */
            <p className="challenge-board__empty">{t('board.noneListed')}</p>
          ) : (
            <table className="challenge-board__table">
              <caption className="challenge-board__caption">
                {t('board.caption')}
              </caption>
              <thead>
                <tr>
                  <th scope="col">{t('board.rank')}</th>
                  <th scope="col">{t('board.who')}</th>
                  <th scope="col">{t('board.gates')}</th>
                  <th scope="col">{t('board.depth')}</th>
                </tr>
              </thead>
              <tbody>
                {entries.map((entry) => {
                  const mine = standing !== null && standing.rank === entry.rank
                  return (
                    <tr
                      key={`${String(entry.rank)}-${entry.username}`}
                      className={
                        mine
                          ? 'challenge-board__row challenge-board__row--mine'
                          : 'challenge-board__row'
                      }
                      aria-current={mine ? 'true' : undefined}
                    >
                      <td>{entry.rank}</td>
                      {/*
                       * The display name when there is one, the handle
                       * otherwise — the same fallback every byline in this app
                       * uses. Neither is translated: they are somebody's name.
                       * The marker beside it is what carries "this is you"
                       * without depending on the row's background colour.
                       */}
                      <td>
                        {entry.displayName ?? entry.username}
                        {mine ? (
                          <span className="challenge-board__you">
                            {t('board.you')}
                          </span>
                        ) : null}
                      </td>
                      <td>{entry.gateCount}</td>
                      <td>{entry.depth}</td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          )}

          {standing === null ? (
            signedIn ? (
              <p className="challenge-board__standing">
                {t('board.youUnranked')}
              </p>
            ) : null
          ) : (
            <p className="challenge-board__standing">
              {t('board.yourStanding', {
                rank: standing.rank,
                gates: standing.gateCount,
                depth: standing.depth,
              })}
              {standing.listed ? null : (
                <>
                  {' '}
                  <span className="challenge-board__withheld">
                    {t('board.withheld')}
                  </span>
                </>
              )}
            </p>
          )}
        </>
      )}
    </section>
  )
}
