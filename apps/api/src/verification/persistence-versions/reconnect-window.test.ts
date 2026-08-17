/**
 * The window between "the last peer left" and "the row was written".
 *
 * `detach` used to remove the document from the registry and start the write
 * without waiting for it, so for the length of one database round trip a circuit
 * had *no* live document and a row that was out of date. A join that landed inside
 * that window was seeded from the stale row, and because a session is persisted as
 * a whole state rather than as a delta, the next write from the new document
 * replaced the one the outgoing peer was still writing.
 *
 * The document is now dropped from the registry only once its write has *landed*,
 * so a rejoin inside the window finds the document that is still there rather than
 * the row that is behind it — and if somebody does rejoin, the document is kept
 * rather than dropped underneath them.
 *
 * This is a registry-level probe rather than a live one because the interleaving
 * has to be *held open* to be observed, and in the real deployment it usually was
 * not: `DATABASE_URL` carries `connection_limit=1`, so the read queued behind the
 * write on the single pooled connection and arrived after it. That made the
 * ordering a property of the connection string rather than of this code, which is
 * why it was worth closing here: a pool of two would have reopened it.
 *
 * Everything is in memory: no database, no Redis, no socket. It is safe in the
 * default suite and runs in milliseconds.
 */

import { describe, expect, it } from 'vitest'
import * as Y from 'yjs'
import { documentOf, projectCircuit, writeCircuit } from '@qsim/collab'
import { CIRCUIT_SCHEMA_VERSION, type Circuit } from '@qsim/schema'
import {
  createDocumentRegistry,
  type DocumentPorts,
} from '../../ws/documents.js'

const bell: Circuit = {
  schemaVersion: CIRCUIT_SCHEMA_VERSION,
  qubits: 2,
  clbits: 0,
  operations: [
    { id: 'op-0', gate: 'h', targets: [0], column: 0 },
    { id: 'op-1', gate: 'cx', targets: [1], controls: [0], column: 1 },
  ],
}

/** One gate added to whatever the document currently says, as an update. */
function edit(
  state: Uint8Array | null,
  id: string,
  column: number
): Uint8Array {
  const doc = new Y.Doc()
  if (state !== null) Y.applyUpdate(doc, state)
  const before = Y.encodeStateVector(doc)
  const baseline = projectCircuit(doc)
  writeCircuit(
    doc,
    {
      ...baseline.circuit,
      operations: [
        ...baseline.circuit.operations,
        { id, gate: 'x', targets: [0], column },
      ],
    },
    { origin: 'peer', baseline }
  )
  return Y.encodeStateAsUpdate(doc, before)
}

const gateIds = (state: Uint8Array): string[] => {
  const doc = new Y.Doc()
  Y.applyUpdate(doc, state)
  return projectCircuit(doc)
    .circuit.operations.map((operation) => operation.id)
    .sort()
}

describe('the reconnect window after the last peer leaves', () => {
  it('seeds a rejoin from the document, not from a row still in flight', async () => {
    /** The row, and a queue of writes held open so the window is observable. */
    let row: Uint8Array | null = Y.encodeStateAsUpdate(documentOf(bell))
    const writes: { state: Uint8Array; land: () => void }[] = []
    /** Lands every held write in the order it was submitted, as a pool would. */
    const drain = async (): Promise<void> => {
      while (writes.length > 0) writes.shift()?.land()
      await new Promise((resolve) => setTimeout(resolve, 10))
    }

    const ports: DocumentPorts = {
      latestCircuit: () => Promise.resolve(bell),
      loadSession: () => Promise.resolve(row === null ? null : { state: row }),
      saveSession: (_circuitId, state) =>
        // Held open: this is the round trip the real relay does not wait for.
        new Promise<void>((resolve) => {
          writes.push({
            state,
            land: () => {
              row = state
              resolve()
            },
          })
        }),
      dropSession: () => {
        row = null
        return Promise.resolve()
      },
      bus: null,
      now: () => Date.now(),
      schedule: () => () => undefined,
      log: () => undefined,
    }

    const registry = createDocumentRegistry(ports, 'replica-a')

    const first = await registry.attach({
      circuitId: 'c1',
      peerId: 'peer-1',
      access: 'write',
      deliver: () => undefined,
      deliverPresence: () => undefined,
      dropped: () => undefined,
    })
    if ('refused' in first) throw new Error('the first peer was refused')
    expect(first.apply(edit(row, 'gate-a', 2)).ok).toBe(true)

    // The tab closes. The write starts and is still in flight.
    first.detach()
    await Promise.resolve()

    // A reconnect one tick later — a dropped wifi link, a tab restored.
    const second = await registry.attach({
      circuitId: 'c1',
      peerId: 'peer-2',
      access: 'write',
      deliver: () => undefined,
      deliverPresence: () => undefined,
      dropped: () => undefined,
    })
    if ('refused' in second) throw new Error('the second peer was refused')

    // What it was handed contains the gate the outgoing peer made: it joined the
    // document that is still in the registry, not the row that is behind it.
    const handed = second.missing(null)
    expect(handed).not.toBeNull()
    expect(gateIds(handed ?? new Uint8Array())).toStrictEqual([
      'gate-a',
      'op-0',
      'op-1',
    ])

    // And its own edit builds on top of that, so nothing is lost when the writes
    // land in the order they were submitted.
    expect(second.apply(edit(handed, 'gate-b', 3)).ok).toBe(true)
    second.detach()
    await drain()
    expect(row).not.toBeNull()
    expect(gateIds(row ?? new Uint8Array())).toStrictEqual([
      'gate-a',
      'gate-b',
      'op-0',
      'op-1',
    ])
  })
})
