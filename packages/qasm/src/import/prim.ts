/**
 * The intermediate the whole importer converges on: a gate reduced to its
 * *kernel* plus a list of controls.
 *
 * ── WHY THE CONTRACT'S OWN GATE NAMES ARE THE WRONG INTERMEDIATE ─────────
 *
 * The catalog names a `cx` and a `ccx`, and it is tempting to lower `cx a, b;`
 * straight to one. It is also wrong, because the moment a modifier appears the
 * name stops fitting: `ctrl @ cx` is a gate with two controls, and `cx` in the
 * catalog "takes exactly 1" — `acceptsControls` is false for every two- and
 * three-qubit entry, so the validator refuses it and the message blames the
 * user's file for the importer's choice of name.
 *
 * The kernel form has no such ceiling. Every one-qubit gate in the catalog
 * accepts arbitrary controls, positive or negative (§3.1), so `x` with a list
 * of controls can express `cx`, `ccx`, `negctrl @ ctrl @ x` and everything in
 * between. `choose` at the bottom of this file then picks the catalog name that
 * fits at the very end — which is exactly the inverse of the exporter's
 * `QASM_FORMS`, and deliberately mirrors it so that a circuit exported as `cx`
 * comes back as `cx` and not as an `x` with a control.
 *
 * ── WHY `gphase` IS A PRIMITIVE HERE AND NOT IN THE CONTRACT ─────────────
 *
 * `stdgates.inc` defines `u2` and `u3` with a `gphase` in front of them, and
 * OpenQASM 2's built-in `U` carries the same phase. A global phase is
 * unobservable, so the contract has no gate for one and none is needed — until
 * somebody writes `ctrl @ u3(…)`, at which point the phase becomes *relative*
 * and is the difference between two different unitaries. Carrying it as a
 * primitive that survives until controls are known is the only way to be right
 * in both cases: with no controls it is dropped, and with controls it becomes a
 * `p` on the control qubit, which is what controlling a phase means.
 *
 * That is the same fact the exporter's header states from the other side, where
 * it explains why `u` maps to the built-in `U` and not to `u3`.
 */

import type { ControlSpec, GateId } from '@qsim/schema'

/**
 * The catalog gates a lowering may produce directly.
 *
 * `swap` and `iswap` are here despite accepting no controls, because they are
 * genuinely two-qubit primitives with no one-qubit kernel. Their control
 * handling is the one case `applyControls` has to refuse, and it does so by
 * name.
 */
export type KernelId = Extract<
  GateId,
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
  | 'swap'
  | 'iswap'
>

export interface GatePrim {
  readonly kind: 'gate'
  readonly kernel: KernelId
  readonly targets: readonly number[]
  readonly controls: readonly ControlSpec[]
  readonly params: readonly number[]
}

export interface PhasePrim {
  readonly kind: 'gphase'
  readonly angle: number
}

/**
 * A barrier, which is a drawing and not a gate.
 *
 * It is a primitive because OpenQASM allows one inside a `gate` body, so it has
 * to survive the same lowering everything else does — and because modifiers
 * leave it alone: controlling a barrier is not a thing, and neither is
 * inverting one.
 */
export interface BarrierPrim {
  readonly kind: 'barrier'
  readonly qubits: readonly number[]
}

export type Prim = GatePrim | PhasePrim | BarrierPrim

export function gatePrim(
  kernel: KernelId,
  targets: readonly number[],
  controls: readonly ControlSpec[] = [],
  params: readonly number[] = []
): GatePrim {
  return { kind: 'gate', kernel, targets, controls, params }
}

/** How many qubits each kernel acts on, not counting controls. */
export const KERNEL_ARITY: Readonly<Record<KernelId, number>> = {
  i: 1,
  x: 1,
  y: 1,
  z: 1,
  h: 1,
  s: 1,
  sdg: 1,
  t: 1,
  tdg: 1,
  sx: 1,
  rx: 1,
  ry: 1,
  rz: 1,
  p: 1,
  u: 1,
  swap: 2,
  iswap: 2,
}

/**
 * The catalog name and control list a primitive becomes in the document.
 *
 * The named forms are preferred over the equivalent "one-qubit gate plus a
 * control" spelling — `cx` rather than `x` with one control — for two reasons.
 * It is what the editor's palette produces, so an imported circuit looks like a
 * drawn one; and it is what the exporter emits, so a file exported and
 * re-imported returns to the same document rather than to a synonym of it.
 *
 * Returns `null` when the shape has no contract form at all, which happens only
 * for a controlled `swap` beyond `cswap` and for any controlled `iswap`. The
 * caller turns that into a sentence naming the gate.
 */
export function choose(prim: GatePrim): {
  readonly gate: GateId
  readonly targets: readonly number[]
  readonly controls: readonly ControlSpec[]
} | null {
  const { kernel, targets, controls } = prim
  const positive = controls.every((control) => control.state === 1)

  if (kernel === 'swap' || kernel === 'iswap') {
    if (controls.length === 0) return { gate: kernel, targets, controls: [] }
    // `cswap` is the only controlled form of either that the catalog has.
    if (kernel === 'swap' && controls.length === 1 && positive) {
      return { gate: 'cswap', targets, controls }
    }
    return null
  }

  if (controls.length === 1 && positive) {
    const named = SINGLY_CONTROLLED[kernel]
    if (named !== undefined) return { gate: named, targets, controls }
  }
  if (controls.length === 2 && positive && kernel === 'x') {
    return { gate: 'ccx', targets, controls }
  }
  return { gate: kernel, targets, controls }
}

/**
 * Kernels with a catalog name for their singly-controlled form.
 *
 * Exactly the entries `QASM_FORMS` in the exporter declares a `builtInControls`
 * of 1 for, read backwards. `y` and `h` are absent because the catalog has no
 * `cy` or `ch`: those import as `y` and `h` carrying one control, which is the
 * same operation and the form the editor draws.
 */
const SINGLY_CONTROLLED: Partial<Record<KernelId, GateId>> = {
  x: 'cx',
  z: 'cz',
  rz: 'crz',
  p: 'cp',
}
