import { describe, expect, it } from 'vitest'

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

  it('refuses to build a production client with no origin configured', () => {
    /*
     * Left to default, every request would go to the Vercel origin, where the
     * SPA rewrite serves index.html — and the failure would surface as "the
     * API sent an unexpected response" for what is a deployment problem.
     */
    expect(() => resolveApiBaseUrl({ PROD: true })).toThrow('VITE_API_URL')
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
