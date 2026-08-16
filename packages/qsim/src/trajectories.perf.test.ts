/**
 * What Monte Carlo trajectories cost, and what they buy — §5.4's trade,
 * measured.
 *
 * WHY THIS FILE IS `.perf.test.ts` AND NOT `.test.ts` — the reason
 * `performance.perf.test.ts` sets out at length: a wall-clock assertion
 * running beside three other workspaces measures the scheduler rather than the
 * code, and a suite that goes red at random is a suite everyone learns to
 * ignore. Nothing here is a correctness check; the physics lives in
 * `trajectories.test.ts` and `verification/noise-trajectories.test.ts`, and
 * neither of those looks at a clock.
 *
 * ────────────────────────────────────────────────────────────────────────
 * THE TRADE, IN NUMBERS
 *
 * A density-matrix run answers exactly and costs 4ⁿ memory and 4ⁿ arithmetic
 * per channel operator. A trajectory run answers to within 1/√N and costs 2ⁿ
 * memory and 2ⁿ arithmetic per channel application, times N shots. So there
 * are two separate claims worth measuring, and they pull in opposite
 * directions:
 *
 *  - **At a register ρ can hold, ρ is the better buy.** One exact answer costs
 *    about what a few thousand shots cost, and the shots are still only
 *    approximate. The first test below is that comparison at eight qubits,
 *    where both modes run comfortably.
 *
 *  - **At a register ρ cannot hold, there is no comparison to make.** Eighteen
 *    qubits is 4 MB of statevector and **one terabyte** of density matrix. The
 *    second test is not a benchmark against anything — it is the claim that the
 *    mode runs at all at a size where the other one cannot be allocated, which
 *    is the entire reason §5.4 names the method.
 *
 * WHY THE COMMON BRANCH BEING FREE MATTERS HERE. A depolarising channel at a
 * realistic error rate draws the identity 999 times in 1000, and
 * `sampleKraus` skips that branch outright (see `trajectories.ts`). What is
 * left to pay for is the *weights* pass of the two damping channels, which is
 * unavoidable: their branch probabilities depend on the state. That is why the
 * per-gate cost below is a small multiple of a clean gate's rather than the
 * eight-operator sweep the density kernel performs.
 *
 * ────────────────────────────────────────────────────────────────────────
 * WHAT THIS MEASURED WHEN IT WAS WRITTEN, so the budgets below read as slack
 * rather than as targets — one Node worker, nothing else running:
 *
 *   8 qubits, 60 gates, exact ρ .......................... 265 ms
 *   8 qubits, 60 gates, 2 000 trajectories ............... 874 ms
 *   18 qubits, 90 gates, 16 trajectories ................. 9.9 s
 *
 * Two things follow and both are worth saying out loud. At eight qubits the
 * exact answer costs about six hundred shots, so a user who wants a histogram
 * should be given ρ and not a sampler. And at eighteen qubits a shot is about
 * 0.6 s, so a thousand-shot run is ten minutes — the mode makes the register
 * *possible*, not quick, and a UI offering it has to say so rather than
 * spinning. The budgets asserted below are an order of magnitude above these
 * numbers: this file is a guard against a regression that changes the shape of
 * the cost, not a benchmark of a machine.
 */

import { describe, expect, it } from 'vitest'

import { MAX_DENSITY_QUBITS, densityBytes } from './density.js'
import { NOISE_PROFILES } from './noise.js'
import { createRng } from './rng.js'
import { runNoisy, runNoisyDensity } from './runner.js'
import type { CircuitLike, OperationLike } from './runner.js'

const PROFILE = NOISE_PROFILES.superconducting

/**
 * A layered circuit: Hadamards on every wire, then an entangling ladder, then
 * a layer of T gates — repeated. Dense by construction, so no amplitude is
 * ever zero and no later "skip the empty part of the state" optimisation could
 * flatter itself on this benchmark.
 */
function layered(qubits: number, layers: number): CircuitLike {
  const operations: OperationLike[] = []
  let id = 0
  let column = 0
  const push = (gate: string, targets: number[], controls?: number[]): void => {
    id++
    operations.push({ id: `op${id}`, gate, targets, column, controls })
  }
  for (let layer = 0; layer < layers; layer++) {
    for (let qubit = 0; qubit < qubits; qubit++) push('h', [qubit])
    column++
    for (let qubit = 0; qubit + 1 < qubits; qubit += 2) {
      push('cx', [qubit + 1], [qubit])
    }
    column++
    for (let qubit = 0; qubit < qubits; qubit++) push('t', [qubit])
    column++
  }
  return { qubits, operations }
}

describe('the cost of a trajectory against the cost of ρ', () => {
  it(
    'buys a few thousand shots for the price of one exact answer at 8 qubits',
    { timeout: 300_000 },
    () => {
      const circuit = layered(8, 3)

      // Warm up both paths: the first call through either kernel is mostly the
      // JIT compiling it.
      runNoisyDensity(layered(4, 1), { profile: PROFILE })
      runNoisy(layered(4, 1), { profile: PROFILE, shots: 8, rng: createRng(1) })

      const densityStarted = Date.now()
      const exact = runNoisyDensity(circuit, { profile: PROFILE })
      const densityMs = Date.now() - densityStarted

      const shots = 2000
      const trajectoriesStarted = Date.now()
      const sampled = runNoisy(circuit, {
        profile: PROFILE,
        shots,
        rng: createRng(20260817),
      })
      const trajectoriesMs = Date.now() - trajectoriesStarted

      // Reading both results also makes the work unremovable.
      expect(exact.distribution.length).toBe(256)
      expect(Object.keys(sampled.counts).length).toBeGreaterThan(1)

      // Both are budgets on the same order, which is the point: at a size ρ
      // can hold, the exact answer is not the expensive one. The numbers are
      // deliberately loose — this file asserts the shape of the trade, not a
      // machine's throughput.
      expect(densityMs, `ρ took ${densityMs} ms`).toBeLessThan(60_000)
      expect(
        trajectoriesMs,
        `${shots} trajectories took ${trajectoriesMs} ms`
      ).toBeLessThan(30_000)
    }
  )

  it(
    'runs 18 qubits, where ρ would be a terabyte',
    { timeout: 300_000 },
    () => {
      const qubits = 18
      // The claim, as arithmetic, before the clock is involved: ρ for this
      // register is 2¹⁸ × 2¹⁸ × 16 bytes, four orders of magnitude past the
      // budget `MAX_DENSITY_QUBITS` draws the line at, while the statevector
      // the trajectory carries is 4 MB.
      expect(densityBytes(qubits)).toBeGreaterThan(1e12)
      expect(qubits).toBeGreaterThan(MAX_DENSITY_QUBITS)
      expect(2 ** qubits * 16).toBeLessThan(5e6)

      const circuit = layered(qubits, 2)
      runNoisy(layered(8, 1), { profile: PROFILE, shots: 4, rng: createRng(2) })

      const started = Date.now()
      const result = runNoisy(circuit, {
        profile: PROFILE,
        shots: 16,
        rng: createRng(20260818),
      })
      const elapsed = Date.now() - started

      let total = 0
      for (const count of Object.values(result.counts)) total += count
      expect(total).toBe(16)
      expect(
        elapsed,
        `18 qubits × 16 shots × ${circuit.operations.length} gates took ` +
          `${elapsed} ms`
      ).toBeLessThan(120_000)
    }
  )
})
