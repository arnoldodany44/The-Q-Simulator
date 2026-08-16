/**
 * The wall-clock budgets behind two claims the §3.2 panel makes by existing.
 *
 * WHY THIS FILE IS `.perf.test.ts` — the same reason `performance.perf.test.ts`
 * sets out at length: a timing assertion running beside three other
 * workspaces measures the scheduler rather than the code, and a suite that
 * goes red at random is a suite everyone learns to ignore.
 *
 * THE TWO CLAIMS.
 *
 * 1. **Per-qubit entropy is free at any register size.** `qubitEntropy` reads
 *    a closed form off the Bloch length instead of decomposing anything, so a
 *    twenty-qubit register — twenty passes over a million amplitudes — is a
 *    live-editing operation and not a mode the reader waits for. If someone
 *    "simplifies" it into `vonNeumannEntropy(partialTrace(state, [q]))` the
 *    answer stays correct to the last digit and this budget blows, which is
 *    exactly the kind of regression a correctness suite cannot see.
 *
 * 2. **`MAX_EIGEN_DIM` is where it is for a measured reason.** The ceiling is
 *    128 because one decomposition of a dense 128×128 Hermitian matrix takes
 *    about a sixth of a second, and the next power of two takes two seconds.
 *    The budget here is a second — six times the measurement, because a CI
 *    box is not a laptop — and it is the assertion that would notice if the
 *    iteration ever lost its row-major access pattern and went back to
 *    striding down columns.
 *
 * THE FIXTURE FOR (2) IS A RANDOM DENSE MATRIX, NOT A DENSITY MATRIX, and
 * that is deliberate. Every ρ a circuit produces is easy for Jacobi in one
 * way or another: a subsystem of a pure state has rank at most 2^(qubits
 * outside it), and a heavily scrambled state's reduced ρ is near I/2ᵏ, which
 * is nearly diagonal already. Both converge in a fraction of the sweeps. The
 * ceiling has to hold for the hard case, so the hard case is what is timed.
 */

import { describe, expect, it } from 'vitest'

import { applyControlled, apply1q } from './apply.js'
import { MAX_EIGEN_DIM, eigenvaluesHermitian } from './eigen.js'
import type { HermitianMatrix } from './eigen.js'
import { GATE_MATRICES } from './gates.js'
import { qubitEntropy, subsystemEntropy } from './metrics.js'
import { createRng } from './rng.js'
import { alloc } from './statevector.js'
import type { Statevector } from './statevector.js'

const { h, t, x } = GATE_MATRICES

/** GHZ on n qubits — entangled everywhere, so no path can take a shortcut. */
function ghz(qubits: number): Statevector {
  const state = alloc(qubits)
  apply1q(state, h, 0)
  for (let qubit = 1; qubit < qubits; qubit++) {
    applyControlled(state, x, qubit, [{ qubit: qubit - 1, state: 1 }])
  }
  return state
}

/** A seeded dense Hermitian matrix — the worst case for a Jacobi sweep. */
function denseHermitian(dim: number, seed: number): HermitianMatrix {
  const rng = createRng(seed)
  const re = new Float64Array(dim * dim)
  const im = new Float64Array(dim * dim)
  for (let row = 0; row < dim; row++) {
    for (let column = row; column < dim; column++) {
      const vr = rng.next() * 2 - 1
      const vi = row === column ? 0 : rng.next() * 2 - 1
      re[row * dim + column] = vr
      im[row * dim + column] = vi
      re[column * dim + row] = vr
      im[column * dim + row] = -vi
    }
  }
  return { dim, re, im }
}

describe('entanglement-metric budgets', () => {
  it(
    'reads every qubit of a 20-qubit register in under 1 s',
    { timeout: 120_000 },
    () => {
      // Warm up so the reading is the loop rather than the JIT compiling it.
      const small = ghz(12)
      for (let qubit = 0; qubit < small.qubits; qubit++) {
        qubitEntropy(small, qubit)
      }

      const state = ghz(20)
      let best = Number.POSITIVE_INFINITY
      for (let attempt = 0; attempt < 3; attempt++) {
        const started = Date.now()
        let total = 0
        for (let qubit = 0; qubit < state.qubits; qubit++) {
          total += qubitEntropy(state, qubit)
        }
        best = Math.min(best, Date.now() - started)
        // Reading the answer makes the work unremovable and asserts it stayed
        // correct while it was being timed: every qubit of GHZ reads 1 bit.
        expect(total).toBeCloseTo(state.qubits, 8)
      }
      expect(best, `20 Bloch entropies took ${best} ms`).toBeLessThan(1000)
    }
  )

  it(
    'decomposes a dense matrix at the ceiling in under 1 s',
    { timeout: 120_000 },
    () => {
      eigenvaluesHermitian(denseHermitian(32, 1))

      const matrix = denseHermitian(MAX_EIGEN_DIM, 20250816)
      let trace = 0
      for (let i = 0; i < MAX_EIGEN_DIM; i++) {
        trace += matrix.re[i * MAX_EIGEN_DIM + i]
      }

      let best = Number.POSITIVE_INFINITY
      for (let attempt = 0; attempt < 3; attempt++) {
        const started = Date.now()
        const values = eigenvaluesHermitian(matrix)
        best = Math.min(best, Date.now() - started)
        // Unremovable, and the cheapest correctness check there is on a
        // spectrum: it has to sum to the trace.
        let sum = 0
        for (const value of values) sum += value
        expect(sum).toBeCloseTo(trace, 8)
      }
      expect(
        best,
        `a ${MAX_EIGEN_DIM}×${MAX_EIGEN_DIM} decomposition took ${best} ms`
      ).toBeLessThan(1000)
    }
  )

  it('still reads the widest allowed subsystem correctly', () => {
    // The correctness half of the ceiling, untimed: seven qubits is what
    // `MAX_SUBSYSTEM_QUBITS` admits, and every proper subsystem of GHZ
    // carries exactly one bit.
    expect(subsystemEntropy(ghz(10), [0, 1, 2, 3, 4, 5, 6])).toBeCloseTo(1, 8)
    // And a scrambled state, where the answer is not one line of algebra.
    const scrambled = alloc(10)
    for (let round = 0; round < 2; round++) {
      for (let qubit = 0; qubit < 10; qubit++) {
        apply1q(scrambled, h, qubit)
        apply1q(scrambled, t, qubit)
      }
      for (let qubit = 0; qubit < 10; qubit++) {
        applyControlled(scrambled, x, (qubit + 1) % 10, [{ qubit, state: 1 }])
      }
    }
    const bits = subsystemEntropy(scrambled, [0, 1, 2, 3, 4, 5, 6])
    // Seven qubits cut from ten: the other side is three wide, so the shared
    // entropy cannot exceed three bits however scrambled the state is.
    expect(bits).toBeGreaterThan(0)
    expect(bits).toBeLessThanOrEqual(3 + 1e-9)
  })
})
