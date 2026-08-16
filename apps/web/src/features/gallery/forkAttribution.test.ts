import { describe, expect, it } from 'vitest'

import {
  FORKED_FROM_STATE_KEY,
  forkAttributionFrom,
} from './forkAttribution.js'

/**
 * History state is attacker-influenceable in exactly the way a URL is: a
 * crafted link can push an entry carrying any shape at all. Nothing branches
 * on these values, so the worst a forged one could do is put a sentence on
 * screen the reader did not earn — and this is what keeps even that off it.
 */

describe('forkAttributionFrom', () => {
  it('reads what a fork navigation wrote', () => {
    expect(
      forkAttributionFrom({
        [FORKED_FROM_STATE_KEY]: { title: 'Bell pair', username: 'ada' },
      })
    ).toEqual({ title: 'Bell pair', username: 'ada' })
  })

  it('is null for a page nobody forked into', () => {
    expect(forkAttributionFrom(null)).toBeNull()
    expect(forkAttributionFrom(undefined)).toBeNull()
    expect(forkAttributionFrom({})).toBeNull()
    // The key another feature writes into the same state object.
    expect(forkAttributionFrom({ intendedPath: '/circuits' })).toBeNull()
  })

  it('refuses anything that is not two non-empty strings', () => {
    const shapes: unknown[] = [
      { [FORKED_FROM_STATE_KEY]: 'Bell pair' },
      { [FORKED_FROM_STATE_KEY]: { title: 'Bell pair' } },
      { [FORKED_FROM_STATE_KEY]: { title: 1, username: 'ada' } },
      { [FORKED_FROM_STATE_KEY]: { title: '', username: 'ada' } },
      { [FORKED_FROM_STATE_KEY]: { title: 'Bell pair', username: '' } },
      { [FORKED_FROM_STATE_KEY]: null },
      { [FORKED_FROM_STATE_KEY]: ['Bell pair', 'ada'] },
    ]

    for (const shape of shapes) {
      expect(forkAttributionFrom(shape)).toBeNull()
    }
  })
})
