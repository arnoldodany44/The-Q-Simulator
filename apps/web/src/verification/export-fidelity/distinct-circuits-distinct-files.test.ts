// @vitest-environment node
import { parseCircuit, type CircuitInput } from '@qsim/schema'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'

import { circuitToSvg } from '../../features/export/diagram'

/**
 * TWO DIFFERENT CIRCUITS MAY NOT PRODUCE THE SAME FILE.
 *
 * A drawing is allowed to be coarser than the document it came from — that is
 * what a drawing is. What it may not be is *ambiguous*: an exported SVG is all
 * its reader has, with no document beside it to check against, so a picture
 * that is byte-identical for two different unitaries does not merely lose
 * detail, it tells the reader something false and gives them no way to notice.
 *
 * Two collisions were found by rendering circuits through this very function
 * and comparing the strings, and both were exact rather than approximate —
 * identical markup, and identical pixels once rasterised:
 *
 *   - `swap` and `iswap` both mapped to the `cross` glyph, which draws two
 *     plain diagonals with no label and no mark.
 *   - every parametrised gate drew only its symbol, because `boxLabel` reads
 *     the gate id and never `operation.params` — so `Rz(π/2)` and `Rz(0.1235)`
 *     were one file, and a QFT exported as a picture was a wall of identical
 *     `P` boxes.
 *
 * The assertion is inequality of the whole file rather than the presence of a
 * particular glyph, because the property that matters is the one an outsider
 * relies on and not the mechanism that currently provides it.
 */

function svgOf(operations: CircuitInput['operations'], qubits = 3): string {
  return circuitToSvg(
    parseCircuit({ schemaVersion: 1, qubits, clbits: 0, operations }),
    renderToStaticMarkup,
    { title: 'Quantum circuit', description: 'A circuit.' }
  ).svg
}

describe('the exported diagram identifies the circuit it came from', () => {
  it('draws SWAP and iSWAP differently', () => {
    const swap = svgOf(
      [{ id: 'op_1', gate: 'swap', targets: [0, 1], column: 0 }],
      2
    )
    const iswap = svgOf(
      [{ id: 'op_1', gate: 'iswap', targets: [0, 1], column: 0 }],
      2
    )

    expect(swap).not.toEqual(iswap)
  })

  it.each([
    ['rz', [Math.PI / 2], [0.123456]],
    ['p', [Math.PI / 4], [1.9]],
    ['u', [0.1, 0.2, 0.3], [1.1, 2.2, 3.3]],
  ])('draws two different %s angles differently', (gate, left, right) => {
    const first = svgOf([
      { id: 'op_1', gate, targets: [0], params: left, column: 0 },
    ])
    const second = svgOf([
      { id: 'op_1', gate, targets: [0], params: right, column: 0 },
    ])

    expect(first).not.toEqual(second)
  })

  it('writes an angle a reader can read, not only one they can compare', () => {
    /*
     * Inequality alone would be satisfied by a hash in a hidden attribute.
     * The angle has to be *legible*, in the notation the editor already shows
     * beside the slider — the π form when there is one, and a bounded decimal
     * when there is not.
     */
    expect(
      svgOf([
        {
          id: 'op_1',
          gate: 'rz',
          targets: [0],
          params: [Math.PI / 2],
          column: 0,
        },
      ])
    ).toContain('π/2')
    expect(
      svgOf([
        { id: 'op_1', gate: 'rz', targets: [0], params: [0.123456], column: 0 },
      ])
    ).toContain('0.1235')
  })

  it('keeps a symbolic angle symbolic', () => {
    // A declared parameter is an identifier the author chose, and substituting
    // its value here would draw a circuit the document does not describe.
    const svg = circuitToSvg(
      parseCircuit({
        schemaVersion: 1,
        qubits: 2,
        clbits: 0,
        parameters: [{ name: 'theta', value: 0.5 }],
        operations: [
          {
            id: 'op_1',
            gate: 'rz',
            targets: [0],
            params: ['theta'],
            column: 0,
          },
        ],
      }),
      renderToStaticMarkup,
      { title: 'Quantum circuit', description: 'A circuit.' }
    ).svg

    expect(svg).toContain('theta')
  })
})
