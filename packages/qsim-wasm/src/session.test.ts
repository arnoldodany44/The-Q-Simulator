/**
 * Memory ownership across the boundary.
 *
 * The design decision under test is the one in `session.ts`: the statevector
 * lives in linear memory and JavaScript borrows views onto it. These suites
 * hold that decision to its consequences — that a borrowed view *is* an
 * ordinary `Statevector` to the rest of the engine, that the boundary is
 * crossed without copying, and above all that the one way this can go wrong
 * (a view detached by memory growth) is loud rather than silent.
 */

import {
  alloc,
  blochVector,
  norm,
  probabilities,
  type Statevector,
} from '@qsim/core'
import { describe, expect, test } from 'vitest'

import { createExtras, createKernel } from './kernel.js'
import {
  DetachedStateError,
  createSession,
  detachState,
  type KernelSession,
} from './session.js'
import { createReferenceExports } from './testing/reference-exports.js'

function session(pages?: number): KernelSession {
  return createSession(createReferenceExports({ initialPages: pages }))
}

describe('a state allocated in linear memory', () => {
  test('is an ordinary Statevector in the ground state', () => {
    const s = session()
    const handle = s.allocState(4)
    expect(handle).toBeDefined()

    const state = handle?.statevector
    expect(state?.qubits).toBe(4)
    expect(state?.size).toBe(16)
    expect(state?.re[0]).toBe(1)
    expect(state?.im[0]).toBe(0)
    expect(norm(state as Statevector)).toBe(1)
    s.dispose()
  })

  /**
   * The layout claim `ownedPointer` relies on: one allocation, real half
   * first, imaginary half immediately after. If this ever stopped holding,
   * every pointer handed to the kernel would still be a valid address and the
   * imaginary parts would silently be somebody else's bytes.
   */
  test('puts the imaginary half immediately after the real half', () => {
    const s = session()
    const handle = s.allocState(5)
    const state = handle?.statevector
    if (handle === undefined || state === undefined) throw new Error('no state')

    expect(state.re.buffer).toBe(s.exports.memory.buffer)
    expect(state.im.buffer).toBe(s.exports.memory.buffer)
    expect(state.im.byteOffset).toBe(state.re.byteOffset + state.size * 8)
    expect(s.ownedPointer(state)).toBe(state.re.byteOffset)
    expect(s.ownedPointer(state)).toBe(handle.pointer)
    s.dispose()
  })

  /**
   * The whole reason the state lives here: the rest of `@qsim/core` takes it
   * unmodified. No adapter, no conversion, and — the point — no copy.
   */
  test('works unmodified with the rest of the engine', () => {
    const s = session()
    const handle = s.allocState(3)
    const state = handle?.statevector
    if (state === undefined) throw new Error('no state')

    const kernel = createKernel(s)
    // A Hadamard on qubit 0, through the kernel, on a linear-memory state.
    const h = new Float64Array([
      Math.SQRT1_2,
      0,
      Math.SQRT1_2,
      0,
      Math.SQRT1_2,
      0,
      -Math.SQRT1_2,
      0,
    ])
    expect(kernel.applyControlled(state, h, 0, [])).toBe(true)

    // Functions that were written with no knowledge of WebAssembly.
    const p = probabilities(state)
    expect(p[0]).toBeCloseTo(0.5, 12)
    expect(p[1]).toBeCloseTo(0.5, 12)
    expect(blochVector(state, 0).x).toBeCloseTo(1, 12)
    s.dispose()
  })

  test('declines a statevector allocated on the JavaScript heap', () => {
    const s = session()
    // Not an error and not a special case: `alloc()`, `clone()` and every
    // checkpoint produce these, and they simply run in TypeScript.
    expect(s.ownedPointer(alloc(4))).toBeUndefined()
    s.dispose()
  })
})

/**
 * THE HAZARD. Growing a `WebAssembly.Memory` replaces its `ArrayBuffer` and
 * detaches every view into it. A detached `Float64Array` reads as `undefined`,
 * so a kernel loop over one would write `NaN` and a fallback loop would do the
 * same — a wrong answer with no exception anywhere.
 *
 * The stand-in allocator grows on demand precisely so this can be provoked
 * here rather than discovered in a browser.
 */
describe('when memory growth detaches a view', () => {
  /** Force a growth by allocating more than the initial page holds. */
  function provokeGrowth(s: KernelSession): void {
    const big = s.allocState(14) // 2¹⁴ amplitudes × 2 arrays × 8 B = 256 KB
    expect(big).toBeDefined()
  }

  test('a cached statevector is detected as detached, not silently wrong', () => {
    const s = session(1)
    const handle = s.allocState(4)
    if (handle === undefined) throw new Error('no state')

    // The mistake this guards against: hold the object, allocate, keep using it.
    const cached = handle.statevector
    provokeGrowth(s)

    expect(cached.re.byteLength).toBe(0) // detached, as promised
    expect(() => s.ownedPointer(cached)).toThrow(DetachedStateError)
    s.dispose()
  })

  test('the handle heals itself — its getter re-derives the views', () => {
    const s = session(1)
    const handle = s.allocState(4)
    if (handle === undefined) throw new Error('no state')
    handle.statevector.re[3] = 0.5

    provokeGrowth(s)

    // Same bytes, new views, no copy and no loss.
    const fresh = handle.statevector
    expect(fresh.re.byteLength).toBeGreaterThan(0)
    expect(fresh.re[0]).toBe(1)
    expect(fresh.re[3]).toBe(0.5)
    expect(s.ownedPointer(fresh)).toBe(handle.pointer)
    s.dispose()
  })

  /**
   * The three-way distinction that makes the design safe. "Not mine" and
   * "detached" must never be conflated: the first falls back to TypeScript
   * and is routine, the second cannot be computed with by anybody and has to
   * surface.
   */
  test('a heap state is declined while a detached one throws', () => {
    const s = session(1)
    const handle = s.allocState(4)
    if (handle === undefined) throw new Error('no state')
    const cached = handle.statevector
    provokeGrowth(s)

    expect(s.ownedPointer(alloc(4))).toBeUndefined()
    expect(() => s.ownedPointer(cached)).toThrow(/detached/i)
    s.dispose()
  })

  /**
   * The kernel must not swallow that throw. Falling back to TypeScript with a
   * detached view would compute over `undefined` and write NaN — a fallback
   * is only safe for a state somebody can actually read.
   */
  test('the kernel propagates it rather than falling back over NaN', () => {
    const s = session(1)
    const handle = s.allocState(4)
    if (handle === undefined) throw new Error('no state')
    const cached = handle.statevector
    provokeGrowth(s)

    const kernel = createKernel(s)
    expect(() => kernel.applyISwap(cached, 0, 1)).toThrow(DetachedStateError)
    s.dispose()
  })
})

describe('release and dispose', () => {
  test('a released handle refuses to hand out its state again', () => {
    const s = session()
    const handle = s.allocState(3)
    if (handle === undefined) throw new Error('no state')

    expect(handle.live).toBe(true)
    handle.release()
    expect(handle.live).toBe(false)
    // The bytes may already belong to the next allocation, so reading them
    // would be reading somebody else's state.
    expect(() => handle.statevector).toThrow(DetachedStateError)
    s.dispose()
  })

  test('release is idempotent and dispose frees what is left', () => {
    const s = session()
    const a = s.allocState(3)
    const b = s.allocState(3)
    a?.release()
    a?.release()
    s.dispose()
    expect(a?.live).toBe(false)
    expect(b?.live).toBe(false)
  })
})

describe('detachState', () => {
  test('copies out of linear memory, independent of it', () => {
    const s = session()
    const handle = s.allocState(3)
    if (handle === undefined) throw new Error('no state')
    handle.statevector.re[2] = 0.25

    const copy = detachState(handle.statevector)
    expect(copy.re.buffer).not.toBe(s.exports.memory.buffer)
    expect(copy.re[2]).toBe(0.25)

    // Independent: releasing the original must not disturb the copy, which is
    // the point of having one at a worker boundary.
    handle.release()
    expect(copy.re[2]).toBe(0.25)
    expect(copy.re[0]).toBe(1)
    s.dispose()
  })
})

describe('the accelerated extras', () => {
  test('reproduce the engine for norm, probabilities and reduced density', () => {
    const s = session()
    const extras = createExtras(s)
    const kernel = createKernel(s)
    const handle = s.allocState(4)
    if (handle === undefined) throw new Error('no state')

    const h = new Float64Array([
      Math.SQRT1_2,
      0,
      Math.SQRT1_2,
      0,
      Math.SQRT1_2,
      0,
      -Math.SQRT1_2,
      0,
    ])
    kernel.applyControlled(handle.statevector, h, 0, [])
    kernel.applyControlled(handle.statevector, h, 2, [])

    const state = handle.statevector
    expect(extras.normSquared(state)).toBeCloseTo(norm(state) ** 2, 12)

    const density = extras.reducedDensity(state, 0)
    const bloch = blochVector(state, 0)
    if (density === undefined) throw new Error('declined')
    // §5.5: x = 2·Re ρ₀₁, z = ρ₀₀ − ρ₁₁.
    expect(2 * density[2]).toBeCloseTo(bloch.x, 12)
    expect(density[0] - density[1]).toBeCloseTo(bloch.z, 12)

    s.dispose()
  })

  test('decline a heap state instead of copying it in', () => {
    const s = session()
    const extras = createExtras(s)
    const heap = alloc(3)
    expect(extras.normSquared(heap)).toBeUndefined()
    expect(extras.scale(heap, 2)).toBe(false)
    expect(extras.reducedDensity(heap, 0)).toBeUndefined()
    // A probabilities buffer on the JS heap has no address the kernel can
    // write through, so it is declined even for a state that is owned.
    const handle = s.allocState(3)
    if (handle === undefined) throw new Error('no state')
    expect(extras.probabilities(handle.statevector, new Float64Array(8))).toBe(
      false
    )
    s.dispose()
  })
})
