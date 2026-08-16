/**
 * The drawing itself: wires, and a shape for every operation on them.
 *
 * It was extracted out of `CircuitCanvas` in M1.7 so that there is exactly one
 * renderer of a circuit diagram in this project. The canvas puts it inside an
 * interactive, `aria-hidden` `<svg>` with a grid overlay on top; the SVG and
 * PNG exports (`features/export/diagram.ts`) put the same element inside a
 * standalone `<svg>` with its own stylesheet. Drawing the export a second way
 * would mean two files to change every time a glyph changes, and the second
 * one would be the one nobody looked at — an exported diagram that quietly
 * stopped matching the editor is worse than no export.
 *
 * What is deliberately *not* here: the playhead band of the timeline scrubber,
 * the selection halo's meaning, and everything in the grid overlay. Those are
 * states of the editor rather than parts of the diagram, and a downloaded file
 * showing where somebody's cursor was would be a puzzle to the person who
 * receives it. Selection is passed through all the same, because the canvas
 * needs it; the exporter simply does not pass one.
 *
 * It renders a fragment rather than an `<svg>` so that both callers own their
 * own root element, with the attributes their context needs.
 */

import { type Circuit } from '@qsim/schema'

import { GateNode } from './GateNode'
import { ClassicalWire, QubitWire } from './QubitWire'
import { DEFAULT_METRICS, type GridMetrics, type GridSize } from './geometry'

const NO_SELECTION: readonly string[] = []

export interface CircuitPlotProps {
  readonly circuit: Circuit
  /** How much grid to draw — from `gridSizeOf`, not from the circuit alone. */
  readonly size: GridSize
  /** Width of the plot in user units, which is how long a wire is. */
  readonly width: number
  readonly metrics?: GridMetrics
  /** Ids of the operations drawn as selected. Empty for an export. */
  readonly selection?: readonly string[]
}

export function CircuitPlot({
  circuit,
  size,
  width,
  metrics = DEFAULT_METRICS,
  selection = NO_SELECTION,
}: CircuitPlotProps) {
  const selected = new Set(selection)
  return (
    <>
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
    </>
  )
}

function range(length: number): number[] {
  return Array.from({ length }, (_, index) => index)
}
