/**
 * The circuit contract, written as itself — the native format of §6.
 *
 * This is the export with no translation in it at all, and it is the one that
 * matters most: the other three formats lose something (a symbolic parameter
 * becomes a literal, a wire label becomes a comment, a diagram becomes
 * pixels), and this one loses nothing. It is what somebody sends back to
 * re-open the circuit exactly as it was.
 *
 * Two things it does beyond `JSON.stringify(circuit)`:
 *
 *  1. **A fixed key order.** `JSON.stringify` follows insertion order, which
 *     depends on how the object happened to be built — a circuit from the
 *     editor and the same circuit round-tripped through the API can produce
 *     byte-different files. An exported file is a thing people diff and commit,
 *     so the order is the schema's own, declared once here.
 *  2. **Undefined fields are dropped rather than emitted as null.** The
 *     schema's optional fields are absent-or-present, and `null` is neither —
 *     it would fail `parseCircuit` on the way back in.
 *
 * Indented with two spaces and ending in a newline, because it is a file in a
 * repository as often as it is a download.
 */

import type { Circuit, CustomGate, Operation } from '@qsim/schema'

/** Serialise a circuit as the native JSON document, ready to write to a file. */
export function toCircuitJson(circuit: Circuit): string {
  return `${JSON.stringify(orderedCircuit(circuit), null, 2)}\n`
}

/**
 * The same document with its keys in the order `circuit.ts` declares them.
 *
 * Written as explicit object literals rather than a generic key sorter: a
 * sorter would put `clbits` before `qubits` and scatter `column` into the
 * middle of an operation, which is alphabetical and unreadable. The order a
 * person wants is the order the schema is written in.
 */
function orderedCircuit(circuit: Circuit): Record<string, unknown> {
  return withoutUndefined({
    schemaVersion: circuit.schemaVersion,
    qubits: circuit.qubits,
    clbits: circuit.clbits,
    qubitLabels: circuit.qubitLabels,
    parameters: circuit.parameters?.map((parameter) => ({
      name: parameter.name,
      value: parameter.value,
    })),
    operations: circuit.operations.map(orderedOperation),
    customGates: orderedCustomGates(circuit.customGates),
  })
}

function orderedOperation(operation: Operation): Record<string, unknown> {
  return withoutUndefined({
    id: operation.id,
    gate: operation.gate,
    targets: [...operation.targets],
    controls: operation.controls?.map((control) =>
      typeof control === 'number'
        ? control
        : { qubit: control.qubit, state: control.state }
    ),
    params: operation.params === undefined ? undefined : [...operation.params],
    column: operation.column,
    clbitTargets:
      operation.clbitTargets === undefined
        ? undefined
        : [...operation.clbitTargets],
    condition:
      operation.condition === undefined
        ? undefined
        : {
            clbit: operation.condition.clbit,
            equals: operation.condition.equals,
          },
  })
}

function orderedCustomGates(
  customGates: Readonly<Record<string, CustomGate>> | undefined
): Record<string, unknown> | undefined {
  if (customGates === undefined) return undefined
  const entries = Object.entries(customGates).map(([name, definition]) => [
    name,
    withoutUndefined({
      qubits: definition.qubits,
      symbol: definition.symbol,
      operations: definition.operations.map(orderedOperation),
    }),
  ])
  return Object.fromEntries(entries) as Record<string, unknown>
}

/** Drops absent optional fields, so none of them is written as `null`. */
function withoutUndefined(
  value: Record<string, unknown>
): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(value).filter(([, entry]) => entry !== undefined)
  )
}
