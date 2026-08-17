/**
 * The gate set this package compiles *to*, and the argument for choosing it.
 *
 * ── WHAT THE DEVICE SAYS IT RUNS ─────────────────────────────────────────
 *
 * A Heron processor reports `basis_gates: ["cz", "id", "rx", "rz", "rzz",
 * "sx", "x"]`. There is no `h` and no `cx` in that list, and there never will
 * be: those are textbook names for pulses a superconducting chip does not
 * have. Everything a user draws has to be rewritten into what is there, and
 * that rewriting is this package's first half.
 *
 * ── WHAT THIS PACKAGE EMITS, WHICH IS LESS ───────────────────────────────
 *
 * Five of the seven: `rz`, `sx`, `x`, `id`, `cz`. Two are deliberately left
 * on the table.
 *
 *   `rx(θ)` and `rzz(θ)` are **fractional gates**. They are real, they are in
 *   the reported basis, and they are *not enabled by default*: a backend
 *   serves them only when the session opts in, and a program that uses them
 *   against a backend that has not is rejected. Emitting an arbitrary-angle
 *   `rx` would therefore trade a decomposition that always runs for one that
 *   sometimes does, in exchange for saving one `sx` per rotation. On a plan
 *   that grants ten minutes of QPU time every twenty-eight days, a rejected
 *   job costs more than a slightly longer circuit.
 *
 * The five that remain are enough for universality on their own — `rz` and
 * `sx` generate every one-qubit rotation (see `euler.ts`), and `cz` entangles
 * — so nothing is given up but gate count.
 *
 * ── AND WHY THE ARITHMETIC LEANS SO HARD ON `rz` ─────────────────────────
 *
 * Because `rz` is free. Read the backend properties and every `rz` entry says
 * `gate_error: 0` and `gate_length: 0` — not "very small", exactly zero. A
 * z-rotation on this hardware is not a pulse at all; it is a change of
 * reference frame applied to the pulses that follow, so it takes no time and
 * adds no error. `sx` is the one calibrated one-qubit pulse and `x` is two of
 * them. That is the whole reason the decomposition below is a ZSX sandwich
 * rather than an XYX one: it puts everything expensive into as few `sx` as the
 * gate genuinely needs and everything else into rotations that cost nothing.
 */

/** The gate ids this package emits, as `@qsim/schema` spells them. */
export type BasisGateId = 'i' | 'x' | 'sx' | 'rz' | 'cz'

/**
 * The five emitted gates. `i` is the catalog's identity, which OpenQASM 3 and
 * the backend both call `id`; the rename happens in the serialiser.
 */
export const BASIS_GATE_IDS: readonly BasisGateId[] = [
  'i',
  'x',
  'sx',
  'rz',
  'cz',
]

/**
 * The seven gates a Heron backend reports. Kept so that a target's declared
 * basis can be checked against what is emitted rather than assumed — a device
 * whose basis does not contain these five is a device this package must refuse
 * rather than quietly mis-compile for.
 */
export const HERON_NATIVE_GATES: readonly string[] = [
  'cz',
  'id',
  'rx',
  'rz',
  'rzz',
  'sx',
  'x',
]

/**
 * Structural operations that pass through untouched. They are not gates: a
 * barrier is an instruction to the scheduler, and `reset` and `measure` are
 * primitives every backend implements directly.
 */
export const PASSTHROUGH_GATE_IDS: readonly string[] = [
  'barrier',
  'reset',
  'measure',
]

/** Whether `gate` is one of the five this package emits. */
export function isBasisGate(gate: string): gate is BasisGateId {
  return (BASIS_GATE_IDS as readonly string[]).includes(gate)
}

/** Whether `gate` survives decomposition unchanged. */
export function isPassthrough(gate: string): boolean {
  return PASSTHROUGH_GATE_IDS.includes(gate)
}
