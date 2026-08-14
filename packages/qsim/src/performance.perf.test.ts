/**
 * The budget from the work plan for M0.2: 20 qubits × 200 gates in under a
 * second. That is the size the live editor has to keep up with.
 *
 * WHY THIS FILE IS `.perf.test.ts` AND NOT `.test.ts`.
 *
 * A wall-clock assertion measures the machine as much as the code. `pnpm test`
 * runs through turbo, which builds and tests every workspace at once; this
 * circuit measures ~480 ms with the CPU to itself and has been observed above
 * 1000 ms inside a loaded `pnpm verify`, on identical code. A CI runner with
 * two vCPUs is more contended than any development machine, so keeping the
 * budget in the default suite buys random red — and a suite that goes red at
 * random is a suite everyone learns to ignore, which costs far more than this
 * assertion is worth.
 *
 * So the budget lives here, excluded from `pnpm test` and run on its own by
 * `pnpm --filter @qsim/core test:perf`. CI runs it in the dedicated engine job
 * where nothing competes with it.
 *
 * The correctness half of what this used to guard has not been dropped. The
 * §5.2 guarantee — that the kernel is O(2ⁿ) per gate and nobody has
 * "simplified" it into building 2ⁿ × 2ⁿ Kronecker matrices — is asserted in
 * numerical-stability.test.ts, which runs the same 20-qubit circuit inside the
 * normal suite. A Kronecker regression is about a million times slower, so it
 * cannot complete there at all, timing assertion or not.
 */

import { describe, expect, it } from 'vitest'

import { apply1q, applyControlled, applySwap } from './apply.js'
import { GATE_MATRICES, rzMatrix } from './gates.js'
import { alloc, norm, type Statevector } from './statevector.js'

const { h, t, x, z } = GATE_MATRICES

/**
 * Exactly `gates` operations, of the mix a real circuit has: fixed and
 * parametrised single-qubit gates, controlled gates spanning distant qubits
 * (the stride pattern the cache likes least) and swaps.
 */
function runCircuit(state: Statevector, gates: number): void {
  const n = state.qubits
  for (let k = 0; k < gates; k++) {
    const q = k % n
    switch (k % 6) {
      case 0:
        apply1q(state, h, q)
        break
      case 1:
        apply1q(state, rzMatrix(0.1 * k), q)
        break
      case 2:
        applyControlled(state, x, (q + 1) % n, [{ qubit: q, state: 1 }])
        break
      case 3:
        applyControlled(state, z, (q + n - 3) % n, [{ qubit: q, state: 1 }])
        break
      case 4:
        applySwap(state, q, (q + 7) % n)
        break
      default:
        apply1q(state, t, q)
        break
    }
  }
}

describe('performance budget', () => {
  // The timeout is generous on purpose: the budget is the assertion at the
  // end, not the runner's patience. A slow box should report the number it
  // measured, not a timeout with nothing to read.
  it(
    'simulates 20 qubits × 200 gates in well under a second',
    { timeout: 60_000 },
    () => {
      // Warm up on a small register first. Without it the measurement is
      // mostly the JIT compiling the kernel loops for the first time, which
      // is real but is not what the budget is about.
      runCircuit(alloc(12), 200)

      // Best of three. `turbo` runs every workspace's tests at once and CI
      // machines are shared, so a single wall-clock reading measures the
      // scheduler as much as the kernel. The minimum is the run that got the
      // CPU to itself, which is the number this budget is about; a genuine
      // regression in the kernel slows down all three.
      let best = Number.POSITIVE_INFINITY
      for (let attempt = 0; attempt < 3; attempt++) {
        const state = alloc(20)
        const started = Date.now()
        runCircuit(state, 200)
        best = Math.min(best, Date.now() - started)

        // Reading the norm also makes the work unremovable: with no
        // observation of the result, nothing stops a future engine from
        // eliminating the whole loop.
        expect(norm(state)).toBeCloseTo(1, 10)
      }

      expect(best, `20 qubits × 200 gates took ${best} ms`).toBeLessThan(1000)
    }
  )
})
