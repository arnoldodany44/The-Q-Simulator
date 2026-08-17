import { CIRCUIT_SCHEMA_VERSION, validateCircuit } from '@qsim/schema'
import type { Circuit } from '@qsim/schema'
import { describe, expect, it } from 'vitest'
import * as Y from 'yjs'

import {
  FIELD_COLUMN,
  FIELD_GATE,
  FIELD_ID,
  FIELD_SEQ,
  FIELD_TARGETS,
  META_QUBITS,
  circuitRoots,
} from './document.js'
import {
  MAX_DOCUMENT_GATES,
  MAX_DOCUMENT_OPERATIONS,
  projectCircuit,
} from './project.js'
import { documentOf, writeCircuit } from './write.js'

/** A document with a known client id, so slot keys are predictable. */
function docFor(circuit: Circuit, clientID: number): Y.Doc {
  const doc = new Y.Doc()
  doc.clientID = clientID
  writeCircuit(doc, circuit, {
    origin: null,
    baseline: projectCircuit(doc),
  })
  return doc
}

const bell: Circuit = {
  schemaVersion: CIRCUIT_SCHEMA_VERSION,
  qubits: 2,
  clbits: 2,
  operations: [
    { id: 'op_1', gate: 'h', targets: [0], column: 0 },
    { id: 'op_2', gate: 'cx', targets: [1], controls: [0], column: 1 },
  ],
}

describe('projectCircuit', () => {
  it('reads an untouched document as a one-wire empty circuit', () => {
    const projection = projectCircuit(new Y.Doc())

    // There is no such thing as a zero-qubit circuit in the contract, so the
    // floor is one wire rather than a refusal: a joiner that attaches before
    // the first sync frame must have something valid to draw.
    expect(projection.circuit).toEqual({
      schemaVersion: CIRCUIT_SCHEMA_VERSION,
      qubits: 1,
      clbits: 0,
      operations: [],
    })
    expect(projection.deferred).toEqual([])
    expect(validateCircuit(projection.circuit)).toEqual([])
  })

  it('round-trips a circuit through the document', () => {
    const projection = projectCircuit(documentOf(bell))

    expect(projection.circuit).toEqual(bell)
    expect(projection.slots.size).toBe(2)
  })

  it('never writes to the document it reads', () => {
    // The property the whole design rests on. A reader that repaired what it
    // read would have every peer performing the same repair concurrently, which
    // is a second conflict invented by the fix — so the projection resolves a
    // broken merge by *deciding* rather than by writing, and this is what says
    // so out loud. It holds even for a document that needs deferring.
    const doc = docFor(bell, 1)
    circuitRoots(doc).operations.set(
      'other-1',
      new Y.Map<unknown>([
        [FIELD_ID, 'op_9'],
        [FIELD_GATE, 'y'],
        [FIELD_TARGETS, [0]],
        [FIELD_COLUMN, 0],
        [FIELD_SEQ, 99],
      ])
    )
    const before = Y.encodeStateAsUpdate(doc)
    let updates = 0
    doc.on('update', () => {
      updates += 1
    })

    expect(projectCircuit(doc).deferred).toHaveLength(1)

    expect(updates).toBe(0)
    expect([...Y.encodeStateAsUpdate(doc)]).toEqual([...before])
  })

  it('round-trips labels, parameters and custom gates', () => {
    const circuit: Circuit = {
      schemaVersion: CIRCUIT_SCHEMA_VERSION,
      qubits: 2,
      clbits: 0,
      qubitLabels: ['alice', 'bob'],
      parameters: [
        { name: 'theta', value: 0.5 },
        { name: 'phi', value: 1.25 },
      ],
      operations: [
        { id: 'op_1', gate: 'rz', targets: [0], params: ['theta'], column: 0 },
        { id: 'op_2', gate: 'bell', targets: [0, 1], column: 1 },
      ],
      customGates: {
        bell: {
          qubits: 2,
          operations: [
            { id: 'b1', gate: 'h', targets: [0], column: 0 },
            { id: 'b2', gate: 'cx', targets: [1], controls: [0], column: 1 },
          ],
        },
      },
    }

    const projection = projectCircuit(documentOf(circuit))

    expect(projection.circuit).toEqual(circuit)
  })

  it('keeps the declaration order of parameters', () => {
    // The stamp is what does this. Sorting by name would move a slider under
    // the other peer's cursor the moment somebody declared `alpha`.
    const doc = docFor(
      {
        ...bell,
        parameters: [
          { name: 'zeta', value: 1 },
          { name: 'alpha', value: 2 },
        ],
      },
      1
    )

    expect(projectCircuit(doc).circuit.parameters).toEqual([
      { name: 'zeta', value: 1 },
      { name: 'alpha', value: 2 },
    ])
  })

  it('names the wires the editor would name when only one is labelled', () => {
    // §6 wants one label per qubit or none, and a wire that reads `q1` on one
    // screen and nothing on another is the divergence this module prevents.
    const doc = docFor(bell, 1)
    circuitRoots(doc).labels.set('1', 'bob')

    expect(projectCircuit(doc).circuit.qubitLabels).toEqual(['q0', 'bob'])
  })

  it('orders operations by when they entered the document', () => {
    // Not by column, and not by whatever order this peer's map iterates in.
    // Entry order is what a solo editor's own appends produce, so attaching a
    // document to a session does not reshuffle the array under the canvas —
    // and it is agreed between peers, which map iteration order is not.
    const doc = docFor({ ...bell, operations: [] }, 1)
    let projection = projectCircuit(doc)
    for (const operation of [
      { id: 'late', gate: 'x', targets: [0], column: 5 },
      { id: 'early', gate: 'x', targets: [0], column: 0 },
    ]) {
      projection = writeCircuit(
        doc,
        {
          ...projection.circuit,
          operations: [...projection.circuit.operations, operation],
        },
        { origin: null, baseline: projection }
      )
    }

    expect(projection.circuit.operations.map((o) => o.id)).toEqual([
      'late',
      'early',
    ])
  })

  describe('a document a stranger wrote into', () => {
    it('defers a slot that does not hold an operation at all', () => {
      const doc = docFor(bell, 1)
      circuitRoots(doc).operations.set('x-1', 7)

      const projection = projectCircuit(doc)

      expect(projection.circuit.operations).toHaveLength(2)
      expect(projection.deferred).toEqual([
        { slot: 'x-1', reason: 'malformed', blockedBy: [] },
      ])
    })

    it('defers an operation whose shape the contract refuses', () => {
      const doc = docFor(bell, 1)
      const fields = new Y.Map<unknown>()
      circuitRoots(doc).operations.set('x-1', fields)
      fields.set(FIELD_ID, 'op_9')
      fields.set(FIELD_GATE, 'h')
      fields.set(FIELD_TARGETS, 'not an array')
      fields.set(FIELD_COLUMN, 3)
      fields.set(FIELD_SEQ, 9)

      expect(projectCircuit(doc).deferred).toEqual([
        { slot: 'x-1', reason: 'malformed', blockedBy: [] },
      ])
    })

    it('defers an operation the whole document refuses', () => {
      // A gate nobody has heard of is a shape the contract accepts and a
      // circuit it refuses, so it survives the placement pass and dies in
      // `settle`. That is the case a structural reading cannot catch.
      const doc = docFor(bell, 1)
      const fields = new Y.Map<unknown>()
      circuitRoots(doc).operations.set('x-1', fields)
      fields.set(FIELD_ID, 'op_9')
      fields.set(FIELD_GATE, 'definitely-not-a-gate')
      fields.set(FIELD_TARGETS, [0])
      fields.set(FIELD_COLUMN, 3)
      fields.set(FIELD_SEQ, 9)

      const projection = projectCircuit(doc)

      expect(projection.circuit.operations).toHaveLength(2)
      expect(projection.deferred).toEqual([
        {
          slot: 'x-1',
          reason: 'invalid',
          operation: {
            id: 'op_9',
            gate: 'definitely-not-a-gate',
            targets: [0],
            column: 3,
          },
          blockedBy: [],
        },
      ])
      expect(validateCircuit(projection.circuit)).toEqual([])
    })

    it('defers the operations a narrowed register no longer holds', () => {
      // Reachable without malice: one peer removed a wire while another used
      // it. The register is not grown back to rescue them, because the removal
      // is a real edit somebody made.
      const doc = docFor(bell, 1)
      circuitRoots(doc).meta.set(META_QUBITS, 1)

      const projection = projectCircuit(doc)

      expect(projection.circuit.qubits).toBe(1)
      expect(projection.circuit.operations.map((o) => o.id)).toEqual(['op_1'])
      expect(projection.deferred).toEqual([
        {
          slot: projection.deferred[0]?.slot ?? '',
          reason: 'out-of-register',
          operation: bell.operations[1],
          blockedBy: [],
        },
      ])
    })

    it('derives a register when the document declares none it can read', () => {
      const doc = docFor(bell, 1)
      circuitRoots(doc).meta.set(META_QUBITS, 'three')

      expect(projectCircuit(doc).circuit.qubits).toBe(2)
    })

    it('reads no more operations than the ceiling, and counts the rest', () => {
      const doc = new Y.Doc()
      const roots = circuitRoots(doc)
      // Deliberately unreadable slots: the ceiling is applied on the cheap
      // pass, before anything is parsed, which is the property under test —
      // otherwise a peer could make every projection do unbounded work.
      doc.transact(() => {
        for (let index = 0; index <= MAX_DOCUMENT_OPERATIONS; index += 1) {
          const fields = new Y.Map<unknown>()
          fields.set(FIELD_SEQ, index)
          roots.operations.set(`x-${index}`, fields)
        }
      })

      const projection = projectCircuit(doc)

      expect(projection.overflow).toBe(1)
      // Every slot that *was* read is reported, and the one past the ceiling is
      // only counted — a document inflated to a million slots must not become a
      // million-entry array on every projection.
      expect(projection.deferred).toHaveLength(MAX_DOCUMENT_OPERATIONS)
      expect(projection.circuit.operations).toEqual([])
    })
  })
})

/**
 * A definition that calls another definition, which §3.1 permits, the contract
 * bounds with `MAX_CUSTOM_GATE_DEPTH`, and `packageSelection` produces whenever
 * somebody wraps a block that already contains one.
 */
const nested: Circuit = {
  schemaVersion: CIRCUIT_SCHEMA_VERSION,
  qubits: 2,
  clbits: 0,
  operations: [{ id: 'op_2', gate: 'wrapper', targets: [0, 1], column: 0 }],
  customGates: {
    pair: {
      qubits: 2,
      operations: [
        { id: 'd1', gate: 'h', targets: [0], column: 0 },
        { id: 'd2', gate: 'cx', targets: [1], controls: [0], column: 1 },
      ],
    },
    wrapper: {
      qubits: 2,
      operations: [{ id: 'w1', gate: 'pair', targets: [0, 1], column: 0 }],
    },
  },
}

describe('custom gate definitions are judged together', () => {
  it('keeps a definition whose body calls another definition', () => {
    /*
     * Probed one at a time, `wrapper` names a gate nothing declares, so the
     * contract answered `unknown-gate` and the definition was dropped from the
     * projection — which deferred every operation that used it as `invalid` and
     * let the next `writeGates` delete the definition from the document for
     * good. Opening a session on an ordinary saved circuit emptied it, and every
     * peer agreed, so nothing detected it.
     */
    const projection = projectCircuit(documentOf(nested))

    expect(projection.circuit).toEqual(nested)
    expect(projection.deferred).toEqual([])
    expect(validateCircuit(projection.circuit)).toEqual([])
  })

  it('drops only the definition the contract names, and keeps its siblings', () => {
    const doc = documentOf(nested)
    circuitRoots(doc).gates.set('broken', { qubits: 1, operations: 'nope' })

    const projection = projectCircuit(doc)

    expect(Object.keys(projection.circuit.customGates ?? {}).sort()).toEqual([
      'pair',
      'wrapper',
    ])
    expect(projection.circuit.operations).toHaveLength(1)
  })

  it('reads no more definitions than the ceiling allows', () => {
    const doc = new Y.Doc()
    const roots = circuitRoots(doc)
    doc.transact(() => {
      roots.meta.set(META_QUBITS, 1)
      for (let index = 0; index < MAX_DOCUMENT_GATES + 4; index += 1) {
        // Padded so the sort order is the numeric one, which makes *which*
        // definitions survive a fact about the document rather than about
        // string collation.
        roots.gates.set(`g${String(index).padStart(4, '0')}`, {
          qubits: 1,
          operations: [],
        })
      }
    })

    const projection = projectCircuit(doc)

    expect(Object.keys(projection.circuit.customGates ?? {})).toHaveLength(
      MAX_DOCUMENT_GATES
    )
  })
})

describe('wire labels do not depend on this peer’s key order', () => {
  it('ignores a key that is not the canonical spelling of its index', () => {
    /*
     * `Number('00')` is 0, so '0' and '00' named one wire and the later key won
     * — and "later" is this peer's own Y.Map integration order, which two peers
     * holding identical bytes do not agree on. The projection is a pure function
     * of the document or it is nothing.
     */
    const base = Y.encodeStateAsUpdate(
      documentOf({
        schemaVersion: CIRCUIT_SCHEMA_VERSION,
        qubits: 2,
        clbits: 0,
        operations: [],
      })
    )

    const ana = new Y.Doc()
    ana.clientID = 11
    Y.applyUpdate(ana, base)
    const beto = new Y.Doc()
    beto.clientID = 22
    Y.applyUpdate(beto, base)

    ana.transact(() => {
      const labels = circuitRoots(ana).labels
      labels.set('0', 'alice')
      labels.set('1', 'q1')
    })
    beto.transact(() => {
      circuitRoots(beto).labels.set('00', 'intruder')
    })
    Y.applyUpdate(ana, Y.encodeStateAsUpdate(beto))
    Y.applyUpdate(beto, Y.encodeStateAsUpdate(ana))

    // Byte-identical, and the key orders differ.
    expect(Y.encodeStateVector(ana)).toEqual(Y.encodeStateVector(beto))
    expect([...circuitRoots(ana).labels.keys()]).not.toEqual([
      ...circuitRoots(beto).labels.keys(),
    ])

    expect(projectCircuit(ana).circuit.qubitLabels).toEqual(['alice', 'q1'])
    expect(projectCircuit(beto).circuit.qubitLabels).toEqual(['alice', 'q1'])
  })
})
