import { describe, expect, it } from 'vitest'

import { CIRCUIT_SCHEMA_VERSION, type Circuit } from './circuit.js'
import { depth } from './helpers.js'
import {
  CircuitPreviewSchema,
  PREVIEW_MAX_COLUMNS,
  PREVIEW_MAX_QUBITS,
  previewOf,
  safeParsePreview,
} from './preview.js'

/**
 * A preview is drawn on a card the reader cannot interrogate, beside numbers
 * they can. So the properties worth pinning are the ones a wrong drawing would
 * violate silently: that it never claims more than it holds, that it never
 * draws half a gate, and that its column count agrees with the depth printed
 * next to it.
 */

function circuit(
  qubits: number,
  operations: Circuit['operations'],
  clbits = 0
): Circuit {
  return {
    schemaVersion: CIRCUIT_SCHEMA_VERSION,
    qubits,
    clbits,
    operations,
  }
}

describe('previewOf', () => {
  it('keeps a small circuit whole', () => {
    const bell = circuit(2, [
      { id: 'a', gate: 'h', targets: [0], column: 0 },
      { id: 'b', gate: 'cx', targets: [1], controls: [0], column: 1 },
    ])

    expect(previewOf(bell)).toEqual({
      qubits: 2,
      columns: 2,
      truncated: false,
      operations: [
        { gate: 'h', column: 0, targets: [0], controls: [] },
        { gate: 'cx', column: 1, targets: [1], controls: [0] },
      ],
    })
  })

  it('compacts gaps so the column count matches the depth beside it', () => {
    // Columns 0 and 7 with nothing in between: `depth` says 2, and a preview
    // that drew seven empty columns would contradict the card it sits on.
    const sparse = circuit(1, [
      { id: 'a', gate: 'h', targets: [0], column: 0 },
      { id: 'b', gate: 'x', targets: [0], column: 7 },
    ])

    const preview = previewOf(sparse)
    expect(preview.columns).toBe(depth(sparse))
    expect(preview.operations.map((operation) => operation.column)).toEqual([
      0, 1,
    ])
    expect(preview.truncated).toBe(false)
  })

  it('draws the opening columns and says the rest is missing', () => {
    const long = circuit(
      1,
      Array.from({ length: PREVIEW_MAX_COLUMNS + 4 }, (_, column) => ({
        id: `op${String(column)}`,
        gate: 'x',
        targets: [0],
        column,
      }))
    )

    const preview = previewOf(long)
    expect(preview.columns).toBe(PREVIEW_MAX_COLUMNS)
    expect(preview.operations).toHaveLength(PREVIEW_MAX_COLUMNS)
    expect(preview.truncated).toBe(true)
  })

  it('draws the top wires and says the register is deeper', () => {
    const tall = circuit(
      PREVIEW_MAX_QUBITS + 2,
      Array.from({ length: PREVIEW_MAX_QUBITS + 2 }, (_, qubit) => ({
        id: `op${String(qubit)}`,
        gate: 'h',
        targets: [qubit],
        column: 0,
      }))
    )

    const preview = previewOf(tall)
    expect(preview.qubits).toBe(PREVIEW_MAX_QUBITS)
    expect(preview.truncated).toBe(true)
    for (const operation of preview.operations) {
      for (const target of operation.targets) {
        expect(target).toBeLessThan(PREVIEW_MAX_QUBITS)
      }
    }
  })

  it('drops a gate rather than drawing it with a wire cut off', () => {
    // The control is on a wire the preview does not draw. Half a CNOT is a
    // bare ⊕, which is a different gate rather than a smaller one.
    const wide = circuit(PREVIEW_MAX_QUBITS + 1, [
      { id: 'a', gate: 'h', targets: [0], column: 0 },
      {
        id: 'b',
        gate: 'cx',
        targets: [0],
        controls: [PREVIEW_MAX_QUBITS],
        column: 1,
      },
    ])

    const preview = previewOf(wide)
    expect(preview.operations.map((operation) => operation.gate)).toEqual(['h'])
    expect(preview.truncated).toBe(true)
  })

  it('keeps a barrier occupying its own column', () => {
    // `depth` ignores barriers because they are not work; a *drawing* cannot,
    // because closing the gap would place the gates either side in one moment.
    const fenced = circuit(1, [
      { id: 'a', gate: 'h', targets: [0], column: 0 },
      { id: 'b', gate: 'barrier', targets: [0], column: 1 },
      { id: 'c', gate: 'x', targets: [0], column: 2 },
    ])

    const preview = previewOf(fenced)
    expect(preview.operations.map((operation) => operation.column)).toEqual([
      0, 1, 2,
    ])
  })

  it('produces a value its own schema accepts, for every shape tried', () => {
    const shapes = [
      circuit(1, []),
      circuit(3, [{ id: 'a', gate: 'measure', targets: [0], column: 0 }], 1),
      circuit(PREVIEW_MAX_QUBITS + 5, [
        { id: 'a', gate: 'ccx', targets: [2], controls: [0, 1], column: 40 },
      ]),
    ]

    for (const shape of shapes) {
      expect(CircuitPreviewSchema.safeParse(previewOf(shape)).success).toBe(
        true
      )
    }
  })
})

describe('safeParsePreview', () => {
  it('reads back what previewOf wrote', () => {
    const written = previewOf(
      circuit(2, [{ id: 'a', gate: 'h', targets: [0], column: 0 }])
    )
    expect(safeParsePreview(JSON.parse(JSON.stringify(written)))).toEqual(
      written
    )
  })

  it('answers null rather than throwing on a row it cannot read', () => {
    // The whole reason this is lenient: a stored preview that does not parse
    // must cost a thumbnail, never the listing it appears in.
    expect(safeParsePreview(null)).toBeNull()
    expect(safeParsePreview({ qubits: 'two' })).toBeNull()
    expect(safeParsePreview({ qubits: 99, columns: 0, operations: [] })).toBe(
      null
    )
  })
})
