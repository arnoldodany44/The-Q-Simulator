/**
 * Which execution mode a circuit needs — §5.3, read off the document.
 *
 * Analytic mode returns one final statevector, and a circuit that measures
 * before it ends does not have one: each run collapses differently, so the
 * honest answer is a tally over many runs rather than a vector. The engine
 * enforces that itself (`rejectMidCircuit` in `runner.ts` throws
 * `MidCircuitMeasurementError`), and until M0.9 the editor simply let it: a
 * teleportation circuit reached the worker in analytic mode and came back as
 * an error the reader could do nothing about.
 *
 * This function is the other half. It asks the same question of the same two
 * shapes the runner asks it of — a `measure`, or an operation carrying a
 * `condition` — so the panel chooses trajectories mode for exactly the
 * circuits analytic mode would have refused, and for no others.
 *
 * WHAT IS DELIBERATELY NOT HERE: `reset`. A reset in the middle of a
 * superposition is genuinely random and needs trajectories too, but whether a
 * given reset is in that position depends on the *state* at that column, not
 * on the document — and the runner lets the two deterministic cases through
 * precisely so that "reset a wire back to |0⟩" stays an analytic circuit.
 * Deciding statically here would send every circuit containing a reset to a
 * shot tally, throwing away an exact answer the engine was willing to give.
 * The engine's refusal remains the backstop for the case that is genuinely
 * random.
 */

import type { ExecutionMode } from '@qsim/core'
import type { Circuit } from '@qsim/schema'

/** Whether analytic mode would refuse this circuit. */
export function needsTrajectories(circuit: Circuit): boolean {
  return circuit.operations.some(
    (operation) =>
      operation.gate === 'measure' || operation.condition !== undefined
  )
}

/** The mode to run this circuit in. */
export function executionModeFor(circuit: Circuit): ExecutionMode {
  return needsTrajectories(circuit) ? 'trajectories' : 'analytic'
}
