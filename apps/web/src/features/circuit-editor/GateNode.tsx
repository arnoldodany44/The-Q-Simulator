/**
 * One operation, drawn.
 *
 * The renderer is compositional rather than a switch over gate names: an
 * operation is a vertical link, zero or more control dots, and a glyph on
 * each target. Toffoli is then "the CNOT target with two dots" and Fredkin
 * is "the SWAP crosses with one dot", both for free, and a custom gate that
 * the catalog has never heard of still comes out as a labelled box on its
 * targets. A per-gate switch would need a new branch for each of those.
 *
 * Two distinctions carry meaning and are drawn to be unmistakable rather
 * than merely different:
 *
 *  - A **negative control** is a hollow ring, not a paler dot. It inverts
 *    when the gate fires, so a reader who misses it misreads the circuit;
 *    filled versus outlined survives a bad monitor, colour blindness and a
 *    screenshot scaled to a third of its size, and a shade does not.
 *  - The **classical link** is a double line, the convention that separates
 *    "this qubit is entangled with that one" from "this bit was written by
 *    a measurement", which are not remotely the same claim.
 *
 * Everything here is presentational and `aria-hidden` by way of its parent
 * SVG; the accessible account of the same operation is built in
 * `CircuitCanvas` from `describeQubitCell`, which reads the roles from the
 * same module this file draws from.
 */

import { controlsOf, type Circuit, type Operation } from '@qsim/schema'

import { NotationText } from '../../components/Notation'
import {
  DEFAULT_METRICS,
  classicalY,
  columnX,
  gateBounds,
  qubitY,
  type GridMetrics,
  type GridSize,
} from './geometry'
import {
  boxLabel,
  clbitLabel,
  paramLabel,
  targetShape,
  touchesRegister,
} from './operationRoles'

const CONTROL_RADIUS = 6
const NEGATIVE_CONTROL_RADIUS = 6.5
const PLUS_RADIUS = 11
const SWAP_ARM = 7
const METER_RADIUS = 9
/**
 * Where the `i` of an iSWAP sits relative to the crossing point: up and to the
 * right, in the quadrant the two arms leave empty. A mark rather than a colour
 * or a thicker stroke, so it survives a screenshot, a grayscale printer and a
 * reader who cannot see the difference between two blues (§10).
 */
const ISWAP_MARK_OFFSET = { x: 10, y: -9 } as const
/** Distance from the centre of a gate box down to its parameter label. */
const PARAM_LABEL_OFFSET = 24
/** The mark that says "this crossing is an iSWAP". Notation, so D2 leaves it. */
const ISWAP_MARK = 'i'
/** Half the gap between the two strands of a classical link. */
const CLASSICAL_SPACING = 2.5

export interface GateNodeProps {
  readonly circuit: Circuit
  readonly operation: Operation
  readonly size: GridSize
  readonly metrics?: GridMetrics
  readonly selected?: boolean
}

export function GateNode({
  circuit,
  operation,
  size,
  metrics = DEFAULT_METRICS,
  selected = false,
}: GateNodeProps) {
  const x = columnX(operation.column, metrics)
  const controls = controlsOf(operation)
  const shape = targetShape(operation.gate)

  const wireYs = [
    ...operation.targets.map((qubit) => qubitY(qubit, metrics)),
    ...controls.map((control) => qubitY(control.qubit, metrics)),
  ]
  const top = Math.min(...wireYs)
  const quantumBottom = Math.max(...wireYs)
  const reachesRegister = touchesRegister(operation) && size.clbits > 0
  const registerY = classicalY(size, metrics)
  const bottom = reachesRegister ? registerY : quantumBottom

  const className = selected ? 'qsim-op qsim-op--selected' : 'qsim-op'

  if (shape === 'barrier') {
    // A barrier is not a gate and gets no link and no box: it is a fence
    // across the moment, and the dashes are what say "nothing happens here".
    return (
      <g className={className} data-operation-id={operation.id}>
        {selected ? (
          <SelectionHalo
            x={x}
            top={top}
            bottom={quantumBottom}
            metrics={metrics}
          />
        ) : null}
        <line
          className="qsim-barrier"
          x1={x}
          x2={x}
          y1={top - metrics.rowHeight * 0.45}
          y2={quantumBottom + metrics.rowHeight * 0.45}
        />
      </g>
    )
  }

  return (
    <g className={className} data-operation-id={operation.id}>
      {selected ? (
        <SelectionHalo x={x} top={top} bottom={bottom} metrics={metrics} />
      ) : null}

      {quantumBottom > top ? (
        <line className="qsim-link" x1={x} x2={x} y1={top} y2={quantumBottom} />
      ) : null}

      {reachesRegister ? (
        <ClassicalLink
          x={x}
          from={quantumBottom}
          to={registerY}
          operation={operation}
        />
      ) : null}

      {controls.map((control) => (
        <ControlDot
          key={control.qubit}
          x={x}
          y={qubitY(control.qubit, metrics)}
          negative={control.state === 0}
        />
      ))}

      {operation.targets.map((qubit) => (
        <TargetGlyph
          key={qubit}
          x={x}
          y={qubitY(qubit, metrics)}
          shape={shape}
          label={boxLabel(operation.gate, circuit)}
          /*
           * The angles, drawn. Without them `Rz(π/2)` and `Rz(0,1235)` are the
           * same picture — which is a gate a reader cannot identify on the
           * canvas and two different circuits with identical bytes once the
           * drawing is exported. See `paramLabel`.
           */
          params={paramLabel(operation)}
          cell={{ qubit, column: operation.column }}
          metrics={metrics}
        />
      ))}
    </g>
  )
}

function ControlDot({
  x,
  y,
  negative,
}: {
  x: number
  y: number
  negative: boolean
}) {
  return (
    <circle
      className={
        negative ? 'qsim-control qsim-control--negative' : 'qsim-control'
      }
      cx={x}
      cy={y}
      r={negative ? NEGATIVE_CONTROL_RADIUS : CONTROL_RADIUS}
    />
  )
}

function TargetGlyph({
  x,
  y,
  shape,
  label,
  params,
  cell,
  metrics,
}: {
  x: number
  y: number
  shape: ReturnType<typeof targetShape>
  label: string
  /** The angles under the box, already formatted. `''` for a gate with none. */
  params: string
  cell: { qubit: number; column: number }
  metrics: GridMetrics
}) {
  if (shape === 'plus') {
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

  if (shape === 'cross' || shape === 'cross-i') {
    return (
      <g className="qsim-target">
        <line
          className="qsim-swap"
          x1={x - SWAP_ARM}
          y1={y - SWAP_ARM}
          x2={x + SWAP_ARM}
          y2={y + SWAP_ARM}
        />
        <line
          className="qsim-swap"
          x1={x - SWAP_ARM}
          y1={y + SWAP_ARM}
          x2={x + SWAP_ARM}
          y2={y - SWAP_ARM}
        />
        {/*
         * The one mark that separates an iSWAP from a SWAP. Without it the two
         * gates drew the same picture — identical strings out of
         * `circuitToSvg` and identical pixels out of the rasteriser — and they
         * are not the same unitary.
         */}
        {shape === 'cross-i' ? (
          <NotationText
            className="qsim-swap__mark"
            value={ISWAP_MARK}
            x={x + ISWAP_MARK_OFFSET.x}
            y={y + ISWAP_MARK_OFFSET.y}
          />
        ) : null}
      </g>
    )
  }

  const box = gateBounds(cell, metrics, shape === 'meter' ? 1 : label.length)

  if (shape === 'meter') {
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
        <path
          className="qsim-meter"
          d={`M ${x - METER_RADIUS} ${y + 5} A ${METER_RADIUS} ${METER_RADIUS} 0 0 1 ${x + METER_RADIUS} ${y + 5}`}
        />
        <line
          className="qsim-meter"
          x1={x}
          y1={y + 5}
          x2={x + METER_RADIUS - 2}
          y2={y - METER_RADIUS + 2}
        />
      </g>
    )
  }

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
      <NotationText className="qsim-box__label" value={label} x={x} y={y} />
      {/*
       * Below the box rather than inside it. `gateBounds` clamps a box to the
       * column width, so `Rz(π/2)` inside one would be clipped at the very
       * width the grid depends on; beneath it there is a row's worth of space
       * and the label is the only thing in it.
       */}
      {params === '' ? null : (
        <NotationText
          className="qsim-box__param"
          value={params}
          x={x}
          y={y + PARAM_LABEL_OFFSET}
        />
      )}
    </g>
  )
}

/**
 * The double line down to the classical register, plus the marker that says
 * which direction the information travelled: an arrowhead for a measurement
 * writing into the register, a dot and the tested value for an operation
 * reading a condition out of it.
 */
function ClassicalLink({
  x,
  from,
  to,
  operation,
}: {
  x: number
  from: number
  to: number
  operation: Operation
}) {
  const clbits = operation.clbitTargets ?? []
  const condition = operation.condition
  return (
    <g className="qsim-classical-link">
      <line
        className="qsim-link qsim-link--classical"
        x1={x - CLASSICAL_SPACING}
        x2={x - CLASSICAL_SPACING}
        y1={from}
        y2={to}
      />
      <line
        className="qsim-link qsim-link--classical"
        x1={x + CLASSICAL_SPACING}
        x2={x + CLASSICAL_SPACING}
        y1={from}
        y2={to}
      />
      {clbits.length > 0 ? (
        <>
          <path
            className="qsim-classical-arrow"
            d={`M ${x - 5} ${to - 7} L ${x + 5} ${to - 7} L ${x} ${to} Z`}
          />
          <NotationText
            className="qsim-register-label"
            value={clbits.map(clbitLabel).join(', ')}
            x={x + 16}
            y={to + 12}
          />
        </>
      ) : null}
      {condition !== undefined ? (
        <>
          <circle className="qsim-condition" cx={x} cy={to} r={5} />
          <NotationText
            className="qsim-register-label"
            value={`${clbitLabel(condition.clbit)} = ${condition.equals}`}
            x={x + 22}
            y={to + 12}
          />
        </>
      ) : null}
    </g>
  )
}

function SelectionHalo({
  x,
  top,
  bottom,
  metrics,
}: {
  x: number
  top: number
  bottom: number
  metrics: GridMetrics
}) {
  return (
    <rect
      className="qsim-op__halo"
      x={x - metrics.columnWidth / 2 + 3}
      y={top - metrics.rowHeight / 2 + 3}
      width={metrics.columnWidth - 6}
      height={bottom - top + metrics.rowHeight - 6}
      rx={6}
    />
  )
}
