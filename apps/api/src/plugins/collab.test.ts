/**
 * The cross-replica wire, and the decorator's two states.
 *
 * The Redis client itself is not exercised here — `plugins/events.ts` has the
 * same argument, and a test that needs a real instance is a test that turns a
 * dropped connection into a red build. What *is* exercised is the part that can
 * be wrong without anybody noticing: the framing, which is hand-rolled, and the
 * refusal of a payload anything holding the connection string could publish.
 */

import { circuitChannel } from '@qsim/contract'
import type { PresenceState } from '@qsim/contract'
import { describe, expect, it } from 'vitest'
import {
  decodeCollabMessage,
  encodeCollabMessage,
  namespacedChannel,
} from './collab.js'
import type { CollabMessage } from '../ws/documents.js'

describe('the cross-replica framing', () => {
  const messages: CollabMessage[] = [
    { kind: 'update', origin: 'replica-a', bytes: new Uint8Array([1, 2, 3]) },
    { kind: 'sync-request', origin: 'replica-b' },
    {
      kind: 'sync-state',
      origin: 'replica-c',
      bytes: new Uint8Array([255, 0]),
    },
  ]

  it('round-trips every message kind', () => {
    for (const message of messages) {
      expect(decodeCollabMessage(encodeCollabMessage(message))).toEqual(message)
    }
  })

  /**
   * The property the origin field exists for: Redis delivers a publish back to
   * the publisher over its own subscriber connection, so a replica has to be able
   * to recognise its own bytes. Applying them again is harmless in a CRDT;
   * republishing them is a loop with as many hops as there are replicas.
   */
  it('carries the origin verbatim, whatever the body contains', () => {
    // A body that begins with bytes that look like a header, so a decoder reading
    // past the length prefix would find a plausible one.
    const message: CollabMessage = {
      kind: 'update',
      origin: 'replica-a',
      bytes: new Uint8Array([1, 9, 65, 65]),
    }
    const decoded = decodeCollabMessage(encodeCollabMessage(message))
    expect(decoded).toEqual(message)
  })

  it('refuses a payload it cannot read rather than throwing', () => {
    const truncated = encodeCollabMessage(
      messages[0] as CollabMessage
    ).subarray(0, 4)
    for (const payload of [
      Buffer.alloc(0),
      Buffer.from([1]),
      // An origin length past the payload.
      Buffer.from([1, 40, 97]),
      // A zero-length origin: nobody can be recognised by it.
      Buffer.from([1, 0, 97, 98]),
      // A kind this build has no member for.
      Buffer.from([9, 1, 97, 98]),
      truncated,
    ]) {
      expect(decodeCollabMessage(payload)).toBeNull()
    }
  })

  /**
   * An empty body is refused for the two kinds that carry one. Yjs would throw on
   * a zero-length update, and this is the cheaper refusal — a message nobody can
   * act on, dropped before it reaches a decoder on a hot path.
   */
  it('refuses an update or a state with no bytes', () => {
    expect(decodeCollabMessage(Buffer.from([1, 1, 97]))).toBeNull()
    expect(decodeCollabMessage(Buffer.from([3, 1, 97]))).toBeNull()
    // A sync request legitimately has none.
    expect(decodeCollabMessage(Buffer.from([2, 1, 97]))).toEqual({
      kind: 'sync-request',
      origin: 'a',
    })
  })

  it('refuses to publish under an origin the framing cannot carry', () => {
    expect(() =>
      encodeCollabMessage({ kind: 'sync-request', origin: 'x'.repeat(300) })
    ).toThrow()
  })
})

describe('the channel a document is fanned out on', () => {
  /**
   * §8 names the channel; the prefix is what keeps development, production and
   * every test apart on the one Redis instance they share.
   */
  it('is §8’s name under this deployment’s prefix', () => {
    expect(namespacedChannel('qsim:test', circuitChannel('c1'))).toBe(
      'qsim:test:circuit:c1'
    )
  })
})

describe('a presence on the cross-replica wire (M5.3)', () => {
  const state: PresenceState = {
    name: 'Ada Lovelace',
    access: 'write',
    cursor: { qubit: 1, column: 4 },
    selection: ['op-1', 'op-2'],
    edits: 3,
  }

  it('round-trips a presence and a departure', () => {
    for (const message of [
      { kind: 'presence', origin: 'replica-a', peerId: 'peer-1', state },
      {
        kind: 'presence',
        origin: 'replica-a',
        peerId: 'peer-1',
        state: null,
      },
    ] satisfies CollabMessage[]) {
      expect(decodeCollabMessage(encodeCollabMessage(message))).toEqual(message)
    }
  })

  /**
   * The one message on this channel with a *shape*, and therefore the one that
   * has to be parsed rather than cast. Anything holding the connection string can
   * publish here, and what comes out of the decoder is composed into a frame every
   * peer in the session renders — so the schema is the socket's own, and there is
   * no second, laxer reading of a presence anywhere in the process.
   */
  it('refuses a body that is not a presence', () => {
    const envelope = encodeCollabMessage({
      kind: 'presence',
      origin: 'replica-a',
      peerId: 'peer-1',
      state,
    })
    const header = envelope.subarray(0, 2 + 'replica-a'.length)

    const bodies = [
      'not json at all',
      '{}',
      // A name past the ceiling the contract sets.
      JSON.stringify({
        peerId: 'p',
        state: { ...state, name: 'x'.repeat(200) },
      }),
      // A peer id shaped so it could name a Redis channel or a second field.
      JSON.stringify({ peerId: 'p:1', state }),
      // A selection past the ceiling: a peer that claims two hundred outlines.
      JSON.stringify({
        peerId: 'p',
        state: { ...state, selection: Array.from({ length: 40 }, () => 'op') },
      }),
      // A cursor off the grid the format allows at all.
      JSON.stringify({
        peerId: 'p',
        state: { ...state, cursor: { qubit: 0, column: 999_999 } },
      }),
      // An access level nobody defines.
      JSON.stringify({ peerId: 'p', state: { ...state, access: 'admin' } }),
      // A field the schema does not have. Strict, because an unknown key in a
      // presence is a peer talking to a build that is not this one.
      JSON.stringify({ peerId: 'p', state: { ...state, email: 'a@b.c' } }),
    ]

    for (const body of bodies) {
      const payload = Buffer.concat([header, Buffer.from(body, 'utf8')])
      expect(decodeCollabMessage(payload), body).toBeNull()
    }
  })
})
