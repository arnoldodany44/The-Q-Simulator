/**
 * Every one-qubit gate in the catalog, as Euler angles, and every Euler angle
 * as `rz` and `sx`.
 *
 * This file is the first of the two layers the package is made of, and it is
 * the one that is only arithmetic. Nothing here knows what a device is.
 *
 * ════════════════════════════════════════════════════════════════════════
 * PART ONE — THE CATALOG AS EULER ANGLES
 *
 * Qiskit's universal one-qubit gate, which `@qsim/core`'s `uMatrix` implements
 * entry for entry, is
 *
 *     U(θ,φ,λ) = ⎡ cos(θ/2)         −e^{iλ}·sin(θ/2)     ⎤
 *                ⎣ e^{iφ}·sin(θ/2)   e^{i(φ+λ)}·cos(θ/2) ⎦
 *
 * and every one-qubit gate in the catalog is a special case of it. The table
 * below records which, together with the leftover phase γ in
 *
 *     matrixFor(gate) = e^{iγ} · U(θ, φ, λ)
 *
 * The angles are written as exact expressions — `Math.PI / 2`, not
 * `1.5707963267948966` — and every derived angle in part two is built from
 * them by additions that are exact in Float64 (`π − π/2` is `π/2` to the bit,
 * by Sterbenz's lemma). That is what lets the emitted program say `rz(pi/2)`.
 * `formatAngle` in `@qsim/qasm` recognises the π form by `===` and nothing
 * else, on the deliberate principle that an exporter may not *change* an
 * angle; so an approximation here would not be a rounding error in the output,
 * it would be an ugly output. Both are worth avoiding and only one is worth
 * arguing about.
 *
 * `verification/euler-table.test.ts` multiplies out every row against
 * `matrixFor`, which is the only reason to believe any of it.
 *
 * ── γ IS NOT DECORATION ──────────────────────────────────────────────────
 *
 * Two rows have a non-zero γ: `sx` (π/4) and `rz(θ)` (−θ/2). For an
 * uncontrolled gate that phase is global and unobservable, and `zsxOf` drops
 * it. For a *controlled* gate it is not global at all — it applies only on the
 * |1⟩ branch of the control — and dropping it is precisely the difference
 * between `crz` and `cp`, which are different operations. `controlled.ts` uses
 * it; see `@qsim/core`'s `gates.ts` header for the same warning from the
 * other side.
 *
 * ════════════════════════════════════════════════════════════════════════
 * PART TWO — EULER ANGLES AS rz AND sx
 *
 * The identity everything rests on, derived rather than quoted. Write
 * `sx = e^{iπ/4}·rx(π/2)`, which is true entry for entry, and multiply out:
 *
 *     rx(π/2)·rz(α)·rx(π/2) = −i·⎡ sin(α/2)   cos(α/2) ⎤
 *                                ⎣ cos(α/2)  −sin(α/2) ⎦
 *
 * At α = θ+π that bracket becomes ⎡c −s⎤ over ⎡−s −c⎤ with c = cos(θ/2) and
 * s = sin(θ/2), and sandwiching it between two more z-rotations gives
 *
 *     rz(φ+π)·sx·rz(θ+π)·sx·rz(λ) = −i·e^{−i(φ+λ)/2} · U(θ,φ,λ)
 *
 * which is U up to a global phase. Read right to left, that is the circuit
 * `rz(λ) → sx → rz(θ+π) → sx → rz(φ+π)`: five gates, two of which are pulses.
 *
 * ── THREE SHORTER CASES, AND WHY THEY ARE EXACT EQUALITIES ───────────────
 *
 * The generic form is always correct, so the three reductions below are about
 * gate count and nothing else. Each is taken only when θ is *exactly* the
 * constant named, never within a tolerance: a tolerance would mean the
 * transpiler silently replaces the user's rotation by a nearby one, which is
 * the one thing a transpiler must not do. A near-miss simply costs two extra
 * gates.
 *
 *   θ = 0    U is diagonal: U(0,φ,λ) = diag(1, e^{i(φ+λ)}), one `rz(φ+λ)` and
 *            no pulse at all.
 *   θ = π    U is antidiagonal: U(π,φ,λ) ∝ rz(φ−λ+π)·X, so `x` then one `rz`.
 *   θ = π/2  every entry has modulus 1/√2, which is exactly the family a
 *            single `sx` between two `rz` can reach:
 *            U(π/2,φ,λ) ∝ rz(φ+π/2)·sx·rz(λ−π/2).
 *
 * The third is the one the Hadamard lands in: h is U(π/2, 0, π), so it comes
 * out as `rz(pi/2) → sx → rz(pi/2)`, one pulse, and the whole reason the H a
 * user drags onto a wire costs a Heron chip almost nothing.
 */

import { GATES, type GateId } from '@qsim/schema'

import type { EulerAngles } from './complex2.js'

const PI = Math.PI
const HALF_PI = Math.PI / 2
const QUARTER_PI = Math.PI / 4

/** A gate of the emitted basis that acts on one qubit. */
export interface BasisRotation {
  readonly gate: 'x' | 'sx' | 'rz'
  /** Present only for `rz`. */
  readonly angle?: number
}

/**
 * Gate ids that this file can turn into Euler angles: every catalog gate whose
 * `arity` is 1 and whose category is not structural, plus the one-qubit gates
 * that the multi-qubit entries are built from.
 */
export type OneQubitCatalogId =
  | 'i'
  | 'x'
  | 'y'
  | 'z'
  | 'h'
  | 's'
  | 'sdg'
  | 't'
  | 'tdg'
  | 'sx'
  | 'rx'
  | 'ry'
  | 'rz'
  | 'p'
  | 'u'

const ONE_QUBIT_IDS: readonly OneQubitCatalogId[] = [
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
  'rx',
  'ry',
  'rz',
  'p',
  'u',
]

/** Whether `gate` is a catalog gate with a 2×2 matrix. */
export function isOneQubitCatalogId(gate: string): gate is OneQubitCatalogId {
  return (ONE_QUBIT_IDS as readonly string[]).includes(gate)
}

/**
 * The one-qubit gate a multi-qubit catalog entry is *made of*, and how many
 * controls the entry carries by definition.
 *
 * The contract already stores `cx` as "x with one control" and `ccx` as "x
 * with two" (`GATES.cx.controlCount`), so this table is not a second opinion
 * about their shape — it is the statement that `crz` is `rz` and `cp` is `p`,
 * which is what makes one controlled-U construction serve all four. `swap`,
 * `iswap` and `cswap` are absent because they are not built from a one-qubit
 * gate at all; `decompose.ts` handles them by name.
 */
export const BASE_GATE_OF: Readonly<
  Partial<Record<GateId, OneQubitCatalogId>>
> = {
  cx: 'x',
  cz: 'z',
  crz: 'rz',
  cp: 'p',
  ccx: 'x',
}

/**
 * The Euler angles of a catalog one-qubit gate, with its leftover phase.
 *
 * Throws `RangeError` on the wrong parameter count, for the same reason
 * `matrixFor` does: a missing angle defaulted to zero turns `rx(θ)` into the
 * identity, and the gate would vanish from the circuit with nothing said.
 */
export function eulerOf(
  gate: OneQubitCatalogId,
  params: readonly number[] = []
): EulerAngles {
  switch (gate) {
    case 'i':
      return angles(gate, params, 0, { theta: 0, phi: 0, lambda: 0, phase: 0 })
    case 'x':
      return angles(gate, params, 0, {
        theta: PI,
        phi: 0,
        lambda: PI,
        phase: 0,
      })
    case 'y':
      return angles(gate, params, 0, {
        theta: PI,
        phi: HALF_PI,
        lambda: HALF_PI,
        phase: 0,
      })
    case 'z':
      return angles(gate, params, 0, {
        theta: 0,
        phi: 0,
        lambda: PI,
        phase: 0,
      })
    case 'h':
      return angles(gate, params, 0, {
        theta: HALF_PI,
        phi: 0,
        lambda: PI,
        phase: 0,
      })
    case 's':
      return angles(gate, params, 0, {
        theta: 0,
        phi: 0,
        lambda: HALF_PI,
        phase: 0,
      })
    case 'sdg':
      return angles(gate, params, 0, {
        theta: 0,
        phi: 0,
        lambda: -HALF_PI,
        phase: 0,
      })
    case 't':
      return angles(gate, params, 0, {
        theta: 0,
        phi: 0,
        lambda: QUARTER_PI,
        phase: 0,
      })
    case 'tdg':
      return angles(gate, params, 0, {
        theta: 0,
        phi: 0,
        lambda: -QUARTER_PI,
        phase: 0,
      })
    case 'sx':
      /*
       * √X is not rx(π/2): it is e^{iπ/4}·rx(π/2). The two are the same
       * operation on a wire and different operations under a control, which is
       * why γ is recorded rather than absorbed.
       */
      return angles(gate, params, 0, {
        theta: HALF_PI,
        phi: -HALF_PI,
        lambda: HALF_PI,
        phase: QUARTER_PI,
      })
    case 'rx':
      return angles(gate, params, 1, {
        theta: params[0] as number,
        phi: -HALF_PI,
        lambda: HALF_PI,
        phase: 0,
      })
    case 'ry':
      return angles(gate, params, 1, {
        theta: params[0] as number,
        phi: 0,
        lambda: 0,
        phase: 0,
      })
    case 'rz':
      /*
       * rz(θ) = e^{−iθ/2}·diag(1, e^{iθ}) = e^{−iθ/2}·U(0,0,θ). The phase is
       * the entire difference between `crz` and `cp`.
       */
      return angles(gate, params, 1, {
        theta: 0,
        phi: 0,
        lambda: params[0] as number,
        phase: -(params[0] as number) / 2,
      })
    case 'p':
      return angles(gate, params, 1, {
        theta: 0,
        phi: 0,
        lambda: params[0] as number,
        phase: 0,
      })
    case 'u':
      return angles(gate, params, 3, {
        theta: params[0] as number,
        phi: params[1] as number,
        lambda: params[2] as number,
        phase: 0,
      })
  }
}

/**
 * Checks the parameter count and that every angle is finite, then hands back
 * the row. Kept as one helper so the table above reads as a table.
 */
function angles(
  gate: string,
  params: readonly number[],
  expected: number,
  result: EulerAngles
): EulerAngles {
  if (params.length !== expected) {
    throw new RangeError(
      `Gate "${gate}" takes ${expected} parameter(s), got ${params.length}.`
    )
  }
  for (const value of params) {
    if (!Number.isFinite(value)) {
      throw new RangeError(`Gate "${gate}" was given a non-finite parameter.`)
    }
  }
  return result
}

/**
 * A one-qubit operation as `rz` and `sx`, **up to global phase**.
 *
 * The phase carried by `angles` is deliberately ignored here: on a wire it is
 * unobservable, and reproducing it would cost a gate that does nothing. Every
 * caller that needs the phase — which means every caller that is about to put
 * a control on this gate — reads `angles.phase` itself and puts it where it
 * becomes observable, on the control.
 *
 * An `rz` whose angle is exactly zero is dropped, so a gate that reduces to
 * nothing emits nothing. The one gate for which that is wrong is `i`, which
 * `decompose.ts` special-cases: the user drew an identity and the backend has
 * one, so it is emitted.
 */
export function zsxOf(angles: EulerAngles): readonly BasisRotation[] {
  const { theta, phi, lambda } = angles

  if (theta === 0) {
    // U(0,φ,λ) = diag(1, e^{i(φ+λ)}) — a phase, and phases are free.
    return rzOnly(phi + lambda)
  }
  if (theta === PI) {
    // U(π,φ,λ) ∝ rz(φ−λ+π)·X: the bit flip, then one frame change.
    return [{ gate: 'x' }, ...rzOnly(phi - lambda + PI)]
  }
  if (theta === HALF_PI) {
    // The single-pulse family: every entry has modulus 1/√2.
    return [
      ...rzOnly(lambda - HALF_PI),
      { gate: 'sx' },
      ...rzOnly(phi + HALF_PI),
    ]
  }
  return [
    ...rzOnly(lambda),
    { gate: 'sx' },
    ...rzOnly(theta + PI),
    { gate: 'sx' },
    ...rzOnly(phi + PI),
  ]
}

const NO_ROTATION: readonly BasisRotation[] = []

function rzOnly(angle: number): readonly BasisRotation[] {
  return angle === 0 ? NO_ROTATION : [{ gate: 'rz', angle }]
}

/**
 * How many *pulses* a rotation list costs: `sx` is one and `x` is one, `rz` is
 * zero because the hardware implements it as a frame change (see `basis.ts`).
 *
 * This is the number the fusion pass in `decompose.ts` compares, and it is the
 * number that predicts noise. Counting instructions instead would make fusing
 * `rz·rz` look like a win and fusing `h·h` — which cancels to nothing — look
 * like a tie.
 */
export function pulseCost(rotations: readonly BasisRotation[]): number {
  let cost = 0
  for (const rotation of rotations) if (rotation.gate !== 'rz') cost++
  return cost
}

/**
 * Every catalog gate id whose arity is 1 and whose category is not structural.
 * Read from `GATES` rather than listed, so a gate added to the contract
 * without a row in `eulerOf` fails a test here rather than at runtime in a
 * user's circuit.
 */
export function oneQubitCatalogIds(): readonly GateId[] {
  return (Object.keys(GATES) as GateId[]).filter((id) => {
    const meta = GATES[id]
    return meta.category === 'single' || meta.category === 'parametrised'
  })
}
