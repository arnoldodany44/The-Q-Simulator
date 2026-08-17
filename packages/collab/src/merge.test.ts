/**
 * Two documents, edited while disconnected, merged.
 *
 * This is the milestone. "Yjs converges" is not the question — of course it
 * converges — the question is whether what it converges to is a circuit, and
 * whether both peers agree about which circuit it is.
 *
 * Every test here ends in the same two assertions, because those are the two
 * failure modes and they are not equally visible:
 *
 *   - an invalid circuit, which the editor and the engine would both refuse and
 *     which somebody would therefore notice;
 *   - two peers quietly holding *different* circuits, which nothing notices,
 *     and which is what a CRDT is supposed to have made impossible.
 *
 * `agree()` asserts both at once and every test calls it.
 */

import { CIRCUIT_SCHEMA_VERSION, validateCircuit } from '@qsim/schema'
import type { Circuit, Operation } from '@qsim/schema'
import { describe, expect, it } from 'vitest'
import * as Y from 'yjs'

import { projectCircuit, type CircuitProjection } from './project.js'
import { documentOf, writeCircuit } from './write.js'

/**
 * A peer: a document, its client id, and the projection it last read.
 *
 * The client id is fixed rather than random so that the tie-break — which only
 * decides genuinely concurrent placements — is predictable in a test. Nothing
 * in the design depends on the *value*, only on both peers using the same rule.
 */
interface Peer {
  readonly name: string
  readonly doc: Y.Doc
  projection: CircuitProjection
}

/** A peer holding its own copy of `doc`, as if it had just synced. */
function fork(doc: Y.Doc, name: string, clientID: number): Peer {
  const copy = new Y.Doc()
  copy.clientID = clientID
  Y.applyUpdate(copy, Y.encodeStateAsUpdate(doc))
  return { name, doc: copy, projection: projectCircuit(copy) }
}

/**
 * An edit made locally, exactly as the bridge makes one: the peer's own
 * projection is the baseline, and the store's circuit is the input.
 */
function edit(peer: Peer, change: (circuit: Circuit) => Circuit): void {
  peer.projection = writeCircuit(peer.doc, change(peer.projection.circuit), {
    origin: peer.name,
    baseline: peer.projection,
  })
}

function place(operation: Operation): (circuit: Circuit) => Circuit {
  return (circuit) => ({
    ...circuit,
    operations: [...circuit.operations, operation],
  })
}

/**
 * Exchange everything both peers did while apart, in both directions.
 *
 * Each state is captured *before* either is applied, which is what makes this a
 * merge of two divergent histories rather than a hand-off.
 */
function reconnect(left: Peer, right: Peer): void {
  const fromLeft = Y.encodeStateAsUpdate(left.doc)
  const fromRight = Y.encodeStateAsUpdate(right.doc)
  Y.applyUpdate(left.doc, fromRight)
  Y.applyUpdate(right.doc, fromLeft)
  left.projection = projectCircuit(left.doc)
  right.projection = projectCircuit(right.doc)
}

/** The two assertions of this file. Returns what both peers agreed on. */
function agree(left: Peer, right: Peer): CircuitProjection {
  expect(validateCircuit(left.projection.circuit)).toEqual([])
  expect(validateCircuit(right.projection.circuit)).toEqual([])
  expect(right.projection.circuit).toEqual(left.projection.circuit)
  // Slot keys included: a slot names the peer that minted it, so both peers
  // see the same one and disagreeing about them would be a divergence too.
  expect(bySlot(right.projection)).toEqual(bySlot(left.projection))
  return left.projection
}

function bySlot(projection: CircuitProjection): readonly unknown[] {
  return [...projection.deferred].sort((a, b) => (a.slot < b.slot ? -1 : 1))
}

const shared: Circuit = {
  schemaVersion: CIRCUIT_SCHEMA_VERSION,
  qubits: 3,
  clbits: 3,
  operations: [{ id: 'op_1', gate: 'h', targets: [0], column: 0 }],
}

/**
 * Ana and Beto, both holding the document they opened a minute ago.
 *
 * Ana's id sorts below Beto's, so she wins a tie. Which one wins is arbitrary;
 * that both agree is not. The ids start at 2 to leave 1 free for a third peer
 * that has to sort ahead of both — Yjs re-draws a client id that is already in
 * the document, so a collision would silently undo the point of choosing them.
 */
function twoPeers(circuit: Circuit = shared): [Peer, Peer] {
  const origin = documentOf(circuit)
  return [fork(origin, 'ana', 2), fork(origin, 'beto', 3)]
}

describe('merging two documents edited while disconnected', () => {
  it('keeps both edits when they do not contend for a cell', () => {
    const [ana, beto] = twoPeers()
    edit(ana, place({ id: 'op_2', gate: 'x', targets: [1], column: 1 }))
    edit(beto, place({ id: 'op_2', gate: 'z', targets: [2], column: 1 }))

    reconnect(ana, beto)
    const merged = agree(ana, beto)

    expect(merged.circuit.operations).toHaveLength(3)
    expect(merged.deferred).toEqual([])
  })

  /**
   * THE CASE THAT MOTIVATES THE WHOLE DESIGN.
   *
   * Ana drops an H on (q0, c3). Beto drops an X on (q0, c3). Both edits are
   * legal, the merge of them is not, and no CRDT will refuse it.
   */
  it('places one of two gates dropped on the same cell and defers the other', () => {
    const [ana, beto] = twoPeers()
    edit(ana, place({ id: 'op_2', gate: 'h', targets: [0], column: 3 }))
    edit(beto, place({ id: 'op_2', gate: 'x', targets: [0], column: 3 }))

    reconnect(ana, beto)
    const merged = agree(ana, beto)

    // One gate is in the circuit. The other is *not lost*: it is in the
    // document, it is reported, and it names what blocked it — which is what
    // makes resolving it an ordinary edit rather than a recovery.
    expect(merged.circuit.operations).toHaveLength(2)
    expect(merged.deferred).toHaveLength(1)
    const [deferred] = merged.deferred
    expect(deferred?.reason).toBe('column-conflict')
    expect(deferred?.blockedBy).toEqual([merged.circuit.operations[1]?.id])

    // Ana's slot sorts first, so hers is the one that stands. Asserted to pin
    // the rule down, not because the winner matters.
    expect(merged.circuit.operations[1]?.gate).toBe('h')
    expect(deferred?.operation?.gate).toBe('x')
  })

  it('never fuses two operations that were minted with the same id', () => {
    // Both peers count up from `op_1` inside the document they opened, so both
    // call their next gate `op_2`. Keyed by id those would be one key, and a
    // Y.Map merges one key field by field: the result would be a gate with
    // Ana's name and Beto's targets — an edit neither of them made.
    const [ana, beto] = twoPeers()
    edit(ana, place({ id: 'op_2', gate: 'h', targets: [1], column: 1 }))
    edit(
      beto,
      place({ id: 'op_2', gate: 'cx', targets: [2], controls: [1], column: 2 })
    )

    reconnect(ana, beto)
    const merged = agree(ana, beto)

    expect(merged.circuit.operations).toHaveLength(3)
    expect(merged.deferred).toEqual([])
    // Both gates survive intact — no operation mixes one peer's gate with the
    // other's targets.
    expect(
      merged.circuit.operations.map((operation) => ({
        gate: operation.gate,
        targets: operation.targets,
        column: operation.column,
      }))
    ).toEqual([
      { gate: 'h', targets: [0], column: 0 },
      { gate: 'h', targets: [1], column: 1 },
      { gate: 'cx', targets: [2], column: 2 },
    ])
    // And the ids are unique, because the contract refuses a circuit whose
    // operations cannot be told apart. *Both* holders of the colliding id are
    // renamed, deterministically, and the shared id is retired: M5.4 made
    // `operations[].id` the thing a comment anchors to, so leaving the plain id
    // on whichever claim happened to sort first would hand one person's comment
    // to another person's gate. An anchor may fail to resolve; it may never
    // resolve to a different gate. See `renameDuplicateIds`.
    const ids = merged.circuit.operations.map((operation) => operation.id)
    expect(new Set(ids).size).toBe(3)
    expect(ids).not.toContain('op_2')
    expect(ids.filter((id) => id.startsWith('op_2#'))).toHaveLength(2)
    // The untouched operation keeps its own id: only a collision renames.
    expect(ids).toContain('op_1')
  })

  it('merges two edits to one operation field by field', () => {
    // The reason an operation is a nested map rather than one JSON value.
    // Adding a control and changing an angle are not in conflict in any sense
    // a person would recognise, so both survive.
    const [ana, beto] = twoPeers({
      ...shared,
      operations: [
        { id: 'op_1', gate: 'rz', targets: [0], params: [0], column: 0 },
      ],
    })
    edit(ana, (circuit) => ({
      ...circuit,
      operations: [{ ...circuit.operations[0]!, params: [1.25] }],
    }))
    edit(beto, (circuit) => ({
      ...circuit,
      operations: [{ ...circuit.operations[0]!, controls: [1] }],
    }))

    reconnect(ana, beto)
    const merged = agree(ana, beto)

    expect(merged.circuit.operations).toEqual([
      {
        id: 'op_1',
        gate: 'rz',
        targets: [0],
        params: [1.25],
        controls: [1],
        column: 0,
      },
    ])
  })

  it('lets a deletion win over a concurrent edit of the same operation', () => {
    // Ana changes the angle, Beto deletes the gate. The document has one
    // answer to this and it is Yjs's: the key is gone, and the writes inside
    // it went with it. It is worth a test because the *other* plausible
    // outcome — a resurrected operation missing whichever fields Ana did not
    // touch — would be a shape the contract refuses.
    const [ana, beto] = twoPeers({
      ...shared,
      operations: [
        { id: 'op_1', gate: 'rz', targets: [0], params: [0], column: 0 },
      ],
    })
    edit(ana, (circuit) => ({
      ...circuit,
      operations: [{ ...circuit.operations[0]!, params: [2] }],
    }))
    edit(beto, (circuit) => ({ ...circuit, operations: [] }))

    reconnect(ana, beto)
    const merged = agree(ana, beto)

    expect(merged.circuit.operations).toEqual([])
  })

  it('does not let an edit to a deleted operation land on a later one', () => {
    // The reason a slot key may never be reused, tested rather than asserted.
    // Ana deletes a gate and places another; a counter that handed out the
    // freed key again would give the new gate the old one's slot, and Beto's
    // concurrent edit — made before he saw the deletion — would move a gate he
    // has never seen. Two unrelated operations, fused, with nothing in the
    // document to show it happened.
    const [ana, beto] = twoPeers()
    edit(ana, (circuit) => ({ ...circuit, operations: [] }))
    edit(ana, place({ id: 'op_2', gate: 'x', targets: [1], column: 1 }))
    edit(beto, (circuit) => ({
      ...circuit,
      operations: [{ ...circuit.operations[0]!, column: 4 }],
    }))

    reconnect(ana, beto)
    const merged = agree(ana, beto)

    expect(merged.circuit.operations).toEqual([
      { id: 'op_2', gate: 'x', targets: [1], column: 1 },
    ])
  })

  it('defers a measurement whose classical bit is taken in its column', () => {
    // The contract accepts two writers of one bit in one column; the engine has
    // no rule for ordering them, so the editor never builds that shape and the
    // projection will not either. Two peers apart can, so it is deferred like a
    // cell conflict — on different wires, which is what makes this a rule the
    // contract's column check does not cover.
    const [ana, beto] = twoPeers()
    edit(
      ana,
      place({
        id: 'op_2',
        gate: 'measure',
        targets: [1],
        clbitTargets: [0],
        column: 4,
      })
    )
    edit(
      beto,
      place({
        id: 'op_3',
        gate: 'measure',
        targets: [2],
        clbitTargets: [0],
        column: 4,
      })
    )

    reconnect(ana, beto)
    const merged = agree(ana, beto)

    expect(merged.circuit.operations).toHaveLength(2)
    expect(merged.deferred[0]?.reason).toBe('clbit-in-use')
  })

  it('does not let a newcomer displace an operation that was already there', () => {
    // The Lamport stamp, doing its job. Beto's gate is written after he has
    // seen Ana's, so it is strictly younger and loses the cell — whichever way
    // the client ids happen to sort. Without the stamp the tie-break would
    // decide, and a peer joining with a low client id would evict gates that
    // had been on screen for an hour.
    const [ana, beto] = twoPeers()
    edit(ana, place({ id: 'op_2', gate: 'h', targets: [0], column: 3 }))

    // Beto syncs, so his next edit happens *after* Ana's in the merged history.
    Y.applyUpdate(beto.doc, Y.encodeStateAsUpdate(ana.doc))
    beto.projection = projectCircuit(beto.doc)
    // Then he goes offline again and lands on the same cell. `late` carries the
    // client id that sorts *before* Ana's, so only the stamp can decide this the
    // right way round — the tie-break would hand him the cell.
    const late = fork(beto.doc, 'late', 1)
    expect(late.doc.clientID).toBe(1)
    edit(late, place({ id: 'op_9', gate: 'x', targets: [0], column: 3 }))
    edit(ana, place({ id: 'op_3', gate: 'z', targets: [1], column: 3 }))

    reconnect(ana, late)
    const merged = agree(ana, late)

    expect(merged.circuit.operations.map((operation) => operation.id)).toEqual([
      'op_1',
      'op_2',
      'op_3',
    ])
    expect(merged.deferred[0]?.operation?.id).toBe('op_9')
    expect(merged.deferred[0]?.blockedBy).toEqual(['op_2'])
  })

  it('agrees no matter which order the two updates arrive in', () => {
    // A third peer joining sees the same document whichever way round its
    // provider hands it the two histories. This is the property that map
    // iteration order would quietly break: the content is identical, the
    // insertion order is not, and anything that read the map in its own order
    // would produce two different circuits from the same bytes.
    const [ana, beto] = twoPeers()
    edit(ana, place({ id: 'op_2', gate: 'h', targets: [0], column: 3 }))
    edit(beto, place({ id: 'op_2', gate: 'x', targets: [0], column: 3 }))
    const fromAna = Y.encodeStateAsUpdate(ana.doc)
    const fromBeto = Y.encodeStateAsUpdate(beto.doc)

    const first = new Y.Doc()
    Y.applyUpdate(first, fromAna)
    Y.applyUpdate(first, fromBeto)
    const second = new Y.Doc()
    Y.applyUpdate(second, fromBeto)
    Y.applyUpdate(second, fromAna)

    const left = projectCircuit(first)
    const right = projectCircuit(second)
    expect(validateCircuit(left.circuit)).toEqual([])
    expect(right.circuit).toEqual(left.circuit)
    expect(right.deferred).toEqual(left.deferred)
  })

  it('resolves a conflict as an ordinary edit, with nothing lost', () => {
    // What the deferral is *for*. Ana moves her gate out of the contested cell;
    // Beto's gate — which has been sitting in the document the whole time —
    // becomes placeable, and the projection says so without anybody re-sending
    // anything.
    const [ana, beto] = twoPeers()
    edit(ana, place({ id: 'op_2', gate: 'h', targets: [0], column: 3 }))
    edit(beto, place({ id: 'op_2', gate: 'x', targets: [0], column: 3 }))
    reconnect(ana, beto)
    expect(ana.projection.deferred).toHaveLength(1)

    edit(ana, (circuit) => ({
      ...circuit,
      operations: circuit.operations.map((operation) =>
        operation.gate === 'h' && operation.column === 3
          ? { ...operation, column: 5 }
          : operation
      ),
    }))
    reconnect(ana, beto)
    const merged = agree(ana, beto)

    expect(merged.deferred).toEqual([])
    expect(
      merged.circuit.operations.map((operation) => [
        operation.gate,
        operation.column,
      ])
    ).toEqual([
      ['h', 0],
      ['h', 5],
      ['x', 3],
    ])
  })
})
