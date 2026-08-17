/**
 * INDEPENDENT VERIFICATION — lens: wasm-agreement, part three.
 *
 * The first two files ask what the two engines compute and what the gate in
 * front of installation proves. This one asks what happens **after** the gate,
 * when an installed kernel fails mid-circuit — which is the only remaining way
 * a checkout that passed every check still ends up worse off than the pure
 * TypeScript it started as.
 *
 * Three places in the package state the intended behaviour:
 *
 *   exports.ts   "A stub that is ever *called* means the kernel panicked …
 *                 the bridge catches it and uninstalls the kernel."
 *   kernel.ts    "`disableStatevectorKernel` is what happens if it is ever
 *                 caught disagreeing afterwards."
 *   qsim/kernel  "a silent fall-back to a correct answer is exactly how such a
 *                 defect would ship … `kernelStatus().disabledReason` is what
 *                 a caller logs."
 *
 * None of it was implemented: `disableStatevectorKernel` had no caller outside
 * unit tests and no `try` sat between `acceleratedApplyControlled` and the
 * WebAssembly instance, so a trap killed the run *and* left the kernel
 * installed, and every subsequent gate failed the same way for the life of the
 * process.
 *
 * `crate/Cargo.toml` is what makes that more than a documentation slip: the
 * release profile is `panic = "abort"`, so a Rust panic in the shipped artifact
 * is a wasm trap rather than a call to the `__wbindgen_throw` stub `exports.ts`
 * installs. Either way it arrives in JavaScript as a thrown error.
 *
 * ── WHAT "RECOVERY" MEANS HERE, AND WHY IT IS NOT A SILENT FALLBACK ──────
 *
 * A trap is raised from inside the gate loop with an unknown number of
 * amplitudes already rewritten, so re-applying that gate in TypeScript would
 * compute from a half-transformed state and return an answer that is wrong and
 * says nothing. The gate that trapped therefore fails loudly, as
 * `KernelTrapError`, and the *kernel* is uninstalled — so the next gate, and
 * every later run in the process, is the TypeScript that was always the
 * definition.
 */

import { afterEach, describe, expect, it } from 'vitest'

import {
  GATE_MATRICES,
  acceleratedApplyControlled,
  activeStatevectorKernel,
  alloc,
  applyControlled,
  installStatevectorKernel,
  kernelStatus,
  uninstallStatevectorKernel,
  type Statevector,
} from '@qsim/core'

import type { KernelExports } from '../../exports.js'
import { KernelTrapError, createKernel } from '../../kernel.js'
import { createSession } from '../../session.js'
import { createTransliteratedExports } from './rust-transliteration.js'

afterEach(() => {
  uninstallStatevectorKernel()
})

/** Exports whose gate entry point traps, the way an aborting panic does. */
function trappingExports(): KernelExports {
  const honest = createTransliteratedExports()
  return {
    ...honest,
    apply_controlled: () => {
      throw new WebAssembly.RuntimeError('unreachable')
    },
  }
}

describe('an installed kernel that traps mid-circuit', () => {
  it('uninstalls itself and lets the next gate run in TypeScript', () => {
    const session = createSession(trappingExports())
    try {
      installStatevectorKernel(createKernel(session))
      const handle = session.allocState(3)
      expect(handle).toBeDefined()
      if (handle === undefined) return

      // The gate that trapped fails, and says what happened rather than
      // returning an answer computed from a state nobody can vouch for.
      expect(() =>
        acceleratedApplyControlled(handle.statevector, GATE_MATRICES.h, 0, [])
      ).toThrow(KernelTrapError)

      // The kernel is gone, and the reason survives for a caller to log.
      expect(kernelStatus().id).toBeUndefined()
      expect(kernelStatus().disabledReason).toContain('trapped')
      expect(activeStatevectorKernel()).toBeUndefined()

      /*
       * And this is the part that was actually broken: the next gate is not
       * the same failure again. With no kernel installed, `apply.ts` computes
       * it — on a heap state, because the state in linear memory is the one the
       * trap may have half-written.
       */
      const heap = alloc(3)
      acceleratedApplyControlled(heap, GATE_MATRICES.h, 0, [])
      const reference = alloc(3)
      applyControlled(reference, GATE_MATRICES.h, 0, [])
      expect(heap.re[0]).toBeCloseTo(reference.re[0], 15)

      handle.release()
    } finally {
      session.dispose()
    }
  })

  it('carries the original trap as its cause', () => {
    const session = createSession(trappingExports())
    try {
      installStatevectorKernel(createKernel(session))
      const handle = session.allocState(2)
      if (handle === undefined) return
      try {
        acceleratedApplyControlled(handle.statevector, GATE_MATRICES.x, 0, [])
        expect.unreachable('the trap should have propagated')
      } catch (error) {
        expect(error).toBeInstanceOf(KernelTrapError)
        expect((error as Error).cause).toBeInstanceOf(WebAssembly.RuntimeError)
      }
      handle.release()
    } finally {
      session.dispose()
    }
  })

  it('leaves a detached statevector as a detached statevector', () => {
    /*
     * `ownedPointer` raises `DetachedStateError` *before* anything is written,
     * and letting it through is deliberate and unchanged: a detached view
     * cannot be computed with by anybody, so a TypeScript fallback would read
     * `undefined` and write `NaN` — the one silent failure `session.ts` exists
     * to prevent. It is not a trap, so the kernel stays installed.
     */
    const session = createSession(
      createTransliteratedExports({ initialPages: 1 })
    )
    installStatevectorKernel(createKernel(session))
    const handle = session.allocState(8)
    expect(handle).toBeDefined()
    if (handle === undefined) return
    try {
      const held: Statevector = handle.statevector // cached across the next alloc
      const second = session.allocState(12) // grows memory, detaches `held`
      expect(second).toBeDefined()
      expect(held.re.byteLength).toBe(0)

      expect(() =>
        acceleratedApplyControlled(held, GATE_MATRICES.h, 0, [])
      ).toThrow(/detached|released/i)
      expect(kernelStatus().id).toBeDefined()
      expect(kernelStatus().disabledReason).toBeUndefined()

      // And re-reading the getter heals the handle, which is the documented
      // recovery.
      acceleratedApplyControlled(handle.statevector, GATE_MATRICES.h, 0, [])
      second?.release()
    } finally {
      handle.release()
      session.dispose()
    }
  })

  it('DEFECT: a kernel that half-applies a gate then declines corrupts the state', () => {
    /*
     * Rule 2 of the bridge — "decline without touching anything" — is a
     * contract on the *kernel*, and nothing can verify it from outside: a
     * kernel that writes and then returns false has its work applied a second
     * time by the fallback, and the engine reports no error at all.
     *
     * Kept as a defect rather than fixed because the only fix is a copy of the
     * state before every gate, which is the 2ⁿ-per-gate cost the whole design
     * exists to avoid (see `session.ts`). What it documents is why the crate
     * validates before its first write and returns `false` rather than trapping
     * partway through — and why a trap, which cannot make that promise, stops
     * the run instead of falling back.
     */
    const session = createSession(createTransliteratedExports())
    const honest = createKernel(session)
    installStatevectorKernel({
      id: 'half-applying',
      applyControlled: (state, matrix, target, controls): boolean => {
        honest.applyControlled(state, matrix, target, controls)
        return false // "not mine" — after having done the work
      },
      applySwap: honest.applySwap,
      applyISwap: honest.applyISwap,
    })

    const handle = session.allocState(2)
    expect(handle).toBeDefined()
    if (handle === undefined) return
    try {
      acceleratedApplyControlled(handle.statevector, GATE_MATRICES.h, 0, [])
      const reference = alloc(2)
      applyControlled(reference, GATE_MATRICES.h, 0, [])

      // H applied twice is the identity, so the state is back at |00⟩ while
      // the reference is in the superposition the circuit asked for.
      expect(handle.statevector.re[0]).toBeCloseTo(1, 15)
      expect(reference.re[0]).toBeCloseTo(Math.SQRT1_2, 15)
      expect(kernelStatus().disabledReason).toBeUndefined()
    } finally {
      handle.release()
      session.dispose()
    }
  })
})
