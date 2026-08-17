/**
 * INDEPENDENT VERIFICATION — lens: wasm-agreement, part four.
 *
 * WHY THIS FILE EXISTS. `apply.ts` and `crate/src/kernel.rs` share a loop
 * structure on purpose — the Rust is a transliteration of the TypeScript — so
 * comparing them to each other proves the transcription was faithful and
 * nothing more. A pairing that is wrong in the *same* way on both sides, or an
 * endianness convention applied consistently backwards, is invisible to that
 * comparison: both engines would return the same wrong state.
 *
 * So this file compares both of them against the thing §5.2 tells you never to
 * build: the full 2ⁿ × 2ⁿ operator, assembled column by column straight from
 * the definition of what a gate does to a basis state, and applied by an
 * O(4ⁿ) matrix–vector product. That is the slow, obviously-correct method. It
 * is unusable above five qubits, which is exactly why the engine does not use
 * it, and perfectly usable as an oracle below five.
 *
 * The dense operator is built with no reference to `base`, `offset`, `stride`
 * or any other quantity the two engines share. It uses only:
 *
 *   D1 — amplitude index `i` holds qubit `q` in bit `q`
 *   the 2×2 read as `M[row][col]`, row and column being the target bit
 *   a control condition as a filter on the *input* basis index
 */

import { describe, expect, it } from 'vitest'

import {
  GATE_MATRICES,
  acceleratedApplyControlled,
  acceleratedApplyISwap,
  acceleratedApplySwap,
  alloc,
  applyControlled,
  applyISwap,
  applySwap,
  createRng,
  installStatevectorKernel,
  matrixFor,
  uninstallStatevectorKernel,
  type ControlSpec,
  type Matrix2,
  type Statevector,
} from '@qsim/core'

import { createKernel } from '../../kernel.js'
import { createSession } from '../../session.js'
import { createTransliteratedExports } from './rust-transliteration.js'

/** A dense complex operator, row-major, real and imaginary parts apart. */
interface Dense {
  readonly size: number
  readonly re: Float64Array
  readonly im: Float64Array
}

function identity(size: number): Dense {
  const re = new Float64Array(size * size)
  const im = new Float64Array(size * size)
  for (let i = 0; i < size; i++) re[i * size + i] = 1
  return { size, re, im }
}

/**
 * The full operator for a 2×2 on `target` under `controls`, built one input
 * basis state at a time.
 *
 * For input |j⟩: if the controls do not admit `j` the gate is the identity on
 * it. Otherwise let `b` be the target bit of `j`; the gate sends |j⟩ to
 * `M[0][b]·|j with bit t = 0⟩ + M[1][b]·|j with bit t = 1⟩`, which is the
 * definition of applying a 2×2 in the {|0⟩, |1⟩} basis of that qubit and is
 * where D1 enters — nowhere else.
 */
function denseControlled(
  qubits: number,
  matrix: Matrix2,
  target: number,
  controls: readonly ControlSpec[]
): Dense {
  const size = 1 << qubits
  const operator = identity(size)
  let mask = 0
  let value = 0
  for (const control of controls) {
    mask |= 1 << control.qubit
    if (control.state === 1) value |= 1 << control.qubit
  }

  const bit = 1 << target
  for (let column = 0; column < size; column++) {
    if ((column & mask) !== value) continue
    const b = (column & bit) === 0 ? 0 : 1
    const zero = column & ~bit
    const one = column | bit
    // The gate replaces the identity column, so clear it first.
    operator.re[column * size + column] = 0
    operator.im[column * size + column] = 0
    // M[row][col] lives at (row * 2 + col) * 2 in the eight-double layout.
    operator.re[zero * size + column] = matrix[(0 * 2 + b) * 2]
    operator.im[zero * size + column] = matrix[(0 * 2 + b) * 2 + 1]
    operator.re[one * size + column] = matrix[(1 * 2 + b) * 2]
    operator.im[one * size + column] = matrix[(1 * 2 + b) * 2 + 1]
  }
  return operator
}

/** SWAP as a permutation of basis states, under an optional control. */
function denseSwap(
  qubits: number,
  q0: number,
  q1: number,
  controls: readonly ControlSpec[]
): Dense {
  const size = 1 << qubits
  const operator = identity(size)
  let mask = 0
  let value = 0
  for (const control of controls) {
    mask |= 1 << control.qubit
    if (control.state === 1) value |= 1 << control.qubit
  }
  const bit0 = 1 << q0
  const bit1 = 1 << q1
  for (let column = 0; column < size; column++) {
    if ((column & mask) !== value) continue
    const b0 = (column & bit0) === 0 ? 0 : 1
    const b1 = (column & bit1) === 0 ? 0 : 1
    if (b0 === b1) continue
    const swapped = column ^ bit0 ^ bit1
    operator.re[column * size + column] = 0
    operator.re[swapped * size + column] = 1
  }
  return operator
}

/** iSWAP: the same permutation, with a factor of i on the moved amplitudes. */
function denseISwap(qubits: number, q0: number, q1: number): Dense {
  const size = 1 << qubits
  const operator = identity(size)
  const bit0 = 1 << q0
  const bit1 = 1 << q1
  for (let column = 0; column < size; column++) {
    const b0 = (column & bit0) === 0 ? 0 : 1
    const b1 = (column & bit1) === 0 ? 0 : 1
    if (b0 === b1) continue
    const swapped = column ^ bit0 ^ bit1
    operator.re[column * size + column] = 0
    operator.im[swapped * size + column] = 1
  }
  return operator
}

/** ψ' = U ψ, the O(4ⁿ) way, with no structure exploited. */
function denseApply(operator: Dense, state: Statevector): Statevector {
  const size = state.size
  const out = alloc(state.qubits)
  for (let row = 0; row < size; row++) {
    let sumR = 0
    let sumI = 0
    for (let column = 0; column < size; column++) {
      const mr = operator.re[row * size + column]
      const mi = operator.im[row * size + column]
      const ar = state.re[column]
      const ai = state.im[column]
      sumR += mr * ar - mi * ai
      sumI += mr * ai + mi * ar
    }
    out.re[row] = sumR
    out.im[row] = sumI
  }
  return out
}

function worst(a: Statevector, b: Statevector): number {
  let value = 0
  for (let i = 0; i < a.size; i++) {
    if (Number.isNaN(a.re[i]) !== Number.isNaN(b.re[i])) return Infinity
    if (Number.isNaN(a.im[i]) !== Number.isNaN(b.im[i])) return Infinity
    const dre = Math.abs(a.re[i] - b.re[i])
    const dim = Math.abs(a.im[i] - b.im[i])
    if (dre > value) value = dre
    if (dim > value) value = dim
  }
  return value
}

/** A dense random state, and the same doubles inside linear memory. */
function seeded(qubits: number, seed: number) {
  const session = createSession(createTransliteratedExports())
  installStatevectorKernel(createKernel(session))
  const handle = session.allocState(qubits)
  if (handle === undefined) throw new Error('the transliteration refused')
  const heap = alloc(qubits)
  const rng = createRng(seed)
  let sum = 0
  for (let i = 0; i < heap.size; i++) {
    const re = rng.next() * 2 - 1
    const im = rng.next() * 2 - 1
    heap.re[i] = re
    heap.im[i] = im
    sum += re * re + im * im
  }
  const scale = 1 / Math.sqrt(sum)
  const wasm = handle.statevector
  for (let i = 0; i < heap.size; i++) {
    heap.re[i] *= scale
    heap.im[i] *= scale
    wasm.re[i] = heap.re[i]
    wasm.im[i] = heap.im[i]
  }
  const before = alloc(qubits)
  before.re.set(heap.re)
  before.im.set(heap.im)
  return {
    heap,
    before,
    wasm: () => handle.statevector,
    done: () => {
      handle.release()
      session.dispose()
      uninstallStatevectorKernel()
    },
  }
}

/**
 * Both engines against the dense operator. `1e-14` rather than 0: the oracle
 * sums 2ⁿ terms per row where the engines sum two, and although the extra
 * terms are exact zeros the association is not guaranteed to match.
 */
const ORACLE_TOLERANCE = 1e-14

describe('both engines against a dense 2ⁿ × 2ⁿ operator', () => {
  it('agrees on every fixed gate at every target, 1 to 5 qubits', () => {
    for (let qubits = 1; qubits <= 5; qubits++) {
      for (const gate of [
        'i',
        'x',
        'y',
        'z',
        'h',
        's',
        'sdg',
        't',
        'tdg',
        'sx',
      ] as const) {
        for (let target = 0; target < qubits; target++) {
          const run = seeded(qubits, 0x2024 + target)
          try {
            const oracle = denseApply(
              denseControlled(qubits, GATE_MATRICES[gate], target, []),
              run.before
            )
            applyControlled(run.heap, GATE_MATRICES[gate], target, [])
            acceleratedApplyControlled(
              run.wasm(),
              GATE_MATRICES[gate],
              target,
              []
            )
            expect(
              worst(run.heap, oracle),
              `TS ${gate}@${target}`
            ).toBeLessThan(ORACLE_TOLERANCE)
            expect(
              worst(run.wasm(), oracle),
              `WASM ${gate}@${target}`
            ).toBeLessThan(ORACLE_TOLERANCE)
          } finally {
            run.done()
          }
        }
      }
    }
  })

  it('agrees on parametrised gates, including at extreme angles', () => {
    const angles = [0, Math.PI / 3, -Math.PI, 2 * Math.PI, 1e-300, 1e15]
    for (const gate of ['rx', 'ry', 'rz', 'p'] as const) {
      for (const theta of angles) {
        const matrix = matrixFor(gate, [theta])
        const run = seeded(4, 0x77)
        try {
          const oracle = denseApply(
            denseControlled(4, matrix, 2, []),
            run.before
          )
          applyControlled(run.heap, matrix, 2, [])
          acceleratedApplyControlled(run.wasm(), matrix, 2, [])
          expect(worst(run.heap, oracle), `TS ${gate}(${theta})`).toBeLessThan(
            ORACLE_TOLERANCE
          )
          expect(
            worst(run.wasm(), oracle),
            `WASM ${gate}(${theta})`
          ).toBeLessThan(ORACLE_TOLERANCE)
        } finally {
          run.done()
        }
      }
    }
    // `u` is the only gate whose 2×2 has all four entries complex, so it is
    // the one that would expose a transposed or conjugated read of the layout.
    for (const params of [
      [Math.PI / 5, Math.PI / 7, -Math.PI / 3],
      [Math.PI, 0, Math.PI],
      [1e-300, 1e15, -1e15],
    ]) {
      const matrix = matrixFor('u', params)
      const run = seeded(4, 0x88)
      try {
        const oracle = denseApply(denseControlled(4, matrix, 1, []), run.before)
        applyControlled(run.heap, matrix, 1, [])
        acceleratedApplyControlled(run.wasm(), matrix, 1, [])
        expect(worst(run.heap, oracle)).toBeLessThan(ORACLE_TOLERANCE)
        expect(worst(run.wasm(), oracle)).toBeLessThan(ORACLE_TOLERANCE)
      } finally {
        run.done()
      }
    }
  })

  it('agrees on controlled gates, positive, negative and doubled', () => {
    const qubits = 4
    const shapes: readonly ControlSpec[][] = [
      [{ qubit: 0, state: 1 }],
      [{ qubit: 0, state: 0 }],
      [{ qubit: 3, state: 1 }],
      [
        { qubit: 0, state: 1 },
        { qubit: 3, state: 0 },
      ],
    ]
    // A complex-valued matrix under a control mask — the shape the package's
    // own equivalence drawer never produces.
    const matrices: readonly [string, Matrix2][] = [
      ['x', GATE_MATRICES.x],
      ['y', GATE_MATRICES.y],
      ['t', GATE_MATRICES.t],
      ['rz', matrixFor('rz', [Math.PI / 3])],
      ['p', matrixFor('p', [-Math.PI / 4])],
      ['u', matrixFor('u', [0.3, 0.7, -1.1])],
    ]
    for (const controls of shapes) {
      for (const [label, matrix] of matrices) {
        for (let target = 0; target < qubits; target++) {
          if (controls.some((c) => c.qubit === target)) continue
          const run = seeded(qubits, 0x1357)
          try {
            const oracle = denseApply(
              denseControlled(qubits, matrix, target, controls),
              run.before
            )
            applyControlled(run.heap, matrix, target, controls)
            acceleratedApplyControlled(run.wasm(), matrix, target, controls)
            const where = `c${label}@${target} ${JSON.stringify(controls)}`
            expect(worst(run.heap, oracle), `TS ${where}`).toBeLessThan(
              ORACLE_TOLERANCE
            )
            expect(worst(run.wasm(), oracle), `WASM ${where}`).toBeLessThan(
              ORACLE_TOLERANCE
            )
          } finally {
            run.done()
          }
        }
      }
    }
  })

  it('agrees on swap, cswap and iswap', () => {
    const qubits = 4
    for (let q0 = 0; q0 < qubits; q0++) {
      for (let q1 = 0; q1 < qubits; q1++) {
        if (q0 === q1) continue
        const control = [0, 1, 2, 3].find((q) => q !== q0 && q !== q1) as number
        for (const controls of [
          [],
          [{ qubit: control, state: 1 as const }],
          [{ qubit: control, state: 0 as const }],
        ]) {
          const run = seeded(qubits, 0x2468 + q0 * 4 + q1)
          try {
            const oracle = denseApply(
              denseSwap(qubits, q0, q1, controls),
              run.before
            )
            applySwap(run.heap, q0, q1, controls)
            acceleratedApplySwap(run.wasm(), q0, q1, controls)
            expect(worst(run.heap, oracle)).toBeLessThan(ORACLE_TOLERANCE)
            expect(worst(run.wasm(), oracle)).toBeLessThan(ORACLE_TOLERANCE)
          } finally {
            run.done()
          }
        }

        const run = seeded(qubits, 0x9753 + q0 * 4 + q1)
        try {
          const oracle = denseApply(denseISwap(qubits, q0, q1), run.before)
          applyISwap(run.heap, q0, q1)
          acceleratedApplyISwap(run.wasm(), q0, q1)
          expect(worst(run.heap, oracle), `TS iswap ${q0},${q1}`).toBeLessThan(
            ORACLE_TOLERANCE
          )
          expect(
            worst(run.wasm(), oracle),
            `WASM iswap ${q0},${q1}`
          ).toBeLessThan(ORACLE_TOLERANCE)
        } finally {
          run.done()
        }
      }
    }
  })
})
