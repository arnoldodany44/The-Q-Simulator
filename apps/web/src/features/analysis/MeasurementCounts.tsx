/**
 * What a circuit that measures actually answers — M0.9.
 *
 * A circuit with a mid-circuit measurement has no single final state (§5.3):
 * every run collapses somewhere else, so the answer is a tally over many runs
 * rather than a vector. Until this component existed the editor had nothing to
 * show for one — the panel asked for an analytic run, the engine refused it,
 * and the reader got an error where the answer should have been. That made the
 * teleportation preset unshippable, which is what brought this forward into
 * M0.9.
 *
 * ── It is a table, and that is not a shortcut ────────────────────────────
 *
 * The analytic panel draws bars because the quantity it shows is continuous
 * and the phase rides along with it as colour and direction. A shot tally has
 * neither: a count is an integer and a register reading has no phase. So the
 * columns *are* the information, and a bar is added beside them as a second,
 * redundant encoding of the same share — never the only carrier (§10), and
 * `aria-hidden` because the number is right next to it.
 *
 * ── The share is a measurement, and the text says so ─────────────────────
 *
 * Nothing here is exact. The summary names the number of runs so a reader can
 * tell a 49/51 split that means "even" from one that means "not quite even",
 * which is the same distinction the shots control teaches on the analytic
 * side.
 */

import { useId, useMemo } from 'react'
import { useTranslation } from 'react-i18next'

import type { ShotCounts } from '@qsim/core'

import { Notation } from '../../components/Notation'
import { tallyCounts } from './counts'
import { formatCount, formatProbability, pluralCount } from './format'
import { DEFAULT_BAR_LIMIT } from './histogram'

export interface MeasurementCountsProps {
  readonly counts: ShotCounts
  /** How many readings are listed one by one. Same cap as the histogram. */
  readonly rowLimit?: number
}

export function MeasurementCounts({
  counts,
  rowLimit = DEFAULT_BAR_LIMIT,
}: MeasurementCountsProps) {
  const { t, i18n } = useTranslation('analysis')
  const language = i18n.language
  const headingId = useId()
  const tally = useMemo(() => tallyCounts(counts, rowLimit), [counts, rowLimit])

  return (
    <section className="measurement-counts" aria-labelledby={headingId}>
      <h4 id={headingId} className="measurement-counts__heading">
        {t('counts.heading')}
      </h4>
      <p className="measurement-counts__intro">
        {t('counts.intro', {
          count: pluralCount(tally.readings),
          shots: formatCount(tally.shots, language),
          readings: formatCount(tally.readings, language),
        })}
      </p>

      {tally.rows.length === 0 ? (
        <p className="measurement-counts__empty">{t('counts.empty')}</p>
      ) : (
        <div className="measurement-counts__viewport">
          <table className="measurement-counts__grid">
            <caption className="visually-hidden">
              {t('counts.table.caption')}
            </caption>
            <thead>
              <tr>
                <th scope="col">{t('counts.table.reading')}</th>
                <th scope="col">{t('counts.table.runs')}</th>
                <th scope="col">{t('counts.table.share')}</th>
              </tr>
            </thead>
            <tbody>
              {tally.rows.map((row) => (
                <tr key={row.label}>
                  <th scope="row" className="measurement-counts__reading">
                    {/*
                     * A classical register reading is notation, not prose: it
                     * is the same bitstring Qiskit prints, and it means the
                     * same thing in all three languages (D2).
                     */}
                    <Notation value={row.label ?? ''} />
                  </th>
                  <Figures
                    count={row.count}
                    share={row.share}
                    language={language}
                  />
                </tr>
              ))}

              {tally.remainder === null ? null : (
                <tr className="measurement-counts__row--remainder">
                  <th scope="row">
                    {t('counts.table.remainder', {
                      count: pluralCount(tally.hiddenReadings),
                      hidden: formatCount(tally.hiddenReadings, language),
                    })}
                  </th>
                  <Figures
                    count={tally.remainder.count}
                    share={tally.remainder.share}
                    language={language}
                  />
                </tr>
              )}
            </tbody>
          </table>
        </div>
      )}
    </section>
  )
}

function Figures({
  count,
  share,
  language,
}: {
  readonly count: number
  readonly share: number
  readonly language: string
}) {
  return (
    <>
      <td className="measurement-counts__number">
        {formatCount(count, language)}
      </td>
      <td className="measurement-counts__number">
        {formatProbability(share, language)}
        {/*
         * The redundant encoding: the same share as a length. Hidden from the
         * accessibility tree because the number it repeats is in the same
         * cell, and a screen reader has no use for "a bar, 30% wide".
         */}
        <span
          className="measurement-counts__bar"
          aria-hidden="true"
          style={{ inlineSize: `${(share * 100).toFixed(2)}%` }}
        />
      </td>
    </>
  )
}
