import { describe, expect, it } from 'vitest'
import { API_ERROR_CODES } from './errors.js'
import {
  MAX_COLLAB_STATE_BYTES,
  MAX_COLLAB_UPDATE_BYTES,
  MAX_PRESENCE_NAME_LENGTH,
  MAX_PRESENCE_SELECTION,
  MAX_SERVER_FRAME_BYTES,
  MAX_SOCKET_FRAME_BYTES,
  MAX_SOCKET_PENDING_BYTES,
  MAX_SOCKET_PENDING_FRAMES,
  MAX_SOCKET_TOKEN_LENGTH,
  SOCKET_CLOSE,
  SOCKET_ERROR_CODES,
  SOCKET_PATH,
  circuitChannel,
  decodeBinaryPayload,
  encodeBinaryPayload,
  encodeFrame,
  parseClientFrame,
  parseServerFrame,
} from './socket.js'
import type { ClientFrame, ServerFrame } from './socket.js'

describe('the socket vocabulary', () => {
  it('lives at §8’s path, outside the versioned prefix', () => {
    expect(SOCKET_PATH).toBe('/ws')
  })

  it('names the collaboration channel the way §8 does', () => {
    expect(circuitChannel('c1')).toBe('circuit:c1')
  })

  it('carries only error codes apps/web already translates', () => {
    // The whole reason the socket has no vocabulary of its own: a code outside
    // this list would be a sentence nobody wrote in three languages.
    for (const code of SOCKET_ERROR_CODES) {
      expect(API_ERROR_CODES).toContain(code)
    }
  })

  it('uses close codes from the RFC’s private range', () => {
    for (const code of Object.values(SOCKET_CLOSE)) {
      expect(code).toBeGreaterThanOrEqual(4000)
      expect(code).toBeLessThanOrEqual(4999)
    }
  })

  /**
   * The ceilings have to compose, and each of these three failed at least once
   * while they were being chosen.
   */
  it('admits the largest legal frame in each direction', () => {
    // A full-sized collaboration update, base64, plus its envelope.
    const largestUpdate = Math.ceil(MAX_COLLAB_UPDATE_BYTES / 3) * 4
    expect(largestUpdate).toBeLessThan(MAX_SOCKET_FRAME_BYTES)
    // A whole document on the join frame, which only the server sends.
    const largestState = Math.ceil(MAX_COLLAB_STATE_BYTES / 3) * 4
    expect(largestState).toBeLessThan(MAX_SERVER_FRAME_BYTES)
    // …and a client must be able to read what the server is allowed to send.
    expect(MAX_SERVER_FRAME_BYTES).toBeGreaterThan(MAX_SOCKET_FRAME_BYTES)
  })

  it('bounds a socket’s pending queue no more loosely than it used to', () => {
    // The queue used to be bounded by count alone, when every frame was under
    // 8 KiB. The frame ceiling has moved twelvefold since; the *product* is
    // what one caller can make this process hold, and it has not.
    expect(MAX_SOCKET_PENDING_BYTES).toBeLessThanOrEqual(
      8 * 1024 * MAX_SOCKET_PENDING_FRAMES
    )
  })
})

describe('the binary payload codec', () => {
  it('round-trips every byte value, at every length modulo three', () => {
    for (let length = 0; length <= 259; length += 1) {
      const bytes = Uint8Array.from({ length }, (_, index) => (index * 7) % 256)
      const text = encodeBinaryPayload(bytes)
      expect(decodeBinaryPayload(text)).toEqual(bytes)
    }
  })

  it('produces canonical base64, which the frame schema then accepts', () => {
    expect(encodeBinaryPayload(new Uint8Array([0]))).toBe('AA==')
    expect(encodeBinaryPayload(new Uint8Array([0, 1]))).toBe('AAE=')
    expect(encodeBinaryPayload(new Uint8Array([0, 1, 2]))).toBe('AAEC')
    expect(encodeBinaryPayload(new Uint8Array([255, 255, 255]))).toBe('////')
  })

  it('reads an unpadded payload, because both forms mean the same bytes', () => {
    expect(decodeBinaryPayload('AAE')).toEqual(new Uint8Array([0, 1]))
  })

  /**
   * The one property that matters more than tolerance: a decoder that returned
   * what it could read would hand the CRDT a truncated update, which integrates
   * and leaves the document holding half of somebody's gesture.
   */
  it('refuses anything that is not base64 rather than decoding part of it', () => {
    for (const text of ['A', 'AAAAA', 'AA=A', 'AA A', 'a-b_', '💥', 'AAAÿ']) {
      expect(decodeBinaryPayload(text)).toBeNull()
    }
  })
})

describe('parseClientFrame', () => {
  it('accepts the seven frames a client may send', () => {
    const frames: ClientFrame[] = [
      { type: 'authenticate', token: 'a.b.c' },
      { type: 'subscribe', runId: 'run_1' },
      { type: 'unsubscribe', runId: 'run_1' },
      { type: 'ping' },
      { type: 'collab:join', circuitId: 'c1' },
      { type: 'collab:join', circuitId: 'c1', since: 'AAEC' },
      { type: 'collab:update', circuitId: 'c1', update: 'AAEC' },
      { type: 'collab:leave', circuitId: 'c1' },
    ]
    for (const frame of frames) {
      expect(parseClientFrame(encodeFrame(frame))).toEqual(frame)
    }
  })

  it('refuses an update past the collaboration ceiling', () => {
    const update = encodeBinaryPayload(
      new Uint8Array(MAX_COLLAB_UPDATE_BYTES + 3)
    )
    expect(
      parseClientFrame(
        JSON.stringify({ type: 'collab:update', circuitId: 'c1', update })
      )
    ).toBeNull()
  })

  /**
   * The field is where hostile text is refused, not the decoder. A payload the
   * schema accepted and the decoder could not read is a second refusal, and
   * having both is what keeps either one from being the only one.
   */
  it('refuses an update that is not base64 at all', () => {
    for (const update of ['not base64!', 'AA=A', '../etc']) {
      expect(
        parseClientFrame(
          JSON.stringify({ type: 'collab:update', circuitId: 'c1', update })
        )
      ).toBeNull()
    }
  })

  it('refuses a circuit id that could name a channel of its own', () => {
    for (const circuitId of ['circuit:other', 'c 1', '*', 'a'.repeat(65)]) {
      expect(
        parseClientFrame(JSON.stringify({ type: 'collab:join', circuitId }))
      ).toBeNull()
    }
  })

  it('answers null for anything else, rather than throwing', () => {
    expect(parseClientFrame('{')).toBeNull()
    expect(parseClientFrame('"subscribe"')).toBeNull()
    expect(parseClientFrame(JSON.stringify({ type: 'simulate' }))).toBeNull()
    expect(
      parseClientFrame(JSON.stringify({ type: 'subscribe', runId: '' }))
    ).toBeNull()
  })

  it('refuses a run id that could address something other than a run', () => {
    for (const runId of ['../other', 'run 1', 'a'.repeat(65)]) {
      expect(
        parseClientFrame(JSON.stringify({ type: 'subscribe', runId }))
      ).toBeNull()
    }
  })

  it('refuses a token past the bound before a verifier ever sees it', () => {
    const token = 'x'.repeat(MAX_SOCKET_TOKEN_LENGTH + 1)
    expect(
      parseClientFrame(JSON.stringify({ type: 'authenticate', token }))
    ).toBeNull()
  })

  it('refuses an oversized frame before parsing it', () => {
    const padded = JSON.stringify({
      type: 'ping',
      pad: 'x'.repeat(MAX_SOCKET_FRAME_BYTES),
    })
    expect(parseClientFrame(padded)).toBeNull()
  })
})

describe('parseServerFrame', () => {
  it('accepts every frame the server may send', () => {
    const frames: ServerFrame[] = [
      { type: 'ready', viewer: null, expiresAt: null },
      { type: 'ready', viewer: 'u1', expiresAt: 1_700_000_000_000 },
      { type: 'subscribed', runId: 'run_1', status: 'QUEUED' },
      { type: 'unsubscribed', runId: 'run_1', reason: 'unauthorised' },
      {
        type: 'run:progress',
        runId: 'run_1',
        phase: 'simulating',
        completed: null,
        total: null,
      },
      { type: 'job:status', runId: 'run_1', status: 'RUNNING' },
      {
        type: 'run:complete',
        runId: 'run_1',
        status: 'FAILED',
        durationMs: null,
        error: 'TIMED_OUT',
      },
      { type: 'error', code: 'NOT_FOUND', runId: 'run_1' },
      { type: 'error', code: 'SIMULATION_UNAVAILABLE', runId: null },
      { type: 'pong' },
      {
        type: 'collab:joined',
        circuitId: 'c1',
        access: 'write',
        update: 'AAEC',
        vector: 'AAEC',
        deferred: 0,
        overflow: 0,
      },
      { type: 'collab:update', circuitId: 'c1', update: 'AAEC' },
      { type: 'collab:left', circuitId: 'c1', reason: 'unauthorised' },
      { type: 'collab:error', circuitId: 'c1', code: 'FORBIDDEN' },
    ]
    for (const frame of frames) {
      expect(parseServerFrame(encodeFrame(frame))).toEqual(frame)
    }
  })

  it('drops a frame from a newer API rather than failing', () => {
    // Deployment skew is the normal case, not the exceptional one: the API
    // ships ahead of the tab that is already open.
    expect(parseServerFrame(JSON.stringify({ type: 'run:queued' }))).toBeNull()
  })

  it('refuses a completion whose status is not terminal', () => {
    const raw = JSON.stringify({
      type: 'run:complete',
      runId: 'run_1',
      status: 'RUNNING',
      durationMs: null,
      error: null,
    })
    expect(parseServerFrame(raw)).toBeNull()
  })
})

describe('presence on the wire (M5.3)', () => {
  const position = {
    cursor: { qubit: 0, column: 4 },
    selection: ['op-1'],
    edits: 2,
  }

  function client(state: unknown): unknown {
    return parseClientFrame(
      JSON.stringify({ type: 'collab:presence', circuitId: 'c1', state })
    )
  }

  it('accepts a position, a cleared cursor and an empty selection', () => {
    expect(client(position)).toEqual({
      type: 'collab:presence',
      circuitId: 'c1',
      state: position,
    })
    expect(client({ cursor: null, selection: [], edits: 0 })).not.toBeNull()
  })

  /**
   * THE PROPERTY THE WHOLE DESIGN TURNS ON. A peer says where it is looking; the
   * server says who it is. There is no field here for a name, and the schema is
   * strict — so a client cannot smuggle one in, which is what §11's "a display
   * name, never an email" needs in order to be enforceable at all.
   */
  it('refuses a client that tries to name itself', () => {
    expect(client({ ...position, name: 'Somebody Else' })).toBeNull()
    expect(client({ ...position, access: 'write' })).toBeNull()
    expect(client({ ...position, email: 'ada@example.com' })).toBeNull()
  })

  it('admits the classical register row and refuses a cell off the format', () => {
    // The canvas grid has one row the circuit does not: the register sits at the
    // virtual wire index `size.qubits` and a cursor may stand there.
    expect(
      client({ ...position, cursor: { qubit: 28, column: 0 } })
    ).not.toBeNull()
    expect(client({ ...position, cursor: { qubit: 29, column: 0 } })).toBeNull()
    expect(
      client({ ...position, cursor: { qubit: 0, column: 4096 } })
    ).toBeNull()
    expect(client({ ...position, cursor: { qubit: 0, column: -1 } })).toBeNull()
  })

  it('bounds the selection a cursor may carry', () => {
    const many = Array.from({ length: MAX_PRESENCE_SELECTION + 1 }, () => 'op')
    expect(client({ ...position, selection: many })).toBeNull()
    // And an id with a NUL in it, which Postgres refuses inside jsonb and which
    // `storableText` is what keeps out of every string in this contract.
    expect(client({ ...position, selection: ['op '] })).toBeNull()
  })

  it('refuses an edit count that is not a bounded whole number', () => {
    expect(client({ ...position, edits: -1 })).toBeNull()
    expect(client({ ...position, edits: 1.5 })).toBeNull()
    expect(client({ ...position, edits: 2 ** 31 })).toBeNull()
  })

  it('reads a peer’s state and a peer’s departure from the server', () => {
    const state = {
      ...position,
      name: 'Ada Lovelace',
      access: 'read',
    }
    for (const payload of [state, null]) {
      expect(
        parseServerFrame(
          JSON.stringify({
            type: 'collab:presence',
            circuitId: 'c1',
            peerId: 'peer-1',
            state: payload,
          })
        )
      ).toEqual({
        type: 'collab:presence',
        circuitId: 'c1',
        peerId: 'peer-1',
        state: payload,
      })
    }
  })

  it('refuses a name past the ceiling from the server too', () => {
    // The relay truncates rather than refusing (see `MAX_PRESENCE_NAME_LENGTH`),
    // so a frame past it is a server this client should not believe.
    const raw = JSON.stringify({
      type: 'collab:presence',
      circuitId: 'c1',
      peerId: 'peer-1',
      state: {
        ...position,
        name: 'x'.repeat(MAX_PRESENCE_NAME_LENGTH + 1),
        access: 'read',
      },
    })
    expect(parseServerFrame(raw)).toBeNull()
  })
})

describe('the ceilings the two ends of the collaboration channel agree on', () => {
  /** The base64 length of `bytes` bytes, which is what a frame field carries. */
  const encoded = (bytes: number): number => Math.ceil(bytes / 3) * 4

  it('lets a client read the largest document the relay will serve', () => {
    /*
     * `collab:joined` carries a whole document, up to `MAX_COLLAB_STATE_BYTES`, and
     * base64 costs a third. A client ceiling below that would refuse the join frame
     * of a document the relay considers ordinary — and did, once the document
     * ceiling rose to hold the largest circuit a save accepts. The two constants
     * cannot be derived from one another in `socket.ts` (one is read before the
     * other is declared), so the relationship is asserted here instead.
     */
    expect(MAX_SERVER_FRAME_BYTES).toBeGreaterThan(
      encoded(MAX_COLLAB_STATE_BYTES)
    )
  })

  it('accepts a `collab:joined` at the document ceiling', () => {
    const raw = JSON.stringify({
      type: 'collab:joined',
      circuitId: 'c1',
      access: 'write',
      update: 'A'.repeat(encoded(MAX_COLLAB_STATE_BYTES)),
      vector: 'AAAA',
      deferred: 0,
      overflow: 0,
    })
    expect(raw.length).toBeLessThanOrEqual(MAX_SERVER_FRAME_BYTES)
    expect(parseServerFrame(raw)).toMatchObject({ type: 'collab:joined' })
  })
})
