/**
 * The generator is only useful if it is boring in exactly two ways: the same
 * seed always gives the same stream, and the stream looks uniform. Both are
 * asserted here, because every sampling test in the suite rests on them.
 */

import { describe, expect, it } from 'vitest'

import { createRng, randomSeed } from './rng.js'

function draw(seed: number, count: number): number[] {
  const rng = createRng(seed)
  return Array.from({ length: count }, () => rng.next())
}

describe('determinism', () => {
  it('gives the same stream to two generators with the same seed', () => {
    expect(draw(12345, 200)).toEqual(draw(12345, 200))
  })

  it('gives different streams to different seeds', () => {
    expect(draw(1, 50)).not.toEqual(draw(2, 50))
  })

  it('decorrelates neighbouring seeds from the first draw', () => {
    // Without the SplitMix32 expansion the seeds a test sweeps — 0, 1, 2, … —
    // would open with nearly identical values, and a sampling test would then
    // measure the seeding, not the physics.
    const firstDraws = new Set<number>()
    const deciles = new Set<number>()
    for (let seed = 0; seed < 1000; seed++) {
      const value = createRng(seed).next()
      firstDraws.add(value)
      deciles.add(Math.floor(value * 10))
    }
    expect(firstDraws.size).toBe(1000)
    expect(deciles.size).toBe(10)
  })

  it('pins the stream of seed 1, which is a compatibility contract', () => {
    // A shared circuit carries its seed (D4) and the server re-runs it to
    // validate a challenge. Replacing the generator changes every result a
    // user has ever seen, so it is a breaking change — and this is where it
    // announces itself instead of being discovered in production.
    expect(draw(1, 4)).toEqual([
      0.09156953175513294, 0.8881928137485323, 0.43427017709149285,
      0.746779782068075,
    ])
  })
})

describe('distribution', () => {
  it('stays inside [0, 1)', () => {
    for (const value of draw(99, 10_000)) {
      expect(value).toBeGreaterThanOrEqual(0)
      expect(value).toBeLessThan(1)
    }
  })

  it('fills ten buckets evenly (chi-squared, 9 dof)', () => {
    const samples = 100_000
    const buckets = new Float64Array(10)
    for (const value of draw(2024, samples))
      buckets[Math.floor(value * 10)] += 1

    const expected = samples / 10
    let chiSquared = 0
    for (const observed of buckets) {
      chiSquared += (observed - expected) ** 2 / expected
    }
    // 16.919 is the 95th percentile of χ² with 9 degrees of freedom.
    expect(chiSquared, `χ² = ${chiSquared}`).toBeLessThan(16.919)
  })

  it('has a mean near one half', () => {
    const values = draw(7, 50_000)
    const mean = values.reduce((sum, value) => sum + value, 0) / values.length
    expect(mean).toBeCloseTo(0.5, 2)
  })

  it('carries more than 32 bits, as the sampler needs', () => {
    // One 32-bit word would make every draw a multiple of 2⁻³². If not one of
    // ten thousand draws has a finer fraction than that, `next()` lost its low
    // word and outcomes rarer than 2⁻³² became unreachable.
    const finer = draw(31, 10_000).some(
      (value) => !Number.isInteger(value * 2 ** 32)
    )
    expect(finer).toBe(true)
  })
})

describe('input handling', () => {
  it('rejects a non-integer seed', () => {
    expect(() => createRng(1.5)).toThrow(RangeError)
  })

  it('accepts a zero seed without degenerating', () => {
    // Zero is the seed that a "no seed supplied" bug produces, and all-zero is
    // the one state xoshiro can never leave.
    expect(new Set(draw(0, 10)).size).toBe(10)
  })

  it('produces a 32-bit unsigned integer seed', () => {
    for (let i = 0; i < 100; i++) {
      const seed = randomSeed()
      expect(Number.isInteger(seed)).toBe(true)
      expect(seed).toBeGreaterThanOrEqual(0)
      expect(seed).toBeLessThan(2 ** 32)
    }
  })
})
