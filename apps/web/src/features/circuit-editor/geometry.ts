/**
 * The canvas coordinate system — the only place that knows how a circuit
 * cell becomes a pair of pixels, and the only place that knows how to go
 * back.
 *
 * It lives apart from the components, holds no React and no DOM, because the
 * *inverse* mapping is load-bearing. Every pointer interaction in M0.5c
 * (drop a gate here, grab the gate under the cursor, snap a drag to a cell)
 * resolves to `pointToCell`, and a hit test that is one row off produces a
 * bug with no visible cause: the DOM is correct, the SVG is correct, and the
 * gate simply lands somewhere else. As a pure function of two integers it can
 * instead be round-tripped exhaustively in a test, which is what
 * `geometry.test.ts` does.
 *
 * Orientation: qubit 0 is the **top** wire and column 0 is the leftmost, so
 * the drawing reads the way Qiskit prints it. That is a drawing convention
 * and nothing more — decision D1 (qubit 0 is the least significant bit) is
 * about bit order inside the statevector and is untouched by which row gets
 * painted first.
 *
 * The classical register is a wire but not a row: it sits below the last
 * qubit, separated by `registerGap`, and `pointToCell` deliberately reports
 * `null` for points that land on it. Nothing can be dropped on the classical
 * wire — a measurement reaches it from its qubit, it is never placed there.
 */

import type { Circuit } from '@qsim/schema'

export interface GridMetrics {
  /** Horizontal distance between the centres of two adjacent columns. */
  readonly columnWidth: number
  /** Vertical distance between the centres of two adjacent qubit wires. */
  readonly rowHeight: number
  /** Blank space before column 0 and after the last column. */
  readonly padX: number
  /** Blank space above the first wire and below the last one drawn. */
  readonly padY: number
  /** Side of the square a one-qubit gate is drawn in. */
  readonly gateSize: number
  /** Extra space between the last qubit wire and the classical register. */
  readonly registerGap: number
}

/**
 * Every value is an integer, and `columnWidth` and `rowHeight` are even.
 * Cell centres therefore land on exact halves, which keeps `pointToCell`
 * free of floating-point ties at the boundaries between cells.
 */
export const DEFAULT_METRICS: GridMetrics = {
  columnWidth: 56,
  rowHeight: 48,
  padX: 20,
  padY: 16,
  gateSize: 34,
  registerGap: 16,
}

/**
 * Columns drawn even when the circuit does not fill them. An empty document
 * that rendered as a bare stub would give a first-time user nothing to aim
 * at; this is the room to drop the first gate into.
 */
export const MIN_COLUMNS = 8

/** A cell of the editable grid: one qubit at one moment in time. */
export interface Cell {
  readonly qubit: number
  readonly column: number
}

export interface Point {
  readonly x: number
  readonly y: number
}

export interface Rect {
  readonly x: number
  readonly y: number
  readonly width: number
  readonly height: number
}

/** How much grid there is to draw. Not a circuit: the canvas pads it out. */
export interface GridSize {
  readonly qubits: number
  /** 0 when the circuit has no classical register, which draws no wire. */
  readonly clbits: number
  readonly columns: number
}

/**
 * Rows the keyboard cursor can stand on: one per wire, plus the classical
 * register when the circuit has one.
 *
 * The register is a row of the ARIA grid, so the grid pattern requires the
 * arrow keys to reach it — read-only means "you cannot edit it", not "you
 * cannot look at it". It is addressed as the virtual wire index
 * `size.qubits`, one past the last real wire, which is exactly where the
 * canvas draws it; `isRegisterRow` is the test every command uses before it
 * treats a cursor as a qubit.
 */
export function rowCount(size: GridSize): number {
  return size.qubits + (size.clbits > 0 ? 1 : 0)
}

/** Whether a cell names the classical register rather than a qubit wire. */
export function isRegisterRow(cell: Cell, size: GridSize): boolean {
  return cell.qubit >= size.qubits
}

/** Columns the circuit actually occupies, i.e. one past its last column. */
export function columnCount(circuit: Circuit): number {
  let last = -1
  for (const operation of circuit.operations) {
    if (operation.column > last) last = operation.column
  }
  return last + 1
}

/** The grid a circuit is drawn on, padded to `minColumns`. */
export function gridSizeOf(
  circuit: Circuit,
  minColumns: number = MIN_COLUMNS
): GridSize {
  return {
    qubits: circuit.qubits,
    clbits: circuit.clbits,
    columns: Math.max(minColumns, columnCount(circuit)),
  }
}

/** Centre of a column, in user units. */
export function columnX(
  column: number,
  metrics: GridMetrics = DEFAULT_METRICS
): number {
  return metrics.padX + column * metrics.columnWidth + metrics.columnWidth / 2
}

/** Centre of a qubit wire, in user units. */
export function qubitY(
  qubit: number,
  metrics: GridMetrics = DEFAULT_METRICS
): number {
  return metrics.padY + qubit * metrics.rowHeight + metrics.rowHeight / 2
}

/** Centre of the classical register wire. Only meaningful when clbits > 0. */
export function classicalY(
  size: GridSize,
  metrics: GridMetrics = DEFAULT_METRICS
): number {
  return qubitY(size.qubits, metrics) + metrics.registerGap
}

export function cellCenter(
  cell: Cell,
  metrics: GridMetrics = DEFAULT_METRICS
): Point {
  return { x: columnX(cell.column, metrics), y: qubitY(cell.qubit, metrics) }
}

/**
 * The rectangle a cell owns. Cells tile the plot exactly: the right edge of
 * one is the left edge of the next, and `pointToCell` assigns a shared edge
 * to the cell it opens, never to the one it closes.
 */
export function cellBounds(
  cell: Cell,
  metrics: GridMetrics = DEFAULT_METRICS
): Rect {
  return {
    x: metrics.padX + cell.column * metrics.columnWidth,
    y: metrics.padY + cell.qubit * metrics.rowHeight,
    width: metrics.columnWidth,
    height: metrics.rowHeight,
  }
}

/**
 * Rough advance of one character of the gate label font. Used only to widen
 * a box so a long symbol such as `iSWAP` is not clipped; an estimate is
 * enough because the result is clamped to the column and the label is
 * centred inside whatever comes out.
 */
const LABEL_CHAR_WIDTH = 8.5

/** The box a gate is drawn in, widened to fit a label of `labelLength`. */
export function gateBounds(
  cell: Cell,
  metrics: GridMetrics = DEFAULT_METRICS,
  labelLength = 1
): Rect {
  const width = Math.min(
    metrics.columnWidth - 8,
    Math.max(metrics.gateSize, labelLength * LABEL_CHAR_WIDTH + 14)
  )
  const centre = cellCenter(cell, metrics)
  return {
    x: centre.x - width / 2,
    y: centre.y - metrics.gateSize / 2,
    width,
    height: metrics.gateSize,
  }
}

/**
 * The cell under a point, or `null` when the point is outside the grid —
 * in the padding, past the last column, or on the classical wire.
 *
 * This is the inverse of `cellCenter`, and `geometry.test.ts` proves it over
 * every cell of several grids rather than over a handful of samples.
 */
export function pointToCell(
  point: Point,
  size: GridSize,
  metrics: GridMetrics = DEFAULT_METRICS
): Cell | null {
  const column = Math.floor((point.x - metrics.padX) / metrics.columnWidth)
  const qubit = Math.floor((point.y - metrics.padY) / metrics.rowHeight)
  if (column < 0 || column >= size.columns) return null
  if (qubit < 0 || qubit >= size.qubits) return null
  return { qubit, column }
}

/**
 * The closest cell to a point, clamped into the grid. This is what a drag
 * wants: a pointer that strays into the padding still has an obvious
 * intended destination, and refusing to snap there would make the last row
 * and the last column feel unreachable.
 */
export function nearestCell(
  point: Point,
  size: GridSize,
  metrics: GridMetrics = DEFAULT_METRICS
): Cell {
  const column = Math.floor((point.x - metrics.padX) / metrics.columnWidth)
  const qubit = Math.floor((point.y - metrics.padY) / metrics.rowHeight)
  return {
    qubit: clamp(qubit, 0, size.qubits - 1),
    column: clamp(column, 0, size.columns - 1),
  }
}

export function plotWidth(
  size: GridSize,
  metrics: GridMetrics = DEFAULT_METRICS
): number {
  return metrics.padX * 2 + size.columns * metrics.columnWidth
}

export function plotHeight(
  size: GridSize,
  metrics: GridMetrics = DEFAULT_METRICS
): number {
  const register = size.clbits > 0 ? metrics.registerGap + metrics.rowHeight : 0
  return metrics.padY * 2 + size.qubits * metrics.rowHeight + register
}

function clamp(value: number, low: number, high: number): number {
  return Math.min(high, Math.max(low, value))
}
