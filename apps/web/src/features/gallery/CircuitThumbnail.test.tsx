import { CIRCUIT_SCHEMA_VERSION, previewOf } from '@qsim/schema'
import type { Circuit } from '@qsim/schema'
import { cleanup, render } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'

import { CircuitThumbnail } from './CircuitThumbnail'

/**
 * The drawing on a card.
 *
 * Two properties are worth pinning, and neither is "it renders":
 *
 *   1. **It is the editor's ink.** Every mark wears the `qsim-*` class the
 *      editor's own gates wear, so a reader who clicks through sees the same
 *      drawing enlarged rather than a second rendering that resembles it. A
 *      test that only counted elements would pass over a thumbnail drawn in
 *      its own private vocabulary.
 *   2. **It says when it is incomplete.** A drawing that silently omits part
 *      of its subject is a drawing that lies, and the truncation mark is the
 *      only thing on the card that says the circuit continues past the frame.
 *
 * It is also `aria-hidden`, which is asserted here because it is a decision:
 * a lossy picture must not be a screen reader's only account of a circuit, and
 * the card states the counts it would be summarising as real text beside it.
 */

afterEach(cleanup)

function circuit(qubits: number, operations: Circuit['operations']): Circuit {
  return {
    schemaVersion: CIRCUIT_SCHEMA_VERSION,
    qubits,
    clbits: 0,
    operations,
  }
}

const bell = circuit(2, [
  { id: 'a', gate: 'h', targets: [0], column: 0 },
  { id: 'b', gate: 'cx', targets: [1], controls: [0], column: 1 },
])

describe('CircuitThumbnail', () => {
  it('draws one wire per qubit the preview holds', () => {
    const { container } = render(<CircuitThumbnail preview={previewOf(bell)} />)

    expect(container.querySelectorAll('.qsim-wire')).toHaveLength(2)
  })

  it('draws a gate box with its catalog symbol', () => {
    const { container } = render(<CircuitThumbnail preview={previewOf(bell)} />)

    expect(container.querySelectorAll('.qsim-box')).toHaveLength(1)
    // `H`, from the same table `GateNode` reads — not a second glyph list.
    expect(
      container.querySelector('.circuit-thumbnail__label')?.textContent
    ).toBe('H')
  })

  it('draws a CNOT as a control, a link and a ⊕ — the editor’s own marks', () => {
    const { container } = render(<CircuitThumbnail preview={previewOf(bell)} />)

    expect(container.querySelectorAll('.qsim-control')).toHaveLength(1)
    expect(container.querySelectorAll('.qsim-plus')).toHaveLength(1)
    expect(container.querySelectorAll('.qsim-link')).toHaveLength(1)
  })

  it('says nothing to a screen reader, deliberately', () => {
    const { container } = render(<CircuitThumbnail preview={previewOf(bell)} />)

    expect(container.querySelector('svg')?.getAttribute('aria-hidden')).toBe(
      'true'
    )
  })

  it('marks a circuit that continues past the frame', () => {
    const long = circuit(
      1,
      Array.from({ length: 40 }, (_, column) => ({
        id: `op${String(column)}`,
        gate: 'x',
        targets: [0],
        column,
      }))
    )

    const { container } = render(<CircuitThumbnail preview={previewOf(long)} />)

    expect(container.querySelector('.circuit-thumbnail__more')).not.toBeNull()
  })

  it('does not mark one that fits', () => {
    const { container } = render(<CircuitThumbnail preview={previewOf(bell)} />)

    expect(container.querySelector('.circuit-thumbnail__more')).toBeNull()
  })

  it('draws wires for a circuit with nothing in it rather than a sliver', () => {
    // An empty document is a real thing to publish by accident, and a card
    // that collapsed to a line would look like a rendering failure.
    const { container } = render(
      <CircuitThumbnail preview={previewOf(circuit(3, []))} />
    )

    expect(container.querySelectorAll('.qsim-wire')).toHaveLength(3)
    expect(container.querySelector('svg')?.getAttribute('viewBox')).toBeTruthy()
  })

  it('draws a measurement as a letter, not as the editor’s meter', () => {
    // The arc and needle are a smudge at 13 pixels; the letter is legible and
    // is notation in both places (untranslated, D2).
    const measured = circuit(1, [
      { id: 'a', gate: 'measure', targets: [0], column: 0, clbitTargets: [0] },
    ])

    const { container } = render(
      <CircuitThumbnail preview={previewOf({ ...measured, clbits: 1 })} />
    )

    expect(container.querySelector('.qsim-meter')).toBeNull()
    expect(
      container.querySelector('.circuit-thumbnail__label')?.textContent
    ).toBe('M')
  })
})
