/**
 * The shots control — §3.2: "muestreo con shots, configurable de 1 a 100 000,
 * con comparación contra la distribución teórica".
 *
 * ── What this is for ─────────────────────────────────────────────────────
 *
 * A simulator knows every probability exactly. A quantum computer does not:
 * it is run some number of times and the answer is a tally. The whole gap
 * between those two facts is what this control exists to make visible, and it
 * is visible in one gesture — drag the slider from 10 shots to 100 000 and
 * watch the sampled bars settle onto the exact marks. That is the teaching
 * moment, so the design serves it before anything else:
 *
 *  - **One track, two marks.** The bar is what was measured, the tick is
 *    where the theory says it belongs, and the distance between them is the
 *    sampling error. Two bars side by side would show two lengths; a bar and
 *    a target shows a *gap*, and it is the gap that closes.
 *  - **The typical error is printed.** A reader who sees the gaps shrink can
 *    only guess at the rule; the summary line says the gaps should be about
 *    1/(2√N) and lets them check the next drag against it.
 *  - **A new sample without a new circuit.** "Draw again" moves the seed and
 *    nothing else, so the same state resampled gives different counts — which
 *    is the point of the word *sampling* and is otherwise easy to miss.
 *
 * ── It is off until asked ────────────────────────────────────────────────
 *
 * §5.3: a simulator has no reason to add shot noise nobody asked for. The
 * exact distribution is above, in the histogram and the amplitude table; this
 * is a deliberate second reading, so nothing is sampled and nothing crosses
 * the thread boundary until the checkbox is ticked.
 *
 * ── Where the work happens ───────────────────────────────────────────────
 *
 * Not here. The counts arrive already drawn, by `sampleShots` on the worker,
 * in the same message as the state they were drawn from (`protocol.ts`).
 * 100 000 draws over a 20-qubit register is an eight-megabyte sweep and two
 * million comparisons, and on the main thread that is a frozen tab. This
 * component chooses the shot count and reads the answer; it never samples.
 *
 * ── Two renderings, one model ────────────────────────────────────────────
 *
 * The same split the circuit canvas and the histogram make: an `aria-hidden`
 * drawing for people who look, and a table of the same rows for people who
 * listen. Here the table is *visible* as well, because its columns — the
 * count, the observed share, the signed difference — are the comparison
 * itself and not a transcript of it.
 */

import type { Statevector } from '@qsim/core'
import { useId, useMemo } from 'react'
import { useTranslation } from 'react-i18next'

import { Notation, NotationText } from '../../components/Notation'
import type { SamplePayload } from '../simulation/protocol'
import {
  formatCount,
  formatProbability,
  formatProbabilityDelta,
  pluralCount,
} from './format'
import { DEFAULT_BAR_LIMIT, ket } from './histogram'
import {
  SHOT_STOPS,
  buildComparison,
  samplingLayout,
  samplingRowCentreY,
  shotsAtStop,
  stopForShots,
  type Comparison,
  type ComparisonRow,
  type SamplingLayout,
} from './sampling'

/** What the control owns. Held by the panel, because the worker needs it. */
export interface SamplingSettings {
  /** Nothing is sampled while this is false. */
  readonly enabled: boolean
  readonly shots: number
  /** Bumped by "draw again" — a different sample of the same state. */
  readonly seed: number
}

export interface ShotSamplerProps {
  /** The state the counts were drawn from. */
  readonly state: Statevector
  readonly settings: SamplingSettings
  readonly onChange: (settings: SamplingSettings) => void
  /**
   * The counts of the run that produced `state`, or null when none were
   * requested or none have come back yet. Never counts from another run —
   * they travel in the same message as the state (`protocol.ts`).
   */
  readonly sampling: SamplePayload | null
  /** How many basis states are listed one by one. Same cap as the chart. */
  readonly rowLimit?: number
}

export function ShotSampler({
  state,
  settings,
  onChange,
  sampling,
  rowLimit = DEFAULT_BAR_LIMIT,
}: ShotSamplerProps) {
  const { t, i18n } = useTranslation('analysis')
  const language = i18n.language
  const headingId = useId()
  const shotsId = useId()

  const comparison = useMemo(
    () =>
      sampling === null
        ? null
        : buildComparison(state, sampling.counts, sampling.shots, rowLimit),
    [state, sampling, rowLimit]
  )

  return (
    <section className="shot-sampler" aria-labelledby={headingId}>
      <h4 id={headingId} className="shot-sampler__heading">
        {t('sampling.heading')}
      </h4>
      <p className="shot-sampler__intro">{t('sampling.intro')}</p>

      <div className="shot-sampler__controls">
        <label className="shot-sampler__toggle">
          <input
            type="checkbox"
            checked={settings.enabled}
            onChange={(event) => {
              onChange({ ...settings, enabled: event.target.checked })
            }}
          />
          {t('sampling.enable')}
        </label>

        {settings.enabled ? (
          <>
            <div className="shot-sampler__shots">
              <label className="shot-sampler__label" htmlFor={shotsId}>
                {t('sampling.shots')}
              </label>
              {/*
               * The slider's own value is a stop index, which is a number the
               * user has never been shown — hence `aria-valuetext`, exactly as
               * the parameter editor does for its angle slider. Without it a
               * screen reader announces "7 of 15" for a thousand shots.
               */}
              <input
                id={shotsId}
                className="shot-sampler__slider"
                type="range"
                min={0}
                max={SHOT_STOPS.length - 1}
                step={1}
                value={stopForShots(settings.shots)}
                aria-valuetext={formatCount(settings.shots, language)}
                onChange={(event) => {
                  onChange({
                    ...settings,
                    shots: shotsAtStop(Number(event.target.value)),
                  })
                }}
              />
              {/*
               * A span, not an `<output>`. An output is a live region, and
               * this one changes on every stop of a drag — a screen reader
               * would recite sixteen shot counts on the way from 1 to
               * 100 000. The value is already announced by the slider's own
               * `aria-valuetext`, at the moment the slider announces it, so
               * this readout is for the eye and is hidden from the tree.
               */}
              <span
                className="shot-sampler__reading tabular-numbers"
                aria-hidden="true"
              >
                {formatCount(settings.shots, language)}
              </span>
            </div>

            <button
              type="button"
              className="shot-sampler__resample"
              onClick={() => {
                // A new seed, nothing else. The circuit, the state and the
                // shot count are untouched, so what changes on screen is the
                // sample and only the sample.
                onChange({ ...settings, seed: settings.seed + 1 })
              }}
            >
              {t('sampling.resample')}
            </button>
          </>
        ) : null}
      </div>

      {settings.enabled ? (
        comparison === null ? (
          <p className="shot-sampler__waiting">{t('sampling.waiting')}</p>
        ) : (
          <Result comparison={comparison} language={language} />
        )
      ) : null}
    </section>
  )
}

function Result({
  comparison,
  language,
}: {
  readonly comparison: Comparison
  readonly language: string
}) {
  const { t } = useTranslation('analysis')
  const chartRows =
    comparison.remainder === null
      ? comparison.rows
      : [...comparison.rows, comparison.remainder]
  const layout = samplingLayout(comparison.qubits, chartRows.length)

  return (
    <>
      <p className="shot-sampler__summary">
        {t('sampling.summary', {
          count: pluralCount(comparison.shots),
          shots: formatCount(comparison.shots, language),
          gap: formatProbability(comparison.largestGap, language),
          typical: formatProbability(comparison.standardError, language),
        })}
      </p>

      <div className="shot-sampler__viewport">
        <svg
          className="shot-sampler__plot"
          width={layout.width}
          height={layout.height}
          viewBox={`0 0 ${layout.width} ${layout.height}`}
          aria-hidden="true"
          focusable="false"
        >
          {chartRows.map((row, index) => (
            <ChartRow
              key={row.index ?? 'remainder'}
              row={row}
              index={index}
              layout={layout}
            />
          ))}
        </svg>
      </div>

      <div className="shot-sampler__viewport">
        <table className="shot-sampler__grid">
          <caption className="visually-hidden">
            {t('sampling.table.caption')}
          </caption>
          <thead>
            <tr>
              <th scope="col">{t('sampling.table.state')}</th>
              <th scope="col">{t('sampling.table.exact')}</th>
              <th scope="col">{t('sampling.table.count')}</th>
              <th scope="col">{t('sampling.table.observed')}</th>
              <th scope="col">{t('sampling.table.difference')}</th>
            </tr>
          </thead>
          <tbody>
            {comparison.rows.map((row) => (
              <tr className="shot-sampler__row" key={row.index}>
                <th scope="row" className="shot-sampler__state">
                  <Notation value={ket(row.label)} />
                </th>
                <RowFigures row={row} language={language} />
              </tr>
            ))}

            {comparison.remainder === null ? null : (
              <tr className="shot-sampler__row shot-sampler__row--remainder">
                <th scope="row">
                  {t('sampling.table.remainder', {
                    count: pluralCount(comparison.hiddenStates),
                    hidden: formatCount(comparison.hiddenStates, language),
                  })}
                </th>
                <RowFigures row={comparison.remainder} language={language} />
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </>
  )
}

function RowFigures({
  row,
  language,
}: {
  readonly row: ComparisonRow
  readonly language: string
}) {
  return (
    <>
      <td className="shot-sampler__number">
        {formatProbability(row.probability, language)}
      </td>
      <td className="shot-sampler__number">
        {formatCount(row.count, language)}
      </td>
      <td className="shot-sampler__number">
        {formatProbability(row.frequency, language)}
      </td>
      <td className="shot-sampler__number shot-sampler__delta">
        {formatProbabilityDelta(row.delta, language)}
      </td>
    </>
  )
}

/**
 * One row of the drawing: the sampled share as a bar, the exact probability as
 * a tick on the same track.
 *
 * The tick is drawn after the bar so it stays visible where the two coincide —
 * which is what the reader is being invited to make happen.
 */
function ChartRow({
  row,
  index,
  layout,
}: {
  readonly row: ComparisonRow
  readonly index: number
  readonly layout: SamplingLayout
}) {
  const centre = samplingRowCentreY(layout, index)
  const top = centre - layout.barHeight / 2
  const exactX = layout.trackX + row.probability * layout.trackWidth

  return (
    <g
      className={
        row.index === null
          ? 'shot-sampler__chart-row shot-sampler__chart-row--remainder'
          : 'shot-sampler__chart-row'
      }
    >
      <NotationText
        className="shot-sampler__chart-label"
        // The remainder stands for states that share no label, so it wears an
        // ellipsis — the sentence explaining it is in the table below.
        value={row.index === null ? '…' : ket(row.label)}
        x={layout.labelX}
        y={centre}
      />
      <rect
        className="shot-sampler__track"
        x={layout.trackX}
        y={top}
        width={layout.trackWidth}
        height={layout.barHeight}
        rx={2}
      />
      <rect
        className="shot-sampler__bar"
        x={layout.trackX}
        y={top}
        width={row.frequency * layout.trackWidth}
        height={layout.barHeight}
        rx={2}
      />
      <line
        className="shot-sampler__exact"
        x1={exactX}
        y1={top - 2}
        x2={exactX}
        y2={top + layout.barHeight + 2}
      />
    </g>
  )
}
