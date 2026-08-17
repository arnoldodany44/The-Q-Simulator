// @vitest-environment node
import { CIRCUIT_SCHEMA_VERSION, type Circuit } from '@qsim/schema'
import { describe, expect, it } from 'vitest'

import { gridSizeOf } from '../circuit-editor/geometry'
import { collaboratorHue } from '../../lib/collab-colour'
import type { PeerPresence } from './presence'
import { presenceMarks } from './presenceMarks'

/**
 * What a peer's position means on *this* tab's grid — which is not always the grid
 * the peer has. Two people in a session are a document apart for as long as it takes
 * an update to arrive, and a mark for a cell that does not exist here would be drawn
 * in the padding or at a negative offset.
 */

const circuit: Circuit = {
  schemaVersion: CIRCUIT_SCHEMA_VERSION,
  qubits: 2,
  clbits: 1,
  operations: [
    { id: 'op-h', gate: 'h', targets: [0], column: 0 },
    { id: 'op-cx', gate: 'cx', targets: [1], controls: [0], column: 1 },
  ],
}

const size = gridSizeOf(circuit)

function peer(overrides: Partial<PeerPresence> = {}): PeerPresence {
  return {
    peerId: 'p1',
    name: 'Ada',
    access: 'write',
    cursor: { qubit: 0, column: 3 },
    selection: [],
    edits: 0,
    seenAt: 1_000,
    ...overrides,
  }
}

describe('a caret', () => {
  it('is one mark on the cell the peer is focused on, and carries the name', () => {
    const marks = presenceMarks([peer()], circuit, size)

    expect(marks).toEqual([
      {
        key: 'p1:cursor',
        peerId: 'p1',
        name: 'Ada',
        access: 'write',
        hue: collaboratorHue('p1'),
        kind: 'cursor',
        cell: { qubit: 0, column: 3 },
        labelled: true,
      },
    ])
  })

  it('is nothing at all for a peer that is not on the grid', () => {
    expect(presenceMarks([peer({ cursor: null })], circuit, size)).toEqual([])
  })

  it('is nothing for a cell this tab cannot draw yet', () => {
    // The peer has already added a third wire, or is standing in a column past
    // what this grid has grown to. Not an error: the update is on its way.
    const off = [
      { qubit: 9, column: 0 },
      { qubit: 0, column: size.columns },
      { qubit: -1, column: 0 },
    ]
    for (const cursor of off) {
      expect(
        presenceMarks([peer({ cursor })], circuit, size),
        String(cursor.qubit)
      ).toEqual([])
    }
  })

  it('is drawn on the classical register, which is a row and not a qubit', () => {
    // `qubit === circuit.qubits` is the register (see `geometry.ts`), and somebody
    // standing there is reading a measurement rather than placing anything.
    const marks = presenceMarks(
      [peer({ cursor: { qubit: 2, column: 1 } })],
      circuit,
      size
    )
    expect(marks).toHaveLength(1)
    expect(marks[0]?.cell).toEqual({ qubit: 2, column: 1 })
  })
})

describe('a gate somebody else is holding', () => {
  it('is outlined on every wire it stands on, not only its target', () => {
    // A CNOT is two cells tall on screen. Outlining the target alone would say
    // somebody had hold of half of it.
    const marks = presenceMarks([peer({ selection: ['op-cx'] })], circuit, size)
    const selection = marks.filter((mark) => mark.kind === 'selection')

    expect(selection.map((mark) => mark.cell)).toEqual([
      { qubit: 1, column: 1 },
      { qubit: 0, column: 1 },
    ])
    // The name is printed once, on the caret — not once per outlined cell.
    expect(selection.every((mark) => !mark.labelled)).toBe(true)
  })

  it('is skipped when this tab has no such operation', () => {
    // A gate the peer created that has not arrived here, or one just deleted.
    const marks = presenceMarks(
      [peer({ selection: ['op-ghost'] })],
      circuit,
      size
    )
    expect(marks.filter((mark) => mark.kind === 'selection')).toEqual([])
  })

  it('is painted before the caret, so the caret ends up on top', () => {
    const marks = presenceMarks(
      [peer({ selection: ['op-h'], cursor: { qubit: 0, column: 0 } })],
      circuit,
      size
    )
    expect(marks.map((mark) => mark.kind)).toEqual(['selection', 'cursor'])
  })
})

describe('several peers', () => {
  it('keeps them in the order they arrived and gives each its own hue', () => {
    const marks = presenceMarks(
      [
        peer(),
        peer({ peerId: 'p2', name: 'Beto', cursor: { qubit: 1, column: 2 } }),
      ],
      circuit,
      size
    )

    expect(marks.map((mark) => mark.peerId)).toEqual(['p1', 'p2'])
    expect(marks[0]?.hue).toBe(collaboratorHue('p1'))
    expect(marks[1]?.hue).toBe(collaboratorHue('p2'))
  })

  it('marks a watcher as one, so its caret can be drawn differently', () => {
    const marks = presenceMarks([peer({ access: 'read' })], circuit, size)
    expect(marks[0]?.access).toBe('read')
  })

  it('gives every mark a key that survives a movement', () => {
    const before = presenceMarks([peer({ selection: ['op-h'] })], circuit, size)
    const after = presenceMarks(
      [peer({ selection: ['op-h'], cursor: { qubit: 1, column: 4 } })],
      circuit,
      size
    )
    expect(after.map((mark) => mark.key)).toEqual(
      before.map((mark) => mark.key)
    )
  })
})
