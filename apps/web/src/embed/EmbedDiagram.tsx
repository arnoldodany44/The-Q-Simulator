/**
 * The circuit, drawn — the embed's half of the picture.
 *
 * ── It is the editor's renderer, not a third one ─────────────────────────
 *
 * `CircuitPlot` is the one component in this project that turns a circuit
 * into wires and glyphs; the canvas puts it inside an interactive `<svg>` and
 * `features/export/diagram.tsx` puts it inside a standalone one. This is the
 * third caller and it adds no marks of its own, because a teacher who clicks
 * through from a blog post to the editor has to find the drawing they were
 * looking at rather than something that resembles it.
 *
 * What it does add is the label gutter. In the editor those names live in an
 * HTML column beside the plot, positioned from `qubitY` — machinery that
 * exists so the names can be *edited*. Here they are text inside the SVG, the
 * same choice `diagram.tsx` makes for the same reason: nothing in an embed
 * edits anything, and one element is one element to size.
 *
 * ── `role="img"`, not `aria-hidden` ──────────────────────────────────────
 *
 * The canvas hides its plot from assistive technology because it publishes an
 * ARIA grid beside it, and the gallery thumbnail hides its own because it is
 * a lossy drawing with the real figures printed next to it. Neither applies
 * here: this drawing is complete, and the frame has no grid. So it is labelled
 * like the exported file is — a name and a one-sentence description, both in
 * the frame's language — because an embed is read by screen readers in
 * somebody else's page, where an unlabelled graphic is an unlabelled graphic.
 *
 * ── Why it does not import `operationRoles.ts` ───────────────────────────
 *
 * That module has `qubitLabel`, which is exactly what is wanted, and it
 * reaches `defaultQubitLabel` in `useCircuitStore` — a module that carries
 * Zustand and the whole undo history for one template string.
 * `features/analysis/bloch.ts` already refused that import for the same reason
 * and wrote its own `q${index}`; this is the second such refusal, and the
 * dependency-cruiser rule for this directory is what keeps it from being
 * quietly undone.
 */

import type { Circuit } from '@qsim/schema'
import { useId } from 'react'
import { useTranslation } from 'react-i18next'

import { NotationText } from '../components/Notation'
import { CircuitPlot } from '../features/circuit-editor/CircuitPlot'
import {
  DEFAULT_METRICS,
  classicalY,
  columnCount,
  gridSizeOf,
  plotHeight,
  plotWidth,
  qubitY,
  undrawnColumns,
  type GridMetrics,
} from '../features/circuit-editor/geometry'

/**
 * A frame is small, so the drawing starts at the circuit's own width rather
 * than at the editor's eight-column minimum: an embedded Bell pair should be
 * two columns of wire and not two columns plus six of empty grid waiting for
 * gates nobody can place here.
 */
const MIN_EMBED_COLUMNS = 1

/** Room for the wire names, in user units. Sized like the exporter's. */
const LABEL_CHAR_WIDTH = 7.5
const LABEL_PADDING = 16
const MAX_LABEL_LENGTH = 12

export interface EmbedDiagramProps {
  readonly circuit: Circuit
  readonly metrics?: GridMetrics
}

export function EmbedDiagram({
  circuit,
  metrics = DEFAULT_METRICS,
}: EmbedDiagramProps) {
  const { t } = useTranslation('embed')
  const titleId = useId()
  const descriptionId = useId()

  const size = gridSizeOf(circuit, MIN_EMBED_COLUMNS)
  const plot = plotWidth(size, metrics)
  const height = plotHeight(size, metrics)
  const labels = wireLabels(circuit)
  const gutter = gutterWidth(labels)
  // Centred in the gutter's text column, which is everything left of the gap
  // `LABEL_PADDING` reserves before the first wire.
  const labelX = (gutter - LABEL_PADDING) / 2
  const width = gutter + plot
  const hidden = undrawnColumns(circuit)

  return (
    <div className="embed__diagram">
      {hidden > 0 ? (
        <p className="embed__notice">
          {t('diagram.truncated', {
            drawn: size.columns,
            total: columnCount(circuit),
          })}
        </p>
      ) : null}
      <svg
        className="embed__plot"
        viewBox={`0 0 ${width} ${height}`}
        width={width}
        height={height}
        role="img"
        aria-labelledby={`${titleId} ${descriptionId}`}
      >
        <title id={titleId}>{t('diagram.title')}</title>
        <desc id={descriptionId}>
          {t('diagram.description', {
            qubits: circuit.qubits,
            columns: columnCount(circuit),
          })}
        </desc>

        {/*
         * Through `NotationText`, which is the one sanctioned route for
         * invariant notation (D2, §1.1) and the reason it exists at all: a
         * wire called `q0` is notation, and Chrome's page translator will
         * happily turn it into something else inside a page it has decided to
         * translate — which, for an embed, is a page this project does not
         * control. It centres what it draws, so the labels are centred in the
         * gutter rather than flush against its left edge.
         */}
        <g className="embed__labels">
          {labels.map((label, index) => (
            <NotationText
              key={index}
              className="embed__wire-label"
              value={label}
              x={labelX}
              y={qubitY(index, metrics)}
            />
          ))}
          {size.clbits > 0 ? (
            <NotationText
              className="embed__wire-label embed__wire-label--classical"
              value={t('diagram.classical')}
              x={labelX}
              y={classicalY(size, metrics)}
            />
          ) : null}
        </g>

        {/* The plot draws in its own coordinates; the gutter shifts it. */}
        <g transform={`translate(${gutter} 0)`}>
          <CircuitPlot
            circuit={circuit}
            size={size}
            width={plot}
            metrics={metrics}
          />
        </g>
      </svg>
    </div>
  )
}

/** The wire names, defaulted the way the canvas defaults them. */
function wireLabels(circuit: Circuit): string[] {
  return Array.from(
    { length: circuit.qubits },
    (_, index) => circuit.qubitLabels?.[index] ?? `q${index}`
  )
}

/**
 * An estimate, like `gateBounds`' own. The names are centred in a column of
 * their own with `LABEL_PADDING` of clear space after it, so a face slightly
 * wider than assumed eats into that gap rather than colliding with a wire.
 */
function gutterWidth(labels: readonly string[]): number {
  const longest = labels.reduce(
    (best, label) => Math.max(best, Math.min(label.length, MAX_LABEL_LENGTH)),
    2
  )
  return longest * LABEL_CHAR_WIDTH + LABEL_PADDING
}
