/**
 * One cell of the editable grid.
 *
 * The cell is a `<div role="gridcell">` sitting exactly on top of the square
 * the SVG drew, at the coordinates `geometry.ts` computed for both. It is
 * the editor's whole interactive surface: the focus target, the drop target,
 * and the handle an already-placed gate is dragged by. Making it one element
 * rather than three is what guarantees that what you can see, what you can
 * focus and what you can drop on are the same square.
 *
 * There are two variants because dnd-kit's hooks may only run inside a
 * `DndContext`, and the canvas is also rendered outside one — a preview, an
 * embed, the landing page. React forbids calling a hook conditionally, so
 * the condition is expressed as a choice of component instead, made once by
 * `CircuitCanvas`.
 *
 * `DndCell` registers a draggable even for an empty cell, disabled. Keeping
 * the hook count fixed avoids remounting the cell the instant a gate lands
 * on it — and a remount at that moment would drop keyboard focus, which is
 * exactly where the user's attention is.
 */

import { useDraggable, useDroppable } from '@dnd-kit/core'
import {
  useCallback,
  useEffect,
  useRef,
  type CSSProperties,
  type ReactNode,
} from 'react'

import type { Cell } from './geometry'

export interface GridCellProps {
  readonly cell: Cell
  /** Horizontal placement inside the row, from `cellBounds`. */
  readonly left: number
  readonly width: number
  /** Set when an operation occupies this cell; it is then draggable. */
  readonly operationId?: string
  readonly selected?: boolean
  /** The keyboard cursor is here. */
  readonly focused?: boolean
  /** The cursor should pull DOM focus, not merely be marked. */
  readonly autoFocus?: boolean
  /** This wire is already claimed by a half-finished multi-qubit placement. */
  readonly claimed?: boolean
  /** This column is the one a half-finished placement is waiting in. */
  readonly awaiting?: boolean
  /** Accessible name for a cell with nothing in it. */
  readonly emptyLabel: string
  /**
   * The cell's own contents already name it, so `emptyLabel` is withheld.
   * Set for a register cell that records a measurement: its text *is* the
   * description, and an `aria-label` beside it would silence that text.
   */
  readonly named?: boolean
  /** Draws the register row's muted treatment; see `ReadonlyCell`. */
  readonly readOnly?: boolean
  /**
   * What a screen reader calls an occupied cell's drag handle. dnd-kit's own
   * default is the English word "draggable"; D2 does not stop at strings we
   * wrote ourselves, so the translated one is passed in.
   */
  readonly dragRoleDescription?: string
  readonly onFocusCell?: (cell: Cell) => void
  readonly onActivate?: (cell: Cell) => void
  readonly children?: ReactNode
}

/** dnd-kit identifiers. Kept here so both ends of a drop agree on them. */
function dropIdOf(cell: Cell): string {
  return `cell:${cell.qubit}:${cell.column}`
}

function dragIdOf(cell: Cell): string {
  return `grab:${cell.qubit}:${cell.column}`
}

/** The cell outside a `DndContext`: readable and focusable, never a target. */
export function PlainCell(props: GridCellProps) {
  const ref = useCursorFocus<HTMLDivElement>(
    props.focused ?? false,
    props.autoFocus ?? false
  )
  return (
    <div {...cellAttributes(props)} ref={ref}>
      {props.children}
    </div>
  )
}

/**
 * A cell of the classical register row: reachable, readable, never editable.
 *
 * It carries the same roving `tabIndex` and the same cursor class as every
 * other cell, because the ARIA grid pattern reaches every cell with the arrow
 * keys and `aria-readonly` says "you cannot change this", not "you cannot
 * come here". What it does not carry is dnd-kit: nothing is ever dropped on
 * the register — a measurement reaches it from its own qubit — which is the
 * same ruling `pointToCell` makes by returning `null` for this band.
 *
 * `onActivate` is still wired, so Enter here answers with a sentence instead
 * of doing nothing; the refusal lives in `useKeyboardGrid`.
 */
export function ReadonlyCell(props: GridCellProps) {
  const ref = useCursorFocus<HTMLSpanElement>(
    props.focused ?? false,
    props.autoFocus ?? false
  )
  return (
    <span {...cellAttributes(props)} aria-readonly="true" ref={ref}>
      {props.children}
    </span>
  )
}

export function DndCell(props: GridCellProps) {
  const { cell, operationId } = props
  const focusRef = useCursorFocus<HTMLDivElement>(
    props.focused ?? false,
    props.autoFocus ?? false
  )

  const { setNodeRef: setDropRef, isOver } = useDroppable({
    id: dropIdOf(cell),
    data: { cell },
  })
  const {
    setNodeRef: setDragRef,
    attributes,
    listeners,
    isDragging,
  } = useDraggable({
    id: dragIdOf(cell),
    disabled: operationId === undefined,
    data:
      operationId === undefined
        ? undefined
        : { kind: 'operation', id: operationId, grabbedQubit: cell.qubit },
  })

  const setRef = useCallback(
    (node: HTMLDivElement | null) => {
      focusRef.current = node
      setDropRef(node)
      setDragRef(node)
    },
    [focusRef, setDragRef, setDropRef]
  )

  // Only the two attributes worth keeping are taken from dnd-kit: the id of
  // its screen-reader instructions, and the disabled state. Its `role`,
  // `tabIndex` and English `aria-roledescription` are all wrong for a cell
  // inside a grid with roving focus, and spreading them wholesale would
  // quietly reintroduce them.
  const draggable = operationId !== undefined
  return (
    <div
      {...listeners}
      {...cellAttributes(props, { over: isOver, dragging: isDragging })}
      aria-describedby={draggable ? attributes['aria-describedby'] : undefined}
      aria-roledescription={draggable ? props.dragRoleDescription : undefined}
      ref={setRef}
    >
      {props.children}
    </div>
  )
}

interface CellFlags {
  readonly over?: boolean
  readonly dragging?: boolean
}

function cellAttributes(props: GridCellProps, flags: CellFlags = {}) {
  const { cell, left, width, operationId, emptyLabel } = props
  const style: CSSProperties = { left, width }

  const className = [
    'circuit-canvas__cell',
    props.readOnly ? 'circuit-canvas__cell--readonly' : null,
    operationId === undefined ? null : 'circuit-canvas__cell--occupied',
    props.selected ? 'circuit-canvas__cell--selected' : null,
    props.focused ? 'circuit-canvas__cell--cursor' : null,
    props.claimed ? 'circuit-canvas__cell--claimed' : null,
    props.awaiting ? 'circuit-canvas__cell--awaiting' : null,
    flags.over ? 'circuit-canvas__cell--over' : null,
    flags.dragging ? 'circuit-canvas__cell--dragging' : null,
  ]
    .filter((token) => token !== null)
    .join(' ')

  return {
    role: 'gridcell' as const,
    className,
    style,
    tabIndex: props.focused ? 0 : -1,
    // An empty cell has no text, and a keyboard user who lands on a nameless
    // cell hears nothing at all. The name is an attribute rather than hidden
    // text so the cell's *contents* stay the only description of a gate.
    ...(operationId === undefined && props.named !== true
      ? { 'aria-label': emptyLabel }
      : {}),
    ...(props.selected === true ? { 'aria-selected': true } : {}),
    onClick: () => props.onActivate?.(cell),
    onFocus: () => props.onFocusCell?.(cell),
  }
}

/**
 * Moves DOM focus to the cell the cursor just reached, and brings it into
 * view where the user can actually see it.
 *
 * `autoFocus` is what keeps this from stealing focus on arrival: it is false
 * until the user has actually touched the grid, so a page that merely
 * contains an editor does not rip focus away from the address bar.
 */
// Generic in the element: the register row's cells are spans and every other
// cell is a div, and they claim the cursor by exactly the same rule.
function useCursorFocus<T extends HTMLElement>(
  focused: boolean,
  autoFocus: boolean
) {
  const node = useRef<T | null>(null)
  useEffect(() => {
    const cell = node.current
    if (!focused || !autoFocus || cell === null) return
    // The browser's own focus scroll is declined because it measures against
    // the scrollport, and the scrollport reaches under the sticky gutter —
    // see `revealCell`.
    cell.focus({ preventScroll: true })
    revealCell(cell)
  }, [focused, autoFocus])
  return node
}

/*
 * The canvas's scroller and the pinned gutter inside it. Named here because
 * the cell is the only thing that knows when it has just become the cursor,
 * and it has to ask its own scroller to make room.
 */
const VIEWPORT = '.circuit-canvas__viewport'
const GUTTER = '.circuit-canvas__gutter'

/**
 * Scrolls the canvas so the cursor cell is fully visible — clear of the
 * sticky wire gutter, not merely inside the scrollport.
 *
 * The distinction is the whole point. The gutter is `position: sticky` and
 * opaque, so it paints over the leftmost ~104px of the scroller. A cell that
 * has scrolled into that band is, as far as the browser is concerned, "in
 * view": the implicit scroll that comes with `focus()` sees no reason to
 * move, and the cell — with its accent focus ring — is invisible behind the
 * gutter for the two columns in its shadow. WCAG 2.2 SC 2.4.11 (Focus Not
 * Obscured) is explicit that author content may not entirely hide a focused
 * component, and §10 asks for a visible keyboard focus in the first place.
 *
 * So the obstruction is measured rather than assumed — the gutter's width is
 * a rem value in the stylesheet and reading it back keeps the two from
 * drifting — and the scroll is applied directly. `scrollLeft`/`scrollTop`
 * rather than `scrollBy`: it is instant, which is what a cursor stepping one
 * cell per keypress wants, and it is honest under `prefers-reduced-motion`.
 */
function revealCell(cell: HTMLElement): void {
  const viewport = cell.closest<HTMLElement>(VIEWPORT)
  if (viewport === null) return

  const cellBox = cell.getBoundingClientRect()
  // jsdom reports every rectangle as zero, and so does a canvas that is not
  // laid out yet. Scrolling by a difference of zeroes would be harmless, but
  // bailing out says plainly that there is nothing to measure.
  if (cellBox.width === 0 && cellBox.height === 0) return

  const viewBox = viewport.getBoundingClientRect()
  const blocked = viewport.querySelector<HTMLElement>(GUTTER)?.offsetWidth ?? 0
  const left = viewBox.left + blocked

  let dx = 0
  if (cellBox.left < left) dx = cellBox.left - left
  else if (cellBox.right > viewBox.right) dx = cellBox.right - viewBox.right

  let dy = 0
  if (cellBox.top < viewBox.top) dy = cellBox.top - viewBox.top
  else if (cellBox.bottom > viewBox.bottom) dy = cellBox.bottom - viewBox.bottom

  if (dx !== 0) viewport.scrollLeft += dx
  if (dy !== 0) viewport.scrollTop += dy
}
