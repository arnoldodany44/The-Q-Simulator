import { describe, expect, it } from 'vitest'

import {
  GATE_MATRICES,
  ISWAP_MATRIX,
  SWAP_MATRIX,
  dagger,
  isOneQubitGateId,
  matrixFor,
  pMatrix,
  rxMatrix,
  ryMatrix,
  rzMatrix,
  uMatrix,
  type FixedGateId,
  type Matrix2,
} from './gates.js'

/** Decision D6: tolerance 1e-10, expressed as digits for `toBeCloseTo`. */
const DIGITS = 10

const IDENTITY = [1, 0, 0, 0, 0, 0, 1, 0]

/** Matrix product `a·b`, in the flat layout documented in gates.ts. */
function multiply(a: Matrix2, b: Matrix2): Matrix2 {
  const out = new Float64Array(8)
  for (let row = 0; row < 2; row++) {
    for (let column = 0; column < 2; column++) {
      let re = 0
      let im = 0
      for (let k = 0; k < 2; k++) {
        const left = (row * 2 + k) * 2
        const right = (k * 2 + column) * 2
        re += a[left] * b[right] - a[left + 1] * b[right + 1]
        im += a[left] * b[right + 1] + a[left + 1] * b[right]
      }
      out[(row * 2 + column) * 2] = re
      out[(row * 2 + column) * 2 + 1] = im
    }
  }
  return out
}

function expectMatrix(actual: Float64Array, expected: readonly number[]): void {
  expect(actual.length).toBe(expected.length)
  for (let k = 0; k < expected.length; k++) {
    expect(actual[k]).toBeCloseTo(expected[k], DIGITS)
  }
}

const SQRT1_2 = Math.SQRT1_2
const PI = Math.PI

describe('the fixed catalog', () => {
  it('is unitary, every entry of it', () => {
    for (const [id, matrix] of Object.entries(GATE_MATRICES)) {
      expect(matrix.length, id).toBe(8)
      expectMatrix(multiply(dagger(matrix), matrix), IDENTITY)
    }
  })

  it('spells the Pauli matrices the way the literature does', () => {
    expectMatrix(GATE_MATRICES.i, IDENTITY)
    expectMatrix(GATE_MATRICES.x, [0, 0, 1, 0, 1, 0, 0, 0])
    // Y = [[0,-i],[i,0]] — the imaginary parts are where sign errors hide.
    expectMatrix(GATE_MATRICES.y, [0, 0, 0, -1, 0, 1, 0, 0])
    expectMatrix(GATE_MATRICES.z, [1, 0, 0, 0, 0, 0, -1, 0])
  })

  it('builds H, S and T from the right constants', () => {
    expectMatrix(GATE_MATRICES.h, [
      SQRT1_2,
      0,
      SQRT1_2,
      0,
      SQRT1_2,
      0,
      -SQRT1_2,
      0,
    ])
    expectMatrix(GATE_MATRICES.s, [1, 0, 0, 0, 0, 0, 0, 1])
    // T's phase is e^{iπ/4}: equal real and imaginary parts, both 1/√2.
    expectMatrix(GATE_MATRICES.t, [1, 0, 0, 0, 0, 0, SQRT1_2, SQRT1_2])
  })

  it('satisfies the identities that pin the phases down', () => {
    const { h, s, sdg, sx, t, tdg, x, y, z } = GATE_MATRICES

    expectMatrix(multiply(h, h), IDENTITY)
    expectMatrix(multiply(s, s), [...z])
    expectMatrix(multiply(sx, sx), [...x])
    expectMatrix(multiply(s, sdg), IDENTITY)
    expectMatrix(multiply(t, tdg), IDENTITY)

    // X·Y·Z = iI. A single flipped sign anywhere in the Paulis breaks this.
    expectMatrix(multiply(multiply(x, y), z), [0, 1, 0, 0, 0, 0, 0, 1])

    let power = GATE_MATRICES.i
    for (let k = 0; k < 8; k++) power = multiply(power, t)
    expectMatrix(power, IDENTITY)
  })
})

describe('the parametrised gates', () => {
  const angles = [0, 0.3, PI / 4, PI / 2, PI, 2 * PI, -1.25]

  it('stay unitary at every angle tried', () => {
    for (const theta of angles) {
      for (const matrix of [
        rxMatrix(theta),
        ryMatrix(theta),
        rzMatrix(theta),
        pMatrix(theta),
        uMatrix(theta, theta / 2, -theta),
      ]) {
        expectMatrix(multiply(dagger(matrix), matrix), IDENTITY)
      }
    }
  })

  it('uses the half angle, so a 2π rotation is -I and not I', () => {
    expectMatrix(rxMatrix(2 * PI), [-1, 0, 0, 0, 0, 0, -1, 0])
    expectMatrix(rxMatrix(PI), [0, 0, 0, -1, 0, -1, 0, 0]) // -iX
    expectMatrix(ryMatrix(PI), [0, 0, -1, 0, 1, 0, 0, 0])
    expectMatrix(rzMatrix(PI), [0, -1, 0, 0, 0, 0, 0, 1]) // diag(-i, i)
  })

  it('keeps Rz and P a global phase apart', () => {
    // Rz(θ) = e^{-iθ/2}·P(θ). Global here, but not once the gate is
    // controlled — which is why crz and cp are separate gates.
    const theta = 0.9
    const rz = rzMatrix(theta)
    const p = pMatrix(theta)
    const phaseRe = Math.cos(theta / 2)
    const phaseIm = -Math.sin(theta / 2)
    for (let k = 0; k < 8; k += 2) {
      expect(rz[k]).toBeCloseTo(p[k] * phaseRe - p[k + 1] * phaseIm, DIGITS)
      expect(rz[k + 1]).toBeCloseTo(p[k] * phaseIm + p[k + 1] * phaseRe, DIGITS)
    }
  })

  it('reproduces Z, S and T from P', () => {
    expectMatrix(pMatrix(PI), [...GATE_MATRICES.z])
    expectMatrix(pMatrix(PI / 2), [...GATE_MATRICES.s])
    expectMatrix(pMatrix(PI / 4), [...GATE_MATRICES.t])
  })

  it('reproduces X, H and P from U, as Qiskit does', () => {
    expectMatrix(uMatrix(PI, 0, PI), [...GATE_MATRICES.x])
    expectMatrix(uMatrix(PI / 2, 0, PI), [...GATE_MATRICES.h])
    expectMatrix(uMatrix(0, 0, 1.1), [...pMatrix(1.1)])
  })

  it('relates √X to Rx(π/2) by the phase Qiskit gives it', () => {
    // SX = e^{iπ/4}·Rx(π/2). U(θ,φ,λ) has a real top-left entry by
    // construction, so it can only ever reach √X up to this phase — which is
    // exactly why the catalog stores √X explicitly instead of deriving it.
    const rx = rxMatrix(PI / 2)
    for (let k = 0; k < 8; k += 2) {
      expect(GATE_MATRICES.sx[k]).toBeCloseTo(
        (rx[k] - rx[k + 1]) * SQRT1_2,
        DIGITS
      )
      expect(GATE_MATRICES.sx[k + 1]).toBeCloseTo(
        (rx[k] + rx[k + 1]) * SQRT1_2,
        DIGITS
      )
    }
  })
})

describe('dagger', () => {
  it('turns each gate into its inverse', () => {
    expectMatrix(dagger(GATE_MATRICES.s), [...GATE_MATRICES.sdg])
    expectMatrix(dagger(GATE_MATRICES.t), [...GATE_MATRICES.tdg])
    expectMatrix(dagger(GATE_MATRICES.h), [...GATE_MATRICES.h])
  })

  it('is its own inverse', () => {
    const matrix = uMatrix(0.7, -0.2, 1.9)
    expectMatrix(dagger(dagger(matrix)), [...matrix])
  })

  it('rejects a matrix that is not 2×2', () => {
    expect(() => dagger(SWAP_MATRIX)).toThrow(RangeError)
  })

  it('transposes as well as conjugates', () => {
    // A symmetric-looking bug — conjugate without transpose — survives every
    // diagonal gate, so it has to be caught on an asymmetric one.
    expectMatrix(
      dagger(new Float64Array([0, 0, 1, 2, 3, 4, 0, 0])),
      [0, 0, 3, -4, 1, -2, 0, 0]
    )
  })
})

describe('matrixFor', () => {
  it('hands back the shared catalog matrix for fixed gates', () => {
    for (const id of Object.keys(GATE_MATRICES)) {
      const gate = id as FixedGateId
      expect(matrixFor(gate)).toBe(GATE_MATRICES[gate])
    }
  })

  it('builds the parametrised gates from positional parameters', () => {
    expectMatrix(matrixFor('rx', [0.4]), [...rxMatrix(0.4)])
    expectMatrix(matrixFor('ry', [0.4]), [...ryMatrix(0.4)])
    expectMatrix(matrixFor('rz', [0.4]), [...rzMatrix(0.4)])
    expectMatrix(matrixFor('p', [0.4]), [...pMatrix(0.4)])
    expectMatrix(matrixFor('u', [0.4, 0.5, 0.6]), [...uMatrix(0.4, 0.5, 0.6)])
  })

  it('refuses to invent a missing angle', () => {
    expect(() => matrixFor('rx')).toThrow(RangeError)
    expect(() => matrixFor('rx', [1, 2])).toThrow(RangeError)
    expect(() => matrixFor('u', [1, 2])).toThrow(RangeError)
    expect(() => matrixFor('rz', [Number.NaN])).toThrow(RangeError)
    expect(() => matrixFor('p', [Number.POSITIVE_INFINITY])).toThrow(RangeError)
  })

  it('knows which schema gate ids it can answer for', () => {
    for (const id of ['i', 'x', 'sx', 'rx', 'ry', 'rz', 'p', 'u']) {
      expect(isOneQubitGateId(id), id).toBe(true)
    }
    // Multi-qubit and structural gates are not this function's business.
    for (const id of ['cx', 'cz', 'swap', 'iswap', 'ccx', 'measure', 'nope']) {
      expect(isOneQubitGateId(id), id).toBe(false)
    }
  })
})

describe('the two-qubit reference matrices', () => {
  it('spells SWAP as the |01⟩ ↔ |10⟩ exchange', () => {
    expect([...SWAP_MATRIX]).toEqual([
      1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1, 0, 0, 0, 0, 0, 1, 0, 0, 0, 0, 0, 0,
      0, 0, 0, 0, 0, 1, 0,
    ])
  })

  it('gives iSWAP the factor of i on the exchanged amplitudes', () => {
    // Entry (1,2) and (2,1) are i; the diagonal corners stay 1.
    expect(ISWAP_MATRIX[(1 * 4 + 2) * 2]).toBe(0)
    expect(ISWAP_MATRIX[(1 * 4 + 2) * 2 + 1]).toBe(1)
    expect(ISWAP_MATRIX[(2 * 4 + 1) * 2]).toBe(0)
    expect(ISWAP_MATRIX[(2 * 4 + 1) * 2 + 1]).toBe(1)
    expect(ISWAP_MATRIX[0]).toBe(1)
    expect(ISWAP_MATRIX[(3 * 4 + 3) * 2]).toBe(1)
  })
})
