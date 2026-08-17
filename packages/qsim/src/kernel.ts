/**
 * The optional-accelerator seam — specification §5.6, phase 2.
 *
 * §5.6 plans a Rust/WASM core for the numeric hot path. This module is the
 * one place that core can attach to, and it is designed around a single
 * assertion: **the TypeScript kernel in `apply.ts` is the definition of what
 * this engine computes.** WASM is an optimisation of that definition, never a
 * second opinion on it. So:
 *
 *   - Nothing here is required. With no kernel installed — the default, and
 *     the only state in a Node process or a browser without WASM — every
 *     function below is one module-scoped read, one `undefined` check, and a
 *     direct call into `apply.ts`. That is the cost of the seam, against
 *     O(2ⁿ) inside the call.
 *   - Nothing here adds a dependency. `StatevectorKernel` is an interface and
 *     `installed` is a variable; `@qsim/core` still resolves to zero packages
 *     (§12.3) and still runs unchanged where WASM does not exist.
 *   - `apply.ts` is deliberately NOT routed through this module. It stays the
 *     reference implementation, callable directly and unaffected by whatever
 *     is installed, which is what lets the equivalence suite in `@qsim/wasm`
 *     compare the two at all. A reference that could itself be accelerated
 *     would be comparing WASM against WASM.
 *
 * WHY A BOOLEAN RETURN. An accelerator can only touch a statevector whose
 * buffers live in *its* linear memory (see `@qsim/wasm`'s session module for
 * why the state lives there and not in the JS heap). Any other statevector —
 * one from `alloc()`, one restored from a checkpoint by `clone()` — is
 * unreachable to it, and copying 16 MB across the boundary to reach it would
 * cost more than the gate saves. So each entry point *offers* the work and
 * takes `false` for "not mine". Declining is routine, not an error, and the
 * fall-through is the same call the engine would have made anyway.
 *
 * WHY THE GUARDS RUN ON BOTH PATHS. `apply.ts` rejects a control on a target,
 * a qubit twice controlled and a wrong-sized matrix with a `RangeError`. Those
 * are the shapes whose behaviour would otherwise be silent nonsense, and they
 * become worse across a WASM boundary, not better: an out-of-range target is a
 * write outside the state and inside somebody else's arena. The guards
 * therefore run *before* the offer, from the same functions `apply.ts` uses,
 * so an invalid call fails identically whether or not an accelerator is
 * present.
 */

import {
  applyControlled,
  applySwap,
  applyISwap,
  checkControls,
  checkDistinct,
  checkMatrix,
  checkQubit,
  type ControlSpec,
} from './apply.js'
import type { Matrix2 } from './gates.js'
import type { Statevector } from './statevector.js'

/**
 * An accelerated implementation of the three statevector entry points the
 * runner dispatches unitaries through.
 *
 * Every method returns whether it did the work. `false` means the caller must
 * fall back, and it must leave the state **exactly as it found it** — a kernel
 * that half-applied a gate and then declined would corrupt the state in a way
 * no test could attribute.
 *
 * The signatures mirror `apply.ts` entry for entry, including the matrix
 * layout of `gates.ts` (row-major, real and imaginary interleaved), because
 * the whole point is that either side can serve any call.
 */
export interface StatevectorKernel {
  /** For diagnostics and for the disable message. E.g. `'wasm-simd128'`. */
  readonly id: string
  readonly applyControlled: (
    state: Statevector,
    matrix: Matrix2,
    target: number,
    controls: readonly ControlSpec[]
  ) => boolean
  readonly applySwap: (
    state: Statevector,
    q0: number,
    q1: number,
    controls: readonly ControlSpec[]
  ) => boolean
  readonly applyISwap: (state: Statevector, q0: number, q1: number) => boolean
}

/** What `kernelStatus()` reports. */
export interface KernelStatus {
  /** The installed kernel's id, or `undefined` when the engine is pure TS. */
  readonly id: string | undefined
  /** Why the last kernel was removed, when it was removed by `disable`. */
  readonly disabledReason: string | undefined
}

let installed: StatevectorKernel | undefined
let disabledReason: string | undefined

/**
 * Route the runner's statevector gates through `kernel`.
 *
 * Global by design and single-writer by contract: the accelerator is a
 * property of the process (a worker has one WASM instance, not one per
 * circuit), and threading it through five runner entry points would put an
 * options bag on every call site to say the same thing. The caller that
 * installs is the one that loaded the module, and it owns removing it.
 *
 * The caller is expected to have proved equivalence first — `@qsim/wasm`
 * exports `verifyEquivalence()` for that and its loader refuses to install
 * without it. Nothing here can enforce that, which is the honest reason
 * `disableStatevectorKernel` exists.
 */
export function installStatevectorKernel(kernel: StatevectorKernel): void {
  installed = kernel
  disabledReason = undefined
}

/** Return the engine to pure TypeScript. Idempotent. */
export function uninstallStatevectorKernel(): void {
  installed = undefined
  disabledReason = undefined
}

/**
 * Remove the kernel because it was caught disagreeing with `apply.ts`.
 *
 * Separate from `uninstall` so the reason survives: a kernel that produces a
 * different amplitude is a defect that must be visible, and a silent
 * fall-back to a correct answer is exactly how such a defect would ship. The
 * engine keeps working — the TypeScript answer was always the right one — and
 * `kernelStatus().disabledReason` is what a caller logs.
 */
export function disableStatevectorKernel(reason: string): void {
  installed = undefined
  disabledReason = reason
}

/** The installed kernel, or `undefined`. Exposed for tests and diagnostics. */
export function activeStatevectorKernel(): StatevectorKernel | undefined {
  return installed
}

/** Whether the engine is accelerated right now, and why it might not be. */
export function kernelStatus(): KernelStatus {
  return { id: installed?.id, disabledReason }
}

/**
 * `applyControlled` with the accelerator consulted first.
 *
 * The zero-control case is not special-cased here the way `apply.ts` special-
 * cases it: a kernel is free to treat an empty control list as the plain
 * one-qubit walk, and forcing it back through `apply1q` would keep the most
 * common gate in the product on the slow path.
 */
export function acceleratedApplyControlled(
  state: Statevector,
  matrix: Matrix2,
  target: number,
  controls: readonly ControlSpec[]
): void {
  const kernel = installed
  if (kernel !== undefined) {
    checkQubit(state, target, 'target')
    checkMatrix(matrix, 8)
    checkControls(state, controls, target)
    if (kernel.applyControlled(state, matrix, target, controls)) return
  }
  applyControlled(state, matrix, target, controls)
}

/** `applySwap` with the accelerator consulted first. */
export function acceleratedApplySwap(
  state: Statevector,
  q0: number,
  q1: number,
  controls: readonly ControlSpec[]
): void {
  const kernel = installed
  if (kernel !== undefined) {
    checkQubit(state, q0, 'target')
    checkQubit(state, q1, 'target')
    checkDistinct(q0, q1)
    checkControls(state, controls, q0, q1)
    if (kernel.applySwap(state, q0, q1, controls)) return
  }
  applySwap(state, q0, q1, controls)
}

/** `applyISwap` with the accelerator consulted first. */
export function acceleratedApplyISwap(
  state: Statevector,
  q0: number,
  q1: number
): void {
  const kernel = installed
  if (kernel !== undefined) {
    checkQubit(state, q0, 'target')
    checkQubit(state, q1, 'target')
    checkDistinct(q0, q1)
    if (kernel.applyISwap(state, q0, q1)) return
  }
  applyISwap(state, q0, q1)
}
