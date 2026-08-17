/**
 * Two real peers over two real Y.Docs, with a relay in between.
 *
 * Independent verification of M5.1's undo ownership. The scenarios are derived
 * from what a correct per-user undo must do, and every expected value is
 * written down before the run.
 *
 * The relay is the only part the milestone does not ship yet, so it is built
 * the only way it can be: a peer forwards every update its own document
 * produced — an edit, an undo, a redo — and never forwards one that arrived
 * from the relay, because that is an echo.
 */

import type { CircuitProjection } from '@qsim/collab'
import type { Circuit } from '@qsim/schema'
import * as Y from 'yjs'

import {
  createCircuitStore,
  type CircuitStore,
} from '../../features/circuit-editor/useCircuitStore'
import { bridgeCircuitDocument } from '../../features/collab/circuitDocument'

export interface Peer {
  readonly name: string
  readonly store: CircuitStore
  readonly doc: Y.Doc
  readonly bridge: ReturnType<typeof bridgeCircuitDocument>
  readonly outbox: Uint8Array[]
  readonly receive: (update: Uint8Array) => void
  /** How many times the bridge said this tab had opened another document. */
  readonly replaced: number
  /** The last projection the bridge announced. */
  projection: CircuitProjection
}

/** The first peer: its store's circuit becomes the document. */
export function host(name: string, circuit?: Circuit): Peer {
  return attach(name, createCircuitStore(circuit), new Y.Doc(), 'store')
}

/** A second peer, synced from `from` before it bridges, as the header requires. */
export function joiner(name: string, from: Peer, circuit?: Circuit): Peer {
  const doc = new Y.Doc()
  Y.applyUpdate(doc, Y.encodeStateAsUpdate(from.doc))
  return attach(name, createCircuitStore(circuit), doc, 'document')
}

function attach(
  name: string,
  store: CircuitStore,
  doc: Y.Doc,
  seed: 'store' | 'document'
): Peer {
  const outbox: Uint8Array[] = []
  let receiving = false
  let projection: CircuitProjection | null = null
  let replaced = 0

  doc.on('update', (update: Uint8Array) => {
    if (receiving) return
    outbox.push(update)
  })

  const bridge = bridgeCircuitDocument({
    store,
    doc,
    seed,
    onProjection: (next) => {
      projection = next
    },
    onDocumentReplaced: () => {
      replaced += 1
    },
  })

  return {
    name,
    store,
    doc,
    bridge,
    outbox,
    receive(update) {
      receiving = true
      try {
        const result = bridge.receive(update)
        if (!result.ok) {
          throw new Error(`${name} refused an update: ${result.reason}`)
        }
      } finally {
        receiving = false
      }
    },
    get replaced(): number {
      return replaced
    },
    get projection(): CircuitProjection {
      return projection ?? bridge.projection()
    },
    set projection(_next: CircuitProjection) {
      throw new Error('read only')
    },
  }
}

/** Flush everything `from` has produced into `to`. */
export function deliver(from: Peer, to: Peer): void {
  for (const update of from.outbox.splice(0, from.outbox.length)) {
    to.receive(update)
  }
}

/** Both ways, twice, so a write caused by an adoption also lands. */
export function merge(left: Peer, right: Peer): void {
  deliver(left, right)
  deliver(right, left)
  deliver(left, right)
  deliver(right, left)
}

/** `gate@targets:column` for every placed operation, sorted, human-readable. */
export function cells(circuit: Circuit): string[] {
  return circuit.operations
    .map(
      (operation) =>
        `${operation.gate}@${[...operation.targets].join('+')}:${String(
          operation.column
        )}`
    )
    .sort()
}

export function circuitOf(peer: Peer): Circuit {
  return peer.store.getState().circuit
}

/** The id an accepted edit minted. Throws rather than typing `undefined` on. */
export function idOf(result: { ok: boolean; ids?: readonly string[] }): string {
  const id = result.ok ? result.ids?.[0] : undefined
  if (id === undefined) throw new Error('the edit was refused')
  return id
}

/** The params of the document's only operation, for the drag scenarios. */
export function paramsOf(circuit: Circuit): readonly unknown[] | undefined {
  return circuit.operations[0]?.params
}

export function deferredOf(peer: Peer): string[] {
  return peer.projection.deferred
    .map((entry) => `${entry.reason}:${entry.operation?.gate ?? '?'}`)
    .sort()
}
