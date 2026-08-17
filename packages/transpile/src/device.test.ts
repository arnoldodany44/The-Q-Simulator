import { describe, expect, it } from 'vitest'

import {
  UNUSABLE_ERROR,
  deviceGraph,
  girthOf,
  type DeviceTarget,
} from './device.js'
import { TranspileRefusal } from './refusal.js'
import { HERON, HERON_UNCALIBRATED } from './testing/heron.js'

describe('girthOf', () => {
  const graph = (
    edges: readonly (readonly [number, number])[],
    size: number
  ) => {
    const adjacency: number[][] = Array.from({ length: size }, () => [])
    for (const [a, b] of edges) {
      ;(adjacency[a] as number[]).push(b)
      ;(adjacency[b] as number[]).push(a)
    }
    return adjacency
  }

  it('is 3 for a triangle', () => {
    expect(
      girthOf(
        graph(
          [
            [0, 1],
            [1, 2],
            [0, 2],
          ],
          3
        )
      )
    ).toBe(3)
  })

  it('is 4 for a square', () => {
    expect(
      girthOf(
        graph(
          [
            [0, 1],
            [1, 2],
            [2, 3],
            [3, 0],
          ],
          4
        )
      )
    ).toBe(4)
  })

  it('is Infinity for a path and for a star', () => {
    expect(
      girthOf(
        graph(
          [
            [0, 1],
            [1, 2],
            [2, 3],
          ],
          4
        )
      )
    ).toBe(Infinity)
    expect(
      girthOf(
        graph(
          [
            [0, 1],
            [0, 2],
            [0, 3],
          ],
          4
        )
      )
    ).toBe(Infinity)
  })

  it('finds a long cycle that no vertex sees locally', () => {
    const ring = Array.from({ length: 12 }, (_u, i): [number, number] => [
      i,
      (i + 1) % 12,
    ])
    expect(girthOf(graph(ring, 12))).toBe(12)
  })
})

describe('a real Heron device', () => {
  const graph = deviceGraph(HERON)

  it('couples 176 pairs out of the 12 090 a full register would', () => {
    expect(HERON.qubits).toBe(156)
    expect(HERON.coupling).toHaveLength(176)
    const complete = (156 * 155) / 2
    expect(HERON.coupling.length / complete).toBeLessThan(0.015)
  })

  it('gives every qubit at most three neighbours', () => {
    expect(graph.maxDegree).toBe(3)
  })

  it('has no triangle and no square: the shortest cycle is twelve long', () => {
    // This one number is the reason a Toffoli cannot run here, and the reason
    // `placement.ts` can refuse one before searching.
    expect(graph.girth).toBe(12)
  })

  it('drops the pairs and qubits whose calibration failed', () => {
    // Four qubits report an sx error of exactly 1 and several pairs a cz error
    // of exactly 1 — a calibration saying the gate does not work. Excluding
    // them is what stops a placement from choosing hardware that is dead.
    expect(graph.excludedQubits).toEqual([82, 94, 113, 130])
    expect(graph.excludedPairs).toHaveLength(10)
    expect(graph.edges).toHaveLength(166)
    expect(graph.usableQubits).toHaveLength(152)
    for (const pair of graph.edges) {
      expect(pair.error ?? 0).toBeLessThan(UNUSABLE_ERROR)
    }
  })

  it('keeps the girth after the broken pairs are removed', () => {
    expect(graph.girth).toBe(12)
  })

  it('knows the error rate of a pair, in either direction', () => {
    expect(graph.errorOf(53, 54)).toBeCloseTo(0.000998, 6)
    expect(graph.errorOf(54, 53)).toBe(graph.errorOf(53, 54))
    expect(graph.errorOf(0, 100)).toBeUndefined()
  })

  it('reports itself calibrated, and the topology-only copy does not', () => {
    expect(graph.calibrated).toBe(true)
    const bare = deviceGraph(HERON_UNCALIBRATED)
    expect(bare.calibrated).toBe(false)
    // Nothing is excluded without a calibration to exclude it by, so the bare
    // graph is the full lattice.
    expect(bare.edges).toHaveLength(176)
    expect(bare.girth).toBe(12)
  })
})

describe('a device this package cannot compile for', () => {
  const base: DeviceTarget = {
    name: 'eagle-ish',
    qubits: 3,
    coupling: [
      { a: 0, b: 1 },
      { a: 1, b: 2 },
    ],
  }

  it('is refused when its basis has no cz', () => {
    const target: DeviceTarget = {
      ...base,
      basisGates: ['ecr', 'id', 'rz', 'sx', 'x'],
    }
    expect(() => deviceGraph(target)).toThrowError(TranspileRefusal)
    try {
      deviceGraph(target)
    } catch (cause) {
      expect((cause as TranspileRefusal).code).toBe('device-basis-mismatch')
      expect((cause as TranspileRefusal).detail.missing).toBe('cz')
    }
  })

  it('accepts a basis that spells the identity "id"', () => {
    expect(() =>
      deviceGraph({ ...base, basisGates: ['cz', 'id', 'rz', 'sx', 'x'] })
    ).not.toThrow()
  })

  it('is refused when it couples a qubit it does not have', () => {
    expect(() =>
      deviceGraph({ ...base, coupling: [{ a: 0, b: 9 }] })
    ).toThrowError(/outside its own register/)
  })

  it('drops a pair listed twice rather than counting it twice', () => {
    const graph = deviceGraph({
      ...base,
      coupling: [
        { a: 0, b: 1 },
        { a: 1, b: 0 },
        { a: 1, b: 2 },
      ],
    })
    expect(graph.edges).toHaveLength(2)
  })
})
