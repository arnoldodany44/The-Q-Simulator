/**
 * Numbers, as the active language writes them (D2, §1.1).
 *
 * Every figure in the analysis panel is locale-sensitive and none of it is
 * optional: French writes `50 %` with a non-breaking space and a decimal
 * comma, Spanish writes `1,5708`, English writes `1.5708`. A hardcoded
 * decimal point is not a cosmetic slip here — it turns a probability into
 * something that reads as a thousands separator for a third of the users.
 *
 * `Intl.NumberFormat` does all of it, including the space before the percent
 * sign, which is why nothing below concatenates a `%` by hand.
 *
 * The analysis feature keeps its own formatters rather than borrowing the
 * editor's `angles.ts`: that module is about *entering* an angle (parsing
 * three locales' conventions, finding π forms) and this one is about
 * reporting a measurement. They will diverge, and a shared module would end
 * up being neither.
 *
 * NOTHING HERE TYPES A GLYPH ICU OWNS. Which character a locale uses for the
 * minus sign is ICU's to decide and it has changed before: the ICU shipped
 * with Node 24 and with Chromium writes U+002D for `en`, `es` and `fr` alike,
 * where earlier data wrote U+2212 for two of them. `minusSign()` reads the
 * answer out of `formatToParts` instead of asserting one, which is what keeps
 * the `a + bi` connector and a negative real part in the same column the same
 * character whatever ICU decides next — and is why this file states the rule
 * rather than the glyph.
 */

import { TAU, normalizePhase, phaseToDegrees } from '../../lib/phase-colour'
import { PROBABILITY_FLOOR } from './histogram'

/** Digits shown for a phase in radians. Matches the editor's angle field. */
const RADIAN_DIGITS = 4

/** Digits shown for a phase in degrees. Enough for π/16 steps: 11,25°. */
const DEGREE_DIGITS = 2

/**
 * Digits shown for an amplitude component and for a magnitude, *fixed* rather
 * than capped.
 *
 * Four decimals resolve everything a teaching circuit produces — 0,7071 is
 * 1/√2 and 0,3536 is half of it — and trailing zeros are kept because this is
 * the one column the monospace font of §10 exists for. `1` above `0,7071`
 * puts the decimal separators in different places and the eye can no longer
 * compare the two; `1,0000` above `0,7071` is a column.
 */
const AMPLITUDE_DIGITS = 4

/**
 * The smallest magnitude `AMPLITUDE_DIGITS` resolves: half of the last digit.
 * Anything under it rounds to `0,0000`.
 */
const AMPLITUDE_RESOLUTION = 0.5 * 10 ** -AMPLITUDE_DIGITS

/**
 * Below this an amplitude is Float64 residue rather than a number the circuit
 * produced — the amplitude counterpart of `PROBABILITY_FLOOR`, which is the
 * same statement about |a|². Derived rather than written out so the two cannot
 * drift: a row the chart keeps is a row this module must print honestly, and a
 * row the chart drops is noise this module may round to zero.
 */
const AMPLITUDE_FLOOR = Math.sqrt(PROBABILITY_FLOOR)

/** A count of states — grouped, so 1 048 576 is legible. */
export function formatCount(value: number, locale: string): string {
  return new Intl.NumberFormat(locale).format(value)
}

/**
 * The number i18next picks a plural form with — never the number on screen.
 *
 * The figure itself is interpolated separately, already written the way the
 * active language writes it; this is only the selector, and it is clamped for a
 * reason that is easy to miss. CLDR gives French and Spanish a `many` category
 * that fires on exact multiples of a million, English has none, and
 * `locale-parity.test.ts` requires the three catalogs to hold identical keys —
 * so a `_many` form would have to be written in English too, where nothing can
 * ever select it, and leaving it out makes a French sentence about 1 000 000
 * basis states fall through to the English catalog. Every sentence in the
 * analysis panel distinguishes exactly one from more than one, and every value
 * of 2 or more is `other` in all three languages, so clamping selects the form
 * the true count would have selected.
 *
 * 0 and 1 pass through untouched, because the difference between them is real:
 * French counts 0 as singular and Spanish does not.
 */
export function pluralCount(value: number): number {
  return value <= 1 ? value : 2
}

/**
 * A probability as a percentage.
 *
 * Two decimals is right for everything a teaching circuit produces (50 %,
 * 12,5 %, 3,13 %) and wrong for the remainder bar of a large register, where
 * a genuine share of the distribution can round to `0 %` — a chart that says
 * a bar holds nothing while drawing it is worse than one that omits it. So a
 * positive value that would round away is re-formatted to one significant
 * digit instead, and reports `0,0001 %` rather than nothing.
 */
export function formatProbability(value: number, locale: string): string {
  const rounded = new Intl.NumberFormat(locale, {
    style: 'percent',
    maximumFractionDigits: 2,
  })
  if (value <= 0 || value >= 0.0001) return rounded.format(value)

  return new Intl.NumberFormat(locale, {
    style: 'percent',
    maximumSignificantDigits: 1,
  }).format(value)
}

/**
 * The difference between two probabilities, signed: `+0,2 %`, `−0,31 %`.
 *
 * Strictly this is a difference of percentages — percentage *points* — and it
 * is written with a percent sign all the same, because the two numbers it sits
 * beside in the sampling table are percentages and a second unit in the same
 * row would be read as a second quantity. The sign is the payload: it says
 * which way the sample missed, and `exceptZero` keeps a `+` on a positive gap
 * where the default would print it bare and leave the reader to infer.
 */
export function formatProbabilityDelta(value: number, locale: string): string {
  return new Intl.NumberFormat(locale, {
    style: 'percent',
    maximumFractionDigits: 2,
    signDisplay: 'exceptZero',
  }).format(value)
}

/**
 * One amplitude as `a + bi` — §3.2's notation, and the reason this returns a
 * string rather than a pair.
 *
 * The sign between the parts is chosen here rather than left to the formatter,
 * because `-0,7071i` and `− 0,7071i` read differently: the first is a negative
 * imaginary part, the second is a subtraction, and the notation of §3.2 is the
 * second. The character used is the locale's own minus sign, taken from
 * `formatToParts` rather than typed as a hyphen, so the connector and any
 * negative real part beside it are the same glyph whatever ICU chooses to
 * write — and mixing two glyphs in one column is visible at a glance in a
 * monospace font.
 *
 * THE CONNECTOR IS CHOSEN FROM WHAT WILL BE PRINTED, not from the raw sign.
 * `-0` is not the only value that prints as zero: so does every residue below
 * `AMPLITUDE_FLOOR`, and taking the sign from the raw number put a minus in
 * front of `0,0000` — the exact artefact this rule exists to prevent, wearing
 * a different mask.
 */
export function formatAmplitude(
  re: number,
  im: number,
  locale: string
): string {
  const sign = printsAsZero(im) || im >= 0 ? '+' : minusSign(locale)
  const imaginary = formatComponent(Math.abs(im), locale)
  return `${formatComponent(re, locale)} ${sign} ${imaginary}i`
}

/** `|a|`, at the same fixed width as the parts it was built from. */
export function formatMagnitude(value: number, locale: string): string {
  return formatComponent(value, locale)
}

/**
 * A phase in radians, bare: `1,5708`. The unit belongs to the column header
 * in the amplitude table and to `formatPhaseReading` in the histogram, so it
 * is not baked in here.
 */
export function formatRadians(phase: number, locale: string): string {
  return new Intl.NumberFormat(locale, {
    maximumFractionDigits: RADIAN_DIGITS,
  }).format(printableRadians(phase))
}

/** The phase in degrees: `90°`, `11,25°`. The label a frozen phasor wears. */
export function formatDegrees(phase: number, locale: string): string {
  const degrees = new Intl.NumberFormat(locale, {
    maximumFractionDigits: DEGREE_DIGITS,
  }).format(printableDegrees(phase))
  // No space before the degree sign in any of the three languages, and the
  // sign is not a punctuation mark French spaces out.
  return `${degrees}°`
}

/**
 * Both readings of a phase, for the table: `90° · 1,5708 rad`.
 *
 * Degrees are what a reader compares against the arrow, radians are what the
 * physics is written in, and the amplitude table of §3.2 asks for both. The
 * separator is a middle dot rather than a comma because a comma is already
 * the decimal separator in two of the three languages.
 */
export function formatPhaseReading(phase: number, locale: string): string {
  return `${formatDegrees(phase, locale)} · ${formatRadians(phase, locale)} rad`
}

/* ──────────────────────────────── internals ─────────────────────────── */

/**
 * One component of an amplitude, or a magnitude: four fixed decimals for
 * everything that resolves at four decimals, and one significant digit for the
 * band that does not.
 *
 * The fixed width is what aligns the column (see `AMPLITUDE_DIGITS`), and it
 * is given up only where keeping it would print a falsehood. The chart keeps a
 * row whenever |a|² clears `PROBABILITY_FLOOR`, i.e. whenever |a| clears 1e-6,
 * while four decimals resolve nothing below 5e-5 — so the whole band between
 * them used to print as an exact `0,0000` beside a positive probability and a
 * meaningful phase, three cells of one row contradicting each other.
 * `formatProbability` already makes exactly this trade for exactly this
 * reason; this is the same ruling applied to the columns beside it.
 *
 * Below the floor the fixed form is the honest one: that is arithmetic
 * residue, and `0,0000` is what it is.
 */
function formatComponent(value: number, locale: string): string {
  const magnitude = Math.abs(value)
  if (magnitude >= AMPLITUDE_FLOOR && magnitude < AMPLITUDE_RESOLUTION) {
    return new Intl.NumberFormat(locale, {
      maximumSignificantDigits: 1,
    }).format(value)
  }
  return amplitudeFormat(locale).format(zeroed(value))
}

/** Whether `formatComponent` will render this value as a bare zero. */
function printsAsZero(value: number): boolean {
  return Math.abs(value) < AMPLITUDE_FLOOR
}

function amplitudeFormat(locale: string): Intl.NumberFormat {
  return new Intl.NumberFormat(locale, {
    minimumFractionDigits: AMPLITUDE_DIGITS,
    maximumFractionDigits: AMPLITUDE_DIGITS,
  })
}

/**
 * The phase to print, in radians, folded so that a value which *rounds* to a
 * full turn is printed as zero.
 *
 * `normalizePhase` folds into `[0, 2π)` and the fold is exact — but printing
 * rounds, and rounding is where the fold used to be lost. A phase of −4,5e-6
 * normalises to 6,2831853, which at four decimals is 6,2832: larger than 2π,
 * so the radian column printed a number the fold is supposed to make
 * impossible, and two amplitudes a hundred-thousandth of a radian apart were
 * printed a full turn apart — in the numeric channel §10 ranks *above* hue
 * precisely so a colour-blind reader can rely on it.
 *
 * Folding at the printed precision costs at most half of the last digit shown,
 * which is the error every other figure in this module already carries.
 */
function printableRadians(phase: number): number {
  const folded = normalizePhase(phase)
  return roundTo(folded, RADIAN_DIGITS) >= roundTo(TAU, RADIAN_DIGITS)
    ? 0
    : zeroed(folded)
}

/** The same fold, at the precision `formatDegrees` prints. */
function printableDegrees(phase: number): number {
  const degrees = phaseToDegrees(phase)
  return roundTo(degrees, DEGREE_DIGITS) >= 360 ? 0 : zeroed(degrees)
}

function roundTo(value: number, decimals: number): number {
  const scale = 10 ** decimals
  return Math.round(value * scale) / scale
}

/** The locale's minus sign. ICU picks the glyph; this reads whichever it is. */
function minusSign(locale: string): string {
  const part = new Intl.NumberFormat(locale)
    .formatToParts(-1)
    .find((candidate) => candidate.type === 'minusSign')
  return part?.value ?? '-'
}

/**
 * `-0` is `0`. `Object.is` is the only comparison that can tell them apart,
 * which is exactly why the distinction survives all the way to a formatter
 * that then prints a minus sign in front of nothing.
 */
function zeroed(value: number): number {
  return Object.is(value, -0) ? 0 : value
}
