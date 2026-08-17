import { describe, expect, it } from 'vitest'

import { splitNotation } from './prose'

/**
 * The one micro-syntax in the catalogs. Its failure mode is not an exception:
 * it is a paragraph that renders with a stray backtick in it, or a gate name
 * that quietly stops being marked `translate="no"` and gets rewritten by
 * Chrome's page translator.
 */
describe('notation inside a paragraph', () => {
  it('leaves a paragraph with no backticks alone', () => {
    expect(splitNotation('One wire, no gates.')).toEqual([
      { text: 'One wire, no gates.', notation: false },
    ])
  })

  it('marks the span between backticks', () => {
    expect(splitNotation('Apply an `H` to the wire.')).toEqual([
      { text: 'Apply an ', notation: false },
      { text: 'H', notation: true },
      { text: ' to the wire.', notation: false },
    ])
  })

  it('handles several spans, and one at each end', () => {
    expect(splitNotation('`|0⟩` becomes `|1⟩`')).toEqual([
      { text: '|0⟩', notation: true },
      { text: ' becomes ', notation: false },
      { text: '|1⟩', notation: true },
    ])
  })

  it('emits no empty spans when two are adjacent', () => {
    const spans = splitNotation('`H``Z`')
    expect(spans).toEqual([
      { text: 'H', notation: true },
      { text: 'Z', notation: true },
    ])
    expect(spans.every((span) => span.text !== '')).toBe(true)
  })

  /*
   * The forgiving reading, and the reason for it: the strict one would let a
   * translator's stray backtick swallow the rest of the paragraph into a code
   * span, and nothing in the build would notice.
   */
  it('treats an unpaired backtick as literal text', () => {
    expect(splitNotation('a ` b')).toEqual([{ text: 'a ` b', notation: false }])
    expect(splitNotation('`H` and a stray `')).toEqual([
      { text: 'H', notation: true },
      { text: ' and a stray `', notation: false },
    ])
  })

  it('handles the empty paragraph without producing a span', () => {
    expect(splitNotation('')).toEqual([])
  })
})
