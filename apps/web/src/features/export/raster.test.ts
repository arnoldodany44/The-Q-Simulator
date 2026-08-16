import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { Diagram } from './diagram'
import { DEFAULT_PNG_SCALE, RasterError, rasterise } from './raster'

/**
 * Rasterisation, against a stubbed canvas.
 *
 * jsdom has no 2D context and no image decoder, so the browser half is
 * replaced here. What that leaves is exactly the part worth pinning: the
 * source the image is given (a `data:` URL, so the canvas stays untainted and
 * `toBlob` does not throw a `SecurityError` at the last step), the pixel size
 * the canvas is set to, and the three ways this can fail — each of which the
 * panel turns into a different sentence.
 */

const DIAGRAM: Diagram = {
  svg: '<svg xmlns="http://www.w3.org/2000/svg" width="100" height="50"></svg>',
  width: 100,
  height: 50,
}

let sources: string[] = []
let drawn: { width: number; height: number } | null = null

/** An `Image` that loads whatever it is given, on the next microtask. */
class LoadingImage {
  onload: (() => void) | null = null
  private listeners = new Map<string, () => void>()

  addEventListener(type: string, listener: () => void) {
    this.listeners.set(type, listener)
  }

  set src(value: string) {
    sources.push(value)
    queueMicrotask(() => {
      this.listeners.get('load')?.()
    })
  }
}

/** An `Image` that always fails, for the path where the SVG will not render. */
class FailingImage {
  private listeners = new Map<string, () => void>()

  addEventListener(type: string, listener: () => void) {
    this.listeners.set(type, listener)
  }

  set src(_value: string) {
    queueMicrotask(() => {
      this.listeners.get('error')?.()
    })
  }
}

beforeEach(() => {
  sources = []
  drawn = null
  vi.stubGlobal('Image', LoadingImage)
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue({
    drawImage: (
      _image: unknown,
      _x: number,
      _y: number,
      w: number,
      h: number
    ) => {
      drawn = { width: w, height: h }
    },
  } as unknown as CanvasRenderingContext2D)
  HTMLCanvasElement.prototype.toBlob = function toBlob(
    callback: BlobCallback,
    type?: string
  ) {
    callback(new Blob(['png'], { type: type ?? 'image/png' }))
  }
})

afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

describe('rasterise', () => {
  it('draws the diagram at twice its size by default', async () => {
    const blob = await rasterise(DIAGRAM)
    expect(blob.type).toBe('image/png')
    expect(drawn).toEqual({ width: 200, height: 100 })
    expect(DEFAULT_PNG_SCALE).toBe(2)
  })

  it('honours a scale the caller asks for', async () => {
    await rasterise(DIAGRAM, 3)
    expect(drawn).toEqual({ width: 300, height: 150 })
  })

  it('loads the SVG from a data URL, so the canvas stays untainted', async () => {
    await rasterise(DIAGRAM)
    expect(sources).toHaveLength(1)
    expect(sources[0]!.startsWith('data:image/svg+xml;charset=utf-8,')).toBe(
      true
    )
    // Percent-encoded rather than base64: `btoa` throws on the non-Latin-1
    // characters a title or a `√X` label will contain.
    expect(decodeURIComponent(sources[0]!.split(',')[1]!)).toBe(DIAGRAM.svg)
  })

  it('refuses a canvas no browser will allocate, rather than returning blank', async () => {
    const huge: Diagram = { ...DIAGRAM, width: 20_000, height: 50 }
    await expect(rasterise(huge)).rejects.toThrow(RasterError)
    await expect(rasterise(huge)).rejects.toMatchObject({ code: 'too-large' })
    // An over-large canvas fails by producing an empty bitmap, silently, which
    // is why this is checked before anything is drawn.
    expect(drawn).toBeNull()
  })

  it('reports a browser that refuses a 2D context', async () => {
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(null)
    await expect(rasterise(DIAGRAM)).rejects.toMatchObject({
      code: 'no-context',
    })
  })

  it('reports an SVG the browser could not render', async () => {
    vi.stubGlobal('Image', FailingImage)
    await expect(rasterise(DIAGRAM)).rejects.toMatchObject({
      code: 'render-failed',
    })
  })

  it('reports a canvas that produced no data', async () => {
    HTMLCanvasElement.prototype.toBlob = function toBlob(
      callback: BlobCallback
    ) {
      callback(null)
    }
    await expect(rasterise(DIAGRAM)).rejects.toMatchObject({
      code: 'encode-failed',
    })
  })
})
