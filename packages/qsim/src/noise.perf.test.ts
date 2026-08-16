/**
 * The wall-clock budget for a noisy run — §3.3 at the size §3.3 works at.
 *
 * WHY THIS FILE IS `.perf.test.ts` AND NOT `.test.ts` — the same reason
 * `performance.perf.test.ts` and `density.perf.test.ts` set out: a timing
 * assertion running beside three other workspaces measures the scheduler
 * rather than the code, and a suite that goes red at random is a suite
 * everyone learns to ignore. The correctness of the channels is in
 * `noise.test.ts` and `verification/noise-channels.test.ts`, neither of which
 * looks at a clock.
 *
 * ────────────────────────────────────────────────────────────────────────
 * WHAT A NOISY RUN COSTS, AND WHY IT IS NOT THE SAME NUMBER AS A CLEAN ONE
 *
 * `density.perf.test.ts` budgets 100 unitary gates on a 10-qubit ρ at under
 * two seconds. Noise mode is several times that per gate, and the factor is
 * arithmetic rather than sloppiness. A gate is two sweeps of one 2×2 over ρ. A
 * profile's channel group is a depolarising channel (four Kraus operators) plus
 * amplitude and phase damping (two each) — eight operators, each costing two
 * 2×2 complex products per corner of ρ. At ten qubits one channel group over
 * one wire is 2.1 M complex products, and a hundred-gate circuit puts a group
 * on every wire a gate touched.
 *
 * The kernel is already close to what scalar Float64 in JavaScript can do, so
 * the budget below is a statement about the size of the problem and not about
 * how tight the loop is. Two things follow, and both are the point of having
 * the number written down:
 *
 *  - **The mode is comfortable where it is used and slow at its ceiling.** The
 *    cost is 4ⁿ, so six qubits is milliseconds, eight is under a second, ten is
 *    a wait, and twelve is a wait the UI has to be honest about. §3.3 calls
 *    this a study mode at 10–12 qubits, and this is what that sentence costs.
 *  - **The next gain is not in this file.** §5.6's phase 2 (SIMD in a WASM
 *    core) is 3–10×, and specialising each channel to its closed form is
 *    another large factor. Neither is done here: five specialised paths are
 *    five places a silent physics bug can live.
 *
 * WHAT THE SECOND TEST IS ACTUALLY DEFENDING. `applyChannel` walks ρ once and
 * allocates nothing, which is a memory decision before it is a speed one — the
 * copy-accumulate alternative would need two more density matrices, 768 MB at
 * the twelve-qubit ceiling against a 256 MB budget. Running a channel at that
 * ceiling is the cheapest continuous check that the decision has not been
 * quietly reversed: the rejected implementation would fail this by dying, which
 * is exactly the failure mode `assertDensityFits` exists to prevent.
 */

import { describe, expect, it } from 'vitest'

import { applyControlled, apply1q } from './apply.js'
import { alloc, fromStatevector, hermiticityDefect, trace } from './density.js'
import type { DensityMatrix } from './density.js'
import { GATE_MATRICES } from './gates.js'
import {
  NOISE_PROFILES,
  applyChannels,
  channelsForGate,
  depolarizingChannel,
} from './noise.js'
import type { KrausChannel } from './noise.js'
import { alloc as allocState } from './statevector.js'

/**
 * A ρ with no zero entries.
 *
 * Timing the channel on |0…0⟩⟨0…0| would measure a matrix that is one non-zero
 * entry wide for the first few operations, and any later "skip empty corners"
 * optimisation would look like a tenfold win on a benchmark and do nothing for
 * a real circuit. A Hadamard on every wire plus an entangling ladder is the
 * dense case, which is the case that has to fit the budget.
 */
function densityMatrix(qubits: number): DensityMatrix {
  const state = allocState(qubits)
  for (let q = 0; q < qubits; q++) apply1q(state, GATE_MATRICES.h, q)
  for (let q = 0; q + 1 < qubits; q++) {
    applyControlled(state, GATE_MATRICES.t, q, [{ qubit: q + 1, state: 1 }])
  }
  return fromStatevector(state)
}

/** A channel group on every wire, `rounds` times — the shape of a noisy run. */
function sweep(
  rho: DensityMatrix,
  channels: readonly KrausChannel[],
  rounds: number
): void {
  for (let round = 0; round < rounds; round++) {
    for (let q = 0; q < rho.qubits; q++) applyChannels(rho, channels, q)
  }
}

describe('noise-channel performance budget', () => {
  it(
    'runs a 50-gate noisy circuit on a 10-qubit ρ in under 12 s',
    { timeout: 300_000 },
    () => {
      // A profile's group is three channels and eight Kraus operators; fifty
      // gates touching one or two wires each is about a hundred applications
      // of it, which is what five rounds over ten wires comes to.
      const channels = channelsForGate(NOISE_PROFILES.superconducting, 2)
      expect(channels.map((c) => c.kind)).toEqual([
        'depolarizing',
        'amplitudeDamping',
        'phaseDamping',
      ])

      // Warm up on a small register: without it the reading is mostly the JIT
      // compiling the corner kernel for the first time.
      sweep(densityMatrix(6), channels, 10)

      let best = Number.POSITIVE_INFINITY
      for (let attempt = 0; attempt < 3; attempt++) {
        const rho = densityMatrix(10)
        const started = Date.now()
        sweep(rho, channels, 10)
        best = Math.min(best, Date.now() - started)

        // Reading the invariants also makes the work unremovable, and asserts
        // the run stayed physical while it was being timed.
        expect(trace(rho)).toBeCloseTo(1, 10)
        expect(hermiticityDefect(rho)).toBeLessThan(1e-10)
      }

      expect(
        best,
        `10 qubits × 100 channel groups took ${best} ms`
      ).toBeLessThan(12_000)
    }
  )

  it(
    'applies a channel at the documented ceiling without a second matrix',
    { timeout: 300_000 },
    () => {
      // Twelve qubits is `MAX_DENSITY_QUBITS`: 16.7 M entries, 256 MB. This
      // allocates one ρ and applies a four-operator channel to it in place.
      // The rejected copy-accumulate implementation would need 768 MB here.
      const rho = alloc(12)
      const started = Date.now()
      applyChannels(rho, [depolarizingChannel(0.01)], 11)
      const elapsed = Date.now() - started
      expect(trace(rho)).toBeCloseTo(1, 10)
      expect(
        elapsed,
        `one four-operator channel on 12 qubits took ${elapsed} ms`
      ).toBeLessThan(30_000)
    }
  )
})
