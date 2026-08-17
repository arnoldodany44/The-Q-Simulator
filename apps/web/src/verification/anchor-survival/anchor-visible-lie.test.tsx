/**
 * INDEPENDENT VERIFICATION — what the reader is actually shown (lens:
 * anchor-survival).
 *
 * The two files beside this one establish that an operation id can be recycled.
 * This one takes that one step further and asks the question the milestone is
 * about: what does a reader see? `AnchorLabel` is the sentence the panel prints
 * over every thread, and `CommentMarkers` is the badge on the canvas. If the id
 * moved, both of them name a gate the commenter never wrote about.
 *
 * NOTE FOR WHOEVER FINDS THIS RED: these assertions state the claim §3.4 (M5.4)
 * makes. A failure here is a finding, not a broken test. No production code was
 * touched by this directory.
 */

import { emptyCircuit, type Circuit } from '@qsim/schema'
import { render } from '@testing-library/react'
import { describe, expect, it } from 'vitest'

import { AnchorLabel } from '../../features/comments/AnchorLabel'
import { CommentMarkers } from '../../features/comments/CommentMarkers'
import { createCircuitStore } from '../../features/circuit-editor/useCircuitStore'
import '../../i18n'

const saved: Circuit = {
  ...emptyCircuit(3, 3),
  operations: [
    { id: 'op_1', gate: 'h', targets: [0], column: 0 },
    // The gate a reviewer left a comment on: "this X is wrong".
    { id: 'op_2', gate: 'x', targets: [1], column: 1 },
    { id: 'op_3', gate: 'y', targets: [2], column: 2 },
  ],
}

/**
 * The document after the author opened the saved circuit, deleted the commented
 * `x`, and placed one unrelated gate. No merge, no second peer, no concurrency.
 */
function afterDeleteAndPlace() {
  const store = createCircuitStore()
  expect(store.getState().loadCircuit(saved).ok).toBe(true)
  expect(store.getState().removeOperation('op_2').ok).toBe(true)
  const placed = store.getState().placeGate('z', [2], 7)
  expect(placed.ok).toBe(true)
  return store.getState().circuit
}

describe('what the reader is shown after an id is recycled', () => {
  it('the panel sentence must not name a gate the commenter never wrote about', () => {
    const circuit = afterDeleteAndPlace()
    const { container } = render(
      <AnchorLabel circuit={circuit} anchorOpId="op_2" />
    )

    /*
     * Asserted on the branch rather than on the finished sentence, so the check
     * does not depend on i18next having loaded its catalogs in this runner:
     * `AnchorLabel` adds `--orphaned` on exactly one of its three paths, and
     * `comments.anchor.gate` is the path that names a gate by symbol, wire and
     * column. Seeing the second here means the sentence describes the gate that
     * inherited the id.
     */
    const label = container.querySelector('span')
    expect(label?.className).toContain('--orphaned')
    expect(label?.textContent).not.toContain('comments.anchor.gate')
  })

  it('no badge is drawn for the anchor of a gate that was deleted', () => {
    const circuit = afterDeleteAndPlace()
    const { container } = render(
      <CommentMarkers
        circuit={circuit}
        anchors={{ op_2: { open: 1, resolved: 0 } }}
      />
    )

    // "Nothing at all is drawn for an orphaned anchor" — CommentMarkers' own
    // header. A badge here is a badge on a gate nobody has said anything about.
    expect(container.querySelectorAll('.comment-marker')).toHaveLength(0)
  })
})
