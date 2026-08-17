/**
 * A convergence harness built from the outside in.
 *
 * Independent verification of M5.1: it drives the *real* store, the *real*
 * bridge and real `Y.Doc`s, and it asks one question the implementation's own
 * suite cannot ask of itself — is the merge **commutative**? Every scenario
 * merges the same set of offline edits in every possible order and asserts one
 * result, rather than merging once and asserting that the one result looks
 * plausible.
 *
 * Three properties are checked on every scenario, because three things can be
 * wrong and only the first is visible:
 *
 *   1. every order of the same edits produces the same projection — including
 *      the deferral list, which is what a person is shown;
 *   2. every peer's *store* holds that projection, so the circuit on screen and
 *      the circuit in the document are the same circuit;
 *   3. `validateCircuit` accepts it, every time.
 *
 * Client ids are drawn at random by default. That is deliberate: the tie-break
 * for genuinely concurrent placements is the slot key, which is derived from the
 * client id, so a suite that fixes those ids can pass while agreeing only about
 * one particular draw.
 */

import {
  projectCircuit,
  writeCircuit,
  type CircuitProjection,
} from '@qsim/collab'
import { validateCircuit, type Circuit } from '@qsim/schema'
import { expect } from 'vitest'
import * as Y from 'yjs'

import {
  createCircuitStore,
  type CircuitStore,
} from '../../features/circuit-editor/useCircuitStore'
import { bridgeCircuitDocument } from '../../features/collab/circuitDocument'
import type { CircuitDocumentBridge } from '../../features/collab/circuitDocument'

/** A document as the relay would seed one, with a stable client id. */
export function seedDocument(circuit: Circuit, clientID = 999_001): Uint8Array {
  const doc = new Y.Doc()
  doc.clientID = clientID
  writeCircuit(doc, circuit, { origin: null, baseline: projectCircuit(doc) })
  return Y.encodeStateAsUpdate(doc)
}

export interface Peer {
  readonly name: string
  readonly store: CircuitStore
  readonly bridge: CircuitDocumentBridge
  readonly doc: Y.Doc
}

/**
 * A peer that has joined the session and adopted the seeded document.
 *
 * The base state is applied before the bridge attaches, which is the ordering
 * the transport is required to keep: an unsynced document is indistinguishable
 * from a new one, and a bridge over a new one seeds it from the store.
 */
export function join(base: Uint8Array, name: string, clientID: number): Peer {
  const doc = new Y.Doc()
  doc.clientID = clientID
  Y.applyUpdate(doc, base)
  const store = createCircuitStore()
  const bridge = bridgeCircuitDocument({ store, doc })
  return { name, store, bridge, doc }
}

/** Distinct random client ids, so no scenario depends on one draw. */
export function clientIds(count: number): number[] {
  const ids = new Set<number>()
  while (ids.size < count) {
    ids.add(1 + Math.floor(Math.random() * 2_000_000_000))
  }
  return [...ids]
}

/** Hands `from`'s missing bytes to `to`, through the door foreign bytes use. */
export function deliver(from: Peer, to: Peer): void {
  const update = Y.encodeStateAsUpdate(from.doc, Y.encodeStateVector(to.doc))
  const result = to.bridge.receive(update)
  expect(
    result.ok,
    `${to.name} refused ${from.name}'s update: ${
      result.ok ? '' : result.reason
    }`
  ).toBe(true)
}

/** What a peer would show. Comparable with `toEqual`, ordering included. */
export interface Reading {
  readonly circuit: Circuit
  readonly deferred: readonly {
    readonly slot: string
    readonly reason: string
    readonly operationId: string | undefined
    readonly blockedBy: readonly string[]
  }[]
  readonly overflow: number
  readonly slots: readonly (readonly [string, string])[]
  readonly schemaVersion: number | undefined
}

export function readingOf(projection: CircuitProjection): Reading {
  return {
    circuit: projection.circuit,
    deferred: projection.deferred.map((entry) => ({
      slot: entry.slot,
      reason: entry.reason,
      operationId: entry.operation?.id,
      blockedBy: entry.blockedBy,
    })),
    overflow: projection.overflow,
    slots: [...projection.slots].sort(([left], [right]) =>
      left < right ? -1 : left > right ? 1 : 0
    ),
    schemaVersion: projection.schemaVersion,
  }
}

export function reading(doc: Y.Doc): Reading {
  return readingOf(projectCircuit(doc))
}

function permutations<T>(items: readonly T[]): T[][] {
  if (items.length <= 1) return [[...items]]
  const out: T[][] = []
  for (let index = 0; index < items.length; index += 1) {
    const rest = [...items.slice(0, index), ...items.slice(index + 1)]
    for (const tail of permutations(rest))
      out.push([items[index] as T, ...tail])
  }
  return out
}

/**
 * Merges these peers' documents in every order, and in the peers themselves,
 * and asserts one reading.
 *
 * The returned reading is what every order agreed on, for a scenario that then
 * wants to say something about *which* circuit that was.
 */
export function converge(peers: readonly Peer[]): Reading {
  const states = peers.map((peer) => Y.encodeStateAsUpdate(peer.doc))
  const orders = permutations(states.map((_, index) => index))

  const readings = orders.map((order) => {
    const doc = new Y.Doc()
    for (const index of order) Y.applyUpdate(doc, states[index] as Uint8Array)
    return { order, reading: reading(doc) }
  })

  const expected = readings[0] as { order: number[]; reading: Reading }
  for (const candidate of readings.slice(1)) {
    expect(
      candidate.reading,
      `merge order ${candidate.order.join('→')} disagreed with ${expected.order.join('→')}`
    ).toEqual(expected.reading)
  }
  expect(validateCircuit(expected.reading.circuit)).toEqual([])

  // The live peers, which is the case that actually happens: each document
  // already holds its own edits when the others arrive. Two rounds so that a
  // three-peer session propagates fully.
  for (let round = 0; round < 2; round += 1) {
    for (const from of peers) {
      for (const to of peers) if (from !== to) deliver(from, to)
    }
  }

  for (const peer of peers) {
    expect(
      Y.encodeStateVector(peer.doc),
      `${peer.name} holds different bytes`
    ).toEqual(Y.encodeStateVector((peers[0] as Peer).doc))
    expect(
      readingOf(peer.bridge.projection()),
      `${peer.name} read the merged document differently`
    ).toEqual(expected.reading)
    expect(
      peer.store.getState().circuit,
      `${peer.name}'s store did not adopt the merged document`
    ).toEqual(expected.reading.circuit)
    expect(validateCircuit(peer.store.getState().circuit)).toEqual([])
  }

  return expected.reading
}

/** The ids the projection placed, in circuit order. */
export function placedIds(view: Reading): string[] {
  return view.circuit.operations.map((operation) => operation.id)
}

/** A cell, as a comparable string, for saying where a gate ended up. */
export function cellsOf(view: Reading): string[] {
  return view.circuit.operations.map(
    (operation) =>
      `${operation.gate}@${[
        ...operation.targets,
        ...(operation.controls ?? []).map((control) =>
          typeof control === 'number' ? control : control.qubit
        ),
      ]
        .sort((left, right) => left - right)
        .join(',')}:${operation.column}`
  )
}
