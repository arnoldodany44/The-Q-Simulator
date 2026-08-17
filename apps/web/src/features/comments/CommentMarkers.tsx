/**
 * The badge on a commented gate — Fase 5, M5.4.
 *
 * ══════════════════════════════════════════════════════════════════════════
 * A LAYER, FOR THE REASON PRESENCE IS A LAYER
 *
 * The obvious implementation puts a modifier class on the grid cell that carries
 * a thread. It is also the one that makes the editor slower for everybody: the
 * ARIA grid is one element per (qubit, column) — up to 96 × 21 of them, each a
 * dnd-kit droppable and a drag handle — and threading a per-cell prop through it
 * would re-render all of them every time a comment was posted anywhere.
 *
 * So this is an absolutely-positioned sibling handed to `CircuitCanvas` as its
 * opaque `overlay`, exactly as `PresenceCursors` is. The canvas does not know
 * what comments are, `features/comments` reaches into the editor and never the
 * reverse, and a solo reader with no API behind the page pays nothing for either.
 *
 * ══════════════════════════════════════════════════════════════════════════
 * IT IS DECORATION, AND THAT IS A DECISION RATHER THAN AN OMISSION
 *
 * The badge is not a button, and the layer takes no pointer events. Two reasons,
 * and the second is the one that settles it:
 *
 *   1. **A focusable control inside `aria-hidden` is a WCAG failure.** The layer
 *      sits over the grid, which is the canvas's whole accessible surface, so it
 *      is hidden from assistive technology like the plot beneath it. A `<button>`
 *      in there would be reachable by Tab and invisible to a screen reader, which
 *      is worse than not being reachable at all.
 *   2. **It would eat the drag.** The badge sits on the corner of a cell that is
 *      a drop target *and* the handle a placed gate is dragged by. A control there
 *      would make a commented gate harder to move than an uncommented one — the
 *      feature would degrade the editor for the documents that use it most.
 *
 * What reaches the reader instead is the pair this project already uses for the
 * canvas: pixels here, sentences in `CommentsPanel`, where every thread names its
 * gate (`AnchorLabel`) and carries a control that selects it on the canvas. That
 * control is a real button, in the tab order, with a name.
 *
 * ══════════════════════════════════════════════════════════════════════════
 * WHAT IS DRAWN, AND WHAT IS DELIBERATELY NOT
 *
 * One badge per anchored operation *present in this document*, carrying the number
 * of threads on it. An open thread and a resolved one do not wear the same badge:
 * a gate with an unanswered question on it is the thing the reader is looking for,
 * and a gate whose conversation is closed should not compete with it — so the
 * count shown is the open one where there is one, and the resolved-only case gets
 * a quieter mark with no number.
 *
 * Nothing at all is drawn for an orphaned anchor. There is no cell to draw it on,
 * and drawing it on a nearby one is the coordinate mistake this whole milestone
 * exists to avoid (`anchors.ts`): a badge on the gate that moved into (q0, c3)
 * would tell the reader a stranger said something about the gate in front of them.
 * The panel lists those threads against the circuit instead.
 */

import type { Circuit } from '@qsim/schema'
import type { CommentAnchorTally } from '@qsim/contract'
import type { CSSProperties } from 'react'
import { useStore } from 'zustand'

import { useComments } from '../../lib/api'
import {
  DEFAULT_METRICS,
  cellBounds,
  type GridMetrics,
} from '../circuit-editor/geometry'
import {
  useCircuitStore,
  type CircuitStore,
} from '../circuit-editor/useCircuitStore'
import { DEFAULT_COMMENT_VIEW } from './view'
import { resolveAnchors, type AnchorCell } from './anchors'

export interface CommentMarkersProps {
  /** The document on screen — anchors are resolved against this and nothing else. */
  readonly circuit: Circuit
  /**
   * `anchors` from the listing: every anchored operation on the circuit, tallied
   * open and resolved, narrowed by neither the page nor the filter. A page-shaped
   * tally would leave markers missing from gates whose conversation is on page
   * two, and a filtered one would hide the way back out of the filter.
   */
  readonly anchors: Readonly<Record<string, CommentAnchorTally>>
  /**
   * Must match what the canvas was given, or the badges land on the wrong cells.
   * The same contract `PresenceCursors` has, for the same reason: the geometry
   * module is the one place that knows how a cell becomes pixels.
   *
   * There is deliberately no `minColumns` here, unlike the presence layer. A
   * badge's position depends on its own cell alone, and `minColumns` only widens
   * the grid — taking it would be taking a parameter this component would have to
   * ignore, which is how two layers over one canvas come to disagree.
   */
  readonly metrics?: GridMetrics
}

interface Marker {
  readonly anchorOpId: string
  readonly cell: AnchorCell
  readonly open: number
  readonly resolved: number
}

export function CommentMarkers({
  circuit,
  anchors,
  metrics = DEFAULT_METRICS,
}: CommentMarkersProps) {
  const ids = Object.keys(anchors)
  // No element, no layer, no cost on a circuit nobody has commented on — which
  // is most of them.
  if (ids.length === 0) return null

  const { present } = resolveAnchors(circuit, ids)
  const markers: Marker[] = []
  for (const [anchorOpId, cell] of present) {
    const tally = anchors[anchorOpId]
    if (tally === undefined) continue
    if (tally.open === 0 && tally.resolved === 0) continue
    markers.push({
      anchorOpId,
      cell,
      open: tally.open,
      resolved: tally.resolved,
    })
  }

  if (markers.length === 0) return null

  return (
    <div className="comment-marker-layer" aria-hidden="true">
      {markers.map((marker) => (
        <span
          className={
            marker.open > 0
              ? 'comment-marker'
              : 'comment-marker comment-marker--resolved'
          }
          key={marker.anchorOpId}
          style={styleOf(marker.cell, metrics)}
        >
          {/*
           * The number only while something is open. A resolved-only badge says
           * "there is a conversation here" and stays quiet about how long it was:
           * the count that matters on a canvas is the count of open questions.
           */}
          {marker.open > 0 ? marker.open : null}
        </span>
      ))}
    </div>
  )
}

export interface CommentMarkerLayerProps {
  /** The circuit's slug or id. `null` for a document with no home yet. */
  readonly handle: string | null
  readonly store?: CircuitStore
  readonly metrics?: GridMetrics
}

/**
 * `CommentMarkers`, connected — what the page hands the canvas as its overlay.
 *
 * It asks for the listing with **`DEFAULT_COMMENT_VIEW`**, which is deliberately
 * the same selection `CommentsPanel` opens with: React Query keys by parameters,
 * so the two components share one cache entry and one request on the common path.
 * A reader who then changes the filter costs a second listing — the tally inside it
 * is identical, because `anchors` is narrowed by neither the state nor the page —
 * and both stay warm afterwards. The alternative, threading the panel's filter
 * state up through the page so the two keys always match, would make the marker
 * layer depend on which side of a filter somebody is standing on, for a number
 * that does not change with it.
 *
 * A document with no home has nothing to fetch: `/new` and an unsaved draft carry
 * no comments, because a comment is a row against a circuit id.
 */
export function CommentMarkerLayer({
  handle,
  store = useCircuitStore,
  metrics = DEFAULT_METRICS,
}: CommentMarkerLayerProps) {
  const circuit = useStore(store, (state) => state.circuit)
  const query = useComments(handle, DEFAULT_COMMENT_VIEW)
  const anchors = query.data?.anchors

  if (anchors === undefined) return null
  return (
    <CommentMarkers circuit={circuit} anchors={anchors} metrics={metrics} />
  )
}

/**
 * The badge's position, from the same `cellBounds` the grid overlay uses.
 *
 * Not an approximation of it. A badge computed any other way drifts from the cell
 * it is pointing at the moment a metric changes, and a marker on the wrong gate is
 * the exact failure mode this milestone refuses.
 */
function styleOf(cell: AnchorCell, metrics: GridMetrics): CSSProperties {
  const bounds = cellBounds(cell, metrics)
  /*
   * The cell's top-right corner. Not its centre: the centre is where the gate's
   * own glyph is drawn, and a badge over a `CNOT` plus would hide the thing the
   * comment is about.
   */
  return { left: bounds.x + bounds.width, top: bounds.y }
}
