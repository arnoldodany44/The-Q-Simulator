/**
 * The editor: palette, canvas, parameters, and the one line of text that
 * says what just happened.
 *
 * This component owns the wiring and nothing else. The rules live in
 * `placement.ts`, the interaction model in `useKeyboardGrid.ts`, and the
 * document in the store — so what is left here is dnd-kit's context, the
 * sensors, and the translation of a refusal code into a sentence.
 *
 * ## Two sensors, on purpose
 *
 * `PointerSensor` carries the mouse and the finger, with a 4px activation
 * distance so a click that selects is not read as a drag that moves.
 * `KeyboardSensor` carries everything else, and it is not decoration: §10
 * requires the editor to be operable with no pointer at all. Its coordinate
 * getter is overridden because the default one moves the drag by 25px,
 * which lands between cells on a grid whose cells are 56 by 48 — a drag
 * that needs three presses to cross one column is a drag nobody finishes.
 *
 * Space starts a keyboard drag; Enter is left alone so it can stay the
 * editor's own "place it here". That split is what lets the two keyboard
 * paths — pick-up-and-move, and arm-then-place — coexist on the same
 * elements without either one swallowing the other.
 *
 * ## The simulation is mounted here
 *
 * `SimulationPanel` is what makes M0.6 reachable at all: it is the component
 * that calls `useSimulation`, so the worker spawns when the editor mounts and
 * every edit reaches the engine. It sits under the editor rather than beside
 * it because a circuit and its answer are one thing, and because M0.7 grows
 * the analysis panel out of that same slot.
 *
 * ## Why the shared store is a default and not a hard-coded import
 *
 * The editor takes its store as a prop. Tests build an isolated one, and a
 * future preview or diff view will want two editors on one page; a module
 * singleton reached for directly would make both impossible.
 */

import {
  DndContext,
  DragOverlay,
  KeyboardSensor,
  PointerSensor,
  useSensor,
  useSensors,
  type Announcements,
  type DragEndEvent,
  type DragStartEvent,
  type KeyboardCoordinateGetter,
  type ScreenReaderInstructions,
} from '@dnd-kit/core'
import { isGateId, type Circuit } from '@qsim/schema'
import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useStore } from 'zustand'

import { Notation } from '../../components/Notation'
import { SimulationPanel } from '../simulation/SimulationPanel'
import { CircuitCanvas } from './CircuitCanvas'
import { GatePalette } from './GatePalette'
import { ParameterEditor } from './ParameterEditor'
import { ShortcutsPanel } from './ShortcutsPanel'
import {
  DEFAULT_METRICS,
  MIN_COLUMNS,
  columnCount,
  type Cell,
} from './geometry'
import {
  formatWireList,
  gateSymbol,
  qubitLabel,
  targetShape,
} from './operationRoles'
import {
  isPlacementIssue,
  nextSlot,
  pendingQubits,
  type DragPayload,
} from './placement'
import { useCompactViewport } from './useCompactViewport'
import {
  selectedOperations,
  useCircuitStore,
  type CircuitStore,
} from './useCircuitStore'
import {
  useKeyboardGrid,
  type EditReport,
  type GridAnnouncement,
} from './useKeyboardGrid'

export interface CircuitEditorProps {
  readonly store?: CircuitStore
}

export function CircuitEditor({ store = useCircuitStore }: CircuitEditorProps) {
  const { t } = useTranslation(['editor', 'gates'])
  const circuit = useStore(store, (state) => state.circuit)
  const selection = useStore(store, (state) => state.selection)
  const readOnly = useCompactViewport()

  // One free column past the end of the circuit, always: without it the
  // grid has nowhere to grow into and the editor quietly stops accepting
  // gates the moment the circuit fills the visible width.
  const columns = Math.max(MIN_COLUMNS, columnCount(circuit) + 1)
  const grid = useKeyboardGrid({ store, columns, readOnly })
  const [dragging, setDragging] = useState<DragPayload | null>(null)

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 4 } }),
    useSensor(KeyboardSensor, {
      // Enter is deliberately absent from `start`: it belongs to the grid.
      //
      // Tab is in `end` because dnd-kit puts it there, and dropping the
      // library's default is what left a keyboard drag running after focus
      // walked away from it — a drag chip floating over the canvas that the
      // arrow keys no longer reached, with the editor's own key handler
      // switched off the whole time (see `onKeyDown` below) until the user
      // happened to press Escape. dnd-kit answers Tab by ending the drag and
      // consuming the keystroke, so the gate lands where the chip is visibly
      // sitting and focus stays on its cell; the next Tab moves on normally.
      keyboardCodes: {
        start: ['Space'],
        cancel: ['Escape'],
        end: ['Space', 'Enter', 'Tab'],
      },
      coordinateGetter: cellCoordinateGetter,
    })
  )

  const selected = selectedOperations(circuit, selection)[0] ?? null

  return (
    <div
      className="circuit-editor"
      // While dnd-kit is driving a drag it owns the arrow keys, and letting
      // the grid cursor move at the same time would show two cursors going
      // the same way and one of them lying.
      //
      // The handler sits on the whole editor rather than on the grid because
      // Escape and the Ctrl chords are document-level commands and have to
      // work from the toolbar and the palette too. Everything that acts on
      // the grid is gated on the event's origin inside the handler — see
      // `GRID_KEYS` in `useKeyboardGrid.ts`; binding the whole map here is
      // what once made every button in the editor inert under Enter.
      onKeyDown={dragging === null ? grid.handleKeyDown : undefined}
    >
      <DndContext
        sensors={sensors}
        accessibility={{
          // dnd-kit's own announcements are English strings baked into the
          // library. D2 does not stop at the text we wrote ourselves, so
          // they are replaced — without interpolating the dragged item's
          // name, which is notation and has no place inside a translated
          // sentence.
          announcements: {
            onDragStart: () => t('editor:dnd.start'),
            onDragOver: () => undefined,
            // A drop that landed on a cell is answered by the editor's own
            // status line, which says *what* landed *where*; dnd-kit's
            // generic "Gate dropped." would arrive first, from an assertive
            // region, and push the specific answer behind a vague one. A
            // drag that ended on nothing never reaches `applyDrop`, so that
            // is the one case dnd-kit still has to answer for itself.
            onDragEnd: (event: DragEndEvent) =>
              event.over === null ? t('editor:dnd.cancel') : undefined,
            onDragCancel: () => t('editor:dnd.cancel'),
          } satisfies Announcements,
          screenReaderInstructions: {
            draggable: t('editor:dnd.instructions'),
          } satisfies ScreenReaderInstructions,
        }}
        onDragStart={(event: DragStartEvent) => {
          setDragging(payloadOf(event.active.data.current))
        }}
        onDragCancel={() => {
          setDragging(null)
        }}
        onDragEnd={(event: DragEndEvent) => {
          const payload = payloadOf(event.active.data.current)
          const cell = cellOf(event.over?.data.current)
          setDragging(null)
          if (payload === null || cell === null) return
          grid.applyDrop(payload, cell)
        }}
      >
        <div className="circuit-editor__layout">
          <GatePalette
            armed={grid.armed}
            disabled={readOnly}
            onArm={(gate) => {
              grid.arm(gate)
            }}
          />

          <div className="circuit-editor__work">
            <Toolbar
              store={store}
              disabled={readOnly}
              // Not `store.getState().undo` and so on for every one of them
              // — a history move can pull the wires out from under a
              // half-finished placement, and every command owes the live
              // region an account of what it did. The hook is what knows
              // both. Same rule, same code, for the button and for the
              // chord alike; a command wired straight to the store here
              // would be the silent half of a pair.
              onUndo={grid.undo}
              onRedo={grid.redo}
              onCopy={grid.copy}
              onPaste={grid.paste}
              onRemove={grid.removeSelection}
              onCompact={grid.compactColumns}
            />

            <CircuitCanvas
              circuit={circuit}
              selection={selection}
              minColumns={columns}
              draggable
              cursor={grid.cursor}
              focusCursor={grid.focusCursor}
              claimedQubits={pendingQubits(grid.pending)}
              {...(grid.pending === null
                ? {}
                : { awaitingColumn: grid.pending.column })}
              onFocusCell={grid.moveCursorTo}
              onActivateCell={grid.activate}
              // Through the hook rather than straight to the store: both of
              // these renumber the wires, and a placement waiting for its
              // second qubit has to move with them or end.
              onRemoveQubit={grid.removeQubit}
              onInsertQubitBelow={(index) => {
                grid.addQubit(index + 1)
              }}
              // Through the hook for the register bits too, though nothing
              // there renumbers a wire: what they need from it is the live
              // region. A gutter button that edits the document without a
              // word is a button a screen reader user cannot tell they
              // pressed.
              onAddClbit={grid.addClbit}
              onRemoveClbit={grid.removeClbit}
            />

            <p className="circuit-editor__status" role="status">
              {/*
               * The sentence lives in a child keyed by the report's sequence
               * number. Two identical reports in a row — undo twice, delete
               * two gates from the same cell — render the same string, and
               * React would leave the text node untouched: no mutation, no
               * announcement, and the second press appears to have done
               * nothing. Replacing the node is what makes every report a
               * change the live region can see.
               */}
              <span key={grid.announcement?.seq ?? 0}>
                <StatusMessage
                  circuit={circuit}
                  pendingGate={grid.pending?.gate ?? null}
                  pendingSlot={
                    grid.pending === null ? null : nextSlot(grid.pending)
                  }
                  announcement={grid.announcement}
                />
              </span>
            </p>

            <ParameterEditor
              operation={selected}
              disabled={readOnly}
              onChange={(index, value) => {
                if (selected === null) return
                store.getState().setParam(selected.id, index, value)
              }}
              // Every value the slider passes through is applied at once —
              // watching the phasors turn is the point of the control — but
              // the whole drag is one thing to undo.
              onGestureStart={() => {
                store.getState().beginTransaction()
              }}
              onGestureEnd={() => {
                store.getState().endTransaction()
              }}
            />

            {/*
             * Last in the work column because it is the only output there:
             * palette and canvas are what the user acts on, this is what the
             * circuit answers back. M0.7 replaces it in place with the
             * histogram, the amplitude table and the phasors.
             */}
            <SimulationPanel circuit={circuit} />
          </div>
        </div>

        <DragOverlay dropAnimation={null}>
          {dragging === null ? null : (
            <span className="circuit-editor__drag-chip">
              <Notation
                value={
                  dragging.kind === 'palette'
                    ? gateSymbol(dragging.gate)
                    : gateSymbol(
                        circuit.operations.find(
                          (operation) => operation.id === dragging.id
                        )?.gate ?? '',
                        circuit
                      )
                }
              />
            </span>
          )}
        </DragOverlay>
      </DndContext>

      <ShortcutsPanel />
    </div>
  )
}

/**
 * The live region's content: what just happened if anything did, otherwise
 * the prompt for a half-finished placement, otherwise nothing.
 *
 * The report wins because it is the newer fact and the surprising one — a
 * user who pressed Enter and saw nothing appear needs to be told why, and a
 * prompt they have already read does not tell them. It is transient: moving
 * the cursor clears it (see `useKeyboardGrid`), and the prompt comes back on
 * its own, so the question is never lost.
 */
function StatusMessage({
  circuit,
  pendingGate,
  pendingSlot,
  announcement,
}: {
  circuit: Circuit
  pendingGate: string | null
  pendingSlot: 'target' | 'control' | null
  announcement: GridAnnouncement | null
}) {
  const { t } = useTranslation('editor')

  if (announcement !== null) {
    const { message } = announcement
    if (message.kind === 'refused') {
      return (
        <>
          {t(
            isPlacementIssue(message.code)
              ? `placement.${message.code}`
              : `rejection.${message.code}`
          )}
        </>
      )
    }
    return <Outcome circuit={circuit} report={message.report} />
  }

  if (pendingGate === null || pendingSlot === null) return null
  return (
    <>
      <Notation value={gateSymbol(pendingGate, circuit)} />{' '}
      {t(
        pendingSlot === 'control'
          ? 'placement.pickControl'
          : 'placement.pickTarget'
      )}
    </>
  )
}

/**
 * One outcome, said out loud: the gate as notation, then the sentence.
 *
 * The split is D2's rule, and the same one `operationRoles.ts` applies to
 * every cell description: `H` and `CNOT` mean the same thing in all three
 * languages and are rendered through `Notation`, which marks them
 * untranslatable — putting them inside the catalog string would hand them to
 * the next translator, and to Chrome's page translator.
 */
function Outcome({
  circuit,
  report,
}: {
  circuit: Circuit
  report: EditReport
}) {
  const { t, i18n } = useTranslation('editor')
  const { gate, qubits, column, count, label } = report

  const sentence = t(`feedback.${report.key}`, {
    ...(qubits === undefined
      ? {}
      : { qubits: wireList(circuit, qubits, i18n.language) }),
    ...(column === undefined ? {} : { column }),
    ...(count === undefined ? {} : { count }),
    ...(label === undefined ? {} : { label }),
  })

  if (gate === undefined) return <>{sentence}</>
  // A barrier's symbol is a drawing rather than a word — `⋮` read aloud is
  // noise — so it is named the way the canvas names it instead.
  if (targetShape(gate) === 'barrier') {
    return (
      <>
        {t('canvas.cell.barrier')} {sentence}
      </>
    )
  }
  return (
    <>
      <Notation value={gateSymbol(gate, circuit)} /> {sentence}
    </>
  )
}

/** The wires an outcome names, joined the way the active language joins a list. */
function wireList(
  circuit: Circuit,
  qubits: readonly number[],
  locale: string
): string {
  return formatWireList(
    qubits.map((qubit) => qubitLabel(circuit, qubit)),
    locale
  )
}

function Toolbar({
  store,
  disabled,
  onUndo,
  onRedo,
  onCopy,
  onPaste,
  onRemove,
  onCompact,
}: {
  store: CircuitStore
  disabled: boolean
  onUndo: () => void
  onRedo: () => void
  onCopy: () => void
  onPaste: () => void
  onRemove: () => void
  onCompact: () => void
}) {
  const { t } = useTranslation('editor')
  const selection = useStore(store, (state) => state.selection)
  const clipboard = useStore(store, (state) => state.clipboard)

  return (
    <div
      className="circuit-editor__toolbar"
      role="toolbar"
      aria-label={t('toolbar.label')}
    >
      <button type="button" disabled={disabled} onClick={onUndo}>
        {t('toolbar.undo')}
      </button>
      <button type="button" disabled={disabled} onClick={onRedo}>
        {t('toolbar.redo')}
      </button>
      <button
        type="button"
        disabled={disabled || selection.length === 0}
        onClick={onCopy}
      >
        {t('toolbar.copy')}
      </button>
      <button
        type="button"
        disabled={disabled || clipboard === null}
        onClick={onPaste}
      >
        {t('toolbar.paste')}
      </button>
      <button
        type="button"
        disabled={disabled || selection.length === 0}
        onClick={onRemove}
      >
        {t('toolbar.remove')}
      </button>
      <button type="button" disabled={disabled} onClick={onCompact}>
        {t('toolbar.compact')}
      </button>
    </div>
  )
}

/**
 * Moves a keyboard drag by exactly one cell per press. The default getter
 * moves by a fixed 25px, which on this grid is neither a column nor a row.
 */
const cellCoordinateGetter: KeyboardCoordinateGetter = (
  event,
  { currentCoordinates }
) => {
  switch (event.code) {
    case 'ArrowRight':
      return {
        ...currentCoordinates,
        x: currentCoordinates.x + DEFAULT_METRICS.columnWidth,
      }
    case 'ArrowLeft':
      return {
        ...currentCoordinates,
        x: currentCoordinates.x - DEFAULT_METRICS.columnWidth,
      }
    case 'ArrowDown':
      return {
        ...currentCoordinates,
        y: currentCoordinates.y + DEFAULT_METRICS.rowHeight,
      }
    case 'ArrowUp':
      return {
        ...currentCoordinates,
        y: currentCoordinates.y - DEFAULT_METRICS.rowHeight,
      }
    default:
      return undefined
  }
}

/** Narrows dnd-kit's untyped `data` bag back into the payloads we put in. */
function payloadOf(data: unknown): DragPayload | null {
  if (typeof data !== 'object' || data === null) return null
  const bag = data as Record<string, unknown>
  if (
    bag.kind === 'palette' &&
    typeof bag.gate === 'string' &&
    isGateId(bag.gate)
  ) {
    return { kind: 'palette', gate: bag.gate }
  }
  if (
    bag.kind === 'operation' &&
    typeof bag.id === 'string' &&
    typeof bag.grabbedQubit === 'number'
  ) {
    return { kind: 'operation', id: bag.id, grabbedQubit: bag.grabbedQubit }
  }
  return null
}

function cellOf(data: unknown): Cell | null {
  if (typeof data !== 'object' || data === null) return null
  const cell = (data as { cell?: unknown }).cell
  if (typeof cell !== 'object' || cell === null) return null
  const { qubit, column } = cell as Record<string, unknown>
  return typeof qubit === 'number' && typeof column === 'number'
    ? { qubit, column }
    : null
}
