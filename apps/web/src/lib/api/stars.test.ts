import { describe, expect, it } from 'vitest'
import type { CircuitCard, CircuitView } from '@qsim/contract'

import { circuitDetailPayload, circuitViewPayload } from './testing.js'
import { applyStarToPage, applyStarToPages, applyStarToView } from './stars.js'

/**
 * The cache surgery behind an optimistic star.
 *
 * Every case worth pinning is off the happy path, which is exactly why this is
 * a pure module: starring something already starred, unstarring at zero, and
 * the server disagreeing with the guess are all one function call here and a
 * choreography of clicks anywhere else.
 */

function card(overrides: Partial<CircuitCard> = {}): CircuitCard {
  return {
    ...circuitDetailPayload,
    createdAt: new Date(circuitDetailPayload.createdAt),
    updatedAt: new Date(circuitDetailPayload.updatedAt),
    ...overrides,
  } as CircuitCard
}

function page(items: CircuitCard[], starred: string[] = []) {
  return { items, starred, nextCursor: null, limit: 20 }
}

describe('applyStarToPage', () => {
  it('adds the star and the count together', () => {
    const before = page([card({ id: 'cir_1', starCount: 4 })])

    const after = applyStarToPage(before, { circuitId: 'cir_1', starred: true })

    expect(after.items[0]?.starCount).toBe(5)
    expect(after.starred).toEqual(['cir_1'])
  })

  it('removes them together', () => {
    const before = page([card({ id: 'cir_1', starCount: 4 })], ['cir_1'])

    const after = applyStarToPage(before, {
      circuitId: 'cir_1',
      starred: false,
    })

    expect(after.items[0]?.starCount).toBe(3)
    expect(after.starred).toEqual([])
  })

  it('does not move the count when the state does not change', () => {
    /*
     * The server is idempotent — starring twice inserts one row — so a client
     * that added one anyway would show a number no request produced, and would
     * keep showing it until something else refetched the page.
     */
    const before = page([card({ id: 'cir_1', starCount: 4 })], ['cir_1'])

    const after = applyStarToPage(before, { circuitId: 'cir_1', starred: true })

    expect(after.items[0]?.starCount).toBe(4)
    expect(after.starred).toEqual(['cir_1'])
  })

  it('never draws a negative count', () => {
    // The floor the server's own `updateMany` enforces: too high is cosmetic,
    // negative is a number no interface knows how to draw.
    const before = page([card({ id: 'cir_1', starCount: 0 })], ['cir_1'])

    const after = applyStarToPage(before, {
      circuitId: 'cir_1',
      starred: false,
    })

    expect(after.items[0]?.starCount).toBe(0)
  })

  it('takes the server’s count over the guess when there is one', () => {
    // Two tabs and a hundred other readers move this number too.
    const before = page([card({ id: 'cir_1', starCount: 4 })])

    const after = applyStarToPage(before, {
      circuitId: 'cir_1',
      starred: true,
      starCount: 12,
    })

    expect(after.items[0]?.starCount).toBe(12)
  })

  it('returns the very same page when nothing on it matched', () => {
    /*
     * Identity, not equality. React Query holds an infinite listing as an
     * array of pages, and rebuilding every page on every star would give each
     * of them a new reference and re-render the whole gallery to change one
     * number.
     */
    const before = page([card({ id: 'cir_1' })])

    expect(
      applyStarToPage(before, { circuitId: 'cir_other', starred: true })
    ).toBe(before)
  })

  it('leaves the other cards on the page untouched', () => {
    const before = page([
      card({ id: 'cir_1', starCount: 1 }),
      card({ id: 'cir_2', starCount: 7 }),
    ])

    const after = applyStarToPage(before, { circuitId: 'cir_2', starred: true })

    expect(after.items[0]?.starCount).toBe(1)
    expect(after.items[1]?.starCount).toBe(8)
  })
})

describe('applyStarToPages', () => {
  it('finds the circuit whichever page it landed on', () => {
    const data = {
      pages: [
        page([card({ id: 'cir_1', starCount: 1 })]),
        page([card({ id: 'cir_2', starCount: 2 })]),
      ],
      pageParams: [undefined, 'cursor-2'],
    }

    const after = applyStarToPages(data, { circuitId: 'cir_2', starred: true })

    expect(after.pages[1]?.items[0]?.starCount).toBe(3)
    expect(after.pages[1]?.starred).toEqual(['cir_2'])
    // Untouched pages keep their identity, so only one page re-renders.
    expect(after.pages[0]).toBe(data.pages[0])
    expect(after.pageParams).toEqual(data.pageParams)
  })
})

describe('applyStarToView', () => {
  const view: CircuitView = {
    ...circuitViewPayload,
    circuit: {
      ...circuitDetailPayload,
      createdAt: new Date(circuitDetailPayload.createdAt),
      updatedAt: new Date(circuitDetailPayload.updatedAt),
      starCount: 3,
    },
    version: {
      ...circuitViewPayload.version,
      createdAt: new Date(circuitViewPayload.version.createdAt),
    },
  } as CircuitView

  it('moves the boolean and the count on a circuit’s own page', () => {
    const after = applyStarToView(view, {
      circuitId: circuitDetailPayload.id,
      starred: true,
    })

    expect(after.starred).toBe(true)
    expect(after.circuit.starCount).toBe(4)
  })

  it('refuses to write another circuit’s state into this one', () => {
    /*
     * The detail cache is keyed by *handle*, so the same circuit reached by
     * slug and by id is two entries and the mutation walks all of them. The id
     * check is what stops a star landing on whichever entry happened to be
     * next.
     */
    expect(
      applyStarToView(view, { circuitId: 'cir_other', starred: true })
    ).toBe(view)
  })
})
