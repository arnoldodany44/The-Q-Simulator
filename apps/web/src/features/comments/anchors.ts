/**
 * Where a comment's anchor points, resolved against the document on screen —
 * §3.4, §14 (Fase 5, M5.4).
 *
 * ══════════════════════════════════════════════════════════════════════════
 * THIS FILE IS THE ONE PLACE THAT ANSWERS "IS THE GATE STILL THERE?"
 *
 * A comment carries `anchorOpId`, an `operations[].id` from §6. Nothing in the
 * API, the database or the contract records whether that id still names an
 * operation, and that is deliberate — orphanhood is a property of the *pair*
 * (comment, document being displayed), and this tab may be displaying the head
 * version, an older version, a live collaborative session, or an unsaved buffer
 * nobody else has ever seen. The argument is written out in `@qsim/contract`'s
 * `comments.ts`; this is the consequence: the question is asked here, on every
 * render, against `circuit`.
 *
 * ══════════════════════════════════════════════════════════════════════════
 * WHY AN ID CANNOT LIE AND A COORDINATE CAN
 *
 * The editor's store never rewrites an operation's `id`:
 *
 *   - `moveOperation` replaces `targets` and `column` and keeps it;
 *   - `addQubit`, `removeQubit` and `reorderQubits` remap every coordinate an
 *     operation touches and keep it;
 *   - inserting a column is a translation of `column` values, which is the same
 *     shape of edit;
 *   - `removeOperations` filters the array, so undo restores the operation *with
 *     its id* — no write to any comment is involved, and the anchor re-attaches
 *     by itself;
 *   - a *new* operation never receives an id that is in use, because
 *     `idAllocator` skips taken ids and `paste` always mints fresh ones.
 *
 * The last of those is what makes an anchor safe rather than merely convenient.
 * An anchor may fail to resolve. It can never resolve to a different gate — and
 * "silently points at the gate that moved into cell (q0, c3)" is the failure a
 * coordinate anchor has and the reason this project does not have one: a reader
 * would be shown a stranger's sentence about the gate in front of them,
 * attributed to somebody who never said it.
 *
 * ══════════════════════════════════════════════════════════════════════════
 * WHAT AN ORPHAN GETS: KEPT, SHOWN, AND LABELLED
 *
 * `orphaned` is returned rather than dropped. The panel lists an orphaned thread
 * under the circuit with a note saying the operation it was about is no longer
 * in this document, and no marker is drawn for it — because there is no cell to
 * draw it on, and drawing it on a nearby one is the coordinate mistake again.
 *
 * Hiding it would destroy the value of the feature ("we discussed this and
 * decided") invisibly, and deleting it would be a destructive answer to an
 * undoable edit. Both were considered; see the contract.
 *
 * Custom gates are the one subtlety. An operation *inside* a `customGates`
 * definition has an id of its own, and this function does not look there: a
 * comment is anchored to a gate on the canvas, a definition's body is a
 * different document that the definition editor opens separately, and an id is
 * only unique within its own operation list. So a thread on a block's call site
 * stays a thread on the call, and inlining the call orphans it — correctly, since
 * the call it was about no longer exists.
 */

import { qubitsOf, type Circuit, type Operation } from '@qsim/schema'

/** The cell a marker is drawn on: an operation's topmost wire and its column. */
export interface AnchorCell {
  readonly qubit: number
  readonly column: number
}

/** Which of a set of anchors this document can account for. */
export interface AnchorResolution {
  /** Anchors naming an operation present here, with the cell to mark. */
  readonly present: ReadonlyMap<string, AnchorCell>
  /**
   * Anchors naming nothing here. Kept, not discarded — the caller renders them
   * against the circuit with a note. Sorted, so a list of orphans does not
   * reorder itself between renders.
   */
  readonly orphaned: readonly string[]
}

/** The operation an anchor names, or `undefined`. */
export function operationForAnchor(
  circuit: Circuit,
  anchorOpId: string
): Operation | undefined {
  return circuit.operations.find((operation) => operation.id === anchorOpId)
}

/**
 * The cell a marker for this anchor belongs on, or `null` when the anchor
 * resolves to nothing.
 *
 * The *topmost* wire the operation touches, controls included, because that is
 * where the operation's box is drawn highest and a badge on a lower wire of a
 * `cx` would look like a comment about the control alone. `qubitsOf` covers
 * targets and controls together, which is the same set `operationAt` hit-tests.
 */
export function anchorCellOf(
  circuit: Circuit,
  anchorOpId: string
): AnchorCell | null {
  const operation = operationForAnchor(circuit, anchorOpId)
  if (operation === undefined) return null
  const qubits = qubitsOf(operation)
  if (qubits.length === 0) return null
  return { qubit: Math.min(...qubits), column: operation.column }
}

/**
 * Splits a set of anchors into the ones this document holds and the ones it
 * does not.
 *
 * One pass over the operations rather than one `find` per anchor: the canvas
 * calls this on every document change, and a circuit with two hundred gates and
 * a dozen threads would otherwise be a nested loop on the render path.
 *
 * `null` anchors — comments about the circuit rather than about a gate — are not
 * this function's business and are filtered out by the caller; passing one in
 * would make it an orphan, which is a different and wrong statement.
 */
export function resolveAnchors(
  circuit: Circuit,
  anchorIds: Iterable<string>
): AnchorResolution {
  const wanted = new Set(anchorIds)
  const present = new Map<string, AnchorCell>()

  for (const operation of circuit.operations) {
    if (!wanted.has(operation.id)) continue
    const qubits = qubitsOf(operation)
    if (qubits.length === 0) continue
    present.set(operation.id, {
      qubit: Math.min(...qubits),
      column: operation.column,
    })
  }

  const orphaned = [...wanted]
    .filter((id) => !present.has(id))
    .sort((left, right) => left.localeCompare(right))

  return { present, orphaned }
}
