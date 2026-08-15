/**
 * Which column an edit invalidated — the input the incremental cache of
 * §5.6.3 cannot work without.
 *
 * The runner keeps a checkpoint every few columns so that editing column 30
 * of 40 replays a handful of columns instead of forty. Resuming is only
 * correct if the caller names the *earliest* column the edit touched:
 * `invalidateFrom` drops the checkpoints at or after it, and whatever is left
 * is assumed to still describe the circuit. Name a column too late and the run
 * resumes from a state the edit already contradicted, producing a perfectly
 * normalised statevector that belongs to no circuit at all — no exception, no
 * NaN, just a wrong answer. That is why this is a module with its own tests
 * rather than three lines inside the hook.
 *
 * The rules, in order of how much they cost:
 *
 *  - A different register, or a different set of custom gates, invalidates
 *    everything. The cached states are the wrong size or the wrong meaning.
 *  - An operation added, removed, moved or edited invalidates from the
 *    earliest column it occupied *before or after* the edit. Dragging a gate
 *    from column 9 to column 3 changes the circuit from column 3 onwards.
 *  - A parameter whose value changed invalidates from the first column of any
 *    operation that reads it, in either version of the circuit. The operation
 *    itself is untouched — it still says `params: ['theta']` — so the
 *    operation walk alone would miss the entire slider drag, which is the most
 *    frequent edit there is.
 *
 * Everything here is conservative in one direction only: reporting a column
 * that is too early costs replayed work, and that is the acceptable failure.
 */

import { normalizeControl, type Circuit, type Operation } from '@qsim/schema'
import type { Control, ParamValue } from '@qsim/schema'

/**
 * The earliest column that changed between two versions of a circuit, or
 * `null` when nothing the simulator cares about did.
 *
 * `null` is not "column zero": it means the answer already on screen is still
 * the answer, so no simulation needs to run. Renaming a wire lands here.
 * A first circuit — `previous` absent — is a full run, column 0.
 */
export function earliestChangedColumn(
  previous: Circuit | undefined,
  next: Circuit
): number | null {
  if (previous === undefined) return 0
  if (previous === next) return null
  if (
    previous.qubits !== next.qubits ||
    previous.clbits !== next.clbits ||
    // Reference equality: the store rebuilds the circuit object on every edit
    // but carries this one through untouched, so a difference here is a real
    // redefinition — and a redefined block can change any column.
    previous.customGates !== next.customGates
  ) {
    return 0
  }

  let earliest = changedParameterColumn(previous, next)

  const before = new Map(previous.operations.map((op) => [op.id, op]))
  for (const operation of next.operations) {
    const old = before.get(operation.id)
    if (old === undefined) {
      earliest = lowest(earliest, operation.column)
      continue
    }
    before.delete(operation.id)
    if (!sameOperation(old, operation)) {
      earliest = lowest(earliest, Math.min(old.column, operation.column))
    }
  }
  // Whatever is left was deleted.
  for (const removed of before.values()) {
    earliest = lowest(earliest, removed.column)
  }

  return earliest
}

/**
 * The first column reading a parameter whose value moved, in either version.
 *
 * Both versions are scanned because an edit can change a value and remove its
 * last reader in the same step, and the columns that used to read it are
 * invalidated just as surely as the ones that do now.
 */
function changedParameterColumn(
  previous: Circuit,
  next: Circuit
): number | null {
  const before = valuesByName(previous)
  const after = valuesByName(next)

  const moved = new Set<string>()
  for (const [name, value] of after) {
    if (before.get(name) !== value) moved.add(name)
  }
  for (const name of before.keys()) {
    if (!after.has(name)) moved.add(name)
  }
  if (moved.size === 0) return null

  let earliest: number | null = null
  for (const circuit of [previous, next]) {
    for (const operation of circuit.operations) {
      for (const param of operation.params ?? []) {
        if (typeof param === 'string' && moved.has(param)) {
          earliest = lowest(earliest, operation.column)
        }
      }
    }
  }
  return earliest
}

function valuesByName(circuit: Circuit): Map<string, number> {
  return new Map(
    (circuit.parameters ?? []).map((parameter) => [
      parameter.name,
      parameter.value,
    ])
  )
}

/**
 * Whether two operations mean the same run. Compared field by field rather
 * than by serialising: key order is not part of the contract, and a
 * stringified comparison would call a re-ordered but identical operation an
 * edit — every time a circuit came back from JSON.
 */
function sameOperation(left: Operation, right: Operation): boolean {
  return (
    left.gate === right.gate &&
    left.column === right.column &&
    sameNumbers(left.targets, right.targets) &&
    sameControls(left.controls, right.controls) &&
    sameParams(left.params, right.params) &&
    sameNumbers(left.clbitTargets ?? [], right.clbitTargets ?? []) &&
    left.condition?.clbit === right.condition?.clbit &&
    left.condition?.equals === right.condition?.equals
  )
}

function sameNumbers(
  left: readonly number[],
  right: readonly number[]
): boolean {
  return (
    left.length === right.length &&
    left.every((value, index) => value === right[index])
  )
}

function sameParams(
  left: readonly ParamValue[] | undefined,
  right: readonly ParamValue[] | undefined
): boolean {
  const a = left ?? []
  const b = right ?? []
  return a.length === b.length && a.every((value, index) => value === b[index])
}

/**
 * Controls are normalised first, so the two spellings the contract allows for
 * a positive control — `0` and `{ qubit: 0, state: 1 }` — do not read as an
 * edit. Order is compared positionally: reordering controls cannot change the
 * physics, but calling that an edit only costs a replay.
 */
function sameControls(
  left: readonly Control[] | undefined,
  right: readonly Control[] | undefined
): boolean {
  const a = (left ?? []).map(normalizeControl)
  const b = (right ?? []).map(normalizeControl)
  return (
    a.length === b.length &&
    a.every((control, index) => {
      const other = b[index]
      return (
        other !== undefined &&
        control.qubit === other.qubit &&
        control.state === other.state
      )
    })
  )
}

function lowest(
  current: number | null,
  candidate: number | null
): number | null {
  if (candidate === null) return current
  if (current === null) return candidate
  return Math.min(current, candidate)
}
