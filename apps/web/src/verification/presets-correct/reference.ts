/**
 * An obviously-correct, obviously-slow statevector simulator, written from the
 * textbook definitions so that `@qsim/core` has something independent to be
 * checked against.
 *
 * It shares no code with the engine and it is deliberately naive: every
 * operation is materialised as a full 2ⁿ × 2ⁿ dense matrix and multiplied into
 * the state, which is exactly what §5.2 forbids the real engine from doing and
 * exactly what makes this one impossible to get subtly wrong. At three qubits a
 * dense step is 64 complex multiplications, so the whole cost of verifying all
 * six presets this way is invisible.
 *
 * The only convention it borrows is D1 — index = Σ qₖ·2ᵏ, qubit 0 the least
 * significant bit — and that is a frozen decision rather than an implementation
 * detail, so agreeing with the engine about it is not circular.
 */

import type { Circuit, Operation } from '@qsim/schema'

/** A complex number, as a value. Nothing here is written in place. */
export interface Cx {
  readonly re: number
  readonly im: number
}

export const ZERO: Cx = { re: 0, im: 0 }
export const ONE: Cx = { re: 1, im: 0 }

export function cx(re: number, im = 0): Cx {
  return { re, im }
}

export function add(a: Cx, b: Cx): Cx {
  return { re: a.re + b.re, im: a.im + b.im }
}

export function mul(a: Cx, b: Cx): Cx {
  return { re: a.re * b.re - a.im * b.im, im: a.re * b.im + a.im * b.re }
}

export function conj(a: Cx): Cx {
  return { re: a.re, im: -a.im }
}

export function absSquared(a: Cx): number {
  return a.re * a.re + a.im * a.im
}

/** A one-qubit gate, row-major: [u₀₀, u₀₁, u₁₀, u₁₁]. */
export type Matrix2 = readonly [Cx, Cx, Cx, Cx]

const ROOT_HALF = Math.SQRT1_2

/**
 * Gate matrices copied from the definitions, not from `gates.ts`.
 *
 * `u(θ, φ, λ)` is the Qiskit convention the specification names, and every
 * other entry here is the standard textbook matrix.
 */
export function matrixOf(gate: string, params: readonly number[]): Matrix2 {
  switch (gate) {
    case 'x':
    case 'cx':
    case 'ccx':
      return [ZERO, ONE, ONE, ZERO]
    case 'z':
    case 'cz':
      return [ONE, ZERO, ZERO, cx(-1)]
    case 'h':
      return [cx(ROOT_HALF), cx(ROOT_HALF), cx(ROOT_HALF), cx(-ROOT_HALF)]
    case 'p':
    case 'cp': {
      const phi = params[0] ?? 0
      return [ONE, ZERO, ZERO, cx(Math.cos(phi), Math.sin(phi))]
    }
    case 'ry': {
      const theta = params[0] ?? 0
      const c = Math.cos(theta / 2)
      const s = Math.sin(theta / 2)
      return [cx(c), cx(-s), cx(s), cx(c)]
    }
    case 'rz': {
      const theta = params[0] ?? 0
      const c = Math.cos(theta / 2)
      const s = Math.sin(theta / 2)
      return [cx(c, -s), ZERO, ZERO, cx(c, s)]
    }
    case 'u': {
      const [theta = 0, phi = 0, lambda = 0] = params
      const c = Math.cos(theta / 2)
      const s = Math.sin(theta / 2)
      return [
        cx(c),
        mul(cx(Math.cos(lambda), Math.sin(lambda)), cx(-s)),
        mul(cx(Math.cos(phi), Math.sin(phi)), cx(s)),
        mul(cx(Math.cos(phi + lambda), Math.sin(phi + lambda)), cx(c)),
      ]
    }
    default:
      throw new Error(`the reference simulator has no matrix for "${gate}"`)
  }
}

/** The ground state |0…0⟩ of a register of `qubits` wires. */
export function ground(qubits: number): Cx[] {
  const size = 1 << qubits
  return Array.from({ length: size }, (_, index) => (index === 0 ? ONE : ZERO))
}

function numericParams(operation: Operation): readonly number[] {
  return (operation.params ?? []).map((param) => {
    if (typeof param !== 'number') {
      throw new Error(`symbolic parameter "${param}" is not supported here`)
    }
    return param
  })
}

function controlQubits(operation: Operation): readonly number[] {
  return (operation.controls ?? []).map((control) => {
    if (typeof control === 'number') return control
    if (control.state !== 1) {
      throw new Error('the reference simulator only takes positive controls')
    }
    return control.qubit
  })
}

/**
 * One entry of the dense 2ⁿ × 2ⁿ matrix of a (possibly controlled) one-qubit
 * gate: ⟨i|Op|j⟩.
 *
 * Straight off the definition. Rows and columns that disagree anywhere but on
 * the target are zero; where the controls do not all read 1 the operation is
 * the identity; otherwise the entry is the gate's own, indexed by the target
 * bit of the row and of the column.
 */
function element(
  row: number,
  column: number,
  matrix: Matrix2,
  target: number,
  controls: readonly number[]
): Cx {
  const mask = 1 << target
  if ((row & ~mask) !== (column & ~mask)) return ZERO
  const armed = controls.every((control) => ((column >> control) & 1) === 1)
  if (!armed) return row === column ? ONE : ZERO
  const r = (row >> target) & 1
  const c = (column >> target) & 1
  return matrix[r * 2 + c]!
}

/** The state after one operation, by full dense matrix–vector multiplication. */
export function applyOperation(
  vector: readonly Cx[],
  qubits: number,
  operation: Operation
): Cx[] {
  const target = operation.targets[0]!
  const matrix = matrixOf(operation.gate, numericParams(operation))
  const controls = controlQubits(operation)
  const size = 1 << qubits
  const out: Cx[] = []
  for (let row = 0; row < size; row++) {
    let sum = ZERO
    for (let column = 0; column < size; column++) {
      sum = add(
        sum,
        mul(element(row, column, matrix, target, controls), vector[column]!)
      )
    }
    out.push(sum)
  }
  return out
}

/**
 * Run a unitary circuit from |0…0⟩, columns in ascending order.
 *
 * Refuses anything that measures or is conditioned: those have no single final
 * state, and pretending otherwise here would be the exact confusion §5.3 warns
 * about.
 */
export function referenceRun(circuit: Circuit): Cx[] {
  let vector = ground(circuit.qubits)
  for (const operation of orderedOperations(circuit)) {
    if (operation.gate === 'measure' || operation.condition !== undefined) {
      throw new Error('referenceRun takes unitary circuits only')
    }
    vector = applyOperation(vector, circuit.qubits, operation)
  }
  return vector
}

/** Operations in execution order: by column, stable within a column. */
export function orderedOperations(circuit: Circuit): readonly Operation[] {
  return [...circuit.operations]
    .map((operation, index) => ({ operation, index }))
    .sort((a, b) =>
      a.operation.column === b.operation.column
        ? a.index - b.index
        : a.operation.column - b.operation.column
    )
    .map((entry) => entry.operation)
}

/** Born-rule probabilities of every basis state. */
export function referenceProbabilities(vector: readonly Cx[]): number[] {
  return vector.map(absSquared)
}

/**
 * Project `qubit` onto `outcome` and renormalise, returning the branch's
 * probability alongside the collapsed state. The textbook postulate, written
 * out: zero what disagrees, divide by the norm of what is left.
 */
export function project(
  vector: readonly Cx[],
  qubit: number,
  outcome: 0 | 1
): { readonly probability: number; readonly vector: Cx[] } {
  let probability = 0
  for (let index = 0; index < vector.length; index++) {
    if (((index >> qubit) & 1) === outcome)
      probability += absSquared(vector[index]!)
  }
  if (probability === 0) return { probability, vector: vector.map(() => ZERO) }
  const scale = 1 / Math.sqrt(probability)
  return {
    probability,
    vector: vector.map((amplitude, index) =>
      ((index >> qubit) & 1) === outcome
        ? cx(amplitude.re * scale, amplitude.im * scale)
        : ZERO
    ),
  }
}
