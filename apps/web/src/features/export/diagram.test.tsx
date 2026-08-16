import { CIRCUIT_SCHEMA_VERSION, type Circuit } from '@qsim/schema'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'

import { circuitToSvg } from './diagram'

/**
 * The exported SVG. Two questions, and the second is the one that costs
 * people an afternoon:
 *
 *  1. is it the circuit?
 *  2. is it *self-contained* — will it look the same somewhere that is not
 *     this browser, with none of this app's CSS and none of its fonts?
 */

const TELEPORT: Circuit = {
  schemaVersion: CIRCUIT_SCHEMA_VERSION,
  qubits: 3,
  clbits: 2,
  qubitLabels: ['alice', 'shared', 'bob'],
  operations: [
    { id: 'op_1', gate: 'h', targets: [1], column: 0 },
    { id: 'op_2', gate: 'cx', targets: [2], controls: [1], column: 1 },
    { id: 'op_3', gate: 'cx', targets: [1], controls: [0], column: 2 },
    { id: 'op_4', gate: 'h', targets: [0], column: 3 },
    {
      id: 'op_5',
      gate: 'measure',
      targets: [0],
      clbitTargets: [0],
      column: 4,
    },
    {
      id: 'op_6',
      gate: 'x',
      targets: [2],
      column: 5,
      condition: { clbit: 0, equals: 1 },
    },
  ],
}

function draw(circuit: Circuit, title = 'Quantum circuit') {
  return circuitToSvg(circuit, renderToStaticMarkup, {
    title,
    description: 'Three qubits, six operations.',
  })
}

describe('circuitToSvg', () => {
  it('is a standalone SVG document with its own dimensions', () => {
    const { svg, width, height } = draw(TELEPORT)
    expect(svg.startsWith('<?xml version="1.0" encoding="UTF-8"?>')).toBe(true)
    expect(svg).toContain('xmlns="http://www.w3.org/2000/svg"')
    expect(svg).toContain(`viewBox="0 0 ${width} ${height}"`)
    // Explicit width and height, not only a viewBox: Firefox refuses to
    // rasterise an SVG without them, which is how the PNG export would fail.
    expect(svg).toContain(`width="${width}"`)
    expect(svg).toContain(`height="${height}"`)
    expect(svg.trimEnd().endsWith('</svg>')).toBe(true)
  })

  it('carries the whole circuit', () => {
    const drawing = markup(draw(TELEPORT).svg)
    // Two Hadamards, an X and the measurement each draw a box; a plus sits on
    // each of the two CNOT targets with a control dot for each; and the
    // measurement adds the meter and the arrow into the register.
    expect(count(drawing, 'class="qsim-box"')).toBe(4)
    expect(count(drawing, 'class="qsim-plus"')).toBe(2)
    expect(count(drawing, 'class="qsim-control"')).toBe(2)
    expect(drawing).toContain('qsim-meter')
    expect(drawing).toContain('qsim-classical-arrow')
    expect(drawing).toContain('qsim-condition')
  })

  it('names the wires, which live outside the plot in the app', () => {
    const { svg } = draw(TELEPORT)
    for (const label of ['alice', 'shared', 'bob']) {
      expect(svg).toContain(label)
    }
    // The classical register too, when there is one.
    expect(svg).toContain('>c<')
  })

  it('falls back to q0, q1, q2 when the wires are unnamed', () => {
    const { svg } = draw({ ...TELEPORT, qubitLabels: undefined })
    expect(svg).toContain('>q0<')
    expect(svg).toContain('>q2<')
  })

  it('is labelled for a screen reader wherever it is embedded', () => {
    const { svg } = draw(TELEPORT, 'Quantum circuit: Teleportation')
    expect(svg).toContain('role="img"')
    expect(svg).toContain('<title id="qsim-title">')
    expect(svg).toContain('Quantum circuit: Teleportation')
    expect(svg).toContain('<desc id="qsim-desc">')
  })

  it('escapes a title that would otherwise close the element early', () => {
    const { svg } = draw(TELEPORT, 'Bell & <script>alert(1)</script>')
    expect(svg).not.toContain('<script>')
    expect(svg).toContain('&amp;')
    expect(svg).toContain('&lt;script&gt;')
  })

  /* ── self-contained ───────────────────────────────────────────────── */

  it('carries its own stylesheet and never a custom property', () => {
    const { svg } = draw(TELEPORT)
    expect(svg).toContain('<style>')
    // `var(--accent)` with no `:root` to resolve against invalidates the whole
    // declaration, and the gate is drawn with no fill at all.
    expect(svg).not.toContain('var(--')
  })

  it('references nothing outside itself', () => {
    const { svg } = draw(TELEPORT)
    for (const external of ['@import', 'http://', 'https://', 'url(']) {
      // `xmlns` is a namespace name rather than a fetch, and is the one URL
      // an SVG must carry.
      const withoutNamespace = svg.replace(
        /xmlns="http:\/\/www\.w3\.org\/2000\/svg"/g,
        ''
      )
      expect(withoutNamespace, external).not.toContain(external)
    }
  })

  it('names no font it does not carry', () => {
    const { svg } = draw(TELEPORT)
    expect(svg).not.toContain('@font-face')
    // The families it does name are the ones every machine resolves, ending
    // at the generic keyword. In particular not IBM Plex Mono, which this app
    // self-hosts and the file cannot.
    expect(svg).not.toContain('IBM Plex Mono')
    expect(svg).toContain('monospace')
  })

  /* ── size ─────────────────────────────────────────────────────────── */

  it('draws only the columns the circuit occupies', () => {
    // The canvas keeps eight columns as room to drop the next gate; a file has
    // no next gate.
    const oneGate = draw({
      schemaVersion: CIRCUIT_SCHEMA_VERSION,
      qubits: 1,
      clbits: 0,
      operations: [{ id: 'op_1', gate: 'h', targets: [0], column: 0 }],
    })
    const sixGates = draw({
      schemaVersion: CIRCUIT_SCHEMA_VERSION,
      qubits: 1,
      clbits: 0,
      operations: Array.from({ length: 6 }, (_, column) => ({
        id: `op_${column}`,
        gate: 'h',
        targets: [0],
        column,
      })),
    })
    expect(oneGate.width).toBeLessThan(sixGates.width)
  })

  it('is not capped at the width the editor can draw', () => {
    // `MAX_DRAWN_COLUMNS` exists because the canvas builds a DOM element per
    // cell for drag and drop. An export builds none, and cutting the circuit
    // off at column 96 would be a drawing that lies.
    const wide = draw({
      schemaVersion: CIRCUIT_SCHEMA_VERSION,
      qubits: 1,
      clbits: 0,
      operations: [
        { id: 'op_1', gate: 'h', targets: [0], column: 0 },
        { id: 'op_2', gate: 'x', targets: [0], column: 200 },
      ],
    })
    expect(wide.width).toBeGreaterThan(200 * 50)
    expect(wide.svg).toContain('qsim-box')
  })

  it('widens the gutter for the longest wire name', () => {
    const short = draw({ ...TELEPORT, qubitLabels: ['a', 'b', 'c'] })
    const long = draw({
      ...TELEPORT,
      qubitLabels: ['alice-in-wonderland', 'b', 'c'],
    })
    expect(long.width).toBeGreaterThan(short.width)
  })
})

/**
 * The drawing without the stylesheet. Counting class names across the whole
 * file counts the CSS rules too, and `.qsim-control` and
 * `.qsim-control--negative` are two of those before a single dot is drawn.
 */
function markup(svg: string): string {
  return svg.slice(svg.indexOf('</style>'))
}

function count(text: string, needle: string): number {
  return text.split(needle).length - 1
}
