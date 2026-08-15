import { emptyCircuit, parseCircuit, type Circuit } from '@qsim/schema'
import { describe, expect, it } from 'vitest'

import enEditor from '../../i18n/locales/en/editor.json'
import esEditor from '../../i18n/locales/es/editor.json'
import frEditor from '../../i18n/locales/fr/editor.json'
import { GATE_KEYS, PALETTE, PALETTE_ORDER, gateForKey } from './gateCatalog'
import {
  PLACEMENT_ISSUES,
  beginPlacement,
  continuePlacement,
  draftOf,
  isPlacementIssue,
  moveTo,
  nextSlot,
  pendingFits,
  remapPending,
  shapeOf,
  type PendingPlacement,
  type PlacementIssue,
} from './placement'

/**
 * The placement rules, tested without an editor. Every one of them is a pure
 * function of a circuit and a cell, which is the whole reason the module
 * exists: the keyboard path and the pointer path both go through here, so
 * proving the rules once proves them for both.
 */

const BELL: Circuit = parseCircuit({
  schemaVersion: 1,
  qubits: 3,
  operations: [
    { id: 'a', gate: 'h', targets: [0], column: 0 },
    { id: 'b', gate: 'cx', targets: [1], controls: [0], column: 1 },
  ],
})

describe('the shape a gate needs', () => {
  it('asks for one wire for a one-qubit gate', () => {
    expect(shapeOf('h').slots).toEqual(['target'])
  })

  it('asks for the target first and the control second', () => {
    expect(shapeOf('cx').slots).toEqual(['target', 'control'])
  })

  it('asks for both ends of a SWAP as targets', () => {
    expect(shapeOf('swap').slots).toEqual(['target', 'target'])
  })

  it('asks Toffoli for one target and two controls', () => {
    expect(shapeOf('ccx').slots).toEqual(['target', 'control', 'control'])
  })

  it('asks Fredkin for two targets and one control', () => {
    expect(shapeOf('cswap').slots).toEqual(['target', 'target', 'control'])
  })

  it('gives a barrier the whole moment in one step', () => {
    expect(shapeOf('barrier').spansEveryQubit).toBe(true)
    expect(shapeOf('barrier').slots).toHaveLength(1)
  })
})

describe('assembling the draft', () => {
  it('splits the picks into targets and controls in slot order', () => {
    expect(draftOf(BELL, 'ccx', [2, 0, 1], 4)).toEqual({
      kind: 'ready',
      draft: {
        gate: 'ccx',
        targets: [2],
        controls: [0, 1],
        column: 4,
      },
    })
  })

  it('spreads a barrier across every wire of the circuit', () => {
    expect(draftOf(BELL, 'barrier', [], 2)).toEqual({
      kind: 'ready',
      draft: {
        gate: 'barrier',
        targets: [0, 1, 2],
        column: 2,
      },
    })
  })

  it('sends a measurement to the classical bit that carries its index', () => {
    expect(draftOf(BELL, 'measure', [1], 3)).toEqual({
      kind: 'ready',
      draft: {
        gate: 'measure',
        targets: [1],
        clbitTargets: [1],
        column: 3,
      },
    })
  })

  /*
   * The diagonal is a default, not a document invariant: the register
   * commands renumber wires and leave the classical register alone, so the
   * bit carrying a wire's index can already belong to another measurement of
   * the same column. Two writers of one bit in one instant is the shape the
   * engine has no answer for, so the draft takes a bit that is free instead.
   */
  const CROSSED: Circuit = parseCircuit({
    schemaVersion: 1,
    qubits: 3,
    clbits: 3,
    operations: [
      { id: 'm', gate: 'measure', targets: [0], clbitTargets: [1], column: 0 },
    ],
  })

  it('takes a free classical bit when the diagonal one is already written', () => {
    expect(draftOf(CROSSED, 'measure', [1], 0)).toEqual({
      kind: 'ready',
      draft: {
        gate: 'measure',
        targets: [1],
        clbitTargets: [0],
        column: 0,
      },
    })
  })

  it('keeps the diagonal bit in a column that does not use it', () => {
    expect(draftOf(CROSSED, 'measure', [1], 1)).toMatchObject({
      kind: 'ready',
      draft: { clbitTargets: [1] },
    })
  })

  it('refuses when every classical bit of that column is spoken for', () => {
    const full: Circuit = parseCircuit({
      schemaVersion: 1,
      qubits: 3,
      clbits: 1,
      operations: [
        {
          id: 'm',
          gate: 'measure',
          targets: [1],
          clbitTargets: [0],
          column: 0,
        },
      ],
    })

    expect(draftOf(full, 'measure', [0], 0)).toEqual({
      kind: 'refused',
      code: 'no-free-clbit',
    })
  })

  /*
   * A register too short is a different problem with a different answer: the
   * contract refuses it as `clbit-out-of-range`, whose message names the
   * gutter control that fixes it. Silently writing the result to some lower
   * free bit would put it where the user never asked for it.
   */
  it('leaves a bit outside the register alone rather than guessing one', () => {
    const narrow = emptyCircuit(3, 1)
    expect(draftOf(narrow, 'measure', [2], 0)).toMatchObject({
      kind: 'ready',
      draft: { clbitTargets: [2] },
    })
  })
})

describe('the first pick', () => {
  it('finishes a one-qubit gate immediately', () => {
    const step = beginPlacement(BELL, 'h', { qubit: 2, column: 5 })
    expect(step).toEqual({
      kind: 'ready',
      draft: { gate: 'h', targets: [2], column: 5 },
    })
  })

  it('leaves a multi-qubit gate pending, with nothing written yet', () => {
    const step = beginPlacement(BELL, 'cx', { qubit: 0, column: 5 })
    expect(step.kind).toBe('pending')
    if (step.kind !== 'pending') return
    expect(step.pending.picks).toEqual([0])
    expect(nextSlot(step.pending)).toBe('control')
  })

  it('refuses a cell another gate already holds', () => {
    expect(beginPlacement(BELL, 'x', { qubit: 0, column: 0 })).toEqual({
      kind: 'refused',
      code: 'column-conflict',
    })
  })

  it('counts a control wire as occupied, not merely crossed', () => {
    // q0 at column 1 is the CNOT's control; the cell is taken.
    expect(beginPlacement(BELL, 'x', { qubit: 0, column: 1 })).toEqual({
      kind: 'refused',
      code: 'column-conflict',
    })
  })

  /*
   * A gate takes one distinct wire per slot, and the register can be smaller
   * than that. Accepting the first pick anyway used to consume the only wire
   * and then refuse every further pick as `qubit-already-used`, leaving a
   * prompt asking for a wire that does not exist and only Escape to end it.
   */
  it('refuses a gate the register is too small to hold', () => {
    const origin = { qubit: 0, column: 0 }

    expect(beginPlacement(emptyCircuit(1, 0), 'cx', origin)).toEqual({
      kind: 'refused',
      code: 'not-enough-qubits',
    })
    expect(beginPlacement(emptyCircuit(2, 0), 'ccx', origin)).toEqual({
      kind: 'refused',
      code: 'not-enough-qubits',
    })
    expect(beginPlacement(emptyCircuit(2, 0), 'cswap', origin)).toEqual({
      kind: 'refused',
      code: 'not-enough-qubits',
    })

    // The boundary is "fits exactly", not "has room to spare".
    expect(beginPlacement(emptyCircuit(2, 0), 'cx', origin).kind).toBe(
      'pending'
    )
    expect(beginPlacement(emptyCircuit(3, 0), 'ccx', origin).kind).toBe(
      'pending'
    )
    // A barrier spans whatever wires are there, so no register is too narrow.
    expect(beginPlacement(emptyCircuit(1, 0), 'barrier', origin).kind).toBe(
      'ready'
    )
  })
})

const PENDING: PendingPlacement = {
  gate: 'cx',
  column: 5,
  picks: [0],
  slots: ['target', 'control'],
}

describe('the picks after the first', () => {
  it('completes the gate and reports the whole draft', () => {
    expect(continuePlacement(BELL, PENDING, { qubit: 2, column: 5 })).toEqual({
      kind: 'ready',
      draft: { gate: 'cx', targets: [0], controls: [2], column: 5 },
    })
  })

  it('refuses a partner in another column', () => {
    expect(continuePlacement(BELL, PENDING, { qubit: 2, column: 4 })).toEqual({
      kind: 'refused',
      code: 'other-column',
    })
  })

  it('refuses a wire the gate already uses', () => {
    expect(continuePlacement(BELL, PENDING, { qubit: 0, column: 5 })).toEqual({
      kind: 'refused',
      code: 'qubit-already-used',
    })
  })

  it('refuses an occupied partner cell', () => {
    const pending: PendingPlacement = { ...PENDING, column: 1, picks: [2] }
    expect(continuePlacement(BELL, pending, { qubit: 0, column: 1 })).toEqual({
      kind: 'refused',
      code: 'column-conflict',
    })
  })

  it('keeps collecting until a three-wire gate is complete', () => {
    const start = beginPlacement(emptyCircuit(4), 'ccx', {
      qubit: 3,
      column: 0,
    })
    expect(start.kind).toBe('pending')
    if (start.kind !== 'pending') return

    const second = continuePlacement(emptyCircuit(4), start.pending, {
      qubit: 0,
      column: 0,
    })
    expect(second.kind).toBe('pending')
    if (second.kind !== 'pending') return
    expect(nextSlot(second.pending)).toBe('control')

    const third = continuePlacement(emptyCircuit(4), second.pending, {
      qubit: 1,
      column: 0,
    })
    expect(third).toEqual({
      kind: 'ready',
      draft: { gate: 'ccx', targets: [3], controls: [0, 1], column: 0 },
    })
  })
})

/*
 * A pending placement names wires, and the register is editable while it
 * waits. These are the transforms `useKeyboardGrid` applies so that the gate
 * lands on the wire the user anchored it to rather than on whatever wire has
 * that index by the time the shape is complete.
 */
describe('a pending placement when the register changes', () => {
  const CCX: PendingPlacement = {
    gate: 'ccx',
    column: 2,
    picks: [1, 3],
    slots: ['target', 'control', 'control'],
  }

  it('shifts the picks at or below an inserted wire', () => {
    expect(
      remapPending(CCX, (qubit) => (qubit >= 2 ? qubit + 1 : qubit)).picks
    ).toEqual([1, 4])
  })

  it('shifts the picks above a removed wire', () => {
    expect(
      remapPending(CCX, (qubit) => (qubit > 2 ? qubit - 1 : qubit)).picks
    ).toEqual([1, 2])
  })

  it('follows the wires through a reorder', () => {
    const order = [3, 2, 1, 0]
    const positionOf = new Map(order.map((old, position) => [old, position]))
    expect(
      remapPending(CCX, (qubit) => positionOf.get(qubit) ?? qubit).picks
    ).toEqual([2, 0])
  })

  it('leaves the column alone, because columns are not wires', () => {
    expect(remapPending(CCX, (qubit) => qubit + 1)).toMatchObject({
      column: 2,
      gate: 'ccx',
      slots: ['target', 'control', 'control'],
    })
  })

  it('still fits a circuit that holds every wire it claims', () => {
    expect(pendingFits(CCX, emptyCircuit(4))).toBe(true)
  })

  it('does not fit once a claimed wire is past the end', () => {
    expect(pendingFits(CCX, emptyCircuit(3))).toBe(false)
  })
})

describe('moving an operation that is already placed', () => {
  const cnot = BELL.operations[1]!

  it('shifts every wire by the distance the grabbed one moved', () => {
    expect(moveTo(BELL, cnot, 1, { qubit: 2, column: 4 })).toEqual({
      kind: 'move',
      draft: { id: 'b', targets: [2], controls: [1], column: 4 },
    })
  })

  it('moves along the time axis without touching the wires', () => {
    expect(moveTo(BELL, cnot, 1, { qubit: 1, column: 6 })).toEqual({
      kind: 'move',
      draft: { id: 'b', targets: [1], controls: [0], column: 6 },
    })
  })

  it('measures the shift from the wire the user grabbed', () => {
    // Grabbed by its control on q0, dropped on q1: everything moves one down.
    expect(moveTo(BELL, cnot, 0, { qubit: 1, column: 1 })).toEqual({
      kind: 'move',
      draft: { id: 'b', targets: [2], controls: [1], column: 1 },
    })
  })

  it('refuses a shift that would push a wire off the circuit', () => {
    expect(moveTo(BELL, cnot, 1, { qubit: 0, column: 4 })).toEqual({
      kind: 'refused',
      code: 'qubit-out-of-range',
    })
  })

  /*
   * `draftOf` gives a measurement the classical bit that carries its qubit's
   * index. A drag that left the bit behind would break that correspondence
   * the moment after the editor established it, and could put two writers of
   * one bit in a column — a shape a column, being one instant (§6), has no
   * defined answer for.
   */
  const MEASURED: Circuit = parseCircuit({
    schemaVersion: 1,
    qubits: 3,
    clbits: 3,
    operations: [
      { id: 'm', gate: 'measure', targets: [0], clbitTargets: [0], column: 0 },
      {
        id: 'g',
        gate: 'x',
        targets: [1],
        condition: { clbit: 0, equals: 1 },
        column: 1,
      },
    ],
  })

  it('carries a measurement’s classical write to the wire it lands on', () => {
    expect(
      moveTo(MEASURED, MEASURED.operations[0]!, 0, { qubit: 2, column: 0 })
    ).toEqual({
      kind: 'move',
      draft: { id: 'm', targets: [2], clbitTargets: [2], column: 0 },
    })
  })

  it('leaves the classical write alone on a purely horizontal drag', () => {
    expect(
      moveTo(MEASURED, MEASURED.operations[0]!, 0, { qubit: 0, column: 4 })
    ).toEqual({
      kind: 'move',
      draft: { id: 'm', targets: [0], clbitTargets: [0], column: 4 },
    })
  })

  it('refuses a drag whose write would land on a bit that column uses', () => {
    // Two measurements, one column, and the lower one dragged onto the wire
    // whose bit the upper one already writes. The contract accepts that
    // shape and the engine reads it in no defined order, so the drag is
    // refused rather than committed.
    const crowded: Circuit = parseCircuit({
      schemaVersion: 1,
      qubits: 4,
      clbits: 4,
      operations: [
        {
          id: 'top',
          gate: 'measure',
          targets: [0],
          clbitTargets: [2],
          column: 0,
        },
        {
          id: 'low',
          gate: 'measure',
          targets: [3],
          clbitTargets: [3],
          column: 1,
        },
      ],
    })

    expect(
      moveTo(crowded, crowded.operations[1]!, 3, { qubit: 2, column: 0 })
    ).toEqual({ kind: 'refused', code: 'clbit-in-use' })
  })

  it('does not repoint a classical read when its gate is dragged', () => {
    // Deliberately asymmetric with the write above: a move relocates one
    // operation inside a circuit whose measurements stay put, so the bit
    // this gate *reads* is not the drag's business. Paste, which copies a
    // whole self-contained fragment, does translate it.
    expect(
      moveTo(MEASURED, MEASURED.operations[1]!, 1, { qubit: 2, column: 1 })
    ).toEqual({
      kind: 'move',
      draft: { id: 'g', targets: [2], column: 1 },
    })
  })
})

describe('the palette catalog', () => {
  it('gives every gate a key, and no two gates the same one', () => {
    const keys = Object.values(GATE_KEYS)
    expect(new Set(keys).size).toBe(keys.length)
    expect(keys).toHaveLength(PALETTE_ORDER.length)
  })

  it('lists every catalog gate exactly once', () => {
    const listed = PALETTE.flatMap((group) => group.gates.map((g) => g.id))
    expect(new Set(listed).size).toBe(listed.length)
    expect(listed).toEqual([...PALETTE_ORDER])
  })

  it('resolves a key to its gate, whatever the shift state', () => {
    expect(gateForKey('h')).toBe('h')
    expect(gateForKey('H')).toBe('h')
    expect(gateForKey('c')).toBe('cx')
    expect(gateForKey('ArrowUp')).toBeUndefined()
    expect(gateForKey('!')).toBeUndefined()
  })
})

describe('refusal codes', () => {
  it('tells its own refusals apart from the contract’s', () => {
    expect(isPlacementIssue('other-column')).toBe(true)
    expect(isPlacementIssue('column-conflict')).toBe(false)
  })

  it('have a message in all three languages', () => {
    // Typed as total records, so a code added here without a string in every
    // catalog is a compile error rather than a raw key on screen (D2).
    const catalogs: Record<PlacementIssue, string>[] = [
      enEditor.placement,
      esEditor.placement,
      frEditor.placement,
    ]

    for (const issue of PLACEMENT_ISSUES) {
      for (const catalog of catalogs) {
        expect(catalog[issue].trim().length).toBeGreaterThan(0)
      }
    }
  })
})
