/**
 * The model behind the probability histogram: which bars exist, which of
 * them get drawn, and where each one sits. No React, no i18next, no colour —
 * everything here is arithmetic over a statevector, so it can be tested
 * without a DOM and reasoned about without a renderer.
 *
 * ────────────────────────────────────────────────────────────────────────
 * THE BAR CAP, AND WHY IT IS NOT A SECRET
 *
 * Twenty qubits is 1 048 576 basis states. No screen shows that, and no
 * reader wants it: past a few dozen bars the chart stops being a picture of
 * a distribution and becomes a scrollable list nobody reads to the end.
 *
 * Three rules together, chosen so that nothing is ever hidden silently:
 *
 *  1. **A state with no probability is not a bar.** `PROBABILITY_FLOOR` is
 *     the Float64 noise floor for |a|², so what it removes is arithmetic
 *     residue, not physics — and it is what makes a Bell pair two bars
 *     rather than two bars and two ghosts. `occupied` counts what survived,
 *     so the number is on screen even when the states themselves are not.
 *  2. **At most `DEFAULT_BAR_LIMIT` bars are drawn individually**, chosen by
 *     probability, largest first. Thirty-two is one screenful at the row
 *     height the chart uses, and it is also exactly the spectrum of a
 *     five-qubit register — so every circuit small enough to be a teaching
 *     example is drawn whole, and the cap only ever bites where a complete
 *     drawing was never possible anyway.
 *  3. **What the cap removes is still drawn, aggregated.** `hidden` and
 *     `hiddenProbability` are the remainder bar: one bar carrying the mass
 *     of everything not shown, so the eye sees the part of the distribution
 *     it is not being shown state by state. A histogram that quietly
 *     dropped half the probability would be a lie told in a chart.
 *
 * **Selection is by probability; display order is by basis state.** Those
 * are deliberately different. Ranking picks the states worth the space, but
 * a chart whose bars *reorder themselves* on every slider tick is unreadable
 * for exactly the thing this chart exists to show: destructive interference
 * is one bar shrinking to nothing while its neighbour grows, and if the bars
 * swapped places while it happened, the reader would see motion instead of
 * cancellation. Basis-state order gives every bar a fixed address on the
 * axis for as long as it is on screen.
 *
 * Ties go to the lower index — a candidate has to be strictly better than
 * the current worst to displace it — so equal amplitudes produce the same
 * chart on every run rather than a set that depends on iteration order.
 *
 * ────────────────────────────────────────────────────────────────────────
 * DRAWING A FIXED BASIS (M0.9b's landing demo)
 *
 * `fullBasis` draws every basis state, including the ones carrying nothing.
 * The editor must never do this — a Bell pair is two bars, not two bars and
 * two ghosts — but a *sequence* of charts of one register is the opposite
 * case: the landing page's whole argument is that two of four outcomes
 * disappear, and dropping their rows turns that into a re-layout where every
 * row moves, every bar changes length and the chart changes height. §3.2's own
 * model of the picture is "una barra que se encoge hasta desaparecer", which
 * needs the row to still be there at zero.
 *
 * It changes what is *drawn* and nothing that is *counted*: `occupied`,
 * `hidden` and `hiddenProbability` are measured against the floor either way,
 * so the caption over a full-basis chart says the same true thing it says over
 * any other.
 */

import { formatKet, type Statevector } from '@qsim/core'

import { normalizePhase } from '../../lib/phase-colour'

/**
 * Below this a probability is Float64 residue rather than a state the
 * circuit can reach. D6 fixes the test tolerance at 1e-10 on amplitudes;
 * this is the same order of magnitude squared, applied to |a|².
 */
export const PROBABILITY_FLOOR = 1e-12

/** How many basis states are drawn one by one. See the header. */
export const DEFAULT_BAR_LIMIT = 32

/** One drawn basis state. */
export interface HistogramBar {
  /** Statevector index. Qubit `q` of it is `(index >> q) & 1` — D1. */
  readonly index: number
  /** `formatKet`'s label: highest qubit first, no bra-ket brackets. */
  readonly label: string
  /** Born-rule probability, |a|². */
  readonly probability: number
  /** Argument of the amplitude, folded into `[0, 2π)`. */
  readonly phase: number
}

export interface HistogramModel {
  readonly qubits: number
  /** 2ⁿ — every basis state, drawn or not. */
  readonly size: number
  /** Basis states carrying any probability at all. */
  readonly occupied: number
  /** The drawn bars, in ascending basis-state order. */
  readonly bars: readonly HistogramBar[]
  /** Occupied states the cap left out. Zero when everything is drawn. */
  readonly hidden: number
  /** Probability those states hold between them. The remainder bar. */
  readonly hiddenProbability: number
  /** The cap this model was built with, for the caption to quote. */
  readonly limit: number
}

/**
 * A further reading of the same basis states, drawn on the same rows — §3.3's
 * ideal-against-noisy comparison and §3.7's ideal-against-noisy-against-real
 * one, and the reason this chart is extended rather than copies of it drawn
 * beside each other.
 *
 * ADJACENT CHARTS LEAVE THE READER DOING THE SUBTRACTION. The question §3.3
 * asks is not "what do these distributions look like" but "which outcomes
 * gained probability and which lost it", and that is a quantity no set of
 * charts states: it is the difference between a bar here and a bar over there,
 * held in the reader's head across a gap. On one track it is a mark — the bar
 * is still the ideal probability, with its phasor and its hue, and each further
 * reading is a tick with a coloured sliver between the two. A gain grows out of
 * the end of the bar; a loss is eaten out of it.
 *
 * This is the same ruling the shots control makes ("one track, two marks",
 * §3.2) applied to a second question, and it is one chart rather than several
 * for the same reason: what closes, or opens, is a *gap*.
 *
 * THE BAR STAYS THE IDEAL ONE, and that is not arbitrary. The row's hue and its
 * phasor are the phase of an *amplitude*, and neither a noisy state nor a
 * device has a single amplitude per basis state — painting either probability
 * in the ideal state's phase colour would be a claim about a mixed state that
 * nothing supports.
 *
 * ── WHY SEVERAL READINGS ARE LANES AND NOT LAYERS (M4.4) ─────────────────
 *
 * §3.7 puts three distributions on one track, which means two overlays, and two
 * slivers drawn on the same rectangle would overlap: where the noisy run lost
 * three percent and the device lost five, the reader sees one sliver whose
 * length is neither number and cannot tell which reading it belongs to. Colour
 * could not rescue it either — it is already carrying the *direction* of the
 * move, and §10 forbids making it carry a second meaning alone.
 *
 * So each overlay gets a horizontal band of the bar's height, in the order the
 * overlays are passed: reading one on top, reading two below it. Position is a
 * channel nothing else is using, it survives greyscale, and it survives a
 * screen reader because the table below has a labelled column pair per reading.
 * With a single overlay the band is the whole bar, so §3.3's chart is drawn
 * exactly as it was.
 *
 * The labels arrive already translated because this module has no i18next and
 * never will (see the header); the caller that knows what a reading is called
 * is the one that asked for it.
 */
export interface HistogramOverlay {
  /** This reading of each drawn basis state, by statevector index. */
  readonly probabilities: ReadonlyMap<number, number>
  /** This reading's share of everything the cap left out. */
  readonly remainder: number
  /** What this reading is called. Already translated. */
  readonly label: string
  /** Header for its signed-difference column. Already translated. */
  readonly deltaLabel: string
}

/**
 * Basis states carrying any probability.
 *
 * One pass with no allocation, rather than the engine's `probabilities()`,
 * which builds an array of 2ⁿ doubles — 8 MB at the 20-qubit ceiling, on
 * every result, to produce a single integer.
 */
export function occupiedStates(
  state: Statevector,
  floor: number = PROBABILITY_FLOOR
): number {
  let count = 0
  for (let index = 0; index < state.size; index++) {
    if (probabilityAt(state, index) > floor) count += 1
  }
  return count
}

/** Tuning for `buildHistogram`. Every field has a default; see the header. */
export interface HistogramOptions {
  /** How many basis states are drawn one by one. */
  readonly limit?: number
  /** Below this a probability is residue rather than a state. */
  readonly floor?: number
  /** Draw states carrying nothing as well, so the row set never changes. */
  readonly fullBasis?: boolean
}

/**
 * Reads the state once and answers with everything the chart needs.
 *
 * The selection keeps a sorted array of at most `limit` candidates, worst
 * first. That is O(2ⁿ) reads and, in practice, almost no writes: after the
 * first `limit` states, a candidate only costs anything when it beats the
 * current worst, which for any distribution that is not adversarially
 * ascending happens a handful of times. Sorting a million entries to keep
 * thirty-two would cost a hundred times more for the same answer.
 */
export function buildHistogram(
  state: Statevector,
  options: HistogramOptions = {}
): HistogramModel {
  const {
    limit = DEFAULT_BAR_LIMIT,
    floor = PROBABILITY_FLOOR,
    fullBasis = false,
  } = options
  const cap = Math.max(0, Math.floor(limit))
  /** Kept candidates, ascending by probability: `kept[0]` is the worst. */
  const kept: HistogramBar[] = []
  let occupied = 0
  let occupiedProbability = 0

  for (let index = 0; index < state.size; index++) {
    const probability = probabilityAt(state, index)
    const carries = probability > floor
    if (carries) {
      occupied += 1
      occupiedProbability += probability
    } else if (!fullBasis) {
      continue
    }

    if (kept.length >= cap) {
      const worst = kept[0]
      // Strictly better, so a tie leaves the incumbent standing — and
      // `insertByProbability` puts the *highest* index of a tied run first, so
      // the incumbent this evicts is the highest-index member of the worst
      // group and the lower indices stay. An absent `worst` is the
      // `cap === 0` case: nothing is drawn at all.
      if (worst === undefined || probability <= worst.probability) continue
      kept.shift()
    }

    insertByProbability(kept, {
      index,
      label: formatKet(index, state.qubits),
      probability,
      phase: phaseAt(state, index),
    })
  }

  const bars = kept.sort((a, b) => a.index - b.index)
  // Both figures are counted against the floor and never against the row
  // count: with `fullBasis` there are rows carrying nothing, and `hidden`
  // answers "how many states carrying probability are not on screen".
  const drawn = bars.filter((bar) => bar.probability > floor)
  const drawnProbability = drawn.reduce((sum, bar) => sum + bar.probability, 0)

  return {
    qubits: state.qubits,
    size: state.size,
    occupied,
    bars,
    hidden: occupied - drawn.length,
    // Subtracted rather than assumed to be `1 - drawnProbability`: a state
    // half way through a renormalisation interval does not sum to exactly
    // one, and a remainder bar that inherited that error would report
    // hidden probability where there is none. Clamped for the same reason.
    hiddenProbability: Math.max(0, occupiedProbability - drawnProbability),
    limit: cap,
  }
}

/** `|101⟩` from `101`. Notation, so it never passes through a catalog. */
export function ket(label: string): string {
  return `|${label}⟩`
}

/* ─────────────────────────────── geometry ───────────────────────────── */

/**
 * The chart is drawn as rows, not columns, and that is a decision about the
 * data rather than a taste in charts.
 *
 * A basis-state label is `n + 2` characters wide and a register can have
 * twenty qubits; under a vertical bar that label has to be rotated,
 * truncated or dropped. Along a row it simply reads. Rows also give each
 * phasor a hub big enough to read an angle off — the whole point of the
 * element — where thirty-two vertical bars share the width of a panel and
 * leave about twenty pixels each. The `--chart-track` token was written for
 * this shape too: "how long a full bar would be", so a 2 % probability reads
 * as a short bar rather than as an empty row.
 *
 * Sizes are in SVG user units drawn 1:1 with CSS pixels, and the plot is put
 * inside a scroller rather than scaled to fit. Scaling to fit is what makes
 * a 20-qubit chart render its labels at four pixels on a phone; the canvas
 * of M0.5 already made the same choice for the same reason.
 */
export interface HistogramLayout {
  readonly width: number
  readonly height: number
  readonly rowHeight: number
  readonly barHeight: number
  /**
   * How many overlay readings this layout reserved room for, and therefore how
   * many horizontal bands the bar is divided into. Zero for a plain chart,
   * whose bar is undivided.
   */
  readonly lanes: number
  /** Height of one band. Equals `barHeight` when there is at most one lane. */
  readonly laneHeight: number
  /** Centre of the ket label column. */
  readonly labelX: number
  /** Left edge of the track, and the origin of every bar. */
  readonly trackX: number
  readonly trackWidth: number
  /** Centre of the probability column. */
  readonly valueX: number
  /** Centre of the phasor hub. */
  readonly hubX: number
  readonly hubRadius: number
  /** Centre of the numeric-angle column. Only meaningful when frozen. */
  readonly angleX: number
  /**
   * Centre of each overlay's signed-difference column, in the overlays' own
   * order. Empty for a chart with no overlay.
   */
  readonly deltaX: readonly number[]
}

const ROW_HEIGHT = 24
const BAR_HEIGHT = 12
/**
 * The shortest a lane may be and still read as a band rather than a line.
 *
 * A bar carrying two readings is therefore taller than one carrying none —
 * twelve pixels split in two is six each, which is thinner than the tick that
 * marks the reading and would make the two bands look like one striped bar.
 * Growing the bar instead keeps every mark on the chart at a size the eye can
 * separate, and costs a chart that only ever exists on a page of its own.
 */
const MIN_LANE_HEIGHT = 8
const TRACK_WIDTH = 220
const VALUE_WIDTH = 62
const ANGLE_WIDTH = 54
/** Wider than the angle column: a signed percentage carries a sign and a unit. */
const DELTA_WIDTH = 68
const HUB_RADIUS = 10
const GAP = 10
const PAD = 8

/**
 * Advance width of IBM Plex Mono, as a fraction of the font size. The label
 * column is sized from it rather than measured in the DOM: a measurement
 * would make the first paint depend on a font that may still be loading,
 * and this number only has to be right enough to reserve space.
 */
const MONO_ADVANCE = 0.6
const LABEL_FONT_SIZE = 12

/** Which columns a chart reserves room for. */
export interface HistogramLayoutOptions {
  /** The numeric angle column, printed when the phasors are frozen (§10). */
  readonly angles?: boolean
  /** The phasor hub. Off for a chart of a state with nothing to say about phase. */
  readonly phasors?: boolean
  /**
   * How many overlay readings are drawn (§3.3 passes one, §3.7 passes two).
   *
   * A count rather than the boolean this used to be, because each reading needs
   * a signed-difference column of its own and a lane of its own. Zero is the
   * plain chart and is the default.
   */
  readonly comparisons?: number
}

export function histogramLayout(
  qubits: number,
  rows: number,
  options: HistogramLayoutOptions = {}
): HistogramLayout {
  const { angles = false, phasors = true, comparisons = 0 } = options
  const lanes = Math.max(0, Math.floor(comparisons))
  // At most one reading leaves the bar undivided, so §3.3's chart keeps the
  // exact geometry it had before this became a count.
  const barHeight = Math.max(BAR_HEIGHT, lanes * MIN_LANE_HEIGHT)
  const laneHeight = lanes <= 1 ? barHeight : barHeight / lanes
  const rowHeight = ROW_HEIGHT + (barHeight - BAR_HEIGHT)
  // `|` + one digit per qubit + `⟩`. The closing bracket comes from a system
  // fallback font (§10: no Latin subset carries U+27E9), so it is budgeted a
  // full monospace advance it may well exceed — hence the extra padding.
  const labelWidth =
    Math.ceil((qubits + 2) * LABEL_FONT_SIZE * MONO_ADVANCE) + 6
  const trackX = PAD + labelWidth + GAP
  const valueX = trackX + TRACK_WIDTH + GAP + VALUE_WIDTH / 2
  const hubX = valueX + VALUE_WIDTH / 2 + GAP + HUB_RADIUS
  const angleX = hubX + HUB_RADIUS + GAP + ANGLE_WIDTH / 2
  // The last column of whatever precedes the difference, so a chart with no
  // phasors puts its deltas straight after the probabilities rather than after
  // a gap the size of a phasor hub that was never drawn.
  const beforeDelta = !phasors
    ? valueX + VALUE_WIDTH / 2
    : angles
      ? angleX + ANGLE_WIDTH / 2
      : hubX + HUB_RADIUS
  // One column per reading, left to right in the order they were passed — the
  // same order as the lanes, so the column a number is in and the band it was
  // measured from are read in the same direction.
  const deltaX = Array.from(
    { length: lanes },
    (_unused, lane) =>
      beforeDelta + GAP + DELTA_WIDTH / 2 + lane * (GAP + DELTA_WIDTH)
  )
  const lastDelta = deltaX[lanes - 1]
  const right =
    lastDelta === undefined ? beforeDelta : lastDelta + DELTA_WIDTH / 2

  return {
    width: right + PAD,
    height: PAD * 2 + Math.max(1, rows) * rowHeight,
    rowHeight,
    barHeight,
    lanes,
    laneHeight,
    labelX: PAD + labelWidth / 2,
    trackX,
    trackWidth: TRACK_WIDTH,
    valueX,
    hubX,
    hubRadius: HUB_RADIUS,
    angleX,
    deltaX,
  }
}

/** Vertical centre of row `row`, counting from zero. */
export function rowCentreY(layout: HistogramLayout, row: number): number {
  return PAD + row * layout.rowHeight + layout.rowHeight / 2
}

/* ─────────────────────────────── rotation ───────────────────────────── */

/**
 * The rotation to render for a phasor that is already showing `previous`.
 *
 * `phasorRotation` answers in `[0, 360)`, which is the right *direction* and
 * the wrong *number* to animate towards: a phase crossing zero while an Rz
 * slider is dragged goes 350 → 10, and a transition between those two values
 * unwinds the arrow almost all the way round the wrong way. The phase moved
 * by twenty degrees; the picture has to move by twenty degrees.
 *
 * So the rendered value is unwrapped — kept continuous by adding the
 * shortest signed delta to what is already on screen — and the arrow may end
 * up at 730° or −45°, both of which point exactly where they should.
 *
 * Idempotent by construction: re-running it on a value it already produced
 * adds a delta of zero, which is what makes it safe to call during render.
 */
export function unwrapRotation(previous: number, target: number): number {
  const delta = ((((target - previous) % 360) + 540) % 360) - 180
  return previous + delta
}

/* ──────────────────────────────── internals ─────────────────────────── */

function probabilityAt(state: Statevector, index: number): number {
  const re = state.re[index] ?? 0
  const im = state.im[index] ?? 0
  return re * re + im * im
}

/** The argument of an amplitude, folded into `[0, 2π)`. */
function phaseAt(state: Statevector, index: number): number {
  return normalizePhase(Math.atan2(state.im[index] ?? 0, state.re[index] ?? 0))
}

/**
 * Linear insertion into an array of at most `limit` entries, worst first —
 * and, within a run of equal probabilities, **highest index first**.
 *
 * That second ordering is what implements the documented tie-break. Indices
 * arrive in ascending order, so a new bar tying the incumbents is always the
 * highest index among them; placing it *before* the run puts it at the front,
 * which is the end `buildHistogram` evicts from. Appending after the run
 * instead — the obvious spelling, and what this used to do — left the lowest
 * index at the front and evicted exactly the entry "ties go to the lower
 * index" says to keep, so a wide circuit with many equal amplitudes drew the
 * complement of the documented set. Nothing printed was false; which of a set
 * of equally probable states a reader is shown was simply the opposite rule.
 */
function insertByProbability(kept: HistogramBar[], bar: HistogramBar): void {
  let at = kept.length
  while (at > 0) {
    const before = kept[at - 1]
    if (before === undefined || before.probability < bar.probability) break
    at -= 1
  }
  kept.splice(at, 0, bar)
}
