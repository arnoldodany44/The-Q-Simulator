/**
 * The M0.4 budget: editing the last column of a 40-column circuit must cost
 * under 15% of a full simulation.
 *
 * WHY THIS IS `.perf.test.ts` AND NOT PART OF THE DEFAULT SUITE.
 *
 * This looks like a relative measurement, and a relative measurement looks
 * immune to a busy machine. It is not. The two phases are timed one after the
 * other, so the ratio is only meaningful if the load is the same across both
 * windows — and when the load is what changes between them, the ratio measures
 * the change rather than the cache. Observed here: green four runs in a row,
 * then red on the run that started while a batch of other processes was
 * winding down.
 *
 * The correctness half of what this guards is not lost. That an incremental
 * re-simulation equals a full one to 1e-12 is asserted in checkpoints.test.ts
 * and again in verification/checkpoint-equivalence.test.ts, both in the default
 * suite; only the *speed* claim lives here. Run it with:
 *
 *   pnpm --filter @qsim/core test:perf
 */

import { describe, expect, it } from 'vitest'

import { analyticMode } from './measure.js'
import { createRng } from './rng.js'
import { createCheckpoints, invalidateFrom, run, runFrom } from './runner.js'
import type { Statevector } from './statevector.js'
import {
  expectSameState,
  fullState,
  randomCircuit,
  randomColumn,
} from './testing/random-circuits.js'

describe('the incremental budget (work plan M0.4)', () => {
  it(
    'edits the last column of 40 for under 15% of a full simulation',
    { timeout: 60_000 },
    () => {
      const qubits = 14
      const depth = 40
      const last = depth - 1
      const rounds = 8
      const rng = createRng(31415)
      const source = randomCircuit(rng, qubits, depth)
      const cache = createCheckpoints()

      // The same eight edits are replayed by both sides, so the comparison is
      // between two ways of computing identical results.
      const edits = Array.from({ length: rounds }, () =>
        randomColumn(rng, last, qubits)
      )

      // Warm the JIT and fill the cache. Without this the first measurement
      // would mostly be the compiler, which is real but is not the budget.
      run(source.build(), analyticMode(), cache)
      run(source.build())

      // Each phase is timed as a batch rather than per round: `Date.now()` has
      // millisecond resolution, and a single resumed edit is below it — timing
      // one would round the incremental side down to zero and prove nothing.
      const incremental: Statevector[] = []
      const editStarted = Date.now()
      for (const edited of edits) {
        source.columns[last] = edited
        invalidateFrom(cache, last)
        incremental.push(runFrom(cache, source.build(), last).state)
      }
      const editTime = Date.now() - editStarted

      const complete: Statevector[] = []
      const fullStarted = Date.now()
      for (const edited of edits) {
        source.columns[last] = edited
        complete.push(fullState(source.build()))
      }
      const fullTime = Date.now() - fullStarted

      // Comparing the two also makes the work unremovable: with nothing
      // observing the results, nothing stops an engine from eliminating it.
      for (let round = 0; round < rounds; round++) {
        expectSameState(incremental[round], complete[round], `round ${round}`)
      }

      const budget = `${rounds} edits took ${editTime} ms, ${rounds} full runs took ${fullTime} ms`
      expect(
        fullTime,
        `the full runs must be measurable — ${budget}`
      ).toBeGreaterThan(10)
      expect(editTime, budget).toBeLessThan(fullTime * 0.15)
    }
  )
})
