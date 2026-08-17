import { CIRCUIT_SCHEMA_VERSION } from '@qsim/schema'
import type { Circuit } from '@qsim/schema'
import { describe, expect, it } from 'vitest'
import * as Y from 'yjs'

import {
  FIELD_SEQ,
  META_QUBITS,
  circuitRoots,
  slotFields,
  slotKeys,
} from './document.js'
import { projectCircuit, type CircuitProjection } from './project.js'
import { documentOf, writeCircuit } from './write.js'

const local = { peer: 'local' }

const base: Circuit = {
  schemaVersion: CIRCUIT_SCHEMA_VERSION,
  qubits: 2,
  clbits: 2,
  operations: [
    { id: 'op_1', gate: 'rz', targets: [0], params: [0], column: 0 },
    { id: 'op_2', gate: 'x', targets: [1], column: 1 },
  ],
}

function session(circuit: Circuit = base): {
  doc: Y.Doc
  projection: CircuitProjection
  write: (next: Circuit) => CircuitProjection
} {
  const doc = documentOf(circuit)
  const state = { projection: projectCircuit(doc) }
  return {
    doc,
    get projection() {
      return state.projection
    },
    write(next: Circuit) {
      state.projection = writeCircuit(doc, next, {
        origin: local,
        baseline: state.projection,
      })
      return state.projection
    },
  }
}

describe('writeCircuit', () => {
  it('carries the caller’s origin on the transaction', () => {
    // The rule the whole bridge rests on: a client can tell its own writes
    // apart from everybody else's, and therefore does not react to them.
    const doc = documentOf(base)
    const origins: unknown[] = []
    doc.on('update', (_update: Uint8Array, origin: unknown) => {
      origins.push(origin)
    })

    writeCircuit(
      doc,
      { ...base, operations: [] },
      { origin: local, baseline: projectCircuit(doc) }
    )

    expect(origins).toEqual([local])
  })

  it('emits nothing at all when the circuit has not changed', () => {
    // An unconditional write would emit an update per keystroke that changed
    // nothing, clear the redo stack, and make this peer the last writer of
    // values it never touched.
    const doc = documentOf(base)
    let updates = 0
    doc.on('update', () => {
      updates += 1
    })

    writeCircuit(doc, projectCircuit(doc).circuit, {
      origin: local,
      baseline: projectCircuit(doc),
    })

    expect(updates).toBe(0)
  })

  it('writes one field when one field changed', () => {
    const { doc, projection, write } = session()
    const before = Y.encodeStateVector(doc)

    write({
      ...base,
      operations: [
        { ...base.operations[0]!, params: [1.5] },
        base.operations[1]!,
      ],
    })

    // The whole edit, as bytes: a single key on a single slot. This is what
    // makes a slider drag affordable on a socket, and it is a property of the
    // representation rather than of the writer.
    const delta = Y.encodeStateAsUpdate(doc, before)
    expect(delta.byteLength).toBeLessThan(80)
    expect(projection.slots.get('op_1')).toBe(
      projectCircuit(doc).slots.get('op_1')
    )
  })

  it('keeps an operation’s stamp when the operation is edited', () => {
    // A stamp that moved would reorder the array on somebody else's screen and
    // cost the operation a cell it already held.
    const { doc, write } = session()
    const slot = projectCircuit(doc).slots.get('op_1')!
    const stamp = slotFields(circuitRoots(doc), slot)?.get(FIELD_SEQ)

    write({
      ...base,
      operations: [
        { ...base.operations[0]!, column: 4, targets: [1] },
        base.operations[1]!,
      ],
    })

    expect(slotFields(circuitRoots(doc), slot)?.get(FIELD_SEQ)).toBe(stamp)
  })

  it('deletes the slot of an operation the circuit dropped', () => {
    const { doc, write } = session()

    write({ ...base, operations: [base.operations[0]!] })

    expect(slotKeys(circuitRoots(doc))).toHaveLength(1)
  })

  it('removes an optional field rather than leaving it undefined', () => {
    // The contract's objects are strict, so a key left behind holding
    // `undefined` would come back as an unknown key and refuse the operation.
    const { write } = session()
    write({
      ...base,
      operations: [
        { ...base.operations[0]!, params: [1] },
        { ...base.operations[1]!, controls: [0] },
      ],
    })

    const projection = write({
      ...base,
      operations: [
        { ...base.operations[0]!, params: [1] },
        base.operations[1]!,
      ],
    })

    expect(projection.circuit.operations[1]).toEqual({
      id: 'op_2',
      gate: 'x',
      targets: [1],
      column: 1,
    })
  })

  describe('a document holding a deferred operation', () => {
    /** A document where a second gate contends for (q0, c0) and loses. */
    function contended(): ReturnType<typeof session> {
      const held = session()
      // Written directly, as a peer's merged update would arrive: the local
      // store can never produce this, which is exactly why the writer has to
      // be told not to tidy it away.
      const roots = circuitRoots(held.doc)
      roots.operations.set(
        'other-1',
        new Y.Map<unknown>([
          ['id', 'op_9'],
          ['gate', 'y'],
          ['targets', [0]],
          ['column', 0],
          [FIELD_SEQ, 99],
        ])
      )
      held.write(projectCircuit(held.doc).circuit)
      return held
    }

    it('does not delete it when the local circuit is written back', () => {
      // The failure this guards against is the worst one available: the
      // conflict handling itself destroying the gate it was holding back.
      const held = contended()

      expect(held.projection.deferred.map((entry) => entry.slot)).toEqual([
        'other-1',
      ])
      expect(slotKeys(circuitRoots(held.doc))).toContain('other-1')

      held.write({
        ...held.projection.circuit,
        operations: [
          ...held.projection.circuit.operations,
          { id: 'op_3', gate: 'z', targets: [1], column: 6 },
        ],
      })

      expect(slotKeys(circuitRoots(held.doc))).toContain('other-1')
      expect(held.projection.deferred).toHaveLength(1)
    })

    it('reports it as placed once the local edit frees the cell', () => {
      // Why `writeCircuit` returns a projection rather than nothing: this edit
      // says more than the caller asked for, and the caller has to adopt it.
      const held = contended()

      const after = held.write({
        ...held.projection.circuit,
        operations: held.projection.circuit.operations.filter(
          (operation) => operation.id !== 'op_1'
        ),
      })

      expect(after.deferred).toEqual([])
      expect(after.circuit.operations.map((operation) => operation.id)).toEqual(
        ['op_2', 'op_9']
      )
    })
  })

  it('re-creates an operation a peer deleted while it was being edited', () => {
    // An edit is a statement that the operation should exist, and a client
    // holding it on screen has more claim to that than a deletion it never
    // saw. The alternative — dropping the edit silently — is the worse one.
    const { doc, projection, write } = session()
    const slot = projection.slots.get('op_1')!
    circuitRoots(doc).operations.delete(slot)

    const after = write({
      ...base,
      operations: [
        { ...base.operations[0]!, params: [3] },
        base.operations[1]!,
      ],
    })

    expect(after.circuit.operations.map((operation) => operation.id)).toEqual([
      'op_2',
      'op_1',
    ])
    expect(after.slots.get('op_1')).not.toBe(slot)
  })

  it('writes the register, and does not touch what it did not change', () => {
    const { doc, write } = session()
    const roots = circuitRoots(doc)
    expect(roots.meta.get(META_QUBITS)).toBe(2)

    write({ ...base, qubits: 3 })

    expect(roots.meta.get(META_QUBITS)).toBe(3)
  })

  it('drops a label for a wire that no longer exists', () => {
    const { doc, write } = session({ ...base, qubitLabels: ['alice', 'bob'] })

    write({
      schemaVersion: CIRCUIT_SCHEMA_VERSION,
      qubits: 1,
      clbits: 2,
      qubitLabels: ['alice'],
      operations: [base.operations[0]!],
    })

    expect([...circuitRoots(doc).labels.keys()]).toEqual(['0'])
  })
})

describe('naming a wire writes one key', () => {
  const three: Circuit = {
    schemaVersion: CIRCUIT_SCHEMA_VERSION,
    qubits: 3,
    clbits: 0,
    operations: [],
  }

  it('leaves the placeholders the document has never named unwritten', () => {
    /*
     * §6 wants one label per qubit or none, so naming one wire materialises the
     * whole list in the store. Writing every entry of it made a rename of q0 a
     * write to q1's and q2's keys as well — so two peers naming two *different*
     * wires for the first time were two writes to one key, and last-write-wins
     * discarded one rename with nothing in `deferred` to report it.
     */
    const state = session(three)
    state.write({ ...three, qubitLabels: ['alice', 'q1', 'q2'] })

    expect([...circuitRoots(state.doc).labels.keys()]).toEqual(['0'])
    // And the projection is the same circuit either way, because `readLabels`
    // fills an absent key with the same placeholder.
    expect(projectCircuit(state.doc).circuit.qubitLabels).toEqual([
      'alice',
      'q1',
      'q2',
    ])
  })

  it('writes a placeholder back when the document had named that wire', () => {
    const state = session(three)
    state.write({ ...three, qubitLabels: ['q0', 'q1', 'roberto'] })
    expect([...circuitRoots(state.doc).labels.keys()]).toEqual(['2'])

    // Renaming it back to the placeholder is a real edit to a key that exists,
    // so it has to be written rather than skipped.
    state.write({ ...three, qubitLabels: ['q0', 'q1', 'q2'] })
    expect(circuitRoots(state.doc).labels.get('2')).toBe('q2')
  })

  it('deletes a key that is not the canonical spelling of its index', () => {
    const state = session(three)
    state.write({ ...three, qubitLabels: ['alice', 'q1', 'q2'] })
    circuitRoots(state.doc).labels.set('00', 'intruder')

    state.write({ ...three, qubitLabels: ['alice', 'q1', 'roberto'] })

    expect([...circuitRoots(state.doc).labels.keys()].sort()).toEqual([
      '0',
      '2',
    ])
  })
})
