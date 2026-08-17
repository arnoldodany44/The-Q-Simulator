/**
 * The Euler table, row by row, against the engine's own matrices.
 *
 * `euler.ts` claims that every one-qubit gate in the catalog is
 * `e^{iγ}·U(θ,φ,λ)` for the angles it lists. That claim is checked here
 * **exactly** — entry for entry including the phase, not up to a global factor
 * — because γ is the whole point of the table: dropping it is invisible on a
 * wire and is the difference between `crz` and `cp` under a control.
 *
 * The second half checks the other direction: that `zsxOf` turns those angles
 * into `rz` and `sx` correctly, this time up to global phase, which is the
 * modulo `zsxOf` documents itself as working to.
 */

import { describe, expect, it } from 'vitest'
import { GATES, type GateId } from '@qsim/schema'
import { matrixFor, uMatrix, type OneQubitGateId } from '@qsim/core'

import { matrixOf, multiply, identity2, type Matrix2 } from '../complex2.js'
import { eulerOf, zsxOf, type OneQubitCatalogId } from '../euler.js'

const EXACT = 1e-12

const ANGLES = [
  0,
  Math.PI / 2,
  Math.PI,
  -Math.PI / 3,
  1.234,
  -2.5,
  5.5,
] as const

function paramsFor(gate: GateId, seed: number): number[] {
  return Array.from(
    { length: GATES[gate].paramCount },
    (_unused, index) => ANGLES[(seed + index * 3) % ANGLES.length] as number
  )
}

function distance(a: Matrix2, b: Matrix2): number {
  let worst = 0
  for (let i = 0; i < 8; i++) {
    worst = Math.max(worst, Math.abs((a[i] as number) - (b[i] as number)))
  }
  return worst
}

/** |Tr(A†B)|²/4 — one for matrices that differ only by a phase. */
function phaseBlindFidelity(a: Matrix2, b: Matrix2): number {
  let re = 0
  let im = 0
  for (let i = 0; i < 8; i += 2) {
    const ar = a[i] as number
    const ai = a[i + 1] as number
    const br = b[i] as number
    const bi = b[i + 1] as number
    re += ar * br + ai * bi
    im += ar * bi - ai * br
  }
  return (re * re + im * im) / 4
}

const ONE_QUBIT = (Object.keys(GATES) as GateId[]).filter(
  (id) =>
    GATES[id].category === 'single' || GATES[id].category === 'parametrised'
)

describe('the table is the engine', () => {
  it('covers every one-qubit gate in the catalog', () => {
    for (const gate of ONE_QUBIT) {
      expect(() =>
        eulerOf(gate as OneQubitCatalogId, paramsFor(gate, 0))
      ).not.toThrow()
    }
  })

  for (const gate of ONE_QUBIT) {
    it(`${gate} = e^{i γ} U(θ, φ, λ), phase included`, () => {
      for (let seed = 0; seed < ANGLES.length; seed++) {
        const params = paramsFor(gate, seed)
        const fromTable = matrixOf(eulerOf(gate as OneQubitCatalogId, params))
        const fromEngine = matrixFor(gate as OneQubitGateId, params)
        expect(distance(fromTable, fromEngine)).toBeLessThan(EXACT)
        if (GATES[gate].paramCount === 0) break
      }
    })
  }

  it('matrixOf agrees with the engine s uMatrix', () => {
    for (const theta of ANGLES) {
      for (const phi of ANGLES) {
        for (const lambda of ANGLES) {
          const mine = matrixOf({ theta, phi, lambda, phase: 0 })
          expect(distance(mine, uMatrix(theta, phi, lambda))).toBeLessThan(
            EXACT
          )
        }
      }
    }
  })
})

describe('zsxOf implements the angles', () => {
  const RZ = (angle: number): Matrix2 => matrixFor('rz', [angle])
  const SX = matrixFor('sx')
  const X = matrixFor('x')

  /** The rotation list multiplied out: time order becomes right-to-left. */
  function product(rotations: ReturnType<typeof zsxOf>): Matrix2 {
    let out = identity2()
    for (const rotation of rotations) {
      const matrix =
        rotation.gate === 'rz'
          ? RZ(rotation.angle as number)
          : rotation.gate === 'sx'
            ? SX
            : X
      out = multiply(matrix, out)
    }
    return out
  }

  for (const gate of ONE_QUBIT) {
    it(`${gate} in rz and sx`, () => {
      for (let seed = 0; seed < ANGLES.length; seed++) {
        const angles = eulerOf(gate as OneQubitCatalogId, paramsFor(gate, seed))
        const target = matrixOf({ ...angles, phase: 0 })
        expect(
          1 - phaseBlindFidelity(product(zsxOf(angles)), target)
        ).toBeLessThan(1e-10)
        if (GATES[gate].paramCount === 0) break
      }
    })
  }

  it('takes the one-pulse path exactly when theta is exactly pi/2', () => {
    const pulses = (theta: number): number =>
      zsxOf({ theta, phi: 0.3, lambda: -0.7, phase: 0 }).filter(
        (rotation) => rotation.gate !== 'rz'
      ).length
    expect(pulses(Math.PI / 2)).toBe(1)
    // One ulp away is a different rotation, and taking the short path for it
    // would mean the transpiler silently changed the circuit.
    expect(pulses(Math.PI / 2 + Number.EPSILON)).toBe(2)
    expect(pulses(0)).toBe(0)
    expect(pulses(Math.PI)).toBe(1)
    expect(pulses(1.234)).toBe(2)
  })

  it('never emits an rz of exactly zero', () => {
    for (const theta of [0, Math.PI / 2, Math.PI, 1.1]) {
      for (const phi of [0, Math.PI / 2, -Math.PI / 2]) {
        for (const lambda of [0, Math.PI / 2, -Math.PI / 2]) {
          for (const rotation of zsxOf({ theta, phi, lambda, phase: 0 })) {
            expect(rotation.angle).not.toBe(0)
          }
        }
      }
    }
  })
})
