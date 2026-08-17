// @vitest-environment node
import { CIRCUIT_SCHEMA_VERSION } from '@qsim/schema'
import { describe, expect, it, vi } from 'vitest'

import { fetchEmbed } from './fetchEmbed'

/**
 * The one request an embed makes, and what it must never carry.
 *
 * The first test is the one this file exists for. An embed is served from the
 * app's own origin, so a frame that used the shared API client would send a
 * signed-in reader's bearer token out from inside a stranger's blog post —
 * and it would do so on every frame, on every page load, whether or not the
 * server chose to answer differently. Asserting the absence of the header is
 * the version of that promise a refactor cannot quietly undo.
 */

const BELL = {
  schemaVersion: CIRCUIT_SCHEMA_VERSION,
  qubits: 2,
  clbits: 0,
  operations: [
    { id: 'op-0', gate: 'h', targets: [0], column: 0 },
    { id: 'op-1', gate: 'cx', targets: [1], controls: [0], column: 1 },
  ],
}

function body(): unknown {
  return {
    embed: {
      slug: 'V1StGXR8Z5jdHi6B',
      title: 'Bell pair',
      qubitCount: 2,
      gateCount: 2,
      depth: 2,
      author: { username: 'ada' },
      circuit: BELL,
    },
  }
}

function answering(status: number, payload: unknown) {
  return vi.fn(() =>
    Promise.resolve({
      ok: status >= 200 && status < 300,
      status,
      json: () => Promise.resolve(payload),
    } as unknown as Response)
  )
}

describe('fetchEmbed', () => {
  it('sends no credentials of any kind', async () => {
    const fetchSpy = answering(200, body())

    await fetchEmbed('V1StGXR8Z5jdHi6B', {
      fetch: fetchSpy,
      baseUrl: 'https://api.example.test',
    })

    const call = fetchSpy.mock.calls[0] as unknown as [string, RequestInit]
    const init = call[1]
    expect(init.credentials).toBe('omit')
    const headers = init.headers as Record<string, string>
    expect(Object.keys(headers).map((key) => key.toLowerCase())).not.toContain(
      'authorization'
    )
    expect(Object.keys(headers).map((key) => key.toLowerCase())).not.toContain(
      'cookie'
    )
  })

  it('asks the embed route, not the circuit route', async () => {
    /*
     * `/circuits/:id` is `auth: 'optional'` and would answer an owner's
     * PRIVATE circuit. The whole point of the separate route is that this
     * client cannot reach the one that reads a token.
     */
    const fetchSpy = answering(200, body())

    await fetchEmbed('V1StGXR8Z5jdHi6B', {
      fetch: fetchSpy,
      baseUrl: 'https://api.example.test',
    })

    expect((fetchSpy.mock.calls[0] as unknown as [string])[0]).toBe(
      'https://api.example.test/api/v1/embed/V1StGXR8Z5jdHi6B'
    )
  })

  it('parses the response through the contract', async () => {
    const result = await fetchEmbed('V1StGXR8Z5jdHi6B', {
      fetch: answering(200, body()),
      baseUrl: 'https://api.example.test',
    })

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.embed.title).toBe('Bell pair')
    expect(result.embed.gateCount).toBe(2)
  })

  it('reads a 404 as "not embeddable" and nothing more specific', async () => {
    // The server answers a PRIVATE circuit and a slug nobody minted with the
    // same 404 on purpose (§11). This client must not invent a distinction
    // the response does not carry.
    const result = await fetchEmbed('V1StGXR8Z5jdHi6B', {
      fetch: answering(404, { error: { code: 'NOT_FOUND' } }),
      baseUrl: 'https://api.example.test',
    })

    expect(result).toEqual({ ok: false, code: 'unavailable' })
  })

  it('reports a deployment with no API rather than guessing an origin', async () => {
    const fetchSpy = answering(200, body())

    const result = await fetchEmbed('V1StGXR8Z5jdHi6B', {
      fetch: fetchSpy,
      baseUrl: null,
    })

    expect(result).toEqual({ ok: false, code: 'no-api' })
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it('refuses a body the contract did not promise', async () => {
    /*
     * The failure this project has actually had: a misconfigured origin makes
     * the request land on the SPA rewrite, which answers `index.html`. Parsing
     * turns that into one honest failure here instead of `undefined` inside a
     * renderer three layers away.
     */
    const result = await fetchEmbed('V1StGXR8Z5jdHi6B', {
      fetch: answering(200, { embed: { title: 'Bell pair' } }),
      baseUrl: 'https://api.example.test',
    })

    expect(result).toEqual({ ok: false, code: 'failed' })
  })

  it('turns a transport failure into a state, never an exception', async () => {
    const result = await fetchEmbed('V1StGXR8Z5jdHi6B', {
      fetch: vi.fn(() => Promise.reject(new Error('offline'))),
      baseUrl: 'https://api.example.test',
    })

    expect(result).toEqual({ ok: false, code: 'failed' })
  })
})
