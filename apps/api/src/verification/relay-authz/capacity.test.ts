/**
 * What a crowd of readers can take away from a writer.
 *
 * Two ceilings bound what one process holds: `MAX_PEERS_PER_DOCUMENT` and
 * `MAX_DOCUMENTS`. Both are right to exist — §11 asks for resource limits, and
 * §3.4 admits *readers* into a live session, which is what makes them reachable
 * by strangers rather than only by collaborators.
 *
 * The question this file asks is the one that follows from admitting readers:
 * when a ceiling binds, whose join is refused? A relay in which a writer can be
 * crowded out of their own circuit by anonymous watchers has a denial of service
 * with no attacker skill in it at all — and that is what both ceilings did, being
 * first-come with no distinction between reading and writing.
 *
 * `RESERVED_FOR_WRITERS` is the answer: a reader is refused a few slots earlier
 * than a writer, so a crowd of watchers can fill a session but never take the
 * last of it. No eviction and no priority queue — just a lower ceiling for the
 * participant §3.4 admits as a courtesy than for the one whose circuit it is.
 */

import { describe, expect, it } from 'vitest'
import {
  MAX_DOCUMENTS,
  MAX_PEERS_PER_DOCUMENT,
  RESERVED_FOR_WRITERS,
  createDocumentRegistry,
} from '../../ws/documents.js'
import { emptyCircuit } from '@qsim/schema'
import { connect, startRelay, upgradeStatus } from './harness.js'
import { seed } from './fixtures.js'

function registry() {
  const saved = new Map<string, Uint8Array>()
  return {
    saved,
    instance: createDocumentRegistry(
      {
        latestCircuit: () => Promise.resolve(emptyCircuit(2)),
        loadSession: () => Promise.resolve(null),
        saveSession: (circuitId, state) => {
          saved.set(circuitId, state)
          return Promise.resolve()
        },
        dropSession: () => Promise.resolve(),
        bus: null,
        now: () => Date.now(),
        schedule: () => () => undefined,
        log: () => undefined,
      },
      'replica-under-test'
    ),
  }
}

const listeners = {
  deliver: () => undefined,
  deliverPresence: () => undefined,
  dropped: () => undefined,
}

describe('a document’s peer slots', () => {
  it('keep room for the writer however many readers arrive first', async () => {
    const relay = registry()
    try {
      const forReaders = MAX_PEERS_PER_DOCUMENT - RESERVED_FOR_WRITERS
      for (let peer = 0; peer < forReaders; peer += 1) {
        const attached = await relay.instance.attach({
          circuitId: 'circuit-under-test',
          peerId: `watcher-${String(peer)}`,
          access: 'read',
          ...listeners,
        })
        expect(attached).not.toHaveProperty('refused')
      }
      // One more reader is refused: the rest of the slots are not theirs to take.
      const crowd = await relay.instance.attach({
        circuitId: 'circuit-under-test',
        peerId: 'one-watcher-too-many',
        access: 'read',
        ...listeners,
      })
      expect(crowd).toEqual({ refused: 'too-many-peers' })

      // The owner of the circuit still gets into their own live session.
      const owner = await relay.instance.attach({
        circuitId: 'circuit-under-test',
        peerId: 'the-owner',
        access: 'write',
        ...listeners,
      })
      expect(owner).not.toHaveProperty('refused')
    } finally {
      await relay.instance.close()
    }
  })
})

describe('the process’s document slots', () => {
  it('keep room for an owner however many circuits are being watched', async () => {
    const relay = registry()
    try {
      const forReaders = MAX_DOCUMENTS - RESERVED_FOR_WRITERS
      for (let document = 0; document < forReaders; document += 1) {
        const attached = await relay.instance.attach({
          circuitId: `public-circuit-${String(document)}`,
          peerId: `watcher-${String(document)}`,
          access: 'read',
          ...listeners,
        })
        expect(attached).not.toHaveProperty('refused')
      }
      const crowd = await relay.instance.attach({
        circuitId: 'one-watched-circuit-too-many',
        peerId: 'one-watcher-too-many',
        access: 'read',
        ...listeners,
      })
      expect(crowd).toEqual({ refused: 'too-many-documents' })

      const owner = await relay.instance.attach({
        circuitId: 'the-owners-own-circuit',
        peerId: 'the-owner',
        access: 'write',
        ...listeners,
      })
      expect(owner).not.toHaveProperty('refused')
    } finally {
      await relay.instance.close()
    }
  })
})

describe('the connection ceilings on the socket itself', () => {
  it('bound how many sockets one address may hold', async () => {
    const relay = await startRelay()
    try {
      const circuits = await seed(relay)
      const held = []
      const readerSlots = MAX_PEERS_PER_DOCUMENT - RESERVED_FOR_WRITERS
      for (let socket = 0; socket < readerSlots; socket += 1) {
        const peer = await connect(relay)
        peer.send({ type: 'collab:join', circuitId: circuits.public.id })
        await peer.waitFor((frame) => frame.type === 'collab:joined')
        held.push(peer)
      }
      // A seventeenth socket from one address is refused at the upgrade, before
      // any frame — and the reader slots of the document run out first, which is
      // the reservation working: an address cannot fill a session on its own.
      const extra = await connect(relay)
      extra.send({ type: 'collab:join', circuitId: circuits.public.id })
      const refused = await extra.waitFor(
        (frame) => frame.type === 'collab:error'
      )
      expect(refused).toMatchObject({ code: 'RATE_LIMITED' })
      extra.close()

      for (let socket = held.length; socket < 16; socket += 1) {
        held.push(await connect(relay))
      }
      expect(await upgradeStatus(relay)).toBe(429)
      expect(held).toHaveLength(16)
      for (const peer of held) peer.close()
    } finally {
      await relay.close()
    }
  })
})
