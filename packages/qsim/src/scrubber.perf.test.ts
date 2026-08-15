/**
 * The M0.8 budget: walking a 20-column circuit one column at a time must cost
 * under 16 ms per step.
 *
 * Sixteen milliseconds is one frame at 60 Hz, which is what "fluido" in the
 * work plan means — a scrubber that stays inside a frame per step can be held
 * down, or played back automatically, without the picture falling behind the
 * bar it is supposed to be describing.
 *
 * WHY THIS IS `.perf.test.ts` AND NOT PART OF THE DEFAULT SUITE. The same
 * reason as its two neighbours, argued at length in `performance.perf.test.ts`:
 * a wall-clock assertion measures the machine as much as the code, `pnpm test`
 * runs four workspaces at once through turbo, and a suite that goes red at
 * random is a suite everyone learns to ignore. The *correctness* half of the
 * scrubber primitive — that the state after every column equals a truncated
 * run, and that the last column equals a full one — is asserted in
 * checkpoints.test.ts, inside the default suite, where it belongs.
 *
 * WHAT MAKES THE BUDGET REACHABLE, and therefore what this guards. A step
 * resumes from the newest checkpoint at or before the column asked for, so it
 * replays at most `interval` columns rather than the whole circuit — and a
 * forward walk *writes* checkpoints as it passes, so it pays that cost once
 * and every later pass over the same timeline is cheaper. Take the cache away
 * and every step becomes a full simulation of all twenty columns instead of
 * the four it averages here, which is the difference between a timeline you
 * can scrub and a timeline you can only nudge.
 *
 *   pnpm --filter @qsim/core test:perf
 */

import { describe, expect, it } from 'vitest'

import { analyticMode } from './measure.js'
import { createRng } from './rng.js'
import { createCheckpoints, run, stateAfterColumn } from './runner.js'
import type { Statevector } from './statevector.js'
import {
  expectSameState,
  fullState,
  randomCircuit,
} from './testing/random-circuits.js'

/**
 * Fourteen qubits, the register the M0.4 budget already uses. A tab holds
 * 16 384 amplitudes without noticing, and it is far enough past the timer's
 * resolution that an implementation which quietly re-simulated everything
 * could not hide inside the measurement.
 */
const QUBITS = 14

/** The depth the work plan names. */
const DEPTH = 20

/** One frame at 60 Hz. */
const BUDGET_MS = 16

describe('the scrubber budget (work plan M0.8)', () => {
  it(
    'steps through a 20-column circuit inside a frame per step',
    { timeout: 60_000 },
    () => {
      const rng = createRng(90210)
      const circuit = randomCircuit(rng, QUBITS, DEPTH).build()
      const cache = createCheckpoints()

      // Warmed the way the editor warms it: the analysis panel has already run
      // this circuit once before anybody reaches for the timeline. Without it
      // the first measurements would mostly be the compiler, which is real but
      // is not the budget.
      run(circuit, analyticMode(), cache)

      /*
       * The positions a reader walks, in order. `-1` is the state before
       * column 0 — the ground state, and where playback starts — and the walk
       * then runs to the end and back, because backwards is the expensive
       * direction: going forwards the cache is being written as the walk
       * passes, going backwards it can only be read.
       */
      const positions: number[] = []
      for (let column = -1; column < DEPTH; column++) positions.push(column)
      for (let column = DEPTH - 2; column >= -1; column--)
        positions.push(column)

      let worst = 0
      let worstAt = -1
      let total = 0
      // Kept rather than discarded: with nothing observing the results,
      // nothing stops an engine from eliminating the work that produced them.
      const states = new Map<number, Statevector>()

      for (const column of positions) {
        const started = performance.now()
        const state = stateAfterColumn(cache, circuit, column)
        const elapsed = performance.now() - started
        total += elapsed
        if (elapsed > worst) {
          worst = elapsed
          worstAt = column
        }
        states.set(column, state)
      }

      const mean = total / positions.length
      const budget =
        `${positions.length} steps took ${total.toFixed(1)} ms — ` +
        `${mean.toFixed(2)} ms on average, worst ${worst.toFixed(2)} ms ` +
        `at column ${worstAt}`

      // Every step, not merely the average. A mean inside the budget with one
      // step outside it is a scrubber that stutters, and it stutters in the
      // same place every time — which is exactly what a reader notices.
      expect(worst, budget).toBeLessThan(BUDGET_MS)

      // And it walked the real timeline: the last column is the whole circuit,
      // and the position before the first column is the ground state.
      expectSameState(states.get(DEPTH - 1)!, fullState(circuit), 'last column')
      expectSameState(
        states.get(-1)!,
        fullState({ ...circuit, operations: [] }),
        'before the first column'
      )
    }
  )
})
