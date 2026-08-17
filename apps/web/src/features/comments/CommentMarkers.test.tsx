import { CIRCUIT_SCHEMA_VERSION, type Circuit } from '@qsim/schema'
import { cleanup, render } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'

import { DEFAULT_METRICS, cellBounds } from '../circuit-editor/geometry'
import { CommentMarkers } from './CommentMarkers'

/**
 * The badge on an anchored gate, and the three decisions it encodes.
 *
 * 1. **It lands on the gate's own cell**, computed by the same `cellBounds` the
 *    grid overlay uses. A badge one column off is the coordinate mistake this
 *    milestone exists to avoid, wearing a pixel offset instead of a wrong id.
 * 2. **An orphaned anchor draws nothing at all.** There is no cell to draw it on,
 *    and drawing it on a neighbouring one would tell the reader that a stranger
 *    said something about the gate in front of them.
 * 3. **It is decoration.** The layer is `aria-hidden` and holds nothing focusable,
 *    because the accessible surface is the panel's list — a control here would be
 *    reachable by Tab and invisible to a screen reader, and it would eat the drag
 *    on the very gates that carry comments.
 */

afterEach(cleanup)

function threeGates(): Circuit {
  return {
    schemaVersion: CIRCUIT_SCHEMA_VERSION,
    qubits: 3,
    clbits: 0,
    operations: [
      { id: 'op_1', gate: 'h', targets: [0], column: 0 },
      { id: 'op_2', gate: 'x', targets: [1], column: 1 },
      // A two-wire gate whose topmost wire is its control, so "which cell" has a
      // wrong answer available.
      { id: 'op_3', gate: 'cx', targets: [2], controls: [1], column: 3 },
    ],
  }
}

function markers(container: HTMLElement): HTMLElement[] {
  return [...container.querySelectorAll<HTMLElement>('.comment-marker')]
}

describe('a badge on a commented gate', () => {
  it('draws one per anchored gate, on that gate’s own cell', () => {
    const view = render(
      <CommentMarkers
        circuit={threeGates()}
        anchors={{ op_1: { open: 2, resolved: 0 } }}
      />
    )

    const [badge] = markers(view.container)
    expect(badge).toBeDefined()
    // The number is the count of *open* threads, which is what a reader is
    // looking for on a canvas.
    expect(badge?.textContent).toBe('2')

    const bounds = cellBounds({ qubit: 0, column: 0 }, DEFAULT_METRICS)
    expect(badge?.style.left).toBe(`${String(bounds.x + bounds.width)}px`)
    expect(badge?.style.top).toBe(`${String(bounds.y)}px`)
  })

  it('marks a multi-wire gate on its topmost wire, controls included', () => {
    const view = render(
      <CommentMarkers
        circuit={threeGates()}
        anchors={{ op_3: { open: 1, resolved: 0 } }}
      />
    )

    // `cx` targets q2 and is controlled from q1, so the badge belongs on q1 —
    // where the operation's box is drawn highest.
    const bounds = cellBounds({ qubit: 1, column: 3 }, DEFAULT_METRICS)
    expect(markers(view.container)[0]?.style.top).toBe(`${String(bounds.y)}px`)
  })

  it('draws a quieter mark with no number when every thread is resolved', () => {
    const view = render(
      <CommentMarkers
        circuit={threeGates()}
        anchors={{ op_1: { open: 0, resolved: 3 } }}
      />
    )

    const [badge] = markers(view.container)
    expect(badge?.className).toContain('comment-marker--resolved')
    expect(badge?.textContent).toBe('')
  })

  it('still draws the open count on a gate that also has resolved threads', () => {
    const view = render(
      <CommentMarkers
        circuit={threeGates()}
        anchors={{ op_1: { open: 1, resolved: 4 } }}
      />
    )

    const [badge] = markers(view.container)
    expect(badge?.className).not.toContain('comment-marker--resolved')
    expect(badge?.textContent).toBe('1')
  })

  it('draws nothing for an anchor this document does not hold', () => {
    // The orphan case. The thread is not lost — it is listed in the panel with a
    // note — but there is no cell here to point at, so nothing is drawn.
    const view = render(
      <CommentMarkers
        circuit={threeGates()}
        anchors={{ op_gone: { open: 1, resolved: 0 } }}
      />
    )
    expect(markers(view.container)).toHaveLength(0)
    expect(view.container.querySelector('.comment-marker-layer')).toBeNull()
  })

  it('renders no layer at all on a circuit nobody has commented on', () => {
    // Most circuits. The common case must cost nothing: no element, no layer.
    const view = render(<CommentMarkers circuit={threeGates()} anchors={{}} />)
    expect(view.container.firstChild).toBeNull()
  })

  it('is hidden from assistive technology and holds nothing focusable', () => {
    const view = render(
      <CommentMarkers
        circuit={threeGates()}
        anchors={{
          op_1: { open: 1, resolved: 0 },
          op_2: { open: 0, resolved: 1 },
        }}
      />
    )

    const layer = view.container.querySelector('.comment-marker-layer')
    expect(layer?.getAttribute('aria-hidden')).toBe('true')
    /*
     * The pair this project uses for the canvas: pixels here, sentences in the
     * panel. A focusable element inside `aria-hidden` is a WCAG failure, so the
     * assertion is about the whole subtree rather than about the badge element
     * somebody might change later.
     */
    expect(
      layer?.querySelectorAll('a, button, input, select, textarea, [tabindex]')
    ).toHaveLength(0)
  })
})
