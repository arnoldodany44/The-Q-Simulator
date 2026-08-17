/**
 * Durations, in the reader's language, without a catalog entry per unit.
 *
 * A hardware job's two interesting durations — how long it waited and how old
 * the calibration was — span six orders of magnitude between them: a job on an
 * empty device finishes in seconds, one on `ibm_fez` waits days, and a
 * calibration is hours old. Printing milliseconds is unreadable and printing
 * "4.7 hours" in English on a French page is a D2 violation, so the unit is
 * chosen here and the *rendering* is handed to `Intl.NumberFormat`'s unit
 * style — which knows that 4.7 hours is `4,7 heures` and 1 is `1 hour` rather
 * than `1 hours`, in every locale, with no plural key of ours to keep in sync
 * across three catalogs.
 *
 * That is the whole reason this is not four catalog keys with `_one`/`_other`
 * forms: those would be twelve strings, each of which is a fact about a
 * language that `Intl` already knows, and the first locale with a dual form
 * would find twelve strings written by someone who does not speak it.
 */

/** The units a duration is printed in, coarsest first. */
const UNITS = [
  { unit: 'day', ms: 86_400_000 },
  { unit: 'hour', ms: 3_600_000 },
  { unit: 'minute', ms: 60_000 },
] as const

/** The floor of the scale, and what a span shorter than a second still uses. */
const SECOND = { unit: 'second', ms: 1_000 } as const

/**
 * A span of milliseconds as a phrase.
 *
 * The unit is the largest one the span reaches, so a four-minute wait is
 * "4.5 minutes" rather than "0.075 hours" — and a wait under a second is still
 * printed in seconds rather than falling through to milliseconds, because
 * "0.4 seconds" is a duration a person reads and "412 milliseconds" is a
 * measurement of this system rather than of the device.
 *
 * One decimal, which is as much resolution as any of these numbers deserve: a
 * queue wait is not a stopwatch reading, and printing `4.7231 minutes` would
 * imply a precision the timestamps do not have.
 *
 * Negative spans keep their sign rather than being flipped. A negative
 * calibration age means one of two timestamps is not what it claims, and that
 * is worth showing rather than tidying away (`provenance.ts`).
 */
export function formatDuration(ms: number, locale: string): string {
  const magnitude = Math.abs(ms)
  const chosen = UNITS.find((candidate) => magnitude >= candidate.ms) ?? SECOND

  return new Intl.NumberFormat(locale, {
    style: 'unit',
    unit: chosen.unit,
    unitDisplay: 'long',
    maximumFractionDigits: 1,
  }).format(ms / chosen.ms)
}

/**
 * Seconds of QPU time.
 *
 * Always in seconds and never promoted to minutes, because the unit *is* the
 * point: the Open Plan grants ten minutes per twenty-eight days, so what a
 * reader wants to know is how many of its six hundred seconds this run cost.
 * Two decimals, because these numbers are genuinely small — a two-qubit job at
 * a thousand shots is a few seconds — and rounding one to "3 seconds" would
 * hide the difference between two runs.
 */
export function formatQpuSeconds(seconds: number, locale: string): string {
  return new Intl.NumberFormat(locale, {
    style: 'unit',
    unit: 'second',
    unitDisplay: 'long',
    maximumFractionDigits: 2,
  }).format(seconds)
}
