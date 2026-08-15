import {
  createRng,
  run,
  sampleShots,
  type ShotCounts,
  type Statevector,
} from '@qsim/core'
import { parseCircuit, type CircuitInput } from '@qsim/schema'
import { describe, expect, it } from 'vitest'

import { MAX_SHOTS, MIN_SHOTS } from '../simulation/protocol'
import {
  SHOT_STOPS,
  buildComparison,
  shotsAtStop,
  standardError,
  stopForShots,
} from './sampling'

/**
 * The model behind the shots control: the slider's scale, and the join
 * between counts the engine drew and probabilities the engine computed.
 *
 * Nothing here samples. Where a sample is needed it comes from
 * `sampleShots` — the engine's own, seeded — because the point of the
 * monorepo is that the client and the server draw shots the same way, and a
 * test that rolled its own would be checking a second implementation nobody
 * ships.
 */

function stateOf(input: CircuitInput): Statevector {
  const result = run(parseCircuit(input))
  if (result.mode !== 'analytic') throw new Error('expected an analytic run')
  return result.state
}

const BELL: CircuitInput = {
  schemaVersion: 1,
  qubits: 2,
  operations: [
    { id: 'a', gate: 'h', targets: [0], column: 0 },
    { id: 'b', gate: 'cx', targets: [1], controls: [0], column: 1 },
  ],
}

function uniform(qubits: number): CircuitInput {
  return {
    schemaVersion: 1,
    qubits,
    operations: Array.from({ length: qubits }, (_, qubit) => ({
      id: `h${qubit}`,
      gate: 'h',
      targets: [qubit],
      column: 0,
    })),
  }
}

/** Counts drawn by the engine, so the join is tested against real keys. */
function drawn(state: Statevector, shots: number, seed: number): ShotCounts {
  return sampleShots(state, shots, createRng(seed))
}

describe('the slider scale', () => {
  it('spans exactly the range §3.2 asks for', () => {
    expect(SHOT_STOPS[0]).toBe(MIN_SHOTS)
    expect(SHOT_STOPS[SHOT_STOPS.length - 1]).toBe(MAX_SHOTS)
  })

  it('rises, and never by more than a factor of three', () => {
    // A 1-2-5 progression: every neighbouring pair is a step a reader can
    // interpret, and no step is big enough to skip past the shot count where
    // the sample visibly settles.
    for (let index = 1; index < SHOT_STOPS.length; index++) {
      const previous = SHOT_STOPS[index - 1]!
      const current = SHOT_STOPS[index]!
      expect(current).toBeGreaterThan(previous)
      expect(current / previous).toBeLessThanOrEqual(3)
    }
  })

  it('answers with a real stop for a position off either end', () => {
    expect(shotsAtStop(-4)).toBe(MIN_SHOTS)
    expect(shotsAtStop(SHOT_STOPS.length + 10)).toBe(MAX_SHOTS)
  })

  it('round trips every stop', () => {
    SHOT_STOPS.forEach((shots, index) => {
      expect(stopForShots(shots)).toBe(index)
      expect(shotsAtStop(index)).toBe(shots)
    })
  })

  it('shows the nearest stop at or below a count between two of them', () => {
    // The slider must never claim more shots than were drawn.
    expect(shotsAtStop(stopForShots(1234))).toBe(1000)
  })
})

describe('the expected size of a gap', () => {
  it('is 1/(2√N), the standard error at its largest', () => {
    expect(standardError(100)).toBeCloseTo(0.05, 12)
    expect(standardError(10_000)).toBeCloseTo(0.005, 12)
  })

  it('falls by ten for every hundredfold, which is the lesson', () => {
    expect(standardError(100) / standardError(10_000)).toBeCloseTo(10, 12)
  })

  it('is zero rather than infinite for no shots at all', () => {
    expect(standardError(0)).toBe(0)
  })
})

describe('the comparison', () => {
  it('lines each count up against the probability of the same state', () => {
    const comparison = buildComparison(stateOf(BELL), { '00': 6, '11': 4 }, 10)

    expect(comparison.rows.map((row) => row.label)).toEqual(['00', '11'])
    expect(comparison.rows.map((row) => row.count)).toEqual([6, 4])
    expect(comparison.rows[0]?.frequency).toBeCloseTo(0.6, 12)
    expect(comparison.rows[0]?.probability).toBeCloseTo(0.5, 10)
    // Signed, so the row says which way the sample missed.
    expect(comparison.rows[0]?.delta).toBeCloseTo(0.1, 10)
    expect(comparison.rows[1]?.delta).toBeCloseTo(-0.1, 10)
    expect(comparison.largestGap).toBeCloseTo(0.1, 10)
  })

  it('gives a state no shot reached a row of its own, at zero', () => {
    // Absent from the counts is a count of zero (`ShotCounts` says so), and a
    // row that vanished would hide the very state a sample under-drew.
    const comparison = buildComparison(stateOf(BELL), { '00': 10 }, 10)

    expect(comparison.rows[1]?.count).toBe(0)
    expect(comparison.rows[1]?.frequency).toBe(0)
    expect(comparison.rows[1]?.delta).toBeCloseTo(-0.5, 10)
  })

  it('converges on the exact distribution as the shots grow', () => {
    /*
     * The claim §3.2's control exists to demonstrate, asserted the only way a
     * statistical claim can be: over several samples rather than one.
     *
     * A single seed is not evidence in either direction — seed 5 at a hundred
     * shots happens to split a Bell pair exactly fifty-fifty, a gap of 1e-16
     * that no larger sample will beat, and a test built on it would fail for
     * being *too* accurate. Eight seeds averaged separate the two sizes by
     * more than a factor of ten, which is the size of the effect being
     * claimed, so the assertion is about sampling and not about luck.
     */
    const state = stateOf(BELL)
    const meanGap = (shots: number): number => {
      const seeds = [1, 2, 3, 4, 5, 6, 7, 8]
      const total = seeds.reduce(
        (sum, seed) =>
          sum +
          buildComparison(state, drawn(state, shots, seed), shots).largestGap,
        0
      )
      return total / seeds.length
    }

    const small = meanGap(100)
    const large = meanGap(20_000)

    expect(large).toBeLessThan(small)
    // And it falls at the rate `standardError` predicts: a two-hundredfold in
    // shots is roughly a fourteenfold in precision.
    expect(small / large).toBeGreaterThan(5)
  })

  it('never disagrees with the standard error it prints', () => {
    // Four standard deviations: tight enough to catch a join that lost the
    // counts, loose enough that a fixed seed cannot make it flaky.
    const state = stateOf(BELL)
    for (const shots of [100, 20_000]) {
      const comparison = buildComparison(state, drawn(state, shots, 5), shots)
      expect(comparison.largestGap).toBeLessThan(4 * comparison.standardError)
    }
  })

  it('gathers the states the cap left out into one row', () => {
    const state = stateOf(uniform(5))
    const comparison = buildComparison(state, drawn(state, 1000, 9), 1000, 4)

    expect(comparison.rows).toHaveLength(4)
    expect(comparison.hiddenStates).toBe(28)
    expect(comparison.remainder?.probability).toBeCloseTo(28 / 32, 10)
    // Every shot is accounted for: the four listed rows plus the remainder.
    const total =
      comparison.rows.reduce((sum, row) => sum + row.count, 0) +
      (comparison.remainder?.count ?? 0)
    expect(total).toBe(1000)
  })

  it('has no remainder row when every state is listed', () => {
    const state = stateOf(BELL)

    expect(buildComparison(state, drawn(state, 50, 1), 50).remainder).toBeNull()
  })

  it('survives a request for no shots at all', () => {
    // Zero is a legal argument to `sampleShots` (an empty histogram of an
    // existing state), so the join must not divide by it.
    const comparison = buildComparison(stateOf(BELL), {}, 0)

    expect(comparison.rows.every((row) => row.frequency === 0)).toBe(true)
    expect(comparison.largestGap).toBeCloseTo(0.5, 10)
  })
})
