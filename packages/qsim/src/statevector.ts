/**
 * The statevector — state representation and lifecycle (specification §5.1).
 *
 * An n-qubit state is 2ⁿ complex amplitudes. They are stored as **two
 * parallel `Float64Array`**, real and imaginary, never as an array of
 * `{ re, im }` objects. Two reasons, both load-bearing:
 *
 *  - **No garbage.** A 20-qubit state holds 1,048,576 amplitudes. As objects
 *    that is a million allocations for the collector to trace, per state, and
 *    the kernel would allocate a fresh pair on every gate.
 *  - **Transferable.** A typed array can be backed by a `SharedArrayBuffer`
 *    and handed to the Web Worker of M0.6 without copying, which is why
 *    `apps/web` already serves the COOP/COEP headers.
 *
 * Memory is `2ⁿ × 16 bytes`: 16 KB at 10 qubits, 16 MB at 20, 4 GB at 28.
 *
 * Amplitude `i` belongs to the basis state whose qubit `q` reads
 * `(i >> q) & 1` — decision D1, see `conventions.ts`.
 */

import { stateSize } from './conventions.js'

/**
 * Largest system this engine will allocate: 2²⁸ amplitudes is already 4 GB.
 *
 * Deliberately a second copy of `@qsim/schema`'s `MAX_QUBITS`, not an import
 * of it: this package has zero dependencies by design (§12.3), which is what
 * keeps it extractable and worker-safe. Both constants are 28 for the same
 * reason — the memory table in §5.1 — and both would move together.
 */
export const MAX_QUBITS = 28

/**
 * How often a long run should call `renormalize()` — decision D6.
 *
 * Every gate is unitary in exact arithmetic, so the norm is mathematically
 * invariant; in Float64 it drifts by roughly one ulp per gate. Renormalising
 * on a fixed interval keeps that drift far below the 1e-10 test tolerance
 * without paying for two extra passes over the state on every single gate.
 * The runner of M0.4 owns the counting; the constant lives here because it is
 * a property of the representation, not of the loop that uses it.
 */
export const RENORMALIZE_INTERVAL = 64

/** A complex number, for reading one amplitude out. Not used in hot loops. */
export interface Complex {
  readonly re: number
  readonly im: number
}

/**
 * A quantum state. The arrays are mutable — the kernel rewrites them in
 * place — but the shape is fixed at allocation: `re.length === im.length ===
 * size === 2 ** qubits`.
 */
export interface Statevector {
  readonly qubits: number
  /** `2 ** qubits`, cached because every kernel loop bounds itself with it. */
  readonly size: number
  readonly re: Float64Array
  readonly im: Float64Array
}

/**
 * A fresh n-qubit state in |0…0⟩.
 *
 * `Float64Array` is zero-filled by the runtime, so initialising the ground
 * state is a single write: amplitude 0 is the all-zeros basis state.
 */
export function alloc(qubits: number): Statevector {
  if (!Number.isInteger(qubits) || qubits < 1 || qubits > MAX_QUBITS) {
    throw new RangeError(
      `A statevector needs between 1 and ${MAX_QUBITS} qubits, got ${qubits}.`
    )
  }
  const size = stateSize(qubits)
  const state: Statevector = {
    qubits,
    size,
    re: new Float64Array(size),
    im: new Float64Array(size),
  }
  state.re[0] = 1
  return state
}

/** Return an existing state to |0…0⟩, reusing its buffers. */
export function reset(state: Statevector): void {
  state.re.fill(0)
  state.im.fill(0)
  state.re[0] = 1
}

/** Euclidean norm √(Σ|aᵢ|²). Exactly 1 for a physical state. */
export function norm(state: Statevector): number {
  const { re, im, size } = state
  let sum = 0
  for (let i = 0; i < size; i++) sum += re[i] * re[i] + im[i] * im[i]
  return Math.sqrt(sum)
}

/**
 * Scale the state back to unit norm and return the norm it had before.
 *
 * Multiplies by the reciprocal rather than dividing 2ⁿ times: one division
 * plus 2ⁿ multiplications instead of 2ⁿ divisions, and the result is
 * identical because the reciprocal is computed once in full precision.
 *
 * Throws on a zero or non-finite norm. That state has no physical
 * normalisation, and silently producing NaNs would poison every later gate
 * with no clue as to where it started.
 */
export function renormalize(state: Statevector): number {
  const previous = norm(state)
  if (!Number.isFinite(previous) || previous === 0) {
    throw new RangeError(
      `Cannot renormalize a state whose norm is ${previous}.`
    )
  }
  const scale = 1 / previous
  const { re, im, size } = state
  for (let i = 0; i < size; i++) {
    re[i] *= scale
    im[i] *= scale
  }
  return previous
}

/**
 * An independent copy. The checkpoint cache of §5.6 (M0.4) is built on this,
 * so it must not share buffers with the original.
 */
export function clone(state: Statevector): Statevector {
  return {
    qubits: state.qubits,
    size: state.size,
    re: state.re.slice(),
    im: state.im.slice(),
  }
}

/** Amplitude `index`, boxed. For tests and UI, never for the kernel. */
export function amplitude(state: Statevector, index: number): Complex {
  if (!Number.isInteger(index) || index < 0 || index >= state.size) {
    throw new RangeError(
      `Amplitude index ${index} is outside [0, ${state.size}).`
    )
  }
  return { re: state.re[index], im: state.im[index] }
}
