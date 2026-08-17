/**
 * INDEPENDENT VERIFICATION — lens: wasm-agreement, part two.
 *
 * `engines-agree.test.ts` asks whether the two engines compute the same thing.
 * This file asks a narrower question that the first cannot: **what does the
 * gate in front of installation actually prove?**
 *
 * The claim under test is the one stated at the top of `index.ts` and repeated
 * in `load.ts` — "a disagreement between the two is resolved in favour of
 * `@qsim/core` … `loadKernel` proves agreement before installing and refuses to
 * install without it". Four things passed that gate and should not have, and
 * each test below now pins the closed version of one of them:
 *
 *   1. a kernel whose accelerated *extras* disagree, because the gate never
 *      called them (§5.5's Bloch numbers among them)
 *   2. a kernel whose controlled walk mishandles a complex matrix, because the
 *      gate only ever staged a real-valued matrix under a control mask
 *   3. a statevector whose bytes have been returned to the allocator, because
 *      `ownedPointer` validated layout and not liveness
 *   4. `extras.probabilities`, which needed an output region in linear memory
 *      that no part of `KernelSession` could produce
 */

import { describe, expect, it } from 'vitest'

import {
  alloc,
  blochVectors,
  createRng,
  probabilities as tsProbabilities,
  reducedDensity as tsReducedDensity,
  type Statevector,
} from '@qsim/core'

import { verifyEquivalence } from '../../equivalence.js'
import type { KernelExports } from '../../exports.js'
import { createExtras, createKernel } from '../../kernel.js'
import { createSession } from '../../session.js'
import { createTransliteratedExports } from './rust-transliteration.js'

function fill(state: Statevector, seed: number): void {
  const rng = createRng(seed)
  let sum = 0
  for (let i = 0; i < state.size; i++) {
    const re = rng.next() * 2 - 1
    const im = rng.next() * 2 - 1
    state.re[i] = re
    state.im[i] = im
    sum += re * re + im * im
  }
  const scale = 1 / Math.sqrt(sum)
  for (let i = 0; i < state.size; i++) {
    state.re[i] *= scale
    state.im[i] *= scale
  }
}

/* ══════════════════════════════════════════════════════════════════════
 * 1. THE EXTRAS ARE PART OF THE PROOF
 * ══════════════════════════════════════════════════════════════════════ */

describe('the equivalence gate and the accelerated extras', () => {
  it('refuses a kernel whose reduced density has the wrong sign', () => {
    const honest = createTransliteratedExports()
    // One sign, in the entry §5.5 turns into the Bloch y component. Every
    // other export is the crate's own arithmetic — so if the gate is blind to
    // this, it is blind to a kernel that is perfect except for the number the
    // analysis panel draws twenty spheres from.
    const flipped: KernelExports = {
      ...honest,
      reduced_density: (ptr, qubits, qubit, out) => {
        const ok = honest.reduced_density(ptr, qubits, qubit, out)
        if (!ok) return false
        const view = new Float64Array(honest.memory.buffer, out, 4)
        view[3] = -view[3]
        return true
      },
    }

    const session = createSession(flipped)
    try {
      const kernel = createKernel(session)
      const report = verifyEquivalence(session, kernel, { qubits: 6 })
      expect(report.agreed).toBe(false)
      expect(report.failure?.description).toContain('reducedDensity')
      expect(report.failure?.description).toContain('im01')
    } finally {
      session.dispose()
    }
  })

  it('names what the sign would have done to the picture', () => {
    /*
     * Kept as its own test because it is the *consequence*, and the reason the
     * one above is worth a gate: y = -2·Im ρ₀₁, so a flipped sign mirrors every
     * entangled qubit's sphere through the x–z plane. Nothing about the
     * rendering would look wrong.
     */
    const honest = createTransliteratedExports()
    const flipped: KernelExports = {
      ...honest,
      reduced_density: (ptr, qubits, qubit, out) => {
        const ok = honest.reduced_density(ptr, qubits, qubit, out)
        if (!ok) return false
        const view = new Float64Array(honest.memory.buffer, out, 4)
        view[3] = -view[3]
        return true
      },
    }
    const session = createSession(flipped)
    try {
      const extras = createExtras(session)
      const handle = session.allocState(4)
      expect(handle).toBeDefined()
      if (handle === undefined) return
      fill(handle.statevector, 0x51de)
      const heap = alloc(4)
      heap.re.set(handle.statevector.re)
      heap.im.set(handle.statevector.im)

      let sawADisagreement = false
      for (let qubit = 0; qubit < 4; qubit++) {
        const accelerated = extras.reducedDensity(handle.statevector, qubit)
        const reference = tsReducedDensity(heap, qubit)
        expect(accelerated).toBeDefined()
        if (accelerated === undefined) continue
        if (Math.abs(accelerated[3] - reference.im01) > 1e-12) {
          sawADisagreement = true
        }
        const bloch = blochVectors(heap)[qubit]
        expect(Math.abs(-2 * accelerated[3] - (bloch?.y ?? 0))).toBeGreaterThan(
          1e-12
        )
      }
      expect(sawADisagreement).toBe(true)
      handle.release()
    } finally {
      session.dispose()
    }
  })

  it('refuses a kernel whose norm and probabilities are wrong', () => {
    const honest = createTransliteratedExports()
    const wrong: KernelExports = {
      ...honest,
      norm_squared: (ptr, qubits) => honest.norm_squared(ptr, qubits) * 2,
      probabilities: (ptr, qubits, out) => {
        const ok = honest.probabilities(ptr, qubits, out)
        if (!ok) return false
        const view = new Float64Array(honest.memory.buffer, out, 1 << qubits)
        for (let i = 0; i < view.length; i++) view[i] *= 3
        return true
      },
    }
    const session = createSession(wrong)
    try {
      const report = verifyEquivalence(session, createKernel(session), {
        qubits: 6,
      })
      expect(report.agreed).toBe(false)
      // `normSquared` is checked first, so that is the one named. Both are
      // wrong; the gate stops at the first.
      expect(report.failure?.description).toContain('normSquared')
    } finally {
      session.dispose()
    }
  })

  it('refuses a kernel whose scale is wrong', () => {
    const honest = createTransliteratedExports()
    const wrong: KernelExports = {
      ...honest,
      scale: (ptr, qubits, factor) => honest.scale(ptr, qubits, factor * 1.5),
    }
    const session = createSession(wrong)
    try {
      const report = verifyEquivalence(session, createKernel(session), {
        qubits: 5,
      })
      expect(report.agreed).toBe(false)
      expect(report.failure?.description).toContain('scale')
    } finally {
      session.dispose()
    }
  })

  it('still passes the honest crate, extras included', () => {
    // The other half of every refusal above: the gate has not become one that
    // rejects everything.
    const session = createSession(createTransliteratedExports())
    try {
      const report = verifyEquivalence(session, createKernel(session), {
        qubits: 6,
      })
      expect(report.agreed).toBe(true)
      expect(report.worstDeviation).toBe(0)
    } finally {
      session.dispose()
    }
  })
})

/* ══════════════════════════════════════════════════════════════════════
 * 2. THE GATE STAGES A COMPLEX MATRIX UNDER A CONTROL
 * ══════════════════════════════════════════════════════════════════════ */

describe('what the equivalence gate exercises', () => {
  it('applies complex-valued matrices through a control mask', () => {
    const honest = createTransliteratedExports()
    let controlledCalls = 0
    let controlledWithAComplexMatrix = 0
    const watched: KernelExports = {
      ...honest,
      apply_controlled: (ptr, qubits, target, mask, value) => {
        const matrix = new Float64Array(
          honest.memory.buffer,
          honest.matrix_ptr(),
          8
        )
        if (mask !== 0) {
          controlledCalls++
          const anyImaginary =
            matrix[1] !== 0 ||
            matrix[3] !== 0 ||
            matrix[5] !== 0 ||
            matrix[7] !== 0
          if (anyImaginary) controlledWithAComplexMatrix++
        }
        return honest.apply_controlled(ptr, qubits, target, mask, value)
      },
    }
    const session = createSession(watched)
    try {
      const report = verifyEquivalence(session, createKernel(session), {
        qubits: 8,
        gates: 800,
      })
      expect(report.agreed).toBe(true)
      // Controlled gates are drawn in quantity…
      expect(controlledCalls).toBeGreaterThan(50)
      /*
       * …and a good share of them stage a matrix with a non-zero imaginary
       * half. `crz`, `cp` and `ccu` are shapes `apply.ts`'s COVERAGE table
       * lists and the runner dispatches, and the controlled walk is a
       * different loop in `kernel.rs` from the uncontrolled one — so a
       * proof that only ever staged `x` and `z` under a mask compared the
       * imaginary arithmetic of that loop against nothing at all.
       */
      expect(controlledWithAComplexMatrix).toBeGreaterThan(10)
    } finally {
      session.dispose()
    }
  })
})

/* ══════════════════════════════════════════════════════════════════════
 * 3. OWNERSHIP IS PROVEN BY LIVENESS, NOT ONLY BY LAYOUT
 * ══════════════════════════════════════════════════════════════════════ */

describe('ownedPointer against a released statevector', () => {
  it('declines a statevector whose bytes were returned to the allocator', () => {
    // `recycleFreed` is what the Rust allocator does: the same address comes
    // back on the next allocation of the same size. `crate/src/lib.rs`'s
    // `check()` validates a non-null pointer and a qubit count in range and has
    // no live-handle map, so the guard has to be on this side — and it is
    // identity-based, because an address is exactly what a recycling allocator
    // reuses.
    const session = createSession(
      createTransliteratedExports({ recycleFreed: true })
    )
    try {
      const first = session.allocState(4)
      expect(first).toBeDefined()
      if (first === undefined) return

      // The documented hazard is caching across an *allocation* (detachment).
      // This is caching across a *release*, which nothing warned about and
      // which the getter cannot catch because the object already exists.
      const stale = first.statevector
      fill(stale, 0x1111)
      first.release()

      const second = session.allocState(4)
      expect(second).toBeDefined()
      if (second === undefined) return
      // The allocator handed back the same address, as Rust's would.
      expect(second.pointer).toBe(first.pointer)

      // The stale object still passes every *layout* check — its views are
      // over the live buffer, the halves are contiguous and the right length —
      // and it is declined anyway, because it is not a state this session is
      // currently vouching for.
      expect(session.ownedPointer(stale)).toBeUndefined()

      // So a gate offered the stale state declines and the engine falls back to
      // TypeScript, instead of writing into the new state.
      const kernel = createKernel(session)
      const before = second.statevector.re[0]
      expect(before).toBe(1) // |0…0⟩
      const handled = kernel.applyControlled(
        stale,
        Float64Array.from([0, 0, 1, 0, 1, 0, 0, 0]), // X
        0,
        []
      )
      expect(handled).toBe(false)
      expect(second.statevector.re[0]).toBe(1)

      second.release()
    } finally {
      session.dispose()
    }
  })

  it('still accepts a state read fresh from its handle', () => {
    // The other half: the guard has not made the ordinary path decline.
    const session = createSession(createTransliteratedExports())
    try {
      const handle = session.allocState(3)
      expect(handle).toBeDefined()
      if (handle === undefined) return
      expect(session.ownedPointer(handle.statevector)).toBe(handle.pointer)
      handle.release()
    } finally {
      session.dispose()
    }
  })
})

/* ══════════════════════════════════════════════════════════════════════
 * 4. THE ACCELERATED probabilities() HAS AN OUTPUT BUFFER
 * ══════════════════════════════════════════════════════════════════════ */

describe('extras.probabilities', () => {
  it('writes into a buffer the session can produce', () => {
    const session = createSession(createTransliteratedExports())
    try {
      const extras = createExtras(session)
      const handle = session.allocState(8)
      expect(handle).toBeDefined()
      if (handle === undefined) return
      fill(handle.statevector, 0xb0)

      // A JS-heap array: refused, correctly — the kernel writes through a
      // pointer and the heap has no address it can write to.
      expect(
        extras.probabilities(handle.statevector, new Float64Array(256))
      ).toBe(false)

      // `allocBuffer` is the supported answer, and for a 2ⁿ request the fit is
      // exact: `alloc_state(n-1)` reserves 2·2^(n-1) = 2ⁿ doubles.
      const out = session.allocBuffer(handle.statevector.size)
      expect(out).toBeDefined()
      if (out === undefined) return
      expect(out.doubles.length).toBe(256)
      expect(extras.probabilities(handle.statevector, out.doubles)).toBe(true)

      const heap = alloc(8)
      heap.re.set(handle.statevector.re)
      heap.im.set(handle.statevector.im)
      const reference = tsProbabilities(heap)
      for (let i = 0; i < reference.length; i++) {
        expect(out.doubles[i]).toBeCloseTo(reference[i], 15)
      }

      out.release()
      handle.release()
    } finally {
      session.dispose()
    }
  })

  it('exposes exactly the surface the bridge and the gate need', () => {
    const session = createSession(createTransliteratedExports())
    try {
      expect(Object.keys(session).sort()).toEqual([
        'allocBuffer',
        'allocState',
        'dispose',
        'exports',
        'id',
        'matrixScratch',
        'ownedPointer',
      ])
    } finally {
      session.dispose()
    }
  })
})
