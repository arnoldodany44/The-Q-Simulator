/**
 * End to end: a circuit run through the accelerator must equal the same
 * circuit run in TypeScript.
 *
 * `equivalence.test.ts` compares gate by gate, driving the kernel directly.
 * This compares whole runs through `@qsim/core`'s own dispatcher — the seam in
 * `kernel.ts`, the `GateBackend` in `runner.ts`, parameter resolution, the
 * renormalisation every 64 gates, the lot. The two suites fail differently: a
 * fold or pairing mistake shows up there, a *wiring* mistake shows up here.
 *
 * A wiring mistake is the more likely one now. The kernel could be perfect
 * and the runner could still be sending it the target where a control belongs,
 * or bypassing it entirely, or — the failure that would be hardest to see —
 * accelerating everything except the one gate that carries the phase.
 */

import {
  installStatevectorKernel,
  kernelStatus,
  run,
  runFromState,
  uninstallStatevectorKernel,
  type CircuitLike,
  type OperationLike,
  type Statevector,
} from '@qsim/core'
import { afterEach, describe, expect, test } from 'vitest'

import { maxDeviation } from './equivalence.js'
import { createKernel } from './kernel.js'
import { createSession, type KernelSession } from './session.js'
import { createReferenceExports } from './testing/reference-exports.js'

/** The work plan's budget for two routes to the same state. */
const TOLERANCE = 1e-12

afterEach(() => {
  // A leaked global kernel would silently accelerate every later suite in this
  // process, which is exactly the sort of cross-test coupling that makes a
  // failure impossible to localise.
  uninstallStatevectorKernel()
})

function session(): KernelSession {
  return createSession(createReferenceExports())
}

/**
 * A circuit touching every dispatch path in the runner: fixed and
 * parametrised one-qubit gates, a symbolic parameter, positive and negative
 * controls, both two-qubit permutations, the three-qubit gates and a barrier.
 */
const MIN_QUBITS = 5

function circuit(qubits: number): CircuitLike {
  // The `cswap` below reaches qubit 4, so a smaller register would make this
  // fixture throw a RangeError that looks like a kernel defect and is not.
  if (qubits < MIN_QUBITS) {
    throw new Error(`this fixture needs at least ${MIN_QUBITS} qubits`)
  }
  const operations: OperationLike[] = []
  let id = 0
  const next = (): string => `op${++id}`
  let column = 0

  for (let round = 0; round < 6; round++) {
    for (let q = 0; q < qubits; q++) {
      operations.push({ id: next(), gate: 'h', targets: [q], column })
    }
    column++
    operations.push({
      id: next(),
      gate: 'u',
      targets: [0],
      column,
      params: [0.31 + round, 0.72, 1.13],
    })
    operations.push({
      id: next(),
      gate: 'rz',
      targets: [1],
      column,
      params: ['theta'],
    })
    column++
    operations.push({
      id: next(),
      gate: 'cx',
      targets: [1],
      column,
      controls: [0],
    })
    column++
    // A negative control — where `mask` and `value` differ.
    operations.push({
      id: next(),
      gate: 'z',
      targets: [2],
      column,
      controls: [{ qubit: 1, state: 0 }],
    })
    column++
    operations.push({ id: next(), gate: 'swap', targets: [0, 3], column })
    column++
    operations.push({ id: next(), gate: 'iswap', targets: [1, 2], column })
    column++
    operations.push({
      id: next(),
      gate: 'ccx',
      targets: [3],
      column,
      controls: [0, 1],
    })
    column++
    operations.push({
      id: next(),
      gate: 'cswap',
      targets: [2, 4],
      column,
      controls: [0],
    })
    column++
    operations.push({ id: next(), gate: 'barrier', targets: [0], column })
    column++
  }

  return {
    qubits,
    parameters: [{ name: 'theta', value: 0.7853981634 }],
    operations,
  }
}

describe('an accelerated run', () => {
  test('equals the pure TypeScript run of the same circuit', () => {
    const qubits = 5
    const plan = circuit(qubits)

    // Reference first, with nothing installed.
    const expected = run(plan)
    if (expected.mode !== 'analytic') throw new Error('expected analytic')

    const s = session()
    const handle = s.allocState(qubits)
    if (handle === undefined) throw new Error('no state')
    installStatevectorKernel(createKernel(s))
    expect(kernelStatus().id).toBe('wasm')

    const actual = runFromState(plan, handle.statevector)
    expect(maxDeviation(actual.state, expected.state)).toBeLessThan(TOLERANCE)
    // The same argument as in equivalence.test.ts: identical operations in an
    // identical order over identical doubles should be identical bits.
    expect(maxDeviation(actual.state, expected.state)).toBe(0)

    s.dispose()
  })

  test('the state really was evolved inside linear memory', () => {
    const qubits = 5
    const s = session()
    const handle = s.allocState(qubits)
    if (handle === undefined) throw new Error('no state')
    installStatevectorKernel(createKernel(s))

    const result = runFromState(circuit(qubits), handle.statevector)
    // Not a copy that happened to match: the returned state is a view onto
    // the kernel's own memory, which is what "no copy per gate" means.
    expect(result.state.re.buffer).toBe(s.exports.memory.buffer)
    expect(s.ownedPointer(result.state)).toBe(handle.pointer)
    s.dispose()
  })
})

describe('the fallback', () => {
  /**
   * The common case in production, and it has to be exactly right: the runner
   * allocates its own heap state, the kernel cannot reach it, and every gate
   * quietly runs in TypeScript. An accelerator that broke this would break
   * `run()` — the entry point almost everything uses.
   */
  test('a heap state runs in TypeScript even with a kernel installed', () => {
    const plan = circuit(5)
    const expected = run(plan)
    if (expected.mode !== 'analytic') throw new Error('expected analytic')

    const s = session()
    installStatevectorKernel(createKernel(s))
    const actual = run(plan) // allocates on the JS heap; kernel declines
    if (actual.mode !== 'analytic') throw new Error('expected analytic')

    expect(maxDeviation(actual.state, expected.state)).toBe(0)
    s.dispose()
  })

  test('a kernel that declines everything changes no answer', () => {
    const plan = circuit(5)
    const expected = run(plan)
    if (expected.mode !== 'analytic') throw new Error('expected analytic')

    installStatevectorKernel({
      id: 'declines-everything',
      applyControlled: () => false,
      applySwap: () => false,
      applyISwap: () => false,
    })
    const actual = run(plan)
    if (actual.mode !== 'analytic') throw new Error('expected analytic')
    expect(maxDeviation(actual.state, expected.state)).toBe(0)
  })

  /**
   * Uninstalling has to be complete. A half-removed kernel would leave some
   * gates accelerated and some not, which is the state a disagreement
   * response leaves the engine in if `uninstall` is not total.
   */
  test('uninstalling restores the engine exactly', () => {
    const plan = circuit(5)
    const before = run(plan)
    const s = session()
    installStatevectorKernel(createKernel(s))
    uninstallStatevectorKernel()
    const after = run(plan)
    if (before.mode !== 'analytic' || after.mode !== 'analytic') {
      throw new Error('expected analytic')
    }
    expect(maxDeviation(after.state, before.state)).toBe(0)
    expect(kernelStatus().id).toBeUndefined()
    s.dispose()
  })
})

describe('invalid circuits', () => {
  /**
   * The guards must fire identically on both paths. A control on its own
   * target is nonsense the engine rejects; across a WASM boundary it would be
   * a write outside the state if it were not rejected first.
   */
  test('are rejected the same way with and without a kernel', () => {
    const bad: CircuitLike = {
      qubits: 3,
      operations: [
        { id: 'op1', gate: 'x', targets: [0], column: 0, controls: [0] },
      ],
    }

    let withoutKernel: string | undefined
    try {
      run(bad)
    } catch (error) {
      withoutKernel = (error as Error).message
    }

    const s = session()
    const handle = s.allocState(3)
    if (handle === undefined) throw new Error('no state')
    installStatevectorKernel(createKernel(s))

    let withKernel: string | undefined
    try {
      runFromState(bad, handle.statevector)
    } catch (error) {
      withKernel = (error as Error).message
    }

    expect(withoutKernel).toBeDefined()
    expect(withKernel).toBe(withoutKernel)
    s.dispose()
  })
})

describe('a released state', () => {
  test('cannot be run into', () => {
    const s = session()
    const handle = s.allocState(3)
    if (handle === undefined) throw new Error('no state')
    const state: Statevector = handle.statevector
    handle.release()
    installStatevectorKernel(createKernel(s))

    // The bytes may already back another state, so this must not quietly
    // compute over them. `ownedPointer` still recognises the buffer, so the
    // protection that matters here is the allocator's, not the view's — the
    // pointer is no longer registered as live and the kernel declines.
    expect(s.exports.norm_squared(handle.pointer, 3)).toBe(-1)
    expect(state.re.buffer).toBe(s.exports.memory.buffer)
    s.dispose()
  })
})
