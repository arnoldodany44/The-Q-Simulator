/**
 * The diagram as a file — milestone M1.7, specification §3.5.
 *
 * ── ONE RENDERER, NOT A SECOND ONE ───────────────────────────────────────
 *
 * The drawing comes from `CircuitPlot`, the same component the editor canvas
 * puts on screen, rendered to markup instead of to the DOM. Re-implementing
 * the glyphs here would mean two files to change whenever a gate's shape
 * changes, and the exported one would be the copy nobody looked at.
 *
 * `renderToStaticMarkup` is imported dynamically by the panel that uses it, so
 * the server renderer is not in the editor's chunk: it is a click away, not a
 * page load away.
 *
 * ── SELF-CONTAINED, WHICH IS A CLAIM ABOUT FONTS ─────────────────────────
 *
 * An SVG that names a font it does not carry renders in a fallback face
 * everywhere except the browser that made it — the labels move, the boxes stop
 * fitting them, and the file looks broken to everyone but its author. There
 * are three ways out and this file takes the third:
 *
 *   1. Embed the woff2 as a data URI. Correct, and ~19 kB of base64 for what
 *      is usually a dozen one-character labels — on a diagram that is
 *      otherwise 4 kB.
 *   2. Convert the labels to paths. Correct, and needs a font parser in the
 *      browser bundle to do it.
 *   3. **Name no webfont at all.** The stylesheet below asks for system
 *      monospace faces and ends at the generic `monospace`, so every name in
 *      it resolves on the machine that opens the file, with no request and no
 *      fallback surprise.
 *
 * Three is also the honest one for this project: `index.css` already records
 * that `√`, `⟩`, `†` and `π` are absent from every subset of IBM Plex Mono we
 * ship and come from the system fallback *in the app itself*. A gate label is
 * one or two characters centred in a box that was sized by an estimate
 * (`gateBounds`), so a different monospace face moves nothing that matters.
 *
 * Everything else is inlined for the same reason: the colours are literal hex
 * rather than `var(--accent)`, because a custom property with no `:root` to
 * resolve against makes the whole declaration invalid and a gate would be
 * drawn with no fill at all. `verification/export-fidelity/palette.test.ts`
 * reads `index.css` and asserts these literals are still the tokens they were
 * copied from, and that the file names no colour §10 does not declare.
 *
 * ── WHAT THE FILE CARRIES BEYOND THE PICTURE ─────────────────────────────
 *
 * A `<title>` and a `<desc>`, both supplied by the caller in the reader's
 * language, and `role="img"` — an exported diagram is read by screen readers
 * too, and an unlabelled one is an unlabelled image wherever it is embedded.
 * The wire names come with it, drawn as text, because in the app they live in
 * an HTML gutter beside the plot and a diagram whose wires are unnamed loses
 * the qubit labels the author chose.
 */

import { type Circuit } from '@qsim/schema'
import type { ReactElement } from 'react'

import { NotationText } from '../../components/Notation'
import { CircuitPlot } from '../circuit-editor/CircuitPlot'
import {
  DEFAULT_METRICS,
  classicalY,
  columnCount,
  plotHeight,
  plotWidth,
  qubitY,
  type GridMetrics,
  type GridSize,
} from '../circuit-editor/geometry'
import { qubitLabel } from '../circuit-editor/operationRoles'
import { toCircuitJson } from '@qsim/qasm'

/** Renders a React element to markup. `renderToStaticMarkup`, injected. */
export type RenderToMarkup = (element: ReactElement) => string

export interface DiagramOptions {
  /** `<title>`: the accessible name of the image, in the reader's language. */
  readonly title: string
  /** `<desc>`: the one sentence that describes it, in the reader's language. */
  readonly description: string
  readonly metrics?: GridMetrics
}

/** A rendered diagram, and the size a rasteriser needs to know about it. */
export interface Diagram {
  readonly svg: string
  readonly width: number
  readonly height: number
}

/**
 * The width of the label gutter, per character of the longest wire name.
 * An estimate, like `gateBounds`' own: the labels are left-aligned in a column
 * of their own, so a face slightly wider than assumed shortens the gap before
 * the wires rather than colliding with anything.
 */
const LABEL_CHAR_WIDTH = 7.5

/** Room for the label plus the gap to the wire, in user units. */
const LABEL_PADDING = 20

/** Longest wire name the gutter will size itself to. */
const MAX_LABEL_LENGTH = 16

/**
 * The palette, from specification §10 — the same tokens `index.css` declares,
 * as literals because this file has no `:root` to resolve a variable against.
 */
const PALETTE = {
  background: '#141833',
  elevated: '#1c2145',
  wire: '#5a65aa',
  text: '#e8eaf6',
  muted: '#8b93c4',
  accent: '#5ac8fa',
} as const

/**
 * System monospace faces, ending in the generic family. No webfont is named:
 * see the header.
 */
const MONO_STACK =
  "ui-monospace, SFMono-Regular, Menlo, Consolas, 'Liberation Mono', monospace"

/** The stylesheet the file carries, covering every class the plot emits. */
function stylesheet(): string {
  return `
    .qsim-export__background { fill: ${PALETTE.background}; }
    .qsim-export__label {
      fill: ${PALETTE.text};
      font-family: ${MONO_STACK};
      font-size: 13px;
      text-anchor: middle;
    }
    .qsim-wire { stroke: ${PALETTE.wire}; stroke-width: 2; }
    .qsim-wire--classical { stroke-width: 1.5; }
    .qsim-wire--slash { stroke: ${PALETTE.muted}; stroke-width: 1.5; }
    .qsim-register-label {
      fill: ${PALETTE.muted};
      font-family: ${MONO_STACK};
      font-size: 9px;
    }
    .qsim-link { stroke: ${PALETTE.accent}; stroke-width: 2; }
    .qsim-link--classical { stroke-width: 1.5; }
    .qsim-classical-arrow { fill: ${PALETTE.accent}; }
    .qsim-condition { fill: ${PALETTE.accent}; }
    .qsim-barrier {
      stroke: ${PALETTE.muted};
      stroke-width: 2;
      stroke-dasharray: 5 4;
    }
    .qsim-control { fill: ${PALETTE.accent}; }
    .qsim-control--negative {
      fill: ${PALETTE.background};
      stroke: ${PALETTE.accent};
      stroke-width: 2.5;
    }
    .qsim-plus {
      fill: ${PALETTE.background};
      stroke: ${PALETTE.accent};
      stroke-width: 2;
    }
    .qsim-plus__arm { stroke: ${PALETTE.accent}; stroke-width: 2; }
    .qsim-swap {
      stroke: ${PALETTE.accent};
      stroke-width: 2.5;
      stroke-linecap: round;
    }
    .qsim-swap__mark {
      fill: ${PALETTE.accent};
      font-family: ${MONO_STACK};
      font-size: 11px;
    }
    .qsim-box {
      fill: ${PALETTE.elevated};
      stroke: ${PALETTE.accent};
      stroke-width: 1.5;
    }
    .qsim-box__label {
      fill: ${PALETTE.text};
      font-family: ${MONO_STACK};
      font-size: 13px;
    }
    .qsim-box__param {
      fill: ${PALETTE.muted};
      font-family: ${MONO_STACK};
      font-size: 8px;
    }
    .qsim-meter {
      fill: none;
      stroke: ${PALETTE.text};
      stroke-width: 1.5;
      stroke-linecap: round;
    }
  `
    .trim()
    .replace(/\n {4}/g, '\n')
}

/**
 * The circuit as a standalone SVG document.
 *
 * `render` is `renderToStaticMarkup`, passed in rather than imported so this
 * module stays free of `react-dom/server` — the panel loads that on demand,
 * and the tests can render without it.
 */
export function circuitToSvg(
  circuit: Circuit,
  render: RenderToMarkup,
  options: DiagramOptions
): Diagram {
  const metrics = options.metrics ?? DEFAULT_METRICS
  const size = exportSize(circuit)
  const plot = plotWidth(size, metrics)
  const height = plotHeight(size, metrics)
  const gutter = gutterWidth(circuit, size.clbits > 0)
  const width = gutter + plot

  const body = render(
    <CircuitPlot circuit={circuit} size={size} width={plot} metrics={metrics} />
  )
  const labels = render(wireLabels(circuit, size.clbits, metrics, gutter / 2))

  const svg = [
    `<?xml version="1.0" encoding="UTF-8"?>`,
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" ` +
      `height="${height}" viewBox="0 0 ${width} ${height}" role="img" ` +
      `aria-labelledby="qsim-title qsim-desc">`,
    `<title id="qsim-title">${escapeXml(options.title)}</title>`,
    `<desc id="qsim-desc">${escapeXml(options.description)}</desc>`,
    /*
     * The circuit that drew this, inside the drawing.
     *
     * An SVG is a picture, and a picture of a circuit is not a circuit —
     * nothing could recover the operations from the paths. So the exact
     * document travels alongside them, which makes this export a round
     * trip rather than a dead end: `features/import` looks for exactly
     * this element and hands what it finds to `safeParseCircuit`.
     *
     * `<metadata>` is the element SVG defines for this and renderers
     * ignore it, so nothing about the image changes. It is escaped as XML
     * like the title and the description, and it is the same JSON the
     * JSON export writes — one serialiser, so the two exports cannot
     * drift into disagreeing about what this circuit is.
     */
    `<metadata id="qsim-circuit" data-qsim-format="application/json">` +
      `${escapeXml(toCircuitJson(circuit))}</metadata>`,
    `<style>${stylesheet()}</style>`,
    `<rect class="qsim-export__background" x="0" y="0" width="${width}" ` +
      `height="${height}"/>`,
    labels,
    `<g transform="translate(${gutter} 0)">${body}</g>`,
    `</svg>`,
    '',
  ].join('\n')

  return { svg, width, height }
}

/**
 * The grid an export draws on, which is **not** `gridSizeOf`.
 *
 * Two differences, and both are the same idea — a file is not an editor:
 *
 *  - No `MIN_COLUMNS`. The canvas keeps eight columns whether or not the
 *    circuit fills them, because that is where the next gate goes; in a file
 *    they are blank paper.
 *  - No `MAX_DRAWN_COLUMNS`. That cap exists because the canvas builds one DOM
 *    element per cell for the drag-and-drop overlay, and a 4 096-column link
 *    would freeze the tab (see `geometry.ts`). An export builds no overlay, so
 *    the cap would only mean silently cutting the circuit off — and a drawing
 *    that omits part of its subject is a drawing that lies. The PNG has a real
 *    limit at the far end of this and says so; see `raster.ts`.
 */
function exportSize(circuit: Circuit): GridSize {
  return {
    qubits: circuit.qubits,
    clbits: circuit.clbits,
    columns: Math.max(1, columnCount(circuit)),
  }
}

/**
 * The wire names, drawn as SVG text.
 *
 * In the app these live in an HTML gutter that scrolls independently of the
 * plot (see `CircuitCanvas`), which is exactly the arrangement a single file
 * cannot have. They come from `qubitLabel`, the same function the gutter and
 * the accessible grid use, so a renamed wire is renamed everywhere at once.
 *
 * A function returning an element rather than a component, because it is never
 * mounted: it is rendered once to a string and never re-rendered, has no state
 * and no hooks, and calling it a component would make this module a mixed
 * export that React Fast Refresh cannot reason about.
 */
function wireLabels(
  circuit: Circuit,
  clbits: number,
  metrics: GridMetrics,
  x: number
): ReactElement {
  const size = { qubits: circuit.qubits, clbits, columns: 0 }
  return (
    <g className="qsim-export__labels">
      {Array.from({ length: circuit.qubits }, (_, qubit) => (
        <NotationText
          key={qubit}
          className="qsim-export__label"
          value={truncate(qubitLabel(circuit, qubit))}
          x={x}
          y={qubitY(qubit, metrics)}
        />
      ))}
      {clbits > 0 ? (
        <NotationText
          className="qsim-export__label"
          value={CLASSICAL_LABEL}
          x={x}
          y={classicalY(size, metrics)}
        />
      ) : null}
    </g>
  )
}

/**
 * The classical register's name. Notation, not a word: `c` is what the
 * literature and the emitted OpenQASM both call it, so D2 leaves it alone and
 * it travels through `NotationText` like every other symbol on the canvas.
 */
const CLASSICAL_LABEL = 'c'

/** Wide enough for the longest name the gutter will draw. */
function gutterWidth(circuit: Circuit, hasRegister: boolean): number {
  const names = [
    ...Array.from({ length: circuit.qubits }, (_, qubit) =>
      truncate(qubitLabel(circuit, qubit))
    ),
    ...(hasRegister ? ['c'] : []),
  ]
  const longest = names.reduce((width, name) => Math.max(width, name.length), 2)
  return Math.round(longest * LABEL_CHAR_WIDTH + LABEL_PADDING)
}

/**
 * A wire name is user text of up to 32 characters (§6) and the gutter is not a
 * place to spend 240 pixels. Truncated with an ellipsis, which is what the
 * app's own gutter does with `text-overflow`.
 */
function truncate(label: string): string {
  const characters = [...label]
  if (characters.length <= MAX_LABEL_LENGTH) return label
  return `${characters.slice(0, MAX_LABEL_LENGTH - 1).join('')}…`
}

/**
 * Escapes the two characters that would end an element early plus `&`.
 *
 * The title and description come from the catalogs and from a user's circuit
 * title, and the title is arbitrary text. React escapes everything it renders;
 * these two nodes are assembled as strings, so they need it done here.
 */
function escapeXml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
}
