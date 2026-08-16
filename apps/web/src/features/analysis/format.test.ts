// @vitest-environment node
import { describe, expect, it } from 'vitest'

import {
  formatAmplitude,
  formatCoordinate,
  formatCount,
  formatDegrees,
  formatMagnitude,
  formatProbability,
  formatProbabilityDelta,
  formatRadians,
  pluralCount,
} from './format'

/**
 * D2/§1.1, asserted rather than assumed: every number in the analysis panel
 * is written the way the active language writes it.
 *
 * This is not polish. French and Spanish put a comma where English puts a
 * point, so a hardcoded decimal point turns `0.7071` — an amplitude — into
 * something that reads as seven thousand and seventy-one for two thirds of
 * the locales this app ships. The defect is invisible to anyone testing in
 * English, which is exactly why it is pinned here.
 *
 * Percent formatting inserts its own space in `fr` and `es` (and no space in
 * `en`), and the character is a non-breaking one. The assertions therefore
 * match `\s` rather than a literal, because the point is that `Intl` decides
 * — not that it decides one particular way today.
 */

const LANGUAGES = ['en', 'es', 'fr'] as const

describe('an amplitude, as a + bi', () => {
  it('writes the English decimal point', () => {
    expect(formatAmplitude(Math.SQRT1_2, 0, 'en')).toBe('0.7071 + 0.0000i')
  })

  it.each(['es', 'fr'])('writes the %s decimal comma', (language) => {
    expect(formatAmplitude(Math.SQRT1_2, 0, language)).toBe('0,7071 + 0,0000i')
  })

  it.each(LANGUAGES)(
    'pads to four decimals in %s, so columns line up',
    (language) => {
      // §10 chose a monospace font for these columns; fixed fraction digits are
      // what actually aligns them. `1` above `0,7071` is not a column.
      const one = formatAmplitude(1, 0, language)
      const half = formatAmplitude(Math.SQRT1_2, 0, language)

      expect(one).toHaveLength(half.length)
    }
  )

  it('subtracts a negative imaginary part instead of adding a negative one', () => {
    // `a + -0,5i` is not the notation §3.2 asks for, and the sign is the
    // locale's own so the connector matches any minus beside it in the column.
    expect(formatAmplitude(0.5, -0.5, 'fr')).toBe('0,5000 - 0,5000i')
  })

  it('does not report a negative zero as a measurement', () => {
    // `0 · -1` is `-0` in IEEE-754 and reaches `Intl` as one; rendered, it
    // reads as a tiny negative amplitude the state does not have.
    expect(formatAmplitude(-0, -0, 'en')).toBe('0.0000 + 0.0000i')
  })

  it('keeps a genuinely negative real part', () => {
    expect(formatAmplitude(-Math.SQRT1_2, 0, 'en')).toBe('-0.7071 + 0.0000i')
  })

  /*
   * The band between the chart's floor and what four decimals resolve.
   * `PROBABILITY_FLOOR` keeps a row on screen for any |a| above 1e-6, and
   * `0,0000` beside a positive probability and a meaningful phase is a row
   * contradicting itself. Both halves of the shipped `interference` preset at
   * φ = 3.14158265 landed in it.
   */
  it('does not print a zero for an amplitude the chart is still drawing', () => {
    const printed = formatAmplitude(0, 4.5e-6, 'en')

    expect(printed).not.toContain('0.0000i')
    expect(printed).toBe('0.0000 + 0.000005i')
    expect(formatMagnitude(4.5e-6, 'en')).toBe('0.000005')
  })

  it('never puts a minus sign in front of a printed zero', () => {
    // `zeroed()` folds an exact −0; a residue of −4,5e-7 is not −0 and used to
    // reach the connector as an ordinary negative, printing `1.0000 - 0.0000i`.
    expect(formatAmplitude(1, -4.5e-7, 'en')).toBe('1.0000 + 0.0000i')
    expect(formatAmplitude(1, -0, 'en')).toBe('1.0000 + 0.0000i')
  })

  it('rounds residue below the chart floor to zero, and says so plainly', () => {
    // Under the floor there is no physics left to report: |a|² is below
    // `PROBABILITY_FLOOR`, the chart drops the row, and `0,0000` is honest.
    expect(formatAmplitude(0.5, 1e-9, 'en')).toBe('0.5000 + 0.0000i')
    expect(formatMagnitude(1e-9, 'en')).toBe('0.0000')
  })

  it.each(['es', 'fr'])(
    'writes the small band with the %s decimal comma too',
    (language) => {
      expect(formatMagnitude(4.5e-6, language)).toBe('0,000005')
    }
  )
})

describe('the other columns', () => {
  it.each(['es', 'fr'])('writes a magnitude with the %s comma', (language) => {
    expect(formatMagnitude(Math.SQRT1_2, language)).toBe('0,7071')
  })

  it.each(['es', 'fr'])('writes radians with the %s comma', (language) => {
    expect(formatRadians(Math.PI / 4, language)).toBe('0,7854')
  })

  it('trims trailing zeros from a phase but not from an amplitude', () => {
    // A phase of zero is `0`, not `0,0000`: the radians column is read
    // against the degrees beside it, where four decimals would be noise.
    expect(formatRadians(0, 'fr')).toBe('0')
    expect(formatMagnitude(0, 'fr')).toBe('0,0000')
  })

  it.each(LANGUAGES)('groups a five-figure shot count in %s', (language) => {
    // 100 000 is the ceiling of §3.2's control, and every locale groups it
    // differently: `100,000`, `100.000`, `100 000`.
    expect(formatCount(100_000, language)).toMatch(/^100\D?000$/u)
  })
})

describe('a phase never prints a full turn', () => {
  /*
   * `normalizePhase` folds into [0, 2π) exactly, but printing rounds — and the
   * fold used to be lost in the rounding. A phase a hair below a full turn
   * printed as `6.2832` rad (larger than 2π) and `360°`, so two amplitudes a
   * hundred-thousandth of a radian apart were printed a whole turn apart in
   * the numeric channel §10 ranks above hue precisely so it can be relied on.
   */
  const TAU = 2 * Math.PI

  it.each([-1e-5, -4.5e-6, TAU - 1e-7, -1e-9])(
    'prints a phase of %f as zero rather than as a full turn',
    (phase) => {
      expect(formatRadians(phase, 'en')).toBe('0')
      expect(formatDegrees(phase, 'en')).toBe('0°')
    }
  )

  it('prints two phases either side of zero as the same angle', () => {
    // Rz(2e-5) after an H: |0⟩ at −1e-5 rad and |1⟩ at +1e-5 rad, a difference
    // of a thousandth of a degree.
    expect(formatRadians(-1e-5, 'fr')).toBe(formatRadians(1e-5, 'fr'))
    expect(formatDegrees(-1e-5, 'fr')).toBe(formatDegrees(1e-5, 'fr'))
  })

  it('still prints an angle that is genuinely below a full turn', () => {
    // The fold costs at most half of the last digit shown, and nothing more:
    // 359,99° is still 359,99°.
    expect(formatDegrees(-0.0002, 'en')).toBe('359.99°')
    expect(formatRadians(TAU - 0.001, 'en')).toBe('6.2822')
  })
})

describe('the plural selector', () => {
  it('passes 0 and 1 through, because the languages disagree about them', () => {
    // CLDR: French counts 0 as singular, Spanish and English do not.
    expect(pluralCount(0)).toBe(0)
    expect(pluralCount(1)).toBe(1)
  })

  it('clamps everything above one to a value no locale calls `many`', () => {
    // A French `many` fires on exact multiples of a million and would fall
    // through to the English catalog, since English has no such form to write.
    for (const value of [2, 33, 1_000_000, 1_048_576]) {
      expect(pluralCount(value)).toBe(2)
      expect(new Intl.PluralRules('fr').select(pluralCount(value))).toBe(
        'other'
      )
      expect(new Intl.PluralRules('es').select(pluralCount(value))).toBe(
        'other'
      )
    }
  })
})

describe('a signed difference of probabilities', () => {
  it('keeps the sign of a positive gap', () => {
    // Without it the reader cannot tell an overshoot from an undershoot, and
    // the direction of the miss is half of what the column says.
    expect(formatProbabilityDelta(0.002, 'en')).toBe('+0.2%')
  })

  it('writes a negative gap in the locale of the reader', () => {
    expect(formatProbabilityDelta(-0.002, 'fr')).toMatch(/^-0,2\s%$/u)
  })

  it('leaves an exact match unsigned', () => {
    expect(formatProbabilityDelta(0, 'en')).toBe('0%')
  })

  it('agrees with the probability formatter beside it', () => {
    // The two sit in adjacent columns of one row, so a difference of 50% and
    // a probability of 50% have to be the same string bar the sign.
    expect(formatProbabilityDelta(0.5, 'fr').slice(1)).toBe(
      formatProbability(0.5, 'fr')
    )
  })
})

describe('a Bloch coordinate', () => {
  it('keeps four decimals, so a column of them lines up', () => {
    expect(formatCoordinate(1, 'en')).toBe('1.0000')
    expect(formatCoordinate(0.5, 'en')).toBe('0.5000')
    expect(formatCoordinate(Math.SQRT1_2, 'en')).toBe('0.7071')
  })

  it('keeps the sign of a genuinely negative component', () => {
    // |1⟩ is at rz = −1, and a table that dropped the sign would put it at
    // the north pole beside |0⟩.
    expect(formatCoordinate(-1, 'en')).toBe('-1.0000')
    expect(formatCoordinate(-0.5, 'fr')).toBe('-0,5000')
  })

  it('prints residue as a plain zero, with no sign in front of it', () => {
    /*
     * The reason this function exists. A component of an entangled qubit is a
     * difference of sums over 2ⁿ terms, so it arrives as −0 or as −3e-17 as
     * readily as as 0 — and the amplitude rule prints those as `-0.0000`, a
     * minus sign in front of nothing, in the column whose whole message is
     * that the number is nothing.
     */
    expect(formatCoordinate(-0, 'en')).toBe('0.0000')
    expect(formatCoordinate(-3e-17, 'en')).toBe('0.0000')
    expect(formatCoordinate(-1e-9, 'fr')).toBe('0,0000')
    expect(formatCoordinate(0, 'en')).toBe('0.0000')
  })

  it('rounds to zero exactly where the reading does', () => {
    // `readingOf` calls anything within 5e-5 of zero "the centre". Below that
    // threshold the number must print as zero, or the word and the digits in
    // one row would contradict each other.
    expect(formatCoordinate(4.9e-5, 'en')).toBe('0.0000')
    expect(formatCoordinate(5.1e-5, 'en')).toBe('0.0001')
  })

  it('writes the decimal separator of the reader', () => {
    expect(formatCoordinate(0.7071, 'fr')).toBe('0,7071')
    expect(formatCoordinate(0.7071, 'es')).toBe('0,7071')
    expect(formatCoordinate(0.7071, 'en')).toBe('0.7071')
  })
})
