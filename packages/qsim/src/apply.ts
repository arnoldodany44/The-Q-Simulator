/**
 * The application kernel — specification §5.2. This is the hot path of the
 * whole product: everything else in Phase 0 is a wrapper around these loops.
 *
 * NEVER BUILD THE FULL MATRIX. The textbook way to apply a one-qubit gate
 * inside an n-qubit system is to form `I ⊗ … ⊗ M ⊗ … ⊗ I` and multiply. That
 * matrix has 4ⁿ entries, almost all of them zero, and multiplying by it costs
 * O(4ⁿ): at 20 qubits it is a trillion multiplications of which a million
 * matter. Nothing in this file allocates a Kronecker product, and nothing
 * ever should.
 *
 * ────────────────────────────────────────────────────────────────────────
 * INDEX PAIRING — derived once here, so the next reader can check the loops
 * instead of re-deriving them.
 *
 * A statevector index `i` is the binary word of the qubit values, with qubit
 * q sitting at bit q (decision D1, `conventions.ts`). Split that word around
 * the target bit `t`:
 *
 *     i = high · 2^(t+1)  +  b · 2^t  +  low
 *
 * where `high` is the qubits above t, `b ∈ {0,1}` is qubit t itself, and
 * `low < 2^t` is the qubits below t.
 *
 * A gate on qubit t mixes exactly the two amplitudes that share `high` and
 * `low` and differ in `b`. Every other qubit is a spectator — which is all
 * that `I ⊗ M ⊗ I` ever said, and it says it without being built.
 *
 * So the pairs are `(i₀, i₀ + 2^t)` over the indices with bit t clear, and
 * they are enumerated with two counters and no arithmetic per index:
 *
 *     stride = 2^t                                 // weight of the target bit
 *     for base = 0, 2·stride, 4·stride, … < size   // enumerates `high`
 *       for offset = 0 … stride-1                  // enumerates `low`
 *         i₀ = base + offset                       // b = 0
 *         i₁ = i₀ + stride                         // b = 1
 *
 * Every index is hit exactly once: `base` contributes only bits above t,
 * `offset` only bits below t, and the two sets of bits are disjoint. Cost is
 * 2ⁿ reads and 2ⁿ writes per gate, with zero allocation.
 *
 * Worked example — 3 qubits (8 amplitudes), target t = 1, so stride = 2.
 * `base` takes 0 and 4, `offset` takes 0 and 1, and the pairs are
 *
 *     (0, 2)   |000⟩ ↔ |010⟩        (4, 6)   |100⟩ ↔ |110⟩
 *     (1, 3)   |001⟩ ↔ |011⟩        (5, 7)   |101⟩ ↔ |111⟩
 *
 * — every index once, and each pair differs exactly in qubit 1. Kets are
 * printed highest-qubit-first, as in `conventions.ts`.
 *
 * A two-qubit gate splits the word at two points instead of one, so it takes
 * three nested loops (above the higher bit / between the two / below the
 * lower bit) and the group is `base, base+2^q0, base+2^q1, base+2^q0+2^q1`.
 *
 * BASIS ORDER OF A 4×4. Row and column index is `2·b₁ + b₀`, where b₀ is the
 * bit of the **first** qubit argument. The first argument is the less
 * significant one, which is D1 applied locally, so a two-qubit gate written
 * for qubits (0,1) of a two-qubit system is the same matrix as the one
 * written for the whole statevector. Getting this backwards transposes SWAP
 * (which is symmetric, so it hides) and breaks CNOT (which is not).
 *
 * CONTROLS. A control is a filter on the index, not a bigger matrix. Fold the
 * controls into two integers once per gate — `mask`, the bits that are
 * examined, and `value`, what those bits must equal — and the whole condition
 * becomes `(i & mask) === value`. Negative controls come out for free: they
 * are the bits present in `mask` and absent from `value`.
 *
 * COVERAGE. Every gate in the contract reaches the state through one of the
 * five functions below:
 *
 *   i x y z h s sdg t tdg sx rx ry rz p u   apply1q  (applyControlled if the
 *                                           user added controls)
 *   cx cz crz cp ccx                        applyControlled
 *   swap cswap                              applySwap
 *   iswap                                   applyISwap
 *   an arbitrary two-qubit unitary          apply2q
 *
 * `barrier`, `reset` and `measure` are not unitary and are not this file's
 * business — they belong to the runner (M0.4) and to measurement (M0.3).
 */

import type { Matrix2, Matrix4 } from './gates.js'
import type { Statevector } from './statevector.js'

/**
 * A control qubit and the value it must read for the gate to fire.
 *
 * `state: 0` is a negative control (§3.1). Structurally identical to
 * `@qsim/schema`'s `ControlSpec`, so `controlsOf(operation)` can be passed
 * straight in; it is redeclared rather than imported because this package has
 * no dependencies (§12.3). Bare-number controls are not accepted here —
 * normalise them at the contract boundary, where the default lives.
 */
export interface ControlSpec {
  readonly qubit: number
  readonly state: 0 | 1
}

const NO_CONTROLS: readonly ControlSpec[] = []

/**
 * Apply a 2×2 gate to `target`, in place.
 *
 * The eight matrix entries are read into locals before the loop: inside it
 * they are compared and multiplied 2ⁿ⁻¹ times, and a typed-array load per use
 * would dominate the arithmetic.
 */
export function apply1q(
  state: Statevector,
  matrix: Matrix2,
  target: number
): void {
  checkQubit(state, target, 'target')
  checkMatrix(matrix, 8)

  const { re, im, size } = state
  const m00r = matrix[0]
  const m00i = matrix[1]
  const m01r = matrix[2]
  const m01i = matrix[3]
  const m10r = matrix[4]
  const m10i = matrix[5]
  const m11r = matrix[6]
  const m11i = matrix[7]

  const stride = 1 << target
  for (let base = 0; base < size; base += stride << 1) {
    for (let offset = 0; offset < stride; offset++) {
      const i0 = base + offset
      const i1 = i0 + stride
      const a0r = re[i0]
      const a0i = im[i0]
      const a1r = re[i1]
      const a1i = im[i1]
      re[i0] = m00r * a0r - m00i * a0i + (m01r * a1r - m01i * a1i)
      im[i0] = m00r * a0i + m00i * a0r + (m01r * a1i + m01i * a1r)
      re[i1] = m10r * a0r - m10i * a0i + (m11r * a1r - m11i * a1i)
      im[i1] = m10r * a0i + m10i * a0r + (m11r * a1i + m11i * a1r)
    }
  }
}

/**
 * Apply a 2×2 gate to `target`, but only on the indices where every control
 * reads its required value. Same walk as `apply1q` plus one `&` and one
 * comparison per pair; the skipped pairs keep their amplitudes untouched,
 * which is exactly what a controlled gate does to them.
 *
 * Testing `i₀` is enough even though the pair is `(i₀, i₁)`: the two differ
 * only in the target bit, and a control may not be the target.
 *
 * With no controls this is `apply1q`, and it delegates rather than repeating
 * the walk, so the runner can call it unconditionally without paying for the
 * mask test when a gate has no controls.
 */
export function applyControlled(
  state: Statevector,
  matrix: Matrix2,
  target: number,
  controls: readonly ControlSpec[]
): void {
  checkQubit(state, target, 'target')
  checkMatrix(matrix, 8)
  checkControls(state, controls, target)
  if (controls.length === 0) {
    apply1q(state, matrix, target)
    return
  }

  const mask = controlMask(controls)
  const value = controlValue(controls)

  const { re, im, size } = state
  const m00r = matrix[0]
  const m00i = matrix[1]
  const m01r = matrix[2]
  const m01i = matrix[3]
  const m10r = matrix[4]
  const m10i = matrix[5]
  const m11r = matrix[6]
  const m11i = matrix[7]

  const stride = 1 << target
  for (let base = 0; base < size; base += stride << 1) {
    for (let offset = 0; offset < stride; offset++) {
      const i0 = base + offset
      if ((i0 & mask) !== value) continue
      const i1 = i0 + stride
      const a0r = re[i0]
      const a0i = im[i0]
      const a1r = re[i1]
      const a1i = im[i1]
      re[i0] = m00r * a0r - m00i * a0i + (m01r * a1r - m01i * a1i)
      im[i0] = m00r * a0i + m00i * a0r + (m01r * a1i + m01i * a1r)
      re[i1] = m10r * a0r - m10i * a0i + (m11r * a1r - m11i * a1i)
      im[i1] = m10r * a0i + m10i * a0r + (m11r * a1i + m11i * a1r)
    }
  }
}

/**
 * Apply an arbitrary 4×4 to the pair `(q0, q1)`, in place. Row order is
 * `2·b₁ + b₀` — see BASIS ORDER in the header.
 *
 * This one keeps its row/column loop instead of unrolling sixteen complex
 * products: every two-qubit gate in the contract has a specialised path
 * below, so this is the escape hatch for custom unitaries rather than the hot
 * path, and sixty lines of hand-unrolled arithmetic here would be sixty lines
 * nobody can review. The scratch buffers are allocated once per gate, so the
 * O(2ⁿ) part of the function still allocates nothing.
 */
export function apply2q(
  state: Statevector,
  matrix: Matrix4,
  q0: number,
  q1: number
): void {
  checkQubit(state, q0, 'target')
  checkQubit(state, q1, 'target')
  checkDistinct(q0, q1)
  checkMatrix(matrix, 32)

  const { re, im, size } = state
  const bit0 = 1 << q0
  const bit1 = 1 << q1
  const lower = Math.min(bit0, bit1)
  const upper = Math.max(bit0, bit1)

  const index = new Int32Array(4)
  const inR = new Float64Array(4)
  const inI = new Float64Array(4)
  const outR = new Float64Array(4)
  const outI = new Float64Array(4)

  for (let upperBase = 0; upperBase < size; upperBase += upper << 1) {
    for (let middle = 0; middle < upper; middle += lower << 1) {
      for (let offset = 0; offset < lower; offset++) {
        const base = upperBase + middle + offset
        index[0] = base
        index[1] = base + bit0
        index[2] = base + bit1
        index[3] = base + bit0 + bit1

        for (let k = 0; k < 4; k++) {
          inR[k] = re[index[k]]
          inI[k] = im[index[k]]
        }
        for (let row = 0; row < 4; row++) {
          let sumR = 0
          let sumI = 0
          for (let column = 0; column < 4; column++) {
            const at = (row * 4 + column) * 2
            const mr = matrix[at]
            const mi = matrix[at + 1]
            sumR += mr * inR[column] - mi * inI[column]
            sumI += mr * inI[column] + mi * inR[column]
          }
          outR[row] = sumR
          outI[row] = sumI
        }
        for (let k = 0; k < 4; k++) {
          re[index[k]] = outR[k]
          im[index[k]] = outI[k]
        }
      }
    }
  }
}

/**
 * SWAP `q0` and `q1`, optionally controlled (that is `cswap`).
 *
 * SWAP through `apply2q` would be sixteen complex products per group to
 * compute a permutation. It is instead one exchange of the `|01⟩` and `|10⟩`
 * amplitudes: `|00⟩` and `|11⟩` are already symmetric, so three quarters of
 * the state is not touched at all.
 */
export function applySwap(
  state: Statevector,
  q0: number,
  q1: number,
  controls: readonly ControlSpec[] = NO_CONTROLS
): void {
  checkQubit(state, q0, 'target')
  checkQubit(state, q1, 'target')
  checkDistinct(q0, q1)
  checkControls(state, controls, q0, q1)

  const mask = controlMask(controls)
  const value = controlValue(controls)
  const { re, im, size } = state
  const bit0 = 1 << q0
  const bit1 = 1 << q1
  const lower = Math.min(bit0, bit1)
  const upper = Math.max(bit0, bit1)

  for (let upperBase = 0; upperBase < size; upperBase += upper << 1) {
    for (let middle = 0; middle < upper; middle += lower << 1) {
      for (let offset = 0; offset < lower; offset++) {
        const base = upperBase + middle + offset
        if ((base & mask) !== value) continue
        const i01 = base + bit0
        const i10 = base + bit1
        const a01r = re[i01]
        const a01i = im[i01]
        re[i01] = re[i10]
        im[i01] = im[i10]
        re[i10] = a01r
        im[i10] = a01i
      }
    }
  }
}

/**
 * iSWAP: exchange `q0` and `q1` and multiply the exchanged amplitudes by `i`.
 * Multiplying by `i` is `(x, y) → (-y, x)`, so this too is bookkeeping rather
 * than arithmetic.
 *
 * No `controls` parameter: the contract has no controlled iSWAP
 * (`GATES.iswap.acceptsControls === false`), and an unused parameter here
 * would suggest the editor can produce one.
 */
export function applyISwap(state: Statevector, q0: number, q1: number): void {
  checkQubit(state, q0, 'target')
  checkQubit(state, q1, 'target')
  checkDistinct(q0, q1)

  const { re, im, size } = state
  const bit0 = 1 << q0
  const bit1 = 1 << q1
  const lower = Math.min(bit0, bit1)
  const upper = Math.max(bit0, bit1)

  for (let upperBase = 0; upperBase < size; upperBase += upper << 1) {
    for (let middle = 0; middle < upper; middle += lower << 1) {
      for (let offset = 0; offset < lower; offset++) {
        const base = upperBase + middle + offset
        const i01 = base + bit0
        const i10 = base + bit1
        const a01r = re[i01]
        const a01i = im[i01]
        const a10r = re[i10]
        const a10i = im[i10]
        // new a₀₁ = i·a₁₀ and new a₁₀ = i·a₀₁.
        re[i01] = -a10i
        im[i01] = a10r
        re[i10] = -a01i
        im[i10] = a01r
      }
    }
  }
}

/** Bits the control condition examines. */
function controlMask(controls: readonly ControlSpec[]): number {
  let mask = 0
  for (const control of controls) mask |= 1 << control.qubit
  return mask
}

/** What those bits must equal: 1 for a positive control, 0 for a negative. */
function controlValue(controls: readonly ControlSpec[]): number {
  let value = 0
  for (const control of controls) {
    if (control.state === 1) value |= 1 << control.qubit
  }
  return value
}

/*
 * The four guards below are exported for `kernel.ts` and for nothing else.
 * They are absent from `index.ts` on purpose: they are not API, they are the
 * shared definition of "this call is well formed", and the optional WASM
 * accelerator has to apply exactly that definition — same conditions, same
 * `RangeError` messages — before it is offered a gate. Reimplementing them on
 * the other side of a language boundary is how the two would drift.
 */

export function checkQubit(
  state: Statevector,
  qubit: number,
  role: string
): void {
  if (!Number.isInteger(qubit) || qubit < 0 || qubit >= state.qubits) {
    throw new RangeError(
      `${role} qubit ${qubit} is outside [0, ${state.qubits}).`
    )
  }
}

export function checkDistinct(q0: number, q1: number): void {
  if (q0 === q1) {
    throw new RangeError(
      `A two-qubit gate needs two different qubits, got ${q0} twice.`
    )
  }
}

export function checkMatrix(matrix: Float64Array, expected: number): void {
  if (matrix.length !== expected) {
    throw new RangeError(
      `Expected a matrix of ${expected} doubles, got ${matrix.length}. ` +
        `See the layout in gates.ts.`
    )
  }
}

/**
 * Reject the control shapes whose behaviour would otherwise be silent
 * nonsense: a control on a target qubit (the gate would have to be applied
 * and skipped at once) and the same qubit controlled twice (two conditions
 * that the mask/value pair cannot both represent).
 */
export function checkControls(
  state: Statevector,
  controls: readonly ControlSpec[],
  ...targets: number[]
): void {
  let seen = 0
  for (const control of controls) {
    checkQubit(state, control.qubit, 'control')
    if (targets.includes(control.qubit)) {
      throw new RangeError(
        `Qubit ${control.qubit} is both a control and a target.`
      )
    }
    const bit = 1 << control.qubit
    if ((seen & bit) !== 0) {
      throw new RangeError(`Qubit ${control.qubit} is controlled twice.`)
    }
    seen |= bit
  }
}
