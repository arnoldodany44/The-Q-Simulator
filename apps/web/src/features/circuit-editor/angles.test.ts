import { describe, expect, it } from 'vitest'

import {
  ANGLE_STEP,
  ANGLE_STEPS,
  decimalSeparator,
  formatNumber,
  formatPiMultiple,
  fromSliderStep,
  parseAngle,
  readAngle,
  toSliderStep,
} from './angles'

/**
 * The locale tests are the point of this file. `1.5708` and `1,5708` are the
 * same angle written for two audiences, and a hardcoded decimal point is not
 * a cosmetic slip — it is an angle that reads as a thousands separator for
 * every Spanish and French user (D2, §1.1). Asserting it in all three
 * languages is the only way that stays true.
 */

const HALF_PI = Math.PI / 2

describe('formatting numbers for a locale', () => {
  it('writes a decimal point in English and a comma in Spanish and French', () => {
    expect(formatNumber(HALF_PI, 'en')).toBe('1.5708')
    expect(formatNumber(HALF_PI, 'es')).toBe('1,5708')
    expect(formatNumber(HALF_PI, 'fr')).toBe('1,5708')
  })

  /*
   * The regional tag is passed through rather than narrowed to the base
   * language, and it changes the answer: Mexican Spanish writes a decimal
   * point where Peninsular Spanish writes a comma. Narrowing `es-MX` to `es`
   * before formatting — which is exactly what the UI does for *catalogs* —
   * would be wrong here, and this test is what says so.
   */
  it('honours a regional tag rather than narrowing it to the language', () => {
    expect(formatNumber(HALF_PI, 'es-MX')).toBe('1.5708')
    expect(formatNumber(HALF_PI, 'es-ES')).toBe('1,5708')
    expect(formatNumber(HALF_PI, 'fr-CA')).toBe('1,5708')
  })

  it('reports the separator each locale actually uses', () => {
    expect(decimalSeparator('en')).toBe('.')
    expect(decimalSeparator('es')).toBe(',')
    expect(decimalSeparator('fr')).toBe(',')
  })

  it('rounds to four digits, which is finer than the slider can reach', () => {
    expect(formatNumber(ANGLE_STEP, 'en')).toBe('0.1963')
    expect(formatNumber(0, 'fr')).toBe('0')
  })
})

describe('reading an angle back from a field', () => {
  it('accepts either separator, whichever locale the user is in', () => {
    expect(parseAngle('1,5')).toBe(1.5)
    expect(parseAngle('1.5')).toBe(1.5)
    expect(parseAngle('-0,25')).toBe(-0.25)
  })

  it('treats the last separator as the decimal one', () => {
    expect(parseAngle('1.234,5')).toBe(1234.5)
    expect(parseAngle('1,234.5')).toBe(1234.5)
  })

  it('ignores the spaces French uses for grouping', () => {
    expect(parseAngle('1 234,5')).toBe(1234.5)
    expect(parseAngle('1 234,5')).toBe(1234.5)
  })

  it('refuses what is not a number, so a half-typed value survives', () => {
    expect(parseAngle('')).toBeNull()
    expect(parseAngle('-')).toBeNull()
    expect(parseAngle('π/2')).toBeNull()
  })

  /*
   * The positional rule alone read `1.5.` as "grouping, then decimal", threw
   * the first separator away and stored 15 — a factor of ten between what the
   * field showed and what the circuit held, corrected only on blur, with the
   * live simulation running on the wrong angle in between. A separator is
   * grouping only when three digits follow it.
   */
  it('refuses a stray separator instead of guessing at one', () => {
    expect(parseAngle('1.5.')).toBeNull()
    expect(parseAngle('1,5,')).toBeNull()
    expect(parseAngle('1..5')).toBeNull()
    expect(parseAngle('1.5.7')).toBeNull()
  })

  it('still accepts every shape a user legitimately types on the way', () => {
    expect(parseAngle('1.234')).toBe(1.234)
    expect(parseAngle('1,234.56')).toBe(1234.56)
    expect(parseAngle('0,')).toBe(0)
    expect(parseAngle('1,')).toBe(1)
    expect(parseAngle('.5')).toBe(0.5)
    expect(parseAngle('+2')).toBe(2)
  })
})

describe('the π form', () => {
  it('names the angles that have a name', () => {
    expect(formatPiMultiple(0)).toBe('0')
    expect(formatPiMultiple(Math.PI)).toBe('π')
    expect(formatPiMultiple(-Math.PI)).toBe('-π')
    expect(formatPiMultiple(HALF_PI)).toBe('π/2')
    expect(formatPiMultiple((3 * Math.PI) / 4)).toBe('3π/4')
    expect(formatPiMultiple(2 * Math.PI)).toBe('2π')
    expect(formatPiMultiple(-Math.PI / 16)).toBe('-π/16')
  })

  it('prefers the smallest denominator that fits', () => {
    // 8π/16 is the same number and a worse sentence.
    expect(formatPiMultiple((8 * Math.PI) / 16)).toBe('π/2')
  })

  it('says nothing rather than something false', () => {
    expect(formatPiMultiple(1.2)).toBeNull()
    expect(formatPiMultiple(Number.NaN)).toBeNull()
  })

  it('is invariant across locales, because it is notation', () => {
    const en = readAngle(HALF_PI, 'en')
    const fr = readAngle(HALF_PI, 'fr')
    expect(en.pi).toBe('π/2')
    expect(fr.pi).toBe('π/2')
    // The radians beside it are not invariant, and must not be.
    expect(en.radians).toBe('1.5708 rad')
    expect(fr.radians).toBe('1,5708 rad')
  })
})

describe('the slider', () => {
  it('round-trips every stop it can reach', () => {
    for (let step = -ANGLE_STEPS; step <= ANGLE_STEPS; step++) {
      expect(toSliderStep(fromSliderStep(step))).toBe(step)
    }
  })

  it('lands on an angle that has a π name at every stop', () => {
    for (let step = -ANGLE_STEPS; step <= ANGLE_STEPS; step++) {
      expect(formatPiMultiple(fromSliderStep(step))).not.toBeNull()
    }
  })

  it('clamps an angle from the field into its own travel', () => {
    expect(toSliderStep(100)).toBe(ANGLE_STEPS)
    expect(toSliderStep(-100)).toBe(-ANGLE_STEPS)
  })

  it('snaps an arbitrary angle to the nearest stop without moving it', () => {
    // The stored value is untouched; only the slider's position rounds.
    expect(toSliderStep(1.2)).toBe(6)
    expect(fromSliderStep(6)).toBeCloseTo((6 * Math.PI) / 16, 12)
  })
})
