/**
 * The wall-clock budget for the noise mode of §3.3, at the top of the range
 * §3.3 gives it.
 *
 * WHY THIS FILE IS `.perf.test.ts` AND NOT `.test.ts` — the same reason
 * `performance.perf.test.ts` sets out at length: a timing assertion running
 * beside three other workspaces measures the scheduler rather than the code,
 * and a suite that goes red at random is a suite everyone learns to ignore.
 * The correctness half — that ρ → UρU† is O(4ⁿ) and nobody has "simplified"
 * it into two 2ⁿ × 2ⁿ matrix products — is asserted in `density.test.ts`,
 * inside the normal suite, by running a register large enough that the O(8ⁿ)
 * version could not finish there at all.
 *
 * THE BUDGET. Twelve qubits is the documented ceiling and a 256 MB matrix; ten
 * is where the mode is comfortable and where the editor will actually sit, at
 * 16 MB and a million entries. Each gate is two sweeps over those entries, so
 * a hundred gates is 200 million complex updates. Under two seconds is the bar:
 * noise mode is not the live-editing path — it is a mode the reader switches
 * into and waits a moment for — but it has to stay inside the range where a
 * progress spinner is honest rather than a lie about a frozen tab.
 */

import { describe, expect, it } from 'vitest'

import {
  alloc,
  applyControlled,
  applySwap,
  apply1q,
  isHermitian,
  trace,
} from './density.js'
import type { DensityMatrix } from './density.js'
import { GATE_MATRICES, rzMatrix } from './gates.js'

const { h, t, x, z } = GATE_MATRICES

/** The same mix `performance.perf.test.ts` uses, against a density matrix. */
function runCircuit(rho: DensityMatrix, gates: number): void {
  const n = rho.qubits
  for (let k = 0; k < gates; k++) {
    const q = k % n
    switch (k % 6) {
      case 0:
        apply1q(rho, h, q)
        break
      case 1:
        apply1q(rho, rzMatrix(0.1 * k), q)
        break
      case 2:
        applyControlled(rho, x, (q + 1) % n, [{ qubit: q, state: 1 }])
        break
      case 3:
        applyControlled(rho, z, (q + n - 3) % n, [{ qubit: q, state: 1 }])
        break
      case 4:
        applySwap(rho, q, (q + 7) % n)
        break
      default:
        apply1q(rho, t, q)
        break
    }
  }
}

describe('noise-mode performance budget', () => {
  it(
    'evolves a 10-qubit density matrix through 100 gates in under 2 s',
    { timeout: 120_000 },
    () => {
      // Warm up on a small register: without it the reading is mostly the JIT
      // compiling the two kernel passes for the first time.
      runCircuit(alloc(6), 100)

      let best = Number.POSITIVE_INFINITY
      for (let attempt = 0; attempt < 3; attempt++) {
        const rho = alloc(10)
        const started = Date.now()
        runCircuit(rho, 100)
        best = Math.min(best, Date.now() - started)

        // Reading the trace also makes the work unremovable, and asserts the
        // run stayed physical while it was being timed.
        expect(trace(rho)).toBeCloseTo(1, 10)
        expect(isHermitian(rho)).toBe(true)
      }

      expect(best, `10 qubits × 100 gates took ${best} ms`).toBeLessThan(2000)
    }
  )
})
