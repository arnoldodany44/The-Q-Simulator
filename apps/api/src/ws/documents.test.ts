/**
 * The relay's own documents: what it seeds one from, what it refuses, what it
 * writes down, and what happens when two peers who could not see each other
 * arrive at the same cell.
 *
 * `@qsim/collab`'s `merge.test.ts` already answers the CRDT question — two
 * documents edited while disconnected converge on one circuit, and both peers
 * agree which. What is answered here is the *relay's* half of it, which is not
 * the same question and can fail on its own:
 *
 *   - the server holds a document too, so it must converge on the same circuit
 *     the peers do rather than on one of its own;
 *   - the server is the thing that persists, so what it writes has to be a state
 *     that projected cleanly;
 *   - the server takes bytes from strangers, so a peer must not be able to
 *     poison the document every other peer is attached to.
 *
 * Every test uses real Y.Docs and the real `@qsim/collab`. Nothing about a CRDT
 * is worth asserting against a fake.
 */

import {
  MAX_COLLAB_STATE_BYTES,
  MAX_COLLAB_UPDATE_BYTES,
  PRESENCE_TIMEOUT_MS,
} from '@qsim/contract'
import type { PresenceState } from '@qsim/contract'
import { documentOf, projectCircuit, writeCircuit } from '@qsim/collab'
import type { CircuitProjection } from '@qsim/collab'
import { CIRCUIT_SCHEMA_VERSION, validateCircuit } from '@qsim/schema'
import type { Circuit, Operation } from '@qsim/schema'
import { describe, expect, it } from 'vitest'
import * as Y from 'yjs'
import {
  MAX_DOCUMENTS,
  MAX_PEERS_PER_DOCUMENT,
  RESERVED_FOR_WRITERS,
  PERSIST_MAX_INTERVAL_MS,
  PERSIST_QUIET_MS,
  createDocumentRegistry,
} from './documents.js'
import type {
  CollabBus,
  CollabMessage,
  DocumentAttachment,
  DocumentPorts,
  DocumentRegistry,
} from './documents.js'

/* ── circuits, as the editor would build them ────────────────────────────── */

function circuitOf(...operations: Operation[]): Circuit {
  return {
    schemaVersion: CIRCUIT_SCHEMA_VERSION,
    qubits: 2,
    clbits: 0,
    operations,
  }
}

function gate(
  id: string,
  name: string,
  qubit: number,
  column: number
): Operation {
  return { id, gate: name, targets: [qubit], column }
}

/* ── the harness ─────────────────────────────────────────────────────────── */

interface Scheduled {
  readonly run: () => void
  readonly at: number
  cancelled: boolean
}

interface Harness {
  readonly registry: DocumentRegistry
  /** Session rows, keyed by circuit, exactly as the table is. */
  readonly rows: Map<string, Uint8Array>
  /** How many times each circuit's row was written. */
  readonly writes: string[]
  readonly dropped: string[]
  readonly advance: (ms: number) => Promise<void>
  readonly logs: { level: string; message: string }[]
}

interface HarnessOptions {
  /** Head versions, by circuit id. */
  readonly versions?: Record<string, Circuit>
  readonly rows?: Map<string, Uint8Array>
  readonly bus?: CollabBus
  readonly replicaId?: string
  readonly saveFails?: boolean
  readonly loadFails?: boolean
}

function harness(options: HarnessOptions = {}): Harness {
  const rows = options.rows ?? new Map<string, Uint8Array>()
  const writes: string[] = []
  const dropped: string[] = []
  const logs: { level: string; message: string }[] = []
  const timers: Scheduled[] = []
  let clock = 1_000

  const ports: DocumentPorts = {
    latestCircuit: (circuitId) =>
      Promise.resolve(options.versions?.[circuitId] ?? null),
    loadSession: (circuitId) => {
      if (options.loadFails === true) {
        return Promise.reject(new Error('pooler is down'))
      }
      const state = rows.get(circuitId)
      return Promise.resolve(state === undefined ? null : { state })
    },
    saveSession: (circuitId, state) => {
      if (options.saveFails === true) {
        return Promise.reject(new Error('pooler is down'))
      }
      writes.push(circuitId)
      rows.set(circuitId, state)
      return Promise.resolve()
    },
    dropSession: (circuitId) => {
      dropped.push(circuitId)
      rows.delete(circuitId)
      return Promise.resolve()
    },
    bus: options.bus ?? null,
    now: () => clock,
    schedule: (run, ms) => {
      const entry: Scheduled = { run, at: clock + ms, cancelled: false }
      timers.push(entry)
      return () => {
        entry.cancelled = true
      }
    },
    log: (level, _fields, message) => {
      logs.push({ level, message })
    },
  }

  return {
    registry: createDocumentRegistry(ports, options.replicaId ?? 'replica-a'),
    rows,
    writes,
    dropped,
    logs,
    advance: async (ms) => {
      clock += ms
      for (const entry of [...timers]) {
        if (entry.cancelled || entry.at > clock) continue
        entry.cancelled = true
        entry.run()
      }
      // The writer is asynchronous; let it reach the row.
      for (let turn = 0; turn < 4; turn += 1) await Promise.resolve()
    },
  }
}

/** A bus two registries share, so one process can model two replicas. */
function memoryBus(): CollabBus & { readonly published: CollabMessage[] } {
  const channels = new Map<string, Set<(message: CollabMessage) => void>>()
  const published: CollabMessage[] = []
  return {
    published,
    publish: (channel, message) => {
      published.push(message)
      // Delivered to every subscriber including the publisher's own, exactly as
      // Redis does — the origin filter is what makes that safe.
      for (const listener of channels.get(channel) ?? []) listener(message)
      return Promise.resolve()
    },
    subscribe: (channel, listener) => {
      const listeners = channels.get(channel) ?? new Set()
      listeners.add(listener)
      channels.set(channel, listeners)
      return Promise.resolve(() => {
        listeners.delete(listener)
      })
    },
  }
}

/** A peer, as the socket session would drive one. */
interface Attached {
  readonly peer: DocumentAttachment
  /** Updates the relay delivered to this peer. */
  readonly received: Uint8Array[]
  /** Presences the relay delivered to this peer: `[peerId, state]`, oldest first. */
  readonly presences: [string, PresenceState | null][]
  /** The handle the relay knows this peer by. */
  readonly peerId: string
  readonly drops: number
}

/** Peer ids, minted as the socket session mints them: opaque and unique. */
let minted = 0

async function join(
  registry: DocumentRegistry,
  circuitId: string,
  access: 'write' | 'read' = 'write'
): Promise<Attached> {
  const received: Uint8Array[] = []
  const presences: [string, PresenceState | null][] = []
  const state = { drops: 0 }
  minted += 1
  const peerId = `peer-${minted}`
  const result = await registry.attach({
    circuitId,
    peerId,
    access,
    deliver: (update) => received.push(update),
    deliverPresence: (peerId, presence) => presences.push([peerId, presence]),
    dropped: () => {
      state.drops += 1
    },
  })
  if ('refused' in result) {
    throw new Error(`attach refused: ${result.refused}`)
  }
  return {
    peer: result,
    received,
    presences,
    peerId,
    get drops() {
      return state.drops
    },
  }
}

/**
 * A browser, as `circuitDocument.ts` is one: a local Y.Doc, seeded from what the
 * relay handed over, edited through `writeCircuit`, and emitting the updates the
 * transport would send.
 */
class Browser {
  readonly doc = new Y.Doc()
  private projection: CircuitProjection
  readonly outgoing: Uint8Array[] = []
  private readonly origin = { local: true }

  constructor(seed: Uint8Array | null, clientID: number) {
    this.doc.clientID = clientID
    if (seed !== null) Y.applyUpdate(this.doc, seed, { remote: true })
    this.doc.on('update', (update: Uint8Array, origin: unknown) => {
      if (origin === this.origin) this.outgoing.push(update)
    })
    this.projection = projectCircuit(this.doc)
  }

  /** An edit, exactly as the bridge makes one. */
  edit(change: (circuit: Circuit) => Circuit): void {
    this.projection = writeCircuit(this.doc, change(this.projection.circuit), {
      origin: this.origin,
      baseline: this.projection,
    })
  }

  receive(update: Uint8Array): void {
    Y.applyUpdate(this.doc, update, { remote: true })
    this.projection = projectCircuit(this.doc)
  }

  circuit(): Circuit {
    return projectCircuit(this.doc).circuit
  }
}

function place(operation: Operation): (circuit: Circuit) => Circuit {
  return (circuit) => ({
    ...circuit,
    operations: [...circuit.operations, operation],
  })
}

/* ── seeding ─────────────────────────────────────────────────────────────── */

describe('seeding a document', () => {
  it('builds it from the head version when there is no session row', async () => {
    const saved = circuitOf(gate('op_1', 'h', 0, 0))
    const h = harness({ versions: { c1: saved } })
    const a = await join(h.registry, 'c1')

    const doc = new Y.Doc()
    Y.applyUpdate(doc, a.peer.missing(null) as Uint8Array)
    expect(projectCircuit(doc).circuit.operations).toEqual(saved.operations)
  })

  /**
   * The row wins, and it wins by construction rather than by comparing two
   * clocks: `appendVersion` deletes it in the same transaction that writes a
   * version, so a row that exists was written after the last save.
   */
  it('prefers the session row over the head version', async () => {
    const saved = circuitOf(gate('op_1', 'h', 0, 0))
    const unsaved = circuitOf(gate('op_1', 'h', 0, 0), gate('op_2', 'x', 1, 0))
    const rows = new Map([['c1', Y.encodeStateAsUpdate(documentOf(unsaved))]])
    const h = harness({ versions: { c1: saved }, rows })
    const a = await join(h.registry, 'c1')

    const doc = new Y.Doc()
    Y.applyUpdate(doc, a.peer.missing(null) as Uint8Array)
    expect(projectCircuit(doc).circuit.operations).toHaveLength(2)
  })

  it('serves an empty single-wire document for a circuit with no version', async () => {
    const h = harness()
    const a = await join(h.registry, 'c1')
    const doc = new Y.Doc()
    Y.applyUpdate(doc, a.peer.missing(null) as Uint8Array)
    const circuit = projectCircuit(doc).circuit
    expect(circuit.qubits).toBe(1)
    expect(circuit.operations).toEqual([])
  })

  it('forgets a row it cannot read back as a circuit, and falls back', async () => {
    const saved = circuitOf(gate('op_1', 'h', 0, 0))
    const rows = new Map([['c1', new Uint8Array([7, 7, 7, 7])]])
    const h = harness({ versions: { c1: saved }, rows })
    const a = await join(h.registry, 'c1')
    expect(h.dropped).toEqual(['c1'])
    const doc = new Y.Doc()
    Y.applyUpdate(doc, a.peer.missing(null) as Uint8Array)
    expect(projectCircuit(doc).circuit.operations).toEqual(saved.operations)
  })

  it('refuses a stored document past the size ceiling, and keeps the row', async () => {
    const rows = new Map([['c1', new Uint8Array(MAX_COLLAB_STATE_BYTES + 1)]])
    const h = harness({ rows })
    const result = await h.registry.attach({
      circuitId: 'c1',
      peerId: 'probe',
      access: 'write',
      deliver: () => undefined,
      deliverPresence: () => undefined,
      dropped: () => undefined,
    })
    expect(result).toEqual({ refused: 'too-large' })
    // Left alone: a person has to look at a document this big, and the last
    // saved version is still reachable through the ordinary editor.
    expect(h.rows.has('c1')).toBe(true)
  })

  it('refuses when the row cannot be read at all', async () => {
    const h = harness({ loadFails: true })
    const result = await h.registry.attach({
      circuitId: 'c1',
      peerId: 'probe',
      access: 'write',
      deliver: () => undefined,
      deliverPresence: () => undefined,
      dropped: () => undefined,
    })
    expect(result).toEqual({ refused: 'unavailable' })
  })

  /**
   * Two peers arriving together must share one document. Without the in-flight
   * map each would await the database and build its own, and the second would
   * replace the first — leaving the first peer in a session nobody else can see.
   */
  it('builds one document for two peers that arrive together', async () => {
    const h = harness({ versions: { c1: circuitOf() } })
    const [a, b] = await Promise.all([
      join(h.registry, 'c1'),
      join(h.registry, 'c1'),
    ])
    expect(h.registry.documentCount()).toBe(1)

    const browser = new Browser(a.peer.missing(null), 1001)
    browser.edit(place(gate('op_1', 'h', 0, 0)))
    for (const update of browser.outgoing) a.peer.apply(update)
    expect(b.received).toHaveLength(1)
  })
})

/* ── fan-out and convergence ─────────────────────────────────────────────── */

describe('relaying between peers', () => {
  it('delivers an update to every peer but its sender', async () => {
    const h = harness({ versions: { c1: circuitOf() } })
    const a = await join(h.registry, 'c1')
    const b = await join(h.registry, 'c1')
    const c = await join(h.registry, 'c1', 'read')

    const browser = new Browser(a.peer.missing(null), 1001)
    browser.edit(place(gate('op_1', 'h', 0, 0)))
    for (const update of browser.outgoing) {
      expect(a.peer.apply(update)).toMatchObject({ ok: true })
    }

    expect(a.received).toEqual([])
    expect(b.received).toHaveLength(1)
    expect(c.received).toHaveLength(1)
  })

  /**
   * ═══════════════════════════════════════════════════════════════════
   * THE MILESTONE, AT THE RELAY.
   *
   * Ana and Beto both drop a gate on (q0, c0) while they cannot see each other,
   * then both send. §6 says two operations of one column may not share a qubit,
   * and no CRDT will refuse that merge — so the three things asserted here are
   * the three that could go wrong:
   *
   *   1. the server's document projects to a **legal** circuit;
   *   2. both browsers project to the **same** circuit as each other;
   *   3. and to the same one the **server** holds, which is what makes the row
   *      the relay persists the circuit everybody was looking at.
   *
   * The loser is not lost: it is deferred, in the document, and resolving it is
   * an ordinary edit.
   */
  it('converges on one legal circuit when two peers claim the same cell', async () => {
    const h = harness({ versions: { c1: circuitOf() } })
    const ana = await join(h.registry, 'c1')
    const beto = await join(h.registry, 'c1')

    const anaBrowser = new Browser(ana.peer.missing(null), 1001)
    const betoBrowser = new Browser(beto.peer.missing(null), 2002)

    // Both edit while disconnected: neither has seen the other's update.
    anaBrowser.edit(place(gate('op_1', 'h', 0, 0)))
    betoBrowser.edit(place(gate('op_1', 'x', 0, 0)))

    // Then both send, and each receives what the other sent.
    const fromAna = [...anaBrowser.outgoing]
    const fromBeto = [...betoBrowser.outgoing]
    for (const update of fromAna) {
      expect(ana.peer.apply(update)).toMatchObject({ ok: true })
    }
    for (const update of fromBeto) {
      expect(beto.peer.apply(update)).toMatchObject({ ok: true })
    }
    // Each receives what the relay delivered to *it*, which is the other's edit:
    // the relay never echoes an update to the connection it arrived on.
    for (const update of ana.received) anaBrowser.receive(update)
    for (const update of beto.received) betoBrowser.receive(update)

    // 1. legal
    const anaCircuit = anaBrowser.circuit()
    expect(validateCircuit(anaCircuit)).toEqual([])
    // 2. and 3. everybody agrees, including the server
    expect(betoBrowser.circuit()).toEqual(anaCircuit)
    const server = new Y.Doc()
    Y.applyUpdate(server, ana.peer.missing(null) as Uint8Array)
    expect(projectCircuit(server).circuit).toEqual(anaCircuit)

    // Exactly one gate is placed and the other is deferred rather than lost.
    expect(anaCircuit.operations).toHaveLength(1)
    expect(projectCircuit(server).deferred).toHaveLength(1)
    expect(ana.peer.deferred).toBe(1)
  })

  it('reports the deferred count to a peer that joins into a conflict', async () => {
    const h = harness({ versions: { c1: circuitOf() } })
    const ana = await join(h.registry, 'c1')
    const beto = await join(h.registry, 'c1')
    const anaBrowser = new Browser(ana.peer.missing(null), 1001)
    const betoBrowser = new Browser(beto.peer.missing(null), 2002)
    anaBrowser.edit(place(gate('op_1', 'h', 0, 0)))
    betoBrowser.edit(place(gate('op_1', 'x', 0, 0)))
    for (const update of anaBrowser.outgoing) ana.peer.apply(update)
    for (const update of betoBrowser.outgoing) beto.peer.apply(update)

    const late = await join(h.registry, 'c1', 'read')
    expect(late.peer.deferred).toBe(1)
    expect(late.peer.overflow).toBe(0)
  })
})

/* ── refusing bytes ──────────────────────────────────────────────────────── */

describe('refusing an update', () => {
  it('refuses one past the transport ceiling before decoding it', async () => {
    const h = harness({ versions: { c1: circuitOf() } })
    const a = await join(h.registry, 'c1')
    expect(a.peer.apply(new Uint8Array(MAX_COLLAB_UPDATE_BYTES + 1))).toEqual({
      ok: false,
      reason: 'too-large',
    })
  })

  /**
   * The property that separates the relay from the browser's bridge: a peer
   * sending garbage must not be able to damage the document everybody else is
   * attached to. `Y.decodeUpdate` runs before `Y.applyUpdate`, so the refusal is
   * a refusal rather than the report of a document already half-changed.
   */
  it('refuses bytes that are not a Yjs update, leaving the document intact', async () => {
    const saved = circuitOf(gate('op_1', 'h', 0, 0))
    const h = harness({ versions: { c1: saved } })
    const a = await join(h.registry, 'c1')
    const b = await join(h.registry, 'c1')

    expect(a.peer.apply(new Uint8Array([255, 254, 253, 252]))).toEqual({
      ok: false,
      reason: 'malformed',
    })

    const doc = new Y.Doc()
    Y.applyUpdate(doc, b.peer.missing(null) as Uint8Array)
    expect(projectCircuit(doc).circuit.operations).toEqual(saved.operations)
    // Nothing was fanned out and nothing is waiting to be written.
    expect(b.received).toEqual([])
    expect(h.writes).toEqual([])
  })

  /**
   * A legal update whose document is one the relay cannot serve. It is already
   * applied, so the session ends and the row goes — which puts everybody back on
   * the last saved version rather than on a document that can never be reopened.
   */
  it('gives the document up when it grows past the state ceiling', async () => {
    const h = harness({
      versions: { c1: circuitOf() },
      rows: new Map([['c1', new Uint8Array()]]),
    })
    h.rows.delete('c1')
    const a = await join(h.registry, 'c1')
    const b = await join(h.registry, 'c1')

    /*
     * Inflated through a root the projection ignores, which is exactly the shape
     * of the attack this ceiling exists for: the circuit stays legal and the
     * document does not stop growing.
     */
    let outcome: ReturnType<typeof a.peer.apply> = {
      ok: true,
      deferred: 0,
      overflow: 0,
      work: 0,
    }
    /*
     * As many as the ceiling admits, not a fixed count: the document ceiling is
     * checked against `measured + sinceMeasured` and re-measured only when that
     * bound reaches it, which is what keeps the work per update linear in the
     * update instead of in the document. The loop bound is what the ceiling
     * allows plus a margin, so it still terminates on a bug.
     */
    const rounds = Math.ceil(MAX_COLLAB_STATE_BYTES / 48_000) + 8
    for (let i = 0; i < rounds && outcome.ok; i += 1) {
      const filler = new Y.Doc()
      filler.getMap('junk').set(`k${i}`, 'x'.repeat(48_000))
      outcome = a.peer.apply(Y.encodeStateAsUpdate(filler))
    }
    expect(outcome).toEqual({ ok: false, reason: 'document-too-large' })
    expect(b.drops).toBe(1)
    expect(h.registry.documentCount()).toBe(0)
    expect(h.dropped).toEqual(['c1'])
  })
})

/* ── persistence ─────────────────────────────────────────────────────────── */

describe('persisting a document', () => {
  async function edited(h: Harness): Promise<Attached> {
    const a = await join(h.registry, 'c1')
    const browser = new Browser(a.peer.missing(null), 1001)
    browser.edit(place(gate('op_1', 'h', 0, 0)))
    for (const update of browser.outgoing) a.peer.apply(update)
    return a
  }

  it('writes nothing until the document goes quiet', async () => {
    const h = harness({ versions: { c1: circuitOf() } })
    await edited(h)
    expect(h.writes).toEqual([])
    await h.advance(PERSIST_QUIET_MS)
    expect(h.writes).toEqual(['c1'])
  })

  /**
   * The row is what a session's work survives on, so what is in it has to be the
   * document — readable back as the same circuit, by the same code that will
   * read it when somebody reopens the circuit tomorrow.
   */
  it('writes a state that reads back as the circuit', async () => {
    const h = harness({ versions: { c1: circuitOf() } })
    await edited(h)
    await h.advance(PERSIST_QUIET_MS)
    const doc = new Y.Doc()
    Y.applyUpdate(doc, h.rows.get('c1') as Uint8Array)
    const circuit = projectCircuit(doc).circuit
    expect(validateCircuit(circuit)).toEqual([])
    expect(circuit.operations).toEqual([gate('op_1', 'h', 0, 0)])
  })

  /**
   * The debounce alone is not a policy: a session where somebody is typing never
   * goes quiet, so it would never be written at all.
   */
  it('writes under a stream of edits that never goes quiet', async () => {
    const h = harness({ versions: { c1: circuitOf() } })
    const a = await join(h.registry, 'c1')
    const browser = new Browser(a.peer.missing(null), 1001)
    for (let i = 0; i < 12; i += 1) {
      browser.edit(place(gate(`op_${i + 1}`, 'h', i % 2, i)))
      for (const update of browser.outgoing.splice(0)) a.peer.apply(update)
      // Always sooner than the quiet period, so the debounce keeps re-arming.
      await h.advance(PERSIST_QUIET_MS - 500)
    }
    expect(h.writes.length).toBeGreaterThanOrEqual(1)
    expect(PERSIST_MAX_INTERVAL_MS).toBeGreaterThan(PERSIST_QUIET_MS)
  })

  /** The case the row exists for: everybody closed their laptop. */
  it('writes immediately when the last peer leaves', async () => {
    const h = harness({ versions: { c1: circuitOf() } })
    const a = await edited(h)
    const b = await join(h.registry, 'c1')
    b.peer.detach()
    expect(h.writes).toEqual([])
    a.peer.detach()
    await h.advance(0)
    expect(h.writes).toEqual(['c1'])
    expect(h.registry.documentCount()).toBe(0)
  })

  it('writes nothing for a document nobody changed', async () => {
    const h = harness({ versions: { c1: circuitOf() } })
    const a = await join(h.registry, 'c1', 'read')
    a.peer.detach()
    await h.advance(PERSIST_QUIET_MS)
    expect(h.writes).toEqual([])
  })

  it('keeps serving a session whose row cannot be written', async () => {
    const h = harness({ versions: { c1: circuitOf() }, saveFails: true })
    const a = await edited(h)
    await h.advance(PERSIST_QUIET_MS)
    expect(h.logs.some((line) => line.level === 'warn')).toBe(true)
    // The peers still hold the document; only the durability is lost.
    expect(h.registry.documentCount()).toBe(1)
    expect(a.drops).toBe(0)
  })

  it('flushes and lets every document go on close', async () => {
    const h = harness({ versions: { c1: circuitOf() } })
    const a = await edited(h)
    await h.registry.close()
    expect(h.writes).toEqual(['c1'])
    expect(a.drops).toBe(1)
    // The row is kept: the process is going away, the document is not.
    expect(h.rows.has('c1')).toBe(true)
  })
})

/* ── ceilings ────────────────────────────────────────────────────────────── */

describe('what one process will hold', () => {
  it('refuses a document past the process ceiling', async () => {
    const h = harness()
    for (let i = 0; i < MAX_DOCUMENTS; i += 1) {
      await join(h.registry, `c${i}`)
    }
    const result = await h.registry.attach({
      circuitId: 'one-too-many',
      peerId: 'probe',
      access: 'write',
      deliver: () => undefined,
      deliverPresence: () => undefined,
      dropped: () => undefined,
    })
    expect(result).toEqual({ refused: 'too-many-documents' })
  })

  it('refuses a peer past one document’s ceiling', async () => {
    const h = harness({ versions: { c1: circuitOf() } })
    for (let i = 0; i < MAX_PEERS_PER_DOCUMENT; i += 1) {
      await join(h.registry, 'c1', 'write')
    }
    const result = await h.registry.attach({
      circuitId: 'c1',
      peerId: 'probe',
      access: 'write',
      deliver: () => undefined,
      deliverPresence: () => undefined,
      dropped: () => undefined,
    })
    expect(result).toEqual({ refused: 'too-many-peers' })
  })

  it('keeps peer slots for a writer when readers fill the document', async () => {
    /*
     * §3.4 admits watchers precisely because a circuit has exactly one writer, so
     * a crowd of watchers must not be able to lock the owner out of their own
     * live session. Readers are refused `RESERVED_FOR_WRITERS` slots earlier.
     */
    const h = harness({ versions: { c1: circuitOf() } })
    for (let i = 0; i < MAX_PEERS_PER_DOCUMENT - RESERVED_FOR_WRITERS; i += 1) {
      await join(h.registry, 'c1', 'read')
    }
    const crowded = await h.registry.attach({
      circuitId: 'c1',
      peerId: 'watcher',
      access: 'read',
      deliver: () => undefined,
      deliverPresence: () => undefined,
      dropped: () => undefined,
    })
    expect(crowded).toEqual({ refused: 'too-many-peers' })

    // The writer still gets in.
    const writer = await join(h.registry, 'c1', 'write')
    expect(writer.peer.access).toBe('write')
  })

  it('keeps document slots for a writer when readers fill the replica', async () => {
    const h = harness({
      versions: Object.fromEntries(
        Array.from({ length: MAX_DOCUMENTS + 1 }, (_, i) => [
          `c${i}`,
          circuitOf(),
        ])
      ),
    })
    for (let i = 0; i < MAX_DOCUMENTS - RESERVED_FOR_WRITERS; i += 1) {
      await join(h.registry, `c${i}`, 'read')
    }
    const crowded = await h.registry.attach({
      circuitId: `c${MAX_DOCUMENTS - RESERVED_FOR_WRITERS}`,
      peerId: 'watcher',
      access: 'read',
      deliver: () => undefined,
      deliverPresence: () => undefined,
      dropped: () => undefined,
    })
    expect(crowded).toEqual({ refused: 'too-many-documents' })

    const owner = await join(
      h.registry,
      `c${MAX_DOCUMENTS - RESERVED_FOR_WRITERS}`,
      'write'
    )
    expect(owner.peer.access).toBe('write')
  })
})

/* ── two replicas ────────────────────────────────────────────────────────── */

describe('two replicas over one bus', () => {
  it('carries an update from a peer on one to a peer on the other', async () => {
    const bus = memoryBus()
    const versions = { c1: circuitOf() }
    const a = harness({ versions, bus, replicaId: 'replica-a' })
    const b = harness({ versions, bus, replicaId: 'replica-b' })

    const here = await join(a.registry, 'c1')
    const there = await join(b.registry, 'c1', 'read')

    const browser = new Browser(here.peer.missing(null), 1001)
    browser.edit(place(gate('op_1', 'h', 0, 0)))
    for (const update of browser.outgoing) here.peer.apply(update)

    expect(there.received).toHaveLength(1)
    const doc = new Y.Doc()
    Y.applyUpdate(doc, there.peer.missing(null) as Uint8Array)
    expect(projectCircuit(doc).circuit.operations).toHaveLength(1)
  })

  it('does not apply or republish its own publishes', async () => {
    const bus = memoryBus()
    const a = harness({ versions: { c1: circuitOf() }, bus })
    const here = await join(a.registry, 'c1')
    const browser = new Browser(here.peer.missing(null), 1001)
    browser.edit(place(gate('op_1', 'h', 0, 0)))
    for (const update of browser.outgoing) here.peer.apply(update)
    // One update published, and the sender received nothing back.
    expect(bus.published.filter((m) => m.kind === 'update')).toHaveLength(1)
    expect(here.received).toEqual([])
  })

  /**
   * The gap a pure fan-out leaves. Replica B seeds from the persisted row, which
   * is behind A's memory by up to the debounce — and a delta that depends on the
   * gap sits in Yjs's pending queue forever. So a new document asks, and whoever
   * holds one answers with its whole state.
   */
  it('closes the gap when a second replica builds a document late', async () => {
    const bus = memoryBus()
    const versions = { c1: circuitOf() }
    const a = harness({ versions, bus, replicaId: 'replica-a' })
    const b = harness({ versions, bus, replicaId: 'replica-b' })

    const here = await join(a.registry, 'c1')
    const browser = new Browser(here.peer.missing(null), 1001)
    browser.edit(place(gate('op_1', 'h', 0, 0)))
    for (const update of browser.outgoing) here.peer.apply(update)
    // Deliberately *not* persisted: the row still holds the head version.
    expect(a.writes).toEqual([])

    const there = await join(b.registry, 'c1', 'read')
    expect(bus.published.some((m) => m.kind === 'sync-request')).toBe(true)
    expect(bus.published.some((m) => m.kind === 'sync-state')).toBe(true)

    const doc = new Y.Doc()
    Y.applyUpdate(doc, there.peer.missing(null) as Uint8Array)
    expect(projectCircuit(doc).circuit.operations).toHaveLength(1)
  })

  /**
   * The other replica is a peer this process does not control either, so its
   * bytes go through the same decode-before-integrate guard a browser's do.
   */
  it('ignores bytes from a replica that are not a Yjs update', async () => {
    const bus = memoryBus()
    const saved = circuitOf(gate('op_1', 'h', 0, 0))
    const a = harness({ versions: { c1: saved }, bus, replicaId: 'replica-a' })
    const here = await join(a.registry, 'c1')

    await bus.publish('circuit:c1', {
      kind: 'update',
      origin: 'replica-b',
      bytes: new Uint8Array([255, 254, 253, 252]),
    })

    expect(here.received).toEqual([])
    expect(a.registry.documentCount()).toBe(1)
    const doc = new Y.Doc()
    Y.applyUpdate(doc, here.peer.missing(null) as Uint8Array)
    expect(projectCircuit(doc).circuit.operations).toEqual(saved.operations)
  })

  it('only the replica that took the edit owes the row a write', async () => {
    const bus = memoryBus()
    const versions = { c1: circuitOf() }
    const rows = new Map<string, Uint8Array>()
    const a = harness({ versions, bus, rows, replicaId: 'replica-a' })
    const b = harness({ versions, bus, rows, replicaId: 'replica-b' })

    const here = await join(a.registry, 'c1')
    await join(b.registry, 'c1', 'read')
    const browser = new Browser(here.peer.missing(null), 1001)
    browser.edit(place(gate('op_1', 'h', 0, 0)))
    for (const update of browser.outgoing) here.peer.apply(update)

    await a.advance(PERSIST_QUIET_MS)
    await b.advance(PERSIST_QUIET_MS)
    expect(a.writes).toEqual(['c1'])
    expect(b.writes).toEqual([])
  })

  it('degrades to single-instance when the bus cannot be reached', async () => {
    const failing: CollabBus = {
      publish: () => Promise.reject(new Error('redis is down')),
      subscribe: () => Promise.reject(new Error('redis is down')),
    }
    const h = harness({ versions: { c1: circuitOf() }, bus: failing })
    const a = await join(h.registry, 'c1')
    const b = await join(h.registry, 'c1')

    const browser = new Browser(a.peer.missing(null), 1001)
    browser.edit(place(gate('op_1', 'h', 0, 0)))
    for (const update of browser.outgoing) {
      expect(a.peer.apply(update)).toMatchObject({ ok: true })
    }
    // The peers on this replica see each other perfectly; only the others do not.
    expect(b.received).toHaveLength(1)
    expect(h.logs.some((line) => line.level === 'warn')).toBe(true)
  })
})

/* ── presence ────────────────────────────────────────────────────────────── */

describe('presence beside the document (M5.3)', () => {
  const looking = (column: number, name: string | null): PresenceState => ({
    name,
    access: 'write',
    cursor: { qubit: 0, column },
    selection: [],
    edits: 0,
  })

  it('reaches every other peer and never its author', async () => {
    const h = harness({ versions: { c1: circuitOf() } })
    const ada = await join(h.registry, 'c1')
    const grace = await join(h.registry, 'c1', 'read')

    ada.peer.publishPresence(looking(3, 'Ada'))

    expect(grace.presences).toEqual([[ada.peerId, looking(3, 'Ada')]])
    // A client knows where its own cursor is; a second caret on top of the real
    // one is the classic presence bug.
    expect(ada.presences).toEqual([])
  })

  it('hands a joiner everybody already here, and not itself', async () => {
    const h = harness({ versions: { c1: circuitOf() } })
    const ada = await join(h.registry, 'c1')
    ada.peer.publishPresence(looking(1, 'Ada'))

    const beto = await join(h.registry, 'c1')
    beto.peer.publishPresence(looking(4, 'Beto'))

    expect(beto.peer.roster()).toEqual([
      { peerId: ada.peerId, state: looking(1, 'Ada'), seenAt: 1_000 },
    ])
    expect(ada.peer.roster().map((record) => record.peerId)).toEqual([
      beto.peerId,
    ])
  })

  it('takes a cursor off the grid the moment a socket detaches', async () => {
    // The one reliable signal presence ever gets. Waiting for the timeout after
    // a definitive answer arrived would leave a caret on screen for half a
    // minute.
    const h = harness({ versions: { c1: circuitOf() } })
    const ada = await join(h.registry, 'c1')
    const grace = await join(h.registry, 'c1', 'read')
    ada.peer.publishPresence(looking(3, 'Ada'))

    ada.peer.detach()

    expect(grace.presences.at(-1)).toEqual([ada.peerId, null])
    expect(grace.peer.roster()).toEqual([])
  })

  it('says nothing about a peer that detached without ever being seen', async () => {
    const h = harness({ versions: { c1: circuitOf() } })
    const ada = await join(h.registry, 'c1')
    const grace = await join(h.registry, 'c1', 'read')

    ada.peer.detach()

    expect(grace.presences).toEqual([])
  })

  it('expires a ghost and tells everybody, without a timer', async () => {
    const h = harness({ versions: { c1: circuitOf() } })
    const ghost = await join(h.registry, 'c1')
    const ada = await join(h.registry, 'c1')
    ghost.peer.publishPresence(looking(0, 'Ghost'))

    // The ghost's tab was killed: no close frame, no heartbeat. Nothing prunes
    // until somebody else publishes, which is the lazy expiry `presence.ts`
    // argues for — and the client's own timeout is what covers a session where
    // nobody does.
    await h.advance(PRESENCE_TIMEOUT_MS)
    ada.peer.publishPresence(looking(2, 'Ada'))

    expect(ada.presences.at(-1)).toEqual([ghost.peerId, null])
    expect(ada.peer.roster()).toEqual([])
  })

  it('is not persisted with the document', async () => {
    // A cursor in the row would be a cursor restored into a session a week
    // later, on a circuit that has been edited since.
    const rows = new Map<string, Uint8Array>()
    const h = harness({ versions: { c1: circuitOf() }, rows })
    const ada = await join(h.registry, 'c1')
    const browser = new Browser(ada.peer.missing(null), 1001)
    browser.edit(place(gate('op_1', 'h', 0, 0)))
    for (const update of browser.outgoing) ada.peer.apply(update)
    ada.peer.publishPresence(looking(3, 'Ada'))
    ada.peer.detach()
    await h.advance(PERSIST_QUIET_MS)

    const state = rows.get('c1')
    expect(state).toBeDefined()
    const doc = new Y.Doc()
    Y.applyUpdate(doc, state as Uint8Array)
    expect(projectCircuit(doc).circuit.operations).toEqual([
      gate('op_1', 'h', 0, 0),
    ])
    expect(new TextDecoder().decode(state)).not.toContain('Ada')
  })

  it('crosses replicas, and is not republished by the one that received it', async () => {
    const bus = memoryBus()
    const versions = { c1: circuitOf() }
    const a = harness({ versions, bus, replicaId: 'replica-a' })
    const b = harness({ versions, bus, replicaId: 'replica-b' })
    const here = await join(a.registry, 'c1')
    const there = await join(b.registry, 'c1')

    here.peer.publishPresence(looking(5, 'Ada'))

    expect(there.presences).toEqual([[here.peerId, looking(5, 'Ada')]])
    // One publish, from the replica whose client sent it. A republish would be a
    // loop with as many hops as there are replicas.
    expect(bus.published.filter((m) => m.kind === 'presence')).toHaveLength(1)
    // And the newcomer's roster on the other replica knows about it, which is
    // what makes a joiner there see a peer here.
    expect(there.peer.roster()).toEqual([
      { peerId: here.peerId, state: looking(5, 'Ada'), seenAt: 1_000 },
    ])
  })

  it('drops a presence from a replica that does not describe one', async () => {
    // The bus is validated in `plugins/collab.ts`, so what arrives here is
    // already shaped — but a peer id from another replica is still an id this
    // process did not mint, and it must not be able to displace a local peer.
    const bus = memoryBus()
    const versions = { c1: circuitOf() }
    const a = harness({ versions, bus, replicaId: 'replica-a' })
    const here = await join(a.registry, 'c1')

    await bus.publish('circuit:c1', {
      kind: 'presence',
      origin: 'replica-b',
      peerId: here.peerId,
      state: null,
    })

    // Nothing to remove — this peer had published nothing — so nobody is told.
    expect(here.presences).toEqual([])
  })
})
