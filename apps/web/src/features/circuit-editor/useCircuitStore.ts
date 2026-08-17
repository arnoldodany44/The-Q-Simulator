/**
 * The circuit store — the editor's single source of truth (§9).
 *
 * Everything the canvas draws is a function of one `Circuit` held here.
 * Nothing derivable from it is stored beside it: gate count, depth and the
 * occupancy of a cell are computed on read, from `@qsim/schema` helpers or
 * from the selectors at the bottom of this file. A cached derived value is a
 * value that eventually disagrees with the thing it was derived from, and in
 * an editor that disagreement shows up as a gate the user can see but cannot
 * grab.
 *
 * Three rules make the rest of the editor safe to write against:
 *
 * 1. **The circuit is always valid.** Every action builds a candidate circuit
 *    and hands it to `safeParseCircuit`. There is no validation logic in this
 *    file — the contract is the only judge, so the editor and the engine can
 *    never disagree about what a legal circuit is. Occupancy, arity, control
 *    counts and index ranges are all enforced this way rather than
 *    re-implemented here. The single exception is the one rule the editor
 *    holds itself to and the contract does not know: no two operations of a
 *    column may write the same classical bit. It is not spelled out here
 *    either — `paste` asks `classicalWrites.ts`, which is also what
 *    `draftOf` and `moveTo` ask, so the rule has one wording and not three.
 * 2. **A refused edit changes nothing.** `commit()` is the only path to
 *    `set()`, and it runs after validation, so a rejected drag leaves the
 *    circuit object identical — same reference — and leaves the history
 *    untouched. Pressing undo after a refused drop gives back the last *real*
 *    edit, which is the only behaviour a user can predict.
 * 3. **Errors are codes, not sentences.** Actions return a `RejectionReason`,
 *    and the UI renders it through the `editor` catalog (D2). No user-facing
 *    English lives in this file.
 *
 * History uses zundo's `temporal` middleware, as planned in §3/M0.5:
 *   - `partialize` puts only the circuit and the selection under history;
 *     the clipboard and the id counter deliberately survive undo.
 *   - `equality` compares circuits by identity. Circuits are immutable and
 *     every real edit produces a new object, so identity *is* "the circuit
 *     changed". A selection-only change therefore records no step and does
 *     not clear the redo stack, while a real edit records the selection that
 *     was in place before it — undo restores the editing context, not just
 *     the geometry.
 *   - `beginTransaction`/`endTransaction` make a continuous gesture — a
 *     slider drag, a typing session — one history step instead of one per
 *     intermediate value. See them below.
 */

import {
  MAX_CLBITS,
  MAX_QUBITS,
  customGateUsage,
  emptyCircuit,
  inlineOperation,
  lookupGate,
  normalizeColumns,
  normalizeControl,
  qubitsOf,
  safeParseCircuit,
  type Circuit,
  type Condition,
  type Control,
  type CustomGate,
  type Operation,
  type ParamValue,
  type ValidationIssue,
} from '@qsim/schema'
import { temporal, type TemporalState } from 'zundo'
import { create, type StoreApi } from 'zustand'

import { writesCollide } from './classicalWrites'
import {
  customGateNameIssue,
  defaultArguments,
  definitionAsDocument,
  documentAsDefinition,
  firstFreeColumn,
  isUsableSymbol,
  packageFragment,
  parameterValues,
  reshapesUses,
  withFragmentPackaged,
} from './customGates'

/** Wires a new document starts with: room for a Bell pair and a spare. */
export const DEFAULT_QUBITS = 3

/**
 * Classical bits a new document starts with: one per qubit, which is what
 * `QuantumCircuit(n, n)` means in Qiskit and what makes `measure` placeable
 * without ceremony. A measurement writes into the bit that carries its
 * qubit's index, so an empty classical register would make the editor's
 * measure chip refuse every cell it was dropped on — a gate that is in the
 * palette and cannot be used is worse than one that is absent.
 *
 * `addQubit` extends the same decision forward: while the two registers are
 * the same width, a new wire brings its own classical bit. Without that, the
 * fourth wire of a three-bit document could never be measured — the gate was
 * in the palette, the cell was empty, and the contract refused it forever.
 * The growth is deliberately conditional; see `addQubit`.
 */
export const DEFAULT_CLBITS = DEFAULT_QUBITS

/**
 * Undo steps kept. Each step holds a whole circuit, so the ceiling is about
 * memory, not about how far back a user may reasonably want to go.
 */
const HISTORY_LIMIT = 100

const ID_PREFIX = 'op_'

/**
 * Why an edit was refused.
 *
 * The first sixteen are the contract's own validation codes, reused rather
 * than re-spelled: the schema already names every way a circuit can be wrong,
 * and a second vocabulary would only need translating twice. The rest are
 * refusals that are the store's business alone.
 *
 * The reuse is checked by the compiler: `commit` passes the contract's
 * `ValidationCode` straight into `refused`, so a code added to the schema
 * that is missing from this list fails to typecheck.
 */
export const REJECTION_REASONS = [
  'shape',
  'unknown-gate',
  'arity-mismatch',
  'control-count-mismatch',
  'param-count-mismatch',
  'clbit-target-mismatch',
  'qubit-out-of-range',
  'clbit-out-of-range',
  'target-control-overlap',
  'repeated-qubit',
  'column-conflict',
  'unknown-parameter',
  'duplicate-operation-id',
  'duplicate-parameter',
  'qubit-label-count',
  'custom-gate-cycle',
  'custom-gate-too-deep',
  'custom-gate-not-unitary',
  'custom-gate-too-large',
  'operation-not-found',
  'control-not-found',
  'empty-selection',
  'empty-clipboard',
  'register-limit',
  // Two operations of one column would write the same classical bit. The
  // contract accepts that shape and the engine has no defined answer for it,
  // which is why this refusal exists here; the rule, and why it is not the
  // contract's yet, are in `classicalWrites.ts`.
  'clbit-in-use',
  // A history move that consumed no step. They are refusals rather than
  // silences because "nothing happened" is exactly what a user who cannot
  // see the canvas needs to be told; see `undo` below.
  'nothing-to-undo',
  'nothing-to-redo',
  /*
   * ── Custom gates (M2.3) ─────────────────────────────────────────────
   *
   * Seven refusals the contract cannot express, because they are about the
   * *editing gesture* rather than about the document it would produce.
   */
  // The typed name is not an identifier, or it is a catalog gate's.
  'custom-gate-name',
  'custom-gate-exists',
  'custom-gate-not-found',
  // Deleting a definition something still calls, or inlining an operation
  // that is not a call at all.
  'custom-gate-in-use',
  'not-a-custom-gate',
  // The definition editor changed the register or the parameter list, which
  // every existing use was written against. See `reshapesUses`.
  'custom-gate-reshaped',
  // The selection skips an operation inside its own column range, so
  // packaging it would move that operation relative to the block.
  'fragment-not-rectangular',
  // A command that needs a definition open, or one that needs none.
  'definition-open',
  'no-definition-open',
] as const

export type RejectionReason = (typeof REJECTION_REASONS)[number]

/**
 * What every mutating action answers.
 *
 * `ids` names the operations the edit created or changed, so the caller can
 * focus or animate them; it is empty for edits that only remove things.
 * `issues` carries the contract's own diagnostics, which are worth logging
 * but are developer-facing English — the UI shows `reason`, translated.
 */
export type EditResult =
  | { readonly ok: true; readonly ids: readonly string[] }
  | {
      readonly ok: false
      readonly reason: RejectionReason
      readonly issues: readonly ValidationIssue[]
    }

/** Extra fields a placed gate may carry beyond its targets and column. */
export interface PlaceOptions {
  readonly controls?: readonly Control[]
  readonly params?: readonly ParamValue[]
  readonly clbitTargets?: readonly number[]
  readonly condition?: Condition
}

/**
 * A copied fragment. Qubit coordinates are relative to the fragment's own
 * top-left corner — its lowest qubit and earliest column — so pasting is a
 * translation and the clipboard survives edits to the circuit it came from.
 *
 * Classical references are stored absolute and translated at paste time,
 * which is why `originQubit` is kept: `paste` needs the wire the fragment
 * was cut from to know how far the copy travelled. They cannot be stored
 * relative like the qubits are, because a fragment's operations are
 * contract-shaped `Operation`s and a clbit index below zero is not one.
 *
 * A classical write travels with the wire it reads. The editor's only rule
 * for choosing a classical bit is `draftOf`'s "clbit index equals qubit
 * index", and it offers no way to override it — so a measurement pasted one
 * wire down that kept writing to the bit it was copied from would not be a
 * copy of what the user selected, and two measurements in one column would
 * end up writing the same bit. The engine reads a column as one instant (§6)
 * and takes its operations in no particular order, so that shape has no
 * defined answer at all.
 */
export interface CircuitFragment {
  readonly operations: readonly Operation[]
  /** Height of the fragment in qubits, for the paste preview. */
  readonly qubits: number
  /** Width of the fragment in columns. */
  readonly columns: number
  /** The wire the fragment's top row was cut from. */
  readonly originQubit: number
}

/**
 * A definition being edited on the ordinary canvas.
 *
 * ── The decision this type exists to make visible (M2.3) ─────────────────
 *
 * A definition is shared **by reference inside its document**: every use is
 * the name, so changing the definition changes every use, at once, with no
 * way to change one of them. That is the feature — it is what makes a block
 * worth having over copy and paste — and it is data loss for anyone who
 * expected a copy. The editor's answer is not to pick one meaning; it is to
 * make the count impossible to miss. `uses` is carried here so the definition
 * editor's own header can say "3 uses in this circuit will change" for the
 * whole time the user is editing, not in a dialog they dismissed on the way
 * in. The escape hatch is beside it: duplicate the definition under a new
 * name and edit that, which changes nothing.
 *
 * Sharing stops at the document. A definition installed from the library is
 * *copied* into the circuit (see `features/custom-gates`), so nobody else's
 * edit and nobody else's deletion can reach a circuit that is already using
 * it. §3.4 makes the same trade for forks, and for the same reason: a saved
 * circuit has to keep meaning what it meant.
 */
export interface DefinitionEdit {
  readonly name: string
  /** The icon, editable while the definition is open. */
  readonly symbol: string | undefined
  /** The document to come back to. */
  readonly host: Circuit
  readonly hostSelection: readonly string[]
  /**
   * The host document's id counter, carried across the detour.
   *
   * A definition body is a different document with its own counter, so coming
   * back has to restore the host's rather than derive one from the circuit: an
   * id the host used and deleted before the detour must stay spent. See
   * `firstFreeId`.
   */
  readonly hostNextId: number
  /** How many uses in the host document this edit will change. */
  readonly uses: number
}

/** The slice of the store that undo and redo travel through. */
interface CircuitSnapshot {
  readonly circuit: Circuit
  readonly selection: readonly string[]
}

/**
 * Where undo lives while the document is shared (M5.1).
 *
 * ── Why the history has to move at all ────────────────────────────────────
 *
 * zundo's history is a stack of whole circuits, and that is exactly right for
 * one person: an undo step is "the document as it was", and restoring it is
 * total. In a shared document it is wrong for the same reason — restoring the
 * document as it was also restores it as it was *for everybody*, so Ana
 * pressing undo would delete what Beto had just typed. There is no way to fix
 * that inside a snapshot history: a snapshot does not record who did what, and
 * an undo that has to skip somebody else's change needs to know.
 *
 * So while a session is shared, undo is driven by a `Y.UndoManager` scoped to
 * this client's transaction origins, which undoes this client's changes and
 * leaves everybody else's alone. This interface is the seam. It is a plain
 * interface rather than an import so that the editor's module graph — and
 * therefore the chunk every visitor downloads — carries no CRDT until somebody
 * actually opens a shared session; `features/collab` implements it.
 *
 * ── What the solo path pays for it ────────────────────────────────────────
 *
 * Nothing. With nothing attached, every method below behaves exactly as it did
 * before this interface existed, on the same zundo history, and the existing
 * suite for that behaviour is unchanged. Most sessions have one person in them,
 * and making the common case worse to serve the rare one would be a bad trade.
 */
export interface SharedHistory {
  /** Undo up to `steps` of this client's own changes. False if none were left. */
  undo(steps: number): boolean
  redo(steps: number): boolean
  clear(): void
  /** Collapse everything until `endGesture` into one step. */
  beginGesture(): void
  endGesture(): void
}

export interface CircuitState extends CircuitSnapshot {
  /** Ids of the selected operations, always in circuit order. */
  readonly selection: readonly string[]
  readonly clipboard: CircuitFragment | null
  /**
   * Next id to try. Kept in the store rather than in a module variable so two
   * stores cannot mint the same id, and never rewound by undo: reusing the id
   * of an operation the user undid would make the redo stack ambiguous.
   */
  readonly nextId: number
  /**
   * Which *document* is open, counted up every time a whole one replaces the
   * one before it — `loadCircuit` and `reset`, never an edit.
   *
   * It exists because an edit and a document swap are indistinguishable from
   * the outside: both hand out a new `circuit` object, and everything reading
   * the store sees one changed reference either way. Views that are about the
   * document rather than part of it need to tell them apart. The timeline is
   * the case that forced it (§3.1's frozen decision 2 keeps the scrub position
   * across an *edit*, and pairs that with undo restoring the circuit and the
   * position together — a pairing a preset chip does not have, since it clears
   * the history), and `/c/:slug` will be the next.
   *
   * Deliberately outside `partialize`: undo moves within one document and must
   * not renumber it.
   */
  readonly documentId: number
  /**
   * The definition currently open on the canvas, or `null` for the ordinary
   * case of editing the circuit itself.
   *
   * Deliberately outside `partialize`, like `documentId`: undo moves within
   * one document, and a definition editing session is a different document.
   */
  readonly definitionEdit: DefinitionEdit | null

  placeGate(
    gate: string,
    targets: readonly number[],
    column: number,
    options?: PlaceOptions
  ): EditResult
  moveOperation(
    id: string,
    targets: readonly number[],
    column: number,
    options?: {
      readonly controls?: readonly Control[]
      readonly clbitTargets?: readonly number[]
    }
  ): EditResult
  removeOperation(id: string): EditResult
  removeOperations(ids: readonly string[]): EditResult

  addControl(operationId: string, qubit: number, state?: 0 | 1): EditResult
  removeControl(operationId: string, qubit: number): EditResult
  setParam(operationId: string, index: number, value: ParamValue): EditResult

  addQubit(at?: number): EditResult
  removeQubit(index: number): EditResult
  reorderQubits(order: readonly number[]): EditResult
  setQubitLabel(index: number, label: string): EditResult
  addClbit(): EditResult
  removeClbit(index: number): EditResult

  copy(): EditResult
  paste(qubit: number, column: number): EditResult
  compactColumns(): EditResult

  /* ── Custom gates and subcircuits (§3.1, M2.3) ─────────────────────── */

  /** Wrap the selection in a new definition and place the block in its stead. */
  packageSelection(
    name: string,
    options?: { readonly symbol?: string }
  ): EditResult
  /** Place an existing definition on the first column where it fits. */
  placeCustomGate(name: string, qubit?: number): EditResult
  /** Replace one use with the operations it stands for, one level deep. */
  inlineOperation(id: string): EditResult
  /** Copy a definition under a new name — the way to branch instead of edit. */
  duplicateCustomGate(name: string, into: string): EditResult
  /** Add a definition that came from elsewhere, by value. */
  installCustomGate(name: string, definition: CustomGate): EditResult
  /** Remove a definition. Refused while anything still calls it. */
  removeCustomGate(name: string): EditResult

  /** Open a definition's body as the document being edited. */
  openDefinition(name: string): EditResult
  /** Change the icon of the definition currently open. */
  setDefinitionSymbol(symbol: string): EditResult
  /** Write the open definition back, updating every use, and return to the host. */
  applyDefinition(): EditResult
  /** Go back to the host document, changing nothing. */
  cancelDefinition(): EditResult

  setSelection(ids: readonly string[]): void
  toggleSelection(id: string): void
  clearSelection(): void

  loadCircuit(input: unknown): EditResult
  /**
   * Take the document a shared session says we are editing (M5.1).
   *
   * Not `loadCircuit`: this is the *same* document, arriving changed, so
   * `documentId` does not move — a remote keystroke must not reset the timeline
   * scrubber or count as opening something new — and the history is not
   * cleared, because the history of a shared session belongs to the
   * `SharedHistory` driver and not to this store.
   *
   * It still goes through the contract like every other edit: the projection it
   * comes from is valid by construction, and the store's first rule is that the
   * only judge of that is the contract.
   */
  adoptDocument(circuit: Circuit): EditResult
  /**
   * Hand undo over to a shared session, or take it back with `null`.
   *
   * Both directions clear the history: a local stack of snapshots taken before
   * a session is a stack of documents that were only ever this client's, and
   * offering to restore one of them after other people have edited is offering
   * to delete their work. Leaving a session leaves you where the document is.
   */
  attachHistory(history: SharedHistory | null): void
  reset(): void
  /**
   * Both answer an `EditResult` so the caller can say what happened. Undo is
   * the one command whose success and failure look identical on screen — the
   * canvas simply is what it is — so a user who cannot see it has no way to
   * tell "that was undone" from "there was nothing left to undo" unless the
   * store reports which one it was.
   */
  undo(steps?: number): EditResult
  redo(steps?: number): EditResult
  clearHistory(): void

  /**
   * Opens a gesture: everything committed until `endTransaction` collapses
   * into a single history step whose past state is the document as it stood
   * *before* the gesture began.
   *
   * The edits themselves are not deferred — a slider drag has to keep
   * repainting the phasors while it moves, so `setParam` applies every
   * intermediate value at once. Only the recording is grouped. Nesting is
   * not a thing: a second `beginTransaction` while one is open is ignored,
   * because the gestures this exists for are physical and a user has one
   * pointer.
   */
  beginTransaction(): void
  /**
   * Closes the gesture opened by `beginTransaction`. A gesture that ended
   * where it began — dragged out and back — records nothing at all, matching
   * the no-op guard every single-shot action already has.
   */
  endTransaction(): void
}

type CircuitHistory = StoreApi<TemporalState<CircuitSnapshot>>

/**
 * zundo hangs the history store off the zustand api object, but inside the
 * initializer the mutator still types it as `unknown` — it is only typed on
 * the store the caller receives. One cast here keeps every action honest.
 */
function historyOf(api: unknown): CircuitHistory {
  return (api as { temporal: CircuitHistory }).temporal
}

const accepted = (ids: readonly string[] = []): EditResult => ({
  ok: true,
  ids,
})

const refused = (
  reason: RejectionReason,
  issues: readonly ValidationIssue[] = []
): EditResult => ({ ok: false, reason, issues })

/**
 * Creates an independent store. The editor uses the shared instance below;
 * tests and previews create their own, so no state leaks between them.
 *
 * `initialCircuit` is trusted — it is already a parsed `Circuit`. Untrusted
 * JSON goes through `loadCircuit`, which validates it.
 */
export function createCircuitStore(
  initialCircuit: Circuit = emptyCircuit(DEFAULT_QUBITS, DEFAULT_CLBITS)
) {
  return create<CircuitState>()(
    temporal(
      (set, get, api) => {
        const history = (): TemporalState<CircuitSnapshot> =>
          historyOf(api).getState()

        /**
         * The gesture in progress, if any.
         *
         * A closure variable rather than a field of the state: a half-made
         * drag is not part of the document, nothing renders from it, and
         * putting it under `partialize` would make undo restore a gesture
         * that is long over.
         *
         * `recorded` says whether the gesture has already pushed its one
         * history step. The first commit of a gesture is deliberately left
         * to record normally — that pushes exactly the pre-gesture state,
         * which is the one undo has to come back to — and only then is
         * tracking paused for the rest of the drag. The snapshots of the two
         * stacks are what makes a gesture that ends where it started cost
         * nothing, redo stack included.
         */
        let gesture: {
          readonly circuit: Circuit
          readonly pastStates: Partial<CircuitSnapshot>[]
          readonly futureStates: Partial<CircuitSnapshot>[]
          recorded: boolean
        } | null = null

        /** Ends a gesture without judging what it recorded. */
        const abandonGesture = (): void => {
          if (gesture === null) return
          const { recorded } = gesture
          gesture = null
          if (recorded) history().resume()
        }

        /**
         * The shared session's history, while there is one (M5.1).
         *
         * A closure variable for the same reason `gesture` is one: it is not
         * part of the document, nothing renders from it, and putting it under
         * `partialize` would make undo restore a session.
         *
         * While it drives the open document, zundo is paused rather than merely
         * ignored — an unread stack that keeps growing is a hundred circuits of
         * memory and, worse, a stack somebody could later restore from. Every
         * branch that consults it below returns before touching zundo, so
         * `gesture` stays null and `commit`'s pause/resume bookkeeping never
         * runs against a paused history.
         *
         * The exception is a definition session, which is a different document
         * and takes the zundo path even while this is set — see `driver` and
         * `resetDocumentHistory`.
         */
        let shared: SharedHistory | null = null

        /** Clears whichever history is in charge. */
        const resetHistory = (): void => {
          shared?.clear()
          history().clear()
        }

        /**
         * The history driving the document that is open, which is not always the
         * session's — see `resetDocumentHistory`.
         */
        const driver = (): SharedHistory | null =>
          get().definitionEdit === null ? shared : null

        /**
         * Clears the history of the document being *left*, and hands the next
         * one the driver that belongs to it.
         *
         * ── Why a definition session does not use the shared history ────────
         *
         * A definition body is a different document — this store says so, and
         * bumps `documentId` for it — and the `SharedHistory` a session attaches
         * is a `Y.UndoManager` over the *shared* document. Two things followed
         * from routing a definition edit through it, and both were wrong.
         *
         * Clearing it on the way in threw away every step of the shared session
         * that had been taken so far: opening a definition made Ana's earlier
         * edits permanently un-undoable, and the session's undo stack is the one
         * thing in this design that cannot be rebuilt from the document.
         *
         * And while the definition was open, pressing undo asked the shared
         * manager to revert a change to the *circuit* while the user was looking
         * at a definition body — a command with no visible effect and a real one.
         *
         * So the local zundo history drives a definition session, exactly as it
         * drives a solo editor, and the session's stack is left untouched to be
         * waiting when the detour ends. Solo is unaffected: with nothing
         * attached, `shared` is null and both branches resume zundo.
         */
        const resetDocumentHistory = (): void => {
          history().clear()
          if (shared === null || get().definitionEdit !== null) {
            history().resume()
          } else history().pause()
        }

        /**
         * The only path from a candidate circuit to the store. Validates
         * first, so a refusal is a true no-op: no set, no history step, no
         * re-render.
         *
         * The candidate is stored rather than the parsed result. They are
         * structurally identical — the contract has no coercions and every
         * candidate is built from an already-parsed circuit — and keeping
         * ours preserves the object identity of the operations the edit did
         * not touch, which is what lets the canvas skip re-rendering them.
         */
        const commit = (patch: {
          circuit: Circuit
          selection?: readonly string[]
          clipboard?: CircuitFragment | null
          nextId?: number
          ids?: readonly string[]
        }): EditResult => {
          const parsed = safeParseCircuit(patch.circuit)
          if (!parsed.ok) {
            return refused(parsed.issues[0]?.code ?? 'shape', parsed.issues)
          }

          const state = get()
          const pruned = pruneSelection(
            patch.selection ?? state.selection,
            patch.circuit
          )
          const changed = state.circuit !== patch.circuit
          set({
            circuit: patch.circuit,
            selection: sameSequence(state.selection, pruned)
              ? state.selection
              : pruned,
            clipboard:
              patch.clipboard === undefined ? state.clipboard : patch.clipboard,
            nextId: patch.nextId ?? state.nextId,
          })
          // The gesture's first *real* change has just been recorded, with
          // the pre-gesture document as its past state. Everything the rest
          // of the drag writes is an intermediate value nobody wants to undo
          // through, so tracking stops here and `endTransaction` restarts it.
          // The `changed` test matters: zundo's equality skips a set that
          // left the circuit alone, and pausing on one of those would swallow
          // the real change still to come.
          if (gesture !== null && !gesture.recorded && changed) {
            gesture.recorded = true
            history().pause()
          }
          return accepted(patch.ids)
        }

        const replaceOperation = (
          id: string,
          replace: (operation: Operation) => Operation
        ): { circuit: Circuit } | { reason: RejectionReason } => {
          const circuit = get().circuit
          const current = circuit.operations.find(
            (operation) => operation.id === id
          )
          if (current === undefined) return { reason: 'operation-not-found' }
          return {
            circuit: {
              ...circuit,
              operations: circuit.operations.map((operation) =>
                operation.id === id ? replace(current) : operation
              ),
            },
          }
        }

        return {
          circuit: initialCircuit,
          selection: [],
          clipboard: null,
          nextId: 1,
          documentId: 0,
          definitionEdit: null,

          placeGate: (gate, targets, column, options = {}) => {
            const state = get()
            const ids = idAllocator(state.circuit, state.nextId)
            const operation: Operation = {
              id: ids.take(),
              gate,
              targets: [...targets],
              column,
              ...pick('controls', copyOf(options.controls)),
              // A gate dropped from the palette carries no angles yet, and
              // every rotation is the identity at 0 — so the circuit means
              // exactly what it did before the drop until the user moves the
              // slider. Controls and classical targets get no such default:
              // there is no neutral choice of *which* qubit controls a CNOT.
              ...pick('params', copyOf(options.params ?? defaultParams(gate))),
              ...pick('clbitTargets', copyOf(options.clbitTargets)),
              ...pick('condition', options.condition),
            }

            return commit({
              circuit: {
                ...state.circuit,
                operations: [...state.circuit.operations, operation],
              },
              selection: [operation.id],
              nextId: ids.next,
              ids: [operation.id],
            })
          },

          moveOperation: (id, targets, column, options = {}) => {
            const current = get().circuit.operations.find(
              (operation) => operation.id === id
            )
            if (current === undefined) return refused('operation-not-found')

            // Controls follow the gate only when the caller says so: dragging
            // along the time axis moves them implicitly, dragging across
            // wires does not, and the store cannot tell which happened.
            const controls = options.controls ?? current.controls
            // The same argument holds for the classical write of a
            // measurement, and `moveTo` shifts it by the same distance it
            // shifts the wires. `condition.clbit` is deliberately not in
            // here: a move relocates one operation inside a circuit whose
            // measurements stay where they are, so silently repointing a
            // *read* at another bit is not what dragging a gate down a wire
            // asks for.
            const clbitTargets = options.clbitTargets ?? current.clbitTargets
            if (
              current.column === column &&
              sameSequence(current.targets, targets) &&
              sameControls(current.controls, controls) &&
              sameSequence(current.clbitTargets ?? [], clbitTargets ?? [])
            ) {
              // A drag that lands where it started is not an edit.
              return accepted([id])
            }

            const outcome = replaceOperation(id, (operation) =>
              withClbitTargets(
                withControls(
                  { ...operation, targets: [...targets], column },
                  controls
                ),
                clbitTargets
              )
            )
            if ('reason' in outcome) return refused(outcome.reason)
            return commit({ circuit: outcome.circuit, ids: [id] })
          },

          removeOperation: (id) => get().removeOperations([id]),

          removeOperations: (ids) => {
            const circuit = get().circuit
            const doomed = new Set(ids)
            const operations = circuit.operations.filter(
              (operation) => !doomed.has(operation.id)
            )
            if (operations.length === circuit.operations.length) {
              return refused('operation-not-found')
            }
            // Columns are deliberately left as they are; see compactColumns.
            return commit({ circuit: { ...circuit, operations } })
          },

          addControl: (operationId, qubit, state = 1) => {
            const outcome = replaceOperation(operationId, (operation) =>
              withControls(operation, [
                ...(operation.controls ?? []),
                // A bare number is the positive control, and it is what the
                // contract's own examples use. It also keeps exported JSON
                // short, which decides how much of a circuit fits in a URL
                // (D4). The object form is reserved for negative controls.
                state === 1 ? qubit : { qubit, state },
              ])
            )
            if ('reason' in outcome) return refused(outcome.reason)
            // Whether the gate accepts an extra control at all is the
            // catalog's ruling, and `commit` asks it.
            return commit({ circuit: outcome.circuit, ids: [operationId] })
          },

          removeControl: (operationId, qubit) => {
            const current = get().circuit.operations.find(
              (operation) => operation.id === operationId
            )
            if (current === undefined) return refused('operation-not-found')
            const kept = (current.controls ?? []).filter(
              (control) => normalizeControl(control).qubit !== qubit
            )
            if (kept.length === (current.controls ?? []).length) {
              return refused('control-not-found')
            }

            const outcome = replaceOperation(operationId, (operation) =>
              withControls(operation, kept)
            )
            if ('reason' in outcome) return refused(outcome.reason)
            return commit({ circuit: outcome.circuit, ids: [operationId] })
          },

          setParam: (operationId, index, value) => {
            const current = get().circuit.operations.find(
              (operation) => operation.id === operationId
            )
            if (current === undefined) return refused('operation-not-found')

            const params = current.params ?? []
            if (!Number.isInteger(index) || index < 0 || index >= params.length)
              return refused('param-count-mismatch')
            // Dragging a slider back to where it was must not cost an undo.
            if (params[index] === value) return accepted([operationId])

            const next = [...params]
            next[index] = value
            const outcome = replaceOperation(operationId, (operation) => ({
              ...operation,
              params: next,
            }))
            if ('reason' in outcome) return refused(outcome.reason)
            return commit({ circuit: outcome.circuit, ids: [operationId] })
          },

          addQubit: (at) => {
            const circuit = get().circuit
            const index = at ?? circuit.qubits
            if (circuit.qubits >= MAX_QUBITS) return refused('register-limit')
            if (
              !Number.isInteger(index) ||
              index < 0 ||
              index > circuit.qubits
            ) {
              return refused('qubit-out-of-range')
            }

            const operations = circuit.operations.map((operation) =>
              remapQubits(operation, (qubit) =>
                qubit >= index ? qubit + 1 : qubit
              )
            )
            const labels = circuit.qubitLabels
            return commit({
              circuit: {
                ...circuit,
                qubits: circuit.qubits + 1,
                // A new wire brings a classical bit with it while the two
                // registers are the same width — the `QuantumCircuit(n, n)`
                // shape `DEFAULT_CLBITS` sets up and `draftOf` depends on.
                // Otherwise the wire would be unmeasurable for good.
                //
                // Conditional rather than `Math.max`, because a register
                // that is deliberately out of step is a decision: a document
                // loaded with a wider classical register keeps it, and a user
                // who shrank theirs with the gutter control is not overruled
                // by adding a wire. The gutter control is the remedy on that
                // path, and the refusal now names it.
                //
                // Inside the one `commit` on purpose: undo has to restore
                // both counts in a single step.
                ...(circuit.clbits === circuit.qubits
                  ? { clbits: circuit.clbits + 1 }
                  : {}),
                operations,
                // The new wire is named after the count, not after its
                // position: `defaultQubitLabel(index)` would collide with the
                // wire it just pushed aside, and two wires called `q1` is
                // worse than one called `q3` in the middle. `freeQubitLabel`
                // closes the other half of the same hazard — a user who has
                // already renamed some wire to `q3` — because `qubitLabels`
                // is the only handle on a wire once it has a name, and the
                // row headers, the exporter and the histogram all key on it.
                ...pick(
                  'qubitLabels',
                  labels &&
                    insertAt(
                      labels,
                      index,
                      freeQubitLabel(labels, circuit.qubits)
                    )
                ),
              },
            })
          },

          /**
           * Deleting a wire deletes what stood on it. Any operation that used
           * the qubit — as target or as control — goes with it, and the
           * qubits above it shift down one.
           *
           * The alternative, refusing to remove a wire that is not empty,
           * turns a one-click intent into a manual cleanup; and because the
           * whole cascade is a single history step, undo brings all of it
           * back at once. The rule is uniform on purpose: even a `barrier`
           * that merely spans the wire is removed rather than shortened,
           * because "shrink some operations, delete others" is a distinction
           * nobody can predict from looking at the canvas.
           *
           * The classical register is left alone, even though `addQubit`
           * grows it. Shrinking it here would cascade a second time and take
           * measurements belonging to *other* wires with it — deleting q3
           * must never delete the measurement on q1. Growth is one-way;
           * narrowing the classical register stays the explicit act
           * `removeClbit` and its gutter control provide.
           *
           * The classical *writes* stay put for the same reason, so a
           * measurement that rides down onto q0 keeps writing the bit it
           * always wrote. That leaves the editor's clbit-equals-qubit
           * diagonal broken, which is legal and is why `draftOf` chooses a
           * free bit rather than assuming one; see `classicalWrites.ts`.
           */
          removeQubit: (index) => {
            const circuit = get().circuit
            if (circuit.qubits <= 1) return refused('register-limit')
            if (
              !Number.isInteger(index) ||
              index < 0 ||
              index >= circuit.qubits
            )
              return refused('qubit-out-of-range')

            const operations = circuit.operations
              .filter((operation) => !qubitsOf(operation).includes(index))
              .map((operation) =>
                remapQubits(operation, (qubit) =>
                  qubit > index ? qubit - 1 : qubit
                )
              )
            const labels = circuit.qubitLabels
            return commit({
              circuit: {
                ...circuit,
                qubits: circuit.qubits - 1,
                operations,
                ...pick('qubitLabels', labels && removeAt(labels, index)),
              },
            })
          },

          /**
           * `order[newIndex] = oldIndex`, i.e. the old wires listed in their
           * new order — exactly what dnd-kit's `arrayMove` produces when
           * applied to `[0, 1, … n-1]`.
           */
          reorderQubits: (order) => {
            const circuit = get().circuit
            if (order.length !== circuit.qubits)
              return refused('qubit-out-of-range')

            const seen = new Set<number>()
            for (const old of order) {
              if (!Number.isInteger(old) || old < 0 || old >= circuit.qubits)
                return refused('qubit-out-of-range')
              if (seen.has(old)) return refused('repeated-qubit')
              seen.add(old)
            }
            if (order.every((old, position) => old === position))
              return accepted()

            const positionOf = new Map(
              order.map((old, position) => [old, position])
            )
            const operations = circuit.operations.map((operation) =>
              remapQubits(operation, (qubit) => positionOf.get(qubit) ?? qubit)
            )
            const labels = circuit.qubitLabels
            return commit({
              circuit: {
                ...circuit,
                operations,
                ...pick(
                  'qubitLabels',
                  labels &&
                    order.map((old) => labels[old] ?? defaultQubitLabel(old))
                ),
              },
            })
          },

          setQubitLabel: (index, label) => {
            const circuit = get().circuit
            if (
              !Number.isInteger(index) ||
              index < 0 ||
              index >= circuit.qubits
            )
              return refused('qubit-out-of-range')

            // The contract wants one label per qubit or none at all, so
            // naming a single wire materialises the whole list.
            const labels =
              circuit.qubitLabels ??
              Array.from({ length: circuit.qubits }, (_, position) =>
                defaultQubitLabel(position)
              )
            if (labels[index] === label) return accepted()

            const next = [...labels]
            next[index] = label
            return commit({ circuit: { ...circuit, qubitLabels: next } })
          },

          addClbit: () => {
            const circuit = get().circuit
            if (circuit.clbits >= MAX_CLBITS) return refused('register-limit')
            return commit({
              circuit: { ...circuit, clbits: circuit.clbits + 1 },
            })
          },

          /** Cascades like `removeQubit`, and for the same reason. */
          removeClbit: (index) => {
            const circuit = get().circuit
            if (circuit.clbits <= 0) return refused('register-limit')
            if (
              !Number.isInteger(index) ||
              index < 0 ||
              index >= circuit.clbits
            )
              return refused('clbit-out-of-range')

            const operations = circuit.operations
              .filter(
                (operation) =>
                  !(operation.clbitTargets ?? []).includes(index) &&
                  operation.condition?.clbit !== index
              )
              .map((operation) =>
                remapClbits(operation, (clbit) =>
                  clbit > index ? clbit - 1 : clbit
                )
              )
            return commit({
              circuit: { ...circuit, clbits: circuit.clbits - 1, operations },
            })
          },

          copy: () => {
            const state = get()
            const selected = selectedOperations(state.circuit, state.selection)
            if (selected.length === 0) return refused('empty-selection')

            const qubits = selected.flatMap(qubitsOf)
            const columns = selected.map((operation) => operation.column)
            const originQubit = Math.min(...qubits)
            const originColumn = Math.min(...columns)

            const fragment: CircuitFragment = {
              operations: selected.map((operation) => ({
                ...remapQubits(operation, (qubit) => qubit - originQubit),
                column: operation.column - originColumn,
              })),
              qubits: Math.max(...qubits) - originQubit + 1,
              columns: Math.max(...columns) - originColumn + 1,
              originQubit,
            }

            // The circuit is untouched, so this is not a history step — but
            // it still goes through `set` so a paste button can react to it.
            set({ clipboard: fragment })
            return accepted(selected.map((operation) => operation.id))
          },

          /**
           * Pastes with `(qubit, column)` as the fragment's top-left cell.
           * All or nothing: if any operation would land out of range or on an
           * occupied cell, the whole paste is refused, because a partially
           * pasted fragment is not the thing the user copied.
           *
           * The fragment's classical references travel the same distance its
           * wires do (see `CircuitFragment`), so pasting `measure q0 -> c0`
           * one wire down yields `measure q1 -> c1`, and pasting onto the
           * same wire is an exact copy. A shifted bit that leaves the
           * register needs no refusal of its own: the contract answers
           * `clbit-out-of-range`, and `commit` runs before `set`, so the
           * paste is a true no-op — refused exactly where a fresh placement
           * on that wire would have been.
           *
           * A bit that lands *inside* the register but on top of another
           * measurement's write does need one, and it is the only judgement
           * this file makes that the contract does not (see rule 1 of the
           * header). A fragment cut from a document whose diagonal had been
           * broken by a register edit carries an absolute distance between
           * its wire and its bit, and translating it faithfully — which is
           * what a paste is — can land that write in a column that already
           * has one. Unlike a fresh placement there is no free bit to fall
           * back on: `draftOf` may choose any bit for a *new* measurement,
           * while a fragment's internal wiring (a conditioned gate reading
           * the bit its own measurement writes) is only preserved by moving
           * every reference the same distance.
           */
          paste: (qubit, column) => {
            const state = get()
            const fragment = state.clipboard
            if (fragment === null || fragment.operations.length === 0)
              return refused('empty-clipboard')

            const ids = idAllocator(state.circuit, state.nextId)
            const shift = qubit - fragment.originQubit
            const pasted = fragment.operations.map((operation) => ({
              ...remapClbits(
                remapQubits(operation, (position) => position + qubit),
                (clbit) => clbit + shift
              ),
              // Fresh ids, always: a pasted fragment is new operations, and
              // reusing an id would collide with the fragment's source.
              id: ids.take(),
              column: operation.column + column,
            }))

            if (writesCollide(state.circuit.operations, pasted)) {
              return refused('clbit-in-use')
            }

            return commit({
              circuit: {
                ...state.circuit,
                operations: [...state.circuit.operations, ...pasted],
              },
              selection: pasted.map((operation) => operation.id),
              nextId: ids.next,
              ids: pasted.map((operation) => operation.id),
            })
          },

          /**
           * Closes the gaps left by deletions. Deliberately a command of its
           * own rather than something `removeOperation` does: gates sliding
           * out from under the cursor after every delete is the kind of
           * surprise that makes an editor feel unsafe, and `depth()` already
           * ignores empty columns, so a gap costs nothing but pixels.
           */
          compactColumns: () => {
            const circuit = get().circuit
            const compacted = normalizeColumns(circuit)
            const unchanged = compacted.operations.every(
              (operation, index) =>
                operation.column === circuit.operations[index]?.column
            )
            if (unchanged) return accepted()
            return commit({ circuit: compacted })
          },

          /* ── Custom gates (M2.3) ─────────────────────────────────── */

          packageSelection: (name, options = {}) => {
            const state = get()
            /*
             * Not while a definition is open. `documentAsDefinition` carries a
             * document's operations back into the host and nothing else, so a
             * block packaged inside a definition would be dropped on the way
             * out — and if its name is one the *host* already owns, the body's
             * call rebinds to the host's unrelated definition. The edit is
             * accepted, the document validates, and the block now means
             * something else. The panel already hides the packaging form while
             * editing; this is the store's own half of that rule.
             */
            if (state.definitionEdit !== null) return refused('definition-open')
            const ids = idAllocator(state.circuit, state.nextId)
            const result = packageFragment(
              state.circuit,
              state.selection,
              name,
              { ...pick('symbol', options.symbol), instanceId: ids.take() }
            )
            if (!result.ok) return refused(result.reason)

            const circuit = withFragmentPackaged(
              state.circuit,
              state.selection,
              name,
              result.packaged
            )
            return commit({
              circuit,
              selection: [result.packaged.instance.id],
              nextId: ids.next,
              ids: [result.packaged.instance.id],
            })
          },

          placeCustomGate: (name, qubit = 0) => {
            const circuit = get().circuit
            const definition = definitionIn(circuit, name)
            if (definition === undefined) {
              return refused('custom-gate-not-found')
            }
            const top = Math.min(
              Math.max(0, qubit),
              Math.max(0, circuit.qubits - definition.qubits)
            )
            const targets = Array.from(
              { length: definition.qubits },
              (_, index) => top + index
            )
            const column = firstFreeColumn(circuit, top, definition.qubits)
            return get().placeGate(name, targets, column, {
              params: defaultArguments(definition),
            })
          },

          inlineOperation: (id) => {
            const state = get()
            const ids = idAllocator(state.circuit, state.nextId)
            const circuit = inlineOperation(state.circuit, id, () => ids.take())
            if (circuit === null) {
              const exists = state.circuit.operations.some(
                (operation) => operation.id === id
              )
              return refused(
                exists ? 'not-a-custom-gate' : 'operation-not-found'
              )
            }
            // The definition stays declared. Peeling one use apart is not a
            // statement about the other uses, and a definition nothing calls
            // is still a definition the user may want to place again.
            return commit({ circuit, selection: [], nextId: ids.next })
          },

          duplicateCustomGate: (name, into) => {
            const circuit = get().circuit
            const definition = definitionIn(circuit, name)
            if (definition === undefined) {
              return refused('custom-gate-not-found')
            }
            return get().installCustomGate(into, definition)
          },

          installCustomGate: (name, definition) => {
            const circuit = get().circuit
            const issue = customGateNameIssue(circuit, name)
            if (issue !== null) return refused(issue)
            return commit({
              circuit: {
                ...circuit,
                customGates: { ...circuit.customGates, [name]: definition },
              },
            })
          },

          removeCustomGate: (name) => {
            const circuit = get().circuit
            if (definitionIn(circuit, name) === undefined) {
              return refused('custom-gate-not-found')
            }
            // A definition something still calls cannot simply disappear —
            // the same rule the library applies to a published gate, applied
            // here to the document's own copy. Inline the uses first.
            if (customGateUsage(circuit, name).total > 0) {
              return refused('custom-gate-in-use')
            }
            const customGates = { ...circuit.customGates }
            delete customGates[name]
            return commit({
              circuit:
                Object.keys(customGates).length === 0
                  ? withoutCustomGates(circuit)
                  : { ...circuit, customGates },
            })
          },

          openDefinition: (name) => {
            const state = get()
            if (state.definitionEdit !== null) return refused('definition-open')
            const definition = definitionIn(state.circuit, name)
            if (definition === undefined) {
              return refused('custom-gate-not-found')
            }

            abandonGesture()
            const document = definitionAsDocument(
              definition,
              parameterValues(state.circuit)
            )
            set((current) => ({
              circuit: document,
              selection: [],
              nextId: firstFreeId(document),
              documentId: current.documentId + 1,
              definitionEdit: {
                name,
                symbol: definition.symbol,
                host: current.circuit,
                hostSelection: current.selection,
                hostNextId: current.nextId,
                uses: customGateUsage(current.circuit, name).total,
              },
            }))
            resetDocumentHistory()
            return accepted()
          },

          setDefinitionSymbol: (symbol) => {
            const open = get().definitionEdit
            if (open === null) return refused('no-definition-open')
            set({
              definitionEdit: {
                ...open,
                symbol: isUsableSymbol(symbol) ? symbol : undefined,
              },
            })
            return accepted()
          },

          applyDefinition: () => {
            const state = get()
            const open = state.definitionEdit
            if (open === null) return refused('no-definition-open')

            const before = definitionIn(open.host, open.name)
            const after = documentAsDefinition(state.circuit, open.symbol)
            if (
              before !== undefined &&
              open.uses > 0 &&
              reshapesUses(before, after) !== null
            ) {
              // Refused rather than repaired: there is no honest guess about
              // which wire a new one should be, and a use silently rewired is
              // a different circuit wearing the same name.
              return refused('custom-gate-reshaped')
            }

            const host: Circuit = {
              ...open.host,
              customGates: { ...open.host.customGates, [open.name]: after },
            }
            const parsed = safeParseCircuit(host)
            if (!parsed.ok) {
              return refused(parsed.issues[0]?.code ?? 'shape', parsed.issues)
            }

            abandonGesture()
            set((current) => ({
              circuit: host,
              selection: open.hostSelection,
              nextId: Math.max(open.hostNextId, firstFreeId(host)),
              documentId: current.documentId + 1,
              definitionEdit: null,
            }))
            resetDocumentHistory()
            return accepted()
          },

          cancelDefinition: () => {
            const open = get().definitionEdit
            if (open === null) return refused('no-definition-open')
            abandonGesture()
            set((current) => ({
              circuit: open.host,
              selection: open.hostSelection,
              nextId: Math.max(open.hostNextId, firstFreeId(open.host)),
              documentId: current.documentId + 1,
              definitionEdit: null,
            }))
            resetDocumentHistory()
            return accepted()
          },

          setSelection: (ids) => {
            const state = get()
            const selection = pruneSelection(ids, state.circuit)
            if (sameSequence(state.selection, selection)) return
            set({ selection })
          },

          toggleSelection: (id) => {
            const state = get()
            const next = state.selection.includes(id)
              ? state.selection.filter((other) => other !== id)
              : [...state.selection, id]
            state.setSelection(next)
          },

          clearSelection: () => {
            if (get().selection.length === 0) return
            set({ selection: [] })
          },

          /**
           * Opens a document. Untrusted input — a paste, a URL payload, an
           * import — enters here and nowhere else.
           *
           * History is cleared rather than extended: undo is for editing
           * moves, and being able to undo past the beginning of the document
           * you just opened is how you lose the document you just opened.
           * The clipboard survives, so a fragment can be carried between
           * circuits; `paste` validates it against the new register anyway.
           */
          loadCircuit: (input) => {
            const parsed = safeParseCircuit(input)
            if (!parsed.ok) {
              return refused(parsed.issues[0]?.code ?? 'shape', parsed.issues)
            }
            // A document arriving mid-gesture makes the gesture meaningless:
            // the circuit it was editing is gone, and the stacks it snapshot
            // are about to be cleared.
            abandonGesture()
            set((state) => ({
              circuit: parsed.circuit,
              selection: [],
              // Past every `op_N` the opened document holds, so that deleting a
              // gate and dropping another cannot hand the new one the dead
              // one's id — which is what a comment anchored to it would then
              // silently be about. See `firstFreeId`.
              nextId: firstFreeId(parsed.circuit),
              documentId: state.documentId + 1,
              // A definition edit is a detour inside one document; the
              // document it would return to has just been replaced, so there
              // is nowhere to come back to and the detour ends here.
              definitionEdit: null,
            }))
            resetHistory()
            return accepted()
          },

          /*
           * The counter rises to whatever the document now needs and never
           * falls: a peer's operations arrive with ids this store did not mint,
           * and an id a peer used and deleted must not be handed out here.
           */
          adoptDocument: (circuit) =>
            commit({
              circuit,
              nextId: Math.max(get().nextId, firstFreeId(circuit)),
            }),

          attachHistory: (next) => {
            // A half-made local gesture cannot survive the change of history:
            // the stacks it snapshot are about to be cleared, and the driver it
            // would be closed against is a different one.
            abandonGesture()
            shared = next
            history().clear()
            if (next === null || get().definitionEdit !== null) {
              history().resume()
            } else history().pause()
          },

          /** Back to the document this store was created with. */
          reset: () => {
            abandonGesture()
            set((state) => ({
              circuit: initialCircuit,
              selection: [],
              nextId: firstFreeId(initialCircuit),
              documentId: state.documentId + 1,
              definitionEdit: null,
            }))
            resetHistory()
          },

          beginTransaction: () => {
            // A shared session groups a gesture in the undo manager instead,
            // and returns before any of the zundo bookkeeping below — which is
            // what keeps `gesture` null, and therefore keeps `commit` from
            // resuming a history that is deliberately paused. A definition
            // session is not the shared document, so it takes the zundo path
            // below; see `resetDocumentHistory`.
            const session = driver()
            if (session !== null) {
              session.beginGesture()
              return
            }
            if (gesture !== null) return
            const stacks = history()
            gesture = {
              circuit: get().circuit,
              // Copies, not the live arrays: zundo mutates `pastStates` in
              // place when the limit forces the oldest step out.
              pastStates: [...stacks.pastStates],
              futureStates: [...stacks.futureStates],
              recorded: false,
            }
          },

          endTransaction: () => {
            const session = driver()
            if (session !== null) {
              session.endGesture()
              return
            }
            const open = gesture
            gesture = null
            // Nothing was ever written, so there is nothing to close and
            // tracking was never paused.
            if (open === null || !open.recorded) return

            if (sameCircuit(open.circuit, get().circuit)) {
              // The gesture ended where it began. Restoring the original
              // object — while tracking is still paused, so this costs no
              // step either — undoes the identity change nobody asked for,
              // and putting both stacks back removes the step the first
              // change recorded and the redo branch it cleared.
              set({ circuit: open.circuit })
              historyOf(api).setState({
                pastStates: open.pastStates,
                futureStates: open.futureStates,
              })
            }
            history().resume()
          },

          undo: (steps = 1) => {
            const count = usableSteps(steps)
            // In a shared session this is the driver's answer, and it means
            // something narrower than it used to: "there was nothing left of
            // *yours* to undo". A stack that still holds somebody else's
            // changes reports the same refusal, which is the point.
            const session = driver()
            if (session !== null) {
              if (count === null || !session.undo(count)) {
                return refused('nothing-to-undo')
              }
              return accepted()
            }
            // The early return has to precede the delegation, not follow
            // it: zundo pushes the current state onto `futureStates` before
            // it discovers the slice is empty, so even a "harmless" call
            // with 0 would leave a phantom redo step behind.
            //
            // An unusable count reports the same refusal as an empty stack,
            // because it produces the same thing the user sees: no step was
            // consumed and the document did not move.
            if (count === null || history().pastStates.length === 0) {
              return refused('nothing-to-undo')
            }
            history().undo(count)
            return accepted()
          },
          redo: (steps = 1) => {
            const count = usableSteps(steps)
            const session = driver()
            if (session !== null) {
              if (count === null || !session.redo(count)) {
                return refused('nothing-to-redo')
              }
              return accepted()
            }
            if (count === null || history().futureStates.length === 0) {
              return refused('nothing-to-redo')
            }
            history().redo(count)
            return accepted()
          },
          clearHistory: () => {
            abandonGesture()
            resetHistory()
          },
        }
      },
      {
        limit: HISTORY_LIMIT,
        partialize: (state): CircuitSnapshot => ({
          circuit: state.circuit,
          selection: state.selection,
        }),
        equality: (past, current) => past.circuit === current.circuit,
      }
    )
  )
}

/** The editor's store. Tests and previews build their own instead. */
export const useCircuitStore = createCircuitStore()

export type CircuitStore = ReturnType<typeof createCircuitStore>

/* ------------------------------------------------------------------ *
 * Selectors — derived state, computed on read so it cannot drift.
 * ------------------------------------------------------------------ */

/**
 * The operation occupying a cell, if any. This is what "is this cell free?"
 * means, and what the canvas hit-tests against; a stored occupancy map would
 * be the same information twice.
 */
export function operationAt(
  circuit: Circuit,
  qubit: number,
  column: number
): Operation | undefined {
  return circuit.operations.find(
    (operation) =>
      operation.column === column && qubitsOf(operation).includes(qubit)
  )
}

/**
 * The selected operations, in circuit order. Not a zustand selector: it
 * builds a new array on every call, so subscribe to it with `useShallow`.
 */
export function selectedOperations(
  circuit: Circuit,
  selection: readonly string[]
): Operation[] {
  const wanted = new Set(selection)
  return circuit.operations.filter((operation) => wanted.has(operation.id))
}

/**
 * A definition by name, without asking `Object.prototype` for one.
 *
 * `customGates` is an ordinary object, so a bare read answers `toString` with
 * an inherited function — the same trap `gateResolver` documents in the
 * contract's validator, and it would reach here as a definition with no
 * `qubits` and no `operations`.
 */
function definitionIn(circuit: Circuit, name: string): CustomGate | undefined {
  const definitions = circuit.customGates
  if (definitions === undefined || !Object.hasOwn(definitions, name)) {
    return undefined
  }
  return definitions[name]
}

/** The circuit with the (now empty) `customGates` key gone entirely. */
function withoutCustomGates(circuit: Circuit): Circuit {
  const next: Circuit = { ...circuit }
  delete next.customGates
  return next
}

/** Placeholder wire name, used when a user names one wire and not the rest. */
export function defaultQubitLabel(index: number): string {
  return `q${index}`
}

/**
 * The first `qN` no wire already answers to.
 *
 * Counting up from the register size is nearly always one step, because that
 * name belongs to no existing index — but "nearly always" is not a guarantee
 * once wires can be renamed, and a register holding two wires called `q3` is
 * ambiguous everywhere a wire is named by its label. The loop terminates:
 * there are finitely many labels, so some candidate is free.
 */
function freeQubitLabel(labels: readonly string[], count: number): string {
  const taken = new Set(labels)
  let candidate = count
  while (taken.has(defaultQubitLabel(candidate))) candidate += 1
  return defaultQubitLabel(candidate)
}

/* ------------------------------------------------------------------ *
 * Internals
 * ------------------------------------------------------------------ */

/**
 * How many history steps to hand zundo, or `null` for "do nothing".
 *
 * This is the one argument in the store's API the contract never gets to
 * judge: `undo`/`redo` reach `set()` through zundo instead of through
 * `commit()`, so rule 2 of this file's header — a refused edit changes
 * nothing — has to be enforced here by hand.
 *
 * zundo splices `(-steps, steps)` off its stack, which is an *empty* slice
 * for any count below 1; the `shift()` that follows then hands `undefined`
 * to zustand 5, which replaces rather than merges a non-object value. The
 * store is left with no circuit, no clipboard and no actions, and nothing
 * short of rebuilding it recovers. A count of 0 almost always means
 * "nothing to do", so this is a silent no-op rather than a throw —
 * indistinguishable, from the caller's side, from pressing undo on an empty
 * history.
 *
 * Truncating toward zero is what `splice` already does internally, so
 * `undo(1.5)` keeps meaning `undo(1)` and well-formed input is unaffected.
 * Counts above the history depth, `Infinity` included, need no clamp:
 * zundo splices the whole stack and rewinds to the oldest snapshot, which
 * is exactly what asking for more steps than exist should do.
 */
function usableSteps(steps: number): number | null {
  const whole = Math.trunc(steps)
  // `NaN < 1` is false, so NaN needs naming rather than comparing.
  return Number.isNaN(whole) || whole < 1 ? null : whole
}

/**
 * Whether two circuits say the same thing.
 *
 * Identity is the store's usual test for "did anything change", and it is
 * the right one everywhere except at the end of a gesture: a slider dragged
 * out and back has produced a dozen new objects and left the document
 * exactly as it found it, and charging an undo step for that is the very
 * thing `endTransaction` exists to prevent.
 *
 * Structural, not `JSON.stringify`: two circuits built by different code
 * paths can carry their optional fields in a different key order and mean
 * the same thing. The identity fast path makes it cheap — an edit rebuilds
 * only the operation it touched, so every other one is compared by
 * reference.
 *
 * Exported because M1.4a asks the same question from outside: "does the
 * editor still hold the version it was saved from?" — a circuit that arrived
 * over the wire and one built by editing are never the same object, so
 * identity cannot answer it and a second implementation would be one more
 * place for "unchanged" to mean something slightly different.
 */
export function sameCircuit(left: Circuit, right: Circuit): boolean {
  return sameJson(left, right)
}

function sameJson(left: unknown, right: unknown): boolean {
  if (left === right) return true
  if (Array.isArray(left) || Array.isArray(right)) {
    return (
      Array.isArray(left) &&
      Array.isArray(right) &&
      left.length === right.length &&
      left.every((value, index) => sameJson(value, right[index]))
    )
  }
  if (
    typeof left !== 'object' ||
    typeof right !== 'object' ||
    left === null ||
    right === null
  ) {
    // Primitives that failed `===`, including two NaNs — which no contract
    // value can be, and which erring toward "different" only ever costs an
    // extra history step rather than losing one.
    return false
  }

  const leftKeys = Object.keys(left)
  const rightKeys = Object.keys(right)
  if (leftKeys.length !== rightKeys.length) return false
  const other = right as Record<string, unknown>
  return leftKeys.every(
    (key) =>
      key in other &&
      sameJson((left as Record<string, unknown>)[key], other[key])
  )
}

/** Drops ids that no longer exist and puts the rest in circuit order. */
function pruneSelection(
  ids: readonly string[],
  circuit: Circuit
): readonly string[] {
  const wanted = new Set(ids)
  return circuit.operations
    .filter((operation) => wanted.has(operation.id))
    .map((operation) => operation.id)
}

/**
 * Builds `{ key: value }` for a value that may be absent, so an optional
 * field is omitted entirely instead of being present and `undefined`. The
 * contract's objects are strict, and `{ controls: undefined }` is noise that
 * survives into exported JSON.
 */
function pick<K extends string, V>(
  key: K,
  value: V | undefined | null
): Partial<Record<K, V>> {
  if (value === undefined || value === null) return {}
  if (Array.isArray(value) && value.length === 0) return {}
  return { [key]: value } as Record<K, V>
}

/** A mutable copy, because the contract's arrays are not readonly. */
function copyOf<T>(values: readonly T[] | undefined): T[] | undefined {
  return values === undefined ? undefined : [...values]
}

/** Zero angles for a catalog gate that takes parameters, nothing otherwise. */
function defaultParams(gate: string): ParamValue[] | undefined {
  const meta = lookupGate(gate)
  if (meta === undefined || meta.paramCount === 0) return undefined
  return Array.from({ length: meta.paramCount }, () => 0)
}

/** An operation with its control list replaced, dropping it when empty. */
function withControls(
  operation: Operation,
  controls: readonly Control[] | undefined
): Operation {
  const next: Operation = { ...operation }
  if (controls === undefined || controls.length === 0) delete next.controls
  else next.controls = [...controls]
  return next
}

/** The classical counterpart of `withControls`, and dropped when empty. */
function withClbitTargets(
  operation: Operation,
  clbitTargets: readonly number[] | undefined
): Operation {
  const next: Operation = { ...operation }
  if (clbitTargets === undefined || clbitTargets.length === 0)
    delete next.clbitTargets
  else next.clbitTargets = [...clbitTargets]
  return next
}

/** Rewrites every qubit an operation touches, preserving control spelling. */
function remapQubits(
  operation: Operation,
  map: (qubit: number) => number
): Operation {
  const next: Operation = {
    ...operation,
    targets: operation.targets.map(map),
  }
  if (operation.controls !== undefined) {
    next.controls = operation.controls.map((control) =>
      typeof control === 'number'
        ? map(control)
        : { ...control, qubit: map(control.qubit) }
    )
  }
  return next
}

/** The classical counterpart of `remapQubits`. */
function remapClbits(
  operation: Operation,
  map: (clbit: number) => number
): Operation {
  const next: Operation = { ...operation }
  if (operation.clbitTargets !== undefined) {
    next.clbitTargets = operation.clbitTargets.map(map)
  }
  if (operation.condition !== undefined) {
    next.condition = {
      ...operation.condition,
      clbit: map(operation.condition.clbit),
    }
  }
  return next
}

function insertAt<T>(values: readonly T[], index: number, value: T): T[] {
  return [...values.slice(0, index), value, ...values.slice(index)]
}

function removeAt<T>(values: readonly T[], index: number): T[] {
  return values.filter((_, position) => position !== index)
}

function sameSequence<T>(left: readonly T[], right: readonly T[]): boolean {
  return (
    left.length === right.length &&
    left.every((value, index) => value === right[index])
  )
}

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

/**
 * The counter a document has to start from, so that no id is ever recycled.
 *
 * ── Why "unique in the circuit" was not enough ─────────────────────────────
 *
 * `idAllocator` skips ids the circuit *currently* holds, which makes every id
 * unique at any one moment and says nothing about an id the circuit used to
 * hold. Inside one uninterrupted editing run that was fine, because `nextId`
 * only ever counts up. Opening a document reset it to 1 — and then the first
 * placement after a delete was handed the numerically lowest free id, which is
 * precisely the id of whatever had just been deleted.
 *
 * M5.4 made that a lie a reader can see. `Comment.anchorOpId` is an
 * `operations[].id` in a database row, so a comment about a deleted X
 * re-attached itself to the next unrelated gate the user dropped: the panel
 * printed "About Z on q2, column 7" over a sentence written about something
 * else, and nothing anywhere warned. §3.4's rule is that an anchor may fail to
 * resolve — the orphan branch exists for exactly that — but may never resolve to
 * a different gate.
 *
 * So a document's counter starts *past* every `op_N` the document has ever
 * shown, which is one past the highest one it holds when it is opened. An id
 * that has been deleted is never handed out again, because nothing below the
 * counter is, and the counter never moves back: it is deliberately outside
 * `partialize`, so undo does not rewind it either.
 *
 * Ids that do not follow this naming (a hand-written circuit, an import) are
 * left to the allocator's `taken` set, which is what makes them safe too.
 */
export function firstFreeId(circuit: Circuit): number {
  let highest = 0
  for (const operation of circuit.operations) {
    if (!operation.id.startsWith(ID_PREFIX)) continue
    const counted = Number(operation.id.slice(ID_PREFIX.length))
    if (Number.isSafeInteger(counted) && counted > highest) highest = counted
  }
  return highest + 1
}

/**
 * Mints ids that are unique within the circuit. It skips ids already in use
 * rather than trusting the counter, because a loaded document brings its own
 * ids and they need not follow this naming at all.
 */
function idAllocator(circuit: Circuit, from: number) {
  const taken = new Set(circuit.operations.map((operation) => operation.id))
  let counter = from
  return {
    take(): string {
      let id = `${ID_PREFIX}${counter}`
      while (taken.has(id)) {
        counter += 1
        id = `${ID_PREFIX}${counter}`
      }
      taken.add(id)
      counter += 1
      return id
    },
    get next(): number {
      return counter
    },
  }
}
