import { describe, expect, it } from 'vitest'

import {
  apply1q,
  apply2q,
  applyControlled,
  applyISwap,
  applySwap,
  type ControlSpec,
} from './apply.js'
import {
  GATE_MATRICES,
  ISWAP_MATRIX,
  SWAP_MATRIX,
  rzMatrix,
  uMatrix,
  type Matrix2,
  type Matrix4,
} from './gates.js'
import { alloc, clone, renormalize, type Statevector } from './statevector.js'

/** Decision D6: tolerance 1e-10, expressed as digits for `toBeCloseTo`. */
const DIGITS = 10

const { h, x, y, z } = GATE_MATRICES

/**
 * A deterministic pseudo-random normalised state. Deterministic on purpose:
 * a kernel bug that only shows up for one amplitude pattern has to be
 * reproducible from the test name alone.
 */
function pseudoState(qubits: number, seed: number): Statevector {
  const state = alloc(qubits)
  let bits = seed >>> 0
  const next = (): number => {
    bits = (Math.imul(bits, 1664525) + 1013904223) >>> 0
    return bits / 0x100000000 - 0.5
  }
  for (let i = 0; i < state.size; i++) {
    state.re[i] = next()
    state.im[i] = next()
  }
  renormalize(state)
  return state
}

function expectSameState(actual: Statevector, expected: Statevector): void {
  expect(actual.size).toBe(expected.size)
  for (let i = 0; i < expected.size; i++) {
    expect(actual.re[i], `re[${i}]`).toBeCloseTo(expected.re[i], DIGITS)
    expect(actual.im[i], `im[${i}]`).toBeCloseTo(expected.im[i], DIGITS)
  }
}

/**
 * Kronecker product, `high ⊗ low`, in the 4×4 layout of `apply2q`: row index
 * `2·b₁ + b₀`, so `low` acts on the first qubit argument.
 *
 * This is the one place a Kronecker product is allowed to exist, and it is a
 * test oracle, not a code path — §5.2 forbids building one to *apply* a gate.
 * Comparing the kernel against it is how the basis order gets pinned down.
 */
function kron(high: Matrix2, low: Matrix2): Matrix4 {
  const out = new Float64Array(32)
  for (let rowHigh = 0; rowHigh < 2; rowHigh++) {
    for (let columnHigh = 0; columnHigh < 2; columnHigh++) {
      for (let rowLow = 0; rowLow < 2; rowLow++) {
        for (let columnLow = 0; columnLow < 2; columnLow++) {
          const a = (rowHigh * 2 + columnHigh) * 2
          const b = (rowLow * 2 + columnLow) * 2
          const at =
            ((rowHigh * 2 + rowLow) * 4 + (columnHigh * 2 + columnLow)) * 2
          out[at] = high[a] * low[b] - high[a + 1] * low[b + 1]
          out[at + 1] = high[a] * low[b + 1] + high[a + 1] * low[b]
        }
      }
    }
  }
  return out
}

const positive = (qubit: number): ControlSpec => ({ qubit, state: 1 })
const negative = (qubit: number): ControlSpec => ({ qubit, state: 0 })

describe('endianness (D1), the assertion this whole package hangs on', () => {
  it('moves |000⟩ to index 1 when X hits qubit 0, not to index 4', () => {
    const state = alloc(3)
    apply1q(state, x, 0)
    expect(state.re[1]).toBe(1)
    expect(state.re[4]).toBe(0)
    expect([...state.re]).toEqual([0, 1, 0, 0, 0, 0, 0, 0])
  })

  it('moves |000⟩ to index 4 when X hits qubit 2', () => {
    const state = alloc(3)
    apply1q(state, x, 2)
    expect([...state.re]).toEqual([0, 0, 0, 0, 1, 0, 0, 0])
  })

  it('pairs indices across the target bit and leaves the rest alone', () => {
    // Start in |101⟩ = index 5, then H on qubit 1 mixes it with index 7.
    const state = alloc(3)
    apply1q(state, x, 0)
    apply1q(state, x, 2)
    apply1q(state, h, 1)
    expect(state.re[5]).toBeCloseTo(Math.SQRT1_2, DIGITS)
    expect(state.re[7]).toBeCloseTo(Math.SQRT1_2, DIGITS)
    for (const i of [0, 1, 2, 3, 4, 6]) {
      expect(state.re[i], `re[${i}]`).toBeCloseTo(0, DIGITS)
    }
  })

  it('acts on the same qubit whichever position it sits in', () => {
    for (const target of [0, 1, 2, 3]) {
      const state = alloc(4)
      apply1q(state, x, target)
      expect(state.re[1 << target]).toBe(1)
    }
  })
})

describe('applyControlled', () => {
  it('reproduces the CNOT truth table', () => {
    // Control qubit 0, target qubit 1, on two qubits:
    // |00⟩→|00⟩, |01⟩→|11⟩, |10⟩→|10⟩, |11⟩→|01⟩ (indices 0,1,2,3).
    for (const [from, to] of [
      [0, 0],
      [1, 3],
      [2, 2],
      [3, 1],
    ]) {
      const state = alloc(2)
      state.re[0] = 0
      state.re[from] = 1
      applyControlled(state, x, 1, [positive(0)])
      expect(state.re[to], `|${from}⟩ → |${to}⟩`).toBe(1)
      expect(norm2(state)).toBeCloseTo(1, DIGITS)
    }
  })

  it('fires a negative control exactly where the positive one does not', () => {
    // The mirror identity: X·(control on |1⟩)·X on the control qubit is the
    // same operation as a control on |0⟩.
    const mirrored = pseudoState(3, 11)
    apply1q(mirrored, x, 0)
    applyControlled(mirrored, y, 2, [positive(0)])
    apply1q(mirrored, x, 0)

    const direct = pseudoState(3, 11)
    applyControlled(direct, y, 2, [negative(0)])

    expectSameState(direct, mirrored)
  })

  it('requires every control at once, positive or negative', () => {
    // Toffoli: controls on 0 and 1, target 2. Only |011⟩ (index 3) flips.
    for (let from = 0; from < 8; from++) {
      const state = alloc(3)
      state.re[0] = 0
      state.re[from] = 1
      applyControlled(state, x, 2, [positive(0), positive(1)])
      const expected = (from & 3) === 3 ? from ^ 4 : from
      expect(state.re[expected], `|${from}⟩`).toBe(1)
    }
  })

  it('mixes positive and negative controls', () => {
    // Fires only when qubit 0 reads 1 and qubit 1 reads 0: indices 1 and 5.
    for (let from = 0; from < 8; from++) {
      const state = alloc(3)
      state.re[0] = 0
      state.re[from] = 1
      applyControlled(state, x, 2, [positive(0), negative(1)])
      const fires = (from & 1) === 1 && (from & 2) === 0
      expect(state.re[fires ? from ^ 4 : from], `|${from}⟩`).toBe(1)
    }
  })

  it('leaves the skipped amplitudes bit-for-bit untouched', () => {
    const before = pseudoState(4, 7)
    const after = clone(before)
    applyControlled(after, rzMatrix(0.77), 3, [positive(0), negative(1)])
    for (let i = 0; i < before.size; i++) {
      if ((i & 1) === 1 && (i & 2) === 0) continue
      expect(after.re[i], `re[${i}]`).toBe(before.re[i])
      expect(after.im[i], `im[${i}]`).toBe(before.im[i])
    }
  })

  it('with no controls is exactly apply1q', () => {
    // The two share a derivation but not a loop; this is what stops the
    // unrolled hot path from drifting away from the controlled one.
    const controlled = pseudoState(4, 3)
    const plain = clone(controlled)
    applyControlled(controlled, uMatrix(0.6, 1.2, -0.4), 2, [])
    apply1q(plain, uMatrix(0.6, 1.2, -0.4), 2)
    expectSameState(controlled, plain)
  })
})

describe('apply2q', () => {
  it('agrees with two one-qubit gates when the 4×4 is their product', () => {
    // The first argument is the less significant qubit, so the matrix is
    // kron(gate on q1, gate on q0).
    for (const [q0, q1] of [
      [0, 1],
      [1, 0],
      [0, 2],
      [2, 0],
      [1, 2],
    ]) {
      const grouped = pseudoState(3, 21)
      const separate = clone(grouped)
      const low = uMatrix(0.3, 0.9, -1.1)
      const high = uMatrix(-0.8, 0.2, 0.5)

      apply2q(grouped, kron(high, low), q0, q1)
      apply1q(separate, low, q0)
      apply1q(separate, high, q1)

      expectSameState(grouped, separate)
    }
  })

  it('agrees with applyControlled when the 4×4 is a CNOT', () => {
    // Control q0, target q1: |01⟩ ↔ |11⟩, i.e. rows 1 and 3 exchanged.
    const cnot = new Float64Array(32)
    cnot[(0 * 4 + 0) * 2] = 1
    cnot[(1 * 4 + 3) * 2] = 1
    cnot[(2 * 4 + 2) * 2] = 1
    cnot[(3 * 4 + 1) * 2] = 1

    const general = pseudoState(3, 5)
    const specialised = clone(general)
    apply2q(general, cnot, 0, 1)
    applyControlled(specialised, x, 1, [positive(0)])
    expectSameState(general, specialised)
  })
})

describe('SWAP and iSWAP', () => {
  it('matches the general 4×4 path, adjacent or not', () => {
    for (const [q0, q1] of [
      [0, 1],
      [0, 3],
      [2, 1],
      [3, 0],
    ]) {
      const specialised = pseudoState(4, 13)
      const general = clone(specialised)
      applySwap(specialised, q0, q1)
      apply2q(general, SWAP_MATRIX, q0, q1)
      expectSameState(specialised, general)

      const iSpecialised = pseudoState(4, 13)
      const iGeneral = clone(iSpecialised)
      applyISwap(iSpecialised, q0, q1)
      apply2q(iGeneral, ISWAP_MATRIX, q0, q1)
      expectSameState(iSpecialised, iGeneral)
    }
  })

  it('exchanges the two qubits and nothing else', () => {
    // |001⟩ (index 1) with qubits 0 and 2 swapped is |100⟩ (index 4).
    const state = alloc(3)
    apply1q(state, x, 0)
    applySwap(state, 0, 2)
    expect([...state.re]).toEqual([0, 0, 0, 0, 1, 0, 0, 0])
  })

  it('is its own inverse', () => {
    const state = pseudoState(3, 29)
    const before = clone(state)
    applySwap(state, 0, 2)
    applySwap(state, 0, 2)
    expectSameState(state, before)
  })

  it('gives iSWAP its factor of i', () => {
    // |01⟩ → i|10⟩: amplitude 1 leaves index 1 and arrives at index 2 as i.
    // The real parts are compared loosely because negating a zero gives -0,
    // which is a perfectly good zero everywhere except in `Object.is`.
    const state = alloc(2)
    apply1q(state, x, 0)
    applyISwap(state, 0, 1)
    expect(state.re[2]).toBeCloseTo(0, DIGITS)
    expect(state.im[2]).toBe(1)
    expect(state.re[1]).toBeCloseTo(0, DIGITS)
    expect(state.im[1]).toBeCloseTo(0, DIGITS)
  })

  it('runs a controlled SWAP only where the control is satisfied', () => {
    // CSWAP with control 0, targets 1 and 2: |011⟩ (3) ↔ |101⟩ (5), while
    // the even indices (control reads 0) stay put.
    for (let from = 0; from < 8; from++) {
      const state = alloc(3)
      state.re[0] = 0
      state.re[from] = 1
      applySwap(state, 1, 2, [positive(0)])
      const fires = (from & 1) === 1
      const differ = ((from & 2) !== 0) !== ((from & 4) !== 0)
      const swapped = differ ? from ^ 6 : from
      expect(state.re[fires ? swapped : from], `|${from}⟩`).toBe(1)
    }
  })
})

describe('argument checking', () => {
  it('rejects qubits outside the register', () => {
    const state = alloc(2)
    expect(() => apply1q(state, x, 2)).toThrow(RangeError)
    expect(() => apply1q(state, x, -1)).toThrow(RangeError)
    expect(() => applySwap(state, 0, 9)).toThrow(RangeError)
    expect(() => applyISwap(state, 0, 9)).toThrow(RangeError)
  })

  it('rejects a two-qubit gate on one qubit', () => {
    const state = alloc(2)
    expect(() => apply2q(state, SWAP_MATRIX, 1, 1)).toThrow(RangeError)
    expect(() => applySwap(state, 1, 1)).toThrow(RangeError)
    expect(() => applyISwap(state, 1, 1)).toThrow(RangeError)
  })

  it('rejects a matrix of the wrong size', () => {
    const state = alloc(2)
    expect(() => apply1q(state, SWAP_MATRIX, 0)).toThrow(RangeError)
    expect(() => apply2q(state, x, 0, 1)).toThrow(RangeError)
  })

  it('rejects a control that is also a target', () => {
    const state = alloc(3)
    expect(() => applyControlled(state, x, 1, [positive(1)])).toThrow(
      RangeError
    )
    expect(() => applySwap(state, 0, 1, [positive(1)])).toThrow(RangeError)
  })

  it('rejects the same qubit controlled twice', () => {
    const state = alloc(3)
    expect(() =>
      applyControlled(state, z, 2, [positive(0), negative(0)])
    ).toThrow(RangeError)
  })
})

/** Squared norm, kept local so the kernel tests do not lean on `norm()`. */
function norm2(state: Statevector): number {
  let sum = 0
  for (let i = 0; i < state.size; i++) {
    sum += state.re[i] * state.re[i] + state.im[i] * state.im[i]
  }
  return sum
}
