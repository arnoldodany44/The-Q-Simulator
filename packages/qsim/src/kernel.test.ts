/**
 * The optional-accelerator seam.
 *
 * These suites are in `@qsim/core` rather than in `@qsim/wasm` on purpose:
 * they are about what this package promises *without* an accelerator, and
 * about the invariants the seam must hold whatever gets installed. They must
 * therefore pass in a checkout that has never heard of WebAssembly, which is
 * why the kernels below are hand-written objects rather than anything loaded.
 *
 * The promise being tested: the engine computes the same answers whether or
 * not something is installed, and `apply.ts` remains the definition.
 */

import { afterEach, describe, expect, test } from 'vitest'

import { GATE_MATRICES, matrixFor } from './gates.js'
import {
  acceleratedApplyControlled,
  acceleratedApplyISwap,
  acceleratedApplySwap,
  activeStatevectorKernel,
  disableStatevectorKernel,
  installStatevectorKernel,
  kernelStatus,
  uninstallStatevectorKernel,
  type StatevectorKernel,
} from './kernel.js'
import { alloc, type Statevector } from './statevector.js'
import {
  applyControlled,
  applyISwap,
  applySwap,
  type ControlSpec,
} from './apply.js'

afterEach(() => {
  uninstallStatevectorKernel()
})

/** Records what it was offered and declines everything. */
function spy(): {
  kernel: StatevectorKernel
  calls: { name: string; args: unknown[] }[]
} {
  const calls: { name: string; args: unknown[] }[] = []
  return {
    calls,
    kernel: {
      id: 'spy',
      applyControlled: (...args) => {
        calls.push({ name: 'applyControlled', args })
        return false
      },
      applySwap: (...args) => {
        calls.push({ name: 'applySwap', args })
        return false
      },
      applyISwap: (...args) => {
        calls.push({ name: 'applyISwap', args })
        return false
      },
    },
  }
}

function bell(): Statevector {
  const state = alloc(3)
  applyControlled(state, GATE_MATRICES.h, 0, [])
  return state
}

function same(a: Statevector, b: Statevector): number {
  let worst = 0
  for (let i = 0; i < a.size; i++) {
    worst = Math.max(
      worst,
      Math.abs(a.re[i] - b.re[i]),
      Math.abs(a.im[i] - b.im[i])
    )
  }
  return worst
}

describe('with no kernel installed', () => {
  test('the accelerated entry points are the reference ones', () => {
    expect(activeStatevectorKernel()).toBeUndefined()
    expect(kernelStatus()).toEqual({ id: undefined, disabledReason: undefined })

    const viaSeam = bell()
    const viaReference = bell()
    const controls: ControlSpec[] = [{ qubit: 0, state: 1 }]

    acceleratedApplyControlled(viaSeam, GATE_MATRICES.x, 1, controls)
    acceleratedApplySwap(viaSeam, 1, 2, [])
    acceleratedApplyISwap(viaSeam, 0, 2)

    applyControlled(viaReference, GATE_MATRICES.x, 1, controls)
    applySwap(viaReference, 1, 2, [])
    applyISwap(viaReference, 0, 2)

    expect(same(viaSeam, viaReference)).toBe(0)
  })
})

describe('a kernel that declines', () => {
  test('is offered every gate and changes no answer', () => {
    const { kernel, calls } = spy()
    installStatevectorKernel(kernel)

    const viaSeam = bell()
    const viaReference = bell()
    acceleratedApplyControlled(viaSeam, matrixFor('rz', [0.7]), 2, [])
    acceleratedApplySwap(viaSeam, 0, 1, [{ qubit: 2, state: 0 }])
    acceleratedApplyISwap(viaSeam, 1, 2)

    applyControlled(viaReference, matrixFor('rz', [0.7]), 2, [])
    applySwap(viaReference, 0, 1, [{ qubit: 2, state: 0 }])
    applyISwap(viaReference, 1, 2)

    expect(calls.map((c) => c.name)).toEqual([
      'applyControlled',
      'applySwap',
      'applyISwap',
    ])
    expect(same(viaSeam, viaReference)).toBe(0)
  })
})

/**
 * The guards must fire before the kernel is offered anything. Across a WASM
 * boundary an out-of-range target is not a wrong answer, it is a write into
 * another allocation — so the seam validates first and the error is the one
 * `apply.ts` would have raised, word for word.
 */
describe('the guards', () => {
  const cases: [string, () => void, RegExp][] = [
    [
      'a target outside the register',
      () => acceleratedApplyControlled(alloc(2), GATE_MATRICES.x, 5, []),
      /outside \[0, 2\)/,
    ],
    [
      'a control on its own target',
      () =>
        acceleratedApplyControlled(alloc(3), GATE_MATRICES.x, 1, [
          { qubit: 1, state: 1 },
        ]),
      /both a control and a target/,
    ],
    [
      'the same qubit controlled twice',
      () =>
        acceleratedApplyControlled(alloc(3), GATE_MATRICES.x, 0, [
          { qubit: 2, state: 1 },
          { qubit: 2, state: 0 },
        ]),
      /controlled twice/,
    ],
    [
      'a wrong-sized matrix',
      () => acceleratedApplyControlled(alloc(2), new Float64Array(32), 0, []),
      /8 doubles/,
    ],
    [
      'a two-qubit gate on one qubit',
      () => acceleratedApplySwap(alloc(3), 1, 1, []),
      /two different qubits/,
    ],
    [
      'an iSWAP on one qubit',
      () => acceleratedApplyISwap(alloc(3), 2, 2),
      /two different qubits/,
    ],
  ]

  for (const [label, run, expected] of cases) {
    test(`${label} is rejected identically with and without a kernel`, () => {
      expect(run).toThrow(expected)

      const { kernel, calls } = spy()
      installStatevectorKernel(kernel)
      expect(run).toThrow(expected)
      // And the kernel was never given the chance to act on it.
      expect(calls).toHaveLength(0)
    })
  }
})

describe('install, uninstall and disable', () => {
  test('install replaces and uninstall removes', () => {
    const first = spy().kernel
    installStatevectorKernel(first)
    expect(activeStatevectorKernel()).toBe(first)
    expect(kernelStatus().id).toBe('spy')

    uninstallStatevectorKernel()
    expect(activeStatevectorKernel()).toBeUndefined()
    expect(kernelStatus().id).toBeUndefined()
  })

  /**
   * The response to a kernel caught disagreeing with `apply.ts`: it stops
   * being consulted, the engine keeps working because the TypeScript answer
   * was always the right one, and the reason survives so the defect is
   * visible rather than absorbed.
   */
  test('disable removes the kernel and keeps the reason', () => {
    installStatevectorKernel(spy().kernel)
    disableStatevectorKernel('deviated by 3e-9 at gate 41')

    expect(activeStatevectorKernel()).toBeUndefined()
    expect(kernelStatus().disabledReason).toBe('deviated by 3e-9 at gate 41')

    // And the engine still computes.
    const state = bell()
    acceleratedApplyControlled(state, GATE_MATRICES.x, 1, [
      { qubit: 0, state: 1 },
    ])
    expect(state.re[0]).toBeCloseTo(Math.SQRT1_2, 15)
    expect(state.re[3]).toBeCloseTo(Math.SQRT1_2, 15)
  })

  test('a fresh install clears a previous disable reason', () => {
    disableStatevectorKernel('an old failure')
    installStatevectorKernel(spy().kernel)
    expect(kernelStatus().disabledReason).toBeUndefined()
  })
})

/**
 * A kernel that claims a gate must be believed — that is what installing one
 * means — so this checks the seam does not then apply the gate a second time
 * through `apply.ts`. Double application is the failure mode a boolean return
 * invites, and it produces a state that is still normalised.
 */
describe('a kernel that handles a gate', () => {
  test('is not shadowed by the reference running as well', () => {
    installStatevectorKernel({
      id: 'handles-everything',
      // Claims the work and does nothing. The state must therefore be
      // unchanged — if the seam also ran `apply.ts`, it would not be.
      applyControlled: () => true,
      applySwap: () => true,
      applyISwap: () => true,
    })

    const state = bell()
    const before = Float64Array.from(state.re)
    acceleratedApplyControlled(state, GATE_MATRICES.x, 1, [])
    acceleratedApplySwap(state, 0, 2, [])
    acceleratedApplyISwap(state, 1, 2)
    expect(Array.from(state.re)).toEqual(Array.from(before))
  })
})
