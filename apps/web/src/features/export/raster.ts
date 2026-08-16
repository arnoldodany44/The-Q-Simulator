/**
 * The SVG diagram, rasterised to PNG in the browser.
 *
 * The route is the standard one and every step of it is load-bearing:
 *
 *   1. the SVG becomes a `data:` URL rather than a `blob:` one. Both load,
 *      but only a same-origin-clean source leaves the canvas untainted — and a
 *      tainted canvas makes `toBlob` throw a `SecurityError` at the last step,
 *      which is a confusing place to discover the problem;
 *   2. the image is drawn into a canvas whose pixel size is the diagram's
 *      user-unit size times `scale`, so the vector is re-rendered at that
 *      resolution rather than a 1× bitmap being stretched;
 *   3. `toBlob` rather than `toDataURL`, because the result goes straight into
 *      `saveFile` and a base64 round trip of a megabyte image is pure waste.
 *
 * ── THE SCALE, AND WHY 2 ─────────────────────────────────────────────────
 *
 * A PNG has to choose a resolution the SVG did not need to. 2× is the choice:
 * it is the density of every retina and most laptop screens, so a diagram
 * pasted into a slide, an issue or a chat looks sharp rather than soft, and it
 * is the same factor a screenshot of the app would have. It also stays well
 * inside what browsers will allocate — the widest circuit this editor draws
 * (96 columns × 20 wires) is about 5 400 × 1 050 user units, which is
 * 10 800 × 2 100 device pixels at 2×, under both Chrome's 16 384-pixel
 * dimension limit and Safari's area limit. Callers may ask for more; 4× on
 * that same circuit is 21 600 pixels wide and would fail, so the cap below
 * refuses rather than handing back a blank image, which is what an
 * over-large canvas silently produces.
 */

import type { Diagram } from './diagram'

/** Device pixels per user unit, unless the caller says otherwise. */
export const DEFAULT_PNG_SCALE = 2

/**
 * The largest dimension a canvas is asked for. Chrome's limit is 16 384 px per
 * side; Safari and Firefox differ, and all of them fail by producing an empty
 * bitmap rather than by throwing, so this is checked rather than attempted.
 */
const MAX_CANVAS_DIMENSION = 16_384

/** A rasterisation that could not happen, with the reason as a code. */
export class RasterError extends Error {
  readonly code: 'too-large' | 'no-context' | 'render-failed' | 'encode-failed'

  constructor(code: RasterError['code'], message: string) {
    super(message)
    this.name = 'RasterError'
    this.code = code
  }
}

/** Draws the diagram into a PNG at `scale` device pixels per user unit. */
export async function rasterise(
  diagram: Diagram,
  scale: number = DEFAULT_PNG_SCALE
): Promise<Blob> {
  const width = Math.round(diagram.width * scale)
  const height = Math.round(diagram.height * scale)
  if (
    width > MAX_CANVAS_DIMENSION ||
    height > MAX_CANVAS_DIMENSION ||
    width < 1 ||
    height < 1
  ) {
    throw new RasterError(
      'too-large',
      `A ${width}x${height} canvas is outside what a browser will allocate.`
    )
  }

  const image = await loadImage(dataUrl(diagram.svg))
  const canvas = document.createElement('canvas')
  canvas.width = width
  canvas.height = height
  const context = canvas.getContext('2d')
  if (context === null) {
    throw new RasterError(
      'no-context',
      'This browser refused a 2D canvas context, so the diagram cannot be ' +
        'rasterised. The SVG export needs none and still works.'
    )
  }
  context.drawImage(image, 0, 0, width, height)

  return await new Promise<Blob>((resolve, reject) => {
    canvas.toBlob((blob) => {
      if (blob === null) {
        reject(
          new RasterError('encode-failed', 'The canvas produced no PNG data.')
        )
        return
      }
      resolve(blob)
    }, 'image/png')
  })
}

/**
 * The SVG as a `data:` URL.
 *
 * `encodeURIComponent` rather than base64: it keeps the payload readable in a
 * devtools network panel, costs nothing, and — unlike `btoa` — does not throw
 * on the non-Latin-1 characters a circuit title or a `√X` label will contain.
 */
function dataUrl(svg: string): string {
  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`
}

function loadImage(source: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const image = new Image()
    image.addEventListener('load', () => {
      resolve(image)
    })
    image.addEventListener('error', () => {
      reject(
        new RasterError(
          'render-failed',
          'The browser could not render the exported SVG into an image.'
        )
      )
    })
    image.src = source
  })
}
