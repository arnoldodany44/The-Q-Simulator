import { describe, expect, it } from 'vitest'

import {
  COLLABORATOR_HUES,
  COLLAB_LIGHTNESS_PERCENT,
  COLLAB_SATURATION_PERCENT,
  collaboratorColour,
  collaboratorHue,
} from './collab-colour'
import {
  NON_TEXT_CONTRAST_MINIMUM,
  TEXT_CONTRAST_MINIMUM,
  contrastRatio,
  hslToRgb,
  parseHex,
} from './contrast'
import {
  PHASE_LIGHTNESS_PERCENT,
  PHASE_SATURATION_PERCENT,
} from './phase-colour'

/**
 * The three claims the module header makes, each as a test.
 *
 * The interesting one is the *derivation* of the hue offset: the number 27.5 is
 * not a preference, it is the argument maximum of a function this file recomputes.
 * Somebody who nudges it to a rounder value is changing a measured answer, and
 * that should fail rather than merely differ.
 */

/** The surfaces anything meaningful in this app is drawn on. */
const SURFACES = ['#0b0e1f', '#141833', '#1c2145'] as const

/**
 * The hues §10 has already given a meaning: the four phase anchors, the four
 * version-diff marks, the two noise directions.
 */
const MEANINGFUL_HUES = [0, 90, 180, 270, 45, 100, 275] as const

function collabAt(hue: number) {
  return hslToRgb(hue, COLLAB_SATURATION_PERCENT, COLLAB_LIGHTNESS_PERCENT)
}

function hueGap(a: number, b: number): number {
  const raw = Math.abs(((a - b) % 360) + 360) % 360
  return Math.min(raw, 360 - raw)
}

describe('a collaborator colour is not a datum colour', () => {
  it('uses neither the phase saturation nor its lightness', () => {
    // The load-bearing half of the separation. The hue circle is continuous, so
    // there is no hue a phase does not also occupy — what makes a caret read as
    // an annotation rather than as an amplitude is that it is paler and lighter.
    expect(COLLAB_SATURATION_PERCENT).not.toBe(PHASE_SATURATION_PERCENT)
    expect(COLLAB_LIGHTNESS_PERCENT).not.toBe(PHASE_LIGHTNESS_PERCENT)
    expect(
      PHASE_SATURATION_PERCENT - COLLAB_SATURATION_PERCENT
    ).toBeGreaterThanOrEqual(20)
    expect(
      COLLAB_LIGHTNESS_PERCENT - PHASE_LIGHTNESS_PERCENT
    ).toBeGreaterThanOrEqual(10)
  })

  it('keeps every hue clear of every hue that already means something', () => {
    for (const hue of COLLABORATOR_HUES) {
      for (const taken of MEANINGFUL_HUES) {
        expect(
          hueGap(hue, taken),
          `${hue}° is too close to ${taken}°`
        ).toBeGreaterThanOrEqual(17.5)
      }
    }
  })

  it('re-derives the 27.5° offset rather than trusting it', () => {
    /*
     * Eight hues 45° apart are one number: the offset. This sweeps every offset a
     * quarter of a degree apart and asserts that the shipped one is the argument
     * maximum of "distance from the nearest hue that already means something".
     * There is no tie — 27.5° is the midpoint between 10° and 45° modulo 45, and
     * every other candidate is strictly worse.
     */
    const spacing = 360 / COLLABORATOR_HUES.length
    let best = -1
    let bestOffset = -1
    for (let offset = 0; offset < spacing; offset += 0.25) {
      const hues = COLLABORATOR_HUES.map((_, index) => offset + index * spacing)
      const worst = Math.min(
        ...hues.flatMap((hue) =>
          MEANINGFUL_HUES.map((taken) => hueGap(hue, taken))
        )
      )
      if (worst > best) {
        best = worst
        bestOffset = offset
      }
    }

    expect(bestOffset).toBe(COLLABORATOR_HUES[0])
    expect(best).toBe(17.5)
  })

  it('keeps the eight far enough apart to be eight colours', () => {
    for (let index = 1; index < COLLABORATOR_HUES.length; index += 1) {
      const gap = hueGap(
        COLLABORATOR_HUES[index] as number,
        COLLABORATOR_HUES[index - 1] as number
      )
      expect(gap).toBe(45)
    }
  })
})

describe('a presence mark is a hairline, so it is held above 3:1', () => {
  it('clears 7:1 on every surface, at every collaborator hue', () => {
    /*
     * The phase circle is held to `NON_TEXT_CONTRAST_MINIMUM` because a histogram
     * bar is tens of pixels of fill. A cursor is a one-pixel outline and a caret,
     * and a hairline at 3:1 disappears against a busy canvas — so this palette is
     * held to more than twice the minimum, which is what being pale buys.
     */
    let worst = Number.POSITIVE_INFINITY
    let where = ''
    for (const hue of COLLABORATOR_HUES) {
      for (const surface of SURFACES) {
        const ratio = contrastRatio(collabAt(hue), parseHex(surface))
        if (ratio < worst) {
          worst = ratio
          where = `${hue}° on ${surface}`
        }
      }
    }

    expect(
      worst,
      `worst is ${where} at ${worst.toFixed(2)}:1`
    ).toBeGreaterThanOrEqual(7)
    expect(worst).toBeGreaterThanOrEqual(NON_TEXT_CONTRAST_MINIMUM)
  })

  it('carries a name label at AA with the deep background as ink', () => {
    // The label is printed *on* the colour, so it is text on a light chip. --bg-deep
    // is the ink for the same reason it is the phasor's: no light ink survives a
    // pale yellow.
    for (const hue of COLLABORATOR_HUES) {
      const ratio = contrastRatio(parseHex('#0b0e1f'), collabAt(hue))
      expect(
        ratio,
        `label ink on ${hue}° is ${ratio.toFixed(2)}:1`
      ).toBeGreaterThanOrEqual(TEXT_CONTRAST_MINIMUM)
    }
  })
})

describe('which colour a peer gets', () => {
  it('is stable for a peer and independent of who else is here', () => {
    const first = collaboratorColour('peer-ada')
    expect(collaboratorColour('peer-ada')).toBe(first)
    // Nothing about the call depends on the rest of the roster, which is the
    // property a server-assigned slot would not have across two replicas.
    expect(collaboratorColour('peer-beto')).not.toBe(undefined)
    expect(collaboratorColour('peer-ada')).toBe(first)
  })

  it('answers a hue from the palette, whatever the id looks like', () => {
    const ids = [
      '',
      'a',
      'peer-1',
      '00000000-0000-4000-8000-000000000000',
      'x'.repeat(64),
      '🙂',
    ]
    for (const id of ids) {
      expect(COLLABORATOR_HUES).toContain(collaboratorHue(id))
    }
  })

  it('spreads real peer ids over the whole palette', () => {
    // Not a claim about uniqueness — eight colours cannot distinguish sixteen
    // peers, which is why a name is always attached — but a hash that answered
    // one hue for every UUID would make the palette decorative.
    const used = new Set<number>()
    for (let index = 0; index < 200; index += 1) {
      used.add(
        collaboratorHue(
          `8f14e45f-ea3f-4f2b-9c2e-${String(index).padStart(12, '0')}`
        )
      )
    }
    expect(used.size).toBe(COLLABORATOR_HUES.length)
  })

  it('composes the value the stylesheet composes', () => {
    expect(collaboratorColour('peer-ada')).toBe(
      `hsl(${collaboratorHue('peer-ada')} ${COLLAB_SATURATION_PERCENT}% ${COLLAB_LIGHTNESS_PERCENT}%)`
    )
  })
})
