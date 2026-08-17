/**
 * The bridge: a `StatevectorKernel` for `@qsim/core` backed by a WASM session.
 *
 * Three rules shape every function here, and they are the same three rules the
 * seam in `@qsim/core`'s `kernel.ts` is built on.
 *
 * 1. DECLINE, DO NOT GUESS. A statevector that does not live in this
 *    session's linear memory is unreachable, and reaching it would mean the
 *    copy this design exists to avoid. Every entry point returns `false` for
 *    such a state and the engine runs the TypeScript it would have run
 *    anyway. Declining is the common case, not an error: `alloc()`,
 *    `clone()` and every checkpoint produce heap states.
 *
 * 2. DECLINE WITHOUT TOUCHING ANYTHING. A kernel that half-applied a gate and
 *    then returned `false` would leave the state corrupt in a way no test
 *    could attribute to it, because the fallback would then apply the same
 *    gate a second time. So every check happens before the first write —
 *    which is also why the Rust side re-validates and returns `false` rather
 *    than trapping partway through.
 *
 * 3. NEVER BE THE AUTHORITY. If this disagrees with `apply.ts`, `apply.ts` is
 *    right; that is not a tiebreak rule, it is the definition of what the
 *    engine computes. `equivalence.ts` is what proves agreement before
 *    installation, and `disableStatevectorKernel` is what happens if it is
 *    ever caught disagreeing afterwards.
 *
 * WHAT CROSSES PER GATE. Five integers and, for a gate with a matrix, eight
 * doubles written into the staging buffer. No amplitudes. At 20 qubits the
 * kernel then does 2²⁰ complex operations behind that call, so the boundary is
 * six orders of magnitude off the hot path — which is the entire point of
 * putting the state in linear memory (`session.ts`).
 */

import { disableStatevectorKernel } from '@qsim/core'
import type {
  ControlSpec,
  Matrix2,
  Statevector,
  StatevectorKernel,
} from '@qsim/core'

import { DetachedStateError } from './session.js'
import type { KernelSession } from './session.js'

/**
 * The accelerator failed *while executing a gate*, and the kernel has been
 * uninstalled.
 *
 * ══════════════════════════════════════════════════════════════════════════
 * WHY THIS THROWS RATHER THAN FALLING BACK
 *
 * Rule 2 of this file — "decline without touching anything" — is a contract on
 * the crate, and a trap is the crate breaking it: `crate/Cargo.toml` sets
 * `panic = "abort"`, so a Rust panic in the shipped artifact is a wasm trap
 * raised from somewhere inside the gate loop, with an unknown number of
 * amplitudes already rewritten. Falling back to `apply.ts` at that point would
 * apply the gate a second time to a half-transformed state and return an answer
 * that is wrong and says nothing — the one outcome this project is arranged
 * around. So the run stops here, loudly, naming what happened.
 *
 * What is *fixed* is the part that mattered: the kernel is uninstalled before
 * this is thrown, so the very next gate — and every later run in this process —
 * is computed by the TypeScript that was always the definition. Before, the
 * kernel stayed installed, `kernelStatus().disabledReason` stayed undefined,
 * and every subsequent gate failed the same way for the life of the process.
 *
 * A failure raised *before* the crate touches the state is a different thing
 * and is handled differently: nothing has been written, so the kernel declines,
 * the engine falls back, and the caller sees a slower gate rather than an error.
 */
export class KernelTrapError extends Error {
  constructor(operation: string, options: { cause?: unknown } = {}) {
    super(
      `The WebAssembly kernel trapped during ${operation}. It has been ` +
        `disabled, so the rest of this process computes in TypeScript — but ` +
        `this statevector may have been half-written, so this run is not ` +
        `trustworthy and has to be repeated.`,
      options
    )
    this.name = 'KernelTrapError'
  }
}

/** The `(mask, value)` pair `apply.ts` folds a control list into. */
interface ControlWord {
  readonly mask: number
  readonly value: number
}

/**
 * Fold controls into two integers, matching `controlMask`/`controlValue` in
 * `apply.ts` exactly: `mask` is the bits examined, `value` is what they must
 * read, and a negative control is a bit in the first and not the second.
 */
function foldControls(controls: readonly ControlSpec[]): ControlWord {
  let mask = 0
  let value = 0
  for (const control of controls) {
    mask |= 1 << control.qubit
    if (control.state === 1) value |= 1 << control.qubit
  }
  return { mask, value }
}

/**
 * Build the `StatevectorKernel` `@qsim/core` will consult.
 *
 * Not installed by this function. Installation goes through `load.ts`, which
 * runs the equivalence suite first — a kernel that has not been checked
 * against the reference has no business being the thing that computes.
 */
export function createKernel(session: KernelSession): StatevectorKernel {
  const { exports } = session

  /**
   * The pointer for `state`, or `undefined` to decline.
   *
   * `ownedPointer` throws on a detached view rather than returning
   * `undefined`, and that throw is deliberately *not* caught here. Falling
   * back to TypeScript with a detached view would read `undefined` amplitudes
   * and write `NaN` — the fallback is only safe for a state that is genuinely
   * usable, and a detached one is not usable by anybody.
   */
  const pointerFor = (state: Statevector): number | undefined =>
    session.ownedPointer(state)

  const stage = (matrix: Matrix2, doubles: number): boolean => {
    if (matrix.length !== doubles) return false
    session.matrixScratch().set(matrix)
    return true
  }

  /**
   * Everything up to and including the call into WebAssembly, with the two
   * failure modes told apart.
   *
   * `DetachedStateError` is raised by `ownedPointer` *before* anything is
   * written, and `kernel.ts`'s original argument for letting it through is
   * unchanged: a detached view cannot be computed with by anybody, so falling
   * back to TypeScript would read `undefined` and write `NaN`. Anything else
   * thrown from inside the instance is a trap — see `KernelTrapError` for why
   * that one stops the run instead of degrading it.
   */
  const guarded = (operation: string, run: () => boolean): boolean => {
    try {
      return run()
    } catch (error) {
      if (error instanceof DetachedStateError) throw error
      disableStatevectorKernel(
        `the ${session.id} kernel trapped during ${operation}`
      )
      throw new KernelTrapError(operation, { cause: error })
    }
  }

  return {
    id: session.id,

    applyControlled(
      state: Statevector,
      matrix: Matrix2,
      target: number,
      controls: readonly ControlSpec[]
    ): boolean {
      const pointer = pointerFor(state)
      if (pointer === undefined) return false
      if (!stage(matrix, 8)) return false
      const { mask, value } = foldControls(controls)
      return guarded('apply_controlled', () =>
        exports.apply_controlled(pointer, state.qubits, target, mask, value)
      )
    },

    applySwap(
      state: Statevector,
      q0: number,
      q1: number,
      controls: readonly ControlSpec[]
    ): boolean {
      const pointer = pointerFor(state)
      if (pointer === undefined) return false
      const { mask, value } = foldControls(controls)
      return guarded('apply_swap', () =>
        exports.apply_swap(pointer, state.qubits, q0, q1, mask, value)
      )
    },

    applyISwap(state: Statevector, q0: number, q1: number): boolean {
      const pointer = pointerFor(state)
      if (pointer === undefined) return false
      return guarded('apply_iswap', () =>
        exports.apply_iswap(pointer, state.qubits, q0, q1)
      )
    },
  }
}

/**
 * The accelerated operations that are not part of the `StatevectorKernel`
 * interface, because the runner does not dispatch unitaries through them.
 *
 * They are here rather than absent because the profile says they matter. At 20
 * qubits, on this machine, the TypeScript costs are:
 *
 *   blochVectors (20 qubits)   34.9 ms   ← the largest single cost in the
 *                                          live analysis panel, and it is 20
 *                                          reduced-density passes
 *   probabilities               3.2 ms
 *   norm + renormalize          5.8 ms   ← every 64 gates, per `RENORMALIZE_INTERVAL`
 *
 * A caller wires these up explicitly; nothing in `@qsim/core` reaches for
 * them, so they cannot change an answer without someone choosing to use them.
 */
export interface KernelExtras {
  /** Σ|aᵢ|², or `undefined` when the state is not in linear memory. */
  readonly normSquared: (state: Statevector) => number | undefined
  /** Scale in place. `false` when declined. */
  readonly scale: (state: Statevector, factor: number) => boolean
  /** Born-rule probabilities into `out`. `false` when declined. */
  readonly probabilities: (state: Statevector, out: Float64Array) => boolean
  /**
   * `[rho00, rho11, re01, im01]` for one qubit, or `undefined` when declined.
   * The four numbers §5.5 builds a Bloch vector from.
   */
  readonly reducedDensity: (
    state: Statevector,
    qubit: number
  ) => Float64Array | undefined
}

export function createExtras(session: KernelSession): KernelExtras {
  const { exports } = session

  /**
   * A scratch region for the small outputs, carved out of the matrix staging
   * buffer's tail.
   *
   * The staging buffer is 32 doubles and a 2×2 gate uses the first 8. The
   * reduced density needs 4 and is never in flight at the same time as a gate
   * — the runner applies gates, then the analysis panel reads. Reusing the
   * tail keeps the allocation count at zero for a call made once per qubit
   * per edit.
   */
  const RESULT_OFFSET = 16

  return {
    normSquared(state: Statevector): number | undefined {
      const pointer = session.ownedPointer(state)
      if (pointer === undefined) return undefined
      const result = exports.norm_squared(pointer, state.qubits)
      // The crate returns a negative number for a handle it rejected, which a
      // sum of squares can never be.
      return result < 0 ? undefined : result
    },

    scale(state: Statevector, factor: number): boolean {
      const pointer = session.ownedPointer(state)
      if (pointer === undefined) return false
      return exports.scale(pointer, state.qubits, factor)
    },

    probabilities(state: Statevector, out: Float64Array): boolean {
      const pointer = session.ownedPointer(state)
      if (pointer === undefined) return false
      if (out.length !== state.size) return false
      // `out` has to be in linear memory too — the kernel writes through a
      // pointer, and a JS-heap array has no address it can write to.
      if (out.buffer !== exports.memory.buffer) return false
      return exports.probabilities(pointer, state.qubits, out.byteOffset)
    },

    reducedDensity(
      state: Statevector,
      qubit: number
    ): Float64Array | undefined {
      const pointer = session.ownedPointer(state)
      if (pointer === undefined) return undefined
      const scratch = session.matrixScratch()
      const out = scratch.byteOffset + RESULT_OFFSET * 8
      if (!exports.reduced_density(pointer, state.qubits, qubit, out)) {
        return undefined
      }
      // Sliced, not viewed: the caller keeps this past the next gate, and the
      // next gate overwrites the staging buffer it came from.
      return scratch.slice(RESULT_OFFSET, RESULT_OFFSET + 4)
    },
  }
}
