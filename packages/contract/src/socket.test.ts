import { describe, expect, it } from 'vitest'
import { API_ERROR_CODES } from './errors.js'
import {
  MAX_SOCKET_FRAME_BYTES,
  MAX_SOCKET_TOKEN_LENGTH,
  SOCKET_CLOSE,
  SOCKET_ERROR_CODES,
  SOCKET_PATH,
  encodeFrame,
  parseClientFrame,
  parseServerFrame,
} from './socket.js'
import type { ClientFrame, ServerFrame } from './socket.js'

describe('the socket vocabulary', () => {
  it('lives at §8’s path, outside the versioned prefix', () => {
    expect(SOCKET_PATH).toBe('/ws')
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
})

describe('parseClientFrame', () => {
  it('accepts the four frames a client may send', () => {
    const frames: ClientFrame[] = [
      { type: 'authenticate', token: 'a.b.c' },
      { type: 'subscribe', runId: 'run_1' },
      { type: 'unsubscribe', runId: 'run_1' },
      { type: 'ping' },
    ]
    for (const frame of frames) {
      expect(parseClientFrame(encodeFrame(frame))).toEqual(frame)
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
