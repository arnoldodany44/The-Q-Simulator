import { describe, expect, it } from 'vitest'
import { dagger, matrixFor, type OneQubitGateId } from '@qsim/core'

import {
  identity2,
  matrixOf,
  multiply,
  scale,
  sqrtOf,
  unitarityDefect,
  zyzOf,
  type Matrix2,
} from './complex2.js'

const EXACT = 1e-12

function distance(a: Matrix2, b: Matrix2): number {
  let worst = 0
  for (let i = 0; i < 8; i++) {
    worst = Math.max(worst, Math.abs((a[i] as number) - (b[i] as number)))
  }
  return worst
}

/** A spread of unitaries wide enough to reach both degenerate branches. */
const SAMPLES: readonly Matrix2[] = [
  identity2(),
  matrixFor('x'),
  matrixFor('y'),
  matrixFor('z'),
  matrixFor('h'),
  matrixFor('s'),
  matrixFor('t'),
  matrixFor('sx'),
  matrixFor('rx', [0.7]),
  matrixFor('ry', [-2.1]),
  matrixFor('rz', [1.3]),
  matrixFor('p', [2.9]),
  matrixFor('u', [1.1, -0.4, 2.2]),
  matrixFor('u', [Math.PI, 0.3, -1.7]),
  matrixFor('u', [0, 0.5, 0.5]),
  scale(matrixFor('h'), Math.cos(0.9), Math.sin(0.9)),
]

describe('multiply', () => {
  it('composes in matrix order, so A·B is "apply B then A"', () => {
    // s·s = z, and the product of the two matrices is z whichever way round
    // they are here, so the asymmetric check is h then x.
    const hThenX = multiply(matrixFor('x'), matrixFor('h'))
    const xThenH = multiply(matrixFor('h'), matrixFor('x'))
    expect(distance(hThenX, xThenH)).toBeGreaterThan(0.5)
    // H·X·H = Z, exactly.
    const conjugated = multiply(
      matrixFor('h'),
      multiply(matrixFor('x'), matrixFor('h'))
    )
    expect(distance(conjugated, matrixFor('z'))).toBeLessThan(EXACT)
  })

  it('keeps unitaries unitary', () => {
    for (const a of SAMPLES) {
      for (const b of SAMPLES) {
        expect(unitarityDefect(multiply(a, b))).toBeLessThan(EXACT)
      }
    }
  })
})

describe('zyzOf', () => {
  it('inverts matrixOf on every sample, phase included', () => {
    for (const sample of SAMPLES) {
      expect(distance(matrixOf(zyzOf(sample)), sample)).toBeLessThan(EXACT)
    }
  })

  it('inverts matrixOf on angles chosen to hit the degenerate branches', () => {
    const values = [0, Math.PI, Math.PI / 2, -0.3, 2.8]
    for (const theta of values) {
      for (const phi of values) {
        for (const lambda of values) {
          for (const phase of [0, 0.6, -1.9]) {
            const original = matrixOf({ theta, phi, lambda, phase })
            const round = matrixOf(zyzOf(original))
            expect(distance(round, original)).toBeLessThan(EXACT)
          }
        }
      }
    }
  })

  it('always returns theta in [0, pi]', () => {
    for (const sample of SAMPLES) {
      const { theta } = zyzOf(sample)
      expect(theta).toBeGreaterThanOrEqual(0)
      expect(theta).toBeLessThanOrEqual(Math.PI + EXACT)
    }
  })
})

describe('sqrtOf', () => {
  it('squares back to what it came from', () => {
    for (const sample of SAMPLES) {
      const root = sqrtOf(sample)
      expect(unitarityDefect(root)).toBeLessThan(EXACT)
      expect(distance(multiply(root, root), sample)).toBeLessThan(1e-10)
    }
  })

  it('handles the two cases the general formula cannot express', () => {
    // W = I.
    expect(distance(sqrtOf(identity2()), identity2())).toBeLessThan(EXACT)
    // W = −I, a full turn: any half turn is a root, and rz(π) is the one
    // the native basis spells for free.
    const minusIdentity = scale(identity2(), -1, 0)
    const root = sqrtOf(minusIdentity)
    expect(distance(multiply(root, root), minusIdentity)).toBeLessThan(1e-10)
  })

  it('gives S as a root of Z and T as a root of S, up to phase', () => {
    const rootOfZ = sqrtOf(matrixFor('z'))
    expect(distance(multiply(rootOfZ, rootOfZ), matrixFor('z'))).toBeLessThan(
      1e-12
    )
    const rootOfS = sqrtOf(matrixFor('s'))
    expect(distance(multiply(rootOfS, rootOfS), matrixFor('s'))).toBeLessThan(
      1e-12
    )
  })

  it('daggers to an inverse', () => {
    for (const sample of SAMPLES) {
      const root = sqrtOf(sample)
      const product = multiply(root, dagger(root))
      expect(distance(product, identity2())).toBeLessThan(EXACT)
    }
  })
})

describe('unitarityDefect', () => {
  it('is zero for gates and large for anything else', () => {
    for (const id of ['x', 'h', 'sx', 'z'] as OneQubitGateId[]) {
      expect(unitarityDefect(matrixFor(id))).toBeLessThan(EXACT)
    }
    expect(unitarityDefect(scale(identity2(), 2, 0))).toBeGreaterThan(1)
  })
})
