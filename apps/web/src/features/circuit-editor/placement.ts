/**
 * How a gate gets from the palette onto the grid.
 *
 * This module is the whole placement model, and it is deliberately pure:
 * circuits and cells in, an intent out. Nothing here touches the store, so
 * a refused placement is refused *before* anything can be written, and the
 * rules can be tested without rendering an editor. `useKeyboardGrid` and
 * the dnd-kit handlers are both thin wrappers over these functions, which
 * is what keeps the keyboard path and the pointer path from drifting into
 * two different sets of rules.
 *
 * ## Multi-qubit gates are placed in two steps, not dragged across rows
 *
 * A CNOT needs two wires. The obvious gesture — drag from one wire to
 * another — is the wrong one, and not marginally:
 *
 *  - There is no pointer state that expresses "these two rows". A drag has
 *    one position, so a two-row drag has to be read as a start point plus an
 *    end point, and the start point is wherever the user happened to grab
 *    the palette chip.
 *  - On a touch screen the finger covers the very wires it is meant to
 *    distinguish, and the wires are 48px apart.
 *  - It has no keyboard equivalent at all, and §10 requires one.
 *
 * So: the drop (or the first Enter) fixes the gate's **first target** — the
 * ⊕, the box, the × — at the cell the user pointed at, and the editor then
 * asks for the remaining wires one at a time, in the same column. Escape
 * cancels. The decisive property is that **nothing is written to the store
 * until the shape is complete**: a cancelled or refused multi-qubit
 * placement costs no undo step, because there was never an edit to undo.
 *
 * That property is only worth anything if what is finally written is what
 * the user pointed at. `picks` are *physical wire indices*, and the register
 * is editable while a placement waits — a wire inserted above the anchor
 * renumbers it. So a pending placement has to move with its wires or end,
 * and `remapPending` and `pendingFits` are the two halves of that rule; the
 * commands that renumber the register are listed in `useKeyboardGrid`, which
 * owns the state and is therefore the only place that can apply them.
 *
 * The anchor is the first target rather than the first control on purpose.
 * The user drops a chip labelled `CNOT` and the glyph that appears under
 * the cursor is the CNOT's target; putting a bare control dot there instead
 * would be the editor claiming they did something they did not do.
 */

import {
  VARIABLE_ARITY,
  lookupGate,
  qubitsOf,
  type Circuit,
  type Control,
  type GateId,
  type Operation,
} from '@qsim/schema'

import { clbitWriters, freeClbits } from './classicalWrites'
import type { Cell } from './geometry'
import { operationAt, type RejectionReason } from './useCircuitStore'

/** What a picked wire becomes. */
export type SlotKind = 'target' | 'control'

/**
 * Refusals the store never sees, because they happen while the placement is
 * still being assembled. They are codes rather than sentences for the same
 * reason the store's are (see its header): the UI translates them.
 */
export const PLACEMENT_ISSUES = [
  'no-gate-armed',
  'other-column',
  'qubit-already-used',
  // The register is narrower than the gate's shape, so the placement could
  // never be completed. Refused before it starts; see `beginPlacement`.
  'not-enough-qubits',
  // The cursor is on the classical register row, which is readable and never
  // editable. Announced rather than ignored: the row is reachable with the
  // arrow keys, so a silent Enter there reads as a broken key.
  'classical-row',
  'nothing-here',
  'read-only',
  // Every classical bit of the register is already written in that column,
  // so a measurement placed there would have to share one — see
  // `classicalWrites.ts`. Refused before it starts, naming the two things
  // the user can do about it: add a bit, or use another column.
  'no-free-clbit',
  // The one refusal the user did not ask for: a register edit took the wire
  // a half-finished placement was standing on. Silence would be a lie here —
  // the prompt would simply stop, or worse, start pointing somewhere else.
  'cancelled-by-register-edit',
] as const

export type PlacementIssue = (typeof PLACEMENT_ISSUES)[number]

/** Everything the editor can have to say about a refused action. */
export type FeedbackCode = RejectionReason | PlacementIssue

const ISSUES = new Set<string>(PLACEMENT_ISSUES)

export function isPlacementIssue(code: FeedbackCode): code is PlacementIssue {
  return ISSUES.has(code)
}

/** The wires a gate needs, in the order the editor asks for them. */
export interface PlacementShape {
  readonly gate: GateId
  /** `slots[0]` is the anchor: the cell the user dropped on. */
  readonly slots: readonly SlotKind[]
  /**
   * `barrier` alone: one drop fences the whole moment, so there is nothing
   * to pick afterwards and the shape covers every wire in the circuit.
   */
  readonly spansEveryQubit: boolean
}

export function shapeOf(gate: GateId): PlacementShape {
  const meta = lookupGate(gate)
  if (meta === undefined) {
    // Unreachable for a catalog id; the contract refuses it downstream.
    return { gate, slots: ['target'], spansEveryQubit: false }
  }
  if (meta.arity === VARIABLE_ARITY) {
    return { gate, slots: ['target'], spansEveryQubit: true }
  }
  return {
    gate,
    slots: [
      ...Array.from({ length: meta.arity }, (): SlotKind => 'target'),
      ...Array.from({ length: meta.controlCount }, (): SlotKind => 'control'),
    ],
    spansEveryQubit: false,
  }
}

/** A multi-qubit placement the user has started but not finished. */
export interface PendingPlacement {
  readonly gate: GateId
  readonly column: number
  /** Wires chosen so far, in slot order. Never empty. */
  readonly picks: readonly number[]
  readonly slots: readonly SlotKind[]
}

/** What the next pick is for — the prompt the UI shows and announces. */
export function nextSlot(pending: PendingPlacement): SlotKind {
  return pending.slots[pending.picks.length] ?? 'target'
}

/** The arguments of a `placeGate` call, once the shape is complete. */
export interface GateDraft {
  readonly gate: GateId
  readonly targets: readonly number[]
  readonly column: number
  readonly controls?: readonly Control[]
  readonly clbitTargets?: readonly number[]
}

export type PlacementStep =
  | { readonly kind: 'pending'; readonly pending: PendingPlacement }
  | { readonly kind: 'ready'; readonly draft: GateDraft }
  | { readonly kind: 'refused'; readonly code: FeedbackCode }

/**
 * Assembles the draft from the wires the user picked.
 *
 * `measure` writes into the classical bit that carries its qubit's index,
 * which is what `QuantumCircuit(n, n)` means in Qiskit and what a new
 * document here is created with. When the register is too short the
 * contract refuses the placement with `clbit-out-of-range`, and that is the
 * right message: the fix is to add a classical bit, not to guess one — and
 * since the gutter carries add and remove controls for the classical
 * register, that refusal names something the user can actually do.
 *
 * That mapping is a *default chosen at placement*, not an invariant the
 * document carries afterwards, and this is where the difference bites. The
 * register commands renumber the wires and leave the classical register
 * alone — deliberately, see `classicalWrites.ts` — so the wire the user is
 * pointing at may carry an index whose bit some *other* measurement in this
 * column already writes. Then the diagonal is not available and the draft
 * takes the lowest bit that is, because two writers of one bit in one
 * instant is a shape the engine reads in no defined order. A column with no
 * free bit left at all is refused rather than guessed.
 *
 * Returning a `PlacementStep` rather than a bare draft is what makes that
 * refusal expressible: assembling the arguments is the last moment at which
 * the editor still knows *why* it cannot build the operation, and the
 * contract downstream would only be able to say the circuit is invalid.
 */
export function draftOf(
  circuit: Circuit,
  gate: GateId,
  picks: readonly number[],
  column: number
): PlacementStep {
  const shape = shapeOf(gate)
  if (shape.spansEveryQubit) {
    return {
      kind: 'ready',
      draft: {
        gate,
        targets: Array.from({ length: circuit.qubits }, (_, qubit) => qubit),
        column,
      },
    }
  }

  const targetCount = shape.slots.filter((slot) => slot === 'target').length
  const targets = picks.slice(0, targetCount)
  const controls = picks.slice(targetCount)
  const meta = lookupGate(gate)

  const writes =
    meta === undefined || meta.clbitCount === 0
      ? []
      : freeClbits(circuit, column, targets.slice(0, meta.clbitCount))
  if (writes === null) return { kind: 'refused', code: 'no-free-clbit' }

  return {
    kind: 'ready',
    draft: {
      gate,
      targets,
      column,
      ...(controls.length > 0 ? { controls } : {}),
      ...(writes.length > 0 ? { clbitTargets: writes } : {}),
    },
  }
}

/** The first pick: the cell a gate was dropped on, or Enter'd at. */
export function beginPlacement(
  circuit: Circuit,
  gate: GateId,
  cell: Cell
): PlacementStep {
  const shape = shapeOf(gate)
  if (shape.spansEveryQubit) {
    return draftOf(circuit, gate, [], cell.column)
  }
  /*
   * A gate needs one distinct wire per slot, and `shapeOf` knows how many
   * before anything starts. Without this test a CNOT on a one-wire circuit
   * was accepted, consumed the only wire, and then refused every further pick
   * as `qubit-already-used` — an unanswerable prompt that only Escape ended.
   * Refusing the *first* pick is what turns that dead end into a sentence
   * naming something the user can do, since the gutter's insert control is
   * right beside the canvas.
   */
  if (shape.slots.length > circuit.qubits) {
    return { kind: 'refused', code: 'not-enough-qubits' }
  }
  if (operationAt(circuit, cell.qubit, cell.column) !== undefined) {
    return { kind: 'refused', code: 'column-conflict' }
  }

  const picks = [cell.qubit]
  if (picks.length === shape.slots.length) {
    return draftOf(circuit, gate, picks, cell.column)
  }
  return {
    kind: 'pending',
    pending: {
      gate,
      column: cell.column,
      picks,
      slots: shape.slots,
    },
  }
}

/**
 * Every pick after the first. The partner must be in the anchor's column
 * because a gate occupies one moment by definition — accepting a cell in
 * another column would mean silently moving the anchor, and the user would
 * watch the gate they placed jump.
 */
export function continuePlacement(
  circuit: Circuit,
  pending: PendingPlacement,
  cell: Cell
): PlacementStep {
  if (cell.column !== pending.column) {
    return { kind: 'refused', code: 'other-column' }
  }
  if (pending.picks.includes(cell.qubit)) {
    return { kind: 'refused', code: 'qubit-already-used' }
  }
  if (operationAt(circuit, cell.qubit, cell.column) !== undefined) {
    return { kind: 'refused', code: 'column-conflict' }
  }

  const picks = [...pending.picks, cell.qubit]
  if (picks.length === pending.slots.length) {
    return draftOf(circuit, pending.gate, picks, pending.column)
  }
  return { kind: 'pending', pending: { ...pending, picks } }
}

/** Wires a pending placement has already claimed, for the canvas to mark. */
export function pendingQubits(
  pending: PendingPlacement | null
): readonly number[] {
  return pending?.picks ?? []
}

/**
 * Moves a pending placement's picks along with the wires they name.
 *
 * `moveQubit` is the very map the store applied to the operations it already
 * holds — `qubit >= at ? qubit + 1 : qubit` for an insertion, and so on. The
 * two must agree, or the half-placed gate and the placed ones end up on
 * different wires after the same edit, which is the whole defect.
 *
 * `column` is deliberately untouched: columns are orthogonal to the
 * register, and no register command moves a gate through time.
 */
export function remapPending(
  pending: PendingPlacement,
  moveQubit: (qubit: number) => number
): PendingPlacement {
  return { ...pending, picks: pending.picks.map(moveQubit) }
}

/**
 * Whether every wire a pending placement holds still exists.
 *
 * Read on every render, the way the cursor is clamped on read: a placement
 * whose claimed wires cannot be drawn must not be reachable either, or the
 * user is left with a prompt they can never answer and a highlight pointing
 * at nothing. It is the net under the per-command rules, not a substitute
 * for them — a placement that merely *slid* is still on its own wire, and
 * fits.
 */
export function pendingFits(
  pending: PendingPlacement,
  circuit: Circuit
): boolean {
  return pending.picks.every((qubit) => qubit >= 0 && qubit < circuit.qubits)
}

/* ------------------------------------------------------------------ *
 * Dragging
 * ------------------------------------------------------------------ */

/** What is being dragged. Carried in dnd-kit's `active.data`. */
export type DragPayload =
  | { readonly kind: 'palette'; readonly gate: GateId }
  | {
      readonly kind: 'operation'
      readonly id: string
      /**
       * The wire the user grabbed the operation by. A CNOT picked up by its
       * control and dropped two rows down should move by two rows, not
       * teleport its control to the drop row — so the shift is measured
       * from here, not from the operation's first target.
       */
      readonly grabbedQubit: number
    }

/** The arguments of a `moveOperation` call. */
export interface MoveDraft {
  readonly id: string
  readonly targets: readonly number[]
  readonly column: number
  readonly controls?: readonly Control[]
  /**
   * Present only for an operation that writes classically, and only then
   * shifted with the wires; see `moveTo`.
   */
  readonly clbitTargets?: readonly number[]
}

export type MoveStep =
  | { readonly kind: 'move'; readonly draft: MoveDraft }
  | { readonly kind: 'refused'; readonly code: FeedbackCode }

/**
 * Slides a whole operation to a new cell, keeping its shape.
 *
 * Occupancy is left to the contract: the destination cells of a multi-qubit
 * gate are not all visible to a single `operationAt` call, and duplicating
 * the conflict rule here is exactly the drift the store's header warns
 * about. Range is checked here only because a qubit index below zero is not
 * a conflict, it is a nonsense the caller should never have built.
 *
 * A measurement's classical write travels with the wire it reads, by the
 * same shift: `draftOf` gives a measurement the bit carrying its qubit's
 * index, and a drag that left the bit behind would break that rule the
 * moment after the editor established it — and, worse, could put two
 * measurements of one column on the same bit, a shape the engine reads in
 * no defined order. A shifted bit that leaves the register is refused by the
 * contract, so there is no range check for it here.
 *
 * The bit it lands *on* is checked here, though, and the contract cannot do
 * it: a write is refused when the destination column already has a writer of
 * that bit (`classicalWrites.ts`). This is the one occupancy rule the
 * contract does not know, and it applies to a purely horizontal drag too —
 * the wires do not move, but the instant does.
 *
 * `condition.clbit` is left alone. That asymmetry with `paste` is deliberate
 * and is argued in `moveOperation`.
 */
export function moveTo(
  circuit: Circuit,
  operation: Operation,
  grabbedQubit: number,
  cell: Cell
): MoveStep {
  const shift = cell.qubit - grabbedQubit
  const inRange = qubitsOf(operation).every((qubit) => {
    const moved = qubit + shift
    return moved >= 0 && moved < circuit.qubits
  })
  if (!inRange) return { kind: 'refused', code: 'qubit-out-of-range' }

  const controls = operation.controls?.map((control) =>
    typeof control === 'number'
      ? control + shift
      : { ...control, qubit: control.qubit + shift }
  )
  const clbitTargets = operation.clbitTargets?.map((clbit) => clbit + shift)
  if (clbitTargets !== undefined) {
    const writers = clbitWriters(circuit.operations, cell.column, operation.id)
    if (clbitTargets.some((clbit) => writers.has(clbit))) {
      return { kind: 'refused', code: 'clbit-in-use' }
    }
  }

  return {
    kind: 'move',
    draft: {
      id: operation.id,
      targets: operation.targets.map((qubit) => qubit + shift),
      column: cell.column,
      ...(controls !== undefined ? { controls } : {}),
      ...(clbitTargets !== undefined ? { clbitTargets } : {}),
    },
  }
}
