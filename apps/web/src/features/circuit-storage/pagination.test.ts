import { describe, expect, it } from 'vitest'

import { PAGE_PARAM, pageFromSearch } from './pagination'

const at = (query: string): number => pageFromSearch(new URLSearchParams(query))

describe('the page a listing URL asks for', () => {
  it('is the first page when nothing asks for another', () => {
    expect(at('')).toBe(1)
    expect(PAGE_PARAM).toBe('page')
  })

  it('reads a decimal page number', () => {
    expect(at('page=3')).toBe(3)
    expect(at('page=42&sort=recent')).toBe(42)
  })

  it('refuses everything Number() would have accepted', () => {
    /*
     * `Number()` reads the whole of JavaScript's numeric literal grammar plus
     * surrounding whitespace, so each of these is a page number nobody typed.
     * `@qsim/contract`'s `pageNumber` refuses them on the server for the same
     * reason; sending one would be building a request already known to be a
     * 400.
     */
    expect(at('page=0x10')).toBe(1)
    expect(at('page=1e15')).toBe(1)
    expect(at('page=%20%205%20')).toBe(1)
    expect(at('page=-2')).toBe(1)
    expect(at('page=2.5')).toBe(1)
    expect(at('page=')).toBe(1)
    expect(at('page=last')).toBe(1)
  })

  it('treats page zero as the first page rather than as an offset', () => {
    expect(at('page=0')).toBe(1)
  })
})
