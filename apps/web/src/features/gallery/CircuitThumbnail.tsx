/**
 * The little diagram on a gallery card — milestone M1.5b.
 *
 * ── It is the editor's coordinate system, at a smaller scale ──────────────
 *
 * Every position here comes from `circuit-editor/geometry.ts`, the module the
 * editor draws from and hit-tests against, and every mark wears the `qsim-*`
 * class the editor's own gates wear. So a reader who clicks a card and lands
 * in the editor sees the drawing they were just looking at, enlarged — not a
 * second rendering that happens to resemble the first.
 *
 * What changes is the metrics, and only the metrics: a smaller column width,
 * a smaller row height, a smaller box. `DemoDiagram` on the landing page makes
 * the same move for the same reason, and this file is deliberately its
 * sibling rather than a second answer to the same question.
 *
 * ── What it is NOT ───────────────────────────────────────────────────────
 *
 * It is not `CircuitCanvas`. That component carries an ARIA grid, a keyboard
 * cursor, dnd-kit drop targets, a sticky gutter and a link to the document
 * store — machinery for editing a circuit, none of which a card wants, and
 * importing it would put the whole editor bundle behind the gallery.
 *
 * It is also not the circuit. The payload it draws is `CircuitPreview`, which
 * @qsim/schema bounds to a handful of wires and columns and strips of
 * parameters, labels, classical links and control polarity — because none of
 * those survives being drawn at this size. See `previewOf` for the whole
 * argument.
 *
 * ── Why it says nothing ──────────────────────────────────────────────────
 *
 * `aria-hidden`, exactly like the editor's plot, the histogram's SVG and the
 * landing's diagram. A lossy picture must not be a screen reader's only
 * account of a circuit, and the card already states the facts it would be
 * summarising — the qubit count, the gate count, the depth — as real text
 * beside it. The full drawing, with every distinction this one drops, is one
 * link away.
 *
 * The truncation marker is drawn for the same honesty and read for the same
 * reason: a thumbnail of the first ten columns of a forty-column circuit says
 * so with an ellipsis at its edge, and the depth printed on the card says the
 * rest.
 */

/*
 * From @qsim/schema rather than @qsim/contract, though the card's `preview`
 * field is typed through the contract's copy of the same schema. The shape
 * belongs to the circuit format — it is derived from a document by `previewOf`
 * — and the contract merely carries it across the wire; importing it from
 * where it is defined keeps that direction visible.
 */
import type { CircuitPreview, PreviewOperation } from '@qsim/schema'

import { NotationText } from '../../components/Notation'
import { boxLabel, targetShape } from '../circuit-editor/gateGlyphs'
import {
  columnX,
  gateBounds,
  plotHeight,
  plotWidth,
  qubitY,
  type GridMetrics,
  type GridSize,
} from '../circuit-editor/geometry'

/**
 * The editor's metrics, scaled to a card.
 *
 * Halved rather than re-invented, and every value stays an integer with
 * `columnWidth` and `rowHeight` even — the property `geometry.ts` documents
 * for its own defaults, so cell centres land on exact halves. `padX` is
 * smaller than the editor's because there is no gutter to leave room for: a
 * thumbnail draws no wire names.
 */
const THUMBNAIL_METRICS: GridMetrics = {
  columnWidth: 22,
  rowHeight: 18,
  padX: 6,
  padY: 5,
  gateSize: 13,
  registerGap: 6,
}

/** Copied from `GateNode`, scaled with the metrics above. */
const CONTROL_RADIUS = 2.5
const PLUS_RADIUS = 4.5
const SWAP_ARM = 3

/** The mark that says the drawing stops before the circuit does. */
const CONTINUES = '…'

/** Longest gate symbol a 13-pixel box can hold without becoming a smear. */
const MAX_LABEL_CHARACTERS = 2

/**
 * What a measurement's box says here.
 *
 * The editor draws the meter's arc and needle; inside 13 pixels that is a
 * smudge, so the thumbnail spells the letter instead. It is notation in both
 * places — untranslated in all three languages (D2).
 */
const METER_LABEL = 'M'

export interface CircuitThumbnailProps {
  readonly preview: CircuitPreview
}

export function CircuitThumbnail({ preview }: CircuitThumbnailProps) {
  /*
   * `clbits: 0` always. A preview carries no classical register — measurement
   * targets are among the things `previewOf` drops — so declaring one would
   * make `plotHeight` reserve a band for a wire nothing is ever drawn on.
   */
  const size: GridSize = {
    qubits: preview.qubits,
    clbits: 0,
    // At least one column, so a circuit with nothing in it is still a card
    // with wires on it rather than a sliver.
    columns: Math.max(1, preview.columns),
  }
  const width = plotWidth(size, THUMBNAIL_METRICS)
  const height = plotHeight(size, THUMBNAIL_METRICS)

  return (
    <svg
      className="circuit-thumbnail"
      viewBox={`0 0 ${String(width)} ${String(height)}`}
      /*
       * Sized by CSS rather than by attributes, so the drawing fills whatever
       * the card gives it and a reader who zooms to 200% (WCAG 1.4.4) gets a
       * larger picture instead of the same pixels in a larger box.
       */
      preserveAspectRatio="xMinYMid meet"
      aria-hidden="true"
      focusable="false"
    >
      <g className="qsim-wires">
        {Array.from({ length: preview.qubits }, (_, qubit) => (
          <line
            key={qubit}
            className="qsim-wire"
            x1={0}
            x2={width}
            y1={qubitY(qubit, THUMBNAIL_METRICS)}
            y2={qubitY(qubit, THUMBNAIL_METRICS)}
          />
        ))}
      </g>

      <g className="qsim-operations">
        {preview.operations.map((operation, index) => (
          <ThumbnailGate
            /*
             * The index, because a preview operation has no id: `previewOf`
             * drops it along with everything else a thumbnail cannot draw. The
             * list is derived, never reordered and never spliced — it is
             * rebuilt whole whenever the card's data changes — so position is
             * a stable identity here in a way it would not be in the editor.
             */
            key={index}
            operation={operation}
          />
        ))}
      </g>

      {preview.truncated ? (
        /*
         * The circuit continues past the picture. Drawn as an ellipsis on the
         * middle wire rather than a fade, because a fade is a colour and this
         * has to survive a greyscale print and a colour-blind reader (§10) —
         * and because "there is more" is a fact, not an atmosphere.
         *
         * Through `NotationText` like every other mark in a diagram: it is the
         * same character in all three languages, and it is the one route that
         * keeps `i18next/no-literal-string` meaningful (D2).
         */
        <NotationText
          className="circuit-thumbnail__more"
          value={CONTINUES}
          x={width - THUMBNAIL_METRICS.padX}
          y={qubitY((preview.qubits - 1) / 2, THUMBNAIL_METRICS)}
        />
      ) : null}
    </svg>
  )
}

function ThumbnailGate({
  operation,
}: {
  readonly operation: PreviewOperation
}) {
  const x = columnX(operation.column, THUMBNAIL_METRICS)
  const shape = targetShape(operation.gate)

  const wireYs = [...operation.targets, ...operation.controls].map((qubit) =>
    qubitY(qubit, THUMBNAIL_METRICS)
  )
  const top = Math.min(...wireYs)
  const bottom = Math.max(...wireYs)

  if (shape === 'barrier') {
    return (
      <line
        className="qsim-barrier"
        x1={x}
        x2={x}
        y1={top - THUMBNAIL_METRICS.rowHeight * 0.4}
        y2={bottom + THUMBNAIL_METRICS.rowHeight * 0.4}
      />
    )
  }

  return (
    <g className="qsim-op">
      {bottom > top ? (
        <line className="qsim-link" x1={x} x2={x} y1={top} y2={bottom} />
      ) : null}

      {operation.controls.map((qubit) => (
        <circle
          key={`c${String(qubit)}`}
          /*
           * Always the filled disc. A preview does not carry control polarity
           * — see `previewOf` — and at this radius the hollow ring that means
           * "fires on |0⟩" is two pixels of stroke, which is not a distinction
           * a reader can make. Drawing the disc is the simplification the
           * payload already committed to, rather than a second, quieter lie.
           */
          className="qsim-control"
          cx={x}
          cy={qubitY(qubit, THUMBNAIL_METRICS)}
          r={CONTROL_RADIUS}
        />
      ))}

      {operation.targets.map((qubit) => (
        <TargetGlyph
          key={`t${String(qubit)}`}
          x={x}
          qubit={qubit}
          column={operation.column}
          shape={shape}
          label={boxLabel(operation.gate)}
        />
      ))}
    </g>
  )
}

function TargetGlyph({
  x,
  qubit,
  column,
  shape,
  label,
}: {
  readonly x: number
  readonly qubit: number
  readonly column: number
  readonly shape: ReturnType<typeof targetShape>
  readonly label: string
}) {
  const y = qubitY(qubit, THUMBNAIL_METRICS)

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

  if (shape === 'cross') {
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
      </g>
    )
  }

  /*
   * `cross-i` deliberately falls through to the box below rather than drawing
   * the crossing with its mark. The mark is what separates an iSWAP from a
   * SWAP, and at this scale it would be the same smudge the meter glyph is —
   * so the box carries the name instead, which is a distinction that survives
   * 13 pixels. A thumbnail is already lossy on purpose (it does not carry
   * control polarity either); what it may not be is *ambiguous*.
   */
  const box = gateBounds(
    { qubit, column },
    THUMBNAIL_METRICS,
    /*
     * A measurement's box carries the meter glyph in the editor and cannot
     * carry it here — an arc and a needle inside 13 pixels is a smudge — so it
     * is drawn as an `M` box instead. Sized for one character either way.
     */
    1
  )

  return (
    <g className="qsim-target">
      <rect
        className="qsim-box"
        x={box.x}
        y={box.y}
        width={box.width}
        height={box.height}
        rx={2}
      />
      <NotationText
        className="circuit-thumbnail__label"
        value={
          shape === 'meter' ? METER_LABEL : label.slice(0, MAX_LABEL_CHARACTERS)
        }
        x={x}
        y={y}
      />
    </g>
  )
}
