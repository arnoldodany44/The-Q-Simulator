/**
 * The equivalence contract: an accelerator agrees with `apply.ts`, or it does
 * not run.
 *
 * These suites exercise the check itself as hard as they exercise the kernel,
 * because a verifier that passes everything is worse than no verifier — it
 * would install an unchecked accelerator while reporting that it had checked
 * it. So alongside "a correct kernel agrees" there are deliberately broken
 * kernels here, one per way a real one could be wrong, and each must be
 * caught.
 */

import {
  GATE_MATRICES,
  alloc,
  applyControlled,
  matrixFor,
  type ControlSpec,
  type Matrix2,
  type Statevector,
  type StatevectorKernel,
} from '@qsim/core'
import { describe, expect, test } from 'vitest'

import {
  EQUIVALENCE_TOLERANCE,
  describeReport,
  maxDeviation,
  verifyEquivalence,
} from './equivalence.js'
import { createKernel } from './kernel.js'
import { createSession, type KernelSession } from './session.js'
import { createReferenceExports } from './testing/reference-exports.js'

function session(): KernelSession {
  return createSession(createReferenceExports())
}

describe('verifyEquivalence', () => {
  test('a correct kernel agrees with the TypeScript reference', () => {
    const s = session()
    const report = verifyEquivalence(s, createKernel(s))

    expect(report.agreed, describeReport(report)).toBe(true)
    expect(report.failure).toBeUndefined()
    expect(report.worstDeviation).toBeLessThan(EQUIVALENCE_TOLERANCE)
    s.dispose()
  })

  /**
   * The honest expectation is not "within tolerance", it is "identical".
   * Both sides do the same operations in the same association over the same
   * IEEE-754 doubles, so anything above zero means something reassociated —
   * which is worth knowing even while it still passes.
   */
  test('agreement is exact, not merely within tolerance', () => {
    const s = session()
    const report = verifyEquivalence(s, createKernel(s), { gates: 600 })
    expect(report.worstDeviation).toBe(0)
    s.dispose()
  })

  test('the same seed replays the same comparison', () => {
    const a = session()
    const b = session()
    const first = verifyEquivalence(a, createKernel(a), { seed: 99 })
    const second = verifyEquivalence(b, createKernel(b), { seed: 99 })
    expect(second.worstDeviation).toBe(first.worstDeviation)
    expect(second.gates).toBe(first.gates)
    a.dispose()
    b.dispose()
  })

  test('it covers several state sizes', () => {
    for (const qubits of [1, 2, 3, 6, 10]) {
      const s = session()
      const report = verifyEquivalence(s, createKernel(s), {
        qubits,
        gates: 120,
      })
      expect(report.agreed, `${qubits} qubits: ${describeReport(report)}`).toBe(
        true
      )
      s.dispose()
    }
  })
})

/**
 * Each of these is a defect a real kernel could plausibly have. If the
 * verifier misses one, it would have installed that kernel.
 */
describe('the verifier catches a kernel that is wrong', () => {
  /** Wrap a correct kernel and corrupt it in one specific way. */
  function sabotage(
    s: KernelSession,
    mutate: (kernel: StatevectorKernel) => StatevectorKernel
  ): StatevectorKernel {
    return mutate(createKernel(s))
  }

  test('a mirrored qubit index — the endianness mistake (D1)', () => {
    const s = session()
    const kernel = sabotage(s, (inner) => ({
      ...inner,
      applyControlled: (
        state: Statevector,
        matrix: Matrix2,
        target: number,
        controls: readonly ControlSpec[]
      ) =>
        inner.applyControlled(
          state,
          matrix,
          state.qubits - 1 - target,
          controls
        ),
    }))
    const report = verifyEquivalence(s, kernel)
    expect(report.agreed).toBe(false)
    expect(describeReport(report)).toContain('DISAGREES')
    s.dispose()
  })

  test('an inverted control polarity — the negative-control mistake', () => {
    const s = session()
    const kernel = sabotage(s, (inner) => ({
      ...inner,
      applyControlled: (
        state: Statevector,
        matrix: Matrix2,
        target: number,
        controls: readonly ControlSpec[]
      ) =>
        inner.applyControlled(
          state,
          matrix,
          target,
          controls.map((c) => ({
            qubit: c.qubit,
            state: c.state === 1 ? 0 : 1,
          }))
        ),
    }))
    expect(verifyEquivalence(s, kernel).agreed).toBe(false)
    s.dispose()
  })

  test('a transposed gate matrix', () => {
    const s = session()
    const kernel = sabotage(s, (inner) => ({
      ...inner,
      applyControlled: (
        state: Statevector,
        matrix: Matrix2,
        target: number,
        controls: readonly ControlSpec[]
      ) => {
        const t = new Float64Array([
          matrix[0],
          matrix[1],
          matrix[4],
          matrix[5],
          matrix[2],
          matrix[3],
          matrix[6],
          matrix[7],
        ])
        return inner.applyControlled(state, t, target, controls)
      },
    }))
    expect(verifyEquivalence(s, kernel).agreed).toBe(false)
    s.dispose()
  })

  test('swapped qubits in iSWAP — a permutation that hides in the norm', () => {
    const s = session()
    const kernel = sabotage(s, (inner) => ({
      ...inner,
      // iSWAP is not symmetric under exchanging its arguments: it multiplies
      // the exchanged amplitudes by i, and a norm check cannot see the
      // difference. This is exactly the class of defect that needs a
      // reference to compare against rather than an invariant to assert.
      applyISwap: (state: Statevector, q0: number, q1: number) =>
        inner.applyControlled(state, GATE_MATRICES.z, q0, [
          { qubit: q1, state: 1 },
        ]),
    }))
    expect(verifyEquivalence(s, kernel).agreed).toBe(false)
    s.dispose()
  })

  test('a tiny numeric drift, well below D6 but above the budget', () => {
    const s = session()
    const kernel = sabotage(s, (inner) => ({
      ...inner,
      applyControlled: (
        state: Statevector,
        matrix: Matrix2,
        target: number,
        controls: readonly ControlSpec[]
      ) => {
        const nudged = Float64Array.from(matrix, (v) => v * (1 + 1e-11))
        return inner.applyControlled(state, nudged, target, controls)
      },
    }))
    const report = verifyEquivalence(s, kernel)
    expect(report.agreed).toBe(false)
    expect(report.worstDeviation).toBeGreaterThan(EQUIVALENCE_TOLERANCE)
    s.dispose()
  })

  /**
   * A kernel that declines everything is trivially "never wrong". Reporting
   * that as agreement would install an accelerator nothing had checked, so
   * the verifier must treat it as a failure with its own explanation.
   */
  test('a kernel that declines every gate proves nothing and fails', () => {
    const s = session()
    const kernel: StatevectorKernel = {
      id: 'declines-everything',
      applyControlled: () => false,
      applySwap: () => false,
      applyISwap: () => false,
    }
    const report = verifyEquivalence(s, kernel)
    expect(report.agreed).toBe(false)
    expect(report.declined).toBe(report.gates)
    expect(report.failure?.description).toContain('declined every gate')
    s.dispose()
  })

  test('a kernel that cannot allocate fails rather than passing vacuously', () => {
    const s = createSession(createReferenceExports({ refuseAllocation: true }))
    const report = verifyEquivalence(s, createKernel(s))
    expect(report.agreed).toBe(false)
    expect(report.failure?.description).toContain('could not allocate')
    s.dispose()
  })
})

describe('maxDeviation', () => {
  test('is zero for a state compared with itself and finds the worst part', () => {
    const a = alloc(3)
    applyControlled(a, matrixFor('u', [0.3, 0.4, 0.5]), 1, [])
    const b: Statevector = {
      qubits: a.qubits,
      size: a.size,
      re: Float64Array.from(a.re),
      im: Float64Array.from(a.im),
    }
    expect(maxDeviation(a, b)).toBe(0)

    // A difference planted in an imaginary part must be found: half the
    // amplitudes live there and a comparison over `re` alone would pass.
    b.im[2] += 3e-9
    expect(maxDeviation(a, b)).toBeCloseTo(3e-9, 15)
  })
})
