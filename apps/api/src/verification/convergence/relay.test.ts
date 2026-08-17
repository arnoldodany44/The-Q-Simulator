/**
 * Convergence through the relay, driven from outside it.
 *
 * `documents.ts` is a third peer in every session: it holds a Y.Doc, applies
 * what arrives, projects it and fans the bytes on. So the questions this file
 * asks are the ones a client cannot ask alone — does the relay's own copy agree
 * with both clients, and does every client end up holding the same circuit when
 * the edits crossed in flight?
 *
 * Two real client documents, one real registry, no Postgres and no Redis: the
 * ports are the seam the registry was given for exactly this.
 */

import { projectCircuit, writeCircuit } from '@qsim/collab'
import type { CircuitProjection } from '@qsim/collab'
import { emptyCircuit, validateCircuit } from '@qsim/schema'
import type { Circuit } from '@qsim/schema'
import { describe, expect, it } from 'vitest'
import * as Y from 'yjs'

import {
  createDocumentRegistry,
  type DocumentAttachment,
  type DocumentPorts,
} from '../../ws/documents.js'

const CIRCUIT_ID = 'ckt_convergence'

interface Harness {
  readonly registry: ReturnType<typeof createDocumentRegistry>
  readonly saved: Uint8Array[]
}

function harness(head: Circuit): Harness {
  const saved: Uint8Array[] = []
  const ports: DocumentPorts = {
    latestCircuit: () => Promise.resolve(head),
    loadSession: () => Promise.resolve(null),
    saveSession: (_circuitId, state) => {
      saved.push(state)
      return Promise.resolve()
    },
    dropSession: () => Promise.resolve(),
    bus: null,
    now: () => Date.now(),
    // Never fires: nothing here is about the debounce, and a live timer in a
    // test is a flake waiting for a slow machine.
    schedule: () => () => undefined,
    log: () => undefined,
  }
  return {
    registry: createDocumentRegistry(ports, 'replica-under-test'),
    saved,
  }
}

interface Client {
  readonly name: string
  readonly doc: Y.Doc
  readonly inbox: Uint8Array[]
  peer: DocumentAttachment
  projection: CircuitProjection
}

async function connect(
  registry: Harness['registry'],
  name: string,
  clientID: number
): Promise<Client> {
  const inbox: Uint8Array[] = []
  const attached = await registry.attach({
    circuitId: CIRCUIT_ID,
    peerId: `peer-${name}`,
    access: 'write',
    deliver: (update) => inbox.push(update),
    deliverPresence: () => undefined,
    dropped: () => undefined,
  })
  if ('refused' in attached) throw new Error(`refused: ${attached.refused}`)

  const doc = new Y.Doc()
  doc.clientID = clientID
  const state = attached.missing(null)
  expect(state).not.toBeNull()
  Y.applyUpdate(doc, state as Uint8Array)
  return {
    name,
    doc,
    inbox,
    peer: attached,
    projection: projectCircuit(doc),
  }
}

/** Everything the relay has sent this client, applied. */
function drain(client: Client): void {
  for (const update of client.inbox.splice(0)) {
    Y.applyUpdate(client.doc, update, { from: 'relay' })
  }
  client.projection = projectCircuit(client.doc)
}

/** One local edit, sent the way a client sends one. */
function edit(client: Client, next: (circuit: Circuit) => Circuit): void {
  const before = Y.encodeStateVector(client.doc)
  client.projection = writeCircuit(
    client.doc,
    next(client.projection.circuit),
    {
      origin: { local: client.name },
      baseline: client.projection,
    }
  )
  const update = Y.encodeStateAsUpdate(client.doc, before)
  const outcome = client.peer.apply(update)
  expect(outcome.ok ? 'ok' : outcome.reason).toBe('ok')
}

function placeGate(
  circuit: Circuit,
  id: string,
  gate: string,
  qubit: number,
  column: number
): Circuit {
  return {
    ...circuit,
    operations: [...circuit.operations, { id, gate, targets: [qubit], column }],
  }
}

describe('the relay is a third peer and agrees with both clients', () => {
  it('converges when two edits cross in flight', async () => {
    const { registry } = harness(emptyCircuit(3, 3))
    const ana = await connect(registry, 'ana', 4001)
    const beto = await connect(registry, 'beto', 4002)

    // Both place a gate on the same cell, neither having seen the other. Each
    // calls it `op_1`, because each counted up inside its own document.
    edit(ana, (circuit) => placeGate(circuit, 'op_1', 'h', 0, 3))
    edit(beto, (circuit) => placeGate(circuit, 'op_1', 'x', 0, 3))

    drain(ana)
    drain(beto)

    const relay = projectCircuit(
      // The relay's own copy, reachable only through what it hands a joiner.
      docOf((await connect(registry, 'watcher', 4003)).doc)
    )

    expect(ana.projection.circuit).toEqual(beto.projection.circuit)
    expect(relay.circuit).toEqual(ana.projection.circuit)
    expect(ana.projection.deferred.map((entry) => entry.reason)).toEqual([
      'column-conflict',
    ])
    expect(relay.deferred.map((entry) => entry.reason)).toEqual([
      'column-conflict',
    ])
    expect(validateCircuit(relay.circuit)).toEqual([])

    await registry.close()
  })

  it('converges with a peer that edited while it was away', async () => {
    const { registry } = harness(emptyCircuit(3, 3))
    const ana = await connect(registry, 'ana', 4101)
    const beto = await connect(registry, 'beto', 4102)

    edit(ana, (circuit) => placeGate(circuit, 'op_1', 'h', 0, 0))
    drain(beto)
    expect(beto.projection.circuit.operations).toHaveLength(1)

    // Ana's socket dies and she keeps working.
    ana.peer.detach()
    for (let column = 1; column <= 5; column += 1) {
      ana.projection = writeCircuit(
        ana.doc,
        placeGate(ana.projection.circuit, `op_off_${column}`, 'x', 1, column),
        { origin: { local: 'ana' }, baseline: ana.projection }
      )
    }

    // She comes back, and tells the relay what she already has.
    const rejoined = await registry.attach({
      circuitId: CIRCUIT_ID,
      peerId: 'peer-ana',
      access: 'write',
      deliver: (update) => ana.inbox.push(update),
      deliverPresence: () => undefined,
      dropped: () => undefined,
    })
    if ('refused' in rejoined) throw new Error(`refused: ${rejoined.refused}`)
    ana.peer = rejoined
    const gap = rejoined.missing(Y.encodeStateVector(ana.doc))
    expect(gap).not.toBeNull()
    Y.applyUpdate(ana.doc, gap as Uint8Array, { from: 'relay' })
    ana.projection = projectCircuit(ana.doc)

    /*
     * The rejoin is one-directional: it tells Ana what she is missing and asks
     * nothing about what the session is missing from her. So the offline edits
     * are still hers alone until she volunteers them, which is what the next
     * lines do — and what a client is therefore required to do after every
     * reconnection.
     */
    drain(beto)
    const beforeVolunteering = beto.projection.circuit.operations.length

    const outcome = rejoined.apply(Y.encodeStateAsUpdate(ana.doc))
    expect(outcome.ok).toBe(true)
    drain(beto)

    expect(beforeVolunteering).toBe(1)
    expect(beto.projection.circuit.operations).toHaveLength(6)
    expect(beto.projection.circuit).toEqual(ana.projection.circuit)
    expect(validateCircuit(beto.projection.circuit)).toEqual([])

    await registry.close()
  })
})

/** Identity, for the reader: a joiner's document *is* the relay's state. */
function docOf(doc: Y.Doc): Y.Doc {
  return doc
}
