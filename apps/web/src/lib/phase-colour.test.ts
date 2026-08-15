import { describe, expect, it } from 'vitest'

import { formatHex, hslToRgb, parseHex, rgbToHue } from './contrast'
import {
  ANCHOR_HUE_TOLERANCE_DEGREES,
  PHASE_ANCHORS,
  PHASE_LIGHTNESS_PERCENT,
  PHASE_SATURATION_PERCENT,
  TAU,
  normalizePhase,
  phaseToColour,
  phaseToDegrees,
  phaseToHue,
  phasorDirection,
  phasorRotation,
} from './phase-colour'

/** D6: Float64 everywhere, 1e-10 in tests. */
const TOLERANCE = 1e-10

describe('normalizePhase', () => {
  it('lands every input in [0, 2π)', () => {
    const inputs = [
      0,
      1e-12,
      Math.PI,
      TAU,
      -TAU,
      -Math.PI / 2,
      1000 * Math.PI,
      -1000 * Math.PI,
      -1e-18,
      1e18,
    ]
    for (const input of inputs) {
      const wrapped = normalizePhase(input)
      expect(wrapped).toBeGreaterThanOrEqual(0)
      expect(wrapped).toBeLessThan(TAU)
    }
  })

  it('agrees on -π/2 and 3π/2 — the same phase written two ways', () => {
    expect(normalizePhase(-Math.PI / 2)).toBe(normalizePhase((3 * Math.PI) / 2))
    expect(phaseToHue(-Math.PI / 2)).toBe(270)
    expect(phaseToHue((3 * Math.PI) / 2)).toBe(270)
  })

  it('folds a whole turn away', () => {
    for (const turns of [-3, -1, 1, 2, 7]) {
      expect(normalizePhase(Math.PI / 3 + turns * TAU)).toBeCloseTo(
        Math.PI / 3,
        10
      )
    }
  })

  /*
   * A phase a hair below zero — the shape a rounding artefact out of atan2
   * takes — wraps to a value Float64 cannot distinguish from 2π. Left
   * unguarded it escapes the half-open interval and hands the hue 360°,
   * which is 0° painted by a longer route but is also outside the range the
   * signature promises.
   */
  it('folds a negative epsilon to zero rather than to 2π', () => {
    expect(normalizePhase(-1e-18)).toBe(0)
    expect(phaseToHue(-1e-18)).toBe(0)
  })

  it('answers zero for a phase that is not a number', () => {
    // A NaN amplitude must degrade to one wrong bar, never to a chart that
    // throws on the way to being painted.
    expect(normalizePhase(Number.NaN)).toBe(0)
    expect(normalizePhase(Number.POSITIVE_INFINITY)).toBe(0)
    expect(normalizePhase(Number.NEGATIVE_INFINITY)).toBe(0)
    expect(phaseToColour(Number.NaN)).toBe(phaseToColour(0))
  })
})

describe('phaseToHue', () => {
  it('hits the four cardinal hues exactly', () => {
    expect(phaseToHue(0)).toBe(0)
    expect(phaseToHue(Math.PI / 2)).toBe(90)
    expect(phaseToHue(Math.PI)).toBe(180)
    expect(phaseToHue((3 * Math.PI) / 2)).toBe(270)
  })

  it('is the phase in degrees, by construction and not by coincidence', () => {
    // §10's idea in one assertion: the hue wheel and the phase circle are
    // the same circle, so these two readings can never drift apart.
    for (let phase = -TAU; phase < 2 * TAU; phase += 0.01) {
      expect(phaseToHue(phase)).toBe(phaseToDegrees(phase))
    }
  })

  it('stays inside [0, 360)', () => {
    for (let phase = -20; phase < 20; phase += 0.001) {
      const hue = phaseToHue(phase)
      expect(hue).toBeGreaterThanOrEqual(0)
      expect(hue).toBeLessThan(360)
    }
  })
})

describe('phaseToColour', () => {
  it('is a stable mapping', () => {
    // Frozen output. If a token below changes, this test is where the change
    // has to be argued for, rather than being discovered on screen.
    expect(phaseToColour(0)).toBe('hsl(0 85% 66%)')
    expect(phaseToColour(Math.PI / 2)).toBe('hsl(90 85% 66%)')
    expect(phaseToColour(Math.PI)).toBe('hsl(180 85% 66%)')
    expect(phaseToColour((3 * Math.PI) / 2)).toBe('hsl(270 85% 66%)')
  })

  it('rounds the hue instead of printing seventeen figures of it', () => {
    expect(phaseToColour(1)).toBe('hsl(57.3 85% 66%)')
  })

  it('uses the space-separated syntax index.css composes with', () => {
    // A comma-separated hsl() cannot take a bare custom property as its hue,
    // so `hsl(var(--phase-hue) …)` and this string have to share a syntax.
    expect(phaseToColour(0.5)).not.toContain(',')
  })
})

describe('§10 anchors', () => {
  it('assigns each cardinal phase the hue the table prints', () => {
    for (const anchor of PHASE_ANCHORS) {
      expect(phaseToHue(anchor.phase)).toBeCloseTo(anchor.hue, 10)
    }
  })

  /*
   * §10 says the four swatches "come out of the formula". Measured, they are
   * hand-tuned: same colour family, up to 10.4° of hue away and with their
   * own saturation and lightness. The formula is what ships (see the module
   * header); this test pins how far apart the two are allowed to be, so a
   * future re-tuning of either has to move a number on purpose.
   */
  it('stays within the measured hue distance of the printed swatches', () => {
    for (const anchor of PHASE_ANCHORS) {
      const specimenHue = rgbToHue(parseHex(anchor.specimen))
      const separation = Math.abs(
        ((specimenHue - anchor.hue + 540) % 360) - 180
      )
      expect(separation).toBeLessThanOrEqual(ANCHOR_HUE_TOLERANCE_DEGREES)
    }
  })

  it('derives the shipped swatches', () => {
    const derived = PHASE_ANCHORS.map((anchor) =>
      formatHex(
        hslToRgb(
          phaseToHue(anchor.phase),
          PHASE_SATURATION_PERCENT,
          PHASE_LIGHTNESS_PERCENT
        )
      )
    )
    expect(derived).toEqual(['#F25F5F', '#A8F25F', '#5FF2F2', '#A85FF2'])
  })
})

describe('the phasor, which is the encoding colour only reinforces', () => {
  it('points along the complex plane, flipped into SVG coordinates', () => {
    const cases: ReadonlyArray<[number, number, number]> = [
      [0, 1, 0],
      [Math.PI / 2, 0, -1], // +i is up on screen, so y is negative
      [Math.PI, -1, 0],
      [(3 * Math.PI) / 2, 0, 1],
    ]
    for (const [phase, x, y] of cases) {
      const direction = phasorDirection(phase)
      expect(direction.x).toBeCloseTo(x, 10)
      expect(direction.y).toBeCloseTo(y, 10)
    }
  })

  it('is always a unit vector', () => {
    for (let phase = -7; phase < 7; phase += 0.017) {
      const { x, y } = phasorDirection(phase)
      expect(Math.hypot(x, y)).toBeCloseTo(1, 10)
    }
  })

  it('distinguishes opposite phases, which is the whole point', () => {
    // Destructive interference has to be visible without colour vision: two
    // phasors π apart must point in opposite directions, not merely in
    // complementary hues.
    for (const phase of [0, 0.3, 1.2, Math.PI / 2, 2.9]) {
      const a = phasorDirection(phase)
      const b = phasorDirection(phase + Math.PI)
      expect(a.x + b.x).toBeCloseTo(0, 10)
      expect(a.y + b.y).toBeCloseTo(0, 10)
    }
  })

  it('gives a rotation that lands an SVG marker on that direction', () => {
    // SVG rotate() turns clockwise in a y-down space: (1,0) maps to
    // (cos a, sin a). Composing that with phasorRotation has to reproduce
    // phasorDirection exactly, or the arrow and the maths disagree.
    for (let phase = 0; phase < TAU; phase += 0.05) {
      const angle = (phasorRotation(phase) * Math.PI) / 180
      const direction = phasorDirection(phase)
      expect(Math.cos(angle)).toBeCloseTo(direction.x, 10)
      expect(Math.sin(angle)).toBeCloseTo(direction.y, 10)
    }
  })

  it('stays inside [0, 360)', () => {
    for (let phase = -10; phase < 10; phase += 0.013) {
      const rotation = phasorRotation(phase)
      expect(rotation).toBeGreaterThanOrEqual(0)
      expect(rotation).toBeLessThan(360)
    }
  })

  it('reads the cardinal phases as quarter turns', () => {
    expect(phasorRotation(0)).toBe(0)
    expect(phasorRotation(Math.PI / 2)).toBe(270)
    expect(phasorRotation(Math.PI)).toBe(180)
    expect(phasorRotation((3 * Math.PI) / 2)).toBe(90)
  })
})

describe('the numeric reading, which is the encoding for no vision at all', () => {
  it('is available in both units without recomputing a phase', () => {
    const phase = Math.PI / 3
    expect(phaseToDegrees(phase)).toBeCloseTo(60, 10)
    expect(normalizePhase(phase)).toBeCloseTo(Math.PI / 3, 10)
  })

  it('formats through the active locale, decimal comma included', () => {
    // Not an assertion about this module — it has no opinion on formatting —
    // but a guard on the contract it hands the panel: the number that goes
    // beside the phasor is locale-formatted, and French writes 60,5.
    const degrees = phaseToDegrees(1.056)
    expect(
      new Intl.NumberFormat('fr', { maximumFractionDigits: 1 }).format(degrees)
    ).toBe('60,5')
    expect(
      new Intl.NumberFormat('en', { maximumFractionDigits: 1 }).format(degrees)
    ).toBe('60.5')
    expect(
      new Intl.NumberFormat('es', { maximumFractionDigits: 1 }).format(degrees)
    ).toBe('60,5')
  })

  it('agrees with the tolerance the engine is tested to', () => {
    expect(Math.abs(phaseToDegrees(Math.PI) - 180)).toBeLessThan(TOLERANCE)
  })
})
