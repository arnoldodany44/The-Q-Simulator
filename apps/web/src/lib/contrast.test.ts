import { describe, expect, it } from 'vitest'

import {
  contrastRatio,
  formatHex,
  hslToRgb,
  parseHex,
  relativeLuminance,
  rgbToHue,
} from './contrast'

/**
 * These assertions are against values the WCAG definition fixes, not against
 * this implementation's own output. A contrast module that agrees only with
 * itself would let every ratio quoted elsewhere in the design system be
 * wrong by the same factor and still look verified.
 */
describe('contrast', () => {
  describe('hslToRgb', () => {
    it('produces the primaries at full saturation', () => {
      expect(formatHex(hslToRgb(0, 100, 50))).toBe('#FF0000')
      expect(formatHex(hslToRgb(120, 100, 50))).toBe('#00FF00')
      expect(formatHex(hslToRgb(240, 100, 50))).toBe('#0000FF')
    })

    it('produces the achromatic ends whatever the hue', () => {
      expect(formatHex(hslToRgb(37, 85, 100))).toBe('#FFFFFF')
      expect(formatHex(hslToRgb(37, 85, 0))).toBe('#000000')
      expect(formatHex(hslToRgb(210, 0, 50))).toBe('#808080')
    })

    it('wraps the hue the way CSS does', () => {
      expect(hslToRgb(-120, 85, 66)).toEqual(hslToRgb(240, 85, 66))
      expect(hslToRgb(400, 85, 66)).toEqual(hslToRgb(40, 85, 66))
    })

    it('clamps saturation and lightness rather than extrapolating', () => {
      expect(hslToRgb(0, 400, 50)).toEqual(hslToRgb(0, 100, 50))
      expect(hslToRgb(0, 85, -20)).toEqual(hslToRgb(0, 85, 0))
    })
  })

  describe('parseHex', () => {
    it('reads both lengths, with or without the hash', () => {
      expect(parseHex('#abc')).toEqual({ r: 0xaa, g: 0xbb, b: 0xcc })
      expect(parseHex('141833')).toEqual({ r: 0x14, g: 0x18, b: 0x33 })
      expect(parseHex('  #F5445E  ')).toEqual({ r: 245, g: 68, b: 94 })
    })

    it('refuses anything that is not a colour', () => {
      expect(() => parseHex('#12345')).toThrow()
      expect(() => parseHex('rebeccapurple')).toThrow()
      expect(() => parseHex('')).toThrow()
    })
  })

  describe('rgbToHue', () => {
    it('recovers the hue it was built from', () => {
      for (const hue of [0, 45, 90, 180, 240, 300, 359]) {
        expect(rgbToHue(hslToRgb(hue, 85, 66))).toBeCloseTo(hue, 0)
      }
    })

    it('answers zero for a grey, which has no hue', () => {
      expect(rgbToHue({ r: 128, g: 128, b: 128 })).toBe(0)
    })
  })

  describe('relativeLuminance', () => {
    it('spans exactly zero to one', () => {
      expect(relativeLuminance({ r: 0, g: 0, b: 0 })).toBe(0)
      expect(relativeLuminance({ r: 255, g: 255, b: 255 })).toBe(1)
    })

    it('applies the sRGB transfer curve, not a plain gamma', () => {
      // Mid grey is 21.6% of white's luminance, not 50%. A 2.2 gamma would
      // answer 0.2176 here; the difference is small and is exactly the kind
      // of small that moves a borderline colour across a threshold.
      expect(relativeLuminance({ r: 128, g: 128, b: 128 })).toBeCloseTo(
        0.2159,
        4
      )
    })
  })

  describe('contrastRatio', () => {
    it('is 21:1 black on white and 1:1 for a colour on itself', () => {
      const white = parseHex('#FFFFFF')
      const black = parseHex('#000000')
      expect(contrastRatio(white, black)).toBeCloseTo(21, 10)
      expect(contrastRatio(white, white)).toBe(1)
    })

    it('is symmetric', () => {
      const a = parseHex('#5F5FF2')
      const b = parseHex('#141833')
      expect(contrastRatio(a, b)).toBe(contrastRatio(b, a))
    })

    it('matches the reference greys WCAG is usually calibrated against', () => {
      const white = parseHex('#FFFFFF')
      // #767676 is the darkest grey that still passes 4.5:1 on white, and
      // #949494 the darkest that passes 3:1 — the two numbers every contrast
      // checker is spot-checked with.
      expect(contrastRatio(parseHex('#767676'), white)).toBeCloseTo(4.54, 2)
      expect(contrastRatio(parseHex('#949494'), white)).toBeCloseTo(3.03, 2)
    })
  })
})
