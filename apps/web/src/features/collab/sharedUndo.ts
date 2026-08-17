/**
 * Per-user undo, over `Y.UndoManager` (M5.1).
 *
 * ── The trap this file exists to avoid ────────────────────────────────────
 *
 * Undo in a shared document is not "put the document back". Ana pressing undo
 * must take back Ana's last change and leave Beto's alone, and a history of
 * whole-document snapshots — which is what the editor has had since M0.5, and
 * which is the right answer for one person — cannot express that: a snapshot
 * does not record who wrote what, so restoring one restores Beto's typing away
 * too.
 *
 * `Y.UndoManager` is built for exactly this. It records the *items* a
 * transaction created and deleted, and `trackedOrigins` decides which
 * transactions it records at all — so scoping it to this client's origin makes
 * its stack a list of this client's changes and nothing else.
 *
 * ── Three of its settings are decisions rather than defaults ───────────────
 *
 * `trackedOrigins: new Set([origin])`. The origin the bridge writes with, and
 * only that. Remote updates arrive under the provider's origin and the undo
 * manager never sees them, which is the whole point. (Yjs also tracks the
 * manager itself, so that undoing produces a redo entry.)
 *
 * `captureTimeout: 0`. Yjs merges changes made within 500 ms into one stack
 * item by default, which for a text editor is right — nobody wants to undo
 * letter by letter — and for this editor is wrong: two gates dropped quickly
 * are two edits, and the store's existing behaviour, which a large suite pins
 * down, is one step per action. Zero means one stack item per transaction, and
 * `writeCircuit` makes one transaction per commit. Gestures are grouped
 * explicitly instead, below.
 *
 * `ignoreRemoteMapChanges` left at its default, false. That is the setting
 * that decides what happens when Ana changes an angle, Beto changes the same
 * angle afterwards, and Ana presses undo: with the default, Yjs refuses to
 * revert a key somebody else has written since, so Ana's undo does nothing to
 * that field rather than silently reverting Beto's newer value. "Undo mine"
 * has to mean "and only mine", including in the case where mine has already
 * been overwritten.
 *
 * ── What it does not carry, and why it is carried here ────────────────────
 *
 * A stack item knows about document items, not about the editor's selection —
 * and the store's undo has always restored the selection that was in place
 * before an edit, because undo restores the editing context and not just the
 * geometry. `stackItem.meta` is the documented place for that, so the
 * selection rides along in it: recorded when an item is added, applied when one
 * is popped.
 */

import type { Circuit } from '@qsim/schema'
import {
  circuitRoots,
  restampOperations,
  slotKeys,
  widenRegister,
} from '@qsim/collab'
import * as Y from 'yjs'

import {
  sameCircuit,
  type SharedHistory,
} from '../circuit-editor/useCircuitStore'

/** Key under which a stack item carries the selection to come back to. */
const SELECTION = 'qsim:selection'

/**
 * Yjs exports `UndoManager` but not the two types its events are made of.
 *
 * The item is recovered from the manager's own signature rather than restated,
 * so it cannot drift; the event is written out because only the two fields
 * below are used, and a handler is assignable to Yjs's as long as it asks for
 * no more than Yjs passes.
 */
type StackItem = NonNullable<ReturnType<Y.UndoManager['undo']>>

interface StackItemEvent {
  readonly stackItem: StackItem
  readonly type: 'undo' | 'redo'
}

export interface SharedUndoOptions {
  readonly doc: Y.Doc
  /** The origin this client's own writes carry. Nothing else is tracked. */
  readonly origin: unknown
  /** The circuit the store currently holds. */
  readonly circuit: () => Circuit
  /** The selection the store currently holds. */
  readonly selection: () => readonly string[]
  readonly restoreSelection: (ids: readonly string[]) => void
}

export interface SharedUndo extends SharedHistory {
  readonly manager: Y.UndoManager
  /**
   * The selection in place *before* the change about to be written.
   *
   * The bridge knows it and the undo manager cannot: `stack-item-added` fires
   * after the transaction, when the selection has already moved to whatever the
   * edit selected. Undo that restored the post-edit selection would leave the
   * user looking at a gate that is no longer there.
   */
  note: (selection: readonly string[]) => void
  destroy: () => void
}

export function createSharedUndo(options: SharedUndoOptions): SharedUndo {
  const roots = circuitRoots(options.doc)
  /**
   * The origin the repairs in `settleStep` write under.
   *
   * Deliberately *not* in `trackedOrigins`, and deliberately not the bridge's
   * `origin` either: the first would make a repair an undoable step of its own
   * and clear the redo stack it had just created, and the second would make the
   * bridge ignore the update and hold a projection that no longer matches the
   * document. A third object is the only value that is both untracked by the
   * manager and foreign to the bridge.
   */
  const repair = { qsim: 'undo-repair' }
  const manager = new Y.UndoManager(
    // The five roots rather than the document, so that anything a later
    // milestone hangs off this doc — presence, comments, a chat — is outside
    // the scope of the circuit's undo by construction.
    [roots.meta, roots.operations, roots.labels, roots.parameters, roots.gates],
    {
      trackedOrigins: new Set([options.origin]),
      captureTimeout: 0,
    }
  )

  let noted: readonly string[] | null = null
  /** The document as the open gesture found it, when one is open. */
  let gesture: {
    readonly circuit: Circuit
    readonly depth: number
    readonly redoStack: readonly StackItem[]
  } | null = null

  const onAdded = (event: StackItemEvent): void => {
    event.stackItem.meta.set(SELECTION, noted ?? options.selection())
    noted = null
  }

  const onPopped = (event: StackItemEvent): void => {
    const selection: unknown = event.stackItem.meta.get(SELECTION)
    if (Array.isArray(selection)) {
      options.restoreSelection(selection as readonly string[])
    }
  }

  manager.on('stack-item-added', onAdded)
  manager.on('stack-item-popped', onPopped)

  /**
   * One step, and *only* one.
   *
   * `Y.UndoManager.popStackItem` loops `while (stack.length > 0 && nothing has
   * been performed)`, so a step it cannot apply is popped, discarded without a
   * trace, and the step underneath runs in its place. That turns the one
   * behaviour this file promises -- "Ana's undo does nothing to that field
   * rather than silently reverting Beto's newer value" -- into its opposite:
   * Ana presses undo once, her angle step is thrown away because Beto has
   * written that key since, and her *placement* is reverted instead. The gate
   * goes, Beto's value goes with it, and the store reports success.
   *
   * The manager is therefore handed a stack holding exactly the item being asked
   * for, so its own fall-through cannot reach past it. An item that cannot be
   * applied is spent -- which is honest, and is what a snapshot history does too
   * -- and the press reports that nothing moved.
   */
  const one = (
    stack: StackItem[],
    move: () => StackItem | null
  ): StackItem | null => {
    const top = stack.pop()
    if (top === undefined) return null
    const rest = stack.splice(0, stack.length)
    stack.push(top)
    const performed = move()
    stack.unshift(...rest)
    return performed
  }

  /**
   * The two things a step can leave behind, repaired by the peer that pressed it.
   *
   * Both are written under an origin the manager does *not* track, which is the
   * whole reason they are safe: a tracked write would push a stack item of its
   * own and clear the opposite stack, so an undo would destroy the redo it had
   * just created. Untracked, they are ordinary edits that travel to the other
   * peers and are simply not undoable -- which is right, because neither of them
   * is something a person did.
   *
   * The arguments for each are on `widenRegister` and `restampOperations`.
   */
  const settleStep = (before: readonly string[]): void => {
    const known = new Set(before)
    const revived = slotKeys(roots).filter((slot) => !known.has(slot))
    if (revived.length > 0) restampOperations(options.doc, revived, repair)
    widenRegister(options.doc, repair)
  }

  /** Runs one kind of step up to `steps` times, reporting whether any moved. */
  const travel = (steps: number, kind: 'undo' | 'redo'): boolean => {
    noted = options.selection()
    let moved = false
    for (let step = 0; step < steps; step += 1) {
      const stack = kind === 'undo' ? manager.undoStack : manager.redoStack
      const before = slotKeys(roots)
      const performed = one(stack, () =>
        kind === 'undo' ? manager.undo() : manager.redo()
      )
      if (performed === null) break
      moved = true
      settleStep(before)
    }
    noted = null
    return moved
  }

  return {
    manager,

    note(selection) {
      noted = selection
    },

    undo(steps) {
      return travel(steps, 'undo')
    },

    redo(steps) {
      return travel(steps, 'redo')
    },

    clear() {
      gesture = null
      manager.clear()
    },

    /**
     * A continuous gesture — a slider drag, a typing session — is one step.
     *
     * Two calls, and the order of them is the whole trick. `stopCapturing`
     * closes whatever item the *previous* edit left open, so the gesture starts
     * one of its own rather than swallowing the placement that came before it;
     * raising `captureTimeout` then makes every transaction of the gesture land
     * in that one item. Without the first call a drag would undo the edit that
     * preceded it, which is the bug this pair of lines is here to prevent.
     */
    beginGesture() {
      if (gesture !== null) return
      manager.stopCapturing()
      gesture = {
        circuit: options.circuit(),
        depth: manager.undoStack.length,
        redoStack: [...manager.redoStack],
      }
      manager.captureTimeout = Number.MAX_SAFE_INTEGER
    },

    endGesture() {
      const open = gesture
      gesture = null
      manager.captureTimeout = 0
      manager.stopCapturing()
      if (open === null) return
      /*
       * A gesture that ended where it began costs nothing — the same rule the
       * store's own `endTransaction` follows, kept identical here so that
       * dragging a slider out and back does not consume the undo press that
       * was meant for the edit before it. The document keeps the intermediate
       * writes, as a CRDT must; only the *step* is dropped, along with the redo
       * branch the first write cleared.
       *
       * ── Why the item is fused into the one below and not popped ─────────────
       *
       * Popping it was the first version, and it broke the step underneath. Yjs
       * decides whether a deleted map item may be restored by walking the items
       * in the way and asking whether each is explained by this manager's undo or
       * redo stack (`isDeletedByUndoStack`, inside `redoItem`). The popped item
       * was the only thing explaining the gesture's writes, so the *previous*
       * step became unrevertable — and `popStackItem` then performed the one
       * under that instead. A drag out and back followed by one undo press
       * deleted the gate, solo, with no peer and no merge in sight: the common
       * case, since §3.4 says a circuit has exactly one writer today.
       *
       * Fusing says the true thing instead: writes that changed nothing belong to
       * the step before them. One press reverts that step and them together,
       * which is exactly what the snapshot history does.
       */
      if (
        manager.undoStack.length === open.depth + 1 &&
        sameCircuit(open.circuit, options.circuit())
      ) {
        const collapsed = manager.undoStack.pop()
        const beneath = manager.undoStack[manager.undoStack.length - 1]
        if (collapsed !== undefined && beneath !== undefined) {
          beneath.deletions = Y.mergeDeleteSets([
            beneath.deletions,
            collapsed.deletions,
          ])
          beneath.insertions = Y.mergeDeleteSets([
            beneath.insertions,
            collapsed.insertions,
          ])
        }
        manager.redoStack.splice(0, manager.redoStack.length, ...open.redoStack)
      }
    },

    destroy() {
      manager.off('stack-item-added', onAdded)
      manager.off('stack-item-popped', onPopped)
      manager.destroy()
    },
  }
}
