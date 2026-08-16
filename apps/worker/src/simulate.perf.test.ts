/**
 * The one number in the cost model that was inferred rather than measured.
 *
 * `UNIT_COST_MS` in `@qsim/jobs` carries a measurement for the *sampled* path —
 * `apps/web` recorded 3.5, 3.6 and 4.8 ·10⁻⁵ ms per unit across three orders of
 * magnitude of work — and derives the statevector figure from it by the factor
 * the trajectory path adds. That derivation decides most admissions on this
 * server, so it is checked here rather than trusted.
 *
 * A cost model that has quietly drifted is worse than none: it refuses cheap
 * work and admits expensive work with exactly the same confidence, and nothing
 * about the resulting behaviour says which of the two just happened.
 *
 * Excluded from the default suite by `vitest.config.ts`, like every wall-clock
 * assertion in this repository. Run it deliberately:
 *
 *   pnpm --filter worker exec vitest run src/simulate.perf.test.ts
 */

import { UNIT_COST_MS, simulationWork } from '@qsim/jobs'
import { describe, expect, it } from 'vitest'
import { runSimulationJob } from './simulate.js'
import { jobPayload, wideCircuit } from './testing/payloads.js'

const CEILINGS = { maxQubits: 24, timeoutMs: 60_000 }
const noop = (): void => undefined

/**
 * How far above the assumed unit cost a real measurement may land.
 *
 * Four, and it is a tolerance rather than a target. The suite runs on whatever
 * machine happens to be free — a laptop on battery, a shared CI box, a
 * container with a fraction of a core — and the constant it is defending is a
 * budget with its own factor of two of headroom already built in
 * (`workBudgetFor` targets half the window). What this catches is an
 * order-of-magnitude error, which is the kind that makes the admission check
 * meaningless in one direction or the other.
 */
const TOLERANCE = 4

describe('the statevector unit cost', () => {
  it('is within a small multiple of what limits.ts assumes', () => {
    // Sixteen qubits over forty columns: 65 536 amplitudes × 640 operations ≈
    // 4·10⁷ work units, which is a second or so of arithmetic — big enough that
    // process startup and the parse are noise, small enough to run in a suite.
    const circuit = wideCircuit(16, 40)
    const work = simulationWork({
      mode: 'STATEVECTOR',
      qubits: circuit.qubits,
      operations: circuit.operations.length,
      shots: null,
    })

    const started = performance.now()
    runSimulationJob(jobPayload({ circuit }), noop, CEILINGS)
    const elapsed = performance.now() - started

    const measured = elapsed / work
    expect(measured).toBeLessThan(UNIT_COST_MS.STATEVECTOR * TOLERANCE)
  })
})

describe('the wall-clock bound is reachable', () => {
  it('admits work it can actually finish', () => {
    /*
     * The other direction, and the one a pure-arithmetic test cannot check: the
     * budget is only meaningful if work *at* the budget finishes inside the
     * bound. A tenth of the sixty-second budget is measured here and
     * extrapolated, because measuring the whole of it would be a minute-long
     * test.
     */
    const circuit = wideCircuit(18, 20)
    const work = simulationWork({
      mode: 'STATEVECTOR',
      qubits: circuit.qubits,
      operations: circuit.operations.length,
      shots: null,
    })

    const started = performance.now()
    runSimulationJob(jobPayload({ circuit }), noop, CEILINGS)
    const elapsed = performance.now() - started

    // Extrapolated to the full budget, the run must fit the timeout it was
    // admitted against.
    const budget = CEILINGS.timeoutMs / 2 / UNIT_COST_MS.STATEVECTOR
    const projected = (elapsed / work) * budget
    expect(projected).toBeLessThan(CEILINGS.timeoutMs * TOLERANCE)
  })
})
