/**
 * A deliberately slow, obviously-correct reference for the validator's
 * mathematics.
 *
 * Nothing here imports `@qsim/core`. Every matrix is written out from the
 * textbook definition, every operator is built as a full 2ⁿ × 2ⁿ dense matrix,
 * and circuits are evaluated by multiplying those matrices in time order. It is
 * O(8ⁿ) per gate and it is meant to be: the point of this file is that a reader
 * can check it against a textbook line by line, so that when it disagrees with
 * `challenges/validate.ts` the disagreement is evidence rather than noise.
 *
 * Conventions taken from the specification, not from the engine:
 *   D1 little-endian — basis index i has qubit q equal to `(i >> q) & 1`.
 *   Fidelity is the SQUARED convention: F(ψ, φ) = |⟨ψ|φ⟩|².
 */

export interface Cx {
  readonly re: number
  readonly im: number
}

export const c = (re: number, im = 0): Cx => ({ re, im })

const add = (a: Cx, b: Cx): Cx => c(a.re + b.re, a.im + b.im)
const mul = (a: Cx, b: Cx): Cx =>
  c(a.re * b.re - a.im * b.im, a.re * b.im + a.im * b.re)
const conj = (a: Cx): Cx => c(a.re, -a.im)

/** A dense matrix in row-major order: `m[row][col]`. */
export type Matrix = Cx[][]

/**
 * Entry (row, col). The index is always in range by construction; the cast is
 * what `noUncheckedIndexedAccess` costs and it is the same one `@qsim/core`
 * makes in its own kernels.
 */
export function at(matrix: Matrix, row: number, col: number): Cx {
  return (matrix[row] as Cx[])[col] as Cx
}

const SQRT_HALF = Math.SQRT1_2

/** The one-qubit gates this file needs, straight from the textbook. */
const SINGLE: Readonly<Record<string, Matrix>> = {
  i: [
    [c(1), c(0)],
    [c(0), c(1)],
  ],
  x: [
    [c(0), c(1)],
    [c(1), c(0)],
  ],
  y: [
    [c(0), c(0, -1)],
    [c(0, 1), c(0)],
  ],
  z: [
    [c(1), c(0)],
    [c(0), c(-1)],
  ],
  h: [
    [c(SQRT_HALF), c(SQRT_HALF)],
    [c(SQRT_HALF), c(-SQRT_HALF)],
  ],
  s: [
    [c(1), c(0)],
    [c(0), c(0, 1)],
  ],
  sdg: [
    [c(1), c(0)],
    [c(0), c(0, -1)],
  ],
  t: [
    [c(1), c(0)],
    [c(0), c(SQRT_HALF, SQRT_HALF)],
  ],
  tdg: [
    [c(1), c(0)],
    [c(0), c(SQRT_HALF, -SQRT_HALF)],
  ],
}

export function identity(dim: number): Matrix {
  return Array.from({ length: dim }, (_row, r) =>
    Array.from({ length: dim }, (_col, k) => (r === k ? c(1) : c(0)))
  )
}

/** A · B, the schoolbook product. */
export function matmul(a: Matrix, b: Matrix): Matrix {
  const dim = a.length
  return Array.from({ length: dim }, (_row, r) =>
    Array.from({ length: dim }, (_col, k) => {
      let sum = c(0)
      for (let m = 0; m < dim; m++)
        sum = add(sum, mul(at(a, r, m), at(b, m, k)))
      return sum
    })
  )
}

export function matvec(a: Matrix, v: readonly Cx[]): Cx[] {
  return a.map((row) => {
    let sum = c(0)
    for (let k = 0; k < row.length; k++) {
      sum = add(sum, mul(row[k] as Cx, v[k] as Cx))
    }
    return sum
  })
}

const bit = (index: number, q: number): number => (index >> q) & 1

/** A control wire and the value it fires on, as `[qubit, state]`. */
export type ControlPair = readonly [number, number]

/**
 * A one-qubit matrix acting on wire `target`, optionally controlled on
 * `controls`, embedded in a 2ⁿ × 2ⁿ operator.
 *
 * Written as the definition reads: on the subspace where the controls do not
 * match, the operator is the identity; where they do, it is `gate` on the
 * target wire and the identity on every other wire.
 */
export function embed(
  qubits: number,
  gate: Matrix,
  target: number,
  controls: readonly ControlPair[] = []
): Matrix {
  const dim = 2 ** qubits
  const matches = (index: number): boolean =>
    controls.every(([q, state]) => bit(index, q) === state)
  const out: Matrix = []
  for (let row = 0; row < dim; row++) {
    const line: Cx[] = []
    for (let col = 0; col < dim; col++) {
      if (!matches(col) || !matches(row)) {
        line.push(row === col && !matches(col) ? c(1) : c(0))
        continue
      }
      // Both inside the controlled subspace: everything but the target wire
      // has to agree, and the target entry comes from the 2 × 2 matrix.
      const rest = (row ^ col) & ~(1 << target)
      line.push(
        rest === 0 ? at(gate, bit(row, target), bit(col, target)) : c(0)
      )
    }
    out.push(line)
  }
  return out
}

/** The permutation that exchanges wires `a` and `b`. */
export function embedSwap(qubits: number, a: number, b: number): Matrix {
  const dim = 2 ** qubits
  const swapped = (index: number): number => {
    const ba = bit(index, a)
    const bb = bit(index, b)
    let out = index & ~((1 << a) | (1 << b))
    out |= bb << a
    out |= ba << b
    return out
  }
  return Array.from({ length: dim }, (_row, r) =>
    Array.from({ length: dim }, (_col, k) => (swapped(k) === r ? c(1) : c(0)))
  )
}

/** One step of a reference circuit, in the vocabulary this file understands. */
export interface Step {
  readonly gate: string
  readonly targets: readonly number[]
  readonly controls?: readonly ControlPair[]
}

/** The dense operator one step contributes. */
export function stepMatrix(qubits: number, step: Step): Matrix {
  const first = step.targets[0] as number
  if (step.gate === 'swap') {
    return embedSwap(qubits, first, step.targets[1] as number)
  }
  const controls = step.controls ?? []
  if (step.gate === 'cx' || step.gate === 'ccx') {
    return embed(qubits, SINGLE.x as Matrix, first, controls)
  }
  if (step.gate === 'cz') {
    return embed(qubits, SINGLE.z as Matrix, first, controls)
  }
  const single = SINGLE[step.gate]
  if (single === undefined) {
    throw new Error(`The reference has no matrix for "${step.gate}".`)
  }
  return embed(qubits, single, first, controls)
}

/**
 * The matrix a list of steps implements, applied in time order — so the step
 * written first is the one closest to the ket, exactly as U = Uₙ···U₁.
 */
export function circuitMatrix(qubits: number, steps: readonly Step[]): Matrix {
  let out = identity(2 ** qubits)
  for (const step of steps) out = matmul(stepMatrix(qubits, step), out)
  return out
}

/** |index⟩ on `qubits` wires. */
export function basis(qubits: number, index: number): Cx[] {
  return Array.from({ length: 2 ** qubits }, (_value, i) =>
    i === index ? c(1) : c(0)
  )
}

/** The state a list of steps prepares from |0…0⟩. */
export function finalState(qubits: number, steps: readonly Step[]): Cx[] {
  return matvec(circuitMatrix(qubits, steps), basis(qubits, 0))
}

/** F(a, b) = |⟨a|b⟩|² — the squared convention, spelled out. */
export function stateFidelityRef(a: readonly Cx[], b: readonly Cx[]): number {
  let sum = c(0)
  for (let i = 0; i < a.length; i++) {
    sum = add(sum, mul(conj(a[i] as Cx), b[i] as Cx))
  }
  return sum.re * sum.re + sum.im * sum.im
}

/** F(A, B) = |Tr(A†B)|² / d², written as the double sum it is. */
export function unitaryFidelityRef(a: Matrix, b: Matrix): number {
  const dim = a.length
  let sum = c(0)
  for (let row = 0; row < dim; row++) {
    for (let col = 0; col < dim; col++) {
      sum = add(sum, mul(conj(at(a, row, col)), at(b, row, col)))
    }
  }
  return (sum.re * sum.re + sum.im * sum.im) / (dim * dim)
}

/** |⟨output|U|input⟩|² — what one truth-table row asks about. */
export function transitionRef(
  matrix: Matrix,
  input: number,
  output: number
): number {
  const entry = at(matrix, output, input)
  return entry.re * entry.re + entry.im * entry.im
}

/** The same state multiplied by e^{iφ}: physically identical, digitally not. */
export function withGlobalPhase(state: readonly Cx[], phi: number): Cx[] {
  const factor = c(Math.cos(phi), Math.sin(phi))
  return state.map((amp) => mul(amp, factor))
}

/** The same operator multiplied by e^{iφ}. */
export function matrixWithGlobalPhase(matrix: Matrix, phi: number): Matrix {
  const factor = c(Math.cos(phi), Math.sin(phi))
  return matrix.map((row) => row.map((entry) => mul(entry, factor)))
}
