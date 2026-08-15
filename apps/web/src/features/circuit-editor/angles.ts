/**
 * Angles, in the two forms a physicist needs at the same time.
 *
 * A rotation angle is a number of radians, and it is also — nearly always —
 * a simple multiple of π. `Rz(1,5708)` and `Rz(π/2)` are the same gate, but
 * only the second one tells you it is a quarter turn, and only the first one
 * survives being typed into a field. So the editor shows both and this
 * module is where both are produced.
 *
 * Formatting goes through `Intl.NumberFormat` bound to the active locale,
 * which is not a nicety: French writes `1,5708`, and a hardcoded decimal
 * point turns an angle into something that reads as a thousands separator
 * for a third of the users (decision D2, §1.1). Parsing is deliberately
 * *more* forgiving than formatting — a user who types `1.5` into a French
 * build meant one and a half, and refusing that would be pedantry.
 *
 * Nothing here touches React or i18next: π multiples are notation, so they
 * come back as strings for the caller to render through `Notation`.
 */

/**
 * The slider's resolution. Sixteenths of π mean every stop the slider can
 * reach is an exact fraction with a readable name — π/16, π/8, 3π/16, … —
 * so dragging never lands on `0,7854 rad` with no π form to show beside it.
 * The numeric field stays continuous; it is the one place arbitrary angles
 * are entered.
 */
export const ANGLE_STEP_DENOMINATOR = 16

export const ANGLE_STEP = Math.PI / ANGLE_STEP_DENOMINATOR

/**
 * Slider travel, in steps: ±2π, a full turn either way. Rotations are
 * periodic, so a wider range would only offer the same gates again, and a
 * narrower one would make `-2π` unreachable by dragging.
 */
export const ANGLE_STEPS = 2 * ANGLE_STEP_DENOMINATOR

/** Digits shown for a raw radian value. Below this, π/16 rounds to π/8. */
const RADIAN_DIGITS = 4

/**
 * Denominators tried when looking for a π form, smallest first so π/2 is
 * never reported as 8π/16. Sixteen is the slider's resolution and there is
 * no point looking past it: an angle finer than that came from the numeric
 * field, where the user typed radians and expects to see radians.
 */
const PI_DENOMINATORS = [1, 2, 3, 4, 6, 8, 12, 16] as const

/** Slack for the float error of `k · π / n`, far below display precision. */
const PI_TOLERANCE = 1e-9

/** A number as the active locale writes it. */
export function formatNumber(
  value: number,
  locale: string,
  maximumFractionDigits = RADIAN_DIGITS
): string {
  return new Intl.NumberFormat(locale, { maximumFractionDigits }).format(value)
}

/** The character this locale puts between units and decimals. */
export function decimalSeparator(locale: string): string {
  const parts = new Intl.NumberFormat(locale).formatToParts(1.1)
  return parts.find((part) => part.type === 'decimal')?.value ?? '.'
}

/**
 * Reads a number a user typed, in any of the three locales' conventions.
 *
 * The rule is positional rather than locale-driven: whichever of `.` or `,`
 * appears last is the decimal separator and the other is grouping. That
 * accepts `1,5`, `1.5`, `1 234,5` and `1,234.5` without asking which locale
 * the user believes they are in — and a user who switched the interface to
 * French mid-session has a keypad that still types whatever it types.
 *
 * Returns `null` for anything that is not a finite number, so the caller can
 * keep an in-progress `-` or `1,` on screen instead of destroying it.
 *
 * A separator only counts as *grouping* when three digits follow it, which is
 * what grouping means. Without that test the positional rule read `1.5.` as
 * "group, then decimal", threw the first separator away and stored 15 while
 * the field still showed `1.5.` — the circuit and the input disagreeing by a
 * factor of ten, and the live simulation running on the wrong angle until the
 * field was blurred. A half-typed number belongs on screen, not in the
 * document, so it is refused the way `-` and `abc` already are.
 */
const NUMERIC = /^[+-]?\d*(?:[.,]\d{3})*[.,]?\d*$/

export function parseAngle(text: string): number | null {
  // The whitespace class already covers the no-break and narrow no-break
  // spaces French grouping uses, so a pasted grouped number parses here
  // without a character class of its own.
  const trimmed = text.replace(/\s/g, '')
  if (trimmed === '') return null
  if (!NUMERIC.test(trimmed)) return null

  const lastDot = trimmed.lastIndexOf('.')
  const lastComma = trimmed.lastIndexOf(',')
  const decimalAt = Math.max(lastDot, lastComma)
  const normalized =
    decimalAt < 0
      ? trimmed
      : `${trimmed.slice(0, decimalAt).replace(/[.,]/g, '')}.${trimmed
          .slice(decimalAt + 1)
          .replace(/[.,]/g, '')}`

  const value = Number(normalized)
  return Number.isFinite(value) ? value : null
}

/**
 * The angle as a multiple of π — `π/2`, `-3π/4`, `2π`, `0` — or `null` when
 * it is not one of those, which is the honest answer for `1,2 rad`.
 *
 * The sign is a plain hyphen because this is notation, not prose: it sits
 * next to `π` and reads as mathematics in every locale.
 */
export function formatPiMultiple(value: number): string | null {
  if (!Number.isFinite(value)) return null
  if (Math.abs(value) < PI_TOLERANCE) return '0'

  for (const denominator of PI_DENOMINATORS) {
    const exact = (value * denominator) / Math.PI
    const numerator = Math.round(exact)
    if (numerator === 0) continue
    if (Math.abs(exact - numerator) > PI_TOLERANCE) continue
    return piFraction(numerator, denominator)
  }
  return null
}

function piFraction(numerator: number, denominator: number): string {
  const sign = numerator < 0 ? '-' : ''
  const magnitude = Math.abs(numerator)
  const scale = magnitude === 1 ? '' : String(magnitude)
  return denominator === 1
    ? `${sign}${scale}π`
    : `${sign}${scale}π/${denominator}`
}

/** Both readings of one angle, ready to be handed to `Notation`. */
export interface AngleReading {
  /** `1,5708 rad` — locale-formatted, with the SI symbol. */
  readonly radians: string
  /** `π/2`, or `null` when no simple multiple fits. */
  readonly pi: string | null
}

export function readAngle(value: number, locale: string): AngleReading {
  return {
    radians: `${formatNumber(value, locale)} rad`,
    pi: formatPiMultiple(value),
  }
}

/** Nearest slider stop to an arbitrary angle. */
export function toSliderStep(value: number): number {
  return clampStep(Math.round(value / ANGLE_STEP))
}

/** The angle a slider stop stands for. */
export function fromSliderStep(step: number): number {
  return clampStep(step) * ANGLE_STEP
}

function clampStep(step: number): number {
  return Math.min(ANGLE_STEPS, Math.max(-ANGLE_STEPS, step))
}
