/**
 * The landing page's circuit, drawn.
 *
 * ────────────────────────────────────────────────────────────────────────
 * WHY THIS IS NOT `CircuitCanvas`.
 *
 * The editor's canvas is the right renderer for a circuit somebody is editing:
 * it carries an ARIA grid, a keyboard cursor, dnd-kit drop targets, a sticky
 * gutter and a link to the document store. Every one of those is machinery the
 * landing page does not use — and importing it would drag dnd-kit, Zustand,
 * Zundo and Zod into the one route that has to load before a stranger loses
 * interest (M0.9b: the landing must not carry the editor's bundle). What is
 * left after removing all of it is this file: four shapes and a coordinate.
 *
 * It is not a *second* coordinate system, which is the part that would
 * actually be worth avoiding. Every position here comes from
 * `circuit-editor/geometry.ts` — the module the editor draws from and hit-tests
 * against — and every mark wears the same `qsim-*` class the editor's own
 * gates wear, so the wire weight, the control dot and the ⊕ are the same ink in
 * both places by construction. A reader who clicks through from this diagram
 * into the editor sees the drawing they were just looking at.
 *
 * The glyph table below covers exactly the two gates the four stages use.
 * `DemoDiagram.test.tsx` checks its symbol against `@qsim/schema`'s catalog, so
 * a gate renamed there fails here rather than drawing the wrong letter.
 *
 * ────────────────────────────────────────────────────────────────────────
 * IT SAYS NOTHING, ON PURPOSE.
 *
 * `aria-hidden`, exactly like the editor's plot and the histogram's SVG. The
 * words describing this circuit are `LiveDemo`'s job: it prints the stage's
 * own sentence — `demo.stages.<id>.circuit` — as a visible `<figcaption>`,
 * which is real text and is announced like any other. Visible rather than
 * hidden because a reader who *can* see the diagram still benefits from being
 * told which gate is which the first time they meet one, and one rendering
 * rather than two because two would be a second thing to keep in step with the
 * drawing.
 */

import type { Circuit, Operation } from '@qsim/schema'

import { NotationText } from '../../components/Notation'
import {
  DEFAULT_METRICS,
  columnX,
  gateBounds,
  plotHeight,
  plotWidth,
  qubitY,
  type GridMetrics,
  type GridSize,
} from '../circuit-editor/geometry'
import { DEMO_COLUMNS, wireLabel } from './stages'

/** Copied from `GateNode`, which draws the same two shapes for the editor. */
const CONTROL_RADIUS = 6
const PLUS_RADIUS = 11

/**
 * The editor keeps wire names in an HTML gutter beside the plot, because its
 * plot scrolls and a name that scrolls away stops naming anything. This
 * diagram is 192px wide and never scrolls, so the names go inside the drawing
 * — which also keeps the figure a single element the page can centre.
 * `padX` is widened from the editor's 20 to make room for them.
 */
const DEMO_METRICS: GridMetrics = { ...DEFAULT_METRICS, padX: 40 }

/** Centre of the wire name, and where the wire itself starts, left of column 0. */
const LABEL_X = 16
const WIRE_START = 30

/**
 * The glyphs the four stages need.
 *
 * A one-qubit gate is a labelled box; a CNOT target is the ⊕ that says "this
 * wire flips". Both spellings are the editor's, and the reason `cx` carries no
 * symbol is that it has no letter: its notation *is* the circle and the cross.
 */
const DEMO_GLYPHS: Record<string, { readonly symbol: string | null }> = {
  h: { symbol: 'H' },
  cx: { symbol: null },
}

export interface DemoDiagramProps {
  readonly circuit: Circuit
}

export function DemoDiagram({ circuit }: DemoDiagramProps) {
  const size: GridSize = {
    qubits: circuit.qubits,
    clbits: 0,
    columns: DEMO_COLUMNS,
  }
  const width = plotWidth(size, DEMO_METRICS)
  const height = plotHeight(size, DEMO_METRICS)

  return (
    <svg
      className="demo__diagram"
      width={width}
      height={height}
      viewBox={`0 0 ${width} ${height}`}
      aria-hidden="true"
      focusable="false"
    >
      <g className="qsim-wires">
        {range(circuit.qubits).map((qubit) => (
          <g key={qubit}>
            <NotationText
              className="demo__wire-label"
              value={wireLabel(qubit)}
              x={LABEL_X}
              y={qubitY(qubit, DEMO_METRICS)}
            />
            <line
              className="qsim-wire"
              x1={WIRE_START}
              x2={width}
              y1={qubitY(qubit, DEMO_METRICS)}
              y2={qubitY(qubit, DEMO_METRICS)}
            />
          </g>
        ))}
      </g>

      <g className="qsim-operations">
        {circuit.operations.map((operation) => (
          <DemoGate key={operation.id} operation={operation} />
        ))}
      </g>
    </svg>
  )
}

function DemoGate({ operation }: { readonly operation: Operation }) {
  const x = columnX(operation.column, DEMO_METRICS)
  const controls = controlQubits(operation)
  const symbol = DEMO_GLYPHS[operation.gate]?.symbol ?? null

  const wireYs = [...operation.targets, ...controls].map((qubit) =>
    qubitY(qubit, DEMO_METRICS)
  )
  const top = Math.min(...wireYs)
  const bottom = Math.max(...wireYs)

  return (
    <g className="qsim-op">
      {bottom > top ? (
        <line className="qsim-link" x1={x} x2={x} y1={top} y2={bottom} />
      ) : null}

      {controls.map((qubit) => (
        <circle
          key={qubit}
          className="qsim-control"
          cx={x}
          cy={qubitY(qubit, DEMO_METRICS)}
          r={CONTROL_RADIUS}
        />
      ))}

      {operation.targets.map((qubit) =>
        symbol === null ? (
          <PlusTarget key={qubit} x={x} y={qubitY(qubit, DEMO_METRICS)} />
        ) : (
          <BoxTarget
            key={qubit}
            x={x}
            qubit={qubit}
            column={operation.column}
            symbol={symbol}
          />
        )
      )}
    </g>
  )
}

/** The ⊕ of a CNOT target: a ring with a cross through it. */
function PlusTarget({ x, y }: { readonly x: number; readonly y: number }) {
  return (
    <g className="qsim-target">
      <circle className="qsim-plus" cx={x} cy={y} r={PLUS_RADIUS} />
      <line
        className="qsim-plus__arm"
        x1={x - PLUS_RADIUS}
        x2={x + PLUS_RADIUS}
        y1={y}
        y2={y}
      />
      <line
        className="qsim-plus__arm"
        x1={x}
        x2={x}
        y1={y - PLUS_RADIUS}
        y2={y + PLUS_RADIUS}
      />
    </g>
  )
}

/** A one-qubit gate: its letter in a box, sized by `gateBounds` as usual. */
function BoxTarget({
  x,
  qubit,
  column,
  symbol,
}: {
  readonly x: number
  readonly qubit: number
  readonly column: number
  readonly symbol: string
}) {
  const box = gateBounds({ qubit, column }, DEMO_METRICS, symbol.length)
  return (
    <g className="qsim-target">
      <rect
        className="qsim-box"
        x={box.x}
        y={box.y}
        width={box.width}
        height={box.height}
        rx={4}
      />
      <NotationText
        className="qsim-box__label"
        value={symbol}
        x={x}
        y={qubitY(qubit, DEMO_METRICS)}
      />
    </g>
  )
}

/**
 * The control wires of an operation.
 *
 * `@qsim/schema` exports `controlsOf` for exactly this, and it is not imported
 * for the reason in the header: it is a *value*, so it would pull Zod into the
 * landing chunk. Both spellings the contract accepts are handled — a bare
 * index means `{ qubit, state: 1 }` — and the demo has no negative control, so
 * the state is never read.
 */
function controlQubits(operation: Operation): number[] {
  return (operation.controls ?? []).map((control) =>
    typeof control === 'number' ? control : control.qubit
  )
}

function range(length: number): number[] {
  return Array.from({ length }, (_, index) => index)
}
