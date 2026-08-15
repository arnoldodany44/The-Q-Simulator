/**
 * WCAG relative-luminance and contrast arithmetic.
 *
 * This exists so that "this colour is legible on that surface" is a claim the
 * test suite can check rather than a claim someone made once while looking at
 * a screen. Every ratio quoted in a comment in this codebase came out of these
 * functions, and `verification/design/token-contrast.test.ts` re-derives them
 * from `index.css` on every run — so a token edited six months from now cannot
 * quietly drop a graphic below the threshold.
 *
 * Nothing in the running app imports this module today: the palette is static
 * and its contrast is settled at build time, not at render time. It is a
 * design-system instrument, and it is in `src/` rather than in a script
 * because the thing it measures — the tokens — lives in `src/` too, and a
 * measurement that lives somewhere else is a measurement that goes stale.
 *
 * Units follow CSS rather than the usual 0–1 convention: hue in degrees,
 * saturation and lightness in percent, channels in 0–255. The values in this
 * project are written in `hsl()` and read back out of a stylesheet, and a
 * module that silently rescaled them would make every call site a place to
 * get a factor of a hundred wrong.
 */

export interface Rgb {
  readonly r: number
  readonly g: number
  readonly b: number
}

/**
 * WCAG 2.2 SC 1.4.11 Non-text Contrast: user interface components and "parts
 * of graphics required to understand the content" need 3:1 against what is
 * adjacent to them. Every colour that carries meaning in this app is held to
 * this — see the module header of `phase-colour.ts` for why a histogram bar
 * counts as such a graphic.
 */
export const NON_TEXT_CONTRAST_MINIMUM = 3

/** WCAG 2.2 SC 1.4.3 Contrast (Minimum), AA, for text below 18.66px bold. */
export const TEXT_CONTRAST_MINIMUM = 4.5

/**
 * `hsl()` as CSS defines it. Hue wraps, saturation and lightness clamp — the
 * same forgiveness a browser shows, so a measurement here cannot disagree
 * with what is painted.
 */
export function hslToRgb(
  hue: number,
  saturation: number,
  lightness: number
): Rgb {
  const h = ((hue % 360) + 360) % 360
  const s = clamp(saturation / 100)
  const l = clamp(lightness / 100)

  const chroma = (1 - Math.abs(2 * l - 1)) * s
  const second = chroma * (1 - Math.abs(((h / 60) % 2) - 1))
  const lift = l - chroma / 2

  let r = 0
  let g = 0
  let b = 0
  if (h < 60) {
    r = chroma
    g = second
  } else if (h < 120) {
    r = second
    g = chroma
  } else if (h < 180) {
    g = chroma
    b = second
  } else if (h < 240) {
    g = second
    b = chroma
  } else if (h < 300) {
    r = second
    b = chroma
  } else {
    r = chroma
    b = second
  }

  return {
    r: toChannel(r + lift),
    g: toChannel(g + lift),
    b: toChannel(b + lift),
  }
}

/** `#abc` or `#aabbcc`, with or without the hash. Throws on anything else. */
export function parseHex(hex: string): Rgb {
  const digits = hex.trim().replace(/^#/, '')
  const expanded =
    digits.length === 3
      ? digits
          .split('')
          .map((d) => d + d)
          .join('')
      : digits

  if (!/^[0-9a-fA-F]{6}$/.test(expanded)) {
    throw new Error(`Not a hex colour: ${hex}`)
  }

  const value = Number.parseInt(expanded, 16)
  return {
    r: (value >> 16) & 0xff,
    g: (value >> 8) & 0xff,
    b: value & 0xff,
  }
}

export function formatHex({ r, g, b }: Rgb): string {
  const pair = (channel: number) =>
    Math.round(channel).toString(16).padStart(2, '0')
  return `#${pair(r)}${pair(g)}${pair(b)}`.toUpperCase()
}

/**
 * The hue an arbitrary colour sits at, in degrees.
 *
 * Only used to ask how far the four hand-tuned swatches printed in §10 have
 * drifted from the hue the phase formula assigns them — see
 * `phase-colour.test.ts`. Greys have no hue and answer 0.
 */
export function rgbToHue({ r, g, b }: Rgb): number {
  const red = r / 255
  const green = g / 255
  const blue = b / 255
  const max = Math.max(red, green, blue)
  const span = max - Math.min(red, green, blue)
  if (span === 0) return 0

  let hue: number
  if (max === red) hue = ((green - blue) / span) % 6
  else if (max === green) hue = (blue - red) / span + 2
  else hue = (red - green) / span + 4

  return (((hue * 60) % 360) + 360) % 360
}

/**
 * Relative luminance, WCAG 2.x definition.
 *
 * The 0.04045 knee and the 2.4 exponent are the sRGB transfer function, not
 * a gamma of 2.2: getting that wrong shifts every ratio by a few percent,
 * which is exactly enough to move a borderline colour across a threshold.
 */
export function relativeLuminance({ r, g, b }: Rgb): number {
  return 0.2126 * linearize(r) + 0.7152 * linearize(g) + 0.0722 * linearize(b)
}

/** The (L₁+0.05)/(L₂+0.05) ratio, ordered so the result is always ≥ 1. */
export function contrastRatio(a: Rgb, b: Rgb): number {
  const first = relativeLuminance(a)
  const second = relativeLuminance(b)
  const lighter = Math.max(first, second)
  const darker = Math.min(first, second)
  return (lighter + 0.05) / (darker + 0.05)
}

function linearize(channel: number): number {
  const c = channel / 255
  return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4)
}

function clamp(value: number): number {
  return Math.min(1, Math.max(0, value))
}

function toChannel(value: number): number {
  return Math.round(Math.min(1, Math.max(0, value)) * 255)
}
