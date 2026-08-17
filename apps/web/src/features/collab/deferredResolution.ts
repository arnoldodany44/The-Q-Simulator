/**
 * Turning a deferral back into an ordinary edit (M5.6).
 *
 * ═══════════════════════════════════════════════════════════════════════
 * WHY THIS IS AN EDIT AND NOT A REPAIR
 *
 * `project.ts` refuses to repair a merged document, and the argument is the
 * sharpest one in the whole phase: a repair is a *write*, every peer would
 * perform it, and two peers each writing "I moved the loser to column 4" produce
 * two moves — a second conflict invented by the fix, with a settling loop that
 * may never settle. So the projection defers, nobody repairs, and the deferred
 * operation stays in the document with `blockedBy` naming what is in its way.
 *
 * That leaves one thing owed to the person looking at the screen, and it is the
 * sentence `project.ts` ends on: **a gate you placed can arrive on the other
 * peer's screen as a deferred gate rather than as a gate**, and "resolving it is
 * an ordinary edit (move the blocker, or move it) and not a recovery".
 *
 * This file is that ordinary edit. Every path below goes through the *store* —
 * `moveOperation`, `addQubit`, `addClbit` — which means it is validated by the
 * contract, refusable, undoable, and broadcast exactly like a drag. Nothing here
 * touches the Y.Doc, nothing here writes a slot, and nothing here runs unless a
 * person pressed a button: one peer performs it, deliberately, and the other
 * peers receive it as the edit it is. That is the difference between a fix and a
 * loop.
 *
 * ═══════════════════════════════════════════════════════════════════════
 * ONE REPAIR PER REASON, AND TWO REASONS HAVE NONE
 *
 * `column-conflict` and `clbit-in-use` are both "the cell (or the classical bit)
 * this wanted is taken in that column". The repair is to make the column free:
 * everything at that column or after it moves one column right. Not "move the
 * blocker somewhere" — that would need a policy for where, and the free column
 * to the right is precisely what an editor's `compactColumns` already treats as
 * the document's slack. Rightmost first, so no intermediate move lands on top of
 * an operation that has not moved yet.
 *
 * `out-of-register` is the opposite shape: nothing is in the way, the register
 * simply is not wide enough — one peer narrowed it while another used the wide
 * part. The repair is to widen it back, which is the same sentence
 * `widenRegister` enforces after an undo: **a wire cannot be withdrawn from
 * under somebody else's gate.** It is offered as a button rather than performed
 * automatically because here nobody's undo caused it; somebody chose to narrow
 * the register, and overruling that choice is a decision for a person.
 *
 * `malformed` and `invalid` have no repair and must not pretend to. The slot
 * holds something this build cannot read — an unknown gate from a newer
 * deployment, an arity that does not match, a shape nobody honest produced — and
 * every edit that could "fix" it would be a guess about what somebody meant. The
 * surface says so instead.
 */

import type { DeferredOperation } from '@qsim/collab'
import {
  MAX_CLBITS,
  MAX_COLUMNS,
  MAX_QUBITS,
  qubitsOf,
  type Circuit,
  type Operation,
} from '@qsim/schema'

import type { CircuitStore } from '../circuit-editor/useCircuitStore'

/** What, if anything, a person can press to un-defer an operation. */
export type DeferralRepair =
  /**
   * Free the column the operation wants, by moving everything from there on one
   * column to the right.
   */
  | { readonly kind: 'room'; readonly column: number }
  /** Widen the register until the wires and bits it names exist. */
  | {
      readonly kind: 'register'
      readonly qubits: number
      readonly clbits: number
    }
  /**
   * Nothing an edit can do. Either the slot is unreadable, or the repair would
   * cross a contract ceiling — a column past `MAX_COLUMNS`, a wire past
   * `MAX_QUBITS` — and a button that can only be refused is worse than none.
   */
  | { readonly kind: 'none' }

const NONE: DeferralRepair = { kind: 'none' }

/**
 * The repair for one deferred operation, against the circuit now on screen.
 *
 * Pure, and separate from performing it, because this is also what decides
 * whether a button is drawn at all.
 */
export function repairFor(
  entry: DeferredOperation,
  circuit: Circuit
): DeferralRepair {
  const operation = entry.operation
  if (operation === undefined) return NONE

  switch (entry.reason) {
    case 'column-conflict':
    case 'clbit-in-use': {
      // Everything from here on moves right by one, so the *last* column of the
      // circuit is what has to fit. A circuit already at the ceiling has no
      // slack, and `compactColumns` is the remedy on that path.
      const last = lastColumn(circuit)
      if (last + 1 >= MAX_COLUMNS) return NONE
      return { kind: 'room', column: operation.column }
    }

    case 'out-of-register': {
      const needed = registerFor(operation)
      if (needed.qubits > MAX_QUBITS || needed.clbits > MAX_CLBITS) return NONE
      const qubits = Math.max(circuit.qubits, needed.qubits)
      const clbits = Math.max(circuit.clbits, needed.clbits)
      if (qubits === circuit.qubits && clbits === circuit.clbits) return NONE
      return { kind: 'register', qubits, clbits }
    }

    default:
      // `malformed` and `invalid`. See the header.
      return NONE
  }
}

/**
 * Performs a repair, as one undoable step, and reports whether anything moved.
 *
 * The transaction is not cosmetic. A column shift is one `moveOperation` per
 * operation to the right of the conflict, and without the grouping a reader who
 * pressed one button would need nine presses of undo to take it back — and the
 * shared undo would broadcast nine steps where there was one decision. The store
 * routes the grouping to whichever history is attached, so this reads the same
 * solo and in a session.
 *
 * A refusal part-way through is left where it is rather than rolled back: the
 * store has no rollback, the transaction makes the whole shift one undo, and the
 * honest thing for a caller to do with `false` is to say that the repair did not
 * finish. Every refusal it can hit is a contract ceiling that `repairFor` has
 * already checked, so this is the "the document changed under us" path.
 */
export function applyRepair(
  store: CircuitStore,
  repair: DeferralRepair
): boolean {
  if (repair.kind === 'none') return false

  store.getState().beginTransaction()
  try {
    return repair.kind === 'room'
      ? makeRoom(store, repair.column)
      : widen(store, repair.qubits, repair.clbits)
  } finally {
    store.getState().endTransaction()
  }
}

/**
 * Selects what is holding an operation back, so a reader can act on it.
 *
 * The other half of the surface, and the one that always works: the blockers are
 * *placed* operations, so they are on the canvas, and selecting them is what
 * `comments`' "Show this gate on the canvas" already does for an anchor. Ids the
 * circuit no longer holds are dropped rather than selected — the document moves
 * while a panel is on screen — and an empty result reports false so the caller
 * can say that what was in the way has already gone.
 */
export function revealBlockers(
  store: CircuitStore,
  entry: DeferredOperation
): boolean {
  const present = new Set(
    store.getState().circuit.operations.map((operation) => operation.id)
  )
  const found = entry.blockedBy.filter((id) => present.has(id))
  if (found.length === 0) return false
  store.getState().setSelection(found)
  return true
}

function makeRoom(store: CircuitStore, column: number): boolean {
  const moving = [
    ...store
      .getState()
      .circuit.operations.filter((operation) => operation.column >= column),
    // Rightmost first: moving the left edge into an occupied column would be
    // refused by the very rule this is trying to make room for. A copy, because
    // `circuit.operations` is the store's own array and `sort` is in place.
  ].sort((left, right) => right.column - left.column)

  let moved = false
  for (const operation of moving) {
    const result = store
      .getState()
      .moveOperation(operation.id, operation.targets, operation.column + 1)
    if (!result.ok) return false
    moved = true
  }
  return moved
}

function widen(store: CircuitStore, qubits: number, clbits: number): boolean {
  let moved = false
  while (store.getState().circuit.qubits < qubits) {
    // No index, so the wire is appended: inserting one in the middle would
    // renumber every operation above it, which is a different edit entirely and
    // not the one a deferred gate is asking for.
    if (!store.getState().addQubit().ok) return moved
    moved = true
  }
  while (store.getState().circuit.clbits < clbits) {
    if (!store.getState().addClbit().ok) return moved
    moved = true
  }
  return moved
}

function lastColumn(circuit: Circuit): number {
  let last = -1
  for (const operation of circuit.operations) {
    if (operation.column > last) last = operation.column
  }
  return last
}

/** The narrowest register that would hold one operation. */
function registerFor(operation: Operation): {
  readonly qubits: number
  readonly clbits: number
} {
  let qubits = 0
  let clbits = 0
  for (const qubit of qubitsOf(operation)) {
    qubits = Math.max(qubits, qubit + 1)
  }
  for (const clbit of operation.clbitTargets ?? []) {
    clbits = Math.max(clbits, clbit + 1)
  }
  const condition = operation.condition
  if (condition !== undefined) clbits = Math.max(clbits, condition.clbit + 1)
  return { qubits, clbits }
}
