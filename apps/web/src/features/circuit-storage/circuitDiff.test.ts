// @vitest-environment node
import { emptyCircuit, validateCircuit } from '@qsim/schema'
import type { Circuit, Operation } from '@qsim/schema'
import { describe, expect, it } from 'vitest'

import {
  changedEntries,
  diffCircuits,
  operationCells,
  type DiffEntry,
} from './circuitDiff.js'

/**
 * The diff, against expectations written by hand.
 *
 * Every circuit below goes through `validateCircuit` before it is compared, so
 * a fixture that could not exist in the editor — two gates fighting over one
 * cell, a target off the end of the register — fails here rather than teaching
 * the diff to describe a document the rest of the system would reject.
 *
 * The case that forced this file to exist is the last one: two circuits that
 * differ only in the order of the operations inside a column. §6 makes a
 * column one instant, so that is not a difference, and every plausible
 * implementation built on array position reports it as one.
 */

/** A circuit from a list of operations, checked against the contract. */
function circuitOf(
  qubits: number,
  operations: readonly Operation[],
  overrides: Partial<Circuit> = {}
): Circuit {
  const built: Circuit = {
    ...emptyCircuit(qubits, qubits),
    operations: [...operations],
    ...overrides,
  }
  // Throws with the offending rule named, which is what a broken fixture
  // deserves — the alternative is a green test about an impossible document.
  validateCircuit(built)
  return built
}

function gate(
  id: string,
  name: string,
  targets: readonly number[],
  column: number,
  extra: Partial<Operation> = {}
): Operation {
  return { id, gate: name, targets: [...targets], column, ...extra }
}

/** The one entry a single-change expectation is about. */
function only(entries: readonly DiffEntry[]): DiffEntry {
  expect(entries).toHaveLength(1)
  const entry = entries[0]
  if (entry === undefined) throw new Error('unreachable')
  return entry
}

describe('a gate added', () => {
  it('is one addition and leaves everything else alone', () => {
    const h = gate('op_1', 'h', [0], 0)
    const before = circuitOf(2, [h])
    const after = circuitOf(2, [h, gate('op_2', 'x', [1], 1)])

    const diff = diffCircuits(before, after)

    expect(diff.identical).toBe(false)
    expect(diff.counts).toEqual({
      added: 1,
      removed: 0,
      moved: 0,
      changed: 0,
      unchanged: 1,
    })

    const entry = only(changedEntries(diff))
    expect(entry.kind).toBe('added')
    expect(entry.before).toBeNull()
    expect(entry.after?.id).toBe('op_2')
    expect(entry.aspects).toEqual([])
  })
})

describe('a gate removed', () => {
  it('is one removal, and the removed operation is kept for the drawing', () => {
    const h = gate('op_1', 'h', [0], 0)
    const x = gate('op_2', 'x', [1], 1)
    const diff = diffCircuits(circuitOf(2, [h, x]), circuitOf(2, [h]))

    expect(diff.counts.removed).toBe(1)
    expect(diff.counts.unchanged).toBe(1)

    const entry = only(changedEntries(diff))
    expect(entry.kind).toBe('removed')
    expect(entry.after).toBeNull()
    // The view has to draw a ghost of what is gone, so the operation itself
    // travels in the entry rather than only its id.
    expect(entry.before).toEqual(x)
  })
})

describe('a gate moved between columns', () => {
  it('is one move along the time axis, not a removal and an addition', () => {
    const before = circuitOf(2, [gate('op_1', 'h', [0], 0)])
    const after = circuitOf(2, [gate('op_1', 'h', [0], 3)])

    const diff = diffCircuits(before, after)

    expect(diff.counts).toEqual({
      added: 0,
      removed: 0,
      moved: 1,
      changed: 0,
      unchanged: 0,
    })
    const entry = only(changedEntries(diff))
    expect(entry.kind).toBe('moved')
    expect(entry.aspects).toEqual(['column'])
    expect(entry.before?.column).toBe(0)
    expect(entry.after?.column).toBe(3)
  })

  it('recognises the move even when the two versions share no ids', () => {
    // A document that was rebuilt elsewhere — an import, a paste over the
    // top — carries its own ids, and pass 1 of the matcher has nothing to
    // work with. Passes 3 and 4 are what keep the answer honest.
    const before = circuitOf(2, [gate('a', 'h', [0], 0)])
    const after = circuitOf(2, [gate('z', 'h', [0], 2)])

    const entry = only(changedEntries(diffCircuits(before, after)))
    expect(entry.kind).toBe('moved')
    expect(entry.aspects).toEqual(['column'])
  })
})

describe('a gate moved between qubits', () => {
  it('is one move across the register, in the same moment', () => {
    const before = circuitOf(3, [gate('op_1', 'h', [0], 1)])
    const after = circuitOf(3, [gate('op_1', 'h', [2], 1)])

    const entry = only(changedEntries(diffCircuits(before, after)))
    expect(entry.kind).toBe('moved')
    expect(entry.aspects).toEqual(['qubits'])
    expect(entry.before?.targets).toEqual([0])
    expect(entry.after?.targets).toEqual([2])
  })
})

describe('a parameter changed', () => {
  it('is a change in place rather than a move', () => {
    const before = circuitOf(1, [gate('op_1', 'rz', [0], 0, { params: [0] })])
    const after = circuitOf(1, [
      gate('op_1', 'rz', [0], 0, { params: [Math.PI / 2] }),
    ])

    const diff = diffCircuits(before, after)
    expect(diff.counts.moved).toBe(0)

    const entry = only(changedEntries(diff))
    expect(entry.kind).toBe('changed')
    expect(entry.aspects).toEqual(['params'])
    expect(entry.before?.params).toEqual([0])
    expect(entry.after?.params).toEqual([Math.PI / 2])
  })
})

describe('a qubit inserted, shifting everything below it', () => {
  /*
   * The register grows and every operation on a wire at or below the insertion
   * point is renumbered. The diff reports both, and reporting the moves is not
   * a defect of the matcher — it is the only consistent answer available.
   * "Insert a wire at the top" and "add a wire at the bottom, then drag every
   * gate down one" produce the same document, byte for byte, so no comparison
   * of two documents can tell them apart. Saying that the gates now stand on
   * different wires is true of both.
   */
  it('reports the wider register and the wires everything landed on', () => {
    const before = circuitOf(2, [
      gate('op_1', 'h', [0], 0),
      gate('op_2', 'cx', [1], 1, { controls: [0] }),
    ])
    const after = circuitOf(3, [
      gate('op_1', 'h', [1], 0),
      gate('op_2', 'cx', [2], 1, { controls: [1] }),
    ])

    const diff = diffCircuits(before, after)

    expect(diff.qubits).toEqual({ before: 2, after: 3 })
    expect(diff.clbits).toEqual({ before: 2, after: 3 })
    expect(diff.identical).toBe(false)
    expect(diff.counts.added).toBe(0)
    expect(diff.counts.removed).toBe(0)
    expect(diff.counts.moved).toBe(2)

    const [first, second] = changedEntries(diff)
    expect(first?.aspects).toEqual(['qubits'])
    // The CNOT's control moved with it, so both its wires and its controls
    // read as different — one operation, two true statements about it.
    expect(second?.aspects).toEqual(['qubits', 'controls'])
  })

  it('leaves an untouched wire above the insertion point untouched', () => {
    const before = circuitOf(2, [
      gate('op_1', 'h', [0], 0),
      gate('op_2', 'x', [1], 0),
    ])
    // A wire inserted at the bottom: nothing is renumbered.
    const after = circuitOf(3, [
      gate('op_1', 'h', [0], 0),
      gate('op_2', 'x', [1], 0),
    ])

    const diff = diffCircuits(before, after)
    expect(diff.qubits).toEqual({ before: 2, after: 3 })
    expect(changedEntries(diff)).toEqual([])
    // Register width is part of the document, so this is still not identical.
    expect(diff.identical).toBe(false)
  })
})

describe('two circuits that differ only in operation order within a column', () => {
  /*
   * THE CASE THIS MODULE EXISTS FOR. §6: a column is one instant, and the
   * operations in it happen simultaneously. `operations` is a bag, and the
   * order two gates of one column happen to sit in is a fact about the array
   * and about nothing else — a JSON round trip, a paste, a save from another
   * client can each reorder it. A diff that called this a change would light up
   * every version of every circuit for no reason at all.
   */
  it('is not a difference', () => {
    const h = gate('op_1', 'h', [0], 0)
    const x = gate('op_2', 'x', [1], 0)
    const y = gate('op_3', 'y', [2], 0)

    const diff = diffCircuits(circuitOf(3, [h, x, y]), circuitOf(3, [y, h, x]))

    expect(diff.identical).toBe(true)
    expect(changedEntries(diff)).toEqual([])
    expect(diff.counts.unchanged).toBe(3)
  })

  it('is not a difference even when the two versions share no ids', () => {
    // The reorder cannot be excused by the ids agreeing, because they do not.
    // Pass 2 — same column, same targets — is what carries this one.
    const before = circuitOf(3, [
      gate('a', 'h', [0], 0),
      gate('b', 'x', [1], 0),
    ])
    const after = circuitOf(3, [gate('y', 'x', [1], 0), gate('z', 'h', [0], 0)])

    expect(diffCircuits(before, after).identical).toBe(true)
  })

  it('is not a difference when a control is listed on the other side', () => {
    // Controls are a set of wires, not a sequence. `[0, 2]` and `[2, 0]` are
    // the same controlled gate and neither spelling is more correct.
    const before = circuitOf(3, [
      gate('op_1', 'ccx', [1], 0, { controls: [0, 2] }),
    ])
    const after = circuitOf(3, [
      gate('op_1', 'ccx', [1], 0, { controls: [2, 0] }),
    ])

    expect(diffCircuits(before, after).identical).toBe(true)
  })
})

describe('changes that are neither a move nor a placement', () => {
  it('reads a different gate in the same cell as a change, not a swap', () => {
    const before = circuitOf(1, [gate('op_1', 'h', [0], 0)])
    // A fresh id, because the editor mints one for every placed gate: this is
    // a delete and a place, and the diff still reports it as one change to the
    // cell rather than as two unrelated events.
    const after = circuitOf(1, [gate('op_9', 'x', [0], 0)])

    const entry = only(changedEntries(diffCircuits(before, after)))
    expect(entry.kind).toBe('changed')
    expect(entry.aspects).toEqual(['gate'])
  })

  it('reads an added control as a change, not as a move', () => {
    // The gate reaches one wire further, and it has not gone anywhere: what
    // changed is what it is, not where it stands.
    const before = circuitOf(2, [gate('op_1', 'x', [1], 0)])
    const after = circuitOf(2, [gate('op_1', 'x', [1], 0, { controls: [0] })])

    const entry = only(changedEntries(diffCircuits(before, after)))
    expect(entry.kind).toBe('changed')
    expect(entry.aspects).toEqual(['controls'])
  })

  it('reads a control flipped to fire on zero as a change', () => {
    const before = circuitOf(2, [gate('op_1', 'x', [1], 0, { controls: [0] })])
    const after = circuitOf(2, [
      gate('op_1', 'x', [1], 0, { controls: [{ qubit: 0, state: 0 }] }),
    ])

    const entry = only(changedEntries(diffCircuits(before, after)))
    expect(entry.aspects).toEqual(['controls'])
  })

  it('reads a measurement rewired to another classical bit as a change', () => {
    const before = circuitOf(2, [
      gate('op_1', 'measure', [0], 0, { clbitTargets: [0] }),
    ])
    const after = circuitOf(2, [
      gate('op_1', 'measure', [0], 0, { clbitTargets: [1] }),
    ])

    const entry = only(changedEntries(diffCircuits(before, after)))
    expect(entry.kind).toBe('changed')
    expect(entry.aspects).toEqual(['classical'])
  })

  it('reports a move and a retune together, as one moved operation', () => {
    const before = circuitOf(2, [gate('op_1', 'rz', [0], 0, { params: [0] })])
    const after = circuitOf(2, [gate('op_1', 'rz', [1], 0, { params: [1] })])

    const entry = only(changedEntries(diffCircuits(before, after)))
    // The headline is what a reader sees from across the room; the detail is
    // in the aspects, and neither is dropped.
    expect(entry.kind).toBe('moved')
    expect(entry.aspects).toEqual(['qubits', 'params'])
  })

  it('reports a renamed wire without inventing an operation change', () => {
    const before = circuitOf(2, [gate('op_1', 'h', [0], 0)])
    const after = circuitOf(2, [gate('op_1', 'h', [0], 0)], {
      qubitLabels: ['control', 'q1'],
    })

    const diff = diffCircuits(before, after)
    expect(diff.labelsChanged).toBe(true)
    expect(diff.identical).toBe(false)
    expect(changedEntries(diff)).toEqual([])
  })

  it('does not call an explicit default name a rename', () => {
    // `qubitLabels` absent means every wire answers to `qN`, so a document
    // that spells those out says exactly what one that omits them says.
    const before = circuitOf(2, [gate('op_1', 'h', [0], 0)])
    const after = circuitOf(2, [gate('op_1', 'h', [0], 0)], {
      qubitLabels: ['q0', 'q1'],
    })

    expect(diffCircuits(before, after).identical).toBe(true)
  })
})

describe('the matcher declines to invent a move', () => {
  it('keeps an unrelated placement and removal apart', () => {
    /*
     * One `H` leaves the top-left corner and another appears three columns
     * away on a different wire, with no id, no column and no wire in common.
     * Pairing them would draw an arrow across the diagram for a drag nobody
     * performed; an addition beside a removal is the honest reading.
     */
    const before = circuitOf(3, [gate('a', 'h', [0], 0)])
    const after = circuitOf(3, [gate('b', 'h', [2], 3)])

    const diff = diffCircuits(before, after)
    expect(diff.counts.added).toBe(1)
    expect(diff.counts.removed).toBe(1)
    expect(diff.counts.moved).toBe(0)
  })

  it('prefers the untouched candidate when two could match', () => {
    // Two identical `H`s in one column, one of which slides a column to the
    // right. The one that did not move must not be the one reported as moving.
    const before = circuitOf(2, [
      gate('a', 'h', [0], 0),
      gate('b', 'h', [1], 0),
    ])
    const after = circuitOf(2, [gate('c', 'h', [0], 0), gate('d', 'h', [1], 4)])

    const diff = diffCircuits(before, after)
    expect(diff.counts.unchanged).toBe(1)
    const entry = only(changedEntries(diff))
    expect(entry.kind).toBe('moved')
    expect(entry.before?.targets).toEqual([1])
    expect(entry.after?.targets).toEqual([1])
  })
})

describe('a circuit compared with itself', () => {
  it('reports nothing at all', () => {
    const same = circuitOf(3, [
      gate('op_1', 'h', [0], 0),
      gate('op_2', 'cx', [1], 1, { controls: [0] }),
      gate('op_3', 'measure', [1], 2, { clbitTargets: [1] }),
    ])

    const diff = diffCircuits(same, same)
    expect(diff.identical).toBe(true)
    expect(diff.counts.unchanged).toBe(3)
    expect(diff.qubits).toBeNull()
    expect(diff.clbits).toBeNull()
    expect(diff.labelsChanged).toBe(false)
  })
})

describe('entry order', () => {
  it('reads left to right and then top to bottom, whatever the array said', () => {
    const before = circuitOf(3, [])
    const after = circuitOf(3, [
      gate('op_3', 'y', [2], 2),
      gate('op_1', 'h', [1], 0),
      gate('op_2', 'x', [0], 1),
    ])

    const order = changedEntries(diffCircuits(before, after)).map(
      (entry) => entry.after?.id
    )
    expect(order).toEqual(['op_1', 'op_2', 'op_3'])
  })
})

describe('operationCells', () => {
  it('names every wire the operation occupies, in its column', () => {
    const cnot = gate('op_1', 'cx', [2], 4, { controls: [0] })
    expect(operationCells(cnot)).toEqual([
      { qubit: 0, column: 4 },
      { qubit: 2, column: 4 },
    ])
  })

  it('names a wire once even when it is both listed and derived', () => {
    // A single-target gate on one wire is one cell, not one cell per mention.
    expect(operationCells(gate('op_1', 'h', [1], 0))).toEqual([
      { qubit: 1, column: 0 },
    ])
  })
})

/**
 * The four ways this module used to describe something that did not happen.
 *
 * Each was found by driving the real screen: a wire renamed that nobody
 * renamed, two moves nobody made, a move from a place to that same place, and
 * two versions that simulate differently called "the same circuit".
 */
describe('changes nobody made', () => {
  it('does not report a rename when the register merely grew', () => {
    /*
     * `sameLabels` walked to the *wider* register and compared a wire that
     * exists on one side against a null on the other, so every growth and
     * every shrink printed "At least one wire was renamed." next to the line
     * that already explained what did happen. Neither document names a wire.
     */
    const h = gate('op_1', 'h', [0], 0)
    const diff = diffCircuits(circuitOf(2, [h]), circuitOf(3, [h]))

    expect(diff.labelsChanged).toBe(false)
    expect(diff.qubits).toEqual({ before: 2, after: 3 })
  })

  it('still reports a rename of a wire that exists in both', () => {
    const h = gate('op_1', 'h', [0], 0)
    const before = circuitOf(2, [h], { qubitLabels: ['alice', 'bob'] })
    const after = circuitOf(3, [h], { qubitLabels: ['alice', 'carol', 'dave'] })

    expect(diffCircuits(before, after).labelsChanged).toBe(true)
  })

  it('reads two twin gates with their ids exchanged as no change at all', () => {
    /*
     * Two identical gates in one column, ids swapped: the same picture, drawn
     * the same way. Matching on id before matching on place paired each H with
     * its id-mate on the other wire and reported two moves.
     */
    const before = circuitOf(2, [
      gate('a', 'h', [0], 0),
      gate('b', 'h', [1], 0),
    ])
    const after = circuitOf(2, [gate('b', 'h', [0], 0), gate('a', 'h', [1], 0)])

    const diff = diffCircuits(before, after)
    expect(diff.identical).toBe(true)
    expect(diff.counts.moved).toBe(0)
    expect(diff.counts.unchanged).toBe(2)
  })

  it('reads reordered targets as a reordering, not as a move to the same place', () => {
    /*
     * A two-target gate whose wires are listed the other way round occupies
     * exactly the cells it did. Calling that a move produced "SWAP moved from
     * q0 and q1, moment 1, to q0 and q1, moment 1" — with no arrow, because
     * the distance was zero — and offered no detail either.
     */
    const before = circuitOf(2, [gate('s', 'swap', [0, 1], 1)])
    const after = circuitOf(2, [gate('s', 'swap', [1, 0], 1)])

    const entry = only(changedEntries(diffCircuits(before, after)))
    expect(entry.kind).toBe('changed')
    expect(entry.aspects).toEqual(['order'])
  })

  it('keeps calling a genuine change of wires a move', () => {
    const before = circuitOf(3, [gate('s', 'swap', [0, 1], 1)])
    const after = circuitOf(3, [gate('s', 'swap', [1, 2], 1)])

    const entry = only(changedEntries(diffCircuits(before, after)))
    expect(entry.kind).toBe('moved')
    expect(entry.aspects).toEqual(['qubits'])
  })
})

/**
 * What the diagram cannot draw, and the diff used to ignore entirely.
 *
 * Reachable today through the URL codec and through the API, both of which
 * carry `parameters` and `customGates`, even though the editor authors
 * neither. "These two versions hold the same circuit" about two documents that
 * simulate differently is the one kind of wrong a diff must never be.
 */
describe('the parts of a document that are not operations', () => {
  it('does not call two different tunings the same circuit', () => {
    const rz = gate('a', 'rz', [0], 0, { params: ['theta'] })
    const before = circuitOf(1, [rz], {
      parameters: [{ name: 'theta', value: 0 }],
    })
    const after = circuitOf(1, [rz], {
      parameters: [{ name: 'theta', value: Math.PI }],
    })

    const diff = diffCircuits(before, after)
    expect(diff.parametersChanged).toBe(true)
    expect(diff.identical).toBe(false)
    // The operation itself really is unchanged: it references `theta` in both.
    expect(diff.counts.unchanged).toBe(1)
  })

  it('does not mind the order the parameters were declared in', () => {
    const before = circuitOf(1, [], {
      parameters: [
        { name: 'theta', value: 1 },
        { name: 'phi', value: 2 },
      ],
    })
    const after = circuitOf(1, [], {
      parameters: [
        { name: 'phi', value: 2 },
        { name: 'theta', value: 1 },
      ],
    })

    expect(diffCircuits(before, after).identical).toBe(true)
  })

  it('does not call two different subcircuit bodies the same circuit', () => {
    const block = gate('a', 'block', [0], 0)
    const before = circuitOf(1, [block], {
      customGates: {
        block: { qubits: 1, operations: [gate('i', 'h', [0], 0)] },
      },
    })
    const after = circuitOf(1, [block], {
      customGates: {
        block: { qubits: 1, operations: [gate('i', 'x', [0], 0)] },
      },
    })

    const diff = diffCircuits(before, after)
    expect(diff.customGatesChanged).toBe(true)
    expect(diff.identical).toBe(false)
  })

  it('leaves two documents that carry neither alone', () => {
    const h = gate('op_1', 'h', [0], 0)
    const diff = diffCircuits(circuitOf(2, [h]), circuitOf(2, [h]))
    expect(diff.parametersChanged).toBe(false)
    expect(diff.customGatesChanged).toBe(false)
    expect(diff.identical).toBe(true)
  })
})
