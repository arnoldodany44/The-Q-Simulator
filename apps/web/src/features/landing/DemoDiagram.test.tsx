import { lookupGate } from '@qsim/schema'
import { cleanup, render } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'

import { defaultQubitLabel } from '../circuit-editor/useCircuitStore'
import { DemoDiagram } from './DemoDiagram'
import { DEMO_STAGES, wireLabel } from './stages'

/**
 * The diagram is `aria-hidden`, so nothing here can be found by role — and
 * that is the point of the split rather than an inconvenience: the drawing is
 * pixels, and the words are the figure's caption, which `LiveDemo.test.tsx`
 * asserts. What is left to check here is that the pixels are the *editor's*
 * pixels.
 *
 * This file exists because `DemoDiagram` deliberately does not reuse
 * `GateNode`: reusing it would pull Zod and the document store into the
 * landing chunk (see that file's header). The duplication is bounded — two
 * glyphs — and these are the assertions that keep it from drifting: the same
 * classes, the same gate symbol out of the schema catalog, and the same wire
 * names the store produces.
 */

afterEach(cleanup)

function draw(id: string) {
  const stage = DEMO_STAGES.find((candidate) => candidate.id === id)
  if (stage === undefined) throw new Error(`no stage ${id}`)
  return render(<DemoDiagram circuit={stage.circuit} />)
}

describe('the demo diagram', () => {
  it('draws one wire per qubit and says nothing to a screen reader', () => {
    const { container } = draw('zero')

    expect(container.querySelectorAll('.qsim-wire')).toHaveLength(2)
    expect(container.querySelector('svg')?.getAttribute('aria-hidden')).toBe(
      'true'
    )
    // No gates yet, so no glyphs: the first stage is two bare wires.
    expect(container.querySelectorAll('.qsim-box')).toHaveLength(0)
  })

  it('names its wires the way the editor names them', () => {
    const { container } = draw('zero')

    const labels = [...container.querySelectorAll('.demo__wire-label')].map(
      (node) => node.textContent
    )
    expect(labels).toEqual([defaultQubitLabel(0), defaultQubitLabel(1)])
    // The landing's own helper, pinned against the store's: the two are
    // separate functions only because the landing may not import the store.
    expect([wireLabel(0), wireLabel(1)]).toEqual(labels)
  })

  it('draws a Hadamard as the box the gate catalog names', () => {
    const { container } = draw('superposed')

    expect(container.querySelectorAll('.qsim-box')).toHaveLength(1)
    expect(container.querySelector('.qsim-box__label')?.textContent).toBe(
      lookupGate('h')?.symbol
    )
  })

  /*
   * A CNOT is a control dot, a ⊕ and the line joining them, and the line is
   * the part that carries the meaning: it is what says the two wires are one
   * gate rather than two.
   */
  it('draws a CNOT as a dot, a target and the link between them', () => {
    const { container } = draw('entangled')

    expect(container.querySelectorAll('.qsim-control')).toHaveLength(1)
    expect(container.querySelectorAll('.qsim-plus')).toHaveLength(1)
    expect(container.querySelectorAll('.qsim-link')).toHaveLength(1)
    // …and the Hadamard in the column before it is still there.
    expect(container.querySelectorAll('.qsim-box')).toHaveLength(1)
  })

  it('scales down rather than overflowing a narrow screen', () => {
    const { container } = draw('entangled')
    const svg = container.querySelector('svg')

    // A viewBox plus intrinsic dimensions is what lets the stylesheet cap the
    // width at 100% and keep the aspect ratio; without it the drawing would be
    // fixed-width and push the page sideways at 380px.
    expect(svg?.getAttribute('viewBox')).toBeTruthy()
    expect(svg?.getAttribute('width')).toBeTruthy()
    expect(svg?.getAttribute('height')).toBeTruthy()
  })
})
