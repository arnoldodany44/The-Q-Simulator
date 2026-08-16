import { describe, expect, it, vi } from 'vitest'

import {
  DEV_API_BASE_URL,
  resolveApiBaseUrl,
  resolveSocketUrl,
} from './config.js'

describe('resolveApiBaseUrl', () => {
  it('uses the configured origin', () => {
    expect(
      resolveApiBaseUrl({ VITE_API_URL: 'https://api.example.test' })
    ).toBe('https://api.example.test')
  })

  it('removes trailing slashes, which would double the separator', () => {
    // Every contract path begins with `/`, so `https://host/` + `/api/v1`
    // is a URL with `//` that some proxies normalise and some 404.
    expect(
      resolveApiBaseUrl({ VITE_API_URL: 'https://api.example.test//' })
    ).toBe('https://api.example.test')
  })

  it('falls back to the documented local port in development', () => {
    expect(resolveApiBaseUrl({})).toBe(DEV_API_BASE_URL)
    expect(resolveApiBaseUrl({ VITE_API_URL: '   ' })).toBe(DEV_API_BASE_URL)
  })

  it('gives a production build with no origin no origin at all', () => {
    /*
     * Corrected to the right expectation rather than deleted, because the
     * concern that produced the old one is still real: left to DEFAULT, every
     * request would go to the Vercel origin, where the SPA rewrite serves
     * index.html, and the failure would surface as "the API sent an
     * unexpected response" for what is a deployment problem.
     *
     * The answer to that is `null` — which `createApiClient` refuses on, by
     * name, before it builds a URL — and not a throw. A throw at module load
     * takes the page with it; see the block at the end of this file.
     */
    expect(resolveApiBaseUrl({ PROD: true })).toBeNull()
  })
})

describe('resolveSocketUrl', () => {
  it('derives the socket origin from the API origin', () => {
    // One address, one place it can be wrong. A second variable would fail in
    // the nastiest way available: the REST calls work, so the app looks fine,
    // and only the progress feed points at the wrong host.
    expect(resolveSocketUrl('https://api.example.test')).toBe(
      'wss://api.example.test/ws'
    )
  })

  it('keeps a plaintext development origin plaintext', () => {
    expect(resolveSocketUrl('http://localhost:8080')).toBe(
      'ws://localhost:8080/ws'
    )
  })

  it('upgrades the scheme with the page, not independently', () => {
    /*
     * A page served over TLS may not open an insecure socket, and a browser
     * refuses it with a mixed-content error — which points at the wrong
     * problem entirely. Tying the two schemes together is what stops that.
     */
    expect(resolveSocketUrl('https://api.example.test')).toMatch(/^wss:/)
    expect(resolveSocketUrl('http://api.example.test')).toMatch(/^ws:/)
  })

  it('does not produce a double slash from a trailing one', () => {
    expect(resolveSocketUrl('https://api.example.test/')).toBe(
      'wss://api.example.test/ws'
    )
  })
})

/*
 * The regression this file exists for after the fact.
 *
 * Phase 1 shipped a `resolveApiBaseUrl` that threw on a production build with
 * no `VITE_API_URL`. The throw happened while the module graph was loading, so
 * React never mounted and the entire site rendered a white page — including
 * the landing and the editor, neither of which touches the API. Phase 0 had
 * been live and went down the moment Phase 1 merged, over one absent variable
 * in a dashboard.
 *
 * A configuration mistake may degrade the app. It may not delete it.
 */
describe('a production build with no API origin', () => {
  it('answers null rather than throwing', () => {
    expect(() => resolveApiBaseUrl({ PROD: true })).not.toThrow()
    expect(resolveApiBaseUrl({ PROD: true })).toBeNull()
    expect(resolveApiBaseUrl({ PROD: true, VITE_API_URL: '   ' })).toBeNull()
  })

  it('says so once, naming the variable and not a value', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    resolveApiBaseUrl({ PROD: true })

    const message = String(warn.mock.calls[0]?.[0] ?? '')
    expect(message).toContain('VITE_API_URL')
    expect(message).toMatch(/link|tab/i)
    warn.mockRestore()
  })
})
