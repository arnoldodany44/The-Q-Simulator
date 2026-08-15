import { describe, expect, it } from 'vitest'

import { DEV_API_BASE_URL, resolveApiBaseUrl } from './config.js'

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
