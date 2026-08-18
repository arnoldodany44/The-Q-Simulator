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
 * ## The timeline is owned here (M0.8)
 *
 * `useTimeline` holds one number — where the scrubber is parked — and three
 * siblings read it: the bar renders it, the canvas draws a playhead at it, and
 * the analysis panel simulates up to it instead of to the end. That is why it
 * is here rather than inside `TimelineScrubber`, and why it is not in the
 * store: it is a way of looking at the document, not part of it, and undo has
 * no business restoring where somebody was looking.
 *
 * ## What a shared session is allowed to ask of it (M5.6)
 *
 * Two props, and neither of them teaches this file what a session is — the
 * one-way arrow `.dependency-cruiser.cjs` enforces means the editor may never
 * import the CRDT or the transport, because most sessions have one person in them
 * and a solo editor must not download Yjs to find that out.
 *
 * `readOnly` is the relay's answer, drawn: a peer who may watch and not write
 * gets the same editor a compact viewport gets. `onCursorMove` is the outbound
 * half of presence, because only the grid knows where this reader is looking. The
 * inbound half arrives as `canvasOverlay`, which this component forwards without
 * looking inside — so the carets are drawn over the canvas by a layer the editor
 * has never heard of.
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
import { useEffect, useState, type ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import { useStore } from 'zustand'

import { Notation } from '../../components/Notation'
import { SimulationPanel } from '../simulation/SimulationPanel'
import { CircuitCanvas } from './CircuitCanvas'
import { GatePalette } from './GatePalette'
import { ParameterEditor } from './ParameterEditor'
import { CustomGatePanel } from './CustomGatePanel'
import { ShortcutsPanel } from './ShortcutsPanel'
import { TimelineScrubber } from './TimelineScrubber'
import { DEFAULT_METRICS, editableColumns, type Cell } from './geometry'
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
import { drawnColumnOf } from './timeline'
import { useTimeline } from './useTimeline'
import {
  useKeyboardGrid,
  type EditReport,
  type GridAnnouncement,
} from './useKeyboardGrid'

export interface CircuitEditorProps {
  readonly store?: CircuitStore
  /**
   * Something drawn over the canvas, in the canvas's own coordinates (M5.3).
   *
   * Forwarded straight to `CircuitCanvas`, which argues why it is an opaque node.
   * The page owns it rather than the editor for the same reason the page owns the
   * URL and the save control: a shared session belongs to the document, and the
   * editor is what edits the circuit already open in one.
   */
  readonly canvasOverlay?: ReactNode
  /**
   * Something at the end of the toolbar, after the editing commands.
   *
   * An opaque node for the same two reasons `canvasOverlay` is one. The weight
   * half is concrete: the page puts the OpenQASM import here, and that node's
   * graph contains a whole parser — imported from this file it would land in
   * the editor's chunk and be paid for by everyone who opens `/new`. The seam
   * half is the usual one: these buttons act on the circuit already open, and
   * anything that replaces the document belongs to the page.
   */
  readonly toolbarOverflow?: ReactNode
  /**
   * Forces the whole editor read-only, on top of the compact-viewport rule.
   *
   * For a shared session this peer may watch and not write (M5.6). It is a
   * *drawing* decision and never a permission: §11 puts authorisation on the
   * relay, which refuses a `collab:update` from a read-only peer whatever this
   * component drew, and may start refusing after this render — an owner who
   * transfers a circuit mid-session is downgraded in place. What it buys is that
   * the reader is not invited to make edits the relay will drop on the floor.
   */
  readonly readOnly?: boolean
  /**
   * Where the grid cursor is, whenever it moves.
   *
   * The outbound half of presence (§3.4): only the grid knows where this reader
   * is looking, and a cursor is a way of looking at the document rather than part
   * of it, so it is reported rather than stored. A `Cell` and not a presence
   * type, because this file must not learn what a session is — the one-way arrow
   * `.dependency-cruiser.cjs` enforces.
   */
  readonly onCursorMove?: (cell: Cell) => void
}

export function CircuitEditor({
  store = useCircuitStore,
  canvasOverlay,
  toolbarOverflow,
  readOnly: forcedReadOnly = false,
  onCursorMove,
}: CircuitEditorProps) {
  const { t } = useTranslation(['editor', 'gates'])
  const circuit = useStore(store, (state) => state.circuit)
  const selection = useStore(store, (state) => state.selection)
  /*
   * Which document is open, not what is in it. An edit and a preset chip both
   * hand out a new `circuit`; only this tells them apart, and the timeline
   * needs the difference — see `useTimeline`.
   */
  const documentId = useStore(store, (state) => state.documentId)
  // Either reason is enough. A small screen cannot place a gate accurately and a
  // watcher may not place one at all; the controls that write are hidden for both.
  const readOnly = useCompactViewport() || forcedReadOnly

  // One free column past the end of the circuit, and never more than the
  // canvas can draw: without the free column the grid has nowhere to grow
  // into, and without the ceiling a `?c=` link naming column 4095 asks for
  // eighty thousand droppables in one render. `geometry.ts` holds both rules.
  const columns = editableColumns(circuit)
  const grid = useKeyboardGrid({ store, columns, readOnly })
  const [dragging, setDragging] = useState<DragPayload | null>(null)
  /*
   * The timeline is owned here rather than by the scrubber, because it is
   * read in three places that are siblings: the bar renders it, the canvas
   * draws a playhead at it, and the analysis panel simulates *to* it. It is
   * deliberately not in the store — the position is a way of looking at the
   * document, not part of it, and undo has no business restoring it.
   */
  const timeline = useTimeline({ circuit, documentId })
  /*
   * The one place the two column axes meet. The bar walks the engine's
   * instants (`timeline.ts`), and the canvas draws source columns — so a
   * playhead parked inside a block is drawn on the block, which is the honest
   * picture: that instant really is happening there.
   */
  const playhead = drawnColumnOf(circuit, timeline.position)

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

  /*
   * Tell whoever asked where the cursor is (M5.6).
   *
   * Keyed on the two numbers rather than on `grid.cursor`, because that is a fresh
   * object on every render of this component: an effect keyed on it would fire on
   * every keystroke, which for a presence channel is a frame per keystroke instead
   * of a frame per movement.
   *
   * ── AND ON THE CALLBACK, WHICH IS NOT AN OVERSIGHT ──────────────────────
   *
   * The first version held it in a ref and keyed the effect on the coordinates
   * alone, so the position was reported *once*, on mount, into whatever callback
   * existed then — and the session does not exist then. The editor paints as soon
   * as the circuit arrives; the socket opens, authenticates and joins over the
   * second that follows, and `useCollabSession` returns a no-op `setCursor` until
   * it has. Nothing re-reported afterwards, so a peer who placed a gate without
   * ever moving the cursor was announced as «Ana edited the circuit» with the cell
   * dropped and listed in the roster as «not on the grid» — a false statement
   * about somebody who was on the grid, and exactly the placeless interruption
   * `presence.ts` says is not worth making.
   *
   * Re-reporting on a new callback costs nothing: `presenceChannel.moved` drops a
   * position that did not move, so a parent that passes a fresh function every
   * render cannot produce a frame, only a comparison.
   */
  const { qubit: cursorQubit, column: cursorColumn } = grid.cursor
  useEffect(() => {
    onCursorMove?.({ qubit: cursorQubit, column: cursorColumn })
  }, [cursorQubit, cursorColumn, onCursorMove])

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
              overflow={toolbarOverflow}
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
              {...(playhead === null ? {} : { playhead })}
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
              // Whatever the page put over the canvas — other people's cursors,
              // since M5.3. The editor forwards it and never looks inside it.
              {...(canvasOverlay === undefined
                ? {}
                : { overlay: canvasOverlay })}
            />

            {/*
             * Directly under the drawing, because it is the drawing's time
             * axis. It is not disabled with the rest of the editor on a small
             * screen: read-only means "you cannot edit this", and scrubbing
             * edits nothing.
             *
             * A circuit with no columns has no timeline to walk, and a bar
             * with one stop would be a control that cannot do anything —
             * so the whole section waits until there is a gate on the canvas.
             */}
            {timeline.columns > 0 ? (
              <TimelineScrubber timeline={timeline} />
            ) : null}

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
             * Above the simulation panel and below the parameter editor,
             * because it is an editing control and not an output — and
             * because packaging a fragment is the next thing a user reaches
             * for after selecting one, which is what the two controls above it
             * are for. It is hidden on a read-only canvas like every other
             * control that writes to the document (M2.3).
             *
             * `qubit` is the grid cursor's wire, so "Place" puts a block where
             * the reader is looking rather than always on q0.
             */}
            {readOnly ? null : (
              <CustomGatePanel store={store} qubit={grid.cursor.qubit} />
            )}

            {/*
             * Last in the work column because it is the only output there:
             * palette and canvas are what the user acts on, this is what the
             * circuit answers back. M0.7 replaces it in place with the
             * histogram, the amplitude table and the phasors.
             */}
            <SimulationPanel
              circuit={circuit}
              throughColumn={timeline.position}
            />
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
  overflow,
  onUndo,
  onRedo,
  onCopy,
  onPaste,
  onRemove,
  onCompact,
}: {
  store: CircuitStore
  disabled: boolean
  overflow?: ReactNode
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
      <button
        type="button"
        disabled={disabled}
        title={t('toolbar.describe.undo')}
        onClick={onUndo}
      >
        {t('toolbar.undo')}
      </button>
      <button
        type="button"
        disabled={disabled}
        title={t('toolbar.describe.redo')}
        onClick={onRedo}
      >
        {t('toolbar.redo')}
      </button>
      <button
        type="button"
        disabled={disabled || selection.length === 0}
        title={t('toolbar.describe.copy')}
        onClick={onCopy}
      >
        {t('toolbar.copy')}
      </button>
      <button
        type="button"
        disabled={disabled || clipboard === null}
        title={t('toolbar.describe.paste')}
        onClick={onPaste}
      >
        {t('toolbar.paste')}
      </button>
      <button
        type="button"
        disabled={disabled || selection.length === 0}
        title={t('toolbar.describe.remove')}
        onClick={onRemove}
      >
        {t('toolbar.remove')}
      </button>
      <button
        type="button"
        disabled={disabled}
        title={t('toolbar.describe.compact')}
        onClick={onCompact}
      >
        {t('toolbar.compact')}
      </button>
      {/*
       * Last, and pushed to the far end by the stylesheet. It is not an editing
       * command like the six above it — it is where the commands that are not
       * used constantly go — so it is separated by space rather than by a rule
       * or a heading. `role="toolbar"` still covers it: arrow-key navigation
       * over a toolbar is expected to reach everything in it.
       */}
      {overflow === undefined ? null : overflow}
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
