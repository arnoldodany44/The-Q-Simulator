// @vitest-environment node
import { describe, expect, it } from 'vitest'

import {
  MAX_VERSION_NUMBER,
  NO_VERSION_SELECTED,
  versionSearch,
  versionSelection,
} from './versionParams.js'

describe('reading a selection out of the address', () => {
  it('reads a version and a comparison base', () => {
    expect(versionSelection('?v=3&vs=1')).toEqual({ version: 3, compare: 1 })
  })

  it('reads a version on its own', () => {
    expect(versionSelection('?v=7')).toEqual({ version: 7, compare: null })
  })

  it('is the live document when there is no version', () => {
    expect(versionSelection('')).toEqual(NO_VERSION_SELECTED)
    expect(versionSelection('?c=eJyrVg')).toEqual(NO_VERSION_SELECTED)
  })

  it('ignores a comparison base with no version to compare it to', () => {
    expect(versionSelection('?vs=2')).toEqual(NO_VERSION_SELECTED)
  })

  it('ignores a comparison of a version with itself', () => {
    expect(versionSelection('?v=4&vs=4')).toEqual({ version: 4, compare: null })
  })

  it.each([
    ['?v=0x10', 'a hexadecimal literal'],
    ['?v=1e15', 'exponent notation'],
    ['?v=%20%203%20', 'padding whitespace'],
    ['?v=-2', 'a negative number'],
    ['?v=0', 'zero, when numbering starts at one'],
    ['?v=two', 'a word'],
    ['?v=', 'nothing at all'],
  ])('refuses %s (%s) rather than guessing', (search) => {
    expect(versionSelection(search)).toEqual(NO_VERSION_SELECTED)
  })

  it('refuses a number past what the API will look up', () => {
    expect(versionSelection(`?v=${MAX_VERSION_NUMBER}`).version).toBe(
      MAX_VERSION_NUMBER
    )
    expect(versionSelection(`?v=${MAX_VERSION_NUMBER + 1}`)).toEqual(
      NO_VERSION_SELECTED
    )
  })

  it('accepts a URLSearchParams as readily as a string', () => {
    expect(versionSelection(new URLSearchParams({ v: '2' }))).toEqual({
      version: 2,
      compare: null,
    })
  })
})

describe('writing a selection into the address', () => {
  /*
   * THE PROPERTY THAT MATTERS. `?c=` is the unsaved document — the editor
   * writes it there with `replaceState`, and losing it loses work. Every case
   * below carries it through untouched.
   */
  it('keeps the unsaved document in the address', () => {
    expect(versionSearch('?c=eJyrVg', { version: 3, compare: null })).toBe(
      '?c=eJyrVg&v=3'
    )
  })

  it('keeps it when the selection is cleared, too', () => {
    expect(
      versionSearch('?c=eJyrVg&v=3&vs=1', { version: null, compare: null })
    ).toBe('?c=eJyrVg')
  })

  it('drops the comparison when the version is cleared', () => {
    expect(versionSearch('?v=3&vs=1', { version: null, compare: null })).toBe(
      ''
    )
  })

  it('drops the comparison when it names the version itself', () => {
    expect(versionSearch('?vs=1', { version: 2, compare: 2 })).toBe('?v=2')
  })

  it('replaces a selection rather than appending to it', () => {
    expect(versionSearch('?v=3&vs=1', { version: 5, compare: 4 })).toBe(
      '?v=5&vs=4'
    )
  })

  it('leaves unrelated parameters alone', () => {
    expect(
      versionSearch('?example=bell&page=2', { version: 1, compare: null })
    ).toBe('?example=bell&page=2&v=1')
  })

  it('answers an empty string when nothing is left, not a bare question mark', () => {
    expect(versionSearch('', { version: null, compare: null })).toBe('')
  })

  it('round-trips through the reader', () => {
    const written = versionSearch('?c=payload', { version: 9, compare: 4 })
    expect(versionSelection(written)).toEqual({ version: 9, compare: 4 })
  })
})
