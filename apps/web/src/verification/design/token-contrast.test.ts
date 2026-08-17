/**
 * Contrast, measured against the stylesheet that ships.
 *
 * Every ratio quoted in a comment in `index.css` or in `lib/phase-colour.ts`
 * is re-derived here from the actual token values, read out of `index.css` at
 * test time. Nothing is duplicated into TypeScript: a palette written down
 * twice is a palette that will disagree with itself, and the failure mode of
 * that disagreement is a colour that passes an audit in a constants file and
 * fails on screen.
 *
 * What this suite is really for is the edit six months from now. Somebody
 * nudges `--bg-panel` two shades lighter because a card looked flat, and the
 * phase circle quietly loses a hue. That is not a thing anyone notices by
 * looking, because the hue that fails is one of 2ⁿ amplitudes and it fails by
 * a tenth of a point. It is a thing a sweep notices immediately.
 */
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { describe, expect, it } from 'vitest'

import {
  NON_TEXT_CONTRAST_MINIMUM,
  TEXT_CONTRAST_MINIMUM,
  contrastRatio,
  hslToRgb,
  parseHex,
  type Rgb,
} from '../../lib/contrast'
import {
  COLLABORATOR_HUES,
  COLLAB_LIGHTNESS_PERCENT,
  COLLAB_SATURATION_PERCENT,
} from '../../lib/collab-colour'
import {
  PHASE_LIGHTNESS_PERCENT,
  PHASE_SATURATION_PERCENT,
  TAU,
  phaseToColour,
  phaseToHue,
} from '../../lib/phase-colour'

/*
 * The stylesheet is read as a file rather than imported.
 *
 * Two Vite behaviours rule the obvious routes out, and both fail quietly
 * enough to be worth naming: `import css from '…/index.css?raw'` returns an
 * empty string, because Vitest stubs CSS modules unless `test.css` is turned
 * on, and `new URL('…/index.css', import.meta.url)` is rewritten by Vite into
 * an asset URL that is no longer a `file:` URL by the time Node sees it.
 * Building the path from `fileURLToPath` avoids both — nothing here is a
 * pattern Vite claims.
 */
const here = dirname(fileURLToPath(import.meta.url))
const css = readFileSync(join(here, '..', '..', 'index.css'), 'utf8')

/*
 * Comments go first. `index.css` explains its own contrast decisions in
 * prose, and that prose is full of things like "9.17:1 on --bg-panel: focus
 * is …" — which a naive declaration regex reads as a token definition.
 */
const declarations = css.replace(/\/\*[\s\S]*?\*\//g, '')

/** A `--token`'s value, following `var()` indirection to a literal. */
function token(name: string, seen = new Set<string>()): string {
  if (seen.has(name)) throw new Error(`Token --${name} refers to itself`)
  seen.add(name)

  const match = new RegExp(`--${name}:\\s*([^;]+);`).exec(declarations)
  const value = match?.[1]?.trim()
  if (!value) throw new Error(`Token --${name} is not declared in index.css`)

  const indirect = /^var\(\s*--([\w-]+)\s*\)$/.exec(value)
  return indirect?.[1] ? token(indirect[1], seen) : value
}

const colour = (name: string): Rgb => parseHex(token(name))

/** The three backgrounds anything meaningful is ever drawn on. */
const SURFACES = ['bg-deep', 'bg-panel', 'bg-elevated'] as const

/**
 * Quarter-degree steps. The worst hue on this palette sits at 239.75°, which
 * a whole-degree sweep steps straight over — the difference between 240° and
 * 239.75° is 0.003 of a ratio here, but the habit of sampling a continuous
 * encoding at the round numbers is how a failing region gets missed.
 */
const HUE_STEP = 0.25

function sweepHues(): number[] {
  const hues: number[] = []
  for (let hue = 0; hue < 360; hue += HUE_STEP) hues.push(hue)
  return hues
}

function phaseColourAt(hue: number): Rgb {
  return hslToRgb(hue, PHASE_SATURATION_PERCENT, PHASE_LIGHTNESS_PERCENT)
}

describe('the stylesheet and the phase module agree', () => {
  it('composes the same saturation and lightness in both languages', () => {
    // index.css builds `hsl(var(--phase-hue) …)` from these two; phase-colour
    // .ts builds the same string in TypeScript. If they drift, an SVG fill
    // and its CSS-styled neighbour become two slightly different colours for
    // the same phase, which reads as a rendering bug and is a token bug.
    expect(token('phase-saturation')).toBe(`${PHASE_SATURATION_PERCENT}%`)
    expect(token('phase-lightness')).toBe(`${PHASE_LIGHTNESS_PERCENT}%`)
  })

  it('produces the colour the CSS utilities would compose', () => {
    for (const phase of [0, 1, Math.PI / 2, Math.PI, 5.5]) {
      const hue = Math.round(phaseToHue(phase) * 100) / 100
      const composed = `hsl(${hue} ${token('phase-saturation')} ${token('phase-lightness')})`
      expect(phaseToColour(phase)).toBe(composed)
    }
  })
})

describe('phase colours clear 3:1 on every surface, at every phase', () => {
  /*
   * WCAG 2.2 SC 1.4.11. A histogram bar is a "graphical object required to
   * understand the content" on two counts at once: its hue is the phase, and
   * its boundary against the card is what makes its height — the probability
   * — readable at all. §10's own table of four swatches cannot catch this;
   * the failing region is near 240°, and no anchor sits there.
   */
  for (const surface of SURFACES) {
    it(`on --${surface}`, () => {
      const background = colour(surface)
      let worst = Number.POSITIVE_INFINITY
      let worstHue = 0

      for (const hue of sweepHues()) {
        const ratio = contrastRatio(phaseColourAt(hue), background)
        if (ratio < worst) {
          worst = ratio
          worstHue = hue
        }
      }

      expect(
        worst,
        `worst phase hue on --${surface} is ${worstHue}° at ${worst.toFixed(2)}:1`
      ).toBeGreaterThanOrEqual(NON_TEXT_CONTRAST_MINIMUM)
    })
  }

  it('would have failed at the 62% lightness §10 first printed', () => {
    // The regression this milestone fixed, kept as a test so the correction
    // cannot be undone by someone restoring the specification's literal
    // number without re-measuring.
    const at62 = contrastRatio(
      hslToRgb(240, PHASE_SATURATION_PERCENT, 62),
      colour('bg-panel')
    )
    expect(at62).toBeLessThan(NON_TEXT_CONTRAST_MINIMUM)
  })
})

describe('marks drawn on top of a phase colour', () => {
  it('--phase-ink is legible against every hue on the circle', () => {
    // The phasor arrow. It is the primary encoding of phase, so it may not
    // disappear at any point of the circle — which is exactly what a light
    // ink does against the yellows near 60°.
    const ink = colour('phase-ink')
    let worst = Number.POSITIVE_INFINITY
    let worstHue = 0

    for (const hue of sweepHues()) {
      const ratio = contrastRatio(ink, phaseColourAt(hue))
      if (ratio < worst) {
        worst = ratio
        worstHue = hue
      }
    }

    expect(
      worst,
      `worst hue under the phase ink is ${worstHue}° at ${worst.toFixed(2)}:1`
    ).toBeGreaterThanOrEqual(NON_TEXT_CONTRAST_MINIMUM)
  })

  it('rules out --text as that ink, which is why the token exists', () => {
    // 1.00:1 against the yellow at 60°: a phasor drawn in the body text
    // colour would be invisible over a quarter of the phase circle.
    const worstForLightInk = Math.min(
      ...sweepHues().map((hue) =>
        contrastRatio(colour('text'), phaseColourAt(hue))
      )
    )
    expect(worstForLightInk).toBeLessThan(NON_TEXT_CONTRAST_MINIMUM)
  })
})

describe('the diff marks inherit the phase circle’s proof (M1.4b)', () => {
  const DIFF_HUES = [
    'diff-added-hue',
    'diff-removed-hue',
    'diff-moved-hue',
    'diff-changed-hue',
  ] as const

  /*
   * The sweep above proves that *every* hue at --phase-saturation and
   * --phase-lightness clears 3:1 on all three surfaces. The diff marks are
   * declared as bare hues composed against those two tokens precisely so they
   * inherit that result instead of each needing its own measurement — so what
   * is worth asserting is that they really are bare hues, and that nobody has
   * quietly given one of them a lightness of its own.
   */
  it.each(DIFF_HUES)('--%s is a plain hue, not a colour', (name) => {
    const value = token(name)
    expect(value, `--${name} should be a number of degrees`).toMatch(
      /^\d+(\.\d+)?$/
    )
  })

  it('clears 3:1 on every surface, as the sweep guarantees', () => {
    for (const name of DIFF_HUES) {
      const mark = hslToRgb(
        Number(token(name)),
        PHASE_SATURATION_PERCENT,
        PHASE_LIGHTNESS_PERCENT
      )
      for (const surface of SURFACES) {
        const ratio = contrastRatio(mark, colour(surface))
        expect(
          ratio,
          `--${name} on --${surface} is ${ratio.toFixed(2)}:1`
        ).toBeGreaterThanOrEqual(NON_TEXT_CONTRAST_MINIMUM)
      }
    }
  })

  it('keeps the four hues far enough apart to be four colours', () => {
    // Colour is the *last* of the three carriers — the silhouette and the
    // dash pattern come first — but a reader who does see colour should not
    // have to squint either. Sixty degrees is comfortably past the point two
    // hues read as one.
    const hues = DIFF_HUES.map((name) => Number(token(name))).sort(
      (left, right) => left - right
    )
    for (let index = 1; index < hues.length; index += 1) {
      const gap = (hues[index] ?? 0) - (hues[index - 1] ?? 0)
      expect(
        gap,
        `hues ${hues[index - 1]}° and ${hues[index]}°`
      ).toBeGreaterThan(40)
    }
  })
})

describe('a collaborator is not a datum (M5.3)', () => {
  /*
   * Every other borrowed colour in this system — the four diff marks, the two
   * noise directions — is a bare hue at the phase saturation and lightness, and
   * inherits the sweep above. A collaborator's cursor may not, because it is drawn
   * on the canvas at the same time as the histogram: a caret at the phase
   * saturation and lightness is not *like* an amplitude's colour, it is the colour
   * of a particular phase, next to that phase, meaning something else.
   *
   * So the separation is on the two axes the wheel does not use, and this is where
   * that claim is measured rather than asserted. `lib/collab-colour.ts` owns the
   * eight hues (only a client knows a peer id, so only a client can pick one) and
   * `index.css` owns the pair they are composed against; both are checked here,
   * against each other and against the phase pair.
   */
  it('composes the same saturation and lightness in both languages', () => {
    expect(token('collab-saturation')).toBe(`${COLLAB_SATURATION_PERCENT}%`)
    expect(token('collab-lightness')).toBe(`${COLLAB_LIGHTNESS_PERCENT}%`)
  })

  it('does not use the phase circle’s saturation or lightness', () => {
    expect(token('collab-saturation')).not.toBe(token('phase-saturation'))
    expect(token('collab-lightness')).not.toBe(token('phase-lightness'))
  })

  it('clears 7:1 on every surface, at every collaborator hue', () => {
    // Twice what the phase circle owes, because a presence mark is a one-pixel
    // outline and not a bar: a hairline at 3:1 disappears against a busy canvas.
    for (const hue of COLLABORATOR_HUES) {
      const mark = hslToRgb(
        hue,
        COLLAB_SATURATION_PERCENT,
        COLLAB_LIGHTNESS_PERCENT
      )
      for (const surface of SURFACES) {
        const ratio = contrastRatio(mark, colour(surface))
        expect(
          ratio,
          `${hue}° on --${surface} is ${ratio.toFixed(2)}:1`
        ).toBeGreaterThanOrEqual(7)
      }
    }
  })

  it('prints a name on that colour at AA, in --collab-ink', () => {
    const ink = colour('collab-ink')
    for (const hue of COLLABORATOR_HUES) {
      const chip = hslToRgb(
        hue,
        COLLAB_SATURATION_PERCENT,
        COLLAB_LIGHTNESS_PERCENT
      )
      const ratio = contrastRatio(ink, chip)
      expect(
        ratio,
        `--collab-ink on ${hue}° is ${ratio.toFixed(2)}:1`
      ).toBeGreaterThanOrEqual(TEXT_CONTRAST_MINIMUM)
    }
  })

  it('would not be legible as a hairline at the phase circle’s lightness', () => {
    // The regression this palette exists to avoid, kept as a test: at 85%/66% the
    // worst collaborator hue is barely past the non-text minimum, which is fine
    // for a filled bar and not for a 1px outline.
    const worst = Math.min(
      ...COLLABORATOR_HUES.map((hue) =>
        contrastRatio(
          hslToRgb(hue, PHASE_SATURATION_PERCENT, PHASE_LIGHTNESS_PERCENT),
          colour('bg-elevated')
        )
      )
    )
    expect(worst).toBeLessThan(7)
  })
})

describe('the interface palette', () => {
  it('reads text at AA on every surface', () => {
    for (const surface of SURFACES) {
      for (const ink of ['text', 'text-muted', 'accent'] as const) {
        const ratio = contrastRatio(colour(ink), colour(surface))
        expect(
          ratio,
          `--${ink} on --${surface} is ${ratio.toFixed(2)}:1`
        ).toBeGreaterThanOrEqual(TEXT_CONTRAST_MINIMUM)
      }
    }
  })

  it('keeps the focus ring far above the minimum', () => {
    // Focus is the indicator a keyboard user navigates by. It is held to the
    // text threshold rather than the 3:1 a non-text indicator owes, because
    // being merely legible is not the same as being findable.
    for (const surface of SURFACES) {
      expect(
        contrastRatio(colour('focus-ring'), colour(surface))
      ).toBeGreaterThanOrEqual(TEXT_CONTRAST_MINIMUM)
    }
  })

  /*
   * --wire draws the qubit wires and the borders of the palette chips and
   * toolbar buttons. §10 records why it diverges from the hex the document
   * first printed, and the surfaces it is measured against are the two it is
   * actually drawn on. It is deliberately *not* asserted against
   * --bg-elevated (2.87:1): there it is the boundary of a control whose fill
   * is that colour, and the adjacent background a boundary owes contrast to
   * is the one outside it.
   */
  it('draws wires and control borders at 3:1 on the surfaces they sit on', () => {
    for (const surface of ['bg-deep', 'bg-panel'] as const) {
      const ratio = contrastRatio(colour('wire'), colour(surface))
      expect(
        ratio,
        `--wire on --${surface} is ${ratio.toFixed(2)}:1`
      ).toBeGreaterThanOrEqual(NON_TEXT_CONTRAST_MINIMUM)
    }
  })

  it('separates the chart track from the card by a hairline, not by fill', () => {
    // Stated as a test because it is a design decision that looks like an
    // oversight: --chart-track on --bg-panel is far below 3:1 on purpose,
    // and --chart-grid is what carries the boundary.
    expect(
      contrastRatio(colour('chart-track'), colour('bg-panel'))
    ).toBeLessThan(NON_TEXT_CONTRAST_MINIMUM)
    expect(
      contrastRatio(colour('chart-grid'), colour('bg-panel'))
    ).toBeGreaterThanOrEqual(NON_TEXT_CONTRAST_MINIMUM)
  })
})

describe('the phase circle is continuous', () => {
  it('never jumps in colour between neighbouring phases', () => {
    // The reason the shipped mapping is the formula and not an interpolation
    // through §10's four hand-tuned swatches: one saturation and one
    // lightness for the whole circle means equal phase differences look
    // equal. A step of TAU/720 may not move any channel by more than a hair.
    const step = TAU / 720
    for (let phase = 0; phase < TAU; phase += step) {
      const here = phaseColourAt(phaseToHue(phase))
      const next = phaseColourAt(phaseToHue(phase + step))
      const jump = Math.max(
        Math.abs(here.r - next.r),
        Math.abs(here.g - next.g),
        Math.abs(here.b - next.b)
      )
      expect(jump).toBeLessThanOrEqual(4)
    }
  })
})
