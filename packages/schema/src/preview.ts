/**
 * The thumbnail of a circuit — milestone M1.5b.
 *
 * ── The problem this shape exists to solve ────────────────────────────────
 *
 * A gallery card shows a small drawing of the circuit it advertises, and the
 * card knows nothing about the document: `CircuitCardResponse` is metadata and
 * counters, because a listing of fifty circuits must not carry fifty
 * documents. `CircuitVersion.data` is capped at 256 KiB (see
 * `MAX_CIRCUIT_JSON_BYTES` in @qsim/db), so joining the head version into the
 * gallery query would put up to 12 MB behind one anonymous request on the
 * product's front page — for a picture 200 pixels wide.
 *
 * The alternative that first suggests itself, one `GET /circuits/:id` per
 * card, is worse in every direction: fifty round trips, fifty full payloads,
 * fifty visibility checks, and a page that assembles itself in front of the
 * reader.
 *
 * So the drawing gets its own bounded shape. A preview is what fits on a
 * thumbnail and nothing else: a handful of wires, a handful of columns, and
 * the operations standing in them, stripped of everything a 6-pixel glyph
 * cannot show. It is derived from the circuit by `previewOf` at the two places
 * that write a document (see `metricsOf` in @qsim/db, which sits beside it),
 * stored denormalised on `Circuit` exactly as `gateCount` and `depth` are, and
 * read back with the card in one query and no join.
 *
 * ── What it deliberately loses ────────────────────────────────────────────
 *
 * Parameters, classical links, conditions, custom-gate bodies, qubit labels
 * and control polarity. Every one of them is meaning, and none of them
 * survives being drawn at this size: a negative control is a hollow ring
 * versus a filled disc — three pixels of difference on a card — and an angle
 * is a string of digits inside a box 8 pixels tall. Carrying them would cost
 * bytes on every card in the gallery to draw something no reader can resolve.
 *
 * That makes a preview an *illustration and not a reading*, and the interface
 * has to say so rather than imply otherwise: the card renders it
 * `aria-hidden`, states the qubit, gate and depth counts as real text beside
 * it, and the full circuit is one click away in the editor, where every one of
 * those distinctions is drawn properly.
 *
 * `truncated` is the same honesty applied to size. A drawing that silently
 * omits part of its subject is a drawing that lies — the same argument
 * `MAX_DRAWN_COLUMNS` makes in the editor's canvas — so a circuit wider or
 * taller than the thumbnail says so in the payload, and the card can show that
 * it continues past the edge.
 */

import { z } from 'zod'
import { MAX_QUBITS, type Circuit } from './circuit.js'
import { controlsOf } from './helpers.js'

/**
 * Wires a preview draws, at most.
 *
 * Six is what stays legible in a card-sized figure: at the editor's 48-pixel
 * row height a seventh wire either overflows the card or forces a scale at
 * which the gate boxes stop being readable shapes. A register wider than this
 * is drawn down to its sixth wire and reports `truncated`.
 */
export const PREVIEW_MAX_QUBITS = 6

/**
 * Columns a preview draws, at most.
 *
 * Ten columns at the editor's 56-pixel column width is a figure with an aspect
 * ratio close to 2:1, which is the shape a card wants. It also bounds the
 * payload: the most a preview can hold is `PREVIEW_MAX_QUBITS` ×
 * `PREVIEW_MAX_COLUMNS` operations — sixty — because the contract forbids two
 * operations sharing a qubit in one column, and sixty of these objects is a
 * few kilobytes rather than a few hundred.
 */
export const PREVIEW_MAX_COLUMNS = 10

/**
 * One operation as a thumbnail draws it.
 *
 * `gate` is the catalog id rather than a symbol, because the symbol is a
 * display decision and this is the wire: `boxLabel` in the editor already owns
 * the mapping, including the cases where the box says something other than the
 * gate's own name, and a second table shipped in the payload would be a second
 * thing to keep in step.
 *
 * `controls` holds every control wire whatever its trigger state — see the
 * header on why polarity is not carried.
 */
export const PreviewOperationSchema = z.strictObject({
  gate: z.string().max(64),
  column: z
    .int()
    .min(0)
    .max(PREVIEW_MAX_COLUMNS - 1),
  targets: z
    .array(
      z
        .int()
        .min(0)
        .max(MAX_QUBITS - 1)
    )
    .max(MAX_QUBITS),
  controls: z
    .array(
      z
        .int()
        .min(0)
        .max(MAX_QUBITS - 1)
    )
    .max(MAX_QUBITS),
})

export type PreviewOperation = z.infer<typeof PreviewOperationSchema>

/**
 * A circuit small enough to draw on a card.
 *
 * `qubits` and `columns` are what the *preview* holds, not what the circuit
 * has: the real counts travel beside it on the card as `qubitCount` and
 * `depth`, which is what the reader is told in words. Keeping the two separate
 * is what stops a thumbnail from being mistaken for a measurement.
 */
export const CircuitPreviewSchema = z.strictObject({
  qubits: z.int().min(1).max(PREVIEW_MAX_QUBITS),
  columns: z.int().min(0).max(PREVIEW_MAX_COLUMNS),
  /** The circuit reaches past what is drawn, in either direction. */
  truncated: z.boolean(),
  operations: z
    .array(PreviewOperationSchema)
    .max(PREVIEW_MAX_QUBITS * PREVIEW_MAX_COLUMNS),
})

export type CircuitPreview = z.infer<typeof CircuitPreviewSchema>

/**
 * Reads a stored preview, or `null` for anything that is not one.
 *
 * Lenient where `parseCircuit` is strict, and the asymmetry is the point. A
 * version's payload is the document — a row that does not parse is a fault
 * that must stop the request rather than reach the engine. A preview is
 * decoration derived from data the server already holds, so a row written by
 * an older build, or one whose bounds have since tightened, must cost a
 * thumbnail and never a page: refusing to serve the gallery because a picture
 * did not parse would trade the whole listing for one card.
 */
export function safeParsePreview(value: unknown): CircuitPreview | null {
  const result = CircuitPreviewSchema.safeParse(value)
  return result.success ? result.data : null
}

/**
 * The thumbnail of a circuit: the top-left corner of its diagram.
 *
 * The corner rather than a sample, and the reason is that a circuit is read
 * left to right in time and top to bottom in the register. The first columns
 * on the first wires are where the state preparation lives — the Hadamards,
 * the entangling pair — which is the part of a circuit a person recognises at
 * a glance. A window taken from the middle would be a picture of an algorithm
 * with its opening removed.
 *
 * Columns are *renumbered*, not merely filtered. A circuit whose operations
 * sit in columns 0 and 7 has a depth of 2 (`depth` ignores gaps), and a
 * thumbnail that drew seven empty columns between them would contradict the
 * number printed beside it on the same card. Compacting is also what makes the
 * ten-column window worth ten operations rather than however many happen to
 * fall inside an arbitrary range.
 *
 * An operation is kept only when *every* wire it occupies is inside the
 * window. A CNOT drawn with its control cut off is not a smaller CNOT, it is a
 * different gate — a bare ⊕ on a wire — and drawing that would be worse than
 * drawing nothing.
 */
export function previewOf(circuit: Circuit): CircuitPreview {
  const qubits = Math.min(circuit.qubits, PREVIEW_MAX_QUBITS)

  /*
   * The circuit's own column numbering compacted to `0, 1, 2, …`, in the same
   * order — `normalizeColumns` without building a whole circuit to throw away.
   * Barriers are included here, unlike in `depth`, because a barrier occupies
   * a column *visually*: the fence is drawn, and a thumbnail that closed the
   * gap around it would place the gates either side of it in one moment.
   */
  const occupied = [
    ...new Set(circuit.operations.map((operation) => operation.column)),
  ].sort((left, right) => left - right)
  const compacted = new Map(occupied.map((column, index) => [column, index]))

  const operations: PreviewOperation[] = []
  let truncated =
    circuit.qubits > qubits || occupied.length > PREVIEW_MAX_COLUMNS

  for (const operation of circuit.operations) {
    const column = compacted.get(operation.column) ?? operation.column
    if (column >= PREVIEW_MAX_COLUMNS) {
      truncated = true
      continue
    }

    const controls = controlsOf(operation).map((control) => control.qubit)
    // Every wire inside the window, or none of it. See the header.
    const outside = [...operation.targets, ...controls].some(
      (qubit) => qubit >= qubits
    )
    if (outside) {
      truncated = true
      continue
    }

    operations.push({
      gate: operation.gate,
      column,
      targets: [...operation.targets],
      controls,
    })
  }

  return {
    qubits,
    columns: Math.min(occupied.length, PREVIEW_MAX_COLUMNS),
    truncated,
    operations,
  }
}
