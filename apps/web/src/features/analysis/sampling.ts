/**
 * The model behind the shots control — §3.2's "muestreo con shots", the
 * empirical counts drawn beside the theoretical distribution.
 *
 * No physics is computed here and none may be. The counts arrive from
 * `sampleShots` in the engine, having been drawn on the worker; the exact
 * probabilities arrive from the same `buildHistogram` the chart above uses.
 * What this module does is line the two up, which is arithmetic on numbers
 * both of which already exist.
 *
 * ────────────────────────────────────────────────────────────────────────
 * WHY THE SLIDER IS LOGARITHMIC.
 *
 * §3.2 asks for 1 to 100 000 shots. On a linear slider the entire interesting
 * range — the first few hundred draws, where the histogram visibly disagrees
 * with the theory — occupies the first half a percent of the track, and every
 * position a user can actually hit answers "the sample matches". The lesson is
 * that error falls like 1/√N, and a control that can only express large N
 * hides the falling.
 *
 * So the stops are a 1-2-5 decade progression: sixteen positions, each roughly
 * two and a half times the last, every one of them a number a person would
 * choose. Discrete stops also mean the control is *the same* under a pointer
 * and under an arrow key, which a continuous log scale is not.
 *
 * ────────────────────────────────────────────────────────────────────────
 * WHAT MAKES THE COMPARISON LEGIBLE.
 *
 * Three things, in this order:
 *
 *  1. Each state's two numbers on one row — exact probability and observed
 *     frequency — so the comparison is a reading, not a memory test.
 *  2. The signed gap between them, so "the sample is 0,4 % high on |00⟩" is
 *     on screen rather than being subtracted by the reader.
 *  3. `standardError`, the size the gaps *should* be at this shot count. It
 *     is what turns a table of near-misses into a demonstration: at 100 shots
 *     the typical gap is 5 %, at 10 000 it is 0,5 %, and the reader watches
 *     the third column shrink by ten for every hundredfold on the slider.
 */

import type { ShotCounts, Statevector } from '@qsim/core'

import { DEFAULT_BAR_LIMIT, buildHistogram } from './histogram'

/**
 * The positions of the shots slider: 1, 2, 5, 10 … 100 000.
 *
 * Written out rather than generated. Sixteen literals are easier to read than
 * the loop that would produce them, and this list is a product decision (§3.2's
 * range, and which numbers inside it a reader can land on) rather than a
 * derivation.
 */
export const SHOT_STOPS: readonly number[] = [
  1, 2, 5, 10, 20, 50, 100, 200, 500, 1000, 2000, 5000, 10_000, 20_000, 50_000,
  100_000,
]

/** Qiskit's own default, and therefore the one this control starts at. */
export const DEFAULT_SAMPLE_SHOTS = 1000

/** The shot count at slider position `stop`, clamped to the ends. */
export function shotsAtStop(stop: number): number {
  const index = Math.min(SHOT_STOPS.length - 1, Math.max(0, Math.round(stop)))
  return SHOT_STOPS[index] ?? SHOT_STOPS[0]!
}

/**
 * The slider position showing `shots` — the nearest stop at or below it, so a
 * count restored from somewhere else never moves the slider past what it
 * describes.
 */
export function stopForShots(shots: number): number {
  let stop = 0
  for (let index = 0; index < SHOT_STOPS.length; index++) {
    if (SHOT_STOPS[index]! <= shots) stop = index
  }
  return stop
}

/**
 * The standard deviation of an observed frequency at `shots` draws, at the
 * value where it is largest.
 *
 * For a basis state of probability p the count is binomial, so the observed
 * frequency has standard deviation √(p(1−p)/N). That is maximised at p = ½ and
 * equals 1/(2√N) there, which is the number this returns: the typical size of
 * the gaps in the table, and an upper bound on it rather than a fitted value.
 *
 * It is statistics about the sampler, not a re-derivation of anything the
 * engine does — nothing here draws a sample or touches an amplitude.
 */
export function standardError(shots: number): number {
  if (!(shots > 0)) return 0
  return 1 / (2 * Math.sqrt(shots))
}

/** One basis state, exact against observed. */
export interface ComparisonRow {
  /** Statevector index, or null for the aggregated remainder row. */
  readonly index: number | null
  /** `formatKet`'s label; empty for the remainder row. */
  readonly label: string
  /** Born-rule probability — what an infinite sample would converge on. */
  readonly probability: number
  /** How many of the shots landed here. */
  readonly count: number
  /** `count / shots`. Zero when nothing was sampled. */
  readonly frequency: number
  /** `frequency − probability`: signed, so the direction of the miss shows. */
  readonly delta: number
}

export interface Comparison {
  /** Register size, so the drawing can reserve a column for the labels. */
  readonly qubits: number
  /** Shots the worker actually drew, echoed from the response. */
  readonly shots: number
  /** The listed states, in ascending basis-state order. */
  readonly rows: readonly ComparisonRow[]
  /**
   * Everything the cap left out, as one row — including the shots that landed
   * on states no row shows. Null when the cap left nothing out *and* every
   * sampled outcome is listed.
   */
  readonly remainder: ComparisonRow | null
  /** How many basis states that remainder stands for. */
  readonly hiddenStates: number
  /** The largest |delta| on screen: the headline of the comparison. */
  readonly largestGap: number
  /** The gap this many shots should typically produce. See `standardError`. */
  readonly standardError: number
}

/**
 * Line the counts up against the exact distribution of the same state.
 *
 * The selection is the histogram's, so the rows here are the bars there — see
 * `amplitudes.ts` for why three renderings of one distribution must not each
 * choose their own states.
 *
 * Counts are keyed by ket label, which is what `sampleShots` produces and what
 * `buildHistogram` puts on a bar, so the join needs no index arithmetic and no
 * assumption about endianness beyond the one D1 already fixed.
 */
export function buildComparison(
  state: Statevector,
  counts: ShotCounts,
  shots: number,
  limit: number = DEFAULT_BAR_LIMIT
): Comparison {
  const model = buildHistogram(state, { limit })
  const drawn = Math.max(0, shots)

  let listedCount = 0
  const rows = model.bars.map((bar): ComparisonRow => {
    const count = counts[bar.label] ?? 0
    listedCount += count
    const frequency = drawn === 0 ? 0 : count / drawn
    return {
      index: bar.index,
      label: bar.label,
      probability: bar.probability,
      count,
      frequency,
      delta: frequency - bar.probability,
    }
  })

  /*
   * Every shot that did not land on a listed state. Summed over the counts
   * rather than taken as `shots - listedCount` for the same reason the
   * histogram subtracts its remainder probability instead of assuming one: the
   * two agree here, and deriving it from the counts is what makes a
   * disagreement visible instead of absorbed.
   */
  let total = 0
  for (const count of Object.values(counts)) total += count
  const hiddenCount = Math.max(0, total - listedCount)

  const remainder: ComparisonRow | null =
    model.hidden === 0 && hiddenCount === 0
      ? null
      : {
          index: null,
          label: '',
          probability: model.hiddenProbability,
          count: hiddenCount,
          frequency: drawn === 0 ? 0 : hiddenCount / drawn,
          delta:
            (drawn === 0 ? 0 : hiddenCount / drawn) - model.hiddenProbability,
        }

  let largestGap = 0
  for (const row of remainder === null ? rows : [...rows, remainder]) {
    largestGap = Math.max(largestGap, Math.abs(row.delta))
  }

  return {
    qubits: model.qubits,
    shots: drawn,
    rows,
    remainder,
    hiddenStates: model.hidden,
    largestGap,
    standardError: standardError(drawn),
  }
}

/* ─────────────────────────────── geometry ───────────────────────────── */

/**
 * The comparison chart is one row per state, and each row carries two marks on
 * one track: a filled bar for what was sampled and a tick for where the theory
 * says it belongs.
 *
 * Two marks on one track rather than two bars side by side, because the
 * quantity the reader is being shown is the *distance between them*. Paired
 * bars put that distance in two places at once and make it a comparison of
 * lengths; one bar with a target on it makes it a gap, and the gap closing as
 * the shot count rises is the entire lesson.
 *
 * Sizes are SVG user units drawn 1:1 with CSS pixels, and the plot scrolls
 * rather than scaling — the same ruling `histogramLayout` makes, for the same
 * reason: a twenty-qubit ket squeezed into a phone's width is four pixels tall.
 */
export interface SamplingLayout {
  readonly width: number
  readonly height: number
  readonly rowHeight: number
  readonly barHeight: number
  /** Centre of the ket label column. */
  readonly labelX: number
  /** Left edge of the track, and the origin of every bar. */
  readonly trackX: number
  readonly trackWidth: number
}

const ROW_HEIGHT = 20
const BAR_HEIGHT = 10
const TRACK_WIDTH = 220
const GAP = 10
const PAD = 8

/** Advance width of IBM Plex Mono, as a fraction of the font size. */
const MONO_ADVANCE = 0.6
const LABEL_FONT_SIZE = 12

export function samplingLayout(qubits: number, rows: number): SamplingLayout {
  // `|` + one digit per qubit + `⟩`, with the closing bracket budgeted a full
  // monospace advance it comes from a fallback font and may exceed (§10).
  const labelWidth =
    Math.ceil((qubits + 2) * LABEL_FONT_SIZE * MONO_ADVANCE) + 6
  const trackX = PAD + labelWidth + GAP

  return {
    width: trackX + TRACK_WIDTH + PAD,
    height: PAD * 2 + Math.max(1, rows) * ROW_HEIGHT,
    rowHeight: ROW_HEIGHT,
    barHeight: BAR_HEIGHT,
    labelX: PAD + labelWidth / 2,
    trackX,
    trackWidth: TRACK_WIDTH,
  }
}

/** Vertical centre of row `row`, counting from zero. */
export function samplingRowCentreY(
  layout: SamplingLayout,
  row: number
): number {
  return PAD + row * layout.rowHeight + layout.rowHeight / 2
}
