import { DEFAULT_GALLERY_SORT, MIN_SEARCH_LENGTH } from '@qsim/contract'
import { describe, expect, it } from 'vitest'

import {
  SEARCH_PARAM,
  SORT_PARAM,
  TAG_PARAM,
  isFiltered,
  searchWithSelection,
  selectionFromSearch,
} from './selection.js'

/**
 * The address is the selection, and the selection is the cache key.
 *
 * Both halves matter and the second is the one with teeth: two spellings of
 * one selection would be two React Query entries for one listing, which shows
 * up as a gallery that refetches itself when nothing changed. So the round
 * trip is asserted, and so is the normalisation that makes it a round trip.
 */

function search(query: string): URLSearchParams {
  return new URLSearchParams(query)
}

describe('selectionFromSearch', () => {
  it('reads the whole selection', () => {
    expect(
      selectionFromSearch(search('sort=stars&tag=grover&q=teleport'))
    ).toEqual({ sort: 'stars', tag: 'grover', q: 'teleport' })
  })

  it('falls back to the default order rather than to a 400', () => {
    /*
     * A hand-edited or stale URL should show the gallery. The API would answer
     * 400 for a sort it does not know, and an error about a parameter the
     * reader did not type is not an answer.
     */
    expect(selectionFromSearch(search('sort=alphabetical')).sort).toBe(
      DEFAULT_GALLERY_SORT
    )
    expect(selectionFromSearch(search('')).sort).toBe(DEFAULT_GALLERY_SORT)
  })

  it('omits an empty tag and an empty term rather than carrying blanks', () => {
    const selection = selectionFromSearch(search('tag=&q=%20%20'))

    expect(selection.tag).toBeUndefined()
    expect(selection.q).toBeUndefined()
  })

  it('does not second-guess a tag the server has the authority on', () => {
    // Dropping it would answer a different question — every circuit you may
    // see — which on this route is the answer to produce by accident least.
    expect(selectionFromSearch(search('tag=%23%23%23')).tag).toBe('###')
  })

  it('bounds what it will carry, because the server bounds what it accepts', () => {
    const long = 'x'.repeat(500)
    const selection = selectionFromSearch(search(`tag=${long}&q=${long}`))

    expect(selection.tag?.length).toBeLessThanOrEqual(64)
    expect(selection.q?.length).toBeLessThanOrEqual(64)
  })
})

describe('searchWithSelection', () => {
  it('round-trips a selection through the address', () => {
    const written = searchWithSelection(search(''), {
      sort: 'stars',
      tag: 'grover',
      q: 'teleport',
    })

    expect(selectionFromSearch(written)).toEqual({
      sort: 'stars',
      tag: 'grover',
      q: 'teleport',
    })
  })

  it('spells the default order as absence', () => {
    // A `?sort=recent` that means exactly what no parameter means is a longer
    // URL and a second cache key for one listing.
    const written = searchWithSelection(search('sort=stars'), {
      sort: DEFAULT_GALLERY_SORT,
    })

    expect(written.has(SORT_PARAM)).toBe(false)
  })

  it('clears a facet when the selection says empty', () => {
    const written = searchWithSelection(search('tag=grover&q=bell'), {
      sort: 'recent',
      tag: '',
      q: '',
    })

    expect(written.has(TAG_PARAM)).toBe(false)
    expect(written.has(SEARCH_PARAM)).toBe(false)
  })

  it('leaves parameters this feature does not own alone', () => {
    // A language, a future flag, anything a link carried in with it.
    const written = searchWithSelection(search('lng=fr&tag=old'), {
      sort: 'recent',
      tag: 'new',
    })

    expect(written.get('lng')).toBe('fr')
    expect(written.get(TAG_PARAM)).toBe('new')
  })

  it('trims, so a term of spaces is no term at all', () => {
    const written = searchWithSelection(search(''), { q: '   ' })

    expect(written.has(SEARCH_PARAM)).toBe(false)
  })
})

describe('isFiltered', () => {
  it('is what an empty state needs to know', () => {
    // "Nothing has been published" and "nothing matches your search" are
    // different sentences, and one of them is wrong on a new deployment.
    expect(isFiltered({ sort: 'recent' })).toBe(false)
    expect(isFiltered({ sort: 'stars' })).toBe(false)
    expect(isFiltered({ tag: 'grover' })).toBe(true)
    expect(isFiltered({ q: 'x'.repeat(MIN_SEARCH_LENGTH) })).toBe(true)
  })
})
