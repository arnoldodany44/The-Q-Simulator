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
  emptyCircuit,
  lookupGate,
  normalizeColumns,
  normalizeControl,
  qubitsOf,
  safeParseCircuit,
  type Circuit,
  type Condition,
  type Control,
  type Operation,
  type ParamValue,
  type ValidationIssue,
} from '@qsim/schema'
import { temporal, type TemporalState } from 'zundo'
import { create, type StoreApi } from 'zustand'

import { writesCollide } from './classicalWrites'

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

/** The slice of the store that undo and redo travel through. */
interface CircuitSnapshot {
  readonly circuit: Circuit
  readonly selection: readonly string[]
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

  setSelection(ids: readonly string[]): void
  toggleSelection(id: string): void
  clearSelection(): void

  loadCircuit(input: unknown): EditResult
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
            set({ circuit: parsed.circuit, selection: [], nextId: 1 })
            history().clear()
            return accepted()
          },

          /** Back to the document this store was created with. */
          reset: () => {
            abandonGesture()
            set({ circuit: initialCircuit, selection: [], nextId: 1 })
            history().clear()
          },

          beginTransaction: () => {
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
            const open = gesture
            gesture = null
            // Nothing was ever written, so there is nothing to close and
            // tracking was never paused.
            if (open === null || !open.recorded) return

            if (sameDocument(open.circuit, get().circuit)) {
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
            if (count === null || history().futureStates.length === 0) {
              return refused('nothing-to-redo')
            }
            history().redo(count)
            return accepted()
          },
          clearHistory: () => {
            abandonGesture()
            history().clear()
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
 */
function sameDocument(left: Circuit, right: Circuit): boolean {
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
