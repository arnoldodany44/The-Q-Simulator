/**
 * What shape a gate is drawn as, and what letter goes inside it.
 *
 * ── Why this is its own module ────────────────────────────────────────────
 *
 * These four values used to live in `operationRoles.ts`, which is where the
 * editor reads them from and where they still logically belong. The problem is
 * everything *else* in that module: `qubitLabel` needs `defaultQubitLabel`,
 * which lives in `useCircuitStore.ts`, which constructs the document store at
 * module scope — a side effect a bundler cannot shake away. So a component
 * that wanted nothing but "is a `cx` a plus or a box" pulled Zustand, Zundo,
 * the undo history and the whole document model into its chunk along with it.
 *
 * That cost is invisible in the editor, which needs all of it anyway, and it
 * is not invisible in the gallery: M1.5b draws a thumbnail on every card, on a
 * route whose entire job is to load quickly for somebody who has not decided
 * to stay yet. Splitting the table out is what lets that route import the one
 * fact it needs.
 *
 * `operationRoles.ts` re-exports everything here, so nothing that already used
 * these names had to change, and there is still exactly one table — which is
 * the property that matters. Two would mean a gate renamed in the catalog
 * drawing correctly in one place and as a raw identifier in the other.
 *
 * Nothing here imports React or the DOM. The only two imports are
 * `@qsim/schema` and this feature's own `angles.ts`, which itself imports
 * nothing at all — so the property that made this module worth splitting out
 * still holds: a card that wants to know what shape a `cx` is does not acquire
 * Zustand, Zundo and the undo history to find out.
 */

import { lookupGate, type Circuit, type Operation } from '@qsim/schema'

import { formatPiMultiple } from './angles'

/**
 * The glyph drawn on a *target* wire. Everything not listed is a labelled
 * box, which is the right default: the catalog is open (custom gates land
 * here too) and a box with a symbol in it is never wrong, only plain.
 *
 * `cross-i` is the SWAP crosses with an `i` beside them, and it exists because
 * `iswap` used to be `cross`: SWAP and iSWAP are different unitaries and drew
 * byte-identical pictures. On the canvas that is a gate you cannot identify;
 * in an SVG or a PNG export it is worse, because the file is all the reader
 * has and there is nothing else to check it against.
 */
export type TargetShape =
  'box' | 'plus' | 'cross' | 'cross-i' | 'meter' | 'barrier'

const TARGET_SHAPES: Readonly<Record<string, TargetShape>> = {
  cx: 'plus',
  ccx: 'plus',
  swap: 'cross',
  iswap: 'cross-i',
  cswap: 'cross',
  measure: 'meter',
  barrier: 'barrier',
}

export function targetShape(gate: string): TargetShape {
  return TARGET_SHAPES[gate] ?? 'box'
}

/**
 * Gates the contract stores as "a one-qubit gate plus a control" are drawn
 * with the *base* gate in the box: a `cz` is a Z box joined to a control
 * dot. Labelling that box `CZ` would read as a controlled-controlled-Z,
 * because the dot already says "controlled".
 */
const BOX_LABELS: Readonly<Record<string, string>> = {
  cz: 'Z',
  crz: 'Rz',
  cp: 'P',
}

/**
 * The catalog symbol, a custom gate's own symbol, or the raw gate name.
 *
 * `circuit` is optional because a caller may not have one: a gallery
 * thumbnail is derived from the document and does not carry its custom-gate
 * table (see `previewOf` in @qsim/schema on what a preview deliberately
 * loses). Such a gate then falls through to its own identifier, which is a
 * plain label rather than a wrong one.
 */
export function gateSymbol(gate: string, circuit?: Circuit): string {
  const meta = lookupGate(gate)
  if (meta !== undefined) return meta.symbol
  return circuit?.customGates?.[gate]?.symbol ?? gate
}

/** The text drawn inside a gate box. */
export function boxLabel(gate: string, circuit?: Circuit): string {
  return BOX_LABELS[gate] ?? gateSymbol(gate, circuit)
}

/**
 * Characters the parameter label may use before it is cut.
 *
 * The label is centred under a box in a 56 px column, at 8 px in a monospace
 * face — roughly eleven characters before it would reach into the column
 * beside it and sit under somebody else's gate. `u(0.1,0.2,0.3)` is exactly
 * eleven, so the only thing that truncates is an angle written to more digits
 * than a drawing can carry; the ellipsis says so on the spot rather than
 * letting the reader believe they have the whole number.
 */
const MAX_PARAM_LABEL = 11

/** Decimals kept when an angle has no π form. See `paramLabel`. */
const PARAM_DECIMALS = 4

/**
 * The angles a parametrised gate carries, as they are drawn beneath its box —
 * or `''` for the gates that carry none.
 *
 * ── THE DEFECT THIS EXISTS FOR ────────────────────────────────────────────
 *
 * `boxLabel` reads the gate id and nothing else, so `Rz(π/2)` and `Rz(0.1235)`
 * drew the same box, and `circuitToSvg` produced byte-identical files for two
 * different circuits — a QFT exported as a PNG was a wall of identical `P`
 * boxes. The picture was not merely coarser than the document; it mapped
 * distinct circuits onto the same bytes, so a reader holding the file had no
 * way to tell which one they had.
 *
 * ── WHY THIS IS NOTATION AND NOT A LOCALISED NUMBER ──────────────────────
 *
 * `formatParams` in `operationRoles.ts` writes the same angles for the
 * accessibility layer and writes them through `Intl.NumberFormat`, because
 * that is a *sentence* a screen reader speaks. This is a label inside a
 * diagram, beside `π`, `q0` and `c0 = 1`, and it travels into an exported file
 * that has no locale at all — so it goes through `Notation` like every other
 * symbol on the canvas, and `formatPiMultiple` is what writes it (the same
 * function the angle field shows beside the slider).
 *
 * A value with no π form is written to four decimals, which is what the
 * drawing can hold. That is a drawing's precision and not a claim of
 * exactness: `@qsim/qasm` is where the lossless spelling lives, and the JSON
 * export is the one that loses nothing at all.
 */
export function paramLabel(operation: Operation): string {
  const params = operation.params ?? []
  if (params.length === 0) return ''

  const text = params
    .map((value) =>
      typeof value === 'string'
        ? // A symbolic parameter is an identifier the author chose, not a
          // quantity — printed as written, exactly as `formatParams` does.
          value
        : (formatPiMultiple(value) ?? trimDecimal(value))
    )
    .join(',')

  return text.length <= MAX_PARAM_LABEL
    ? text
    : `${text.slice(0, MAX_PARAM_LABEL - 1)}…`
}

/** `0.1235`, `1.9`, `-2` — four decimals with the trailing zeros gone. */
function trimDecimal(value: number): string {
  if (!Number.isFinite(value)) return String(value)
  return String(Number(value.toFixed(PARAM_DECIMALS)))
}
