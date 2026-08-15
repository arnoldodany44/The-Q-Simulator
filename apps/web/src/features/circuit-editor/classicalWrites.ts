/**
 * Who writes which classical bit, and in which instant.
 *
 * A column is one instant (§6). The engine groups a column's operations and
 * runs them in whatever order the array happens to hold, which is safe for
 * the quantum state — the contract guarantees the qubits of a column are
 * disjoint, and gates on disjoint qubits commute. The classical register is
 * the one thing that does not commute: two operations writing the *same* bit
 * in the *same* column give a different tally depending only on which of them
 * `operations` lists last, and `runner.ts` has no rule that could choose
 * between them. So the editor never builds that shape.
 *
 * ## Why it is reachable at all
 *
 * The editor's only way of choosing a classical bit is `draftOf`'s "the bit
 * carrying the qubit's index". That diagonal is a *default chosen at
 * placement*, not a property the document keeps: `addQubit`, `removeQubit`
 * and `reorderQubits` renumber the wires and deliberately leave the classical
 * register alone — deleting q0 must not move q1's result to another bit, and
 * must not renumber the bits a condition reads — so a measurement can end up
 * on a wire whose index is no longer its bit's. The next measurement placed
 * on the vacated index would then claim a bit that column already writes.
 *
 * ## Why the rule lives here and not in the contract
 *
 * `validateCircuit`'s per-column occupancy map tracks qubits only, so a
 * circuit arriving through `loadCircuit` — an import, a URL payload — can
 * still carry two writers of one bit. Teaching the contract that rule would
 * close it for every consumer at once and is where it belongs long term, but
 * it is a new validation code on a shipped contract and that is the owner's
 * call, not something to smuggle in through the editor.
 *
 * Until then this module is the editor's own construction rule, stated once.
 * Three gestures could break it — placing a measurement, dragging one across
 * wires, pasting one — and one shared function is what keeps those three from
 * growing three subtly different answers.
 */

import type { Circuit, Operation } from '@qsim/schema'

/**
 * The classical bits written in one column, each mapped to the operation
 * writing it. `ignoreId` drops an operation from the census, which is what
 * an operation being *moved* needs: it must not collide with itself.
 */
export function clbitWriters(
  operations: readonly Operation[],
  column: number,
  ignoreId?: string
): Map<number, string> {
  const writers = new Map<number, string>()
  for (const operation of operations) {
    if (operation.column !== column || operation.id === ignoreId) continue
    for (const clbit of operation.clbitTargets ?? []) {
      if (!writers.has(clbit)) writers.set(clbit, operation.id)
    }
  }
  return writers
}

/**
 * The bits a new operation should write, given the ones it would prefer.
 *
 * The preference is the diagonal — bit index equals qubit index — because
 * that is what `QuantumCircuit(n, n)` means and what a reader of the canvas
 * expects. It is only ever departed from when that bit is already spoken for
 * in the column, and then the answer is the lowest bit that is free rather
 * than a refusal: the user asked to measure a wire, and there is a bit that
 * can hold the result.
 *
 * `null` means the column has no room left — every bit of the register is
 * already written in it — and the caller refuses, because guessing is not
 * available and silently overwriting another measurement's bit is the very
 * shape this module exists to prevent.
 *
 * A preferred bit outside the register is passed through untouched. That is
 * a different problem with a different answer: the contract refuses it as
 * `clbit-out-of-range`, whose message names the remedy the gutter offers
 * ("add a classical bit"), and quietly writing the result to some lower free
 * bit instead would put it somewhere the user never asked for.
 */
export function freeClbits(
  circuit: Circuit,
  column: number,
  preferred: readonly number[]
): readonly number[] | null {
  const taken = new Set(clbitWriters(circuit.operations, column).keys())
  const chosen: number[] = []
  for (const bit of preferred) {
    if (bit < 0 || bit >= circuit.clbits) {
      chosen.push(bit)
      continue
    }
    const free = taken.has(bit) ? lowestFreeClbit(taken, circuit.clbits) : bit
    if (free === null) return null
    taken.add(free)
    chosen.push(free)
  }
  return chosen
}

/**
 * Whether adding these operations would put a second writer on any bit —
 * against the operations already there, and against each other.
 *
 * This is what a paste has to ask. A fragment's classical references travel
 * with its wires, so a fragment cut from a document whose diagonal had been
 * broken can land on a bit the destination column already writes, however
 * carefully the fragment itself was built.
 */
export function writesCollide(
  existing: readonly Operation[],
  added: readonly Operation[]
): boolean {
  const written = new Map<number, Set<number>>()
  const bitsOf = (operation: Operation): Set<number> =>
    new Set(operation.clbitTargets ?? [])

  for (const operation of existing) {
    const bits = bitsOf(operation)
    if (bits.size === 0) continue
    const column = written.get(operation.column) ?? new Set<number>()
    for (const clbit of bits) column.add(clbit)
    written.set(operation.column, column)
  }

  for (const operation of added) {
    const bits = bitsOf(operation)
    if (bits.size === 0) continue
    const column = written.get(operation.column) ?? new Set<number>()
    for (const clbit of bits) {
      if (column.has(clbit)) return true
      column.add(clbit)
    }
    written.set(operation.column, column)
  }
  return false
}

/** The lowest bit of the register nobody has claimed, or `null`. */
function lowestFreeClbit(
  taken: ReadonlySet<number>,
  clbits: number
): number | null {
  for (let bit = 0; bit < clbits; bit += 1) {
    if (!taken.has(bit)) return bit
  }
  return null
}
