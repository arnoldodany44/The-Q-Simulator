import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { MEDIA_TYPES, saveFile, saveText } from './download'

/**
 * A download nobody receives is the failure mode this module exists for, and
 * it is silent: no error, no file. So the assertions below are about the
 * mechanism rather than the result — an object URL, an anchor carrying
 * `download`, a click, and a revocation that does not race the browser.
 *
 * jsdom implements none of `URL.createObjectURL`, so it is stubbed here. That
 * is not a weakness of the test: what is being checked is *which* API is
 * called and in what order, which is exactly the part that differs between a
 * download that works everywhere and one that works in Chrome.
 */

let created: Blob[] = []
let revoked: string[] = []
let clicked: HTMLAnchorElement[] = []

beforeEach(() => {
  vi.useFakeTimers()
  created = []
  revoked = []
  clicked = []
  vi.stubGlobal('URL', {
    ...URL,
    createObjectURL: (blob: Blob) => {
      created.push(blob)
      return `blob:test/${created.length}`
    },
    revokeObjectURL: (url: string) => {
      revoked.push(url)
    },
  })
  // jsdom's anchor click would try to navigate; recording it is what the test
  // is about anyway.
  vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (
    this: HTMLAnchorElement
  ) {
    clicked.push(this)
  })
})

afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

describe('saveFile', () => {
  it('clicks an anchor at an object URL, carrying the file name', () => {
    const blob = new Blob(['x'], { type: 'text/plain' })
    saveFile('bell-pair.qasm', blob)

    expect(created).toEqual([blob])
    expect(clicked).toHaveLength(1)
    const anchor = clicked[0]!
    expect(anchor.download).toBe('bell-pair.qasm')
    expect(anchor.href).toContain('blob:test/1')
    expect(anchor.rel).toBe('noopener')
  })

  it('never uses a data: URL, which browsers refuse to download', () => {
    saveFile('x.json', new Blob(['{}']))
    expect(clicked[0]!.href.startsWith('data:')).toBe(false)
  })

  it('puts the anchor in the document, because Firefox needs it there', () => {
    let attached = false
    vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (
      this: HTMLAnchorElement
    ) {
      attached = document.body.contains(this)
    })
    saveFile('x.json', new Blob(['{}']))
    expect(attached).toBe(true)
    // And takes it out again, so nothing is left behind.
    expect(document.querySelectorAll('a[download]')).toHaveLength(0)
  })

  it('revokes the URL later, not in the tick that used it', () => {
    saveFile('x.json', new Blob(['{}']))
    // Revoking here would cancel the download in the browsers that fetch the
    // blob asynchronously.
    expect(revoked).toEqual([])
    vi.advanceTimersByTime(40_000)
    expect(revoked).toEqual(['blob:test/1'])
  })
})

describe('saveText', () => {
  it('wraps text in a blob of the media type it was given', async () => {
    saveText('a.qasm', 'OPENQASM 3.0;', MEDIA_TYPES.qasm)
    expect(created).toHaveLength(1)
    expect(created[0]!.type).toBe(MEDIA_TYPES.qasm)
    expect(await created[0]!.text()).toBe('OPENQASM 3.0;')
  })

  it('declares utf-8 on every text media type it offers', () => {
    for (const [format, type] of Object.entries(MEDIA_TYPES)) {
      if (format === 'png') continue
      expect(type, format).toContain('charset=utf-8')
    }
  })
})
