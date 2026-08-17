import { CIRCUIT_SCHEMA_VERSION, type Circuit } from '@qsim/schema'
import { describe, expect, it } from 'vitest'

import { applyPatch, foldPatches, lessonBaseCircuit } from './patch'

/**
 * A patch is the format's one moving part, and it has to be **total**: the
 * reader is editing the same document the lesson is patching, so "this patch
 * does not apply" is an ordinary Tuesday rather than a bug, and it has to
 * arrive as a refusal the player can act on rather than as a throw inside a
 * render.
 */

const wire = (): Circuit => lessonBaseCircuit(1)

describe('applying a patch', () => {
  it('is the identity when it says nothing', () => {
    const before = wire()
    const after = applyPatch(before, {})
    expect(after.ok).toBe(true)
    if (after.ok) expect(after.circuit).toEqual(before)
  })

  it('adds operations', () => {
    const result = applyPatch(wire(), {
      add: [{ id: 'h', gate: 'h', targets: [0], column: 0 }],
    })
    expect(result.ok).toBe(true)
    if (result.ok) expect(result.circuit.operations).toHaveLength(1)
  })

  it('removes by id, and ignores an id that is not there', () => {
    const one = applyPatch(wire(), {
      add: [{ id: 'h', gate: 'h', targets: [0], column: 0 }],
    })
    expect(one.ok).toBe(true)
    if (!one.ok) return

    const two = applyPatch(one.circuit, { remove: ['h', 'never-existed'] })
    expect(two.ok).toBe(true)
    if (two.ok) expect(two.circuit.operations).toEqual([])
  })

  /*
   * The ordering that makes "swap this H for an X" one patch. With `add`
   * first, the contract would refuse the duplicate id halfway through what the
   * author thinks of as a single change.
   */
  it('removes before it adds, so an id can be replaced in one patch', () => {
    const one = applyPatch(wire(), {
      add: [{ id: 'g', gate: 'h', targets: [0], column: 0 }],
    })
    expect(one.ok).toBe(true)
    if (!one.ok) return

    const two = applyPatch(one.circuit, {
      remove: ['g'],
      add: [{ id: 'g', gate: 'x', targets: [0], column: 0 }],
    })
    expect(two.ok).toBe(true)
    if (two.ok) expect(two.circuit.operations[0]?.gate).toBe('x')
  })

  it('refuses a duplicate id with the contract`s own issue', () => {
    const one = applyPatch(wire(), {
      add: [{ id: 'g', gate: 'h', targets: [0], column: 0 }],
    })
    expect(one.ok).toBe(true)
    if (!one.ok) return

    const two = applyPatch(one.circuit, {
      add: [{ id: 'g', gate: 'x', targets: [0], column: 1 }],
    })
    expect(two.ok).toBe(false)
    if (!two.ok) {
      expect(two.issues.map((issue) => issue.code)).toContain(
        'duplicate-operation-id'
      )
    }
  })

  it('refuses two operations in one cell', () => {
    const one = applyPatch(wire(), {
      add: [{ id: 'a', gate: 'h', targets: [0], column: 0 }],
    })
    expect(one.ok).toBe(true)
    if (!one.ok) return

    const two = applyPatch(one.circuit, {
      add: [{ id: 'b', gate: 'x', targets: [0], column: 0 }],
    })
    expect(two.ok).toBe(false)
    if (!two.ok) {
      expect(two.issues.map((issue) => issue.code)).toContain('column-conflict')
    }
  })

  it('grows and shrinks the register', () => {
    const grown = applyPatch(wire(), { qubits: 3 })
    expect(grown.ok).toBe(true)
    if (grown.ok) expect(grown.circuit.qubits).toBe(3)
  })

  it('refuses a shrink that would strand a gate', () => {
    const two = applyPatch(lessonBaseCircuit(2), {
      add: [{ id: 'g', gate: 'h', targets: [1], column: 0 }],
    })
    expect(two.ok).toBe(true)
    if (!two.ok) return

    const shrunk = applyPatch(two.circuit, { qubits: 1 })
    expect(shrunk.ok).toBe(false)
    if (!shrunk.ok) {
      expect(shrunk.issues.map((issue) => issue.code)).toContain(
        'qubit-out-of-range'
      )
    }
  })

  /*
   * `qubitLabels` is sized by the register, so a resize that left it alone
   * would produce a validation issue nobody wrote. This is the one piece of
   * bookkeeping `applyPatch` does on the author's behalf.
   */
  it('keeps qubit labels the same length as the register', () => {
    const labelled: Circuit = {
      schemaVersion: CIRCUIT_SCHEMA_VERSION,
      qubits: 2,
      clbits: 0,
      qubitLabels: ['message', 'helper'],
      operations: [],
    }
    const shrunk = applyPatch(labelled, { qubits: 1 })
    expect(shrunk.ok).toBe(true)
    if (shrunk.ok) expect(shrunk.circuit.qubitLabels).toEqual(['message'])

    const grown = applyPatch(labelled, { qubits: 3 })
    expect(grown.ok).toBe(true)
    if (grown.ok) expect(grown.circuit.qubitLabels).toBeUndefined()
  })
})

describe('folding a lesson from zero', () => {
  it('walks every patch in order', () => {
    const folded = foldPatches(wire(), [
      { add: [{ id: 'a', gate: 'h', targets: [0], column: 0 }] },
      { add: [{ id: 'b', gate: 'z', targets: [0], column: 1 }] },
      { remove: ['a'] },
    ])
    expect(folded.ok).toBe(true)
    if (folded.ok) {
      expect(folded.circuit.operations.map((o) => o.id)).toEqual(['b'])
    }
  })

  it('stops at the first refusal and reports it', () => {
    const folded = foldPatches(wire(), [
      { add: [{ id: 'a', gate: 'h', targets: [0], column: 0 }] },
      { add: [{ id: 'a', gate: 'x', targets: [0], column: 1 }] },
    ])
    expect(folded.ok).toBe(false)
  })
})
