/**
 * The probability histogram, with the phasors. Specification §3.2 and §10.
 *
 * This is the signature element of the product, and §10 calls the phasors
 * the only animation that matters. A bar is not a flat block of one colour:
 * it carries a small vector pointing along the phase of its amplitude. Drag
 * an Rz slider and the arrows turn. Build two paths that interfere and you
 * watch two opposite phasors cancel before the bar disappears. That is two
 * seconds of animation explaining something that normally takes a chapter.
 *
 * ── The phase is encoded three times, in this order ──────────────────────
 *
 * §10's rule, and `lib/phase-colour.ts` explains the reasoning at length:
 *
 *  1. **Direction.** Where the arrow points. Readable with no colour vision
 *     at all, and the channel that makes cancellation visible as geometry.
 *  2. **Number.** The angle in degrees and radians — printed on the chart
 *     when motion is off, and always present in the table below.
 *  3. **Hue.** Reinforcement, never the only carrier.
 *
 * So the chart survives greyscale, it survives colour blindness, and under
 * `prefers-reduced-motion` it survives the animation being taken away: the
 * arrows freeze *and print their angle*, because the information was in
 * where they point and the rotation was only the animation of a change.
 *
 * ── Two renderings of one model ──────────────────────────────────────────
 *
 * The same split the circuit canvas uses: the SVG is `aria-hidden` pixels
 * for people who look, and a table of state, probability and phase is the
 * same data as sentences for people who listen. Both are generated from one
 * `HistogramModel`, so they cannot describe different distributions. The cap
 * on how many bars are drawn is stated in the figure's own caption, visible
 * to everyone, because a chart that silently omits part of a distribution is
 * a chart that lies.
 *
 * ── The rotation is unwrapped, the hue follows it ───────────────────────
 *
 * A CSS transition on the arrow's `transform` is what makes the turn
 * continuous while a slider is dragged, and `unwrapRotation` is what keeps
 * it going the short way round zero. The hue is driven off the *same*
 * unwrapped number (negated: SVG rotates clockwise, the phase circle does
 * not), so colour and direction travel together — a bar whose phase creeps
 * past 0 does not flash across the far side of the hue wheel while its arrow
 * moves by two degrees. Both are written by `usePhasorRotation`, in a layout
 * effect, for the reason given there; the hue rides on `--row-hue`, a
 * registered `@property` that inherits, which is what lets one write per row
 * tint three marks and still interpolate.
 *
 * ── One chart, several distributions (M2.2, M4.4) ───────────────────────
 *
 * §3.3 asks for the ideal distribution beside the noisy one and §3.7 asks for
 * the real device beside both, and this chart is what draws them — extended
 * with `overlays`, never duplicated. Adjacent charts would show several sets of
 * lengths and leave the reader subtracting them across a gap; on one track each
 * difference is a mark. `HistogramOverlay` in `histogram.ts` argues it at
 * length, and `Move` below is the few lines that draw it. Everything above is
 * unchanged when no overlay is passed, which is every caller but two.
 *
 * With more than one overlay each reading takes a horizontal band of the bar,
 * in the order passed, because two slivers on one rectangle overlap into a
 * length that is neither reading — see `HistogramOverlay`.
 */

import type { Statevector } from '@qsim/core'
import {
  Fragment,
  useLayoutEffect,
  useMemo,
  useRef,
  type RefObject,
} from 'react'
import { useTranslation } from 'react-i18next'

import { Notation, NotationText } from '../../components/Notation'
import { phasorRotation } from '../../lib/phase-colour'
import { usePrefersReducedMotion } from '../../lib/usePrefersReducedMotion'
import {
  formatCount,
  formatDegrees,
  formatPhaseReading,
  formatProbability,
  formatProbabilityDelta,
  pluralCount,
} from './format'
import {
  DEFAULT_BAR_LIMIT,
  PROBABILITY_FLOOR,
  buildHistogram,
  histogramLayout,
  ket,
  rowCentreY,
  unwrapRotation,
  type HistogramBar,
  type HistogramLayout,
  type HistogramOverlay,
} from './histogram'

export interface ProbabilityHistogramProps {
  /** The final state of an analytic run. */
  readonly state: Statevector
  /** How many basis states are drawn one by one. See `histogram.ts`. */
  readonly barLimit?: number
  /**
   * Draw every basis state, including the ones carrying nothing, so that a
   * sequence of charts of one register keeps its rows. `histogram.ts` argues
   * why this is right for the landing demo and wrong for the editor.
   */
  readonly fullBasis?: boolean
  /**
   * Draw the phasors and print the note explaining them. Off for a caller
   * whose states are all real: four arrows that point the same way and never
   * move explain nothing, and the note would promise a cancellation the chart
   * cannot show.
   */
  readonly phasors?: boolean
  /** Overrides the chart's own title, for a caller with its own vocabulary. */
  readonly heading?: string
  /** Overrides the sentence beside the title. Pass with `heading`. */
  readonly summary?: string
  /**
   * Overrides the accessible table's caption.
   *
   * The default describes a chart of one distribution, and the comparing
   * default describes a chart of two — neither of which is true of §3.7's,
   * which carries three. A caption that named the wrong number of readings
   * would misdescribe the table to the readers who have only the table.
   */
  readonly tableCaption?: string
  /**
   * Further readings of the same basis states, drawn on the same tracks —
   * §3.3's noisy distribution against this ideal one, and §3.7's real device
   * against both. See `HistogramOverlay` for why each is a mark on this chart
   * rather than a chart of its own, and why several are lanes.
   *
   * Their presence changes one more thing, and deliberately: the accessible
   * table below stops being `visually-hidden`. A bar's length is a quantity a
   * sighted reader can compare by eye, which is what lets the table be an
   * alternative rather than the rendering — but a two-pixel sliver between a
   * bar's end and a tick is not, so with an overlay the numbers *are* the
   * reading and they are shown. Same ruling the Bloch panel makes about its own
   * table, and the same one §10 makes about the `--wire` token.
   */
  readonly overlays?: readonly HistogramOverlay[]
}

/** Stable identity for the default, so the memos below do not re-run per render. */
const NO_OVERLAYS: readonly HistogramOverlay[] = []

export function ProbabilityHistogram({
  state,
  barLimit = DEFAULT_BAR_LIMIT,
  fullBasis = false,
  phasors = true,
  heading,
  summary,
  tableCaption,
  overlays = NO_OVERLAYS,
}: ProbabilityHistogramProps) {
  const { t, i18n } = useTranslation('analysis')
  const language = i18n.language
  const frozen = usePrefersReducedMotion()

  const model = useMemo(
    () => buildHistogram(state, { limit: barLimit, fullBasis }),
    [state, barLimit, fullBasis]
  )
  /*
   * A remainder row exists for either of two reasons, and the second one only
   * with an overlay. The first is the cap: states the chart chose not to draw,
   * which is what `model.hidden` counts. The second is *probability the second
   * reading put where the first one has none* — an outcome noise created out of
   * nothing. Rows are chosen by the ideal distribution (which is what keeps the
   * chart from reordering itself on every slider tick), so such an outcome has
   * no bar of its own and would otherwise be drawn nowhere at all: the chart
   * would show a distribution losing probability to a place it never names.
   */
  const anyRemainder = overlays.some(
    (reading) => reading.remainder > PROBABILITY_FLOOR
  )
  const remainder = model.hidden > 0 || anyRemainder
  const rows = model.bars.length + (remainder ? 1 : 0)
  const angles = frozen && phasors
  const comparing = overlays.length > 0
  const lanes = overlays.length
  const layout = useMemo(
    () =>
      histogramLayout(model.qubits, rows, {
        angles,
        phasors,
        comparisons: lanes,
      }),
    [model.qubits, rows, angles, phasors, lanes]
  )

  const caption =
    summary ??
    (remainder
      ? t('histogram.caption.capped', {
          count: pluralCount(model.hidden),
          shown: formatCount(model.bars.length, language),
          occupied: formatCount(model.occupied, language),
          total: formatCount(model.size, language),
          hidden: formatCount(model.hidden, language),
          share: formatProbability(model.hiddenProbability, language),
        })
      : t('histogram.caption.complete', {
          count: pluralCount(model.occupied),
          occupied: formatCount(model.occupied, language),
          total: formatCount(model.size, language),
        }))

  // A normalised state always has somewhere to be, so this is the shape of a
  // state that arrived empty rather than of a circuit anyone built. Saying so
  // beats drawing an axis with nothing on it.
  if (model.bars.length === 0) {
    return <p className="histogram__empty">{t('histogram.empty')}</p>
  }

  return (
    <figure className="histogram">
      <figcaption className="histogram__caption">
        <span className="histogram__title">
          {heading ?? t('histogram.heading')}
        </span>
        <span className="histogram__disclosure">{caption}</span>
      </figcaption>

      <div className="histogram__viewport">
        <svg
          className="histogram__plot"
          width={layout.width}
          height={layout.height}
          viewBox={`0 0 ${layout.width} ${layout.height}`}
          aria-hidden="true"
          focusable="false"
        >
          {model.bars.map((bar, row) => (
            /*
             * Keyed by register *and* index: a row keeps its DOM node — and
             * with it the last rotation it was drawn at — for as long as it
             * describes the same basis state. Index 3 of a two-qubit register
             * and index 3 of a three-qubit one are different states wearing
             * the same number, and a node reused across that boundary would
             * unwrap one arrow against a stranger's angle.
             */
            <BarRow
              key={`${model.qubits}:${bar.index}`}
              bar={bar}
              row={row}
              layout={layout}
              frozen={frozen}
              phasors={phasors}
              language={language}
              seconds={overlays.map(
                (reading) => reading.probabilities.get(bar.index) ?? 0
              )}
            />
          ))}

          {remainder ? (
            <RemainderRow
              row={model.bars.length}
              layout={layout}
              probability={model.hiddenProbability}
              language={language}
              seconds={overlays.map((reading) => reading.remainder)}
            />
          ) : null}
        </svg>
      </div>

      {phasors ? (
        <p className="histogram__note">{t('histogram.phasorNote')}</p>
      ) : null}

      {/*
       * The wrapper is load-bearing, not markup habit. `.visually-hidden`
       * hides a box by making it one pixel with `overflow: hidden`, and a
       * `<table>` cannot be one pixel: table layout refuses any width below
       * its min-content, so the box stayed as wide as its widest row — four
       * hundred and seventy-six pixels of absolutely positioned element,
       * adding to the document's scrollable overflow and pushing the *page*
       * sideways at 320 CSS px, which is WCAG 2.2 SC 1.4.10. Invisible, and
       * measurable only as a scrollbar under the whole editor. A block
       * wrapper does take the one pixel, and its `overflow: hidden` clips
       * the table inside it.
       *
       * The class stays off the table itself so the element keeps
       * `display: table` and, with it, the table semantics that are the
       * entire reason this rendering exists.
       */}
      {/*
       * When it is a viewport it scrolls sideways — seven `white-space: nowrap`
       * columns with two overlays — so it needs a tab stop and a name, or the
       * right-hand delta columns are unreachable from a keyboard (WCAG 2.2 SC
       * 2.1.1). When it is `.visually-hidden` it must NOT be focusable: a tab
       * stop on an invisible box is a focus that goes nowhere on screen, which
       * is the opposite of the fix.
       */}
      <div
        className={comparing ? 'histogram__viewport' : 'visually-hidden'}
        {...(comparing
          ? {
              tabIndex: 0,
              role: 'region' as const,
              'aria-label':
                tableCaption ?? t('histogram.table.comparedCaption'),
            }
          : {})}
      >
        <table className="histogram__table">
          <caption className={comparing ? 'visually-hidden' : undefined}>
            {tableCaption ??
              (comparing
                ? t('histogram.table.comparedCaption')
                : t('histogram.table.caption'))}
          </caption>
          <thead>
            <tr>
              <th scope="col">{t('histogram.table.state')}</th>
              <th scope="col">{t('histogram.table.probability')}</th>
              {overlays.map((reading) => (
                /*
                 * Keyed by the reading's own name rather than by position: the
                 * two headers of one reading have to travel together, and a
                 * positional key would let React reuse the "noisy" header for
                 * the "device" column if the order ever changed.
                 */
                <Fragment key={reading.label}>
                  <th scope="col">{reading.label}</th>
                  <th scope="col">{reading.deltaLabel}</th>
                </Fragment>
              ))}
              {/* The phase column follows the phasors: a caller that suppressed
                  them has a chart with no phase on it, and a described table
                  that carried one anyway would describe a different picture. */}
              {phasors ? (
                <th scope="col">{t('histogram.table.phase')}</th>
              ) : null}
            </tr>
          </thead>
          <tbody>
            {model.bars.map((bar) => (
              <tr className="histogram__table-row" key={bar.index}>
                <th scope="row">
                  <Notation value={ket(bar.label)} />
                </th>
                <td className="histogram__cell">
                  {formatProbability(bar.probability, language)}
                </td>
                <SecondCells
                  ideal={bar.probability}
                  overlays={overlays}
                  at={(reading) => reading.probabilities.get(bar.index) ?? 0}
                  language={language}
                />
                {phasors ? (
                  <td>
                    <Notation value={formatPhaseReading(bar.phase, language)} />
                  </td>
                ) : null}
              </tr>
            ))}

            {remainder ? (
              <tr className="histogram__table-row">
                <th scope="row">
                  {model.hidden > 0
                    ? t('histogram.table.remainder', {
                        count: pluralCount(model.hidden),
                        hidden: formatCount(model.hidden, language),
                      })
                    : /* Nothing was capped away, so this row stands for the
                         outcomes the circuit never reaches — the ones the
                         second reading put probability into. */
                      t('histogram.table.unreached')}
                </th>
                <td className="histogram__cell">
                  {formatProbability(model.hiddenProbability, language)}
                </td>
                <SecondCells
                  ideal={model.hiddenProbability}
                  overlays={overlays}
                  at={(reading) => reading.remainder}
                  language={language}
                />
                {phasors ? <td>{t('histogram.table.mixedPhase')}</td> : null}
              </tr>
            ) : null}
          </tbody>
        </table>
      </div>
    </figure>
  )
}

/**
 * Two cells per overlay reading — its value and its signed difference — or
 * nothing at all.
 *
 * A component rather than an inline fragment because it is rendered from two
 * places — the bars and the remainder row — and a table whose two branches
 * disagreed about how many cells a row has is a table that reads back to front
 * for a screen reader from the mismatch onwards.
 *
 * The reading is fetched through `at` rather than passed as an array, so the
 * two call sites differ in exactly the thing that differs between them (a bar
 * looks its state up by index, the remainder has one number) and cannot fall
 * out of step with the header, which iterates the same list.
 */
function SecondCells({
  ideal,
  overlays,
  at,
  language,
}: {
  readonly ideal: number
  readonly overlays: readonly HistogramOverlay[]
  readonly at: (reading: HistogramOverlay) => number
  readonly language: string
}) {
  return (
    <>
      {overlays.map((reading) => {
        const value = at(reading)
        const delta = value - ideal
        return (
          <Fragment key={reading.label}>
            <td className="histogram__cell">
              {formatProbability(value, language)}
            </td>
            <td className={`histogram__cell ${deltaClass(delta)}`}>
              {formatProbabilityDelta(delta, language)}
            </td>
          </Fragment>
        )
      })}
    </>
  )
}

/**
 * Which way a row moved, as a class.
 *
 * Colour is the *third* carrier here and never the only one (§10): the drawing
 * puts a gain outside the end of its bar and a loss inside it, the number
 * carries an explicit sign through `signDisplay: 'exceptZero'`, and this hue is
 * the reinforcement. A row that did not move gets neither class, so `0 %` is
 * printed in ink rather than in a colour that would imply a direction.
 */
function deltaClass(delta: number): string {
  if (delta > 0) return 'histogram__delta--gain'
  if (delta < 0) return 'histogram__delta--loss'
  return 'histogram__delta--level'
}

interface BarRowProps {
  readonly bar: HistogramBar
  readonly row: number
  readonly layout: HistogramLayout
  readonly frozen: boolean
  readonly phasors: boolean
  readonly language: string
  /** Each overlay's reading of this state, in the overlays' own order. */
  readonly seconds: readonly number[]
}

function BarRow({
  bar,
  row,
  layout,
  frozen,
  phasors,
  language,
  seconds,
}: BarRowProps) {
  const centre = rowCentreY(layout, row)
  const top = centre - layout.barHeight / 2
  const group = usePhasorRotation(phasorRotation(bar.phase))
  /*
   * Exactly proportional, with no minimum length. A bar shorter than a pixel
   * is a state with almost no probability, and inflating it to "visible"
   * would be drawing a probability the state does not have — the printed
   * percentage beside it is what carries values too small to see, which is
   * why every row prints one.
   */
  const fill = bar.probability * layout.trackWidth

  return (
    <g className="histogram__row" ref={group}>
      <NotationText
        className="histogram__label"
        value={ket(bar.label)}
        x={layout.labelX}
        y={centre}
      />

      <rect
        className="histogram__track"
        x={layout.trackX}
        y={top}
        width={layout.trackWidth}
        height={layout.barHeight}
        rx={2}
      />
      <rect
        className="histogram__fill phase-fill"
        x={layout.trackX}
        y={top}
        width={fill}
        height={layout.barHeight}
        rx={2}
      />

      <Moves
        ideal={bar.probability}
        seconds={seconds}
        layout={layout}
        top={top}
        centre={centre}
        language={language}
      />

      <NotationText
        className="histogram__value"
        value={formatProbability(bar.probability, language)}
        x={layout.valueX}
        y={centre}
      />

      {phasors ? (
        <Phasor x={layout.hubX} y={centre} radius={layout.hubRadius} />
      ) : null}

      {/*
       * §10: frozen phasors show the numeric angle instead. The column only
       * exists in this mode — `histogramLayout` does not reserve its width
       * otherwise — so nothing is drawn over and nothing is left blank.
       */}
      {frozen && phasors ? (
        <NotationText
          className="histogram__angle"
          value={formatDegrees(bar.phase, language)}
          x={layout.angleX}
          y={centre}
        />
      ) : null}
    </g>
  )
}

interface MovesProps {
  readonly ideal: number
  readonly seconds: readonly number[]
  readonly layout: HistogramLayout
  readonly top: number
  readonly centre: number
  readonly language: string
}

/**
 * How far this outcome moved between the ideal reading and each of the others —
 * §3.3's whole point and §3.7's, drawn as slivers on the track the bar already
 * occupies.
 *
 * FOUR MARKS, IN §10's ORDER. The sliver's *side* of the bar's end is the
 * primary channel and needs no colour vision at all: a gain grows out past the
 * end of the bar, into track that was empty; a loss is cut out of the bar
 * itself. The tick is where that reading actually lands, so the eye has a
 * position and not only a length. Which *band* of the bar the pair sits in says
 * which reading it is, which is the channel a second overlay needs and the one
 * §3.3 did not (see `HistogramOverlay`). The signed percentage in that
 * reading's own column is the number, and it carries its own `+` or `−`. The
 * hue is last, and it is the only one a colour-blind reader loses.
 *
 * Nothing is drawn for a state that did not move: a zero-width rectangle and a
 * tick sitting exactly on the bar's end are what "these two agree" looks like,
 * and the printed `0 %` is what says so.
 */
function Moves({ ideal, seconds, layout, top, centre, language }: MovesProps) {
  const idealX = layout.trackX + ideal * layout.trackWidth

  return (
    <>
      {seconds.map((second, lane) => {
        const delta = second - ideal
        const secondX = layout.trackX + second * layout.trackWidth
        // Bands run downwards in the order the overlays were passed, which is
        // also the order of the difference columns to the right — so "second
        // band" and "second column" name the same reading.
        const laneTop = top + lane * layout.laneHeight
        return (
          <Fragment key={lane}>
            <rect
              className={`histogram__move ${deltaClass(delta)}`}
              x={Math.min(idealX, secondX)}
              y={laneTop}
              width={Math.abs(secondX - idealX)}
              height={layout.laneHeight}
            />
            <line
              className="histogram__second"
              x1={secondX}
              y1={laneTop - 2}
              x2={secondX}
              y2={laneTop + layout.laneHeight + 2}
            />
            <NotationText
              className={`histogram__delta ${deltaClass(delta)}`}
              value={formatProbabilityDelta(delta, language)}
              x={layout.deltaX[lane] ?? 0}
              y={centre}
            />
          </Fragment>
        )
      })}
    </>
  )
}

interface RemainderRowProps {
  readonly row: number
  readonly layout: HistogramLayout
  readonly probability: number
  readonly language: string
  /** Each overlay's share of the same states, in the overlays' own order. */
  readonly seconds: readonly number[]
}

/**
 * Everything the cap left out, as one bar.
 *
 * It has no phasor and no hue, and that absence is the honest statement: the
 * states it stands for do not share a phase, so any arrow here would be an
 * average of angles, which is not a thing. Its label is an ellipsis rather
 * than a word — the label column is one ket wide, and the caption above the
 * chart is where the sentence explaining this bar belongs.
 */
function RemainderRow({
  row,
  layout,
  probability,
  language,
  seconds,
}: RemainderRowProps) {
  const centre = rowCentreY(layout, row)
  const top = centre - layout.barHeight / 2

  return (
    <g className="histogram__row histogram__row--remainder">
      <NotationText
        className="histogram__label"
        value="…"
        x={layout.labelX}
        y={centre}
      />
      <rect
        className="histogram__track"
        x={layout.trackX}
        y={top}
        width={layout.trackWidth}
        height={layout.barHeight}
        rx={2}
      />
      <rect
        className="histogram__fill histogram__fill--remainder"
        x={layout.trackX}
        y={top}
        width={probability * layout.trackWidth}
        height={layout.barHeight}
        rx={2}
      />
      {/*
       * The remainder moves too, and on a large register it is where most of
       * the movement is: an outcome the noise created out of nothing has no bar
       * of its own — the rows are chosen by *ideal* probability — so this is
       * the row that says "probability arrived where the circuit put none".
       */}
      <Moves
        ideal={probability}
        seconds={seconds}
        layout={layout}
        top={top}
        centre={centre}
        language={language}
      />
      <NotationText
        className="histogram__value"
        value={formatProbability(probability, language)}
        x={layout.valueX}
        y={centre}
      />
    </g>
  )
}

interface PhasorProps {
  readonly x: number
  readonly y: number
  readonly radius: number
}

/**
 * One rotating vector.
 *
 * The hub is translated into place with a static `transform` attribute and
 * the needle turns *inside* it, so the rotation is about the origin of its
 * own coordinate system and needs no `transform-origin` — a property whose
 * behaviour on SVG elements is exactly the kind of thing that works in one
 * browser and offsets the arrow by ten pixels in another.
 *
 * The needle is drawn pointing along +x, which `phasorRotation` is defined
 * against, and it is turned by `usePhasorRotation` rather than by an
 * attribute here — see that hook for why the angle cannot come from the
 * render. The hub is painted in `--bg-deep` because a phase colour clears
 * 3:1 against it at every hue on the circle (§10) — no light backing can say
 * the same, and an arrow that vanishes at one quarter of the phase circle
 * would take the primary encoding with it.
 */
function Phasor({ x, y, radius }: PhasorProps) {
  const reach = radius - 2
  const head = 4.2
  const flare = 3.2

  return (
    <g className="phasor" transform={`translate(${x} ${y})`}>
      <circle className="phasor__hub" r={radius} />
      <g className="phasor__needle">
        <line
          className="phasor__shaft phase-stroke"
          x1={0}
          y1={0}
          x2={reach - head + 1}
          y2={0}
        />
        <polygon
          className="phasor__head phase-fill"
          points={`${reach},0 ${reach - head},${-flare} ${reach - head},${flare}`}
        />
      </g>
      {/* Drawn last so the pivot reads as the origin the arrow turns about. */}
      <circle className="phasor__pivot" r={1.1} />
    </g>
  )
}

/**
 * Turns one row's phasor to `target`, continuously.
 *
 * THE ANGLE ON SCREEN IS NOT A FUNCTION OF THE STATE. `phasorRotation`
 * answers in `[0, 360)`, and a phase creeping past zero while an Rz slider is
 * dragged goes 350 → 10: the arrow has moved twenty degrees and a transition
 * between those two numbers unwinds it three hundred and forty the other way.
 * The number to render depends on the number already rendered, which React
 * keeps in exactly one place — the committed DOM — and nowhere else. Reading
 * it back out of the node is therefore not a workaround, it is where the
 * value lives. (A ref would be the same value in a second place, and the
 * lint rule that forbids reading one during render is right to: the render
 * would then depend on something React is free to discard.)
 *
 * So the row carries its own last rotation as `data-rotation`, and this
 * layout effect — before paint, so no frame is ever drawn at the wrong angle
 * — unwraps the new target against it and writes both the transform and the
 * hue. Both come from the same unwrapped number, so a bar whose phase creeps
 * past zero does not flash across the far side of the hue wheel while its
 * arrow moves by two degrees. `--row-hue` inherits and is registered as a
 * `<number>`, which is what lets one write per row animate three marks.
 *
 * Idempotent, and it has to be: StrictMode runs an effect twice on mount, and
 * unwrapping a value against itself adds a delta of zero.
 */
function usePhasorRotation(target: number): RefObject<SVGGElement | null> {
  const group = useRef<SVGGElement | null>(null)

  useLayoutEffect(() => {
    const node = group.current
    if (node === null) return

    const previous = Number(node.dataset.rotation)
    const next = round(
      Number.isFinite(previous) ? unwrapRotation(previous, target) : target
    )

    node.dataset.rotation = String(next)
    // Negated because `phasorRotation` already flipped the sense of the turn
    // for SVG, and the hue *is* the phase in degrees (§10). `hsl()` normalises
    // whatever lands outside [0, 360), so the unwrapped value goes in as it is.
    node.style.setProperty('--row-hue', String(-next))
    node
      .querySelector<SVGGElement>('.phasor__needle')
      ?.style.setProperty('transform', `rotate(${next}deg)`)
  }, [target])

  return group
}

/**
 * Thousandths of a degree, which is some four hundred times finer than
 * anything an eye resolves at this size.
 *
 * Not tidiness: `atan2` of two amplitudes that should give exactly ten
 * degrees gives 9.999999999999943, and unrounded that number reaches the DOM
 * in full — twice per row, on every result, on a chart that can carry
 * thirty-two rows. Rounding cannot accumulate drift either, because each
 * unwrap adds a fresh delta to the rounded value rather than compounding it.
 */
function round(degrees: number): number {
  return Math.round(degrees * 1000) / 1000
}
