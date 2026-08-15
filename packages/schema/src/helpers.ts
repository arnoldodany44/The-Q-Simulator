/**
 * Pure helpers over the circuit contract.
 *
 * Every function here is total and side-effect free: it takes a circuit and
 * returns a number or a new circuit, never a mutated one. The editor keeps
 * circuits in React state, so mutating one in place would be invisible to
 * rendering and painful to undo.
 */

import {
  CIRCUIT_SCHEMA_VERSION,
  MAX_CLBITS,
  MAX_QUBITS,
  type Circuit,
  type Control,
  type ControlSpec,
  type Operation,
  type Parameter,
} from './circuit.js'
import { lookupGate } from './gates.js'

/** A bare number means a positive control: fires when the qubit reads |1⟩. */
export function normalizeControl(control: Control): ControlSpec {
  return typeof control === 'number' ? { qubit: control, state: 1 } : control
}

/** Every control of an operation in its explicit `{ qubit, state }` form. */
export function controlsOf(operation: Operation): ControlSpec[] {
  return (operation.controls ?? []).map(normalizeControl)
}

/**
 * Every qubit an operation occupies, targets and controls alike. Both kinds
 * block the column: a control wire crossing a qubit still reserves it.
 */
export function qubitsOf(operation: Operation): number[] {
  const qubits = [...operation.targets]
  for (const control of controlsOf(operation)) qubits.push(control.qubit)
  return qubits
}

/**
 * Number of gates in the circuit, in the sense a challenge leaderboard means
 * it: barriers, resets and measurements are not gates, they are structure.
 * Use `circuit.operations.length` when you want the raw count instead.
 *
 * A custom gate counts as one gate, not as the size of its body — that is
 * the whole point of packaging a subcircuit.
 */
export function gateCount(circuit: Circuit): number {
  let count = 0
  for (const operation of circuit.operations) {
    if (lookupGate(operation.gate)?.category === 'structural') continue
    count++
  }
  return count
}

/**
 * Circuit depth: how many time steps the circuit really takes.
 *
 * Counted as the number of *occupied* columns, which has two consequences
 * worth stating:
 *
 *  - Gaps do not count. A circuit whose operations sit in columns 0 and 7
 *    has depth 2, so `depth(c) === depth(normalizeColumns(c))` always holds
 *    and a half-finished drag cannot inflate the number.
 *  - Barriers do not count. A barrier is an instruction to the optimiser,
 *    not an operation on the state; Qiskit's `depth()` ignores them too, and
 *    matching it keeps our numbers comparable. `reset` and `measure` do
 *    count: they are real work on real hardware.
 *
 * Everything in one column happens at once, so a `cx` spanning two qubits
 * adds one to the depth, not two.
 */
export function depth(circuit: Circuit): number {
  const occupied = new Set<number>()
  for (const operation of circuit.operations) {
    if (operation.gate === 'barrier') continue
    occupied.add(operation.column)
  }
  return occupied.size
}

/**
 * Close the gaps in the column numbering, so occupied columns become
 * `0, 1, 2, …` in their original order.
 *
 * Editing leaves holes — delete every gate in column 3 and the circuit
 * still claims a column 3. This is what the editor calls after a delete and
 * what the QASM exporter calls before emitting, since QASM has no notion of
 * an empty moment.
 *
 * Operation order within the array is preserved, because the editor's undo
 * stack and React keys both depend on it.
 */
export function normalizeColumns(circuit: Circuit): Circuit {
  const used = [...new Set(circuit.operations.map((op) => op.column))].sort(
    (a, b) => a - b
  )
  const remapped = new Map(used.map((column, index) => [column, index]))
  return {
    ...circuit,
    operations: circuit.operations.map((operation) => ({
      ...operation,
      // The lookup always hits; `??` avoids a non-null assertion.
      column: remapped.get(operation.column) ?? operation.column,
    })),
  }
}

/** A valid, empty circuit — the starting point of every new document. */
export function emptyCircuit(qubits: number, clbits = 0): Circuit {
  if (!Number.isInteger(qubits) || qubits < 1 || qubits > MAX_QUBITS) {
    throw new RangeError(
      `A circuit needs between 1 and ${MAX_QUBITS} qubits, got ${qubits}.`
    )
  }
  if (!Number.isInteger(clbits) || clbits < 0 || clbits > MAX_CLBITS) {
    throw new RangeError(
      `A circuit needs between 0 and ${MAX_CLBITS} classical bits, ` +
        `got ${clbits}.`
    )
  }
  return {
    schemaVersion: CIRCUIT_SCHEMA_VERSION,
    qubits,
    clbits,
    operations: [],
  }
}

/**
 * An operation's parameters as plain numbers, resolving symbolic references
 * against the circuit's `parameters`. This is the last step before the
 * engine builds a gate matrix, which is why it returns radians and not a
 * union type.
 *
 * Throws on an unknown name. A circuit that passed `validateCircuit()`
 * cannot reach that throw, so it signals a bug rather than bad user input.
 */
export function resolveParams(
  operation: Operation,
  parameters: readonly Parameter[] = []
): number[] {
  return (operation.params ?? []).map((param) => {
    if (typeof param === 'number') return param
    const declared = parameters.find((candidate) => candidate.name === param)
    if (declared === undefined) {
      throw new Error(
        `Operation "${operation.id}" references parameter "${param}", ` +
          `which is not declared in the circuit.`
      )
    }
    return declared.value
  })
}
