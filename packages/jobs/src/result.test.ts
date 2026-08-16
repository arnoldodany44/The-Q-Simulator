import { describe, expect, it } from 'vitest'
import {
  MAX_RESULT_JSON_BYTES,
  MAX_RESULT_OUTCOMES,
  RESULT_PROBABILITY_FLOOR,
  assertResultFits,
  boundOutcomes,
  parseStoredResult,
  resultByteLength,
} from './result.js'
import type { SimulationRunResult } from './result.js'
import { SimulationFailure } from './run.js'

function result(
  overrides: Partial<SimulationRunResult> = {}
): SimulationRunResult {
  return {
    resultVersion: 1,
    mode: 'STATEVECTOR',
    qubits: 2,
    shots: null,
    seed: 7,
    noiseProfileId: null,
    outcomes: [
      { state: '00', probability: 0.5, count: null },
      { state: '11', probability: 0.5, count: null },
    ],
    hiddenOutcomes: 0,
    hiddenWeight: 0,
    purity: null,
    durationMs: 3,
    ...overrides,
  }
}

describe('boundOutcomes', () => {
  it('keeps the heaviest states and reports what it left behind', () => {
    const candidates = [
      { state: '00', probability: 0.1, count: null },
      { state: '01', probability: 0.6, count: null },
      { state: '10', probability: 0.3, count: null },
    ]
    const bounded = boundOutcomes(candidates, 2)
    expect(bounded.outcomes.map((entry) => entry.state)).toEqual(['01', '10'])
    expect(bounded.hiddenOutcomes).toBe(1)
    expect(bounded.hiddenWeight).toBeCloseTo(0.1, 12)
  })

  it('is honest about a truncated list, which is the point of the shape', () => {
    // Without the hidden count, six states out of a million would be
    // indistinguishable from a distribution that really has six states in it.
    const candidates = Array.from({ length: 500 }, (_unused, index) => ({
      state: index.toString(2).padStart(9, '0'),
      probability: 1 / 500,
      count: null,
    }))
    const bounded = boundOutcomes(candidates)
    expect(bounded.outcomes).toHaveLength(MAX_RESULT_OUTCOMES)
    expect(bounded.hiddenOutcomes).toBe(500 - MAX_RESULT_OUTCOMES)
    expect(bounded.hiddenWeight).toBeCloseTo(
      (500 - MAX_RESULT_OUTCOMES) / 500,
      9
    )
  })

  it('drops floating-point residue rather than spending a slot on it', () => {
    const bounded = boundOutcomes([
      { state: '0', probability: 1, count: null },
      { state: '1', probability: RESULT_PROBABILITY_FLOOR / 10, count: null },
    ])
    expect(bounded.outcomes).toHaveLength(1)
    // Residue is not "hidden weight" either: it was never an outcome.
    expect(bounded.hiddenOutcomes).toBe(0)
  })

  it('breaks a tie by label, so an equal distribution is stored the same twice', () => {
    // A maximally mixed state has 2ⁿ states of exactly equal weight. Without a
    // total order the top-k would depend on iteration order, and a reproducible
    // seed would stop meaning anything.
    const candidates = [
      { state: '11', probability: 0.25, count: null },
      { state: '00', probability: 0.25, count: null },
      { state: '10', probability: 0.25, count: null },
      { state: '01', probability: 0.25, count: null },
    ]
    const first = boundOutcomes(candidates, 2)
    const second = boundOutcomes([...candidates].reverse(), 2)
    expect(first.outcomes).toEqual(second.outcomes)
    expect(first.outcomes.map((entry) => entry.state)).toEqual(['00', '01'])
  })

  it('derives weight from counts when a tally carries no probabilities', () => {
    const bounded = boundOutcomes(
      [
        { state: '0', probability: null, count: 900 },
        { state: '1', probability: null, count: 100 },
      ],
      1
    )
    expect(bounded.outcomes[0]?.state).toBe('0')
    expect(bounded.hiddenWeight).toBeCloseTo(0.1, 12)
  })

  it('survives a tally of nothing without dividing by zero', () => {
    const bounded = boundOutcomes([{ state: '0', probability: null, count: 0 }])
    expect(bounded.outcomes).toEqual([])
    expect(bounded.hiddenWeight).toBe(0)
  })
})

describe('the stored shape', () => {
  it('parses a result it wrote', () => {
    expect(parseStoredResult(JSON.parse(JSON.stringify(result())))).toEqual(
      result()
    )
  })

  it('answers null for a column holding something else', () => {
    // The column outlives the code that wrote it. A shape that no longer parses
    // must read as "no readable result", not as a cast that is wrong later.
    expect(parseStoredResult({ resultVersion: 0 })).toBeNull()
    expect(parseStoredResult(null)).toBeNull()
    expect(parseStoredResult('{}')).toBeNull()
  })

  it('refuses more outcomes than the cap, even from storage', () => {
    const tooMany = result({
      outcomes: Array.from(
        { length: MAX_RESULT_OUTCOMES + 1 },
        (_u, index) => ({
          state: index.toString(2).padStart(9, '0'),
          probability: 0,
          count: null,
        })
      ),
    })
    expect(parseStoredResult(JSON.parse(JSON.stringify(tooMany)))).toBeNull()
  })
})

describe('the size tripwire', () => {
  it('lets a bounded result through with room to spare', () => {
    // A well-formed result is 256 entries of a 28-character label at most,
    // which is a few tens of kilobytes. The ceiling is comfortably above that,
    // so reaching it means the bounding did not happen.
    const widest = result({
      qubits: 28,
      outcomes: Array.from({ length: MAX_RESULT_OUTCOMES }, (_u, index) => ({
        state: index.toString(2).padStart(28, '0'),
        probability: 1 / MAX_RESULT_OUTCOMES,
        count: 12345,
      })),
    })
    expect(resultByteLength(widest)).toBeLessThan(MAX_RESULT_JSON_BYTES)
    expect(() => {
      assertResultFits(widest)
    }).not.toThrow()
  })

  it('fails the run rather than storing a truncated answer', () => {
    // A truncated result is a row that reads as a successful run and is not
    // one, which is the failure this refuses to commit.
    const oversized = result({
      outcomes: [{ state: '0'.repeat(62), probability: 1, count: null }],
    })
    expect(() => {
      assertResultFits(oversized, 32)
    }).toThrow(SimulationFailure)
    try {
      assertResultFits(oversized, 32)
    } catch (error) {
      expect((error as SimulationFailure).code).toBe('RESULT_TOO_LARGE')
    }
  })

  it('measures the row in bytes, not in code units', () => {
    /*
     * A bitstring label is ASCII, so the two measures coincide for anything
     * this system actually stores. The distinction still has to hold, because
     * the ceiling is a byte ceiling and a future label — a named register, a
     * qubit alias — would not be ASCII. The multi-byte label here is deliberate
     * and is not a label the engine produces.
     */
    const ascii = result()
    expect(resultByteLength(ascii)).toBe(JSON.stringify(ascii).length)

    const multiByte = result({
      outcomes: [{ state: 'ψ00', probability: 1, count: null }],
    })
    expect(resultByteLength(multiByte)).toBeGreaterThan(
      JSON.stringify(multiByte).length
    )
  })
})
