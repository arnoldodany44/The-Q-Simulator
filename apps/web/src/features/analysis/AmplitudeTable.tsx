/**
 * The amplitude table — specification §3.2: `|state⟩ → a + bi`, magnitude,
 * probability, and the phase in radians and in degrees.
 *
 * This is the panel's exact reading. The histogram above it is a picture and
 * the phasors are an animation; this is the place a reader comes to when the
 * question is "what *is* the amplitude", and every answer here is a number
 * rather than a length or an angle.
 *
 * ── Why it is a real table ───────────────────────────────────────────────
 *
 * Not a grid of divs with ARIA bolted on. Six columns of numbers about one
 * basis state each is what `<table>` means, and a browser gives it row and
 * column navigation, header association and `aria-sort` for free — none of
 * which is free the other way round. The SVG chart above needs a described
 * table because a drawing has no text; this needs no drawing because it is
 * already the text.
 *
 * ── The monospace column, and what actually aligns it ────────────────────
 *
 * §10 chose IBM Plex Mono for these columns. A monospace font is necessary
 * and not sufficient: `1` above `0,7071` still puts two decimal separators in
 * different places. What aligns the column is fixed fraction digits, which is
 * why `formatAmplitude` and `formatMagnitude` pad to four rather than
 * trimming to four (`format.ts`). The closing `⟩` of a ket comes from a
 * fallback font at an unknown width (§10), so the ket column is left-aligned
 * and the numeric ones are right-aligned; nothing depends on that bracket
 * measuring one advance.
 *
 * ── Locale, and why it is not a detail ───────────────────────────────────
 *
 * Every figure goes through `Intl.NumberFormat` bound to the active language
 * (D2, §1.1). French writes `0,7071`; a hardcoded decimal point would turn an
 * amplitude into something that reads as a thousands separator for a third of
 * this app's users. The `a + bi` connector is the locale's own minus sign for
 * the same reason.
 *
 * ── Sorting ──────────────────────────────────────────────────────────────
 *
 * Basis-state order by default, probability order on request (§3.2). The two
 * sortable headers are buttons inside their `<th>`, and the `<th>` carries
 * `aria-sort` — the pairing assistive technology is built to read. Sorting
 * re-orders rows the model already produced; it never re-reads the state.
 */

import type { Statevector } from '@qsim/core'
import { useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'

import { Notation } from '../../components/Notation'
import {
  buildAmplitudes,
  sortAmplitudes,
  type AmplitudeOrder,
  type AmplitudeRow,
} from './amplitudes'
import {
  formatAmplitude,
  formatCount,
  formatDegrees,
  formatMagnitude,
  formatProbability,
  formatRadians,
  pluralCount,
} from './format'
import { DEFAULT_BAR_LIMIT, ket } from './histogram'

export interface AmplitudeTableProps {
  /** The final state of an analytic run. */
  readonly state: Statevector
  /** How many basis states are listed one by one. Same cap as the chart. */
  readonly rowLimit?: number
}

export function AmplitudeTable({
  state,
  rowLimit = DEFAULT_BAR_LIMIT,
}: AmplitudeTableProps) {
  const { t, i18n } = useTranslation('analysis')
  const language = i18n.language
  const [order, setOrder] = useState<AmplitudeOrder>('state')

  const model = useMemo(
    () => buildAmplitudes(state, rowLimit),
    [state, rowLimit]
  )
  const rows = useMemo(
    () => sortAmplitudes(model.rows, order),
    [model.rows, order]
  )
  const remainder = model.hidden > 0

  const caption = remainder
    ? t('amplitudes.caption.capped', {
        count: pluralCount(model.hidden),
        shown: formatCount(model.rows.length, language),
        occupied: formatCount(model.occupied, language),
        total: formatCount(model.size, language),
        hidden: formatCount(model.hidden, language),
        share: formatProbability(model.hiddenProbability, language),
      })
    : t('amplitudes.caption.complete', {
        count: pluralCount(model.occupied),
        occupied: formatCount(model.occupied, language),
        total: formatCount(model.size, language),
      })

  if (model.rows.length === 0) {
    return <p className="amplitudes__empty">{t('amplitudes.empty')}</p>
  }

  return (
    <figure className="amplitudes">
      <figcaption className="amplitudes__caption">
        <span className="amplitudes__title">{t('amplitudes.heading')}</span>
        <span className="amplitudes__disclosure">{caption}</span>
      </figcaption>

      {/*
       * The scroller, not the table, is what reflows. Six columns of data at
       * 320 CSS px cannot shrink to fit without becoming unreadable, and WCAG
       * 1.4.10 asks that the *page* not scroll horizontally — a table inside
       * its own scroller satisfies both.
       */}
      <div className="amplitudes__viewport">
        <table className="amplitudes__grid">
          <caption className="visually-hidden">
            {t('amplitudes.table.caption')}
          </caption>
          <thead>
            <tr>
              <th
                scope="col"
                aria-sort={order === 'state' ? 'ascending' : 'none'}
              >
                <SortButton
                  label={t('amplitudes.columns.state')}
                  active={order === 'state'}
                  onSort={() => {
                    setOrder('state')
                  }}
                />
              </th>
              <th scope="col">{t('amplitudes.columns.amplitude')}</th>
              <th scope="col">{t('amplitudes.columns.magnitude')}</th>
              <th
                scope="col"
                aria-sort={order === 'probability' ? 'descending' : 'none'}
              >
                <SortButton
                  label={t('amplitudes.columns.probability')}
                  active={order === 'probability'}
                  onSort={() => {
                    setOrder('probability')
                  }}
                />
              </th>
              <th scope="col">{t('amplitudes.columns.radians')}</th>
              <th scope="col">{t('amplitudes.columns.degrees')}</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <AmplitudeRowCells
                key={row.index}
                row={row}
                language={language}
              />
            ))}

            {remainder ? (
              <tr className="amplitudes__row amplitudes__row--remainder">
                <th scope="row">
                  {t('amplitudes.table.remainder', {
                    count: pluralCount(model.hidden),
                    hidden: formatCount(model.hidden, language),
                  })}
                </th>
                {/*
                 * Aggregated states have no amplitude and no phase — adding
                 * complex numbers that interfere is not what a remainder row
                 * means, and averaging angles is not a thing. The probability
                 * is the one figure that does add up, so it is the one figure
                 * printed.
                 */}
                <td colSpan={2}>{t('amplitudes.table.noAmplitude')}</td>
                <td className="amplitudes__number">
                  {formatProbability(model.hiddenProbability, language)}
                </td>
                <td colSpan={2}>{t('amplitudes.table.mixedPhase')}</td>
              </tr>
            ) : null}
          </tbody>
        </table>
      </div>
    </figure>
  )
}

function AmplitudeRowCells({
  row,
  language,
}: {
  readonly row: AmplitudeRow
  readonly language: string
}) {
  return (
    <tr className="amplitudes__row">
      <th scope="row" className="amplitudes__state">
        <Notation value={ket(row.label)} />
      </th>
      <td className="amplitudes__number">
        <Notation value={formatAmplitude(row.re, row.im, language)} />
      </td>
      <td className="amplitudes__number">
        {formatMagnitude(row.magnitude, language)}
      </td>
      <td className="amplitudes__number">
        {formatProbability(row.probability, language)}
      </td>
      <td className="amplitudes__number">
        {formatRadians(row.phase, language)}
      </td>
      <td className="amplitudes__number">
        {formatDegrees(row.phase, language)}
      </td>
    </tr>
  )
}

/**
 * The control in a sortable header.
 *
 * `aria-sort` lives on the `<th>` above rather than here: it describes the
 * column, and a button is not a column. The button's own state is carried by
 * a class, because the thing that changed is which column the table is
 * ordered by — `aria-pressed` would announce a toggle that can be turned off,
 * and this one cannot.
 */
function SortButton({
  label,
  active,
  onSort,
}: {
  readonly label: string
  readonly active: boolean
  readonly onSort: () => void
}) {
  return (
    <button
      type="button"
      className={
        active
          ? 'amplitudes__sort amplitudes__sort--active'
          : 'amplitudes__sort'
      }
      onClick={onSort}
    >
      {label}
    </button>
  )
}
