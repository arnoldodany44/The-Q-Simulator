/**
 * A circuit as a matrix, and the comparison that ignores global phase.
 *
 * Phase 3 needs this and nothing before it did: §3.6 lets a challenge name a
 * **unitary** as its target — "build the circuit that implements this
 * operation" — and a unitary is not a state. Comparing the two circuits'
 * *final states* would only compare their action on |0…0⟩, which every circuit
 * agrees on far more often than it agrees everywhere: `x` on q0 and
 * `cx q0→q1 · x q0` send |00⟩ to the same place and are different operations.
 *
 * ────────────────────────────────────────────────────────────────────────
 * COLUMN j IS U|j⟩. THAT IS THE WHOLE CONSTRUCTION.
 *
 * A matrix *is* its action on a basis, so the unitary is assembled by running
 * the circuit once from each of the 2ⁿ basis states (`runFromState`) and
 * writing the resulting amplitudes into a column. Entry (row, col) is therefore
 * ⟨row|U|col⟩, stored at `col * dim + row` — column-major, the layout that
 * makes a whole column a contiguous slice, which is the thing this file writes
 * 2ⁿ times and reads whenever a truth table asks "where did |col⟩ go".
 *
 * Nothing here re-implements gate application: every column comes out of the
 * same runner, applying the same kernel, that the browser used to draw the
 * reader's histogram (§12.1).
 *
 * ────────────────────────────────────────────────────────────────────────
 * GLOBAL PHASE, AND WHY A VALIDATOR THAT FAILS IT IS WRONG
 *
 * |ψ⟩ and e^{iφ}|ψ⟩ are the same physical state: every measurement, in every
 * basis, gives identical statistics, and no experiment distinguishes them. The
 * same is true of U and e^{iφ}U as operations. So a challenge whose reference
 * solution is `h` must accept a submission of `x · h · x`-style equivalents
 * that differ only by an overall factor — and, more to the point, must accept
 * the *same* circuit written with `s·s·s` where the answer used `sdg`, which
 * differs by exactly such a factor.
 *
 * `stateFidelity` in `metrics.ts` already has this property: |⟨ψ|φ⟩|² throws
 * the phase away by squaring the modulus. The matrix version below is its
 * direct analogue,
 *
 *     F(A, B) = |Tr(A†B)|² / d²
 *
 * which is 1 exactly when B = e^{iφ}A, is 0 for operations as different as X
 * and Y, and — like every fidelity in this package — is the *squared*
 * convention (see the header of `metrics.ts`, which argues at length that
 * mixing the two is how "0.98" comes to mean nothing).
 *
 * Tr(A†B)/d is the entanglement fidelity of the two operations, so this number
 * is not merely a distance that happens to be phase-blind: it is what the
 * literature calls the process fidelity, and it answers "how often does B
 * behave like A" for a state drawn from the maximally entangled input.
 *
 * ────────────────────────────────────────────────────────────────────────
 * THE CEILING, AND WHY IT IS SO MUCH LOWER THAN THE STATEVECTOR'S
 *
 * A statevector is 2ⁿ amplitudes; a unitary is 4ⁿ, and building it costs 2ⁿ
 * runs of the circuit — so the work is 4ⁿ times the gate count where a single
 * simulation is 2ⁿ. Eight qubits is 65 536 complex entries and 256 runs, which
 * is a megabyte and a few milliseconds; twelve would be a gigabyte. §3.6's
 * unitary challenges are gate-identity puzzles on two or three wires, so eight
 * is already far past what they need, and the refusal is a typed error rather
 * than a slow answer that looks like a hang.
 */

import { stateSize } from './conventions.js'
import { runFromState } from './runner.js'
import type { CircuitLike } from './runner.js'
import { alloc } from './statevector.js'
import type { Statevector } from './statevector.js'

/**
 * The largest register this file will build a matrix for.
 *
 * Eight qubits: 4⁸ = 65 536 complex entries, one megabyte across the two
 * Float64Arrays, assembled from 256 circuit runs. See the header for why this
 * is so far below `MAX_QUBITS`.
 */
export const MAX_UNITARY_QUBITS = 8

/** A register too wide to hold as a matrix — refused, never attempted. */
export class UnitaryTooLargeError extends RangeError {
  readonly qubits: number
  readonly limit: number

  constructor(qubits: number) {
    super(
      `A unitary on ${qubits} qubits has ${String(4 ** qubits)} entries; ` +
        `${MAX_UNITARY_QUBITS} qubits is the ceiling.`
    )
    this.name = 'UnitaryTooLargeError'
    this.qubits = qubits
    this.limit = MAX_UNITARY_QUBITS
  }
}

/**
 * A dim × dim complex matrix in **column-major** order: entry (row, col) is at
 * `col * dim + row`, so column `col` is the contiguous slice describing
 * U|col⟩.
 */
export interface Unitary {
  readonly qubits: number
  /** `2 ** qubits`. Both the row count and the column count. */
  readonly dim: number
  readonly re: Float64Array
  readonly im: Float64Array
}

/** Allocates the zero matrix for `qubits` wires. */
export function allocUnitary(qubits: number): Unitary {
  if (!Number.isInteger(qubits) || qubits < 1) {
    throw new RangeError(`A unitary needs at least one qubit, got ${qubits}.`)
  }
  if (qubits > MAX_UNITARY_QUBITS) throw new UnitaryTooLargeError(qubits)
  const dim = stateSize(qubits)
  return {
    qubits,
    dim,
    re: new Float64Array(dim * dim),
    im: new Float64Array(dim * dim),
  }
}

/** The basis state |index⟩ on `qubits` wires, as a fresh statevector. */
function basisState(qubits: number, index: number): Statevector {
  const state = alloc(qubits)
  state.re[0] = 0
  state.re[index] = 1
  return state
}

/**
 * The matrix this circuit implements.
 *
 * Analytic only, and deliberately: a circuit that measures or branches on a
 * classical bit is not a unitary at all (§5.3), so `runFromState` refuses it
 * with `MidCircuitMeasurementError` rather than this file inventing a meaning
 * for the question.
 */
export function circuitUnitary(circuit: CircuitLike): Unitary {
  const matrix = allocUnitary(circuit.qubits)
  const { dim, re, im } = matrix
  for (let column = 0; column < dim; column++) {
    const { state } = runFromState(circuit, basisState(circuit.qubits, column))
    const offset = column * dim
    for (let row = 0; row < dim; row++) {
      re[offset + row] = state.re[row]
      im[offset + row] = state.im[row]
    }
  }
  return matrix
}

/**
 * F(A, B) = |Tr(A†B)|² / d² — 1 when the two operations differ only by an
 * overall phase, 0 when they are as unlike as X and Y.
 *
 * See the header for why the phase has to be thrown away and why this is the
 * squared convention.
 */
export function unitaryFidelity(a: Unitary, b: Unitary): number {
  if (a.qubits !== b.qubits) {
    throw new RangeError(
      `Operations on ${a.qubits} and ${b.qubits} qubits act on different ` +
        'spaces and have no fidelity.'
    )
  }
  // Tr(A†B) = Σᵢⱼ conj(Aᵢⱼ)·Bᵢⱼ — the Hilbert–Schmidt inner product, which is
  // the same sum whichever way the entries are laid out, so the column-major
  // order costs nothing here.
  let re = 0
  let im = 0
  for (let i = 0; i < a.re.length; i++) {
    const ar = a.re[i]
    const ai = a.im[i]
    const br = b.re[i]
    const bi = b.im[i]
    re += ar * br + ai * bi
    im += ar * bi - ai * br
  }
  const dim = a.dim
  return (re * re + im * im) / (dim * dim)
}

/**
 * |⟨output|U|input⟩|² — the probability that feeding the basis state |input⟩
 * through this operation and measuring gives |output⟩.
 *
 * This is what a truth-table target asks about one row, and it is a
 * probability rather than an amplitude for the same reason every comparison
 * here is: a per-column phase is not observable, and a row that arrived with a
 * minus sign in front of it arrived.
 */
export function transitionProbability(
  matrix: Unitary,
  input: number,
  output: number
): number {
  const { dim, re, im } = matrix
  if (
    !Number.isInteger(input) ||
    !Number.isInteger(output) ||
    input < 0 ||
    output < 0 ||
    input >= dim ||
    output >= dim
  ) {
    throw new RangeError(
      `Basis indices must be integers in [0, ${dim}); got ${input} → ${output}.`
    )
  }
  const at = input * dim + output
  const r = re[at]
  const i = im[at]
  return r * r + i * i
}
