/**
 * The circuit canvas: the SVG plot, the pinned wire gutter, and the ARIA
 * grid that is laid over both.
 *
 * ## Why the SVG is `aria-hidden`
 *
 * ARIA inside SVG is the obvious approach and the wrong one. Support for
 * `role="grid"` on `<g>` elements is uneven across screen readers, `<title>`
 * on a shape is announced inconsistently, and — decisively — the thing a
 * reader needs is not "there is a circle here" but "q1, column 2, CNOT
 * target, controlled by q0". That is a grid, and the browser already has an
 * excellent one.
 *
 * So the canvas ships two layers over one model:
 *
 *  - the SVG plot, `aria-hidden`, which is pixels for people who look;
 *  - a `role="grid"` overlay — one row per wire, one cell per moment —
 *    which is sentences for people who listen, *and* the editor's entire
 *    interactive surface.
 *
 * Both are generated from the same `Circuit` and from the same role
 * classification in `operationRoles.ts`, so they cannot describe different
 * circuits. Since M0.5c the overlay is not merely descriptive: each cell is
 * the keyboard cursor's target, dnd-kit's drop target, and the handle an
 * already-placed gate is dragged by. Making those one element is what
 * guarantees that what a user sees, what they can focus and what they can
 * drop on are the same square — the geometry comes from `cellBounds` for
 * the overlay and from `cellCenter` for the drawing, and those are inverses
 * proved in `geometry.test.ts`.
 *
 * The grid deliberately covers the padded width of the plot rather than
 * just the occupied columns: an empty column is not "no content", it is
 * where the next gate goes, and a placement target a keyboard user cannot
 * reach is not a placement target.
 *
 * The classical register is a row of the grid but never an editable one.
 * Its cells are `aria-readonly`: a measurement reaches the register from
 * its qubit, and nothing is ever placed there directly — which is the same
 * ruling `pointToCell` makes by returning `null` for that band. They are
 * still *reachable*, carrying the same roving tabindex as every other cell,
 * because the grid pattern navigates every cell and a row a keyboard user
 * can never stand on is a row that only exists for people reading the page
 * in virtual mode. Its *width* is another matter: the gutter carries add and
 * remove controls for it, the counterpart of the wire controls, because a
 * qubit whose classical bit does not exist can never be measured.
 *
 * ## Reading at 3 qubits and at 20
 *
 * The plot scrolls; the gutter holding the wire names is `position: sticky`
 * inside the same scroller, so names stay put horizontally while columns
 * slide past, and stay glued to their wires vertically because both are
 * positioned from `qubitY`. The gutter's *labels* are `aria-hidden`: the
 * same names reach a screen reader as the grid's row headers, and hearing
 * every wire twice is worse than not seeing it once. Its buttons are not,
 * because they are the only way to resize either register.
 *
 * ## Below 768px
 *
 * The editor is read-only and scrolls (specification §10, risk 6): row
 * controls are not rendered, cells are not drop targets, and a notice says
 * so rather than leaving the user hunting for a control that is not there.
 * The viewport query is the default; an explicit `readOnly` prop overrides
 * it, which is what a preview or an embed will want.
 */

import { type Circuit } from '@qsim/schema'
import { useId, useRef, type CSSProperties, type ReactNode } from 'react'
import { flushSync } from 'react-dom'
import { useTranslation } from 'react-i18next'

import { Notation } from '../../components/Notation'
import { GateNode } from './GateNode'
import {
  DndCell,
  PlainCell,
  ReadonlyCell,
  type GridCellProps,
} from './GridCell'
import {
  ClassicalRowHeader,
  ClassicalWire,
  QubitRowHeader,
  QubitWire,
} from './QubitWire'
import {
  DEFAULT_METRICS,
  MIN_COLUMNS,
  cellBounds,
  classicalY,
  columnCount,
  gridSizeOf,
  plotHeight,
  plotWidth,
  qubitY,
  type Cell,
  type GridMetrics,
  type GridSize,
} from './geometry'
import {
  describeClassicalCell,
  describeQubitCell,
  formatParams,
  formatWireList,
  qubitLabel,
  registerOperationsAt,
  type CellSegment,
} from './operationRoles'
import { useCompactViewport } from './useCompactViewport'
import { operationAt } from './useCircuitStore'

const NO_SELECTION: readonly string[] = []
const NO_QUBITS: readonly number[] = []

export interface CircuitCanvasProps {
  readonly circuit: Circuit
  /** Ids of the selected operations, as held by the store. */
  readonly selection?: readonly string[]
  /** Overrides the viewport-derived read-only mode. */
  readonly readOnly?: boolean
  readonly minColumns?: number
  readonly metrics?: GridMetrics
  readonly onRemoveQubit?: (index: number) => void
  readonly onInsertQubitBelow?: (index: number) => void
  readonly onAddClbit?: () => void
  /** Removes the highest classical bit; see `ClassicalRowHeader`. */
  readonly onRemoveClbit?: () => void

  /**
   * Registers every cell with dnd-kit. Only valid inside a `DndContext`,
   * which is why it is opt-in rather than assumed.
   */
  readonly draggable?: boolean
  /** Where the keyboard cursor is. */
  readonly cursor?: Cell
  /** Whether the cursor cell should take DOM focus (see `GridCell`). */
  readonly focusCursor?: boolean
  /** Wires already claimed by a half-finished multi-qubit placement. */
  readonly claimedQubits?: readonly number[]
  /** The column such a placement is waiting in, if one is in progress. */
  readonly awaitingColumn?: number
  readonly onFocusCell?: (cell: Cell) => void
  readonly onActivateCell?: (cell: Cell) => void
}

export function CircuitCanvas({
  circuit,
  selection = NO_SELECTION,
  readOnly,
  minColumns = MIN_COLUMNS,
  metrics = DEFAULT_METRICS,
  onRemoveQubit,
  onInsertQubitBelow,
  onAddClbit,
  onRemoveClbit,
  draggable = false,
  cursor,
  focusCursor = false,
  claimedQubits = NO_QUBITS,
  awaitingColumn,
  onFocusCell,
  onActivateCell,
}: CircuitCanvasProps) {
  const { t } = useTranslation('editor')
  const compact = useCompactViewport()
  const locked = readOnly ?? compact

  const gutter = useRef<HTMLDivElement | null>(null)

  /*
   * Runs a removal and hands focus on to the control that replaces the one it
   * destroys.
   *
   * WCAG 2.4.3, and the reason the whole editor went dead after a single
   * click: a row control that removes its own row destroys the element
   * holding focus, and focus fell to `<body>` — outside the element the key
   * handler is bound to, so every shortcut stopped answering until the user
   * tabbed back in. Removing a middle wire was no better, only quieter: React
   * re-used that button for a *different* wire, so one gesture either lost
   * focus or left it somewhere nobody chose.
   *
   * `flushSync` is what makes `neighbour` meaningful: the button to move to
   * does not exist until React has re-rendered the gutter, and the button
   * that had focus no longer exists at all. Nothing is reclaimed unless the
   * gutter really held focus, so a pointer user in a browser that does not
   * focus buttons on click is not dragged into a gutter they never entered.
   */
  const removeAndReclaim = (
    remove: () => void,
    neighbour: (node: HTMLElement) => HTMLButtonElement | null
  ): void => {
    const node = gutter.current
    const held = node?.contains(document.activeElement) ?? false
    flushSync(remove)
    if (!held || node === null) return
    neighbour(node)?.focus()
  }

  const size = gridSizeOf(circuit, minColumns)
  const width = plotWidth(size, metrics)
  const height = plotHeight(size, metrics)
  const selected = new Set(selection)

  return (
    <section className="circuit-canvas" aria-label={t('canvas.label')}>
      {locked ? (
        <p className="circuit-canvas__notice">{t('canvas.readOnly')}</p>
      ) : null}

      <div className="circuit-canvas__viewport">
        <div className="circuit-canvas__gutter" style={{ height }} ref={gutter}>
          {range(circuit.qubits).map((qubit) => (
            <QubitRowHeader
              key={qubit}
              index={qubit}
              label={qubitLabel(circuit, qubit)}
              metrics={metrics}
              removeLabel={t('wire.remove', {
                label: qubitLabel(circuit, qubit),
              })}
              insertLabel={t('wire.insertBelow', {
                label: qubitLabel(circuit, qubit),
              })}
              onRemove={
                locked || onRemoveQubit === undefined
                  ? undefined
                  : (index) => {
                      removeAndReclaim(
                        () => {
                          onRemoveQubit(index)
                        },
                        // The row that took the deleted one's place, or the
                        // last row when the bottom wire went.
                        (node) => {
                          const buttons =
                            node.querySelectorAll<HTMLButtonElement>(
                              '[data-row-remove]'
                            )
                          return buttons.item(
                            Math.min(index, buttons.length - 1)
                          )
                        }
                      )
                    }
              }
              onInsertBelow={locked ? undefined : onInsertQubitBelow}
            />
          ))}
          {size.clbits > 0 ? (
            <ClassicalRowHeader
              size={size}
              metrics={metrics}
              addLabel={t('register.addBit')}
              removeLabel={t('register.removeBit')}
              {...(locked || onAddClbit === undefined
                ? {}
                : { onAdd: onAddClbit })}
              {...(locked ||
              onRemoveClbit === undefined ||
              // The last bit stays: this row — and with it the only control
              // that could bring the register back — is drawn only while the
              // register has width.
              circuit.clbits <= 1
                ? {}
                : {
                    onRemove: () => {
                      // The control retires at one bit, so the last press
                      // destroys it; focus goes to the add control beside it
                      // rather than to `<body>`.
                      removeAndReclaim(
                        onRemoveClbit,
                        (node) =>
                          node.querySelector<HTMLButtonElement>(
                            '[data-register-remove]'
                          ) ??
                          node.querySelector<HTMLButtonElement>(
                            '[data-register-add]'
                          )
                      )
                    },
                  })}
            />
          ) : null}
        </div>

        <div className="circuit-canvas__stage" style={{ width, height }}>
          <svg
            className="circuit-canvas__plot"
            width={width}
            height={height}
            viewBox={`0 0 ${width} ${height}`}
            aria-hidden="true"
            focusable="false"
          >
            <g className="qsim-wires">
              {range(circuit.qubits).map((qubit) => (
                <QubitWire
                  key={qubit}
                  qubit={qubit}
                  width={width}
                  metrics={metrics}
                />
              ))}
              {size.clbits > 0 ? (
                <ClassicalWire size={size} width={width} metrics={metrics} />
              ) : null}
            </g>
            <g className="qsim-operations">
              {circuit.operations.map((operation) => (
                <GateNode
                  key={operation.id}
                  circuit={circuit}
                  operation={operation}
                  size={size}
                  metrics={metrics}
                  selected={selected.has(operation.id)}
                />
              ))}
            </g>
          </svg>

          <CircuitGrid
            circuit={circuit}
            size={size}
            metrics={metrics}
            selected={selected}
            draggable={draggable && !locked}
            cursor={cursor}
            focusCursor={focusCursor}
            claimedQubits={claimedQubits}
            awaitingColumn={awaitingColumn}
            onFocusCell={locked ? undefined : onFocusCell}
            onActivateCell={locked ? undefined : onActivateCell}
          />
        </div>
      </div>
    </section>
  )
}

interface CircuitGridProps {
  readonly circuit: Circuit
  readonly size: GridSize
  readonly metrics: GridMetrics
  readonly selected: ReadonlySet<string>
  readonly draggable: boolean
  readonly cursor?: Cell
  readonly focusCursor: boolean
  readonly claimedQubits: readonly number[]
  readonly awaitingColumn?: number
  readonly onFocusCell?: (cell: Cell) => void
  readonly onActivateCell?: (cell: Cell) => void
}

/**
 * The canvas's accessible and interactive surface: every cell of the grid,
 * occupied or not, as an element a reader can hear and a cursor can reach.
 */
function CircuitGrid({
  circuit,
  size,
  metrics,
  selected,
  draggable,
  cursor,
  focusCursor,
  claimedQubits,
  awaitingColumn,
  onFocusCell,
  onActivateCell,
}: CircuitGridProps) {
  const { t } = useTranslation('editor')
  const columns = range(size.columns)
  const CellView = draggable ? DndCell : PlainCell
  const claimed = new Set(claimedQubits)
  const summaryId = useId()

  // The cursor always exists somewhere, so that a grid arriving without one
  // still has exactly one cell in the tab order.
  const focus: Cell = cursor ?? { qubit: 0, column: 0 }

  return (
    <>
      {/*
       * The one sentence that answers "what is on this canvas", attached to
       * the grid as its description rather than parked inside it. ARIA lets
       * `role="grid"` own rows and rowgroups and nothing else, so a bare
       * paragraph among the rows is a child a reader building a table model
       * is entitled to drop — and this is the last thing that should be
       * droppable, being the only summary a listener gets.
       */}
      <p className="visually-hidden circuit-canvas__summary" id={summaryId}>
        {t('canvas.contents')}{' '}
        {t('canvas.summary', {
          qubits: circuit.qubits,
          columns: columnCount(circuit),
          gates: circuit.operations.length,
        })}
      </p>

      <div
        className="circuit-canvas__grid"
        role="grid"
        aria-label={t('canvas.grid')}
        aria-describedby={summaryId}
        aria-rowcount={1 + circuit.qubits + (size.clbits > 0 ? 1 : 0)}
        aria-colcount={size.columns + 1}
      >
        <div role="row" className="visually-hidden">
          <span role="columnheader">{t('canvas.wireHeader')}</span>
          {columns.map((column) => (
            <span key={column} role="columnheader">
              {t('canvas.column', { index: column })}
            </span>
          ))}
        </div>

        {range(circuit.qubits).map((qubit) => (
          <div
            key={qubit}
            role="row"
            className="circuit-canvas__grid-row"
            style={rowStyle(qubitY(qubit, metrics), metrics)}
          >
            <span role="rowheader" className="visually-hidden">
              <Notation value={qubitLabel(circuit, qubit)} />
            </span>
            {columns.map((column) => {
              const cell: Cell = { qubit, column }
              const operation = operationAt(circuit, qubit, column)
              const bounds = cellBounds(cell, metrics)
              const props: GridCellProps = {
                cell,
                left: bounds.x,
                width: bounds.width,
                emptyLabel: t('canvas.cell.empty'),
                dragRoleDescription: t('canvas.cell.dragHandle'),
                focused: focus.qubit === qubit && focus.column === column,
                autoFocus: focusCursor,
                claimed: claimed.has(qubit),
                awaiting: awaitingColumn === column,
                ...(operation === undefined
                  ? {}
                  : {
                      operationId: operation.id,
                      selected: selected.has(operation.id),
                    }),
                ...(onFocusCell === undefined ? {} : { onFocusCell }),
                ...(onActivateCell === undefined
                  ? {}
                  : { onActivate: onActivateCell }),
              }
              return (
                <CellView key={column} {...props}>
                  {operation === undefined ? null : (
                    <Segments
                      segments={describeQubitCell(circuit, operation, qubit)}
                    />
                  )}
                </CellView>
              )
            })}
          </div>
        ))}

        {size.clbits > 0 ? (
          <div
            role="row"
            className="circuit-canvas__grid-row"
            style={rowStyle(classicalY(size, metrics), metrics)}
          >
            <span role="rowheader" className="visually-hidden">
              <Piece>
                <Notation value="c" />
              </Piece>
              <Piece>
                {t('canvas.classicalRegister', { count: circuit.clbits })}
              </Piece>
            </span>
            {columns.map((column) => {
              const records = registerOperationsAt(circuit, column)
              // The register is a row of the grid, so its cells take the same
              // roving tabindex and the same cursor as every other cell: the
              // ARIA grid pattern reaches every cell with the arrow keys, and
              // `aria-readonly` says "you cannot edit this", not "you cannot
              // come here". A cell with nothing written into it also has no
              // text, and a nameless gridcell is announced as nothing at all,
              // so an empty slot says the word an empty qubit cell says.
              const cell: Cell = { qubit: size.qubits, column }
              const props: GridCellProps = {
                cell,
                left: cellBounds({ qubit: 0, column }, metrics).x,
                width: metrics.columnWidth,
                emptyLabel: t('canvas.cell.empty'),
                named: records.length > 0,
                readOnly: true,
                focused: focus.qubit === size.qubits && focus.column === column,
                autoFocus: focusCursor,
                ...(onFocusCell === undefined ? {} : { onFocusCell }),
                ...(onActivateCell === undefined
                  ? {}
                  : { onActivate: onActivateCell }),
              }
              return (
                <ReadonlyCell key={column} {...props}>
                  {records.map((operation) => (
                    <Segments
                      key={operation.id}
                      segments={describeClassicalCell(circuit, operation)}
                    />
                  ))}
                </ReadonlyCell>
              )
            })}
          </div>
        ) : null}
      </div>
    </>
  )
}

/** A row band, centred on the wire the SVG drew at the same `y`. */
function rowStyle(centreY: number, metrics: GridMetrics): CSSProperties {
  return { top: centreY - metrics.rowHeight / 2, height: metrics.rowHeight }
}

/**
 * One piece of a description.
 *
 * The inline style is not decoration. The accessible name algorithm
 * concatenates an element's children and only inserts a separating space
 * around a child that is *not* `display: inline`; a whitespace-only text
 * node between two inline spans is flattened away first. Left inline, the
 * cell containing `CNOT` and `target` computes its name as `CNOTtarget`,
 * which is what a screen reader would actually say. `inline-block` is what
 * puts the space back, and it costs nothing here because every description
 * is visually hidden anyway.
 */
const PIECE_STYLE: CSSProperties = { display: 'inline-block' }

function Piece({ children }: { children: ReactNode }) {
  return <span style={PIECE_STYLE}>{children}</span>
}

/**
 * Renders a cell description. Notation goes through `Notation` and phrases
 * through the catalog, never pasted into one string: an accessible name is
 * still user-facing text, so D2 applies to it exactly as it applies to a
 * button, and a gate symbol buried inside a translated sentence is a symbol
 * no lint rule can protect.
 */
function Segments({ segments }: { segments: readonly CellSegment[] }) {
  const { t, i18n } = useTranslation('editor')
  return (
    <span className="visually-hidden">
      {segments.map((segment, index) => (
        <Piece key={index}>
          {segment.kind === 'notation' ? (
            <Notation value={segment.value} />
          ) : segment.kind === 'params' ? (
            <Notation
              value={formatParams(segment.names, segment.values, i18n.language)}
            />
          ) : (
            t(segment.key, {
              ...segment.values,
              // A list of wires is prose, so it is joined the way the active
              // language joins one — not with a hard-coded comma.
              ...(segment.wires === undefined
                ? {}
                : { qubits: formatWireList(segment.wires, i18n.language) }),
            })
          )}
        </Piece>
      ))}
    </span>
  )
}

function range(length: number): number[] {
  return Array.from({ length }, (_, index) => index)
}
