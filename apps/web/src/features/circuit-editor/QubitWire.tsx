/**
 * One wire, in its two halves.
 *
 * A wire is drawn in two places that scroll independently: the line itself
 * lives in the SVG plot, which scrolls horizontally as the circuit grows,
 * while its name and its row controls live in a gutter pinned to the left
 * edge. Splitting them is what keeps the labels readable at column 40 —
 * a name that scrolls off is a name that stops naming anything.
 *
 * The two halves stay aligned because both derive their vertical position
 * from `qubitY`: the gutter rows are absolutely positioned at the same
 * coordinates the SVG uses, so alignment is arithmetic rather than a stack
 * of matching CSS heights that drift the first time a padding changes.
 *
 * The gutter labels are `aria-hidden`. They would otherwise be the second
 * place a screen reader hears "q0", the first being the row header of the
 * ARIA grid in `CircuitCanvas` — see that file's header for why the grid is
 * the canvas's accessible surface. The row *buttons* stay in the tree:
 * hiding them would hide the only way to resize either register, and
 * focusable content inside an `aria-hidden` subtree is a trap rather than a
 * simplification, which is why the attribute sits on the labels and not on
 * the gutter.
 */

import { Notation, NotationText } from '../../components/Notation'
import {
  DEFAULT_METRICS,
  classicalY,
  qubitY,
  type GridMetrics,
  type GridSize,
} from './geometry'

/** Vertical half-distance between the two strands of the classical wire. */
const CLASSICAL_SPACING = 2.5

export function QubitWire({
  qubit,
  width,
  metrics = DEFAULT_METRICS,
}: {
  qubit: number
  width: number
  metrics?: GridMetrics
}) {
  const y = qubitY(qubit, metrics)
  return <line className="qsim-wire" x1={0} x2={width} y1={y} y2={y} />
}

/**
 * The classical register: one double line for the whole register, with a
 * slash carrying its width. Drawing sixty-four separate classical wires
 * would be honest and unreadable; the slash-and-count is the notation the
 * literature already uses for exactly this problem.
 */
export function ClassicalWire({
  size,
  width,
  metrics = DEFAULT_METRICS,
}: {
  size: GridSize
  width: number
  metrics?: GridMetrics
}) {
  const y = classicalY(size, metrics)
  const slashX = metrics.padX * 0.6
  return (
    <g className="qsim-wire-group">
      <line
        className="qsim-wire qsim-wire--classical"
        x1={0}
        x2={width}
        y1={y - CLASSICAL_SPACING}
        y2={y - CLASSICAL_SPACING}
      />
      <line
        className="qsim-wire qsim-wire--classical"
        x1={0}
        x2={width}
        y1={y + CLASSICAL_SPACING}
        y2={y + CLASSICAL_SPACING}
      />
      <line
        className="qsim-wire qsim-wire--slash"
        x1={slashX - 5}
        x2={slashX + 5}
        y1={y + 7}
        y2={y - 7}
      />
      <NotationText
        className="qsim-register-label"
        value={String(size.clbits)}
        x={slashX + 10}
        y={y - 10}
      />
    </g>
  )
}

/**
 * The gutter entry for one qubit: its name and the controls that act on the
 * whole row. The controls are omitted rather than disabled when the editor
 * is read-only — a disabled button on a touch screen is a target that
 * teaches the user nothing, and below 768px the row is genuinely not
 * editable (specification §10 and risk 6).
 */
export function QubitRowHeader({
  label,
  index,
  metrics = DEFAULT_METRICS,
  removeLabel,
  insertLabel,
  onRemove,
  onInsertBelow,
}: {
  label: string
  index: number
  metrics?: GridMetrics
  removeLabel: string
  insertLabel: string
  onRemove?: (index: number) => void
  onInsertBelow?: (index: number) => void
}) {
  return (
    <div
      className="circuit-canvas__row"
      style={{
        top: qubitY(index, metrics) - metrics.rowHeight / 2,
        height: metrics.rowHeight,
      }}
    >
      <span className="circuit-canvas__wire-label" aria-hidden="true">
        <Notation value={label} />
      </span>
      {(onRemove ?? onInsertBelow) ? (
        <span className="circuit-canvas__row-actions">
          {onInsertBelow ? (
            <button
              type="button"
              className="circuit-canvas__row-button"
              aria-label={insertLabel}
              onClick={() => {
                onInsertBelow(index)
              }}
            >
              <InsertIcon />
            </button>
          ) : null}
          {onRemove ? (
            <button
              type="button"
              className="circuit-canvas__row-button"
              // The canvas finds this button again after the row it belonged
              // to is gone, to hand focus to the row that took its place —
              // see the `reclaim` effect in `CircuitCanvas`.
              data-row-remove=""
              aria-label={removeLabel}
              onClick={() => {
                onRemove(index)
              }}
            >
              <RemoveIcon />
            </button>
          ) : null}
        </span>
      ) : null}
    </div>
  )
}

/**
 * The gutter entry for the classical register: its name and the two controls
 * that resize it, mirroring `QubitRowHeader`.
 *
 * The register needs its own controls because it is not a pure function of
 * the qubit count. `addQubit` grows it while the two registers are in step,
 * which covers the ordinary path, but a loaded document may arrive with a
 * narrower one and a user may want to shrink it deliberately — and without a
 * control, a wire past the end of the register could never be measured while
 * the refusal cheerfully advised adding a classical bit.
 *
 * Only the last bit can be removed. `removeClbit` cascades, deleting every
 * operation that writes to or is conditioned on the bit that goes, exactly
 * as `removeQubit` does for a wire; "shrink from the end" is the only shrink
 * whose effect a user can predict from looking at the canvas. The caller
 * withholds the remove control at one bit, because the gutter draws this row
 * only while the register has width — reaching zero would take the add
 * control away with it.
 */
export function ClassicalRowHeader({
  size,
  metrics = DEFAULT_METRICS,
  addLabel,
  removeLabel,
  onAdd,
  onRemove,
}: {
  size: GridSize
  metrics?: GridMetrics
  addLabel: string
  removeLabel: string
  onAdd?: () => void
  onRemove?: () => void
}) {
  return (
    <div
      className="circuit-canvas__row circuit-canvas__row--classical"
      style={{
        top: classicalY(size, metrics) - metrics.rowHeight / 2,
        height: metrics.rowHeight,
      }}
    >
      <span className="circuit-canvas__wire-label" aria-hidden="true">
        <Notation value="c" />
      </span>
      {(onAdd ?? onRemove) ? (
        <span className="circuit-canvas__row-actions">
          {onAdd ? (
            <button
              type="button"
              className="circuit-canvas__row-button"
              data-register-add=""
              aria-label={addLabel}
              onClick={onAdd}
            >
              <InsertIcon />
            </button>
          ) : null}
          {onRemove ? (
            <button
              type="button"
              className="circuit-canvas__row-button"
              // Retires at one bit, so the press that removes the last one
              // removes this button too; the canvas hands focus on from here.
              data-register-remove=""
              aria-label={removeLabel}
              onClick={onRemove}
            >
              <RemoveIcon />
            </button>
          ) : null}
        </span>
      ) : null}
    </div>
  )
}

/*
 * The icons are drawn rather than lettered: `+` and `×` as text would be
 * user-facing literals that the i18next lint rule is right to reject, and
 * routing punctuation through `Notation` would stretch that component past
 * what it means.
 */

function InsertIcon() {
  return (
    <svg
      viewBox="0 0 16 16"
      aria-hidden="true"
      focusable="false"
      width="12"
      height="12"
    >
      <path d="M8 3v10M3 8h10" />
    </svg>
  )
}

function RemoveIcon() {
  return (
    <svg
      viewBox="0 0 16 16"
      aria-hidden="true"
      focusable="false"
      width="12"
      height="12"
    >
      <path d="M4 4l8 8M12 4l-8 8" />
    </svg>
  )
}
