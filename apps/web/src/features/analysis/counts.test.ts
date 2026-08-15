import { describe, expect, it } from 'vitest'

import { tallyCounts } from './counts'

describe('tallyCounts', () => {
  it('draws readings in register order and shares that add to one', () => {
    const tally = tallyCounts({ '10': 3, '00': 5, '01': 2 }, 32)
    expect(tally.rows.map((row) => row.label)).toEqual(['00', '01', '10'])
    expect(tally.shots).toBe(10)
    expect(tally.rows.map((row) => row.share)).toEqual([0.5, 0.2, 0.3])
    expect(tally.remainder).toBeNull()
    expect(tally.readings).toBe(3)
  })

  it('selects by weight but still draws in register order', () => {
    // The two rules of §3.2 pulling in different directions, which is the
    // whole reason they are stated separately: `11` is the commonest reading
    // and is kept, `00` is the rarest and is not — but the survivors are drawn
    // in the register's own order, not in the order they were chosen.
    const tally = tallyCounts({ '00': 1, '01': 5, '10': 9, '11': 20 }, 2)
    expect(tally.rows.map((row) => row.label)).toEqual(['10', '11'])
    expect(tally.remainder?.count).toBe(6)
    expect(tally.hiddenReadings).toBe(2)
    expect(tally.readings).toBe(4)
  })

  it('loses no shot to the cap', () => {
    const counts = Object.fromEntries(
      Array.from({ length: 40 }, (_, index) => [
        index.toString(2).padStart(6, '0'),
        index + 1,
      ])
    )
    const tally = tallyCounts(counts, 8)
    const drawn =
      tally.rows.reduce((sum, row) => sum + row.count, 0) +
      (tally.remainder?.count ?? 0)
    expect(drawn).toBe(tally.shots)
    const share =
      tally.rows.reduce((sum, row) => sum + row.share, 0) +
      (tally.remainder?.share ?? 0)
    expect(share).toBeCloseTo(1, 12)
  })

  it('breaks ties on the label, so equal counts are stable', () => {
    const tally = tallyCounts({ b: 4, a: 4, c: 1 }, 2)
    expect(tally.rows.map((row) => row.label)).toEqual(['a', 'b'])
  })

  it('answers an empty tally without dividing by zero', () => {
    const tally = tallyCounts({}, 32)
    expect(tally.rows).toEqual([])
    expect(tally.remainder).toBeNull()
    expect(tally.shots).toBe(0)
    expect(tally.readings).toBe(0)
  })
})
