import { describe, expect, it } from 'vitest'

import { GATE_MATRICES } from './gates.js'
import { MidCircuitMeasurementError } from './measure.js'
import { run, runFromState, type CircuitLike } from './runner.js'
import { alloc } from './statevector.js'
import {
  MAX_UNITARY_QUBITS,
  UnitaryTooLargeError,
  allocUnitary,
  circuitUnitary,
  transitionProbability,
  unitaryFidelity,
  type Unitary,
} from './unitary.js'

/** D6's tolerance. */
const TOLERANCE = 1e-10

function circuit(
  qubits: number,
  operations: CircuitLike['operations']
): CircuitLike {
  return { qubits, operations }
}

/** A one-qubit circuit holding a single named gate. */
function single(gate: string): CircuitLike {
  return circuit(1, [{ id: 'op1', gate, targets: [0], column: 0 }])
}

/** The same matrix with every entry multiplied by e^{iφ}. */
function phased(matrix: Unitary, phi: number): Unitary {
  const cos = Math.cos(phi)
  const sin = Math.sin(phi)
  const out = allocUnitary(matrix.qubits)
  for (let i = 0; i < matrix.re.length; i++) {
    const r = matrix.re[i]
    const m = matrix.im[i]
    out.re[i] = r * cos - m * sin
    out.im[i] = r * sin + m * cos
  }
  return out
}

describe('circuitUnitary', () => {
  it('reproduces the gate matrix of a one-gate circuit', () => {
    const h = circuitUnitary(single('h'))
    // GATE_MATRICES are row-major [a,b,c,d] for [[a,b],[c,d]]; the unitary is
    // column-major, so entry (row, col) is at col * 2 + row.
    const expected = GATE_MATRICES.h
    for (let row = 0; row < 2; row++) {
      for (let col = 0; col < 2; col++) {
        const flat = (row * 2 + col) * 2
        expect(h.re[col * 2 + row]).toBeCloseTo(expected[flat], 12)
        expect(h.im[col * 2 + row]).toBeCloseTo(expected[flat + 1], 12)
      }
    }
  })

  it('puts CNOT in the little-endian place D1 fixes (control q0)', () => {
    const cx = circuitUnitary(
      circuit(2, [
        { id: 'op1', gate: 'cx', targets: [1], controls: [0], column: 0 },
      ])
    )
    // |01⟩ is index 1 (q0 set, D1) and must go to |11⟩, index 3.
    expect(transitionProbability(cx, 1, 3)).toBeCloseTo(1, 12)
    expect(transitionProbability(cx, 0, 0)).toBeCloseTo(1, 12)
    expect(transitionProbability(cx, 2, 2)).toBeCloseTo(1, 12)
    expect(transitionProbability(cx, 3, 1)).toBeCloseTo(1, 12)
  })

  it('agrees with run() on the ground-state column', () => {
    const bell = circuit(2, [
      { id: 'op1', gate: 'h', targets: [0], column: 0 },
      { id: 'op2', gate: 'cx', targets: [1], controls: [0], column: 1 },
    ])
    const matrix = circuitUnitary(bell)
    const result = run(bell)
    if (result.mode !== 'analytic') throw new Error('expected analytic')
    for (let row = 0; row < 4; row++) {
      expect(matrix.re[row]).toBeCloseTo(result.state.re[row], 12)
      expect(matrix.im[row]).toBeCloseTo(result.state.im[row], 12)
    }
  })

  it('refuses a register wider than the ceiling instead of allocating it', () => {
    expect(() => allocUnitary(MAX_UNITARY_QUBITS + 1)).toThrow(
      UnitaryTooLargeError
    )
  })

  it('refuses a circuit that measures, because that is not an operation', () => {
    expect(() =>
      circuitUnitary(
        circuit(1, [
          {
            id: 'op1',
            gate: 'measure',
            targets: [0],
            clbitTargets: [0],
            column: 0,
          },
        ])
      )
    ).toThrow(MidCircuitMeasurementError)
  })
})

describe('unitaryFidelity', () => {
  it('is 1 for a matrix against itself', () => {
    const h = circuitUnitary(single('h'))
    expect(unitaryFidelity(h, h)).toBeCloseTo(1, 12)
  })

  /*
   * THE TRAP THIS FILE EXISTS FOR. Two operations differing by an overall
   * factor of modulus one are the same operation, and a challenge validator
   * that failed them would be wrong.
   */
  it('is 1 up to global phase, at every angle', () => {
    const cx = circuitUnitary(
      circuit(2, [
        { id: 'op1', gate: 'cx', targets: [1], controls: [0], column: 0 },
      ])
    )
    for (const phi of [0.1, Math.PI / 4, Math.PI / 2, Math.PI, 2.7183]) {
      expect(unitaryFidelity(cx, phased(cx, phi))).toBeCloseTo(1, 12)
    }
  })

  /*
   * The concrete case a learner will hit: `s·s·s` and `sdg` are the same gate
   * up to a factor of -i. A validator comparing entries would reject the
   * three-gate spelling of the right answer.
   */
  it('accepts s·s·s as sdg, which differ by exactly -i', () => {
    const sdg = circuitUnitary(single('sdg'))
    const sss = circuitUnitary(
      circuit(1, [
        { id: 'op1', gate: 's', targets: [0], column: 0 },
        { id: 'op2', gate: 's', targets: [0], column: 1 },
        { id: 'op3', gate: 's', targets: [0], column: 2 },
      ])
    )
    expect(unitaryFidelity(sdg, sss)).toBeCloseTo(1, 12)
  })

  it('is 0 for X against Y, which differ by more than a phase', () => {
    expect(
      unitaryFidelity(circuitUnitary(single('x')), circuitUnitary(single('y')))
    ).toBeCloseTo(0, 12)
  })

  it('separates two circuits that agree on |0…0⟩ and nowhere else', () => {
    // Both leave |00⟩ exactly where it was; only one of them does anything at
    // all. This is the case a state target cannot see and a unitary one can.
    const plain = circuit(2, [
      { id: 'op1', gate: 'i', targets: [0], column: 0 },
    ])
    const entangling = circuit(2, [
      { id: 'op1', gate: 'cx', targets: [1], controls: [0], column: 0 },
    ])
    const a = run(plain)
    const b = run(entangling)
    if (a.mode !== 'analytic' || b.mode !== 'analytic') {
      throw new Error('expected analytic')
    }
    // Identical final states…
    for (let i = 0; i < 4; i++) {
      expect(a.state.re[i]).toBeCloseTo(b.state.re[i], 12)
    }
    // …and different operations, which is the whole reason a unitary target
    // exists beside a state one.
    expect(
      unitaryFidelity(circuitUnitary(plain), circuitUnitary(entangling))
    ).toBeLessThan(0.99)
  })

  it('refuses two matrices of different widths', () => {
    expect(() => unitaryFidelity(allocUnitary(1), allocUnitary(2))).toThrow(
      RangeError
    )
  })
})

describe('runFromState', () => {
  it('evolves the state it is given rather than the ground state', () => {
    const state = alloc(1)
    state.re[0] = 0
    state.re[1] = 1
    const { state: out } = runFromState(single('x'), state)
    expect(out.re[0]).toBeCloseTo(1, 12)
    expect(out.re[1]).toBeCloseTo(0, 12)
  })

  it('preserves the norm', () => {
    const state = alloc(2)
    state.re[0] = Math.SQRT1_2
    state.re[3] = Math.SQRT1_2
    const { state: out } = runFromState(
      circuit(2, [
        { id: 'op1', gate: 'h', targets: [0], column: 0 },
        { id: 'op2', gate: 't', targets: [1], column: 1 },
      ]),
      state
    )
    let norm = 0
    for (let i = 0; i < out.size; i++) {
      norm += out.re[i] ** 2 + out.im[i] ** 2
    }
    expect(norm).toBeCloseTo(1, 10)
  })

  it('refuses a state of the wrong width', () => {
    expect(() => runFromState(single('x'), alloc(2))).toThrow(
      /cannot run a circuit/
    )
  })

  it('leaves the fidelity of an identity circuit at 1 within D6 tolerance', () => {
    const identity = circuit(1, [
      { id: 'op1', gate: 'h', targets: [0], column: 0 },
      { id: 'op2', gate: 'h', targets: [0], column: 1 },
    ])
    const i = circuitUnitary(single('i'))
    expect(
      Math.abs(1 - unitaryFidelity(i, circuitUnitary(identity)))
    ).toBeLessThan(TOLERANCE)
  })
})
