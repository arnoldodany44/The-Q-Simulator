/**
 * The circuit the first column simulates.
 *
 * ════════════════════════════════════════════════════════════════════════
 * A HARDWARE CIRCUIT MEASURES, AND ANALYTIC MODE REFUSES ONE THAT DOES
 *
 * Every circuit that reaches a device ends in measurement — the transpiler
 * refuses one that does not, because «a backend answers with bits and with
 * nothing else». And `@qsim/core`'s analytic mode refuses any circuit
 * containing a `measure` or a classical condition, for the reason its
 * `rejectMidCircuit` gives: there is no single statevector after a measurement,
 * only one per outcome.
 *
 * Those two facts collide exactly here, and the resolution is not a workaround:
 * the ideal column is a picture of **the state the device measured**, so what it
 * must simulate is the circuit *up to* its measurements. Removing a terminal
 * measurement changes nothing about the state — it is the last thing that
 * happens — and what is left is precisely the distribution the device sampled.
 *
 * ════════════════════════════════════════════════════════════════════════
 * BUT ONLY WHEN THE MEASUREMENTS REALLY ARE THE LAST THING
 *
 * A measurement in the middle of a circuit is a different animal. Delete it and
 * the wire it was on stays coherent through everything that follows, so the
 * remaining circuit evolves a superposition the real run collapsed — and the
 * "ideal" column would be a picture of a computation that never happened,
 * differing from the device's answer by an amount that looks exactly like
 * hardware error.
 *
 * The same is true of a classical condition, more obviously: a conditioned gate
 * ran on the device for some shots and not for others, and no single unitary
 * describes that.
 *
 * So both are refused by name rather than silently dropped. A teleportation
 * circuit has no ideal statevector to draw beside its device counts, and saying
 * so is the honest rendering — the counts themselves are still shown.
 */

import type { Circuit, Operation } from '@qsim/schema'
import { safeExpandCircuit } from '@qsim/schema'

/** Why a circuit has no single ideal state to draw. */
export type IdealRefusal =
  /** A gate runs only for some shots, so no one unitary describes the run. */
  | 'conditioned'
  /** A measurement with work after it on the same wire. */
  | 'mid-circuit-measurement'

export type IdealCircuit =
  | { readonly ok: true; readonly circuit: Circuit }
  | { readonly ok: false; readonly code: IdealRefusal }

/**
 * The circuit with its terminal measurements removed, or a refusal.
 *
 * Read from the expanded circuit, the same reading `gateCount`, `depth` and
 * `alignMeasurements` take — a measurement packaged inside a block is still a
 * measurement, and one that ran mid-circuit is still mid-circuit.
 *
 * "Terminal" is decided per wire and by column, which is the only definition
 * that survives the contract's model of time: everything in one column happens
 * at once, so a measurement in column 4 is terminal for its qubit when nothing
 * in column 5 or later touches that qubit. Two measurements of different wires
 * in different columns are both terminal, which a naive "is it the last
 * operation in the document" test would get wrong on every circuit whose
 * measurements are staggered.
 *
 * `reset` is left alone. The engine accepts it in analytic mode, and unlike a
 * measurement it does not branch: whatever the state was, the wire is now |0⟩.
 */
export function idealCircuitOf(circuit: Circuit): IdealCircuit {
  const flat = safeExpandCircuit(circuit)?.circuit ?? circuit

  /** The last column any operation touches each qubit in. */
  const lastTouch = new Map<number, number>()
  for (const operation of flat.operations) {
    if (operation.gate === 'measure' || operation.gate === 'barrier') continue
    for (const wire of wiresOf(operation)) {
      lastTouch.set(wire, Math.max(lastTouch.get(wire) ?? -1, operation.column))
    }
  }

  for (const operation of flat.operations) {
    if (operation.condition !== undefined) {
      return { ok: false, code: 'conditioned' }
    }
    if (operation.gate !== 'measure') continue
    for (const wire of wiresOf(operation)) {
      if ((lastTouch.get(wire) ?? -1) > operation.column) {
        return { ok: false, code: 'mid-circuit-measurement' }
      }
    }
  }

  return {
    ok: true,
    circuit: {
      ...flat,
      operations: flat.operations.filter(
        (operation) => operation.gate !== 'measure'
      ),
    },
  }
}

/**
 * Every qubit an operation acts on, controls included.
 *
 * Controls count: a `cx` whose control is a measured wire is work on that wire,
 * and a measurement followed by it is mid-circuit even though the measured
 * qubit is nobody's target.
 */
function wiresOf(operation: Operation): readonly number[] {
  const controls = (operation.controls ?? []).map((control) =>
    typeof control === 'number' ? control : control.qubit
  )
  return [...operation.targets, ...controls]
}
