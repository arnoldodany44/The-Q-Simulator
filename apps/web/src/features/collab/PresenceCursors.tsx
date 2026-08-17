/**
 * Other people's carets, over the plot — M5.3.
 *
 * ── WHY THIS IS A LAYER AND NOT A PROPERTY OF A CELL ─────────────────────
 *
 * The obvious implementation puts a modifier class on the grid cell somebody else
 * is looking at. It is also the one that makes the editor slower for everybody: the
 * grid is one element per (qubit, column) — up to 96 × 21 of them, each a dnd-kit
 * droppable and a drag handle — and a cursor that moved eight times a second would
 * re-render all of them eight times a second, on the tab of the person who is
 * *trying to type*.
 *
 * So presence is an absolutely-positioned sibling that subscribes to the presence
 * store itself, through `useSyncExternalStore`. A remote cursor movement re-renders
 * this component and nothing else — not the grid, not the plot, not the store the
 * editor's own state lives in. The canvas takes it as an opaque `overlay` node
 * (`CircuitCanvas`), so the editor does not import this file and the one-way arrow
 * `.dependency-cruiser.cjs` enforces between the editor and the CRDT stays pointing
 * the way it does.
 *
 * ── WHY IT IS `aria-hidden`, AND WHERE THE SENTENCES ARE ─────────────────
 *
 * Because a cursor drawn on a canvas tells a screen reader nothing at all, and this
 * project already has the answer: the SVG plot is `aria-hidden` and paired with a
 * described ARIA grid (`CircuitCanvas.tsx`). A presence layer is more of the same
 * pixels, so it is hidden for the same reason — and putting `role="img"` and a label
 * on it would be worse than silence, because it would announce a coordinate every
 * time somebody moved.
 *
 * The accessible half of this pair is `PresenceRoster`: a list a reader can walk on
 * demand to learn who is here and where, plus a live region that speaks arrivals,
 * departures and edits — and never motion.
 */

import type { Circuit } from '@qsim/schema'
import { useSyncExternalStore, type CSSProperties } from 'react'
import { useTranslation } from 'react-i18next'

import {
  DEFAULT_METRICS,
  cellBounds,
  gridSizeOf,
  MIN_COLUMNS,
  type GridMetrics,
} from '../circuit-editor/geometry'
import { presenceMarks, type PresenceMark } from './presenceMarks'
import type { PresenceStore } from './presence'

export interface PresenceCursorsProps {
  readonly store: PresenceStore
  /** The circuit this tab is drawing — a selection is resolved against it. */
  readonly circuit: Circuit
  /** Must match what the canvas was given, or the marks land on the wrong cells. */
  readonly minColumns?: number
  readonly metrics?: GridMetrics
}

export function PresenceCursors({
  store,
  circuit,
  minColumns = MIN_COLUMNS,
  metrics = DEFAULT_METRICS,
}: PresenceCursorsProps) {
  const { t } = useTranslation('collab')
  const snapshot = useSyncExternalStore(store.subscribe, store.snapshot)

  // Nothing at all in a solo session: no element, no layer, no cost. Most
  // sessions have one person in them, and the common case should look exactly as
  // it did before this milestone.
  if (snapshot.peers.length === 0) return null

  const size = gridSizeOf(circuit, minColumns)
  const marks = presenceMarks(snapshot.peers, circuit, size)

  return (
    <div className="presence-layer" aria-hidden="true">
      {marks.map((mark) => (
        <span
          key={mark.key}
          className={classNameOf(mark)}
          style={styleOf(mark, metrics)}
        >
          {mark.labelled ? (
            <span className="presence-mark__name">
              {mark.name ?? t('presence.anonymous')}
            </span>
          ) : null}
        </span>
      ))}
    </div>
  )
}

function classNameOf(mark: PresenceMark): string {
  return [
    'presence-mark',
    `presence-mark--${mark.kind}`,
    mark.access === 'read' ? 'presence-mark--reader' : null,
  ]
    .filter((name) => name !== null)
    .join(' ')
}

/**
 * The rectangle of the cell, from the same `cellBounds` the grid overlay uses.
 *
 * Not an approximation of it: the geometry module is the one place that knows how a
 * cell becomes pixels, and a caret computed any other way would be a caret that
 * drifts from the cell it is pointing at as soon as a metric changes.
 */
function styleOf(mark: PresenceMark, metrics: GridMetrics): CSSProperties {
  const bounds = cellBounds(mark.cell, metrics)
  return {
    left: bounds.x,
    top: bounds.y,
    width: bounds.width,
    height: bounds.height,
    // The hue only; the stylesheet composes it against --collab-saturation and
    // --collab-lightness, exactly as the phase utilities compose --phase-hue.
    ['--collab-hue' as string]: String(mark.hue),
  }
}
