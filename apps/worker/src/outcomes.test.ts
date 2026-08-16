import { MAX_RESULT_OUTCOMES, RESULT_PROBABILITY_FLOOR } from '@qsim/jobs'
import { describe, expect, it } from 'vitest'
import { selectFromCounts, selectFromDistribution } from './outcomes.js'

/** A uniform distribution over 2ⁿ states, as a maximally mixed register has. */
function uniform(qubits: number): Float64Array {
  const size = 2 ** qubits
  return new Float64Array(size).fill(1 / size)
}

describe('selectFromDistribution', () => {
  it('keeps everything when everything fits', () => {
    const distribution = Float64Array.from([0.25, 0, 0, 0.75])
    const bounded = selectFromDistribution(distribution, 2)
    expect(bounded.outcomes).toEqual([
      { state: '11', probability: 0.75, count: null },
      { state: '00', probability: 0.25, count: null },
    ])
    expect(bounded.hiddenOutcomes).toBe(0)
    expect(bounded.hiddenWeight).toBe(0)
  })

  it('drops residue below the floor without calling it hidden', () => {
    // A state carrying 10⁻¹⁶ is a rounding artefact of the kernel. Listing it
    // would spend a slot on nothing; counting it as hidden would imply the run
    // found something there.
    const distribution = Float64Array.from([
      1 - RESULT_PROBABILITY_FLOOR / 10,
      RESULT_PROBABILITY_FLOOR / 10,
    ])
    const bounded = selectFromDistribution(distribution, 1)
    expect(bounded.outcomes).toHaveLength(1)
    expect(bounded.hiddenOutcomes).toBe(0)
  })

  it('accounts for every state it left out', () => {
    const bounded = selectFromDistribution(uniform(12), 12)
    expect(bounded.outcomes).toHaveLength(MAX_RESULT_OUTCOMES)
    expect(bounded.hiddenOutcomes).toBe(4096 - MAX_RESULT_OUTCOMES)
    expect(bounded.hiddenWeight).toBeCloseTo(
      (4096 - MAX_RESULT_OUTCOMES) / 4096,
      6
    )
    // The kept weight plus the hidden weight is the whole distribution. Without
    // that, a truncated list is a lie about the physics.
    const kept = bounded.outcomes.reduce(
      (sum, entry) => sum + (entry.probability ?? 0),
      0
    )
    expect(kept + bounded.hiddenWeight).toBeCloseTo(1, 6)
  })

  it('is deterministic on a maximally mixed register', () => {
    /*
     * The case the moving threshold could quietly break: 2ⁿ states of exactly
     * equal weight, so "the top 256" is decided entirely by tie-breaks. Two
     * calls must agree, and they must agree with the ascending-label rule
     * `boundOutcomes` uses.
     */
    const first = selectFromDistribution(uniform(11), 11)
    const second = selectFromDistribution(uniform(11), 11)
    expect(first.outcomes).toEqual(second.outcomes)
    expect(first.outcomes[0]?.state).toBe('0'.repeat(11))
    const labels = first.outcomes.map((entry) => entry.state)
    expect([...labels].sort()).toEqual(labels)
  })

  it('survives a distribution far larger than the buffer', () => {
    // The whole reason the pass is streaming: at the register ceiling this is
    // sixteen million doubles, and an object per entry would allocate gigabytes
    // to answer a 256-entry question.
    const bounded = selectFromDistribution(uniform(16), 16)
    expect(bounded.outcomes).toHaveLength(MAX_RESULT_OUTCOMES)
    expect(bounded.hiddenOutcomes).toBe(65536 - MAX_RESULT_OUTCOMES)
  })

  it('attaches the counts drawn from the same state', () => {
    const bounded = selectFromDistribution(Float64Array.from([0.5, 0.5]), 1, {
      '0': 480,
      '1': 520,
    })
    expect(bounded.outcomes.map((entry) => entry.count).sort()).toEqual([
      480, 520,
    ])
  })
})

describe('selectFromCounts', () => {
  it('states an empirical frequency as a probability', () => {
    // So a client can draw a tally and an exact distribution on the same axis
    // without knowing which mode produced it.
    const bounded = selectFromCounts({ '00': 900, '11': 100 })
    expect(bounded.outcomes).toEqual([
      { state: '00', probability: 0.9, count: 900 },
      { state: '11', probability: 0.1, count: 100 },
    ])
  })

  it('caps a tally with many distinct outcomes', () => {
    const counts: Record<string, number> = {}
    for (let index = 0; index < 1_000; index++) {
      counts[index.toString(2).padStart(10, '0')] = 1
    }
    const bounded = selectFromCounts(counts)
    expect(bounded.outcomes).toHaveLength(MAX_RESULT_OUTCOMES)
    expect(bounded.hiddenOutcomes).toBe(1_000 - MAX_RESULT_OUTCOMES)
  })
})
