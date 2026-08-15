/**
 * A deliberately slow, deliberately independent quantum simulator, written to
 * check what the analysis panel *displays* against what the mathematics says.
 *
 * It shares no code with `@qsim/core`. The engine evolves a state by pairing
 * indices in place (`apply.ts`), which is fast and is exactly the kind of
 * arithmetic that can be self-consistently wrong; this builds the full
 * 2ⁿ × 2ⁿ operator of every gate from its textbook definition and multiplies.
 * At three qubits that is an 8 × 8 matrix per gate — far too slow to ship and
 * far too simple to be subtly wrong.
 *
 * The one thing it does share is decision D1, which it re-states rather than
 * imports: bit `q` of statevector index `i` is `(i >> q) & 1`, and the ket
 * label prints the highest qubit first. That is the convention the display is
 * being checked against, so it has to be written down somewhere independent of
 * the code under test.
 */

/** One complex number. Objects rather than interleaved arrays: this is a
 * reference, and legibility is the only performance requirement. */
export interface Cx {
  readonly re: number
  readonly im: number
}

/** A dense operator, row-major: `m[row][column]`. */
export type Operator = readonly (readonly Cx[])[]

/** A 2×2 one-qubit gate, row-major. */
export type Gate2 = readonly [readonly [Cx, Cx], readonly [Cx, Cx]]

const c = (re: number, im = 0): Cx => ({ re, im })
const R2 = Math.SQRT1_2

/* ── The textbook matrices, written out here rather than imported ───────── */

export const GATE_I: Gate2 = [
  [c(1), c(0)],
  [c(0), c(1)],
]
export const GATE_X: Gate2 = [
  [c(0), c(1)],
  [c(1), c(0)],
]
export const GATE_Y: Gate2 = [
  [c(0), c(0, -1)],
  [c(0, 1), c(0)],
]
export const GATE_Z: Gate2 = [
  [c(1), c(0)],
  [c(0), c(-1)],
]
export const GATE_H: Gate2 = [
  [c(R2), c(R2)],
  [c(R2), c(-R2)],
]
export const GATE_S: Gate2 = [
  [c(1), c(0)],
  [c(0), c(0, 1)],
]
export const GATE_T: Gate2 = [
  [c(1), c(0)],
  [c(0), c(Math.cos(Math.PI / 4), Math.sin(Math.PI / 4))],
]

/** P(φ) = diag(1, e^{iφ}). */
export function gateP(phi: number): Gate2 {
  return [
    [c(1), c(0)],
    [c(0), c(Math.cos(phi), Math.sin(phi))],
  ]
}

/** Rz(θ) = diag(e^{−iθ/2}, e^{iθ/2}) — Qiskit's convention, global phase and
 * all, which is what makes the phase column a testable number. */
export function gateRz(theta: number): Gate2 {
  return [
    [c(Math.cos(theta / 2), -Math.sin(theta / 2)), c(0)],
    [c(0), c(Math.cos(theta / 2), Math.sin(theta / 2))],
  ]
}

/** Ry(θ) = [[cos θ/2, −sin θ/2], [sin θ/2, cos θ/2]]. */
export function gateRy(theta: number): Gate2 {
  return [
    [c(Math.cos(theta / 2)), c(-Math.sin(theta / 2))],
    [c(Math.sin(theta / 2)), c(Math.cos(theta / 2))],
  ]
}

/* ── Building the full operator ─────────────────────────────────────────── */

/** D1, restated: the value of qubit `q` inside statevector index `i`. */
export function bit(index: number, qubit: number): number {
  return (index >> qubit) & 1
}

/** D1, restated: the ket label of an index, highest qubit first. */
export function ketLabel(index: number, qubits: number): string {
  let out = ''
  for (let q = qubits - 1; q >= 0; q--) out += String(bit(index, q))
  return out
}

/**
 * The 2ⁿ × 2ⁿ operator of `gate` acting on `target`, conditioned on every
 * qubit in `controls` reading 1.
 *
 * Straight from the definition: `C = P·(U on target) + (1 − P)·I`, where `P`
 * projects onto the subspace where all the controls are set. Written entry by
 * entry so there is nothing clever to get wrong.
 */
export function operatorFor(
  qubits: number,
  gate: Gate2,
  target: number,
  controls: readonly number[] = []
): Operator {
  const size = 1 << qubits
  const fires = (index: number): boolean =>
    controls.every((control) => bit(index, control) === 1)

  const rows: Cx[][] = []
  for (let row = 0; row < size; row++) {
    const line: Cx[] = []
    for (let column = 0; column < size; column++) {
      // Off the controlled subspace the operator is the identity.
      if (!fires(row) || !fires(column)) {
        line.push(c(row === column ? 1 : 0))
        continue
      }
      // Inside it, every bit but the target must agree.
      const mask = ~(1 << target)
      if ((row & mask) !== (column & mask)) {
        line.push(c(0))
        continue
      }
      line.push(gate[bit(row, target)]![bit(column, target)]!)
    }
    rows.push(line)
  }
  return rows
}

/** `operator · vector`, the schoolbook way. */
export function applyOperator(operator: Operator, vector: readonly Cx[]): Cx[] {
  return operator.map((row) => {
    let re = 0
    let im = 0
    for (let column = 0; column < row.length; column++) {
      const m = row[column]!
      const v = vector[column]!
      re += m.re * v.re - m.im * v.im
      im += m.re * v.im + m.im * v.re
    }
    return c(re, im)
  })
}

/** |0…0⟩. */
export function groundState(qubits: number): Cx[] {
  const size = 1 << qubits
  const out: Cx[] = []
  for (let index = 0; index < size; index++) out.push(c(index === 0 ? 1 : 0))
  return out
}

/** One gate in a reference circuit. */
export interface RefStep {
  readonly gate: Gate2
  readonly target: number
  readonly controls?: readonly number[]
}

/** Evolve |0…0⟩ through the steps, in order. */
export function referenceState(
  qubits: number,
  steps: readonly RefStep[]
): Cx[] {
  let vector = groundState(qubits)
  for (const step of steps) {
    vector = applyOperator(
      operatorFor(qubits, step.gate, step.target, step.controls ?? []),
      vector
    )
  }
  return vector
}

/** |a|². */
export function probabilityOf(amplitude: Cx): number {
  return amplitude.re * amplitude.re + amplitude.im * amplitude.im
}

/** The argument of an amplitude, folded into `[0, 2π)`. */
export function phaseOf(amplitude: Cx): number {
  const raw = Math.atan2(amplitude.im, amplitude.re)
  const tau = 2 * Math.PI
  const wrapped = raw < 0 ? raw + tau : raw
  return wrapped >= tau ? 0 : wrapped
}
