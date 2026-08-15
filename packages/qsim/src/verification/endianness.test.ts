/**
 * INDEPENDENT ADVERSARIAL VERIFICATION — ENDIANNESS LENS.
 *
 * Nothing here is derived from the engine's own tests. Every expectation is
 * either a hand-computed basis-state mapping or the output of a deliberately
 * slow reference written in this file: a dense 2ⁿ × 2ⁿ matrix built entry by
 * entry from decision D1 ("qubit q is bit q of the index") and multiplied into
 * the vector by textbook matrix-vector arithmetic. That reference is the
 * O(4ⁿ) construction §5.2 forbids in production — which is exactly what makes
 * it a useful oracle: it shares no code, no loop and no index arithmetic with
 * the kernel it checks.
 *
 * The four things this file is looking for:
 *   1. a ket label that reads back to front from the amplitude index;
 *   2. a two-qubit gate whose (q0, q1) arguments are wired to the wrong bit
 *      significance — invisible for SWAP and CZ, fatal for CNOT and CRZ;
 *   3. a controlled gate that misbehaves when control and target are not
 *      adjacent, or when the control sits below rather than above the target;
 *   4. disagreement between formatKet, the shot-count keys and the classical
 *      register labels — §16's "source number one".
 */

import { describe, expect, it } from 'vitest'

import {
  apply1q,
  apply2q,
  applyControlled,
  applyISwap,
  applySwap,
  type ControlSpec,
} from '../apply.js'
import { bitOf, formatKet } from '../conventions.js'
import {
  GATE_MATRICES,
  ISWAP_MATRIX,
  SWAP_MATRIX,
  rzMatrix,
  uMatrix,
  type Matrix2,
  type Matrix4,
} from '../gates.js'
import {
  collapse,
  marginalProbability,
  orderedCounts,
  probabilities,
  sampleShots,
  trajectoriesMode,
} from '../measure.js'
import { createRng, type Rng } from '../rng.js'
import {
  formatRegister,
  run,
  runTrajectory,
  type CircuitLike,
} from '../runner.js'
import { alloc, type Statevector } from '../statevector.js'

/* ───────────────────────── the slow reference ───────────────────────── */

interface Cx {
  readonly re: number
  readonly im: number
}

const ZERO: Cx = { re: 0, im: 0 }
const ONE: Cx = { re: 1, im: 0 }

/**
 * D1, spelled out here rather than imported: if `bitOf` were wrong this file
 * would inherit the error and prove nothing. `conventions.ts` is checked
 * against this literal form separately below.
 */
function bit(index: number, qubit: number): number {
  return (index >>> qubit) & 1
}

/** Entry (row, column) of a 2×2 in the layout documented in `gates.ts`. */
function m2(matrix: Matrix2, row: number, column: number): Cx {
  const at = (row * 2 + column) * 2
  return { re: matrix[at], im: matrix[at + 1] }
}

/** Entry (row, column) of a 4×4 in the same layout. */
function m4(matrix: Matrix4, row: number, column: number): Cx {
  const at = (row * 4 + column) * 2
  return { re: matrix[at], im: matrix[at + 1] }
}

function times(a: Cx, b: Cx): Cx {
  return { re: a.re * b.re - a.im * b.im, im: a.re * b.im + a.im * b.re }
}

/** Identity entry, so the Kronecker product below reads uniformly. */
function eye(row: number, column: number): Cx {
  return row === column ? ONE : ZERO
}

/**
 * Entry of `I ⊗ … ⊗ M ⊗ … ⊗ I` written the only way that cannot get the
 * ordering wrong: as the literal product over qubits of each factor's entry,
 * with qubit q reading bit q of the row and column indices.
 */
function oneQubitEntry(
  matrix: Matrix2,
  target: number,
  qubits: number,
  row: number,
  column: number
): Cx {
  let product = ONE
  for (let q = 0; q < qubits; q++) {
    const factor =
      q === target
        ? m2(matrix, bit(row, q), bit(column, q))
        : eye(bit(row, q), bit(column, q))
    product = times(product, factor)
  }
  return product
}

/**
 * Entry of a controlled one-qubit gate. A control is a condition on the basis
 * state, so the row either gets the gate's 2×2 or a row of the identity.
 */
function controlledEntry(
  matrix: Matrix2,
  target: number,
  controls: readonly ControlSpec[],
  qubits: number,
  row: number,
  column: number
): Cx {
  const fires = controls.every(
    (control) => bit(row, control.qubit) === control.state
  )
  if (!fires) return eye(row, column)
  return oneQubitEntry(matrix, target, qubits, row, column)
}

/**
 * Entry of a two-qubit gate under the frozen basis order of `apply.ts`: the
 * 4×4 row index is `2·b₁ + b₀`, where b₀ is the bit of the FIRST argument.
 * Every other qubit is a spectator, so the entry is zero unless row and column
 * agree everywhere else.
 */
function twoQubitEntry(
  matrix: Matrix4,
  q0: number,
  q1: number,
  row: number,
  column: number
): Cx {
  const spectators = ~((1 << q0) | (1 << q1))
  if ((row & spectators) !== (column & spectators)) return ZERO
  const r = 2 * bit(row, q1) + bit(row, q0)
  const c = 2 * bit(column, q1) + bit(column, q0)
  return m4(matrix, r, c)
}

/** Multiply a dense 2ⁿ × 2ⁿ operator into a vector, O(4ⁿ) and proud of it. */
function denseApply(
  vector: readonly Cx[],
  entry: (row: number, column: number) => Cx
): Cx[] {
  const size = vector.length
  const out: Cx[] = []
  for (let row = 0; row < size; row++) {
    let re = 0
    let im = 0
    for (let column = 0; column < size; column++) {
      const product = times(entry(row, column), vector[column])
      re += product.re
      im += product.im
    }
    out.push({ re, im })
  }
  return out
}

/* ───────────────────────────── test fixtures ─────────────────────────── */

/** A reproducible stream that owes nothing to `rng.ts`. */
function scrambler(seed: number): () => number {
  let value = seed >>> 0
  return (): number => {
    value = (Math.imul(value, 1664525) + 1013904223) >>> 0
    return value / 4294967296
  }
}

function randomState(qubits: number, seed: number): Statevector {
  const state = alloc(qubits)
  const draw = scrambler(seed)
  let sum = 0
  for (let i = 0; i < state.size; i++) {
    const re = draw() - 0.5
    const im = draw() - 0.5
    state.re[i] = re
    state.im[i] = im
    sum += re * re + im * im
  }
  const scale = 1 / Math.sqrt(sum)
  for (let i = 0; i < state.size; i++) {
    state.re[i] *= scale
    state.im[i] *= scale
  }
  return state
}

function randomMatrix4(seed: number): Matrix4 {
  const draw = scrambler(seed)
  const matrix = new Float64Array(32)
  for (let i = 0; i < 32; i++) matrix[i] = draw() - 0.5
  return matrix
}

function basisState(qubits: number, index: number): Statevector {
  const state = alloc(qubits)
  state.re[0] = 0
  state.re[index] = 1
  return state
}

function toVector(state: Statevector): Cx[] {
  const out: Cx[] = []
  for (let i = 0; i < state.size; i++) {
    out.push({ re: state.re[i], im: state.im[i] })
  }
  return out
}

/** D6 fixes the tolerance at 1e-10; the reference is exact, so this is slack. */
function expectVector(
  state: Statevector,
  expected: readonly Cx[],
  label: string
): void {
  for (let i = 0; i < expected.length; i++) {
    expect(state.re[i], `${label} re[${i}]`).toBeCloseTo(expected[i].re, 10)
    expect(state.im[i], `${label} im[${i}]`).toBeCloseTo(expected[i].im, 10)
  }
}

function scriptedRng(values: readonly number[]): Rng {
  let at = 0
  return {
    next(): number {
      const value = values[at % values.length]
      at++
      return value
    },
  }
}

function analyticState(circuit: CircuitLike): Statevector {
  const result = run(circuit)
  if (result.mode !== 'analytic') throw new Error('expected an analytic run')
  return result.state
}

function trajectoryCounts(
  circuit: CircuitLike,
  shots: number,
  seed: number
): Readonly<Record<string, number>> {
  const result = run(circuit, trajectoriesMode(shots, createRng(seed)))
  if (result.mode !== 'trajectories') throw new Error('expected trajectories')
  return result.counts
}

/* ───────────────────────────── 1. the labels ─────────────────────────── */

describe('ket labels agree with the amplitude index', () => {
  it('is plain binary, zero-padded, most significant qubit first', () => {
    // Independent formula: under D1 the index IS the binary word of the qubit
    // values, so printing highest qubit first is just toString(2).
    for (let qubits = 1; qubits <= 6; qubits++) {
      for (let index = 0; index < 1 << qubits; index++) {
        expect(
          formatKet(index, qubits),
          `index ${index}, ${qubits} qubits`
        ).toBe(index.toString(2).padStart(qubits, '0'))
      }
    }
  })

  it('puts qubit q at string position (n - 1 - q)', () => {
    const qubits = 5
    for (let index = 0; index < 1 << qubits; index++) {
      const ket = formatKet(index, qubits)
      for (let q = 0; q < qubits; q++) {
        expect(ket[qubits - 1 - q], `index ${index}, qubit ${q}`).toBe(
          String(bit(index, q))
        )
        expect(bitOf(index, q)).toBe(bit(index, q))
      }
    }
  })

  it('worked example from conventions.ts: index 5 of 3 qubits is |101>', () => {
    expect(formatKet(5, 3)).toBe('101')
    expect(bit(5, 0)).toBe(1)
    expect(bit(5, 1)).toBe(0)
    expect(bit(5, 2)).toBe(1)
  })
})

/* ─────────────────────── 2. one-qubit gate placement ─────────────────── */

describe('one-qubit gates land on the qubit named, at the right bit', () => {
  it('X on qubit q flips exactly bit q of the index', () => {
    const qubits = 4
    for (let target = 0; target < qubits; target++) {
      for (let index = 0; index < 1 << qubits; index++) {
        const state = basisState(qubits, index)
        apply1q(state, GATE_MATRICES.x, target)
        const expected = index ^ (1 << target)
        for (let i = 0; i < state.size; i++) {
          expect(
            state.re[i],
            `X on q${target} from ${formatKet(index, qubits)}, re[${i}]`
          ).toBeCloseTo(i === expected ? 1 : 0, 12)
          expect(state.im[i]).toBeCloseTo(0, 12)
        }
      }
    }
  })

  it('X on qubit 0 of three qubits sends |000> to index 1 (ket 001)', () => {
    const state = alloc(3)
    apply1q(state, GATE_MATRICES.x, 0)
    expect(state.re[1]).toBeCloseTo(1, 12)
    expect(formatKet(1, 3)).toBe('001')
  })

  it('X on qubit 2 of three qubits sends |000> to index 4 (ket 100)', () => {
    const state = alloc(3)
    apply1q(state, GATE_MATRICES.x, 2)
    expect(state.re[4]).toBeCloseTo(1, 12)
    expect(formatKet(4, 3)).toBe('100')
  })

  it('Z phases only the indices whose target bit is set', () => {
    const qubits = 4
    for (let target = 0; target < qubits; target++) {
      const state = randomState(qubits, 11 + target)
      const before = toVector(state)
      apply1q(state, GATE_MATRICES.z, target)
      for (let i = 0; i < state.size; i++) {
        const sign = bit(i, target) === 1 ? -1 : 1
        expect(state.re[i], `Z q${target} index ${i}`).toBeCloseTo(
          sign * before[i].re,
          12
        )
        expect(state.im[i]).toBeCloseTo(sign * before[i].im, 12)
      }
    }
  })

  it('matches the dense tensor-product reference for every gate and target', () => {
    const qubits = 3
    const catalog: [string, Matrix2][] = [
      ...Object.entries(GATE_MATRICES),
      ['u(0.7,0.3,1.1)', uMatrix(0.7, 0.3, 1.1)],
      ['rz(0.9)', rzMatrix(0.9)],
    ]
    for (const [name, matrix] of catalog) {
      for (let target = 0; target < qubits; target++) {
        const state = randomState(qubits, 101 + target)
        const expected = denseApply(toVector(state), (row, column) =>
          oneQubitEntry(matrix, target, qubits, row, column)
        )
        apply1q(state, matrix, target)
        expectVector(state, expected, `${name} on q${target}`)
      }
    }
  })
})

/* ────────────────────── 3. controls, adjacent or not ─────────────────── */

describe('controlled gates read the control bit they were given', () => {
  it('CNOT flips the target only where the control bit is 1', () => {
    const qubits = 5
    const cases: [number, number][] = [
      [0, 4],
      [4, 0],
      [1, 3],
      [3, 1],
      [0, 1],
      [2, 3],
    ]
    for (const [control, target] of cases) {
      for (let index = 0; index < 1 << qubits; index++) {
        const state = basisState(qubits, index)
        applyControlled(state, GATE_MATRICES.x, target, [
          { qubit: control, state: 1 },
        ])
        const expected =
          bit(index, control) === 1 ? index ^ (1 << target) : index
        expect(
          state.re[expected],
          `cx c${control} t${target} from ${formatKet(index, qubits)}`
        ).toBeCloseTo(1, 12)
      }
    }
  })

  it('matches the dense reference for every control/target pair and polarity', () => {
    const qubits = 4
    const matrix = uMatrix(1.3, 0.4, 2.2)
    for (let target = 0; target < qubits; target++) {
      for (let control = 0; control < qubits; control++) {
        if (control === target) continue
        for (const polarity of [0, 1] as const) {
          const controls: ControlSpec[] = [{ qubit: control, state: polarity }]
          const state = randomState(qubits, 7 + target * 4 + control)
          const expected = denseApply(toVector(state), (row, column) =>
            controlledEntry(matrix, target, controls, qubits, row, column)
          )
          applyControlled(state, matrix, target, controls)
          expectVector(state, expected, `c${control}=${polarity} t${target}`)
        }
      }
    }
  })

  it('matches the dense reference for two controls straddling the target', () => {
    const qubits = 5
    const matrix = GATE_MATRICES.x
    const cases: ControlSpec[][] = [
      [
        { qubit: 0, state: 1 },
        { qubit: 4, state: 1 },
      ],
      [
        { qubit: 4, state: 1 },
        { qubit: 0, state: 1 },
      ],
      [
        { qubit: 0, state: 0 },
        { qubit: 4, state: 1 },
      ],
      [
        { qubit: 3, state: 0 },
        { qubit: 1, state: 0 },
      ],
    ]
    for (const controls of cases) {
      const target = 2
      const state = randomState(qubits, 313)
      const expected = denseApply(toVector(state), (row, column) =>
        controlledEntry(matrix, target, controls, qubits, row, column)
      )
      applyControlled(state, matrix, target, controls)
      const label = controls.map((c) => `q${c.qubit}=${c.state}`).join(',')
      expectVector(state, expected, `ccx [${label}] t${target}`)
    }
  })

  it('CRZ is not symmetric under exchanging control and target', () => {
    // Derived by hand: |q1 q0> = |01>, i.e. index 1. With control q0 (=1) the
    // gate fires on q1, which reads 0, so the amplitude picks up rz[0][0] =
    // e^{-i0.8/2}. With control q1 (=0) the gate never fires.
    const theta = 0.8
    const matrix = rzMatrix(theta)

    const fired = basisState(2, 1)
    applyControlled(fired, matrix, 1, [{ qubit: 0, state: 1 }])
    expect(fired.re[1]).toBeCloseTo(Math.cos(theta / 2), 12)
    expect(fired.im[1]).toBeCloseTo(-Math.sin(theta / 2), 12)

    const idle = basisState(2, 1)
    applyControlled(idle, matrix, 0, [{ qubit: 1, state: 1 }])
    expect(idle.re[1]).toBeCloseTo(1, 12)
    expect(idle.im[1]).toBeCloseTo(0, 12)
  })
})

/* ────────────────────── 4. two-qubit argument order ──────────────────── */

describe('two-qubit gates map (q0, q1) onto the documented bit order', () => {
  it('on qubits (0,1) of a two-qubit register it is a plain matrix product', () => {
    // With q0 = 0 and q1 = 1 the group index 2·b1 + b0 IS the statevector
    // index, so apply2q must reduce to the textbook 4-vector product.
    const matrix = randomMatrix4(5)
    const state = randomState(2, 42)
    const expected = denseApply(toVector(state), (row, column) =>
      m4(matrix, row, column)
    )
    apply2q(state, matrix, 0, 1)
    expectVector(state, expected, 'apply2q(0,1)')
  })

  it('matches the dense reference for every ordered pair of qubits', () => {
    const qubits = 4
    const matrix = randomMatrix4(9)
    for (let q0 = 0; q0 < qubits; q0++) {
      for (let q1 = 0; q1 < qubits; q1++) {
        if (q0 === q1) continue
        const state = randomState(qubits, 500 + q0 * 4 + q1)
        const expected = denseApply(toVector(state), (row, column) =>
          twoQubitEntry(matrix, q0, q1, row, column)
        )
        apply2q(state, matrix, q0, q1)
        expectVector(state, expected, `apply2q(q${q0}, q${q1})`)
      }
    }
  })

  it('a CNOT written as a 4x4 agrees with applyControlled', () => {
    // Control on the FIRST argument, so in the basis 2·b1 + b0 the gate must
    // exchange rows 1 (b0=1, b1=0) and 3 (b0=1, b1=1).
    const cnot = new Float64Array(32)
    const set = (row: number, column: number): void => {
      cnot[(row * 4 + column) * 2] = 1
    }
    set(0, 0)
    set(1, 3)
    set(2, 2)
    set(3, 1)

    const qubits = 4
    for (const [control, target] of [
      [0, 3],
      [3, 0],
      [1, 2],
      [2, 1],
    ] as const) {
      const viaMatrix = randomState(qubits, 77)
      apply2q(viaMatrix, cnot, control, target)
      const viaControls = randomState(qubits, 77)
      applyControlled(viaControls, GATE_MATRICES.x, target, [
        { qubit: control, state: 1 },
      ])
      expectVector(
        viaMatrix,
        toVector(viaControls),
        `cnot 4x4 vs controlled, c${control} t${target}`
      )
    }
  })

  it('swapping the arguments conjugates the 4x4 by SWAP', () => {
    // M acting on (q0,q1) equals SWAP·M·SWAP acting on (q1,q0): the relabelling
    // exchanges rows/columns 1 and 2 of the 4x4 and nothing else.
    const matrix = randomMatrix4(13)
    const conjugated = new Float64Array(32)
    const permute = (k: number): number => (k === 1 ? 2 : k === 2 ? 1 : k)
    for (let row = 0; row < 4; row++) {
      for (let column = 0; column < 4; column++) {
        const source = (permute(row) * 4 + permute(column)) * 2
        const destination = (row * 4 + column) * 2
        conjugated[destination] = matrix[source]
        conjugated[destination + 1] = matrix[source + 1]
      }
    }

    const direct = randomState(4, 1234)
    apply2q(direct, matrix, 1, 3)
    const flipped = randomState(4, 1234)
    apply2q(flipped, conjugated, 3, 1)
    expectVector(direct, toVector(flipped), 'apply2q argument exchange')
  })
})

/* ───────────────────────── 5. SWAP and iSWAP ─────────────────────────── */

describe('SWAP and iSWAP move the bits they name', () => {
  it('SWAP exchanges bits q0 and q1 of every index', () => {
    const qubits = 5
    for (const [q0, q1] of [
      [0, 4],
      [4, 0],
      [1, 3],
      [0, 1],
      [2, 4],
    ] as const) {
      for (let index = 0; index < 1 << qubits; index++) {
        const state = basisState(qubits, index)
        applySwap(state, q0, q1)
        const b0 = bit(index, q0)
        const b1 = bit(index, q1)
        let expected = index & ~((1 << q0) | (1 << q1))
        if (b1 === 1) expected |= 1 << q0
        if (b0 === 1) expected |= 1 << q1
        expect(
          state.re[expected],
          `swap(${q0},${q1}) from ${formatKet(index, qubits)}`
        ).toBeCloseTo(1, 12)
      }
    }
  })

  it('applySwap equals apply2q with SWAP_MATRIX, both argument orders', () => {
    const qubits = 4
    for (const [q0, q1] of [
      [0, 3],
      [3, 0],
      [1, 2],
    ] as const) {
      const fast = randomState(qubits, 2024)
      applySwap(fast, q0, q1)
      const slow = randomState(qubits, 2024)
      const expected = denseApply(toVector(slow), (row, column) =>
        twoQubitEntry(SWAP_MATRIX, q0, q1, row, column)
      )
      expectVector(fast, expected, `swap(${q0},${q1})`)
    }
  })

  it('controlled SWAP touches only the indices where the control fires', () => {
    const qubits = 5
    const controls: ControlSpec[] = [{ qubit: 4, state: 1 }]
    for (let index = 0; index < 1 << qubits; index++) {
      const state = basisState(qubits, index)
      applySwap(state, 0, 2, controls)
      let expected = index
      if (bit(index, 4) === 1) {
        const b0 = bit(index, 0)
        const b2 = bit(index, 2)
        expected = index & ~0b101
        if (b2 === 1) expected |= 1
        if (b0 === 1) expected |= 4
      }
      expect(
        state.re[expected],
        `cswap c4 (0,2) from ${formatKet(index, qubits)}`
      ).toBeCloseTo(1, 12)
    }
  })

  it('iSWAP sends |q0=1> to i|q1=1> and is symmetric in its arguments', () => {
    const qubits = 4
    // Hand-derived: iSWAP|01> = i|10>, where the "1" on the right is the first
    // argument. Calling it on (q0 = 1, q1 = 3), the state with only qubit 1 set
    // is index 2 and it must move, times i, to the state with only qubit 3 set,
    // index 8.
    const state = basisState(qubits, 1 << 1)
    applyISwap(state, 1, 3)
    expect(state.re[1 << 3]).toBeCloseTo(0, 12)
    expect(state.im[1 << 3]).toBeCloseTo(1, 12)
    expect(state.re[1 << 1]).toBeCloseTo(0, 12)
    expect(state.im[1 << 1]).toBeCloseTo(0, 12)

    const forward = randomState(qubits, 606)
    applyISwap(forward, 1, 3)
    const backward = randomState(qubits, 606)
    applyISwap(backward, 3, 1)
    expectVector(forward, toVector(backward), 'iswap argument symmetry')
  })

  it('applyISwap equals apply2q with ISWAP_MATRIX', () => {
    const qubits = 4
    for (const [q0, q1] of [
      [0, 3],
      [2, 1],
    ] as const) {
      const fast = randomState(qubits, 808)
      applyISwap(fast, q0, q1)
      const slow = randomState(qubits, 808)
      const expected = denseApply(toVector(slow), (row, column) =>
        twoQubitEntry(ISWAP_MATRIX, q0, q1, row, column)
      )
      expectVector(fast, expected, `iswap(${q0},${q1})`)
    }
  })
})

/* ──────────────────── 6. measurement reads the same bit ──────────────── */

describe('measurement indexes qubits the same way the kernel does', () => {
  it('marginalProbability sums |a|^2 over the indices whose bit q is set', () => {
    const qubits = 4
    const state = randomState(qubits, 3141)
    const p = probabilities(state)
    for (let q = 0; q < qubits; q++) {
      let expected = 0
      for (let i = 0; i < state.size; i++) {
        if (bit(i, q) === 1) expected += p[i]
      }
      expect(marginalProbability(state, q), `marginal q${q}`).toBeCloseTo(
        expected,
        12
      )
    }
  })

  it('collapse keeps exactly the indices agreeing with the outcome', () => {
    const qubits = 4
    for (let q = 0; q < qubits; q++) {
      for (const outcome of [0, 1] as const) {
        const state = randomState(qubits, 271 + q)
        const before = toVector(state)
        collapse(state, q, outcome)

        let kept = 0
        for (let i = 0; i < before.length; i++) {
          if (bit(i, q) === outcome) {
            kept += before[i].re * before[i].re + before[i].im * before[i].im
          }
        }
        const scale = 1 / Math.sqrt(kept)
        for (let i = 0; i < before.length; i++) {
          const factor = bit(i, q) === outcome ? scale : 0
          expect(state.re[i], `collapse q${q}=${outcome} re[${i}]`).toBeCloseTo(
            before[i].re * factor,
            12
          )
          expect(state.im[i]).toBeCloseTo(before[i].im * factor, 12)
        }
      }
    }
  })
})

/* ───────────────── 7. shot-count keys vs amplitude indices ───────────── */

describe('shot-count keys name the basis state they were drawn from', () => {
  it('a basis state yields exactly its own ket as the only key', () => {
    const qubits = 3
    for (let index = 0; index < 1 << qubits; index++) {
      const state = basisState(qubits, index)
      const counts = sampleShots(state, 5, scriptedRng([0.1, 0.5, 0.9]))
      expect(counts, `basis index ${index}`).toEqual({
        [index.toString(2).padStart(qubits, '0')]: 5,
      })
    }
  })

  it('hand-computed draws land in the hand-computed bins', () => {
    // p(index 1) = 0.25, p(index 6) = 0.75, everything else 0.
    // cumulative = [0, .25, .25, .25, .25, .25, 1, 1]; the sampler takes the
    // smallest index whose cumulative mass strictly exceeds the draw.
    const state = alloc(3)
    state.re[0] = 0
    state.re[1] = 0.5
    state.re[6] = Math.sqrt(0.75)
    const counts = sampleShots(state, 4, scriptedRng([0.1, 0.3, 0.9999, 0]))
    expect(counts).toEqual({ '001': 2, '110': 2 })
    expect(orderedCounts(counts).map(([label]) => label)).toEqual([
      '001',
      '110',
    ])
  })

  it('enumerates in ascending basis-state order through orderedCounts', () => {
    // THE CORRECT CONVENTION, so nobody reinstates the confusion: display order
    // is `orderedCounts()`, never `Object.keys()` of a `ShotCounts`. A plain
    // object enumerates its canonical array-index keys first, and a ket label
    // is an array index exactly when it has no leading zero — so "100" is
    // hoisted in front of "000" whatever order the engine inserted them in, and
    // no sort at the insertion site can change that. Asserted unsorted here on
    // purpose: `.sort()` before comparing is what hid the original defect.
    const qubits = 3
    const state = alloc(qubits)
    for (let i = 0; i < state.size; i++) state.re[i] = Math.sqrt(1 / state.size)
    const draws: number[] = []
    for (let i = 0; i < state.size; i++) draws.push((i + 0.5) / state.size)

    const counts = sampleShots(state, state.size, scriptedRng(draws))
    expect(orderedCounts(counts).map(([label]) => label)).toEqual([
      '000',
      '001',
      '010',
      '011',
      '100',
      '101',
      '110',
      '111',
    ])
    // Every count is carried across, not just every label.
    expect(orderedCounts(counts).map(([, count]) => count)).toEqual(
      Array.from({ length: state.size }, () => 1)
    )
  })

  it('every draw agrees with a linear scan of the same cumulative sums', () => {
    const qubits = 4
    const state = randomState(qubits, 8191)
    const p = probabilities(state)
    const cumulative: number[] = []
    let total = 0
    for (let i = 0; i < p.length; i++) {
      total += p[i]
      cumulative.push(total)
    }
    for (let step = 0; step < 64; step++) {
      const draw = (step + 0.5) / 64
      const target = draw * total
      let expected = p.length - 1
      for (let i = 0; i < cumulative.length; i++) {
        if (target < cumulative[i]) {
          expected = i
          break
        }
      }
      const counts = sampleShots(state, 1, scriptedRng([draw]))
      expect(Object.keys(counts), `draw ${draw}`).toEqual([
        expected.toString(2).padStart(qubits, '0'),
      ])
    }
  })
})

/* ─────────────── 8. the runner, end to end, and the registers ────────── */

describe('the runner keeps circuit JSON, amplitudes and labels aligned', () => {
  it('x on qubit 0 of three qubits leaves the state at ket 001', () => {
    const circuit: CircuitLike = {
      qubits: 3,
      operations: [{ id: 'a', gate: 'x', targets: [0], column: 0 }],
    }
    const state = analyticState(circuit)
    expect(state.re[1]).toBeCloseTo(1, 12)
    const counts = sampleShots(state, 3, scriptedRng([0.5]))
    expect(counts).toEqual({ '001': 3 })
  })

  it('the spec example cx targets [2] controls [1] flips q2 from q1', () => {
    // §6's op_2. Start from |q1 = 1> (index 2); the control fires and q2 flips,
    // so the amplitude lands at index 2 + 4 = 6, ket 110.
    const circuit: CircuitLike = {
      qubits: 3,
      operations: [
        { id: 'a', gate: 'x', targets: [1], column: 0 },
        { id: 'b', gate: 'cx', targets: [2], controls: [1], column: 1 },
      ],
    }
    const state = analyticState(circuit)
    expect(state.re[6]).toBeCloseTo(1, 12)
    expect(formatKet(6, 3)).toBe('110')
  })

  it('a Bell pair on (q0, q2) puts its mass on indices 0 and 5', () => {
    const circuit: CircuitLike = {
      qubits: 3,
      operations: [
        { id: 'a', gate: 'h', targets: [0], column: 0 },
        { id: 'b', gate: 'cx', targets: [2], controls: [0], column: 1 },
      ],
    }
    const state = analyticState(circuit)
    const p = probabilities(state)
    expect(p[0]).toBeCloseTo(0.5, 10)
    expect(p[5]).toBeCloseTo(0.5, 10)
    for (let i = 0; i < p.length; i++) {
      if (i !== 0 && i !== 5) expect(p[i], `index ${i}`).toBeCloseTo(0, 10)
    }
  })

  it('formatRegister prints the highest clbit first', () => {
    const register = new Uint8Array([1, 0, 1, 0])
    // clbit 0 = 1, clbit 3 = 0 → "0101" read from clbit 3 down to clbit 0.
    expect(formatRegister(register)).toBe('0101')
  })

  it('trajectory counts and analytic ket labels describe the same outcome', () => {
    const unitary: CircuitLike = {
      qubits: 3,
      operations: [{ id: 'a', gate: 'x', targets: [0], column: 0 }],
    }
    const analytic = sampleShots(analyticState(unitary), 8, scriptedRng([0.5]))

    const measured: CircuitLike = {
      qubits: 3,
      clbits: 3,
      operations: [
        { id: 'a', gate: 'x', targets: [0], column: 0 },
        {
          id: 'm0',
          gate: 'measure',
          targets: [0],
          clbitTargets: [0],
          column: 1,
        },
        {
          id: 'm1',
          gate: 'measure',
          targets: [1],
          clbitTargets: [1],
          column: 1,
        },
        {
          id: 'm2',
          gate: 'measure',
          targets: [2],
          clbitTargets: [2],
          column: 1,
        },
      ],
    }
    const counts = trajectoryCounts(measured, 8, 99)
    expect(Object.keys(counts)).toEqual(Object.keys(analytic))
    expect(counts).toEqual({ '001': 8 })
  })

  it('a measurement writes the clbit it names, not the qubit index', () => {
    // q0 is 1 and q1 is 0, but the measurements are crossed: q0 → c1 and
    // q1 → c0. The register is therefore c1 c0 = "10".
    const circuit: CircuitLike = {
      qubits: 2,
      clbits: 2,
      operations: [
        { id: 'a', gate: 'x', targets: [0], column: 0 },
        {
          id: 'm0',
          gate: 'measure',
          targets: [0],
          clbitTargets: [1],
          column: 1,
        },
        {
          id: 'm1',
          gate: 'measure',
          targets: [1],
          clbitTargets: [0],
          column: 1,
        },
      ],
    }
    const trajectory = runTrajectory(circuit, createRng(3))
    expect(Array.from(trajectory.register)).toEqual([0, 1])
    expect(formatRegister(trajectory.register)).toBe('10')
  })

  it('an asymmetric GHZ-like circuit keeps its ket labels asymmetric', () => {
    // h q0, cx q0→q1: mass on |000> and |011>. If any label were reversed the
    // second key would read 110, which "011" is chosen to distinguish.
    const circuit: CircuitLike = {
      qubits: 3,
      operations: [
        { id: 'a', gate: 'h', targets: [0], column: 0 },
        { id: 'b', gate: 'cx', targets: [1], controls: [0], column: 1 },
      ],
    }
    const counts = sampleShots(
      analyticState(circuit),
      2,
      scriptedRng([0.1, 0.9])
    )
    expect(Object.keys(counts).sort()).toEqual(['000', '011'])
  })

  it('crz through the runner distinguishes its control from its target', () => {
    const theta = 0.8
    const build = (targets: number[], controls: number[]): CircuitLike => ({
      qubits: 2,
      operations: [
        { id: 'a', gate: 'x', targets: [0], column: 0 },
        {
          id: 'b',
          gate: 'crz',
          targets,
          controls,
          params: [theta],
          column: 1,
        },
      ],
    })

    const fired = analyticState(build([1], [0]))
    expect(fired.re[1]).toBeCloseTo(Math.cos(theta / 2), 10)
    expect(fired.im[1]).toBeCloseTo(-Math.sin(theta / 2), 10)

    const idle = analyticState(build([0], [1]))
    expect(idle.re[1]).toBeCloseTo(1, 10)
    expect(idle.im[1]).toBeCloseTo(0, 10)
  })

  it('trajectory counts enumerate in ascending register order', () => {
    // Same correction as the ket labels above: the register counts up through
    // `orderedCounts()`, not through `Object.keys()`, because "10" is a
    // canonical array index and "00" is not. Unsorted assertion on purpose.
    const circuit: CircuitLike = {
      qubits: 2,
      clbits: 2,
      operations: [
        { id: 'h0', gate: 'h', targets: [0], column: 0 },
        { id: 'h1', gate: 'h', targets: [1], column: 0 },
        {
          id: 'm0',
          gate: 'measure',
          targets: [0],
          clbitTargets: [0],
          column: 1,
        },
        {
          id: 'm1',
          gate: 'measure',
          targets: [1],
          clbitTargets: [1],
          column: 1,
        },
      ],
    }
    const counts = trajectoryCounts(circuit, 400, 17)
    expect(orderedCounts(counts).map(([label]) => label)).toEqual([
      '00',
      '01',
      '10',
      '11',
    ])
  })

  it('analytic ket labels and trajectory labels are the same label set', () => {
    const unitary: CircuitLike = {
      qubits: 3,
      operations: [
        { id: 'a', gate: 'h', targets: [0], column: 0 },
        { id: 'b', gate: 'cx', targets: [1], controls: [0], column: 1 },
      ],
    }
    const analytic = sampleShots(
      analyticState(unitary),
      2,
      scriptedRng([0.1, 0.9])
    )

    const measured: CircuitLike = {
      qubits: 3,
      clbits: 3,
      operations: [
        ...unitary.operations,
        {
          id: 'm0',
          gate: 'measure',
          targets: [0],
          clbitTargets: [0],
          column: 2,
        },
        {
          id: 'm1',
          gate: 'measure',
          targets: [1],
          clbitTargets: [1],
          column: 2,
        },
        {
          id: 'm2',
          gate: 'measure',
          targets: [2],
          clbitTargets: [2],
          column: 2,
        },
      ],
    }
    const counts = trajectoryCounts(measured, 200, 5)
    expect(Object.keys(counts).sort()).toEqual(Object.keys(analytic).sort())
    expect(Object.keys(counts).sort()).toEqual(['000', '011'])
  })

  it('cswap with the control below both targets moves the right bits', () => {
    const qubits = 5
    const controls: ControlSpec[] = [{ qubit: 0, state: 1 }]
    for (let index = 0; index < 1 << qubits; index++) {
      const state = basisState(qubits, index)
      applySwap(state, 1, 4, controls)
      let expected = index
      if (bit(index, 0) === 1) {
        const b1 = bit(index, 1)
        const b4 = bit(index, 4)
        expected = index & ~((1 << 1) | (1 << 4))
        if (b4 === 1) expected |= 1 << 1
        if (b1 === 1) expected |= 1 << 4
      }
      expect(
        state.re[expected],
        `cswap c0 (1,4) from ${formatKet(index, qubits)}`
      ).toBeCloseTo(1, 12)
    }
  })

  it('swap through the runner moves the amplitude between the named bits', () => {
    const circuit: CircuitLike = {
      qubits: 4,
      operations: [
        { id: 'a', gate: 'x', targets: [0], column: 0 },
        { id: 'b', gate: 'swap', targets: [0, 3], column: 1 },
      ],
    }
    const state = analyticState(circuit)
    expect(state.re[8]).toBeCloseTo(1, 12)
    expect(formatKet(8, 4)).toBe('1000')
  })
})
