/**
 * The density matrix as a heat map — §3.2's advanced mode.
 *
 * Two grids, the real part and the imaginary one, and a table of the entries
 * behind them. `densityMap.ts` argues the encoding; this file draws it.
 *
 * ────────────────────────────────────────────────────────────────────────
 * WHY ANYONE WOULD LOOK AT IT
 *
 * The diagonal of ρ is the histogram, already drawn twice over. The reason to
 * draw the matrix is the off-diagonal: ρ_ij is the coherence between two basis
 * states, it is what a superposition is *made of*, and it is the first thing
 * noise takes. A phase-damping channel leaves every bar of the histogram
 * exactly where it was and empties the corners of this map — a change that
 * literally nothing else in the panel can show.
 *
 * ────────────────────────────────────────────────────────────────────────
 * THE TABLE IS THE RENDERING
 *
 * A cell's colour and opacity are not a length anyone can compare by eye, so
 * this is the Bloch panel's position and takes the Bloch panel's decision: the
 * grids are `aria-hidden` and the numbers beside them are visible and carry the
 * meaning. It is a list of entries rather than a transcription of the grid, for
 * the reason `densityMap.ts` gives — a matrix at these sizes is overwhelmingly
 * zeros, and sixteen columns of `a + bi` is a table nobody can navigate.
 *
 * ────────────────────────────────────────────────────────────────────────
 * THE CAP IS VISIBLE, THE WAY THE HISTOGRAM'S IS
 *
 * ρ is 4ⁿ entries and the block drawn is at most 16 × 16. What that leaves out
 * is stated above the map — how many basis states and how much population —
 * because a picture that quietly showed a sixteenth of a matrix would be a lie
 * drawn in colour. The peak is printed too: the map is scaled to the block's
 * own largest entry, so the scale is never something a reader has to infer.
 */

import { useMemo } from 'react'
import { useTranslation } from 'react-i18next'

import { Notation } from '../../components/Notation'
import { phaseToColour } from '../../lib/phase-colour'
import type { DensityBlock } from '../simulation/protocol'
import { buildDensityMap, type DensityCell } from './densityMap'
import {
  formatAmplitude,
  formatCoordinate,
  formatCount,
  formatProbability,
  pluralCount,
} from './format'
import { ket } from './histogram'

/** Side of one cell, in SVG user units drawn 1:1 with CSS pixels. */
const CELL = 18

/** Room for the row and column labels around the grid. */
const GUTTER = 10

export interface DensityHeatmapProps {
  readonly block: DensityBlock
}

export function DensityHeatmap({ block }: DensityHeatmapProps) {
  const { t, i18n } = useTranslation('analysis')
  const language = i18n.language
  const map = useMemo(() => buildDensityMap(block), [block])
  const size = map.labels.length

  if (size === 0) {
    // A ρ whose every population is below the floor is not a state anyone
    // built; saying so beats drawing an empty square.
    return <p className="density__empty">{t('density.empty')}</p>
  }

  return (
    <figure className="density">
      <figcaption className="density__caption">
        <span className="density__title">{t('density.heading')}</span>
        <span className="density__disclosure">
          {map.hidden > 0
            ? t('density.caption.capped', {
                count: pluralCount(map.hidden),
                shown: formatCount(size, language),
                hidden: formatCount(map.hidden, language),
                share: formatProbability(map.hiddenPopulation, language),
              })
            : t('density.caption.complete', {
                count: pluralCount(size),
                shown: formatCount(size, language),
              })}
        </span>
      </figcaption>

      <p className="density__note">{t('density.note')}</p>
      <p className="density__scale">
        {t('density.scale', { peak: formatCoordinate(map.peak, language) })}
      </p>

      <div className="density__grids">
        <Grid
          cells={map.real}
          size={size}
          labels={map.labels}
          title={t('density.part.real')}
        />
        <Grid
          cells={map.imaginary}
          size={size}
          labels={map.labels}
          title={t('density.part.imaginary')}
        />
      </div>

      <div className="density__viewport">
        <table className="density__grid-table">
          <caption className="visually-hidden">
            {t('density.table.caption')}
          </caption>
          <thead>
            <tr>
              <th scope="col">{t('density.table.row')}</th>
              <th scope="col">{t('density.table.column')}</th>
              <th scope="col">{t('density.table.value')}</th>
              <th scope="col">{t('density.table.magnitude')}</th>
              <th scope="col">{t('density.table.kind')}</th>
            </tr>
          </thead>
          <tbody>
            {map.entries.map((entry) => (
              <tr className="density__row" key={`${entry.row}:${entry.column}`}>
                <th scope="row" className="density__state">
                  <Notation value={ket(entry.rowLabel)} />
                </th>
                <td className="density__state">
                  <Notation value={ket(entry.columnLabel)} />
                </td>
                <td className="density__number">
                  <Notation
                    value={formatAmplitude(entry.re, entry.im, language)}
                  />
                </td>
                <td className="density__number">
                  {formatCoordinate(entry.magnitude, language)}
                </td>
                <td className="density__kind">
                  {entry.diagonal
                    ? t('density.table.population')
                    : t('density.table.coherence')}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {map.negligible > 0 ? (
        <p className="density__note">
          {t('density.table.negligible', {
            count: pluralCount(map.negligible),
            negligible: formatCount(map.negligible, language),
          })}
        </p>
      ) : null}
    </figure>
  )
}

interface GridProps {
  readonly cells: readonly DensityCell[]
  readonly size: number
  readonly labels: readonly string[]
  readonly title: string
}

/**
 * One grid.
 *
 * `aria-hidden`, like every other drawing in this panel — the table below is
 * what a screen reader reads. The heading above it is *not* hidden, because a
 * reader who can see the two squares still has to be told which is which, and
 * "the real part" is a word rather than a picture.
 */
function Grid({ cells, size, labels, title }: GridProps) {
  const extent = GUTTER + size * CELL

  return (
    <div className="density__part">
      <p className="density__part-title">{title}</p>
      <svg
        className="density__plot"
        width={extent}
        height={extent}
        viewBox={`0 0 ${extent} ${extent}`}
        aria-hidden="true"
        focusable="false"
      >
        {cells.map((cell) => (
          <rect
            key={`${cell.row}:${cell.column}`}
            className="density__cell"
            x={GUTTER + cell.column * CELL}
            y={GUTTER + cell.row * CELL}
            width={CELL}
            height={CELL}
            /*
             * The colour is §10's phase mapping and nothing else: a positive
             * real part is phase 0, a negative one is phase π, and the two
             * imaginary signs are the quarter turns between. Opacity is the
             * magnitude, so an entry of zero is nothing on screen rather than a
             * pale block claiming a coherence the state does not have — and the
             * cell's outline, which does not fade, is what keeps the grid
             * legible as a grid.
             */
            fill={phaseToColour(cell.phase)}
            fillOpacity={cell.weight}
          />
        ))}

        {/* The diagonal, marked once: it is the histogram, and everything off
            it is what this picture exists for. */}
        <line
          className="density__diagonal"
          x1={GUTTER}
          y1={GUTTER}
          x2={GUTTER + size * CELL}
          y2={GUTTER + size * CELL}
        />

        {/*
         * One tick per row and column, in place of the kets themselves. A
         * sixteen-qubit ket is fourteen characters and there is no gutter that
         * fits sixteen of them; what the ticks have to do is say *how many*
         * states the block holds and where each one's band is, so the reader
         * can count in from the diagonal and find the row in the table. The
         * labels themselves live in that table, which is the rendering.
         */}
        {labels.map((label, index) => (
          <g key={label}>
            <rect
              className="density__tick"
              x={0}
              y={GUTTER + index * CELL + 2}
              width={GUTTER - 4}
              height={CELL - 4}
            />
            <rect
              className="density__tick"
              x={GUTTER + index * CELL + 2}
              y={0}
              width={CELL - 4}
              height={GUTTER - 4}
            />
          </g>
        ))}
      </svg>
    </div>
  )
}
