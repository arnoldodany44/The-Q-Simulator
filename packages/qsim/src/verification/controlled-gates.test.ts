/**
 * INDEPENDENT VERIFICATION — controlled gates, multi-control, negative control.
 *
 * Nothing here trusts the kernel's own test suite. Every expected value is
 * derived from the textbook definition of a controlled operator
 *
 *     C_S(U) = (1 − Π_S) + Π_S · U_t ,   Π_S = ⨂_{c ∈ S} |s_c⟩⟨s_c|
 *
 * and built as a **dense 2ⁿ × 2ⁿ complex matrix by explicit Kronecker
 * products**, then multiplied into the state by brute-force matrix-vector
 * product. That is precisely the O(4ⁿ) road §5.2 forbids the engine to take —
 * which is what makes it a good oracle: it shares no code, no index algebra
 * and no loop structure with `apply.ts`.
 *
 * The Kronecker order is forced by decision D1. Qubit 0 is the least
 * significant bit of the index, and in `A ⊗ B` the row index is
 * `i_A · dim(B) + i_B`, so the *first* factor carries the *most* significant
 * bits. The full operator is therefore `M_{n−1} ⊗ … ⊗ M_1 ⊗ M_0`, highest
 * qubit first. Getting this backwards is exactly the mirrored-circuit bug D1
 * exists to prevent, so the oracle asserts it on the CNOT truth table before
 * it is used to judge anything else.
 *
 * Tolerance is D6's 1e-10, expressed as digits for `toBeCloseTo`. Where the
 * claim is "this subspace was not touched at all", the assertion is exact
 * equality rather than a tolerance: a controlled gate acts as the identity
 * there, and the identity does not perturb mantissas.
 */

import fc from 'fast-check'
import { describe, expect, it } from 'vitest'

import {
  apply1q,
  apply2q,
  applyControlled,
  applySwap,
  type ControlSpec,
} from '../apply.js'
import {
  GATE_MATRICES,
  SWAP_MATRIX,
  matrixFor,
  pMatrix,
  rzMatrix,
  uMatrix,
  type Matrix2,
  type Matrix4,
} from '../gates.js'
import { run, type CircuitLike, type OperationLike } from '../runner.js'
import { alloc, clone, type Statevector } from '../statevector.js'

/** Decision D6: test tolerance 1e-10, as digits for `toBeCloseTo`. */
const DIGITS = 10

const { h, s, t: tGate, tdg, x, y, z } = GATE_MATRICES

/* ─────────────────────── the slow, obvious oracle ────────────────────── */

/** A dense complex matrix, row-major, real and imaginary parts split. */
interface Dense {
  readonly dim: number
  readonly re: Float64Array
  readonly im: Float64Array
}

function zeros(dim: number): Dense {
  return {
    dim,
    re: new Float64Array(dim * dim),
    im: new Float64Array(dim * dim),
  }
}

function identity(dim: number): Dense {
  const out = zeros(dim)
  for (let i = 0; i < dim; i++) out.re[i * dim + i] = 1
  return out
}

/** The kernel's flat 2×2 layout, unpacked into the oracle's representation. */
function dense2(matrix: Matrix2): Dense {
  const out = zeros(2)
  for (let row = 0; row < 2; row++) {
    for (let column = 0; column < 2; column++) {
      out.re[row * 2 + column] = matrix[(2 * row + column) * 2]
      out.im[row * 2 + column] = matrix[(2 * row + column) * 2 + 1]
    }
  }
  return out
}

/** |b⟩⟨b|, the one-qubit projector a control imposes. */
function projector(bit: 0 | 1): Dense {
  const out = zeros(2)
  out.re[bit * 2 + bit] = 1
  return out
}

function kron(a: Dense, b: Dense): Dense {
  const dim = a.dim * b.dim
  const out = zeros(dim)
  for (let ra = 0; ra < a.dim; ra++) {
    for (let ca = 0; ca < a.dim; ca++) {
      const ar = a.re[ra * a.dim + ca]
      const ai = a.im[ra * a.dim + ca]
      for (let rb = 0; rb < b.dim; rb++) {
        for (let cb = 0; cb < b.dim; cb++) {
          const br = b.re[rb * b.dim + cb]
          const bi = b.im[rb * b.dim + cb]
          const row = ra * b.dim + rb
          const column = ca * b.dim + cb
          out.re[row * dim + column] = ar * br - ai * bi
          out.im[row * dim + column] = ar * bi + ai * br
        }
      }
    }
  }
  return out
}

/**
 * `M_{n−1} ⊗ … ⊗ M_0`, identity wherever `factors` is silent. Highest qubit
 * first, because D1 puts qubit 0 in the least significant position.
 */
function expand(qubits: number, factors: ReadonlyMap<number, Dense>): Dense {
  let out = identity(1)
  for (let q = qubits - 1; q >= 0; q--) {
    out = kron(out, factors.get(q) ?? identity(2))
  }
  return out
}

function multiply(a: Dense, b: Dense): Dense {
  const dim = a.dim
  const out = zeros(dim)
  for (let row = 0; row < dim; row++) {
    for (let column = 0; column < dim; column++) {
      let sumR = 0
      let sumI = 0
      for (let k = 0; k < dim; k++) {
        const ar = a.re[row * dim + k]
        const ai = a.im[row * dim + k]
        const br = b.re[k * dim + column]
        const bi = b.im[k * dim + column]
        sumR += ar * br - ai * bi
        sumI += ar * bi + ai * br
      }
      out.re[row * dim + column] = sumR
      out.im[row * dim + column] = sumI
    }
  }
  return out
}

/** `a + b` and `a − b`, entrywise. */
function add(a: Dense, b: Dense): Dense {
  const out = zeros(a.dim)
  for (let i = 0; i < a.re.length; i++) {
    out.re[i] = a.re[i] + b.re[i]
    out.im[i] = a.im[i] + b.im[i]
  }
  return out
}

function subtract(a: Dense, b: Dense): Dense {
  const out = zeros(a.dim)
  for (let i = 0; i < a.re.length; i++) {
    out.re[i] = a.re[i] - b.re[i]
    out.im[i] = a.im[i] - b.im[i]
  }
  return out
}

/** `Π_S`, the projector onto the subspace where every control is satisfied. */
function metProjector(qubits: number, controls: readonly ControlSpec[]): Dense {
  const factors = new Map<number, Dense>()
  for (const control of controls) {
    factors.set(control.qubit, projector(control.state))
  }
  return expand(qubits, factors)
}

/** `(1 − Π) + Π·V` — the definition of "V where the controls are met". */
function controlledBy(
  qubits: number,
  bare: Dense,
  controls: readonly ControlSpec[]
): Dense {
  const met = metProjector(qubits, controls)
  const dim = 1 << qubits
  return add(subtract(identity(dim), met), multiply(met, bare))
}

/** The oracle's controlled one-qubit gate. */
function controlledGateDense(
  qubits: number,
  matrix: Matrix2,
  target: number,
  controls: readonly ControlSpec[]
): Dense {
  const bare = expand(qubits, new Map([[target, dense2(matrix)]]))
  return controlledBy(qubits, bare, controls)
}

/**
 * SWAP as a permutation matrix, written from its definition on basis states
 * rather than from any 4×4: column `i` carries a 1 in the row whose index is
 * `i` with the two qubit bits exchanged.
 */
function swapBare(qubits: number, q0: number, q1: number): Dense {
  const dim = 1 << qubits
  const out = zeros(dim)
  for (let i = 0; i < dim; i++) {
    const b0 = (i >> q0) & 1
    const b1 = (i >> q1) & 1
    let j = i & ~((1 << q0) | (1 << q1))
    j |= b1 << q0
    j |= b0 << q1
    out.re[j * dim + i] = 1
  }
  return out
}

function swapDense(
  qubits: number,
  q0: number,
  q1: number,
  controls: readonly ControlSpec[]
): Dense {
  return controlledBy(qubits, swapBare(qubits, q0, q1), controls)
}

/** Brute-force `|ψ'⟩ = M|ψ⟩`. O(4ⁿ), which is the whole point. */
function applyDense(state: Statevector, operator: Dense): Statevector {
  const dim = state.size
  const out = {
    qubits: state.qubits,
    size: dim,
    re: new Float64Array(dim),
    im: new Float64Array(dim),
  }
  for (let row = 0; row < dim; row++) {
    let sumR = 0
    let sumI = 0
    for (let column = 0; column < dim; column++) {
      const mr = operator.re[row * dim + column]
      const mi = operator.im[row * dim + column]
      sumR += mr * state.re[column] - mi * state.im[column]
      sumI += mr * state.im[column] + mi * state.re[column]
    }
    out.re[row] = sumR
    out.im[row] = sumI
  }
  return out
}

/* ──────────────────────────── test plumbing ─────────────────────────── */

/**
 * A deterministic normalised state. Its own generator, not the engine's
 * `rng.ts`: an oracle that shares a component with the thing it judges is
 * that much less of an oracle.
 */
function randomState(qubits: number, seed: number): Statevector {
  const state = alloc(qubits)
  let bits = seed >>> 0 || 1
  const next = (): number => {
    bits ^= bits << 13
    bits >>>= 0
    bits ^= bits >>> 17
    bits ^= bits << 5
    bits >>>= 0
    return bits / 0x100000000 - 0.5
  }
  let sum = 0
  for (let i = 0; i < state.size; i++) {
    const re = next()
    const im = next()
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

/** The basis state |index⟩ of an `qubits`-qubit register. */
function basisState(qubits: number, index: number): Statevector {
  const state = alloc(qubits)
  state.re[0] = 0
  state.re[index] = 1
  return state
}

/** The single index carrying amplitude 1, or `-1` if the state is not basis. */
function basisIndexOf(state: Statevector): number {
  let found = -1
  for (let i = 0; i < state.size; i++) {
    const magnitude = Math.hypot(state.re[i], state.im[i])
    if (magnitude < 1e-12) continue
    if (found !== -1) return -1
    if (Math.abs(magnitude - 1) > 1e-12) return -1
    if (Math.abs(state.im[i]) > 1e-12 || state.re[i] < 0) return -1
    found = i
  }
  return found
}

function expectSameState(
  actual: Statevector,
  expected: Statevector,
  label = ''
): void {
  expect(actual.size).toBe(expected.size)
  for (let i = 0; i < expected.size; i++) {
    expect(actual.re[i], `${label} re[${i}]`).toBeCloseTo(
      expected.re[i],
      DIGITS
    )
    expect(actual.im[i], `${label} im[${i}]`).toBeCloseTo(
      expected.im[i],
      DIGITS
    )
  }
}

function positive(...qubits: number[]): ControlSpec[] {
  return qubits.map((qubit) => ({ qubit, state: 1 as const }))
}

/** CNOT through the kernel, for building decompositions in the tests. */
function cnot(state: Statevector, control: number, target: number): void {
  applyControlled(state, x, target, positive(control))
}

/** The final state of an analytic run, with the mode narrowed. */
function analyticState(circuit: CircuitLike): Statevector {
  const result = run(circuit)
  if (result.mode !== 'analytic') throw new Error('expected analytic mode')
  return result.state
}

/** A 4×4 permutation: `map[column]` is the row that column is sent to. */
function permutation4(map: readonly number[]): Matrix4 {
  const matrix = new Float64Array(32)
  for (let column = 0; column < 4; column++) {
    matrix[(map[column] * 4 + column) * 2] = 1
  }
  return matrix
}

/** A 4×4 diagonal from four `[re, im]` pairs. */
function diagonal4(entries: readonly (readonly number[])[]): Matrix4 {
  const matrix = new Float64Array(32)
  for (let k = 0; k < 4; k++) {
    matrix[(k * 4 + k) * 2] = entries[k][0]
    matrix[(k * 4 + k) * 2 + 1] = entries[k][1]
  }
  return matrix
}

/**
 * The full 2ⁿ × 2ⁿ operator the kernel actually implements, reconstructed by
 * feeding it every basis state one at a time and reading off the columns.
 *
 * Comparing operators rather than one image of one random state is the
 * difference between "these agree here" and "these are the same gate": a bug
 * that only touches a subspace the chosen state happens to miss cannot hide
 * from this.
 */
function reconstruct(
  qubits: number,
  apply: (state: Statevector) => void
): Dense {
  const dim = 1 << qubits
  const out = zeros(dim)
  for (let column = 0; column < dim; column++) {
    const state = basisState(qubits, column)
    apply(state)
    for (let row = 0; row < dim; row++) {
      out.re[row * dim + column] = state.re[row]
      out.im[row * dim + column] = state.im[row]
    }
  }
  return out
}

function expectSameOperator(
  actual: Dense,
  expected: Dense,
  label: string
): void {
  expect(actual.dim).toBe(expected.dim)
  for (let i = 0; i < expected.re.length; i++) {
    const row = Math.floor(i / expected.dim)
    const column = i % expected.dim
    expect(actual.re[i], `${label} re(${row},${column})`).toBeCloseTo(
      expected.re[i],
      DIGITS
    )
    expect(actual.im[i], `${label} im(${row},${column})`).toBeCloseTo(
      expected.im[i],
      DIGITS
    )
  }
}

/* ───────────────────────── the oracle's own audit ────────────────────── */

describe('the oracle agrees with D1 before it judges anything', () => {
  it('places qubit 0 in the least significant Kronecker factor', () => {
    // Z on qubit 0 of a 2-qubit register must negate the odd indices (1, 3),
    // which are the ones with bit 0 set. Z on qubit 1 must negate 2 and 3.
    const onZero = expand(2, new Map([[0, dense2(z)]]))
    const signsZero = [0, 1, 2, 3].map((i) => onZero.re[i * 4 + i])
    expect(signsZero).toEqual([1, -1, 1, -1])

    const onOne = expand(2, new Map([[1, dense2(z)]]))
    const signsOne = [0, 1, 2, 3].map((i) => onOne.re[i * 4 + i])
    expect(signsOne).toEqual([1, 1, -1, -1])
  })

  it('reproduces the CNOT truth table from its definition', () => {
    // Control 0, target 1: |01⟩ (index 1) → |11⟩ (index 3), and back.
    const operator = controlledGateDense(2, x, 1, positive(0))
    const sent = [0, 1, 2, 3].map((column) => {
      for (let row = 0; row < 4; row++) {
        if (operator.re[row * 4 + column] === 1) return row
      }
      return -1
    })
    expect(sent).toEqual([0, 3, 2, 1])
  })
})

/* ─────────────────── 1. the defining subspace behaviour ──────────────── */

describe('a controlled gate is identity off the control subspace', () => {
  it('leaves every unmet amplitude bit-identical and gates the rest', () => {
    // Two controls of opposite sign on a 5-qubit register, target between
    // them. The met subspace is a quarter of the indices; the other three
    // quarters must come back untouched, not merely close.
    const qubits = 5
    const target = 2
    const controls: ControlSpec[] = [
      { qubit: 0, state: 1 },
      { qubit: 4, state: 0 },
    ]
    const gate = uMatrix(0.83, 1.27, -2.11)

    const before = randomState(qubits, 0x510001)
    const bare = clone(before)
    apply1q(bare, gate, target)

    const actual = clone(before)
    applyControlled(actual, gate, target, controls)

    const mask = (1 << 0) | (1 << 4)
    const value = 1 << 0
    for (let i = 0; i < actual.size; i++) {
      const met = (i & mask) === value
      const source = met ? bare : before
      expect(actual.re[i], `re[${i}] met=${met}`).toBe(source.re[i])
      expect(actual.im[i], `im[${i}] met=${met}`).toBe(source.im[i])
    }
  })

  it('is the exact identity when no control can ever be satisfied', () => {
    // A negative control on a qubit prepared in |1⟩: the gate must not fire.
    const state = alloc(3)
    apply1q(state, x, 2)
    apply1q(state, h, 0)
    const before = clone(state)
    applyControlled(state, y, 1, [{ qubit: 2, state: 0 }])
    for (let i = 0; i < state.size; i++) {
      expect(state.re[i]).toBe(before.re[i])
      expect(state.im[i]).toBe(before.im[i])
    }
  })
})

/* ──────────────── 2. exhaustive sweep against the oracle ─────────────── */

/** Every non-empty control set on `qubits`, with every 0/1 assignment. */
function everyControlSet(qubits: number, target: number): ControlSpec[][] {
  const others: number[] = []
  for (let q = 0; q < qubits; q++) if (q !== target) others.push(q)

  const out: ControlSpec[][] = []
  for (let subset = 1; subset < 1 << others.length; subset++) {
    const chosen = others.filter((_, k) => ((subset >> k) & 1) === 1)
    for (let assignment = 0; assignment < 1 << chosen.length; assignment++) {
      out.push(
        chosen.map((qubit, k) => ({
          qubit,
          state: ((assignment >> k) & 1) as 0 | 1,
        }))
      )
    }
  }
  return out
}

describe('every control shape on a 4-qubit register matches the oracle', () => {
  const qubits = 4
  const gate = uMatrix(1.13, 0.47, 2.71)

  for (let target = 0; target < qubits; target++) {
    const sets = everyControlSet(qubits, target)
    it(`target ${target}: ${sets.length} control shapes`, () => {
      const seed = 0x9e37 + target
      for (const controls of sets) {
        const before = randomState(qubits, seed)
        const actual = clone(before)
        applyControlled(actual, gate, target, controls)
        const expected = applyDense(
          before,
          controlledGateDense(qubits, gate, target, controls)
        )
        const label = controls
          .map((c) => `${c.state === 1 ? '' : '¬'}q${c.qubit}`)
          .join(',')
        expectSameState(actual, expected, `[${label}]→q${target}`)
      }
    })
  }
})

describe('non-adjacent, reversed and multi-control placements', () => {
  const cases: {
    name: string
    qubits: number
    target: number
    controls: ControlSpec[]
    matrix: Matrix2
  }[] = [
    {
      name: 'control 0 below a far target 5',
      qubits: 6,
      target: 5,
      controls: positive(0),
      matrix: h,
    },
    {
      name: 'control 5 above a far target 0',
      qubits: 6,
      target: 0,
      controls: positive(5),
      matrix: h,
    },
    {
      name: 'adjacent, control below target',
      qubits: 3,
      target: 2,
      controls: positive(1),
      matrix: uMatrix(0.4, 1.9, 0.6),
    },
    {
      name: 'adjacent, control above target',
      qubits: 3,
      target: 1,
      controls: positive(2),
      matrix: uMatrix(0.4, 1.9, 0.6),
    },
    {
      name: 'negative control below target',
      qubits: 4,
      target: 3,
      controls: [{ qubit: 0, state: 0 }],
      matrix: s,
    },
    {
      name: 'negative control above target',
      qubits: 4,
      target: 0,
      controls: [{ qubit: 3, state: 0 }],
      matrix: s,
    },
    {
      name: 'two controls straddling the target',
      qubits: 5,
      target: 2,
      controls: positive(0, 4),
      matrix: x,
    },
    {
      name: 'two controls above the target, descending order',
      qubits: 5,
      target: 0,
      controls: positive(4, 2),
      matrix: rzMatrix(0.9),
    },
    {
      name: 'three controls, all positive',
      qubits: 5,
      target: 3,
      controls: positive(0, 1, 4),
      matrix: x,
    },
    {
      name: 'three controls, mixed signs',
      qubits: 5,
      target: 1,
      controls: [
        { qubit: 4, state: 1 },
        { qubit: 0, state: 0 },
        { qubit: 3, state: 1 },
      ],
      matrix: uMatrix(2.2, -0.7, 1.4),
    },
    {
      name: 'three controls, all negative',
      qubits: 5,
      target: 2,
      controls: [
        { qubit: 0, state: 0 },
        { qubit: 1, state: 0 },
        { qubit: 4, state: 0 },
      ],
      matrix: h,
    },
    {
      name: 'four controls on a 5-qubit register',
      qubits: 5,
      target: 2,
      controls: [
        { qubit: 0, state: 1 },
        { qubit: 1, state: 0 },
        { qubit: 3, state: 1 },
        { qubit: 4, state: 0 },
      ],
      matrix: pMatrix(1.05),
    },
  ]

  for (const testCase of cases) {
    it(testCase.name, () => {
      const before = randomState(testCase.qubits, 0x2718 + testCase.target)
      const actual = clone(before)
      applyControlled(
        actual,
        testCase.matrix,
        testCase.target,
        testCase.controls
      )
      const expected = applyDense(
        before,
        controlledGateDense(
          testCase.qubits,
          testCase.matrix,
          testCase.target,
          testCase.controls
        )
      )
      expectSameState(actual, expected, testCase.name)
    })
  }
})

describe('control ordering and duplicate-free control sets', () => {
  it('does not depend on the order the controls are listed', () => {
    const forward: ControlSpec[] = [
      { qubit: 0, state: 1 },
      { qubit: 2, state: 0 },
      { qubit: 4, state: 1 },
    ]
    const reversed = [...forward].reverse()
    const before = randomState(5, 0xbeef)

    const a = clone(before)
    applyControlled(a, h, 3, forward)
    const b = clone(before)
    applyControlled(b, h, 3, reversed)

    for (let i = 0; i < a.size; i++) {
      expect(a.re[i], `re[${i}]`).toBe(b.re[i])
      expect(a.im[i], `im[${i}]`).toBe(b.im[i])
    }
  })

  it('rejects a control that is also the target', () => {
    const state = alloc(3)
    expect(() => {
      applyControlled(state, x, 1, positive(1))
    }).toThrow()
  })

  it('rejects the same qubit controlled twice', () => {
    const state = alloc(3)
    expect(() => {
      applyControlled(state, x, 2, [
        { qubit: 0, state: 1 },
        { qubit: 0, state: 0 },
      ])
    }).toThrow()
  })

  it('rejects a control outside the register', () => {
    const state = alloc(3)
    expect(() => {
      applyControlled(state, x, 0, positive(3))
    }).toThrow()
  })
})

/* ───────────── 3. negative control = X-conjugated positive one ───────── */

describe('a negative control is a positive control conjugated by X', () => {
  it('holds for a single control on either side of the target', () => {
    for (const [control, target] of [
      [0, 4],
      [4, 0],
      [2, 3],
    ]) {
      const before = randomState(5, 0x1234 + control)

      const viaNegative = clone(before)
      applyControlled(viaNegative, h, target, [{ qubit: control, state: 0 }])

      const viaConjugation = clone(before)
      apply1q(viaConjugation, x, control)
      applyControlled(viaConjugation, h, target, positive(control))
      apply1q(viaConjugation, x, control)

      expectSameState(viaConjugation, viaNegative, `control ${control}`)
    }
  })

  it('holds for a mixed three-control gate', () => {
    const controls: ControlSpec[] = [
      { qubit: 0, state: 0 },
      { qubit: 1, state: 1 },
      { qubit: 4, state: 0 },
    ]
    const gate = uMatrix(1.7, 0.3, -1.1)
    const before = randomState(5, 0xc0ffee)

    const viaNegative = clone(before)
    applyControlled(viaNegative, gate, 3, controls)

    const viaConjugation = clone(before)
    const flipped = controls.filter((c) => c.state === 0).map((c) => c.qubit)
    for (const qubit of flipped) apply1q(viaConjugation, x, qubit)
    applyControlled(
      viaConjugation,
      gate,
      3,
      positive(...controls.map((c) => c.qubit))
    )
    for (const qubit of flipped) apply1q(viaConjugation, x, qubit)

    expectSameState(viaConjugation, viaNegative)
  })
})

/* ──────────────────────── 4. Toffoli (CCX) ──────────────────────────── */

describe('Toffoli against its truth table on all 8 basis states', () => {
  /** |c₁ c₀⟩ = |11⟩ flips the target; every other input is fixed. */
  function toffoliTruth(
    index: number,
    a: number,
    b: number,
    t: number
  ): number {
    const met = ((index >> a) & 1) === 1 && ((index >> b) & 1) === 1
    return met ? index ^ (1 << t) : index
  }

  const placements: [number, number, number][] = [
    [0, 1, 2],
    [1, 2, 0],
    [0, 2, 1],
    [2, 1, 0],
  ]

  for (const [a, b, target] of placements) {
    it(`controls (${a}, ${b}) → target ${target}`, () => {
      for (let index = 0; index < 8; index++) {
        const state = basisState(3, index)
        applyControlled(state, x, target, positive(a, b))
        expect(basisIndexOf(state), `input |${index}⟩`).toBe(
          toffoliTruth(index, a, b, target)
        )
      }
    })
  }

  it('is a genuine permutation of the 8 basis states', () => {
    const images = new Set<number>()
    for (let index = 0; index < 8; index++) {
      const state = basisState(3, index)
      applyControlled(state, x, 2, positive(0, 1))
      images.add(basisIndexOf(state))
    }
    expect(images.size).toBe(8)
    expect(images.has(-1)).toBe(false)
  })

  it('matches the Nielsen & Chuang 6-CNOT + T decomposition', () => {
    // Figure 4.9, controls a and b, target c. This uses only one-qubit gates
    // and singly-controlled X, so it exercises the two-control path against a
    // circuit that never uses one.
    const a = 0
    const b = 3
    const c = 1
    const before = randomState(4, 0x4d5e)

    const built = clone(before)
    apply1q(built, h, c)
    cnot(built, b, c)
    apply1q(built, tdg, c)
    cnot(built, a, c)
    apply1q(built, tGate, c)
    cnot(built, b, c)
    apply1q(built, tdg, c)
    cnot(built, a, c)
    apply1q(built, tGate, b)
    apply1q(built, tGate, c)
    apply1q(built, h, c)
    cnot(built, a, b)
    apply1q(built, tGate, a)
    apply1q(built, tdg, b)
    cnot(built, a, b)

    const expected = applyDense(
      before,
      controlledGateDense(4, x, c, positive(a, b))
    )
    expectSameState(built, expected, 'CCX decomposition')
  })

  it('matches the oracle on a superposed 5-qubit register', () => {
    const controls = positive(4, 1)
    const before = randomState(5, 0xa11ce)
    const actual = clone(before)
    applyControlled(actual, x, 3, controls)
    const expected = applyDense(before, controlledGateDense(5, x, 3, controls))
    expectSameState(actual, expected)
  })

  it('runs as gate "ccx" through the circuit runner', () => {
    for (let index = 0; index < 8; index++) {
      const preparation: OperationLike[] = []
      for (let q = 0; q < 3; q++) {
        if (((index >> q) & 1) === 1) {
          preparation.push({
            id: `prep_${q}`,
            gate: 'x',
            targets: [q],
            column: 0,
          })
        }
      }
      const circuit: CircuitLike = {
        qubits: 3,
        operations: [
          ...preparation,
          {
            id: 'ccx',
            gate: 'ccx',
            targets: [2],
            controls: [0, 1],
            column: 1,
          },
        ],
      }
      const met = (index & 0b011) === 0b011
      expect(basisIndexOf(analyticState(circuit)), `|${index}⟩`).toBe(
        met ? index ^ 0b100 : index
      )
    }
  })
})

/* ──────────────────────── 5. Fredkin (CSWAP) ────────────────────────── */

describe('Fredkin against its truth table on all 8 basis states', () => {
  function fredkinTruth(
    index: number,
    c: number,
    a: number,
    b: number
  ): number {
    if (((index >> c) & 1) === 0) return index
    const ba = (index >> a) & 1
    const bb = (index >> b) & 1
    let out = index & ~((1 << a) | (1 << b))
    out |= bb << a
    out |= ba << b
    return out
  }

  const placements: [number, number, number][] = [
    [0, 1, 2],
    [2, 0, 1],
    [1, 0, 2],
    [1, 2, 0],
  ]

  for (const [control, a, b] of placements) {
    it(`control ${control}, swapping (${a}, ${b})`, () => {
      for (let index = 0; index < 8; index++) {
        const state = basisState(3, index)
        applySwap(state, a, b, positive(control))
        expect(basisIndexOf(state), `input |${index}⟩`).toBe(
          fredkinTruth(index, control, a, b)
        )
      }
    })
  }

  it('matches the oracle with a non-adjacent control and targets', () => {
    const before = randomState(5, 0x7f7f)
    const actual = clone(before)
    applySwap(actual, 0, 4, positive(2))
    const expected = applyDense(before, swapDense(5, 0, 4, positive(2)))
    expectSameState(actual, expected)
  })

  it('matches the oracle with a negative control', () => {
    const controls: ControlSpec[] = [{ qubit: 3, state: 0 }]
    const before = randomState(5, 0x3131)
    const actual = clone(before)
    applySwap(actual, 1, 4, controls)
    const expected = applyDense(before, swapDense(5, 1, 4, controls))
    expectSameState(actual, expected)
  })

  it('matches the oracle with two controls of opposite sign', () => {
    const controls: ControlSpec[] = [
      { qubit: 0, state: 1 },
      { qubit: 4, state: 0 },
    ]
    const before = randomState(5, 0x5959)
    const actual = clone(before)
    applySwap(actual, 1, 3, controls)
    const expected = applyDense(before, swapDense(5, 1, 3, controls))
    expectSameState(actual, expected)
  })

  it('equals CX(b→a) · CCX(c,a→b) · CX(b→a)', () => {
    // SWAP(a,b) = CX(b→a)·CX(a→b)·CX(b→a); controlling only the middle CNOT
    // is enough, because the outer two cancel when the control is |0⟩.
    const c = 4
    const a = 0
    const b = 2
    const before = randomState(5, 0x6060)

    const built = clone(before)
    cnot(built, b, a)
    applyControlled(built, x, b, positive(c, a))
    cnot(built, b, a)

    const expected = applyDense(before, swapDense(5, a, b, positive(c)))
    expectSameState(built, expected, 'CSWAP decomposition')
  })

  it('runs as gate "cswap" through the circuit runner', () => {
    for (let index = 0; index < 8; index++) {
      const preparation: OperationLike[] = []
      for (let q = 0; q < 3; q++) {
        if (((index >> q) & 1) === 1) {
          preparation.push({
            id: `prep_${q}`,
            gate: 'x',
            targets: [q],
            column: 0,
          })
        }
      }
      const circuit: CircuitLike = {
        qubits: 3,
        operations: [
          ...preparation,
          {
            id: 'cswap',
            gate: 'cswap',
            targets: [1, 2],
            controls: [0],
            column: 1,
          },
        ],
      }
      expect(basisIndexOf(analyticState(circuit)), `|${index}⟩`).toBe(
        fredkinTruth(index, 0, 1, 2)
      )
    }
  })
})

/* ────────── 6. specialised controlled paths vs the general 4×4 ───────── */

describe('the specialised controlled paths match the general apply2q', () => {
  it('CNOT, with the target as the first qubit argument', () => {
    // apply2q indexes a group by 2·b₁ + b₀ with b₀ the first argument. With
    // (q0, q1) = (target, control) the column order is (c,t) =
    // 00, 01, 10, 11 and CNOT sends 10 → 11 and 11 → 10.
    const matrix = permutation4([0, 1, 3, 2])
    for (const [control, target] of [
      [0, 3],
      [3, 0],
      [1, 2],
    ]) {
      const before = randomState(4, 0x1111 + control)
      const viaControlled = clone(before)
      applyControlled(viaControlled, x, target, positive(control))
      const viaGeneral = clone(before)
      apply2q(viaGeneral, matrix, target, control)
      expectSameState(viaGeneral, viaControlled, `cx ${control}→${target}`)
    }
  })

  it('CNOT, with the control as the first qubit argument', () => {
    // Now the column order is (t,c) = 00, 01, 10, 11 and CNOT sends
    // 01 → 11 and 11 → 01.
    const matrix = permutation4([0, 3, 2, 1])
    for (const [control, target] of [
      [0, 3],
      [3, 0],
      [2, 1],
    ]) {
      const before = randomState(4, 0x2222 + control)
      const viaControlled = clone(before)
      applyControlled(viaControlled, x, target, positive(control))
      const viaGeneral = clone(before)
      apply2q(viaGeneral, matrix, control, target)
      expectSameState(viaGeneral, viaControlled, `cx ${control}→${target}`)
    }
  })

  it('CZ, and CZ is symmetric in its two qubits', () => {
    const matrix = diagonal4([
      [1, 0],
      [1, 0],
      [1, 0],
      [-1, 0],
    ])
    const before = randomState(4, 0x3333)

    const viaControlled = clone(before)
    applyControlled(viaControlled, z, 3, positive(1))
    const viaGeneral = clone(before)
    apply2q(viaGeneral, matrix, 1, 3)
    expectSameState(viaGeneral, viaControlled, 'cz')

    // The whole point of CZ: exchanging control and target changes nothing.
    const swappedRoles = clone(before)
    applyControlled(swappedRoles, z, 1, positive(3))
    expectSameState(swappedRoles, viaControlled, 'cz reversed')
  })

  it('CP(φ) is symmetric, CRz(θ) is not', () => {
    const phi = 0.77
    const theta = 0.77
    const before = randomState(4, 0x4444)

    const cp = clone(before)
    applyControlled(cp, pMatrix(phi), 2, positive(0))
    const cpReversed = clone(before)
    applyControlled(cpReversed, pMatrix(phi), 0, positive(2))
    expectSameState(cpReversed, cp, 'cp is symmetric')

    // CRz carries e^{∓iθ/2} on the target, so the two roles are different
    // operators. Pin that difference rather than assume it.
    const crz = clone(before)
    applyControlled(crz, rzMatrix(theta), 2, positive(0))
    const crzReversed = clone(before)
    applyControlled(crzReversed, rzMatrix(theta), 0, positive(2))
    let differs = false
    for (let i = 0; i < crz.size; i++) {
      if (Math.abs(crz.re[i] - crzReversed.re[i]) > 1e-6) differs = true
      if (Math.abs(crz.im[i] - crzReversed.im[i]) > 1e-6) differs = true
    }
    expect(differs, 'crz must not be symmetric in control and target').toBe(
      true
    )
  })

  it('CRz(θ) matches the 4×4 written with the control first', () => {
    // Column order (t,c): index 1 is (t=0,c=1) and gets e^{-iθ/2}; index 3 is
    // (t=1,c=1) and gets e^{+iθ/2}. Indices 0 and 2 have c=0 and are fixed.
    const theta = 1.31
    const matrix = diagonal4([
      [1, 0],
      [Math.cos(theta / 2), -Math.sin(theta / 2)],
      [1, 0],
      [Math.cos(theta / 2), Math.sin(theta / 2)],
    ])
    const before = randomState(4, 0x5555)
    const viaControlled = clone(before)
    applyControlled(viaControlled, rzMatrix(theta), 3, positive(1))
    const viaGeneral = clone(before)
    apply2q(viaGeneral, matrix, 1, 3)
    expectSameState(viaGeneral, viaControlled, 'crz')
  })

  it('uncontrolled SWAP matches apply2q with SWAP_MATRIX', () => {
    for (const [q0, q1] of [
      [0, 3],
      [3, 0],
      [1, 2],
    ]) {
      const before = randomState(4, 0x6666 + q0)
      const viaSpecialised = clone(before)
      applySwap(viaSpecialised, q0, q1)
      const viaGeneral = clone(before)
      apply2q(viaGeneral, SWAP_MATRIX, q0, q1)
      expectSameState(viaGeneral, viaSpecialised, `swap ${q0},${q1}`)
    }
  })

  it('controlled SWAP matches CX-conjugated CCX built from apply2q', () => {
    // The general path can express the two CNOTs of the CSWAP identity; the
    // three-qubit middle stays on the controlled path, so this compares the
    // specialised CSWAP against a mixture of the two.
    const cnotTargetFirst = permutation4([0, 1, 3, 2])
    const before = randomState(4, 0x7777)

    const viaSpecialised = clone(before)
    applySwap(viaSpecialised, 1, 3, positive(0))

    const viaMixed = clone(before)
    apply2q(viaMixed, cnotTargetFirst, 1, 3)
    applyControlled(viaMixed, x, 3, positive(0, 1))
    apply2q(viaMixed, cnotTargetFirst, 1, 3)

    expectSameState(viaMixed, viaSpecialised, 'cswap')
  })
})

/* ─────────────────────── 7. through the runner ───────────────────────── */

describe('the runner reaches the same controlled operators', () => {
  it('cx with the control above and below the target', () => {
    for (const [control, target] of [
      [0, 3],
      [3, 0],
    ]) {
      const circuit: CircuitLike = {
        qubits: 4,
        operations: [
          { id: 'h', gate: 'h', targets: [control], column: 0 },
          {
            id: 'cx',
            gate: 'cx',
            targets: [target],
            controls: [control],
            column: 1,
          },
        ],
      }
      const state = analyticState(circuit)
      const reference = alloc(4)
      apply1q(reference, h, control)
      const expected = applyDense(
        reference,
        controlledGateDense(4, x, target, positive(control))
      )
      expectSameState(state, expected, `cx ${control}→${target}`)
    }
  })

  it('a one-qubit gate with two controls, one of them negative', () => {
    const controls: ControlSpec[] = [
      { qubit: 0, state: 1 },
      { qubit: 3, state: 0 },
    ]
    const circuit: CircuitLike = {
      qubits: 4,
      operations: [
        { id: 'h0', gate: 'h', targets: [0], column: 0 },
        { id: 'h3', gate: 'h', targets: [3], column: 0 },
        {
          id: 'cch',
          gate: 'ry',
          targets: [2],
          controls: [
            { qubit: 0, state: 1 },
            { qubit: 3, state: 0 },
          ],
          params: [0.9],
          column: 1,
        },
      ],
    }
    const state = analyticState(circuit)

    const reference = alloc(4)
    apply1q(reference, h, 0)
    apply1q(reference, h, 3)
    const expected = applyDense(
      reference,
      controlledGateDense(4, matrixFor('ry', [0.9]), 2, controls)
    )
    expectSameState(state, expected, 'controlled ry')
  })

  it('a controlled identity is exactly the identity', () => {
    const circuit: CircuitLike = {
      qubits: 3,
      operations: [
        { id: 'h', gate: 'h', targets: [0], column: 0 },
        {
          id: 'ci',
          gate: 'i',
          targets: [2],
          controls: [0],
          column: 1,
        },
      ],
    }
    const state = analyticState(circuit)
    const reference = alloc(3)
    apply1q(reference, h, 0)
    expectSameState(state, reference, 'controlled i')
  })

  it('crz and cp are different operators at the same angle', () => {
    const angle = 1.2
    const build = (gate: string): Statevector =>
      analyticState({
        qubits: 2,
        operations: [
          { id: 'h0', gate: 'h', targets: [0], column: 0 },
          { id: 'h1', gate: 'h', targets: [1], column: 0 },
          {
            id: 'g',
            gate,
            targets: [1],
            controls: [0],
            params: [angle],
            column: 1,
          },
        ],
      })

    const reference = alloc(2)
    apply1q(reference, h, 0)
    apply1q(reference, h, 1)

    expectSameState(
      build('crz'),
      applyDense(
        reference,
        controlledGateDense(2, rzMatrix(angle), 1, positive(0))
      ),
      'crz'
    )
    expectSameState(
      build('cp'),
      applyDense(
        reference,
        controlledGateDense(2, pMatrix(angle), 1, positive(0))
      ),
      'cp'
    )
  })
})

/* ──────────────────── 8. property-based sweep ────────────────────────── */

describe('property: any control shape matches the oracle (fast-check)', () => {
  it('holds for random registers, targets, control sets and unitaries', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 2, max: 5 }).chain((qubits) =>
          fc.record({
            qubits: fc.constant(qubits),
            picks: fc.shuffledSubarray([...Array(qubits).keys()], {
              minLength: 2,
              maxLength: qubits,
            }),
            states: fc.array(fc.constantFrom(0, 1), {
              minLength: qubits,
              maxLength: qubits,
            }),
            angles: fc.array(fc.integer({ min: 0, max: 1000 }), {
              minLength: 3,
              maxLength: 3,
            }),
            seed: fc.integer({ min: 1, max: 0x7fffffff }),
          })
        ),
        ({ qubits, picks, states, angles, seed }) => {
          const target = picks[0]
          const controls: ControlSpec[] = picks.slice(1).map((qubit, k) => ({
            qubit,
            state: states[k],
          }))
          const [a, b, c] = angles.map((k) => (k / 500) * Math.PI - Math.PI)
          const gate = uMatrix(a, b, c)

          const before = randomState(qubits, seed)
          const actual = clone(before)
          applyControlled(actual, gate, target, controls)
          const expected = applyDense(
            before,
            controlledGateDense(qubits, gate, target, controls)
          )

          for (let i = 0; i < actual.size; i++) {
            expect(actual.re[i]).toBeCloseTo(expected.re[i], DIGITS)
            expect(actual.im[i]).toBeCloseTo(expected.im[i], DIGITS)
          }
        }
      ),
      { numRuns: 250 }
    )
  })

  it('holds for controlled SWAP on random registers', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 3, max: 5 }).chain((qubits) =>
          fc.record({
            qubits: fc.constant(qubits),
            picks: fc.shuffledSubarray([...Array(qubits).keys()], {
              minLength: 3,
              maxLength: qubits,
            }),
            states: fc.array(fc.constantFrom(0, 1), {
              minLength: qubits,
              maxLength: qubits,
            }),
            seed: fc.integer({ min: 1, max: 0x7fffffff }),
          })
        ),
        ({ qubits, picks, states, seed }) => {
          const q0 = picks[0]
          const q1 = picks[1]
          const controls: ControlSpec[] = picks.slice(2).map((qubit, k) => ({
            qubit,
            state: states[k],
          }))

          const before = randomState(qubits, seed)
          const actual = clone(before)
          applySwap(actual, q0, q1, controls)
          const expected = applyDense(
            before,
            swapDense(qubits, q0, q1, controls)
          )

          for (let i = 0; i < actual.size; i++) {
            expect(actual.re[i]).toBeCloseTo(expected.re[i], DIGITS)
            expect(actual.im[i]).toBeCloseTo(expected.im[i], DIGITS)
          }
        }
      ),
      { numRuns: 200 }
    )
  })
})

/* ───────── 9. operator identity, not just agreement on one state ──────── */

describe('the reconstructed operator equals the definition', () => {
  const qubits = 4
  const gate = uMatrix(0.61, -1.33, 2.05)

  for (let target = 0; target < qubits; target++) {
    it(`target ${target}: every control shape, entry by entry`, () => {
      for (const controls of everyControlSet(qubits, target)) {
        const label = controls
          .map((c) => `${c.state === 1 ? '' : '¬'}q${c.qubit}`)
          .join(',')
        expectSameOperator(
          reconstruct(qubits, (state) => {
            applyControlled(state, gate, target, controls)
          }),
          controlledGateDense(qubits, gate, target, controls),
          `[${label}]→q${target}`
        )
      }
    })
  }

  it('controlled SWAP, every control shape on 4 qubits', () => {
    for (const [q0, q1] of [
      [0, 1],
      [0, 3],
      [3, 0],
      [1, 2],
    ]) {
      const others: number[] = []
      for (let q = 0; q < qubits; q++) if (q !== q0 && q !== q1) others.push(q)
      for (let subset = 1; subset < 1 << others.length; subset++) {
        const chosen = others.filter((_, k) => ((subset >> k) & 1) === 1)
        for (let assign = 0; assign < 1 << chosen.length; assign++) {
          const controls: ControlSpec[] = chosen.map((qubit, k) => ({
            qubit,
            state: ((assign >> k) & 1) as 0 | 1,
          }))
          expectSameOperator(
            reconstruct(qubits, (state) => {
              applySwap(state, q0, q1, controls)
            }),
            swapDense(qubits, q0, q1, controls),
            `cswap(${q0},${q1})`
          )
        }
      }
    }
  })
})

/* ────────── 10. permutation symmetries a wrong index would break ─────── */

describe('symmetries that hold for the operator, not for the code', () => {
  it('CCZ is invariant under every permutation of its three qubits', () => {
    // CCZ = diag(1,…,1,−1): it phases |111⟩ and nothing else, so which of the
    // three qubits is called "the target" cannot matter. An index slip in the
    // multi-control path would almost certainly break this.
    const qubits = 4
    const trio = [0, 2, 3]
    const reference = reconstruct(qubits, (state) => {
      applyControlled(state, z, trio[0], positive(trio[1], trio[2]))
    })
    for (const [target, a, b] of [
      [trio[1], trio[0], trio[2]],
      [trio[2], trio[0], trio[1]],
      [trio[0], trio[2], trio[1]],
    ]) {
      expectSameOperator(
        reconstruct(qubits, (state) => {
          applyControlled(state, z, target, positive(a, b))
        }),
        reference,
        `ccz target ${target}`
      )
    }
  })

  it('CCZ phases exactly the basis state with all three qubits set', () => {
    for (let index = 0; index < 8; index++) {
      const state = basisState(3, index)
      applyControlled(state, z, 2, positive(0, 1))
      expect(state.re[index], `|${index}⟩`).toBeCloseTo(
        index === 7 ? -1 : 1,
        DIGITS
      )
      expect(state.im[index], `|${index}⟩ imaginary`).toBeCloseTo(0, DIGITS)
    }
  })

  it('CSWAP is invariant under exchanging its two swap targets', () => {
    const forward = reconstruct(5, (state) => {
      applySwap(state, 1, 4, positive(2))
    })
    const reversed = reconstruct(5, (state) => {
      applySwap(state, 4, 1, positive(2))
    })
    expectSameOperator(reversed, forward, 'cswap argument order')
  })

  it('the four assignments of two controls partition the register', () => {
    // Every index satisfies exactly one of the four sign patterns on a pair of
    // control qubits. So the four projectors must sum to the identity, and
    // applying the same gate once under each pattern must equal applying it
    // unconditionally. A mask or value computed wrongly for negative controls
    // would either double-cover or leave a hole, and both show up here.
    const qubits = 4
    const gate = pMatrix(0.83)
    const target = 1
    const patterns: [0 | 1, 0 | 1][] = [
      [0, 0],
      [0, 1],
      [1, 0],
      [1, 1],
    ]
    const asControls = ([sa, sb]: [0 | 1, 0 | 1]): ControlSpec[] => [
      { qubit: 0, state: sa },
      { qubit: 3, state: sb },
    ]

    let sum = metProjector(qubits, asControls(patterns[0]))
    for (let k = 1; k < patterns.length; k++) {
      sum = add(sum, metProjector(qubits, asControls(patterns[k])))
    }
    expectSameOperator(sum, identity(1 << qubits), 'control partition')

    const state = randomState(qubits, 0x8888)
    const expected = clone(state)
    apply1q(expected, gate, target)
    for (const pattern of patterns) {
      applyControlled(state, gate, target, asControls(pattern))
    }
    expectSameState(state, expected, 'four assignments cover the register')
  })
})

/* ─────────── 11. multi-control truth tables by brute enumeration ──────── */

describe('multi-control X truth tables over every basis state', () => {
  const cases: { name: string; target: number; controls: ControlSpec[] }[] = [
    { name: 'C³X, controls 0,1,2 → 3', target: 3, controls: positive(0, 1, 2) },
    { name: 'C³X, controls 1,2,3 → 0', target: 0, controls: positive(1, 2, 3) },
    {
      name: 'mixed C³X, ¬q0 q1 ¬q3 → q2',
      target: 2,
      controls: [
        { qubit: 0, state: 0 },
        { qubit: 1, state: 1 },
        { qubit: 3, state: 0 },
      ],
    },
    {
      name: 'all-negative C³X → q1',
      target: 1,
      controls: [
        { qubit: 0, state: 0 },
        { qubit: 2, state: 0 },
        { qubit: 3, state: 0 },
      ],
    },
  ]

  for (const testCase of cases) {
    it(testCase.name, () => {
      for (let index = 0; index < 16; index++) {
        const met = testCase.controls.every(
          (control) => ((index >> control.qubit) & 1) === control.state
        )
        const state = basisState(4, index)
        applyControlled(state, x, testCase.target, testCase.controls)
        expect(basisIndexOf(state), `|${index}⟩`).toBe(
          met ? index ^ (1 << testCase.target) : index
        )
      }
    })
  }
})

/* ───────────── 12. negative controls through the circuit runner ──────── */

describe('negative controls survive the circuit JSON contract', () => {
  it('cx with a negative control fires on |0⟩ and not on |1⟩', () => {
    for (const [control, target] of [
      [0, 2],
      [2, 0],
    ]) {
      for (const prepared of [0, 1]) {
        const operations: OperationLike[] = []
        if (prepared === 1) {
          operations.push({
            id: 'prep',
            gate: 'x',
            targets: [control],
            column: 0,
          })
        }
        operations.push({
          id: 'cx',
          gate: 'cx',
          targets: [target],
          controls: [{ qubit: control, state: 0 }],
          column: 1,
        })
        const index = prepared === 1 ? 1 << control : 0
        const expected = prepared === 0 ? index ^ (1 << target) : index
        expect(
          basisIndexOf(analyticState({ qubits: 3, operations })),
          `control ${control} prepared |${prepared}⟩`
        ).toBe(expected)
      }
    }
  })

  it('ccx with one negative control matches the definition', () => {
    const controls: ControlSpec[] = [
      { qubit: 0, state: 1 },
      { qubit: 3, state: 0 },
    ]
    const circuit: CircuitLike = {
      qubits: 4,
      operations: [
        { id: 'h0', gate: 'h', targets: [0], column: 0 },
        { id: 'h3', gate: 'h', targets: [3], column: 0 },
        {
          id: 'ccx',
          gate: 'ccx',
          targets: [2],
          controls: [
            { qubit: 0, state: 1 },
            { qubit: 3, state: 0 },
          ],
          column: 1,
        },
      ],
    }
    const reference = alloc(4)
    apply1q(reference, h, 0)
    apply1q(reference, h, 3)
    expectSameState(
      analyticState(circuit),
      applyDense(reference, controlledGateDense(4, x, 2, controls)),
      'ccx with a negative control'
    )
  })

  it('cswap with a negative control matches the definition', () => {
    const controls: ControlSpec[] = [{ qubit: 0, state: 0 }]
    const circuit: CircuitLike = {
      qubits: 4,
      operations: [
        { id: 'h', gate: 'h', targets: [0], column: 0 },
        { id: 'x1', gate: 'x', targets: [1], column: 0 },
        {
          id: 'cswap',
          gate: 'cswap',
          targets: [1, 3],
          controls: [{ qubit: 0, state: 0 }],
          column: 1,
        },
      ],
    }
    const reference = alloc(4)
    apply1q(reference, h, 0)
    apply1q(reference, x, 1)
    expectSameState(
      analyticState(circuit),
      applyDense(reference, swapDense(4, 1, 3, controls)),
      'cswap with a negative control'
    )
  })
})

/* ────────────── 13. the comparisons above have teeth ─────────────────── */

describe('the oracle rejects the wrong answers, not just accepts the right', () => {
  /** Whether two operators differ by more than the D6 tolerance anywhere. */
  function differs(a: Dense, b: Dense): boolean {
    for (let i = 0; i < a.re.length; i++) {
      if (Math.abs(a.re[i] - b.re[i]) > 1e-9) return true
      if (Math.abs(a.im[i] - b.im[i]) > 1e-9) return true
    }
    return false
  }

  const qubits = 4
  const gate = uMatrix(1.02, 0.35, -2.4)
  const target = 1
  const controls: ControlSpec[] = [
    { qubit: 0, state: 1 },
    { qubit: 3, state: 0 },
  ]
  const kernel = reconstruct(qubits, (state) => {
    applyControlled(state, gate, target, controls)
  })

  it('a flipped control sign is a different operator', () => {
    const flipped: ControlSpec[] = controls.map((control) => ({
      qubit: control.qubit,
      state: control.state === 1 ? 0 : 1,
    }))
    expect(
      differs(kernel, controlledGateDense(qubits, gate, target, flipped))
    ).toBe(true)
  })

  it('exchanging a control with the target is a different operator', () => {
    const exchanged: ControlSpec[] = [
      { qubit: target, state: 1 },
      { qubit: 3, state: 0 },
    ]
    expect(
      differs(kernel, controlledGateDense(qubits, gate, 0, exchanged))
    ).toBe(true)
  })

  it('reading the register big-endian is a different operator', () => {
    // The D1 failure mode: qubit q read as bit (n−1−q). If the suite could
    // not tell the two apart, none of the agreements above would mean
    // anything, because a mirrored engine would pass them all.
    const mirrored = controls.map((control) => ({
      qubit: qubits - 1 - control.qubit,
      state: control.state,
    }))
    expect(
      differs(
        kernel,
        controlledGateDense(qubits, gate, qubits - 1 - target, mirrored)
      )
    ).toBe(true)
  })

  it('dropping a control is a different operator', () => {
    expect(
      differs(
        kernel,
        controlledGateDense(qubits, gate, target, controls.slice(0, 1))
      )
    ).toBe(true)
  })
})

/* ──────── 14. loop bounds at a size the dense oracle cannot reach ─────── */

describe('the control walk holds at 16 qubits', () => {
  // 2¹⁶ is 65,536 amplitudes — far past what a 2ⁿ × 2ⁿ oracle can chew, so
  // the reference here is `apply1q` (a different function, with no mask and
  // no control test) plus the definition applied index by index. What this
  // catches that the small registers cannot is a loop bound that only misses
  // when the target sits at the very top or the very bottom of a wide word.
  const qubits = 16

  const placements: {
    name: string
    target: number
    controls: ControlSpec[]
  }[] = [
    {
      name: 'target 0, controls at the top of the word',
      target: 0,
      controls: [
        { qubit: 15, state: 1 },
        { qubit: 14, state: 0 },
      ],
    },
    {
      name: 'target 15, controls at the bottom of the word',
      target: 15,
      controls: [
        { qubit: 0, state: 1 },
        { qubit: 1, state: 0 },
        { qubit: 2, state: 1 },
      ],
    },
    {
      name: 'target 8, controls straddling it',
      target: 8,
      controls: [
        { qubit: 0, state: 0 },
        { qubit: 15, state: 1 },
      ],
    },
  ]

  for (const placement of placements) {
    it(placement.name, () => {
      const gate = uMatrix(1.9, 0.55, -0.8)
      const before = randomState(qubits, 0xabcd + placement.target)

      const bare = clone(before)
      apply1q(bare, gate, placement.target)

      const actual = clone(before)
      applyControlled(actual, gate, placement.target, placement.controls)

      let mask = 0
      let value = 0
      for (const control of placement.controls) {
        mask |= 1 << control.qubit
        if (control.state === 1) value |= 1 << control.qubit
      }

      // One assertion for 65,536 amplitudes: the first disagreement is
      // reported by index, so a failure is still reproducible, and the suite
      // does not pay for a quarter of a million matcher invocations.
      let met = 0
      let firstMismatch = ''
      for (let i = 0; i < actual.size; i++) {
        const fired = (i & mask) === value
        if (fired) met++
        const source = fired ? bare : before
        if (actual.re[i] === source.re[i] && actual.im[i] === source.im[i]) {
          continue
        }
        if (firstMismatch === '') {
          firstMismatch =
            `index ${i} (fired=${fired}): got ` +
            `${actual.re[i]}${actual.im[i] >= 0 ? '+' : ''}${actual.im[i]}i, ` +
            `expected ${source.re[i]}${source.im[i] >= 0 ? '+' : ''}` +
            `${source.im[i]}i`
        }
      }
      expect(firstMismatch).toBe('')
      // Guard the guard: a mask that matched nothing would make the loop
      // above assert only that the state was left alone.
      expect(met).toBe(actual.size >> placement.controls.length)
    })
  }
})

/* ──────────────── 15. controlled SWAP misuse is refused ──────────────── */

describe('controlled SWAP refuses the shapes that would be silent', () => {
  it('rejects a control that is one of the swapped qubits', () => {
    const state = alloc(3)
    expect(() => {
      applySwap(state, 0, 1, positive(1))
    }).toThrow()
    expect(() => {
      applySwap(state, 0, 1, positive(0))
    }).toThrow()
  })

  it('rejects the same control qubit listed twice', () => {
    const state = alloc(4)
    expect(() => {
      applySwap(state, 0, 1, [
        { qubit: 2, state: 1 },
        { qubit: 2, state: 1 },
      ])
    }).toThrow()
  })

  it('leaves the unmet subspace bit-identical', () => {
    const before = randomState(5, 0x9999)
    const actual = clone(before)
    applySwap(actual, 0, 4, [{ qubit: 3, state: 0 }])
    for (let i = 0; i < actual.size; i++) {
      if (((i >> 3) & 1) === 0) continue
      expect(actual.re[i], `re[${i}]`).toBe(before.re[i])
      expect(actual.im[i], `im[${i}]`).toBe(before.im[i])
    }
  })
})
