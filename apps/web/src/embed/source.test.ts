// @vitest-environment node
import { describe, expect, it } from 'vitest'

import { readEmbedAddress } from './source'

/**
 * The embed's whole router, which is a pure function of two strings.
 *
 * Most of what is asserted here is refusal. An address that cannot be a
 * circuit has to become a *state* rather than a request — a frame that fires
 * a fetch for `/embed/c/../../etc` and reports whatever the server says is a
 * frame that has made somebody else's blog post into a probe.
 */

describe('readEmbedAddress', () => {
  it('reads a saved circuit from the path', () => {
    const { request } = readEmbedAddress('/embed/c/V1StGXR8Z5jdHi6B', '')
    expect(request).toEqual({ kind: 'slug', slug: 'V1StGXR8Z5jdHi6B' })
  })

  it('reads a circuit carried in its own link', () => {
    const { request } = readEmbedAddress('/embed', '?c=PAYLOAD')
    expect(request).toEqual({ kind: 'inline', payload: 'PAYLOAD' })
  })

  it('reads the built file the same way, for a browser that opened it', () => {
    const { request } = readEmbedAddress('/embed.html', '?c=PAYLOAD')
    expect(request).toEqual({ kind: 'inline', payload: 'PAYLOAD' })
  })

  it('refuses a handle that cannot be one', () => {
    for (const path of [
      '/embed/c/../../etc/passwd',
      '/embed/c/',
      `/embed/c/${'x'.repeat(65)}`,
      '/embed/c/has spaces',
    ]) {
      expect(readEmbedAddress(path, '').request).toEqual({ kind: 'invalid' })
    }
  })

  it('survives a malformed percent escape instead of throwing', () => {
    // `decodeURIComponent('%zz')` throws, and anybody can type that into an
    // address bar. A frame that threw here would render nothing at all.
    expect(readEmbedAddress('/embed/c/%zz', '').request).toEqual({
      kind: 'invalid',
    })
  })

  it('refuses a path that is not an embed address', () => {
    expect(readEmbedAddress('/', '').request).toEqual({ kind: 'invalid' })
    expect(readEmbedAddress('/c/abc', '').request).toEqual({ kind: 'invalid' })
  })

  it('refuses an inline address with no payload', () => {
    expect(readEmbedAddress('/embed', '').request).toEqual({ kind: 'invalid' })
    expect(readEmbedAddress('/embed', '?c=').request).toEqual({
      kind: 'invalid',
    })
  })
})

describe('the language a teacher pins', () => {
  it('takes the one in the query', () => {
    expect(readEmbedAddress('/embed/c/abc', '?lang=fr').language).toBe('fr')
  })

  it('is null when none was pinned, so the reader’s browser decides', () => {
    expect(readEmbedAddress('/embed/c/abc', '').language).toBeNull()
  })

  it('ignores a language this product does not have', () => {
    /*
     * `null` rather than the tag: an unknown tag would reach i18next and
     * select nothing, leaving the frame in whatever `fallbackLng` says
     * regardless of the reader — which is worse than detecting.
     */
    expect(readEmbedAddress('/embed/c/abc', '?lang=de').language).toBeNull()
    expect(readEmbedAddress('/embed/c/abc', '?lang=').language).toBeNull()
  })
})
