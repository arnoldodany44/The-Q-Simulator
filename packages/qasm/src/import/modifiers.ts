/**
 * `ctrl @`, `negctrl @`, `inv @` and `pow(k) @` applied to a lowered gate.
 *
 * ── WHY MODIFIERS ACT ON A LIST AND NOT ON A GATE ────────────────────────
 *
 * Because every one of them distributes over a *sequence*, and the sequence is
 * what a lowering produces: `u3` is two primitives, `cu` is two, a user gate is
 * however many its body has.
 *
 *   ctrl @ (B ∘ A) = (ctrl @ B) ∘ (ctrl @ A)
 *
 * — which is true because ctrl @ M = |0⟩⟨0| ⊗ I + |1⟩⟨1| ⊗ M, and multiplying
 * two of those out leaves the cross terms zero. So controlling a block really is
 * controlling each operation in it, one at a time. Inversion distributes the
 * same way with the order reversed, (BA)† = A†B†, and `pow` is repetition.
 *
 * ── THE ORDER THE MODIFIERS ARE APPLIED IN ───────────────────────────────
 *
 * Right to left: the modifier nearest the gate acts first, because that is what
 * `inv @ ctrl @ x` means — invert the controlled gate, not control the inverted
 * one. For these two it happens not to matter; for `pow(2) @ inv @ …` against
 * `inv @ pow(2) @ …` it also does not, and for a future modifier it might. The
 * qubits, in contrast, bind left to right: the leftmost `ctrl` takes the first
 * operand. Those two directions are both the language's, and getting either
 * backwards produces a program that runs and computes something else.
 */

import type { ControlSpec } from '@qsim/schema'

import { limitError, unsupportedError, type QasmPosition } from './errors.js'
import { MAX_OPERATIONS, MAX_POW_EXPONENT } from './limits.js'
import type { KernelId, Prim } from './prim.js'

/**
 * A kernel and what it becomes under `inv @`, where the catalog has an answer.
 *
 * The gaps are the point. `sx` and `iswap` have inverses — every unitary does —
 * and this catalog has no name for either, so `inv @ sx` is refused by name
 * rather than approximated. The alternative would be emitting `u(π/2, …)` with
 * a global phase attached, which is equal to `sx†` right up until somebody
 * controls it, and then silently is not. That is the same trap the exporter
 * documents for `u3`, and an importer that fell into it would be undetectable
 * from inside the project.
 */
const SELF_INVERSE: ReadonlySet<KernelId> = new Set<KernelId>([
  'i',
  'x',
  'y',
  'z',
  'h',
  'swap',
])

const PAIRED_INVERSE: Partial<Record<KernelId, KernelId>> = {
  s: 'sdg',
  sdg: 's',
  t: 'tdg',
  tdg: 't',
}

/** Kernels whose inverse is the same gate with negated angles. */
const NEGATED_ANGLE: ReadonlySet<KernelId> = new Set<KernelId>([
  'rx',
  'ry',
  'rz',
  'p',
])

/**
 * Adds control qubits to every primitive in a sequence.
 *
 * The interesting case is `gphase`. A global phase under k controls is no longer
 * global: it is a phase applied only on the branch where the controls fire,
 * which is exactly `p(γ)` on one of the control qubits, conditioned on the
 * others. Any positive control will do as the carrier — the phase is symmetric
 * in them — so the first one is used.
 *
 * When every control is negative there is no such carrier: `negctrl @ gphase`
 * puts the phase on the branch where the qubit reads |0⟩, which is `p(-γ)`
 * *times another global phase*, and unwinding that would need a gate the
 * catalog does not have. It is refused by name. The construct is vanishingly
 * rare — it can only arise from `negctrl @ u2`, `negctrl @ u3` or OpenQASM 2's
 * `negctrl`-free grammar reaching here through a user gate — and a refusal that
 * names it is better than a circuit that is off by a relative phase.
 */
export function addControls(
  prims: readonly Prim[],
  controls: readonly ControlSpec[],
  at: QasmPosition
): Prim[] {
  if (controls.length === 0) return [...prims]
  return prims.map((prim) => {
    if (prim.kind === 'barrier') return prim
    if (prim.kind === 'gate') {
      return { ...prim, controls: [...controls, ...prim.controls] }
    }

    const carrierIndex = controls.findIndex((control) => control.state === 1)
    const carrier = controls[carrierIndex]
    if (carrier === undefined) {
      throw unsupportedError(
        at,
        'negctrl @ gphase',
        'This applies only negative controls to a gate carrying a global ' +
          'phase (u2, u3 or OpenQASM 2’s built-in U). The phase becomes ' +
          'observable and the gate catalog has no shape for the result.'
      )
    }
    return {
      kind: 'gate',
      kernel: 'p',
      targets: [carrier.qubit],
      controls: controls.filter((_, index) => index !== carrierIndex),
      params: [prim.angle],
    }
  })
}

/** `inv @` over a sequence: reversed, with every primitive inverted. */
export function invert(prims: readonly Prim[], at: QasmPosition): Prim[] {
  return [...prims].reverse().map((prim) => {
    if (prim.kind === 'barrier') return prim
    if (prim.kind === 'gphase') return { kind: 'gphase', angle: -prim.angle }

    const kernel = prim.kernel
    if (SELF_INVERSE.has(kernel)) return prim
    const paired = PAIRED_INVERSE[kernel]
    if (paired !== undefined) return { ...prim, kernel: paired }
    if (NEGATED_ANGLE.has(kernel)) {
      return { ...prim, params: prim.params.map((angle) => -angle) }
    }
    if (kernel === 'u') {
      // U(θ, φ, λ)† = U(−θ, −λ, −φ). The swap of the last two is not a typo:
      // the phases attach to opposite corners of the matrix under a dagger.
      const [theta = 0, phi = 0, lambda = 0] = prim.params
      return { ...prim, params: [-theta, -lambda, -phi] }
    }

    throw unsupportedError(
      at,
      `inv @ ${kernel}`,
      `The inverse of "${kernel}" is not in this simulator’s gate ` +
        `catalog, and writing it as an equal-up-to-global-phase substitute ` +
        `would stop being equal the moment the gate were controlled.`
    )
  })
}

/**
 * `pow(k) @` over a sequence.
 *
 * Only whole exponents. `pow(0.5) @ x` is a perfectly good OpenQASM 3 gate —
 * it is √X, which this catalog even has — but `pow(0.5) @ h` is not any gate
 * here, and an importer that got one of them right and the other wrong would be
 * worse than one that refuses both and says which exponent it refused.
 *
 * The repeat count is bounded twice: by `MAX_POW_EXPONENT`, so the reader hears
 * about the exponent they wrote, and by `MAX_OPERATIONS` on the product, so
 * `pow(1000) @ pow(1000) @ x` cannot allocate before either fires.
 */
export function power(
  prims: readonly Prim[],
  exponent: number,
  at: QasmPosition
): Prim[] {
  if (!Number.isInteger(exponent)) {
    throw unsupportedError(
      at,
      `pow(${String(exponent)})`,
      `A fractional power of a gate is not in this simulator’s catalog; ` +
        `only whole exponents can be written as a repetition.`
    )
  }
  const times = Math.abs(exponent)
  if (times > MAX_POW_EXPONENT) {
    throw limitError(
      at,
      `pow(${String(exponent)}) would repeat a gate ${String(times)} times; ` +
        `the importer allows at most ${String(MAX_POW_EXPONENT)}.`
    )
  }
  if (times * prims.length > MAX_OPERATIONS) {
    throw limitError(
      at,
      `pow(${String(exponent)}) would produce ` +
        `${String(times * prims.length)} operations, past the ` +
        `${String(MAX_OPERATIONS)} a circuit may hold.`
    )
  }

  const base = exponent < 0 ? invert(prims, at) : [...prims]
  const out: Prim[] = []
  for (let repeat = 0; repeat < times; repeat++) out.push(...base)
  return out
}
