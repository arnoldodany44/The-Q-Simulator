import { describe, expect, it } from 'vitest'

import { CIRCUIT_ROUTES, circuitPath, fillRoute } from './paths.js'

describe('fillRoute', () => {
  it('substitutes every placeholder', () => {
    expect(fillRoute(CIRCUIT_ROUTES.version, { id: 'abc', n: 3 })).toBe(
      '/circuits/abc/versions/3'
    )
  })

  it('encodes each segment separately, leaving the separators alone', () => {
    expect(fillRoute(CIRCUIT_ROUTES.item, { id: 'a/b?c' })).toBe(
      '/circuits/a%2Fb%3Fc'
    )
  })

  it('throws rather than leaving a placeholder in the path', () => {
    expect(() => fillRoute(CIRCUIT_ROUTES.version, { id: 'abc' })).toThrow(':n')
  })
})

describe('circuitPath', () => {
  it('builds every route the client calls', () => {
    expect(circuitPath.collection()).toBe('/circuits')
    expect(circuitPath.item('abc')).toBe('/circuits/abc')
    expect(circuitPath.fork('abc')).toBe('/circuits/abc/fork')
    expect(circuitPath.versions('abc')).toBe('/circuits/abc/versions')
    expect(circuitPath.version('abc', 2)).toBe('/circuits/abc/versions/2')
  })

  /*
   * The point of building from templates rather than from string literals: a
   * built path can never still contain the parameter notation, which is the
   * failure mode that shows up as a 404 nobody can explain.
   */
  it('never leaves Fastify parameter notation in a built path', () => {
    const built = [
      circuitPath.collection(),
      circuitPath.item('abc'),
      circuitPath.fork('abc'),
      circuitPath.versions('abc'),
      circuitPath.version('abc', 2),
    ]

    for (const path of built) expect(path).not.toMatch(/:[A-Za-z]/)
  })
})
