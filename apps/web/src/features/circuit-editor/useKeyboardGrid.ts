/**
 * The editor's interaction model, keyboard first.
 *
 * Everything the user can do to a circuit passes through this hook: the
 * cursor, the armed gate, the half-finished multi-qubit placement, the
 * shortcut map, and the single sentence that comes back saying what
 * happened. The pointer path (dnd-kit) calls the same functions with the
 * same arguments — `applyDrop` is a thin front for `beginPlacement` and
 * `moveTo` — so there is exactly one set of rules, and a gesture cannot do
 * something the keyboard cannot.
 *
 * ## What the live region says, and what it stays quiet about
 *
 * Every command that changes the document reports its outcome, not only its
 * refusals: a user who cannot see the canvas otherwise has no way to tell a
 * placement that landed from one that was silently dropped, and no way at
 * all to tell an undo that consumed a step from one that found an empty
 * stack — both leave a canvas that simply is what it is.
 *
 * The line runs the other way too. Moving the cursor changes nothing and
 * says nothing: announcing every arrow key would bury the reports that
 * matter under a stream of coordinates the grid already speaks through the
 * focused cell. So the rule is *state changes are announced, navigation is
 * not*, and the region stays `polite` — a success is never worth
 * interrupting whatever a reader is in the middle of.
 *
 * A report is a catalog key plus its values (`EditReport`), never a
 * sentence: gate symbols are notation and reach the screen through
 * `Notation`, which is D2's rule and `operationRoles.ts`'s convention.
 *
 * Nothing here is transient state pretending to be document state. The
 * cursor, the armed gate and the pending placement live in React, never in
 * the store, which is what makes a cancelled placement free: undo has never
 * heard of it.
 *
 * ## Why the register commands come through here
 *
 * A pending placement holds *wire indices*, and a wire inserted or removed
 * while it waits renumbers them — so a CNOT anchored on q1 would silently
 * land on q2, and the "claimed wire" highlight would point at the wrong wire
 * the whole time it waited. `addQubit`, `removeQubit`, `reorderQubits`,
 * `undo` and `redo` are therefore hook-owned callbacks rather than direct
 * store calls, and each one either moves the picks with their wires or ends
 * the placement and says so:
 *
 *  - **insert** — every pick at or below the new wire shifts down by one;
 *    the placement continues and nothing is announced, because from the
 *    user's side the gate is still on the wire they pointed at.
 *  - **remove** — a placement standing on the deleted wire is cancelled.
 *    That is the store's own cascade rule ("deleting a wire deletes what
 *    stood on it") applied to a half-built operation. Any other pick simply
 *    shifts up.
 *  - **reorder** — picks follow their wires to their new positions.
 *  - **undo / redo** — cancelled. Undo restores an arbitrary earlier
 *    circuit, and there is no wire transform that can be applied to that, so
 *    the only honest answer is to end the placement.
 *
 * `armed` survives a cancellation, so the user can re-anchor with one Enter
 * instead of picking the gate out of the palette again.
 *
 * ## The full keyboard map
 *
 * Surfaced to the user in `ShortcutsPanel.tsx`; if you change one, change
 * both. Shortcuts are ignored while focus is inside a text field, so typing
 * `4` into the angle box does not arm √X.
 *
 * ### Where each key is live
 *
 * This handler is bound to the whole editor, so every keystroke in the
 * subtree reaches it — including the ones aimed at a toolbar button, a wire
 * control or the shortcuts disclosure. Which half of the map may claim a
 * keystroke therefore depends on where it came from, and `handleKeyDown`
 * splits it three ways:
 *
 *  - **Grid keys** — the arrows, Home/End, Enter and Delete/Backspace — act
 *    only when the event originated inside `[role="grid"]`. They all call
 *    `preventDefault`, and a key that both suppresses a button's native
 *    activation and answers somewhere else is how an editor ends up with no
 *    working buttons at all.
 *  - **Space is not one of them.** It belongs to dnd-kit's keyboard sensor
 *    and to nothing else: it picks a gate up. Binding it here as well —
 *    which it was — made a single press do both, so picking up an armed gate
 *    also attempted a placement on the cell it was standing on and pushed a
 *    refusal the user never caused into the live region, while on an empty
 *    cell it silently placed the gate. Both contradict the shortcuts panel,
 *    which tells the user in all three languages that Enter places and Space
 *    only picks up. The editor's handler cannot tell the two apart by state
 *    either: dnd-kit reports the drag through React state, which lands well
 *    after the keydown that started it.
 *  - **Gate keys** act inside the grid and inside the palette, the two
 *    components they belong to (WCAG 2.1.4; see the arming branch below).
 *  - **Escape and the Ctrl/Cmd chords** are live anywhere in the editor.
 *    They override no native activation, and they are the document-level
 *    commands the shortcuts panel advertises as global.
 *
 * ### Moving (cursor is on the grid)
 *   ArrowLeft / ArrowRight   previous / next column
 *   ArrowUp / ArrowDown      previous / next row
 *   Home / End               first / last column of the row
 *   Ctrl+Home / Ctrl+End     first / last cell of the grid
 *
 * "Row" includes the classical register, which the cursor reaches like any
 * other row of the grid — the ARIA grid pattern asks for every cell to be
 * reachable, and a read-only row is one you cannot edit rather than one you
 * cannot look at. Every command that would write through the cursor
 * (`activate`, `removeAtCursor`, `paste`) tests `isRegisterRow` first and
 * refuses with `classical-row`, because the bits there are written by the
 * measurements on the wires above and never directly.
 *
 * ### Building
 *   a gate key              arm a gate from the palette (h, x, c, …; the
 *                           full map is `GATE_KEYS` in gateCatalog.ts, and
 *                           every palette button shows its own)
 *   Enter                   place the armed gate at the cursor; with a
 *                           multi-qubit gate, take the next wire; with no
 *                           gate armed, select whatever is under the cursor
 *   Space                   pick the gate under the cursor up for a keyboard
 *                           drag — dnd-kit's, not this hook's
 *   Escape                  cancel the pending placement, else disarm the
 *                           palette, else clear the selection
 *   Delete / Backspace      remove the operation under the cursor, else the
 *                           current selection
 *
 * ### Document
 *   Ctrl+Z                  undo
 *   Ctrl+Shift+Z, Ctrl+Y    redo
 *   Ctrl+C                  copy the selection
 *   Ctrl+V                  paste with the cursor as the top-left corner
 *
 * Cmd is accepted wherever Ctrl is, so the map is not a lie on macOS.
 */

import { qubitsOf, type Control, type GateId } from '@qsim/schema'
import {
  useCallback,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
} from 'react'
import { useStore } from 'zustand'

import { gateForKey } from './gateCatalog'
import { gridSizeOf, isRegisterRow, rowCount, type Cell } from './geometry'
import { clbitLabel, qubitLabel } from './operationRoles'
import {
  beginPlacement,
  continuePlacement,
  moveTo,
  pendingFits,
  remapPending,
  type DragPayload,
  type FeedbackCode,
  type PendingPlacement,
  type PlacementStep,
} from './placement'
import {
  operationAt,
  type CircuitState,
  type CircuitStore,
  type EditResult,
} from './useCircuitStore'

const ORIGIN: Cell = { qubit: 0, column: 0 }

/**
 * Keys that move the cursor, place, select or delete — everything that acts
 * *on the grid*. Listed so the origin test below is one lookup instead of a
 * condition repeated in nine branches, where the tenth would eventually be
 * written without it.
 */
const GRID_KEYS: ReadonlySet<string> = new Set([
  'ArrowLeft',
  'ArrowRight',
  'ArrowUp',
  'ArrowDown',
  'Home',
  'End',
  'Enter',
  'Delete',
  'Backspace',
])

/**
 * Where a keystroke came from.
 *
 * `closest` matches the element itself, which is what makes the grid test
 * true both for a keydown on a cell and for one on the grid container — the
 * cells have no handler of their own, so everything they produce arrives
 * here having bubbled through the container anyway.
 *
 * The palette is identified by `data-gate`, the attribute its chips already
 * carry for the roving tabindex: focus inside the palette is always on a
 * chip, and the alternative — matching a CSS class — would tie this rule to
 * a stylesheet that has no say in it.
 */
function originOf(target: HTMLElement | null) {
  return {
    typing:
      target?.closest('input, textarea, select, [contenteditable]') != null,
    grid: target?.closest('[role="grid"]') != null,
    palette: target?.closest('[data-gate]') != null,
  }
}

/**
 * Something the editor did, in the terms the live region will say it.
 *
 * A key and its values rather than a finished sentence, for the reason
 * `operationRoles.ts` gives: the gate is named by its *id*, and the view
 * turns that into notation through `Notation`, so no symbol is ever pasted
 * into the middle of a translated string (D2).
 *
 * Wires are carried as indices and named by the view against the circuit it
 * is rendering — except for `label`, which is a name captured at the moment
 * of the edit, because a wire that has just been deleted has no index left
 * to look up.
 */
export interface EditReport {
  /** Key under `feedback.` in the `editor` catalog. */
  readonly key: string
  /** Gate id, spoken as notation before the sentence. */
  readonly gate?: string
  /** Wires the sentence names, in canvas order. */
  readonly qubits?: readonly number[]
  readonly column?: number
  /** Drives the i18next plural, so every count needs its own two forms. */
  readonly count?: number
  /** A register name — `q3`, `c1` — read before the edit that consumed it. */
  readonly label?: string
}

/** The two things the editor has to say: it refused, or it did something. */
export type GridMessage =
  | { readonly kind: 'refused'; readonly code: FeedbackCode }
  | { readonly kind: 'done'; readonly report: EditReport }

export interface GridAnnouncement {
  readonly message: GridMessage
  /**
   * Rises with every report, including a report identical to the last one.
   *
   * Repeating a message verbatim is silence: two undos in a row render the
   * same string, React leaves the text node alone, no mutation record is
   * produced and a screen reader says nothing at all — the exact ambiguity
   * this whole channel exists to remove. The view keys the sentence's
   * element by this number so the node is replaced on every report.
   */
  readonly seq: number
}

export interface KeyboardGridOptions {
  readonly store: CircuitStore
  /** Columns the grid draws, including the empty ones past the circuit. */
  readonly columns: number
  /** Below 768px the editor is read-only (§10); every action then refuses. */
  readonly readOnly?: boolean
}

export interface KeyboardGrid {
  readonly cursor: Cell
  readonly armed: GateId | null
  readonly pending: PendingPlacement | null
  /** The last thing that happened, refusal or outcome alike. */
  readonly announcement: GridAnnouncement | null
  /**
   * Whether the cursor cell should pull DOM focus to itself. False until the
   * user touches the grid, so arriving on the page does not yank focus out
   * of wherever the browser put it.
   */
  readonly focusCursor: boolean
  // Declared as properties rather than methods on purpose: every one of
  // them is handed straight to a JSX prop, and a method signature makes
  // `@typescript-eslint/unbound-method` — rightly — treat that as losing
  // `this`. These close over their state and have no `this` to lose.
  readonly arm: (gate: GateId | null) => void
  readonly moveCursorTo: (cell: Cell) => void
  readonly activate: (cell: Cell) => void
  readonly cancel: () => void
  readonly applyDrop: (payload: DragPayload, cell: Cell) => void
  readonly handleKeyDown: (event: KeyboardEvent<HTMLElement>) => void
  // The register commands and the history commands. They are here rather
  // than called on the store directly because both renumber or replace the
  // wires a pending placement is standing on; see the header.
  readonly addQubit: (at: number) => void
  readonly removeQubit: (index: number) => void
  readonly reorderQubits: (order: readonly number[]) => void
  readonly addClbit: () => void
  readonly removeClbit: () => void
  readonly undo: () => void
  readonly redo: () => void
  // The document commands the toolbar and the Ctrl chords share. Both paths
  // come through here for the same reason undo does: a command that reports
  // its outcome from one path and not from the other is a command that is
  // silent exactly half the time.
  readonly copy: () => void
  readonly paste: () => void
  readonly removeSelection: () => void
  readonly compactColumns: () => void
}

export function useKeyboardGrid({
  store,
  columns,
  readOnly = false,
}: KeyboardGridOptions): KeyboardGrid {
  const circuit = useStore(store, (state) => state.circuit)
  const [cursor, setCursor] = useState<Cell>(ORIGIN)
  const [armed, setArmed] = useState<GateId | null>(null)
  const [pending, setPending] = useState<PendingPlacement | null>(null)
  const [announcement, setAnnouncement] = useState<GridAnnouncement | null>(
    null
  )
  const [focusCursor, setFocusCursor] = useState(false)
  // Monotonic across clears as well, so a report that follows an identical
  // one can never reuse its number; see `GridAnnouncement.seq`.
  const reports = useRef(0)

  // The cursor is clamped on read rather than on write: qubits disappear
  // when a wire is deleted, and a cursor stored past the end would point at
  // a cell that no longer exists until the next arrow key.
  const size = useMemo(() => gridSizeOf(circuit, columns), [circuit, columns])
  // `rowCount` rather than `size.qubits`: the classical register is a row of
  // the grid, so the cursor reaches it like any other — see `geometry.ts`.
  const rows = rowCount(size)
  const safeCursor = useMemo(
    () => ({
      qubit: clamp(cursor.qubit, 0, rows - 1),
      column: clamp(cursor.column, 0, size.columns - 1),
    }),
    [cursor.qubit, cursor.column, rows, size.columns]
  )

  // And the placement is validated on read for the same reason. Every
  // command below either moves the picks with their wires or ends the
  // placement, so this should never fire; it exists so that a register
  // mutator added later and wired up by nobody cannot produce a placement
  // whose claimed wires are off the canvas — a prompt with no answer and a
  // highlight on a wire that is not there. `editRegister` then drops the
  // stored copy, so a register that grows back cannot resurrect it.
  const safePending = useMemo(
    () => (pending !== null && pendingFits(pending, circuit) ? pending : null),
    [pending, circuit]
  )

  const say = useCallback((message: GridMessage | null) => {
    reports.current += 1
    setAnnouncement(message === null ? null : { message, seq: reports.current })
  }, [])

  const refuse = useCallback(
    (code: FeedbackCode) => {
      say({ kind: 'refused', code })
    },
    [say]
  )

  const clearMessage = useCallback(() => {
    say(null)
  }, [say])

  /**
   * Reports the outcome — the refusal, or `done` — and answers whether the
   * edit went through.
   *
   * `done` is null only where success has nothing worth saying: a wire
   * reorder the user just performed by hand, and the paths where the caller
   * builds its report from the result and has already refused.
   */
  const settle = useCallback(
    (result: EditResult, done: EditReport | null): boolean => {
      if (!result.ok) {
        refuse(result.reason)
        return false
      }
      say(done === null ? null : { kind: 'done', report: done })
      return true
    },
    [refuse, say]
  )

  const arm = useCallback(
    (gate: GateId | null) => {
      setArmed(gate)
      setPending(null)
      clearMessage()
    },
    [clearMessage]
  )

  const moveCursorTo = useCallback(
    (cell: Cell) => {
      setFocusCursor(true)
      // Cells report their own focus here, so this runs for the cell the
      // cursor is already on — and it must then change nothing. Clearing the
      // message unconditionally would erase the report made a microtask ago,
      // by the very focus that report's own re-render caused.
      if (
        cell.qubit === safeCursor.qubit &&
        cell.column === safeCursor.column
      ) {
        return
      }
      setCursor(cell)
      // A message is about the cell it was reported on. Moving away answers
      // it, and leaving it on screen would make the next cell look guilty.
      // Nothing is said in its place: navigation is not news.
      clearMessage()
    },
    [clearMessage, safeCursor.qubit, safeCursor.column]
  )

  const cancel = useCallback(() => {
    clearMessage()
    // Unconditional, so nothing stale outlives the Escape; only a placement
    // the user can actually see absorbs the press.
    setPending(null)
    if (safePending !== null) return
    if (armed !== null) {
      setArmed(null)
      return
    }
    store.getState().clearSelection()
  }, [clearMessage, store, armed, safePending])

  /** Turns one placement step into store calls and screen feedback. */
  const advance = useCallback(
    (step: PlacementStep) => {
      if (step.kind === 'refused') {
        refuse(step.code)
        return
      }
      if (step.kind === 'pending') {
        setPending(step.pending)
        // The prompt for the next wire takes the region over; saying "half a
        // gate placed" first would be a fact about nothing.
        clearMessage()
        return
      }
      const { gate, targets, column, controls, clbitTargets } = step.draft
      const placed = store.getState().placeGate(gate, targets, column, {
        ...(controls !== undefined ? { controls } : {}),
        ...(clbitTargets !== undefined ? { clbitTargets } : {}),
      })
      // A refused completion leaves the pending placement standing so the
      // user can pick a different partner instead of starting over.
      if (
        settle(placed, {
          key: 'placed',
          gate,
          qubits: wiresOf(targets, controls),
          column,
        })
      ) {
        setPending(null)
      }
    },
    [store, clearMessage, refuse, settle]
  )

  const activate = useCallback(
    (cell: Cell) => {
      setFocusCursor(true)
      setCursor(cell)
      if (readOnly) {
        refuse('read-only')
        return
      }
      // The register row is reachable so it can be read, and answers rather
      // than doing nothing: a key that is silent on one row of a grid and
      // active on every other reads as a fault, not as a rule.
      if (isRegisterRow(cell, size)) {
        refuse('classical-row')
        return
      }

      if (safePending !== null) {
        advance(continuePlacement(circuit, safePending, cell))
        return
      }
      if (armed !== null) {
        advance(beginPlacement(circuit, armed, cell))
        return
      }

      const occupant = operationAt(circuit, cell.qubit, cell.column)
      if (occupant === undefined) {
        refuse('no-gate-armed')
        return
      }
      // Selecting says nothing: the selection is not the document, and the
      // cell the user is standing on already speaks its own contents.
      store.getState().setSelection([occupant.id])
      clearMessage()
    },
    [
      store,
      advance,
      armed,
      circuit,
      safePending,
      readOnly,
      size,
      clearMessage,
      refuse,
    ]
  )

  const applyDrop = useCallback(
    (payload: DragPayload, cell: Cell) => {
      setFocusCursor(false)
      setCursor(cell)
      if (readOnly) {
        refuse('read-only')
        return
      }

      if (payload.kind === 'palette') {
        // A drop always starts a fresh placement: dropping a second gate
        // while one is half-placed means the user changed their mind.
        setPending(null)
        advance(beginPlacement(circuit, payload.gate, cell))
        return
      }

      const operation = circuit.operations.find(
        (candidate) => candidate.id === payload.id
      )
      if (operation === undefined) {
        refuse('operation-not-found')
        return
      }
      const outcome = moveTo(circuit, operation, payload.grabbedQubit, cell)
      if (outcome.kind === 'refused') {
        refuse(outcome.code)
        return
      }
      const { id, targets, column, controls, clbitTargets } = outcome.draft
      settle(
        store.getState().moveOperation(id, targets, column, {
          ...(controls !== undefined ? { controls } : {}),
          ...(clbitTargets !== undefined ? { clbitTargets } : {}),
        }),
        {
          key: 'moved',
          gate: operation.gate,
          qubits: wiresOf(targets, controls),
          column,
        }
      )
    },
    [store, advance, circuit, readOnly, refuse, settle]
  )

  const removeAtCursor = useCallback(
    (cell: Cell) => {
      const state = store.getState()
      // Nothing is deleted *from* the register: what is written there belongs
      // to the measurement on a wire, and Delete here must not silently fall
      // through to emptying the selection instead.
      if (isRegisterRow(cell, size)) {
        refuse('classical-row')
        return
      }
      const occupant = operationAt(circuit, cell.qubit, cell.column)
      if (occupant !== undefined) {
        // Read before the removal: afterwards there is no operation left to
        // describe, and "something was deleted" is not an answer.
        settle(state.removeOperation(occupant.id), {
          key: 'removed',
          gate: occupant.gate,
          qubits: [...qubitsOf(occupant)].sort((a, b) => a - b),
          column: occupant.column,
        })
        return
      }
      if (state.selection.length > 0) {
        settle(state.removeOperations(state.selection), {
          key: 'removedMany',
          count: state.selection.length,
        })
        return
      }
      refuse('nothing-here')
    },
    [store, circuit, size, refuse, settle]
  )

  const removeSelection = useCallback(() => {
    const state = store.getState()
    settle(state.removeOperations(state.selection), {
      key: 'removedMany',
      count: state.selection.length,
    })
  }, [store, settle])

  const copy = useCallback(() => {
    const result = store.getState().copy()
    settle(
      result,
      result.ok ? { key: 'copied', count: result.ids.length } : null
    )
  }, [store, settle])

  const paste = useCallback(() => {
    const cell = safeCursor
    // The paste corner is a wire, and the contract would refuse the register
    // row as `qubit-out-of-range` — true, and unhelpful about which row is
    // the problem.
    if (isRegisterRow(cell, size)) {
      refuse('classical-row')
      return
    }
    const result = store.getState().paste(cell.qubit, cell.column)
    settle(
      result,
      result.ok
        ? {
            key: 'pasted',
            count: result.ids.length,
            qubits: [cell.qubit],
            column: cell.column,
          }
        : null
    )
  }, [store, safeCursor, size, refuse, settle])

  const compactColumns = useCallback(() => {
    // `compactColumns` accepts either way — closing no gaps is not a refusal
    // — so the two outcomes are told apart by whether the document moved.
    // Both are worth saying: a button that answers nothing reads as broken.
    const before = store.getState().circuit
    const result = store.getState().compactColumns()
    settle(result, {
      key: store.getState().circuit === before ? 'noGaps' : 'gapsClosed',
    })
  }, [store, settle])

  /**
   * Runs a register command and takes the pending placement with it.
   *
   * `survive` is the wire transform, and returning `null` from it means the
   * placement cannot follow — the wire it stood on is gone. That case
   * outranks the edit's own report: it is the surprising half of what
   * happened, and the half the user did not ask for. A placement that merely
   * slid one row is still anchored where the user put it, and reporting a
   * retarget that did not happen is noise in a live region.
   *
   * `describe` is a thunk because a wire's name is only settled once the
   * edit has landed — an insertion renumbers the labels it pushed aside.
   *
   * The remap runs only after the store accepted the edit. A refused
   * `addQubit` at the register ceiling changes no wire, so moving the picks
   * would invent a renumbering that never took place.
   */
  const editRegister = useCallback(
    (
      edit: () => EditResult,
      describe: () => EditReport | null,
      survive: (pending: PendingPlacement) => PendingPlacement | null
    ) => {
      const current = safePending
      const result = edit()
      if (!settle(result, result.ok ? describe() : null)) return
      if (current === null) {
        // Either there was no placement, or there was one that no longer
        // fits the register — invisible already, and dropped here so that a
        // wire arriving now cannot bring it back.
        setPending(null)
        return
      }

      const next = survive(current)
      setPending(next)
      if (next === null) refuse('cancelled-by-register-edit')
    },
    [refuse, safePending, settle]
  )

  const addQubit = useCallback(
    (at: number) => {
      editRegister(
        () => store.getState().addQubit(at),
        () => ({
          key: 'qubitAdded',
          label: qubitLabel(store.getState().circuit, at),
        }),
        (current) =>
          remapPending(current, (qubit) => (qubit >= at ? qubit + 1 : qubit))
      )
    },
    [store, editRegister]
  )

  const removeQubit = useCallback(
    (index: number) => {
      // The name is read before the edit: after it, that index belongs to
      // the wire that took the deleted one's place.
      const label = qubitLabel(circuit, index)
      const held = circuit.operations.length
      editRegister(
        () => store.getState().removeQubit(index),
        /*
         * The cascade is counted, not just the wire.
         *
         * Deleting a wire deletes every operation that touches it, and a CNOT
         * whose control sat here mostly lived on a *different* wire — it
         * disappears from a row the user was not looking at. "Wire q0
         * removed." on its own under-reports exactly the half nobody asked
         * for. `removeClbit` needs no counterpart: everything its own cascade
         * takes is drawn on the register row it is shrinking.
         */
        () => {
          const lost = held - store.getState().circuit.operations.length
          return lost === 0
            ? { key: 'qubitRemoved', label }
            : { key: 'qubitRemovedWithGates', label, count: lost }
        },
        (current) =>
          current.picks.includes(index)
            ? null
            : remapPending(current, (qubit) =>
                qubit > index ? qubit - 1 : qubit
              )
      )
    },
    [circuit, store, editRegister]
  )

  const reorderQubits = useCallback(
    (order: readonly number[]) => {
      const positionOf = new Map(
        order.map((old, position) => [old, position] as const)
      )
      editRegister(
        () => store.getState().reorderQubits(order),
        // Nothing to say: the user dragged the wires themselves, and the row
        // headers they are looking at have already moved.
        () => null,
        (current) =>
          remapPending(current, (qubit) => positionOf.get(qubit) ?? qubit)
      )
    },
    [store, editRegister]
  )

  /*
   * The classical register has no pending placement to protect — its bits
   * are not wires and no half-built gate stands on one — so these two go
   * straight to the store. They come through the hook for the reporting
   * alone, which is the whole reason the gutter's other buttons do.
   */
  const addClbit = useCallback(() => {
    const added = store.getState().circuit.clbits
    settle(store.getState().addClbit(), {
      key: 'clbitAdded',
      label: clbitLabel(added),
    })
  }, [store, settle])

  const removeClbit = useCallback(() => {
    const state = store.getState()
    // The highest bit, always: `removeClbit` cascades, so taking one from the
    // middle would renumber every measurement above it.
    const index = state.circuit.clbits - 1
    settle(state.removeClbit(index), {
      key: 'clbitRemoved',
      label: clbitLabel(index),
    })
  }, [store, settle])

  /**
   * Undo and redo, from the toolbar and from the chords alike — one
   * implementation, because a rule that lives in two places is a rule that
   * eventually holds in one of them.
   *
   * A history move that actually changed the document ends a half-finished
   * placement: the circuit it was being assembled against is gone, and there
   * is no transform from "some earlier circuit" to "where the user's wires
   * went". Undo on an empty history changes nothing, and is therefore not
   * allowed to cancel anything either.
   *
   * Both outcomes are spoken, and they are the pair this whole channel was
   * built for: "Undone." and "There is nothing left to undo." leave exactly
   * the same canvas behind, so a user who cannot see it can only tell them
   * apart if the editor says which one happened.
   */
  const rewind = useCallback(
    (run: (state: CircuitState) => EditResult, done: EditReport) => {
      const before = store.getState().circuit
      if (!settle(run(store.getState()), done)) return
      if (safePending === null || store.getState().circuit === before) return
      setPending(null)
      // Overrides "Undone.": the cancelled placement is the surprise, and a
      // live region gets one sentence.
      refuse('cancelled-by-register-edit')
    },
    [store, refuse, safePending, settle]
  )

  const undo = useCallback(() => {
    rewind((state) => state.undo(), { key: 'undone' })
  }, [rewind])

  const redo = useCallback(() => {
    rewind((state) => state.redo(), { key: 'redone' })
  }, [rewind])

  const handleKeyDown = useCallback(
    (event: KeyboardEvent<HTMLElement>) => {
      const origin = originOf(event.target as HTMLElement | null)

      if (event.key === 'Escape') {
        if (origin.typing) return
        event.preventDefault()
        cancel()
        return
      }
      if (origin.typing) return

      /*
       * The origin gate. Below this line the handler may assume that a grid
       * key really came from the grid, so `preventDefault` never swallows
       * the activation of a control the user is standing on: Enter on the
       * Undo button undoes, Space on the shortcuts disclosure opens it,
       * Delete on a toolbar button deletes nothing, and an arrow key does
       * not teleport focus into the canvas (WCAG 2.1.1, 2.4.3, 3.2.1).
       *
       * It sits above the Ctrl/Cmd branch because Ctrl+Home and Ctrl+End
       * move the cursor too, and the flag they need is this one.
       */
      if (GRID_KEYS.has(event.key) && !origin.grid) return

      const command = event.ctrlKey || event.metaKey

      if (command) {
        const key = event.key.toLowerCase()
        if (key === 'z') {
          event.preventDefault()
          if (event.shiftKey) redo()
          else undo()
          return
        }
        if (key === 'y') {
          event.preventDefault()
          redo()
          return
        }
        if (key === 'c') {
          event.preventDefault()
          copy()
          return
        }
        if (key === 'v') {
          event.preventDefault()
          paste()
          return
        }
        if (event.key === 'Home' || event.key === 'End') {
          event.preventDefault()
          moveCursorTo(
            event.key === 'Home'
              ? ORIGIN
              : { qubit: rows - 1, column: size.columns - 1 }
          )
          return
        }
        return
      }

      const bounds = { rows, columns: size.columns }
      switch (event.key) {
        case 'ArrowLeft':
          event.preventDefault()
          moveCursorTo(stepCell(safeCursor, 0, -1, bounds))
          return
        case 'ArrowRight':
          event.preventDefault()
          moveCursorTo(stepCell(safeCursor, 0, 1, bounds))
          return
        case 'ArrowUp':
          event.preventDefault()
          moveCursorTo(stepCell(safeCursor, -1, 0, bounds))
          return
        case 'ArrowDown':
          event.preventDefault()
          moveCursorTo(stepCell(safeCursor, 1, 0, bounds))
          return
        case 'Home':
          event.preventDefault()
          moveCursorTo({ qubit: safeCursor.qubit, column: 0 })
          return
        case 'End':
          event.preventDefault()
          moveCursorTo({ qubit: safeCursor.qubit, column: size.columns - 1 })
          return
        case 'Enter':
          event.preventDefault()
          activate(safeCursor)
          return
        case 'Delete':
        case 'Backspace':
          event.preventDefault()
          if (readOnly) {
            refuse('read-only')
            return
          }
          removeAtCursor(safeCursor)
          return
        default:
          break
      }

      /*
       * Arming a gate with a single letter is the affordance that makes a
       * palette of twenty-six gates usable without a pointer, and WCAG 2.1.4
       * allows exactly that as long as the shortcut is switchable off,
       * remappable, or live only while the component it belongs to has
       * focus. There is no preferences screen yet, so the third route is the
       * one taken: the gate keys belong to the grid and to the palette
       * together — arming from a chip is what `GatePalette` documents — and
       * are inert everywhere else in the editor, where `c` used to arm a
       * CNOT while the user was aiming at the Copy button.
       */
      if (!origin.grid && !origin.palette) return

      const gate = gateForKey(event.key)
      if (gate !== undefined) {
        event.preventDefault()
        arm(gate)
      }
    },
    [
      activate,
      arm,
      cancel,
      copy,
      moveCursorTo,
      paste,
      readOnly,
      redo,
      refuse,
      removeAtCursor,
      rows,
      safeCursor,
      size,
      undo,
    ]
  )

  return {
    cursor: safeCursor,
    armed,
    pending: safePending,
    announcement,
    focusCursor,
    arm,
    moveCursorTo,
    activate,
    cancel,
    applyDrop,
    handleKeyDown,
    addQubit,
    removeQubit,
    reorderQubits,
    addClbit,
    removeClbit,
    undo,
    redo,
    copy,
    paste,
    removeSelection,
    compactColumns,
  }
}

/**
 * Every wire an operation names, in canvas order.
 *
 * Sorted rather than left in slot order: the user picked a CNOT's target
 * before its control, but "q0 and q1" is the order they are looking at, and
 * a sentence that read "q1 and q0" would be describing the same gate in a
 * shape nobody drew.
 */
function wiresOf(
  targets: readonly number[],
  controls: readonly Control[] | undefined
): number[] {
  return [
    ...targets,
    ...(controls ?? []).map((control) =>
      typeof control === 'number' ? control : control.qubit
    ),
  ].sort((first, second) => first - second)
}

function stepCell(
  cell: Cell,
  dq: number,
  dc: number,
  bounds: { rows: number; columns: number }
): Cell {
  return {
    qubit: clamp(cell.qubit + dq, 0, bounds.rows - 1),
    column: clamp(cell.column + dc, 0, bounds.columns - 1),
  }
}

function clamp(value: number, low: number, high: number): number {
  return Math.min(high, Math.max(low, value))
}
